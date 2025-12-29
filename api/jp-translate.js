// Server-side JP translation proxy to avoid CORS
// Tries WordReference first, then Jisho (JMdict) fallback

export default async function handler(req, res) {
  try {
    const { q, limit = 5 } = req.query || {};
    const word = typeof q === 'string' ? q.trim() : '';
    const lim = Math.max(1, Math.min(10, Number(limit) || 5));
    if (!word) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }

    const uniq = new Set();
    const sourcesUsed = [];

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
      const before = uniq.size;
      const html = await fetchText(wrUrl);
      
      // Extract Japanese translations from WordReference HTML
      // Look for <span class="ToWrd">...</span> within translation cells
      const japanesePattern = /<span class="ToWrd">([^<]+)<\/span>/g;
      const matches = html.matchAll(japanesePattern);
      
      // Unwanted text patterns to exclude
      const excludePatterns = [
        /^[\s]*主な訳語[\s]*$/,
        /^[\s]*英語[\s]*$/,
        /^[\s]*日本語[\s]*$/,
        /^[\s]*$/ // empty strings
      ];
      
      for (const match of matches) {
        let term = (match[1] || '').trim();
        if (!term) continue;
        
        // Filter out unwanted text
        if (excludePatterns.some(pat => pat.test(term))) {
          continue;
        }
        
        // Filter by Japanese characters presence
        if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(term)) {
          uniq.add(term);
          if (uniq.size >= lim) break;
        }
      }
      if (uniq.size > before) {
        sourcesUsed.push('wordreference');
      }
    } catch (e) {
      console.warn('jp-translate: wordreference failed', e);
    }

    // --- Jisho (JMdict) fallback
    if (uniq.size < lim) {
      try {
        const before = uniq.size;
        const jishoUrl = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;
        const data = await fetchJson(jishoUrl);
        if (data && Array.isArray(data.data)) {
          for (const entry of data.data) {
            if (entry && Array.isArray(entry.japanese)) {
              for (const jp of entry.japanese) {
                const term = (jp.word || jp.reading || '').trim();
                if (term) uniq.add(term);
                if (uniq.size >= lim) break;
              }
            }
            if (uniq.size >= lim) break;
          }
        }
        if (uniq.size > before) {
          sourcesUsed.push('jisho');
        }
      } catch (e) {
        console.warn('jp-translate: jisho failed', e);
      }
    }

    const out = Array.from(uniq).slice(0, lim);
    res.status(200).json({ ok: true, result: out, sourcesUsed });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}