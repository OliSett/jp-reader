/* Knowledge index (what you know, from Anki) + longest-match tokenizer with deinflection. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.ST = { UNKNOWN: 0, NEW: 1, LEARNING: 2, KNOWN: 3, MANUAL: 4 };
JA.ST_NAMES = ['unknown', 'new', 'learning', 'known', 'known'];

JA.Knowledge = class Knowledge {
  constructor(dict) {
    this.dict = dict;
    this.entryStatus = new Map(); // dict row idx -> status
    this.termStatus = new Map();  // plain string -> status (fallback, Anki-only words)
    this.manual = new Set();      // keys the user marked as known ('j:<id>' or 't:<term>')
    this.maxLen = 1;
    this.counts = { known: 0, learning: 0, new: 0, unmatched: 0, total: 0 };
  }

  /** words: [{word, reading, status}] from Anki */
  build(words, manualKeys = []) {
    this.entryStatus.clear(); this.termStatus.clear();
    this.manual = new Set(manualKeys);
    this.maxLen = 1;
    const c = { known: 0, learning: 0, new: 0, unmatched: 0, total: words.length };
    for (const w of words) {
      if (!w.word) continue;
      const idxs = this.resolve(w.word, w.reading);
      if (idxs.length) for (const i of idxs) this._max(this.entryStatus, i, w.status);
      else c.unmatched++;
      this._max(this.termStatus, w.word, w.status);
      if (w.word.length > this.maxLen) this.maxLen = w.word.length;
      if (w.status === JA.ST.KNOWN) c.known++; else if (w.status === JA.ST.LEARNING) c.learning++; else c.new++;
    }
    this.counts = c;
  }

  _max(map, k, v) { const o = map.get(k); if (o === undefined || v > o) map.set(k, v); }

  /** Map a word (+ optional reading) to dictionary rows. */
  resolve(word, reading) {
    const d = this.dict;
    if (!d || !d.loaded) return [];
    let idxs = d.lookup(word) || [];
    if (!idxs.length) return [];
    if (reading) {
      const r = JA.kana.toHira(JA.kana.cleanField(reading));
      const f = idxs.filter(i => d.rows[i][2].some(k => JA.kana.toHira(k) === r));
      if (f.length) idxs = f;
    }
    if (JA.kana.isKanaOnly(word) && idxs.length > 1) {
      // kana word: prefer entries normally written in kana
      const f = idxs.filter(i => d.rows[i][7] || !d.rows[i][1].length);
      if (f.length) idxs = f;
    } else if (!JA.kana.isKanaOnly(word)) {
      const f = idxs.filter(i => d.rows[i][1].includes(word));
      if (f.length) idxs = f;
    }
    return idxs;
  }

  setStatus(word, reading, status) {
    for (const i of this.resolve(word, reading)) this._max(this.entryStatus, i, status);
    this._max(this.termStatus, word, status);
    if (word.length > this.maxLen) this.maxLen = word.length;
  }

  statusOf(idxs, base, surface, key) {
    if (key && this.manual.has(key)) return JA.ST.MANUAL;
    let st = -1;
    for (const i of idxs || []) { const s = this.entryStatus.get(i); if (s !== undefined && s > st) st = s; }
    if (st < 0) {
      const a = this.termStatus.get(base), b = this.termStatus.get(surface);
      st = Math.max(a === undefined ? -1 : a, b === undefined ? -1 : b);
    }
    return st < 0 ? JA.ST.UNKNOWN : st;
  }
};

JA.tokenizer = (() => {
  const SKIP_POS = new Set(['prt', 'aux', 'aux-v', 'aux-adj', 'cop', 'conj']);
  const MAX = 14;

  /** Returns tokens [{s, e, surface, base, idxs, key, status, skip}].
   *  Each run of Japanese text is split by picking the cheapest path through all dictionary
   *  matches (fewer, longer, more common words win), instead of greedy longest-match. */
  function tokenize(text, know) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (!JA.kana.isJpChar(text[i])) { i++; continue; }
      let e = i;
      while (e < n && JA.kana.isJpChar(text[e])) e++;
      tokenizeRun(text, i, e, know, out);
      i = e;
    }
    return out;
  }

  const SKIP_COST_KANA = 2.2;   // leaving a kana character unmatched
  const SKIP_COST_KANJI = 2.6;  // unknown kanji (per character)

  /** Cost of reading `s` as one of the entries in idxs; returns {cost, idxs} with impossible readings removed. */
  function matchCost(s, idxs, reasons, know) {
    const dict = know.dict;
    const kanaOnly = JA.kana.isKanaOnly(s);
    const katakana = kanaOnly && hasKatakana(s) && !/[\u3041-\u3096]/.test(s);
    let best = Infinity;
    const keep = [];
    for (const x of idxs) {
      const row = dict.rows[x];
      const hasKanji = row[1].length > 0;
      const usuallyKana = !!row[7] || !hasKanji;
      const grammar = row[5].length > 0 && row[5].every(p => SKIP_POS.has(p));
      let c = 1;
      if (grammar && kanaOnly && !katakana) { // particles etc. (の is listed with rare kanji 乃/之)
        keep.push(x);
        if (0.9 < best) best = 0.9;
        continue;
      }
      if (kanaOnly && s.length === 1) c += 1.5; // lone kana as a content word is unlikely
      if (kanaOnly && !usuallyKana) {
        // kana that only "matches" a word normally written in kanji (く→九, は→歯)
        if (s.length === 1) continue;
        if (katakana) continue; // カズ is not 数: katakana rarely spells a normal kanji word
        c += s.length === 2 ? 1.4 : 0.5;
      }
      if (!kanaOnly && row[7]) c += 0.6; // kanji spelling of a word normally written in kana (本の vs 日本+の)
      if (!row[6]) c += 0.4;
      const rank = know.rankOf ? know.rankOf(x) : null;
      c += rank ? Math.min(1, Math.log10(rank) / 6) : 0.5;
      keep.push(x);
      if (c < best) best = c;
    }
    if (!keep.length) return null;
    return { cost: best + 0.15 * reasons.length, idxs: keep };
  }

  function hasKatakana(t) {
    for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c >= 0x30a1 && c <= 0x30f6) return true; }
    return false;
  }

  // small caches: pages repeat the same substrings a lot
  const deinflectCache = new Map();
  function deinflectCached(s) {
    let r = deinflectCache.get(s);
    if (!r) {
      if (deinflectCache.size > 60000) deinflectCache.clear();
      r = JA.deinflect.deinflect(s);
      // drop duplicates of the same term (keep every type, they filter differently)
      deinflectCache.set(s, r);
    }
    return r;
  }

  function candidatesAt(text, p, end, know) {
    const dict = know.dict;
    const loaded = dict && dict.loaded;
    const res = [];
    for (let L = Math.min(MAX, end - p); L >= 1; L--) {
      const s = text.substr(p, L);
      const cands = JA.kana.isKana(s[s.length - 1]) ? deinflectCached(s) : [{ term: s, type: JA.deinflect.T.ALL, reasons: [] }];
      let bestL = null;
      const alsoIdxs = []; // other valid readings of the same text, so 知らない counts as known when you know 知る
      for (const c of cands) {
        let idxs = loaded ? dict.index.get(c.term) || (hasKatakana(c.term) ? dict.lookup(c.term) : null) : null;
        if (!idxs && !know.termStatus.has(c.term)) continue;
        if (idxs && c.type !== JA.deinflect.T.ALL) idxs = idxs.filter(x => JA.deinflect.posFits(c.type, dict.rows[x][4]));
        if (idxs && idxs.length) {
          const m = matchCost(s, idxs, c.reasons, know);
          // an exact dictionary word beats a conjugated reading of the same text (怖がる, not 怖い+がる)
          const better = !bestL || c.reasons.length < bestL.reasons.length || (c.reasons.length === bestL.reasons.length && m.cost < bestL.cost);
          if (m && better) bestL = { L, idxs: m.idxs, base: c.term, reasons: c.reasons, cost: m.cost };
          if (m) alsoIdxs.push(...m.idxs);
        } else if (know.termStatus.has(c.term) && JA.deinflect.posFits(c.type, null)) {
          const cost = 1 + 0.05 * c.reasons.length;
          if (!bestL || cost < bestL.cost) bestL = { L, idxs: [], base: c.term, reasons: c.reasons, cost };
        }
      }
      if (bestL) { bestL.statusIdxs = alsoIdxs; res.push(bestL); }
    }
    return res;
  }

  function tokenizeRun(text, start, end, know, out) {
    const len = end - start;
    const dp = new Array(len + 1).fill(Infinity);
    const back = new Array(len + 1).fill(null);
    dp[0] = 0;
    for (let q = 0; q < len; q++) {
      if (dp[q] === Infinity) continue;
      const p = start + q;
      for (const m of candidatesAt(text, p, end, know)) {
        const v = dp[q] + m.cost;
        if (v < dp[q + m.L]) { dp[q + m.L] = v; back[q + m.L] = { from: q, m }; }
      }
      if (JA.kana.isKanji(text[p])) {
        // unknown kanji run (up to 4) as one unparsed word
        let k = q;
        while (k < len && k - q < 4 && JA.kana.isKanji(text[start + k])) {
          k++;
          const v = dp[q] + SKIP_COST_KANJI * (k - q);
          if (v < dp[k]) { dp[k] = v; back[k] = { from: q, unparsed: true }; }
        }
      } else {
        const v = dp[q] + SKIP_COST_KANA;
        if (v < dp[q + 1]) { dp[q + 1] = v; back[q + 1] = { from: q, skip: true }; }
      }
    }
    const toks = [];
    for (let q = len; q > 0;) {
      const b = back[q];
      if (!b) { q--; continue; }
      const s = start + b.from, e = start + q;
      if (b.m) toks.push(makeToken(text, s, e, b.m, know));
      else if (b.unparsed) {
        const surf = text.slice(s, e);
        const key = 't:' + surf;
        toks.push({ s, e, surface: surf, base: surf, idxs: [], primary: null, key, status: know.statusOf([], surf, surf, key), skip: false, unparsed: true });
      }
      q = b.from;
    }
    for (let k = toks.length - 1; k >= 0; k--) out.push(toks[k]);
  }

  function makeToken(text, s, e, best, know) {
    const dict = know.dict;
    const surface = text.slice(s, e);
    let primary = null;
    if (best.idxs.length) {
      // prefer an entry you know, then a common one, then a kanji match
      const kanaSurface = JA.kana.isKanaOnly(text.slice(s, e));
      const scored = best.idxs.map(i => {
        const r = dict.rows[i];
        const rank = know.rankOf ? know.rankOf(i) : null;
        return {
          i,
          sc: (know.entryStatus.get(i) || 0) * 10 + (r[6] ? 3 : 0) + (r[1].includes(best.base) ? 2 : 0)
            + (kanaSurface && (r[7] || !r[1].length) ? 4 : 0) + (rank ? 3 - Math.min(3, Math.log10(rank) / 2) : 0),
        };
      });
      scored.sort((a, b) => b.sc - a.sc);
      primary = scored[0].i;
    }
    const key = primary !== null ? 'j:' + dict.rows[primary][0] : 't:' + best.base;
    let skip = false;
    if (primary !== null) {
      const fp = dict.rows[primary][5];
      skip = fp.length > 0 && fp.every(p => SKIP_POS.has(p)) && JA.kana.isKanaOnly(surface);
    }
    return {
      s, e, surface, base: best.base, idxs: best.idxs, primary, key,
      status: Math.max(know.statusOf(best.idxs, best.base, surface, key), best.statusIdxs && best.statusIdxs.length ? know.statusOf(best.statusIdxs, best.base, surface, null) : 0), skip, reasons: best.reasons,
    };
  }

  /** Display info for a token's word (dictionary form, reading, meaning). */
  function wordInfo(tok, know) {
    const dict = know.dict;
    if (tok.primary === null || tok.primary === undefined) return { word: tok.base, reading: '', meaning: '', kanji: '' };
    const r = dict.rows[tok.primary];
    const word = tok.base;
    if (JA.kana.isKanaOnly(word)) {
      // written in kana on the page: keep it in kana, mention the usual kanji spelling only as a hint
      const kanji = r[1].length && !r[7] ? r[1].slice(0, 2).join('・') : '';
      return { word, reading: '', meaning: r[3], common: !!r[6], kanji };
    }
    const reading = r[2][0] || '';
    return { word, reading: word === reading ? '' : reading, meaning: r[3], common: !!r[6], kanji: '' };
  }

  /** Split into sentences, keeping offsets. */
  function sentences(text) {
    const out = [];
    const re = /[^。！？!?\n]+[。！？!?」』]*/g;
    let m;
    while ((m = re.exec(text))) if (m[0].trim()) out.push({ s: m.index, e: m.index + m[0].length, text: m[0].trim() });
    return out;
  }

  return { tokenize, wordInfo, sentences };
})();

if (typeof module !== 'undefined') module.exports = JA;
