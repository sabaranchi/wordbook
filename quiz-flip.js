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
    <div id="quiz-card" class="flip-card" data-word="${question.word.replace(/"/g, '&quot;')}">
      <div class="flip-card-inner">
        <div class="flip-card-front">${frontText}</div>
        <div class="flip-card-back">${backText}</div>
      </div>
    </div>
    <div style="margin-top:1rem; font-size:0.9rem; color:#666; text-align:center;">
      <p style="margin:0.3rem 0;">👆 カードをタップして裏返す</p>
      <p style="margin:0.3rem 0;">👈 左タップ/スワイプ = 不正解 | 右タップ/スワイプ = 正解 👉</p>
    </div>
  `;

  const playBtn = quizArea.querySelector('.play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => speak(String(question.word)));
  }

  const card = quizArea.querySelector('#quiz-card');
  
  // クリック/タップでフリップ
  card.addEventListener('click', (e) => {
    // 裏返し状態でない場合だけフリップ
    if (!card.classList.contains('flipped')) {
      card.classList.add('flipped');
    }
  });

  // スワイプ & タップジェスチャー
  let touchStart = null;
  card.addEventListener('touchstart', (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
  });
  
  card.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const touchEnd = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY, time: Date.now() };
    const dx = touchEnd.x - touchStart.x;
    const dy = touchEnd.y - touchStart.y;
    const time = touchEnd.time - touchStart.time;

    // スワイプ: 距離 > 50px & 時間 < 500ms
    const isSwipe = Math.abs(dx) > 50 && Math.abs(dy) < 30 && time < 500;
    // タップ: 移動 < 10px & 時間 < 300ms
    const isTap = Math.abs(dx) < 10 && Math.abs(dy) < 10 && time < 300;

    if (isSwipe && card.classList.contains('flipped')) {
      // 右スワイプ = 正解、左スワイプ = 不正解
      const isCorrect = dx > 0;
      handleQuizAnswer(question.word, isCorrect);
    } else if (isTap && card.classList.contains('flipped')) {
      // フリップ状態でのタップ: 左右の位置で判定
      const cardRect = card.getBoundingClientRect();
      const tapX = touchStart.x;
      const cardCenter = cardRect.left + cardRect.width / 2;
      const isCorrect = tapX > cardCenter;
      handleQuizAnswer(question.word, isCorrect);
    }
  });

  // マウスクリック対応（デスクトップ）
  card.addEventListener('click', (e) => {
    if (card.classList.contains('flipped')) {
      const cardRect = card.getBoundingClientRect();
      const clickX = e.clientX;
      const cardCenter = cardRect.left + cardRect.width / 2;
      // 中央から 10% 以上離れた位置でのクリック
      if (Math.abs(clickX - cardCenter) > cardRect.width * 0.1) {
        const isCorrect = clickX > cardCenter;
        handleQuizAnswer(question.word, isCorrect);
      }
    }
  });
}

function handleQuizAnswer(word, isCorrect) {
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
