const $ = id => document.getElementById(id);
const LOGICAL = ['Word', 'Reading', 'Meaning', 'Sentence', 'Source'];
let S = null;
let deckList = [];
let selectedDecks = new Set();

const list = v => v.split(',').map(x => x.trim()).filter(Boolean);

function renderPhone(st) {
  const body = $('phoneBody');
  const key = st.settings.syncKey;
  if (!key) {
    body.replaceChildren(h('button', { class: 'btn', onclick: async () => { renderPhone(await bg('setSyncKey', { key: 'new' })); } }, 'Link a phone'));
    return;
  }
  const link = JA.APP_URL + '#pair=' + encodeURIComponent(key);
  const ph = st.phone || {};
  body.replaceChildren(
    h('p', null, 'On your iPhone, open this link in Safari (send it to yourself by AirDrop, Messages or e-mail), then tap ', h('b', null, 'Share → Add to Home Screen'), ':'),
    h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, link),
    h('div', { class: 'row' },
      h('button', { class: 'btn g', onclick: () => navigator.clipboard.writeText(link).then(() => say($('phoneMsg'), 'Link copied.', 'ok')) }, 'Copy link'),
      h('span', { class: 'hint' }, 'Sync code: ', h('b', null, key)),
      h('button', { class: 'btn g', onclick: async () => { say($('phoneMsg'), 'Syncing…'); renderPhone(await bg('phoneSync')); } }, 'Sync now'),
      h('button', { class: 'btn g', onclick: async () => { if (confirm('Unlink the phone? It will stop receiving your words.')) renderPhone(await bg('setSyncKey', { key: '' })); } }, 'Unlink')),
    h('div', { id: 'phoneMsg', class: 'status' },
      ph.error ? h('span', { class: 'bad' }, ph.error)
        : ph.at ? `Last sync ${new Date(ph.at).toLocaleString()} · ${ph.fromPhone || 0} cards added from the phone · ${ph.pending || 0} waiting` : 'Not synced yet.'));
}

async function load() {
  const st = await bg('getState');
  renderPhone(st);
  S = st.settings;
  $('ankiUrl').value = S.ankiUrl; $('ankiKey').value = S.ankiKey;
  $('wordFields').value = S.wordFields.join(', ');
  $('readingFields').value = S.readingFields.join(', ');
  $('matureDays').value = S.matureDays; $('suspended').value = S.suspended;
  $('countLearning').checked = S.countLearning;
  $('targetDeck').value = S.targetDeck;
  $('tags').value = S.tags.join(' ');
  $('allowDuplicates').checked = S.allowDuplicates;
  for (const k of ['unknown', 'new', 'learning', 'known']) $('c_' + k).value = S.colors[k];
  $('showKnown').checked = S.showKnown; $('watchPage').checked = S.watchPage;
  $('autoParse').value = (S.autoParse || []).join('\n');
  $('jitenKey').value = S.jitenKey;
  $('freqStar').value = S.freqStar;
  if (st.freq) say($('freqStatus'), `Loaded: ${st.freq.name} — ${st.freq.entries.toLocaleString()} words`, 'ok');
  selectedDecks = new Set(S.decks);
  renderChecklist(st);
  if (st.dict) say($('dictStatus'), `Loaded: ${st.dict.entries.toLocaleString()} entries (${st.dict.date || st.dict.version})`, 'ok');
  connect(true);
}

function renderChecklist(st) {
  const item = (ok, ...text) => h('div', null, ok ? h('span', { class: 'ok' }, '✔') : h('span', { class: 'bad' }, '○'), ' ', ...text);
  $('checklist').replaceChildren(
    h('h2', null, 'Status'),
    item(st.ankiOk, st.ankiOk ? 'Anki connected' : 'Anki not connected', !st.ankiOk && st.ankiError ? [' — ', h('span', { class: 'hint' }, st.ankiError)] : null),
    item(st.settings.decks.length, st.settings.decks.length ? `Using decks: ${st.settings.decks.join(', ')}` : 'No decks selected'),
    item(!!st.dict, st.dict ? 'Dictionary imported' : 'Dictionary not imported'),
    item(!!st.freq, st.freq ? `Frequency list: ${st.freq.name}` : 'No frequency list (optional, recommended)'),
    item(st.sharedAt, st.sharedAt ? `Shared with the Claude connector via Anki (${st.sentences.toLocaleString()} saved sentences)` : 'Not yet shared with the Claude connector (happens on sync)'),
    item(st.counts.total > 0, `${st.counts.total} words read from Anki (${st.counts.known} known, ${st.counts.learning} learning, ${st.counts.new} new${st.dict && st.counts.unmatched ? `, ${st.counts.unmatched} not found in the dictionary` : ''})`));
}

async function connect(quiet) {
  if (!quiet) await save(false);
  $('connStatus').textContent = 'Connecting… (check Anki for a pop-up)';
  try {
    deckList = await bg('ankiDecks');
    say($('connStatus'), 'Connected', 'ok');
    renderDecks();
    $('deckList').replaceChildren(...deckList.map(d => h('option', { value: d })));
    const models = await bg('ankiModels');
    const own = 'JP Reader Vocab';
    $('noteType').replaceChildren(
      h('option', { value: own }, `${own} (made for this extension — created automatically)`),
      ...models.filter(m => m !== own).map(m => h('option', { value: m }, m)));
    $('noteType').value = S.noteType || own;
    if (!$('noteType').value) $('noteType').value = own;
    renderFieldMap();
  } catch (e) {
    say($('connStatus'), e.message, 'bad');
  }
}

function renderDecks() {
  $('decks').replaceChildren();
  for (const d of deckList) {
    const c = document.createElement('span');
    c.className = 'chip' + (selectedDecks.has(d) ? ' on' : '');
    c.textContent = d;
    c.onclick = () => { selectedDecks.has(d) ? selectedDecks.delete(d) : selectedDecks.add(d); renderDecks(); };
    $('decks').appendChild(c);
  }
}

async function renderFieldMap() {
  const m = $('noteType').value;
  const own = m === 'JP Reader Vocab';
  $('mapWrap').hidden = own;
  if (own) return;
  let fields = [];
  try { fields = await bg('ankiModelFields', { name: m }); } catch { /* ignore */ }
  const guess = (logical) => {
    const saved = S.noteType === m && S.fieldMap && S.fieldMap[logical];
    if (saved) return saved;
    const pats = { Word: /^(expression|word|vocab|front|kanji|japanese)/i, Reading: /reading|furigana|kana/i, Meaning: /meaning|english|definition|back|gloss/i, Sentence: /sentence/i, Source: /source|notes/i };
    return fields.find(f => pats[logical].test(f)) || '';
  };
  $('fieldMap').replaceChildren(...LOGICAL.map(l => h('div', null, h('span', { class: 'hint' }, l),
    h('select', { dataset: { l } }, h('option', { value: '' }, '— skip —'), ...fields.map(f => h('option', { value: f }, f))))));
  $('fieldMap').querySelectorAll('select').forEach(s => { s.value = guess(s.dataset.l); });
}
$('noteType').onchange = renderFieldMap;

function collect() {
  const fieldMap = {};
  $('fieldMap').querySelectorAll('select').forEach(s => { fieldMap[s.dataset.l] = s.value; });
  return {
    ankiUrl: $('ankiUrl').value.trim() || JA.DEFAULTS.ankiUrl,
    ankiKey: $('ankiKey').value.trim(),
    decks: [...selectedDecks],
    wordFields: list($('wordFields').value),
    readingFields: list($('readingFields').value),
    matureDays: Math.max(1, +$('matureDays').value || 21),
    suspended: $('suspended').value,
    countLearning: $('countLearning').checked,
    targetDeck: $('targetDeck').value.trim() || 'Japanese',
    noteType: $('noteType').value || 'JP Reader Vocab',
    fieldMap,
    tags: $('tags').value.split(/\s+/).filter(Boolean),
    allowDuplicates: $('allowDuplicates').checked,
    colors: { unknown: $('c_unknown').value, new: $('c_new').value, learning: $('c_learning').value, known: $('c_known').value },
    showKnown: $('showKnown').checked,
    watchPage: $('watchPage').checked,
    autoParse: $('autoParse').value.split('\n').map(x => x.trim()).filter(Boolean),
    jitenKey: $('jitenKey').value.trim(),
    freqStar: Math.max(0, +$('freqStar').value || 0),
  };
}

async function save(sync = true) {
  $('saveStatus').textContent = 'Saving…';
  try {
    await bg('saveSettings', { settings: collect() });
    S = { ...S, ...collect() };
    if (sync && S.decks.length) {
      $('saveStatus').textContent = 'Reading your words from Anki…';
      await bg('refreshAnki');
    }
    const st = await bg('getState');
    renderChecklist(st);
    $('saveStatus').replaceChildren(h('span', { class: 'ok' }, 'Saved.'), st.counts.total ? ` ${st.counts.total} words from Anki.` : '');
  } catch (e) { say($('saveStatus'), e.message, 'bad'); }
}

$('connect').onclick = () => connect(false);
$('save').onclick = () => save(true);

$('detect').onclick = async () => {
  if (!selectedDecks.size) { $('fields').hidden = false; $('fields').textContent = 'Select at least one deck first.'; return; }
  try {
    const f = await bg('ankiSampleFields', { decks: [...selectedDecks] });
    $('fields').hidden = false;
    $('fields').textContent = Object.entries(f).map(([k, v]) => `${k.padEnd(22)} e.g. ${v}`).join('\n') || 'No notes found.';
  } catch (e) { $('fields').hidden = false; $('fields').textContent = e.message; }
};

$('dictFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const set = (t, cls) => say($('dictStatus'), t, cls);
  try {
    const buf = await file.arrayBuffer();
    const info = await JA.dict.importFile(buf, file.name, t => set(t));
    set('Loading into the extension…');
    await bg('reloadDictionary');
    set(`Imported ${info.entries.toLocaleString()} entries.`, 'ok');
    renderChecklist(await bg('getState'));
  } catch (err) { set('Import failed: ' + err.message, 'bad'); }
};

$('freqFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  say($('freqStatus'), 'Reading…');
  try {
    const data = await JA.freq.parseFile(await file.arrayBuffer(), file.name);
    if (data.name === 'Frequency list (CSV)' || data.name === 'Frequency list') data.name = file.name.replace(/\.[^.]+$/, '');
    await JA.dict.idbSet('freq', data);
    const st = await bg('reloadFrequency');
    say($('freqStatus'), `Imported ${st.freq.name}: ${st.freq.entries.toLocaleString()} words`, 'ok');
    renderChecklist(st);
  } catch (err) { say($('freqStatus'), 'Import failed: ' + err.message, 'bad'); }
};
$('freqJiten').onclick = async () => {
  say($('freqStatus'), 'Downloading from Jiten…');
  try {
    const st = await bg('downloadJitenFrequency');
    say($('freqStatus'), `Loaded ${st.freq.name}: ${st.freq.entries.toLocaleString()} words`, 'ok');
    renderChecklist(st);
  } catch (err) { say($('freqStatus'), err.message, 'bad'); }
};

$('testJiten').onclick = async () => {
  $('diag').hidden = false; $('diag').textContent = 'Calling api.jiten.moe…';
  try { $('diag').textContent = JSON.stringify(await bg('jitenDiagnostics'), null, 2); }
  catch (e) { $('diag').textContent = 'Error: ' + e.message; }
};

load();
