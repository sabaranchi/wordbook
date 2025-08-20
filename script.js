fetch('words.json')
  .then(res => res.json())
  .then(words => {
    const container = document.getElementById('word-container');
    words.forEach(word => {
      const card = document.createElement('div');
      card.className = 'word-card';
      card.innerHTML = `
        <h2>${word.word}</h2>
        <p><strong>意味:</strong> ${word.meaning}</p>
        <p><em>例文:</em> ${word.example}</p>
        <p><small>カテゴリー: ${word.category}</small></p>
        <button onclick="new Audio('${word.audio}').play()">発音を聞く</button>
      `;
      container.appendChild(card);
    });
  });