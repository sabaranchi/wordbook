// Memorize mode: all words shown once, flip-card style, left/right buttons to mark known/unknown
let memorizeState = {
  words: [],
  currentIndex: 0,
  flipped: false,
  correct: 0,
  incorrect: 0
};

function shuffle(arr) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startMemorize() {
  const memorizeArea = document.getElementById('memorize-area');
  memorizeArea.innerHTML = '';

  const myWords = customWords.filter(w => w.userId === userId);
  
  if (myWords.length === 0) {
    memorizeArea.innerHTML = '<h3>No words to memorize yet.</h3>';
    return;
  }

  // Shuffle all words
  const shuffledWords = shuffle(myWords);
  
  memorizeState = {
    words: shuffledWords,
    currentIndex: 0,
    flipped: false,
    correct: 0,
    incorrect: 0
  };

  renderMemorizeCard();
}

function renderMemorizeCard() {
  const memorizeArea = document.getElementById('memorize-area');
  const { words, currentIndex, flipped } = memorizeState;

  if (currentIndex >= words.length) {
    // Completed
    const total = words.length;
    const summary = `
      <h2>Memorize Completed!</h2>
      <div style="font-size: 1.2em; margin: 20px 0;">
        <p>✓ Known: <span style="color: green; font-weight: bold;">${memorizeState.correct}</span></p>
        <p>✗ Unknown: <span style="color: red; font-weight: bold;">${memorizeState.incorrect}</span></p>
        <p>Total: ${total}</p>
      </div>
      <button onclick="startMemorize()" style="padding: 10px 20px; font-size: 1em; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px;">Start Again</button>
    `;
    memorizeArea.innerHTML = summary;
    return;
  }

  const word = words[currentIndex];
  const progressText = `${currentIndex + 1} / ${words.length}`;

  const frontContent = `
    <div style="margin-bottom: 20px;">
      <h3>${word.word}</h3>
      ${word.example ? `<p style="font-size: 0.9em; color: #666; margin-top: 10px; font-style: italic;">${word.example}</p>` : ''}
    </div>
  `;

  const backContent = `
    <div style="margin-bottom: 20px;">
      <h3>${word.meaning_jp || '?'}</h3>
      ${word.meaning ? `<p style="font-size: 0.9em; color: #666; margin-top: 10px;">${word.meaning}</p>` : ''}
    </div>
  `;

  memorizeArea.innerHTML = `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
      <span style="font-size: 1.1em; font-weight: bold;">Progress: ${progressText}</span>
      <button class="play-btn" title="Play pronunciation" style="font-size: 1.5em; cursor: pointer; background: none; border: none; padding: 5px;">🔊</button>
    </div>

    <div class="memorize-card-container">
      <div id="memorize-card" class="memorize-flip-card ${flipped ? 'flipped' : ''}" data-word="${word.word.replace(/"/g, '&quot;')}">
        <div class="memorize-card-front">
          ${frontContent}
        </div>
        <div class="memorize-card-back">
          ${backContent}
        </div>
      </div>
    </div>

    <div style="display: flex; gap: 20px; justify-content: center; margin-top: 30px;">
      <button id="unknown-btn" onclick="handleMemorizeAnswer(false)" style="flex: 1; padding: 15px; font-size: 1.1em; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
        ✗ 知らなかった
      </button>
      <button id="known-btn" onclick="handleMemorizeAnswer(true)" style="flex: 1; padding: 15px; font-size: 1.1em; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
        ✓ 知ってた
      </button>
    </div>
  `;

  // Add click listener to flip card
  const card = memorizeArea.querySelector('#memorize-card');
  if (card) {
    card.addEventListener('click', (e) => {
      if (e.target === card || card.contains(e.target)) {
        memorizeState.flipped = !memorizeState.flipped;
        card.classList.toggle('flipped');
      }
    });
  }

  // Add play button listener
  const playBtn = memorizeArea.querySelector('.play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      const word = memorizeState.words[memorizeState.currentIndex];
      if (word) speak(String(word.word));
    });
  }
}

function handleMemorizeAnswer(isKnown) {
  const { words, currentIndex } = memorizeState;
  const word = words[currentIndex];

  if (isKnown) {
    memorizeState.correct++;
  } else {
    memorizeState.incorrect++;
  }

  // Move to next word
  memorizeState.currentIndex++;
  memorizeState.flipped = false;

  renderMemorizeCard();
}
