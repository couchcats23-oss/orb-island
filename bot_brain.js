// Competitive bots for practice matches. A bot is a normal server-side Player driven by a Brain:
// it moves with the same physics as a human, and it only knows what a human could know
// (what it can see, hear, what its chip radar returns, and the warnings it receives when somebody scans it).
//   bot_brain.js   : lifecycle, perception, message handling      bot_think.js : decisions, goals, movement
//   bot_combat.js  : target choice, orb tactics, dodging, traps    bot_nav.js / bot_aim.js : physics + ballistics
import { RULES, FLAGS } from './public/js/rules.js';
import { heightAt, floorAt, slopeAt, queryColliders } from './public/js/terrain.js';
import { Body, los } from './bot_nav.js';
import { angDiff, rnd } from './bot_util.js';
import { thinkMethods } from './bot_think.js';
import { combatMethods } from './bot_combat.js';

export const LEVELS = {
  //          reaction  aim error  sight  think  dodge  special-orb use  scan eagerness  hearing
  easy:   { react: 0.9,  aim: 0.11,  vis: 40, think: 0.45, dodge: 0.35, specials: 0.35, scan: 0.6, hearing: 0.7 },
  normal: { react: 0.5,  aim: 0.055, vis: 55, think: 0.30, dodge: 0.65, specials: 0.75, scan: 1.0, hearing: 1.0 },
  hard:   { react: 0.25, aim: 0.025, vis: 70, think: 0.20, dodge: 0.92, specials: 1.0,  scan: 1.25, hearing: 1.25 },
};
// Different play styles so no two bots feel the same.
export const PERSONAS = {
  hunter:    { scan: 8,  hide: 0.10, aggro: 1.00, loot: 0.9, trap: 0.3, say: 'Hunting.' },
  ambusher:  { scan: 30, hide: 0.85, aggro: 0.35, loot: 1.0, trap: 1.0, say: 'Shh.' },
  scavenger: { scan: 18, hide: 0.30, aggro: 0.55, loot: 1.5, trap: 0.5, say: 'Mine.' },
  flanker:   { scan: 12, hide: 0.20, aggro: 0.85, loot: 1.0, trap: 0.6, say: 'Behind you.' },
};
export const BOT_NAMES = ['Kuro', 'Vega', 'Nyx', 'Mako', 'Echo', 'Saber', 'Wraith', 'Ember', 'Cinder', 'Raven', 'Onyx', 'Drift', 'Pike', 'Sable', 'Halo', 'Rook'];
const TAU = Math.PI * 2;
const SAY = { kill: ['gg', 'nice try', 'one down', 'too slow', 'got you'], scanned: ['who is scanning?', 'I see you', 'found you'], close: ['that was close!', 'ouch'] };

export class Brain {
  constructor(player, lobby, level, persona) {
    this.pl = player; this.lobby = lobby;
    this.levelName = LEVELS[level] ? level : 'normal'; this.cfg = LEVELS[this.levelName];
    this.personaName = PERSONAS[persona] ? persona : 'hunter'; this.per = PERSONAS[this.personaName];
    this.me = { x: 0, y: 0, z: 0, fl: 0 }; this.body = null; this.yaw = 0; this.pitch = 0;
    this.visited = new Map();
    this.reset();
  }

  reset() {
    this.know = new Map(); this.contacts = []; this.vis = []; this.zones = []; this.blasts = []; this.noticed = new Map();
    this.state = 'drop'; this.stateT = 0; this.goal = null; this.goalKind = '';
    this.nextThink = 0; this.nextScan = 0; this.nextFire = 0; this.lastSuppress = -99; this.lastTrap = -99; this.lastSay = -99;
    this.phase = 'expose'; this.phaseUntil = 0; this.throwsInPhase = 0; this.strafeT = 0; this.side = 1;
    this.target = null; this.aimAt = null; this.coverPos = null; this.hideUntil = 0; this.hideCool = 0; this.trapDir = null;
    this.steerDir = [0, 0]; this.steerAt = 0; this.evadeDir = null; this.evadeUntil = 0; this.hp = RULES.hp;
    this.fightAt = null; this.pingedAt = -99; this.hitAt = -99; this.landedAt = 0; this.dropTarget = null; this.scanSweep = 0;
    this.visited.clear();
  }

  // Called by the lobby when the match starts (Player already has spawn position + loadout).
  begin() {
    const p = this.pl; this.reset();
    this.me = { x: p.x, y: p.y, z: p.z, fl: 0 };
    this.body = new Body(this.me, this.lobby);
    this.yaw = Math.atan2(p.x, p.z); this.pitch = -0.3;
    this.pickDrop();
  }

  say(kind, chance) {
    const t = this.lobby.t;
    if (Math.random() > chance || t - this.lastSay < 20) return;
    this.lastSay = t;
    const list = SAY[kind]; const text = list[Math.floor(Math.random() * list.length)];
    setTimeout(() => { if (this.lobby.state === 'running') this.lobby.broadcast({ t: 'chat', id: this.pl.id, name: this.pl.name, text }); }, 600 + Math.random() * 1200);
  }

  // ---- drop -----------------------------------------------------------------
  pickDrop() {
    const me = this.me, L = this.lobby, reach = 78;
    let best = null, bs = -1e9;
    for (const pk of L.pickups.values()) {
      if (pk.k !== 'cache') continue;
      const d = Math.hypot(pk.x - me.x, pk.z - me.z);
      if (d > reach) continue;
      let s = (this.per.loot + this.per.aggro > 1.3 ? 1 : 0.35) * (reach - d) + rnd(0, 45);
      for (const q of L.players.values()) if (q.bot && q !== this.pl && q.bot.dropTarget && Math.hypot(q.bot.dropTarget.x - pk.x, q.bot.dropTarget.z - pk.z) < 25) s -= 60;
      if (s > bs) { bs = s; best = { x: pk.x, z: pk.z }; }
    }
    if (!best || this.personaName === 'ambusher' && Math.random() < 0.6) {
      for (let i = 0; i < 30 && !(best && best.free); i++) {
        const a = Math.random() * TAU, r = rnd(30, 75), x = me.x + Math.cos(a) * r, z = me.z + Math.sin(a) * r;
        if (heightAt(x, z) > 3 && slopeAt(x, z) < 0.5) best = { x, z, free: true };
      }
    }
    this.dropTarget = best || { x: me.x * 0.7, z: me.z * 0.7 };
  }

  dropTick(dt) {
    const me = this.me, g = this.dropTarget;
    let wx = g.x - me.x, wz = g.z - me.z; const d = Math.hypot(wx, wz);
    if (d > 2) { wx /= d; wz /= d; } else wx = wz = 0;
    this.body.glide(dt, wx, wz);
    if (d > 1) this.yaw = Math.atan2(-wx, -wz);
    if (!this.body.dropping) { this.state = 'roam'; this.stateT = this.lobby.t; this.landedAt = this.lobby.t; this.nextThink = 0; this.nextScan = this.lobby.t + rnd(6, 16) / this.cfg.scan * (this.per.scan / 14); this.pitch = 0; }
  }

  update(dt) {
    const p = this.pl, L = this.lobby;
    if (!p.alive || L.state !== 'running' || !this.body) return;
    if (this.body.dropping) { this.dropTick(dt); this.send(); return; }
    this.hp = p.hp;
    if (L.t >= this.nextThink) { this.nextThink = L.t + this.cfg.think * rnd(0.8, 1.25); this.think(); }
    this.act(dt);
    this.send();
  }

  send() { const me = this.me; this.lobby.onState(this.pl, { x: me.x, y: me.y, z: me.z, yaw: this.yaw, pitch: this.pitch, fl: me.fl }); }

  // ---- messages the server would send a human client -----------------------------------------
  onMsg(o) {
    const t = this.lobby.t;
    switch (o.t) {
      case 'sonar': if (!o.cancel && o.blips) for (const b of o.blips) this.addContact(b[0], b[1], 'sonar'); break;
      case 'pinged': this.addContact(o.x, o.z, 'ping'); this.pingedAt = t; this.onPinged(o.x, o.z); break;
      case 'hit': this.hitAt = t; this.blasts.push({ x: o.x, z: o.z, r: 9, until: t + 3 }); this.say('close', 0.08); break;
      case 'fix': this.me.x = o.x; this.me.y = o.y; this.me.z = o.z; break;
      default: break;
    }
  }

  onEv(o) {
    const L = this.lobby, t = L.t, me = this.me, id = this.pl.id;
    if (!this.body || this.body.dropping || !this.pl.alive) return;
    const d = Math.hypot((o.x ?? 1e9) - me.x, (o.z ?? 1e9) - me.z);
    if (o.k === 'throw' && o.id !== id && d < 85 * this.cfg.hearing) this.addContact(o.x + rnd(-6, 6), o.z + rnd(-6, 6), 'throw');
    else if (o.k === 'boom') {
      if (d < 170) this.blasts.push({ x: o.x, z: o.z, r: 6, until: t + 2.5 });
      if (o.by !== id && d < 130) this.fightAt = { x: o.x, z: o.z, t };
    } else if (o.k === 'death' && o.by === id && o.id !== id) this.say('kill', 0.3);
  }

  // ---- contacts: anonymous "somebody is around here" information --------------------------------
  addContact(x, z, src) {
    const t = this.lobby.t;
    (this.cstat = this.cstat || {})[src] = (this.cstat[src] || 0) + 1;
    for (const c of this.contacts) if (Math.hypot(c.x - x, c.z - z) < 10) { c.x = x; c.z = z; c.t = t; c.src = src; return; }
    this.contacts.push({ x, z, t, src });
    if (this.contacts.length > 10) this.contacts.shift();
  }
  fresh(maxAge) { const t = this.lobby.t; return this.contacts.filter((c) => t - c.t < maxAge); }

  // ---- sight and hearing ------------------------------------------------------------------------
  perceive() {
    const L = this.lobby, p = this.pl, me = this.me, t = L.t, cfg = this.cfg;
    const eye = me.y + ((me.fl & FLAGS.CROUCH) ? RULES.eyeCrouch : RULES.eye);
    this.vis.length = 0;
    for (const q of L.players.values()) {
      if (q === p || !q.alive || q.phase !== 'play') continue;
      const dx = q.x - me.x, dz = q.z - me.z, d = Math.hypot(dx, dz);
      let k = this.know.get(q.id);
      const still = t - q.lastMoving > 1.0, qc = (q.fl & FLAGS.CROUCH) !== 0;
      const range = cfg.vis * (qc ? 0.7 : 1) * (still ? 0.8 : 1);
      let seen = false;
      if (d < range) {
        const ang = Math.abs(angDiff(Math.atan2(-dx, -dz), this.yaw));
        if (d < 9 || ang < 1.2) seen = los(me.x, eye, me.z, q.x, q.y + (qc ? 1.0 : 1.55), q.z, L.deadTrees);
      }
      if (seen) {
        if (!k) { k = { id: q.id, x: q.x, y: q.y, z: q.z, vx: 0, vz: 0, t, firstSeen: t, vis: false, d }; this.know.set(q.id, k); }
        const dtk = t - k.t;
        if (k.vis && dtk > 0.01 && dtk < 0.8) { k.vx = k.vx * 0.5 + (q.x - k.x) / dtk * 0.5; k.vz = k.vz * 0.5 + (q.z - k.z) / dtk * 0.5; }
        else { if (!k.vis) k.firstSeen = t; k.vx = k.vz = 0; }
        k.x = q.x; k.y = q.y; k.z = q.z; k.t = t; k.vis = true; k.d = d; k.shield = t < q.shieldUntil; k.crouch = qc;
        this.vis.push(k);
      } else {
        if (k && k.vis) this.addContact(k.x + k.vx * 0.6, k.z + k.vz * 0.6, 'lost'); // just lost sight: remember where
        if (k) k.vis = false;
        if (t - q.lastMoving < 0.5) { // footsteps
          const hr = ((q.fl & FLAGS.SPRINT) ? 26 : qc ? 4 : 11) * cfg.hearing;
          if (d < hr) this.addContact(q.x + rnd(-5, 5), q.z + rnd(-5, 5), 'step');
        }
      }
    }
    this.vis.sort((a, b) => a.d - b.d);
    for (const k of this.vis) this.contacts = this.contacts.filter((c) => Math.hypot(c.x - k.x, c.z - k.z) > 14);
    for (const [id, k] of this.know) if (t - k.t > 45) this.know.delete(id);
    this.contacts = this.contacts.filter((c) => t - c.t < 60);
    this.blasts = this.blasts.filter((b) => b.until > t);
  }
}

Object.assign(Brain.prototype, thinkMethods, combatMethods);
