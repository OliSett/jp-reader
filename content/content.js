/* Content script: colours Japanese words by what you know in Anki, shows a word popup
 * and a side panel with coverage and bulk card adding. */
(() => {
  if (window.__jarLoaded) return;
  window.__jarLoaded = true;

  const ST = ['unknown', 'new', 'learning', 'known', 'known'];
  const ST_LABEL = ['Not in Anki', 'In Anki (new)', 'Learning', 'Known', 'Marked known'];
  const JP = /[぀-ヿ㐀-䶿一-鿿豈-﫿々]/;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'RT', 'RP', 'SVG', 'CODE', 'PRE', 'IFRAME', 'CANVAS', 'TEMPLATE']);
  const BLOCK = 'p,div,li,td,th,h1,h2,h3,h4,h5,h6,article,section,blockquote,dd,dt,figcaption,body';

  /** Safe DOM builder: text is inserted as text, never parsed as HTML. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (['checked', 'disabled', 'type', 'title'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  let settings = null;
  let active = false;
  let observer = null;
  const words = new Map();   // key -> {w, r, g, st, count, el, sel}
  const spans = new Map();   // key -> Set<span>
  let ui = null;

  const send = (msg) => browser.runtime.sendMessage(msg).then(res => {
    if (!res) throw new Error('No response from the extension');
    if (!res.ok) throw new Error(res.error);
    return res.r;
  });

  async function loadSettings() {
    const { settings: s } = await browser.storage.local.get('settings');
    settings = Object.assign({ colors: {}, watchPage: true, showKnown: false, autoParse: [], targetDeck: 'Japanese' }, s || {});
    applyStyle();
  }

  // ---------- page styling ----------
  function applyStyle() {
    let st = document.getElementById('jar-style');
    if (!st) { st = document.createElement('style'); st.id = 'jar-style'; (document.head || document.documentElement).appendChild(st); }
    const c = Object.assign({ unknown: '#e5484d', new: '#3e8ef7', learning: '#f5a524', known: '#2fb26b' }, settings.colors);
    st.textContent = `
      .jar-w{cursor:pointer;border-radius:2px;transition:background .15s}
      .jar-w:hover{background:rgba(127,127,127,.18)}
      .jar-unknown{text-decoration:underline 2px ${c.unknown};text-underline-offset:3px;background:${c.unknown}14}
      .jar-new{text-decoration:underline 2px ${c.new};text-underline-offset:3px}
      .jar-learning{text-decoration:underline dotted 2px ${c.learning};text-underline-offset:3px}
      .jar-known{${settings.showKnown ? `text-decoration:underline 1px ${c.known}88;text-underline-offset:3px` : ''}}
      .jar-unknown.jar-hot{text-decoration-thickness:3px;background:${c.unknown}22}
      .jar-sel{outline:2px solid ${c.new};outline-offset:1px;background:${c.new}22}
      .jar-off .jar-w{text-decoration:none!important;background:none!important;outline:0!important}`;
  }

  // ---------- text collection ----------
  function textNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !JP.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentElement; p; p = p.parentElement) {
          if (SKIP_TAGS.has(p.tagName) || p.isContentEditable || p.classList.contains('jar-w') || p.id === 'jar-host') return NodeFilter.FILTER_REJECT;
          if (p === root) break;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n; while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // Inline tags never break a word: 大<rt>だい</rt>丈<rt>じょう</rt>夫 or 食<rt>た</rt>べる are read as one text.
  const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD', 'LABEL', 'MARK', 'NOBR',
    'Q', 'RB', 'RTC', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR']);
  function blockOf(n) {
    let p = n.parentElement;
    while (p && p !== document.body && INLINE.has(p.tagName)) p = p.parentElement;
    return p || document.body;
  }

  /** Group text nodes by paragraph and rebuild each paragraph's text (without furigana). */
  function segments(nodes) {
    const groups = new Map();
    for (const n of nodes) {
      const b = blockOf(n);
      if (!groups.has(b)) groups.set(b, new Set());
      groups.get(b).add(n);
    }
    const segs = [];
    for (const [block, set] of groups) {
      let text = '';
      const parts = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(x) {
          if (x.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
          if (x.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
          if (SKIP_TAGS.has(x.tagName) || x.id === 'jar-host') return NodeFilter.FILTER_REJECT;
          if (!INLINE.has(x.tagName)) return NodeFilter.FILTER_REJECT; // nested paragraph: its own segment
          return NodeFilter.FILTER_SKIP;
        },
      });
      let x;
      while ((x = walker.nextNode())) {
        if (x.nodeType === 1) { text += '\n'; continue; }
        if (set.has(x)) parts.push({ node: x, start: text.length, end: text.length + x.nodeValue.length });
        text += x.nodeValue;
      }
      if (parts.length) segs.push({ text, parts });
    }
    return segs;
  }

  let tokenSeq = 0;
  async function processNodes(nodes) {
    const segs = segments(nodes.filter(n => n.isConnected));
    let i = 0;
    while (i < segs.length) {
      // batches of about 20k characters
      const batch = [];
      let size = 0;
      while (i < segs.length && (size < 20000 || !batch.length)) { batch.push(segs[i]); size += segs[i].text.length; i++; }
      const { results, words: info } = await send({ type: 'tokenize', texts: batch.map(sg => sg.text) });
      for (const [k, v] of Object.entries(info)) if (!words.has(k)) words.set(k, { ...v, count: 0, el: null, sel: false });
      batch.forEach((sg, j) => {
        const toks = results[j];
        const tids = toks.map(() => ++tokenSeq);
        for (const part of sg.parts) {
          if (!part.node.isConnected) continue;
          const pieces = [];
          toks.forEach(([s, e, key], ti) => {
            if (e <= part.start || s >= part.end) return;
            pieces.push([Math.max(s, part.start) - part.start, Math.min(e, part.end) - part.start, key, s >= part.start, (s < part.start || e > part.end) ? tids[ti] : 0]);
          });
          wrap(part.node, pieces);
        }
      });
      renderPanel();
      bankNewSentences();
    }
  }

  /** pieces: [start, end, key, isFirstPieceOfWord] within this text node */
  function wrap(node, pieces) {
    if (!pieces.length || !node.parentNode) return;
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [s, e, key, head, tid] of pieces) {
      if (s > pos) frag.appendChild(document.createTextNode(text.slice(pos, s)));
      const w = words.get(key);
      const sp = document.createElement('span');
      sp.className = 'jar-w jar-' + ST[w.st] + (w.sel ? ' jar-sel' : '') + (isHot(w) ? ' jar-hot' : '');
      sp.dataset.k = key;
      if (tid) sp.dataset.t = tid;
      sp.textContent = text.slice(s, e);
      frag.appendChild(sp);
      if (head) { w.count++; if (!w.el) w.el = sp; }
      if (!spans.has(key)) spans.set(key, new Set());
      spans.get(key).add(sp);
      pos = e;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }

  /** Where a card came from: the page, or what the hosting page (video player, reader) says. */
  function sourceFor(el) {
    if (window.__jarSource) { try { return window.__jarSource(el); } catch { /* fall through */ } }
    return `${document.title} — ${location.href}`;
  }

  const isHot = w => w.f && w.f <= (settings.freqStar || 10000) && w.st === 0;
  const fmtRank = f => (f ? `#${f.toLocaleString()}` : '');

  /** Remember the sentence each not-yet-known word appeared in, so later cards can use it. */
  const banked = new Set();
  let bankTimer = null;
  function bankNewSentences() {
    clearTimeout(bankTimer);
    bankTimer = setTimeout(() => {
      const items = [];
      for (const [k, w] of words) {
        if (banked.has(k) || !w.el || w.st >= 3 || banked.size >= 400) continue;
        banked.add(k);
        const sentence = sentenceFor(w.el);
        if (sentence && sentence.length >= 4) items.push({ key: k, sentence, surface: fullSurface(w.el), source: sourceFor(w.el) });
      }
      if (items.length) send({ type: 'bankSentences', items }).catch(() => {});
    }, 1500);
  }

  async function parsePage(root = document.body) {
    if (!settings) await loadSettings();
    active = true;
    document.documentElement.classList.remove('jar-off');
    buildUI();
    ui.status.textContent = 'Parsing…';
    try {
      await processNodes(textNodes(root));
      ui.status.textContent = '';
    } catch (e) { ui.status.textContent = e.message; }
    if (settings.watchPage && !observer) {
      let pending = new Set(), timer = null;
      observer = new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType === 3) { if (n.parentElement && !n.parentElement.closest('.jar-w,#jar-host')) pending.add(n); }
          else if (n.nodeType === 1 && !n.closest('#jar-host') && !n.classList.contains('jar-w')) textNodes(n).forEach(t => pending.add(t));
        }
        if (pending.size && !timer) timer = setTimeout(() => {
          const list = [...pending].filter(t => t.isConnected && !(t.parentElement && t.parentElement.closest('.jar-w')));
          pending = new Set(); timer = null;
          processNodes(list).catch(() => {});
        }, 400);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: false });
    }
  }

  function clearPage() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    for (const set of spans.values()) for (const sp of set) {
      if (sp.isConnected) sp.replaceWith(document.createTextNode(sp.textContent));
    }
    document.body.normalize();
    spans.clear(); words.clear();
    hideTip();
    if (ui) { ui.host.remove(); ui = null; }
  }

  // ---------- statuses ----------
  function setStatus(key, st) {
    const w = words.get(key); if (!w) return;
    w.st = st;
    for (const sp of spans.get(key) || []) {
      sp.classList.remove('jar-unknown', 'jar-new', 'jar-learning', 'jar-known');
      sp.classList.add('jar-' + ST[st]);
      sp.classList.toggle('jar-hot', isHot(w));
    }
  }
  async function refreshStatuses() {
    if (!words.size) return;
    const map = await send({ type: 'statuses', keys: [...words.keys()] });
    for (const [k, st] of Object.entries(map)) setStatus(k, st);
    hideTip();
    renderPanel();
    if (window.__jarAfterStatus) window.__jarAfterStatus();
  }
  function toggleSelect(key, on) {
    const w = words.get(key); if (!w) return;
    w.sel = on === undefined ? !w.sel : on;
    for (const sp of spans.get(key) || []) sp.classList.toggle('jar-sel', w.sel);
  }

  /** Visible text of a paragraph without furigana (<rt>/<rp>). */
  function blockText(block) {
    let t = '';
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: x => (x.nodeType === 1 ? (x.tagName === 'RT' || x.tagName === 'RP' || x.tagName === 'SCRIPT' || x.tagName === 'STYLE' || x.id === 'jar-host' ? NodeFilter.FILTER_REJECT : (x.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)) : NodeFilter.FILTER_ACCEPT),
    });
    let x;
    while ((x = w.nextNode())) t += x.nodeType === 1 ? '\n' : x.nodeValue;
    return t;
  }

  /** Readable text of a page section: paragraphs on their own lines, no furigana, no scripts. */
  function blockTextDeep(root) {
    let t = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: x => (x.nodeType === 1
        ? (/^(RT|RP|SCRIPT|STYLE|NOSCRIPT|NAV|FOOTER|BUTTON|SVG)$/.test(x.tagName) || x.id === 'jar-host' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
        : NodeFilter.FILTER_ACCEPT),
    });
    let x;
    while ((x = w.nextNode())) {
      if (x.nodeType === 3) t += x.nodeValue;
      else if (!INLINE.has(x.tagName)) t += '\n';
    }
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  }

  function sentenceFor(el) {
    if (!el) return '';
    const block = blockOf(el.firstChild || el);
    const text = blockText(block).replace(/[ \t\u3000]+/g, ' ');
    const surface = fullSurface(el);
    const parts = text.match(/[^。！？!?\n]+[。！？!?」』]*/g) || [text];
    const hit = parts.find(p => p.includes(surface)) || parts.find(p => p.includes(el.textContent)) || text;
    return hit.trim().slice(0, 220);
  }


  async function addToAnki(keys) {
    const items = keys.map(k => {
      const w = words.get(k);
      return { key: k, word: w.w, reading: w.r, meaning: w.g, kanji: w.k, sentence: sentenceFor(w.el), surface: w.el ? fullSurface(w.el) : w.w, source: sourceFor(w.el) };
    });
    ui.status.textContent = `Adding ${items.length}…`;
    try {
      const r = await send({ type: 'addCards', items });
      keys.forEach(k => toggleSelect(k, false));
      await refreshStatuses();
      ui.status.textContent = (r.queued ? `Sent ${r.added} card${r.added === 1 ? '' : 's'} to Anki (added when Firefox next syncs)` : `Added ${r.added} card${r.added === 1 ? '' : 's'}`)
        + (r.noSentence ? ` (${r.noSentence} without a sentence, tagged needs-sentence)` : '') + (r.failed.length ? ` · ${r.failed.length} skipped (${[...new Set(r.failed.map(f => f.reason))].join(', ')})` : '');
    } catch (e) { ui.status.textContent = e.message; }
  }
  async function markKnown(keys) {
    await send({ type: 'markKnown', keys, on: true });
    keys.forEach(k => toggleSelect(k, false));
    await refreshStatuses();
  }

  // ---------- UI (shadow DOM) ----------
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}
    .panel{position:fixed;right:14px;bottom:14px;width:320px;max-height:70vh;display:flex;flex-direction:column;background:#1d1f23;color:#eee;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;z-index:2147483647;overflow:hidden}
    .panel.min .body{display:none}
    .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#26292f;cursor:pointer}
    .hd b{font-size:15px}.hd .sp{flex:1}
    .x{background:none;border:0;color:#aaa;font-size:16px;cursor:pointer;padding:0 4px}
    .body{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px}
    .bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:#333}
    .bar i{display:block;height:100%}
    .nums{display:flex;justify-content:space-between;color:#bbb;font-size:12px}
    .big{font-size:26px;font-weight:700}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    button.b{background:#3e8ef7;color:#fff;border:0;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer}
    button.g{background:#3a3e46}
    button.b:disabled{opacity:.5;cursor:default}
    .list{display:flex;flex-direction:column;gap:2px;max-height:38vh;overflow:auto;border-top:1px solid #333;padding-top:6px}
    .it{display:grid;grid-template-columns:18px 1fr auto;gap:6px;align-items:start;padding:4px 2px;border-radius:6px;cursor:pointer}
    .it:hover{background:#2a2d33}
    .w{font-size:15px}.r{color:#aaa;font-size:11px;margin-left:4px}.m{color:#bbb;font-size:11px;grid-column:2/4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .c{color:#888;font-size:11px}
    .status{color:#9fd3a0;font-size:12px;min-height:14px}
    .tabs{display:flex;gap:4px}.tabs button{flex:1}
    .tabs .on{background:#3e8ef7}
    @media (max-width:600px){
      .panel{left:8px;right:8px;width:auto;bottom:8px;max-height:55vh;font-size:14px}
      .it{padding:7px 2px}
      button.b{padding:8px 12px;font-size:13px}
    }
    .tip{position:fixed;z-index:2147483647;width:min(280px,calc(100vw - 16px));background:#1d1f23;color:#eee;border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;display:none}
    .tip .w{font-size:22px}.tip .r{font-size:13px}.tip .m{white-space:normal;font-size:13px;color:#ddd;margin:6px 0}
    .pill{display:inline-block;font-size:11px;border-radius:9px;padding:1px 8px;margin-top:4px}
    .s0{background:#e5484d33;color:#ff9b9e}.s1{background:#3e8ef733;color:#9cc4ff}.s2{background:#f5a52433;color:#ffd38a}.s3,.s4{background:#2fb26b33;color:#8fe0b2}
    input[type=checkbox]{margin:3px 0 0}
    .kh{color:#9aa3ad;font-size:12px;margin-top:2px}.star{color:#f5c542}.fq{color:#7d8590;margin-left:4px}.fqp{background:#ffffff14;color:#cfd3da;margin-left:6px}
  `;

  function buildUI() {
    if (ui) return;
    const host = document.createElement('div');
    host.id = 'jar-host';
    const root = host.attachShadow({ mode: 'open' });
    const tab = (f, label, on) => h('button', { class: 'b g' + (on ? ' on' : ''), dataset: { f } }, label);
    root.append(
      h('style', null, CSS),
      h('div', { class: 'panel' },
        h('div', { class: 'hd' }, h('b', null, '読'), h('span', null, 'Reader'), h('span', { class: 'sp' }), h('span', { class: 'cov' }),
          h('button', { class: 'x', title: 'Stop and remove highlights' }, '✕')),
        h('div', { class: 'body' },
          h('div', null, h('span', { class: 'big pct' }, '–'), ' ', h('span', { class: 'lbl' }, 'of words on this page are known')),
          h('div', { class: 'bar' }),
          h('div', { class: 'nums' }),
          h('div', { class: 'tabs' }, tab(0, 'Not in Anki', true), tab(2, 'Learning'), tab(1, 'New')),
          h('div', { class: 'row' }, h('button', { class: 'b g all' }, 'Select all'), h('button', { class: 'b g none' }, 'None'), h('span', { class: 'sp' }),
            h('button', { class: 'b g sort', title: 'Sort the list' }, 'Sort: on page')),
          h('div', { class: 'list' }),
          h('div', { class: 'row' }, h('button', { class: 'b add', disabled: true }, 'Add to Anki'), h('button', { class: 'b g known', disabled: true }, 'Mark known')),
          h('div', { class: 'c deck' }),
          h('div', { class: 'status' }))),
      h('div', { class: 'tip' }));
    document.documentElement.appendChild(host);
    const $ = s => root.querySelector(s);
    ui = { host, root, $, status: $('.status'), list: $('.list'), tip: $('.tip'), filter: 0, sort: 'page' };
    if (innerWidth <= 600) $('.panel').classList.add('min');
    $('.hd').addEventListener('click', e => { if (!e.target.classList.contains('x')) $('.panel').classList.toggle('min'); });
    $('.x').addEventListener('click', clearPage);
    root.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      ui.filter = +b.dataset.f;
      root.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      renderPanel();
    }));
    $('.all').addEventListener('click', () => { listKeys().forEach(k => toggleSelect(k, true)); renderPanel(); });
    $('.none').addEventListener('click', () => { [...words.keys()].forEach(k => toggleSelect(k, false)); renderPanel(); });
    $('.sort').addEventListener('click', () => {
      ui.sort = ui.sort === 'freq' ? 'page' : 'freq';
      $('.sort').textContent = ui.sort === 'freq' ? 'Sort: most common' : 'Sort: on page';
      renderPanel();
    });
    $('.add').addEventListener('click', () => addToAnki(selectedKeys()));
    $('.known').addEventListener('click', () => markKnown(selectedKeys()));
    ui.tip.addEventListener('mouseleave', hideTip);
  }

  const byFreq = (a, b) => (a[1].f || 1e9) - (b[1].f || 1e9) || b[1].count - a[1].count;
  const listKeys = () => [...words.entries()].filter(([, w]) => (ui.filter === 0 ? w.st === 0 : w.st === ui.filter) && w.count > 0)
    .sort(ui.sort === 'freq' ? byFreq : (a, b) => b[1].count - a[1].count).map(([k]) => k);
  const selectedKeys = () => [...words.entries()].filter(([, w]) => w.sel).map(([k]) => k);

  let renderQueued = false;
  function renderPanel() {
    if (!ui || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!ui) return;
      const tot = [0, 0, 0, 0];
      for (const w of words.values()) tot[Math.min(w.st, 3)] += w.count;
      const all = tot.reduce((a, b) => a + b, 0) || 1;
      const known = tot[3] + (settings.countLearning !== false ? tot[2] : 0);
      ui.$('.pct').textContent = Math.round((known / all) * 100) + '%';
      ui.$('.cov').textContent = Math.round((known / all) * 100) + '%';
      const c = Object.assign({ unknown: '#e5484d', new: '#3e8ef7', learning: '#f5a524', known: '#2fb26b' }, settings.colors);
      ui.$('.bar').replaceChildren(...[[tot[3], c.known], [tot[2], c.learning], [tot[1], c.new], [tot[0], c.unknown]].map(([n, col]) => h('i', { style: { width: (n / all) * 100 + '%', background: col } })));
      const uniq = [0, 0, 0, 0];
      for (const w of words.values()) if (w.count) uniq[Math.min(w.st, 3)]++;
      ui.$('.nums').replaceChildren(h('span', null, `${uniq[3]} known`), h('span', null, `${uniq[2]} learning`), h('span', null, `${uniq[1]} new`), h('span', null, `${uniq[0]} not in Anki`));
      const keys = listKeys();
      ui.list.replaceChildren();
      for (const k of keys.slice(0, 300)) {
        const w = words.get(k);
        const it = h('label', { class: 'it' },
          h('input', { type: 'checkbox', checked: w.sel, onchange: e => { toggleSelect(k, e.target.checked); renderButtons(); } }),
          h('div', null, isHot(w) ? h('span', { class: 'star', title: 'Very common word' }, '★ ') : null, h('span', { class: 'w' }, w.w), h('span', { class: 'r' }, w.r)),
          h('span', { class: 'c' }, `×${w.count}`, w.f ? h('span', { class: 'fq' }, ' ' + fmtRank(w.f)) : null),
          h('div', { class: 'm' }, w.g || (w.u ? '(not in dictionary)' : '')));
        it.addEventListener('mouseenter', () => { if (w.el) w.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
        ui.list.appendChild(it);
      }
      if (!keys.length) ui.list.replaceChildren(h('div', { class: 'c' }, 'Nothing here.'));
      ui.$('.deck').textContent = `Cards go to “${settings.targetDeck || 'Japanese'}”`;
      renderButtons();
    });
  }
  function renderButtons() {
    const n = selectedKeys().length;
    ui.$('.add').disabled = !n; ui.$('.known').disabled = !n;
    ui.$('.add').textContent = n ? `Add ${n} to Anki` : 'Add to Anki';
  }

  // ---------- word popup ----------
  let tipKey = null, tipTimer = null;
  function showTip(sp) {
    const key = sp.dataset.k, w = words.get(key);
    if (!w || !ui) return;
    tipKey = key;
    const t = ui.tip;
    // show the word as it is written on the page; kanji spelling only as a hint
    const surf = fullSurface(sp);
    const kanaHere = /^[\u3040-\u30ff\u30fc]+$/.test(surf) && /[\u3400-\u9fff]/.test(w.w);
    const head = kanaHere ? surf : w.w;
    const hint = kanaHere ? `Usually written ${w.w}` : (w.k ? `Usually written ${w.k}` : '');
    t.replaceChildren(...[
      h('div', null, h('span', { class: 'w' }, head), kanaHere ? null : h('span', { class: 'r' }, w.r)),
      hint ? h('div', { class: 'kh' }, hint) : null,
      h('div', { class: 'm' }, w.g || (w.u ? 'Not in the dictionary.' : 'No dictionary loaded — import JMdict in Settings for meanings.')),
      h('span', { class: 'pill s' + w.st }, ST_LABEL[w.st]),
      w.f ? h('span', { class: 'pill fqp', title: 'Rank in your frequency list (1 = most common)' }, `${isHot(w) ? '★ ' : ''}Frequency ${fmtRank(w.f)}`) : null,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'b a', onclick: () => { addToAnki([key]); hideTip(); } }, '＋ Anki'),
        h('button', { class: 'b g k', onclick: () => { markKnown([key]); hideTip(); } }, 'Known'),
        h('button', { class: 'b g s', onclick: () => { toggleSelect(key); renderPanel(); hideTip(); } }, w.sel ? 'Unselect' : 'Select'))].filter(Boolean));
    const r = sp.getBoundingClientRect();
    t.style.display = 'block';
    const top = r.bottom + 6 + t.offsetHeight > innerHeight ? r.top - t.offsetHeight - 6 : r.bottom + 6;
    t.style.top = Math.max(4, top) + 'px';
    t.style.left = Math.max(8, Math.min(innerWidth - t.offsetWidth - 8, r.left)) + 'px';
  }
  /** Text of the whole word when it is split over several pieces (e.g. per-kanji furigana). */
  function fullSurface(sp) {
    const tid = sp.dataset.t;
    if (!tid) return sp.textContent;
    const scope = (sp.parentElement && sp.parentElement.closest(BLOCK)) || document;
    return [...scope.querySelectorAll(`.jar-w[data-t="${tid}"]`)].map(x => x.textContent).join('');
  }

  function hideTip() { if (ui) ui.tip.style.display = 'none'; tipKey = null; }

  document.addEventListener('mouseover', e => {
    const sp = e.target.closest && e.target.closest('.jar-w');
    clearTimeout(tipTimer);
    if (sp) tipTimer = setTimeout(() => showTip(sp), 250);
  });
  document.addEventListener('mouseout', e => {
    const sp = e.target.closest && e.target.closest('.jar-w');
    if (sp) { clearTimeout(tipTimer); tipTimer = setTimeout(() => { if (ui && !ui.tip.matches(':hover')) hideTip(); }, 350); }
  });
  const touchOnly = window.matchMedia && window.matchMedia('(hover: none)').matches;
  document.addEventListener('click', e => {
    if (!touchOnly || !ui) return;
    const sp = e.target.closest && e.target.closest('.jar-w');
    if (sp) {
      if (sp.closest('a')) e.preventDefault();
      clearTimeout(tipTimer);
      showTip(sp);
    } else if (!e.composedPath().includes(ui.host)) hideTip();
  });
  document.addEventListener('click', e => {
    const sp = e.target.closest && e.target.closest('.jar-w');
    if (sp && (e.altKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleSelect(sp.dataset.k); renderPanel(); }
  }, true);

  // ---------- messages ----------
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'jar-toggle') { active ? clearPage() : parsePage(); return Promise.resolve({ active: !active }); }
    if (msg.type === 'jar-parse') { if (!active) parsePage(); return Promise.resolve({ active: true }); }
    if (msg.type === 'jar-clear') { clearPage(); return Promise.resolve({ active: false }); }
    if (msg.type === 'jar-is-active') return Promise.resolve({ active });
    if (msg.type === 'jar-page-text') {
      const root = document.querySelector('article, main, [role=main]') || document.body;
      return Promise.resolve({ title: document.title, url: location.href, text: blockTextDeep(root) });
    }
    if (msg.type === 'jar-statuses-changed') { if (active) refreshStatuses().catch(() => {}); }
    if (msg.type === 'jar-settings-changed') { loadSettings().then(() => renderPanel()); }
    return undefined;
  });

  // auto-parse on listed sites
  loadSettings().then(() => {
    if ((settings.autoParse || []).some(p => p && location.href.includes(p))) parsePage();
  }).catch(() => {});

  window.__jar = { parsePage, clearPage, words, refreshStatuses };
})();
