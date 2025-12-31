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

    // --- helper: fetch text with timeout
    const fetchText = async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
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
      const html = await fetchText(weblioUrl);
      
      // Extract Japanese translations from Weblio HTML
      // More specific targeting: look for meaning sections
      // Weblio typically has meanings in specific div/span structures
      const japanesePattern = /<span class="content">([^<]+)<\/span>/g;
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
        let term = (match[1] || '').trim();
        if (!term) continue;
        
        // Filter out unwanted text
        if (excludePatterns.some(pat => pat.test(term))) {
          continue;
        }
        
        // Split by 、(Japanese comma) or semicolon and take only the first part
        if (term.includes('、')) {
          term = term.split('、')[0].trim();
        } else if (term.includes('；')) {
          term = term.split('；')[0].trim();
        } else if (term.includes(';')) {
          term = term.split(';')[0].trim();
        }
        
        // Normalize: remove leading/trailing spaces and compress internal spaces
        term = term.replace(/\s+/g, '');
        if (!term) continue;
        
        // Additional length check: skip overly long terms (likely descriptions)
        if (term.length > 50) {
          continue;
        }
        
        // Filter by Japanese characters presence
        if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(term)) {
          weblioSet.add(term);
          if (weblioSet.size >= lim) break;
        }
      }
      weblioResults.push(...Array.from(weblioSet));
    } catch (e) {
      console.warn('jp-translate: weblio failed', e);
    }

    res.status(200).json({
      ok: true,
      result: weblioResults.slice(0, lim),
      sourcesUsed: weblioResults.length > 0 ? ['weblio'] : [],
      weblioResults
    });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}