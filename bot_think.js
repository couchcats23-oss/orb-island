// Bot decision making: what to do next (state machine), where to go, when to scan, and how to move there.
import { RULES } from './public/js/rules.js';
import { heightAt, floorAt, slopeAt, getPOIs, queryColliders } from './public/js/terrain.js';
import { angDiff, rnd, clampN, yawTo } from './bot_util.js';

const col = [];
const TAU = Math.PI * 2;

export const thinkMethods = {
  ammo() { let n = 0; for (const s of this.pl.loadout) if (s && s !== 'barrier') n++; return n; },
  has(type) { return this.pl.loadout.indexOf(type); },
  aliveCount() { let n = 0; for (const q of this.lobby.players.values()) if (q.alive) n++; return n; },
  bored() { return clampN((this.lobby.t - (this.lastAction || 0) - ({ easy: 90, normal: 60, hard: 45 }[this.levelName] || 60)) / 60, 0, 1); },

  // Nothing has happened for a while: pick up a vague hint about where somebody is (distant footsteps, rumours of movement)
  // so matches on a big island do not drag. Deliberately imprecise.
  rumorTick() {
    const L = this.lobby, t = L.t, me = this.me;
    if (this.bored() <= 0 || t < (this.nextRumor || 0)) return;
    this.nextRumor = t + rnd(12, 22) / (0.5 + this.cfg.scan * 0.5);
    if (this.personaName === 'ambusher' && Math.random() < 0.6) return;
    let best = null, bd = 1e9;
    for (const q of L.players.values()) {
      if (q === this.pl || !q.alive || q.phase !== 'play') continue;
      const d = Math.hypot(q.x - me.x, q.z - me.z);
      if (d > 60 && d < bd) { bd = d; best = q; }
    }
    if (best) this.addContact(best.x + rnd(-45, 45), best.z + rnd(-45, 45), 'rumor');
  },
  // How badly the bot wants a fight: grows with match time, with few survivors, and while nobody has died for a long while
  // (so a quiet match, or one where everybody is wounded, still ends in a showdown).
  urgency() {
    const t = this.lobby.t, quiet = t - Math.max(this.lobby.lastDeathT || 0, 60);
    return Math.min(1.6, clampN((t - 150) / 300, 0, 1) + (this.aliveCount() <= 4 ? 0.4 : 0) + clampN((quiet - 100) / 150, 0, 1) * 0.5);
  },
  // Wounded bots are cautious, but nothing heals in this game: the longer it stays quiet the less that caution counts.
  nerve() { return Math.max(this.bored(), clampN(this.urgency() - 0.3, 0, 1)); },

  // ---- main decision --------------------------------------------------------------------------
  think() {
    const L = this.lobby, t = L.t, p = this.pl;
    this.perceive(); this.refreshZones();
    const threat = this.scanOrbs();
    this.detonateTick(); this.rumorTick();
    const tgt = this.pickTarget();
    this.target = tgt;
    const hpLow = p.hp < 38 && this.nerve() < 0.6, ammo = this.ammo(), armed = ammo > 0 || this.has('barrier') >= 0;
    const prev = this.state;
    if (threat || tgt) this.lastAction = t;
    let st;
    if (threat || t < this.evadeUntil) st = 'evade';
    else if (tgt && armed && (!hpLow || tgt.d < 22 || (this.per.aggro > 0.9 && tgt.d < 35))) st = 'duel';
    else if (tgt) st = 'flee';
    else if (this.pickupGoal()) st = 'grab';
    else if (ammo <= (this.per.loot > 1.2 ? 4 : 3) && this.cacheGoal()) st = 'loot';
    else if (this.huntGoal()) st = 'hunt';
    else st = this.idleState();
    if (st !== prev) this.enter(st);
    if (this.goal) { // give up on goals we cannot reach
      const key = this.goalKind + Math.round(this.goal.x / 12) + ',' + Math.round(this.goal.z / 12);
      if (key !== this.goalKey) { this.goalKey = key; this.goalSince = t; }
      else if (t - this.goalSince > 40 && (this.goalKind === 'roam' || this.goalKind === 'hunt' || this.goalKind === 'loot')) { this.goal = null; this.contacts = []; this.goalKey = ''; this.state = 'roam'; }
    }
    if (this.canScan(st)) this.doScan();
    if (st === 'hunt') this.suppressTick();
    if (st === 'ambush' || st === 'roam') this.trapTick();
  },

  enter(st) {
    const t = this.lobby.t, me = this.me;
    (this.sstat = this.sstat || {})[st] = (this.sstat[st] || 0) + 1;
    this.state = st; this.stateT = t;
    if (st === 'duel') { this.phase = 'expose'; this.phaseUntil = t + rnd(2.5, 4.5); this.throwsInPhase = 0; this.coverPos = null; this.strafeT = 0; }
    else if (st === 'flee' && this.target) {
      const k = this.target, dx = me.x - k.x, dz = me.z - k.z, d = Math.hypot(dx, dz) || 1;
      this.goal = this.landNear(me.x + dx / d * 45 + rnd(-12, 12), me.z + dz / d * 45 + rnd(-12, 12)) || { x: me.x + dx / d * 30, z: me.z + dz / d * 30 };
      this.goalKind = 'flee';
    }
  },

  // ---- goals ----------------------------------------------------------------------------------
  landNear(x, z) {
    for (let i = 0; i < 8; i++) {
      const px = x + (i ? rnd(-14, 14) : 0), pz = z + (i ? rnd(-14, 14) : 0);
      if (floorAt(px, pz, 99) > 1.2 && slopeAt(px, pz) < 0.7) return { x: px, z: pz };
    }
    return null;
  },

  pickupGoal() {
    const L = this.lobby, me = this.me, wantOrbs = this.ammo() < 8;
    let best = null, bd = 1e9;
    for (const pk of L.pickups.values()) {
      if (!pk.active || pk.k === 'cache' || (pk.k === 'orbs' && !wantOrbs)) continue;
      const d = Math.hypot(pk.x - me.x, pk.z - me.z);
      if (d > (pk.k === 'chip' ? 90 : 55) || d >= bd || floorAt(pk.x, pk.z, 99) < -0.8) continue;
      bd = d; best = pk;
    }
    if (!best) return false;
    this.goal = { x: best.x, z: best.z }; this.goalKind = 'grab';
    return true;
  },

  cacheGoal() {
    const L = this.lobby, me = this.me;
    let best = null, bd = 450;
    for (const pk of L.pickups.values()) {
      if (!pk.active || pk.k !== 'cache') continue;
      const d = Math.hypot(pk.x - me.x, pk.z - me.z);
      if (d < bd) { bd = d; best = pk; }
    }
    if (!best) return false;
    this.goal = { x: best.x, z: best.z }; this.goalKind = 'loot';
    return true;
  },

  huntGoal() {
    const t = this.lobby.t, me = this.me, u = this.urgency();
    if (t < this.hideUntil && this.state === 'ambush' && (this.per.hide > 0.6 || this.hp < 45)) return false;
    if (this.hp < 40 && this.per.aggro < 0.9 && this.nerve() < 0.5) return false;
    const maxAge = 22 + 25 * u + (this.per.aggro > 0.8 ? 8 : 0) + 20 * this.bored();
    let best = null, bs = 1e9;
    for (const c of this.contacts) {
      const a = t - c.t; if (a > maxAge) continue;
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (this.per.aggro < 0.5 && d > 120 && u < 0.5) continue;
      const s = a * 1.5 + d * 0.12 - (c.src === 'sonar' ? 4 : 0);
      if (s < bs) { bs = s; best = c; }
    }
    if (!best && this.fightAt && t - this.fightAt.t < 15 && this.per.aggro > 0.6 && this.hp > 50) {
      const d = Math.hypot(this.fightAt.x - me.x, this.fightAt.z - me.z);
      if (d > 30 && d < 200) best = { x: this.fightAt.x + rnd(-10, 10), z: this.fightAt.z + rnd(-10, 10), t: this.fightAt.t, src: 'fight' };
    }
    if (!best) return false;
    let gx = best.x, gz = best.z;
    if (this.personaName === 'flanker' && best.src === 'ping') { // come in from the side
      const dx = gx - me.x, dz = gz - me.z, d = Math.hypot(dx, dz) || 1, s = this.side;
      gx += -dz / d * 24 * s; gz += dx / d * 24 * s;
    }
    this.goal = { x: gx, z: gz, contact: best }; this.goalKind = 'hunt';
    return true;
  },

  idleState() {
    const t = this.lobby.t, me = this.me;
    if (this.state === 'ambush' && t < this.hideUntil) return 'ambush';
    if (this.state === 'ambush') this.hideCool = t + rnd(18, 35);
    const wounded = this.hp < 45;
    const arrived = !this.goal || this.goalKind !== 'roam' || Math.hypot(this.goal.x - me.x, this.goal.z - me.z) < 5;
    if (this.state === 'roam' && !arrived) return 'roam';
    if (this.goal && this.goalKind === 'roam' && arrived) this.markVisited();
    if (t > this.hideCool && (wounded ? Math.random() < 0.8 * (1 - 0.8 * this.nerve()) : Math.random() < this.per.hide * 0.35 * (1 - this.bored()))) { this.startHide(wounded ? 20 : rnd(8, 16)); return 'ambush'; }
    this.pickRoam();
    return 'roam';
  },

  markVisited() { const me = this.me; for (const poi of getPOIs()) if (Math.hypot(poi.x - me.x, poi.z - me.z) < 32) this.visited.set(poi.id, this.lobby.t); },

  pickRoam() {
    const me = this.me, t = this.lobby.t, late = t > 150 || this.aliveCount() <= 5;
    const cand = [];
    for (const poi of getPOIs()) {
      const d = Math.hypot(poi.x - me.x, poi.z - me.z);
      if (d < 30 || d > 650) continue;
      cand.push({ x: poi.x + rnd(-9, 9), z: poi.z + rnd(-9, 9), w: (1 / (1 + d / 160)) * (this.visited.has(poi.id) ? 0.25 : 1) });
    }
    for (let i = 0; i < 4; i++) { const a = Math.random() * TAU, r = rnd(60, 480); cand.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, w: 0.15 }); }
    cand.push({ x: rnd(-150, 150), z: rnd(-150, 150), w: (late ? 1.2 : 0.35) + 2 * this.bored() }); // the middle of the island is where paths cross
    let sum = 0; for (const c of cand) sum += c.w;
    let g = null;
    for (let tries = 0; tries < 6 && !g; tries++) {
      let r = Math.random() * sum, pick = cand[0];
      for (const c of cand) { r -= c.w; if (r <= 0) { pick = c; break; } }
      g = this.landNear(pick.x, pick.z);
    }
    this.goal = g || { x: me.x + rnd(-40, 40), z: me.z + rnd(-40, 40) }; this.goalKind = 'roam';
  },

  startHide(seconds) {
    const t = this.lobby.t, me = this.me;
    this.hideUntil = t + seconds;
    let best = { x: me.x, z: me.z }, bs = -1e9;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * TAU, r = i ? rnd(6, 35) : 0, x = me.x + Math.cos(a) * r, z = me.z + Math.sin(a) * r;
      const g = floorAt(x, z, 99); if (g < 1.5 || slopeAt(x, z) > 0.6) continue;
      queryColliders(x, z, 7, col, this.lobby.deadTrees);
      let n = 0; for (const c of col) if (c.k === 0) n++;
      const s = n * 1.0 - r * 0.05; if (s > bs) { bs = s; best = { x, z }; }
    }
    this.goal = best; this.goalKind = 'hide'; this.hideSpot = best;
  },

  // ---- chip radar -------------------------------------------------------------------------------
  canScan(st) {
    const t = this.lobby.t;
    if (t < this.nextScan || t < this.pl.sonarReady) return false;
    if (st === 'duel' || st === 'evade' || st === 'flee' || st === 'grab') return false;
    if (this.fresh(8).length) return false;
    if (this.per.hide > 0.6 && st !== 'ambush' && st !== 'roam') return false;
    return true;
  },

  doScan() {
    const t = this.lobby.t, me = this.me;
    this.lobby.onSonar(this.pl); this.scans = (this.scans || 0) + 1;
    this.nextScan = t + (this.per.scan / this.cfg.scan) * (1 - 0.5 * clampN(this.urgency(), 0, 1)) * (1 - 0.4 * this.bored()) * rnd(0.8, 1.35);
    if (this.state === 'roam') { // a scan reveals us: slip away from this spot
      const a = Math.random() * TAU, r = rnd(28, 45), g = this.landNear(me.x + Math.cos(a) * r, me.z + Math.sin(a) * r);
      if (g) { this.goal = g; this.goalKind = 'roam'; }
    }
  },

  onPinged(x, z) {
    const t = this.lobby.t;
    this.say('scanned', 0.1);
    if (!this.pl.alive || !this.body || this.body.dropping || this.state === 'duel' || this.state === 'evade') return;
    if (this.per.hide > 0.6 || this.hp < 45) { // somebody scanned us: dig in and wait for them to come
      this.trapDir = { x: x - this.me.x, z: z - this.me.z };
      this.startHide(rnd(10, 18)); this.state = 'ambush'; this.stateT = t;
    }
  },

  // ---- moving ---------------------------------------------------------------------------------
  goMove(gx, gz) {
    const t = this.lobby.t;
    if (t >= this.steerAt) { this.steerDir = this.body.steer(gx, gz, this.zones); this.steerAt = t + 0.12; }
    return this.steerDir;
  },

  act(dt) {
    const me = this.me, t = this.lobby.t, st = this.state;
    let wx = 0, wz = 0, mode = 'walk', face = null;
    if (this.pl.remotes.length) this.detonateTick(); // traps are checked every tick, not just when thinking
    if (st === 'evade') { const m = this.evadeMove(); wx = m[0]; wz = m[1]; mode = 'sprint'; }
    else if (st === 'duel') { const m = this.duelMove(dt); wx = m.wx; wz = m.wz; mode = m.mode; face = this.target; }
    else if (st === 'ambush') {
      const g = this.hideSpot;
      if (g && Math.hypot(g.x - me.x, g.z - me.z) > 2.5) { const m = this.goMove(g.x, g.z); wx = m[0]; wz = m[1]; mode = 'walk'; }
      else { mode = 'crouch'; this.scanSweep += dt * 0.6; }
    } else if (this.goal) {
      const g = this.goal, d = Math.hypot(g.x - me.x, g.z - me.z);
      if (d > (this.goalKind === 'grab' || this.goalKind === 'loot' ? 0.9 : 2)) {
        const m = this.goMove(g.x, g.z); wx = m[0]; wz = m[1];
        const near = this.fresh(20).some((c) => Math.hypot(c.x - me.x, c.z - me.z) < 70);
        if (st === 'flee') mode = 'sprint';
        else if (d > 30 && !near && !(st === 'hunt' && d < 55)) mode = 'sprint';
        else if (st === 'hunt' && d < 18 && g.contact && t - g.contact.t > 4) mode = 'crouch';
        if (st === 'hunt' && d < 8 && !this.vis.length) this.contacts = this.contacts.filter((c) => c !== g.contact); // searched here: nobody
      }
    }
    this.body.walk(dt, wx, wz, mode);
    // facing
    let want = this.yaw, rate = this.levelName === 'easy' ? 4 : 7;
    if (face) { want = yawTo(face.x - me.x, face.z - me.z); rate = 11; }
    else if (st === 'ambush' && !(wx || wz)) want = (this.trapDir ? yawTo(this.trapDir.x, this.trapDir.z) : this.yaw) + Math.sin(this.scanSweep) * 1.3;
    else if (this.body.speed > 0.5) want = yawTo(this.body.vx, this.body.vz);
    this.yaw += clampN(angDiff(want, this.yaw), -rate * dt, rate * dt);
    if (this.yaw > Math.PI) this.yaw -= TAU; else if (this.yaw < -Math.PI) this.yaw += TAU;
    let wp = 0;
    if (face) { const d = Math.hypot(face.x - me.x, face.z - me.z) || 1; wp = clampN(Math.atan2((face.y || 0) + 1.2 - (me.y + RULES.eye), d), -0.6, 0.6); }
    this.pitch += (wp - this.pitch) * Math.min(1, dt * 8);
    if (st === 'duel') this.fireTick();
  },
};
