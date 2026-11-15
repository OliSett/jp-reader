/* Pitch accent: lookup (Kanjium data, CC BY-SA 4.0) and a dots-and-lines graph as inline SVG,
 * so it shows on every Anki client without scripts. Shared by the extension and the connector. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.pitch = (() => {
  let map = null;
  const hira = s => String(s || '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const SMALL = new Set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ');

  let byReading = null; // reading -> accent string, or null when words read that way differ
  function load(data) {
    map = new Map(); byReading = new Map();
    for (const [w, r, a] of data.rows || []) {
      const rd = r || hira(w);
      map.set(w + '\t' + rd, String(a).split(',').map(Number));
      byReading.set(rd, byReading.has(rd) && byReading.get(rd) !== String(a) ? null : String(a));
    }
    return map.size;
  }
  const loaded = () => !!map;
  const size = () => (map ? map.size : 0);

  /** Accent numbers for a word, e.g. [0] or [1, 0]. Empty when unknown. */
  function lookup(word, reading) {
    if (!map || !word) return [];
    const w = String(word).trim(), r = hira(String(reading || '').trim() || w);
    const kanaOnly = /^[぀-ヿー]+$/.test(w);
    let hit = map.get(w + '\t' + r) || (kanaOnly && w !== hira(w) ? map.get(hira(w) + '\t' + r) : null);
    // a word written in kana (いじる for 弄る): use the reading, if every word read that way has the same accent
    if (!hit && kanaOnly && byReading.get(r)) hit = byReading.get(r).split(',').map(Number);
    return hit ? hit.slice() : [];
  }

  /** Split kana into morae: small ゃゅょ etc. join the previous kana; っ, ん and ー count on their own. */
  function morae(kana) {
    const out = [];
    for (const c of String(kana || '')) {
      if (SMALL.has(c) && out.length) out[out.length - 1] += c;
      else out.push(c);
    }
    return out;
  }

  /** High (true) / low (false) for each mora plus the following particle. */
  function pattern(n, a) {
    a = Math.max(0, Math.min(a, n));
    const hl = [];
    for (let i = 1; i <= n + 1; i++) {
      if (a === 0) hl.push(i !== 1);
      else if (a === 1) hl.push(i === 1);
      else hl.push(i !== 1 && i <= a);
    }
    if (n === 1 && a === 0) hl[0] = false; // e.g. 木が: low then high particle
    return hl;
  }

  function category(n, a) {
    if (a === 0) return ['heiban', '平板'];
    if (a === 1) return ['atamadaka', '頭高'];
    if (a >= n) return ['odaka', '尾高'];
    return ['nakadaka', '中高'];
  }
  const COLOR = { heiban: '#3d7be0', atamadaka: '#e0443d', nakadaka: '#e38a1c', odaka: '#2f9e57' };

  /** One graph: filled dots for the word's morae, a hollow dot for the particle, lines between them, kana below. */
  function svg(reading, a) {
    const m = morae(hira(reading));
    const n = m.length;
    if (!n) return '';
    const hl = pattern(n, a);
    const [cat, label] = category(n, a);
    const col = COLOR[cat];
    const step = 24, x0 = 14, yH = 10, yL = 30;
    const pts = hl.map((h, i) => [x0 + i * step, h ? yH : yL]);
    const W = x0 * 2 + n * step, H = 54;
    const lines = pts.slice(1).map((p, i) => `<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${p[0]}" y2="${p[1]}" stroke="${col}" stroke-width="2.2"${i === n - 1 ? ' stroke-dasharray="3 3"' : ''}/>`).join('');
    const dots = pts.map(([x, y], i) => (i < n
      ? `<circle cx="${x}" cy="${y}" r="4.6" fill="${col}"/>`
      : `<circle cx="${x}" cy="${y}" r="4.2" fill="none" stroke="${col}" stroke-width="2"/>`)).join('');
    const kana = m.map((k, i) => `<text x="${x0 + i * step}" y="49" text-anchor="middle" font-size="${k.length > 1 ? 11 : 13}" fill="currentColor">${k}</text>`).join('');
    return `<span class="pitch-graph pitch-${cat}" title="${label} [${a}]"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${lines}${dots}${kana}</svg><span class="pitch-label" style="color:${col}">${label} [${a}]</span></span>`;
  }

  /** HTML for a card's Pitch field ('' if the word isn't in the data). Shows up to two accents. */
  function html(word, reading) {
    const acc = lookup(word, reading);
    if (!acc.length) return '';
    const r = String(reading || '').trim() || word;
    return `<div class="pitch">${acc.slice(0, 2).map(a => svg(r, a)).join('')}</div>`;
  }

  return { load, loaded, size, lookup, morae, pattern, category, svg, html };
})();
