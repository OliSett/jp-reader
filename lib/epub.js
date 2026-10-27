/* EPUB reading for extension pages: unzip, read the package (OPF), table of contents,
 * and turn chapters into safe DOM (no scripts, no event handlers, no remote loads). */
var JA = globalThis.JA || (globalThis.JA = {});

JA.epub = (() => {
  const dec = new TextDecoder();

  function resolve(base, href) {
    const clean = decodeURIComponent(href.split('#')[0]);
    if (!clean) return base;
    if (clean.startsWith('/')) return clean.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const seg of clean.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  const xml = text => new DOMParser().parseFromString(text, 'application/xml');
  const byLocal = (doc, name) => [...doc.getElementsByTagName('*')].filter(e => e.localName === name);

  /** Parse an .epub (ArrayBuffer) into {meta, files, spine, toc}. */
  async function open(buf) {
    const list = await JA.archive.unzip(buf);
    const files = new Map(list.map(f => [f.name, f.data]));
    const container = files.get('META-INF/container.xml');
    if (!container) throw new Error('Not an EPUB (META-INF/container.xml missing).');
    const rootfile = byLocal(xml(dec.decode(container)), 'rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath || !files.get(opfPath)) throw new Error('EPUB package file not found.');
    const opf = xml(dec.decode(files.get(opfPath)));

    const text = name => { const e = byLocal(opf, name)[0]; return e ? e.textContent.trim() : ''; };
    const manifest = new Map();
    for (const it of byLocal(opf, 'item')) {
      manifest.set(it.getAttribute('id'), {
        href: resolve(opfPath, it.getAttribute('href') || ''),
        type: it.getAttribute('media-type') || '',
        props: it.getAttribute('properties') || '',
      });
    }
    const spineEl = byLocal(opf, 'spine')[0];
    const spine = byLocal(opf, 'itemref')
      .filter(r => r.getAttribute('linear') !== 'no')
      .map(r => manifest.get(r.getAttribute('idref')))
      .filter(it => it && /x?html/.test(it.type) && files.has(it.href))
      .map(it => ({ href: it.href, title: '' }));

    // cover image
    let cover = [...manifest.values()].find(m => m.props.split(/\s+/).includes('cover-image'));
    if (!cover) {
      const m = byLocal(opf, 'meta').find(x => x.getAttribute('name') === 'cover');
      if (m) cover = manifest.get(m.getAttribute('content'));
    }

    // table of contents: EPUB3 nav, else EPUB2 NCX
    const toc = [];
    const nav = [...manifest.values()].find(m => m.props.split(/\s+/).includes('nav'));
    if (nav && files.has(nav.href)) {
      const doc = new DOMParser().parseFromString(dec.decode(files.get(nav.href)), 'application/xhtml+xml');
      const navEl = byLocal(doc, 'nav').find(n => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || byLocal(doc, 'nav')[0];
      if (navEl) for (const a of byLocal(navEl, 'a')) if (a.getAttribute('href')) toc.push({ title: a.textContent.trim(), href: resolve(nav.href, a.getAttribute('href')) });
    } else {
      const ncx = [...manifest.values()].find(m => /ncx/.test(m.type));
      if (ncx && files.has(ncx.href)) {
        const doc = xml(dec.decode(files.get(ncx.href)));
        for (const p of byLocal(doc, 'navPoint')) {
          const label = byLocal(p, 'text')[0], content = byLocal(p, 'content')[0];
          if (label && content) toc.push({ title: label.textContent.trim(), href: resolve(ncx.href, content.getAttribute('src') || '') });
        }
      }
    }
    for (const t of toc) { const s = spine.find(x => x.href === t.href); if (s && !s.title) s.title = t.title; }
    spine.forEach((s, i) => { if (!s.title) s.title = i === 0 ? 'Start' : `Section ${i + 1}`; });

    const meta = {
      title: text('title') || 'Untitled',
      author: text('creator'),
      language: text('language'),
      vertical: spineEl && spineEl.getAttribute('page-progression-direction') === 'rtl',
      cover: cover && files.has(cover.href) ? cover.href : null,
    };
    return { meta, files, spine, toc, mime: href => { const m = [...manifest.values()].find(x => x.href === href); return m ? m.type : ''; } };
  }

  function parseChapter(book, href) {
    const raw = dec.decode(book.files.get(href));
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(raw, 'text/html');
    return doc;
  }

  /** Plain text of a chapter without furigana, one line per paragraph. */
  function chapterText(book, href) {
    const doc = parseChapter(book, href);
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    let out = '';
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          const t = c.localName;
          if (t === 'rt' || t === 'rp' || t === 'script' || t === 'style') continue;
          if (t === 'br') { out += '\n'; continue; }
          const block = /^(p|div|h[1-6]|li|section|article|blockquote|tr|dd|dt|figcaption)$/.test(t);
          walk(c);
          if (block) out += '\n';
        }
      }
    };
    walk(body);
    return out.replace(/\n{2,}/g, '\n');
  }

  const DROP = new Set(['script', 'style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'source', 'foreignobject', 'title', 'head']);
  const KEEP_ATTR = new Set(['id', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'width', 'height', 'viewbox', 'preserveaspectratio', 'xlink:href', 'lang', 'dir']);

  /** Chapter body as a sanitized DocumentFragment for `doc`, images as blob URLs. */
  function renderChapter(book, href, doc, blobCache) {
    const src = parseChapter(book, href);
    const body = src.body || src.getElementsByTagName('body')[0] || src.documentElement;
    const frag = doc.createDocumentFragment();
    const blobUrl = path => {
      if (!book.files.has(path)) return '';
      if (!blobCache.has(path)) blobCache.set(path, URL.createObjectURL(new Blob([book.files.get(path)], { type: book.mime(path) || 'image/*' })));
      return blobCache.get(path);
    };
    const copy = (node, parent) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { parent.appendChild(doc.createTextNode(c.nodeValue)); continue; }
        if (c.nodeType !== 1) continue;
        const name = c.localName.toLowerCase();
        if (DROP.has(name)) continue;
        const isSvg = c.namespaceURI === 'http://www.w3.org/2000/svg';
        const el = isSvg ? doc.createElementNS('http://www.w3.org/2000/svg', c.localName) : doc.createElement(name === 'body' ? 'div' : name);
        for (const a of [...c.attributes]) {
          const an = a.name.toLowerCase();
          if (an.startsWith('on') || !KEEP_ATTR.has(an)) continue;
          let v = a.value;
          if (an === 'src' || an === 'xlink:href' || (an === 'href' && name === 'image')) {
            const u = blobUrl(resolve(href, v));
            if (!u) continue;
            if (an === 'xlink:href') { el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u); el.setAttribute('href', u); continue; }
            v = u;
          } else if (an === 'href') {
            if (/^\s*javascript:/i.test(v)) continue;
            if (/^[a-z]+:/i.test(v)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
            else { el.dataset.bookHref = resolve(href, v) + (v.includes('#') ? '#' + v.split('#')[1] : ''); v = '#'; }
          }
          try { el.setAttribute(a.name, v); } catch { /* odd attribute names */ }
        }
        copy(c, el);
        parent.appendChild(el);
      }
    };
    copy(body, frag);
    return frag;
  }

  // ---------- make a small EPUB from plain text (web articles sent from the phone or Firefox) ----------
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xffffffff; for (const b of u8) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  /** Minimal uncompressed zip writer. files: [{name, data: Uint8Array}] */
  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint32(14, crc, true);
      local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(local.buffer), name, f.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true); cen.setUint32(24, size, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + size;
    }
    const cenSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
    return out.buffer;
  }

  const escX = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** An EPUB with one chapter per ~3000 characters of text. */
  function fromText(title, text, source = '') {
    const enc = new TextEncoder();
    const paras = text.split(/\n+/).map(t => t.trim()).filter(Boolean);
    const chapters = [];
    let cur = [];
    let size = 0;
    for (const p of paras) { cur.push(p); size += p.length; if (size > 3000) { chapters.push(cur); cur = []; size = 0; } }
    if (cur.length || !chapters.length) chapters.push(cur);
    const files = [{ name: 'mimetype', data: enc.encode('application/epub+zip') },
      { name: 'META-INF/container.xml', data: enc.encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') }];
    const items = chapters.map((c, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
    const spine = chapters.map((c, i) => `<itemref idref="c${i}"/>`).join('');
    files.push({ name: 'OEBPS/content.opf', data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${escX(source || title)}</dc:identifier><dc:title>${escX(title)}</dc:title><dc:creator>${escX(source.replace(/^https?:\/\//, '').split('/')[0])}</dc:creator><dc:language>ja</dc:language></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`) });
    chapters.forEach((c, i) => {
      const body = (i === 0 ? `<h1>${escX(title)}</h1>` : '') + c.map(p => `<p>${escX(p)}</p>`).join('');
      files.push({ name: `OEBPS/c${i}.xhtml`, data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escX(title)}</title></head><body>${body}</body></html>`) });
    });
    return zip(files);
  }

  return { open, chapterText, renderChapter, resolve, fromText, zip };
})();

if (typeof module !== 'undefined') module.exports = JA;
