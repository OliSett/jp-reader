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
    /** compact snapshot of Anki words: [[word, reading, status], …] */
    packWords: words => words.map(w => [w.word, w.reading || '', w.status]),
    unpackWords: rows => (rows || []).map(([word, reading, status]) => ({ word, reading, status })),
  };
})();

if (typeof module !== 'undefined') module.exports = JA;
