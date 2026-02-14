// Flip-card quiz replacement
// This file contains the new flip-card based quiz functionality
// Include this AFTER script.js to override the quiz functions

function toggleQuizMode() {
  quizMode = quizMode === 'en-to' ? 'to-en' : 'en-to';
  localStorage.setItem('quizMode', quizMode);
  startQuiz();
}

function startQuiz() {
  const quizArea = document.getElementById('quiz-area');
  quizArea.innerHTML = '';

  const myWords = customWords.filter(w => w.userId === userId);
  const unlearned = myWords.filter(w => !learnedWords[w.word]);
  const learned = myWords.filter(w => learnedWords[w.word]);

  let pool = [];
  if (unlearned.length > 0) {
    const sortedByStreak = [...learned].sort((a, b) => (correctStreaks[a.word] || 0) - (correctStreaks[b.word] || 0));
    pool = [...unlearned, ...sortedByStreak.slice(0, 100)];
  } else {
    pool = [...learned];
  }

  if (pool.length === 0) {
    quizArea.innerHTML = '<h3>No words to quiz yet.</h3>';
    return;
  }

  const question = pool[Math.floor(Math.random() * pool.length)];
  currentQuestion = question;
  const frontText = quizMode === 'en-to' ? question.word : question.meaning_jp;
  const backText = quizMode === 'en-to' ? (question.meaning_jp || '?') : (question.word || '?');
  const modeLabel = quizMode === 'en-to' ? '英→日' : '日→英';

  quizArea.innerHTML = `
    <div style="margin-bottom:1rem; display:flex; gap:0.5rem; align-items:center;">
      <button onclick="toggleQuizMode()" style="margin-right:0.5rem;">Mode: ${modeLabel}</button>
      <button onclick="startMemorize()" style="margin-left:0.5rem;">Memorize</button>
      <button class="play-btn" title="Play pronunciation">🔊</button>
    </div>
    <div class="quiz-card-container">
      <div id="quiz-card" class="flip-card" data-word="${question.word.replace(/"/g, '&quot;')}">
        <div class="flip-card-inner">
          <div class="flip-card-front">${frontText}</div>
          <div class="flip-card-back">${backText}</div>
        </div>
      </div>
    </div>
  `;

  const playBtn = quizArea.querySelector('.play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => speak(String(question.word)));
  }

  const cardContainer = quizArea.querySelector('.quiz-card-container');
  const card = quizArea.querySelector('#quiz-card');
  const cardFront = card.querySelector('.flip-card-front');
  const cardBack = card.querySelector('.flip-card-back');
  
  // フロント（表）クリック: フリップのみ
  cardFront.addEventListener('click', (e) => {
    e.stopPropagation();
    card.classList.toggle('flipped');
  });

  // バック（裏）クリック: 左右の位置で正誤判定
  cardBack.addEventListener('click', (e) => {
    e.stopPropagation();
    const cardRect = card.getBoundingClientRect();
    const clickX = e.clientX;
    const cardCenter = cardRect.left + cardRect.width / 2;
    // 中央から離れた位置でのクリック
    if (Math.abs(clickX - cardCenter) > cardRect.width * 0.1) {
      const isCorrect = clickX > cardCenter;
      handleQuizAnswer(question.word, isCorrect, cardContainer);
    }
  });

  // スワイプ & タップジェスチャー（裏面でのみ判定）
  let touchStart = null;
  cardContainer.addEventListener('touchstart', (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
  });
  
  cardContainer.addEventListener('touchend', (e) => {
    if (!touchStart || !card.classList.contains('flipped')) return;
    
    const touchEnd = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY, time: Date.now() };
    const dx = touchEnd.x - touchStart.x;
    const dy = touchEnd.y - touchStart.y;
    const time = touchEnd.time - touchStart.time;

    // スワイプ: 距離 > 50px & 時間 < 500ms
    const isSwipe = Math.abs(dx) > 50 && Math.abs(dy) < 30 && time < 500;
    // タップ: 移動 < 10px & 時間 < 300ms
    const isTap = Math.abs(dx) < 10 && Math.abs(dy) < 10 && time < 300;

    if (isSwipe) {
      // 右スワイプ = 正解、左スワイプ = 不正解
      const isCorrect = dx > 0;
      handleQuizAnswer(question.word, isCorrect, cardContainer);
    } else if (isTap) {
      // タップ: 左右の位置で判定
      const cardRect = card.getBoundingClientRect();
      const tapX = touchStart.x;
      const cardCenter = cardRect.left + cardRect.width / 2;
      const isCorrect = tapX > cardCenter;
      handleQuizAnswer(question.word, isCorrect, cardContainer);
    }
  });
}

function handleQuizAnswer(word, isCorrect, cardContainer) {
  const quizArea = document.getElementById('quiz-area');
  quizArea.style.backgroundColor = isCorrect ? '#d4edda' : '#f8d7da';
  quizArea.style.pointerEvents = 'none';

  setTimeout(() => {
    quizArea.style.backgroundColor = '';
    quizArea.style.pointerEvents = 'auto';

    if (isCorrect) {
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
    }

    try {
      updateLearningStatus(word, !!learnedWords[word], Number(correctStreaks[word] || 0));
    } catch (e) {
      console.error('updateLearningStatus failed', e);
    }

    startQuiz();
  }, 800);
}

// Remove old checkAnswer function to prevent conflicts
if (typeof window.checkAnswer === 'function') {
  delete window.checkAnswer;
}

// Memorize Mode Implementation
let memorizeState = {
  pool: [],
  currentIndex: 0,
  answers: {},
  isStarted: false
};

function startMemorize() {
  const quizArea = document.getElementById('quiz-area');
  quizArea.innerHTML = '';

  const myWords = customWords.filter(w => w.userId === userId);
  
  if (myWords.length === 0) {
    quizArea.innerHTML = '<h3>No words to memorize yet.</h3>';
    return;
  }

  // Shuffle all words
  memorizeState.pool = [...myWords].sort(() => Math.random() - 0.5);
  memorizeState.currentIndex = 0;
  memorizeState.answers = {};
  memorizeState.isStarted = true;

  displayMemorizeCard();
}

function displayMemorizeCard() {
  const quizArea = document.getElementById('quiz-area');
  const { pool, currentIndex } = memorizeState;

  if (currentIndex >= pool.length) {
    showMemorizeComplete();
    return;
  }

  const word = pool[currentIndex];
  const totalWords = pool.length;
  const progressNum = currentIndex + 1;

  // Get example sentence (first one from examples array)
  const exampleSentence = word.example && word.example.length > 0 
    ? word.example[0] 
    : 'No example available';

  const frontText = word.word;
  const backText = word.meaning_jp || '?';

  quizArea.innerHTML = `
    <div style="margin-bottom:1rem; display:flex; gap:0.5rem; align-items:center; justify-content:space-between;">
      <div>Progress: <strong>${progressNum}/${totalWords}</strong></div>
      <button onclick="exitMemorize()" style="padding:0.5rem 1rem;">← Back to Quiz</button>
    </div>

    <div id="memorize-card" class="flip-card" style="
      width:100%;
      max-width:600px;
      margin:2rem auto;
      perspective:1000px;
      cursor:pointer;
      height:300px;
    ">
      <div class="flip-card-inner" style="
        position:relative;
        width:100%;
        height:100%;
        transition:transform 0.6s;
        transform-style:preserve-3d;
      ">
        <!-- Front -->
        <div style="
          position:absolute;
          width:100%;
          height:100%;
          backface-visibility:hidden;
          display:flex;
          flex-direction:column;
          justify-content:center;
          align-items:center;
          background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color:white;
          border-radius:10px;
          padding:2rem;
          box-shadow:0 4px 8px rgba(0,0,0,0.2);
          text-align:center;
        ">
          <div style="font-size:2.5rem; font-weight:bold; margin-bottom:1rem;">${frontText}</div>
          <div style="font-size:1rem; margin-top:1rem; opacity:0.8;">${exampleSentence}</div>
          <div style="font-size:0.8rem; margin-top:1.5rem; opacity:0.7;">Click to reveal translation</div>
        </div>

        <!-- Back -->
        <div style="
          position:absolute;
          width:100%;
          height:100%;
          backface-visibility:hidden;
          transform:rotateY(180deg);
          display:flex;
          justify-content:center;
          align-items:center;
          background:linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          color:white;
          border-radius:10px;
          padding:2rem;
          box-shadow:0 4px 8px rgba(0,0,0,0.2);
          text-align:center;
        ">
          <div style="font-size:2rem; font-weight:bold;">${backText}</div>
        </div>
      </div>
    </div>

    <div style="
      display:flex;
      gap:1rem;
      justify-content:center;
      margin-top:2rem;
    ">
      <button class="answer-btn incorrect-btn" onclick="memorizeAnswer(false)" style="
        flex:1;
        max-width:250px;
        padding:1rem;
        font-size:1.1rem;
        background:#ff6b6b;
        color:white;
        border:none;
        border-radius:8px;
        cursor:pointer;
        font-weight:bold;
      ">
        ✗ 知らなかった
      </button>
      <button class="answer-btn correct-btn" onclick="memorizeAnswer(true)" style="
        flex:1;
        max-width:250px;
        padding:1rem;
        font-size:1.1rem;
        background:#51cf66;
        color:white;
        border:none;
        border-radius:8px;
        cursor:pointer;
        font-weight:bold;
      ">
        ✓ 知ってた
      </button>
    </div>
  `;

  // Add flip event listener
  const card = document.getElementById('memorize-card');
  const cardInner = card.querySelector('.flip-card-inner');
  
  card.addEventListener('click', function(e) {
    if (!e.target.closest('button')) {
      cardInner.style.transform = 
        cardInner.style.transform === 'rotateY(180deg)' 
          ? 'rotateY(0deg)' 
          : 'rotateY(180deg)';
    }
  });
}

function memorizeAnswer(isCorrect) {
  const { pool, currentIndex } = memorizeState;
  const word = pool[currentIndex];

  // Track answer (for stats if needed later)
  memorizeState.answers[word.word] = isCorrect;

  // Move to next word
  memorizeState.currentIndex++;
  
  // Small delay before displaying next card
  setTimeout(() => {
    displayMemorizeCard();
  }, 300);
}

function showMemorizeComplete() {
  const quizArea = document.getElementById('quiz-area');
  const { answers, pool } = memorizeState;

  const correctCount = Object.values(answers).filter(v => v === true).length;
  const totalCount = pool.length;
  const percentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

  quizArea.innerHTML = `
    <div style="
      text-align:center;
      padding:2rem;
      background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color:white;
      border-radius:10px;
      margin:2rem 0;
    ">
      <h2 style="font-size:2.5rem; margin-bottom:1rem;">Memorize Complete!</h2>
      <p style="font-size:1.5rem; margin:1rem 0;">
        You remembered <strong>${correctCount}/${totalCount}</strong> words
      </p>
      <p style="font-size:1.2rem; opacity:0.9;">
        Success rate: <strong>${percentage}%</strong>
      </p>
      <button onclick="startMemorize()" style="
        margin-top:2rem;
        padding:1rem 2rem;
        font-size:1.1rem;
        background:white;
        color:#667eea;
        border:none;
        border-radius:8px;
        cursor:pointer;
        font-weight:bold;
      ">
        Memorize Again (Reshuffled)
      </button>
      <button onclick="startQuiz()" style="
        margin-top:1rem;
        display:block;
        width:100%;
        padding:0.8rem;
        font-size:1rem;
        background:rgba(255,255,255,0.2);
        color:white;
        border:1px solid white;
        border-radius:8px;
        cursor:pointer;
      ">
        Back to Quiz
      </button>
    </div>
  `;
}

function exitMemorize() {
  memorizeState.isStarted = false;
  memorizeState.pool = [];
  memorizeState.currentIndex = 0;
  startQuiz();
}
