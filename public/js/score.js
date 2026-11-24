// Scoring: pose similarity to the reference choreography + hitting the beat.
// Numbers are tuned with the offline harness tools/eval/run.mjs (results: tools/eval/RESULTS.md).
import { clamp } from './common.js';

const SEG = [
  [11, 13, 1.2], [13, 15, 1.2], [12, 14, 1.2], [14, 16, 1.2], // arms
  [23, 25, 1.0], [25, 27, 1.0], [24, 26, 1.0], [26, 28, 1.0], // legs
  [11, 12, 0.6], [23, 24, 0.6],                                // shoulders, hips
];
const LR = { 11: 12, 12: 11, 13: 14, 14: 13, 15: 16, 16: 15, 23: 24, 24: 23, 25: 26, 26: 25, 27: 28, 28: 27 };
const MOVE_J = [13, 14, 15, 16, 25, 26, 27, 28];

// Tunables (exported so the harness can sweep them; the app never changes them)
export const TUNE = {
  lagMin: -0.2, lagMax: 1.0,  // s: how late (or early) a player may copy the reference video
  lagTau: 2.5,                // s: time constant of the per-dancer lag / mirror estimate
  lagSlack: 2,                // frames around the learned lag that still count
  ratio0: 0.22, ratio1: 0.84, // match ratio -> 0..100 display scale
  liveTau: 0.6,               // s: smoothing of the live match meter
  motWin: 0.25,               // s: baseline of the motion measure
  mot0: 0.3, mot1: 0.6,       // dancer / reference motion in a beat: below mot0 no match, above mot1 full
  minSpeed: 0.6,              // torso-lengths/s: weaker motion is no accent
  prom: 0.3,                  // a peak must rise this share above the valley before it
  peakGap: 0.15,              // s: closer peaks merge (the stronger one stays)
  w1: 0.09, w1f: 0.12,        // s / share of a beat: full credit window (min of the two)
  w2: 0.18, w2f: 0.24,        // s / share of a beat: zero-credit edge
  offMin: -0.1, offMax: 0.2, offMaxF: 0.28, // learned per-dancer offset limits (s, share of a beat)
  ampW: 0,                    // weight accents by strength (exponent; 0 = off)
  ptsMatch: 0.7, ptsBeat: 30,
};

// unit vectors for each segment; null where not visible
export function features(lm, aspect = 1, mirror = false) {
  if (!lm) return null;
  const g = (i) => lm[mirror ? (LR[i] ?? i) : i];
  return SEG.map(([a, b]) => {
    const A = g(a), B = g(b);
    if (!A || !B || A[2] < 0.4 || B[2] < 0.4) return null;
    let dx = (B[0] - A[0]) * aspect, dy = B[1] - A[1];
    if (mirror) dx = -dx;
    const n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n];
  });
}

// 0..1, 1 = identical limb directions
export function similarity(fa, fb) {
  if (!fa || !fb) return null;
  let s = 0, w = 0;
  for (let i = 0; i < SEG.length; i++) {
    const a = fa[i], b = fb[i];
    if (!a || !b) continue;
    const wt = SEG[i][2];
    const cos = clamp(a[0] * b[0] + a[1] * b[1], -1, 1);
    const deg = (Math.acos(cos) * 180) / Math.PI;
    s += wt * Math.max(0, 1 - deg / 100); w += wt;
  }
  return w >= 4 ? s / w : null;
}

// Reference choreography with precomputed features (normal + mirrored).
// Match is contrastive: how much better the live pose fits the reference at the dancer's own lag than it
// fits the dance on average, relative to how distinctive that reference moment is. Standing still or
// doing another dance fits every moment about equally and scores low.
export class Reference {
  constructor(choreo) {
    this.c = choreo;
    this.fps = choreo.fps || 15;
    const asp = choreo.aspect || 16 / 9;
    this.f = choreo.frames.map((fr) => fr.p ? [features(fr.p, asp, false), features(fr.p, asp, true)] : null);
    const have = this.f.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
    const step = Math.max(1, Math.floor(have.length / 48));
    this.B = have.filter((_, k) => k % step === 0);
    // mean similarity of each reference frame to the whole dance (its "ordinariness")
    this.base = this.f.map((r) => {
      if (!r) return null;
      let s = 0, n = 0;
      for (const j of this.B) { const v = similarity(r[0], this.f[j][0]); if (v != null) { s += v; n++; } }
      return n ? s / n : null;
    });
    // motion of the reference per frame: limb displacement over the last ~0.25 s (torso-lengths/s),
    // same measure as Dancer.motion — a longer baseline than one frame keeps landmark jitter small
    const k = Math.max(1, Math.round(TUNE.motWin * this.fps));
    this.sp = choreo.frames.map((fr, i) => (i >= k ? motion(fr.p, choreo.frames[i - k].p, asp, k / this.fps) : null));
    this.l0 = Math.round(TUNE.lagMin * this.fps); this.nl = Math.round(TUNE.lagMax * this.fps) - this.l0 + 1;
  }
  // mean reference limb speed in song time [t0, t1)
  speedIn(t0, t1) {
    let s = 0, n = 0;
    for (let i = Math.max(1, Math.ceil(t0 * this.fps)); i < Math.min(this.sp.length, t1 * this.fps); i++) if (this.sp[i] != null) { s += this.sp[i]; n++; }
    return n ? s / n : null;
  }
  frameAt(t) { return this.c.frames[clamp(Math.round(t * this.fps), 0, this.c.frames.length - 1)]; }
  // stateless: best raw similarity of a live pose around time t (players react ~0.3 s late)
  match(lm, camAspect, t) {
    const fp = features(lm, camAspect, false);
    if (!fp) return null;
    let best = null;
    const i0 = Math.round((t - 0.75) * this.fps), i1 = Math.round((t + 0.15) * this.fps);
    for (let i = Math.max(0, i0); i <= Math.min(this.f.length - 1, i1); i++) {
      const r = this.f[i]; if (!r) continue;
      for (const fr of r) {
        const s = similarity(fp, fr);
        if (s != null && (best == null || s > best)) best = s;
      }
    }
    return best;
  }
  // stateful per dancer: learns the dancer's lag and mirror; returns {s, c, cref} or null
  //   s = raw similarity at the learned lag, c = s - fit to the dance on average, cref = same for the reference itself
  track(fp, t, st) {
    if (!fp) return null;
    const nl = this.nl, n = this.f.length;
    if (st.ref !== this) { st.ref = this; st.lag = new Float32Array(2 * nl).fill(-1); st.t = null; }
    const dt = st.t == null ? 1e9 : clamp(t - st.t, 0.02, 0.5);
    const a = 1 - Math.exp(-dt / TUNE.lagTau);
    st.t = t;
    const k0 = Math.round(t * this.fps);
    const cur = new Float32Array(2 * nl).fill(NaN);
    for (let l = 0; l < nl; l++) {
      const i = k0 - (l + this.l0);
      if (i < 0 || i >= n || !this.f[i]) continue;
      for (let m = 0; m < 2; m++) {
        const s = similarity(fp, this.f[i][m]);
        if (s == null) continue;
        const j = m * nl + l;
        cur[j] = s;
        st.lag[j] = st.lag[j] < 0 ? s : st.lag[j] + a * (s - st.lag[j]);
      }
    }
    let bj = -1;
    for (let j = 0; j < 2 * nl; j++) if (st.lag[j] >= 0 && (bj < 0 || st.lag[j] > st.lag[bj])) bj = j;
    if (bj < 0) return null;
    const m = bj >= nl ? 1 : 0, lb = bj - m * nl;
    let s = null, li = -1;
    for (let l = Math.max(0, lb - TUNE.lagSlack); l <= Math.min(nl - 1, lb + TUNE.lagSlack); l++) {
      const v = cur[m * nl + l];
      if (!Number.isNaN(v) && (s == null || v > s)) { s = v; li = l; }
    }
    if (s == null) return null;
    let bs = 0, bn = 0;
    for (const j of this.B) { const v = similarity(fp, this.f[j][m]); if (v != null) { bs += v; bn++; } }
    if (!bn) return null;
    const ri = k0 - (li + this.l0);
    const cref = Math.max(0.05, 1 - (this.base[ri] ?? 0.6));
    st.mirror = m; st.lagS = (lb + this.l0) / this.fps;
    return { s, c: Math.max(0, s - bs / bn), cref };
  }
}

// display scales
// raw similarity ~0.55 (random pose) .. 0.92 (same pose) -> 0..100 (kept for callers of Reference.match)
export const simPct = (s) => (s == null ? null : Math.round(clamp((s - 0.55) / 0.35) * 100));
// contrastive match ratio (Reference.track c / cref) -> 0..100
export const ratioPct = (r) => (r == null ? null : Math.round(clamp((r - TUNE.ratio0) / (TUNE.ratio1 - TUNE.ratio0)) * 100));
export const tier = (p) => (p >= 80 ? 'SHARP' : p >= 60 ? 'SOLID' : p >= 35 ? 'LOOSE' : 'LOST');

// Per-dancer live state: motion peaks vs beat grid, similarity per beat, points
export class Dancer {
  constructor(id) {
    this.id = id;
    this.prev = null; this.speed = 0; this.hist = []; // [t, speed] samples at mid-frame times
    this.peaks = []; // [{t, a}] accents: time (s, parabolic sub-frame) and prominence
    this.sims = []; this.simLive = null; // sims: [t, c, cref]
    this.points = 0; this.beatsJudged = 0; this.hits = 0;
    this.rhythm = 0; // 0..1 EMA of beat quality
    this.lastJudge = null; this.lastTier = null;
    this.notes = []; // recent [beatIndex, quality 0 | 0.5 | 1] for the 8-count ruler
    this.seen = 0;
    this.st = {}; this.valley = Infinity; this.dtAvg = null;
    this.cE = 0; this.rE = 0; this.tLive = null; this.mot = [];
  }
  // t = song time (s) when the frame was captured
  push(lm, t, ref, camAspect) {
    this.seen = t;
    const torso = torsoLen(lm, camAspect);
    if (this.prev && t > this.prev.t && torso > 0.02) {
      const dt = t - this.prev.t;
      if (dt < 0.5) {
        this.dtAvg = this.dtAvg == null ? dt : this.dtAvg * 0.9 + dt * 0.1;
        let sum = 0, n = 0;
        for (const j of MOVE_J) {
          const a = lm[j], b = this.prev.lm[j];
          if (a[2] < 0.4 || b[2] < 0.4) continue;
          sum += Math.hypot((a[0] - b[0]) * camAspect, a[1] - b[1]); n++;
        }
        if (n) {
          // jittery timestamps: never divide by much less than the usual frame gap
          const sp = sum / n / torso / Math.max(dt, 0.7 * this.dtAvg); // torso-lengths per second
          this.speed = sp;
          this.hist.push([(t + this.prev.t) / 2, sp]);
          this.findPeak();
        }
      }
    }
    this.prev = { lm, t };
    // motion over ~motWin: compare with the buffered frame closest to t - motWin
    this.buf = (this.buf || []).filter(([bt]) => bt > t - 2 * TUNE.motWin && bt < t);
    let bb = null;
    for (const f of this.buf) if (!bb || Math.abs(t - f[0] - TUNE.motWin) < Math.abs(t - bb[0] - TUNE.motWin)) bb = f;
    if (bb && t - bb[0] > TUNE.motWin * 0.5) {
      const v = motion(lm, bb[1], camAspect, t - bb[0]);
      if (v != null) this.mot.push([t, v]);
    }
    this.buf.push([t, lm]);
    while (this.mot.length && this.mot[0][0] < t - 4) this.mot.shift();
    if (ref) {
      const r = ref.track(features(lm, camAspect, false), t, this.st);
      if (r) {
        this.sims.push([t, r.c, r.cref]);
        const a = this.tLive == null ? 1 : 1 - Math.exp(-clamp(t - this.tLive, 0, 1) / TUNE.liveTau);
        this.cE += a * (r.c - this.cE); this.rE += a * (r.cref - this.rE); this.tLive = t;
        this.simLive = ratioPct(this.cE / Math.max(0.05, this.rE));
      }
    }
    while (this.hist.length && this.hist[0][0] < t - 4) this.hist.shift();
    while (this.sims.length && this.sims[0][0] < t - 4) this.sims.shift();
  }
  findPeak() {
    const h = this.hist, n = h.length;
    if (n < 3) return;
    const [t0, s0] = h[n - 3], [t1, s1] = h[n - 2], [t2, s2] = h[n - 1];
    if (!(s1 > s0 && s1 >= s2)) { this.valley = Math.min(this.valley, s1); return; }
    const valley = Math.min(this.valley, s0);
    let recentMax = 0;
    for (const [t, s] of h) if (t > t1 - 2 && s > recentMax) recentMax = s;
    // landmark jitter alone gives ~0.3-0.6 torso/s of "speed": accents must clear that floor
    const floor = lowQuantile(h, t1 - 4, 0.25);
    if (s1 < TUNE.minSpeed + floor || s1 - valley < TUNE.prom * s1 || s1 < recentMax * 0.3) return;
    // sub-frame peak time: vertex of the parabola through the three samples
    const tp = vertex(t0, s0, t1, s1, t2, s2);
    const pk = { t: tp, a: s1 - (Number.isFinite(valley) ? valley : 0) };
    const last = this.peaks[this.peaks.length - 1];
    if (last && tp - last.t < TUNE.peakGap) { if (pk.a > last.a) this.peaks[this.peaks.length - 1] = pk; }
    else this.peaks.push(pk);
    this.valley = s2;
    if (this.peaks.length > 60) this.peaks.shift();
  }
  // judge one beat once enough time has passed after it (screen.js waits JUDGE_LAG)
  judge(beatT, beatIdx, beatLen) {
    const L = beatLen > 0.2 ? beatLen : 0.5;
    // the camera->screen pipeline adds a steady delay; learn it per dancer from their own accents
    let near = null, nearA = 0;
    for (const p of this.peaks) {
      const d = p.t - beatT;
      if (Math.abs(d) <= L * 0.4 && (near == null || Math.abs(d) < Math.abs(near))) { near = d; nearA = p.a; }
    }
    // offset from the previous beats only (this beat's own accent must not move the target onto itself)
    const offs = (this.offs || []).slice().sort((a, b) => a - b);
    const hi = Math.min(TUNE.offMax, TUNE.offMaxF * L);
    const center = offs.length >= 4 ? clamp(offs[offs.length >> 1], TUNE.offMin, hi) : 0.04;
    if (near != null && nearA > 0) this.offs = (this.offs || []).concat(near).slice(-12);
    const T = beatT + center;
    const w1 = Math.min(TUNE.w1, TUNE.w1f * L), w2 = Math.min(TUNE.w2, TUNE.w2f * L);
    // best accent near the beat (extra accents elsewhere are fine: double time, footwork)
    const K = hitAt(this.peaks, T, L, w1, w2);
    let strong = null;
    for (const p of this.peaks) {
      const e = p.t - T;
      if (Math.abs(e) < L / 2 && (!strong || p.a > strong.a)) strong = { a: p.a, e };
    }
    // chance level, measured on the dancer's own accents: the same test on grids shifted by 1/4..3/4
    // beat (no real beat there). Busy random motion hits those as often as the real beat and
    // averages to ~0; q may go negative for a beat, summary and meters clamp at 0.
    const SH = [0.25, 0.375, 0.5, 0.625, 0.75];
    let cs0 = 0;
    for (const f of SH) cs0 += hitAt(this.peaks, T + f * L, L, w1, w2) / SH.length;
    this.kSum = (this.kSum || 0) + K; this.cSum = (this.cSum || 0) + cs0;
    const nJ = this.beatsJudged + 1;
    const c0 = Math.min(0.85, (this.cSum + 0.3 * 2) / (nJ + 2)); // running chance level, prior 0.3
    const q = Math.max(-1, (K - c0) / (1 - c0)); // one beat costs at most one beat's worth
    let word = 'MISS';
    if (K >= 1) word = 'ON BEAT';
    else if (K > 0 || strong) word = strong && strong.e < 0 ? 'EARLY' : 'LATE';
    const qn = K >= 1 ? 1 : K >= 0.4 ? 0.5 : 0;
    // match: contrast of the live poses inside this beat
    let cs = 0, rs = 0;
    for (const [t, c, r] of this.sims) if (t >= beatT - L / 2 && t < beatT + L / 2) { cs += c; rs += r; }
    let sim = rs ? ratioPct(cs / rs) : null;
    // moving counts: a pose that only resembles the reference while standing still is no match
    const ref = this.st.ref;
    if (sim != null && ref) {
      const lag = this.st.lagS || 0;
      const rsp = ref.speedIn(beatT - L / 2 - lag, beatT + L / 2 - lag);
      let ds = 0, dn = 0;
      for (const [t, v] of this.mot) if (t >= beatT - L / 2 && t < beatT + L / 2) { ds += v; dn++; }
      if (rsp != null && dn) {
        const mr = ds / dn / Math.max(0.3, rsp);
        this.motRatio = mr;
        sim = Math.round(sim * clamp((mr - TUNE.mot0) / (TUNE.mot1 - TUNE.mot0)));
      }
    }
    const pts = Math.max(0, Math.round((sim ?? 0) * TUNE.ptsMatch + q * TUNE.ptsBeat));
    this.points += pts; this.beatsJudged++; this.hits += q;
    if (sim != null) { this.simSum = (this.simSum || 0) + sim; this.simN = (this.simN || 0) + 1; }
    this.rhythmRaw = (this.rhythmRaw ?? 0) * 0.7 + q * 0.3;
    this.rhythm = clamp(this.rhythmRaw);
    this.lastJudge = word;
    if (sim != null) this.lastTier = tier(sim);
    this.notes.push([beatIdx, qn]);
    if (this.notes.length > 16) this.notes.shift();
    return { q: qn, quality: q, near: K, word, sim, pts };
  }
  summary() {
    return {
      id: this.id, points: this.points, match: this.simN ? Math.round(this.simSum / this.simN) : 0,
      onBeat: this.beatsJudged ? Math.round(onBeatShare(this.kSum, this.cSum, this.beatsJudged) * 100) : 0,
    };
  }
}

// share of beats hit above chance: (hit rate - chance rate) / (1 - chance rate), 0..1
// 0..1: how well the dancer's accents hit time T (best one within half a beat; with TUNE.ampW
// an accent counts in proportion to its strength relative to the strongest one around T)
function hitAt(peaks, T, L, w1, w2) {
  let K = 0, amax = 0;
  if (TUNE.ampW) for (const p of peaks) if (Math.abs(p.t - T) < L / 2 && p.a > amax) amax = p.a;
  for (const p of peaks) {
    const ae = Math.abs(p.t - T);
    if (ae >= L / 2) continue;
    let k = ae <= w1 ? 1 : ae <= w2 ? (w2 - ae) / (w2 - w1) : 0;
    if (TUNE.ampW && amax > 0) k *= (p.a / amax) ** TUNE.ampW;
    if (k > K) K = k;
  }
  return K;
}

function onBeatShare(kSum, cSum, n) {
  const k = kSum / n, c = Math.min(0.85, cSum / n);
  return clamp((k - c) / (1 - c));
}

function lowQuantile(h, from, q) {
  const v = [];
  for (const [t, s] of h) if (t >= from) v.push(s);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(q * (v.length - 1))];
}

function vertex(t0, s0, t1, s1, t2, s2) {
  // parabola through 3 points with uneven spacing
  const d0 = t0 - t1, d2 = t2 - t1;
  const den = d0 * d2 * (d0 - d2);
  if (!den) return t1;
  const A = (d2 * (s0 - s1) - d0 * (s2 - s1)) / den;
  const Bc = (d0 * d0 * (s2 - s1) - d2 * d2 * (s0 - s1)) / den;
  if (A >= 0) return t1;
  return clamp(t1 - Bc / (2 * A), t0, t2);
}

// limb displacement between two poses per second, in torso lengths (null if not measurable)
function motion(a, b, aspect, dt) {
  if (!a || !b || dt <= 0) return null;
  const tl = torsoLen(a, aspect);
  if (tl < 0.02) return null;
  let s = 0, n = 0;
  for (const j of MOVE_J) { if (a[j][2] < 0.4 || b[j][2] < 0.4) continue; s += Math.hypot((a[j][0] - b[j][0]) * aspect, a[j][1] - b[j][1]); n++; }
  return n >= 2 ? s / n / tl / dt : null;
}

function torsoLen(lm, aspect = 1) {
  const ms = [(lm[11][0] + lm[12][0]) / 2, (lm[11][1] + lm[12][1]) / 2];
  const mh = [(lm[23][0] + lm[24][0]) / 2, (lm[23][1] + lm[24][1]) / 2];
  return Math.hypot((ms[0] - mh[0]) * aspect, ms[1] - mh[1]);
}
