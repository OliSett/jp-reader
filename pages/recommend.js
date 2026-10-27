const $ = id => document.getElementById(id);
const TYPES = [[1, 'Anime'], [9, 'Manga'], [4, 'Novels & light novels'], [8, 'Web novels'], [7, 'Visual novels'], [2, 'Drama']];
const BANDS = [['Comfortable', 95, 100], ['Sweet spot', 88, 95], ['Challenge', 80, 88]];
let S = null, data = null, tab = 'sweet', typeFilter = new Set();

const pct = v => Math.round(v * 10) / 10;
const color = (c, low, high) => (c >= high ? 'var(--green)' : c >= low ? 'var(--blue)' : c >= low - 8 ? 'var(--amber)' : 'var(--red)');

// ---------- most common words you don't know yet ----------
let nextList = [], nextOffset = 0;
async function loadNext(more) {
  const box = $('next');
  if (!more) { nextList = []; nextOffset = 0; }
  try {
    const add = await bg('nextWords', { limit: 50, offset: nextOffset });
    nextOffset += 50;
    nextList.push(...add.map(w => ({ ...w, sel: !more && nextList.length + add.indexOf(w) < 20 })));
    renderNext();
  } catch (e) {
    box.replaceChildren(h('h2', null, 'Most common words you don\'t know yet'),
      h('p', { class: 'hint' }, e.message + ' ', h('a', { href: '#', onclick: ev => { ev.preventDefault(); browser.runtime.openOptionsPage(); } }, 'Open Settings')));
  }
}
function renderNext() {
  const box = $('next');
  const withS = nextList.filter(w => w.sentence).length;
  const selected = () => nextList.filter(w => w.sel);
  const btnAdd = h('button', { class: 'btn', onclick: () => sendToBulk(selected(), 'Frequency list') }, 'Review & add selected');
  const btnKnown = h('button', { class: 'btn g', onclick: async () => {
    const pick = selected(); if (!pick.length) return;
    await bg('markKnown', { keys: pick.map(w => w.key), on: true });
    nextList = nextList.filter(w => !w.sel); renderNext();
  } }, 'I know these');
  box.replaceChildren(
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h2', { style: { margin: '0' } }, 'Most common words you don\'t know yet'),
      h('div', { class: 'row' }, h('button', { class: 'btn g', onclick: () => { nextList.forEach(w => (w.sel = true)); renderNext(); } }, 'Select all'),
        h('button', { class: 'btn g', onclick: () => { nextList.forEach(w => (w.sel = false)); renderNext(); } }, 'None'))),
    h('p', { class: 'hint' }, `Ranked by your frequency list, skipping everything already in Anki or marked known. ${withS} of ${nextList.length} have a sentence you've already read; the rest are tagged "needs-sentence" so Claude can write one.`),
    h('table', null,
      h('thead', null, h('tr', null, ['', 'Rank', 'Word', 'Reading', 'Meaning', 'Sentence'].map(x => h('th', null, x)))),
      h('tbody', null, nextList.map(w => h('tr', null,
        h('td', null, h('input', { type: 'checkbox', checked: w.sel, onchange: e => { w.sel = e.target.checked; } })),
        h('td', { class: 'rk' }, `#${w.rank.toLocaleString()}`),
        h('td', { style: { fontSize: '16px' } }, w.word),
        h('td', null, w.reading),
        h('td', null, (w.meaning || '').slice(0, 60)),
        h('td', { class: 'sen' }, w.sentence || '—'))))),
    h('div', { class: 'row', style: { marginTop: '10px' } }, btnAdd, btnKnown,
      h('button', { class: 'btn g', onclick: () => loadNext(true) }, 'Show 50 more')));
}

async function init() {
  loadNext();
  S = (await bg('getState')).settings;
  const sel = new Set(S.recTypes);
  $('types').replaceChildren();
  for (const [id, name] of TYPES) {
    const c = document.createElement('span');
    c.className = 'chip' + (sel.has(id) ? ' on' : '');
    c.textContent = name; c.dataset.id = id;
    c.onclick = () => c.classList.toggle('on');
    $('types').appendChild(c);
  }
  $('perType').value = String(S.recPerType); $('pages').value = String(S.recPages);
  $('low').value = S.recLow; $('high').value = S.recHigh;
  $('bands').replaceChildren();
  for (const [n, lo, hi] of BANDS) {
    const c = document.createElement('span');
    c.className = 'chip' + (lo === S.recLow && hi === S.recHigh ? ' on' : '');
    c.textContent = `${n} (${lo}–${hi}%)`;
    c.onclick = () => { $('low').value = lo; $('high').value = hi; [...$('bands').children].forEach(x => x.classList.toggle('on', x === c)); saveLevel(); };
    $('bands').appendChild(c);
  }
  $('low').onchange = $('high').onchange = saveLevel;
  const st = await bg('jitenScanStatus');
  if (st.running) poll(); else if (st.titles) { $('scanMsg').textContent = `Last scan: ${st.titles} titles, ${new Date(st.at).toLocaleString()}`; compute(); }
  else $('out').replaceChildren(h('div', { class: 'card hint' }, 'No scan yet. Pick your media and press ', h('b', null, 'Scan titles'), ' (takes about 1–3 minutes).'));
}

async function saveLevel() {
  S.recLow = +$('low').value; S.recHigh = +$('high').value;
  await bg('saveSettings', { settings: { recLow: S.recLow, recHigh: S.recHigh } });
  compute();
}

$('scan').onclick = async () => {
  const types = [...$('types').querySelectorAll('.chip.on')].map(c => +c.dataset.id);
  if (!types.length) { $('scanMsg').textContent = 'Pick at least one media type.'; return; }
  const perType = +$('perType').value, pages = +$('pages').value;
  await bg('saveSettings', { settings: { recTypes: types, recPerType: perType, recPages: pages } });
  await bg('jitenScan', { types, perType, pages });
  poll();
};

async function poll() {
  $('scan').disabled = true; $('prog').hidden = false;
  const st = await bg('jitenScanStatus');
  $('prog').max = st.total || 1; $('prog').value = st.done;
  $('scanMsg').textContent = st.error ? '' : `${st.message} ${st.total ? `(${st.done}/${st.total})` : ''}`;
  if (st.error) say($('scanMsg'), st.error, 'bad');
  if (st.running) { if (st.done && st.done % 10 === 0) compute(); setTimeout(poll, 1000); return; }
  $('scan').disabled = false; $('prog').hidden = true;
  compute();
}

async function compute() {
  data = await bg('recommendations', { low: S.recLow, high: S.recHigh, countLearning: S.countLearning });
  render();
}

function sendToBulk(items, source) {
  browser.storage.local.set({ pendingBulk: { source, items: items.map(u => ({ key: u.key, word: u.word, reading: u.reading, meaning: u.meaning, rank: u.rank, sentence: u.sentence || '', surface: u.surface || '', status: u.status })) } })
    .then(() => browser.tabs.create({ url: browser.runtime.getURL('pages/bulk.html') }));
}

function render() {
  const { low, high } = { low: S.recLow, high: S.recHigh };
  if (!data || !data.titles.length) {
    $('out').replaceChildren(h('div', { class: 'card hint' }, 'No titles analysed yet. If a scan finished but nothing shows, open Settings → Diagnostics → Test Jiten API.'));
    return;
  }
  const t = data.titles;
  const by = b => t.filter(x => x.band === b).length;
  if (tab === 'sweet' && !data.recommended.length && !render.switched) { tab = 'all'; render.switched = true; }
  const weighted = t.some(x => x.weighted);
  const stat = (n, label) => h('div', null, h('div', { class: 'big' }, String(n)), h('div', { class: 'hint' }, label));

  const summary = h('div', { class: 'card' },
    h('div', { class: 'stats' },
      stat(by('sweet'), 'titles at your level'),
      stat(by('easy'), 'easier than that'),
      stat(by('stretch'), 'just out of reach'),
      stat(data.unlocked, `more titles reach ${low}% if you learn the top 50 words below`)),
    h('p', { class: 'hint', style: { margin: '10px 0 0' } },
      `Coverage is estimated from each title's most frequent words${weighted ? ', weighted by how often they appear' : ''}, so the real figure is usually a few points lower — treat it as a ranking.`));

  // gap words
  const gaps = data.gapList.slice(0, 50);
  const gapCard = h('div', { class: 'card' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h2', { style: { margin: '0' } }, 'Words that fill your gaps'),
      h('button', { class: 'btn', id: 'gapBulk', onclick: () => sendToBulk(gaps, 'Gap words (Jiten recommendations)') }, `Review & add these ${gaps.length}`)),
    h('p', { class: 'hint' }, "Words you don't know yet that show up most across titles near your level. Learning them raises coverage on many titles at once."),
    h('table', null,
      h('thead', null, h('tr', null, ['Word', 'Reading', 'Meaning', 'Rank', 'Coverage gained', 'Appears in'].map(x => h('th', null, x)))),
      h('tbody', null, gaps.map(g => h('tr', null,
        h('td', { style: { fontSize: '16px' } }, g.word),
        h('td', null, g.reading),
        h('td', null, (g.meaning || '').slice(0, 70)),
        h('td', { class: 'rk' }, g.rank ? `#${g.rank.toLocaleString()}` : ''),
        h('td', null, `+${pct(g.gain)} pts`),
        h('td', { class: 'hint' }, `${g.titles.length} title${g.titles.length === 1 ? '' : 's'}: ${g.titles.slice(0, 3).join(', ')}${g.titles.length > 3 ? '…' : ''}`))))));

  // titles
  const tabs = [['sweet', 'At your level'], ['easy', 'Easier'], ['stretch', 'Stretch'], ['all', 'All']];
  const typesPresent = [...new Set(t.map(x => x.deck.type))].filter(x => x !== undefined);
  let list = tab === 'all' ? t.slice().sort((a, b) => b.coverage - a.coverage) : tab === 'sweet' ? data.recommended : t.filter(x => x.band === tab).sort((a, b) => b.coverage - a.coverage);
  if (typeFilter.size) list = list.filter(x => typeFilter.has(x.deck.type));
  const cards = list.slice(0, 120).map(x => titleCard(x, low, high));
  const titleSection = h('div', { class: 'card' },
    h('div', { class: 'tabs' },
      tabs.map(([k, n]) => h('span', { class: 'chip' + (k === tab ? ' on' : ''), dataset: { tab: k }, onclick: () => { tab = k; render(); } }, n)),
      h('span', { style: { flex: '1' } }),
      typesPresent.map(ty => h('span', {
        class: 'chip' + (typeFilter.has(ty) ? ' on' : ''), dataset: { type: ty },
        onclick: () => { typeFilter.has(ty) ? typeFilter.delete(ty) : typeFilter.add(ty); render(); },
      }, (TYPES.find(x => x[0] === ty) || [0, 'Type ' + ty])[1]))),
    h('div', { class: 'titles' }, cards.length ? cards : h('span', { class: 'hint' }, 'Nothing in this group.')));

  $('out').replaceChildren(summary, gapCard, titleSection);
}

function titleCard(x, low, high) {
  const d = x.deck;
  const type = (TYPES.find(t => t[0] === d.type) || [0, ''])[1];
  const meta = [type, d.difficulty !== undefined ? `difficulty ${pct(d.difficulty)}` : '', d.chars ? `${Math.round(d.chars / 1000).toLocaleString()}k chars` : ''].filter(Boolean).join(' · ');
  return h('div', { class: 't' },
    d.cover ? h('img', { src: d.cover, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div', { class: 'nm' }, d.title),
      h('div', { class: 'en' }, d.titleEn),
      h('div', { class: 'meter' }, h('i', { style: { width: Math.min(100, x.coverage) + '%', background: color(x.coverage, low, high) } })),
      h('div', { class: 'meta' }, h('b', null, `${pct(x.coverage)}%`), ` known · ${x.unknownCount} new words in its top ${x.sample}`),
      h('div', { class: 'meta' }, meta),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => sendToBulk(x.unknown.slice(0, 40), d.title) }, 'Words to learn first'),
        h('a', { class: 'btn g', href: `https://jiten.moe/decks/media/${encodeURIComponent(d.id)}/detail`, target: '_blank', rel: 'noopener' }, 'Jiten'))));
}

init();
