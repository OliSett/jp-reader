/* Coverage estimates and recommendations from Jiten vocabulary samples. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.recommend = (() => {
  const SKIP_POS = new Set(['prt', 'aux', 'aux-v', 'aux-adj', 'cop', 'conj']);

  function wordState(w, know) {
    const idxs = know.resolve(w.spelling, w.reading);
    const d = know.dict;
    const primary = idxs.length ? idxs[0] : null;
    const key = primary !== null ? 'j:' + d.rows[primary][0] : 't:' + w.spelling;
    if (primary !== null) {
      const fp = d.rows[primary][5];
      if (fp.length && fp.every(p => SKIP_POS.has(p))) return null; // particles etc.
    }
    const status = know.statusOf(idxs, w.spelling, w.spelling, key);
    const meaning = w.meaning || (primary !== null ? d.rows[primary][3] : '');
    const reading = w.reading || (primary !== null ? d.rows[primary][2][0] : '');
    return { key, status, meaning, reading };
  }

  const isKnown = (st, countLearning) => st >= JA.ST.KNOWN || (countLearning && st === JA.ST.LEARNING);

  /** scanned: [{deck, words}] ; opts: {low, high, countLearning} */
  function analyze(scanned, know, opts) {
    const { low = 88, high = 95, countLearning = true } = opts || {};
    const titles = [];
    for (const { deck, words } of scanned) {
      if (!words || !words.length) continue;
      const hasOcc = words.some(w => w.occ !== undefined);
      let total = 0, known = 0;
      const unknown = [];
      for (const w of words) {
        const s = wordState(w, know);
        if (!s) continue;
        const wt = hasOcc ? (w.occ || 0) : 1;
        total += wt;
        if (isKnown(s.status, countLearning)) known += wt;
        else unknown.push({ word: w.spelling, reading: s.reading, meaning: s.meaning, key: s.key, weight: wt, status: s.status });
      }
      if (!total) continue;
      unknown.sort((a, b) => b.weight - a.weight);
      const coverage = (known / total) * 100;
      titles.push({ deck, coverage, total, weighted: hasOcc, sample: words.length, unknownCount: unknown.length, unknown, band: band(coverage, low, high) });
    }

    // Gap words: unknown words that add the most coverage across titles that are within reach.
    const reach = titles.filter(t => t.coverage >= low - 12 && t.coverage < high + 2);
    const gaps = new Map();
    for (const t of reach) {
      for (const u of t.unknown) {
        let g = gaps.get(u.key);
        if (!g) gaps.set(u.key, (g = { ...u, gain: 0, titles: [] }));
        g.gain += (u.weight / t.total) * 100;
        g.titles.push(t.deck.title);
      }
    }
    const gapList = [...gaps.values()].sort((a, b) => b.gain - a.gain).slice(0, 150);

    // What learning the top 50 gap words would unlock
    const top = new Set(gapList.slice(0, 50).map(g => g.key));
    let unlocked = 0;
    for (const t of titles) {
      if (t.coverage >= low) continue;
      const add = t.unknown.filter(u => top.has(u.key)).reduce((s, u) => s + u.weight, 0);
      if (t.coverage + (add / t.total) * 100 >= low) unlocked++;
    }

    const mid = (low + high) / 2;
    const recommended = titles.filter(t => t.band === 'sweet').sort((a, b) => Math.abs(a.coverage - mid) - Math.abs(b.coverage - mid));
    return { titles, recommended, gapList, unlocked };
  }

  function band(c, low, high) {
    if (c >= high) return 'easy';
    if (c >= low) return 'sweet';
    if (c >= low - 8) return 'stretch';
    return 'hard';
  }

  return { analyze, wordState };
})();

if (typeof module !== 'undefined') module.exports = JA;
