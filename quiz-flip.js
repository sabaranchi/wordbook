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

// Memorize Mode Functions
let memorizeState = null;

function startMemorize() {
  const memorizeArea = document.getElementById('memorize-area');
  memorizeArea.innerHTML = '';

  const myWords = customWords.filter(w => w.userId === userId);

  if (myWords.length === 0) {
    memorizeArea.innerHTML = '<h3>No words to memorize yet.</h3>';
    return;
  }

  // Shuffle words using Fisher-Yates algorithm
  const shuffled = [...myWords];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  memorizeState = {
    words: shuffled,
    current: 0
  };

  displayMemorizeCard();
}

function displayMemorizeCard() {
  const memorizeArea = document.getElementById('memorize-area');
  memorizeArea.innerHTML = '';

  if (!memorizeState || memorizeState.current >= memorizeState.words.length) {
    memorizeArea.innerHTML = '<h3>Memorize Complete! 🎉</h3><button onclick="showSection(\'add\')">Back to Add Word</button>';
    return;
  }

  const word = memorizeState.words[memorizeState.current];
  const totalWords = memorizeState.words.length;
  const currentNum = memorizeState.current + 1;

  // Get examples (first one only)
  const exampleEn = word.example ? word.example.split(/\n|、/)[0] : '';
  const exampleJp = word.example_jp ? word.example_jp.split(/\n|、/)[0] : '';

  memorizeArea.innerHTML = `
    <div style="margin-bottom:1rem; display:flex; gap:1rem; align-items:center;">
      <h3 style="margin:0;">${currentNum} / ${totalWords}</h3>
      <button class="play-btn" title="Play pronunciation">🔊</button>
    </div>
    <div class="memorize-card-container">
      <div id="memorize-card" class="flip-card">
        <div class="flip-card-inner">
          <div class="flip-card-front">
            <div class="memorize-front-content">
              <div class="memorize-word">${word.word}</div>
              <div class="memorize-example">${exampleEn}</div>
            </div>
          </div>
          <div class="flip-card-back">
            <div class="memorize-back-content">
              <div class="memorize-meaning">${word.meaning_jp || '?'}</div>
              <div class="memorize-example">${exampleJp}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div style="margin-top:2rem; display:flex; gap:2rem; justify-content:center;">
      <button class="answer-btn answer-no" style="background-color:#ffcccc; padding:1rem 2rem; border:none; border-radius:8px; cursor:pointer; font-size:1.2rem;">
        ✗ Didn't Know
      </button>
      <button class="answer-btn answer-yes" style="background-color:#ccffcc; padding:1rem 2rem; border:none; border-radius:8px; cursor:pointer; font-size:1.2rem;">
        ✓ Knew It
      </button>
    </div>
  `;

  const playBtn = memorizeArea.querySelector('.play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => speak(String(word.word)));
  }

  const card = memorizeArea.querySelector('#memorize-card');
  const cardFront = card.querySelector('.flip-card-front');

  // フロント（表）クリック: フリップのみ
  cardFront.addEventListener('click', (e) => {
    e.stopPropagation();
    card.classList.toggle('flipped');
  });

  // ボタンクリック: 次へ進む（学習状態は更新しない）
  const answerNoBtn = memorizeArea.querySelector('.answer-no');
  const answerYesBtn = memorizeArea.querySelector('.answer-yes');

  answerNoBtn.addEventListener('click', () => {
    handleMemorizeAnswer(false);
  });

  answerYesBtn.addEventListener('click', () => {
    handleMemorizeAnswer(true);
  });

  // キーボード: 左矢印 = 知らなかった、右矢印 = 知ってた
  const handleKeyPress = (e) => {
    if (e.key === 'ArrowLeft') {
      handleMemorizeAnswer(false);
    } else if (e.key === 'ArrowRight') {
      handleMemorizeAnswer(true);
    }
  };
  document.addEventListener('keydown', handleKeyPress);

  // スワイプ & タップジェスチャー（カード全体）
  let touchStart = null;
  const cardContainer = memorizeArea.querySelector('.memorize-card-container');
  
  cardContainer.addEventListener('touchstart', (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
  });

  cardContainer.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    
    const touchEnd = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY, time: Date.now() };
    const dx = touchEnd.x - touchStart.x;
    const dy = touchEnd.y - touchStart.y;
    const time = touchEnd.time - touchStart.time;

    const isSwipe = Math.abs(dx) > 50 && Math.abs(dy) < 30 && time < 500;

    if (isSwipe) {
      // 右スワイプ = 知ってた、左スワイプ = 知らなかった
      const knew = dx > 0;
      handleMemorizeAnswer(knew);
    }
  });

  // クリック時：左右の位置で判定
  card.addEventListener('click', (e) => {
    if (card.classList.contains('flipped')) {
      const cardRect = card.getBoundingClientRect();
      const clickX = e.clientX;
      const cardCenter = cardRect.left + cardRect.width / 2;
      const knew = clickX > cardCenter;
      if (Math.abs(clickX - cardCenter) > cardRect.width * 0.1) {
        handleMemorizeAnswer(knew);
      }
    }
  });
}

function handleMemorizeAnswer(knew) {
  // Update memorize state and move to next word
  // Note: Unlike quiz, we don't update learning status here
  memorizeState.current++;
  displayMemorizeCard();
}
