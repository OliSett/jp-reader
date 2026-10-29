/* Sync between the Firefox extension and the phone app through the jp-reader-sync Supabase project.
 * Everything is addressed by a private sync key; the server only stores sha256(key). */
var JA = globalThis.JA || (globalThis.JA = {});

JA.sync = (() => {
  const URL_ = 'https://xpilndkmyysabeqrtine.supabase.co';
  const ANON = 'sb_publishable_0N2UTJv2w4qCmnb6KElOew_8BS1Rn5c';
  let key = '';

  const configure = c => { key = (c && c.syncKey) || ''; };
  const enabled = () => key.length >= 20;

  /** 120 random bits as 24 readable characters, e.g. JPR-7K2M-Q9XD-… */
  function newKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const chars = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
    return 'JPR-' + chars.match(/.{4}/g).join('-');
  }
  const normalize = k => String(k || '').trim().toUpperCase().replace(/\s+/g, '');

  async function rpc(fn, args) {
    if (!enabled()) throw new Error('Phone sync is not set up.');
    const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_key: key, ...args }),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message || text; } catch { /* plain text */ }
      throw new Error(`Sync failed (${res.status}): ${msg}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // ---------- shared state: slimmed, deterministic, gzip-compressed ----------
  const toB64 = u8 => { let b = ''; for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(b); };
  const fromB64 = s => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  async function streamBytes(u8, stream) {
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
  }

  /** Only what the other device needs: marked-known words and the best sentence per word. */
  function slimShared(manualKnown, bank) {
    const keys = Object.keys(bank || {}).sort();
    const slimBank = {};
    for (const k of keys) {
      const e = bank[k] && bank[k][0];
      if (e && e.s) slimBank[k] = [{ s: e.s, w: e.w || '', src: (e.src || '').slice(0, 90), t: e.t || 0 }];
    }
    return { manualKnown: [...new Set(manualKnown || [])].sort(), sentenceBank: slimBank };
  }

  /** -> { json, data } where data is what gets stored ({v:2, z:<base64 gzip>}) */
  async function packShared(manualKnown, bank) {
    const json = JSON.stringify(slimShared(manualKnown, bank));
    const z = await streamBytes(new TextEncoder().encode(json), new CompressionStream('gzip'));
    return { json, data: { v: 2, z: toB64(z) } };
  }
  async function unpackShared(data) {
    if (!data) return { manualKnown: [], sentenceBank: {} };
    if (data.v === 2 && data.z) return JSON.parse(new TextDecoder().decode(await streamBytes(fromB64(data.z), new DecompressionStream('gzip'))));
    return { manualKnown: data.manualKnown || [], sentenceBank: data.sentenceBank || {} }; // version 1 (uncompressed)
  }
  async function digest(text) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return toB64(new Uint8Array(h)).slice(0, 22);
  }

  return {
    configure, enabled, newKey, normalize,
    put: (kind, data) => rpc('jp_put', { kind, data }),
    get: (kinds, since = null) => rpc('jp_get', { kinds, since }),
    times: () => rpc('jp_times', {}),
    queueAdd: items => rpc('jp_queue_add', { items }),
    queuePending: () => rpc('jp_queue_pending', {}),
    queueDone: ids => rpc('jp_queue_done', { ids }),
    inboxAdd: item => rpc('jp_inbox_add', { item }),
    inboxTake: () => rpc('jp_inbox_take', {}),
    URL: URL_, ANON,
    packShared, unpackShared, digest,
    /** compact snapshot of Anki words: [[word, reading, status], …] */
    packWords: words => words.map(w => [w.word, w.reading || '', w.status]),
    unpackWords: rows => (rows || []).map(([word, reading, status]) => ({ word, reading, status })),
  };
})();

if (typeof module !== 'undefined') module.exports = JA;
