/* Phone/web app: stands in for the Firefox extension APIs (storage, messaging, tabs) so the
 * extension's background and pages run unchanged. Pages live in same-origin iframes. */
var JA = globalThis.JA || (globalThis.JA = {});
JA.platform = 'web';

(() => {
  // ---------- storage.local, persisted to IndexedDB ----------
  let data = {};
  let saveTimer = null;
  const ready = JA.dict.idbGet('webstore').then(v => { data = v || {}; }).catch(() => { data = {}; });
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => JA.dict.idbSet('webstore', data).catch(() => {}), 300); };
  const storage = {
    async get(keys) {
      await ready;
      if (keys == null) return clone(data);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(obj) { await ready; for (const [k, v] of Object.entries(obj)) data[k] = clone(v); persist(); },
    async remove(keys) { await ready; for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; persist(); },
  };
  window.addEventListener('pagehide', () => JA.dict.idbSet('webstore', data));

  // ---------- messaging ----------
  const bgListeners = [];
  const frames = new Map(); // id -> {win, listeners}
  let nextFrame = 1;

  async function dispatchBg(msg) {
    const m = clone(msg);
    for (const f of bgListeners) { const r = f(m, {}); if (r !== undefined) return clone(await r); }
    return undefined;
  }
  async function dispatchFrame(id, msg) {
    const fr = frames.get(id);
    if (!fr) throw new Error('No such page');
    for (const f of fr.listeners) { const r = f(clone(msg), {}); if (r !== undefined) return r; }
    return undefined;
  }

  const ROUTES = { 'pages/reader.html': 'books', 'pages/video.html': 'video', 'pages/bulk.html': 'text', 'pages/recommend.html': 'learn', 'pages/options.html': 'settings', 'web/settings.html': 'settings' };
  const base = new URL('.', location.href).href;
  function openUrl(url) {
    const path = new URL(url, base).href.replace(base, '').split('#')[0].split('?')[0];
    const tab = ROUTES[path];
    if (tab) location.hash = tab; else window.open(url, '_blank', 'noopener');
  }

  const tabs = {
    async query() { return [...frames.keys()].map(id => ({ id })); },
    sendMessage: (id, msg) => dispatchFrame(id, msg),
    async create({ url }) { openUrl(url); return {}; },
  };

  // the background script's view
  window.browser = {
    storage: { local: storage },
    runtime: {
      onMessage: { addListener: f => bgListeners.push(f) },
      sendMessage: dispatchBg,
      getURL: p => new URL(p, base).href,
      openOptionsPage: () => { location.hash = 'settings'; },
    },
    tabs,
  };

  // each page frame gets its own view (its listeners receive broadcasts)
  function browserFor(win) {
    const id = nextFrame++;
    const fr = { win, listeners: [] };
    frames.set(id, fr);
    win.addEventListener('unload', () => frames.delete(id));
    return {
      storage: { local: storage },
      runtime: {
        id: 'jp-reader-web',
        onMessage: { addListener: f => fr.listeners.push(f) },
        sendMessage: dispatchBg,
        getURL: p => new URL(p, base).href,
        openOptionsPage: () => { location.hash = 'settings'; },
      },
      tabs: {
        query: async () => [{ id }],
        sendMessage: (tid, msg) => dispatchFrame(tid, msg),
        create: async ({ url }) => { openUrl(url); return {}; },
      },
    };
  }

  window.JA_WEB = { browserFor, storageReady: ready, openUrl };
})();
