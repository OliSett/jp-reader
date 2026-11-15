/* Safari background: the very first script. Records that the background ran, and any load error,
 * in storage so the extension pages can show it even when the background is dead. */
(() => {
  const put = (stage, error) => { try { browser.storage.local.set({ bgStatus: { stage, error: error || '', at: Date.now() } }); } catch (e) { /* no storage */ } };
  put('scripts loading');
  if (typeof self.addEventListener !== 'function') return;
  self.addEventListener('error', e => put('script error', `${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`));
  self.addEventListener('unhandledrejection', e => put('error', String((e.reason && e.reason.message) || e.reason)));
})();
