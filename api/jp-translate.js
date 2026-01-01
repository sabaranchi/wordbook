// Server-side JP translation proxy to avoid CORS
// Tries Weblio, WordReference, and Jisho
// Returns translations sorted by frequency (deduped), then by source priority (WR > Weblio > Jisho)

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

    // --- helper: decode HTML entities and remove tags for Weblio scraping
    const decodeHtmlEntities = (input = '') => {
      const numericDecoded = input.replace(/&#(x?[0-9a-fA-F]+);/g, (_, num) => {
        const val = num.startsWith('x') || num.startsWith('X') ? parseInt(num.slice(1), 16) : parseInt(num, 10);
        if (Number.isNaN(val)) return '';
        return String.fromCodePoint(val);
      });
      return numericDecoded
        .replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\u00a0/g, ' ');
    };

    const stripTagsAndDecode = (html) => {
      const withoutTags = (html || '').replace(/<[^>]*>/g, ' ');
      const decoded = decodeHtmlEntities(withoutTags);
      return decoded.replace(/\s+/g, ' ').trim();
    };

    // --- Weblio PRIMARY: scrape English-Japanese translation blocks
    try {
      const weblioUrl = `https://ejje.weblio.jp/content/${encodeURIComponent(word)}`;
      const html = await fetchText(weblioUrl);

      // Flexible capture for spans/divs/tds with class containing "content-explanation ej"
      const weblioPattern = /<(?:span|div|td)[^>]*class\s*=\s*["'][^"']*content-explanation\s+ej[^"']*["'][^>]*>([\s\S]*?)<\/\s*(?:span|div|td)\s*>/gi;
      const wlSet = new Set();
      let match;
      while ((match = weblioPattern.exec(html)) && wlSet.size < lim) {
        const inner = match[1] || '';
        const textBlock = stripTagsAndDecode(inner);
        if (!textBlock) continue;

        // Split on common separators to capture multiple translations in one block
        const candidates = textBlock.split(/[、；;，]/);
        for (const raw of candidates) {
          let term = decodeHtmlEntities(raw || '').replace(/\s+/g, ' ').trim();
          term = term.replace(/^[・•●◆▶▷◼■□\-–—·•\s]+/, '').replace(/[・•●◆▶▷◼■□\-–—·•\s]+$/, '');
          if (!term) continue;
          term = term.replace(/\s+/g, '');
          if (!term) continue;
          if (!(/[\u3040-\u30FF\u4E00-\u9FFF]/.test(term))) continue;
          if (term.length > 50) continue;
          wlSet.add(term);
          if (wlSet.size >= lim) break;
        }
      }

      weblioResults.push(...Array.from(wlSet).slice(0, lim));
      console.log(`[jp-translate] weblio found: ${weblioResults.length} results for "${word}"`);
    } catch (e) {
      console.warn('jp-translate: weblio failed', e);
    }

    // --- WordReference (always fetch to consider both sources)
    {
      try {
        const wrUrl = `https://www.wordreference.com/enja/${encodeURIComponent(word)}`;
        const html = await fetchText(wrUrl);
        
        // Split HTML to extract only the "main translations" section, before "Additional Translations"
        // "それ以外の訳語" marks the start of additional translations we want to skip
        const mainSectionMatch = html.split(/それ以外の訳語|Additional Translations/i);
        const mainHtml = mainSectionMatch[0] || html;
        
        // Extract Japanese translations from WordReference HTML
        // Target <td class="ToWrd"> elements and capture content before first tag (br/em/span)
        const toWrdPattern = /<td[^>]*class=["'][^"']*ToWrd[^"']*["'][^>]*>([\s\S]*?)(?:<(?:br|em|span)|<\/td>)/gi;
        const matches = [...mainHtml.matchAll(toWrdPattern)];
        
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
        
        const baseSet = new Set(weblioResults);
        const wrSet = new Set();
        // Collect up to lim total, considering both sources
        const remaining = Math.max(lim - weblioResults.length, Math.ceil(lim / 2));
        for (const match of matches) {
          if (wrSet.size >= remaining) break;
          // match[1] contains the text content before the first tag
          const rawText = (match[1] || '').trim();
          if (!rawText) continue;
          
          // Split by common Japanese separators to get individual terms
          // e.g., "LOL、(笑)、笑、w" → ["LOL", "(笑)", "笑", "w"]
          const candidates = rawText.split(/[、，]/);
          
          for (let term of candidates) {
            term = term.trim();
            if (!term) continue;
            
            // Filter out unwanted text
            if (excludePatterns.some(pat => pat.test(term))) {
              continue;
            }
            
            // Remove parentheses if present (e.g., "(笑)" → "笑")
            term = term.replace(/^[\(（]*(.*?)[\)）]*$/, '$1').trim();
            
            // Normalize: remove leading/trailing spaces and compress internal spaces
            term = term.replace(/\s+/g, '');
            if (!term) continue;
            
            // Additional length check: skip overly long terms (likely descriptions)
            if (term.length > 50) {
              continue;
            }
            
            // Filter by Japanese characters presence and avoid duplicates with Weblio
            if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(term) && !baseSet.has(term)) {
              wrSet.add(term);
              baseSet.add(term);
              if (wrSet.size >= remaining) break;
            }
          }
          if (wrSet.size >= remaining) break;
        }
        wrResults.push(...Array.from(wrSet));
        console.log(`[jp-translate] wordreference found: ${wrResults.length} results for "${word}"`);
      } catch (e) {
        console.warn('jp-translate: wordreference failed', e);
      }
    }

    // --- Jisho (always fetch)
    try {
      const jishoUrl = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;
      const data = await fetchJson(jishoUrl);
      if (data && Array.isArray(data.data)) {
        const jSet = new Set();
        for (const entry of data.data) {
          if (entry && Array.isArray(entry.japanese)) {
            for (const jp of entry.japanese) {
              const term = (jp.word || jp.reading || '').trim();
              if (term && /[\u3040-\u30FF\u4E00-\u9FFF]/.test(term) && term.length <= 50) {
                jSet.add(term);
                if (jSet.size >= lim * 2) break; // collect extra for later filtering
              }
            }
            if (jSet.size >= lim * 2) break;
          }
        }
        jishoResults.push(...Array.from(jSet).slice(0, lim * 2));
        console.log(`[jp-translate] jisho found: ${jishoResults.length} results for "${word}"`);
      }
    } catch (e) {
      console.warn('jp-translate: jisho failed', e);
    }

    // Determine sourcesUsed (all three sources consulted for best translations)
    const sourcesUsed = [];
    if (weblioResults.length > 0) sourcesUsed.push('weblio');
    if (wrResults.length > 0) sourcesUsed.push('wordreference');
    if (jishoResults.length > 0) sourcesUsed.push('jisho');

    // --- Merge and sort by frequency (dedup), then by source priority
    // Create map: term -> { count, sources: [WR, Weblio, Jisho] priority }
    const termFreq = new Map();
    const sourcePriority = { wordreference: 3, weblio: 2, jisho: 1 };

    // Add results from all sources
    weblioResults.forEach(term => {
      if (!termFreq.has(term)) termFreq.set(term, { count: 0, maxPriority: 0 });
      const entry = termFreq.get(term);
      entry.count += 1;
      entry.maxPriority = Math.max(entry.maxPriority, sourcePriority.weblio);
    });

    wrResults.forEach(term => {
      if (!termFreq.has(term)) termFreq.set(term, { count: 0, maxPriority: 0 });
      const entry = termFreq.get(term);
      entry.count += 1;
      entry.maxPriority = Math.max(entry.maxPriority, sourcePriority.wordreference);
    });

    jishoResults.forEach(term => {
      if (!termFreq.has(term)) termFreq.set(term, { count: 0, maxPriority: 0 });
      const entry = termFreq.get(term);
      entry.count += 1;
      entry.maxPriority = Math.max(entry.maxPriority, sourcePriority.jisho);
    });

    // Sort by frequency (descending), then by source priority (descending)
    const sortedTerms = Array.from(termFreq.entries())
      .sort((a, b) => {
        const [termA, dataA] = a;
        const [termB, dataB] = b;
        // First: sort by frequency (count) descending
        if (dataB.count !== dataA.count) return dataB.count - dataA.count;
        // Second: sort by max source priority descending (WR > Weblio > Jisho)
        return dataB.maxPriority - dataA.maxPriority;
      })
      .map(([term]) => term)
      .slice(0, lim);

    res.status(200).json({
      ok: true,
      result: sortedTerms,
      sourcesUsed,
      weblioResults,
      wrResults,
      jishoResults
    });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}