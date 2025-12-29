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

    // 並列取得: Jisho と Wiktionary を同時に実行
    const [jishoData, wiktData] = await Promise.allSettled([
      fetchJson(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`),
      fetchJson(`https://api.wiktextract.com/en/word/${encodeURIComponent(word)}`)
    ]);

    const uniq = new Map(); // word -> priority (低いほど優先)
    const tagSet = new Set(['idiom', 'phrasal verb', 'slang', 'colloquial']);

    // --- Jisho (JMdict) 結果を追加 (priority: 1 = 基本語義)
    if (jishoData.status === 'fulfilled' && jishoData.value && Array.isArray(jishoData.value.data)) {
      for (const entry of jishoData.value.data) {
        if (entry && Array.isArray(entry.japanese)) {
          for (const jp of entry.japanese) {
            const term = (jp.word || jp.reading || '').trim();
            if (term && !uniq.has(term)) uniq.set(term, 1);
            if (uniq.size >= lim * 2) break; // 多めに取得
          }
        }
        if (uniq.size >= lim * 2) break;
      }
    }

    // --- Wiktionary 結果を追加 (priority: 0 = スラング・口語優先, 2 = 通常)
    if (wiktData.status === 'fulfilled' && Array.isArray(wiktData.value)) {
      for (const entry of wiktData.value) {
        const senses = Array.isArray(entry.senses) ? entry.senses : [];
        for (const s of senses) {
          const isSpecial = Array.isArray(s.tags) && s.tags.some(tag => tagSet.has(String(tag).toLowerCase()));
          const priority = isSpecial ? 0 : 2; // スラング・口語は最優先

          // 日本語訳を優先
          if (Array.isArray(s.translations)) {
            for (const t of s.translations) {
              const isJa = (t.lang_code && t.lang_code.toLowerCase() === 'ja') || (t.lang && /japanese/i.test(t.lang));
              if (isJa) {
                const term = (t.word || t.text || '').trim();
                if (term) {
                  if (!uniq.has(term) || uniq.get(term) > priority) {
                    uniq.set(term, priority);
                  }
                }
                if (uniq.size >= lim * 3) break;
              }
            }
          }

          // スラング・口語タグがあれば gloss も含める
          if (isSpecial && Array.isArray(s.glosses)) {
            for (const g of s.glosses) {
              const term = String(g || '').trim();
              if (term) {
                if (!uniq.has(term) || uniq.get(term) > priority) {
                  uniq.set(term, priority);
                }
                if (uniq.size >= lim * 3) break;
              }
            }
          }

          if (uniq.size >= lim * 3) break;
        }
        if (uniq.size >= lim * 3) break;
      }
    }

    // priority でソートして上位 lim 個を返す
    const sorted = Array.from(uniq.entries()).sort((a, b) => a[1] - b[1]);
    const out = sorted.slice(0, lim).map(([term]) => term);
    res.status(200).json({ ok: true, result: out });
  } catch (err) {
    console.error('jp-translate error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}