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
  const WEB = JA.platform === 'web'; // the phone app: no Anki, words come from the extension via sync

  async function init() {
    S.settings = await JA.loadSettings();
    configure();
    try { const c = await JA.dict.idbGet('jmdict'); if (c) E.dict.load(c); } catch (e) { console.warn('dictionary load failed', e); }
    try { const f = await JA.dict.idbGet('freq'); if (f) E.freq.load(f); } catch (e) { console.warn('frequency load failed', e); }
    const saved = await store.get(['ankiWords', 'lastSync', 'manualKnown', 'jitenScan', 'sentenceBank']);
    S.words = saved.ankiWords || [];
    S.lastSync = saved.lastSync || null;
    E.bank = saved.sentenceBank || {};
    if (saved.jitenScan) { S.scanned = saved.jitenScan.items || []; S.scan.at = saved.jitenScan.at; }
    E.know.build(S.words, saved.manualKnown || []);
    const ph = await store.get('phoneSync');
    if (ph.phoneSync) S.phone = { ...S.phone, ...ph.phoneSync, busy: false };
    refreshAnki().catch(() => {}); // silent; Anki may be closed
    setInterval(() => phoneSync().catch(() => {}), WEB ? 2 * 60e3 : 5 * 60e3);
  }

  function configure() {
    if (JA.anki) JA.anki.configure({ url: S.settings.ankiUrl, key: S.settings.ankiKey });
    JA.jiten.configure({ key: S.settings.jitenKey });
    JA.sync.configure({ syncKey: S.settings.syncKey });
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
      platform: WEB ? 'web' : 'extension',
      phone: { ...S.phone, enabled: JA.sync.enabled() },
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
    try {
      const remote = Object.fromEntries((await JA.sync.get(['words', 'shared'])).map(r => [r.kind, r]));
      // shared: marked-known words, saved sentences (both directions)
      const { manualKnown } = await store.get('manualKnown');
      const mine = { manualKnown: manualKnown || [], sentenceBank: E.bank, settings: null, settingsAt: 0 };
      const m = JA.shared.merge(mine, remote.shared ? remote.shared.data : JA.shared.empty());
      E.bank = m.sentenceBank;
      E.know.manual = new Set(m.manualKnown);
      await store.set({ manualKnown: m.manualKnown, sentenceBank: E.bank });
      await JA.sync.put('shared', { manualKnown: m.manualKnown, sentenceBank: m.sentenceBank, updatedAt: Date.now() });

      if (WEB) {
        // phone: take the Anki word list the extension published
        if (remote.words && (!S.lastSync || new Date(remote.words.updated_at).getTime() > S.lastSync)) {
          const local = S.words.filter(w => w.status === JA.ST.NEW && w.local); // queued here, not yet in the snapshot
          S.words = JA.sync.unpackWords(remote.words.data.words);
          const have = new Set(S.words.map(w => w.word));
          for (const w of local) if (!have.has(w.word)) S.words.push(w);
          S.lastSync = new Date(remote.words.updated_at).getTime();
          await store.set({ ankiWords: S.words, lastSync: S.lastSync });
        }
        E.know.build(S.words, m.manualKnown);
        S.phone.pending = 0;
      } else {
        // Firefox: publish the Anki word list, then add cards mined on the phone
        if (S.words.length && (!remote.words || (S.lastSync && S.lastSync > new Date(remote.words.updated_at).getTime()))) {
          await JA.sync.put('words', { words: JA.sync.packWords(S.words), at: S.lastSync });
        }
        const pending = await JA.sync.queuePending();
        S.phone.pending = pending.length;
        if (pending.length && S.ankiOk) {
          const r = await JA.anki.addCards(pending.map(p => p.item), S.settings);
          const done = pending.filter(p => r.addedItems.includes(p.item) || r.failed.some(f => f.word === p.item.word && /duplicate/i.test(f.reason))).map(p => p.id);
          if (done.length) await JA.sync.queueDone(done);
          for (const it of r.addedItems) { E.know.setStatus(it.word, it.reading, JA.ST.NEW); S.words.push({ word: it.word, reading: it.reading, status: JA.ST.NEW }); }
          if (r.added) await store.set({ ankiWords: S.words });
          S.phone.fromPhone = (S.phone.fromPhone || 0) + r.added;
          S.phone.pending = pending.length - done.length;
        }
      }
      S.phone.at = Date.now(); S.phone.error = '';
      broadcast({ type: 'jar-statuses-changed' });
    } catch (e) {
      S.phone.error = e.message;
    } finally {
      S.phone.busy = false;
      store.set({ phoneSync: { at: S.phone.at, error: S.phone.error, fromPhone: S.phone.fromPhone } });
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
    async reloadFrequency() { const f = await JA.dict.idbGet('freq'); if (f) E.freq.load(f); broadcast({ type: 'jar-statuses-changed' }); return summary(); },
    downloadJitenFrequency: () => downloadJitenFrequency(),
    tokenize: ({ texts }) => E.tokenizeTexts(texts),
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
  JA.handlers = H;

  browser.runtime.onMessage.addListener((msg) => {
    const h = msg && H[msg.type];
    if (!h) return undefined;
    return S.ready.then(() => h(msg)).then(r => ({ ok: true, r }), e => ({ ok: false, error: e.message || String(e) }));
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

  S.ready = init();
})();
