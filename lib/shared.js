/* State shared between the Firefox extension and the Claude connector.
 * Stored as a JSON file in Anki's media folder (the leading underscore tells Anki to keep it),
 * read/written through AnkiConnect, so it also syncs with AnkiWeb. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.shared = (() => {
  const FILE = '_jp_reader_shared.json';
  const MAX_KEYS = 15000;
  const SETTINGS_KEYS = ['decks', 'wordFields', 'readingFields', 'matureDays', 'suspended', 'countLearning', 'targetDeck', 'noteType', 'fieldMap', 'tags'];

  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  const empty = () => ({ version: 1, updatedAt: 0, settings: null, settingsAt: 0, manualKnown: [], sentenceBank: {} });

  async function read() {
    let b64;
    try { b64 = await JA.anki.call('retrieveMediaFile', { filename: FILE }); } catch { return empty(); }
    if (!b64) return empty();
    try { return { ...empty(), ...JSON.parse(fromB64(b64)) }; } catch { return empty(); }
  }

  async function write(state) {
    state.updatedAt = Date.now();
    trimBank(state.sentenceBank);
    await JA.anki.call('storeMediaFile', { filename: FILE, data: toB64(JSON.stringify(state)) });
  }

  /** Union of two states; newest settings win. */
  function merge(a, b) {
    const out = empty();
    out.manualKnown = [...new Set([...(a.manualKnown || []), ...(b.manualKnown || [])])];
    const newer = (a.settingsAt || 0) >= (b.settingsAt || 0) ? a : b;
    out.settings = newer.settings || a.settings || b.settings;
    out.settingsAt = Math.max(a.settingsAt || 0, b.settingsAt || 0);
    out.sentenceBank = { ...(a.sentenceBank || {}) };
    for (const [k, list] of Object.entries(b.sentenceBank || {})) addSentences(out.sentenceBank, k, list);
    return out;
  }

  /** bank: {key: [{s, w, src, t}]} — keeps up to 3 distinct sentences per word. */
  function addSentences(bank, key, list) {
    const cur = bank[key] || [];
    for (const e of list) {
      if (!e || !e.s || cur.some(x => x.s === e.s)) continue;
      cur.push({ s: e.s.slice(0, 220), w: e.w || '', src: (e.src || '').slice(0, 200), t: e.t || Math.floor(Date.now() / 864e5) });
    }
    cur.sort((x, y) => score(x.s) - score(y.s));
    bank[key] = cur.slice(0, 3);
    return bank[key];
  }
  // prefer natural-length sentences (roughly 12–45 characters)
  const score = s => (s.length < 8 ? 100 : 0) + Math.abs(Math.min(s.length, 80) - 25);

  function bestSentence(bank, key) {
    const l = bank && bank[key];
    return l && l.length ? l[0] : null;
  }

  function trimBank(bank) {
    const keys = Object.keys(bank);
    if (keys.length <= MAX_KEYS) return;
    const age = k => Math.max(...bank[k].map(e => e.t || 0));
    keys.sort((x, y) => age(x) - age(y)).slice(0, keys.length - MAX_KEYS).forEach(k => delete bank[k]);
  }

  const pickSettings = s => Object.fromEntries(SETTINGS_KEYS.filter(k => k in s).map(k => [k, s[k]]));

  return { FILE, read, write, merge, addSentences, bestSentence, pickSettings, toB64, fromB64, empty };
})();

if (typeof module !== 'undefined') module.exports = JA;
