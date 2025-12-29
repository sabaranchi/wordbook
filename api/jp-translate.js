// Server-side JP translation proxy to avoid CORS
// Tries Jisho (JMdict), then Wiktextract (Wiktionary)

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

    // --- helper: fetch JSON with timeout
    const fetchJson = async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000); // 増加: 6s → 12s
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`http_${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    };

    // --- Jisho (JMdict)
    try {
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
    } catch (e) {
      console.warn('jp-translate: jisho failed', e);
    }

    // --- Wiktextract (Wiktionary) fallback
    if (uniq.size < lim) {
      try {
        const tagSet = new Set(['idiom', 'phrasal verb', 'slang', 'colloquial']);
        const wiktUrl = `https://api.wiktextract.com/en/word/${encodeURIComponent(word)}`;
        const data = await fetchJson(wiktUrl);
        if (Array.isArray(data)) {
          for (const entry of data) {
            const senses = Array.isArray(entry.senses) ? entry.senses : [];
            for (const s of senses) {
              if (Array.isArray(s.translations)) {
                for (const t of s.translations) {
                  const isJa = (t.lang_code && t.lang_code.toLowerCase() === 'ja') || (t.lang && /japanese/i.test(t.lang));
                  if (isJa) {
                    const term = (t.word || t.text || '').trim();
                    if (term) uniq.add(term);
                    if (uniq.size >= lim) break;
                  }
                }
              }
              if (uniq.size >= lim) break;

              if (Array.isArray(s.glosses) && Array.isArray(s.tags)) {
                const hasTag = s.tags.some(tag => tagSet.has(String(tag).toLowerCase()));
                if (hasTag) {
                  for (const g of s.glosses) {
                    const term = String(g || '').trim();
                    if (term) uniq.add(term);
                    if (uniq.size >= lim) break;
                  }
                }
              }
              if (uniq.size >= lim) break;
            }
            if (uniq.size >= lim) break;
          }
        }
      } catch (e) {
        console.warn('jp-translate: wiktionary failed', e);
      }
    }

    const out = Array.from(uniq).slice(0, lim);
    res.status(200).json({ ok: true, result: out });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}