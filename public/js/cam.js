// Camera phone: camera -> local pose detection -> video + pose data to the TV screen (link.js: direct WebRTC or relay).
import { drawPoses, TAPES, dedupeBodies } from './common.js';
import { CamLink, normCode, resolveCode } from './link.js';
import { createDetector, compact, Tracker } from './pose.js';
import { IS_APP, ORIGIN } from './env.js';

const $ = (id) => document.getElementById(id);
const video = $('v'), canvas = $('c'), ctx = canvas.getContext('2d');
video.style.visibility = 'hidden';
const qs = new URLSearchParams(location.search);
let room = normCode(qs.get('room') || localStorage.getItem('rukh.room') || '');
if (room.length < 4) room = '';
let facing = qs.get('facing') || 'environment';
let stream, detector, tracker = new Tracker(4), link = null;
let lastPoses = [], fps = 0, confirmCode = '';
const rukh = (window.rukh = { link: null, state: 'idle', stats: null, sent: {} });
const SIM = qs.get('simulate') || '';
const pageUrl = (name, q = '') => (IS_APP ? `/${name}.html` : `/${name}`) + q;

// ---- full-screen states: the camera or the tracker cannot run (each one reachable with ?simulate=<name>)
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function allowSteps() {
  if (IS_APP && isIOS) return ['Open the iPhone Settings', 'Scroll to RUKH', 'Turn on Camera, then come back here'];
  if (IS_APP) return ['Open Settings → Apps → RUKH', 'Permissions → Camera → Allow', 'Come back here and tap Try again'];
  if (isIOS) return ['Tap “aA” (or the camera icon) in the address bar', 'Website Settings → Camera → Allow', 'Tap Try again'];
  return ['Tap the icon left of the address', 'Permissions → Camera → Allow', 'Tap Try again'];
}
const STATES = {
  blocked: () => ({ tag: 'Camera', h: 'Camera access is off', p: 'RUKH needs the camera to see the dancers. Poses are found right on this phone; the picture goes only to the TV in your room.', steps: allowSteps(), go: ['Try again', retryCamera] }),
  nocamera: () => ({ tag: 'Camera', h: 'No camera found', p: 'This device has no camera RUKH can use. Open the camera page on a phone, or use this device as the TV screen.', go: ['Try again', retryCamera], alt: ['Open the TV screen', () => (location.href = pageUrl('screen'))] }),
  inuse: () => ({ tag: 'Camera', h: 'The camera is busy', p: 'Another app holds the camera — a video call or the camera app. Close it, then try again.', go: ['Try again', retryCamera] }),
  unsupported: (why) => ({ tag: 'Browser', h: 'This browser cannot run the camera', p: `Missing: ${why}. Open ${new URL(ORIGIN).host}/cam in an up-to-date Chrome (Android) or Safari (iPhone).`, go: ['Try again', () => location.reload()] }),
  tracker: (why) => ({ tag: 'Tracker', h: 'The dance tracker did not start', p: `Pose tracking could not load (${why}). Check the internet and try again. A very old phone may be too slow for it.`, go: ['Try again', () => location.reload()] }),
};
function showState(name, why) {
  const d = STATES[name](why);
  $('stTag').textContent = d.tag; $('stH').textContent = d.h; $('stP').textContent = d.p;
  $('stSteps').innerHTML = ''; (d.steps || []).forEach((t) => { const li = document.createElement('li'); li.textContent = t; $('stSteps').appendChild(li); });
  $('stSteps').hidden = !d.steps;
  $('stGo').textContent = d.go[0]; $('stGo').onclick = d.go[1];
  $('stAlt').hidden = !d.alt;
  if (d.alt) { $('stAlt').textContent = d.alt[0]; $('stAlt').onclick = d.alt[1]; }
  $('state').hidden = false; $('state').dataset.name = name;
  $('boot')?.classList.add('gone');
  rukh.error = name;
}
function camError(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'blocked';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'nocamera';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'inuse';
  return 'blocked';
}
async function retryCamera() {
  if (SIM && STATES[SIM]) return; // simulated states stay put
  try { await startCamera(); $('state').hidden = true; rukh.error = null; if (!booted) boot2(); }
  catch (e) { showState(camError(e)); }
}

// ---- note strip under the top bar (highest priority first)
let crowdAt = 0, crowdN = 0, relayAt = 0;
function evalNote() {
  const now = performance.now();
  let n = null;
  if (SIM === 'offline' || !navigator.onLine) n = ['Offline', 'Wi-Fi or mobile data is off. The TV link comes back by itself.', 'bad'];
  else if (SIM === 'crowd' || (crowdN > 4 && now - crowdAt < 2500)) n = [`${SIM ? 5 : crowdN} people in frame`, 'RUKH scores 4 dancers. Everyone else, step out of the picture.', 'warn'];
  else if (SIM === 'replaced' || rukh.state === 'replaced') n = ['Another phone took this TV', 'Tap Change room, or reload to take it back.', 'bad'];
  else if (SIM === 'relay' || (rukh.state === 'relay' && now - relayAt < 8000)) n = ['Relay mode', 'Phone and TV are on different networks: video goes through the RUKH server.', 'info'];
  const el = $('note');
  if (!n) { el.hidden = true; return; }
  $('noteT').textContent = n[0]; $('noteS').textContent = n[1]; el.dataset.kind = n[2]; el.hidden = false;
}
setInterval(evalNote, 400);
addEventListener('online', evalNote); addEventListener('offline', evalNote);

// ---- join form
const join = $('join');
const inputs = [...$('code').querySelectorAll('input')];
inputs.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-1);
    if (inp.value && inputs[i + 1]) inputs[i + 1].focus();
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus(); });
  inp.addEventListener('paste', (e) => {
    const t = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (t.length >= 4) { e.preventDefault(); t.slice(0, 4).split('').forEach((ch, k) => (inputs[k].value = ch)); }
  });
});
join.addEventListener('submit', async (e) => {
  e.preventDefault();
  const typed = normCode(inputs.map((i) => i.value).join(''));
  if (typed.length !== 4) { $('err').textContent = 'The code has 4 characters — it is on the TV.'; return; }
  let code = typed, note = '';
  if (confirmCode !== typed) {
    $('err').textContent = 'Looking for the TV…';
    const r = await resolveCode(typed);
    if (r.live === false) {
      confirmCode = typed;
      $('err').textContent = `No TV shows ${typed} right now. Check the code on the TV — or tap Connect again to wait for it.`;
      return;
    }
    code = r.code;
    if (r.corrected) note = `Code ${typed} → ${code}: found the TV.`;
  }
  confirmCode = ''; $('err').textContent = '';
  room = code; localStorage.setItem('rukh.room', room);
  history.replaceState(null, '', `${location.pathname}?room=${room}${location.search.includes('relay=1') ? '&relay=1' : ''}`);
  join.hidden = true; connect();
  if (note) $('hint').textContent = note;
});
$('leave').onclick = () => {
  link?.close(); link = null; room = ''; localStorage.removeItem('rukh.room');
  inputs.forEach((i) => (i.value = '')); join.hidden = false; inputs[0].focus();
  setLink('idle');
};
$('flip').onclick = async () => { facing = facing === 'user' ? 'environment' : 'user'; await startCamera(); };
window.rukhRestartCamera = startCamera; // used by the automated test to line the clip up with the music

// ---- camera
async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  stream.getVideoTracks()[0].addEventListener('ended', () => { if (!rukh.error) showState('inuse'); });
  video.srcObject = stream;
  await video.play().catch(() => {});
  link?.setStream(stream);
  const s = stream.getVideoTracks()[0].getSettings();
  $('rotate').classList.toggle('on', (s.height || 0) > (s.width || 0));
}

// ---- link to the TV (link.js decides: direct WebRTC, or JPEG relay through our worker)
function connect() {
  $('roomTag').textContent = `ROOM ${room}`;
  link?.close();
  link = rukh.link = new CamLink({ room, video });
  if (stream) link.setStream(stream);
  link.addEventListener('state', (e) => setLink(e.detail.state, e.detail.reason));
  link.addEventListener('stats', () => renderLink());
  link.addEventListener('message', (e) => {
    const m = e.detail;
    if (m.type === 'phase' && m.text) { $('hint').textContent = String(m.text).slice(0, 160); linkHint = false; }
  });
  setLink(link.state);
}
const HINT0 = $('hint').innerHTML;
let linkHint = false; // the hint currently shows a link message (phase messages from the TV replace it)
const MODE_TXT = { idle: '—', connecting: 'LINK…', waiting: 'NO TV', direct: 'DIRECT', relay: 'RELAY', lost: 'LOST', replaced: 'OFF' };
function setLink(state, reason) {
  if (state === 'relay' && rukh.state !== 'relay') relayAt = performance.now();
  rukh.state = state;
  const el = $('stLink');
  el.querySelector('b').textContent = MODE_TXT[state] || state.toUpperCase();
  Object.assign(el.querySelector('b').style, { fontSize: '20px', lineHeight: '30px', whiteSpace: 'nowrap' });
  el.className = 'stat ' + (state === 'direct' || state === 'relay' ? 'ok' : 'bad');
  const hint = (h) => { $('hint').innerHTML = h; linkHint = true; };
  if (state === 'replaced') hint('Another phone is now the camera for this TV. Tap <b>Change room</b>, or reload to take it back.');
  else if (state === 'waiting') hint(`Waiting for the TV with code <b>${room}</b> — open <b>/screen</b> on the TV.`);
  else if (state === 'lost') hint('Connection lost — reconnecting by itself. Check Wi-Fi or mobile data.');
  else if (state === 'relay' && /direct/.test(reason || '')) hint('Video goes to the TV through the RUKH server — the phone and TV could not link directly.');
  else if (linkHint) { $('hint').innerHTML = HINT0; linkHint = false; }
  renderLink();
}
function renderLink() {
  const s = link?.stats; rukh.stats = s;
  const span = $('stLink').querySelector('span');
  const live = rukh.state === 'direct' || rukh.state === 'relay';
  span.textContent = live && s?.lat ? `TV · ${Math.round(s.lat)} ms` : 'TV link';
  span.style.whiteSpace = 'nowrap';
}

// ---- detection loop
let lastDetect = 0, frames = 0, fpsT = performance.now(), detMs = 30, gap = 45;
function loop() {
  const now = performance.now();
  if (detector && video.readyState >= 2 && now - lastDetect >= gap) {
    lastDetect = now;
    const t0 = performance.now();
    const ct = link ? link.frameTime() : performance.timeOrigin + t0; // capture time of this camera frame
    const res = detector.lm.detectForVideo(video, t0);
    // one body reported twice must not open a second slot: keep the more visible copy
    const vis = (lm) => lm.reduce((a, q) => a + q[2], 0);
    const raw = dedupeBodies(compact(res).sort((a, b) => vis(b) - vis(a)));
    lastPoses = tracker.update(raw, t0);
    // a 5th person: tell the TV (it scores 4); repeat once a second while it lasts, once more when it ends
    if (raw.length > 4 || crowdN > 4) {
      if (raw.length > 4) crowdAt = t0;
      if (raw.length !== crowdN || t0 - (rukh.crowdSent || 0) > 1000) { link?.send({ type: 'crowd', n: raw.length }); rukh.crowdSent = t0; }
      crowdN = raw.length;
    }
    frames++;
    // slow device: leave the main thread ~1/3 of the time for video relay + network
    detMs = detMs * 0.8 + (performance.now() - t0) * 0.2; gap = Math.max(45, detMs * 0.5); rukh.detMs = Math.round(detMs);
    if (link) {
      const how = link.sendPose({ type: 'pose', w: video.videoWidth, h: video.videoHeight, poses: lastPoses, mir: facing === 'user' }, ct);
      rukh.sent[how] = (rukh.sent[how] || 0) + 1;
    }
  }
  if (now - fpsT > 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; renderStats(); }
  paint();
  requestAnimationFrame(loop);
}
function paint() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, W, H);
  if (!video.videoWidth) return;
  const top = (document.querySelector('.top')?.getBoundingClientRect().bottom || 0) * dpr;
  const bottom = (document.querySelector('.dock')?.getBoundingClientRect().top || innerHeight) * dpr;
  const landscape = W > H;
  const y0 = landscape ? 0 : top, avail = landscape ? H : Math.max(bottom - top, H * 0.4);
  const s = Math.min(W / video.videoWidth, avail / video.videoHeight);
  const bw = video.videoWidth * s, bh = video.videoHeight * s;
  const box = { x: (W - bw) / 2, y: y0 + (avail - bh) / 2, w: bw, h: bh };
  const mirror = facing === 'user';
  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(video, W - box.x - bw, box.y, bw, bh); }
  else ctx.drawImage(video, box.x, box.y, bw, bh);
  ctx.restore();
  drawPoses(ctx, lastPoses, box, { mirror, scale: dpr * Math.max(0.6, bw / 1400), labels: true });
}
function renderStats() {
  renderLink();
  $('stDancers').querySelector('b').textContent = lastPoses.length;
  $('stFps').querySelector('b').textContent = fps;
  const dots = $('dots').children;
  for (let i = 0; i < 4; i++) dots[i].style.background = lastPoses.some((p) => p.id === i) ? TAPES[i] : '';
}

// ---- boot
let booted = false;
function unsupported() {
  const miss = [];
  if (!window.isSecureContext) miss.push('a secure (https) page');
  if (!navigator.mediaDevices?.getUserMedia) miss.push('camera access');
  if (!window.WebAssembly) miss.push('WebAssembly');
  if (!window.WebSocket) miss.push('WebSocket');
  return miss.join(', ');
}
(async () => {
  if (SIM && STATES[SIM]) { showState(SIM, SIM === 'unsupported' ? 'camera access, WebAssembly' : SIM === 'tracker' ? 'WebGL context lost' : ''); return; }
  const miss = unsupported();
  if (miss) { showState('unsupported', miss); return; }
  try {
    await startCamera();
  } catch (e) {
    console.warn('camera', e);
    showState(camError(e));
    return;
  }
  boot2();
})();
async function boot2() {
  booted = true;
  $('boot').textContent = 'Loading dance tracker…';
  if (qs.get('det') === '0') {
    // network bench: no tracker, empty pose packets at 20 Hz so link latency is measured without detection load
    setInterval(() => { if (link) { const how = link.sendPose({ type: 'pose', w: video.videoWidth, h: video.videoHeight, poses: [], mir: false }); rukh.sent[how] = (rukh.sent[how] || 0) + 1; } }, 50);
  } else try { detector = await createDetector({ numPoses: Math.min(5, Math.max(1, Number(qs.get('np')) || 5)), delegate: qs.get('delegate') }); }
  catch (e) { console.error(e); showState('tracker', e.message || String(e)); }
  $('boot').remove();
  navigator.wakeLock?.request?.('screen').catch(() => {});
  requestAnimationFrame(loop);
  if (room) connect(); else { join.hidden = false; inputs[0].focus(); setLink('idle'); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') navigator.wakeLock?.request?.('screen').catch(() => {});
});
