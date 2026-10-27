/* Phone app shell: first-run data download, pairing links, tab routing. */
(() => {
  const PAGES = { books: 'pages/reader.html', video: 'pages/video.html', text: 'pages/bulk.html', learn: 'pages/recommend.html', settings: 'web/settings.html' };
  const view = document.getElementById('view');
  const boot = document.getElementById('boot');
  const bootMsg = document.getElementById('bootMsg');
  const bar = document.getElementById('bootBar');
  const bg = (type, d = {}) => browser.runtime.sendMessage({ type, ...d }).then(r => { if (!r || !r.ok) throw new Error(r ? r.error : 'no response'); return r.r; });

  function toast(t, ms = 3500) {
    const el = document.getElementById('toast');
    el.textContent = t; el.style.display = 'block';
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.style.display = 'none'; }, ms);
  }
  window.JA_WEB.toast = toast;

  /** Download a gzipped JSON data file with progress. */
  async function fetchGz(url, label) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${label}: download failed (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    const parts = []; let got = 0;
    bar.hidden = false; bar.max = total || 1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      bar.value = total ? got : 0;
      bootMsg.textContent = `${label}: ${(got / 1e6).toFixed(1)}${total ? ' / ' + (total / 1e6).toFixed(1) : ''} MB`;
    }
    bootMsg.textContent = `${label}: unpacking…`;
    const raw = await JA.archive.inflate(new Blob(parts), 'gzip');
    return JSON.parse(new TextDecoder().decode(raw));
  }

  async function ensureData() {
    const st = await bg('getState');
    if (!st.dict) {
      bootMsg.textContent = 'First start: downloading the dictionary (about 6 MB, once)…';
      await JA.dict.idbSet('jmdict', await fetchGz('data/jmdict.json.gz', 'Dictionary'));
      bootMsg.textContent = 'Building the dictionary…';
      await bg('reloadDictionary');
    }
    if (!st.freq) {
      try {
        await JA.dict.idbSet('freq', await fetchGz('data/freq.json.gz', 'Frequency list'));
        await bg('reloadFrequency');
      } catch (e) { console.warn(e); }
    }
    bar.hidden = true;
  }

  function route() {
    let h = location.hash.slice(1);
    if (h.startsWith('pair=')) return;
    if (!PAGES[h]) h = 'books';
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.tab === h));
    const want = new URL(PAGES[h], location.href).href;
    if (view.dataset.page !== want) { view.dataset.page = want; view.src = want; }
  }
  window.addEventListener('hashchange', route);
  // tapping the active tab again goes back to that tab's start (e.g. from a book to the library)
  document.querySelectorAll('nav a').forEach(a => a.addEventListener('click', e => {
    if (location.hash.slice(1) === a.dataset.tab) { e.preventDefault(); view.src = view.dataset.page; }
  }));

  async function start() {
    try {
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      bootMsg.textContent = 'Loading your dictionary…';
      await window.JA_WEB.storageReady;
      await JA.bg.ready;
      await ensureData();
      const pair = location.hash.match(/^#pair=(.+)$/);
      if (pair) {
        bootMsg.textContent = 'Linking with Firefox…';
        try {
          const st = await bg('setSyncKey', { key: decodeURIComponent(pair[1]) });
          toast(st.phone.error ? 'Linked, but sync failed: ' + st.phone.error : `Linked with Firefox — ${st.counts.total} Anki words`);
        } catch (e) { toast('Linking failed: ' + e.message, 6000); }
        history.replaceState(null, '', location.pathname + '#settings');
      }
      boot.style.display = 'none';
      route();
      // keep in step with Firefox when the app comes back to the front
      document.addEventListener('visibilitychange', () => { if (!document.hidden) bg('phoneSync').catch(() => {}); });
    } catch (e) {
      bootMsg.textContent = 'Could not start: ' + e.message + ' — check your connection and reopen the app.';
      bar.hidden = true;
    }
  }
  start();
})();
