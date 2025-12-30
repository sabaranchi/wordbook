// Server-side JP translation proxy to avoid CORS
// Tries WordReference first, then Jisho (JMdict) fallback
// Returns translations grouped by source to prevent overwrites and allow flexible formatting

export default async function handler(req, res) {
  try {
    const { q, limit = 5 } = req.query || {};
    const word = typeof q === 'string' ? q.trim() : '';
    const lim = Math.max(1, Math.min(10, Number(limit) || 5));
    if (!word) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }

    const wrResults = [];
    const jishoResults = [];

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

    // --- helper: fetch JSON with timeout
    const fetchJson = async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`http_${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    };

    // --- WordReference PRIMARY: scrape English-Japanese translation
    try {
      const wrUrl = `https://www.wordreference.com/enja/${encodeURIComponent(word)}`;
      const html = await fetchText(wrUrl);
      
      // Extract Japanese translations from WordReference HTML
      // More flexible pattern to capture Japanese text from various HTML structures
      const japanesePattern = /(?:class="(?:TarEng|TarTop|ToWrd)">|<td[^>]*>\s*(?:<[^>]*>)*)([^<]*(?:[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+)[^<]*)/g;
      const matches = html.matchAll(japanesePattern);
      
      // Unwanted text patterns to exclude
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
        /[:：]/, // contains colon or full-width colon (likely section markers or descriptive text)
        /^[\s]*[、。，。]+[\s]*$/, // just punctuation
        /[\?\？！！]/, // contains question/exclamation marks (likely meta text)
        /。[\s]*$/, // ends with sentence-ending punctuation (full-width period) - likely UI text
        /連絡|報告|削除|編集|送信|問題/, // action verbs/UI text like "連絡する", "報告する"
        /不適切|スパム|問題があります/, // abuse/spam report keywords
        /、.{0,20}(広告|コピーライト|著作権|プライバシー)/, // page boilerplate with comma separator
        /^(広告|コピーライト|著作権|プライバシー)/, // page footer/header text
        /,[\s]*(広告|著作権)/ // English-style comma with ad/copyright keywords
      ];
      
      const wrSet = new Set();
      for (const match of matches) {
        let term = (match[1] || '').trim();
        if (!term) continue;
        
        // Filter out unwanted text
        if (excludePatterns.some(pat => pat.test(term))) {
          continue;
        }
        
        // Split by 、(Japanese comma) and take only the first part to avoid mixed meanings
        // e.g., "犬 、 イヌ科の動物" → take only "犬"
        if (term.includes('、')) {
          term = term.split('、')[0].trim();
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
          wrSet.add(term);
          if (wrSet.size >= lim) break;
        }
      }
      wrResults.push(...Array.from(wrSet));
    } catch (e) {
      console.warn('jp-translate: wordreference failed', e);
    }

    // --- Jisho (JMdict) fallback
    // Only fetch if WordReference results are insufficient
    if (wrResults.length < lim) {
      try {
        const jishoUrl = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;
        const data = await fetchJson(jishoUrl);
        if (data && Array.isArray(data.data)) {
          const jishoSet = new Set(wrResults); // Start with WR results to avoid duplicates
          for (const entry of data.data) {
            if (entry && Array.isArray(entry.japanese)) {
              for (const jp of entry.japanese) {
                const term = (jp.word || jp.reading || '').trim();
                if (term && !jishoSet.has(term)) {
                  jishoResults.push(term);
                  jishoSet.add(term);
                  if (jishoResults.length >= (lim - wrResults.length)) break;
                }
              }
            }
            if (jishoResults.length >= (lim - wrResults.length)) break;
          }
        }
      } catch (e) {
        console.warn('jp-translate: jisho failed', e);
      }
    }

    // Determine sourcesUsed
    const sourcesUsed = [];
    if (wrResults.length > 0) sourcesUsed.push('wordreference');
    if (jishoResults.length > 0) sourcesUsed.push('jisho');

    res.status(200).json({
      ok: true,
      result: [...wrResults, ...jishoResults].slice(0, lim),
      sourcesUsed,
      wrResults,
      jishoResults
    });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}