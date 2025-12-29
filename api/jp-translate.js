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

    const wrTerms = [];
    const jishoTerms = [];
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
      const html = await fetchText(wrUrl);
      
      // Extract Japanese translations from WordReference HTML
      // More flexible pattern to capture Japanese text from various HTML structures
      const japanesePattern = /(?:class="(?:TarEng|TarTop|ToWrd)">|<td[^>]*>\s*(?:<[^>]*>)*)([^<]*(?:[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+)[^<]*)/g;
      const matches = html.matchAll(japanesePattern);
      
      // Unwanted text patterns to exclude
      const excludePatterns = [
        /^[\s]*主な訳語[\s]*$/i,
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
      
      for (const match of matches) {
        let term = (match[1] || '').trim();
        if (!term) continue;
        
        // Filter out unwanted text
        if (excludePatterns.some(pat => pat.test(term))) {
          continue;
        }
        
        // Additional length check: skip overly long terms (likely descriptions)
        if (term.length > 50) {
          continue;
        }
        
        // Filter by Japanese characters presence
        if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(term)) {
          wrTerms.push(term);
          if (wrTerms.length >= lim) break;
        }
      }
      if (wrTerms.length > 0) {
        sourcesUsed.push('wordreference');
      }
    } catch (e) {
      console.warn('jp-translate: wordreference failed', e);
    }

    // --- Jisho (JMdict) fallback
    if (wrTerms.length < lim) {
      try {
        const jishoUrl = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;
        const data = await fetchJson(jishoUrl);
        if (data && Array.isArray(data.data)) {
          for (const entry of data.data) {
            if (entry && Array.isArray(entry.japanese)) {
              for (const jp of entry.japanese) {
                const term = (jp.word || jp.reading || '').trim();
                if (term) jishoTerms.push(term);
                if (jishoTerms.length >= lim - wrTerms.length) break;
              }
            }
            if (jishoTerms.length >= lim - wrTerms.length) break;
          }
        }
        if (jishoTerms.length > 0) {
          sourcesUsed.push('jisho');
        }
      } catch (e) {
        console.warn('jp-translate: jisho failed', e);
      }
    }

    // --- Format WordReference results: detect "それ以外の訳語" pattern
    let formattedWrTerms = [];
    const otherTransIdx = wrTerms.findIndex(t => /^それ以外の訳語$/.test(t));
    
    if (otherTransIdx !== -1 && otherTransIdx < wrTerms.length - 1) {
      // Add terms before "それ以外の訳語"
      formattedWrTerms = wrTerms.slice(0, otherTransIdx);
      // Format "それ以外の訳語（terms...）"
      const otherTerms = wrTerms.slice(otherTransIdx + 1);
      if (otherTerms.length > 0) {
        formattedWrTerms.push(`それ以外の訳語（${otherTerms.join('、')}）`);
      }
    } else {
      // No special formatting needed
      formattedWrTerms = wrTerms;
    }

    // --- Detect common terms between Jisho and WordReference (higher priority)
    const jishoSet = new Set(jishoTerms);
    const wrSet = new Set(formattedWrTerms);
    
    // Common terms: appear in both sources
    const commonTerms = jishoTerms.filter(term => wrSet.has(term));
    
    // Jisho-only terms: in Jisho but not in WordReference
    const jishoOnlyTerms = jishoTerms.filter(term => !wrSet.has(term));
    
    // WordReference-only terms: in WordReference but not in Jisho
    const wrOnlyTerms = formattedWrTerms.filter(term => !jishoSet.has(term));

    // --- Combine: Common (highest priority) → Jisho-only → WordReference-only
    const combined = [...commonTerms, ...jishoOnlyTerms, ...wrOnlyTerms];
    const out = combined.slice(0, lim);

    res.status(200).json({ ok: true, result: out, sourcesUsed });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}