
let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = [];
let currentQuestion = null;
let question = null;
let correctStreaks = JSON.parse(localStorage.getItem('correctStreaks') || '{}');

const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbximFpa3J21ua8wAN4MmvYWANYcEbDjZMNm4YTuPK0ksKiFWFF3nK1M43J8bclwKo_9Uw/exec';

function useDB(mode, callback) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('WordDB', 1);
    request.onupgradeneeded = e => {
      e.target.result.createObjectStore('words', { keyPath: 'id' });
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
          customWords = data;

          // ✅ ここで learnedWords と correctStreaks を再構築
          learnedWords = {};
          correctStreaks = {};
          data.forEach(word => {
            learnedWords[word.id] = word.learned === true || word.learned === 'TRUE';
            correctStreaks[word.id] = Number(word.streak) || 0;
          });
          localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
          localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

          useDB('readwrite', store => {
            store.clear();
            data.forEach(word => store.put(word));
          });
          document.getElementById('loading').style.display = 'none';
          document.getElementById('word-container').style.display = 'block';
          renderWords();
        });
    };
  });
});


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
      id: wordObj.id,
      word: wordObj.word,
      meaning_jp: wordObj.meaning_jp,
      meaning: wordObj.meaning,
      example: wordObj.example,
      category: wordObj.category
    })
  });

  customWords.push(wordObj);
  renderWords();
}

async function editWord(index, field, value) {
  const cleanValue = value.trim();
  const word = customWords[index];

  if (!word.id) {
    word.id = `${word.word}`;
  }

  word[field] = cleanValue;
  customWords[index] = word; // ✅ 明示的に更新
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
      id: word.id,
      word: word.word,
      meaning_jp: word.meaning_jp,
      meaning: word.meaning,
      example: word.example,
      category: word.category
    })
  });

  renderWords();
}

async function updateLearningStatus(id, learned, streak) {
  const word = customWords.find(w => w.id === id);
  if (!word) return;
  word.learned = learned;
  word.streak = streak;

  await new Promise(resolve => {
    useDB('readwrite', store => {
      store.put(word);
      resolve();
    });
  });

  await fetch(`${SHEET_API_URL}?action=update`, {
    method: 'POST',
    body: new URLSearchParams({
      action: 'update',
      id: word.id,
      learned: word.learned,
      streak: word.streak
    })
  });
}

function deleteWord(index) {
  const id = customWords[index].id;
  if (!confirm('この単語を削除しますか？')) return;
  customWords.splice(index, 1);
  useDB('readwrite', store => store.delete(id));
  fetch(`${SHEET_API_URL}?action=delete&id=${id}`, {
    method: 'POST',
    body: JSON.stringify({ id }),
    mode: 'no-cors'
  });
  renderWords();
}

function toggleLearned(id, checked) {
  learnedWords[id] = checked;
  localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
  if (checked !== true) {
    correctStreaks[id] = 0; // ← streak をリセット
    localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));
  }
  updateLearningStatus(id, checked, correctStreaks[id]); // ← これを追加
  updateProgressBar();
}

function updateProgressBar() {
  const total = customWords.length;
  const validIds = customWords.map(w => w.id);
  const learnedCount = validIds.filter(id => learnedWords[id]).length;
  const percent = total === 0 ? 0 : Math.round((learnedCount / total) * 100);

  document.getElementById('progress-text').textContent = `${percent}%`;
  const fill = document.getElementById('progress-fill');
  fill.style.width = `${percent}%`;
  fill.style.backgroundColor = percent < 40 ? 'red' : percent < 80 ? 'orange' : 'green';
}

function renderWords(words = customWords) {
  const container = document.getElementById('word-container');
  container.innerHTML = '';

  const batchSize = 10;
  let index = 0;

  function renderBatch() {
    const slice = words.slice(index, index + batchSize);
    slice.forEach((word, i) => {
      const actualIndex = i + index;
      const isLearned = learnedWords[word.id] || false;
      const meaning_jpHTML = word.meaning_jp ? word.meaning_jp.replace(/\n/g, '<br>') : '<br>';
      const meaningHTML = word.meaning ? word.meaning.replace(/\n/g, '<br>') : '&nbsp;&nbsp;&nbsp;&nbsp;';
      const exampleHTML = word.example ? word.example.replace(/\n/g, '<br>') : '&nbsp;&nbsp;&nbsp;&nbsp;';
      const categoryHTML = typeof word.category === 'string' ? word.category.replace(/,/g, ',&nbsp;&nbsp;') : Array.isArray(word.category) ? word.category.join(',&nbsp;&nbsp;') : '';

      const card = document.createElement('div');
      card.className = 'word-card';
      card.innerHTML = `
        <div class="word-header">
          <h2 contenteditable="true" onblur="editWord(${actualIndex}, 'word', this.textContent)">${word.word}</h2>
          <button class="play-btn" onclick="speak(${JSON.stringify(word.word)})" title="発音を再生">🔊</button>
        </div>

        <p class="meaning" style="display:none;"><strong>意味:</strong> 
          <span class="value" contenteditable="true" onblur="editWord(${actualIndex}, 'meaning_jp', this.innerHTML)">
            ${meaning_jpHTML}
          </span>
        </p>
        <button onclick="this.previousElementSibling.style.display='block'; this.style.display='none';">意味を見る</button>

        <div class="row">
          <span class="label"><strong>定義:</strong></span>
          <span class="value scrollable" contenteditable="true" onblur="editWord(${actualIndex},'meaning', this.innerHTML)">
            ${meaningHTML}
          </span>
        </div>

        <div class="row">
          <span class="label "><strong>例文:</strong></span>
          <span class="value scrollable" contenteditable="true" onblur="editWord(${actualIndex}, 'example', this.innerHTML)">
            ${exampleHTML}
          </span>
        </div>

        <div class="row">
          <span class="label"><strong>カテゴリー:</strong></span>
          <span class="value" contenteditable="true" onblur="editWord(${actualIndex}, 'category', this.textContent)">
            ${categoryHTML}
          </span>
        </div>

        <label>
          <input type="checkbox" ${isLearned ? 'checked' : ''} onchange="toggleLearned('${word.id}', this.checked)">
          習得済み
        </label>

        <button onclick="deleteWord(${actualIndex})">削除</button>
        <button id="auto-fill-${actualIndex}" onclick="enrichWordFromDictionary(${actualIndex})">自動入力</button>
      `;
/*
      const card = document.createElement('div');
      card.className = 'word-card';
      card.innerHTML = `
        <h2 contenteditable="true" onblur="editWord(${actualIndex}, 'word', this.textContent)">${word.word}</h2>
        <p class="meaning" style="display:none;"><strong>意味:</strong> <span contenteditable="true" onblur="editWord(${actualIndex}, 'meaning', this.textContent)">${word.meaning_jp}</span></p>
        <button onclick="this.previousElementSibling.style.display='block'; this.style.display='none';">意味を見る</button>
        <p><strong>定義:</strong> <span contenteditable="true" onblur="editWord(${actualIndex}, 'meaning', this.textContent)">${word.meaning}</span></p>
        <p><strong>例文:</strong> <span contenteditable="true" onblur="editWord(${actualIndex}, 'example', this.textContent)">${word.example}</span></p>
        <p><strong>カテゴリー:</strong>  <span contenteditable="true" onblur="editWord(${actualIndex}, 'category', this.textContent)">${word.category}</span></small></p>
        <label>
          <input type="checkbox" ${isLearned ? 'checked' : ''} onchange="toggleLearned('${word.id}', this.checked)">
          習得済み
        </label>
        <button onclick="deleteWord(${actualIndex})">削除</button>
      `;
*/
      container.appendChild(card);
    });


    index += batchSize;
    if (index < words.length) {
      setTimeout(renderBatch, 50);
    } else {
      updateProgressBar();
    }
  }

  renderBatch();
}

let currentFilter = 'all'; // 'learned' / 'unlearned' / 'all'

function applyFilter(type) {
  let filtered = [];
  currentFilter = type;
  const words = [...customWords]; // 最新状態をコピー

  if (type === 'learned') {
    filtered = customWords.filter(word => learnedWords[word.id]);
  } else if (type === 'unlearned') {
    filtered = customWords.filter(word => !learnedWords[word.id]);
  } else {
    filtered = customWords;
  }

  renderWords(filtered);
}

function getFilteredWords() {
  if (currentFilter === 'learned') {
    return customWords.filter(word => learnedWords[word.id]);
  } else if (currentFilter === 'unlearned') {
    return customWords.filter(word => !learnedWords[word.id]);
  } else {
    return [...customWords];
  }
}

function shuffleWords() {
  const filtered = getFilteredWords();
  const shuffled = [...filtered].sort(() => Math.random() - 0.5);
  renderWords(shuffled);
}

function startQuiz() {
  const quizArea = document.getElementById('quiz-area');
  quizArea.innerHTML = '';

  const unlearned = customWords.filter(w => !learnedWords[w.id]);
  const learned = customWords.filter(w => learnedWords[w.id]);

  let pool = [];

  if (unlearned.length > 0) {
    pool = [...unlearned, ...learned.slice(0, 20)]; // 未習得を中心に、習得済みも少し混ぜる
  } else {
    pool = [...learned];
  }

  const question = pool[Math.floor(Math.random() * pool.length)];
  currentQuestion = question;

  const distractors = customWords
    .filter(w => w.id !== question.id)
    .map(w => w.meaning_jp);

  const randomDistractors = shuffle(distractors).slice(0, 2);

  const choices = shuffle([
    question.meaning_jp,
    ...randomDistractors
  ]);

  quizArea.innerHTML = `
    <h3>「${question.word}」の意味は？</h3>
    ${choices.map(c => `<button onclick="checkAnswer('${c}', '${question.meaning_jp}', '${question.id}')">${c}</button>`).join('')}
  `;
}

function checkAnswer(selected, correct) {
  const quizArea = document.getElementById('quiz-area');
  quizArea.style.backgroundColor = selected === correct ? '#d4edda' : '#f8d7da';

  const id = currentQuestion.id;

  setTimeout(() => {
    quizArea.style.backgroundColor = '';

    if (selected === correct) {
      correctStreaks[id] = (correctStreaks[id] || 0) + 1;

      if (correctStreaks[id] >= 3) {
        learnedWords[id] = true;
        localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
      }
    } else {
      correctStreaks[id] = 0;

      if (learnedWords[id]) {
        learnedWords[id] = false;
        localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
      }

      alert(`不正解… 正しくは「${correct}」`);
    }

    localStorage.setItem('correctStreaks', JSON.stringify(correctStreaks));

    updateLearningStatus(id, learnedWords[id], correctStreaks[id]);

    startQuiz();
  }, 500);
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// ---音声再生機能 (Web Speech API) ---
function detectLang(text) {
  if (!text) return 'en-US';
  // 日本語文字が含まれるなら日本語、それ以外は英語を基本にする簡易判定
  if (/[一-龯ぁ-ゔァ-ヴー々〆〤]/.test(text)) return 'ja-JP';
  return 'en-US';
}

function speak(text, lang) {
  if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang || detectLang(text);

  // 利用可能な音声から言語に合うものを選ぶ（なければブラウザ任せ）
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length) {
    const shortLang = (utter.lang || '').toLowerCase().slice(0,2);
    const voice = voices.find(v => v.lang && v.lang.toLowerCase().slice(0,2) === shortLang);
    if (voice) utter.voice = voice;
  }

  // 既存の再生を止めてから再生
  try {
    window.speechSynthesis.cancel();
  } catch (e) {}
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
  const id = word.toLowerCase().replace(/\s+/g, '-');

  if (!word) {
    addButton.disabled = false;
    addButton.textContent = '追加';
    addButton.style.opacity = '1';
    addButton.style.cursor = 'pointer';
    return;
  }

  if (customWords.some(w => w.id === id)) {
    const shouldUpdate = confirm('この単語はすでに存在します。\n更新しますか？（キャンセルで中止）');
    if (!shouldUpdate) {
      addButton.disabled = false;
      addButton.textContent = '追加';
      addButton.style.opacity = '1';
      addButton.style.cursor = 'pointer';
      return;
    }


    // ✅ 更新処理：IndexedDBとGoogle Sheetsに上書き
    const updatedWord = { id, word, meaning_jp, meaning, example, category, audio: "" };

    useDB('readwrite', store => store.put(updatedWord));

    fetch(SHEET_API_URL + '?action=update', {
      method: 'POST',
      body: JSON.stringify(updatedWord)
    }).then(() => {
      const index = customWords.findIndex(w => w.id === id);
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


  const newWord = { id, word, meaning_jp, meaning, example, category, audio: "" };

  // IndexedDB に保存
  useDB('readwrite', store => store.put(newWord));

  // Google Sheets に送信
  fetch(SHEET_API_URL, {
    method: 'POST',
    body: new URLSearchParams({
      action: 'add',
      id: newWord.id,
      word: newWord.word,
      meaning_jp: newWord.meaning_jp,
      meaning: newWord.meaning,
      example: newWord.example,
      category: newWord.category
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

  const word = this.value.trim();
  if (!word) return;
  debounceTimer = setTimeout(async () => {
    const lang = 'en'; // 必要に応じて 'en-us', 'en-uk', 'en-cn' などに変更

    try {
      console.log('fetch開始');
      const res = await fetch(`https://cambridge-dictionaryapi.vercel.app/api/dictionary/${lang}/${word}`);
      if (!res.ok) throw new Error('Cambridge API failed');
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

      document.getElementById('new-meaning').value = formattedMeanings
      document.getElementById('new-example').value = allExamples.slice(0, 2).join('\n');
      document.getElementById('new-category').value = data.pos || '';
    } catch (err) {
      console.error('辞書情報の取得に失敗しました', err);
      document.getElementById('new-meaning').value = '';
      document.getElementById('new-example').value = '';
      document.getElementById('new-category') = '';
    }
  }, 300); // ← 入力が止まってから0.5秒後に実行
});



async function enrichWordFromDictionary(index) {
  const button = document.getElementById(`auto-fill-${index}`);
  if (button) {
    button.disabled = true;
    button.textContent = '取得中...';
    button.style.opacity = '0.5';
    button.style.pointerEvents = 'none';
  }

  try {
    const wordObj = customWords[index];
    const word = wordObj.word.trim();
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
    formData.append('id', wordObj.id);

    await fetch(`${SHEET_API_URL}?action=update`, {
      method: 'POST',
      body: formData,
    });
    renderWords();
  } catch (err) {
    console.error('辞書情報の取得に失敗しました', err);
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
*/
