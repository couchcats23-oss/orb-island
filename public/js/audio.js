// All sound is synthesised with WebAudio (no audio files): chip sonar, orb beeps, explosions,
// implosion suck, gas hiss, propeller whir, footsteps, plus ocean / jungle / wind ambience and a tense pad.
import { S, onChange } from './settings.js';

export class AudioEngine {
  constructor() {
    this.ctx = null; this.loops = new Map(); this.L = { x: 0, y: 0, z: 0 }; this.amb = null; this.musicNodes = null;
    this.state = { shore: 0, forest: 0, wind: 0.3, under: 0 };
    this.smooth = { shore: 0, forest: 0, wind: 0.3, under: 0 };
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = c.createGain();
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 5; this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
    this.master.connect(this.comp); this.comp.connect(c.destination);
    this.sfx = c.createGain(); this.ambBus = c.createGain(); this.musicBus = c.createGain(); this.voice = c.createGain();
    for (const n of [this.sfx, this.ambBus, this.musicBus, this.voice]) n.connect(this.master);
    // reverb
    this.reverb = c.createConvolver(); this.reverb.buffer = this._impulse(2.6, 2.8);
    this.revSend = c.createGain(); this.revSend.gain.value = 0.22;
    this.revOut = c.createGain(); this.revOut.gain.value = 0.7;
    this.revSend.connect(this.reverb); this.reverb.connect(this.revOut); this.revOut.connect(this.master);
    this.white = this._noiseBuf('white'); this.pink = this._noiseBuf('pink'); this.brown = this._noiseBuf('brown');
    this.applyVolumes();
    onChange(() => this.applyVolumes());
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }
  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = S.masterVol; this.sfx.gain.value = S.sfxVol; this.ambBus.gain.value = S.ambVol;
    this.musicBus.gain.value = S.musicVol * 0.6; this.voice.gain.value = S.voiceVol;
  }

  _impulse(sec, decay) {
    const c = this.ctx, n = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }
  _noiseBuf(kind) {
    const c = this.ctx, n = c.sampleRate * 3, b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return b;
  }

  setListener(pos, fwd, up) {
    if (!this.ctx) return;
    this.L.x = pos.x; this.L.y = pos.y; this.L.z = pos.z;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
  }

  // ---- building blocks ---------------------------------------------------
  _chain(pos, vol = 1, refDist = 10) {
    const c = this.ctx, now = c.currentTime, out = c.createGain();
    out.gain.value = vol;
    if (!pos) { out.connect(this.sfx); out.connect(this.revSend); return { input: out, t0: now + 0.001, dist: 0 }; }
    const L = this.L, dist = Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.max(900, 18000 - dist * 28);
    const p = this._panner(pos, refDist);
    out.connect(lp); lp.connect(p); p.connect(this.sfx);
    const rg = c.createGain(); rg.gain.value = Math.min(1, dist / 150); lp.connect(rg); rg.connect(this.revSend);
    return { input: out, t0: now + Math.min(dist / 343, 3) + 0.001, dist };
  }
  _panner(pos, refDist = 10) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = refDist; p.maxDistance = 3000; p.rolloffFactor = 1.15;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    return p;
  }
  _osc(type, f0, f1, t0, dur, gain, input, attack = 0.005) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(input); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  _noise(buf, t0, dur, gain, input, o = {}) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf; s.loop = true;
    f.type = o.type || 'lowpass'; f.frequency.setValueAtTime(o.f0 || 1000, t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + dur);
    f.Q.value = o.q || 0.7;
    const a = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + a);
    if (o.swell) { g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.8); g.gain.linearRampToValueAtTime(0.0001, t0 + dur); }
    else g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(input);
    s.start(t0, Math.random() * 2); s.stop(t0 + dur + 0.05);
  }

  // ---- gameplay sounds ---------------------------------------------------
  boom(kind, pos) {
    if (!this.ctx) return;
    const size = { cracker: 0.85, timer: 1.15, implosion: 1.25, remote: 1.05, homing: 0.55, flame: 0.7, gas: 0.45 }[kind] || 0.9;
    const { input, t0 } = this._chain(pos, 1.5 * size, 14);
    this._osc('sine', 120, 32, t0, 0.9 * size + 0.3, 1.3, input, 0.003);
    this._osc('sine', 64, 24, t0, 1.5 * size + 0.3, 1.0, input, 0.006);
    this._noise(this.brown, t0, 1.3 * size + 0.3, 1.6, input, { type: 'lowpass', f0: 3200, f1: 180, q: 0.5 });
    this._noise(this.white, t0, 0.09, 1.0, input, { type: 'highpass', f0: 1800, q: 0.7 });
    this._noise(this.pink, t0 + 0.08, 1.8 * size + 0.4, 0.45, input, { type: 'bandpass', f0: 1000, f1: 300, q: 0.8, attack: 0.05 });
    // debris patter
    for (let i = 0; i < 5; i++) this._noise(this.white, t0 + 0.35 + Math.random() * 1.2, 0.05, 0.12, input, { type: 'bandpass', f0: 1500 + Math.random() * 3000, q: 3 });
  }
  implosionSuck(pos, dur = 2.4) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 1.3, 12);
    this._noise(this.pink, t0, dur, 0.9, input, { type: 'bandpass', f0: 150, f1: 4200, q: 1.8, attack: 0.5, swell: true });
    this._osc('sawtooth', 60, 900, t0, dur, 0.28, input, 0.6);
    this._osc('sine', 40, 200, t0, dur, 0.6, input, 0.6);
  }
  implode(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 1.7, 16);
    this._osc('sine', 260, 26, t0, 1.1, 1.5, input, 0.002);
    this._noise(this.brown, t0, 1.0, 1.4, input, { type: 'lowpass', f0: 2000, f1: 60 });
    this._noise(this.white, t0, 0.06, 1.0, input, { type: 'highpass', f0: 2500 });
  }
  activate() { // thumb switch: three rising beeps
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.5);
    [1500, 1950, 2500].forEach((f, i) => this._osc('square', f, f, t0 + i * 0.075, 0.055, 0.22, input, 0.002));
  }
  timerTick(pos, urgent = 0) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 0.55 + urgent * 0.4, 6);
    this._osc('sine', 2150 + urgent * 500, 2150 + urgent * 500, t0, 0.05, 0.5, input, 0.002);
  }
  remoteBlip(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 0.25, 4);
    this._osc('sine', 3100, 3100, t0, 0.04, 0.3, input, 0.002);
  }
  detClick() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.6);
    this._noise(this.white, t0, 0.02, 0.8, input, { type: 'highpass', f0: 3000 });
    this._osc('square', 900, 900, t0 + 0.02, 0.06, 0.25, input, 0.002);
    this._osc('square', 1800, 1800, t0 + 0.09, 0.08, 0.25, input, 0.002);
  }
  throwSwish(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 0.55, 5);
    this._noise(this.pink, t0, 0.22, 0.6, input, { type: 'bandpass', f0: 500, f1: 2200, q: 1.2, attack: 0.05 });
  }
  sonar(own = true, pos = null) { // left-hand chip: rising pulse with echoes
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, own ? 0.7 : 0.35, 12);
    for (let i = 0; i < 4; i++) {
      const g = 0.55 * Math.pow(0.55, i), t = t0 + i * 0.24;
      this._osc('sine', 320, 1500, t, 0.42, g, input, 0.02);
      this._osc('sine', 640, 3000, t, 0.3, g * 0.3, input, 0.02);
    }
    this._osc('sine', 82, 70, t0, 0.7, 0.5, input, 0.03);
  }
  sonarCancel() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.6);
    this._noise(this.white, t0, 0.5, 0.7, input, { type: 'bandpass', f0: 1600, f1: 500, q: 4, attack: 0.01 });
    this._osc('sawtooth', 220, 90, t0, 0.5, 0.25, input);
  }
  pinged() { // warning: someone's sonar hit your chip
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.75);
    this._osc('square', 190, 120, t0, 0.16, 0.3, input, 0.004);
    this._osc('square', 190, 120, t0 + 0.24, 0.16, 0.3, input, 0.004);
    this._osc('sine', 60, 50, t0, 0.5, 0.7, input, 0.01);
  }
  barrierOn(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 0.7, 8);
    [400, 600, 802, 1210, 1604].forEach((f, i) => this._osc('sine', f * 0.8, f * 1.25, t0 + i * 0.04, 0.9, 0.18, input, 0.1));
  }
  barrierHit() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.6);
    this._osc('sine', 1800, 700, t0, 0.35, 0.5, input, 0.002);
    this._noise(this.white, t0, 0.12, 0.3, input, { type: 'highpass', f0: 4000 });
  }
  pickup() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.7);
    this._osc('triangle', 880, 880, t0, 0.18, 0.35, input); this._osc('triangle', 1320, 1320, t0 + 0.08, 0.3, 0.35, input);
  }
  chipGot() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.8);
    [660, 880, 1320, 1760].forEach((f, i) => this._osc('sine', f, f, t0 + i * 0.07, 0.5, 0.35, input, 0.005));
    this._osc('sine', 110, 110, t0, 0.8, 0.3, input);
  }
  hurt(amount = 30) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 1);
    this._osc('sine', 140, 50, t0, 0.35, 0.9, input, 0.002);
    this._noise(this.brown, t0, 0.25, 0.9, input, { type: 'lowpass', f0: 900, f1: 120 });
    if (amount > 45) this._osc('sine', 3600, 3600, t0, 1.6, 0.12, input, 0.05); // ringing
  }
  death() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 1);
    this._osc('sine', 90, 30, t0, 2.4, 1.0, input, 0.02);
    this._noise(this.brown, t0, 2.0, 0.8, input, { type: 'lowpass', f0: 600, f1: 60, attack: 0.1 });
  }
  heartbeat() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.9);
    this._osc('sine', 70, 40, t0, 0.14, 1.0, input, 0.005); this._osc('sine', 62, 38, t0 + 0.2, 0.16, 0.8, input, 0.005);
  }
  parachute() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.8);
    this._noise(this.pink, t0, 0.9, 0.9, input, { type: 'lowpass', f0: 2400, f1: 500, attack: 0.02 });
    this._osc('sine', 90, 60, t0, 0.5, 0.7, input, 0.01);
  }
  landing(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 1, 8);
    this._osc('sine', 110, 45, t0, 0.3, 0.9, input, 0.002);
    this._noise(this.brown, t0, 0.3, 0.8, input, { type: 'lowpass', f0: 1200, f1: 200 });
  }
  uiClick() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.5);
    this._osc('sine', 1400, 900, t0, 0.05, 0.25, input, 0.002);
  }
  tick() {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(null, 0.4);
    this._osc('sine', 1900, 1900, t0, 0.03, 0.18, input, 0.001);
  }
  footstep(surface, vol, pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, vol, 3);
    switch (surface) {
      case 'sand': this._noise(this.brown, t0, 0.2, 0.8, input, { type: 'lowpass', f0: 700, f1: 300, attack: 0.02 }); break;
      case 'leaf': this._noise(this.pink, t0, 0.14, 0.7, input, { type: 'bandpass', f0: 2200, q: 1.2 }); this._noise(this.white, t0 + 0.04, 0.06, 0.25, input, { type: 'highpass', f0: 4500 }); break;
      case 'rock': this._osc('triangle', 220, 120, t0, 0.07, 0.6, input, 0.001); this._noise(this.white, t0, 0.04, 0.5, input, { type: 'highpass', f0: 3000 }); break;
      case 'wood': this._osc('sine', 160, 90, t0, 0.12, 0.7, input, 0.002); this._noise(this.pink, t0, 0.08, 0.35, input, { type: 'bandpass', f0: 500, q: 1.5 }); break;
      case 'water': this._noise(this.pink, t0, 0.32, 0.7, input, { type: 'bandpass', f0: 900, f1: 1800, q: 1.5, attack: 0.04 }); break;
      default: this._noise(this.pink, t0, 0.13, 0.8, input, { type: 'bandpass', f0: 800, q: 0.9, attack: 0.012 });
    }
  }
  splash(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 1, 6);
    this._noise(this.pink, t0, 0.7, 1.0, input, { type: 'bandpass', f0: 700, f1: 2400, q: 1, attack: 0.03 });
  }
  birdChirp(pos) {
    if (!this.ctx) return;
    const { input, t0 } = this._chain(pos, 0.3, 10);
    const base = 2000 + Math.random() * 2400, n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this._osc('sine', base * (1 + Math.random() * 0.3), base * (0.8 + Math.random() * 0.6), t0 + i * 0.11, 0.09, 0.4, input, 0.01);
  }

  // ---- looping positional sounds (gas cloud, flame, propeller) ------------
  startLoop(id, kind, pos) {
    if (!this.ctx || this.loops.has(id)) return;
    const c = this.ctx, out = c.createGain(), lp = c.createBiquadFilter(), p = this._panner(pos, kind === 'homing' ? 4 : 12);
    out.gain.value = 0.0001; lp.type = 'lowpass'; lp.frequency.value = 12000;
    out.connect(lp); lp.connect(p); p.connect(this.sfx);
    const nodes = [];
    const src = (buf, type, f, q, g) => { const s = c.createBufferSource(), fl = c.createBiquadFilter(), gg = c.createGain(); s.buffer = buf; s.loop = true; fl.type = type; fl.frequency.value = f; fl.Q.value = q; gg.gain.value = g; s.connect(fl); fl.connect(gg); gg.connect(out); s.start(0, Math.random() * 2); nodes.push(s); return fl; };
    let vol = 0.5;
    if (kind === 'gas') { src(this.white, 'bandpass', 2600, 0.6, 0.8); src(this.pink, 'lowpass', 500, 0.5, 0.5); vol = 0.55; }
    else if (kind === 'flame') { const f = src(this.brown, 'lowpass', 700, 0.6, 1.2); src(this.white, 'highpass', 3500, 0.5, 0.18); const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 7; lg.gain.value = 250; lfo.connect(lg); lg.connect(f.frequency); lfo.start(); nodes.push(lfo); vol = 0.6; }
    else if (kind === 'homing') {
      const o = c.createOscillator(), g = c.createGain(), bp = c.createBiquadFilter(), tr = c.createOscillator(), tg = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = 210; bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.4; g.gain.value = 0.5;
      tr.frequency.value = 38; tg.gain.value = 0.35; tr.connect(tg); tg.connect(g.gain);
      o.connect(bp); bp.connect(g); g.connect(out); o.start(); tr.start(); nodes.push(o, tr); vol = 0.7;
    }
    out.gain.linearRampToValueAtTime(vol, c.currentTime + 0.3);
    this.loops.set(id, { out, p, nodes, vol });
  }
  updateLoop(id, pos) {
    const l = this.loops.get(id);
    if (!l) return;
    if (l.p.positionX) { l.p.positionX.value = pos.x; l.p.positionY.value = pos.y; l.p.positionZ.value = pos.z; } else l.p.setPosition(pos.x, pos.y, pos.z);
  }
  stopLoop(id) {
    const l = this.loops.get(id);
    if (!l) return;
    this.loops.delete(id);
    const t = this.ctx.currentTime;
    l.out.gain.cancelScheduledValues(t); l.out.gain.setValueAtTime(l.out.gain.value, t); l.out.gain.linearRampToValueAtTime(0.0001, t + 0.4);
    setTimeout(() => { for (const n of l.nodes) { try { n.stop(); } catch {} } }, 600);
  }

  // ---- ambience ----------------------------------------------------------
  startAmbience() {
    if (!this.ctx || this.amb) return;
    const c = this.ctx, a = this.amb = {};
    const layer = (buf, type, f, q) => {
      const s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
      s.buffer = buf; s.loop = true; fl.type = type; fl.frequency.value = f; fl.Q.value = q; g.gain.value = 0;
      s.connect(fl); fl.connect(g); g.connect(this.ambBus); s.start(0, Math.random() * 2);
      return { s, fl, g };
    };
    a.ocean = layer(this.brown, 'lowpass', 900, 0.5);
    a.surf = layer(this.pink, 'bandpass', 1400, 0.6);
    const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.11; lg.gain.value = 0.12; lfo.connect(lg); lg.connect(a.ocean.g.gain); lfo.start();
    const lfo2 = c.createOscillator(), lg2 = c.createGain(); lfo2.frequency.value = 0.09; lg2.gain.value = 0.06; lfo2.connect(lg2); lg2.connect(a.surf.g.gain); lfo2.start();
    a.wind = layer(this.pink, 'bandpass', 420, 0.5);
    const lfo3 = c.createOscillator(), lg3 = c.createGain(); lfo3.frequency.value = 0.07; lg3.gain.value = 160; lfo3.connect(lg3); lg3.connect(a.wind.fl.frequency); lfo3.start();
    a.insects = layer(this.white, 'bandpass', 5200, 9);
    const trem = c.createOscillator(), tg = c.createGain(); trem.frequency.value = 31; tg.gain.value = 0.045; trem.connect(tg); tg.connect(a.insects.g.gain); trem.start();
    a.insects2 = layer(this.white, 'bandpass', 3700, 10);
    const trem2 = c.createOscillator(), tg2 = c.createGain(); trem2.frequency.value = 23; tg2.gain.value = 0.03; trem2.connect(tg2); tg2.connect(a.insects2.g.gain); trem2.start();
    a.under = layer(this.brown, 'lowpass', 300, 0.7);
    a.timer = setInterval(() => {
      if (this.smooth.forest > 0.25 && Math.random() < 0.5 + this.smooth.forest * 0.4) {
        const ang = Math.random() * 6.283, d = 12 + Math.random() * 45;
        this.birdChirp({ x: this.L.x + Math.cos(ang) * d, y: this.L.y + 3 + Math.random() * 8, z: this.L.z + Math.sin(ang) * d });
      }
    }, 1400);
  }
  stopAmbience() {
    if (!this.amb) return;
    clearInterval(this.amb.timer);
    for (const k of Object.keys(this.amb)) { const l = this.amb[k]; if (l && l.s) { try { l.s.stop(); } catch {} } }
    this.amb = null;
  }
  setAmbience(shore, forest, wind, under, dt) {
    if (!this.amb) return;
    const k = 1 - Math.exp(-dt * 1.5), sm = this.smooth;
    sm.shore += (shore - sm.shore) * k; sm.forest += (forest - sm.forest) * k; sm.wind += (wind - sm.wind) * k; sm.under += (under - sm.under) * k;
    const a = this.amb, ab = 1 - sm.under;
    a.ocean.g.gain.value = (0.05 + sm.shore * 0.38) * ab; a.surf.g.gain.value = sm.shore * 0.2 * ab;
    a.wind.g.gain.value = (0.05 + sm.wind * 0.16) * ab;
    a.insects.g.gain.value = (0.02 + sm.forest * 0.06) * ab; a.insects2.g.gain.value = (0.01 + sm.forest * 0.04) * ab;
    a.under.g.gain.value = sm.under * 0.9;
  }

  // ---- music: slow, tense pad ---------------------------------------------
  startMusic() {
    if (!this.ctx || this.musicNodes) return;
    const c = this.ctx, m = this.musicNodes = { nodes: [] };
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 2;
    const g = c.createGain(); g.gain.value = 0.0001; g.gain.linearRampToValueAtTime(0.22, c.currentTime + 6);
    lp.connect(g); g.connect(this.musicBus);
    [55, 82.4, 130.8, 164.8, 196].forEach((f, i) => {
      for (const det of [-6, 5]) {
        const o = c.createOscillator(); o.type = i % 2 ? 'triangle' : 'sawtooth'; o.frequency.value = f; o.detune.value = det;
        const og = c.createGain(); og.gain.value = 0.08 / (1 + i * 0.3); o.connect(og); og.connect(lp); o.start(); m.nodes.push(o);
      }
    });
    const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.045; lg.gain.value = 260; lfo.connect(lg); lg.connect(lp.frequency); lfo.start(); m.nodes.push(lfo);
    m.hit = setInterval(() => {
      const t0 = c.currentTime + 0.05;
      const o = c.createOscillator(), og = c.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(55, t0); o.frequency.exponentialRampToValueAtTime(48, t0 + 4);
      og.gain.setValueAtTime(0.0001, t0); og.gain.linearRampToValueAtTime(0.5, t0 + 0.05); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 4);
      o.connect(og); og.connect(this.musicBus); o.start(t0); o.stop(t0 + 4.2);
    }, 13000);
    m.g = g;
  }
  stopMusic() {
    if (!this.musicNodes) return;
    const m = this.musicNodes; this.musicNodes = null; clearInterval(m.hit);
    const t = this.ctx.currentTime; m.g.gain.cancelScheduledValues(t); m.g.gain.setValueAtTime(m.g.gain.value, t); m.g.gain.linearRampToValueAtTime(0.0001, t + 1.5);
    setTimeout(() => { for (const n of m.nodes) { try { n.stop(); } catch {} } }, 1800);
  }
}
