/* Video player with Japanese subtitles highlighted by what you know. */
const $ = id => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), transcript = $('transcript');
// iPhone's file picker doesn't know .srt/.ass, so a type filter greys them out: accept any file and check it ourselves
if (JA.platform === 'web' || /iPhone|iPad|iPod/.test(navigator.userAgent)) $('sfile').removeAttribute('accept');
let cues = [], cueEls = [], cur = -1, offset = 0, autoPause = false, pausedAt = -1, showSubs = true;
let videoName = '', subName = '', userScrollAt = 0;

async function loadState() {
  const { videoState } = await browser.storage.local.get('videoState');
  return videoState || {};
}
async function saveState(patch) {
  const all = await loadState();
  all[videoName || subName] = { ...(all[videoName || subName] || {}), ...patch, at: Date.now() };
  // keep the 50 most recent
  const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  for (const k of keys.slice(50)) delete all[k];
  await browser.storage.local.set({ videoState: all });
}

$('vfile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  videoName = f.name;
  $('empty').style.display = 'none';
  showNames();
  const st = (await loadState())[videoName];
  if (st) {
    if (st.offset) setOffset(st.offset);
    video.addEventListener('loadedmetadata', () => { if (st.t && st.t < video.duration - 5) video.currentTime = st.t; }, { once: true });
  }
  video.addEventListener('error', () => {
    $('empty').style.display = '';
    $('empty').textContent = `This browser can't play “${f.name}”. MKV and some codecs aren't supported — convert to MP4 (H.264/AAC), e.g. with HandBrake or ffmpeg.`;
  }, { once: true });
};

$('sfile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) { try { text = new TextDecoder('shift_jis').decode(buf); } catch { /* keep utf-8 */ } }
  if (f.type.startsWith('video/') || f.type.startsWith('image/') || /\.(mp4|mkv|mov|webm|m4v|jpe?g|png|heic)$/i.test(f.name)) {
    $('cov').textContent = `“${f.name}” isn't a subtitle file. Choose an .srt, .vtt or .ass file.`;
    return;
  }
  cues = JA.subs.parse(text, f.name);
  subName = f.name;
  showNames();
  if (!cues.length) { $('cov').textContent = `No subtitle lines found in “${f.name}”. Is it an .srt, .vtt or .ass file?`; return; }
  buildTranscript();
  const st = (await loadState())[videoName || subName];
  if (st && st.offset && !videoName) setOffset(st.offset);
};

function showNames() { $('names').textContent = [videoName, subName].filter(Boolean).join(' + '); document.title = (videoName || subName || 'Video') + ' — JP Reader'; }

function buildTranscript() {
  if (window.__jar) window.__jar.clearPage();
  transcript.replaceChildren(...cues.map((c, i) => {
    const el = h('div', { class: 'cue', dataset: { i: String(i) } },
      h('span', { class: 'tm', title: 'Jump here', onclick: () => { video.currentTime = c.start + offset + 0.01; play(); } }, JA.subs.fmt(c.start)),
      h('div', { class: 'tx' }, c.text));
    return el;
  }));
  cueEls = [...transcript.children];
  cur = -1;
  $('cov').textContent = `${cues.length} lines · checking words…`;
  if (window.__jar) window.__jar.parsePage(transcript).then(updateCoverage);
}

/** Episode coverage and i+1 lines (exactly one word you don't know). */
function updateCoverage() {
  if (!window.__jar) return;
  const words = window.__jar.words;
  let tot = 0, known = 0, i1 = 0;
  for (const el of cueEls) {
    let unknown = 0;
    for (const sp of el.querySelectorAll('.jar-w')) {
      if (sp.dataset.t && sp !== el.querySelector(`.jar-w[data-t="${sp.dataset.t}"]`)) continue;
      const w = words.get(sp.dataset.k);
      if (!w) continue;
      tot++;
      if (w.st >= 2) known++; else unknown++;
    }
    el.classList.toggle('i1', unknown === 1);
    if (unknown === 1) i1++;
  }
  $('cov').textContent = tot ? `Episode: ${Math.round((known / tot) * 100)}% of words known · ${i1} lines with exactly one new word (marked i+1)` : `${cues.length} lines`;
}

function setOffset(v) {
  offset = Math.round(v * 100) / 100;
  $('offset').textContent = `sync ${offset >= 0 ? '+' : ''}${offset.toFixed(2)}s`;
  saveState({ offset });
  tick(true);
}

function showCue(i) {
  if (i === cur) return;
  if (cur >= 0 && cueEls[cur]) cueEls[cur].classList.remove('now');
  cur = i;
  if (i < 0) { overlay.replaceChildren(); return; }
  const el = cueEls[i];
  el.classList.add('now');
  if (Date.now() - userScrollAt > 4000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // the overlay shows a copy of the highlighted transcript line
  const line = h('div', { class: 'line' });
  line.append(...[...el.querySelector('.tx').childNodes].map(n => n.cloneNode(true)));
  overlay.replaceChildren(line);
}

function tick(force) {
  if (!cues.length) return;
  const t = video.currentTime - offset;
  const i = JA.subs.at(cues, t);
  // auto-pause only when playback runs past the end of the line (not after jumping somewhere)
  if (autoPause && !video.paused && cur >= 0 && pausedAt !== cur && Date.now() - seekAt > 400
      && t >= cues[cur].end - 0.08 && t - cues[cur].end < 0.6 && (i !== cur)) {
    pausedAt = cur;
    video.pause();
    video.currentTime = cues[cur].end + offset - 0.05;
    return;
  }
  if (force || i !== cur) showCue(i);
}
video.addEventListener('timeupdate', () => tick());
let seekAt = 0;
video.addEventListener('seeking', () => { seekAt = Date.now(); });
video.addEventListener('seeked', () => { pausedAt = -1; seekAt = Date.now(); tick(true); });
let raf = 0;
const loop = () => { tick(); if (!video.paused) raf = requestAnimationFrame(loop); };
video.addEventListener('play', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
let saveT = 0;
video.addEventListener('timeupdate', () => { if (Date.now() - saveT > 5000 && videoName) { saveT = Date.now(); saveState({ t: video.currentTime }); } });
transcript.addEventListener('wheel', () => { userScrollAt = Date.now(); }, { passive: true });
transcript.addEventListener('touchmove', () => { userScrollAt = Date.now(); }, { passive: true });

// pause when you reach for a word in the subtitle
overlay.addEventListener('pointerdown', () => { if (!video.paused) video.pause(); });
overlay.addEventListener('mouseover', e => { if (e.target.closest('.jar-w') && !video.paused) video.pause(); });

const play = () => { const r = video.play(); if (r && r.catch) r.catch(() => {}); };

function seekCue(d) {
  if (!cues.length) return;
  const t = video.currentTime - offset;
  let i = JA.subs.at(cues, t);
  if (i < 0) { i = cues.findIndex(c => c.start > t); if (d < 0) i = (i < 0 ? cues.length : i) - 1; else if (i < 0) return; else i -= 1; }
  const n = Math.max(0, Math.min(cues.length - 1, i + d));
  pausedAt = -1;
  video.currentTime = cues[n].start + offset + 0.01;
  play();
}
function replay() { if (cur >= 0) { pausedAt = -1; video.currentTime = cues[cur].start + offset + 0.01; play(); } else seekCue(0); }

$('offMinus').onclick = () => setOffset(offset - 0.25);
$('offPlus').onclick = () => setOffset(offset + 0.25);
$('auto').onclick = () => { autoPause = !autoPause; $('auto').textContent = `Auto-pause: ${autoPause ? 'on' : 'off'}`; $('auto').classList.toggle('g', !autoPause); };
$('subsBtn').onclick = () => { showSubs = !showSubs; overlay.classList.toggle('hidden', !showSubs); $('subsBtn').textContent = `Subs: ${showSubs ? 'on' : 'off'}`; };
$('full').onclick = () => {
  const w = $('vwrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (w.requestFullscreen) w.requestFullscreen().catch(() => w.classList.toggle('full'));
  else w.classList.toggle('full');
};

document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); video.paused ? play() : video.pause(); }
  else if (k === 'arrowleft') { e.preventDefault(); seekCue(-1); }
  else if (k === 'arrowright') { e.preventDefault(); seekCue(1); }
  else if (k === 'r') replay();
  else if (k === 'a') $('auto').click();
  else if (k === 's') $('subsBtn').click();
  else if (k === 'z') setOffset(offset - 0.1);
  else if (k === 'x') setOffset(offset + 0.1);
  else if (k === 'escape') $('vwrap').classList.remove('full');
});

// cards made here say which video and when
window.__jarSource = el => {
  const c = el && el.closest ? el.closest('.cue') : null;
  const i = c ? +c.dataset.i : cur;
  return `${videoName || subName}${i >= 0 && cues[i] ? ' ' + JA.subs.fmt(cues[i].start) : ''}`;
};
window.__jarAfterStatus = updateCoverage;
