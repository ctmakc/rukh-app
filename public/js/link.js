// RUKH transport: phone (CamLink) <-> TV (ScreenLink).
// Direct path: WebRTC video + unordered data channel for poses (STUN only).
// Relay path: the room websocket through our Durable Object — JPEG frames as binary messages,
// poses as JSON. Relay starts when WebRTC is not up within DIRECT_TIMEOUT, when it drops, or when
// either page has ?relay=1. Both classes are EventTargets:
//   'state'   detail {state, reason}   state: connecting | waiting | direct | relay | lost | replaced
//   'pose'    detail {cap, poses, w, h, mir, lat}   (ScreenLink; cap = capture time in this page's performance.now() ms)
//   'message' detail <json>            any other app message from the other side (e.g. {type:'phase', text})
//   'stats'   detail link.stats
import { WS_ORIGIN } from './env.js';

export const ICE = {
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
};
export const DIRECT_TIMEOUT = 6000;
const HEARTBEAT = 5000, HEARTBEAT_DEAD = 13000;
const PING = '{"type":"ping"}', PONG = '{"type":"pong"}'; // answered by the DO auto-response, free of charge
const RELAY_W = 480, FPS_MIN = 6, FPS_MAX = 12, Q_MIN = 0.35, Q_MAX = 0.7;
const MAGIC0 = 0x52, MAGIC1 = 0x46; // 'RF' = relay frame
const LINK_TYPES = new Set(['hello', 'peer-joined', 'peer-left', 'offer', 'answer', 'ice', 'call', 'prefs', 'want-relay', 'rtc-failed', 'lping', 'lpong', 'lstat', 'mode', 'pose']);

/** epoch milliseconds with sub-ms resolution (same base on both pages of one machine) */
export const clock = () => performance.timeOrigin + performance.now();
const pnow = () => performance.now();
const qs = () => new URLSearchParams(location.search);
// test hook: ?rtcfail=1 drops every ICE candidate so the direct path can never connect
const RTCFAIL = /^1$/.test(new URLSearchParams(location.search).get('rtcfail') || '');
const sdpOut = (d) => (RTCFAIL ? { type: d.type, sdp: d.sdp.replace(/^a=candidate:.*\r?\n/gm, '') } : d);
export const wantRelay = () => /^(1|true|yes)$/i.test(qs().get('relay') || '');

/** Room code from user input: upper-case, letters and digits only, 4–6 chars */
export function normCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
// Codes made by makeCode() never contain I L O 0 1; typed look-alikes are mapped here.
const LOOK = { O: ['Q', 'D'], '0': ['Q', 'D'], I: ['J', 'T'], L: ['J'], '1': ['J', 'T'], S: ['5'], '5': ['S'], B: ['8'], '8': ['B'], Z: ['2'], '2': ['Z'], U: ['V'], V: ['U'], G: ['6'], '6': ['G'] };
export function codeVariants(code) {
  let out = [''];
  for (const ch of code) {
    const alts = [ch, ...(LOOK[ch] || [])];
    out = out.flatMap((p) => alts.map((a) => p + a)).slice(0, 512);
  }
  // fewest substitutions first: the typed code, then one-letter fixes, then two…
  const diff = (v) => [...v].reduce((n, c, i) => n + (c !== code[i]), 0);
  return out.sort((x, y) => diff(x) - diff(y));
}
/** {code: {screen, camera}} for up to 16 codes — which rooms have a TV right now */
export async function roomStatus(codes) {
  const { ORIGIN } = await import('./env.js');
  const r = await fetch(`${ORIGIN}/api/room?codes=${codes.slice(0, 16).join(',')}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('room status ' + r.status);
  return r.json();
}
/** Resolve a typed code: exact room if a TV is there, else the single look-alike that has a TV, else the typed code. */
export async function resolveCode(typed) {
  const code = normCode(typed);
  try {
    const vars = codeVariants(code).slice(0, 16);
    const st = await roomStatus(vars);
    if (st[code]?.screen) return { code, live: true };
    const hits = vars.filter((c) => st[c]?.screen);
    if (hits.length === 1) return { code: hits[0], live: true, corrected: true };
    return { code, live: false };
  } catch { return { code, live: null }; }
}

export function wsUrl(code, role) { return `${WS_ORIGIN}/ws/${code}?role=${role}`; }

// ---------------------------------------------------------------- websocket with reconnect + heartbeat
export class Signal {
  constructor(code, role, onMsg, onState, onBinary) {
    this.code = code; this.role = role; this.onMsg = onMsg; this.onState = onState || (() => {}); this.onBinary = onBinary || null;
    this.queue = []; this.closed = false; this.retry = 0; this.lastIn = 0; this.state = 'connecting';
    this._online = () => this.kick();
    this._vis = () => document.visibilityState === 'visible' && this.kick();
    addEventListener('online', this._online);
    document.addEventListener('visibilitychange', this._vis);
    this.hb = setInterval(() => this.heartbeat(), HEARTBEAT);
    this.open();
  }
  get open_() { return this.ws?.readyState === 1; }
  get bufferedAmount() { return this.ws?.bufferedAmount || 0; }
  open() {
    clearTimeout(this.reT);
    if (this.closed) return;
    let ws;
    try { ws = this.ws = new WebSocket(wsUrl(this.code, this.role)); } catch (e) { this.later(); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.retry = 0; this.lastIn = pnow(); this.setState('open');
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastIn = pnow();
      if (typeof e.data !== 'string') { this.onBinary?.(e.data); return; }
      if (e.data === PONG) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') return;
      this.onMsg(m);
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      if (e.code === 4000) { this.closed = true; this.setState('replaced'); return; }
      this.setState('closed');
      this.later();
    };
    ws.onerror = () => {};
  }
  later() {
    if (this.closed) return;
    clearTimeout(this.reT);
    this.reT = setTimeout(() => this.open(), Math.min(5000, 300 * 2 ** this.retry++) + Math.random() * 200);
  }
  /** network came back / tab visible: reconnect right away if the socket is not healthy */
  kick() {
    if (this.closed) return;
    if (this.ws?.readyState === 1 && pnow() - this.lastIn < HEARTBEAT_DEAD) return;
    try { this.ws?.close(); } catch {}
    this.ws = null; this.retry = 0; this.setState('closed'); this.open();
  }
  heartbeat() {
    const ws = this.ws, t = pnow();
    const late = this.lastHb && t - this.lastHb > HEARTBEAT * 2; // page was frozen / throttled: give the socket a fresh chance
    this.lastHb = t;
    if (!ws || ws.readyState !== 1) return;
    if (late) this.lastIn = Math.max(this.lastIn, t - HEARTBEAT);
    if (t - this.lastIn > HEARTBEAT_DEAD) { this.kick(); return; } // half-open socket after a network change
    ws.send(PING);
  }
  setState(s) { if (s !== this.state) { this.state = s; this.onState(s); } }
  /** JSON message; queued while reconnecting unless {queue:false} */
  send(obj, { queue = true } = {}) {
    const s = JSON.stringify(obj);
    if (this.ws?.readyState === 1) { this.ws.send(s); return true; }
    if (queue) { this.queue.push(s); if (this.queue.length > 40) this.queue.shift(); }
    return false;
  }
  sendRaw(buf) { if (this.ws?.readyState === 1) { this.ws.send(buf); return true; } return false; }
  close() {
    this.closed = true; clearInterval(this.hb); clearTimeout(this.reT);
    removeEventListener('online', this._online);
    document.removeEventListener('visibilitychange', this._vis);
    try { this.ws?.close(1000, 'bye'); } catch {}
  }
}

function pushLog(link, what) {
  const e = [Math.round(pnow()), what];
  (link.events ||= []).push(e);
  if (link.events.length > 60) link.events.shift();
}
const safeSend = (ch, s) => { try { if (ch?.readyState === 'open') { ch.send(s); return true; } } catch {} return false; };
const emit = (t, type, detail) => t.dispatchEvent(new CustomEvent(type, { detail }));

// relay frame: 'R''F' | u16 header length (LE) | header JSON utf-8 | JPEG bytes
function packFrame(header, jpeg) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + jpeg.byteLength);
  out[0] = MAGIC0; out[1] = MAGIC1; out[2] = h.length & 255; out[3] = h.length >> 8;
  out.set(h, 4); out.set(new Uint8Array(jpeg), 4 + h.length);
  return out.buffer;
}
function unpackFrame(buf) {
  const u = new Uint8Array(buf);
  if (u.length < 8 || u[0] !== MAGIC0 || u[1] !== MAGIC1) return null;
  const n = u[2] | (u[3] << 8);
  let header; try { header = JSON.parse(new TextDecoder().decode(u.subarray(4, 4 + n))); } catch { return null; }
  return { header, jpeg: u.subarray(4 + n) };
}

// ================================================================ phone side
export class CamLink extends EventTarget {
  /**
   * @param {{room:string, video:HTMLVideoElement, relay?:boolean}} o  video = the local camera <video> (relay frames are cut from it)
   */
  constructor({ room, video, relay = wantRelay() }) {
    super();
    this.room = normCode(room); this.video = video; this.forceRelay = !!relay;
    this.relayWanted = this.forceRelay; this.screenHere = false; this.state = 'connecting'; this.reason = '';
    this.pc = null; this.dc = null; this.oid = Math.floor(Math.random() * 1e6); this.stream = null; this.pendingIce = [];
    this.sid = Math.floor(Math.random() * 2 ** 31); // relay sender id: a new phone/page restarts seq, the TV resets on a new sid
    this.stats = { mode: 'connecting', rtt: 0, lat: 0, delay: 0, fps: 0, kbps: 0, q: 0.6, w: RELAY_W, sent: 0, remote: null };
    this.fps = 10; this.q = 0.6; this.seq = 0; this.lastFrameAt = 0; this.encoding = false; this.idleSince = pnow(); this.tuneAt = 0;
    this.bytesWin = 0; this.framesWin = 0; this.winT = pnow(); this.wsPoseT = 0;
    this.frameEpoch = 0; // capture time of the frame currently shown in this.video
    this.retryN = 0;
    this._watchVideo();
    this.sig = new Signal(this.room, 'camera', (m) => this._onMsg(m), (s) => this._onSig(s));
    this.frameTimer = setInterval(() => this._frameTick(), 1000 / FPS_MAX / 2);
  }
  _log(w) { pushLog(this, w); }
  /** Capture time (epoch ms) of the camera frame now in the <video> — stamp poses with this. */
  frameTime() { return this.frameEpoch && clock() - this.frameEpoch < 500 ? this.frameEpoch : clock(); }
  _watchVideo() {
    const v = this.video;
    if (!v || !('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
    const cb = (now, md) => {
      if (this.closed) return; // close() ends the chain (a new CamLink on the same <video> starts its own)
      const t = md.captureTime ?? md.presentationTime ?? now;
      this.frameEpoch = performance.timeOrigin + Math.min(t, pnow());
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }
  setStream(stream) {
    this.stream = stream;
    const track = stream?.getVideoTracks()[0];
    const sender = this.pc?.getSenders().find((x) => x.track?.kind === 'video' || x.track === null);
    if (sender && track) sender.replaceTrack(track).catch(() => this._negotiateSoon());
    else this._negotiateSoon();
  }
  get directOk() { return this.dc?.readyState === 'open' && this.pc?.connectionState === 'connected'; }
  get relaying() { return !this.directOk && this.relayWanted && this.screenHere && this.sig.open_; }

  /** Send one pose packet. msg: {type:'pose', poses, w, h, mir}; ct = capture epoch ms (frameTime()). */
  sendPose(msg, ct = this.frameTime()) {
    msg.ct = Math.round(ct * 10) / 10;
    msg.age = Math.max(0, Math.round(clock() - ct));
    if (this.directOk && safeSend(this.dc, JSON.stringify(msg))) return 'direct';
    if (!this.screenHere || !this.sig.open_) return 'none';
    const t = pnow();
    // Relay: every pose goes out at once as its own small message, queued behind any frame already in the socket.
    // (Holding poses for the next JPEG lost most of them on busy phones: detection runs back to back on the main
    // thread, so a flush timer never got to fire before the next pose replaced the held one.)
    if (this.relaying) { this.wsPoseT = t; this.sig.send(msg, { queue: false }); return 'relay'; }
    if (t - this.wsPoseT < 30) return 'skip';
    this.wsPoseT = t;
    this.sig.send(msg, { queue: false });
    return 'ws';
  }
  send(obj) { return this.directOk && safeSend(this.dc, JSON.stringify(obj)) ? true : this.sig.send(obj, { queue: false }); }

  // ---- signalling
  _onSig(s) {
    if (s === 'replaced') { this._closePc(); this._set('replaced', 'another phone took over this room'); return; }
    if (s === 'open') this.helloSeen = false; // 'waiting' only once the room told us whether a TV is there
    this._update();
  }
  _onMsg(m) {
    switch (m.type) {
      // a signalling blip must not tear down a working direct link: the TV says in 'call' which offer it still holds
      case 'hello': this.helloSeen = true; this.screenHere = !!m.peer; if (m.peer && !this.directOk) this._negotiateSoon(); break;
      case 'peer-joined': if (m.role === 'screen') { this.screenHere = true; this._log('screen joined'); } break;
      case 'peer-left': if (m.role === 'screen') { this.screenHere = false; this._log('screen left'); } break;
      case 'call':
        this.screenHere = true;
        if (m.relay) this._forceRelay();
        else if (!(this.directOk && m.have === this.oid)) this._negotiateSoon();
        break;
      case 'prefs': if (m.relay) this._forceRelay(); break;
      case 'want-relay': this._forceRelay(); break;
      case 'rtc-failed': if (m.oid === this.oid) { this.relayWanted = true; this._closePc(); this._retryLater(); } break;
      case 'answer': this._onAnswer(m); break;
      case 'ice': this._onIce(m); break;
      case 'lping': this.sig.send({ type: 'lpong', t: m.t, ct: clock() }, { queue: false }); break;
      case 'lstat': this.stats.remote = m; this.stats.lat = m.lat; this.stats.delay = m.delay; this.stats.rtt = m.rtt; emit(this, 'stats', this.stats); break;
      default: if (!LINK_TYPES.has(m.type)) emit(this, 'message', m);
    }
    this._update();
  }
  _forceRelay() { this.forceRelay = true; this.relayWanted = true; this._closePc(); this._update(); }
  _negotiateSoon() {
    // a fresh attempt is already running (hello + call arrive close together): leave it be
    if (this.pc && pnow() - (this.negAt || 0) < 1500 && this.pc.connectionState !== 'failed') return;
    clearTimeout(this.negT);
    this.negT = setTimeout(() => this._negotiate(), 150);
  }
  _retryLater() {
    clearTimeout(this.retryT);
    if (this.forceRelay) return;
    const wait = [12000, 25000, 60000][Math.min(2, this.retryN++)];
    this.retryT = setTimeout(() => { if (!this.directOk) this._negotiate(); }, wait);
  }
  _closePc() {
    clearTimeout(this.directT);
    const pc = this.pc; this.pc = null; this.dc = null; this.pendingIce = [];
    try { pc?.close(); } catch {}
  }
  async _negotiate() {
    if (!this.stream || !this.screenHere || this.forceRelay || this.state === 'replaced') { this._update(); return; }
    this._closePc();
    this.negAt = pnow();
    const oid = ++this.oid;
    this._log('offer ' + oid);
    const pc = (this.pc = new RTCPeerConnection(ICE));
    for (const t of this.stream.getVideoTracks()) {
      const sender = pc.addTrack(t, this.stream);
      try {
        const p = sender.getParameters();
        p.encodings = [{ maxBitrate: 2_500_000, maxFramerate: 30 }];
        p.degradationPreference = 'maintain-framerate';
        sender.setParameters(p).catch(() => {});
      } catch {}
    }
    const dc = (this.dc = pc.createDataChannel('pose', { ordered: false, maxRetransmits: 0 }));
    dc.onopen = () => { if (this.pc === pc) { this.retryN = 0; clearTimeout(this.retryT); this._update('direct up'); } };
    dc.onclose = () => { if (this.pc === pc) { this.relayWanted = true; this._update('direct closed'); this._retryLater(); } };
    dc.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'lping') safeSend(dc, JSON.stringify({ type: 'lpong', t: m.t, ct: clock() }));
      else this._onMsg(m);
    };
    pc.onicecandidate = (e) => e.candidate && !RTCFAIL && this.pc === pc && this.sig.send({ type: 'ice', c: e.candidate, oid }, { queue: false });
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'failed') { this.relayWanted = true; this._closePc(); this._update('direct failed'); this._retryLater(); }
      else if (s === 'disconnected') {
        // give ICE 2.5 s to come back, then relay while it keeps trying
        setTimeout(() => { if (this.pc === pc && pc.connectionState !== 'connected') { this.relayWanted = true; this._update('direct unstable'); } }, 2500);
      } else this._update();
    };
    this.directT = setTimeout(() => {
      if (this.pc !== pc || this.dc?.readyState === 'open') return;
      // no direct path in time: relay now, keep this attempt alive a little longer, then retry fresh
      this.relayWanted = true; this._update('direct timeout');
      this._retryLater();
    }, DIRECT_TIMEOUT);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (this.pc !== pc) return;
      this.sig.send({ type: 'offer', sdp: sdpOut(pc.localDescription), oid }, { queue: false });
    } catch (e) { console.warn('offer failed', e); this.relayWanted = true; this._update('offer failed'); this._retryLater(); }
    this._update();
  }
  async _onAnswer(m) {
    const pc = this.pc;
    if (!pc || m.oid !== this.oid || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription(m.sdp);
      for (const c of this.pendingIce.splice(0)) pc.addIceCandidate(c).catch(() => {});
    } catch (e) { console.warn('answer rejected', e); this._closePc(); this.relayWanted = true; this._retryLater(); }
  }
  _onIce(m) {
    const pc = this.pc;
    if (!pc || !m.c || (m.oid != null && m.oid !== this.oid)) return;
    if (pc.remoteDescription) pc.addIceCandidate(m.c).catch(() => {});
    else this.pendingIce.push(m.c);
  }

  // ---- relay frames (JPEG over the room websocket)
  async _frameTick() {
    const v = this.video;
    if (!this.relaying || this.encoding || !v || v.readyState < 2 || !v.videoWidth) return;
    const t = pnow();
    if (t - this.lastFrameAt < 1000 / this.fps - 4) return;
    // congestion control by what is still queued in the socket
    const buf = this.sig.bufferedAmount, last = this.lastSize || 30000;
    if (buf > last * 1.5) {
      if (t - this.tuneAt > 400) { this.tuneAt = t; this.fps = Math.max(FPS_MIN, this.fps - 1); this.q = Math.max(Q_MIN, +(this.q - 0.05).toFixed(2)); }
      this.idleSince = t;
      return; // skip this frame
    }
    if (buf > 0) this.idleSince = t;
    else if (t - this.idleSince > 2500 && t - this.tuneAt > 1500) {
      this.tuneAt = t;
      if (this.q < Q_MAX) this.q = Math.min(Q_MAX, +(this.q + 0.05).toFixed(2)); else this.fps = Math.min(FPS_MAX, this.fps + 1);
    }
    this.lastFrameAt = t; this.encoding = true;
    try {
      const w = Math.min(RELAY_W, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth / 2) * 2;
      const ct = this.frameTime();
      let blob;
      if (typeof OffscreenCanvas !== 'undefined') {
        if (!this.oc || this.oc.width !== w || this.oc.height !== h) { this.oc = new OffscreenCanvas(w, h); this.octx = this.oc.getContext('2d'); }
        this.octx.drawImage(v, 0, 0, w, h);
        blob = await this.oc.convertToBlob({ type: 'image/jpeg', quality: this.q });
      } else {
        if (!this.cc) { this.cc = document.createElement('canvas'); this.cctx = this.cc.getContext('2d'); }
        if (this.cc.width !== w || this.cc.height !== h) { this.cc.width = w; this.cc.height = h; }
        this.cctx.drawImage(v, 0, 0, w, h);
        blob = await new Promise((res) => this.cc.toBlob(res, 'image/jpeg', this.q));
      }
      if (!blob || !this.relaying) return;
      const jpeg = await blob.arrayBuffer();
      const header = { ct: Math.round(ct * 10) / 10, w, h, seq: ++this.seq, sid: this.sid, q: this.q, fps: this.fps };
      const pkt = packFrame(header, jpeg);
      if (this.sig.sendRaw(pkt)) {
        this.lastSize = pkt.byteLength; this.bytesWin += pkt.byteLength; this.framesWin++; this.stats.sent++;
      }
    } catch (e) { console.warn('relay frame', e); }
    finally {
      this.encoding = false;
      const now = pnow();
      if (now - this.winT > 1000) {
        this.stats.fps = Math.round((this.framesWin * 1000) / (now - this.winT));
        this.stats.kbps = Math.round((this.bytesWin * 8) / (now - this.winT));
        this.stats.q = this.q; this.framesWin = 0; this.bytesWin = 0; this.winT = now;
      }
    }
  }

  _update(reason) {
    if (this.state === 'replaced') return;
    let s;
    if (this.directOk) s = 'direct';
    else if (!this.sig.open_) s = this.sig.state === 'connecting' ? 'connecting' : 'lost'; // never opened yet = connecting
    else if (!this.screenHere) s = this.helloSeen ? 'waiting' : 'connecting';
    else if (this.relaying) s = 'relay';
    else s = 'connecting';
    if (reason) this.reason = reason;
    this._set(s, this.reason);
  }
  _set(s, reason) {
    if (s === this.state) return;
    this.state = s; this.stats.mode = s; this._log(s + (reason ? ' (' + reason + ')' : ''));
    // tell the TV which path we are on (it shows it and picks the right video source)
    if (s === 'direct' || s === 'relay') this.sig.send({ type: 'mode', mode: s }, { queue: false });
    emit(this, 'state', { state: s, reason });
  }
  close() {
    this.closed = true;
    clearInterval(this.frameTimer); clearTimeout(this.negT); clearTimeout(this.retryT);
    this._closePc(); this.sig.close(); this.state = 'closed';
  }
}

// ================================================================ TV side
export class ScreenLink extends EventTarget {
  /** @param {{room:string, video:HTMLVideoElement, relay?:boolean}} o  video = element that receives the direct WebRTC stream */
  constructor({ room, video, relay = wantRelay() }) {
    super();
    this.room = normCode(room); this.video = video; this.forceRelay = !!relay;
    this.pc = null; this.dc = null; this.oid = -1; this.pendingIce = []; this.camHere = false; this.camMode = '';
    this.state = 'connecting';
    this.bitmap = null; this.bitmapW = 0; this.bitmapH = 0; this.lastRelayAt = 0; this.lastVideoAt = 0; this.shownSeq = 0; this.decoding = 0;
    this.lastPoseAt = 0; this.samples = []; this.offset = null; // cam clock - our clock (ms)
    this.lat = []; // recent pose latencies
    this.stats = { mode: 'connecting', rtt: 0, offset: null, lat: 0, latP95: 0, latRaw: 0, delay: 120, fps: 0, kbps: 0, frames: 0, relayFrames: 0, videoFrames: 0, poses: 0 };
    this.win = { frames: 0, bytes: 0, t: pnow() };
    this._watchVideo();
    this.sig = new Signal(this.room, 'screen', (m) => this._onMsg(m), (s) => this._onSig(s), (b) => this._onBinary(b));
    this.pingT = setInterval(() => this._ping(), 1000);
    this.statT = setInterval(() => this._tick(), 500);
  }
  _log(w) { pushLog(this, w); }
  /** What to draw now: {src: HTMLVideoElement|ImageBitmap, w, h, mode} or null */
  media() {
    const t = pnow();
    const v = this.video;
    if (v && v.srcObject && v.videoWidth && v.readyState >= 2 && t - this.lastVideoAt < 800) return { src: v, w: v.videoWidth, h: v.videoHeight, mode: 'direct' };
    if (this.bitmap && t - this.lastRelayAt < 4000) return { src: this.bitmap, w: this.bitmapW, h: this.bitmapH, mode: 'relay' };
    if (v && v.srcObject && v.videoWidth && v.readyState >= 2 && t - this.lastVideoAt < 2500) return { src: v, w: v.videoWidth, h: v.videoHeight, mode: 'direct' };
    return null;
  }
  get videoDelay() { return this.stats.delay; }
  get rtt() { return this.stats.rtt; }
  send(obj) { return this.sig.send(obj); }

  _watchVideo() {
    const v = this.video;
    if (!v) return;
    // timeupdate keeps working when the element is off screen and rVFC is throttled
    v.addEventListener('timeupdate', () => { if (v.srcObject && v.videoWidth) this.lastVideoAt = Math.max(this.lastVideoAt, pnow() - 300); });
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
    const cb = (now, md) => {
      this.lastVideoAt = pnow(); this.stats.videoFrames++; this.win.frames++;
      let d = null;
      if (md.captureTime) d = md.expectedDisplayTime - md.captureTime;
      else if (md.receiveTime) d = md.expectedDisplayTime - md.receiveTime + this.stats.rtt / 2;
      if (d != null && d > 0 && d < 1500 && this.media()?.mode === 'direct') this.stats.delay = this.stats.delay * 0.9 + d * 0.1;
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }
  _onSig(s) {
    if (s === 'replaced') { this._closePc(); this._set('replaced'); return; }
    this._update();
  }
  _onMsg(m) {
    switch (m.type) {
      case 'hello':
        this.camHere = !!m.peer;
        if (m.peer) this._call();
        break;
      case 'peer-joined':
        if (m.role === 'camera') { this.camHere = true; this._log('camera joined'); this._call(); }
        break;
      case 'peer-left':
        // the phone may only have lost its socket; a live direct link keeps running, a dead one is dropped
        if (m.role === 'camera') { this.camHere = false; this._log('camera left'); if (this.pc?.connectionState !== 'connected') this._closePc(); }
        break;
      case 'offer': this._onOffer(m); break;
      case 'ice': this._onIce(m); break;
      case 'lpong': this._onPong(m); break;
      case 'mode': this.camMode = m.mode; break;
      case 'pose': this._onPose(m); break;
      default: if (!LINK_TYPES.has(m.type)) emit(this, 'message', m);
    }
    this._update();
  }
  _call() {
    const have = this.pc?.connectionState === 'connected' && this.dc?.readyState === 'open' ? this.oid : null;
    this.sig.send({ type: 'call', relay: this.forceRelay || undefined, have }, { queue: false });
  }
  async _onOffer(m) {
    this.camHere = true;
    this._log('offer ' + m.oid);
    if (this.forceRelay) { this.sig.send({ type: 'want-relay' }); return; }
    this._closePc();
    this.oid = m.oid;
    const pc = (this.pc = new RTCPeerConnection(ICE));
    pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      this.video.srcObject = e.streams[0] || new MediaStream([e.track]);
      this.video.play().catch(() => {});
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (this.pc !== pc) return;
      this.dc = dc;
      dc.onmessage = (ev) => { let x; try { x = JSON.parse(ev.data); } catch { return; } this._onMsg(x); };
      dc.onopen = () => this._update(); dc.onclose = () => this._update();
    };
    pc.onicecandidate = (e) => e.candidate && !RTCFAIL && this.pc === pc && this.sig.send({ type: 'ice', c: e.candidate, oid: m.oid }, { queue: false });
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed') { this.sig.send({ type: 'rtc-failed', oid: m.oid }); this._closePc(); }
      this._update();
    };
    try {
      await pc.setRemoteDescription(m.sdp);
      for (const c of this.pendingIce.splice(0)) pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription(await pc.createAnswer());
      if (this.pc !== pc) return;
      this.sig.send({ type: 'answer', sdp: sdpOut(pc.localDescription), oid: m.oid }, { queue: false });
    } catch (e) { console.warn('answer failed', e); this.sig.send({ type: 'rtc-failed', oid: m.oid }); this._closePc(); }
  }
  _onIce(m) {
    const pc = this.pc;
    if (!pc || !m.c || (m.oid != null && m.oid !== this.oid)) return;
    if (pc.remoteDescription) pc.addIceCandidate(m.c).catch(() => {});
    else this.pendingIce.push(m.c);
  }
  _closePc() {
    const pc = this.pc; this.pc = null; this.dc = null; this.pendingIce = [];
    try { pc?.close(); } catch {}
    if (this.video) { this.video.srcObject = null; }
    this.lastVideoAt = 0;
  }
  _ping() {
    const msg = { type: 'lping', t: Math.round(clock() * 10) / 10 };
    if (!safeSend(this.dc, JSON.stringify(msg)) && this.camHere) this.sig.send(msg, { queue: false });
  }
  _onPong(m) {
    const now = clock(), rtt = now - m.t;
    if (!(rtt >= 0 && rtt < 5000)) return;
    this.samples.push({ rtt, off: m.ct - (m.t + rtt / 2), at: now });
    while (this.samples.length > 20 || (this.samples[0] && now - this.samples[0].at > 30000)) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.off; this.stats.offset = Math.round(best.off * 10) / 10;
    this.stats.rtt = this.stats.rtt ? this.stats.rtt * 0.7 + rtt * 0.3 : rtt;
  }
  /** cam capture epoch -> our performance.now() timebase */
  _capPerf(m) {
    if (m.ct && this.offset != null) return m.ct - this.offset - performance.timeOrigin;
    return pnow() - (m.age || 0) - this.stats.rtt / 2;
  }
  _onPose(m) {
    const now = pnow(), cap = this._capPerf(m);
    const lat = now - cap;
    this.lastPoseAt = now; this.stats.poses++;
    if (lat > -50 && lat < 5000) { this.lat.push(lat); if (this.lat.length > 120) this.lat.shift(); }
    if (m.ct) this.stats.latRaw = Math.round(clock() - m.ct); // exact when both pages share one clock (tests)
    emit(this, 'pose', { cap, poses: m.poses || [], w: m.w, h: m.h, mir: !!m.mir, lat });
  }
  _onBinary(buf) {
    const f = unpackFrame(buf);
    if (!f) return;
    const { header } = f;
    this.win.bytes += buf.byteLength; this.stats.relayFrames++;
    if (header.pose) this._onPose(header.pose);
    // a new sender (phone reload, app restart, second phone) starts its seq at 1 again: forget the old order
    const newSender = header.sid != null ? header.sid !== this.shownSid : header.seq + 30 < this.shownSeq;
    if (newSender) { this.shownSid = header.sid; this.shownSeq = 0; }
    if (header.seq <= this.shownSeq || this.decoding > 2) return; // stale or decoder busy: drop
    this.decoding++;
    createImageBitmap(new Blob([f.jpeg], { type: 'image/jpeg' })).then((bmp) => {
      this.decoding--;
      if (header.seq <= this.shownSeq) { bmp.close?.(); return; }
      this.shownSeq = header.seq;
      this.bitmap?.close?.(); this.bitmap = bmp; this.bitmapW = bmp.width; this.bitmapH = bmp.height;
      this.lastRelayAt = pnow(); this.win.frames += this.media()?.mode === 'relay' ? 1 : 0;
      const d = this.lastRelayAt + 8 - this._capPerf(header); // +8 ms ≈ next paint
      if (header.ct) this.stats.delayRaw = Math.round(clock() + 8 - header.ct); // exact when both pages share one clock (tests)
      if (d > 0 && d < 5000 && this.media()?.mode === 'relay') this.stats.delay = this.stats.delay * 0.85 + d * 0.15;
      this._update();
    }, () => { this.decoding--; });
  }
  _tick() {
    const now = pnow(), dt = now - this.win.t;
    if (dt >= 1000) {
      this.stats.fps = Math.round((this.win.frames * 1000) / dt);
      this.stats.kbps = Math.round((this.win.bytes * 8) / dt);
      this.win = { frames: 0, bytes: 0, t: now };
      if (this.lat.length) {
        const s = [...this.lat].sort((a, b) => a - b);
        this.stats.lat = Math.round(s[Math.floor(s.length / 2)]);
        this.stats.latP95 = Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]);
      }
      if (this.state === 'direct' || this.state === 'relay') {
        // over the data channel when it is up: the room object then stays idle (hibernates, nothing billed)
        const st = { type: 'lstat', mode: this.state, lat: this.stats.lat, delay: Math.round(this.stats.delay), rtt: Math.round(this.stats.rtt), fps: this.stats.fps };
        if (!safeSend(this.dc, JSON.stringify(st)) && this.camHere) this.sig.send(st, { queue: false });
      }
      emit(this, 'stats', this.stats);
    }
    this._update();
  }
  _update() {
    if (this.state === 'replaced') return;
    const t = pnow();
    let s;
    // state = transport state; media() = what can be drawn right now
    if (this.pc?.connectionState === 'connected' && this.dc?.readyState === 'open') s = 'direct';
    else if (this.sig.open_ && this.camHere && (t - this.lastRelayAt < 5000 || (this.camMode === 'relay' && t - this.lastPoseAt < 5000))) s = 'relay';
    else if (this.media()) s = this.media().mode;
    else if (!this.sig.open_) s = this.sig.state === 'connecting' ? 'connecting' : 'lost';
    else if (!this.camHere) s = 'waiting';
    else if (this.lastPoseAt && t - this.lastPoseAt > 5000 && t - Math.max(this.lastRelayAt, this.lastVideoAt) > 5000) s = 'lost';
    else s = 'connecting';
    this._set(s);
  }
  _set(s) {
    if (s === this.state) return;
    this.state = s; this.stats.mode = s; this._log(s);
    emit(this, 'state', { state: s });
  }
  close() { clearInterval(this.pingT); clearInterval(this.statT); this._closePc(); this.sig.close(); }
}
