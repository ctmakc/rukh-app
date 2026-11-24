// Beat detection from audio, fully in the browser (no services).
// spectral-flux onset envelope -> tempo by autocorrelation -> phase by comb alignment -> beat grid.

export async function detectBeatsFromUrl(url, hint = 0) {
  const buf = await (await fetch(url)).arrayBuffer();
  const ac = new OfflineAudioContext(1, 22050, 22050);
  const audio = await ac.decodeAudioData(buf);
  return detectBeats(audio, hint);
}

// Measured on our synthesized tracks (tools/eval/beats.mjs): remaining onset-detector delay after
// centring the analysis frames, seconds (subtracted from every beat).
const LATENCY = -0.010;

export function detectBeats(audio, hint = 0) {
  const sr = audio.sampleRate;
  // mono mixdown
  const ch = audio.numberOfChannels;
  const len = audio.length;
  const x = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) x[i] += d[i] / ch;
  }
  const N = 1024, hop = Math.round(sr / 100); // 100 envelope frames per second
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float32Array(N), im = new Float32Array(N);
  const bins = N / 2;
  const kLow = Math.max(2, Math.round((180 * N) / sr)); // kick band: up to ~180 Hz
  let prev = new Float32Array(bins);
  const frames = Math.floor((len - N) / hop);
  const env = new Float32Array(Math.max(frames, 1)), envL = new Float32Array(Math.max(frames, 1));
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0, fl = 0;
    const cur = new Float32Array(bins);
    for (let k = 1; k < bins; k++) {
      const m = Math.log1p(10 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) { flux += d * (k < bins / 4 ? 1.5 : 1); if (k <= kLow) fl += d; } // favour low/mid (kick, snare)
    }
    env[f] = flux; envL[f] = fl; prev = cur;
  }
  const fps = sr / hop;
  const t0 = N / 2 / sr; // frame f is centred at f / fps + N / 2 / sr
  const on = detrend(env, Math.round(fps * 0.5)), onL = detrend(envL, Math.round(fps * 0.5));
  // tempo: autocorrelation over 60..180 BPM with a prior (around the dance's own BPM, else around 100,
  // the middle of our dances' movement tempos)
  const acf = (lag) => { let s = 0; for (let i = lag; i < on.length; i++) s += on[i] * on[i - lag]; return s; };
  let bestLag = 0, bestVal = -1;
  const minLag = Math.round((60 / 180) * fps), maxLag = Math.round((60 / 60) * fps);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const pref = hint ? Math.exp(-0.5 * (Math.log2(bpm / hint) / 0.25) ** 2) : Math.exp(-0.5 * Math.log2(bpm / 100) ** 2 / 0.6 ** 2);
    // comb: a true beat period also repeats at 2x, 3x, 4x (kills 3/4-beat and dotted-rhythm lags)
    let v = 0;
    for (let m = 1; m <= 4 && m * lag < on.length / 2; m++) v += acf(m * lag) / m;
    v *= pref;
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  let period = refineLag(acf, bestLag);
  // phase envelope: all onsets + extra weight on the kick band (robust when hats or noise dominate)
  const mx = (a) => a.reduce((m, v) => (v > m ? v : m), 1e-9);
  const mOn = mx(on), mL = mx(onL);
  const ph = new Float32Array(on.length).map((_, i) => on[i] / mOn + 0.7 * onL[i] / mL);
  const P = smooth(ph);
  let { phase, val } = bestPhase(P, period);
  // no hint: a fast grid whose every other beat is much weaker is the "and" of a slower beat
  if (!hint && (60 * fps) / period > 135 && period * 2 <= maxLag + 2) {
    const ev = gridSum(P, phase, period * 2), od = gridSum(P, phase + period, period * 2);
    if (Math.max(ev, od) > 1.6 * Math.min(ev, od)) {
      period = refineLag(acf, Math.round(period * 2));
      ({ phase, val } = bestPhase(P, period));
    }
  }
  // fit: snap each grid beat to the strongest phase-envelope peak within +-6 % of a period, then a
  // weighted least-squares line through the snapped beats gives the final period and phase
  const pts = [];
  for (let k = 0, t = phase; t < P.length; k++, t += period) {
    const w = Math.max(1, Math.round(period * 0.06));
    let bi = -1, bv = 0;
    for (let i = Math.max(1, Math.round(t) - w); i <= Math.min(P.length - 2, Math.round(t) + w); i++) if (P[i] > bv && P[i] >= P[i - 1] && P[i] >= P[i + 1]) { bv = P[i]; bi = i; }
    if (bi >= 0) {
      const d = (P[bi - 1] - P[bi + 1]) / (2 * (P[bi - 1] - 2 * P[bi] + P[bi + 1]) || 1);
      pts.push([k, bi + (Math.abs(d) < 1 ? d : 0), bv]);
    }
  }
  if (pts.length >= 6) {
    const fit = wls(pts);
    if (Math.abs(fit.b / period - 1) < 0.03) { period = fit.b; phase = fit.a; }
  }
  void val;
  const beats = [];
  let first = phase;
  while (first - period >= -0.5) first -= period;
  for (let t = first; t < on.length; t += period) {
    const s = (t / fps) + t0 - LATENCY;
    if (s >= 0) beats.push(Math.round(s * 1000) / 1000);
  }
  return { bpm: Math.round(((60 * fps) / period) * 100) / 100, beats, duration: len / sr };
}

function detrend(env, w) {
  // remove the local mean (half-window w) and keep the positive part
  const n = env.length, out = new Float32Array(n), cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + env[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w);
    out[i] = Math.max(0, env[i] - (cs[b] - cs[a]) / (b - a));
  }
  return out;
}
function smooth(a) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = ((a[i - 1] ?? a[i]) + 2 * a[i] + (a[i + 1] ?? a[i])) / 4;
  return o;
}
function refineLag(acf, lag) {
  const a = acf(lag - 1), b = acf(lag), c = acf(lag + 1);
  const delta = (a - c) / (2 * (a - 2 * b + c) || 1);
  return lag + (Math.abs(delta) < 1 ? delta : 0);
}
const at = (P, t) => { const i = Math.floor(t), u = t - i; return (P[i] || 0) * (1 - u) + (P[i + 1] || 0) * u; };
function gridSum(P, phase, period) {
  let s = 0;
  for (let t = phase % period; t < P.length; t += period) s += at(P, t);
  return s;
}
function bestPhase(P, period) {
  let phase = 0, val = -1;
  for (let p = 0; p < period; p += 0.25) {
    const s = gridSum(P, p, period);
    if (s > val) { val = s; phase = p; }
  }
  return { phase, val };
}
// weighted least squares t = a + b*k
function wls(pts) {
  let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
  for (const [k, t, w] of pts) { sw += w; sk += w * k; st += w * t; skk += w * k * k; skt += w * k * t; }
  const b = (sw * skt - sk * st) / (sw * skk - sk * sk || 1);
  return { a: (st - b * sk) / sw, b };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let s = 0; s < n; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = s + k, b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
