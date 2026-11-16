// Bot combat: choosing targets and orbs, aiming, peek-and-cover duels, dodging incoming orbs, traps, barrier use.
import { RULES, ORB, FLAGS } from './public/js/rules.js';
import { floorAt, queryColliders } from './public/js/terrain.js';
import { los } from './bot_nav.js';
import { solveThrow, predictLanding } from './bot_aim.js';
import { rnd, clampN } from './bot_util.js';

const col = [];

export const combatMethods = {
  eyeY() { const me = this.me; return me.y + ((me.fl & FLAGS.CROUCH) ? RULES.eyeCrouch : RULES.eye); },

  // ---- danger awareness -------------------------------------------------------------------------
  refreshZones() {
    const L = this.lobby, me = this.me, z = this.zones;
    z.length = 0;
    for (const c of L.clouds) if (Math.hypot(c.x - me.x, c.z - me.z) < 60) z.push({ x: c.x, z: c.z, r: c.r + 3, kind: 'gas', in: c.r + 0.8 });
    for (const f of L.fires) {
      const len = Math.min(1, f.age / 0.6) * ORB.flame.len;
      if (Math.hypot(f.x - me.x, f.z - me.z) > len + 30) continue;
      for (let s = 0; s <= len; s += 3) z.push({ x: f.x + f.ax * s, z: f.z + f.az * s, r: 3, kind: 'fire', in: 2.6 });
    }
    for (const o of L.orbs.values()) {
      const def = ORB[o.type];
      if (!def.blast || (o.st === 0 && o.type !== 'homing')) continue;
      const d = Math.hypot(o.x - me.x, o.z - me.z); if (d > 40) continue;
      if (o.owner === this.pl.id) { if (o.type === 'remote') z.push({ x: o.x, z: o.z, r: def.blast + 1, kind: 'own' }); continue; }
      if (d < 24 && (o.type === 'remote' || o.type === 'implosion' || o.type === 'timer')) z.push({ x: o.x, z: o.z, r: def.blast + 1.5, kind: 'orb' });
    }
    for (const b of this.blasts) z.push({ x: b.x, z: b.z, r: b.r, kind: 'blast' });
  },

  // Look for orbs/clouds/fire that are about to hurt us. Returns the most urgent threat (or null).
  scanOrbs() {
    const L = this.lobby, t = L.t, me = this.me, p = this.pl, cfg = this.cfg;
    const shielded = t < p.shieldUntil;
    let worst = null, wt = 1e9;
    for (const o of L.orbs.values()) {
      if (o.owner === p.id && o.type !== 'timer' && o.type !== 'implosion') continue;
      const d = Math.hypot(o.x - me.x, o.z - me.z); if (d > 45) continue;
      let n = this.noticed.get(o.id);
      if (n === undefined) { n = Math.random() < cfg.dodge; this.noticed.set(o.id, n); }
      if (!n || o.age < cfg.react * 0.5) continue;
      const def = ORB[o.type]; let ix = o.x, iz = o.z, tl = 99, R;
      if (o.type === 'homing') { if (o.st === 3 && d < 25) { tl = d / 10; R = 7; } else continue; }
      else if (o.st === 0) {
        const l = predictLanding(o); ix = l.x; iz = l.z; tl = l.t;
        if (o.type === 'timer') tl = Math.min(tl, o.fuse - o.age);
        R = def.blast ? def.blast + 2 : def.r ? def.r + 3 : (def.len || 14) + 2;
      } else if (o.type === 'timer') { tl = o.fuse - o.age; R = def.blast + 2; }
      else if (o.type === 'implosion') { tl = o.stuckAt + def.delay + def.suck - o.age; R = def.blast + 3; }
      else continue;
      if (Math.hypot(ix - me.x, iz - me.z) > R) continue;
      if (tl < wt) { wt = tl; worst = { x: ix, z: iz, r: R, tl, type: o.type }; }
    }
    if (this.noticed.size > 300) this.noticed.clear();
    if (!worst) { // standing in gas or on a fire line? get out
      for (const q of this.zones) if ((q.kind === 'gas' || q.kind === 'fire') && Math.hypot(q.x - me.x, q.z - me.z) < q.in) { worst = { x: q.x, z: q.z, r: q.r + 3, tl: 0, type: q.kind }; break; }
    }
    if (!worst) return null;
    const blast = ORB[worst.type] && ORB[worst.type].blast;
    if (!shielded && blast && worst.tl < 0.9 && Math.hypot(worst.x - me.x, worst.z - me.z) < blast && this.has('barrier') >= 0 && Math.random() < cfg.dodge + 0.1) this.useBarrier();
    this.evadeDir = worst; this.evadeUntil = t + 0.6;
    return worst;
  },

  evadeMove() {
    const me = this.me, e = this.evadeDir;
    if (!e) return [0, 0];
    const dx = me.x - e.x, dz = me.z - e.z, d = Math.hypot(dx, dz) || 1;
    return this.goMove(e.x + dx / d * (e.r + 6), e.z + dz / d * (e.r + 6));
  },

  useBarrier() {
    const slot = this.has('barrier');
    if (slot < 0 || this.lobby.t < this.pl.shieldUntil) return false;
    this.lobby.onThrow(this.pl, { slot, d: [0, 0, 1], pw: 0 });
    return this.lobby.t < this.pl.shieldUntil;
  },

  // ---- targets & orb choice -----------------------------------------------------------------------
  pickTarget() {
    let best = null, bs = 1e9;
    for (const k of this.vis) { const s = k.d + (k.shield ? 15 : 0); if (s < bs) { bs = s; best = k; } }
    return best;
  },

  prefDist() { return { hunter: 22, ambusher: 32, scavenger: 28, flanker: 18 }[this.personaName] || 24; },

  chooseOrb(k, opts) {
    const p = this.pl, d = k.d, sp = this.cfg.specials, inv = {};
    p.loadout.forEach((ty, i) => { if (ty && ty !== 'barrier' && ty !== 'remote' && inv[ty] === undefined) inv[ty] = i; });
    const list = [], still = Math.hypot(k.vx || 0, k.vz || 0) < 0.6;
    const add = (ty, score, extra) => { if (inv[ty] !== undefined && score > 0) list.push({ type: ty, slot: inv[ty], score: score * rnd(0.75, 1.25), ...extra }); };
    if (d >= 10 && d <= 56) add('cracker', 1.0, { y: 1.2, tol: 2.9, pws: [1, 0.8, 0.6] });
    if (d >= 10 && d <= 48) add('timer', 0.8 * sp, { y: 1.5, tol: 4, pws: [0.9, 0.7, 0.5] });
    if (d >= 9 && d <= 30) add('implosion', 1.25 * sp, { y: 0.1, tol: 3.5, pws: [0.8, 0.6, 0.4] });
    if (d >= 14 && d <= 42) add('homing', (k.vis ? 0.8 : 1.1) * sp, { y: 1.0, tol: 9, pws: [0.9, 0.7] });
    if (d >= 14 && d <= 34) add('flame', sp, { y: 0.1, tol: 4.5, pws: [0.9, 0.7, 0.5] });
    if (d >= 15 && d <= 40) add('gas', (opts.flush ? 1.6 : still ? 1.2 : 0.55) * sp, { y: 0.3, tol: 6, pws: [0.9, 0.7, 0.5] });
    if (!list.length) return null;
    list.sort((a, b) => b.score - a.score);
    return list[0];
  },

  // Aim (with target leading + noise), check the flight actually lands near the target, then throw.
  throwAt(k, opts) {
    const L = this.lobby, p = this.pl, me = this.me, t = L.t;
    const ch = this.chooseOrb(k, opts); if (!ch) return false;
    const shielded = t < p.shieldUntil, def = ORB[ch.type];
    const safe = shielded ? 2.5 : def.blast ? def.blast + 1.5 : def.r ? def.r + 3.5 : (def.len || 14) + 2;
    const lf = this.levelName === 'easy' ? 0.5 : this.levelName === 'hard' ? 1 : 0.8;
    const err = this.cfg.aim * k.d * 0.5, ey = this.eyeY();
    let tf = k.d / 20, best = null;
    for (let i = 0; i < 2; i++) {
      const lfe = lf * clampN(1.6 / Math.max(tf, 0.1), 0.35, 1);
      const ax = k.x + (k.vx || 0) * tf * lfe + (rnd(-1, 1) + rnd(-1, 1)) * err, az = k.z + (k.vz || 0) * tf * lfe + (rnd(-1, 1) + rnd(-1, 1)) * err;
      const sol = solveThrow(L, me.x, ey, me.z, ax, floorAt(k.x, k.z, 99) + ch.y, az, { self: me, minSafe: safe, pws: ch.pws, tol: ch.tol + (opts.tolBonus || 0) });
      if (!sol) break; best = sol; tf = sol.t;
    }
    if (!best || best.err > ch.tol + (opts.tolBonus || 0)) return false;
    // keep the last orbs for good shots
    if (this.ammo() <= 2 * (1 - this.nerve()) && !opts.flush && !(k.d < 28 && best.t < 1.6)) return false; // (not forever: nerve() grows in a stalemate)
    // a 4-5 s lob at somebody who is running is wasted ammo (they simply walk away): only area weapons are worth it
    if (best.t > 1.8 && !opts.flush && Math.hypot(k.vx || 0, k.vz || 0) > 1.5 && (ch.type === 'cracker' || ch.type === 'timer') && Math.random() > 0.25) return false;
    const fuse = ch.type === 'timer' ? clampN(Math.round((best.t + 0.2) * 10) / 10, 1, 10) : 0;
    if (process.env.BOT_DEBUG) console.log(`  ${p.name}(${this.levelName}) throws ${ch.type} at ${k.vis ? 'enemy' : 'contact'} d=${k.d.toFixed(0)} err=${best.err.toFixed(1)} flight=${best.t.toFixed(1)}s ${best.hit}`);
    L.onThrow(p, { slot: ch.slot, d: best.d, pw: best.pw, fuse });
    if (process.env.BOT_DEBUG && !p.loadout[ch.slot]) { let last = null; for (const o of L.orbs.values()) last = o; if (last) last.expect = { x: best.imp.x, z: best.imp.z, y: best.imp.y, t: best.imp.t, ox: me.x, oz: me.z }; }
    return !p.loadout[ch.slot];
  },

  fireTick() {
    const L = this.lobby, t = L.t, p = this.pl, k = this.target, hard = this.levelName === 'hard';
    if (!k || !k.vis || this.phase !== 'expose' || t < this.nextFire || t < p.throwReady) return;
    if (t - k.firstSeen < this.cfg.react) return;
    const shielded = t < p.shieldUntil;
    if (!shielded && this.has('barrier') >= 0 && ((this.hp < 50 && k.d < 36) || (hard && k.d < 22 && Math.random() < 0.02)) && Math.random() < this.cfg.dodge) { if (this.useBarrier()) return; }
    if (k.d > (hard ? 62 : 52)) { this.nextFire = t + 0.5; return; }
    const ok = this.throwAt(k, {});
    this.nextFire = t + (ok ? (Math.random() < 0.35 && this.levelName !== 'easy' ? rnd(0.5, 0.8) : rnd(0.9, 1.6)) : 0.35) * (hard ? 0.8 : this.levelName === 'easy' ? 1.4 : 1);
    if (ok) { this.throwsInPhase++; this.misses = 0; }
    else if ((this.misses = (this.misses || 0) + 1) >= 4) { this.misses = 0; this.phaseUntil = t; } // no clean shot from here: change position
  },

  // ---- duel movement: strafe in the open, duck behind cover between throws ----------------------
  duelMove(dt) {
    const me = this.me, t = this.lobby.t, k = this.target, p = this.pl, out = { wx: 0, wz: 0, mode: 'walk' };
    if (!k) return out;
    const dx = k.x - me.x, dz = k.z - me.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    if (this.phase === 'expose' && (t > this.phaseUntil || this.throwsInPhase >= 2 || this.ammo() === 0)) {
      this.phase = 'cover'; this.phaseUntil = t + rnd(1.2, 2.6) * (this.levelName === 'hard' ? 0.8 : 1.2); this.coverPos = this.findCover(k);
    } else if (this.phase === 'cover' && t > this.phaseUntil) {
      this.phase = 'expose'; this.phaseUntil = t + rnd(2.5, 4.5); this.throwsInPhase = 0; this.coverPos = null;
    }
    if (this.phase === 'cover') {
      const c = this.coverPos;
      if (c && Math.hypot(c.x - me.x, c.z - me.z) > 1.2) { const m = this.goMove(c.x, c.z); out.wx = m[0]; out.wz = m[1]; out.mode = 'sprint'; }
      else out.mode = 'crouch';
      return out;
    }
    if (d < 9 && !(t < p.shieldUntil)) { // too close for our own blast: shield up or back off
      if (this.levelName !== 'easy') this.useBarrier();
      const m = this.goMove(me.x - ux * 20, me.z - uz * 20); out.wx = m[0]; out.wz = m[1]; out.mode = 'sprint'; return out;
    }
    this.strafeT -= dt; if (this.strafeT <= 0) { this.side = -this.side; this.strafeT = rnd(0.6, 1.5); }
    const pref = this.prefDist(), radial = d > pref + 6 ? 1 : d < pref - 6 ? -1 : 0;
    let wx = -uz * this.side * 0.9 + ux * radial * 0.8, wz = ux * this.side * 0.9 + uz * radial * 0.8;
    const l = Math.hypot(wx, wz) || 1; wx /= l; wz /= l;
    const m = this.goMove(me.x + wx * 6, me.z + wz * 6); out.wx = m[0]; out.wz = m[1]; out.mode = d > 50 ? 'sprint' : 'walk';
    return out;
  },

  // Stand on the far side of a tree/rock from the enemy.
  findCover(k) {
    const me = this.me, L = this.lobby, cands = [];
    queryColliders(me.x, me.z, 15, col, L.deadTrees);
    for (const c of col) {
      if (c.k !== 0 || c.r < 0.3) continue;
      const dx = c.x - k.x, dz = c.z - k.z, dd = Math.hypot(dx, dz) || 1;
      const sx = c.x + dx / dd * (c.r + 0.9), sz = c.z + dz / dd * (c.r + 0.9);
      if (floorAt(sx, sz, 99) < 0.2) continue;
      cands.push({ x: sx, z: sz, d: Math.hypot(sx - me.x, sz - me.z) });
    }
    cands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(6, cands.length); i++) {
      const c = cands[i], y = floorAt(c.x, c.z, 99);
      if (!los(k.x, k.y + 1.5, k.z, c.x, y + 1.2, c.z, L.deadTrees)) return c;
    }
    const dx = me.x - k.x, dz = me.z - k.z, d = Math.hypot(dx, dz) || 1;
    return this.landNear(me.x + dx / d * 16, me.z + dz / d * 16);
  },

  // ---- area denial: lob something at where we think somebody is hiding ------------------------------
  suppressTick() {
    const L = this.lobby, t = L.t, me = this.me, g = this.goal, c = g && g.contact;
    if (!c || t - this.lastSuppress < 6 || this.ammo() < 3 || t < this.pl.throwReady || t - c.t > 10 || c.src === 'fight' || c.src === 'rumor') return;
    const d = Math.hypot(c.x - me.x, c.z - me.z); if (d < 16 || d > 44) return;
    if (Math.random() > 0.3 + 0.4 * this.cfg.specials * this.per.aggro) return;
    this.lastSuppress = t;
    this.throwAt({ x: c.x, z: c.z, y: floorAt(c.x, c.z, 99), d, vx: 0, vz: 0, vis: false }, { flush: true, tolBonus: 3 });
  },

  // ---- remote traps ------------------------------------------------------------------------------------
  trapTick() {
    const L = this.lobby, t = L.t, me = this.me, p = this.pl, slot = this.has('remote');
    if (slot < 0 || t - this.lastTrap < 25 || p.remotes.length >= 2 || t < p.throwReady) return;
    this.lastTrap = t - (Math.random() < this.per.trap * 0.5 ? 0 : 15);
    if (this.lastTrap === t - 15) return;
    const c = this.fresh(40)[0];
    let dir = c ? { x: c.x - me.x, z: c.z - me.z } : this.trapDir || { x: -me.x, z: -me.z };
    const dl = Math.hypot(dir.x, dir.z) || 1, dist = rnd(11, 15), tx = me.x + dir.x / dl * dist, tz = me.z + dir.z / dl * dist;
    const sol = solveThrow(L, me.x, this.eyeY(), me.z, tx, floorAt(tx, tz, 99) + 0.1, tz, { self: me, minSafe: 10, arc: 'low', pws: [0.5, 0.35, 0.7] });
    if (!sol || sol.err > 3) { this.lastTrap = t - 15; return; }
    L.onThrow(p, { slot, d: sol.d, pw: sol.pw, fuse: 0 });
    this.lastTrap = t;
  },

  // Blow our remote orbs when an enemy steps next to one (and we are not standing next to it).
  detonateTick() {
    const L = this.lobby, p = this.pl, me = this.me;
    if (!p.remotes.length) return;
    const shielded = L.t < p.shieldUntil, mine = [];
    for (const id of p.remotes) { const o = L.orbs.get(id); if (o) mine.push(o); }
    if (!shielded) for (const o of mine) if (Math.hypot(o.x - me.x, o.z - me.z) < 9.5) return;
    const R = this.levelName === 'hard' ? 4.5 : 4;
    for (const o of mine) {
      if (o.st !== 1) continue;
      for (const q of L.players.values()) {
        if (q === p || !q.alive || q.phase !== 'play') continue;
        if (Math.hypot(q.x - o.x, q.y + 0.9 - o.y, q.z - o.z) < R) { L.onDetonate(p, { all: p.remotes[0] !== o.id }); return; }
      }
    }
  },
};
