// Shared bits for camera + screen.
export const TAPES = ['#FF4F8B', '#3DD6F5', '#C5F04A', '#FF9A3C'];
export const TAPE_NAMES = ['PINK', 'CYAN', 'LIME', 'ORANGE'];

// MediaPipe pose-33 skeleton (no face mesh lines except a head dot)
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32], [15, 19], [16, 20],
];
export const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

// Transport lives in link.js (CamLink / ScreenLink); re-exported here for older imports.
export { ICE, Signal, wsUrl, normCode } from './link.js';
export { ORIGIN, WS_ORIGIN, IS_APP, api } from './env.js';

export function makeCode() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b, (x) => a[x % a.length]).join('');
}

// Draw skeletons. poses: [{id, lm:[[x,y,v]...]}], coords normalized to the video frame.
// box = {x,y,w,h} drawing rect in canvas pixels; mirror flips horizontally.
export function drawPoses(ctx, poses, box, { mirror = false, scale = 1, labels = false } = {}) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const p of poses) {
    if (!p || !p.lm) continue;
    const col = TAPES[p.id % 4];
    const P = (i) => {
      const q = p.lm[i];
      const x = mirror ? 1 - q[0] : q[0];
      return [box.x + x * box.w, box.y + q[1] * box.h, q[2]];
    };
    // dark under-stroke so lines read on any video
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? col : 'rgba(10,10,14,.55)';
      ctx.lineWidth = (pass ? 7 : 12) * scale;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        const A = P(a), B = P(b);
        if (A[2] < 0.35 || B[2] < 0.35) continue;
        ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#ECE8DF';
    for (const j of JOINTS) {
      const A = P(j); if (A[2] < 0.35) continue;
      ctx.beginPath(); ctx.arc(A[0], A[1], (j === 0 ? 9 : 5) * scale, 0, Math.PI * 2); ctx.fill();
    }
    if (labels) {
      const h = P(0);
      const tag = TAPE_NAMES[p.id % 4];
      ctx.font = `800 ${Math.round(18 * scale)}px "Schibsted Grotesk", sans-serif`;
      const w = ctx.measureText(tag).width + 18 * scale;
      const y = Math.max(box.y + 4, h[1] - 64 * scale);
      ctx.fillStyle = col;
      ctx.fillRect(h[0] - w / 2, y, w, 28 * scale);
      ctx.fillStyle = '#141519';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(tag, h[0], y + 14 * scale + 1);
    }
  }
  ctx.restore();
}

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

// MediaPipe can report one body twice (seen in Chromium with the GPU delegate: 3 detections for 2 people,
// which opened a third dancer lane). Two detections whose shoulders and hips sit, on average, within a third
// of the torso length of each other are one person.
const BODY_J = [11, 12, 23, 24];
const torsoLen = (lm) => Math.hypot((lm[11][0] + lm[12][0] - lm[23][0] - lm[24][0]) / 2, (lm[11][1] + lm[12][1] - lm[23][1] - lm[24][1]) / 2);
export function sameBody(a, b) {
  const s = Math.max(0.02, Math.min(torsoLen(a), torsoLen(b)));
  let d = 0;
  for (const j of BODY_J) d += Math.hypot(a[j][0] - b[j][0], a[j][1] - b[j][1]);
  return d / BODY_J.length < 0.35 * s;
}
/** Drop repeated detections of one body, keeping the first of each (pass the list best-first). get(x) → landmarks. */
export function dedupeBodies(list, get = (x) => x) {
  const out = [];
  for (const x of list) if (!out.some((y) => sameBody(get(x), get(y)))) out.push(x);
  return out;
}
