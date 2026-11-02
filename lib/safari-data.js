/* Safari / iPhone extension: platform flag and one-time download of the lite word data. */
var JA = globalThis.JA || (globalThis.JA = {});
JA.platform = 'safari';

JA.safariData = (() => {
  const BASE = 'https://olisett.github.io/jp-reader/data/';
  const state = { progress: '' };
  async function fetchGz(name, label) {
    const res = await fetch(BASE + name, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${label}: download failed (${res.status})`);
    state.progress = `${label}: downloading…`;
    const raw = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    state.progress = `${label}: saving…`;
    return JSON.parse(raw);
  }
  let running = null;
  function ensure(E, force) {
    if (running) return running;
    running = (async () => {
      if (force || !E.dict.loaded) {
        const d = await fetchGz('jmdict-lite.json.gz', 'Dictionary');
        await JA.dict.idbSet('jmdict', d);
        E.dict.load(d);
      }
      if (force || !E.freq.loaded) {
        const f = await fetchGz('freq-lite.json.gz', 'Frequency list');
        await JA.dict.idbSet('freq', f);
        E.freq.load(f);
      }
      E.know.build((JA.bg && JA.bg.words) || [], [...E.know.manual]);
      state.progress = '';
    })().finally(() => { running = null; });
    return running;
  }
  return { ensure, get progress() { return state.progress; } };
})();
