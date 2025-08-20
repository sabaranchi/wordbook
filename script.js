
let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = [];

const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbzvPHN406Iw0CZ61D71KJ84nczrekcZRLUqyDM3htB4xFwtHo-7y9Gg1oCVocHhZl06/exec';

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
  fetch(SHEET_API_URL, { method: 'POST', body: JSON.stringify(wordObj) });
  customWords.push(wordObj);
  renderWords();
}

function editWord(index, field, value) {
  const word = customWords[index];
  word[field] = value.trim();
  useDB('readwrite', store => store.put(word));
  fetch(SHEET_API_URL, { method: 'PUT', body: JSON.stringify(word) });
  renderWords();
}

function deleteWord(index) {
  const id = customWords[index].id;
  if (!confirm('この単語を削除しますか？')) return;
  customWords.splice(index, 1);
  useDB('readwrite', store => store.delete(id));
  fetch(`${SHEET_API_URL}?id=${id}`, { method: 'DELETE' });
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

function applyFilter(type) {
  let filtered = [];

  if (type === 'learned') {
    filtered = customWords.filter(word => learnedWords[word.id]);
  } else if (type === 'unlearned') {
    filtered = customWords.filter(word => !learnedWords[word.id]);
  } else {
    filtered = customWords;
  }

  renderWords(filtered);
}

function shuffleWords() {
  const shuffled = [...customWords].sort(() => Math.random() - 0.5);
  renderWords(shuffled);
}

function startQuiz() {
  const quizArea = document.getElementById('quiz-area');
  quizArea.innerHTML = '';

  const unlearnedWords = customWords.filter(w => !learnedWords[w.id]);

  if (unlearnedWords.length === 0) {
    quizArea.innerHTML = '<p>すべて習得済みです！🎉</p>';
    return;
  }

  const question = unlearnedWords[Math.floor(Math.random() * unlearnedWords.length)];
  const choices = shuffle([
    question.meaning,
    ...customWords.filter(w => w.id !== question.id).slice(0, 2).map(w => w.meaning)
  ]);

  quizArea.innerHTML = `
    <h3>「${question.word}」の意味は？</h3>
    ${choices.map(c => `<button onclick="checkAnswer('${c}', '${question.meaning}')">${c}</button>`).join('')}
  `;
}

function checkAnswer(selected, correct) {
  alert(selected === correct ? '正解！🎉' : `不正解… 正しくは「${correct}」`);
  startQuiz();
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


/*
fetch('https://script.google.com/macros/s/AKfycbzvPHN406Iw0CZ61D71KJ84nczrekcZRLUqyDM3htB4xFwtHo-7y9Gg1oCVocHhZl06/exec')
  .then(res => res.json())
  .then(data => {
    customWords = data;
    window.words = customWords;
    renderWords(customWords);
    updateProgressBar();
  });

function addWordToSheet(wordObj) {
  fetch('https://script.google.com/macros/s/AKfycbzvPHN406Iw0CZ61D71KJ84nczrekcZRLUqyDM3htB4xFwtHo-7y9Gg1oCVocHhZl06/exec', {
    method: 'POST',
    body: JSON.stringify(wordObj),
    headers: { 'Content-Type': 'application/json' }
  }).then(() => {
    customWords.push(wordObj);
    renderWords(customWords);
    updateProgressBar();
  });
}
*/


/*

let learnedWords = JSON.parse(localStorage.getItem('learnedWords') || '{}');
let customWords = JSON.parse(localStorage.getItem('customWords') || []);
window.words = customWords;

window.addEventListener('DOMContentLoaded', () => {
  renderWords(customWords);
  updateProgressBar();
});

function saveWords() {
  localStorage.setItem('customWords', JSON.stringify(customWords));
}

function toggleLearned(id, checked) {
  learnedWords[id] = checked;
  localStorage.setItem('learnedWords', JSON.stringify(learnedWords));
  updateProgressBar();
}

function updateProgressBar() {
  const total = customWords.length;

  // customWords に存在する id だけを対象に習得済みをカウント
  const validIds = customWords.map(w => w.id);
  const learnedCount = validIds.filter(id => learnedWords[id]).length;

  const percent = total === 0 ? 0 : Math.round((learnedCount / total) * 100);

  document.getElementById('progress-text').textContent = `${percent}%`;
  const fill = document.getElementById('progress-fill');
  fill.style.width = `${percent}%`;

  fill.style.backgroundColor =
    percent < 40 ? 'red' : percent < 80 ? 'orange' : 'green';
}

function renderWords(words = customWords) {
  const container = document.getElementById('word-container');
  container.innerHTML = '';

  words.forEach((word, index) => {
    const isLearned = learnedWords[word.id] || false;

    const card = document.createElement('div');
    card.className = 'word-card';
    card.innerHTML = `
      <h2 contenteditable="true" onblur="editWord(${index}, 'word', this.textContent)">${word.word}</h2>
      <p class="meaning" style="display:none;"><strong>意味:</strong> <span contenteditable="true" onblur="editWord(${index}, 'meaning', this.textContent)">${word.meaning}</span></p>
      <button onclick="this.previousElementSibling.style.display='block'; this.style.display='none';">意味を見る</button>
      <p><em>例文:</em> <span contenteditable="true" onblur="editWord(${index}, 'example', this.textContent)">${word.example}</span></p>
      <p><small>カテゴリー: <span contenteditable="true" onblur="editWord(${index}, 'category', this.textContent)">${word.category}</span></small></p>
      <label>
        <input type="checkbox" ${isLearned ? 'checked' : ''} onchange="toggleLearned('${word.id}', this.checked)">
        習得済み
      </label>
      <button onclick="deleteWord(${index})">削除</button>
    `;
    container.appendChild(card);
  });

  updateProgressBar();
}

function editWord(index, field, value) {
  customWords[index][field] = value.trim();
  saveWords();
}

function deleteWord(index) {
  if (confirm('この単語を削除しますか？')) {
    customWords.splice(index, 1);
    saveWords();
    renderWords();
  }
}

function applyFilter(type) {
  let filtered = [];

  if (type === 'learned') {
    filtered = customWords.filter(word => learnedWords[word.id]);
  } else if (type === 'unlearned') {
    filtered = customWords.filter(word => !learnedWords[word.id]);
  } else {
    filtered = customWords;
  }

  renderWords(filtered);
}

function shuffleWords() {
  const shuffled = [...customWords].sort(() => Math.random() - 0.5);
  renderWords(shuffled);
}

function startQuiz() {
  const quizArea = document.getElementById('quiz-area');
  quizArea.innerHTML = '';

  const unlearnedWords = customWords.filter(w => !learnedWords[w.id]);

  if (unlearnedWords.length === 0) {
    quizArea.innerHTML = '<p>すべて習得済みです！🎉</p>';
    return;
  }

  const question = unlearnedWords[Math.floor(Math.random() * unlearnedWords.length)];
  const choices = shuffle([
    question.meaning,
    ...customWords.filter(w => w.id !== question.id).slice(0, 2).map(w => w.meaning)
  ]);

  quizArea.innerHTML = `
    <h3>「${question.word}」の意味は？</h3>
    ${choices.map(c => `<button onclick="checkAnswer('${c}', '${question.meaning}')">${c}</button>`).join('')}
  `;
}

function checkAnswer(selected, correct) {
  alert(selected === correct ? '正解！🎉' : `不正解… 正しくは「${correct}」`);
  startQuiz();
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
  customWords.push(newWord);
  saveWords();
  renderWords();
  this.reset();
});

*/