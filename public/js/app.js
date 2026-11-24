// RUKH app start screen (app.html; index.html inside the native app).
// Roles: camera for a TV (code or QR) -> cam, solo practice -> lesson, TV screen -> screen.
// Native plugins are reached only through window.Capacitor.Plugins[name] (pages are plain modules, no bundler).
import { IS_APP, ORIGIN } from './env.js';
import { BONES } from './common.js';

const $ = (id) => document.getElementById(id);
const P = (name) => window.Capacitor?.Plugins?.[name];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// In the app pages are files in the bundle (/cam.html); on the website the Worker serves clean paths (/cam).
export const page = (name, qs = '') => (IS_APP ? `/${name}.html` : `/${name}`) + qs;
const cleanCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- links
$('screenLink').href = page('screen');
$('soloLink').href = page('lesson', '?solo=1');
$('privacyLink').href = IS_APP ? `${ORIGIN}/privacy` : '/privacy';
if (IS_APP) {
  P('App')?.getInfo?.().then((i) => { $('ver').textContent = `v${i.version}`; }).catch(() => {});
  // the solo lesson page ships with the app; until it is in the bundle the row says so instead of opening a blank page
  fetch(page('lesson'), { cache: 'no-store' }).then((r) => { if (!r.ok) soloSoon(); }).catch(soloSoon);
}
function soloSoon() {
  const a = $('soloLink');
  a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.style.opacity = '.55';
  a.querySelector('.role-head span').textContent = 'Coming with the next update. Connect to a TV meanwhile.';
}

// ---------- code entry
const inputs = [...$('code').querySelectorAll('input')];
const err = $('err');
function fill(code) { cleanCode(code).slice(0, 4).split('').forEach((ch, k) => { inputs[k].value = ch; }); mark(); }
function mark() { inputs.forEach((i) => i.classList.toggle('filled', !!i.value)); }
inputs.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    const v = cleanCode(inp.value);
    if (v.length > 1) { fill(v); inputs[Math.min(3, v.length)].focus(); return; }
    inp.value = v; mark(); err.textContent = '';
    if (v && inputs[i + 1]) inputs[i + 1].focus();
    if (v && i === 3) $('join').requestSubmit();
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && inputs[i - 1]) inputs[i - 1].focus(); });
  inp.addEventListener('paste', (e) => {
    const t = cleanCode(e.clipboardData.getData('text'));
    if (t.length >= 4) { e.preventDefault(); fill(t); inputs[3].focus(); }
  });
});
const last = cleanCode(localStorage.getItem('rukh.room'));
if (last.length === 4) fill(last);

$('join').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = inputs.map((i) => i.value).join('');
  if (code.length !== 4) { err.textContent = 'The code has 4 characters. It is in the corner of the TV screen.'; inputs[code.length]?.focus(); return; }
  goCam(code);
});
function goCam(code) {
  localStorage.setItem('rukh.room', code);
  location.href = page('cam', `?room=${code}`);
}

// ---------- QR scanner (BarcodeDetector where the WebView has it, vendored jsQR elsewhere)
const scan = $('scan'), sv = $('scanVideo'), msg = $('scanMsg');
let scanStream = null, scanTimer = 0, detect = null;
const say = (t, bad = false) => { msg.textContent = t; msg.classList.toggle('bad', bad); };

async function makeDetector() {
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      const bd = new BarcodeDetector({ formats: ['qr_code'] });
      return async (src) => (await bd.detect(src))[0]?.rawValue || null;
    }
  } catch {}
  if (!window.jsQR) {
    await new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsqr/jsQR.js'; s.onload = ok; s.onerror = no; document.head.append(s);
    });
  }
  const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
  return async (src) => {
    const w = src.videoWidth, h = src.videoHeight; if (!w) return null;
    const k = Math.min(1, 640 / Math.max(w, h));
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    x.drawImage(src, 0, 0, c.width, c.height);
    const img = x.getImageData(0, 0, c.width, c.height);
    return window.jsQR(img.data, c.width, c.height, { inversionAttempts: 'dontInvert' })?.data || null;
  };
}

function readQr(text) {
  const t = (text || '').trim();
  if (/^[A-Za-z0-9]{4}$/.test(t)) return { room: cleanCode(t) };
  let u; try { u = new URL(t); } catch { return null; }
  const room = cleanCode(u.searchParams.get('room'));
  if (room.length === 4) return { room };
  if (/^\/c\/[\w-]+/.test(u.pathname) && /(^|\.)mmix\.biz$/.test(u.hostname)) return { clip: u.href };
  return null;
}

async function openScan() {
  stopStage();
  scan.hidden = false; scan.classList.remove('hit');
  say('Point the camera at the QR on the TV');
  if (!navigator.mediaDevices?.getUserMedia) { say('This device cannot open the camera here. Type the code from the TV.', true); return; }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    const n = e?.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') say(IS_APP ? 'Camera access is off for RUKH. Turn it on in the phone settings (Apps → RUKH → Permissions), or type the code.' : 'Camera access is blocked for this site. Allow it in the browser, or type the code.', true);
    else if (n === 'NotFoundError' || n === 'OverconstrainedError') say('No camera found on this device. Type the code from the TV.', true);
    else if (n === 'NotReadableError') say('The camera is busy in another app. Close it and try again, or type the code.', true);
    else say('Could not start the camera. Type the code from the TV.', true);
    return;
  }
  sv.srcObject = scanStream; await sv.play().catch(() => {});
  try { detect = detect || (await makeDetector()); } catch { say('The QR reader did not load. Type the code from the TV.', true); return; }
  const tick = async () => {
    if (!scanStream) return;
    let raw = null; try { raw = await detect(sv); } catch {}
    if (raw) {
      const r = readQr(raw);
      if (r?.room) { scan.classList.add('hit'); say(`Room ${r.room}. Connecting…`); P('Haptics')?.impact?.({ style: 'MEDIUM' }); closeScan(true); goCam(r.room); return; }
      if (r?.clip) { closeScan(true); location.href = r.clip; return; }
      say('That QR is not a RUKH room. Scan the QR on the TV screen.', true);
    }
    scanTimer = setTimeout(tick, 120);
  };
  tick();
}
function closeScan(keepStage) {
  clearTimeout(scanTimer);
  scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; sv.srcObject = null;
  scan.hidden = true;
  if (!keepStage) startStage();
}
$('scanBtn').onclick = openScan;
$('scanClose').onclick = () => { closeScan(); inputs.find((i) => !i.value)?.focus(); };

// ---------- native: back button closes the scanner first, then leaves the app from the start screen
if (IS_APP) {
  P('App')?.addListener?.('backButton', () => { if (!scan.hidden) closeScan(); else P('App').exitApp?.(); });
  P('KeepAwake')?.allowSleep?.().catch?.(() => {});
}

// ---------- stage: reference dancer as tape strips, counted in eights
const cv = $('stageCanvas'), cx = cv.getContext('2d');
const cells = [...$('ruler').children];
let ref = null, raf = 0, box = null;
const TAPE = { arms: '#FF4F8B', legs: '#3DD6F5', body: '#ECE8DF' };

async function loadRef() {
  try {
    const list = await (await fetch('/ref/index.json')).json();
    const r = await (await fetch(list[0].json)).json();
    const frames = r.frames.filter((f) => f.p);
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const f of frames) for (const j of [0, 11, 12, 15, 16, 27, 28, 31, 32]) {
      const [x, y, v] = f.p[j]; if (v < 0.4) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    box = { x0, x1, y0, y1, aspect: r.aspect || 16 / 9 };
    ref = { ...r, frames: r.frames };
  } catch { ref = null; }
}

function frameAt(t) {
  const i = Math.floor(t * ref.fps) % ref.frames.length;
  for (let k = 0; k < 4; k++) { const f = ref.frames[(i + k) % ref.frames.length]; if (f.p) return f.p; }
  return null;
}

function draw(now) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, W, H);
  const t = reduced ? 3.2 : (now / 1000) % ref.duration;
  const p = frameAt(t);
  // fit the dance's whole bounding box into the right part of the stage, above the ruler
  // portrait phone: dancer stands right of the headline; wider stages: dancer above the headline
  const copy = cv.parentElement.querySelector('.stage-copy'), rulerTop = $('ruler').offsetTop;
  const side = copy.offsetWidth < W * 0.7;
  const areaY = 14;
  const areaX = side ? copy.offsetLeft + copy.offsetWidth + 4 : W * 0.3;
  const areaW = side ? W - areaX - 12 : W * 0.6;
  const areaH = (side ? rulerTop - 10 : copy.offsetTop - 4) - areaY;
  const bw = (box.x1 - box.x0) * box.aspect, bh = box.y1 - box.y0;
  const s = Math.min(areaW / bw, areaH / bh);
  const ox = areaX + (areaW - bw * s) / 2, oy = areaY + (areaH - bh * s) / 2;
  const X = (x) => ox + (x - box.x0) * box.aspect * s, Y = (y) => oy + (y - box.y0) * s;
  // floor mark under the feet: a square-cut chalk cross, as on a rehearsal floor
  const fy = Y(box.y1) + 6, fx = X((box.x0 + box.x1) / 2);
  cx.strokeStyle = 'rgba(236,232,223,.18)'; cx.lineWidth = 6; cx.lineCap = 'butt';
  cx.beginPath(); cx.moveTo(fx - 70, fy - 10); cx.lineTo(fx + 70, fy + 10); cx.moveTo(fx - 60, fy + 12); cx.lineTo(fx + 60, fy - 12); cx.stroke();
  if (p) {
    const lw = Math.max(7, s * 0.028);
    cx.lineCap = 'butt';
    for (const [a, b] of BONES) {
      const A = p[a], B = p[b]; if (A[2] < 0.3 || B[2] < 0.3) continue;
      const arm = [13, 14, 15, 16, 19, 20].includes(b), leg = [25, 26, 27, 28, 31, 32].includes(b);
      cx.strokeStyle = arm ? TAPE.arms : leg ? TAPE.legs : TAPE.body;
      cx.lineWidth = arm || leg ? lw : lw * 0.8;
      cx.beginPath(); cx.moveTo(X(A[0]), Y(A[1])); cx.lineTo(X(B[0]), Y(B[1])); cx.stroke();
    }
    const hx = X(p[0][0]), hy = Y(p[0][1]), hs = lw * 2.6;
    cx.save(); cx.translate(hx, hy); cx.rotate(-0.02); cx.fillStyle = TAPE.body; cx.fillRect(-hs / 2, -hs / 2, hs, hs); cx.restore();
  }
  // ruler: current count of eight from the reference beat grid
  const beats = ref.beats || [];
  let n = -1; for (let i = 0; i < beats.length; i++) { if (beats[i] <= t) n = i; else break; }
  const cnt = n < 0 ? -1 : n % 8;
  cells.forEach((c, i) => { c.classList.toggle('on', i === cnt); c.classList.toggle('down', cnt >= 0 && i < cnt); });
  if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
}
function startStage() { cancelAnimationFrame(raf); if (ref && box) raf = requestAnimationFrame(draw); }
function stopStage() { cancelAnimationFrame(raf); raf = 0; }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopStage(); else if (scan.hidden) startStage(); });
addEventListener('resize', () => { if (reduced && ref) requestAnimationFrame(draw); });
addEventListener('pageshow', (e) => { if (e.persisted && scan.hidden) startStage(); });
loadRef().then(startStage);
