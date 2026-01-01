// Server-side JP translation proxy to avoid CORS
// Uses Weblio dictionary (https://ejje.weblio.jp/) for English-Japanese translations

export default async function handler(req, res) {
  try {
    const { q, limit = 5 } = req.query || {};
    const word = typeof q === 'string' ? q.trim() : '';
    const lim = Math.max(1, Math.min(10, Number(limit) || 5));
    if (!word) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }

    const weblioResults = [];
    const wrResults = [];

    // --- helper: fetch text with timeout
    const fetchText = async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000); // 3秒に短縮
      try {
        const r = await fetch(url, { 
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!r.ok) throw new Error(`http_${r.status}`);
        return await r.text();
      } finally {
        clearTimeout(timer);
      }
    };

    // --- Weblio: scrape English-Japanese translation
    try {
      const weblioUrl = `https://ejje.weblio.jp/content/${encodeURIComponent(word)}`;
      const t0 = Date.now();
      console.log('jp-translate: weblio fetch start', { word, url: weblioUrl });
      const html = await fetchText(weblioUrl);
      console.log('jp-translate: weblio fetch ok', { word, ms: Date.now() - t0, bytes: html.length });
      
      // Extract Japanese translations from Weblio HTML
      // Target the main meaning/translation blocks: span/div/td with class containing "content-explanation ej"
      // Allow nested tags inside; capture inner HTML then strip tags/entities
      const japanesePattern = /<(?:span|div|td)[^>]*class="[^"]*content-explanation\s+ej[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td)>/gi;
      const matches = html.matchAll(japanesePattern);
      
      // Unwanted text patterns to exclude
      const excludePatterns = [
        /^[\s]*英和[\s]*$/i,
        /^[\s]*和英[\s]*$/i,
        /^[\s]*英語[\s]*$/i,
        /^[\s]*日本語[\s]*$/i,
        /^[\s]*用例[\s]*$/i,
        /^[\s]*例文[\s]*$/i,
        /^[\s]*語源[\s]*$/i,
        /^[\s]*$/, // empty strings
        /^[\s]*\|[\s]*$/, // pipe separator
        /^\d+[\.\)]+$/, // just numbers with punctuation
        /^\([\d]+件\)/, // (112件) pattern
        /件\)/, // ends with 件)
        /発音を聞く|プレーヤー再生|ピン留め|単語を追加|共有|主な意味/, // UI action texts
        /[:：][\s]*$/, // ends with colon (likely section markers)
        /^[\s]*[、。，。]+[\s]*$/, // just punctuation
        /[\?\？！！]/, // contains question/exclamation marks (likely meta text)
        /。[\s]*$/, // ends with sentence-ending punctuation (full-width period) - likely UI text
        /連絡|報告|削除|編集|送信|問題|ログイン|会員登録/, // action verbs/UI text
        /不適切|スパム|問題があります/, // abuse/spam report keywords
        /広告|コピーライト|著作権|プライバシー|利用規約/, // page boilerplate
        /Weblio|検索|辞書|英和|和英/, // site-specific UI text
        /^[\s]*\d+[\s]*$/, // just numbers
        /音声を再生|音節|発音記号/, // pronunciation related UI
        /クリップボード|お気に入り|単語帳/ // bookmark/clipboard UI
      ];
      
      const weblioSet = new Set();
      for (const match of matches) {
        const inner = match[1] || '';
        // Strip tags and decode a few common entities
        let term = inner
          .replace(/<[^>]+>/g, ' ') // drop nested tags
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/\s+/g, ' ')
          .trim();
        if (!term) continue;
        
        // Filter out unwanted text
        if (excludePatterns.some(pat => pat.test(term))) {
          continue;
        }
        
        // Split into multiple candidates by common separators
        const parts = term
          .split(/[、；;，]/)
          .map(s => s.replace(/\s+/g, '').trim())
          .filter(Boolean);
        
        for (const p of parts) {
          // Additional length check: skip overly long terms (likely descriptions)
          if (p.length > 50) {
            continue;
          }
          // Filter by Japanese characters presence
          if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(p)) {
            weblioSet.add(p);
            if (weblioSet.size >= lim) break;
          }
        }
        if (weblioSet.size >= lim) break;
      }
      const collected = Array.from(weblioSet);
      weblioResults.push(...collected);
      console.log('jp-translate: weblio parsed', { word, count: collected.length, sample: collected.slice(0, 5) });
    } catch (e) {
      console.warn('jp-translate: weblio failed', { word, error: e?.message || e });
    }

    // --- WordReference: always fetch to complement Weblio (especially for slang/informal expressions)
    try {
      const wrUrl = `https://www.wordreference.com/enja/${encodeURIComponent(word)}`;
      const t1 = Date.now();
      console.log('jp-translate: wr fetch start', { word, url: wrUrl });
      const html = await fetchText(wrUrl);
      console.log('jp-translate: wr fetch ok', { word, ms: Date.now() - t1, bytes: html.length });

        // Extract main translations section only (before "Additional Translations")
        const mainHtml = (html.split(/それ以外の訳語|Additional Translations/i)[0]) || html;
        
        // Target ToWrd class specifically (main translation column in WordReference)
        const japanesePattern = /<td[^>]*class="[^"]*ToWrd[^"]*"[^>]*>([^<]+)/g;
        const matches = mainHtml.matchAll(japanesePattern);

        const excludePatterns = [
          /^[\s]*主な訳語[\s]*$/i,
          /^[\s]*それ以外の訳語[\s]*$/i,
          /^[\s]*英語[\s]*$/i,
          /^[\s]*日本語[\s]*$/i,
          /^[\s]*成句[\s]*[:：]?[\s]*$/i,
          /^[\s]*複合語[\s]*[:：]?[\s]*$/i,
          /^[\s]*関連用語[\s]*[:：]?[\s]*$/i,
          /^[\s]*$/, // empty strings
          /^[\s]*\|[\s]*$/, // pipe separator
          /^\d+[\.\)]+$/, // just numbers with punctuation
          /^[\s]*[、。，。]+[\s]*$/, // just punctuation
          /[:：][\s]*$/, // ends with colon (section headers)
          /。[\s]*$/, // ends with full-width period
          /連絡|報告|削除|編集|送信|問題/,
          /不適切|スパム|問題があります/,
          /広告|コピーライト|著作権|プライバシー/,
          /,[\s]*(広告|著作権)/,
          /WordReference|Forum|Compound Forms|Inflections/, // site UI text
          /オンライン言語辞典|英和辞書|辞書|言語/, // dictionary/site info
          /日本語-英語|英語-日本語|〜-〜/, // language pair labels
          /もっと見る|詳細|翻訳/, // navigation/UI
          /フォーラム|以下の単語も見る|最近の検索/, // forum/navigation UI
          /見る[\s]*[:：]|検索[\s]*[:：]/, // section labels with colon
          /-[\s]*[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+[\s]*$/ // ends with dash and Japanese (likely label)
        ];

        const wrSet = new Set(weblioResults); // avoid duplicates with Weblio
        let rawCount = 0;
        for (const match of matches) {
          let term = (match[1] || '').trim();
          rawCount++;
          if (!term) continue;
          if (excludePatterns.some(p => p.test(term))) continue;

          // split by Japanese comma, take first part only (WR entries often include gloss)
          if (term.includes('、')) term = term.split('、')[0].trim();
          term = term.replace(/\s+/g, '');
          if (!term || term.length > 50) continue;
          if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(term)) {
            wrSet.add(term);
            if (wrSet.size >= lim * 2) break; // collect more to merge with Weblio
          }
        }

        // Only push the WR additions (exclude ones already in Weblio)
        wrResults.push(...Array.from(wrSet).filter(t => !weblioResults.includes(t)));
        console.log('jp-translate: wr parsed', { word, rawMatches: rawCount, afterFilter: wrSet.size, unique: wrResults.length, sample: wrResults.slice(0,5) });
      } catch (e) {
        console.warn('jp-translate: wr failed', { word, error: e?.message || e });
      }

    const combined = [...weblioResults, ...wrResults].slice(0, lim);
    const sourcesUsed = [];
    if (weblioResults.length > 0) sourcesUsed.push('weblio');
    if (wrResults.length > 0) sourcesUsed.push('wordreference');

    res.status(200).json({
      ok: true,
      result: combined,
      sourcesUsed,
      weblioResults,
      wrResults
    });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}