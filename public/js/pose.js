// In-browser pose detection (MediaPipe Tasks, runs locally) + stable dancer slots.
import { FilesetResolver, PoseLandmarker } from '/vendor/mediapipe/vision_bundle.mjs';

export async function createDetector({ numPoses = 4, model = '/models/pose_landmarker_lite.task', delegate: want = null } = {}) {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO',
    numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let lm, delegate = want === 'cpu' ? 'CPU' : 'GPU';
  try {
    lm = await PoseLandmarker.createFromOptions(fileset, opts(delegate));
  } catch (e) {
    console.warn('GPU delegate failed, using CPU', e);
    delegate = 'CPU';
    lm = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  return { lm, delegate };
}

// Convert MediaPipe result to compact [[x,y,v]...] arrays
export function compact(result) {
  return (result.landmarks || []).map((l) =>
    l.map((q) => [round(q.x), round(q.y), Math.round((q.visibility ?? 1) * 100) / 100])
  );
}
const round = (v) => Math.round(v * 1000) / 1000;

// Keeps a dancer in the same slot (colour) while they move around, cross paths or hide behind
// each other for a moment: constant-velocity prediction + body size, best global assignment
// (all slot/detection pairings are tried; at most 4x4), coasting for slots that are briefly lost.
// Checked offline by tools/eval/run.mjs (section f).
export class Tracker {
  constructor(slots = 4) { this.slots = Array.from({ length: slots }, () => null); }
  update(lms, now) {
    const dets = lms.map((lm) => ({ c: center(lm), z: size(lm) }));
    const S = this.slots.map((s, si) => {
      if (!s) return null;
      // predict on the last velocity, at most 0.4 s ahead and 0.15 frame widths away: at a low pose rate
      // (a busy phone, 1–3 poses/s) a long extrapolation lands far from the dancer and breaks the match
      const h = Math.min(now - s.seen, 700);
      let dx = s.v[0] * h, dy = s.v[1] * h;
      return { si, p: [s.c[0] + dx, s.c[1] + dy], gate: 0.16 + Math.min(0.2, (now - s.seen) / 4000) };
    }).filter(Boolean);
    const cost = (sl, d) => {
      const s = this.slots[sl.si];
      const dist = Math.hypot(d.c[0] - sl.p[0], d.c[1] - sl.p[1]);
      if (dist > sl.gate) return Infinity;
      return dist + 0.2 * Math.abs(Math.log((d.z || 1e-3) / (s.z || 1e-3)));
    };
    const C = S.map((sl) => dets.map((d) => cost(sl, d)));
    const pairs = assign(C, 0.15);
    const taken = new Set(), usedSlot = new Set(), out = [];
    const put = (si, ci) => {
      const s = this.slots[si], d = dets[ci];
      const dt = Math.max(1, now - s.seen);
      let v;
      if (dt <= 400) {
        const vel = [(d.c[0] - s.c[0]) / dt, (d.c[1] - s.c[1]) / dt];
        const a = 1 - Math.exp(-Math.min(dt, 400) / 150); // velocity smoothing, time constant 0.15 s
        v = [s.v[0] * (1 - a) + vel[0] * a, s.v[1] * (1 - a) + vel[1] * a];
      } else v = [s.v[0] * 0.5, s.v[1] * 0.5]; // samples too far apart to measure: keep a damped guess
      const vmax = 0.0012; // frame widths per ms (1.2 per second): ignore jumps from bad detections
      const vn = Math.hypot(v[0], v[1]);
      this.slots[si] = { c: d.c, v: vn > vmax ? [v[0] * vmax / vn, v[1] * vmax / vn] : v, z: s.z * 0.8 + d.z * 0.2, seen: now };
      usedSlot.add(si); taken.add(ci);
      out.push({ id: si, lm: lms[ci] });
    };
    for (const [k, ci] of pairs) put(S[k].si, ci);
    // second chance before a new slot: a detection left over near a slot that went unmatched
    // (missed for a pose or two, or moved further than the gate) keeps that dancer's slot
    const left = dets.map((_, ci) => ci).filter((ci) => !taken.has(ci));
    if (left.length) {
      const free = S.filter((sl) => !usedSlot.has(sl.si));
      if (free.length) {
        const far = (sl, d) => {
          const s = this.slots[sl.si], dist = Math.hypot(d.c[0] - s.c[0], d.c[1] - s.c[1]);
          return dist > 0.3 + Math.min(0.2, (now - s.seen) / 5000) ? Infinity : dist + 0.2 * Math.abs(Math.log((d.z || 1e-3) / (s.z || 1e-3)));
        };
        const C2 = free.map((sl) => left.map((ci) => far(sl, dets[ci])));
        for (const [k, j] of assign(C2, 0.6)) put(free[k].si, left[j]);
      }
    }
    // new dancers: fill free slots left-to-right
    const fresh = dets.map((d, ci) => [d.c[0], ci]).filter(([, ci]) => !taken.has(ci)).sort((a, b) => a[0] - b[0]);
    for (const [, ci] of fresh) {
      const si = this.slots.findIndex((s, i) => !usedSlot.has(i) && (!s || now - s.seen > 1500));
      if (si < 0) break;
      usedSlot.add(si);
      this.slots[si] = { c: dets[ci].c, v: [0, 0], z: dets[ci].z, seen: now };
      out.push({ id: si, lm: lms[ci] });
    }
    // forget slots unseen for 2.5 s
    this.slots.forEach((s, i) => { if (s && now - s.seen > 2500) this.slots[i] = null; });
    return out.sort((a, b) => a.id - b.id);
  }
}
// minimum-cost matching of slots (rows) to detections (cols); a row may stay unmatched at a fixed
// cost `miss` (a long-lost slot must not be cheaper to fill than a fresh one). Exhaustive search: <= 4 rows x <= 4..6 cols is a few hundred combinations.
function assign(C, miss) {
  const R = C.length, N = R ? C[0].length : 0;
  let best = [], bestCost = Infinity;
  const cur = [], used = new Array(N).fill(false);
  (function rec(r, acc) {
    if (acc >= bestCost) return;
    if (r === R) { bestCost = acc; best = cur.slice(); return; }
    for (let c = 0; c < N; c++) {
      if (used[c] || C[r][c] === Infinity) continue;
      used[c] = true; cur.push([r, c]);
      rec(r + 1, acc + C[r][c]);
      cur.pop(); used[c] = false;
    }
    rec(r + 1, acc + miss); // leave this slot unmatched
  })(0, 0);
  return best;
}
// body position: mostly the hips (they move least while dancing), a little of the shoulders
function center(lm) {
  const hx = (lm[23][0] + lm[24][0]) / 2, hy = (lm[23][1] + lm[24][1]) / 2;
  const sx = (lm[11][0] + lm[12][0]) / 2, sy = (lm[11][1] + lm[12][1]) / 2;
  return [hx * 0.75 + sx * 0.25, hy * 0.75 + sy * 0.25];
}
// torso length (shoulder centre to hip centre) as a body-size / distance cue
function size(lm) {
  return Math.hypot((lm[11][0] + lm[12][0] - lm[23][0] - lm[24][0]) / 2, (lm[11][1] + lm[12][1] - lm[23][1] - lm[24][1]) / 2);
}
