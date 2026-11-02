const $ = id => document.getElementById(id);
const codeFrom = v => { const m = String(v || '').match(/JPR-[A-Z0-9-]{20,}/i); return m ? m[0].toUpperCase() : String(v || '').trim(); };

async function render() {
  let st;
  try { st = await bg('getState'); } catch (e) { $('link').textContent = e.message; return; }
  const key = st.settings.syncKey, ph = st.phone || {};
  if (!key) {
    const input = h('input', { type: 'text', placeholder: 'JPR-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
    $('link').replaceChildren(
      h('p', { class: 'hint' }, 'In Firefox: JP Reader Settings → Phone → copy the sync code (or the whole link) and paste it here. Use the same code as your iPhone app.'),
      input,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: async () => {
        say($('msg'), 'Linking…');
        try { const s = await bg('setSyncKey', { key: codeFrom(input.value) }); say($('msg'), s.phone.error ? 'Linked, but: ' + s.phone.error : `Linked — ${s.counts.total} Anki words`, s.phone.error ? 'bad' : 'ok'); render(); }
        catch (e) { say($('msg'), e.message, 'bad'); }
      } }, 'Link')),
      h('div', { id: 'msg', class: 'status' }));
  } else {
    $('link').replaceChildren(
      h('p', null, ph.error ? h('span', { class: 'bad' }, ph.error) : h('span', { class: 'ok' }, '● Linked with Firefox')),
      h('p', { class: 'hint' }, `${st.counts.total.toLocaleString()} Anki words (${st.counts.known.toLocaleString()} known, ${st.counts.learning.toLocaleString()} learning) · ${st.manual} marked known`
        + (ph.at ? ` · last sync ${new Date(ph.at).toLocaleString()}` : ''), h('br'), `Code: …${key.slice(-4)}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { say($('msg2'), 'Syncing…'); await bg('phoneSync'); render(); } }, 'Sync now'),
        h('button', { class: 'btn g', onclick: async () => { if (confirm('Unlink from Firefox?')) { await bg('setSyncKey', { key: '' }); render(); } } }, 'Unlink')),
      h('div', { id: 'msg2', class: 'status' }));
  }
  $('data').replaceChildren(
    h('p', { class: 'hint' },
      st.dict ? `Dictionary: ${st.dict.entries.toLocaleString()} common words` : (st.dataProgress || 'Dictionary: downloading on first start…'), ' · ',
      st.freq ? `Frequency list: ${st.freq.entries.toLocaleString()} words` : ''),
    st.dataError ? h('p', null, h('span', { class: 'bad' }, st.dataError), ' ', h('button', { class: 'btn g', onclick: async () => { say($('data'), 'Downloading…'); try { await bg('retryData'); } catch (e) { /* shown below */ } render(); } }, 'Try again')) : null);
  if (!st.dict && !st.dataError) setTimeout(render, 1500);
}
render();
