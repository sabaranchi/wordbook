// Batch import function for adding multiple words from a text file

// Store failed and skipped words for download
let failedWords = [];
let skippedWords = [];

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
  
  // Reset log arrays
  failedWords = [];
  skippedWords = [];
  
  // Show progress UI
  const progressDiv = document.getElementById('import-progress');
  const progressBar = document.getElementById('import-fill');
  const statusDiv = document.getElementById('import-status');
  const logContainer = document.getElementById('import-log-container');
  const logTextarea = document.getElementById('import-log');
  
  progressDiv.style.display = 'block';
  progressBar.style.width = '0%';
  logContainer.style.display = 'block';
  logTextarea.value = '=== Batch Import Started ===\n';

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  const appendLog = (message) => {
    logTextarea.value += message + '\n';
    logTextarea.scrollTop = logTextarea.scrollHeight;
  };

  // Import each word
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const progress = Math.round(((i + 1) / words.length) * 100);
    
    statusDiv.textContent = `進行中: ${i + 1}/${words.length} - "${word}"を処理中...`;
    progressBar.style.width = `${progress}%`;

    try {
      // Check if word already exists
      if (customWords.some(w => w.word === word)) {
        appendLog(`⊘ SKIPPED: "${word}" (already exists)`);
        skipCount++;
        skippedWords.push(word);
        continue;
      }

      appendLog(`→ Processing: "${word}"...`);

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
        } else {
          appendLog(`  ⚠ Definition fetch returned ${res.status} for "${word}"`);
        }
      } catch (e) {
        appendLog(`  ⚠ Definition fetch error for "${word}": ${e.message}`);
      }

      // Fetch JP translation
      try {
        meaning_jp = await fetchJapaneseTranslations(word);
      } catch (e) {
        appendLog(`  ⚠ JP translation error for "${word}": ${e.message}`);
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
        appendLog(`  ✗ Sheets save error for "${word}": ${e.message}`);
        failCount++;
        failedWords.push(word);
        continue;
      }

      // Update local state
      customWords.push(newWord);
      successCount++;
      appendLog(`  ✓ SUCCESS: "${word}" added`);

      // Small delay between requests to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (err) {
      failCount++;
      failedWords.push(word);
      appendLog(`✗ ERROR: "${word}" - ${err.message}`);
      console.error(`[Batch Import] Error processing "${word}":`, err);
    }
  }

  // Update final UI
  progressBar.style.width = '100%';
  statusDiv.textContent = `完了: 成功 ${successCount}件、スキップ ${skipCount}件、エラー ${failCount}件`;
  
  appendLog('\n=== Batch Import Completed ===');
  appendLog(`✓ Success: ${successCount}`);
  appendLog(`⊘ Skipped: ${skipCount}`);
  appendLog(`✗ Failed: ${failCount}`);

  // Update summary
  const summaryDiv = document.getElementById('import-summary');
  summaryDiv.innerHTML = `
    <strong>インポート完了</strong><br>
    成功: <span style="color: green;">${successCount}件</span> | 
    スキップ: <span style="color: orange;">${skipCount}件</span> | 
    失敗: <span style="color: red;">${failCount}件</span>
  `;

  // Show download button only if there are failed/skipped words
  const downloadBtn = document.getElementById('download-failed-btn');
  if (failedWords.length > 0 || skippedWords.length > 0) {
    downloadBtn.style.display = 'inline-block';
  } else {
    downloadBtn.style.display = 'none';
  }

  // Refresh UI
  renderWords();
  updateProgressBar();
}

function downloadFailedWords() {
  const lines = [];
  
  if (skippedWords.length > 0) {
    lines.push('# Skipped words (already exist)');
    skippedWords.forEach(w => lines.push(w));
    lines.push('');
  }
  
  if (failedWords.length > 0) {
    lines.push('# Failed words (errors during import)');
    failedWords.forEach(w => lines.push(w));
  }

  if (lines.length === 0) {
    alert('ダウンロードする単語がありません');
    return;
  }

  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `failed-skipped-words-${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
