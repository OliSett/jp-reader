const $ = id => document.getElementById(id);
const toast = t => (parent.JA_WEB && parent.JA_WEB.toast ? parent.JA_WEB.toast(t) : alert(t));

function bookmarklet(key) {
  // posts the page text straight to your sync inbox (works in Safari, which has separate storage from the home-screen app)
  const code = `(function(){var K=${JSON.stringify(key)},U=${JSON.stringify(JA.sync.URL)},A=${JSON.stringify(JA.sync.ANON)};`
    + `function T(n){var t='';for(var c=n.firstChild;c;c=c.nextSibling){if(c.nodeType==3)t+=c.nodeValue;else if(c.nodeType==1&&!/^(RT|RP|SCRIPT|STYLE|NOSCRIPT|NAV|FOOTER|BUTTON|SVG|IFRAME)$/.test(c.tagName)){var d=getComputedStyle(c).display,x=T(c);t+=/^(inline|ruby|ruby-base|inline-block|contents)$/.test(d)?x:'\\n'+x+'\\n';}}return t}`
    + `var r=document.querySelector('article,main,[role=main]')||document.body,s=T(r).replace(/[ \\t]+\\n/g,'\\n').replace(/\\n\\s*\\n+/g,'\\n').trim();`
    + `fetch(U+'/rest/v1/rpc/jp_inbox_add',{method:'POST',headers:{apikey:A,Authorization:'Bearer '+A,'Content-Type':'application/json'},body:JSON.stringify({sync_key:K,item:{title:document.title,url:location.href,text:s.slice(0,400000),at:Date.now()}})})`
    + `.then(function(x){alert(x.ok?'Sent to JP Reader. Open Books in the app.':'JP Reader: sending failed ('+x.status+')')}).catch(function(e){alert('JP Reader: this site blocks sending ('+e+')')})})();`;
  return 'javascript:' + code;
}

async function render() {
  const st = await bg('getState');
  const key = st.settings.syncKey;
  const ph = st.phone || {};

  // link
  if (!key) {
    const input = h('input', { type: 'text', placeholder: 'JPR-XXXX-XXXX-…', autocapitalize: 'characters', autocomplete: 'off' });
    $('link').replaceChildren(
      h('p', { class: 'hint' }, 'In Firefox, open JP Reader Settings → Phone → “Link a phone”, then open the link it shows on this iPhone. Or type the sync code here:'),
      input,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: async () => {
        try { await bg('setSyncKey', { key: input.value }); toast('Linked with Firefox'); render(); } catch (e) { toast(e.message); }
      } }, 'Link')));
  } else {
    $('link').replaceChildren(
      h('p', null, ph.error ? h('span', { class: 'bad' }, ph.error) : h('span', { class: 'ok' }, '● Linked with Firefox')),
      h('p', { class: 'hint' }, `${st.counts.total.toLocaleString()} Anki words (${st.counts.known.toLocaleString()} known, ${st.counts.learning.toLocaleString()} learning) · ${st.manual} marked known · ${st.sentences.toLocaleString()} saved sentences`
        + (ph.at ? ` · last sync ${new Date(ph.at).toLocaleString()}` : '')),
      h('p', { class: 'hint' }, 'Cards you make here are sent to Anki through Firefox; they appear the next time Firefox syncs while Anki is open.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { toast('Syncing…'); await bg('phoneSync'); render(); toast('Synced'); } }, 'Sync now'),
        h('button', { class: 'btn g', onclick: async () => { if (confirm('Unlink from Firefox?')) { await bg('setSyncKey', { key: '' }); render(); } } }, 'Unlink')));
  }

  // bookmarklet
  if (!key) $('bm').replaceChildren(h('p', { class: 'hint' }, 'Link with Firefox first: the bookmark sends pages through your sync space.'));
  else {
    const code = bookmarklet(key);
    $('bm').replaceChildren(
      h('ol', { class: 'hint', style: { paddingLeft: '18px', lineHeight: '1.7' } },
        h('li', null, 'Tap ', h('b', null, 'Copy bookmark code'), ' below.'),
        h('li', null, 'In Safari, open any page, tap ', h('b', null, 'Share → Add Bookmark'), ', name it “→ JP Reader”, save.'),
        h('li', null, 'Open bookmarks, tap ', h('b', null, 'Edit'), ', open the new bookmark, delete its address and paste the code.'),
        h('li', null, 'On a Japanese page, open bookmarks and tap “→ JP Reader”. The page shows up in Books.')),
      h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(code).then(() => toast('Copied. Now paste it as a bookmark address.'), () => { ta.hidden = false; ta.select(); }) }, 'Copy bookmark code'));
    const ta = h('textarea', { hidden: true, readonly: true, style: { marginTop: '10px', minHeight: '80px' } }, code);
    $('bm').append(ta);
  }

  // data
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = ` · using ${(e.usage / 1e6).toFixed(0)} MB on this phone`; } catch { /* unsupported */ }
  $('data').replaceChildren(
    h('p', { class: 'hint' }, st.dict ? `Dictionary: ${st.dict.entries.toLocaleString()} entries` : 'Dictionary: not loaded', ' · ',
      st.freq ? `Frequency list: ${st.freq.name}` : 'No frequency list', usage),
    h('label', { class: 'f' }, h('input', { type: 'checkbox', checked: st.settings.countLearning, onchange: e => bg('saveSettings', { settings: { countLearning: e.target.checked } }) }), ' Count words I\'m learning as known for coverage'),
    h('label', { class: 'f' }, 'Mark unknown words with ★ when in the top ',
      h('input', { type: 'number', value: st.settings.freqStar, style: { width: '100px', display: 'inline-block' }, onchange: e => bg('saveSettings', { settings: { freqStar: +e.target.value || 0 } }) }), ' most common'));
}
render();
