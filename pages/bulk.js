const $ = id => document.getElementById(id);
let rows = []; // {key, word, reading, meaning, sentence, surface, count, status, sel, done}
let settings = null;

const shown = () => {
  const on = new Set([...document.querySelectorAll('.filters input:checked')].map(i => +i.dataset.st));
  const list = rows.filter(r => on.has(Math.min(r.status, 3)) || r.pinned);
  const by = $('sort').value;
  if (by === 'rank') return list.slice().sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  if (by === 'count') return list.slice().sort((a, b) => b.count - a.count);
  return list;
};

function render() {
  const list = shown();
  $('results').hidden = !rows.length;
  $('count').textContent = `${list.length} word${list.length === 1 ? '' : 's'}`;
  const tb = $('rows');
  tb.replaceChildren();
  for (const r of list.slice(0, 1500)) {
    const field = f => h('input', { type: 'text', value: r[f] || '', oninput: e => { r[f] = e.target.value; } });
    tb.append(h('tr', { class: r.done ? 'done' : null },
      h('td', null, h('input', { type: 'checkbox', checked: r.sel, disabled: r.done, onchange: e => { r.sel = e.target.checked; buttons(); } })),
      h('td', { class: 'w' }, field('word')),
      h('td', null, field('reading')),
      h('td', { class: 'm' }, field('meaning')),
      h('td', { class: 'sen' }, field('sentence')),
      h('td', null, String(r.count)),
      h('td', { class: 'rk' }, r.rank ? `#${r.rank.toLocaleString()}` : ''),
      h('td', null, h('span', { class: 'pill s' + r.status }, r.done ? 'Added' : ST_LABEL[r.status]))));
  }
  buttons();
}
function buttons() {
  const n = rows.filter(r => r.sel && !r.done).length;
  const ns = rows.filter(r => r.sel && !r.done && !(r.sentence || '').trim()).length;
  $('noSent').textContent = ns ? `${ns} selected word${ns === 1 ? ' has' : 's have'} no sentence yet. If you've read it somewhere with the extension on, a saved sentence is used; otherwise the card is tagged "needs-sentence" and Claude can write one through the connector.` : '';
  $('add').disabled = !n; $('known').disabled = !n;
  $('add').textContent = n ? `Add ${n} to Anki` : 'Add to Anki';
}

$('go').onclick = async () => {
  const text = $('input').value.trim();
  if (!text) return;
  $('msg').textContent = 'Working…';
  const mode = document.querySelector('input[name=mode]:checked').value;
  try {
    const res = mode === 'text' ? await bg('analyzeText', { text, source: $('source').value }) : await bg('lookupWords', { words: text.split(/\n+/) });
    $('sort').value = mode === 'text' ? 'count' : 'none';
    rows = res.map(r => ({ ...r, sel: false, pinned: mode === 'list' }));
    const st = await bg('getState');
    if (st.dict) say($('msg'), `Found ${rows.length} distinct words.`);
    else say($('msg'), 'No dictionary imported — only words already in your Anki are recognised and meanings are empty. Import JMdict in Settings.', 'warn');
    render();
  } catch (e) { say($('msg'), e.message, 'bad'); }
};
document.querySelectorAll('.filters input').forEach(i => (i.onchange = render));
$('sort').onchange = render;
$('all').onclick = () => { shown().forEach(r => { if (!r.done) r.sel = true; }); render(); };
$('none').onclick = () => { rows.forEach(r => (r.sel = false)); render(); };
$('top').onclick = () => { rows.forEach(r => (r.sel = false)); shown().filter(r => !r.done).slice(0, 20).forEach(r => (r.sel = true)); render(); };

$('add').onclick = async () => {
  const pick = rows.filter(r => r.sel && !r.done);
  const deck = $('deck').value.trim();
  if (deck && deck !== settings.targetDeck) await bg('saveSettings', { settings: { targetDeck: deck } });
  let added = 0, noSent = 0, queued = false; const failed = [];
  for (let i = 0; i < pick.length; i += 100) {
    const part = pick.slice(i, i + 100);
    $('addMsg').textContent = `Adding ${Math.min(i + 100, pick.length)} / ${pick.length}…`;
    try {
      const r = await bg('addCards', { items: part.map(p => ({ word: p.word, reading: p.reading, meaning: p.meaning, kanji: p.kanji, sentence: p.sentence, surface: p.surface, source: $('source').value })) });
      added += r.added; noSent += r.noSentence || 0; queued = queued || r.queued; failed.push(...r.failed);
      const bad = new Set(r.failed.map(f => f.word));
      part.forEach(p => { if (!bad.has(p.word)) { p.done = true; p.sel = false; p.status = 1; } });
    } catch (e) { say($('addMsg'), e.message, 'bad'); render(); return; }
  }
  const skipped = failed.length ? ` ${failed.length} skipped: ${failed.slice(0, 5).map(f => `${f.word} (${f.reason})`).join(', ')}${failed.length > 5 ? '…' : ''}` : '';
  const verb = queued ? `Sent ${added} card${added === 1 ? '' : 's'} to Anki — Firefox adds them on its next sync.` : `Added ${added} card${added === 1 ? '' : 's'}.`;
  $('addMsg').replaceChildren(h('span', { class: 'ok' }, verb), skipped, noSent ? ` ${noSent} tagged needs-sentence.` : '');
  render();
};
$('known').onclick = async () => {
  const pick = rows.filter(r => r.sel && !r.done);
  await bg('markKnown', { keys: pick.map(p => p.key), on: true });
  pick.forEach(p => { p.status = 4; p.sel = false; });
  $('addMsg').textContent = `Marked ${pick.length} as known.`;
  render();
};

(async () => {
  settings = (await bg('getState')).settings;
  $('deck').value = settings.targetDeck;
  // words handed over from the Recommendations page
  const { pendingBulk } = await browser.storage.local.get('pendingBulk');
  if (pendingBulk && pendingBulk.items && pendingBulk.items.length) {
    await browser.storage.local.remove('pendingBulk');
    rows = pendingBulk.items.map(it => ({ count: 1, status: 0, ...it, sel: true, pinned: true }));
    $('source').value = pendingBulk.source || 'Recommendations';
    $('sort').value = 'none';
    $('msg').textContent = `${rows.length} words from Recommendations — edit anything, then add.`;
    render();
  }
})();
