/* Frequency dictionaries: Yomitan frequency .zip (JPDB, Jiten, BCCWJ, Innocent corpus…) or CSV/TSV.
 * Stored as rows [term, reading, rank] sorted by rank (1 = most common). */
var JA = globalThis.JA || (globalThis.JA = {});

JA.freq = (() => {
  function valueOf(d) {
    if (typeof d === 'number') return d;
    if (typeof d === 'string') { const n = parseFloat(d.replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; }
    if (d && typeof d === 'object') {
      if ('frequency' in d) return valueOf(d.frequency);
      if ('value' in d) return valueOf(d.value);
      if ('displayValue' in d) return valueOf(d.displayValue);
    }
    return null;
  }

  /** Yomitan: index.json + term_meta_bank_*.json with [term, "freq", data] rows. */
  async function parseYomitanZip(buf) {
    const files = await JA.archive.unzip(buf, n => /(^|\/)(index|term_meta_bank_\d+)\.json$/i.test(n));
    const dec = new TextDecoder();
    const indexFile = files.find(f => /index\.json$/i.test(f.name));
    const index = indexFile ? JSON.parse(dec.decode(indexFile.data)) : {};
    const raw = [];
    for (const f of files) {
      if (!/term_meta_bank/i.test(f.name)) continue;
      for (const row of JSON.parse(dec.decode(f.data))) {
        if (!Array.isArray(row) || row[1] !== 'freq') continue;
        const d = row[2];
        const reading = d && typeof d === 'object' && typeof d.reading === 'string' ? d.reading : '';
        const v = valueOf(d);
        if (v !== null) raw.push([row[0], reading, v]);
      }
    }
    if (!raw.length) throw new Error('No frequency entries found. Is this a Yomitan *frequency* dictionary?');
    return { name: index.title || 'Frequency list', rows: toRanks(raw, index.frequencyMode === 'occurrence-based') };
  }

  /** CSV/TSV: first Japanese column is the word, an optional second kana column the reading.
   *  If a header names a rank/frequency column it is used, otherwise line order is the rank. */
  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const sep = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ',';
    const split = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    let head = split(lines[0]);
    const isHeader = !head.some(c => JA.kana.hasJapanese(c));
    let rankCol = -1, occ = false;
    if (isHeader) {
      rankCol = head.findIndex(c => /rank/i.test(c));
      if (rankCol < 0) { rankCol = head.findIndex(c => /freq|occurr|count/i.test(c)); occ = rankCol >= 0 && !/rank/i.test(head[rankCol]); }
    }
    const raw = [];
    lines.slice(isHeader ? 1 : 0).forEach((l, i) => {
      const cells = split(l);
      const ti = cells.findIndex(c => JA.kana.hasJapanese(c));
      if (ti < 0) return;
      const next = cells[ti + 1] || '';
      const reading = /^[぀-ヿー]+$/.test(next) ? next : '';
      const v = rankCol >= 0 ? parseFloat(cells[rankCol]) : i + 1;
      raw.push([cells[ti], reading, isNaN(v) ? i + 1 : v]);
    });
    if (!raw.length) throw new Error('No Japanese words found in this file.');
    return { name: 'Frequency list (CSV)', rows: toRanks(raw, occ) };
  }

  function toRanks(raw, occurrenceBased) {
    raw.sort((a, b) => (occurrenceBased ? b[2] - a[2] : a[2] - b[2]));
    if (occurrenceBased) return raw.map((r, i) => [r[0], r[1], i + 1]);
    return raw.map(r => [r[0], r[1], Math.round(r[2])]);
  }

  async function parseFile(buf, filename = '') {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x50 && u8[1] === 0x4b) return parseYomitanZip(u8);
    let text = new TextDecoder().decode(u8);
    if (u8[0] === 0x1f && u8[1] === 0x8b) text = new TextDecoder().decode(await JA.archive.inflate(u8, 'gzip'));
    const t = text.trim();
    if (t.startsWith('[')) { // a bare term_meta_bank json
      const raw = JSON.parse(t).filter(r => Array.isArray(r) && r[1] === 'freq').map(r => [r[0], (r[2] && r[2].reading) || '', valueOf(r[2])]).filter(r => r[2] !== null);
      return { name: filename || 'Frequency list', rows: toRanks(raw, false) };
    }
    return parseCsv(text);
  }

  class Frequency {
    constructor() { this.rows = []; this.byTR = new Map(); this.byT = new Map(); this.name = ''; this.loaded = false; this.entryCache = new Map(); }
    load(data) {
      this.rows = data.rows; this.name = data.name;
      this.byTR = new Map(); this.byT = new Map(); this.entryCache = new Map();
      for (const [t, r, rank] of data.rows) {
        if (r) { const k = t + '|' + JA.kana.toHira(r); if (!this.byTR.has(k)) this.byTR.set(k, rank); }
        if (!this.byT.has(t)) this.byT.set(t, rank);
      }
      this.loaded = data.rows.length > 0;
    }
    /** Rank of a dictionary entry (min over its spellings), or null. */
    rankOfEntry(dict, idx) {
      if (!this.loaded || idx === null || idx === undefined) return null;
      if (this.entryCache.has(idx)) return this.entryCache.get(idx);
      const row = dict.rows[idx];
      const readings = row[2].map(JA.kana.toHira);
      let best = null;
      const take = v => { if (v !== undefined && (best === null || v < best)) best = v; };
      for (const k of row[1]) for (const r of readings) take(this.byTR.get(k + '|' + r));
      if (best === null) for (const k of row[1]) take(this.byT.get(k));
      if (best === null && (row[7] || !row[1].length)) for (const r of row[2]) { take(this.byTR.get(r + '|' + JA.kana.toHira(r))); take(this.byT.get(r)); }
      this.entryCache.set(idx, best);
      return best;
    }
    rankOfTerm(term) { return this.loaded ? (this.byT.get(term) ?? null) : null; }
  }

  return { parseFile, parseCsv, parseYomitanZip, Frequency, _valueOf: valueOf };
})();

if (typeof module !== 'undefined') module.exports = JA;
