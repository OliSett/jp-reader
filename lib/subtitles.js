/* SRT / WebVTT / ASS subtitle parsing. */
var JA = globalThis.JA || (globalThis.JA = {});

JA.subs = (() => {
  const t2s = t => {
    const m = t.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  };
  const clean = s => s
    .replace(/\{\\[^}]*\}/g, '')          // {\an8} ASS overrides inside SRT
    .replace(/<\/?[a-z][^>]*>/gi, '')     // <i>, <font …>
    .replace(/\\N/g, '\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .trim();

  function parseSrtVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split('\n');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;
      const [a, z] = lines[ti].split('-->');
      const start = t2s(a), end = t2s(z.split(/\s+/).filter(Boolean)[0] || '');
      const body = clean(lines.slice(ti + 1).join('\n'));
      if (!isNaN(start) && !isNaN(end) && body) cues.push({ start, end, text: body });
    }
    return cues;
  }

  function parseAss(text) {
    const cues = [];
    let fmt = null;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      if (/^Format:/i.test(line) && !fmt) continue;
      if (/^\[Events\]/i.test(line)) { fmt = 'events'; continue; }
      if (fmt === 'events' && /^Format:/i.test(line)) { fmt = line.slice(7).split(',').map(s => s.trim().toLowerCase()); continue; }
      if (Array.isArray(fmt) && /^Dialogue:/i.test(line)) {
        const parts = line.slice(9).split(',');
        const rec = {};
        fmt.forEach((f, i) => { rec[f] = i === fmt.length - 1 ? parts.slice(i).join(',') : parts[i]; });
        const body = clean(rec.text || '');
        if (body) cues.push({ start: t2s(rec.start), end: t2s(rec.end), text: body });
      }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  function parse(text, name = '') {
    const cues = /\.ass$|\.ssa$/i.test(name) || /^\[Script Info\]/m.test(text) ? parseAss(text) : parseSrtVtt(text);
    // merge exact duplicates (karaoke / signs repeated)
    return cues.filter((c, i) => !(i && c.text === cues[i - 1].text && Math.abs(c.start - cues[i - 1].start) < 0.05));
  }

  /** Index of the cue showing at time t (binary search), or -1. */
  function at(cues, t) {
    let lo = 0, hi = cues.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 && t <= cues[best].end ? best : -1;
  }

  const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60), ss = Math.floor(s % 60); return `${m}:${String(ss).padStart(2, '0')}`; };

  return { parse, at, fmt, t2s };
})();

if (typeof module !== 'undefined') module.exports = JA;
