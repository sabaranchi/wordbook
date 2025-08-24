
let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = [];
let currentQuestion = null;
let question = null;
let correctStreaks = JSON.parse(localStorage.getItem('correctStreaks') || '{}');

const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbySnZKlkD5hMlzzLcAaAnAahAmzxPpQi8ROxEsLqjmTUxK59hNcOC-ImrMnfCdwO5qK4Q/exec';

function useDB(mode, callback) {
  const request = indexedDB.open('WordDB', 1);
  request.onupgradeneeded = e => {
    e.target.result.createObjectStore('words', { keyPath: 'id' });
  };
  request.onsuccess = e => {
    const db = e.target.result;
    const tx = db.transaction('words', mode);
    const store = tx.objectStore('words');
    callback(store);
  };
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loading').style.display = 'block';

  useDB('readonly', store => {
    store.getAll().onsuccess = e => {
      const localWords = e.target.result;
      if (localWords.length > 0) {
        customWords = localWords;
        renderWords();
      }

      fetch(SHEET_API_URL)
        .then(res => res.json())
        .then(data => {
          customWords = data;
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


function addWord(wordObj) {
  useDB('readwrite', store => store.put(wordObj));
  fetch(`${SHEET_API_URL}?action=add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wordObj)
  });
  customWords.push(wordObj);
  renderWords();
}

function editWord(index, field, value) {
  const word = customWords[index];
  word[field] = value.trim();
  useDB('readwrite', store => store.put(word));
  fetch(`${SHEET_API_URL}?action=update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(word)
  });
  renderWords();
}

function updateLearningStatus(id, learned, streak) {
  const word = customWords.find(w => w.id === id);
  if (!word) return;
  word.learned = learned;
  word.streak = streak;
  useDB('readwrite', store => store.put(word));
  fetch(`${SHEET_API_URL}?action=update`, {
    method: 'POST',
    body: JSON.stringify(word)
  });
  renderWords();
}

function deleteWord(index) {
  const id = customWords[index].id;
  if (!confirm('この単語を削除しますか？')) return;
  customWords.splice(index, 1);
  useDB('readwrite', store => store.delete(id));
  fetch(`${SHEET_API_URL}?action=delete&id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  renderWords();
}

function toggleLearned(id, checked) {
  learnedWords[id] = checked;
  localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
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

      const card = document.createElement('div');
      card.className = 'word-card';
      card.innerHTML = `
        <h2 contenteditable="true" onblur="editWord(${actualIndex}, 'word', this.textContent)">${word.word}</h2>
        <p class="meaning" style="display:none;"><strong>意味:</strong> <span contenteditable="true" onblur="editWord(${actualIndex}, 'meaning', this.textContent)">${word.meaning}</span></p>
        <button onclick="this.previousElementSibling.style.display='block'; this.style.display='none';">意味を見る</button>
        <p><em>例文:</em> <span contenteditable="true" onblur="editWord(${actualIndex}, 'example', this.textContent)">${word.example}</span></p>
        <p><small>カテゴリー: <span contenteditable="true" onblur="editWord(${actualIndex}, 'category', this.textContent)">${word.category}</span></small></p>
        <label>
          <input type="checkbox" ${isLearned ? 'checked' : ''} onchange="toggleLearned('${word.id}', this.checked)">
          習得済み
        </label>
        <button onclick="deleteWord(${actualIndex})">削除</button>
      `;
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
    pool = [...unlearned, ...learned.slice(0, 2)]; // 未習得を中心に、習得済みも少し混ぜる
  } else {
    pool = [...learned];
  }

  const question = pool[Math.floor(Math.random() * pool.length)];
  currentQuestion = question;

  const choices = shuffle([
    question.meaning,
    ...customWords.filter(w => w.id !== question.id).slice(0, 2).map(w => w.meaning)
  ]);


  quizArea.innerHTML = `
    <h3>「${question.word}」の意味は？</h3>
    ${choices.map(c => `<button onclick="checkAnswer('${c}', '${question.meaning}', '${question.id}')">${c}</button>`).join('')}
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

document.getElementById('add-word-form').addEventListener('submit', function(e) {
  e.preventDefault();

  const word = document.getElementById('new-word').value.trim();
  const meaning = document.getElementById('new-meaning').value.trim();
  const example = document.getElementById('new-example').value.trim();
  const category = document.getElementById('new-category').value.trim();
  const id = word.toLowerCase().replace(/\s+/g, '-');

  if (!word || !meaning) return;
  if (customWords.some(w => w.id === id)) {
    alert('この単語はすでに追加されています！');
    return;
  }

  const newWord = { id, word, meaning, example, category, audio: "" };

  // IndexedDB に保存
  useDB('readwrite', store => store.put(newWord));

  // Google Sheets に送信
  fetch(SHEET_API_URL, {
    method: 'POST',
    body: JSON.stringify(newWord)
  }).then(() => {
    customWords.push(newWord);
    renderWords();
    updateProgressBar();
    this.reset();
  }).catch(err => {
    alert('Google Sheetsへの保存に失敗しました');
    console.error(err);
  });
});

function showSection(name) {
  document.getElementById('add-section').style.display = name === 'add' ? 'block' : 'none';
  document.getElementById('quiz-section').style.display = name === 'quiz' ? 'block' : 'none';

  if (name === 'quiz') startQuiz();
}
