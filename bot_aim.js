// Ballistics for bots: simulate an orb flight like the server does and search for a throw that lands where we want.
import { RULES } from './public/js/rules.js';
import { floorAt, queryColliders } from './public/js/terrain.js';

const col = [];
const G = 9.8;

// Simulate a throw (same launch rules as Lobby.onThrow). Returns where/when it first touches something.
export function simThrow(lobby, ex, ey, ez, dx, dy, dz, pw) {
  const sp = RULES.throwMin + (RULES.throwMax - RULES.throwMin) * pw;
  let x = ex + dx * 0.7, y = ey + dy * 0.7 - 0.15, z = ez + dz * 0.7;
  let vx = dx * sp, vy = dy * sp, vz = dz * sp;
  const h = 1 / 40;
  for (let i = 1; i <= 200; i++) {
    vy -= G * h; x += vx * h; y += vy * h; z += vz * h;
    const g = floorAt(x, z, y);
    if (y - 0.14 <= g) return { x, y: g, z, t: i * h, hit: 'ground' };
    if (y < 18) {
      queryColliders(x, z, 1.2, col, lobby.deadTrees);
      for (const c of col) {
        if (y < c.y0 || y > c.y1) continue;
        if (c.k === 0) { if (Math.hypot(x - c.x, z - c.z) < c.r + 0.14) return { x, y, z, t: i * h, hit: 'tree' }; }
        else if (x > c.minX - 0.14 && x < c.maxX + 0.14 && z > c.minZ - 0.14 && z < c.maxZ + 0.14) return { x, y, z, t: i * h, hit: 'box' };
      }
    }
    if (Math.abs(x) > 4000 || Math.abs(z) > 4000) break;
  }
  return { x, y, z, t: 200 * h, hit: 'none' };
}

// Find (direction, power) so an orb launched from the eye lands near (tx,ty,tz).
// opts: pws (powers to try), arc ('low' | 'high' | undefined), self {x,z} + minSafe (reject impacts too close to us).
export function solveThrow(lobby, ex, ey, ez, tx, ty, tz, opts = {}) {
  const ux = tx - ex, uz = tz - ez, R = Math.hypot(ux, uz) || 0.01, hh = ty - ey;
  const hx = ux / R, hz = uz / R;
  const tryArc = (sgn) => {
    let best = null;
    for (const pw of opts.pws || [1, 0.75, 0.5]) {
      const v = RULES.throwMin + (RULES.throwMax - RULES.throwMin) * pw, v2 = v * v;
      const disc = v2 * v2 - G * (G * R * R + 2 * hh * v2);
      if (disc < 0) continue;
      const th = Math.atan((v2 + sgn * Math.sqrt(disc)) / (G * R)), c = Math.cos(th);
      const d = [hx * c, Math.sin(th), hz * c];
      const r = simThrow(lobby, ex, ey, ez, d[0], d[1], d[2], pw);
      let err = Math.hypot(r.x - tx, r.z - tz) + Math.abs(r.y - ty) * 0.25;
      if (opts.self) { const sd = Math.hypot(r.x - opts.self.x, r.z - opts.self.z); if (sd < (opts.minSafe || 0)) err += (opts.minSafe - sd) * 3 + 20; }
      const score = err + 0.3 * r.t; // among equally accurate throws, prefer the quick ones (hard to dodge)
      if (!best || score < best.score) best = { d, pw, err, score, t: r.t, imp: r, hit: r.hit };
    }
    return best;
  };
  // Flat, fast arcs first (about 1-2 s of flight: hard to sidestep); lobs only when the flat arc is blocked.
  const order = opts.arc === 'high' ? [1] : opts.arc === 'low' ? [-1] : [-1, 1];
  let best = null;
  for (const sgn of order) {
    const r = tryArc(sgn);
    if (r && (!best || r.err < best.err)) best = r;
    if (best && best.err <= (opts.tol || 3)) break;
  }
  return best;
}

// Where will a flying orb come down? (used to dodge incoming throws)
export function predictLanding(o) {
  let x = o.x, y = o.y, z = o.z, vx = o.vx, vy = o.vy, vz = o.vz;
  const h = 0.05;
  for (let i = 1; i <= 80; i++) {
    vy -= G * h; x += vx * h; y += vy * h; z += vz * h;
    if (y - 0.14 <= floorAt(x, z, y)) return { x, z, t: i * h };
  }
  return { x, z, t: 4 };
}
