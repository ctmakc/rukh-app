// LESSON mode: learn a reference dance move by move, then dance it start to finish.
// Camera source: ?solo=1 -> this device's own camera + pose detection here; ?room=CODE -> a phone on /cam via link.js.
// Flow: pick a dance -> each move loops (0.5 / 0.75 / 1x) with a "5 6 7 8" count-in -> a rep that scores >= PASS
// moves on -> full run -> summary. Scoring is score.js Dancer (contrastive lag-locked match + beat judge) fed with
// SONG time, so slower playback scales every window with it; beats come from the dance JSON grid.
import { drawPoses, TAPES, makeCode, clamp } from './common.js';
import { ScreenLink, normCode } from './link.js';
import { ORIGIN, IS_APP } from './env.js';
import { Reference, Dancer, tier } from './score.js';
import qrcode from '/vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const page = (name, q = '') => (IS_APP ? `/${name}.html` : `/${name}`) + q;
const PASS = clamp(Number(qs.get('pass')) || 60, 1, 100); // ?pass= lowers the bar (tests, kids' classes)
const JUDGE_LAG = 0.75; // real seconds to wait for late poses before a beat is judged
const RATES = [0.5, 0.75, 1];
const refVideo = $('ref'), camVideo = $('camVideo');
const camCanvas = $('camCanvas'), cctx = camCanvas.getContext('2d');
const prevCanvas = $('previewCanvas'), pctx = prevCanvas.getContext('2d');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const L = (window.rukh = {
  src: qs.has('room') ? 'room' : 'solo', code: '', phase: 'pick', mode: 'move',
  dances: [], dance: null, choreo: null, ref: null, beats: [], moves: [], mi: 0,
  rate: RATES.includes(Number(qs.get('rate'))) ? Number(qs.get('rate')) : 0.75,
  mirrorRef: qs.get('mirror') === '1', mirrorCam: true,
  cam: 'starting', // starting | live | denied | nocam | busy | waiting (room, no phone yet) | lost
  poseBuf: [], poseTimes: [], poseRate: 0, lastBodyAt: 0, lastPoseMsg: 0, camW: 16, camH: 9, camMir: false,
  dancer: null, st: {}, offs: [], seg: null, rep: null, best: {}, reps: 0, passed: 0, full: null,
});

// ------------------------------------------------------------------ camera source
let detector = null, tracker = null, stream = null, link = null;
const camLabel = (t, cls) => { $('srcTxt').textContent = t; $('srcChip').className = 'src ' + (cls || ''); };

async function startSolo() {
  L.src = 'solo';
  camLabel('This camera', 'wait');
  if (!navigator.mediaDevices?.getUserMedia) return camFail('nocam');
  try {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: qs.get('facing') || 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    console.warn('camera', e.name, e.message);
    const n = e.name;
    return camFail(n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotReadableError' || n === 'AbortError' ? 'busy' : 'nocam');
  }
  camVideo.srcObject = stream;
  await camVideo.play().catch(() => {});
  L.camMir = (qs.get('facing') || 'user') === 'user';
  setCam('loading');
  if (!detector) {
    try {
      const { createDetector, Tracker } = await import('./pose.js');
      tracker = new Tracker(4);
      detector = await createDetector({ numPoses: 2, delegate: qs.get('delegate') });
      L.delegate = detector.delegate;
    } catch (e) {
      console.error(e);
      return camFail('tracker', e.message);
    }
  }
  setCam('live');
  camLabel('This camera', 'ok');
}
window.rukhRestartCamera = startSolo; // test hook: restarts a fake camera clip from its first frame

let compactFn = null, lastDetect = 0, detMs = 30, gap = 45;
async function detectStep(now) {
  if (!detector || !camVideo.videoWidth || camVideo.readyState < 2 || now - lastDetect < gap) return;
  if (!compactFn) compactFn = (await import('./pose.js')).compact;
  lastDetect = now;
  const t0 = performance.now();
  const res = detector.lm.detectForVideo(camVideo, t0);
  const poses = tracker.update(compactFn(res), t0);
  detMs = detMs * 0.8 + (performance.now() - t0) * 0.2;
  gap = Math.max(40, detMs * 0.6); // leave the main thread time for the reference video + drawing
  onPoses(t0, poses, camVideo.videoWidth, camVideo.videoHeight);
}

function startRoom() {
  L.src = 'room';
  L.code = normCode(qs.get('room') || '');
  if (L.code.length < 4) {
    L.code = normCode(localStorage.getItem('rukh.lessonRoom') || '');
    if (L.code.length < 4) L.code = makeCode();
    history.replaceState(null, '', `${location.pathname}?room=${L.code}`);
  }
  localStorage.setItem('rukh.lessonRoom', L.code);
  link = L.link = new ScreenLink({ room: L.code, video: $('camVideo') });
  link.addEventListener('pose', (e) => {
    const m = e.detail;
    L.lastPoseMsg = performance.now();
    L.camMir = !!m.mir;
    onPoses(m.cap, m.poses || [], m.w, m.h);
  });
  link.addEventListener('state', (e) => roomState(e.detail.state));
  roomState(link.state);
}
function roomState(s) {
  const live = s === 'direct' || s === 'relay';
  if (live) { L.everLive = true; if (L.cam !== 'live') setCam('live'); camLabel(`Phone · ${L.code} · ${s.toUpperCase()}`, 'ok'); }
  else if (s === 'lost' && !L.everLive) { setCam('waiting'); camLabel(`${L.code} · no server`, 'bad'); }
  else if (s === 'lost') { setCam('lost'); camLabel(`Phone · ${L.code} · LOST`, 'bad'); }
  else if (s === 'replaced') { setCam('lost'); camLabel(`${L.code} · open elsewhere`, 'bad'); }
  else { if (L.cam !== 'live') setCam('waiting'); camLabel(`Phone · ${L.code}`, 'wait'); }
}

// Pick the learner: the biggest body in frame (closest to the camera). Others are drawn but not scored.
function torso(lm, asp) {
  const sx = (lm[11][0] + lm[12][0]) / 2, sy = (lm[11][1] + lm[12][1]) / 2, hx = (lm[23][0] + lm[24][0]) / 2, hy = (lm[23][1] + lm[24][1]) / 2;
  return Math.hypot((sx - hx) * asp, sy - hy);
}
function wholeBody(lm) { return [11, 12, 23, 24, 25, 26].every((j) => lm[j][2] > 0.5) && (lm[27][2] > 0.35 || lm[28][2] > 0.35); }

function onPoses(cap, poses, w, h) {
  const now = performance.now();
  if (w && h) { L.camW = w; L.camH = h; }
  const asp = L.camW / L.camH;
  let main = null;
  for (const p of poses) if (!main || torso(p.lm, asp) > torso(main.lm, asp)) main = p;
  L.poseBuf.push({ cap, poses, main: main?.id ?? -1 });
  while (L.poseBuf.length && L.poseBuf[0].cap < now - 2500) L.poseBuf.shift();
  L.poseTimes.push(now);
  if (main) { L.lastBodyAt = now; L.whole = wholeBody(main.lm); }
  if (!main) return;
  if ((L.phase === 'play' || L.phase === 'gap' || L.phase === 'count') && L.dancer && L.ref) {
    const t = songAt(cap);
    if (t > L.seg.t0 - 0.6 * L.rate) L.dancer.push(main.lm, t, L.ref, asp);
    L.rec?.push([t, main.lm, asp]); // tests: set rukh.rec = [] to record what was scored
  }
}

// ------------------------------------------------------------------ camera states
const CAM_MSG = {
  loading: ['Loading the dance tracker…', ''],
  denied: ['Camera blocked', 'RUKH needs the camera to see your moves. Allow camera access for this site in the browser (the camera icon in the address bar, or Settings → Apps → RUKH → Permissions), then try again. The video stays on this device.'],
  nocam: ['No camera found', 'This device has no camera RUKH can use. Use a phone as the camera instead: open the camera page on it and type the code shown here.'],
  busy: ['The camera is busy', 'Another app or browser tab is using the camera. Close it and try again.'],
  tracker: ['The dance tracker did not start', 'This browser could not run pose tracking. Update the browser, or use a phone as the camera.'],
  waiting: ['Connect the camera phone', 'Lean a phone against the wall 2–3 m away, open the camera page and type this code. It sends your moves to this screen.'],
  lost: ['Camera phone disconnected', 'Reconnecting by itself. Check Wi-Fi or mobile data on the phone.'],
};
function setCam(state, detail) {
  L.cam = state;
  document.body.dataset.cam = state;
  const sheet = $('sheet'), bad = BAD_CAM.includes(state);
  // on the dance list the camera card sits inside the camera preview; in the studio it is a modal sheet
  const inline = L.phase === 'pick';
  if (sheet.parentNode !== (inline ? $('preview') : document.body)) (inline ? $('preview') : document.body).appendChild(sheet);
  sheet.classList.toggle('inline', inline);
  if (state === 'live') { sheet.hidden = true; $('previewMsg').textContent = ''; return; }
  const [h, p] = CAM_MSG[state] || [state, ''];
  $('previewMsg').textContent = h;
  if (!bad) { sheet.hidden = true; return; }
  if (L.phase === 'play' || L.phase === 'count') pauseLesson();
  sheet.hidden = false;
  $('sheetTag').textContent = state === 'waiting' ? 'Phone camera' : 'Camera';
  $('sheetTag').style.setProperty('--tc', state === 'waiting' ? 'var(--t2)' : 'var(--t4)');
  sheet.firstElementChild.style.borderLeftColor = state === 'waiting' ? 'var(--t2)' : 'var(--t4)';
  $('sheetH').textContent = h;
  $('sheetP').textContent = p + (detail && state === 'tracker' ? ` (${detail})` : '');
  const act = $('sheetAct'); act.innerHTML = '';
  const showJoin = state === 'nocam' || state === 'waiting' || state === 'tracker';
  $('sheetJoin').hidden = !showJoin;
  const btn = (txt, fn, primary) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = txt; b.onclick = fn; act.appendChild(b); return b; };
  if (state === 'denied' || state === 'busy') btn('Try again', () => startSolo(), true);
  if (L.src === 'solo' && state !== 'waiting') btn('Use a phone as the camera', () => { location.href = page('lesson', `?room=${L.pendingCode ||= makeCode()}`); }, showJoin);
  if (L.src === 'room') btn('Use this device’s camera', () => { location.href = page('lesson', '?solo=1'); });
  if (L.phase !== 'pick') btn('Back to the dances', () => { sheet.hidden = true; backToPick(); });
  if (showJoin) {
    const code = L.src === 'room' ? L.code : (L.pendingCode ||= makeCode());
    $('joinCode').textContent = code;
    $('joinUrl').textContent = `${new URL(ORIGIN).host}/cam`;
    drawQr($('joinQr'), `${ORIGIN}/cam?room=${code}`);
  }
  if (!inline) act.querySelector('.btn')?.focus();
}
const BAD_CAM = ['denied', 'nocam', 'busy', 'tracker', 'waiting'];
function camFail(kind, detail) { setCam(kind, detail); camLabel(kind === 'denied' ? 'Camera blocked' : 'No camera', 'bad'); }

// ------------------------------------------------------------------ dances
async function loadDances() {
  $('pickErr').hidden = true;
  try {
    const r = await fetch('/ref/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    L.dances = await r.json();
    if (!Array.isArray(L.dances) || !L.dances.length) throw new Error('empty');
  } catch (e) {
    console.warn('dance list', e);
    L.dances = [];
    $('pickErr').hidden = false; $('dances').innerHTML = '';
    return;
  }
  L.best = JSON.parse(localStorage.getItem('rukh.lessonBest') || '{}');
  const ol = $('dances'); ol.innerHTML = '';
  const LV = { easy: 'var(--t3)', medium: 'var(--t2)', hard: 'var(--t1)' };
  L.dances.forEach((d, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dance'; b.style.setProperty('--tc', LV[d.level] || 'var(--chalk)');
    const best = L.best[d.id];
    b.innerHTML = `<img alt="" loading="lazy" src="${d.poster}"><span class="d-main"><b></b><span class="d-meta mono"></span></span>
      <span class="d-side"><span class="tape lvl"></span><span class="d-best mono"></span></span>`;
    b.querySelector('b').textContent = d.title;
    b.querySelector('.d-meta').textContent = `${d.style || 'dance'} · ${Math.round(d.bpm)} BPM · ${(d.moves || []).length} moves`;
    b.querySelector('.lvl').textContent = d.level || '—';
    b.querySelector('.d-best').textContent = best?.full != null ? `best ${best.full}` : '';
    b.onclick = () => openDance(i);
    li.appendChild(b); ol.appendChild(li);
  });
  if (qs.get('dance')) { const i = L.dances.findIndex((d) => d.id === qs.get('dance')); if (i >= 0) openDance(i); }
}

async function openDance(i) {
  const d = L.dances[i];
  L.dance = d; L.choreo = null; L.ref = null; L.mi = 0; L.st = {}; L.offs = []; L.full = null;
  $('danceTitle').textContent = d.title;
  $('danceMeta').textContent = `${d.level || ''} · ${d.style || ''} · ${Math.round(d.bpm)} BPM`;
  setPhase('load');
  showLoad('Loading the dance…');
  const myId = d.id;
  try {
    // the whole video as a blob: the asset server may answer without byte ranges, and a streamed video
    // that is not fully in memory cannot seek (currentTime = move start would land at 0)
    const [choreo, vurl] = await Promise.all([
      fetch(d.json).then((r) => { if (!r.ok) throw new Error('dance data ' + r.status); return r.json(); }),
      Promise.race([
        fetch(d.video).then((r) => { if (!r.ok) throw new Error('video ' + r.status); return r.blob(); }).then((b) => URL.createObjectURL(b)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('video timeout')), 45000)),
      ]),
    ]);
    if (L.dance?.id !== myId) { URL.revokeObjectURL(vurl); return; }
    await new Promise((res, rej) => {
      refVideo.onloadeddata = res; refVideo.onerror = () => rej(new Error('video ' + (refVideo.error?.code || '')));
      const old = L.videoUrl; L.videoUrl = vurl;
      refVideo.src = vurl; refVideo.load();
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
      setTimeout(() => rej(new Error('video timeout')), 25000);
    });
    if (L.dance?.id !== myId) return;
    if (!choreo.frames?.length || !choreo.beats?.length) throw new Error('dance data has no poses or beats');
    L.choreo = choreo; L.ref = new Reference(choreo); L.beats = choreo.beats;
    L.moves = (choreo.moves?.length ? choreo.moves : d.moves || []).filter((m) => m.end > m.t);
    if (!L.moves.length) L.moves = [{ t: choreo.beats[0], end: choreo.duration, label: 'Whole dance', counts: 8 }];
  } catch (e) {
    if (L.dance?.id !== myId) return;
    console.warn('dance load', e);
    showLoad(`This dance did not load (${e.message}).`, true);
    return;
  }
  refVideo.onloadeddata = refVideo.onerror = null;
  L.best[d.id] ||= { moves: {} };
  renderMoves(); hideLoad();
  history.replaceState(null, '', `${location.pathname}?${L.src === 'room' ? 'room=' + L.code : 'solo=1'}&dance=${d.id}`);
  gotoMove(0, false);
  setPhase('ready');
}
function showLoad(msg, err) {
  const el = $('loadMsg'); el.hidden = false; el.className = 'loadmsg' + (err ? ' err' : '');
  el.innerHTML = '';
  const p = document.createElement('p'); p.textContent = msg; el.appendChild(p);
  if (err) {
    const row = document.createElement('div'); row.className = 'sheet-act';
    const a = document.createElement('button'); a.className = 'btn primary'; a.type = 'button'; a.textContent = 'Try again'; a.onclick = () => openDance(L.dances.indexOf(L.dance));
    const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = 'Another dance'; b.onclick = backToPick;
    row.append(a, b); el.appendChild(row); a.focus();
  }
}
function hideLoad() { $('loadMsg').hidden = true; }

// ------------------------------------------------------------------ moves rail + ruler
function renderMoves() {
  const ol = $('moves'); ol.innerHTML = '';
  const best = L.best[L.dance.id].moves;
  L.moves.forEach((m, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'mv';
    const bm = best[i];
    b.innerHTML = `<em class="mono">${String(i + 1).padStart(2, '0')}</em><span class="mv-l"><b></b></span><span class="mv-s mono"></span>`;
    b.querySelector('b').textContent = m.label;
    b.querySelector('.mv-s').textContent = bm ? String(bm.score) : `${m.counts || 8} ct`;
    b.classList.toggle('scored', !!bm);
    b.classList.toggle('passed', !!bm?.passed);
    b.classList.toggle('cur', i === L.mi && L.mode === 'move');
    b.onclick = () => { gotoMove(i, L.phase !== 'ready'); };
    li.appendChild(b); ol.appendChild(li);
  });
}
function buildRuler(n) {
  const r = $('ruler'); r.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('div'); c.className = 'cell' + (i >= n ? ' off' : '');
    c.innerHTML = `<b>${i + 1}</b><i class="fill"></i><i class="notch"></i>`;
    r.appendChild(c);
  }
}
function rulerOn(k, count) {
  [...$('ruler').children].forEach((c, i) => { c.classList.toggle('on', i === k); c.classList.toggle('cnt', !!count && i === k); });
}
function rulerMark(k, sim, q) {
  const c = $('ruler').children[k]; if (!c) return;
  c.querySelector('.fill').style.transform = `scaleY(${sim == null ? 0 : clamp(sim / 100, 0.04, 1)})`;
  const n = c.querySelector('.notch'); n.className = 'notch ' + (q >= 1 ? 'q1' : q > 0 ? 'q5' : 'q0');
  c.classList.toggle('pass', sim != null && sim >= PASS);
  c.classList.toggle('miss', sim == null);
}
function rulerClear() { for (const c of $('ruler').children) { c.querySelector('.fill').style.transform = 'scaleY(0)'; c.querySelector('.notch').className = 'notch'; c.classList.remove('pass', 'miss'); } }

// ------------------------------------------------------------------ flow
function setPhase(p) {
  const was = L.phase;
  L.phase = p;
  if ((p === 'pick') !== (was === 'pick') && BAD_CAM.includes(L.cam)) setCam(L.cam); // move the camera card between list and studio
  document.body.className = document.body.className.replace(/\bph-\w+/g, '').trim() + ' ph-' + p;
  document.body.classList.toggle('full', L.mode === 'full');
}
function segFor() {
  if (L.mode === 'full') {
    const t0 = L.moves[0].t, t1 = L.moves[L.moves.length - 1].end;
    return { t0, t1, counts: 8 };
  }
  const m = L.moves[L.mi];
  return { t0: m.t, t1: m.end, counts: m.counts || 8 };
}
function beatsIn(t0, t1) {
  const out = [];
  L.beats.forEach((b, i) => { if (b >= t0 - 0.03 && b < t1 - 0.03) out.push(i); });
  return out;
}
function barBeat() { return L.moves[0].beat ?? L.beats.findIndex((b) => b >= L.moves[0].t - 0.03); }

function gotoMove(i, autostart) {
  stopPlayback();
  L.mode = 'move';
  L.mi = clamp(i, 0, L.moves.length - 1);
  const m = L.moves[L.mi];
  $('moveTag').textContent = `${String(L.mi + 1).padStart(2, '0')} · ${m.label}`;
  $('startTxt').textContent = `Start move ${L.mi + 1}`;
  $('scoreLbl').textContent = 'This rep';
  L.seg = segFor();
  buildRuler(L.seg.counts); rulerClear();
  setScore(null, ''); renderMoves();
  refVideo.playbackRate = L.rate;
  seekRef(m.t);
  if (autostart) countIn(true); else setPhase('ready');
}
function startFull() {
  stopPlayback();
  L.mode = 'full';
  $('moveTag').textContent = 'Full run · whole dance';
  $('startTxt').textContent = 'Start the full run';
  $('scoreLbl').textContent = 'Full run';
  L.seg = segFor();
  buildRuler(8); rulerClear(); setScore(null, ''); renderMoves();
  seekRef(L.seg.t0);
  countIn(true);
}
function seekRef(t) { try { refVideo.pause(); refVideo.currentTime = Math.max(0, t - 0.02); } catch {} }

// ---- audio (count-in clicks; the reference video carries the music)
let ac = null;
function ensureAudio() {
  if (!ac) { try { ac = new AudioContext(); } catch { ac = null; } }
  ac?.resume().catch(() => {});
}
function click(at, hi) {
  if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = hi ? 1320 : 880; o.type = 'square';
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.2, at + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
  o.connect(g); g.connect(ac.destination); o.start(at); o.stop(at + 0.1);
}
const beatLen = () => 60 / (L.choreo?.grid?.bpm || L.choreo?.bpm || 100);
let timers = [];
const later = (ms, fn) => timers.push(setTimeout(fn, ms));
function clearTimers() { timers.forEach(clearTimeout); timers = []; }

// "5 · 6 · 7 · 8" (full) before a move / run, "7 · 8" between reps; counts light ruler cells 5..8 / 7..8
function countIn(full) {
  if (!L.ref) return;
  if (L.cam !== 'live') { setCam(L.cam); return; }
  ensureAudio();
  clearTimers();
  const counts = full ? [5, 6, 7, 8] : [7, 8];
  const P = beatLen() / L.rate; // real seconds per count at this speed
  refVideo.playbackRate = L.rate;
  seekRef(L.seg.t0);
  // the song clock runs through the count-in, so poses captured now land just before the move starts
  anchor = { vt: L.seg.t0 - counts.length * beatLen(), p: performance.now() + 120 };
  newRep();
  setPhase('count');
  L.playAt = performance.now() + 120 + counts.length * P * 1000; // when the move starts playing (tests line a fake camera up with it)
  const t0 = (ac?.currentTime ?? 0) + 0.12;
  counts.forEach((n, k) => {
    click(t0 + k * P, n === 8);
    later(120 + k * P * 1000, () => { $('count').innerHTML = `<span>${n}</span>`; rulerOn(n - 1, true); });
  });
  later(120 + counts.length * P * 1000, () => {
    $('count').innerHTML = '';
    if (L.phase !== 'count') return;
    refVideo.playbackRate = L.rate;
    const pr = refVideo.play();
    pr?.catch?.((e) => { console.warn('play', e); flash('Tap Start to play the music', 'bad'); setPhase('ready'); });
    anchor = { vt: L.seg.t0, p: performance.now() };
    setPhase('play');
  });
}
function newRep() {
  const d = new Dancer(0);
  d.st = L.st; d.offs = L.offs.slice(-12); // keep the learned lag / mirror / rhythm offset across reps
  L.dancer = d;
  const idx = beatsIn(L.seg.t0, L.seg.t1);
  L.rep = { idx, next: 0, res: [], sims: [], start: performance.now() };
  rulerClear();
  setScore(null, L.mode === 'full' ? '' : `Rep ${L.reps + 1}`);
}
function stopPlayback() {
  clearTimers(); refVideo.pause(); $('count').innerHTML = '';
  if (['count', 'play', 'gap', 'paused'].includes(L.phase)) setPhase('ready');
}
function pauseLesson() {
  if (L.phase === 'play' || L.phase === 'count' || L.phase === 'gap') { stopPlayback(); setPhase('ready'); $('startTxt').textContent = L.mode === 'full' ? 'Start the full run' : `Start move ${L.mi + 1}`; }
}

// ---- song clock (song time = reference video time; poses carry capture times in this page's performance.now())
let anchor = { vt: 0, p: 0 };
function songAt(perf) { return anchor.vt + ((perf - anchor.p) / 1000) * L.rate; }

function judgeDue(t) {
  const R = L.rep; if (!R) return;
  while (R.next < R.idx.length && t > L.beats[R.idx[R.next]] + JUDGE_LAG * L.rate) {
    const bi = R.idx[R.next], bt = L.beats[bi], len = (L.beats[bi + 1] ?? bt + beatLen()) - bt;
    const d = L.dancer;
    let r = { sim: null, q: 0, word: 'NOBODY' };
    if (d.seen && d.seen > bt - Math.max(len, 0.5)) { // the learner was tracked around this beat
      r = d.judge(bt, bi, len);
      if (r.sim == null) r.word = 'NO READ';
    }
    R.res.push(r);
    const k = L.mode === 'full' ? (((bi - barBeat()) % 8) + 8) % 8 : R.next;
    if (L.mode === 'full' && k === 0) rulerClear();
    rulerMark(k % 8, r.sim, r.q);
    R.next++;
    const sims = R.res.map((x) => x.sim).filter((x) => x != null);
    const mean = sims.length ? Math.round(sims.reduce((a, b) => a + b, 0) / sims.length) : null;
    const word = r.sim == null ? r.word : `${tier(r.sim)} · ${r.word}`;
    if (L.mode === 'full') setScore(d.points, word); else setScore(mean, word);
  }
}
function repDone() {
  const R = L.rep;
  const sims = R.res.map((x) => x.sim).filter((x) => x != null);
  const read = R.res.length ? sims.length / R.res.length : 0;
  const score = sims.length ? Math.round(sims.reduce((a, b) => a + b, 0) / sims.length) : null;
  L.offs = L.dancer.offs || L.offs;
  if (L.mode === 'full') return fullDone();
  L.reps++;
  const best = L.best[L.dance.id].moves;
  const pass = read >= 0.5 && score != null && score >= PASS;
  const prev = best[L.mi];
  if (score != null && read >= 0.5) best[L.mi] = { score: Math.max(score, prev?.score ?? 0), passed: pass || !!prev?.passed, rate: pass ? L.rate : prev?.rate };
  saveBest();
  L.lastRep = { mi: L.mi, score, read, pass, rate: L.rate };
  renderMoves();
  if (read < 0.5) {
    flash(Date.now() - L.lastBodyAt > 1500 ? 'Nobody in frame' : 'Too few poses to score', 'bad');
    setScore(score, 'Step into frame · go again');
    return loopAgain();
  }
  setScore(score, pass ? `PASS · ${tier(score)}` : `${tier(score)} · go again`);
  if (pass) {
    L.passed++;
    flash(`Pass · ${score}`, 'ok');
    if (L.mi + 1 < L.moves.length) later(1300, () => { L.reps = 0; gotoMove(L.mi + 1, true); });
    else later(1300, () => startFull());
    setPhase('ready');
    $('startTxt').textContent = L.mi + 1 < L.moves.length ? `Start move ${L.mi + 2}` : 'Start the full run';
  } else {
    flash(`${score} · again`, '');
    loopAgain();
  }
}
function loopAgain() { countIn(false); }
function fullDone() {
  refVideo.pause();
  const s = L.dancer.summary();
  L.full = { ...s, tier: tier(s.match) };
  const b = L.best[L.dance.id];
  b.full = Math.max(b.full ?? 0, s.points);
  saveBest();
  renderSummary();
  setPhase('summary');
  setTimeout(() => $('againBtn').focus(), 60);
}
function saveBest() { localStorage.setItem('rukh.lessonBest', JSON.stringify(L.best)); }

function renderSummary() {
  const f = L.full;
  $('sumPts').textContent = f.points;
  $('sumTier').textContent = f.tier;
  $('sumTier').style.setProperty('--tc', f.match >= 80 ? 'var(--t3)' : f.match >= 60 ? 'var(--t2)' : f.match >= 35 ? 'var(--t4)' : 'var(--t1)');
  $('sumSub').textContent = `${f.match}% match · ${f.onBeat}% on beat · ${L.dance.title} at ${rateTxt(L.rate)}`;
  // the run in eights: one row per bar, one cell per count (fill = match, pink foot = on the beat)
  const bars = $('sumBars'); bars.innerHTML = '';
  const head = document.createElement('div'); head.className = 'sum-bar head';
  for (let c = 1; c <= 8; c++) { const b = document.createElement('b'); b.textContent = c; head.appendChild(b); }
  bars.appendChild(head);
  let row = null;
  (L.rep?.idx || []).forEach((bi, j) => {
    const k = (((bi - barBeat()) % 8) + 8) % 8;
    if (!row || k === 0) { row = document.createElement('div'); row.className = 'sum-bar'; for (let c = 0; c < 8; c++) row.appendChild(document.createElement('i')); bars.appendChild(row); }
    const r = L.rep.res[j], cell = row.children[k];
    if (!r) return;
    cell.style.setProperty('--s', r.sim ?? 0);
    cell.className = (r.sim != null && r.sim >= PASS ? 'ok' : r.sim == null ? 'nil' : '') + (r.q >= 1 ? ' hit' : r.q > 0 ? ' half' : '');
  });
  const ol = $('sumMoves'); ol.innerHTML = '';
  const best = L.best[L.dance.id].moves;
  let weak = 0, weakS = 1e9;
  // per move: match in this run (beats inside the move) + best practice rep
  const inRun = (m) => {
    const v = [];
    (L.rep?.idx || []).forEach((bi, j) => { const b = L.beats[bi]; const r = L.rep.res[j]; if (r && r.sim != null && b >= m.t - 0.03 && b < m.end - 0.03) v.push(r.sim); });
    return v.length ? Math.round(v.reduce((x, y) => x + y, 0) / v.length) : null;
  };
  L.moves.forEach((m, i) => {
    const bm = best[i], li = document.createElement('li');
    const run = inRun(m), sc = run ?? bm?.score ?? null;
    if ((sc ?? -1) < weakS) { weakS = sc ?? -1; weak = i; }
    li.className = sc != null && sc >= PASS ? 'passed' : '';
    const practice = bm ? `best rep ${bm.score}${bm.passed ? ' · pass' + (bm.rate && bm.rate < 1 ? ' at ' + rateTxt(bm.rate) : '') : ''}` : 'not practised';
    li.innerHTML = `<em class="mono">${String(i + 1).padStart(2, '0')}</em><b></b><span class="mono">${run == null ? 'no read' : 'run ' + run} · ${practice}</span><i style="transform:scaleX(${(sc ?? 0) / 100})"></i>`;
    li.querySelector('b').textContent = m.label;
    ol.appendChild(li);
  });
  L.weak = weak;
  $('weakBtn').textContent = `Practise move ${weak + 1}: ${L.moves[weak].label}`;
}
L.showSummary = () => { renderSummary(); setPhase('summary'); }; // layout checks without dancing a full run
const rateTxt = (r) => (r === 0.5 ? '½ speed' : r === 0.75 ? '¾ speed' : 'full speed');

function setScore(v, word) {
  $('repScore').textContent = v == null ? '··' : String(v);
  $('repScore').classList.toggle('nil', v == null);
  $('repWord').textContent = word || '';
  const pct = L.mode === 'full' ? null : v;
  $('meterFill').style.transform = `scaleX(${pct == null ? 0 : clamp(pct / 100)})`;
  $('meter').classList.toggle('ok', pct != null && pct >= PASS);
  if (!reduced && v != null) { const el = $('repScore'); el.classList.remove('roll'); void el.offsetWidth; el.classList.add('roll'); }
}
let flashT = 0;
function flash(txt, cls) {
  const el = $('flash'); el.textContent = txt; el.className = 'flash show ' + (cls || '');
  clearTimeout(flashT); flashT = setTimeout(() => (el.className = 'flash'), 1400);
}
function setRate(r) {
  L.rate = r;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.rate) === r)));
  refVideo.playbackRate = r;
  if (L.phase === 'play' || L.phase === 'count' || L.phase === 'gap') { if (L.mode === 'full') startFull(); else gotoMove(L.mi, true); }
}
function setMirror(on) {
  L.mirrorRef = on;
  document.body.classList.toggle('mirror', on);
  $('mirBtn').setAttribute('aria-pressed', String(on));
}
function backToPick() {
  stopPlayback(); L.mode = 'move';
  refVideo.removeAttribute('src'); refVideo.load();
  $('danceTitle').textContent = 'Pick a dance'; $('danceMeta').textContent = '';
  history.replaceState(null, '', `${location.pathname}?${L.src === 'room' ? 'room=' + L.code : 'solo=1'}`);
  setPhase('pick');
  loadDances();
}

// ------------------------------------------------------------------ input
$('startBtn').onclick = () => {
  if (L.phase !== 'ready') return;
  if (L.mode === 'full') startFull(); else countIn(true);
};
$('fullBtn').onclick = () => L.ref && startFull();
$('prevBtn').onclick = () => L.ref && gotoMove(L.mi - 1, L.phase !== 'ready');
$('nextBtn').onclick = () => L.ref && gotoMove(L.mi + 1, L.phase !== 'ready');
$('retryBtn').onclick = () => { if (!L.ref) return; L.mode === 'full' ? startFull() : gotoMove(L.mi, true); };
$('mirBtn').onclick = () => setMirror(!L.mirrorRef);
document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => setRate(Number(b.dataset.rate))));
$('againBtn').onclick = () => startFull();
$('weakBtn').onclick = () => { L.reps = 0; gotoMove(L.weak || 0, false); };
$('otherBtn').onclick = backToPick;
$('pickRetry').onclick = loadDances;
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, .bugr, [contenteditable]')) return;
  const k = e.key;
  if (L.phase === 'pick') return;
  if (k === ' ' || k === 'Enter') {
    if (document.activeElement?.tagName === 'BUTTON' && k === 'Enter' && L.phase !== 'summary') return;
    e.preventDefault();
    if (L.phase === 'summary') { if (k === 'Enter') startFull(); return; }
    if (L.phase === 'ready') $('startBtn').click(); else pauseLesson();
  }
  else if (k === 'ArrowRight') { e.preventDefault(); $('nextBtn').click(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); $('prevBtn').click(); }
  else if (k === '1' || k === '2' || k === '3') setRate(RATES[Number(k) - 1]);
  else if (k === 'm' || k === 'M') setMirror(!L.mirrorRef);
  else if (k === 'r' || k === 'R') $('retryBtn').click();
  else if (k === 'f' || k === 'F') $('fullBtn').click();
  else if (k === 'Escape') backToPick();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseLesson();
  else navigator.wakeLock?.request?.('screen').catch(() => {});
});

// ------------------------------------------------------------------ per frame
function tick() {
  const now = performance.now();
  if (L.src === 'solo') detectStep(now);
  // pose rate over the last 2 s
  while (L.poseTimes.length && L.poseTimes[0] < now - 2000) L.poseTimes.shift();
  L.poseRate = L.poseTimes.length / 2;
  if (L.phase === 'play') {
    // the song clock follows the video; while it buffers or seeks the clock waits with it
    const stalled = refVideo.paused || refVideo.seeking || refVideo.readyState < 3;
    if (!stalled) { anchor = { vt: refVideo.currentTime, p: now }; L.stallFrom = 0; }
    else {
      anchor = { vt: refVideo.currentTime, p: now };
      L.stallFrom ||= now;
      if (refVideo.paused && !refVideo.ended && now - L.stallFrom > 400) refVideo.play().catch(() => {});
    }
    document.body.classList.toggle('buffering', !!L.stallFrom && now - L.stallFrom > 700);
    const t = songAt(now); L.t = t;
    judgeDue(t);
    // ruler cursor on the current count
    const R = L.rep;
    let k = -1;
    for (let j = 0; j < R.idx.length; j++) if (L.beats[R.idx[j]] <= t) k = j;
    if (k >= 0) { const cell = L.mode === 'full' ? ((((R.idx[k] - barBeat()) % 8) + 8) % 8) : k; if (cell !== L.cell) { L.cell = cell; rulerOn(cell); } }
    if (L.dancer?.simLive != null && L.mode === 'move' && (!L._lt || now - L._lt > 200)) {
      L._lt = now;
      $('meterFill').style.transform = `scaleX(${clamp(L.dancer.simLive / 100)})`;
      $('meter').classList.toggle('ok', L.dancer.simLive >= PASS);
    }
    if (refVideo.currentTime >= L.seg.t1 - 0.02 || refVideo.ended || (refVideo.duration && refVideo.currentTime >= refVideo.duration - 0.05)) {
      document.body.classList.remove('buffering');
      refVideo.pause();
      L.cell = -1;
      setPhase('gap');
      // wait for the last beats' late poses, then score the rep
      later(JUDGE_LAG * 1000 + 120, () => { if (L.phase !== 'gap') return; judgeDue(songAt(performance.now()) + 9); repDone(); });
    }
  } else if (L.phase === 'gap') judgeDue(songAt(now));
  draw(now);
  renderStatus(now);
  requestAnimationFrame(tick);
}

let lastStatus = 0;
function renderStatus(now) {
  if (now - lastStatus < 300) return;
  lastStatus = now;
  const live = L.cam === 'live';
  const nobody = live && now - L.lastBodyAt > 1500;
  const partial = live && !nobody && !L.whole;
  const slow = live && !nobody && L.poseRate < 4 && now - (L.camLiveAt ||= now) > 4000;
  const cs = $('camState');
  let msg = '';
  if (L.cam === 'loading') msg = 'Loading the dance tracker…';
  else if (L.cam === 'lost') msg = 'Camera phone disconnected · reconnecting';
  else if (L.cam === 'waiting') msg = `Phone camera · code ${L.code}`;
  else if (!live) msg = CAM_MSG[L.cam]?.[0] || '';
  else if (nobody) msg = L.src === 'room' ? 'Step in front of the phone' : 'Step into frame';
  else if (partial && L.phase !== 'play') msg = 'Step back · head to feet in frame';
  cs.hidden = !msg; cs.textContent = msg;
  cs.className = 'camstate' + (nobody ? ' big' : '');
  const rc = $('rateChip');
  rc.hidden = !live || nobody;
  rc.textContent = slow ? `Slow tracking · ${L.poseRate.toFixed(1)}/s` : `${L.poseRate.toFixed(0)} poses/s`;
  rc.title = slow ? 'Fewer than 4 poses a second: scores are rough. Close other apps or tabs.' : '';
  rc.classList.toggle('slow', slow);
  $('goHint').textContent = !live ? (CAM_MSG[L.cam]?.[0] || '') : nobody ? 'Step into frame — whole body, 2–3 m from the camera.' : partial ? 'Step back a little: head to feet in frame.' : slow ? 'Tracking is slow on this device: scores will be rough.' : 'You are in frame. Press start and copy the dancer.';
  if (L.phase === 'pick') $('previewMsg').textContent = !live ? (CAM_MSG[L.cam]?.[0] || '') : nobody ? 'Step into frame' : partial ? 'Step back · head to feet' : `In frame · ${L.poseRate.toFixed(0)} poses/s`;
  if (L.src === 'room' && link && live) {
    const s = link.stats;
    camLabel(`Phone · ${L.code} · ${(s.mode || link.state).toUpperCase()}${s.lat ? ' · ' + Math.round(s.lat) + ' ms' : ''}`, 'ok');
  }
}

// ------------------------------------------------------------------ drawing
function fit(W, H, vw, vh, cover) {
  const s = cover ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}
function sizeCanvas(cv) {
  const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (W && H && (cv.width !== W || cv.height !== H)) { cv.width = W; cv.height = H; }
  return { W: cv.width, H: cv.height, dpr };
}
function posesNow(now) {
  const delay = L.src === 'room' && link ? link.stats.delay || 0 : 0;
  const target = now - delay;
  let best = null;
  for (const f of L.poseBuf) if (!best || Math.abs(f.cap - target) < Math.abs(best.cap - target)) best = f;
  if (!best || now - best.cap > 900 + delay) return { poses: [], main: -1 };
  return best;
}
function drawCamInto(ctx, W, H, dpr, now, cover) {
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, W, H);
  let src = null, vw = L.camW, vh = L.camH;
  if (L.src === 'solo') { if (camVideo.videoWidth) { src = camVideo; vw = camVideo.videoWidth; vh = camVideo.videoHeight; } }
  else { const md = link?.media(); if (md) { src = md.src; vw = md.w; vh = md.h; } }
  const box = fit(W, H, vw || 16, vh || 9, cover);
  const mirror = L.src === 'solo' ? L.camMir : L.mirrorCam;
  if (src) {
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(src, W - box.x - box.w, box.y, box.w, box.h); }
    else ctx.drawImage(src, box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.fillStyle = 'rgba(12,13,16,.28)'; ctx.fillRect(0, 0, W, H); // dim the room so the tape skeleton reads
  }
  const f = posesNow(now);
  // the learner in pink tape, anyone else in dim chalk
  const others = f.poses.filter((p) => p.id !== f.main).map((p) => ({ ...p, id: 0 }));
  ctx.save(); ctx.globalAlpha = 0.35; drawPoses(ctx, others, box, { mirror, scale: dpr * Math.max(0.55, box.w / 1500) }); ctx.restore();
  const me = f.poses.filter((p) => p.id === f.main).map((p) => ({ ...p, id: 0 }));
  drawPoses(ctx, me, box, { mirror, scale: dpr * Math.max(0.6, box.w / 1200) });
  return box;
}
function draw(now) {
  if (L.phase === 'pick') {
    const { W, H, dpr } = sizeCanvas(prevCanvas);
    if (W && H) drawCamInto(pctx, W, H, dpr, now, true);
    return;
  }
  const { W, H, dpr } = sizeCanvas(camCanvas);
  if (W && H) drawCamInto(cctx, W, H, dpr, now, getComputedStyle(camCanvas).getPropertyValue('--cover').trim() === '1');
}

// ------------------------------------------------------------------ QR (ink on chalk)
function drawQr(canvas, text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), pad = 3, cell = Math.floor(canvas.width / (n + pad * 2));
  const off = Math.floor((canvas.width - cell * n) / 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ECE8DF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#141519';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
}

// ------------------------------------------------------------------ boot
$('homeLink').href = IS_APP ? '/index.html' : '/app';
$('passLbl').textContent = PASS;
$('meterPass').style.left = PASS + '%';
setRate(L.rate); setMirror(L.mirrorRef); buildRuler(8);
setPhase('pick');
loadDances();
if (L.src === 'room') startRoom(); else startSolo();
navigator.wakeLock?.request?.('screen').catch(() => {});
requestAnimationFrame(tick);
