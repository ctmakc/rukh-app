// TV screen: receives camera video + poses (link.js), plays the reference dance, scores 1–4 dancers,
// records the clip. Every empty / error state is designed and can be forced with ?simulate=<state>
// (see SIMS below) for screenshots and tests; ?demo=<1..4> feeds dancers made from the reference itself.
import { drawPoses, makeCode, TAPES, TAPE_NAMES, clamp, dedupeBodies } from './common.js';
import { ScreenLink, normCode } from './link.js';
import { ORIGIN, IS_APP, api } from './env.js';
import { Reference, Dancer, tier } from './score.js';
import { detectBeatsFromUrl } from './beat.js';
import qrcode from '/vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const ROUND_MAX = Number(qs.get('len') || 30); // seconds of dancing per round (clip length)
const SIM = qs.get('simulate') || '';
const DEMO = clamp(Number(qs.get('demo') || 0), 0, 6) | 0;
const refVideo = $('ref'), remote = $('remote'), stageCanvas = $('stage'), sctx = stageCanvas.getContext('2d');
const pageUrl = (name, q = '') => (IS_APP ? `/${name}.html` : `/${name}`) + q;
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const S = (window.rukh = {
  phase: 'lobby', code: '', dances: [], sel: 0, choreo: null, ref: null, beats: [], bpm: 0, beatSrc: '',
  dancers: new Map(), roster: new Set(), alias: new Map(), lastSeen: new Map(), absorbed: new Map(), together: new Map(), mergeLog: [], poseBuf: [], mirror: qs.get('mirror') !== '0',
  nextBeat: 0, beatIdx: -1, roundEnd: 0, clip: null, simClipTry: 0, poseMsgs: 0, lastPoseAt: 0, poseTimes: [],
  names: loadNames(), refErr: null, paused: null, modal: null, crowd: 0, crowdAt: 0, timers: [],
  level: Number(localStorage.getItem('rukh.level') ?? 0.8), muted: localStorage.getItem('rukh.muted') === '1',
  judgeLag: 0.75, sim: SIM,
});
function loadNames() {
  try { const n = JSON.parse(localStorage.getItem('rukh.names') || 'null'); if (Array.isArray(n) && n.length === 4) return n; } catch {}
  return TAPE_NAMES.slice();
}

// ---------- room + link
S.code = normCode(qs.get('room') || localStorage.getItem('rukh.screenRoom') || '');
if (S.code.length < 4) S.code = makeCode(); // the room socket needs 4–6 letters/digits
localStorage.setItem('rukh.screenRoom', S.code);
const camUrl = `${ORIGIN}/cam?room=${S.code}`;
$('roomCode').textContent = S.code; $('joinCode').textContent = S.code;
$('hostLbl').textContent = $('joinUrl').textContent = `${new URL(ORIGIN).host}/cam`;
drawQr($('joinQr'), camUrl);

// transport (direct WebRTC or relay frames) lives in link.js; link.stats has mode, rtt, latency, video delay
let link;
try { link = new ScreenLink({ room: S.code, video: remote }); }
catch (e) {
  // very old TV browsers: keep the page up and explain on the card
  console.error(e);
  link = Object.assign(new EventTarget(), { state: 'lost', stats: { delay: 0, rtt: 0, fps: 0 }, media: () => null, send() {} });
  S.linkBroken = true;
}
S.link = link;
const sig = { send: (m) => link.send(m) }; // phase messages to the phone
Object.defineProperties(S, {
  rtt: { get: () => link.stats.rtt, enumerable: true },
  videoDelay: { get: () => link.stats.delay, enumerable: true },
  linkState: { get: () => (SIM_LINK || link.state), enumerable: true },
});
let SIM_LINK = '';
link.addEventListener('pose', (e) => onPose(e.detail));
link.addEventListener('message', (e) => {
  const m = e.detail;
  if (m.type === 'crowd') { S.crowd = Number(m.n) || 0; S.crowdAt = performance.now(); }
});
link.addEventListener('state', (e) => {
  const st = e.detail.state;
  if (st === 'replaced') showModal('replaced');
  if (st === 'relay') S.relaySince = performance.now();
  if (st === 'direct' || st === 'relay') sig.send({ type: 'phase', text: phaseText() });
});

// ---------- poses (detail.cap = capture time on the phone, in this page's performance.now() ms)
// A dancer the phone lost for a moment (crossing, a missed detection at a low pose rate) can come back
// under a new tracker slot. During a round the new slot is stitched to the roster dancer who went missing
// nearest to where the new one appeared, so one person keeps one lane, one colour and one score.
// why lanes were joined or kept apart this round (tests read rukh.mergeLog)
const mlog = (e) => { if (S.mergeLog.length < 200) S.mergeLog.push(e); };
const hip = (lm) => [(lm[23][0] + lm[24][0]) / 2, (lm[23][1] + lm[24][1]) / 2];
// a dancer with at least 4 poses in this round's play phase (slots in the roster from the lobby may have none)
const established = (id) => (S.dancers.get(id)?.frames || 0) >= 4;
function stitch(poses, now) {
  if (S.phase === 'results' && S.lastResult?.length) { // keep the round's colours on the stage behind the results
    const ids = new Set(poses.map((p) => p.id)), used = new Set(), map = new Map(S.alias);
    for (const r of S.lastResult) for (const x of r.parts || []) if (x !== r.id) map.set(x, r.id); // merged slots
    return poses.map((p) => {
      const to = map.get(p.id);
      if (to == null || ids.has(to) || used.has(to)) return p;
      used.add(to); return { ...p, id: to };
    });
  }
  if (S.phase !== 'play' && S.phase !== 'count') return poses;
  const raw = new Set(poses.map((p) => p.id));
  // an alias whose own slot is back in the same frame: two real people, the alias goes
  for (const [from, to] of S.alias) if (raw.has(from) && raw.has(to)) { S.alias.delete(from); mlog({ unalias: [from, to], t: +(S._t || 0).toFixed(2) }); }
  const out = [], used = new Set();
  for (const p of poses) {
    let id = S.alias.get(p.id) ?? p.id;
    if (!S.alias.has(p.id) && S.roster.size && !established(id)) {
      // a slot with no dancing behind it yet (new, or only in the lobby roster): the nearest dancer of this round
      // who went missing 0.35–6 s ago takes it. At 1 pose/s a lobby slot can be the same person under a new id.
      const c = hip(p.lm);
      let best = null, bd = 0.45;
      for (const r of S.roster) {
        const ls = S.lastSeen.get(r);
        if (r === id || raw.has(r) || used.has(r) || !ls || now - ls.t < 350 || now - ls.t > 6000) continue;
        if (S.roster.has(id) && !established(r)) continue; // two lobby slots: both may be real people
        const dd = Math.hypot(c[0] - ls.c[0], c[1] - ls.c[1]);
        if (dd < bd) { bd = dd; best = r; }
      }
      if (best != null) {
        S.alias.set(p.id, best); mlog({ live: [p.id, best], t: +(S._t || 0).toFixed(2) });
        // the absorbed slot's few poses (if any) go along; its lane goes
        const x = S.dancers.get(p.id);
        if (x) { S.absorbed.set(best, [...(S.absorbed.get(best) || []), x]); S.dancers.delete(p.id); }
        if (S.roster.delete(p.id)) renderLanes(true);
        id = best;
      }
    }
    if (used.has(id)) id = p.id; // never two poses on one dancer in a frame
    used.add(id);
    S.lastSeen.set(id, { t: now, c: hip(p.lm) });
    out.push(id === p.id ? p : { ...p, id });
  }
  // who was in frame together: the end-of-round merge never joins two people seen side by side
  if (S.phase === 'play' && out.length > 1) for (const a of out) for (const b of out) if (a.id < b.id) { const k = a.id + '-' + b.id; S.together.set(k, (S.together.get(k) || 0) + 1); }
  return out;
}
// one body sent twice (older phones send raw detections): keep the copy on an established dancer
function dedupe(poses) {
  if (poses.length < 2) return poses;
  const rank = (p) => (established(p.id) ? 0 : S.roster.has(p.id) ? 1 : 2) * 10 + p.id;
  const out = dedupeBodies([...poses].sort((a, b) => rank(a) - rank(b)), (p) => p.lm);
  if (out.length < poses.length) S.dupFrames = (S.dupFrames || 0) + 1;
  return out;
}
function onPose(m) {
  const now = performance.now();
  const cap = m.cap;
  m = { ...m, poses: stitch(dedupe(m.poses || []), now) };
  S.poseMsgs++; S.lastPoseAt = now; S.poseTimes.push(now);
  S.camAspect = m.w && m.h ? m.w / m.h : 16 / 9;
  S.poseBuf.push({ cap, poses: m.poses || [] });
  while (S.poseBuf.length && S.poseBuf[0].cap < now - 2500) S.poseBuf.shift();
  if (S.phase === 'play' && !S.paused) {
    const t = songTimeAt(cap);
    for (const p of m.poses || []) {
      if (!S.dancers.has(p.id)) S.dancers.set(p.id, new Dancer(p.id));
      const d = S.dancers.get(p.id);
      d.frames = (d.frames || 0) + 1;
      if (!d.first) d.first = { t, c: hip(p.lm) };
      d.last = { t, c: hip(p.lm) };
      // a slot that flickers for a frame or two (tracker swap at a low pose rate) gets no lane
      if (!S.roster.has(p.id) && (d.frames >= 4 || !S.roster.size)) { S.roster.add(p.id); renderLanes(true); }
      d.push(p.lm, t, S.ref, S.camAspect);
    }
  }
}
function posesForDisplay(now) {
  const target = now - S.videoDelay;
  let best = null;
  for (const f of S.poseBuf) if (!best || Math.abs(f.cap - target) < Math.abs(best.cap - target)) best = f;
  if (!best || now - best.cap > 1200) return [];
  return best.poses;
}
const camLive = (now = performance.now()) => !!link.media() || now - S.lastPoseAt < 1500;
function poseRate(now) {
  while (S.poseTimes.length && S.poseTimes[0] < now - 4000) S.poseTimes.shift();
  return S.poseTimes.length / 4;
}
// a pose that is missing its head or both ankles: the dancer is too close or cut off
const wholeBody = (lm) => lm && lm[0][2] > 0.35 && (lm[27][2] > 0.35 || lm[28][2] > 0.35) && lm[27][1] < 0.995 && lm[28][1] < 0.995;

// ---------- dances
async function loadDances() {
  try {
    const r = await fetch('/ref/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S.dances = await r.json();
  } catch (e) { S.dances = []; S.listErr = e.message; }
  const pk = $('picker'); pk.innerHTML = '';
  S.dances.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'pick'; b.setAttribute('role', 'option');
    const lv = { easy: 1, medium: 2, hard: 3 }[d.level] || 0;
    b.innerHTML = `<img alt="" src="${esc(d.poster)}"><div><b></b><span class="meta"><i class="lv" data-lv="${lv}"><s></s><s></s><s></s></i>${esc((d.level || '').toUpperCase())}${d.style ? ' · ' + esc(d.style.toUpperCase()) : ''}<em class="mono">${Math.round(d.bpm)} BPM</em></span></div>`;
    b.querySelector('b').textContent = d.title;
    b.onclick = () => select(i);
    pk.appendChild(b);
  });
  if (!S.dances.length) {
    pk.innerHTML = '<p class="present">The dance list did not load.</p>';
    S.refErr = 'list'; showModal('reffail');
  } else select(Math.max(0, S.dances.findIndex((d) => d.id === qs.get('dance'))));
}
async function select(i) {
  if (!S.dances.length) return;
  S.sel = (i + S.dances.length) % S.dances.length;
  const picks = [...$('picker').children];
  picks.forEach((b, k) => b.setAttribute('aria-selected', String(k === S.sel)));
  picks[S.sel]?.scrollIntoView({ block: 'nearest' });
  const d = S.dances[S.sel];
  $('danceTitle').textContent = d.title;
  $('danceLvl').textContent = [d.level, d.style].filter(Boolean).join(' · ');
  $('bpm').textContent = `${Math.round(d.bpm)} BPM`;
  const lq = `?room=${S.code}&dance=${encodeURIComponent(d.id)}`;
  $('lessonLink').href = $('lessonAfter').href = pageUrl('lesson', lq);
  S.refErr = null; picks[S.sel]?.classList.remove('bad');
  if (S.modal === 'reffail') hideModal();
  S.choreo = null; S.ref = null; S.beats = [];
  const myId = d.id;
  let choreo, vurl;
  try {
    if (SIM === 'reffail') throw new Error('simulated');
    // the whole video as a blob: the asset server answers without byte ranges, and a video that is
    // not fully in memory cannot seek (resume after a pause restarts at the last beat)
    const [r, rv] = await Promise.all([fetch(d.json), fetch(d.video)]);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!rv.ok) throw new Error('video HTTP ' + rv.status);
    choreo = await r.json();
    if (!choreo.frames?.length) throw new Error('no poses in the file');
    vurl = URL.createObjectURL(await rv.blob());
  } catch (e) { if (S.dances[S.sel].id === myId) failRef(e.message); return; }
  if (S.dances[S.sel].id !== myId) { URL.revokeObjectURL(vurl); return; }
  const old = S.videoUrl;
  S.videoUrl = vurl; refVideo.src = vurl; refVideo.load();
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  S.choreo = choreo; S.ref = new Reference(choreo);
  // beats: detected right here from the track's audio; the JSON grid is the fallback
  S.beats = choreo.beats || []; S.bpm = choreo.bpm; S.beatSrc = 'json';
  try {
    const det = await detectBeatsFromUrl(vurl, choreo.bpm || 0);
    // never swap the grid under a running round
    if (S.dances[S.sel].id === myId && det.beats.length > 8 && S.phase === 'lobby') { S.beats = det.beats; S.bpm = det.bpm; S.beatSrc = 'audio'; }
  } catch (e) { console.warn('beat detection failed, using JSON grid', e); }
  if (S.dances[S.sel].id === myId) $('bpm').textContent = `${Math.round(S.bpm)} BPM`;
}
refVideo.addEventListener('error', () => { if (S.dances[S.sel] && refVideo.src === S.videoUrl) failRef('the video did not play'); });
function failRef(why) {
  S.refErr = why || 'error';
  $('picker').children[S.sel]?.classList.add('bad');
  if (S.phase === 'play' || S.phase === 'count') endRound();
  showModal('reffail');
}

// ---------- sound: reference video → music gain ┐
//                    count-in clicks → click gain ┴→ master (mute) → speakers; the clip records music + clicks
let ac = null, recDest = null, master = null, music = null, clicks = null;
function ensureAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain(); master.connect(ac.destination);
  music = ac.createGain(); music.connect(master);
  clicks = ac.createGain(); clicks.gain.value = 0.9; clicks.connect(master);
  recDest = ac.createMediaStreamDestination();
  const src = ac.createMediaElementSource(refVideo);
  src.connect(music); src.connect(recDest);
  applySound();
}
function applySound() {
  S.level = clamp(Math.round(S.level * 10) / 10, 0, 1);
  localStorage.setItem('rukh.level', S.level); localStorage.setItem('rukh.muted', S.muted ? '1' : '0');
  if (ac) { music.gain.setTargetAtTime(S.level, ac.currentTime, 0.03); master.gain.setTargetAtTime(S.muted ? 0 : 1, ac.currentTime, 0.03); }
  const chip = $('soundChip');
  chip.classList.toggle('muted', S.muted);
  $('soundTxt').textContent = S.muted ? 'Muted · M' : `Music ${Math.round(S.level * 100)}%`;
  [...chip.querySelectorAll('.bars b')].forEach((b, i) => b.classList.toggle('on', !S.muted && S.level >= (i + 1) / 4 - 0.05));
}
// true when the browser lets us play sound now (TV browsers may block it until a key press or tap)
async function audioOn() {
  try { ensureAudio(); } catch { return false; }
  if (SIM === 'sound' && !S.simSoundOk) return false;
  try { await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 500))]); } catch {}
  return ac.state === 'running';
}
function click(at, hi) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = hi ? 1320 : 880; o.type = 'square';
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.25, at + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  o.connect(g); g.connect(clicks); g.connect(recDest); o.start(at); o.stop(at + 0.12);
}
async function soundCheck() {
  if (S.phase !== 'lobby' || S.checking) return;
  if (!(await audioOn())) { showModal('sound', { then: soundCheck }); return; }
  S.checking = true; $('soundChip').classList.add('live');
  flash('Sound check', 'Four clicks, then 4 seconds of the music. − / + sets the music level, M mutes.', 6500);
  const p = 0.5, t0 = ac.currentTime + 0.1;
  for (let k = 0; k < 4; k++) click(t0 + k * p, k === 3);
  later(t0 + 4 * p, () => { refVideo.currentTime = 0; refVideo.play().catch(() => {}); });
  later(t0 + 4 * p + 4, () => { refVideo.pause(); refVideo.currentTime = 0; S.checking = false; $('soundChip').classList.remove('live'); });
}
const later = (at, fn) => { const id = setTimeout(fn, Math.max(0, (at - ac.currentTime) * 1000)); S.timers.push(id); return id; };
function clearTimers() { S.timers.forEach(clearTimeout); S.timers = []; }

// ---------- round flow
function phaseText() {
  if (S.phase === 'play') return S.paused ? 'Round paused — the TV lost the camera. Keep the phone on.' : 'Round is on — dance! Keep the phone still.';
  if (S.phase === 'results') return 'Round over — scan the QR on the TV for your clip.';
  return 'Linked to the TV. Step into frame, whole body.';
}
// 5 · 6 · 7 · 8 on the track's beat; `lead` = seconds of video before the beat that should land on "1"
function countIn(lead, onPlay) {
  const period = 60 / (S.bpm || 120);
  const t0 = ac.currentTime + 0.3;
  setPhase('count');
  ['5', '6', '7', '8'].forEach((n, k) => {
    click(t0 + k * period, k === 3);
    later(t0 + k * period, () => { $('count').innerHTML = `<span>${n}</span>`; litRuler(4 + k); });
  });
  later(Math.max(ac.currentTime, t0 + 4 * period - lead), onPlay);
  later(t0 + 4 * period, () => { $('count').innerHTML = ''; });
}
async function startRound() {
  if (S.phase !== 'lobby' || S.modal) return;
  if (S.refErr) { showModal('reffail'); return; }
  if (!S.ref) { flash('Loading the dance', 'One moment — the reference is still loading.', 3000); return; }
  if (!camLive()) { flash('No camera phone yet', `Scan the QR on the left or open ${new URL(ORIGIN).host}/cam and type ${S.code}.`, 6000); return; }
  if (!(await audioOn())) { showModal('sound', { then: startRound }); return; }
  S.dancers.clear(); S.roster = new Set(posesForDisplay(performance.now()).map((p) => p.id)); S.alias = new Map(); S.lastSeen = new Map();
  S.absorbed = new Map(); S.together = new Map(); S.mergeLog = [];
  S.nextBeat = 0; S.beatIdx = -1; S.paused = null; S.noWatch = false; S.lastResult = null; S.clip = null; S.clipBlob = null;
  S.roundAt = Date.now();
  buildRuler(); renderLanes(true);
  sig.send({ type: 'phase', text: 'Count-in — get ready!' });
  startRecorder();
  refVideo.pause(); refVideo.currentTime = 0;
  const lead = clamp(S.beats[0] ?? 0, 0, 2);
  countIn(lead, () => {
    refVideo.currentTime = 0; anchor = { vt: 0, p: performance.now() };
    playRef();
    S.roundEnd = Math.min(ROUND_MAX, refVideo.duration || ROUND_MAX);
    setPhase('play');
    sig.send({ type: 'phase', text: phaseText() });
  });
}
function playRef() {
  refVideo.play().catch((e) => {
    if (e.name === 'NotAllowedError') { pauseRound('sound'); showModal('sound', { then: resumeRound }); }
  });
}
function pauseRound(why) {
  if (S.phase !== 'play' || S.paused) return;
  S.paused = why; S.pausedAt = songNow();
  refVideo.pause();
  try { if (rec?.state === 'recording') rec.pause(); } catch {}
  document.body.classList.add('paused');
  if (why === 'camlost') { showModal('camlost'); sig.send({ type: 'phase', text: phaseText() }); }
}
function resumeRound() {
  if (!S.paused) return;
  if (S.modal === 'camlost' || S.modal === 'sound') hideModal();
  // restart from the last beat before the pause, so the "1" after the count-in is a real beat
  const B = S.beats; let k = -1;
  for (let i = 0; i < B.length && B[i] <= S.pausedAt - 0.05; i++) k = i;
  const from = k >= 0 ? B[k] : 0;
  refVideo.currentTime = from; anchor = { vt: from, p: performance.now() };
  countIn(0, () => {
    anchor = { vt: refVideo.currentTime, p: performance.now() };
    playRef();
    try { if (rec?.state === 'paused') rec.resume(); } catch {}
    S.paused = null; document.body.classList.remove('paused');
    setPhase('play');
    sig.send({ type: 'phase', text: phaseText() });
  });
}
function abortCount() {
  clearTimers(); $('count').innerHTML = '';
  if (S.paused) { endRound(true); return; }
  stopRecorder(true); refVideo.pause(); setPhase('lobby'); renderLanes(true);
}
// One person = one result row. A lane that only ever existed while another lane was away (never both in one
// frame), starting within 6 s of where and when the other was last seen, is the same dancer under a new tracker
// slot: their beats are added up. Then a lane is ranked only if it took part: judged on at least a quarter of the
// beats (min 5; a lane is judged for 2 s after its last pose, so a brief ghost gets 2–4) and not a 0-point leaver.
function mergedSummary(ds) {
  const sum = (k) => ds.reduce((a, d) => a + (d[k] || 0), 0);
  const n = sum('beatsJudged'), simN = sum('simN');
  const one = new Dancer(ds[0].id);
  Object.assign(one, { points: sum('points'), beatsJudged: n, kSum: sum('kSum'), cSum: sum('cSum'), simSum: sum('simSum'), simN });
  return { ...one.summary(), beatsJudged: n, seen: Math.max(...ds.map((d) => d.seen || 0)), parts: ds.map((d) => d.id) };
}
function rankRows(judged) {
  const groups = [...S.dancers.values()].map((d) => ({ id: d.id, ds: [d, ...(S.absorbed.get(d.id) || [])], first: d.first, last: d.last }));
  groups.sort((a, b) => (a.first?.t ?? 0) - (b.first?.t ?? 0));
  // seen side by side in more than a few frames (2, or 10% of the shorter lane's poses): two people
  const both = (g, h) => { let n = 0; for (const a of g.ds) for (const b of h.ds) n += S.together.get(Math.min(a.id, b.id) + '-' + Math.max(a.id, b.id)) || 0; return n; };
  const frames = (g) => g.ds.reduce((a, d) => a + (d.frames || 0), 0);
  const apart = (g, h) => both(g, h) <= Math.max(2, 0.1 * Math.min(frames(g), frames(h)));
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g) continue;
    for (let j = i + 1; j < groups.length; j++) {
      const h = groups[j];
      if (!h || !g.last || !h.first) continue;
      const gap = h.first.t - g.last.t, dist = Math.hypot(h.first.c[0] - g.last.c[0], h.first.c[1] - g.last.c[1]);
      // a short overlap is allowed (a dancer is judged 2 s past the last pose; slots can hand over mid-flicker)
      const ok = apart(g, h) && gap >= -1.5 && gap <= 6 && dist <= 0.45;
      mlog({ pair: [g.id, h.id], both: both(g, h), frames: [frames(g), frames(h)], gap: +gap.toFixed(2), dist: +dist.toFixed(2), ok });
      if (!ok) continue;
      g.ds.push(...h.ds); g.last = h.last; groups[j] = null;
    }
  }
  const need = Math.max(5, Math.round(judged * 0.25));
  return groups.filter(Boolean).map((g) => mergedSummary(g.ds))
    .map((r) => ({ ...r, early: judged > 8 && r.beatsJudged < judged * 0.5 && r.seen < (S._t || 0) - 3 }))
    .filter((r) => r.beatsJudged >= need && !(r.early && r.points === 0))
    .sort((a, b) => b.points - a.points);
}
function endRound(force) {
  if (S.phase !== 'play' && !(force && S.phase === 'count')) return;
  clearTimers(); $('count').innerHTML = '';
  refVideo.pause();
  if (S.modal === 'camlost') hideModal();
  S.paused = null; document.body.classList.remove('paused');
  const judged = S.nextBeat;
  const rows = rankRows(judged);
  rows.forEach((r) => { r.place = 1 + rows.filter((o) => o.points > r.points).length; r.tie = rows.filter((o) => o.points === r.points).length > 1; });
  S.lastResult = rows;
  renderPodium(rows);
  saveBoard(rows);
  setPhase('results');
  sig.send({ type: 'phase', text: phaseText() });
  finalCardUntil = performance.now() + 2500;
  try { if (rec?.state === 'paused') rec.resume(); } catch {}
  // the final card stays in the clip for 2.6 s; the timer stops this round's recorder only (a new round has its own)
  const mine = rec;
  setTimeout(() => stopRecorder(false, mine), 2600);
}
function setPhase(p) {
  S.phase = p;
  document.body.className = document.body.className.replace(/\bphase-\w+/, '').trim() + ' phase-' + p;
  if (p === 'lobby') { $('startBtn').focus({ preventScroll: true }); renderBoard(); }
  if (p === 'results') { renderBoard(); renderLanes(true); setTimeout(() => $('againBtn').focus({ preventScroll: true }), 50); }
}
$('startBtn').onclick = startRound;
$('checkBtn').onclick = soundCheck;
$('againBtn').onclick = () => { if (S.modal) return; setPhase('lobby'); renderLanes(true); sig.send({ type: 'phase', text: phaseText() }); };
$('clipRetry').onclick = () => S.clipBlob && uploadClip(S.clipBlob);
$('soundChip').onclick = () => { S.muted = !S.muted; ensureAudio(); ac?.resume(); applySound(); };

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable], .bugr-dlg, mmix-review-entry')) return;
  const k = e.key;
  if (S.modal) {
    const act = modalKeys.find((m) => m.key === k || (k === ' ' && m.key === 'Enter'));
    if (act) { e.preventDefault(); act.fn(); }
    return;
  }
  if (k === 'Enter' || k === ' ') {
    if (e.repeat) { e.preventDefault(); return; } // a held key must not skip results and start the next round
    const ae = document.activeElement;
    if (ae && ae !== $('startBtn') && ae !== $('againBtn') && ae.matches?.('button, a')) return; // the focused control clicks itself
    e.preventDefault();
    if (S.phase === 'lobby') startRound(); else if (S.phase === 'results') $('againBtn').click();
    return;
  }
  if (S.phase === 'lobby' && (k === 'ArrowDown' || k === 'ArrowUp')) { e.preventDefault(); select(S.sel + (k === 'ArrowDown' ? 1 : -1)); }
  if (k === 'm' || k === 'M') { S.muted = !S.muted; applySound(); }
  if (k === '-' || k === '_' || k === '[') { S.level -= 0.1; S.muted = false; applySound(); }
  if (k === '+' || k === '=' || k === ']') { S.level += 0.1; S.muted = false; applySound(); }
  if (k === 'f' || k === 'F') S.mirror = !S.mirror;
  if ((k === 't' || k === 'T') && S.phase === 'lobby') soundCheck();
  if ((k === 'l' || k === 'L') && (S.phase === 'lobby' || S.phase === 'results')) location.href = $('lessonLink').href;
  if ((k === 'r' || k === 'R') && S.phase === 'results' && S.clipBlob && !S.clip) uploadClip(S.clipBlob);
  if (k === 'Escape') { if (S.phase === 'play') endRound(); else if (S.phase === 'count') abortCount(); }
});

// ---------- state banners (top of the stage, highest priority first) + blocking cards
let flashUntil = 0, flashMsg = null;
function flash(t, s, ms = 5000) { flashMsg = [t, s, 'info']; flashUntil = performance.now() + ms; evalBanner(); }
function bannerFor(now) {
  if (SIM && SIM_BANNERS[SIM]) return SIM_BANNERS[SIM]();
  if (!navigator.onLine) return ['Offline', 'This screen lost the internet. The room comes back by itself once Wi-Fi is back.', 'bad'];
  if (flashMsg && now < flashUntil) return flashMsg;
  const live = camLive(now), active = S.phase === 'play' || S.phase === 'count' || S.phase === 'lobby';
  if (S.crowd > 4 && now - S.crowdAt < 3000 && active) return [`${S.crowd} people in frame`, 'RUKH scores 4 dancers. Everyone else, step out of the picture.', 'warn'];
  // a slow pose stream is checked first: with 1–2 poses/s skeletons drop out between poses, and
  // 'Nobody in frame' / 'Step back' would send dancers away for nothing
  const rate = live && now - S.liveSince > 5000 ? poseRate(now) : null;
  const slow = rate != null && rate < 6 && active ? [`Phone is slow · ${rate.toFixed(1)} poses/s`, 'Close other apps on the phone, plug in the charger, keep it out of the sun.', 'warn'] : null;
  if (slow && rate < 3) return slow;
  if (live && active && !S.paused && S.phase !== 'lobby') {
    const ps = posesForDisplay(now);
    if (!ps.length) { if (now - (S.seenSomeone || 0) > 2000) return ['Nobody in frame', 'Step back — whole body, head to feet, 2–4 m from the phone.', 'warn']; }
    else S.seenSomeone = now;
  }
  if (live && active) {
    const ps = posesForDisplay(now);
    const cut = ps.filter((p) => !wholeBody(p.lm));
    if (cut.length) { S.cutSince ??= now; } else S.cutSince = null;
    if (S.cutSince && now - S.cutSince > 1500) return ['Step back — whole body', `${cut.map((p) => S.names[p.id]).join(', ')}: head to feet in the picture, so every move counts.`, 'warn', 'low']; // at the foot of the stage: the cut dancer's name tape sits at the top
  }
  if (slow) return slow;
  if (active && S.linkState === 'relay' && now - (S.relaySince || 0) < 9000) return ['Relay mode', 'Phone and TV are on different networks: video goes through the RUKH server, a little behind. Scores count the same.', 'info'];
  return null;
}
function evalBanner() {
  const now = performance.now();
  if (camLive(now)) S.liveSince ??= now; else S.liveSince = null;
  const b = bannerFor(now), el = $('banner');
  if (!b) { if (!el.hidden) el.hidden = true; return; }
  if ($('bannerT').textContent !== b[0]) { $('bannerT').textContent = b[0]; el.classList.remove('lay'); void el.offsetWidth; el.classList.add('lay'); }
  $('bannerS').textContent = b[1];
  el.dataset.kind = b[2]; el.dataset.pos = b[3] || ''; el.hidden = false;
}
setInterval(evalBanner, 250);
addEventListener('offline', evalBanner); addEventListener('online', evalBanner);

let modalKeys = [], modalThen = null;
const MODALS = {
  camlost: () => ({
    tag: 'Round paused', tc: 'var(--t4)', h: 'Camera phone lost',
    p: `Paused at ${fmt(S.pausedAt || 0)}. Keep the phone on with RUKH open — it reconnects by itself, and the round goes on after a count-in.`,
    keys: [['Enter', 'Go on without it', () => { S.noWatch = true; resumeRound(); }], ['Esc', 'End the round', () => endRound()]],
  }),
  sound: () => ({
    tag: 'Sound', tc: 'var(--t2)', h: 'Press any key to turn on the sound',
    p: 'This browser keeps a page silent until someone presses a key or taps the screen once.',
    keys: [['Enter', 'Sound on', soundUnlock], ['Esc', 'Not now', () => { hideModal(); if (S.paused === 'sound') endRound(); }]],
  }),
  reffail: () => ({
    tag: 'Dance', tc: 'var(--t1)', h: S.refErr === 'list' ? 'The dance list did not load' : `“${S.dances[S.sel]?.title || 'This dance'}” did not load`,
    p: `${navigator.onLine ? 'The server did not answer in time' : 'This screen is offline'} (${S.refErr === 'list' ? S.listErr || 'error' : S.refErr}). Try again, or pick another dance with ↑ ↓.`,
    keys: [['R', 'Try again', () => { if (S.refErr === 'list') location.reload(); else select(S.sel); }], ['Esc', 'Pick another', () => hideModal()]],
  }),
  replaced: () => ({
    tag: 'Room', tc: 'var(--t4)', h: `Room ${S.code} is open on another screen`,
    p: 'Only one screen can hold a room. The camera phone now talks to the other one.',
    keys: [['Enter', 'Take it back here', () => location.reload()], ['N', 'New room code', newRoom]],
  }),
  unsupported: () => ({
    tag: 'Browser', tc: 'var(--t1)', h: 'This browser cannot run the RUKH screen',
    p: `Missing: ${S.missing.join(', ')}. Open this page in a current Chrome, Edge, Safari or Firefox — on a laptop on HDMI if the TV browser is old.`,
    keys: [['Enter', 'Try anyway', () => hideModal()]],
  }),
};
function showModal(name, opt = {}) {
  const def = MODALS[name]?.(); if (!def) return;
  S.modal = name; modalThen = opt.then || null;
  $('modalTag').textContent = def.tag; $('modalTag').style.setProperty('--tc', def.tc);
  $('modalH').textContent = def.h; $('modalP').textContent = def.p;
  modalKeys = def.keys.map(([key, label, fn]) => ({ key: key === 'Esc' ? 'Escape' : key.length === 1 ? key.toLowerCase() : key, label, fn }));
  const kk = $('modalKeys'); kk.innerHTML = '';
  def.keys.forEach(([key, label], i) => {
    const b = document.createElement('button');
    b.className = i ? 'ghost' : 'start';
    b.innerHTML = `<span></span><small>${esc(key)}</small>`; b.querySelector('span').textContent = label;
    b.onclick = () => modalKeys[i].fn();
    kk.appendChild(b);
  });
  // letter keys work in both cases
  modalKeys = modalKeys.flatMap((m) => (m.key.length === 1 ? [m, { ...m, key: m.key.toUpperCase() }] : [m]));
  $('modal').hidden = false; $('modal').dataset.name = name;
  setTimeout(() => kk.firstChild?.focus({ preventScroll: true }), 30);
}
function hideModal() { S.modal = null; modalKeys = []; $('modal').hidden = true; }
async function soundUnlock() {
  if (SIM === 'sound') S.simSoundOk = true;
  ensureAudio(); try { await ac.resume(); } catch {}
  if (ac.state !== 'running') return;
  hideModal(); const t = modalThen; modalThen = null; t?.();
}
function newRoom() { localStorage.removeItem('rukh.screenRoom'); location.href = location.pathname; }
// any tap or key also unlocks sound while the sound card is up
addEventListener('pointerdown', () => { if (S.modal === 'sound' && SIM !== 'sound') soundUnlock(); });

// ---------- per-frame: song clock, beat judging, camera watchdog, drawing
let anchor = { vt: 0, p: 0 };
function songTimeAt(perf) { return anchor.vt + (perf - anchor.p) / 1000; }
function songNow() { return songTimeAt(performance.now()); }

function tick() {
  const now = performance.now();
  // judge each beat once late pose packets are in: wait longer when the link is slow (relay, busy phone)
  S.judgeLag = clamp(((link.stats.latP95 || 0) + 250) / 1000, 0.75, 2);
  if (S.phase === 'play' || S.phase === 'count') {
    if (!refVideo.paused || S.paused || S.phase === 'count') anchor = { vt: refVideo.currentTime, p: now };
  }
  if (S.phase === 'play') {
    const t = songNow(); S._t = t;
    const B = S.beats;
    while (!S.paused && S.nextBeat < B.length && t > B[S.nextBeat] + S.judgeLag) {
      const bt = B[S.nextBeat], len = (B[S.nextBeat + 1] ?? bt + 0.5) - bt;
      for (const d of S.dancers.values()) {
        if (t - d.seen > 2) continue;
        d.judge(bt, S.nextBeat, len);
        notch(S.nextBeat, d.id, d.notes[d.notes.length - 1][1]);
      }
      S.nextBeat++;
      renderLanes();
    }
    let bi = -1;
    for (let i = Math.max(0, S.nextBeat - 4); i < B.length && B[i] <= t; i++) bi = i;
    if (bi !== S.beatIdx && bi >= 0) { S.beatIdx = bi; moveRuler(bi); }
    $('timeLeft').textContent = fmt(Math.ceil(Math.max(0, S.roundEnd - t)));
    renderMove(t);
    if (!S.paused && (t >= S.roundEnd || refVideo.ended)) endRound();
    // camera watchdog: no video and no poses for 2.5 s → pause; back for 1 s → count-in and go on
    if (!S.paused && !S.noWatch && !camLive(now)) { S.lostSince ??= now; if (now - S.lostSince > 1000) pauseRound('camlost'); }
    else S.lostSince = null;
    if (S.paused === 'camlost' && now - S.lastPoseAt < 1500 && link.media()) { S.backSince ??= now; if (now - S.backSince > 1200) resumeRound(); }
    else if (S.paused) S.backSince = null;
    if (!S._simT || now - S._simT > 200) { S._simT = now; renderSims(); }
  }
  drawStage(now);
  if (rec) drawRecord(now);
  // presence (lobby)
  const live = posesForDisplay(now), cnt = live.length, cl = camLive(now);
  const key = `${cnt}|${cl}|${S.crowd > 4 && now - S.crowdAt < 3000 ? S.crowd : 0}`;
  if (key !== S._pk) {
    S._pk = key;
    const crowd = S.crowd > 4 && now - S.crowdAt < 3000;
    $('presentTxt').innerHTML = !cl ? '<span class="dot"></span>Camera phone not linked yet'
      : crowd ? `<span class="dot warn"></span><b>${S.crowd} people</b> in frame — 4 can play`
        : cnt ? `<span class="dot ok"></span><b>${cnt} dancer${cnt > 1 ? 's' : ''}</b> in frame — ready`
          : '<span class="dot ok"></span>Camera linked — step into frame';
    $('startBtn').classList.toggle('wait', !cl);
    if (S.phase === 'lobby') renderLanes();
  }
  renderCorner(now);
  document.body.classList.toggle('has-cam', cl);
  requestAnimationFrame(tick);
}
function renderMove(t) {
  const mv = S.choreo?.moves || [];
  const cur = mv.find((m) => m.t <= t && t < m.end), nx = mv.find((m) => m.t > t);
  const txt = cur ? cur.label : nx ? nx.label : '—';
  if ($('moveNext').textContent !== txt) $('moveNext').textContent = txt;
  const lbl = cur ? 'Now' : 'Next move';
  const k = $('moveNext').previousElementSibling; if (k.textContent !== lbl) k.textContent = lbl;
}
let cornerTxt = '';
function renderCorner(now) {
  const st = S.linkState, s = link.stats;
  let t;
  if (st === 'direct') t = `DIRECT · ${Math.round(s.delay)} ms`;
  else if (st === 'relay') t = `RELAY · ${Math.round(s.delay)} ms · ${s.fps || 0} fps`;
  else if (st === 'waiting') t = 'NO CAMERA';
  else if (st === 'replaced') t = 'ROOM TAKEN';
  else if (st === 'lost') t = 'RECONNECTING';
  else t = 'LINKING';
  if (!SIM_LINK && demoN && !link.media()) t = `DEMO · ${Math.min(4, demoN)} dancer${demoN > 1 ? 's' : ''}`;
  if (t !== cornerTxt) { cornerTxt = t; const c = $('corner'); c.textContent = t; c.dataset.st = st; }
}

function fitBox(W, H, vw, vh, cover) {
  const s = cover ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
  const w = vw * s, h = vh * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
function drawCam(ctx, W, H, now, scale, cover) {
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, W, H);
  const md = SIM_NOVIDEO ? null : link.media(); // live camera: <video> (direct) or the latest relay JPEG frame
  const vw = md?.w || 1280, vh = md?.h || 720;
  const box = fitBox(W, H, vw, vh, cover);
  if (md) {
    ctx.save();
    if (S.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(md.src, S.mirror ? W - box.x - box.w : box.x, box.y, box.w, box.h);
    ctx.restore();
  } else {
    // skeleton-only (demo, or poses arrive without video): a taped marley floor
    ctx.fillStyle = '#16171c'; ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = '#23262d'; ctx.lineWidth = Math.max(1, scale);
    const hz = box.y + box.h * 0.62;
    for (let i = 0; i <= 12; i++) { const x = box.x + (box.w * i) / 12; ctx.beginPath(); ctx.moveTo(box.x + box.w / 2 + (x - box.x - box.w / 2) * 0.55, hz); ctx.lineTo(x + (x - box.x - box.w / 2) * 0.5, box.y + box.h); ctx.stroke(); }
    for (let j = 0; j < 5; j++) { const y = hz + (box.h * 0.38 * (j * j)) / 16; ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke(); }
  }
  drawPoses(ctx, posesForDisplay(now).map((p) => ({ ...p })), box, { mirror: S.mirror, scale, labels: false });
  drawNameTags(ctx, posesForDisplay(now), box, scale);
  return box;
}
// our own head tags (with the dancers' names) instead of the colour names from common.js
function drawNameTags(ctx, poses, box, scale) {
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of poses) {
    const h = p.lm?.[0]; if (!h || h[2] < 0.35) continue;
    const x = box.x + (S.mirror ? 1 - h[0] : h[0]) * box.w, y0 = box.y + h[1] * box.h;
    const tag = S.names[p.id] || TAPE_NAMES[p.id];
    ctx.font = `800 ${Math.round(20 * scale)}px "Schibsted Grotesk", sans-serif`;
    const w = ctx.measureText(tag).width + 22 * scale, hh = 32 * scale;
    const y = Math.max(box.y + 4, y0 - 72 * scale);
    ctx.fillStyle = TAPES[p.id % 4]; ctx.fillRect(x - w / 2, y, w, hh);
    ctx.fillStyle = '#141519'; ctx.fillText(tag, x, y + hh / 2 + 1);
  }
  ctx.restore();
}
function drawStage(now) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const r = stageCanvas.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (stageCanvas.width !== W || stageCanvas.height !== H) { stageCanvas.width = W; stageCanvas.height = H; }
  if (S.phase === 'lobby' && camLive(now)) {
    // the join panel covers the left half in the lobby: the whole camera picture goes into the free right part
    sctx.fillStyle = '#0c0d10'; sctx.fillRect(0, 0, W, H);
    const x0 = Math.round(W * 0.46);
    sctx.save(); sctx.translate(x0, 0); drawCam(sctx, W - x0, H, now, Math.max(0.8, W / 1500), false); sctx.restore();
  } else drawCam(sctx, W, H, now, Math.max(0.8, W / 1500), false);
  if (!camLive(now) && S.phase === 'lobby') {
    // the right half of the stage waits for the phone
    sctx.save(); sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillStyle = '#8e8f98'; sctx.font = `700 ${Math.round(W / 60)}px "Schibsted Grotesk", sans-serif`;
    sctx.fillText('THE CAMERA PICTURE APPEARS HERE', W * 0.78, H * 0.5);
    sctx.restore();
  }
}

// ---------- lanes: one per dancer in the round (1–4); the lobby shows all four slots
function laneIds() {
  if (S.phase === 'results' && S.lastResult?.length) return S.lastResult.map((r) => r.id); // place order: 1st on the left
  if (S.phase === 'lobby' || !S.roster.size) return [0, 1, 2, 3];
  return [...S.roster].sort((a, b) => a - b);
}
function renderLanes(reset) {
  const el = $('lanes'), ids = laneIds();
  if (reset || el.dataset.ids !== ids.join()) {
    el.dataset.ids = ids.join(); el.innerHTML = ''; el.style.setProperty('--n', ids.length);
    for (const i of ids) {
      const d = document.createElement('div');
      d.className = 'lane'; d.style.setProperty('--tc', TAPES[i]); d.dataset.id = i;
      d.innerHTML = `<button class="tape lay name" title="Rename"></button><span class="tier"></span><div class="pts"></div><span class="judge"></span>
        <div class="meters"><label>On beat</label><div class="meter rhythm"><i></i></div><label>Match</label><div class="meter sim"><i></i></div></div>`;
      d.querySelector('.name').textContent = S.names[i];
      d.querySelector('.name').onclick = (e) => rename(i, e.currentTarget);
      el.appendChild(d);
    }
  }
  const now = performance.now(), here = new Set(posesForDisplay(now).map((p) => p.id));
  const lead = S.phase === 'play' ? [...S.dancers.values()].reduce((a, b) => (!a || b.points > a.points ? b : a), null) : null;
  [...el.children].forEach((lane) => {
    const i = Number(lane.dataset.id), d = S.dancers.get(i);
    const inRound = S.phase === 'play' || S.phase === 'count' || S.phase === 'results';
    const ranked = S.phase === 'results' ? (S.lastResult || []).some((r) => r.id === i) : true;
    const show = inRound ? (!!d || S.roster.has(i)) && ranked : here.has(i);
    const out = S.phase === 'play' && d && (S._t || 0) - d.seen > 2;
    lane.classList.toggle('empty', !show);
    lane.classList.toggle('ready', show && !d);
    lane.classList.toggle('out', !!out);
    lane.classList.toggle('lead', !!(lead && lead === d && d.points > 0));
    const pts = lane.querySelector('.pts');
    const fin = S.phase === 'results' ? (S.lastResult || []).find((r) => r.id === i) : null;
    let val;
    if (!show) val = S.phase === 'lobby' ? 'Step in' : '—';
    else if (fin) val = String(fin.points); // a merged dancer: the sum over their tracker slots
    else if (!d) val = inRound ? '0' : 'READY';
    else val = String(d.points);
    if (pts.textContent !== val) { pts.textContent = val; if (d) { lane.classList.remove('pulse'); void lane.offsetWidth; lane.classList.add('pulse'); } }
    lane.querySelector('.judge').textContent = fin ? `${ordinal(fin.place)} place${fin.tie ? ' · tie' : ''}` : out ? 'OUT OF FRAME' : d?.lastJudge || '';
    lane.querySelector('.tier').textContent = fin ? tier(fin.match) : out ? '' : d?.lastTier || '';
    lane.querySelector('.meter.rhythm i').style.transform = `scaleX(${fin ? fin.onBeat / 100 : d ? d.rhythm : 0})`;
    if (fin) lane.querySelector('.meter.sim i').style.transform = `scaleX(${fin.match / 100})`;
  });
}
const ordinal = (n) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
function renderSims() {
  [...$('lanes').children].forEach((lane) => {
    const d = S.dancers.get(Number(lane.dataset.id));
    lane.querySelector('.meter.sim i').style.transform = `scaleX(${d && d.simLive != null ? d.simLive / 100 : 0})`;
  });
}
// inline rename on the tape (mouse, touch or keyboard; a TV remote can reach it with Tab)
function rename(i, tapeEl) {
  if (S.phase === 'play' || S.phase === 'count') return;
  const inp = document.createElement('input');
  inp.className = 'tape rename'; inp.value = S.names[i]; inp.maxLength = 12; inp.style.setProperty('--tc', TAPES[i]);
  inp.setAttribute('aria-label', 'Dancer name');
  tapeEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const n = inp.value.trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 12);
    if (save && n) {
      S.names[i] = n; localStorage.setItem('rukh.names', JSON.stringify(S.names));
      // a rename after the round also fixes this round's rows on tonight's board
      if (S.phase === 'results' && S.roundAt) {
        const b = readBoard(); b.forEach((r) => { if (r.at === S.roundAt && r.id === i) r.name = n; });
        localStorage.setItem('rukh.board', JSON.stringify(b)); renderBoard(); renderPodium(S.lastResult || []);
      }
    }
    renderLanes(true);
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}

// ---------- the eight-count ruler
function buildRuler() {
  const r = $('ruler'); r.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('div'); c.className = 'cell';
    c.innerHTML = `<b>${i + 1}</b>${TAPES.map((t) => `<i style="--tc:${t}"></i>`).join('')}`;
    r.appendChild(c);
  }
}
function litRuler(k) { [...$('ruler').children].forEach((c, i) => c.classList.toggle('on', i === k)); }
function moveRuler(bi) {
  const cells = $('ruler').children, k = bi % 8;
  if (k === 0) for (const c of cells) c.querySelectorAll('i').forEach((n) => (n.className = ''));
  litRuler(k);
}
function notch(bi, id, q) {
  const c = $('ruler').children[bi % 8]; if (!c) return;
  const n = c.querySelectorAll('i')[id]; if (!n) return;
  n.className = q >= 1 ? 'q1' : q > 0 ? 'q5' : '';
}

// ---------- results + tonight's board (this TV browser, last 12 hours)
function renderPodium(rows) {
  const el = $('podium'); el.innerHTML = '';
  el.dataset.n = rows.length;
  if (!rows.length) {
    el.innerHTML = '<div class="nobody"><span class="tape" style="--tc:var(--t4)">No score</span><p class="big">Nobody was in frame long enough to score.</p><p class="k">Whole body in the picture, 2–4 m from the phone</p></div>';
    return;
  }
  rows.forEach((r, i) => {
    const d = document.createElement('div'); d.className = 'prow' + (r.place === 1 ? ' win' : '');
    const notes = [`${r.onBeat}% on beat`, `${r.match}% match`, tier(r.match)];
    if (r.early) notes.push('left early');
    d.innerHTML = `<span class="place">${r.place}${r.tie ? '<small>tie</small>' : ''}</span><button class="tape lay name" title="Rename" style="--tc:${TAPES[r.id]};animation-delay:${i * 120}ms"></button><span class="pts">${r.points}</span><span class="sub">${esc(notes.join(' · '))}</span>`;
    const nm = d.querySelector('.name'); nm.textContent = S.names[r.id];
    nm.onclick = () => rename(r.id, nm);
    el.appendChild(d);
  });
}
function readBoard() { try { return JSON.parse(localStorage.getItem('rukh.board') || '[]'); } catch { return []; } }
function saveBoard(rows) {
  const b = readBoard().filter((r) => Date.now() - (r.at || 0) < 7 * 864e5);
  const dance = S.dances[S.sel]?.title || '';
  for (const r of rows) b.push({ name: S.names[r.id], id: r.id, points: r.points, onBeat: r.onBeat, match: r.match, dance, at: S.roundAt || Date.now() });
  b.sort((a, c) => c.points - a.points);
  localStorage.setItem('rukh.board', JSON.stringify(b.slice(0, 80)));
}
function renderBoard() {
  const all = readBoard().filter((r) => Date.now() - (r.at || 0) < 12 * 36e5);
  for (const [ol, n] of [[$('boardList'), 7], [$('miniBoard'), 3]]) {
    ol.innerHTML = '';
    if (!all.length) { ol.innerHTML = '<li class="empty">First round sets the bar.</li>'; continue; }
    all.slice(0, n).forEach((r, k) => {
      const li = document.createElement('li');
      const fresh = S.phase === 'results' && r.at === S.roundAt;
      if (fresh) li.className = 'fresh';
      const place = 1 + all.filter((o) => o.points > r.points).length;
      li.innerHTML = `<span class="pl mono">${place}</span><span class="who"><i style="--tc:${TAPES[r.id % 4]}"></i><span class="n"></span><small></small></span><b>${r.points}</b>`;
      li.querySelector('.n').textContent = r.name; li.querySelector('small').textContent = `${r.dance} · ${r.onBeat}% on beat`;
      ol.appendChild(li);
    });
  }
}

// ---------- clip recording (composite: live video + skeletons + scores + reference inset)
const recCanvas = document.createElement('canvas'); recCanvas.width = 1280; recCanvas.height = 720;
const rctx = recCanvas.getContext('2d');
let rec = null, chunks = [], finalCardUntil = 0;
function pickMime() {
  for (const m of ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
function clipUi(state, text, url) {
  $('clipBox').dataset.state = state;
  $('clipState').textContent = text; $('clipUrl').textContent = url || '';
  $('clipRetry').hidden = state !== 'fail' || !S.clipBlob;
  if (state !== 'ok') { const q = $('clipQr'); q.getContext('2d').clearRect(0, 0, q.width, q.height); }
}
let roundNo = 0;
function startRecorder() {
  stopRecorder(true); // a recorder still finishing the last round's card: drop it, its round is gone from the screen
  const mime = pickMime();
  if (!mime || SIM === 'norec') { rec = null; clipUi('none', 'This browser cannot record clips — scores still count.'); return; }
  const st = recCanvas.captureStream(30);
  for (const t of recDest.stream.getAudioTracks()) st.addTrack(t);
  // chunks and round number belong to this recorder: a late stop or upload never mixes two rounds
  const mine = [], no = ++roundNo;
  const r = rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
  let aborted = false;
  r.ondataavailable = (e) => e.data.size && mine.push(e.data);
  r.onstop = () => { if (!aborted && no === roundNo) uploadClip(new Blob(mine, { type: mime.split(';')[0] })); };
  r.abort = () => { aborted = true; };
  r.start(1000);
  clipUi('rec', 'Recording…');
}
function stopRecorder(abort, which = rec) {
  if (!which) return;
  if (which.state !== 'inactive') { if (abort) which.abort(); which.stop(); }
  if (rec === which) rec = null;
}
async function uploadClip(blob) {
  S.clipBlob = blob;
  const no = roundNo;
  clipUi('busy', 'Saving the clip…');
  if (SIM || DEMO) {
    // test and demo rounds: nothing goes to clip storage (no KV writes, no rate-limit use); the QR shows the clip page
    const url = ORIGIN + '/c/DEMO000000';
    S.clip = { url, demo: true, size: blob.size, type: blob.type };
    drawQr($('clipQr'), url); clipUi('ok', 'Demo round — the clip is not saved', url.replace(/^https?:\/\//, ''));
    return;
  }
  try {
    if (SIM === 'clipfail' && !S.simClipTry++) throw new Error('simulated');
    if (!navigator.onLine) throw Object.assign(new Error('offline'), { why: 'offline' });
    const top = (S.lastResult || [])[0];
    const qp = new URLSearchParams({ title: S.dances[S.sel]?.title || '', score: top ? `${S.names[top.id]} ${top.points}` : '' });
    const r = await fetch(api('/api/clip?' + qp), { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw Object.assign(new Error('limit'), { why: 'limit', wait: Number(r.headers.get('retry-after')) || 0 });
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    if (no !== roundNo) return; // a new round started meanwhile: its own clip box is showing
    S.clip = { ...j, size: blob.size, type: blob.type };
    drawQr($('clipQr'), j.url);
    clipUi('ok', 'Scan to download your clip', j.url.replace(/^https?:\/\//, ''));
  } catch (e) {
    if (no !== roundNo) return;
    const msg = e.why === 'offline' ? 'No internet on this screen. Press R once it is back.'
      : e.why === 'limit' ? `Clip limit for now${e.wait ? ` — try again in ${Math.ceil(e.wait / 60)} min` : ''}. Press R to retry.`
        : `The clip did not save (${e.message}). Press R to try again.`;
    clipUi('fail', msg);
  }
}
function drawRecord(now) {
  const W = 1280, H = 720, ctx = rctx;
  drawCam(ctx, W, H, now, 0.9, true);
  if (refVideo.videoWidth) {
    const iw = 300, ih = Math.min(400, (iw * refVideo.videoHeight) / refVideo.videoWidth);
    const x = W - iw - 24, y = 24;
    ctx.fillStyle = '#ECE8DF'; ctx.fillRect(x - 5, y - 5, iw + 10, ih + 10);
    ctx.drawImage(refVideo, x, y, iw, ih);
  }
  ctx.fillStyle = '#141519d9'; ctx.fillRect(0, 0, 560, 64);
  ctx.fillStyle = '#ECE8DF'; ctx.font = '400 34px "Dela Gothic One"'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('RUKH', 22, 34);
  const wm = ctx.measureText('RUKH').width;
  ctx.fillStyle = '#FF4F8B'; ctx.fillText('.', 22 + wm, 34);
  ctx.fillStyle = '#ECE8DF'; ctx.font = '700 22px "Schibsted Grotesk"';
  ctx.fillText((S.dances[S.sel]?.title || '').toUpperCase(), 22 + wm + 40, 35);
  // score tapes along the bottom, as wide as the number of dancers allows
  const ds = [...S.dancers.values()].sort((a, b) => a.id - b.id);
  const n = Math.max(1, ds.length), gap = 16, w = Math.min(380, (W - 48 - gap * (n - 1)) / n);
  ds.forEach((d, i) => {
    const x = 24 + i * (w + gap), y = H - 92;
    ctx.fillStyle = TAPES[d.id]; ctx.fillRect(x, y, w, 70);
    ctx.fillStyle = '#141519'; ctx.font = '800 20px "Schibsted Grotesk"'; ctx.textAlign = 'left';
    ctx.fillText(S.names[d.id], x + 14, y + 22);
    ctx.font = '700 15px "Schibsted Grotesk"';
    ctx.fillText(d.lastJudge || '', x + 14, y + 50);
    ctx.font = '400 40px "Dela Gothic One"'; ctx.textAlign = 'right';
    ctx.fillText(String(d.points), x + w - 14, y + 38);
  });
  if (now < finalCardUntil && S.lastResult) {
    ctx.fillStyle = '#141519e6'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ECE8DF';
    ctx.font = '400 40px "Dela Gothic One"'; ctx.fillText('FINAL SCORE', W / 2, 150);
    S.lastResult.slice(0, 4).forEach((r, i) => {
      const y = 260 + i * 100;
      ctx.fillStyle = TAPES[r.id]; ctx.fillRect(W / 2 - 330, y - 38, 660, 76);
      ctx.fillStyle = '#141519'; ctx.textAlign = 'left'; ctx.font = '800 32px "Schibsted Grotesk"';
      ctx.fillText(`${r.place}${r.tie ? '=' : ''}  ${S.names[r.id]}`, W / 2 - 300, y + 2);
      ctx.textAlign = 'right'; ctx.font = '400 46px "Dela Gothic One"'; ctx.fillText(String(r.points), W / 2 + 300, y + 2);
    });
    ctx.textAlign = 'center'; ctx.fillStyle = '#8E8F98'; ctx.font = '600 22px "Schibsted Grotesk"';
    ctx.fillText(new URL(ORIGIN).host, W / 2, H - 50);
  }
}

// ---------- QR (drawn ink-on-chalk so phones read it)
function drawQr(canvas, text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), pad = 3, cell = Math.floor(canvas.width / (n + pad * 2));
  const off = Math.floor((canvas.width - cell * n) / 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ECE8DF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#141519';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
}

// ---------- demo dancers (?demo=N, and the simulated states): poses taken from the reference itself
function frameAt(F, t) {
  let lo = 0, hi = F.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (F[m].t <= t) lo = m; else hi = m - 1; }
  return F[lo];
}
function demoFeed(n) {
  setInterval(() => {
    if (!S.choreo || SIM_CAMLOST) return;
    const F = S.choreo.frames, now = performance.now();
    const base = S.phase === 'play' || S.phase === 'count' ? songNow() : (now / 1000) % (S.choreo.duration - 1);
    const poses = [];
    for (let k = 0; k < Math.min(4, n); k++) {
      const f = frameAt(F, Math.max(0, base - 0.1 - k * 0.07));
      if (!f) continue;
      const cx0 = (f.p[23][0] + f.p[24][0]) / 2, cx = (k + 0.5) / Math.min(4, n), s = n > 2 ? 0.8 : 0.95;
      const jit = k * 0.004;
      const lm = f.p.map(([x, y, v], j) => [cx + (x - cx0) * s + (Math.sin(now / 90 + j) * jit), 0.5 + (y - 0.5) * s + (Math.cos(now / 110 + j) * jit), v]);
      if (SIM === 'noone') continue;
      if (SIM === 'cut' && k === 0) lm.forEach((q, j) => { if (j >= 25) q[2] = 0.1; });
      poses.push({ id: k, lm });
    }
    onPose({ cap: now - 90, poses, w: 1280, h: 720 });
    if (n > 4) { S.crowd = n; S.crowdAt = now; }
  }, SIM === 'lowfps' ? 330 : 66);
}

// ---------- simulated states for screenshots / tests: ?simulate=<state>
let SIM_NOVIDEO = false, SIM_CAMLOST = false;
const SIM_BANNERS = {
  offline: () => ['Offline', 'This screen lost the internet. The room comes back by itself once Wi-Fi is back.', 'bad'],
  relay: () => ['Relay mode', 'Phone and TV are on different networks: video goes through the RUKH server, a little behind. Scores count the same.', 'info'],
  nocam: () => ['No camera phone yet', `Scan the QR on the left or open ${new URL(ORIGIN).host}/cam and type ${S.code}.`, 'info'],
};
const SIMS = {
  lobby: { demo: 2 }, nocam: {}, play: { demo: 3, start: true }, play2: { demo: 2, start: true }, play4: { demo: 4, start: true },
  results: { demo: 3, start: true, end: 9000 }, tie: { demo: 2, start: true, end: 6000, tie: true },
  camlost: { demo: 2, start: true, lose: 5000 }, noone: { demo: 2, start: true }, cut: { demo: 2, start: true },
  crowd: { demo: 6 }, lowfps: { demo: 1, start: true }, relay: { demo: 2, link: 'relay' }, sound: { demo: 2, startTry: true },
  reffail: { demo: 2 }, clipfail: { demo: 2, start: true, end: 5000 }, offline: { demo: 2 }, unsupported: { demo: 1, missing: ['WebSocket', 'Web Audio'] },
  replaced: { demo: 1, replaced: true }, norec: { demo: 2, start: true, end: 5000 },
};
async function runSim(name) {
  const sp = SIMS[name]; if (!sp) return;
  if (sp.link) SIM_LINK = sp.link;
  if (sp.link === 'relay') S.relaySince = performance.now();
  if (sp.missing) { S.missing = sp.missing; showModal('unsupported'); return; }
  if (sp.replaced) { showModal('replaced'); return; }
  const t0 = performance.now();
  const ready = () => new Promise((r) => { const w = () => (S.ref && S.beats.length && S.poseMsgs > 5 && (S.beatSrc === 'audio' || performance.now() - t0 > 9000) ? r() : setTimeout(w, 100)); w(); });
  if (name === 'reffail') return; // select() fails by itself under this flag
  await ready();
  if (sp.startTry) { startRound(); return; }
  if (!sp.start) return;
  await new Promise((r) => setTimeout(r, 400));
  ensureAudio(); await ac.resume().catch(() => {});
  await startRound();
  if (sp.lose) setTimeout(() => { SIM_CAMLOST = true; S.lastPoseAt = 0; S.poseBuf = []; }, sp.lose);
  if (sp.end) {
    // end after a fixed number of judged beats, so a slow machine still gets a full podium
    await new Promise((r) => { const w = () => (S.phase === 'play' && S.nextBeat >= Math.round(sp.end / 700) ? r() : setTimeout(w, 200)); w(); });
    if (sp.tie) { const ds = [...S.dancers.values()]; if (ds.length > 1) ds[1].points = ds[0].points; }
    endRound();
  }
}

// ---------- browser support
S.missing = S.linkBroken ? ['room link'] : [];
if (!window.WebSocket) S.missing.push('WebSocket');
if (!window.AudioContext && !window.webkitAudioContext) S.missing.push('Web Audio');
if (!window.createImageBitmap) S.missing.push('image decoding');
if (!window.RTCPeerConnection && !SIM) setTimeout(() => flash('Relay only', 'This browser has no WebRTC: video comes through the RUKH server. Scores count the same.', 9000), 1500);

// ---------- boot
buildRuler(); renderLanes(true); renderBoard(); setPhase('lobby'); applySound();
loadDances();
requestAnimationFrame(tick);
if (S.missing.length) showModal('unsupported');
const demoN = DEMO || SIMS[SIM]?.demo || 0;
if (SIM === 'nocam') SIM_NOVIDEO = true;
if (demoN) demoFeed(demoN);
if (SIM) { document.body.classList.add('is-sim'); runSim(SIM); }
S.simulate = (name) => { location.search = `?simulate=${name}`; };
