/* Jiten.moe public API client (media library + per-title vocabulary).
 * The API is unversioned, so responses are read defensively: field names are matched
 * from a list of likely candidates and the Diagnostics panel shows raw samples. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.jiten = (() => {
  const BASE = 'https://api.jiten.moe/api';
  const TYPES = { 1: 'Anime', 2: 'Drama', 3: 'Movie', 4: 'Novel / light novel', 5: 'Non-fiction', 6: 'Video game', 7: 'Visual novel', 8: 'Web novel', 9: 'Manga' };
  let key = '';
  let last = 0;
  const configure = (c) => { key = c.key || ''; };
  const gap = () => (key ? 250 : 600); // stay under 300 / 120 requests per minute

  async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last + gap() - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch(url, { headers: key ? { 'X-Api-Key': key, Accept: 'application/json' } : { Accept: 'application/json' } });
      if (res.status === 429) {
        const ra = parseInt(res.headers.get('Retry-After') || '10', 10);
        await new Promise(r => setTimeout(r, (isNaN(ra) ? 10 : ra) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Jiten ${res.status} for ${path}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch { return text; }
    }
    throw new Error('Jiten rate limit: try again in a minute.');
  }

  // ---------- defensive readers ----------
  const ARRAY_KEYS = ['data', 'items', 'results', 'decks', 'mediaDecks', 'words', 'vocabulary', 'list', 'values', 'value'];
  function findArray(j) {
    if (Array.isArray(j)) return j;
    if (!j || typeof j !== 'object') return [];
    for (const k of ARRAY_KEYS) if (Array.isArray(j[k])) return j[k];
    for (const v of Object.values(j)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    for (const v of Object.values(j)) if (v && typeof v === 'object' && !Array.isArray(v)) { const a = findArray(v); if (a.length) return a; }
    return [];
  }
  function pick(o, names, depth = 1) {
    if (!o || typeof o !== 'object') return undefined;
    const keys = Object.keys(o);
    for (const n of names) {
      const k = keys.find(x => x.toLowerCase() === n.toLowerCase());
      if (k !== undefined && o[k] !== null && o[k] !== undefined && o[k] !== '') return o[k];
    }
    if (depth > 0) for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) { const r = pick(v, names, depth - 1); if (r !== undefined) return r; }
    return undefined;
  }
  function strings(v, out = [], lim = 6) {
    if (out.length >= lim || v === null || v === undefined) return out;
    if (typeof v === 'string') { if (v.trim() && !JA.kana.hasJapanese(v)) out.push(v.trim()); }
    else if (Array.isArray(v)) v.forEach(x => strings(x, out, lim));
    else if (typeof v === 'object') {
      const inner = pick(v, ['meanings', 'english', 'glosses', 'gloss', 'definitions', 'text', 'meaning'], 0);
      strings(inner !== undefined ? inner : Object.values(v).filter(x => typeof x === 'string' || Array.isArray(x)), out, lim);
    }
    return out;
  }
  /** Like pick, but only accepts strings (or arrays/objects that contain one). */
  function pickStr(o, names, depth = 2) {
    if (!o || typeof o !== 'object') return undefined;
    const keys = Object.keys(o);
    for (const n of names) {
      const k = keys.find(x => x.toLowerCase() === n.toLowerCase());
      if (k === undefined) continue;
      const v = o[k];
      if (typeof v === 'string' && v) return v;
      if (Array.isArray(v)) { const s = v.map(x => (typeof x === 'string' ? x : x && typeof x === 'object' ? pickStr(x, ['text', 'reading', 'spelling', 'value'], 0) : undefined)).find(Boolean); if (s) return s; }
    }
    if (depth > 0) for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) { const r = pickStr(v, names, depth - 1); if (r) return r; }
    return undefined;
  }
  const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() && !isNaN(+v) ? +v : undefined));
  const firstStr = v => (typeof v === 'string' ? v : Array.isArray(v) ? firstStr(v[0]) : v && typeof v === 'object' ? firstStr(pick(v, ['text', 'reading', 'value'], 0)) : undefined);

  function normDeck(d) {
    const title = firstStr(pick(d, ['originalTitle', 'japaneseTitle', 'title', 'name', 'romajiTitle'], 0));
    let cover = firstStr(pick(d, ['coverName', 'coverUrl', 'cover', 'coverImage', 'image'], 0));
    if (cover && !/^https?:/.test(cover)) cover = '';
    return {
      id: pick(d, ['deckId', 'mediaDeckId', 'id'], 0),
      title: title || '(untitled)',
      titleEn: firstStr(pick(d, ['englishTitle', 'romajiTitle'], 0)) || '',
      cover,
      difficulty: num(pick(d, ['difficulty', 'difficultyRaw', 'difficultyScore'], 0)),
      chars: num(pick(d, ['characterCount', 'charCount'], 0)),
      uniqueWords: num(pick(d, ['uniqueWordCount', 'uniqueWords'], 0)),
      type: num(pick(d, ['mediaType', 'type'], 0)),
    };
  }

  function normWord(w) {
    let spelling = pickStr(w, ['spelling', 'mainSpelling', 'originalText', 'word', 'term', 'writing', 'text']);
    if (spelling) spelling = JA.kana.cleanField(spelling);
    const readingRaw = pickStr(w, ['reading', 'readingInKana', 'kanaReading', 'kana', 'hiragana', 'readings']);
    const reading = readingRaw ? JA.kana.cleanField(readingRaw) : '';
    const occ = num(pick(w, ['occurrences', 'occurrenceCount', 'deckOccurrences', 'frequencyInDeck', 'deckFrequency', 'occurrencesInDeck', 'count', 'amount']));
    const meanings = strings(pick(w, ['meanings', 'definitions', 'glosses', 'senses', 'meaning', 'definition']));
    return { spelling, reading, occ, meaning: meanings.slice(0, 4).join('; '), wordId: pick(w, ['wordId'], 1) };
  }

  async function listDecks({ mediaType, offset = 0, sortBy = 'popularity' }) {
    const j = await get('/media-deck/get-media-decks', { offset, sortBy, mediaType });
    return findArray(j).map(normDeck).filter(d => d.id !== undefined);
  }

  async function vocab(id, { limit = 200, sortBy = 'deckFreq', pages = 1 } = {}) {
    const all = [];
    let firstKey = null;
    for (let p = 0; p < pages; p++) {
      const j = await get(`/media-deck/${id}/vocabulary`, { limit, sortBy, offset: p * limit });
      const words = findArray(j).map(normWord).filter(w => w.spelling);
      if (!words.length) break;
      const k = words[0].spelling + '|' + words.length;
      if (p > 0 && k === firstKey) break; // API ignored offset
      if (p === 0) firstKey = k;
      all.push(...words);
      if (words.length < limit) break;
    }
    return all;
  }

  async function diagnostics() {
    const out = {};
    const decksRaw = await get('/media-deck/get-media-decks', { offset: 0, sortBy: 'popularity', mediaType: 1 });
    const arr = findArray(decksRaw);
    out.deckListShape = shape(decksRaw);
    out.firstDeckRaw = arr[0];
    out.firstDeckParsed = arr[0] && normDeck(arr[0]);
    if (out.firstDeckParsed && out.firstDeckParsed.id !== undefined) {
      const vRaw = await get(`/media-deck/${out.firstDeckParsed.id}/vocabulary`, { limit: 5, sortBy: 'deckFreq' });
      out.vocabShape = shape(vRaw);
      out.firstWordsRaw = findArray(vRaw).slice(0, 2);
      out.firstWordsParsed = findArray(vRaw).slice(0, 5).map(normWord);
    }
    return out;
  }
  function shape(j) {
    if (Array.isArray(j)) return `array[${j.length}]`;
    if (j && typeof j === 'object') return '{' + Object.keys(j).map(k => k + ':' + (Array.isArray(j[k]) ? `array[${j[k].length}]` : typeof j[k])).join(', ') + '}';
    return typeof j;
  }

  const link = id => `https://jiten.moe/decks/media/${id}/detail`;

  return { configure, get, listDecks, vocab, diagnostics, link, TYPES, _normDeck: normDeck, _normWord: normWord, _findArray: findArray };
})();

if (typeof module !== 'undefined') module.exports = JA;
