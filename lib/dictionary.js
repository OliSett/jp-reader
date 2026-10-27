/* JMdict dictionary: import (jmdict-simplified JSON), compact storage in IndexedDB, lookup. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.dict = (() => {
  // ---------- IndexedDB key/value ----------
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('jp-reader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbSet(key, val) {
    const d = await db();
    await new Promise((res, rej) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    d.close();
  }
  async function idbGet(key) {
    const d = await db();
    const v = await new Promise((res, rej) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    d.close();
    return v;
  }

  // ---------- Import ----------
  /** jmdict-simplified -> compact rows [id, kanji[], kana[], gloss, pos[], firstPos[], common] */
  function compact(json) {
    if (!json || !Array.isArray(json.words)) throw new Error('This does not look like a jmdict-simplified JSON file (no "words" array).');
    const rows = [];
    for (const w of json.words) {
      const k = (w.kanji || []).map(x => x.text);
      const r = (w.kana || []).map(x => x.text);
      const senses = w.sense || [];
      const lang = s => (s.gloss || []).filter(g => !g.lang || g.lang === 'eng' || g.lang === 'en');
      const gloss = senses.slice(0, 3)
        .map(s => lang(s).slice(0, 3).map(g => g.text).join(', '))
        .filter(Boolean).join('; ');
      const pos = [...new Set(senses.flatMap(s => s.partOfSpeech || []))];
      const firstPos = (senses[0] && senses[0].partOfSpeech) || [];
      const uk = senses.length && (senses[0].misc || []).includes('uk') ? 1 : 0;
      const common = (w.kanji || []).some(x => x.common) || (w.kana || []).some(x => x.common) ? 1 : 0;
      rows.push([w.id, k, r, gloss, pos, firstPos, common, uk]);
    }
    return { version: json.version || '', date: json.dictDate || '', rows };
  }

  async function importFile(buf, filename, onProgress = () => {}) {
    onProgress('Unpacking…');
    const text = await JA.archive.readJsonText(buf, filename);
    onProgress('Reading dictionary (this can take ~20 s)…');
    const json = JSON.parse(text);
    onProgress('Compacting…');
    const c = compact(json);
    onProgress('Saving…');
    await idbSet('jmdict', c);
    return { entries: c.rows.length, version: c.version, date: c.date };
  }

  // ---------- Runtime index ----------
  class Dictionary {
    constructor() { this.rows = []; this.index = new Map(); this.maxLen = 1; this.loaded = false; this.info = null; }
    load(c) {
      this.rows = c.rows;
      this.index = new Map();
      this.maxLen = 1;
      this.byId = new Map();
      c.rows.forEach((row, i) => {
        this.byId.set(row[0], i);
        for (const t of row[1].concat(row[2])) this._add(t, i);
      });
      this.loaded = c.rows.length > 0;
      this.info = { entries: c.rows.length, version: c.version, date: c.date };
    }
    _add(t, i) {
      let a = this.index.get(t);
      if (!a) this.index.set(t, (a = []));
      if (!a.includes(i)) a.push(i);
      if (t.length > this.maxLen) this.maxLen = t.length;
    }
    lookup(term) {
      const hit = this.index.get(term);
      if (hit) return hit;
      // katakana spelling of a word usually written in hiragana
      for (let i = 0; i < term.length; i++) {
        const c = term.charCodeAt(i);
        if (c >= 0x30a1 && c <= 0x30f6) return this.index.get(JA.kana.toHira(term)) || null;
      }
      return null;
    }
    entry(i) {
      const r = this.rows[i];
      return r && { idx: i, id: r[0], kanji: r[1], kana: r[2], gloss: r[3], pos: r[4], firstPos: r[5], common: !!r[6], uk: !!r[7] };
    }
  }

  return { compact, importFile, idbGet, idbSet, Dictionary };
})();

if (typeof module !== 'undefined') module.exports = JA;
