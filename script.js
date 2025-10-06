
let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = [];
let currentQuestion = null;
let question = null;
let quizMode = localStorage.getItem('quizMode') || 'en-to-ja'; // en-to-ja / ja-to-en
let correctStreaks = JSON.parse(localStorage.getItem('correctStreaks') || '{}');
// Enforce Google login only: no local/manual userId
let userId = null;



const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbym0i5TUDxhtuhABkjiNhSo9ZOv2g1ds8ljUIx6r5jVFk1KF7pUs4kJ0bFMuu_5qGaPRw/exec';
// Google Identity: set your client id here
const GOOGLE_CLIENT_ID = '631768968773-jakkcpa1ia1qb8rnec2mj4jqp6ohnoc5.apps.googleusercontent.com';
let currentIdToken = null;

function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function initGoogleIdentity() {
  const target = document.getElementById('g_id_button');
  if (!target) return;

  let attempts = 0;
  const maxAttempts = 12; // retry for ~12 * 250ms = 3s
  const tryInit = () => {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      try {
        console.log('initGoogleIdentity: google.accounts.id available, initializing');
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: false
        });
        console.log('initGoogleIdentity: initialize succeeded, rendering button');
        window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large' });
        console.log('initGoogleIdentity: renderButton called');
      } catch (e) {
        console.warn('initGoogleIdentity: initialize/render failed', e);
      }
      return;
    }
    attempts++;
    if (attempts < maxAttempts) {
      setTimeout(tryInit, 250);
    } else {
      console.warn('Google Identity client did not load; sign-in button not rendered.');
    }
  };
  tryInit();
}

function handleCredentialResponse(resp) {
  if (!resp || !resp.credential) return;
  currentIdToken = resp.credential;
  // persist current id_token for page reloads (sessionStorage used for lifecycle)
  try { sessionStorage.setItem('id_token', currentIdToken); } catch (e) { /* ignore */ }
  const payload = parseJwt(currentIdToken);
  if (payload && payload.sub) {
    // for UI, set userId and update compact user icon (title contains email)
    userId = payload.email || payload.sub;
    const userIcon = document.getElementById('user-icon');
    if (userIcon) {
      const displayText = payload.email || payload.sub || '未ログイン';
      userIcon.title = displayText;
      // show initial letter if email present
      const initial = (payload.email || payload.sub || '').charAt(0).toUpperCase();
      if (typeof userIcon.textContent !== 'undefined') userIcon.textContent = initial || '👤';
      userIcon.setAttribute('aria-hidden', 'false');
    }
    // show signout button
    const so = document.getElementById('signout-btn'); if (so) so.style.display = 'inline-block';

    // After login, fetch the user's rows from the sheet (server will filter by id_token)
    callSheetApi('list').then(data => {
      if (!Array.isArray(data)) data = [];
      customWords = data.map((word, i) => ({ ...word, rowIndex: i }));

      // Rebuild learnedWords and correctStreaks from server data
      learnedWords = {};
      correctStreaks = {};
      customWords.forEach(word => {
        learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
        correctStreaks[word.word] = Number(word.streak) || 0;
      });
      localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
      localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

      // cache in IndexedDB (bulk). Guard each put so a single bad row won't break the whole flow.
      useDB('readwrite', store => {
        try { store.clear(); } catch (e) { /* ignore */ }
        customWords.forEach(w => {
          if (!w || !w.word) {
            console.warn('Skipping IndexedDB put for item without word key', w);
          } else {
            store.put(w);
          }
        });
      });

      document.getElementById('loading').style.display = 'none';
      document.getElementById('word-container').style.display = 'block';
      renderWords();
    }).catch(err => {
      console.error('failed to load sheet data after login', err);
      alert('データの取得に失敗しました。コンソールを確認してください。');
    });
  }
}

// Restore id_token from sessionStorage on page load to avoid being logged out on reload
function restoreSessionFromStorage() {
  try {
    const token = sessionStorage.getItem('id_token');
    if (!token) return false;
    currentIdToken = token;
    const payload = parseJwt(currentIdToken);
    if (!payload) return false;
    userId = payload.email || payload.sub;
    const userIcon = document.getElementById('user-icon');
    if (userIcon) {
      const displayText = userId || '未ログイン';
      userIcon.title = displayText;
      const initial = (userId || '').charAt(0).toUpperCase();
      if (typeof userIcon.textContent !== 'undefined') userIcon.textContent = initial || '👤';
      userIcon.setAttribute('aria-hidden', 'false');
    }
    const so = document.getElementById('signout-btn'); if (so) so.style.display = 'inline-block';

    // load user rows
    callSheetApi('list').then(data => {
      if (!Array.isArray(data)) data = [];
      customWords = data.map((word, i) => ({ ...word, rowIndex: i }));
      // rebuild learned state
      learnedWords = {};
      correctStreaks = {};
      customWords.forEach(word => {
        learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
        correctStreaks[word.word] = Number(word.streak) || 0;
      });
      localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
      localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
      useDB('readwrite', store => {
        try { store.clear(); } catch (e) {}
        customWords.forEach(w => {
          if (!w || !w.word) {
            console.warn('Skipping IndexedDB put for item without word key', w);
          } else {
            store.put(w);
          }
        });
      });
      document.getElementById('loading').style.display = 'none';
      document.getElementById('word-container').style.display = 'block';
      renderWords();
    }).catch(e => {
      console.error('restore list failed', e);
      document.getElementById('loading').style.display = 'none';
      document.getElementById('word-container').style.display = 'block';
    });

    return true;
  } catch (e) { return false; }
}

// Central helper to call the Apps Script endpoint. It attaches id_token when available.
async function callSheetApi(action, params = {}) {
  try {
    const body = new URLSearchParams();
    body.append('action', action);
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === undefined || v === null) return;
      body.append(k, String(v));
    });
    if (currentIdToken) body.append('id_token', currentIdToken);

    const res = await fetch(SHEET_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('callSheetApi HTTP error', res.status, text);
      // still try to parse JSON
      try { return JSON.parse(text); } catch (e) { return text; }
    }
    try { return JSON.parse(text); } catch (e) { return text; }
  } catch (e) {
    console.error('callSheetApi failed', e);
    throw e;
  }
}

async function callSheetGet() {
  const res = await fetch(SHEET_API_URL);
  return res.json();
}

function useDB(mode, callback) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('WordDB', 1);
    request.onupgradeneeded = e => {
      e.target.result.createObjectStore('words', { keyPath: 'word' });
    };
    request.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('words', mode);
      const store = tx.objectStore('words');

      // Create a safe wrapper around the store that validates keyPath before put
      const safeStore = {
        put(obj) {
          try {
            if (!obj || typeof obj.word === 'undefined' || obj.word === null) {
              console.warn('useDB.safeStore: skipping put - missing word key', obj);
              return;
            }
            // ensure word is a non-empty trimmed string (IndexedDB keyPath must evaluate)
            const w = typeof obj.word === 'string' ? obj.word.trim() : String(obj.word);
            if (!w) {
              console.warn('useDB.safeStore: skipping put - empty word value', obj);
              return;
            }
            obj.word = w; // normalize
            return store.put(obj);
          } catch (e) {
            console.warn('useDB.safeStore: put failed', e, obj);
            return;
          }
        },
        add(obj) {
          try { return store.add(obj); } catch (e) { console.warn('useDB.safeStore: add failed', e, obj); }
        },
        delete(key) { try { return store.delete(key); } catch (e) { console.warn('useDB.safeStore: delete failed', e, key); } },
        clear() { try { return store.clear(); } catch (e) { console.warn('useDB.safeStore: clear failed', e); } },
        get(key) { try { return store.get(key); } catch (e) { console.warn('useDB.safeStore: get failed', e, key); } },
        openCursor(range, direction) { try { return store.openCursor(range, direction); } catch (e) { console.warn('useDB.safeStore: openCursor failed', e); } }
      };

      callback(safeStore);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    };
    request.onerror = reject;
  });
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loading').style.display = 'block';
  // initialize Google Identity button if available
  console.log('init: attempting to initialize Google Identity');
  const gbtn = document.getElementById('g_id_button');
  console.log('init: g_id_button element', !!gbtn);
  initGoogleIdentity();

  // Try to restore session (id_token) from sessionStorage to avoid logout on reload
  const restored = restoreSessionFromStorage();
  if (!restored) {
    // Not restored: show login UI (don't fetch user list until login)
    document.getElementById('loading').style.display = 'none';
    document.getElementById('word-container').style.display = 'none';
  }

  // sign-out button behaviour: attach handler regardless of restore state
  const signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      // Prefer disabling auto select to avoid FedCM/revoke cross-origin postMessage issues
      try {
        if (window.google && window.google.accounts && window.google.accounts.id && window.google.accounts.id.disableAutoSelect) {
          try { window.google.accounts.id.disableAutoSelect(); } catch (e) { console.warn('disableAutoSelect failed', e); }
        }
        // Note: window.google.accounts.id.revoke may cause FedCM disconnect/postMessage errors in some environments
        // so we avoid calling revoke here to prevent noisy errors. If you need full server-side revocation, call
        // the Google token revocation endpoint from your backend instead.
      } catch (e) {
        console.warn('signout helper failed', e);
      }

      // Clear client-side session regardless of the above
      currentIdToken = null;
      try { sessionStorage.removeItem('id_token'); } catch (e) {}
      userId = null;
  const userIcon = document.getElementById('user-icon');
  if (userIcon) { userIcon.title = '未ログイン'; if (typeof userIcon.textContent !== 'undefined') userIcon.textContent = '👤'; }
      signoutBtn.style.display = 'none';
      // clear local words view
      customWords = [];
      const wc = document.getElementById('word-container');
      if (wc) { wc.innerHTML = ''; wc.style.display = 'none'; }
    });
  }
});

//------------------------------------------
// 🔍 検索機能
//------------------------------------------
// ナビボタンをまとめている <nav> を取得
const nav = document.querySelector('nav');

// 検索ボックス作成
const searchBox = document.createElement('input');
searchBox.word = 'search-box';
searchBox.placeholder = '単語・意味で検索';
searchBox.style.marginLeft = '10px';
searchBox.style.marginTop = '8px';
searchBox.style.padding = '8px';
searchBox.style.flex = '1';            // 横幅を伸ばす場合
searchBox.style.minWidth = '150px';    // 最小幅
searchBox.style.boxSizing = 'border-box';

// nav の中に横並びで追加
nav.style.display = 'flex';
nav.style.alignItems = 'center';
nav.appendChild(searchBox);


searchBox.addEventListener('input', () => {
  const query = searchBox.value.trim().toLowerCase();
  if (!query) return renderWords();

  const filtered = customWords.filter(w =>
    w.userId === userId &&
    (
      (w.word && w.word.toLowerCase().includes(query)) ||
      (w.meaning_jp && w.meaning_jp.toLowerCase().includes(query)) ||
      (w.meaning && w.meaning.toLowerCase().includes(query))
    )
  );
  renderWords(filtered);
});

function updateCardDOM(word) {
  const id = word.word;
  if (!id) return;
  const container = document.getElementById('word-container');
  const sel = `.word-card[data-word="${CSS.escape(id)}"]`;
  const card = container.querySelector(sel);
  if (!card) return;

  // 更新箇所のみ差分で反映
  const h2 = card.querySelector('h2');
  if (h2) h2.textContent = word.word || '';

  const meaningJpEl = card.querySelector('.meaning_jp');
  if (meaningJpEl) meaningJpEl.innerHTML = (word.meaning_jp || '').replace(/\n/g, '<br>') || '<br>';

  const meaningEnEl = card.querySelector('.meaning_en');
  if (meaningEnEl) meaningEnEl.innerHTML = (word.meaning || '').replace(/\n/g, '<br>') || '&nbsp;&nbsp;&nbsp;&nbsp;';

  const exampleEl = card.querySelector('.example');
  if (exampleEl) exampleEl.innerHTML = (word.example || '').replace(/\n/g, '<br>') || '&nbsp;&nbsp;&nbsp;&nbsp;';

  const categoryEl = card.querySelector('.category');
  if (categoryEl) categoryEl.textContent = word.category || '';

  const chk = card.querySelector('.learned-checkbox');
  if (chk) chk.checked = !!learnedWords[id];
}

async function addWord(wordObj) {
  await new Promise(resolve => {
    useDB('readwrite', store => {
      if (!wordObj || !wordObj.word) {
        console.warn('Skipping IndexedDB put: item missing word key', wordObj);
      } else {
        store.put(wordObj);
      }
      resolve();
    });
  });

  await callSheetApi('add', { word: wordObj.word, meaning_jp: wordObj.meaning_jp, meaning: wordObj.meaning, example: wordObj.example, category: wordObj.category, userId });
  // prefer using callSheetApi for consistent id_token forwarding
  // await callSheetApi('add', { word: wordObj.word, meaning_jp: wordObj.meaning_jp, meaning: wordObj.meaning, example: wordObj.example, category: wordObj.category, userId });

  // 画面に新規カードだけ追加してちらつきを抑える
  const container = document.getElementById('word-container');
  const card = renderCard(wordObj, customWords.length - 1);
  container.appendChild(card);

  updateProgressBar();
}

async function editWord(index, field, value) {
  const cleanValue = value.trim();
  const word = customWords[index];
  if (word.userId !== userId) return; // 他人の単語は編集不可

  word[field] = cleanValue;
  customWords[index] = word;

  await new Promise((resolve) => {
    useDB('readwrite', store => {
      if (!word || !word.word) {
        console.warn('Skipping IndexedDB put: item missing word key', word);
      } else {
        store.put(word);
      }
      resolve(); // ✅ IndexedDB 保存完了
    });
  });


  await callSheetApi('update', { word: word.word, meaning_jp: word.meaning_jp, meaning: word.meaning, example: word.example, category: word.category, userId: word.userId });
  // alternatively: await callSheetApi('update', { word: word.word, meaning_jp: word.meaning_jp, meaning: word.meaning, example: word.example, category: word.category, userId: word.userId });

  // 全体再描画の代わりに該当カードを差分更新
  try { updateCardDOM(word); } catch (e) { console.error(e); }
}

async function updateLearningStatus(word, learned, streak) {
  const word2 = customWords.find(w => w.word === word && w.userId === userId);
  if (!word2) return;
  word2.learned = learned;
  word2.streak = streak;

  // ローカルキャッシュも確実に更新して永続化
  learnedWords[word] = !!word2.learned;
  correctStreaks[word] = Number(word2.streak) || 0;
  localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
  localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

  await new Promise(resolve => {
    useDB('readwrite', store => {
      // Ensure the object has the keyPath 'word' before putting to IndexedDB
      if (!word2 || !word2.word) {
        console.warn('Skipping IndexedDB put: item missing word key', word2);
      } else {
        store.put(word2);
      }
      resolve();
    });
  });

  try {
    await callSheetApi('update', { word: word2.word, learned: word2.learned, streak: word2.streak, userId: word2.userId });
  } catch (e) {
    console.error('Sheets update failed', e);
  }
  // consider using: await callSheetApi('update', { word: word2.word, learned: word2.learned, streak: word2.streak, userId: word2.userId });
}

function deleteWord(index) {
  const word = customWords[index];
  if (word.userId !== userId) return; // 他人の単語は削除不可

  const id = word.word;
  if (!confirm('この単語を削除しますか？')) return;
  customWords.splice(index, 1);
  useDB('readwrite', store => store.delete(id));
  callSheetApi('delete', { id, userId }).catch(e => console.warn('delete to Sheets failed', e));
  // Better: callSheetApi('delete', { id, userId }).catch(e => console.warn('delete to Sheets failed', e));

  // DOMから該当カードを削除（全再描画しない）
  const container = document.getElementById('word-container');
  const sel = `.word-card[data-word="${CSS.escape(id)}"]`;
  const card = container.querySelector(sel);
  if (card) card.remove();

  updateProgressBar();
}

function toggleLearned(word, checked) {
  learnedWords[word] = checked;
  localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
  if (checked !== true) {
    correctStreaks[word] = 0; // ← streak をリセット
    localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
  }
  updateLearningStatus(word, checked, correctStreaks[word]); // ← これを追加
  updateProgressBar();
}

function updateProgressBar() {
  const myWords = customWords.filter(w => w.userId === userId);
  const total = myWords.length;
  const validIds = myWords.map(w => w.word);
  const learnedCount = validIds.filter(word => learnedWords[word]).length;
  const percent = total === 0 ? 0 : Math.round((learnedCount / total) * 100);

  const progressTextEl = document.getElementById('progress-text');
  if (progressTextEl) progressTextEl.textContent = `${percent}%`;
  const fill = document.getElementById('progress-fill');
  fill.style.width = `${percent}%`;
  fill.style.backgroundColor = percent < 40 ? 'red' : percent < 80 ? 'orange' : 'green';
}

function renderCard(word, actualIndex) {
  const isLearned = learnedWords[word.word] || false;
  const meaning_jpHTML = word.meaning_jp ? word.meaning_jp.replace(/\n/g, '<br>') : '<br>';
  const meaningHTML = word.meaning ? word.meaning.replace(/\n/g, '<br>') : '&nbsp;&nbsp;&nbsp;&nbsp;';
  const exampleHTML = word.example ? word.example.replace(/\n/g, '<br>') : '&nbsp;&nbsp;&nbsp;&nbsp;';
  const categoryHTML = typeof word.category === 'string' ? word.category.replace(/,/g, ',&nbsp;&nbsp;') : Array.isArray(word.category) ? word.category.join(',&nbsp;&nbsp;') : '';

  const card = document.createElement('div');
  card.className = 'word-card';
  card.dataset.word = word.word;
  card.innerHTML = `
    <div class="word-header">
      <h2 contenteditable="true">${word.word || ''}</h2>
      <button class="play-btn" title="発音を再生">🔊</button>
    </div>

    <p class="meaning" style="display:none;"><strong>意味:</strong> 
      <span class="value meaning_jp" contenteditable="true">${meaning_jpHTML}</span>
    </p>
    <button class="show-meaning-btn">意味を見る</button>

    <div class="row">
      <span class="label"><strong>定義:</strong></span>
      <span class="value scrollable meaning_en" contenteditable="true">${meaningHTML}</span>
    </div>

    <div class="row">
      <span class="label "><strong>例文:</strong></span>
      <span class="value scrollable example" contenteditable="true">${exampleHTML}</span>
    </div>

    <div class="row">
      <span class="label"><strong>カテゴリー:</strong></span>
      <span class="value category" contenteditable="true">${categoryHTML}</span>
    </div>

    <label>
      <input type="checkbox" class="learned-checkbox" ${isLearned ? 'checked' : ''}>
      習得済み
    </label>

    <button class="delete-btn">削除</button>
    <button class="auto-fill-btn">自動入力</button>
  `;

  // イベント割当（既存の editWord(index, field, value) を使う）
  const h2 = card.querySelector('h2');
  if (h2) {
    h2.addEventListener('blur', () => {
      const idx = customWords.findIndex(w => w.word === word.word);
      editWord(idx, 'word', h2.textContent || '');
    });
  }

  const playBtn = card.querySelector('.play-btn');
  if (playBtn) playBtn.addEventListener('click', () => speak(String(word.word)));

  const showBtn = card.querySelector('.show-meaning-btn');
  const meaningP = card.querySelector('.meaning');
  if (showBtn && meaningP) {
    showBtn.addEventListener('click', () => {
      meaningP.style.display = 'block';
      showBtn.style.display = 'none';
    });
  }

  // contenteditable fields
  const mapField = { 'meaning_jp': '.meaning_jp', 'meaning': '.meaning_en', 'example': '.example', 'category': '.category' };
  Object.keys(mapField).forEach(field => {
    const el = card.querySelector(mapField[field]);
    if (el) {
      el.addEventListener('blur', () => {
        const idx = customWords.findIndex(w => w.word === word.word);
        editWord(idx, field, el.innerHTML || el.textContent || '');
      });
    }
  });

  const chk = card.querySelector('.learned-checkbox');
  if (chk) {
    chk.addEventListener('change', () => toggleLearned(word.word, chk.checked));
  }

  const delBtn = card.querySelector('.delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      const idx = customWords.findIndex(w => w.word === word.word);
      if (idx !== -1) deleteWord(idx);
    });
  }

  const autoBtn = card.querySelector('.auto-fill-btn');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      const idx = customWords.findIndex(w => w.word === word.word);
      if (idx !== -1) {
        // 押下フィードバック & 連打防止
        autoBtn.disabled = true;
        autoBtn.textContent = '取得中...';
        autoBtn.style.opacity = '0.5';
        autoBtn.style.pointerEvents = 'none';
        enrichWordFromDictionary(idx);
      }
    });
  }

  return card;
}

function renderWords(words = customWords) {
  const container = document.getElementById('word-container');
  container.innerHTML = '';

  const myWords = words.filter(w => w.userId === userId); // ← 自分の単語だけ表示

  const batchSize = 10;
  let index = 0;

  function renderBatch() {
    const slice = myWords.slice(index, index + batchSize);
    slice.forEach((word, i) => {
      const actualIndex = customWords.findIndex(w => w.word === word.word);
      const card = renderCard(word, actualIndex);
      container.appendChild(card);
    });

    index += batchSize;
    if (index < myWords.length) {
      setTimeout(renderBatch, 50);
    } else {
      updateProgressBar();
    }
  }

  renderBatch();
}

let currentFilter = 'all'; // 'learned' / 'unlearned' / 'all'

function applyFilter(type) {
  currentFilter = type;
  const myWords = customWords.filter(w => w.userId === userId); // ← 自分の単語だけ

  let filtered = [];
  if (type === 'learned') {
    filtered = myWords.filter(word => learnedWords[word.word]);
  } else if (type === 'unlearned') {
    filtered = myWords.filter(word => !learnedWords[word.word]);
  } else {
    filtered = myWords;
  }

  renderWords(filtered);
}

function getFilteredWords() {
  const myWords = customWords.filter(w => w.userId === userId);
  if (currentFilter === 'learned') {
    return myWords.filter(word => learnedWords[word.word]);
  } else if (currentFilter === 'unlearned') {
    return myWords.filter(word => !learnedWords[word.word]);
  } else {
    return [...myWords];
  }
}

function shuffleWords() {
  const filtered = getFilteredWords();
  const shuffled = [...filtered].sort(() => Math.random() - 0.5);
  renderWords(shuffled);
}

//------------------------------------------
// 🧠 クイズ機能
//------------------------------------------
function toggleQuizMode() {
  quizMode = quizMode === 'en-to-ja' ? 'ja-to-en' : 'en-to-ja';
  localStorage.setItem('quizMode', quizMode);
  const quizModeLabelEl = document.getElementById('quiz-mode-label');
  if (quizModeLabelEl) quizModeLabelEl.textContent = quizMode === 'en-to-ja' ? '英→日' : '日→英';
  startQuiz();
}

function startQuiz() {
  const quizArea = document.getElementById('quiz-area');
  quizArea.innerHTML = '';

  const myWords = customWords.filter(w => w.userId === userId); // ← 自分の単語だけ
  const unlearned = myWords.filter(w => !learnedWords[w.word]);
  const learned = myWords.filter(w => learnedWords[w.word]);

  let pool = [];

  if (unlearned.length > 0) {
    const sortedByStreak = [...learned].sort((a, b) => (correctStreaks[a.word] || 0) - (correctStreaks[b.word] || 0));
    pool = [...unlearned, ...sortedByStreak.slice(0, 100)]; // 未習得を中心に、習得済みもcorrectStreaksが小さいほうから100個混ぜる
  } else {
    pool = [...learned];
  }

  const question = pool[Math.floor(Math.random() * pool.length)];
  currentQuestion = question;

  const distractors = shuffle(
    myWords.filter(w => w.word !== question.word)
      .map(w => quizMode === 'en-to-ja' ? w.meaning_jp : w.word)
  ).slice(0, 4);

  const correctAnswer = quizMode === 'en-to-ja' ? question.meaning_jp : question.word;
  const choices = shuffle([correctAnswer, ...distractors]);

  const questionText = quizMode === 'en-to-ja'
    ? `「${question.word}」の意味は？`
    : `「${question.meaning_jp}」に対応する英単語は？`;

  quizArea.innerHTML = `
    <h3>${questionText}<button class="play-btn" title="発音を再生">🔊</button><button onclick="toggleQuizMode()">切り替え: <span id="quiz-mode-label">${quizMode === 'en-to-ja' ? '英→日' : '日→英'}</span></button></h3>
    ${choices.map(c => `<button onclick="checkAnswer('${c}', '${correctAnswer}', '${question.word}')">${c}</button>`).join('')}
  `;

  const playBtn = quizArea.querySelector('.play-btn');
  if (playBtn) playBtn.addEventListener('click', () => speak(String(question.word)));
}

function checkAnswer(selected, correct, word) {
  const quizArea = document.getElementById('quiz-area');
  quizArea.style.backgroundColor = selected === correct ? '#d4edda' : '#f8d7da';

  setTimeout(() => {
    quizArea.style.backgroundColor = '';

    if (selected === correct) {
      correctStreaks[word] = (correctStreaks[word] || 0) + 1;
      localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

      if (correctStreaks[word] >= 3) {
        learnedWords[word] = true;
        localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
      }
    } else {
      correctStreaks[word] = 0;
      localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

      if (learnedWords[word]) {
        learnedWords[word] = false;
        localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
      }

      alert(`不正解… 正しくは「${correct}」`);
    }

    // DB とシートに確実に状態を送る（数値化して渡す）
    try {
      updateLearningStatus(word, !!learnedWords[word], Number(correctStreaks[word] || 0));
    } catch (e) {
      console.error('updateLearningStatus failed', e);
    }

    startQuiz();
  }, 500);
}

function shuffle(arr) {
  // Fisher–Yates shuffle
  const a = Array.isArray(arr) ? arr.slice() : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- ここから追加: 音声再生機能 (Web Speech API) ---
function detectLang(text) {
  if (!text) return 'en-US';
  // 日本語文字が含まれるなら日本語、それ以外は英語を基本にする簡易判定
  if (/[一-龯ぁ-ゔァ-ヴー々〆〤]/.test(text)) return 'ja-JP';
  return 'en-US';
}

let cachedVoice = null;
function pickVoiceForLang(lang) {
  const voices = window.speechSynthesis.getVoices() || [];
  const short = (lang || 'en-US').toLowerCase().slice(0,2);

  // 1) 同言語かつ名前に Female 等を含む音声を優先
  let v = voices.find(vo => vo.lang && vo.lang.toLowerCase().slice(0,2) === short && /female|女性|frau|femme|woman|girl|女/i.test(vo.name));
  if (v) return v;

  // 2) 同言語の最初の音声
  v = voices.find(vo => vo.lang && vo.lang.toLowerCase().slice(0,2) === short);
  if (v) return v;

  // 3) フォールバックで先頭
  return voices[0] || null;
}

// voices が読み込まれたタイミングでキャッシュをセット
if ('speechSynthesis' in window) {
  const setInitialVoice = () => {
    if (!cachedVoice) cachedVoice = pickVoiceForLang('en-US');
  };
  // 既に読み込まれていれば即セット
  if (window.speechSynthesis.getVoices().length) setInitialVoice();
  // 後から読み込まれる場合に対応
  window.speechSynthesis.addEventListener('voiceschanged', setInitialVoice);
}

// 修正: speak 関数で毎回再選択しないよう cachedVoice を使う
function speak(text, lang) {
  if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang || detectLang(text);

  // すでにキャッシュされた voice があれば使う。なければ候補を取得してキャッシュして使う
  try {
    if (!cachedVoice) {
      cachedVoice = pickVoiceForLang(utter.lang);
    }
    if (cachedVoice) utter.voice = cachedVoice;
  } catch (e) {
    console.error('voice selection error', e);
  }

  try { window.speechSynthesis.cancel(); } catch (e) {}
  window.speechSynthesis.speak(utter);
}

document.getElementById('add-word-form').addEventListener('submit', function(e) {
  e.preventDefault();

  const addButton = document.getElementById('add-button');
  addButton.disabled = true;
  addButton.textContent = '追加中...';
  addButton.style.opacity = '0.5';
  addButton.style.cursor = 'not-allowed';


  const word = document.getElementById('new-word').value.trim();
  const meaning_jp = document.getElementById('new-meaning-ja').value.trim();
  const meaning = document.getElementById('new-meaning').value.trim();
  const example = document.getElementById('new-example').value.trim();
  const category = document.getElementById('new-category').value.trim();

  if (!word) {
    addButton.disabled = false;
    addButton.textContent = '追加';
    addButton.style.opacity = '1';
    addButton.style.cursor = 'pointer';
    return;
  }

  if (customWords.some(w => w.word === word)) {
    const shouldUpdate = confirm('この単語はすでに存在します。\n更新しますか？（キャンセルで中止）');
    if (!shouldUpdate) {
      addButton.disabled = false;
      addButton.textContent = '追加';
      addButton.style.opacity = '1';
      addButton.style.cursor = 'pointer';
      return;
    }


    // ✅ 更新処理：IndexedDBとGoogle Sheetsに上書き
    const updatedWord = {userId, word, meaning_jp, meaning, example, category};

    useDB('readwrite', store => {
      if (!updatedWord || !updatedWord.word) {
        console.warn('Skipping IndexedDB put for updatedWord without word key', updatedWord);
      } else {
        try { store.put(updatedWord); } catch (e) { console.warn('IndexedDB put failed for updatedWord', e, updatedWord); }
      }
    });

    callSheetApi('update', updatedWord).then(() => {
      const index = customWords.findIndex(w => w.word === word);
      if (index !== -1) customWords[index] = updatedWord;
      renderWords();
      updateProgressBar();
      this.reset();
    }).catch(err => {
      alert('Google Sheetsの更新に失敗しました');
      console.error(err);
    }).finally(() => {
      addButton.disabled = false;
      addButton.textContent = '追加';
      addButton.style.opacity = '1';
      addButton.style.cursor = 'pointer';
    });

    return;
  }


  const newWord = { userId, word, meaning_jp, meaning, example, category };

  if (!userId) {
    alert('先に Google でログインしてください。');
    addButton.disabled = false;
    addButton.textContent = '追加';
    addButton.style.opacity = '1';
    addButton.style.cursor = 'pointer';
    return;
  }

  // IndexedDB に保存
  useDB('readwrite', store => {
    if (!newWord || !newWord.word) {
      console.warn('Skipping IndexedDB put for newWord without word key', newWord);
    } else {
      try { store.put(newWord); } catch (e) { console.warn('IndexedDB put failed for newWord', e, newWord); }
    }
  });

  // Google Sheets に送信
  callSheetApi('add', { word: newWord.word, meaning_jp: newWord.meaning_jp, meaning: newWord.meaning, example: newWord.example, category: newWord.category, userId: newWord.userId }).then(() => {
    customWords.push(newWord);
    renderWords();
    updateProgressBar();
    this.reset();
  }).catch(err => {
    alert('Google Sheetsへの保存に失敗しました');
    console.error(err);
  }).finally(() => {
    addButton.disabled = false;
    addButton.textContent = '追加';
    addButton.style.opacity = '1';
    addButton.style.cursor = 'pointer';
  });

});

function showSection(name) {
  document.getElementById('add-section').style.display = name === 'add' ? 'block' : 'none';
  document.getElementById('quiz-section').style.display = name === 'quiz' ? 'block' : 'none';

  if (name === 'quiz') startQuiz();
}

let debounceTimer;

document.getElementById('new-word').addEventListener('input', async function () {
  clearTimeout(debounceTimer);

  // 入力が空なら補完欄をクリアして終了
  const word = this.value.trim();
  if (!word) {
    document.getElementById('new-meaning').value = '';
    document.getElementById('new-example').value = '';
    document.getElementById('new-category').value = '';
    return;
  }

  debounceTimer = setTimeout(async () => {
    const lang = 'en'; // 必要に応じて 'en-us', 'en-uk', 'en-cn' などに変更

    try {
      console.log('fetch開始');
      const res = await fetch(`https://cambridge-dictionaryapi.vercel.app/api/dictionary/${lang}/${word}`);
      if (!res.ok) {
        console.warn('Cambridge API returned', res.status);
        document.getElementById('new-meaning').value = '';
        document.getElementById('new-example').value = '';
        document.getElementById('new-category').value = '';
        return;
      }
      const data = await res.json();

      console.log(data); // デバッグ用
      console.log(JSON.stringify(data, null, 2));
      const allExamples = Array.isArray(data.definition)
        ? data.definition.flatMap(def =>
            Array.isArray(def.example)
              ? def.example.map(e => e.text)
              : []
          )
        : [];

      const formattedMeanings = Array.isArray(data.definition)
        ? data.definition.slice(0, 3).map((d) => `${d.text}`).join('\n')
        : data.definition || '';

      const formattedExamples = allExamples
        .filter(e => e && e.trim() !== '')
        .slice(0, 2)
        .join('\n');

      const category = Array.isArray(data.pos)
        ? data.pos.filter(Boolean).join(', ')
        : typeof data.pos === 'string' ? data.pos : '';

      document.getElementById('new-meaning').value = formattedMeanings;
      document.getElementById('new-example').value = formattedExamples;
      document.getElementById('new-category').value = category;
    } catch (err) {
      console.error('辞書情報の取得に失敗しました', err);
      alert('辞書情報の取得に失敗しました。ネットワークや単語を確認してください。');
      document.getElementById('new-meaning').value = '';
      document.getElementById('new-example').value = '';
      document.getElementById('new-category').value = '';
    }
  }, 300); // ← 入力が止まってから0.3秒後に実行
});

async function enrichWordFromDictionary(index) {
  const wordObj = customWords[index];
  const card = wordObj ? document.querySelector(`.word-card[data-word="${CSS.escape(wordObj.word || '')}"]`) : null;
  let button = card ? card.querySelector('.auto-fill-btn') : null;
  if (button) {
    button.disabled = true;
    button.textContent = '取得中...';
    button.style.opacity = '0.5';
    button.style.pointerEvents = 'none';
  }

  try {
    if (!wordObj) return;
    const word = (wordObj.word || '').trim();
    if (!word) return;
    
    const res = await fetch(`https://cambridge-dictionaryapi.vercel.app/api/dictionary/en/${word}`);
    if (!res.ok) throw new Error('Cambridge API failed');
    const data = await res.json();

    // 定義（最大3つ）
    const formattedMeanings = Array.isArray(data.definition)
      ? data.definition.slice(0, 3).map(d => d.text).join('\n')
      : data.definition || '';

    // 例文（最大2つ）
    const allExamples = Array.isArray(data.definition)
      ? data.definition.flatMap(def => {
          if (Array.isArray(def.example)) {
            return def.example.map(e => e.text);
          } else if (def.example && typeof def.example.text === 'string') {
            return [def.example.text];
          } else {
            return [];
          }
        })
      : [];

    const formattedExamples = allExamples
      .filter(e => e && e.trim() !== '')
      .slice(0, 2)
      .join('\n');

    // 品詞（カテゴリー）
    const category = Array.isArray(data.pos)
      ? data.pos.join(', ')
      : data.pos || '';

    wordObj.meaning = formattedMeanings;
    wordObj.example = formattedExamples;
    wordObj.category = category;

    await new Promise((resolve, reject) => {
      useDB('readwrite', store => {
        if (!wordObj || !wordObj.word) {
          console.warn('Skipping IndexedDB put during enrich: missing word key', wordObj);
        } else {
          store.put(wordObj);
        }
        resolve(); // ✅ 保存完了 or skipped
      });
    });

    // Send update to server (centralized helper adds id_token)
    try {
      console.log('calling callSheetApi update for', wordObj.word);
      const resp = await callSheetApi('update', {
        word: wordObj.word,
        meaning: wordObj.meaning,
        example: wordObj.example,
        category: wordObj.category,
        userId: wordObj.userId || userId
      });
      console.log('callSheetApi update response:', resp);
      // Determine success in several server response styles
      let updated = false;
      if (resp && typeof resp === 'object' && resp.success) updated = true;
      if (typeof resp === 'string' && /updated|added|ok|success/i.test(resp)) updated = true;

      if (updated) {
        const idx = customWords.findIndex(w => w.word === wordObj.word && (w.userId === (wordObj.userId || userId)));
        if (idx !== -1) customWords[idx] = wordObj; else customWords.push(wordObj);
        updateCardDOM(wordObj);
      } else {
        console.warn('Update did not report success; attempting to add instead', resp);
        // ensure userId is set so add will attribute correctly
        wordObj.userId = wordObj.userId || userId;
        const addResp = await callSheetApi('add', { word: wordObj.word, meaning_jp: wordObj.meaning_jp || '', meaning: wordObj.meaning || '', example: wordObj.example || '', category: wordObj.category || '', userId: wordObj.userId });
        console.log('callSheetApi add response:', addResp);
        let added = false;
        if (addResp && typeof addResp === 'object' && addResp.success) added = true;
        if (typeof addResp === 'string' && /added|ok|success/i.test(addResp)) added = true;
        if (added) {
          // reflect in UI
          const idx2 = customWords.findIndex(w => w.word === wordObj.word && w.userId === wordObj.userId);
          if (idx2 === -1) customWords.push(wordObj);
          updateCardDOM(wordObj);
          if (button) {
            button.textContent = '保存しました';
            setTimeout(() => { if (button) button.textContent = '自動入力'; }, 1500);
          }
        } else {
          console.error('Neither update nor add succeeded', resp, addResp);
          alert('シートへの反映に失敗しました（詳細はコンソール）。');
        }
      }
    } catch (e) {
      console.error('Failed to update sheet via callSheetApi', e);
      throw e;
    }
  } catch (err) {
    console.error('辞書情報の取得に失敗しました', err);
    alert('辞書情報の取得に失敗しました。ネットワークや単語を確認してください。');
  }finally {
    if (button) {
      button.disabled = false;
      button.textContent = '自動入力';
      button.style.opacity = '1';
      button.style.pointerEvents = 'auto';
    }
  }
}
