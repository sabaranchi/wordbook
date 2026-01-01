// Server-side JP translation proxy to avoid CORS
// Tries Weblio first, then WordReference fallback
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

    const weblioResults = [];
    const wrResults = [];

    // --- helpers ---
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

    // --- Fetch both sources in parallel ---
    const fetchWeblio = async () => {
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

        return Array.from(wlSet).slice(0, lim);
      } catch (e) {
        console.warn('jp-translate: weblio failed', e);
        return [];
      }
    };

    const fetchWordReference = async () => {
      try {
        const wrUrl = `https://www.wordreference.com/enja/${encodeURIComponent(word)}`;
        const html = await fetchText(wrUrl);
        
        // Split HTML to extract only the "main translations" section, before "Additional Translations"
        // "それ以外の訳語" marks the start of additional translations we want to skip
        const mainSectionMatch = html.split(/それ以外の訳語|Additional Translations/i);
        const mainHtml = mainSectionMatch[0] || html;
        
        // Extract Japanese translations from WordReference HTML
        // More flexible pattern to capture Japanese text from various HTML structures
        const japanesePattern = /(?:class="(?:TarEng|TarTop|ToWrd)">|<td[^>]*>\s*(?:<[^>]*>)*)([^<]*(?:[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+)[^<]*)/g;
        const matches = mainHtml.matchAll(japanesePattern);
        
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
          if (wrSet.size >= lim) break;
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
        return Array.from(wrSet);
      } catch (e) {
        console.warn('jp-translate: wordreference failed', e);
        return [];
      }
    };

    // Execute both fetches in parallel
    const [wlResults, wrRawResults] = await Promise.all([fetchWeblio(), fetchWordReference()]);
    
    // Prioritize Weblio results
    weblioResults.push(...wlResults);
    
    // Add WordReference results, deduplicating against Weblio and respecting limit
    const baseSet = new Set(weblioResults);
    const remaining = lim - weblioResults.length;
    for (const term of wrRawResults) {
      if (wrResults.length >= remaining) break;
      if (!baseSet.has(term)) {
        wrResults.push(term);
        baseSet.add(term);
      }
    }

    // Determine sourcesUsed
    const sourcesUsed = [];
    if (weblioResults.length > 0) sourcesUsed.push('weblio');
    if (wrResults.length > 0) sourcesUsed.push('wordreference');

    res.status(200).json({
      ok: true,
      result: [...weblioResults, ...wrResults].slice(0, lim),
      sourcesUsed,
      weblioResults,
      wrResults
    });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}