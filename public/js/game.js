// In-match client: input, movement, throwing, sonar, snapshot interpolation, events, camera, per-frame HUD/audio.
import * as THREE from 'three';
import { RULES, ORB, ORB_ORDER, FLAGS } from './rules.js';
import { WORLD, heightAt, normalAt, slopeAt, floorAt, forestAt, queryColliders } from './terrain.js';
import { S } from './settings.js';
import { Avatar, Viewmodel, makeOrbMesh, updateOrbMesh, makePickup, updatePickup } from './orbmesh.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now() / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
function angLerp(a, b, t) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }

function pushSnap(buf, s) { buf.push(s); if (buf.length > 8) buf.shift(); }
function sampleBuf(buf, t, out) {
  const n = buf.length;
  if (!n) return false;
  let a, b, f = 0;
  if (t >= buf[n - 1].t) a = b = buf[n - 1];
  else if (t <= buf[0].t) a = b = buf[0];
  else for (let i = n - 2; i >= 0; i--) if (buf[i].t <= t) { a = buf[i]; b = buf[i + 1]; f = (t - a.t) / Math.max(1e-4, b.t - a.t); break; }
  if (!a) a = b = buf[n - 1];
  out.x = a.x + (b.x - a.x) * f; out.y = a.y + (b.y - a.y) * f; out.z = a.z + (b.z - a.z) * f;
  out.yaw = angLerp(a.yaw || 0, b.yaw || 0, f); out.pitch = (a.pitch || 0) + ((b.pitch || 0) - (a.pitch || 0)) * f;
  out.fl = f > 0.5 ? b.fl : a.fl;
  return true;
}

const KILL_TEXT = { sea: 'was swept out to sea', fire: 'burned to death', gas: 'breathed blazing gas', blast: 'was blown apart', left: 'left the island' };

export class Game {
  constructor({ scene, camera, renderer, world, effects, audio, voice, net, hud, tex }) {
    Object.assign(this, { scene, camera, renderer, world, effects, audio, voice, net, hud, tex });
    camera.rotation.order = 'YXZ';
    this.active = false; this.ended = false; this.locked = false; this.onLock = () => {};
    this.keys = new Set(); this.col = [];
    this.players = new Map(); this.orbs = new Map(); this.pickups = new Map(); this.flames = []; this.gasLoops = new Set();
    this.me = this._newMe(); this.meAvatar = null; this.spec = { id: null };
    this.vm = new Viewmodel(camera, $('radar')); this.vm.show(false);
    this.N = [0, 1, 0]; this.D = new THREE.Vector3(); this.tOff = null; this.matchTime = RULES.matchTime; this.goal = RULES.chipGoal;
    this.raiseUntil = 0; this.sendAt = 0; this.ambAt = 0; this.voiceAt = 0; this.hbAt = 0; this.dotAcc = 0; this.hurtAt = 0; this.lastFov = 0;
    const g = new THREE.BufferGeometry(); this.trajPos = new Float32Array(3 * 40); g.setAttribute('position', new THREE.BufferAttribute(this.trajPos, 3)); g.setDrawRange(0, 0);
    this.traj = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.16, map: tex.dot, color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, alphaTest: 0.02 }));
    this.traj.frustumCulled = false; this.traj.visible = false; scene.add(this.traj);
    this._bindNet(); this._bindDom();
  }

  _newMe() {
    return { id: null, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: false, crouchT: 0, crouch: false, sprint: false, swim: false, stam: 1, stamLock: false, stamDelay: 0,
      hp: RULES.hp, alive: false, phase: 'none', chips: 0, sel: 0, charge: -1, fuse: 10, throwReady: 0, sonarReady: 0, stride: 0, fl: 0, loadout: new Array(8).fill(null), speed: 0, shield: false, burn: false, swimStep: 0, deathPos: null, wasSwim: false };
  }

  // ======================================================================== lifecycle
  begin(msg) {
    this.stop(true);
    const m = this.me = this._newMe();
    m.id = this.net.id; this.ended = false; this.tOff = null; this.matchTime = msg.matchTime; this.goal = msg.goal;
    for (const p of msg.players) {
      if (p.id === m.id) { this.meAvatar = new Avatar(p.color, p.name); this.meAvatar.group.visible = false; this.scene.add(this.meAvatar.group); this.meInfo = p; continue; }
      const av = new Avatar(p.color, p.name); av.group.visible = false; this.scene.add(av.group);
      this.players.set(p.id, { id: p.id, name: p.name, color: p.color, avatar: av, buf: [], s: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fl: 0 }, hp: 100, chips: 0, stepAcc: 0, fire: 0, seen: false });
    }
    m.x = msg.spawn.x; m.y = msg.spawn.y; m.z = msg.spawn.z; m.yaw = Math.atan2(m.x, m.z); m.pitch = -0.3;
    m.alive = true; m.phase = 'drop'; m.hp = RULES.hp; m.stam = 1;
    m.loadout = msg.loadout.map((i) => (i >= 0 ? ORB_ORDER[i] : null));
    this.world.resetTrees();
    for (const pk of msg.pickups || []) this._addPickup(pk);
    this.hud.reset(); this.hud.show(true); this.hud.setInv(m.loadout); this.hud.setChips(0, this.goal); this.hud.setAlive(msg.players.length, msg.players.length);
    this._select(m.loadout.findIndex(Boolean) >= 0 ? m.loadout.findIndex(Boolean) : 0);
    this.hud.setSonarCooldown(0);
    this.hud.hint('WASD to glide  ·  land on the island');
    this.hud.toast(`Collect ${this.goal} chips from other players to win`, 'info');
    this.audio.init(); this.audio.resume(); this.audio.startAmbience(); this.audio.startMusic(); this.audio.parachute();
    this.voice.setPeers(msg.players.map((p) => p.id), m.id);
    this.camera.fov = S.fov; this.camera.updateProjectionMatrix();
    this.active = true; this.t = now(); this.pkTimer = 0;
  }

  finish() { this.ended = true; this.me.charge = -1; this.hud.charge(-1); this.traj.visible = false; this.keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); }

  stop(silent) {
    this.active = false;
    for (const p of this.players.values()) p.avatar.dispose();
    this.players.clear();
    if (this.meAvatar) { this.meAvatar.dispose(); this.meAvatar = null; }
    for (const o of this.orbs.values()) { this.scene.remove(o.mesh); this.audio.stopLoop('o' + o.id); }
    this.orbs.clear();
    for (const k of this.pickups.values()) this.scene.remove(k.mesh);
    this.pickups.clear();
    for (const id of this.gasLoops) this.audio.stopLoop(id);
    this.gasLoops.clear();
    for (const f of this.flames) this.audio.stopLoop(f.id);
    this.flames = []; this.effects.gas.clear();
    this.traj.visible = false; this.vm.show(false); this.keys.clear();
    if (!silent) { this.audio.stopAmbience(); this.audio.stopMusic(); this.hud.show(false); if (document.pointerLockElement) document.exitPointerLock(); $('under').classList.remove('on'); }
  }

  // ======================================================================== network
  _bindNet() {
    const n = this.net, on = (t, f) => n.on(t, (m) => { if (this.active) f.call(this, m); });
    on('snap', this._onSnap);
    on('ev', this._onEvent);
    on('hit', (m) => {
      const me = this.me, t = now(); me.hp = m.hp;
      if (m.d >= 3) { this.hud.damage(m.d); this.effects.addShake(Math.min(0.7, m.d / 70)); if (t - this.hurtAt > 0.25) { this.audio.hurt(m.d); this.hurtAt = t; } }
      else { this.dotAcc += m.d + 0.4; if (this.dotAcc > 2.5) { this.dotAcc = 0; this.hud.damage(6); if (t - this.hurtAt > 0.7) { this.audio.hurt(6); this.hurtAt = t; } } }
      if (m.k !== 'sea' && Math.hypot(m.x - me.x, m.z - me.z) > 1.5) this.hud.indicate('hit', m.x, m.z, 1.6);
    });
    on('shield', () => { this.audio.barrierHit(); this.hud.toast('BLOCKED', 'info'); });
    on('sonar', (m) => {
      const t = now();
      if (m.cancel) { this.hud.sonarCancel(t); this.audio.sonarCancel(); this.hud.toast('Signal cancelled: another chip pulsed at the same time', 'warn'); return; }
      this.hud.sonarResult(m, t); this.raiseUntil = t + 4.5;
      this.effects.sonarRing(m.ox, heightAt(m.ox, m.oz) + 0.5, m.oz, m.r);
      if (m.blips.length) { this.audio.tick(); this.hud.toast(`${m.blips.length} signal${m.blips.length > 1 ? 's' : ''} detected`, 'info'); } else this.hud.toast('No movement detected', '');
    });
    on('pinged', (m) => { this.audio.pinged(); this.hud.indicate('ping', m.x, m.z, 3.2); this.hud.toast('Your chip was scanned', 'warn'); });
    on('inv', (m) => { this.me.loadout = m.l.map((i) => (i >= 0 ? ORB_ORDER[i] : null)); this.hud.setInv(this.me.loadout); this._autoSelect(); });
    on('pk', (m) => { for (const pk of m.add || []) this._addPickup(pk); for (const id of m.del || []) this._delPickup(id); });
    on('fix', (m) => { this.me.x = m.x; this.me.y = m.y; this.me.z = m.z; this.me.vx = this.me.vz = 0; });
  }

  _addPickup(pk) {
    this._delPickup(pk.id);
    const mesh = makePickup(pk.k, this.tex); mesh.position.set(pk.x, pk.y, pk.z); this.scene.add(mesh);
    this.pickups.set(pk.id, { id: pk.id, k: pk.k, mesh });
  }
  _delPickup(id) { const p = this.pickups.get(id); if (!p) return; this.scene.remove(p.mesh); this.pickups.delete(id); }

  _onSnap(m) {
    const t = now(), me = this.me;
    this.tOff = this.tOff === null ? t - m.tm : this.tOff * 0.9 + (t - m.tm) * 0.1;
    let alive = 0;
    for (const [id, x, y, z, yaw, pitch, fl, hp, chips] of m.p) {
      if (!(fl & FLAGS.DEAD)) alive++;
      if (id === me.id) {
        me.shield = !!(fl & FLAGS.SHIELD); me.burn = !!(fl & FLAGS.BURN);
        if (chips !== me.chips) { me.chips = chips; this.hud.setChips(chips, this.goal); }
        if (me.alive) me.hp = hp;
        continue;
      }
      const p = this.players.get(id);
      if (!p) continue;
      pushSnap(p.buf, { t, x, y, z, yaw, pitch, fl }); p.hp = hp; p.chips = chips; p.seen = true;
    }
    this.hud.setAlive(alive, this.players.size + 1);
    // orbs
    const seen = new Set();
    for (const [id, ti, x, y, z, st, owner, extra] of m.o) {
      seen.add(id);
      let o = this.orbs.get(id);
      if (!o) {
        const type = ORB_ORDER[ti], mesh = makeOrbMesh(type); mesh.position.set(x, y, z); this.scene.add(mesh);
        o = { id, type, mesh, buf: [], s: { x, y, z, yaw: 0, pitch: 0, fl: 0 }, st, owner, extra, nextTick: 0, sucking: false };
        this.orbs.set(id, o);
      }
      o.st = st; o.extra = extra; pushSnap(o.buf, { t, x, y, z, yaw: 0, pitch: 0, fl: 0 });
    }
    for (const o of [...this.orbs.values()]) if (!seen.has(o.id)) { this.scene.remove(o.mesh); this.audio.stopLoop('o' + o.id); this.orbs.delete(o.id); }
    this.effects.syncGas(m.g, 0);
  }

  _onEvent(m) {
    const me = this.me, pos = { x: m.x, y: m.y, z: m.z }, cam = this.camera.position;
    const who = (id) => (id === me.id ? this.meInfo : this.players.get(id));
    switch (m.k) {
      case 'boom': {
        const kind = ORB_ORDER[m.o];
        this.effects.boom(kind, pos);
        if (kind === 'implosion') this.audio.implode(pos); else this.audio.boom(kind, pos);
        const def = ORB[kind], R = kind === 'implosion' ? def.trees : def.blast ? def.blast * 0.45 : 0;
        if (R > 0) { const gone = this.world.destroyTrees(m.x, m.z, R); for (let i = 0; i < gone.length && i < 14; i++) this.effects.treeBurst(gone[i]); }
        if (Math.hypot(m.x - cam.x, m.y - cam.y, m.z - cam.z) < 7 && me.alive) this.hud.flash();
        break;
      }
      case 'gas': this.audio.boom('gas', pos); break;
      case 'flame': {
        this.effects.addStreaks(m.x, m.y, m.z, m.a, m.life); this.effects.boom('flame', pos); this.audio.boom('flame', pos);
        const gone = this.world.destroyTrees(m.x, m.z, 3.5); for (let i = 0; i < gone.length && i < 10; i++) this.effects.treeBurst(gone[i]);
        const id = 'f' + m.x + '_' + m.z + '_' + Math.random(); this.audio.startLoop(id, 'flame', { x: m.x + 4, y: m.y, z: m.z }); this.flames.push({ id, until: now() + m.life });
        break;
      }
      case 'throw': {
        this.audio.throwSwish(pos);
        const p = this.players.get(m.id); if (p) p.avatar.triggerThrow();
        break;
      }
      case 'barrier': {
        const p = who(m.id), at = m.id === me.id ? { x: me.x, y: me.y + 1, z: me.z } : p && p.s;
        this.audio.barrierOn(at || null);
        if (m.id === me.id) this.hud.toast('BARRIER ACTIVE', 'good');
        break;
      }
      case 'death': {
        const v = who(m.id), killer = m.by !== null && m.by !== undefined ? who(m.by) : null;
        if (killer && m.by !== m.id) this.hud.feed(`${this.hud.nameHtml(killer)} eliminated ${this.hud.nameHtml(v)}`, m.by === me.id || m.id === me.id ? 'mine' : '');
        else this.hud.feed(`${this.hud.nameHtml(v)} ${KILL_TEXT[m.kind] || 'was eliminated'}`, m.id === me.id ? 'mine' : '');
        if (m.id === me.id) this._onMyDeath();
        break;
      }
      case 'chip': {
        const v = who(m.id);
        this.hud.feed(`${this.hud.nameHtml(v)} took ${m.n} chip${m.n > 1 ? 's' : ''}`, m.id === me.id ? 'mine' : '');
        if (m.id === me.id) { this.audio.chipGot(); this.hud.toast(`+${m.n} CHIP`, 'good'); }
        break;
      }
      case 'got': this.audio.pickup(); this.hud.toast('Orbs collected', 'good'); break;
      case 'left': {
        const p = this.players.get(m.id);
        if (p) { this.hud.feed(`${this.hud.nameHtml(p)} disconnected`); p.avatar.dispose(); this.players.delete(m.id); this.voice.setPeers([...this.players.keys(), me.id], me.id); }
        break;
      }
      default: break;
    }
  }

  _onMyDeath() {
    const me = this.me;
    me.alive = false; me.phase = 'dead'; me.charge = -1; me.deathPos = { x: me.x, y: me.y, z: me.z };
    this.hud.charge(-1); this.traj.visible = false; this.vm.show(false);
    this.audio.death(); this.hud.damage(100); this.hud.toast('ELIMINATED', 'bad');
    this.spec.id = null; this._nextSpec(1);
    this.hud.hint('Click to cycle spectate');
  }

  // ======================================================================== input
  _bindDom() {
    const cv = this.renderer.domElement;
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === cv; if (!this.locked) { this.keys.clear(); if (this.me.charge >= 0) { this.me.charge = -1; this.hud.charge(-1); this.traj.visible = false; } } this.onLock(this.locked); });
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.voice.setPtt(false); });
    document.addEventListener('mousemove', (e) => {
      if (!this.active || !this.locked || this.hud.chatOpen) return;
      const s = 0.0022 * S.sens, m = this.me;
      m.yaw -= e.movementX * s; m.pitch = clamp(m.pitch - e.movementY * s * (S.invertY ? -1 : 1), -1.52, 1.52);
    });
    cv.addEventListener('mousedown', (e) => { e.preventDefault(); this._mouse(e, true); });
    window.addEventListener('mouseup', (e) => this._mouse(e, false));
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => { if (!this.active || !this.locked || !this.me.alive) return; this._select((this.me.sel + (e.deltaY > 0 ? 1 : 7)) % 8); }, { passive: true });
    $('chat-input').addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'Enter') { const text = e.target.value.trim(); if (text) this.net.send({ t: 'chat', text }); this.hud.openChat(false); e.stopPropagation(); e.preventDefault(); }
      else if (e.code === 'Escape') { this.hud.openChat(false); e.stopPropagation(); }
    });
  }

  _key(e, down) {
    if (!this.active) return;
    if (this.hud.chatOpen) return;
    const c = e.code;
    if (down) {
      if (c === 'Tab') { e.preventDefault(); this.tab = true; return; }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) e.preventDefault();
      if (e.repeat) { this.keys.add(c); return; }
      this.keys.add(c);
      if (!this.locked || this.ended) return;
      const me = this.me;
      if (c === 'Enter') { this.keys.clear(); this.hud.openChat(true); return; }
      if (c === 'KeyV') { this._ptt(true); return; }
      if (c === 'KeyM') { S.micOn = !S.micOn; this.voice.refresh(); this.hud.toast(S.micOn ? 'Microphone on' : 'Microphone muted'); return; }
      if (!me.alive) { if (c === 'Space' || c === 'KeyD') this._nextSpec(1); else if (c === 'KeyA') this._nextSpec(-1); return; }
      if (c >= 'Digit1' && c <= 'Digit8') this._select(+c.slice(5) - 1);
      else if (c === 'KeyQ') this._sonar();
      else if (c === 'KeyG') { this.net.send({ t: 'det', all: e.shiftKey }); this.audio.detClick(); }
      else if (c === 'KeyZ') { me.fuse = Math.max(1, me.fuse - 0.5); this._showFuse(); }
      else if (c === 'KeyX') { me.fuse = Math.min(ORB.timer.fuse, me.fuse + 0.5); this._showFuse(); }
    } else {
      this.keys.delete(c);
      if (c === 'Tab') { this.tab = false; this.hud.scoreboard(false); }
      if (c === 'KeyV') this._ptt(false);
    }
  }

  _ptt(down) {
    const v = this.voice;
    if (v.micState !== 'on') { if (down && v.micState !== 'requesting') v.enableMic().then(() => this._micHud()); return; }
    v.setPtt(down); this._micHud();
  }
  _micHud() {
    const v = this.voice;
    let txt = '', on = false;
    if (v.micState === 'off') txt = 'VOICE · press V to enable mic';
    else if (v.micState === 'requesting') txt = 'MIC · allow access…';
    else if (v.micState === 'denied') txt = 'MIC BLOCKED';
    else if (v.micState === 'unsupported') txt = 'MIC UNAVAILABLE (needs HTTPS)';
    else if (!S.micOn) txt = 'MIC MUTED';
    else if (S.ptt) { on = v.pttDown; txt = on ? 'TRANSMITTING' : 'MIC · hold V'; } else { on = true; txt = 'MIC LIVE'; }
    this.hud.setMic(txt, on);
  }

  _mouse(e, down) {
    if (!this.active) return;
    const me = this.me;
    if (down) {
      if (!this.locked) { if (!this.ended) this.renderer.domElement.requestPointerLock(); return; }
      if (this.ended) return;
      if (!me.alive) { this._nextSpec(1); return; }
      if (e.button === 0) this._startCharge(); else if (e.button === 2) this._throw(0.3);
    } else if (e.button === 0 && me.charge >= 0) {
      const pw = 0.2 + 0.8 * me.charge; me.charge = -1; this.hud.charge(-1); this.traj.visible = false;
      this._throw(pw);
    }
  }

  _select(i) {
    const me = this.me; me.sel = i; this.hud.select(i);
    const t = me.loadout[i]; this.vm.setOrb(me.alive && me.phase === 'play' ? t : null); this._pendingOrb = t;
    this.audio.tick(); this._showFuse();
    if (me.charge >= 0) { me.charge = -1; this.hud.charge(-1); this.traj.visible = false; }
  }
  _showFuse() { const me = this.me, t = me.loadout[me.sel]; this.hud.fuse(t === 'timer' ? me.fuse : null); }
  _autoSelect() {
    const me = this.me;
    if (!me.loadout[me.sel]) { const i = me.loadout.findIndex(Boolean); if (i >= 0) this._select(i); else this._select(me.sel); } else this._select(me.sel);
  }

  _startCharge() {
    const me = this.me, t = now();
    if (me.phase !== 'play') { this.hud.toast('Land first', 'warn'); return; }
    const type = me.loadout[me.sel];
    if (!type) { this.hud.toast('Empty slot', 'warn'); return; }
    if (t < me.throwReady) return;
    if (type === 'barrier') { this.net.send({ t: 'throw', slot: me.sel, d: [0, 1, 0], pw: 0 }); me.throwReady = t + 0.5; this.audio.activate(); return; }
    me.charge = 0;
  }

  _throwDir(out) {
    const m = this.me, cp = Math.cos(m.pitch);
    out.set(-Math.sin(m.yaw) * cp, Math.sin(m.pitch) + 0.06, -Math.cos(m.yaw) * cp).normalize();
    return out;
  }

  _throw(pw) {
    const me = this.me, t = now();
    if (!me.alive || me.phase !== 'play' || t < me.throwReady) return;
    const type = me.loadout[me.sel];
    if (!type) return;
    if (type === 'barrier') { this._startCharge(); return; }
    const d = this._throwDir(this.D);
    this.net.send({ t: 'throw', slot: me.sel, d: [r2(d.x), r2(d.y), r2(d.z)], pw: r2(pw), fuse: me.fuse });
    me.throwReady = t + 0.45; this.vm.triggerThrow();
    if (type === 'timer') this.audio.activate();
    this.audio.throwSwish(null);
  }

  _sonar() {
    const me = this.me, t = now();
    if (me.phase !== 'play') { this.hud.toast('Chip offline while airborne', 'warn'); return; }
    if (t < me.sonarReady) return;
    me.sonarReady = t + RULES.sonarCooldown; this.hud.setSonarCooldown(me.sonarReady);
    this.net.send({ t: 'sonar' }); this.audio.sonar(true, null); this.raiseUntil = t + 3.5;
  }

  _nextSpec(dir) {
    const list = [...this.players.values()].filter((p) => p.seen && !(p.s.fl & FLAGS.DEAD)).sort((a, b) => a.id.localeCompare ? a.id.localeCompare(b.id) : a.id - b.id);
    if (!list.length) { this.spec.id = null; this.hud.setSpectate(null); return; }
    let i = list.findIndex((p) => p.id === this.spec.id);
    i = (i + dir + list.length) % list.length;
    this.spec.id = list[i].id; this.hud.setSpectate(list[i].name);
  }

  // ======================================================================== per-frame
  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    const t = now(); this.t = t;
    const me = this.me;
    if (me.alive) this._move(dt, t);
    this._entities(dt, t);
    this._cameraUpdate(dt, t);
    this._audioUpdate(dt, t);
    this._hudUpdate(dt, t);
    this._send(t);
  }

  _move(dt, t) {
    const m = this.me, k = this.keys, can = this.locked && !this.hud.chatOpen && !this.ended;
    const iF = can ? (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) : 0, iS = can ? (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) : 0;
    const sy = Math.sin(m.yaw), cy = Math.cos(m.yaw);
    let wx = -sy * iF + cy * iS, wz = -cy * iF - sy * iS;
    const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
    if (m.charge >= 0) { m.charge = Math.min(1, m.charge + dt / RULES.chargeTime); this.hud.charge(m.charge); this._updateTraj(0.2 + 0.8 * m.charge); } else this.traj.visible = false;

    if (m.phase === 'drop') {
      const sp = RULES.dropGlide, a = Math.min(1, dt * 2);
      m.vx += (wx * sp - m.vx) * a; m.vz += (wz * sp - m.vz) * a;
      m.x += m.vx * dt; m.z += m.vz * dt; m.y -= RULES.dropSpeed * dt; m.speed = Math.hypot(m.vx, m.vz); m.fl = 0; m.swim = false; m.crouch = false; m.sprint = false;
      const g = floorAt(m.x, m.z, m.y), landY = g < -0.95 ? -1.1 : g;
      if (m.y <= landY + 0.02) {
        m.y = landY; m.vy = 0; m.phase = 'play'; m.onGround = true; m.vx = m.vz = 0;
        if (g < -0.95) this.audio.splash({ x: m.x, y: 0, z: m.z }); else this.audio.landing(null);
        this.hud.hint(''); this.hud.toast('Landed. Press Q to scan with your chip', 'info');
        this._select(m.sel);
      }
      return;
    }

    // --- ground movement
    const g0 = floorAt(m.x, m.z, m.y);
    m.swim = g0 < -0.95;
    if (m.swim && !m.wasSwim) this.audio.splash({ x: m.x, y: 0, z: m.z });
    m.wasSwim = m.swim;
    const wantCrouch = can && k.has('KeyC') && !m.swim;
    m.crouch = wantCrouch; m.crouchT += ((wantCrouch ? 1 : 0) - m.crouchT) * Math.min(1, dt * 10);
    const moving = wl > 0.05;
    const wantSprint = can && (k.has('ShiftLeft') || k.has('ShiftRight')) && iF > 0 && !m.crouch && !m.swim && !m.stamLock;
    m.sprint = wantSprint && moving;
    if (m.sprint) { m.stam -= dt / 6; m.stamDelay = 0.9; if (m.stam <= 0) { m.stam = 0; m.stamLock = true; } }
    else { m.stamDelay -= dt; if (m.stamDelay <= 0) m.stam = Math.min(1, m.stam + dt / 4); if (m.stamLock && m.stam > 0.3) m.stamLock = false; }
    let speed = m.swim ? RULES.swim : m.crouch ? RULES.crouch : m.sprint ? RULES.sprint : RULES.walk;
    if (!m.swim && g0 < -0.2) speed *= 0.75;
    const nrm = normalAt(m.x, m.z, this.N);
    const uphill = -(wx * nrm[0] + wz * nrm[2]);
    if (m.onGround && uphill > 0) speed *= 1 - clamp(uphill * (1 - nrm[1]) * 1.6, 0, 0.5);
    if (m.onGround && nrm[1] < 0.55) { m.vx += nrm[0] * 10 * dt; m.vz += nrm[2] * 10 * dt; if (uphill > 0) speed *= 0.2; }
    const acc = (m.onGround || m.swim) ? 12 : 2.5, a = Math.min(1, acc * dt);
    m.vx += (wx * speed - m.vx) * a; m.vz += (wz * speed - m.vz) * a;
    if (can && k.has('Space') && m.onGround && !m.swim && !m.crouch) { m.vy = RULES.jump; m.onGround = false; }

    // horizontal move with step limit
    const step = (nx, nz) => {
      const len = Math.hypot(nx - m.x, nz - m.z);
      if (len < 1e-5) return true;
      const gN = floorAt(nx, nz, m.y);
      if (m.onGround && !m.swim && gN - m.y > 0.14 + len * 1.4 && gN - m.y > 0.05) return false;
      m.x = nx; m.z = nz; return true;
    };
    const tx = m.x + m.vx * dt, tz = m.z + m.vz * dt;
    if (!step(tx, tz)) { if (!step(tx, m.z)) m.vx *= 0.2; if (!step(m.x, tz)) m.vz *= 0.2; }
    const top = this._collide(m);

    // vertical
    const g = Math.max(floorAt(m.x, m.z, m.y), top);
    if (m.swim) { m.vy = 0; m.y += (-1.1 - m.y) * Math.min(1, dt * 6); m.onGround = false; }
    else {
      m.vy -= RULES.gravity * dt; m.y += m.vy * dt;
      if (m.y <= g) { if (!m.onGround && m.vy < -7) this.audio.landing(null); m.y = g; m.vy = 0; m.onGround = true; }
      else if (m.onGround && m.vy <= 0 && m.y - g < 0.4 && m.vy > -3) { m.y = g; m.vy = 0; }
      else m.onGround = false;
    }
    m.speed = Math.hypot(m.vx, m.vz);
    m.fl = (m.crouch ? FLAGS.CROUCH : 0) | (m.sprint ? FLAGS.SPRINT : 0) | (m.swim ? FLAGS.SWIM : 0);

    // footsteps
    if (m.swim) { m.swimStep += m.speed * dt; if (m.swimStep > 2.4) { m.swimStep = 0; this.audio.footstep('water', 0.35, null); } }
    else if (m.onGround && m.speed > 0.8) {
      m.stride += m.speed * dt;
      const len = m.crouch ? 2.6 : m.sprint ? 2.1 : 2.4;
      if (m.stride > len) { m.stride = 0; this.audio.footstep(this._surface(m.x, m.z, m.y), m.crouch ? 0.12 : m.sprint ? 0.85 : 0.45, null); }
    }
  }

  _collide(m) {
    const r = RULES.radius; let top = -1e9;
    queryColliders(m.x, m.z, 2.6, this.col, this.world.deadTrees);
    const feet = m.y, head = m.y + (m.crouch ? 1.2 : 1.8);
    for (const c of this.col) {
      if (head <= c.y0) continue;
      if (c.k === 0) {
        const dx = m.x - c.x, dz = m.z - c.z, d = Math.hypot(dx, dz), min = c.r + r;
        if (feet >= c.y1 - 0.45) { if (d < c.r + 0.2) top = Math.max(top, c.y1); continue; }
        if (d < min) { const l = d || 1; m.x = c.x + dx / l * min; m.z = c.z + dz / l * min; }
      } else {
        const inX = m.x > c.minX - r && m.x < c.maxX + r, inZ = m.z > c.minZ - r && m.z < c.maxZ + r;
        if (!inX || !inZ) continue;
        if (feet >= c.y1 - 0.45) { if (m.x > c.minX - 0.1 && m.x < c.maxX + 0.1 && m.z > c.minZ - 0.1 && m.z < c.maxZ + 0.1) top = Math.max(top, c.y1); continue; }
        const px1 = m.x - (c.minX - r), px2 = (c.maxX + r) - m.x, pz1 = m.z - (c.minZ - r), pz2 = (c.maxZ + r) - m.z, mn = Math.min(px1, px2, pz1, pz2);
        if (mn === px1) { m.x = c.minX - r; m.vx = Math.min(0, m.vx); } else if (mn === px2) { m.x = c.maxX + r; m.vx = Math.max(0, m.vx); }
        else if (mn === pz1) { m.z = c.minZ - r; m.vz = Math.min(0, m.vz); } else { m.z = c.maxZ + r; m.vz = Math.max(0, m.vz); }
      }
    }
    return top;
  }

  _surface(x, z, y) {
    const h = heightAt(x, z), f = floorAt(x, z, y);
    if (f > h + 0.15) return 'wood';
    if (h < -0.15) return 'water';
    if (h < 2.0) return 'sand';
    const sl = slopeAt(x, z);
    if (sl > 0.55) return 'rock';
    return forestAt(x, z, h, sl) > 0.35 ? 'leaf' : 'grass';
  }

  _updateTraj(pw) {
    const m = this.me, d = this._throwDir(this.D), sp = RULES.throwMin + (RULES.throwMax - RULES.throwMin) * pw;
    const eye = m.crouch ? RULES.eyeCrouch : RULES.eye;
    let x = m.x + d.x * 0.7, y = m.y + eye + d.y * 0.7 - 0.15, z = m.z + d.z * 0.7, vx = d.x * sp, vy = d.y * sp, vz = d.z * sp, n = 0;
    const type = m.loadout[m.sel];
    if (!type || type === 'barrier') { this.traj.visible = false; return; }
    for (let i = 0; i < 40; i++) {
      vy -= 9.8 * 0.05; x += vx * 0.05; y += vy * 0.05; z += vz * 0.05;
      this.trajPos[n * 3] = x; this.trajPos[n * 3 + 1] = y; this.trajPos[n * 3 + 2] = z; n++;
      if (y <= floorAt(x, z, y) + 0.1) break;
    }
    this.traj.geometry.setDrawRange(0, n); this.traj.geometry.attributes.position.needsUpdate = true; this.traj.visible = true;
  }

  _entities(dt, t) {
    const rt = t - 0.11, cam = this.camera.position, me = this.me, fx = this.effects;
    for (const p of this.players.values()) {
      const av = p.avatar;
      if (!sampleBuf(p.buf, rt, p.s)) { av.group.visible = false; continue; }
      const s = p.s, dist = Math.hypot(s.x - cam.x, s.z - cam.z);
      av.group.visible = dist < 420;
      if (!av.group.visible) continue;
      av.update(dt, s.x, s.y, s.z, s.yaw, s.pitch, s.fl, cam);
      if (!(s.fl & FLAGS.DEAD) && !(s.fl & FLAGS.DROP) && av.speed > 1.2 && dist < 55) {
        p.stepAcc += av.speed * dt;
        const len = (s.fl & FLAGS.CROUCH) ? 2.6 : (s.fl & FLAGS.SPRINT) ? 2.1 : 2.4;
        if (p.stepAcc > len) { p.stepAcc = 0; this.audio.footstep((s.fl & FLAGS.SWIM) ? 'water' : this._surface(s.x, s.z, s.y), (s.fl & FLAGS.CROUCH) ? 0.1 : (s.fl & FLAGS.SPRINT) ? 0.9 : 0.5, { x: s.x, y: s.y + 0.1, z: s.z }); }
      }
      if ((s.fl & FLAGS.BURN) && Math.random() < dt * 22) fx.fire.emit(s.x + (Math.random() - 0.5) * 0.5, s.y + 0.4 + Math.random() * 1.2, s.z + (Math.random() - 0.5) * 0.5, 0, 1.6, 0, 0.6, 0.6, 0.2, [1, 0.7, 0.3], [0.9, 0.2, 0.05], 0.8, 0, 0.5);
    }
    // my own avatar: visible under the parachute and after death
    if (this.meAvatar) {
      const m = me, av = this.meAvatar, vis = m.phase === 'drop' || !m.alive;
      av.group.visible = vis;
      if (vis) {
        const p = m.alive ? m : (m.deathPos || m);
        av.update(dt, p.x, p.y, p.z, m.yaw, m.pitch, m.alive ? (FLAGS.DROP) : FLAGS.DEAD, cam);
        av.head.visible = !m.alive; av.tag.visible = false;
      }
    }
    // orbs
    for (const o of this.orbs.values()) {
      sampleBuf(o.buf, rt, o.s);
      o.mesh.position.set(o.s.x, o.s.y, o.s.z);
      updateOrbMesh(o.mesh, o.st, o.extra, t, dt);
      const d = Math.hypot(o.s.x - cam.x, o.s.y - cam.y, o.s.z - cam.z);
      if (o.type === 'timer' && d < 70 && t >= o.nextTick) { const f = o.extra; this.audio.timerTick(o.s, f < 2 ? 1 : 0); o.nextTick = t + (f < 2 ? 0.18 : f < 4 ? 0.45 : 1.0); }
      else if (o.type === 'remote' && d < 28 && o.st === 1 && t >= o.nextTick) { this.audio.remoteBlip(o.s); o.nextTick = t + 2.4; }
      else if (o.type === 'homing') { this.audio.startLoop('o' + o.id, 'homing', o.s); this.audio.updateLoop('o' + o.id, o.s); }
      if (o.type === 'implosion' && o.st === 2 && !o.sucking) { o.sucking = true; this.audio.implosionSuck(o.s, 2.4); fx.implosionSuck(o.s.x, o.s.y, o.s.z, ORB.implosion.suck + 0.1); }
    }
    for (const k of this.pickups.values()) updatePickup(k.mesh, t, cam);
    // flame & gas loops
    for (let i = this.flames.length - 1; i >= 0; i--) if (t > this.flames[i].until) { this.audio.stopLoop(this.flames[i].id); this.flames.splice(i, 1); }
    const live = new Set();
    for (const [id, c] of fx.gas) { const key = 'g' + id; live.add(key); this.audio.startLoop(key, 'gas', c); this.audio.updateLoop(key, c); this.gasLoops.add(key); }
    for (const key of [...this.gasLoops]) if (!live.has(key)) { this.audio.stopLoop(key); this.gasLoops.delete(key); }
  }

  _eyeHeight(m) { return m.swim ? 1.6 : 1.7 + (RULES.eyeCrouch - 1.7) * m.crouchT; }

  _cameraUpdate(dt, t) {
    const cam = this.camera, m = this.me, fx = this.effects;
    if (this.lastFov !== S.fov) { cam.fov = S.fov; cam.updateProjectionMatrix(); this.lastFov = S.fov; }
    let yaw = m.yaw, pitch = m.pitch;
    this.focus = cam.position;
    if (m.alive) {
      const bob = S.bob && m.phase === 'play' && m.onGround ? Math.sin(t * (m.sprint ? 12 : 8.5) * 0.5) * 0.018 * clamp(m.speed / 5, 0, 1.4) : 0;
      cam.position.set(m.x, m.y + this._eyeHeight(m) + Math.abs(bob), m.z);
      this.vm.show(m.phase === 'play');
    } else {
      const tgt = this.spec.id !== null ? this.players.get(this.spec.id) : null;
      if (tgt && (tgt.s.fl & FLAGS.DEAD)) { this.spec.id = null; this._nextSpec(1); }
      const base = tgt && this.spec.id !== null ? { x: tgt.s.x, y: tgt.s.y + 1.5, z: tgt.s.z } : { x: (m.deathPos || m).x, y: (m.deathPos || m).y + 1.4, z: (m.deathPos || m).z };
      const cp = Math.cos(pitch), dx = Math.sin(yaw) * cp, dy = -Math.sin(pitch), dz = Math.cos(yaw) * cp, dist = 4.2;
      let cx = base.x + dx * dist, cy = base.y + dy * dist + 0.4, cz = base.z + dz * dist;
      cy = Math.max(cy, floorAt(cx, cz, cy) + 0.5);
      cam.position.set(cx, cy, cz); this.focus = base;
    }
    cam.rotation.set(pitch, yaw, 0);
    if (fx.shake > 0.001) { cam.rotation.x += (Math.random() - 0.5) * fx.shake * 0.05; cam.rotation.y += (Math.random() - 0.5) * fx.shake * 0.05; cam.rotation.z = (Math.random() - 0.5) * fx.shake * 0.06; }
    this.vm.update(dt, { speed: m.speed, sprint: m.sprint, crouch: m.crouch, charge: m.charge, raise: t < this.raiseUntil ? 1 : 0, air: !m.onGround }, t);
    $('under').classList.toggle('on', cam.position.y < 0.05);
  }

  _audioUpdate(dt, t) {
    const cam = this.camera, a = this.audio, m = this.me;
    const f = this.D.set(0, 0, -1).applyEuler(cam.rotation);
    a.setListener(cam.position, f, { x: 0, y: 1, z: 0 });
    if (t >= this.ambAt) {
      this.ambAt = t + 0.4;
      const x = cam.position.x, z = cam.position.z, h = heightAt(x, z);
      let sea = 0; for (let i = 0; i < 8; i++) { const an = i * Math.PI / 4; if (heightAt(x + Math.cos(an) * 45, z + Math.sin(an) * 45) < 0.3) sea++; }
      this.amb = { shore: clamp(sea / 6 + (h < 4 ? 0.7 : 0), 0, 1), forest: forestAt(x, z, h, slopeAt(x, z)), wind: 0.25 + clamp(h / 90, 0, 1) * 0.6, under: cam.position.y < 0.05 ? 1 : 0 };
    }
    if (this.amb) a.setAmbience(this.amb.shore, this.amb.forest, this.amb.wind, this.amb.under, dt);
    if (m.alive && m.hp <= 35 && t > this.hbAt) { this.hbAt = t + 0.9 + m.hp / 80; a.heartbeat(); }
  }

  _hudUpdate(dt, t) {
    const m = this.me, h = this.hud;
    h.setVitals(m.hp, m.stam);
    const left = this.tOff === null ? this.matchTime : this.matchTime - (t - this.tOff);
    h.setTimer(left);
    h.drawRadar(t, m.alive ? m.x : (m.deathPos || m).x, m.alive ? m.z : (m.deathPos || m).z, m.yaw);
    h.updateIndicators(t, m.x, m.z, m.yaw);
    if (t >= this.voiceAt) {
      this.voiceAt = t + 0.2;
      const list = [];
      if (this.voice.localSpeaking() && this.meInfo) list.push({ name: this.meInfo.name, color: this.meInfo.color });
      for (const p of this.players.values()) if (this.voice.speaking(p.id)) list.push({ name: p.name, color: p.color });
      h.setVoice(list); this._micHud();
      const getPos = (id) => { const p = this.players.get(id); return p ? { x: p.s.x, y: p.s.y + 1.6, z: p.s.z } : null; };
      this.voice.update(getPos, S.voiceMode === 'prox');
    }
    if (this.tab) {
      const rows = [...this.players.values()].map((p) => ({ name: p.name, color: p.color, chips: p.chips, alive: !(p.s.fl & FLAGS.DEAD), talking: this.voice.speaking(p.id), me: false }));
      if (this.meInfo) rows.push({ name: this.meInfo.name, color: this.meInfo.color, chips: m.chips, alive: m.alive, talking: this.voice.localSpeaking(), me: true });
      rows.sort((a, b) => b.chips - a.chips || (b.alive - a.alive));
      h.scoreboard(true, rows);
    }
  }

  _send(t) {
    const m = this.me;
    if (!m.alive || this.ended || t < this.sendAt) return;
    this.sendAt = t + 0.05;
    this.net.send({ t: 'st', x: r2(m.x), y: r2(m.y), z: r2(m.z), yaw: r2(m.yaw), pitch: r2(m.pitch), fl: m.fl });
  }
}
