/* Safari / iPhone extension: platform flag and the lite word data.
 * The data ships inside the app (data/*.json.gz), so it needs no download and no storage:
 * Safari stops the background page whenever it likes, and each wake just re-reads the bundled files. */
var JA = globalThis.JA || (globalThis.JA = {});
JA.platform = 'safari';

JA.safariData = (() => {
  const REMOTE = 'https://olisett.github.io/jp-reader/data/';
  const state = { progress: '' };
  async function gunzipJson(res) {
    if ('DecompressionStream' in globalThis) return JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text());
    throw new Error('This iOS version is too old (needs iOS 16.4 or newer).');
  }
  async function load(name, label) {
    state.progress = `${label}: loading…`;
    try {
      const res = await fetch(browser.runtime.getURL('data/' + name));
      if (res.ok) return await gunzipJson(res);
    } catch (e) { JA.bgStatus && JA.bgStatus(`${label}: bundled copy failed (${e.message}), downloading`); }
    const res = await fetch(REMOTE + name, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${label}: download failed (${res.status})`);
    return gunzipJson(res);
  }
  let running = null;
  function ensure(E, force) {
    if (running) return running;
    running = (async () => {
      if (force || !E.dict.loaded) E.dict.load(await load('jmdict-lite.json.gz', 'Dictionary'));
      if (force || !E.freq.loaded) E.freq.load(await load('freq-lite.json.gz', 'Frequency list'));
      E.know.build((JA.bg && JA.bg.words) || [], [...E.know.manual]);
      state.progress = '';
    })().finally(() => { running = null; });
    return running;
  }
  return { ensure, get progress() { return state.progress; } };
})();
