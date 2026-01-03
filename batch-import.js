// Batch import function for adding multiple words from a text file

async function handleFileImport() {
  const fileInput = document.getElementById('word-file-input');
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert('ファイルを選択してください');
    return;
  }

  const file = fileInput.files[0];
  const text = await file.text();
  
  // Parse words: one word per line, trim whitespace
  const words = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^[#\/]/.test(line)); // Skip empty lines and comments

  if (words.length === 0) {
    alert('有効な単語が見つかりませんでした');
    return;
  }

  console.log(`[Batch Import] Found ${words.length} words to import`);
  
  // Show progress UI
  const progressDiv = document.getElementById('import-progress');
  const progressBar = document.getElementById('import-fill');
  const statusDiv = document.getElementById('import-status');
  progressDiv.style.display = 'block';
  progressBar.style.width = '0%';

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  // Import each word
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const progress = Math.round(((i + 1) / words.length) * 100);
    
    statusDiv.textContent = `進行中: ${i + 1}/${words.length} - "${word}"を処理中...`;
    progressBar.style.width = `${progress}%`;

    try {
      // Check if word already exists
      if (customWords.some(w => w.word === word)) {
        console.log(`[Batch Import] Skipping duplicate: "${word}"`);
        skipCount++;
        continue;
      }

      // Fetch English definition and JP translation
      let meaning = '';
      let example = '';
      let category = '';
      let meaning_jp = '';

      try {
        const res = await fetch(`https://cambridge-dictionaryapi.vercel.app/api/dictionary/en/${encodeURIComponent(word)}`);
        if (res.ok) {
          const data = await res.json();
          
          // Extract definition
          if (Array.isArray(data.definition)) {
            meaning = data.definition.slice(0, 3).map(d => d.text).join('\n');
            
            // Extract examples
            const allExamples = data.definition.flatMap(def => {
              if (Array.isArray(def.example)) {
                return def.example.map(e => e.text);
              } else if (def.example && def.example.text) {
                return [def.example.text];
              }
              return [];
            });
            example = allExamples.filter(e => e && e.trim()).slice(0, 2).join('\n');
          }

          // Extract POS (part of speech)
          if (Array.isArray(data.pos)) {
            category = data.pos.join(', ');
          }
        }
      } catch (e) {
        console.warn(`[Batch Import] Failed to fetch definition for "${word}":`, e);
      }

      // Fetch JP translation
      try {
        meaning_jp = await fetchJapaneseTranslations(word);
      } catch (e) {
        console.warn(`[Batch Import] Failed to fetch JP translation for "${word}":`, e);
      }

      // Create word object
      const newWord = {
        userId,
        word,
        meaning_jp: meaning_jp || '',
        meaning: meaning || '',
        example: example || '',
        category: category || ''
      };

      // Add to IndexedDB
      await new Promise(resolve => {
        useDB('readwrite', store => {
          if (newWord && newWord.word) {
            store.put(newWord);
          }
          resolve();
        });
      });

      // Add to Google Sheets
      try {
        await callSheetApi('add', {
          word: newWord.word,
          meaning_jp: newWord.meaning_jp,
          meaning: newWord.meaning,
          example: newWord.example,
          category: newWord.category,
          userId: newWord.userId
        });
      } catch (e) {
        console.warn(`[Batch Import] Failed to add "${word}" to Sheets:`, e);
      }

      // Update local state
      customWords.push(newWord);
      successCount++;
      console.log(`[Batch Import] Successfully added: "${word}"`);

      // Small delay between requests to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (err) {
      failCount++;
      console.error(`[Batch Import] Error processing "${word}":`, err);
    }
  }

  // Update final UI
  progressBar.style.width = '100%';
  statusDiv.textContent = `完了: 成功 ${successCount}件、スキップ ${skipCount}件、エラー ${failCount}件`;

  // Refresh UI
  renderWords();
  updateProgressBar();

  // Reset file input and hide progress after 2 seconds
  setTimeout(() => {
    fileInput.value = '';
    progressDiv.style.display = 'none';
  }, 2000);
}
