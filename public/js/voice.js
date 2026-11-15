// WebRTC mesh voice chat. The game server only relays signalling ("rtc" messages).
// Proximity mode: voices are positional and fade with distance. Global mode: everyone hears everyone.
import { S } from './settings.js';

export class Voice {
  constructor(audio, net) {
    this.audio = audio; this.net = net;
    this.peers = new Map(); this.stream = null; this.track = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.micState = 'off'; // off | requesting | on | denied | unsupported
    this.talking = false; this.local = { analyser: null, buf: null, lvl: 0 };
    this.muted = new Set(); this.pttDown = false; this.positional = false;
    this.onChange = () => {};
    net.on('rtc', (m) => this._signal(m.from, m.d));
    fetch('/api/config').then((r) => r.json()).then((c) => { if (c.iceServers) this.iceServers = c.iceServers; }).catch(() => {});
  }

  async enableMic() {
    if (this.micState === 'on' || this.micState === 'requesting') return this.micState === 'on';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.micState = 'unsupported'; this.onChange(); return false; }
    this.micState = 'requesting'; this.onChange();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.track = this.stream.getAudioTracks()[0];
      this.audio.init(); this.audio.resume();
      const ctx = this.audio.ctx, src = ctx.createMediaStreamSource(this.stream), an = ctx.createAnalyser();
      an.fftSize = 512; src.connect(an);
      this.local.analyser = an; this.local.buf = new Uint8Array(an.fftSize);
      this.micState = 'on'; this._applyTransmit();
      // connections made before the mic was enabled need the track added (triggers renegotiation)
      for (const peer of this.peers.values()) { try { peer.pc.addTrack(this.track, this.stream); } catch (e) { console.warn('addTrack failed', e); } }
      this.onChange();
      return true;
    } catch (e) {
      this.micState = 'denied'; this.onChange();
      return false;
    }
  }

  // PTT / open mic / mute
  _applyTransmit() {
    if (!this.track) return;
    const open = S.micOn && (!S.ptt || this.pttDown);
    this.track.enabled = open; this.talking = open;
  }
  setPtt(down) { this.pttDown = down; this._applyTransmit(); this.onChange(); }
  refresh() { this._applyTransmit(); this.onChange(); }

  // keep one connection per other player in the lobby
  setPeers(ids, myId) {
    const want = new Set(ids.filter((i) => i !== myId));
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this._close(id);
    for (const id of want) if (!this.peers.has(id)) this._create(id, myId < id);
  }

  _create(id, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // "perfect negotiation": either side may (re)negotiate; the non-initiator is the polite one on glare
    const peer = { id, pc, initiator, polite: !initiator, makingOffer: false, ignoreOffer: false, pending: [], gain: null, direct: null, spat: null, panner: null, analyser: null, buf: null, lvl: 0, audioEl: null, state: 'connecting', born: performance.now(), retries: 0, retryAt: performance.now() + 9000 };
    this.peers.set(id, peer);
    if (this.stream) this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream));
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = (e) => { if (e.candidate) this.net.send({ t: 'rtc', to: id, d: { ice: e.candidate } }); };
    pc.onconnectionstatechange = () => { peer.state = pc.connectionState; this.onChange(); };
    pc.ontrack = (e) => this._attach(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onnegotiationneeded = async () => {
      if (!initiator && !pc.remoteDescription) return; // initial offer always comes from the initiator: avoids glare at start
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.net.send({ t: 'rtc', to: id, d: { sdp: pc.localDescription } });
      } catch (err) { console.warn('offer failed', err); } finally { peer.makingOffer = false; }
    };
  }

  _signal(from, d) {
    if (!d) return;
    let peer = this.peers.get(from);
    if (!peer) { this._create(from, false); peer = this.peers.get(from); }
    // handle one signalling message at a time per peer (avoids offer/answer races)
    peer.chain = (peer.chain || Promise.resolve()).then(() => this._handle(peer, d)).catch((err) => console.warn('signal error', err));
  }

  async _handle(peer, d) {
    const pc = peer.pc, from = peer.id;
    if (d.sdp) {
      const collision = d.sdp.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(d.sdp);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (d.sdp.type === 'offer') {
        await pc.setLocalDescription();
        this.net.send({ t: 'rtc', to: from, d: { sdp: pc.localDescription } });
      }
    } else if (d.ice) {
      if (!pc.remoteDescription) { peer.pending.push(d.ice); return; }
      try { await pc.addIceCandidate(d.ice); } catch (err) { if (!peer.ignoreOffer) console.warn('ice error', err); }
    }
  }

  _attach(peer, stream) {
    if (peer.gain) return;
    this.audio.init();
    const ctx = this.audio.ctx;
    // Chrome only feeds remote streams into WebAudio when they're also attached to a media element
    const el = peer.audioEl = new Audio(); el.srcObject = stream; el.muted = true; el.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    peer.analyser = ctx.createAnalyser(); peer.analyser.fftSize = 512; peer.buf = new Uint8Array(512);
    src.connect(peer.analyser);
    peer.gain = ctx.createGain();
    peer.direct = ctx.createGain(); peer.spat = ctx.createGain();
    const p = peer.panner = ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'linear'; p.refDistance = 6; p.maxDistance = 90; p.rolloffFactor = 1;
    src.connect(peer.gain);
    peer.gain.connect(peer.direct); peer.gain.connect(peer.spat);
    peer.spat.connect(p); p.connect(this.audio.voice); peer.direct.connect(this.audio.voice);
    this._route(peer);
  }

  _route(peer) {
    if (!peer.gain) return;
    const prox = S.voiceMode === 'prox' && this.positional;
    peer.spat.gain.value = prox ? 1 : 0; peer.direct.gain.value = prox ? 0 : 1;
    peer.gain.gain.value = this.muted.has(peer.id) ? 0 : 1;
  }

  mute(id, on) { if (on) this.muted.add(id); else this.muted.delete(id); const p = this.peers.get(id); if (p) this._route(p); this.onChange(); }
  isMuted(id) { return this.muted.has(id); }

  // per-frame: positions + speaking levels
  update(getPos, positional) {
    this.positional = positional;
    const rms = (an, buf) => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); };
    if (this.local.analyser) { const l = rms(this.local.analyser, this.local.buf); this.local.lvl = this.local.lvl * 0.7 + l * 0.3; }
    const nowMs = performance.now();
    for (const peer of this.peers.values()) {
      // watchdog: if ICE never completes, restart it (up to 4 times)
      if (peer.pc.connectionState !== 'connected' && nowMs > peer.retryAt && peer.retries < 4) {
        peer.retries++; peer.retryAt = nowMs + 9000;
        try { peer.pc.restartIce(); } catch (e) { console.warn('restartIce failed', e); }
      }
    }
    for (const peer of this.peers.values()) {
      if (!peer.gain) continue;
      this._route(peer);
      if (positional) {
        const pos = getPos(peer.id);
        if (pos) { const p = peer.panner; if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z); }
      }
      peer.lvl = peer.lvl * 0.7 + rms(peer.analyser, peer.buf) * 0.3;
    }
  }
  speaking(id) { const p = this.peers.get(id); return !!p && p.lvl > 0.035 && !this.muted.has(id); }
  localSpeaking() { return this.talking && this.local.lvl > 0.035; }
  state(id) { const p = this.peers.get(id); return p ? p.state : 'none'; }

  _close(id) {
    const p = this.peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch {}
    try { p.gain && p.gain.disconnect(); p.panner && p.panner.disconnect(); } catch {}
    if (p.audioEl) { p.audioEl.srcObject = null; }
    this.peers.delete(id);
  }
  closeAll() { for (const id of [...this.peers.keys()]) this._close(id); }
}
