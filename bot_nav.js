// Bot body: movement physics, steering, line of sight and orb-flight prediction. Server-side only.
// Mirrors the client movement model in public/js/game.js so a bot moves exactly like a player would.
import { RULES, FLAGS } from './public/js/rules.js';
import { heightAt, floorAt, normalAt, queryColliders } from './public/js/terrain.js';

const col = [];
const N3 = [0, 1, 0];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const OFFS = [0, 0.4, -0.4, 0.85, -0.85, 1.4, -1.4, 2.2, -2.2];

export class Body {
  constructor(p, lobby) {
    this.p = p; this.lobby = lobby;
    this.vx = 0; this.vy = 0; this.vz = 0; this.onGround = true; this.dropping = true;
    this.stam = 1; this.lock = false; this.delay = 0; this.speed = 0;
    this.side = 1; this.unstick = 0; this.unDir = 0; this.chkT = 0; this.chkX = p.x; this.chkZ = p.z; this.want = false;
  }

  // ---- parachute -----------------------------------------------------------
  glide(dt, wx, wz) {
    const p = this.p, a = Math.min(1, dt * 2);
    this.vx += (wx * RULES.dropGlide - this.vx) * a; this.vz += (wz * RULES.dropGlide - this.vz) * a;
    p.x += this.vx * dt; p.z += this.vz * dt; p.y -= RULES.dropSpeed * dt;
    p.fl = 0; this.speed = Math.hypot(this.vx, this.vz);
    const g = floorAt(p.x, p.z, p.y), landY = g < -0.95 ? -1.1 : g;
    if (p.y <= landY + 0.02) { p.y = landY; this.vx = this.vz = this.vy = 0; this.onGround = true; this.dropping = false; }
  }

  // ---- ground movement (wx,wz = desired unit direction, mode = walk|sprint|crouch) -----------
  walk(dt, wx, wz, mode) {
    const p = this.p;
    const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
    const moving = wl > 0.05;
    const g0 = floorAt(p.x, p.z, p.y), swim = g0 < -0.95;
    const crouch = mode === 'crouch' && !swim;
    const sprint = mode === 'sprint' && moving && !crouch && !swim && !this.lock;
    if (sprint) { this.stam -= dt / 6; this.delay = 0.9; if (this.stam <= 0) { this.stam = 0; this.lock = true; } }
    else { this.delay -= dt; if (this.delay <= 0) this.stam = Math.min(1, this.stam + dt / 4); if (this.lock && this.stam > 0.3) this.lock = false; }
    let speed = swim ? RULES.swim : crouch ? RULES.crouch : sprint ? RULES.sprint : RULES.walk;
    if (!swim && g0 < -0.2) speed *= 0.75;
    const n = normalAt(p.x, p.z, N3), uphill = -(wx * n[0] + wz * n[2]);
    if (this.onGround && uphill > 0) speed *= 1 - clamp(uphill * (1 - n[1]) * 1.6, 0, 0.5);
    if (this.onGround && n[1] < 0.55) { this.vx += n[0] * 10 * dt; this.vz += n[2] * 10 * dt; if (uphill > 0) speed *= 0.2; }
    const a = Math.min(1, ((this.onGround || swim) ? 12 : 2.5) * dt);
    this.vx += (wx * speed - this.vx) * a; this.vz += (wz * speed - this.vz) * a;
    const step = (nx, nz) => {
      const len = Math.hypot(nx - p.x, nz - p.z);
      if (len < 1e-5) return true;
      const gN = floorAt(nx, nz, p.y);
      if (this.onGround && !swim && gN - p.y > 0.14 + len * 1.4 && gN - p.y > 0.05) return false;
      p.x = nx; p.z = nz; return true;
    };
    const tx = p.x + this.vx * dt, tz = p.z + this.vz * dt;
    if (!step(tx, tz)) { if (!step(tx, p.z)) this.vx *= 0.2; if (!step(p.x, tz)) this.vz *= 0.2; }
    const top = this.collide(crouch);
    const g = Math.max(floorAt(p.x, p.z, p.y), top);
    if (swim) { this.vy = 0; p.y += (-1.1 - p.y) * Math.min(1, dt * 6); this.onGround = false; }
    else {
      this.vy -= RULES.gravity * dt; p.y += this.vy * dt;
      if (p.y <= g) { p.y = g; this.vy = 0; this.onGround = true; }
      else if (this.onGround && this.vy <= 0 && p.y - g < 0.4 && this.vy > -3) { p.y = g; this.vy = 0; }
      else this.onGround = false;
    }
    this.speed = Math.hypot(this.vx, this.vz);
    p.fl = (crouch ? FLAGS.CROUCH : 0) | (sprint ? FLAGS.SPRINT : 0) | (swim ? FLAGS.SWIM : 0);
    // stuck detection: wanted to move but barely did for a while -> sidestep for a moment
    this.want = moving;
    this.chkT += dt;
    if (this.chkT >= 1) {
      const moved = Math.hypot(p.x - this.chkX, p.z - this.chkZ);
      if (this.want && moved < 0.8 && mode !== 'crouch') { this.unstick = 0.9 + Math.random() * 0.8; this.unDir = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random()); }
      this.chkT = 0; this.chkX = p.x; this.chkZ = p.z;
    }
    if (this.unstick > 0) this.unstick -= dt;
  }

  collide(crouch) {
    const p = this.p, r = RULES.radius; let top = -1e9;
    queryColliders(p.x, p.z, 2.6, col, this.lobby.deadTrees);
    const feet = p.y, head = p.y + (crouch ? 1.2 : 1.8);
    for (const c of col) {
      if (head <= c.y0) continue;
      if (c.k === 0) {
        const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), min = c.r + r;
        if (feet >= c.y1 - 0.45) { if (d < c.r + 0.2) top = Math.max(top, c.y1); continue; }
        if (d < min) { const l = d || 1; p.x = c.x + dx / l * min; p.z = c.z + dz / l * min; }
      } else {
        if (!(p.x > c.minX - r && p.x < c.maxX + r && p.z > c.minZ - r && p.z < c.maxZ + r)) continue;
        if (feet >= c.y1 - 0.45) { if (p.x > c.minX - 0.1 && p.x < c.maxX + 0.1 && p.z > c.minZ - 0.1 && p.z < c.maxZ + 0.1) top = Math.max(top, c.y1); continue; }
        const a = p.x - (c.minX - r), b = (c.maxX + r) - p.x, c2 = p.z - (c.minZ - r), d2 = (c.maxZ + r) - p.z, mn = Math.min(a, b, c2, d2);
        if (mn === a) { p.x = c.minX - r; this.vx = Math.min(0, this.vx); } else if (mn === b) { p.x = c.maxX + r; this.vx = Math.max(0, this.vx); }
        else if (mn === c2) { p.z = c.minZ - r; this.vz = Math.min(0, this.vz); } else { p.z = c.maxZ + r; this.vz = Math.max(0, this.vz); }
      }
    }
    return top;
  }

  // ---- steering: pick the best of several headings toward (tx,tz) ----------------------------
  cost(x, z, zones) {
    const p = this.p; let c = 0;
    const g = floorAt(x, z, p.y);
    if (g < -0.3) c += 4 + (g < -0.95 ? 8 : 0);
    const rise = g - p.y; if (rise > 0.8) c += 3 + rise;
    queryColliders(x, z, 1.0, col, this.lobby.deadTrees);
    for (const k of col) {
      if (p.y + 1.7 < k.y0 || p.y > k.y1 - 0.4) continue;
      if (k.k === 0) { if (Math.hypot(x - k.x, z - k.z) < k.r + 0.85) c += 5; }
      else if (x > k.minX - 0.85 && x < k.maxX + 0.85 && z > k.minZ - 0.85 && z < k.maxZ + 0.85) c += 5;
    }
    if (zones) for (const q of zones) { const d = Math.hypot(x - q.x, z - q.z); if (d < q.r) c += 3 + 6 * (1 - d / q.r); }
    return c;
  }

  steer(tx, tz, zones) {
    const p = this.p, dx = tx - p.x, dz = tz - p.z;
    if (dx * dx + dz * dz < 0.09) return [0, 0];
    let base = Math.atan2(dz, dx);
    if (this.unstick > 0) base += this.unDir;
    let best = 0, bs = -1e9;
    for (const off of OFFS) {
      const a = base + off, cx = Math.cos(a), cz = Math.sin(a);
      let s = Math.cos(off) * 2.2 - Math.abs(off) * 0.12 + (off * this.side > 0 ? 0.2 : 0);
      s -= this.cost(p.x + cx * 2.2, p.z + cz * 2.2, zones) + this.cost(p.x + cx * 5, p.z + cz * 5, zones) * 0.8;
      if (s > bs) { bs = s; best = off; }
    }
    if (best !== 0) this.side = best > 0 ? 1 : -1;
    const a = base + best; return [Math.cos(a), Math.sin(a)];
  }
}

// ---- line of sight between two eye points (terrain + trees + buildings) ---------------------
export function los(ax, ay, az, bx, by, bz, dead) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
  const n = Math.max(2, Math.ceil(len / 1.6));
  for (let i = 1; i < n; i++) {
    const f = i / n, x = ax + dx * f, y = ay + dy * f, z = az + dz * f;
    if (heightAt(x, z) > y - 0.15) return false;
    if (y > 18) continue;
    queryColliders(x, z, 0.8, col, dead);
    for (const k of col) {
      if (y < k.y0 || y > k.y1) continue;
      if (k.k === 0) { if (Math.hypot(x - k.x, z - k.z) < k.r + 0.1) return false; }
      else if (x > k.minX && x < k.maxX && z > k.minZ && z < k.maxZ) return false;
    }
  }
  return true;
}
