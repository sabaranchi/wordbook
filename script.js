
let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = [];
let currentQuestion = null;
let question = null;
let quizMode = localStorage.getItem('quizMode') || 'en-to-ja'; // en-to-ja / ja-to-en
let correctStreaks = JSON.parse(localStorage.getItem('correctStreaks') || '{}');
let userId = localStorage.getItem('userId');
if (!userId) {
  userId = 'user-' + Math.random().toString(36).slice(2);
  localStorage.setItem('userId', userId);
}
document.getElementById('user-id-display').textContent = userId;
function setManualUserId() {
  const input = document.getElementById('manual-userid');
  const word = input.value.trim();
  if (word) {
    localStorage.setItem('userId', word);
    alert('userIdをセットしました: ' + word);
    location.reload(); // 再読み込みで反映
  }
}



const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbximFpa3J21ua8wAN4MmvYWANYcEbDjZMNm4YTuPK0ksKiFWFF3nK1M43J8bclwKo_9Uw/exec';

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
      callback(store);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    };
    request.onerror = reject;
  });
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loading').style.display = 'block';

  useDB('readonly', store => {
    store.getAll().onsuccess = e => {
      const localWords = e.target.result;
      if (localWords.length > 0) {
        customWords = localWords;
      }

      fetch(SHEET_API_URL)
        .then(res => res.json())
        .then(data => {
          customWords = data.map((word, i) => ({
            ...word,
            rowIndex: i
          }));

          // ✅ ここで learnedWords と correctStreaks を再構築
          learnedWords = {};
          correctStreaks = {};
          data.forEach(word => {
            learnedWords[word.word] = word.learned === true || word.learned === 'TRUE';
            correctStreaks[word.word] = Number(word.streak) || 0;
          });
          localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
          localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

          useDB('readwrite', store => {
            store.clear();
            customWords.forEach(word => store.put(word));
          });
          document.getElementById('loading').style.display = 'none';
          document.getElementById('word-container').style.display = 'block';
          renderWords();
        });
    };
  });
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
      store.put(wordObj);
      resolve();
    });
  });

  await fetch(`${SHEET_API_URL}?action=add`, {
    method: 'POST',
    body: new URLSearchParams({
      action: 'add',
      word: wordObj.word,
      meaning_jp: wordObj.meaning_jp,
      meaning: wordObj.meaning,
      example: wordObj.example,
      category: wordObj.category,
      userId: userId
    })
  });

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
      store.put(word);
      resolve(); // ✅ IndexedDB 保存完了
    });
  });


  await fetch(`${SHEET_API_URL}?action=update`, {
    method: 'POST',
    body: new URLSearchParams({
      action: 'update',
      word: word.word,
      meaning_jp: word.meaning_jp,
      meaning: word.meaning,
      example: word.example,
      category: word.category,
      userId: word.userId
    })
  });

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
      store.put(word2);
      resolve();
    });
  });

  try {
    await fetch(`${SHEET_API_URL}?action=update`, {
      method: 'POST',
      body: new URLSearchParams({
        action: 'update',
        word: word2.word,
        learned: word2.learned,
        streak: word2.streak,
        userId: word2.userId
      })
    });
  } catch (e) {
    console.error('Sheets update failed', e);
  }
}

function deleteWord(index) {
  const word = customWords[index];
  if (word.userId !== userId) return; // 他人の単語は削除不可

  const id = word.word;
  if (!confirm('この単語を削除しますか？')) return;
  customWords.splice(index, 1);
  useDB('readwrite', store => store.delete(id));
  fetch(`${SHEET_API_URL}?action=delete&id=${id}`, {
    method: 'POST',
    body: JSON.stringify({ id, userId }),
    mode: 'no-cors'
  });

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

  document.getElementById('progress-text').textContent = `${percent}%`;
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
  document.getElementById('quiz-mode-label').textContent = quizMode === 'en-to-ja' ? '英→日' : '日→英';
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
    pool = [...unlearned, ...sortedByStreak.slice(0, 50)]; // 未習得を中心に、習得済みもcorrectStreaksが小さいほうから５０個混ぜる
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

    useDB('readwrite', store => store.put(updatedWord));

    fetch(SHEET_API_URL + '?action=update', {
      method: 'POST',
      body: JSON.stringify(updatedWord)
    }).then(() => {
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

  // IndexedDB に保存
  useDB('readwrite', store => store.put(newWord));

  // Google Sheets に送信
  fetch(SHEET_API_URL, {
    method: 'POST',
    body: new URLSearchParams({
      action: 'add',
      word: newWord.word,
      meaning_jp: newWord.meaning_jp,
      meaning: newWord.meaning,
      example: newWord.example,
      category: newWord.category,
      userId: newWord.userId
    })
  }).then(() => {
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
        store.put(wordObj);
        resolve(); // ✅ 保存完了
      });
    });

    const formData = new URLSearchParams();
    formData.append('action', 'update');
    formData.append('word', wordObj.word);
    formData.append('meaning', wordObj.meaning);
    formData.append('example', wordObj.example);
    formData.append('category', wordObj.category);
    formData.append('userId', wordObj.userId || userId);;

    await fetch(`${SHEET_API_URL}?action=update`, {
      method: 'POST',
      body: formData,
    });
    updateCardDOM(wordObj);
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


/*
CORSを回避できるのはdoGET()とdoPOST()のみだからすべての操作をdoPOST()に統合して、
function editWord(index, field, value) {
  const word = customWords[index];
  word[field] = value.trim();
  useDB('readwrite', store => store.put(word));
  fetch(`${SHEET_API_URL}?action=update`, {
    method: 'POST',
    body: JSON.stringify(word),
    mode: 'no-cors'
  });
  renderWords();
}
のようにmode: 'no-cors'を指定する

javascript:localStorage.setItem('userId','user-0')*/