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

    // --- helper: fetch JSON with timeout (<= function maxDuration)
    const fetchJson = async (url, init = {}, timeoutMs = 8000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
        if (!r.ok) throw new Error(`http_${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    };

    // --- helper: translate EN -> JA via provider chain (DeepL -> Google -> LibreTranslate)
    const translateTexts = async (texts) => {
      const arr = Array.isArray(texts) ? texts.filter(Boolean) : [];
      if (arr.length === 0) return [];

      // DeepL
      try {
        const key = process.env.DEEPL_API_KEY;
        if (key) {
          const params = new URLSearchParams();
          for (const q of arr) params.append('text', q);
          params.append('target_lang', 'JA');
          const r = await fetchJson('https://api-free.deepl.com/v2/translate', {
            method: 'POST',
            headers: { 'Authorization': `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
          }, 7000);
          const out = Array.isArray(r.translations) ? r.translations.map(t => t.text) : [];
          if (out.length) return out;
        }
      } catch (e) { console.warn('deepl translate failed', e); }

      // Google Translate API v2
      try {
        const gkey = process.env.GOOGLE_TRANSLATE_API_KEY;
        if (gkey) {
          const body = { q: arr, source: 'en', target: 'ja', format: 'text' };
          const r = await fetchJson(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(gkey)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          }, 7000);
          const out = r && r.data && Array.isArray(r.data.translations) ? r.data.translations.map(t => t.translatedText) : [];
          if (out.length) return out;
        }
      } catch (e) { console.warn('google translate failed', e); }

      // LibreTranslate (public instance or self-hosted)
      try {
        const base = process.env.LIBRE_TRANSLATE_URL || 'https://libretranslate.de/translate';
        const out = [];
        for (const q of arr) {
          const r = await fetchJson(base, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q, source: 'en', target: 'ja', format: 'text' })
          }, 7000);
          if (r && r.translatedText) out.push(r.translatedText);
        }
        if (out.length) return out;
      } catch (e) { console.warn('libre translate failed', e); }

      return [];
    };

    // --- Jisho (JMdict) primary
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

    // --- Urban Dictionary + machine translation (better for slang/colloquial)
    if (uniq.size < lim) {
      try {
        const urbanUrl = `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(word)}`;
        const data = await fetchJson(urbanUrl);
        if (data && Array.isArray(data.list)) {
          // sort by thumbs_up desc for quality
          const sorted = data.list.slice().sort((a,b) => (b.thumbs_up||0) - (a.thumbs_up||0));
          const defs = [];
          for (const it of sorted) {
            let d = String(it.definition || '').replace(/\[|\]/g, '');
            d = d.replace(/\r?\n/g, ' ').trim();
            if (d) defs.push(d);
            if (defs.length >= lim) break;
          }
          if (defs.length) {
            const ja = await translateTexts(defs);
            for (const t of ja) {
              const term = String(t || '').trim();
              if (term) uniq.add(term);
              if (uniq.size >= lim) break;
            }
          }
        }
      } catch (e) {
        console.warn('jp-translate: urban+translate failed', e);
      }
    }

    // --- Wiktextract (Wiktionary) tertiary fallback for idioms/phrasals
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