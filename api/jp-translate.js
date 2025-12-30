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

    // Debug logging
    const DEBUG = true;
    const debugLog = (phase, data) => {
      if (DEBUG) console.log(`[jp-translate] [${word}] [${phase}]:`, data);
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
      
      const allExtractedFromWr = [];
      for (const match of matches) {
        let term = (match[1] || '').trim();
        if (!term) continue;
        
        allExtractedFromWr.push({ raw: match[1], trimmed: term });
        
        // Filter out unwanted text
        if (excludePatterns.some(pat => pat.test(term))) {
          debugLog('WR_FILTERED', `"${term}" (matched exclude pattern)`);
          continue;
        }
        
        // Additional length check: skip overly long terms (likely descriptions)
        if (term.length > 50) {
          debugLog('WR_FILTERED', `"${term}" (too long: ${term.length})`);
          continue;
        }
        
        // Filter by Japanese characters presence
        if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(term)) {
          // Trim and normalize the term to avoid duplicate with different spacing
          const normalizedTerm = term.trim();
          // Only add if not already present (case-sensitive exact match)
          if (!wrTerms.includes(normalizedTerm)) {
            debugLog('WR_ADDED', `"${normalizedTerm}"`);
            wrTerms.push(normalizedTerm);
            if (wrTerms.length >= lim) break;
          } else {
            debugLog('WR_SKIPPED', `"${normalizedTerm}" (already exists)`);
          }
        }
      }
      debugLog('WR_ALL_EXTRACTED', allExtractedFromWr);
      debugLog('WR_FINAL', wrTerms);
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
        const allJishoExtracted = [];
        if (data && Array.isArray(data.data)) {
          for (const entry of data.data) {
            if (entry && Array.isArray(entry.japanese)) {
              for (const jp of entry.japanese) {
                const term = (jp.word || jp.reading || '').trim();
                if (term) {
                  allJishoExtracted.push(term);
                  // Avoid duplicates with wrTerms
                  if (!jishoTerms.includes(term) && !wrTerms.includes(term)) {
                    debugLog('JISHO_ADDED', `"${term}"`);
                    jishoTerms.push(term);
                    if (jishoTerms.length >= lim - wrTerms.length) break;
                  } else if (wrTerms.includes(term)) {
                    debugLog('JISHO_SKIPPED', `"${term}" (already in WR)`);
                  } else {
                    debugLog('JISHO_SKIPPED', `"${term}" (duplicate in JISHO)`);
                  }
                }
              }
            }
            if (jishoTerms.length >= lim - wrTerms.length) break;
          }
        }
        debugLog('JISHO_ALL_EXTRACTED', allJishoExtracted);
        debugLog('JISHO_FINAL', jishoTerms);
        if (jishoTerms.length > 0) {
          sourcesUsed.push('jisho');
        }
      } catch (e) {
        console.warn('jp-translate: jisho failed', e);
      }
    }

    // --- Extract all WordReference terms (including those after "それ以外の訳語")
    debugLog('PROCESS_WR_TERMS', wrTerms);
    const otherTransIdx = wrTerms.findIndex(t => /^それ以外の訳語$/.test(t));
    let allWrTerms = [];
    debugLog('otherTransIdx', otherTransIdx);
    
    if (otherTransIdx !== -1) {
      // Exclude "それ以外の訳語" label itself, keep everything else
      allWrTerms = [
        ...wrTerms.slice(0, otherTransIdx),
        ...wrTerms.slice(otherTransIdx + 1)
      ];
    } else {
      allWrTerms = wrTerms;
    }

    // --- Detect common terms between Jisho and WordReference (using raw terms)
    const jishoSet = new Set(jishoTerms);
    const allWrSet = new Set(allWrTerms);
    
    // Common terms: appear in both sources (highest priority)
    const commonTerms = jishoTerms.filter(term => allWrSet.has(term));
    const commonSet = new Set(commonTerms);
    
    // Jisho-only terms: in Jisho but not in WordReference
    const jishoOnlyTerms = jishoTerms.filter(term => !allWrSet.has(term));
    
    // WordReference-only terms: in WordReference but not in Jisho, excluding common
    const wrOnlyTerms = allWrTerms.filter(term => !jishoSet.has(term));
    
    debugLog('COMMON_TERMS', commonTerms);
    debugLog('JISHO_ONLY_TERMS', jishoOnlyTerms);
    debugLog('WR_ONLY_TERMS', wrOnlyTerms);
    
    // --- Format WordReference-only terms with "それ以外の訳語" pattern if needed
    let formattedWrOnlyTerms = [];
    if (otherTransIdx !== -1) {
      // Split into main terms and "other" terms
      const mainTerms = wrTerms.slice(0, otherTransIdx).filter(t => !commonSet.has(t));
      const otherTerms = wrTerms.slice(otherTransIdx + 1).filter(t => !commonSet.has(t));
      
      debugLog('WR_MAIN_TERMS_FILTERED', mainTerms);
      debugLog('WR_OTHER_TERMS_FILTERED', otherTerms);
      
      formattedWrOnlyTerms = [...mainTerms];
      if (otherTerms.length > 0) {
        formattedWrOnlyTerms.push(`それ以外の訳語（${otherTerms.join('、')}）`);
      }
    } else {
      formattedWrOnlyTerms = wrOnlyTerms;
    }

    debugLog('FORMATTED_WR_ONLY_TERMS', formattedWrOnlyTerms);

    // --- Combine: Common (highest priority) → Jisho-only → WordReference-only
    const combined = [...commonTerms, ...jishoOnlyTerms, ...formattedWrOnlyTerms];
    debugLog('COMBINED', combined);
    debugLog('sourcesUsed', sourcesUsed);
    
    const out = combined.slice(0, lim);
    debugLog('FINAL_RESULT', out);

    res.status(200).json({ ok: true, result: out, sourcesUsed });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}