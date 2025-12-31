
let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = [];
let currentQuestion = null;
let question = null;
let quizMode = localStorage.getItem('quizMode') || 'en-to'; // en-to / ja-to-en
let correctStreaks = JSON.parse(localStorage.getItem('correctStreaks') || '{}');
// Enforce Google login only: no local/manual userId
let userId = null;



// When using server proxy on Vercel, set to '/api/sheets-proxy'.
// Otherwise set to your Apps Script URL.
const SHEET_API_URL = '/api/sheets-proxy';
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

// Try prompting One Tap / FedCM safely. On error, show user-facing fallback banner.
async function tryPromptGoogleOneTap(timeoutMs = 4000) {
  try {
    if (!(window.google && window.google.accounts && window.google.accounts.id)) return false;

    // Call prompt without relying on the notification.status helper methods
    // which may be deprecated when FedCM becomes mandatory. We instead
    // wait for a credential to arrive (handleCredentialResponse sets
    // `currentIdToken`) and fall back after a short timeout.
    try {
      window.google.accounts.id.prompt();
    } catch (err) {
      console.warn('GSI prompt invocation failed:', err);
      showGsiFallback('自動サインインに失敗しました。手動でログインしてください。');
      return false;
    }

    // Wait for credential to be set by handleCredentialResponse or timeout
    const start = Date.now();
    return await new Promise((resolve) => {
      const check = () => {
        if (currentIdToken) {
          // credential arrived — ensure fallback UI is hidden and resolve
          try { hideGsiFallback(); } catch (e) {}
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          // timeout — show friendly fallback UI so user can sign in manually
          showGsiFallback('自動サインインがタイムアウトしました。手動でログインしてください。');
          resolve(false);
          return;
        }
        // poll a few times until timeout
        setTimeout(check, 150);
      };
      check();
    });
  } catch (err) {
    console.warn('GSI prompt failed:', err);
    showGsiFallback('自動サインイン中にエラーが発生しました。手動でログインしてください。');
    return false;
  }
}

function showGsiFallback(msg) {
  try {
    const el = document.getElementById('gsi-fallback-banner');
    const text = document.getElementById('gsi-fallback-text');
    if (text && msg) text.textContent = msg;
    if (el) el.classList.add('visible');
  } catch (e) { console.warn('showGsiFallback failed', e); }
}

function hideGsiFallback() {
  try { const el = document.getElementById('gsi-fallback-banner'); if (el) el.classList.remove('visible'); } catch (e) {}
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

    // Create server-side session so the browser keeps login across restarts
    (async () => {
      try {
        const sessionResp = await fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id_token: currentIdToken })
        });
        const sessionData = await sessionResp.json();
        console.log('session create response', sessionData);
        
        // 📱 スマホ対策: Cookie がブロックされた場合の検出
        if (sessionData && sessionData.ok) {
          // セッション作成成功 → 次のリクエストで Cookie が送られるか確認
          setTimeout(async () => {
            try {
              const checkResp = await fetch('/api/session', { method: 'GET', credentials: 'include' });
              const checkData = await checkResp.json();
              if (!checkData.loggedIn) {
                console.warn('⚠️ Session cookie blocked! Falling back to id_token mode');
                sessionStorage.setItem('cookie_blocked', 'true');
              } else {
                console.log('✅ Session cookie works');
                sessionStorage.removeItem('cookie_blocked');
              }
            } catch (e) {
              console.warn('Session check failed', e);
            }
          }, 500);
        }
      } catch (e) { 
        console.warn('session create threw', e); 
      }
    })();

    // Hybrid flow: first render local cache (fast), then fetch server list in background and sync
    readLocalAll().then(localRows => {
      if (Array.isArray(localRows) && localRows.length > 0) {
        customWords = localRows.map((w, i) => ({ ...w, rowIndex: i }));
        // rebuild state from local
        learnedWords = {};
        correctStreaks = {};
        customWords.forEach(word => {
          learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
          correctStreaks[word.word] = Number(word.streak) || 0;
        });
        localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
        localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
        document.getElementById('loading').style.display = 'none';
        document.getElementById('word-container').style.display = 'block';
        renderWords();
      }

      // now fetch server data and reconcile
      callSheetApi('list').then(serverData => {
        if (!Array.isArray(serverData)) serverData = [];
        // normalize and write to indexedDB
        useDB('readwrite', store => {
          try { store.clear(); } catch (e) { /* ignore */ }
          serverData.forEach((w, i) => {
            if (!w || !w.word) {
              console.warn('Skipping server row without word key', w);
            } else {
              store.put(w);
            }
          });
        }).then(() => {
          customWords = serverData.map((word, i) => ({ ...word, rowIndex: i }));
          // rebuild learnedWords and correctStreaks from server
          learnedWords = {};
          correctStreaks = {};
          customWords.forEach(word => {
            learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
            correctStreaks[word.word] = Number(word.streak) || 0;
          });
          localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
          localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
          renderWords();
        }).catch(e => console.warn('Failed to write server rows to IndexedDB', e));
      }).catch(err => {
        console.warn('Background fetch of server list failed', err);
      });
    }).catch(err => {
      console.warn('readLocalAll failed', err);
      // fallback: still try server fetch
      callSheetApi('list').then(serverData => {
        if (!Array.isArray(serverData)) serverData = [];
        customWords = serverData.map((word, i) => ({ ...word, rowIndex: i }));
        renderWords();
      }).catch(e => {
        console.error('failed to load sheet data after login', e);
        alert('データの取得に失敗しました。コンソールを確認してください。');
      });
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
      // Hybrid: render local first, then background fetch server and sync
      readLocalAll().then(localRows => {
        if (Array.isArray(localRows) && localRows.length > 0) {
          customWords = localRows.map((w, i) => ({ ...w, rowIndex: i }));
          learnedWords = {};
          correctStreaks = {};
          customWords.forEach(word => {
            learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
            correctStreaks[word.word] = Number(word.streak) || 0;
          });
          localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
          localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
          document.getElementById('loading').style.display = 'none';
          document.getElementById('word-container').style.display = 'block';
          renderWords();
        }

        callSheetApi('list').then(serverData => {
          if (!Array.isArray(serverData)) serverData = [];
          useDB('readwrite', store => {
            try { store.clear(); } catch (e) {}
            serverData.forEach(w => {
              if (!w || !w.word) { console.warn('Skipping server row without word key', w); } else { store.put(w); }
            });
          }).then(() => {
            customWords = serverData.map((word, i) => ({ ...word, rowIndex: i }));
            learnedWords = {};
            correctStreaks = {};
            customWords.forEach(word => {
              learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
              correctStreaks[word.word] = Number(word.streak) || 0;
            });
            localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
            localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
            renderWords();
          }).catch(e => console.warn('Failed to write server rows to IndexedDB', e));
        }).catch(e => {
          console.warn('restore list fetch failed', e);
        });
      }).catch(e => {
        console.warn('readLocalAll failed during restore', e);
        // fallback to server-only
        callSheetApi('list').then(serverData => {
          if (!Array.isArray(serverData)) serverData = [];
          customWords = serverData.map((word, i) => ({ ...word, rowIndex: i }));
          renderWords();
        }).catch(err => {
          console.error('restore list failed', err);
          document.getElementById('loading').style.display = 'none';
          document.getElementById('word-container').style.display = 'block';
        });
      });

    return true;
  } catch (e) { return false; }
}

// Central helper to call the Apps Script endpoint. It attaches id_token when available.
async function callSheetApi(action, params = {}) {
  try {
    // If using server proxy (local path), send JSON and include credentials (cookie)
    if (SHEET_API_URL.startsWith('/api/')) {
      const cookieBlocked = sessionStorage.getItem('cookie_blocked') === 'true';
      const headers = { 'Content-Type': 'application/json' };
      
      // 📱 Cookie がブロックされている場合は Authorization ヘッダーで id_token を送る
      if (cookieBlocked && currentIdToken) {
        headers['Authorization'] = `Bearer ${currentIdToken}`;
        console.log('[callSheetApi] Using Bearer token (cookie blocked)');
      }
      
      const res = await fetch(SHEET_API_URL, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(Object.assign({ action }, params))
      });
      const text = await res.text();
      if (!res.ok) {
        console.error('callSheetApi HTTP error', res.status, text);
        if (res.status === 401 || res.status === 403) {
          // 📱 認証エラーの場合、Cookie確認を促す
          console.warn('Authentication failed. Cookie blocked?', sessionStorage.getItem('cookie_blocked'));
          showGsiFallback('認証エラー: ブラウザの設定で Cookie がブロックされている可能性があります。');
        }
        try { return JSON.parse(text); } catch (e) { return text; }
      }
      try { return JSON.parse(text); } catch (e) { return text; }
    }

    // Otherwise, call legacy Apps Script endpoint (attach id_token)
    const body = new URLSearchParams();
    body.append('action', action);
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === undefined || v === null) return;
      body.append(k, String(v));
    });
    // If we don't have an id_token for direct Apps Script calls, surface a message
    if (!currentIdToken) {
      console.warn('callSheetApi: missing id_token for Apps Script');
      showGsiFallback('操作を続行するには Google でログインしてください。');
      throw new Error('missing_id_token');
    }
    body.append('id_token', currentIdToken);

    const res = await fetch(SHEET_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('callSheetApi HTTP error', res.status, text);
      if (res.status === 401 || res.status === 403) {
        showGsiFallback('認証エラー: 再度ログインしてください。');
      }
      try { return JSON.parse(text); } catch (e) { return text; }
    }
    try { return JSON.parse(text); } catch (e) { return text; }
  } catch (e) {
    console.error('callSheetApi failed', e);
    // Surface user-friendly message for known error
    if (e && e.message === 'missing_id_token') throw e;
    showGsiFallback('通信エラーが発生しました。ネットワーク設定や拡張機能を確認してください。');
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

        // Defensive: ensure existing object store has expected keyPath. If not,
        // delete the DB and recreate it to align schema (prevents keyPath DataError).
        try {
          if (db.objectStoreNames && db.objectStoreNames.contains && db.objectStoreNames.contains('words')) {
            const checkTx = db.transaction('words', 'readonly');
            const checkStore = checkTx.objectStore('words');
            const existingKeyPath = checkStore.keyPath;
            if (existingKeyPath !== 'word') {
              console.warn('IndexedDB schema mismatch: existing keyPath=', existingKeyPath, "; recreating DB.");
              db.close();
              const delReq = indexedDB.deleteDatabase('WordDB');
              delReq.onsuccess = () => {
                // small delay then reopen
                setTimeout(() => {
                  useDB(mode, callback).then(resolve).catch(reject);
                }, 50);
              };
              delReq.onerror = () => {
                reject(new Error('failed_delete_legacy_db'));
              };
              return;
            }
          }
        } catch (err) {
          console.warn('useDB schema check failed', err);
          // fallthrough and try to continue
        }

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
            // Create a plain shallow copy to avoid prototype/immutable-object issues that
            // can cause IndexedDB to fail evaluating the keyPath on some platforms.
            const plain = Object.assign({}, obj);
            plain.word = w; // ensure own, trimmed property
            try {
              return store.put(plain);
            } catch (innerErr) {
              // Detailed debug: log types and keys to help track down why keyPath evaluation fails
              console.warn('useDB.safeStore: put threw, details:', innerErr, {
                original: obj,
                plainCopy: plain,
                wordType: typeof plain.word,
                wordValue: plain.word,
                keys: Object.keys(plain)
              });
              throw innerErr;
            }
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

/**
 * Read all rows from local IndexedDB 'words' store and return as array.
 */
function readLocalAll() {
  return new Promise((resolve, reject) => {
    try {
      useDB('readonly', store => {
        const req = store.openCursor();
        const out = [];
        req.onsuccess = function (e) {
          const cursor = e.target.result;
          if (cursor) {
            // shallow copy to detach from cursor
            out.push(Object.assign({}, cursor.value));
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        req.onerror = function (err) { reject(err); };
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loading').style.display = 'block';
  // initialize Google Identity button if available
  console.log('init: attempting to initialize Google Identity');
  const gbtn = document.getElementById('g_id_button');
  console.log('init: g_id_button element', !!gbtn);
  initGoogleIdentity();

  // ============================================================
  // イベント委譲：全カードのイベントを container 1つで処理
  // ============================================================
  const container = document.getElementById('word-container');
  if (!container) {
    console.error('[Init] word-container not found!');
    return;
  }
  console.log('[Init] Setting up event delegation on word-container');
  
  // クリックイベント（ボタン類）
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.word-card');
    if (!card) return;
    const wordId = card.dataset.word;
    const idx = customWords.findIndex(w => w.word === wordId);

    // 削除ボタン
    if (e.target.matches('.delete-btn')) {
      if (idx !== -1) deleteWord(idx);
      return;
    }

    // 音声再生ボタン
    if (e.target.matches('.play-btn')) {
      const word = customWords.find(w => w.word === wordId);
      if (word) speak(String(word.word));
      return;
    }

    // Show Meaning ボタン
    if (e.target.matches('.show-meaning-btn')) {
      const meaning = card.querySelector('.meaning');
      if (meaning) {
        meaning.style.display = 'block';
        e.target.style.display = 'none';
      }
      return;
    }

    // Auto Fill ボタン
    if (e.target.matches('.auto-fill-btn')) {
      if (idx !== -1) {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = '取得中...';
        btn.style.opacity = '0.5';
        btn.style.pointerEvents = 'none';
        enrichWordFromDictionary(idx);
      }
      return;
    }
  });

  // フォーカスアウトイベント（contenteditable の編集保存）
  container.addEventListener('focusout', (e) => {
    const card = e.target.closest('.word-card');
    if (!card) return;
    const wordId = card.dataset.word;
    const idx = customWords.findIndex(w => w.word === wordId);
    if (idx === -1) return;

    // 単語（h2）の編集
    if (e.target.matches('h2[contenteditable]')) {
      editWord(idx, 'word', e.target.textContent || '');
      return;
    }

    // Meaning (JP) の編集
    if (e.target.matches('.meaning_jp')) {
      editWord(idx, 'meaning_jp', e.target.innerHTML || e.target.textContent || '');
      return;
    }

    // Definition (EN) の編集
    if (e.target.matches('.meaning_en')) {
      editWord(idx, 'meaning', e.target.innerHTML || e.target.textContent || '');
      return;
    }

    // Example の編集
    if (e.target.matches('.example')) {
      editWord(idx, 'example', e.target.innerHTML || e.target.textContent || '');
      return;
    }

    // Category の編集
    if (e.target.matches('.category')) {
      editWord(idx, 'category', e.target.innerHTML || e.target.textContent || '');
      return;
    }
  });

  // チェンジイベント（学習チェックボックス）
  container.addEventListener('change', (e) => {
    if (e.target.matches('.learned-checkbox')) {
      const card = e.target.closest('.word-card');
      if (!card) return;
      const wordId = card.dataset.word;
      toggleLearned(wordId, e.target.checked);
    }
  });

  // Try to restore server-side session (cookie). If present, use it to set UI.
  (async function tryRestore() {
    try {
      const r = await fetch('/api/session', { method: 'GET', credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.loggedIn) {
          userId = j.userId || null;
          const userIcon = document.getElementById('user-icon');
          if (userIcon) {
            const displayText = userId || '未ログイン';
            userIcon.title = displayText;
            const initial = (userId || '').charAt(0).toUpperCase();
            if (typeof userIcon.textContent !== 'undefined') userIcon.textContent = initial || '👤';
            userIcon.setAttribute('aria-hidden', 'false');
          }
          const so = document.getElementById('signout-btn'); if (so) so.style.display = 'inline-block';

          // Try to restore id_token from sessionStorage for Apps Script calls. If missing,
          // prompt Google One Tap to acquire a fresh id_token (auto selection may apply).
          const restored = restoreSessionFromStorage();
          if (!restored && window.google && window.google.accounts && window.google.accounts.id) {
            try {
              window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredentialResponse, auto_select: true });
              // Try prompting safely and show fallback on failure
              tryPromptGoogleOneTap();
            } catch (e) {
              console.warn('GSI init/prompt failed during restore', e);
              showGsiFallback('自動サインインが利用できません。手動でログインしてください。');
            }
          }

          // Now perform local-first render and background sync as if logged in
          readLocalAll().then(localRows => {
            if (Array.isArray(localRows) && localRows.length > 0) {
              customWords = localRows.map((w, i) => ({ ...w, rowIndex: i }));
              learnedWords = {};
              correctStreaks = {};
              customWords.forEach(word => {
                learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
                correctStreaks[word.word] = Number(word.streak) || 0;
              });
              localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
              localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
              document.getElementById('loading').style.display = 'none';
              document.getElementById('word-container').style.display = 'block';
              renderWords();
            }

            // Background: still try to fetch server list via Apps Script if id_token available
            callSheetApi('list').then(serverData => {
              if (!Array.isArray(serverData)) serverData = [];
              useDB('readwrite', store => {
                try { store.clear(); } catch (e) {}
                serverData.forEach(w => { if (w && w.word) store.put(w); });
              }).then(() => {
                customWords = serverData.map((word, i) => ({ ...word, rowIndex: i }));
                learnedWords = {};
                correctStreaks = {};
                customWords.forEach(word => {
                  learnedWords[word.word] = word.learned === true || word.learned === 'TRUE' || word.learned === 'true';
                  correctStreaks[word.word] = Number(word.streak) || 0;
                });
                localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
                localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
                renderWords();
              }).catch(e => console.warn('Failed to write server rows to IndexedDB', e));
            }).catch(err => console.warn('Background fetch of server list failed', err));
          }).catch(err => { console.warn('readLocalAll failed', err); document.getElementById('loading').style.display = 'none'; document.getElementById('word-container').style.display = 'none'; });

          return;
        }
      }
    } catch (e) {
      console.warn('restore server session failed', e);
    }

    // Not restored: fall back to client-side restore (sessionStorage) and show login UI
    const restoredLocal = restoreSessionFromStorage();
    if (!restoredLocal) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('word-container').style.display = 'none';
      // 📱 スマホデバッグ用: ログイン状態を画面に表示
      console.log('[Init] Not logged in. Please sign in with Google.');
    } else {
      console.log('[Init] Session restored from sessionStorage');
    }
  })();

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

      // Attempt to clear server-side session cookie
      try {
        await fetch('/api/session', { method: 'DELETE', credentials: 'include' });
      } catch (e) { console.warn('server session delete failed', e); }

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
  // Attach manual fallback button handler (if present)
  const gsiManual = document.getElementById('gsi-manual-btn');
  if (gsiManual) {
    gsiManual.addEventListener('click', () => {
      hideGsiFallback();
      try {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          // Try a manual prompt; catch errors and show fallback again
          tryPromptGoogleOneTap();
        }
      } catch (e) {
        console.warn('manual GSI prompt failed', e);
        showGsiFallback('手動ログインに失敗しました。ブラウザの設定をご確認ください。');
      }
    });
  }
});

// --- Bottom banner measurement (reserve bottom padding) ---
(function setupBottomBanner() {
  try {
    const banner = document.getElementById('bottom-banner');
    if (!banner) return;

    // Measure and set CSS variable so content isn't covered by the bottom banner.
    const setVar = () => {
      const h = banner.offsetHeight || 0;
      document.documentElement.style.setProperty('--bottom-banner-height', h + 'px');
      // Also ensure body padding-bottom is at least that height (some UA styles may override)
      // (CSS already uses the variable, but keep this for legacy support.)
      try {
        document.body.style.paddingBottom = h + 'px';
      } catch (e) {}
    };

    // initial set after paint
    window.requestAnimationFrame(setVar);
    // update on resize/orientation change
    window.addEventListener('resize', setVar);

    // If the banner contains an iframe that may resize on load, listen for it
    const iframe = banner.querySelector('iframe');
    if (iframe) {
      iframe.addEventListener('load', () => setVar());
    }
  } catch (e) {
    console.warn('Bottom banner setup failed', e);
  }
})();

//------------------------------------------
// 🔍 検索機能
//------------------------------------------
// ナビボタンをまとめている <nav> を取得
const nav = document.querySelector('nav');

// 検索ボックス作成
const searchBox = document.createElement('input');
searchBox.word = 'search-box';
searchBox.placeholder = 'search by word or meaning';
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
  // proxy expects `word` parameter for delete
  callSheetApi('delete', { word: id, userId }).catch(e => console.warn('delete to Sheets failed', e));
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
      <button class="play-btn" title="Play pronunciation">🔊</button>
    </div>

    <div class="meaning" style="display:none;">
      <span class="label"><strong>Meaning:</strong> </span>
      <span class="value meaning_jp" contenteditable="true">${meaning_jpHTML}</span>
    </div>
    <button class="show-meaning-btn">Show Meaning</button>

    <div class="row">
      <span class="label"><strong>Definition:</strong></span>
      <span class="value scrollable meaning_en" contenteditable="true">${meaningHTML}</span>
    </div>

    <div class="row">
      <span class="label "><strong>Example:</strong></span>
      <span class="value scrollable example" contenteditable="true">${exampleHTML}</span>
    </div>

    <div class="row">
      <span class="label"><strong>Category:</strong></span>
      <span class="value category" contenteditable="true">${categoryHTML}</span>
    </div>

    <label>
      <input type="checkbox" class="learned-checkbox" ${isLearned ? 'checked' : ''}>
      Learned
    </label>

    <button class="delete-btn">Delete</button>
    <button class="auto-fill-btn">Auto Fill</button>
  `;

  // イベントリスナーは container に委譲（個別登録なし）
    return card;
  }

  // --- Virtual list helpers ---
  let cardCache = new Map(); // word -> card DOM
  let virtualState = null;   // { words, itemHeight, topSpacer, bottomSpacer, host }
  let scrollHandler = null;  // 前のハンドラを保持してクリーンアップ用

  function ensureCard(wordObj) {
    const key = wordObj.word;
    if (cardCache.has(key)) return cardCache.get(key);
    const actualIndex = customWords.findIndex(w => w.word === wordObj.word);
    const card = renderCard(wordObj, actualIndex);
    cardCache.set(key, card);
    return card;
  }

  function mountVirtualList(words) {
    const container = document.getElementById('word-container');
    if (!container) return;

    // 前のスクロールハンドラをクリーンアップ
    if (scrollHandler) {
      container.removeEventListener('scroll', scrollHandler);
      scrollHandler = null;
    }

    container.innerHTML = '';
    container.style.position = 'relative';
    const topSpacer = document.createElement('div');
    const host = document.createElement('div');
    const bottomSpacer = document.createElement('div');
    host.style.position = 'relative';
    container.appendChild(topSpacer);
    container.appendChild(host);
    container.appendChild(bottomSpacer);

    // item height estimate
    let itemHeight = 180;
    if (words.length > 0) {
      const firstCard = ensureCard(words[0]);
      host.appendChild(firstCard);
      itemHeight = Math.max(120, firstCard.getBoundingClientRect().height || 180);
    }

    virtualState = { words, itemHeight, topSpacer, bottomSpacer, host, start: 0, end: 0 };
    const buffer = 5;
    const visibleCount = 24;

    function renderSlice() {
      if (!virtualState) return;
      const { words, itemHeight, topSpacer, bottomSpacer, host } = virtualState;
      const scrollY = container.scrollTop;
      const start = Math.max(0, Math.floor(scrollY / itemHeight) - buffer);
      const end = Math.min(words.length, start + visibleCount + buffer * 2);
      
      // スクロール位置が変わらなければ再レンダリングしない（無限ループ防止）
      if (virtualState.start === start && virtualState.end === end) return;
      
      virtualState.start = start;
      virtualState.end = end;

      topSpacer.style.height = `${start * itemHeight}px`;
      bottomSpacer.style.height = `${Math.max(0, (words.length - end) * itemHeight)}px`;

      // 差分更新: 前回と今回の範囲を比較して、必要なカードのみ追加/削除
      const prevStart = (virtualState._prevStart ?? 0);
      const prevEnd = (virtualState._prevEnd ?? 0);
      virtualState._prevStart = start;
      virtualState._prevEnd = end;

      if (prevStart === start && prevEnd === end) return; // 既に同じ範囲

      // 古いカードを削除
      const toRemove = [];
      for (let i = 0; i < host.children.length; i++) {
        const child = host.children[i];
        const word = child.dataset?.word;
        const wordIdx = words.findIndex(w => w.word === word);
        if (wordIdx < start || wordIdx >= end) {
          toRemove.push(child);
        }
      }
      toRemove.forEach(c => c.remove());

      // 新しいカードを追加（既存カードは保持）
      const existingWords = new Set(Array.from(host.children).map(c => c.dataset?.word));
      for (let i = start; i < end; i++) {
        const word = words[i];
        if (!existingWords.has(word.word)) {
          const card = ensureCard(word);
          // 正しい位置に挿入
          let inserted = false;
          for (let j = 0; j < host.children.length; j++) {
            const childWord = host.children[j].dataset?.word;
            const childIdx = words.findIndex(w => w.word === childWord);
            if (childIdx > i) {
              host.insertBefore(card, host.children[j]);
              inserted = true;
              break;
            }
          }
          if (!inserted) host.appendChild(card);
        }
      }
    }

    renderSlice();
    // addEventListener で登録してから参照を保持（removeEventListener 用）
    scrollHandler = () => renderSlice();
    container.addEventListener('scroll', scrollHandler);
    updateProgressBar();
  }

  function renderWords(words = customWords) {
    console.log('[renderWords] Called with', words.length, 'words');
    const container = document.getElementById('word-container');
    const myWords = words.filter(w => w.userId === userId);
    console.log('[renderWords] myWords filtered:', myWords.length, 'userId:', userId);

    if (myWords.length > 0) {
      container.style.display = 'block';
      document.getElementById('loading').style.display = 'none';
    }

    mountVirtualList(myWords);
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
  quizMode = quizMode === 'en-to' ? 'to-en' : 'en-to';
  localStorage.setItem('quizMode', quizMode);
  const quizModeLabelEl = document.getElementById('quiz-mode-label');
  if (quizModeLabelEl) quizModeLabelEl.textContent = quizMode === 'en-to' ? 'from English' : 'to English';
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
      .map(w => quizMode === 'en-to' ? w.meaning_jp : w.word)
  ).slice(0, 4);

  const correctAnswer = quizMode === 'en-to' ? question.meaning_jp : question.word;
  const choices = shuffle([correctAnswer, ...distractors]);

  const questionText = quizMode === 'en-to'
    ? `「${question.word}」means?`
    : `「${question.meaning_jp}」corresponds to which English word?`;

  quizArea.innerHTML = `
    <h3>${questionText}<button class="play-btn" title="Play pronunciation">🔊</button><button onclick="toggleQuizMode()">Switch: <span id="quiz-mode-label">${quizMode === 'en-to' ? 'to English' : 'from English'}</span></button></h3>
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

      alert(`Incorrect... The correct answer is「${correct}」`);
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

// --- Wiktionary (Wiktextract) fallback for JP translations & idioms ---
async function fetchWiktionaryTranslations(enWord, limit = 5) {
  try {
    if (!enWord || typeof enWord !== 'string') return '';
    const q = enWord.trim();
    if (!q) return '';
    // Wiktextract API (Wiktionary parsed). CORS-friendly endpoint.
    const url = `https://api.wiktextract.com/en/word/${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wiktionary_http_${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return '';

    const uniq = new Set();
    const tagSet = new Set(['idiom', 'phrasal verb', 'slang', 'colloquial']);

    for (const entry of data) {
      const senses = Array.isArray(entry.senses) ? entry.senses : [];
      for (const s of senses) {
        // Prefer explicit JA translations
        if (Array.isArray(s.translations)) {
          for (const t of s.translations) {
            const isJa = (t.lang_code && t.lang_code.toLowerCase() === 'ja') || (t.lang && /japanese/i.test(t.lang));
            if (isJa) {
              const term = (t.word || t.text || '').trim();
              if (term) uniq.add(term);
            }
            if (uniq.size >= limit) break;
          }
        }

        if (uniq.size >= limit) break;

        // If no JA translation, fall back to gloss when the sense is tagged as idiom/phrasal/slang
        if (Array.isArray(s.glosses) && Array.isArray(s.tags)) {
          const hasInterestingTag = s.tags.some(tag => tagSet.has(String(tag).toLowerCase()));
          if (hasInterestingTag) {
            for (const g of s.glosses) {
              const term = String(g || '').trim();
              if (term) uniq.add(term);
              if (uniq.size >= limit) break;
            }
          }
        }

        if (uniq.size >= limit) break;
      }
      if (uniq.size >= limit) break;
    }

    const out = Array.from(uniq).slice(0, limit);
    return out.join('、');
  } catch (e) {
    console.warn('fetchWiktionaryTranslations failed', e);
    return '';
  }
}

// --- JP translations helper (server proxy to avoid CORS) ---
async function fetchJapaneseTranslations(enWord, limit = 5) {
  try {
    if (!enWord || typeof enWord !== 'string') return '';
    const q = enWord.trim();
    if (!q) return '';
    const url = `/api/jp-translate?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000); // 10s timeout
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`jp_proxy_http_${res.status}`);
      const data = await res.json();
      if (data && data.ok) {
        if (Array.isArray(data.sourcesUsed) && data.sourcesUsed.length) {
          console.log('[jp-translate] sourcesUsed:', data.sourcesUsed.join(', '));
        }

        // Debug: inspect raw Weblio results
        if (Array.isArray(data.weblioResults)) {
          console.log('[jp-translate] weblioResults', { count: data.weblioResults.length, sample: data.weblioResults.slice(0, 5) });
        }
        
        // Format output from Weblio results
        let output = '';
        
        // Clean and normalize terms: remove internal spaces
        const cleanTerm = (t) => String(t || '').trim().replace(/\s+/g, '');
        
        // Weblio results
        if (Array.isArray(data.weblioResults) && data.weblioResults.length > 0) {
          output = data.weblioResults.map(cleanTerm).filter(t => t).join('、');
        }
        
        return output;
      }
      return '';
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('fetchJapaneseTranslations failed', e);
    return '';
  }
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
        // JP 側は別系統から取得を試みる
        try {
          const jp = await fetchJapaneseTranslations(word);
          document.getElementById('new-meaning-ja').value = jp || '';
        } catch (_) {}
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

      // 日本語訳（候補）を取得して埋める
      try {
        const jp = await fetchJapaneseTranslations(word);
        document.getElementById('new-meaning-ja').value = jp || '';
      } catch (e) {
        console.warn('JP translation fetch failed (input helper)', e);
      }
    } catch (err) {
      console.error('辞書情報の取得に失敗しました', err);
      alert('辞書情報の取得に失敗しました。ネットワークや単語を確認してください。');
      document.getElementById('new-meaning').value = '';
      document.getElementById('new-example').value = '';
      document.getElementById('new-category').value = '';
      try { document.getElementById('new-meaning-ja').value = ''; } catch (_) {}
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

    // 日本語訳（候補）
    try {
      wordObj.meaning_jp = await fetchJapaneseTranslations(word);
    } catch (e) {
      console.warn('JP translation fetch failed (auto-fill)', e);
      wordObj.meaning_jp = wordObj.meaning_jp || '';
    }

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
        meaning_jp: wordObj.meaning_jp || '',
        meaning: wordObj.meaning,
        example: wordObj.example,
        category: wordObj.category,
        userId: wordObj.userId || userId
      });
      console.log('callSheetApi update response:', resp);
      // Determine success in several server response styles
      let updated = false;
      if (resp && typeof resp === 'object' && (resp.success || resp.ok || (resp.result && resp.result.ok))) updated = true;
      if (typeof resp === 'object' && resp && Object.keys(resp).length === 0) updated = false;
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
        if (addResp && typeof addResp === 'object' && (addResp.success || addResp.ok || (addResp.result && addResp.result.ok))) added = true;
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
