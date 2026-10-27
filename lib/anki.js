/* AnkiConnect client: permissions, reading known words, adding cards. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.anki = (() => {
  const MODEL = 'JP Reader Vocab';
  const MODEL_FIELDS = ['Word', 'Reading', 'Meaning', 'Sentence', 'Source'];

  let cfg = { url: 'http://127.0.0.1:8765', key: '' };
  const configure = (c) => { cfg = { ...cfg, ...c }; };

  async function call(action, params = {}) {
    const body = { action, version: 6, params };
    if (cfg.key) body.key = cfg.key;
    let res;
    try {
      res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Can\'t reach Anki. Make sure Anki is open and the AnkiConnect add-on is installed.');
    }
    const data = await res.json();
    if (data && typeof data === 'object' && 'error' in data) {
      if (data.error) throw new Error('Anki: ' + data.error);
      return data.result;
    }
    return data;
  }

  /** AnkiConnect asks the user (in Anki) to allow this extension the first time. */
  async function requestPermission() {
    const r = await call('requestPermission');
    if (r && r.permission === 'denied') throw new Error('Anki refused access. Allow it in the AnkiConnect pop-up, or add this extension to "webCorsOriginList" in AnkiConnect\'s config.');
    return r;
  }

  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

  /**
   * Read known words. settings: {decks[], wordFields[], readingFields[], matureDays, suspended: 'known'|'ignore'|'learning'}
   * returns [{word, reading, status, noteId}]
   */
  async function readWords(s, onProgress = () => {}) {
    if (!s.decks || !s.decks.length) throw new Error('Choose which Anki deck(s) hold your Japanese words in Settings.');
    const q = s.decks.map(d => `"deck:${d.replace(/"/g, '\\"')}"`).join(' OR ');
    const ids = await call('findCards', { query: q });
    const byNote = new Map();
    const parts = chunk(ids, 500);
    let done = 0;
    for (const part of parts) {
      const cards = await call('cardsInfo', { cards: part });
      for (const c of cards) {
        const st = cardStatus(c, s);
        if (st === null) continue;
        const prev = byNote.get(c.note);
        if (prev && prev.status >= st) continue;
        const f = c.fields || {};
        const word = pickField(f, s.wordFields);
        if (!word) continue;
        byNote.set(c.note, { word, reading: pickField(f, s.readingFields, true), status: st, noteId: c.note });
      }
      onProgress(Math.round((++done / parts.length) * 100));
    }
    return [...byNote.values()];
  }

  function pickField(fields, names, raw = false) {
    for (const n of names || []) {
      const hit = Object.keys(fields).find(k => k.toLowerCase() === n.toLowerCase());
      if (hit && fields[hit].value) {
        const v = JA.kana.cleanField(fields[hit].value);
        if (v) return raw ? v : v;
      }
    }
    if (raw) return '';
    // fallback: first field (sorted by order) that contains Japanese
    const sorted = Object.entries(fields).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    for (const [, v] of sorted) {
      const t = JA.kana.cleanField(v.value);
      if (t && JA.kana.hasJapanese(t) && t.length <= 15) return t;
    }
    return '';
  }

  function cardStatus(c, s) {
    // queue: -3/-2 buried, -1 suspended, 0 new, 1 learning, 2 review, 3 relearning
    if (c.queue === -1) {
      if (s.suspended === 'ignore') return null;
      if (s.suspended === 'learning') return JA.ST.LEARNING;
      return JA.ST.KNOWN;
    }
    if (c.type === 0 || c.queue === 0) return JA.ST.NEW;
    return (c.interval || 0) >= (s.matureDays || 21) ? JA.ST.KNOWN : JA.ST.LEARNING;
  }

  const STYLE_VERSION = 'jp-reader-style v2';
  const CSS = `/* ${STYLE_VERSION} */
.card{margin:0;padding:0;min-height:100vh;font-family:"Yu Gothic UI","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",Meiryo,system-ui,sans-serif;
  color:#2b2a33;background:radial-gradient(circle at 20% 0%,#fff6e9 0,#f6efe4 45%,#efe7f3 100%);text-align:center}
.jp-card{max-width:560px;margin:28px auto;padding:34px 26px 30px;background:rgba(255,255,255,.72);border-radius:22px;
  box-shadow:0 10px 30px rgba(84,64,120,.13),0 1px 0 rgba(255,255,255,.9) inset;border:1px solid rgba(120,100,160,.12)}
.word{font-family:"Yu Mincho","Hiragino Mincho ProN","Noto Serif JP","Noto Serif CJK JP",serif;font-size:58px;font-weight:600;
  line-height:1.25;letter-spacing:.04em;color:#3a2f6b}
.sentence{margin:22px auto 0;padding:14px 18px;max-width:480px;border-radius:14px;background:#f7f2ff;color:#4a4458;
  font-size:23px;line-height:1.75;border-left:4px solid #b9a6ea;text-align:left}
.sentence b{font-weight:700;color:#3a2f6b;background:linear-gradient(transparent 58%,#ffd98a 58%);padding:0 2px;border-radius:2px}
.answer{margin-top:26px;padding-top:22px;border-top:1px dashed rgba(90,70,140,.25)}
.reading{display:inline-block;font-size:24px;letter-spacing:.08em;color:#5b4b9a;background:#ece6fb;border-radius:999px;padding:4px 18px}
.meaning{margin-top:14px;font-size:22px;line-height:1.5;color:#2b2a33}
.source{margin-top:18px;font-size:12px;color:#9a94a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:520px){.jp-card{margin:12px;padding:26px 16px}.word{font-size:46px}.sentence{font-size:20px}}
.nightMode .card,.night_mode .card,.card.nightMode,.card.night_mode{color:#e9e5f3;background:radial-gradient(circle at 20% 0%,#2c2541 0,#1d1a2b 55%,#141320 100%)}
.nightMode .jp-card,.night_mode .jp-card{background:rgba(40,35,60,.75);border-color:rgba(200,180,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.35)}
.nightMode .word,.night_mode .word{color:#d9cffc}
.nightMode .sentence,.night_mode .sentence{background:#2a2442;color:#d6d0e6;border-left-color:#8f7ad6}
.nightMode .sentence b,.night_mode .sentence b{color:#fff;background:linear-gradient(transparent 58%,#8a6a1f 58%)}
.nightMode .reading,.night_mode .reading{background:#3a3160;color:#d9cffc}
.nightMode .meaning,.night_mode .meaning{color:#ece9f5}
.nightMode .answer,.night_mode .answer{border-top-color:rgba(200,180,255,.2)}`;
  const FRONT = '<div class="jp-card"><div class="word">{{Word}}</div>{{#Sentence}}<div class="sentence">{{Sentence}}</div>{{/Sentence}}</div>';
  const BACK = '<div class="jp-card"><div class="word">{{Word}}</div>{{#Sentence}}<div class="sentence">{{Sentence}}</div>{{/Sentence}}'
    + '<div id="answer" class="answer">{{#Reading}}<div class="reading">{{Reading}}</div>{{/Reading}}<div class="meaning">{{Meaning}}</div>'
    + '{{#Source}}<div class="source">{{Source}}</div>{{/Source}}</div></div>';

  /** Create the note type, or bring an existing one up to the current card design. */
  async function ensureModel() {
    const models = await call('modelNames');
    if (!models.includes(MODEL)) {
      await call('createModel', {
        modelName: MODEL, inOrderFields: MODEL_FIELDS, css: CSS, isCloze: false,
        cardTemplates: [{ Name: 'Recognition', Front: FRONT, Back: BACK }],
      });
      return MODEL;
    }
    const styling = await call('modelStyling', { modelName: MODEL }).catch(() => null);
    if (!styling || !String(styling.css || '').includes(STYLE_VERSION)) {
      await call('updateModelStyling', { model: { name: MODEL, css: CSS } });
      const names = await call('modelTemplates', { modelName: MODEL }).then(t => Object.keys(t)).catch(() => ['Recognition']);
      await call('updateModelTemplates', { model: { name: MODEL, templates: { [names[0] || 'Recognition']: { Front: FRONT, Back: BACK } } } });
    }
    return MODEL;
  }

  /**
   * items: [{word, reading, meaning, sentence, source}]
   * s: {targetDeck, noteType, fieldMap:{Word,Reading,Meaning,Sentence,Source}, tags[], allowDuplicates}
   */
  async function addCards(items, s) {
    if (!items.length) return { added: 0, failed: [] };
    const deck = s.targetDeck || 'Japanese';
    await call('createDeck', { deck });
    const useOwn = !s.noteType || s.noteType === MODEL;
    const modelName = useOwn ? await ensureModel() : s.noteType;
    const map = useOwn ? Object.fromEntries(MODEL_FIELDS.map(f => [f, f])) : (s.fieldMap || {});
    const notes = items.map(it => {
      const fields = {};
      const put = (logical, val) => { const real = map[logical]; if (real && val) fields[real] = (fields[real] ? fields[real] + '<br>' : '') + val; };
      put('Word', esc(it.word));
      put('Reading', esc(it.reading));
      put('Meaning', esc(it.meaning));
      put('Sentence', highlight(it.sentence, it.surface || it.word));
      put('Source', esc(it.source));
      return { deckName: deck, modelName, fields, tags: [...new Set([...(s.tags || []), ...(it.tags || [])])], options: { allowDuplicate: !!s.allowDuplicates, duplicateScope: 'collection' } };
    });

    let can;
    try {
      can = await call('canAddNotesWithErrorDetail', { notes });
    } catch (e) {
      const b = await call('canAddNotes', { notes });
      can = b.map(ok => ({ canAdd: ok, error: ok ? null : 'duplicate or empty' }));
    }
    const good = [], failed = [];
    notes.forEach((n, i) => (can[i] && can[i].canAdd ? good.push({ n, it: items[i] }) : failed.push({ word: items[i].word, reason: (can[i] && can[i].error) || 'cannot add' })));
    let ids = [];
    if (good.length) ids = await call('addNotes', { notes: good.map(g => g.n) });
    const addedItems = good.filter((g, i) => ids[i]).map(g => g.it);
    return { added: addedItems.length, addedItems, failed };
  }

  function esc(s) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function highlight(sentence, w) {
    if (!sentence) return '';
    const e = esc(sentence);
    return w ? e.split(esc(w)).join('<b>' + esc(w) + '</b>') : e;
  }

  /** Notes made by the extension/connector that still have no sentence. */
  async function notesNeedingSentence(limit = 30) {
    const ids = (await call('findNotes', { query: 'tag:needs-sentence' })).slice(0, limit);
    if (!ids.length) return [];
    const info = await call('notesInfo', { notes: ids });
    return info.map(n => ({ noteId: n.noteId, model: n.modelName, fields: Object.fromEntries(Object.entries(n.fields).map(([k, v]) => [k, v.value.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()])) }));
  }

  /** Put a sentence on a note (word in bold) and drop the needs-sentence tag. */
  async function setSentence(noteId, sentence, word, s) {
    const [n] = await call('notesInfo', { notes: [noteId] });
    if (!n) throw new Error('Note not found: ' + noteId);
    const own = n.modelName === MODEL;
    const field = own ? 'Sentence' : (s.fieldMap && s.fieldMap.Sentence) || Object.keys(n.fields).find(f => /sentence/i.test(f));
    if (!field || !(field in n.fields)) throw new Error(`Note type "${n.modelName}" has no sentence field. Map one in the extension settings.`);
    const wordField = own ? 'Word' : (s.fieldMap && s.fieldMap.Word) || Object.keys(n.fields)[0];
    const w = word || JA.kana.cleanField(n.fields[wordField] ? n.fields[wordField].value : '');
    await call('updateNoteFields', { note: { id: noteId, fields: { [field]: highlight(sentence, w) } } });
    await call('removeTags', { notes: [noteId], tags: 'needs-sentence' });
    return { noteId, field };
  }

  const deckNames = () => call('deckNames');
  const modelNames = () => call('modelNames');
  const modelFields = (m) => call('modelFieldNames', { modelName: m });
  const version = () => call('version');
  /** Sample field names used in the chosen decks, to help the user pick the word field. */
  async function sampleFields(decks) {
    const q = decks.map(d => `"deck:${d}"`).join(' OR ');
    const ids = (await call('findNotes', { query: q })).slice(0, 20);
    if (!ids.length) return {};
    const info = await call('notesInfo', { notes: ids });
    const out = {};
    for (const n of info) for (const [k, v] of Object.entries(n.fields)) if (!out[k] && v.value) out[k] = JA.kana.cleanField(v.value).slice(0, 30);
    return out;
  }

  return { configure, call, requestPermission, readWords, addCards, ensureModel, CARD: { CSS, FRONT, BACK }, notesNeedingSentence, setSentence, highlight, deckNames, modelNames, modelFields, version, sampleFields, MODEL, MODEL_FIELDS, _cardStatus: cardStatus };
})();

if (typeof module !== 'undefined') module.exports = JA;
