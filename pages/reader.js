/* E-book reader: library with whole-book coverage, and a reading view with highlighting. */
const app = document.getElementById('app');
let books = [];          // metadata list (kv 'books')
let current = null;      // { meta, book, ch }
let blobCache = new Map();
let settings = null;

const pct = v => (v === null || v === undefined ? '–' : `${Math.round(v * 10) / 10}%`);
const save = () => JA.dict.idbSet('books', books);
const metaOf = id => books.find(b => b.id === id);

async function init() {
  settings = (await bg('getState')).settings;
  books = (await JA.dict.idbGet('books')) || [];
  route();
  checkInbox();
}
window.addEventListener('hashchange', route);
function route() {
  const m = location.hash.match(/book=([^&]+)(?:&ch=(\d+))?/);
  if (m && metaOf(m[1])) openBook(m[1], m[2] !== undefined ? +m[2] : null);
  else showLibrary();
}

// ---------------- library ----------------
function showLibrary() {
  if (window.__jar) window.__jar.clearPage();
  document.body.className = 'lib';
  current = null;
  // iPhone's file picker greys out .epub when filtered, so the phone app accepts any file
  const input = h('input', { type: 'file', accept: JA.platform === 'web' ? null : '.epub', multiple: true, style: { display: 'none' }, onchange: e => addFiles([...e.target.files]) });
  const drop = h('div', { class: 'drop' }, 'Drop .epub files here, or ', h('a', { href: '#', onclick: e => { e.preventDefault(); input.click(); } }, 'choose files'), '. Books stay on this computer.', input);
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files].filter(f => /\.epub$/i.test(f.name))); });
  // books you've started first (most recently read on top), then the rest by how much you already know
  const started = b => !!b.opened || (b.pos && (b.pos.ch > 0 || b.pos.frac > 0.02));
  const byCoverage = (a, b) => (b.stats ? b.stats.coverage : -1) - (a.stats ? a.stats.coverage : -1);
  const reading = books.filter(started).sort((a, b) => (b.opened || 0) - (a.opened || 0) || byCoverage(a, b));
  const notStarted = books.filter(b => !started(b)).sort(byCoverage);
  const section = (title, list) => list.length ? [h('h2', { style: { margin: '18px 0 10px' } }, title), h('div', { class: 'books' }, list.map(bookCard))] : null;
  const list = books.length
    ? h('div', null, section('Continue reading', reading), section(reading.length ? 'Not started — most known first' : 'Your books — most known first', notStarted))
    : h('p', { class: 'hint' }, 'No books yet.');
  app.replaceChildren(h('div', { class: 'wrap' },
    h('h1', null, 'Books'),
    h('p', { class: 'sub' }, 'Read EPUBs with your Anki words highlighted, and see how much of each book you already know before you start.'),
    drop, h('div', { id: 'msg', class: 'status' }), list));
}

function bookCard(b) {
  const st = b.stats;
  const cover = b.cover ? h('img', { src: b.cover, alt: '' }) : h('div', { class: 'nocover' }, '本');
  const needLine = st ? Object.entries(st.need).map(([t, n]) => (n === null ? null : n === 0 ? `${t}%: already there` : `${t}%: learn ${n} words`)).filter(Boolean).join(' · ') : '';
  const card = h('div', { class: 'book' }, cover,
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('h3', null, b.title), h('div', { class: 'au' }, b.author || ''),
      st ? [
        h('div', { class: 'cov' }, h('b', null, pct(st.coverage)), h('span', { class: 'hint' }, 'of the running text is words you know')),
        h('div', { class: 'meter' }, h('i', { style: { width: Math.min(100, st.coverage) + '%' } })),
        h('div', { class: 'need' }, `${st.uniqueWords.toLocaleString()} different words, ${st.uniqueKnown.toLocaleString()} known · ${st.tokens >= 1000 ? Math.round(st.tokens / 1000) + 'k' : st.tokens} words long`),
        h('div', { class: 'need' }, needLine),
      ] : h('div', { class: 'hint', id: 'an-' + b.id }, b.analyzing ? 'Checking coverage…' : 'Coverage not checked yet.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { location.hash = `book=${b.id}`; } }, b.pos && b.pos.ch ? `Continue (ch. ${b.pos.ch + 1})` : 'Read'),
        st ? h('button', { class: 'btn g', onclick: () => wordsToLearn(b) }, 'Words to learn') : null,
        h('button', { class: 'btn g', onclick: () => analyze(b.id) }, st ? 'Re-check' : 'Check coverage'),
        st ? h('button', { class: 'btn g', onclick: e => toggleDetail(b, e.target.closest('.book')) }, 'Details') : null,
        h('button', { class: 'btn g', title: 'Remove from library', onclick: () => removeBook(b) }, '✕'))));
  return card;
}

function toggleDetail(b, card) {
  const next = card.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  const st = b.stats;
  const rows = st.unknown.slice(0, 40).map(w => h('tr', null,
    h('td', { style: { fontSize: '16px' } }, w.word),
    h('td', null, w.reading),
    h('td', null, (w.kanji ? w.kanji + ' — ' : '') + (w.meaning || '').slice(0, 60)),
    h('td', null, String(w.count)),
    h('td', { class: 'hint' }, w.rank ? `#${w.rank.toLocaleString()}` : '')));
  const chapters = st.chapters.filter(c => c.tokens > 3).map(c => h('div', { class: 'chap' },
    h('span', { class: 'hint' }, c.title),
    h('div', { class: 'meter' }, h('i', { style: { width: (c.coverage || 0) + '%' } })),
    h('span', null, pct(c.coverage))));
  const d = h('div', { class: 'card detail' },
    h('h2', null, 'Chapters'), chapters,
    h('h2', { style: { marginTop: '16px' } }, 'Most frequent words you don\'t know in this book'),
    h('table', null,
      h('thead', null, h('tr', null, ['Word', 'Reading', 'Meaning', 'Times in book', 'Rank'].map(x => h('th', null, x)))),
      h('tbody', null, rows)));
  card.after(d);
}

function wordsToLearn(b) {
  const items = b.stats.unknown.slice(0, 100).map(w => ({ key: w.key, word: w.word, reading: w.reading, meaning: w.meaning, kanji: w.kanji, rank: w.rank, sentence: w.sentence, surface: w.surface, status: w.status, count: w.count }));
  browser.storage.local.set({ pendingBulk: { source: b.title, items } }).then(() => browser.tabs.create({ url: browser.runtime.getURL('pages/bulk.html') }));
}

async function removeBook(b) {
  if (!confirm(`Remove “${b.title}” from your library?`)) return;
  books = books.filter(x => x.id !== b.id);
  await save();
  await JA.dict.idbSet('bookdata:' + b.id, null);
  showLibrary();
}

async function addFiles(files) {
  for (const f of files) await addBook(await f.arrayBuffer(), f.name);
}

/** Articles sent from Firefox or the iPhone bookmarklet arrive as small books. */
let inboxBusy = false;
async function checkInbox() {
  if (inboxBusy) return;
  inboxBusy = true;
  try {
    const items = await bg('inboxTake');
    for (const it of items || []) {
      const a = it.item || it;
      if (!a.text || !/[\u3040-\u30ff\u4e00-\u9fff]/.test(a.text)) continue;
      await addBook(JA.epub.fromText(a.title || 'Article', a.text, a.url || ''), a.title || 'Article', { article: a.url || true });
    }
  } catch (e) { /* not linked or offline */ }
  inboxBusy = false;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !current) checkInbox(); });

async function addBook(buf, name, extra = {}) {
  const msg = document.getElementById('msg') || document.createElement('div');
  {
    const f = { name };
    say(msg, `Opening ${f.name}…`);
    try {
      const book = await JA.epub.open(buf);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const meta = {
        id, title: book.meta.title, author: book.meta.author, vertical: book.meta.vertical, added: Date.now(),
        chapters: book.spine.map(s => ({ href: s.href, title: s.title })), cover: await coverThumb(book), pos: { ch: 0, frac: 0 }, ...extra,
      };
      await JA.dict.idbSet('bookdata:' + id, buf);
      books.push(meta);
      await save();
      say(msg, `Added “${meta.title}”.`, 'ok');
      showLibrary();
      analyze(id, book);
    } catch (e) { say(msg, `${f.name}: ${e.message}`, 'bad'); }
  }
}

async function coverThumb(book) {
  if (!book.meta.cover) return null;
  try {
    const url = URL.createObjectURL(new Blob([book.files.get(book.meta.cover)], { type: book.mime(book.meta.cover) || 'image/jpeg' }));
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas');
    const scale = 276 / img.height;
    c.width = Math.round(img.width * scale); c.height = 276;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return c.toDataURL('image/jpeg', 0.85);
  } catch { return null; }
}

async function loadBook(id) {
  const buf = await JA.dict.idbGet('bookdata:' + id);
  if (!buf) throw new Error('Book file missing. Remove it and add it again.');
  return JA.epub.open(buf);
}

/** Whole-book coverage, computed by the background with your Anki words. */
async function analyze(id, book) {
  const b = metaOf(id);
  if (!b) return;
  b.analyzing = true;
  const el = document.getElementById('an-' + id);
  if (el) el.textContent = 'Checking coverage… (a long novel takes a few seconds)';
  try {
    book = book || await loadBook(id);
    const chapters = book.spine.map(s => ({ title: s.title, text: JA.epub.chapterText(book, s.href) }));
    b.stats = await bg('analyzeBook', { chapters, source: b.title });
    b.statsAt = Date.now();
  } catch (e) {
    if (el) say(el, 'Coverage check failed: ' + e.message, 'bad');
  }
  b.analyzing = false;
  await save();
  if (!current) showLibrary();
}

// ---------------- reading ----------------
async function openBook(id, ch) {
  const meta = metaOf(id);
  if (!current || current.meta.id !== id) {
    blobCache.forEach(u => URL.revokeObjectURL(u));
    blobCache = new Map();
    current = { meta, book: await loadBook(id), ch: 0 };
    meta.opened = Date.now();
  }
  const chapter = ch === null ? (meta.pos && meta.pos.ch) || 0 : ch;
  renderReader(chapter, ch === null && meta.pos ? meta.pos.frac : 0);
}

function renderReader(ch, frac = 0) {
  const { meta, book } = current;
  ch = Math.max(0, Math.min(book.spine.length - 1, ch));
  current.ch = ch;
  document.body.className = 'reading';
  if (window.__jar) window.__jar.clearPage();
  const vertical = meta.verticalPref !== undefined ? meta.verticalPref : meta.vertical;
  const fs = meta.fontSize || 21;
  const go = n => { location.hash = `book=${meta.id}&ch=${n}`; };
  const chSel = h('select', { onchange: e => go(+e.target.value) }, book.spine.map((s, i) => h('option', { value: String(i), selected: i === ch }, s.title)));
  const hlOn = meta.highlight !== false;
  const bar = h('div', { class: 'bar' },
    h('button', { class: 'btn g', onclick: () => { location.hash = ''; } }, '← Books'),
    h('span', { class: 't', title: meta.title }, meta.title), chSel,
    h('button', { class: 'btn g', disabled: ch === 0, onclick: () => go(ch - 1) }, '‹'),
    h('button', { class: 'btn g', disabled: ch >= book.spine.length - 1, onclick: () => go(ch + 1) }, '›'),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn g', title: 'Smaller text', onclick: () => setFont(-1) }, 'A−'),
    h('button', { class: 'btn g', title: 'Larger text', onclick: () => setFont(1) }, 'A+'),
    h('button', { class: 'btn g', title: 'Vertical / horizontal text', onclick: () => { meta.verticalPref = !vertical; save(); renderReader(ch, currentFrac()); } }, vertical ? '横' : '縦'),
    h('button', { class: 'btn' + (hlOn ? '' : ' g'), onclick: () => { meta.highlight = !hlOn; save(); renderReader(ch, currentFrac()); } }, hlOn ? 'Highlighting on' : 'Highlighting off'));
  const text = h('div', { id: 'text', style: { '--fs': fs + 'px' } });
  text.style.setProperty('--fs', fs + 'px');
  text.append(JA.epub.renderChapter(book, book.spine[ch].href, document, blobCache));
  const endnav = h('div', { class: 'endnav' },
    ch > 0 ? h('button', { class: 'btn g', onclick: () => go(ch - 1) }, '‹ Previous') : null,
    ch < book.spine.length - 1 ? h('button', { class: 'btn', onclick: () => go(ch + 1) }, 'Next chapter ›') : h('span', { class: 'hint' }, 'The end.'));
  text.append(endnav);
  const page = h('div', { id: 'page', class: vertical ? 'vertical' : '' }, text);
  app.replaceChildren(bar, page);

  // internal links between chapters
  text.addEventListener('click', e => {
    const a = e.target.closest('a[data-book-href]');
    if (!a || e.target.closest('.jar-w') && (e.altKey || e.ctrlKey)) return;
    e.preventDefault();
    const [file, anchor] = a.dataset.bookHref.split('#');
    const idx = book.spine.findIndex(s => s.href === file);
    if (idx >= 0 && idx !== ch) go(idx);
    else if (anchor) { const t = text.querySelector(`[id="${CSS.escape(anchor)}"]`); if (t) t.scrollIntoView(); }
  });
  // mouse wheel scrolls sideways in vertical mode
  if (vertical) page.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { page.scrollLeft -= e.deltaY; e.preventDefault(); } }, { passive: false });
  let t = null;
  page.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(() => { meta.pos = { ch, frac: currentFrac() }; save(); }, 400); });
  requestAnimationFrame(() => {
    setFrac(frac);
    meta.pos = { ch, frac };
    save();
    if (hlOn && window.__jar) window.__jar.parsePage(text);
  });
}

function currentFrac() {
  const p = document.getElementById('page');
  if (!p) return 0;
  if (p.classList.contains('vertical')) { const max = p.scrollWidth - p.clientWidth; return max > 0 ? Math.abs(p.scrollLeft) / max : 0; }
  const max = p.scrollHeight - p.clientHeight; return max > 0 ? p.scrollTop / max : 0;
}
function setFrac(f) {
  const p = document.getElementById('page');
  if (!p || !f) return;
  if (p.classList.contains('vertical')) p.scrollLeft = -f * (p.scrollWidth - p.clientWidth);
  else p.scrollTop = f * (p.scrollHeight - p.clientHeight);
}
function setFont(d) {
  const m = current.meta;
  m.fontSize = Math.max(14, Math.min(36, (m.fontSize || 21) + d * 2));
  document.getElementById('text').style.setProperty('--fs', m.fontSize + 'px');
  save();
}

// cards made while reading name the book and chapter
window.__jarSource = () => (current ? `${current.meta.title} — ${current.book.spine[current.ch].title}` : document.title);

init();
