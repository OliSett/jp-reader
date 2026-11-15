/* Background: owns the word engine (dictionary, Anki knowledge, frequency, sentence bank),
 * the Jiten scanner, and syncing shared state with the Claude connector through Anki. */
(() => {
  const E = new JA.Engine();
  const S = {
    settings: null,
    engine: E,
    words: [],
    lastSync: null,
    ankiOk: false,
    ankiError: '',
    syncing: false,
    syncProgress: 0,
    syncPromise: null,
    sharedAt: null,
    phone: { at: null, error: '', busy: false, pending: 0, fromPhone: 0 },
    scan: { running: false, done: 0, total: 0, message: '', at: null, error: '' },
    scanned: [],
    ready: null,
  };
  JA.bg = S;
  const store = browser.storage.local;
  S.dataReady = Promise.resolve();
  // last background state, readable by the extension pages even when the background can't answer
  function status(stage, error) { store.set({ bgStatus: { stage, error: error || '', at: Date.now() } }).catch(() => {}); }
  JA.bgStatus = (m) => status(m);
  // phone app ('web') and the Safari/iPhone extension ('safari'): no Anki, words come from Firefox via sync
  const WEB = JA.platform === 'web' || JA.platform === 'safari';

  async function init() {
    S.settings = await JA.loadSettings();
    configure();
    if (JA.platform !== 'safari') {
      try { const c = await JA.dict.idbGet('jmdict'); if (c) E.dict.load(c); } catch (e) { console.warn('dictionary load failed', e); }
      try { const f = await JA.dict.idbGet('freq'); if (f) E.freq.load(f); } catch (e) { console.warn('frequency load failed', e); }
    }
    const saved = await store.get(['ankiWords', 'lastSync', 'manualKnown', 'jitenScan', 'sentenceBank']);
    S.words = saved.ankiWords || [];
    S.lastSync = saved.lastSync || null;
    E.bank = saved.sentenceBank || {};
    if (saved.jitenScan) { S.scanned = saved.jitenScan.items || []; S.scan.at = saved.jitenScan.at; }
    E.know.build(S.words, saved.manualKnown || []);
    const ph = await store.get('phoneSync');
    if (ph.phoneSync) S.phone = { ...S.phone, ...ph.phoneSync, busy: false };
    if (JA.platform === 'safari') {
      // iPhone: the word data ships inside the app; load it without holding up settings/sync messages
      S.dataReady = JA.safariData.ensure(E).then(() => status('ready'), e => { S.dataError = e.message; status('data error', e.message); });
    }
    if (!WEB) await loadPitch();
    refreshAnki().catch(() => {}); // silent; Anki may be closed
    setInterval(() => phoneSync().catch(() => {}), WEB ? 2 * 60e3 : 5 * 60e3);
    if (JA.platform === 'safari' && browser.alarms) {
      // Safari may stop the background page between uses: an alarm wakes it to sync
      browser.alarms.create('jp-sync', { periodInMinutes: 5 });
      browser.alarms.onAlarm.addListener(a => { if (a.name === 'jp-sync') phoneSync().catch(() => {}); });
    }
  }

  function configure() {
    if (JA.anki) JA.anki.configure({ url: S.settings.ankiUrl, key: S.settings.ankiKey });
    JA.jiten.configure({ key: S.settings.jitenKey });
    JA.sync.configure({ syncKey: S.settings.syncKey });
  }

  // ---------- AI: what a word means in this sentence (and whether it's a word at all) ----------
  const AI_SYSTEM = `You help a learner reading Japanese. A tool cut a piece of text out of a sentence as one word and guessed its dictionary entry.
Decide whether the highlighted text, exactly as cut, is a real word here (an inflected form counts).
It is NOT valid when it is only part of a longer word or name (e.g. 和 inside the name 和真, 一歳 inside 二一歳) or when it joins pieces of two different words (e.g. よカ in よカズマ).
Reply with JSON only, no other text:
{"valid": true or false, "word": "dictionary form", "reading": "hiragana", "meaning": "short English meaning as used in this sentence, max 12 words", "note": "optional nuance or grammar note, max 15 words, or empty", "part_of": "if not valid: the real word or name it belongs to, else empty"}`;
  const aiCache = new Map();
  async function aiExplain({ word, reading, surface, sentence, gloss }) {
    const s = S.settings;
    if (!s.aiKey) throw new Error('Add an Anthropic API key in Settings to get AI meanings.');
    const ck = sentence + '\u0000' + surface;
    if (aiCache.has(ck)) return aiCache.get(ck);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': s.aiKey.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({
        model: s.aiModel || 'claude-haiku-5-5', max_tokens: 400, system: AI_SYSTEM,
        messages: [{ role: 'user', content: `Sentence: ${sentence}\nHighlighted text: ${surface}\nDictionary guess: ${word}${reading ? `（${reading}）` : ''} — ${String(gloss || '').slice(0, 200)}` }],
      }),
    });
    if (!res.ok) {
      let msg = ''; try { msg = (await res.json()).error.message; } catch { /* not json */ }
      throw new Error(res.status === 401 ? 'The Anthropic API key was not accepted — check it in Settings.' : `AI request failed (${res.status}) ${msg}`.trim());
    }
    const j = await res.json();
    const text = (j.content || []).map(c => c.text || '').join('');
    let r;
    try { r = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch { throw new Error('The AI answer could not be read.'); }
    const out = { valid: r.valid !== false, word: r.word || word, reading: r.reading || '', meaning: r.meaning || '', note: r.note || '', partOf: r.part_of || '' };
    aiCache.set(ck, out);
    if (aiCache.size > 1000) aiCache.delete(aiCache.keys().next().value);
    return out;
  }

  // ---------- pitch accent + word audio on cards ----------
  async function loadPitch() {
    try {
      const res = await fetch(browser.runtime.getURL('data/pitch.json.gz'));
      JA.pitch.load(JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text()));
    } catch (e) { console.warn('pitch data failed to load', e); }
  }
  S.enrich = { running: false, done: 0, total: 0, pitch: 0, audio: 0, error: '' };
  /** Fill in pitch graphs and word audio on cards that don't have them yet (runs after each Anki sync). */
  async function enrichCards() {
    if (WEB || S.enrich.running) return;
    S.enrich = { running: true, done: 0, total: 0, pitch: 0, audio: 0, error: '' };
    try {
      const t = (await store.get('enrichTried')).enrichTried || {};
      const tried = { pitch: new Set(t.pitch || []), audio: new Set(t.audio || []) };
      const s = { ...S.settings };
      if (s.wordAudio !== false) {
        // Anki downloads the clips itself; skip this round if the audio site can't be reached
        try { await fetch(JA.anki.audioFor('猫', 'ねこ', 'Audio').url, { mode: 'no-cors', cache: 'no-store' }); } catch { s.wordAudio = false; }
      }
      let lastSave = Date.now();
      const save = () => store.set({ enrichTried: { pitch: [...tried.pitch], audio: [...tried.audio] } });
      const r = await JA.anki.fillPitchAudio(s, tried, p => {
        Object.assign(S.enrich, p);
        if (Date.now() - lastSave > 10e3) { lastSave = Date.now(); save(); }
      });
      Object.assign(S.enrich, r);
      await save();
    } catch (e) { S.enrich.error = e.message; console.warn('pitch/audio fill failed', e); }
    finally { S.enrich.running = false; }
  }

  // ---------- Anki sync (+ shared state with the connector) ----------
  function refreshAnki() {
    if (S.syncPromise) return S.syncPromise;
    S.syncPromise = doRefresh().finally(() => { S.syncPromise = null; });
    return S.syncPromise;
  }

  async function doRefresh() {
    if (WEB) { await phoneSync(); return summary(); }
    S.syncing = true; S.syncProgress = 0;
    try {
      await JA.anki.requestPermission();
      try { await syncShared(); } catch (e) { console.warn('shared state sync failed', e); }
      if (!S.settings.decks.length) { S.ankiOk = true; S.ankiError = 'Pick your Japanese deck(s) in Settings.'; return summary(); }
      const words = await JA.anki.readWords(S.settings, p => (S.syncProgress = p));
      S.words = words;
      S.lastSync = Date.now();
      const { manualKnown } = await store.get('manualKnown');
      E.know.build(words, manualKnown || []);
      await store.set({ ankiWords: words, lastSync: S.lastSync });
      S.ankiOk = true; S.ankiError = '';
      broadcast({ type: 'jar-statuses-changed' });
      phoneSync().catch(() => {});
      enrichCards();
    } catch (e) {
      S.ankiOk = false; S.ankiError = e.message;
      throw e;
    } finally { S.syncing = false; }
    return summary();
  }

  /** Merge our state with the shared file in Anki's media folder and write it back. */
  async function syncShared() {
    const { manualKnown, settingsAt } = await store.get(['manualKnown', 'settingsAt']);
    const local = { manualKnown: manualKnown || [], sentenceBank: E.bank, settings: JA.shared.pickSettings(S.settings), settingsAt: settingsAt || 0 };
    const remote = await JA.shared.read();
    const m = JA.shared.merge(local, remote);
    // settings saved more recently by the Claude connector (e.g. its setup tool) win
    if (remote.settings && (remote.settingsAt || 0) > (settingsAt || 0)) {
      S.settings = { ...S.settings, ...remote.settings };
      await store.set({ settings: S.settings, settingsAt: remote.settingsAt });
      broadcast({ type: 'jar-settings-changed' });
    }
    E.bank = m.sentenceBank;
    E.know.manual = new Set(m.manualKnown);
    await store.set({ manualKnown: m.manualKnown, sentenceBank: E.bank });
    await JA.shared.write(m);
    S.sharedAt = Date.now();
  }

  let pushTimer = null;
  function pushSharedSoon() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      if (S.ankiOk && !WEB) syncShared().catch(() => {});
      phoneSync().catch(() => {});
    }, 20000);
  }

  function summary() {
    return {
      settings: S.settings,
      dict: E.dict.loaded ? E.dict.info : null,
      freq: E.freq.loaded ? { name: E.freq.name, entries: E.freq.rows.length } : null,
      counts: E.know.counts,
      manual: E.know.manual.size,
      sentences: Object.keys(E.bank).length,
      lastSync: S.lastSync, ankiOk: S.ankiOk, ankiError: S.ankiError, syncing: S.syncing, syncProgress: S.syncProgress, sharedAt: S.sharedAt,
      scan: { ...S.scan, titles: S.scanned.length },
      platform: JA.platform || 'extension', dataError: S.dataError || '', dataProgress: JA.safariData ? JA.safariData.progress : '',
      phone: { ...S.phone, enabled: JA.sync.enabled() },
      enrich: S.enrich,
    };
  }

  async function broadcast(msg) {
    try {
      const tabs = await browser.tabs.query({});
      for (const t of tabs) browser.tabs.sendMessage(t.id, msg).catch(() => {});
    } catch { /* ignore */ }
  }

  function statusForKey(key) {
    if (E.know.manual.has(key)) return JA.ST.MANUAL;
    if (key.startsWith('j:')) {
      const idx = E.dict.byId ? E.dict.byId.get(key.slice(2)) : undefined;
      return idx !== undefined ? E.know.statusOf([idx], '', '', key) : JA.ST.UNKNOWN;
    }
    const t = key.slice(2);
    return E.know.statusOf([], t, t, key);
  }

  // ---------- cards ----------
  async function addCards(items) {
    const prepared = E.prepareCards(items);
    const r = WEB ? await queueCards(prepared) : await JA.anki.addCards(prepared, S.settings);
    for (const it of r.addedItems || []) {
      E.know.setStatus(it.word, it.reading, JA.ST.NEW);
      S.words.push({ word: it.word, reading: it.reading, status: JA.ST.NEW, ...(WEB ? { local: true } : {}) });
    }
    await store.set({ ankiWords: S.words });
    broadcast({ type: 'jar-statuses-changed' });
    const noSentence = (r.addedItems || []).filter(it => !it.sentence).length;
    return { added: r.added, failed: r.failed, noSentence, queued: !!r.queued };
  }

  /** Phone: cards wait in the sync queue until the Firefox extension adds them to Anki. */
  async function queueCards(items) {
    if (!JA.sync.enabled()) throw new Error('Link this phone to Firefox first (Settings → Link with Firefox), so cards can reach Anki.');
    const slim = items.map(({ key, word, reading, meaning, sentence, surface, source, tags, kanji }) => ({ key, word, reading, meaning, sentence, surface, source, tags, kanji }));
    for (let i = 0; i < slim.length; i += 200) await JA.sync.queueAdd(slim.slice(i, i + 200));
    S.phone.pending = (S.phone.pending || 0) + slim.length;
    return { added: slim.length, addedItems: items, failed: [], queued: true };
  }

  // ---------- phone <-> Firefox sync ----------
  let phonePromise = null;
  function phoneSync() {
    if (!JA.sync.enabled()) return Promise.resolve(summary());
    if (phonePromise) return phonePromise;
    phonePromise = doPhoneSync().finally(() => { phonePromise = null; });
    return phonePromise;
  }

  async function doPhoneSync() {
    S.phone.busy = true;
    const errors = [];
    const seen = S.phone.seen || (S.phone.seen = {});
    try {
      // what changed on the server since we last looked (tiny request)
      const times = Object.fromEntries((await JA.sync.times()).map(r => [r.kind, r.updated_at]));
      const need = ['words', 'shared'].filter(k => times[k] && times[k] !== seen[k]);
      const remote = need.length ? Object.fromEntries((await JA.sync.get(need)).map(r => [r.kind, r])) : {};

      // 1. cards made on the phone -> Anki (Firefox), first, so nothing else can hold them up
      if (!WEB) {
        try {
          const pending = await JA.sync.queuePending();
          S.phone.pending = pending.length;
          if (pending.length && S.ankiOk) {
            for (let i = 0; i < pending.length; i += 100) {
              const part = pending.slice(i, i + 100);
              const r = await JA.anki.addCards(part.map(p => p.item), S.settings);
              const added = new Set(r.addedItems);
              const dupes = new Set(r.failed.filter(f => /duplicate/i.test(f.reason)).map(f => f.word));
              const done = part.filter(p => added.has(p.item) || dupes.has(p.item.word)).map(p => p.id);
              if (done.length) await JA.sync.queueDone(done);
              for (const it of r.addedItems) { E.know.setStatus(it.word, it.reading, JA.ST.NEW); S.words.push({ word: it.word, reading: it.reading, status: JA.ST.NEW }); }
              S.phone.fromPhone = (S.phone.fromPhone || 0) + r.added;
              S.phone.pending -= done.length;
            }
            await store.set({ ankiWords: S.words });
            S.lastSync = Date.now(); // the word list changed: publish it below
          }
        } catch (e) { errors.push('cards: ' + e.message); }
      }

      // 2. the Anki word list (Firefox publishes, phone reads)
      try {
        if (WEB) {
          if (remote.words) {
            const local = S.words.filter(w => w.status === JA.ST.NEW && w.local); // queued here, not yet in Anki
            S.words = JA.sync.unpackWords(remote.words.data.words);
            const have = new Set(S.words.map(w => w.word));
            for (const w of local) if (!have.has(w.word)) S.words.push(w);
            S.lastSync = new Date(remote.words.updated_at).getTime();
            seen.words = remote.words.updated_at;
            await store.set({ ankiWords: S.words, lastSync: S.lastSync });
          }
          S.phone.pending = 0;
        } else if (S.words.length && (!times.words || (S.lastSync && S.lastSync > new Date(times.words).getTime()))) {
          seen.words = await JA.sync.put('words', { words: JA.sync.packWords(S.words.filter(w => !w.local)), at: S.lastSync });
        } else if (remote.words) seen.words = remote.words.updated_at;
      } catch (e) { errors.push('words: ' + e.message); }

      // 3. marked-known words and saved sentences (both ways), compressed, only uploaded when changed
      try {
        const { manualKnown } = await store.get('manualKnown');
        let mk = manualKnown || [];
        if (remote.shared) {
          const r = await JA.sync.unpackShared(remote.shared.data);
          const m = JA.shared.merge({ manualKnown: mk, sentenceBank: E.bank }, { manualKnown: r.manualKnown, sentenceBank: r.sentenceBank });
          E.bank = m.sentenceBank; mk = m.manualKnown;
          seen.shared = remote.shared.updated_at;
          await store.set({ manualKnown: mk, sentenceBank: E.bank });
        }
        E.know.manual = new Set(mk);
        const packed = await JA.sync.packShared(mk, E.bank);
        const hash = await JA.sync.digest(packed.json);
        if (hash !== S.phone.sharedHash) {
          seen.shared = await JA.sync.put('shared', packed.data);
          S.phone.sharedHash = hash;
        }
      } catch (e) { errors.push('sentences: ' + e.message); }

      if (WEB) E.know.build(S.words, [...E.know.manual]);
      S.phone.at = Date.now();
      S.phone.error = errors.join(' · ');
      broadcast({ type: 'jar-statuses-changed' });
    } catch (e) {
      S.phone.error = e.message;
    } finally {
      S.phone.busy = false;
      store.set({ phoneSync: { at: S.phone.at, error: S.phone.error, fromPhone: S.phone.fromPhone, seen: S.phone.seen, sharedHash: S.phone.sharedHash } });
    }
    return summary();
  }


  async function markKnown(keys, on = true) {
    for (const k of keys) on ? E.know.manual.add(k) : E.know.manual.delete(k);
    await store.set({ manualKnown: [...E.know.manual] });
    broadcast({ type: 'jar-statuses-changed' });
    pushSharedSoon();
    return { ok: true };
  }

  async function bankSentences(items) {
    for (const it of items) JA.shared.addSentences(E.bank, it.key, [{ s: it.sentence, w: it.surface, src: it.source }]);
    await store.set({ sentenceBank: E.bank });
    pushSharedSoon();
    return { ok: true };
  }

  // ---------- frequency ----------
  async function setFrequency(data) {
    await JA.dict.idbSet('freq', data);
    E.freq.load(data);
    broadcast({ type: 'jar-statuses-changed' });
    return summary();
  }
  async function downloadJitenFrequency() {
    const res = await fetch('https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan', { headers: S.settings.jitenKey ? { 'X-Api-Key': S.settings.jitenKey } : {} });
    if (!res.ok) throw new Error(`Jiten returned ${res.status}. Try again in a minute, or import a file instead.`);
    const data = await JA.freq.parseFile(await res.arrayBuffer(), 'jiten');
    if (!data.name || data.name === 'Frequency list') data.name = 'Jiten (global)';
    return setFrequency(data);
  }

  // ---------- Jiten scan ----------
  async function jitenScan({ types, perType, pages }) {
    if (S.scan.running) return S.scan;
    S.scan = { running: true, done: 0, total: 0, message: 'Loading title lists…', at: S.scan.at, error: '' };
    (async () => {
      try {
        const decks = [];
        for (const t of types) {
          for (let off = 0; off < perType; off += 50) {
            S.scan.message = `Loading ${JA.jiten.TYPES[t] || t} titles…`;
            const list = await JA.jiten.listDecks({ mediaType: t, offset: off, sortBy: 'popularity' });
            list.forEach(d => { if (d.type === undefined) d.type = t; });
            decks.push(...list.slice(0, perType - off));
            if (list.length < 50) break;
          }
        }
        if (!decks.length) throw new Error('Jiten returned no titles. Open Settings → Diagnostics → "Test Jiten" and send the output.');
        S.scan.total = decks.length;
        const items = [];
        for (const d of decks) {
          S.scan.message = `Reading vocabulary: ${d.title}`;
          try {
            const words = await JA.jiten.vocab(d.id, { limit: 200, sortBy: 'deckFreq', pages });
            items.push({ deck: d, words: words.map(w => ({ spelling: w.spelling, reading: w.reading, occ: w.occ, meaning: (w.meaning || '').slice(0, 90) })) });
          } catch (e) { console.warn('vocab failed', d.id, e); }
          S.scan.done++;
          if (S.scan.done % 10 === 0) S.scanned = items.slice();
        }
        S.scanned = items;
        S.scan.at = Date.now();
        await store.set({ jitenScan: { at: S.scan.at, items } });
        S.scan.message = `Scanned ${items.length} titles.`;
      } catch (e) {
        S.scan.error = e.message; S.scan.message = '';
      } finally { S.scan.running = false; }
    })();
    return S.scan;
  }

  function recommendations(opts) {
    const r = JA.recommend.analyze(S.scanned, E.know, opts);
    const withRank = u => {
      const b = JA.shared.bestSentence(E.bank, u.key);
      return { ...u, rank: E.freq.loaded ? rankOfKey(u.key, u.word) : null, sentence: b ? b.s : '', surface: b ? b.w : '' };
    };
    const slim = t => ({ ...t, unknown: t.unknown.slice(0, 60).map(withRank) });
    return { titles: r.titles.map(slim), recommended: r.recommended.map(slim), gapList: r.gapList.map(withRank), unlocked: r.unlocked, at: S.scan.at };
  }
  function rankOfKey(key, word) {
    if (key.startsWith('j:') && E.dict.byId) { const i = E.dict.byId.get(key.slice(2)); if (i !== undefined) return E.freq.rankOfEntry(E.dict, i); }
    return E.freq.rankOfTerm(word);
  }

  // ---------- messages ----------
  const SYNC_KEYS = ['decks', 'wordFields', 'readingFields', 'matureDays', 'suspended', 'ankiUrl', 'ankiKey'];
  const H = {
    getState: () => summary(),
    async saveSettings({ settings }) {
      const before = JSON.stringify(SYNC_KEYS.map(k => S.settings[k]));
      S.settings = { ...S.settings, ...settings };
      await store.set({ settings: S.settings, settingsAt: Date.now() });
      configure();
      if (before !== JSON.stringify(SYNC_KEYS.map(k => S.settings[k]))) refreshAnki().catch(() => {});
      else pushSharedSoon();
      broadcast({ type: 'jar-settings-changed' });
      return summary();
    },
    refreshAnki: () => refreshAnki(),
    phoneSync: () => phoneSync(),
    async inboxAdd({ item }) {
      if (!JA.sync.enabled()) throw new Error('Link a phone first (Settings → Phone).');
      await JA.sync.inboxAdd({ title: item.title, url: item.url, text: String(item.text || '').slice(0, 400000), at: Date.now() });
      return { ok: true };
    },
    inboxTake: () => (JA.sync.enabled() ? JA.sync.inboxTake() : []),
    async setSyncKey({ key }) {
      const k = key === 'new' ? JA.sync.newKey() : JA.sync.normalize(key);
      if (k && k.length < 20) throw new Error('That sync code looks too short.');
      S.settings.syncKey = k;
      await store.set({ settings: S.settings });
      configure();
      S.lastSync = WEB ? null : S.lastSync;
      S.phone.seen = {}; S.phone.sharedHash = null;
      if (k) await phoneSync(); else S.phone = { at: null, error: '', busy: false, pending: 0, fromPhone: 0 };
      return summary();
    },
    async reloadDictionary() {
      const c = await JA.dict.idbGet('jmdict');
      if (c) E.dict.load(c);
      E.freq.entryCache = new Map();
      const { manualKnown } = await store.get('manualKnown');
      E.know.build(S.words, manualKnown || []);
      broadcast({ type: 'jar-statuses-changed' });
      return summary();
    },
    async retryData() { S.dataError = ''; S.dataReady = JA.safariData.ensure(E, true).then(() => status('ready'), e => { S.dataError = e.message; }); await S.dataReady; return summary(); },
    async reloadFrequency() { const f = await JA.dict.idbGet('freq'); if (f) E.freq.load(f); broadcast({ type: 'jar-statuses-changed' }); return summary(); },
    downloadJitenFrequency: () => downloadJitenFrequency(),
    tokenize: ({ texts }) => E.tokenizeTexts(texts),
    aiExplain: m => aiExplain(m),
    // ---- subtitles on other websites: find the frame with the video, open the side panel in the page
    async subsStart(msg, sender) {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      if (tabId === undefined) throw new Error('No tab');
      const nonce = Math.random().toString(36).slice(2);
      const found = [];
      subsProbes.set(nonce, found);
      await browser.tabs.sendMessage(tabId, { type: 'jar-subs-probe', nonce }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      subsProbes.delete(nonce);
      found.sort((a, b) => b.area - a.area);
      const videoFrame = found.length ? found[0].frameId : null;
      if (videoFrame !== null) await browser.tabs.sendMessage(tabId, { type: 'jar-subs-attach' }, { frameId: videoFrame }).catch(() => {});
      await browser.tabs.sendMessage(tabId, { type: 'jar-subs-sidebar', videoFrame }, { frameId: 0 });
      return { videoFrame, frames: found.length };
    },
    subsHasVideo(msg, sender) { const f = subsProbes.get(msg.nonce); if (f) f.push({ frameId: sender.frameId || 0, area: msg.area }); return true; },
    async subsRelay(msg, sender) {
      if (!sender.tab) throw new Error('No tab');
      await browser.tabs.sendMessage(sender.tab.id, msg.msg, { frameId: msg.to || 0 });
      return true;
    },
    statuses: ({ keys }) => Object.fromEntries(keys.map(k => [k, statusForKey(k)])),
    addCards: ({ items }) => addCards(items),
    markKnown: ({ keys, on }) => markKnown(keys, on),
    bankSentences: ({ items }) => bankSentences(items),
    analyzeText: ({ text, source }) => { const r = E.analyzeText(text, source || 'Pasted text'); store.set({ sentenceBank: E.bank }); return r.words; },
    lookupWords: ({ words }) => E.lookupWords(words),
    async analyzeBook({ chapters, source }) {
      const r = E.analyzeBook(chapters, { source, countLearning: S.settings.countLearning });
      await store.set({ sentenceBank: E.bank });
      pushSharedSoon();
      return r;
    },
    nextWords: (o) => E.nextWords(o),
    ankiDecks: () => JA.anki.requestPermission().then(() => JA.anki.deckNames()),
    ankiModels: () => JA.anki.modelNames(),
    ankiModelFields: ({ name }) => JA.anki.modelFields(name),
    ankiSampleFields: ({ decks }) => JA.anki.sampleFields(decks),
    jitenDiagnostics: () => JA.jiten.diagnostics(),
    jitenScan: (o) => jitenScan(o),
    jitenScanStatus: () => ({ ...S.scan, titles: S.scanned.length }),
    recommendations: (o) => recommendations(o),
  };
  const subsProbes = new Map();
  JA.handlers = H;

  // messages that don't need the dictionary answer as soon as settings are loaded
  const NO_DATA = new Set(['getState', 'saveSettings', 'setSyncKey', 'phoneSync', 'inboxAdd', 'inboxTake', 'retryData', 'refreshAnki',
    'subsStart', 'subsHasVideo', 'subsRelay', 'subsProbeReply']);
  // sendResponse + `return true` works in every browser (Safari doesn't always pass a returned promise back)
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const h = msg && H[msg.type];
    if (!h) return undefined;
    S.ready.then(() => (NO_DATA.has(msg.type) ? null : S.dataReady)).then(() => h(msg, sender || {}))
      .then(r => ({ ok: true, r }), e => ({ ok: false, error: e.message || String(e) }))
      .then(res => { try { sendResponse(res); } catch { /* page closed */ } });
    return true;
  });

  if (browser.commands && browser.commands.onCommand) {
    browser.commands.onCommand.addListener(async (cmd) => {
      if (cmd !== 'parse-page') return;
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) browser.tabs.sendMessage(tab.id, { type: 'jar-toggle' }).catch(() => {});
    });
  }
  if (browser.runtime.onInstalled) {
    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === 'install') browser.tabs.create({ url: browser.runtime.getURL('pages/options.html') });
    });
  }

  status('starting');
  S.ready = init().then(() => { if (JA.platform !== 'safari') status('ready'); }, e => { status('start failed', e.message || String(e)); throw e; });
})();
