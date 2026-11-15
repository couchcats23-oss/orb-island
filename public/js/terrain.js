// Deterministic island generation shared by the server (physics / hit detection)
// and the browser (rendering). Everything here is pure maths: no THREE, no DOM.
import { mulberry32 } from './rules.js';

export const WORLD = {
  seed: 20261113,
  R: 900,            // nominal island radius in metres (shoreline wobbles around this)
  chunk: 128,        // terrain chunk size
  extent: 2304,      // half size of the area covered by terrain meshes
  killDepth: -24,    // deeper than this and you are "lost at sea"
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export { clamp, lerp, smoothstep };

function hash2(a, b, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647) ^ Math.imul(WORLD.seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

function makePerlin(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const gx = new Float32Array(256), gz = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const a = rnd() * Math.PI * 2; gx[i] = Math.cos(a); gz[i] = Math.sin(a); }
  return {
    n(x, z) {
      const xi = Math.floor(x), zi = Math.floor(z);
      const xf = x - xi, zf = z - zi;
      const X = xi & 255, Z = zi & 255;
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
      const a = p[p[X] + Z], b = p[p[X + 1] + Z], c = p[p[X] + Z + 1], d = p[p[X + 1] + Z + 1];
      const x1 = lerp(gx[a] * xf + gz[a] * zf, gx[b] * (xf - 1) + gz[b] * zf, u);
      const x2 = lerp(gx[c] * xf + gz[c] * (zf - 1), gx[d] * (xf - 1) + gz[d] * (zf - 1), u);
      return lerp(x1, x2, v) * 1.41;
    },
  };
}

function fbm(N, x, z, oct, lac = 2.0, gain = 0.5) {
  let a = 1, f = 1, s = 0, m = 0;
  for (let i = 0; i < oct; i++) { s += a * N.n(x * f, z * f); m += a; a *= gain; f *= lac; }
  return s / m;
}

const S0 = WORLD.seed;
const NH = makePerlin(S0), NW = makePerlin(S0 + 11), NS = makePerlin(S0 + 23), NM = makePerlin(S0 + 37);
const NF = makePerlin(S0 + 53), NC = makePerlin(S0 + 71), NR = makePerlin(S0 + 89);
const R = WORLD.R;

function shapeAt(x, z) {
  const wx = x + 90 * NW.n(x * 0.0021, z * 0.0021);
  const wz = z + 90 * NW.n(x * 0.0021 + 17.3, z * 0.0021 - 9.1);
  return Math.hypot(wx, wz) / R + 0.20 * fbm(NS, x * 0.0017 + 3.1, z * 0.0017 - 4.7, 3);
}

export function rawHeight(x, z) {
  const t = 1.0 - shapeAt(x, z);
  if (t <= 0) {
    let h = Math.max(t * 240, -70);
    if (t > -0.45) { // offshore rock stacks
      const st = NR.n(x * 0.011, z * 0.011);
      h += smoothstep(0.55, 0.72, st) * smoothstep(-0.03, -0.1, t) * smoothstep(-0.45, -0.25, t) * 42;
    }
    return h;
  }
  const land = Math.min(1, t / 0.5);
  const sm = land * land * (3 - 2 * land);
  let h = Math.pow(sm, 0.85) * 14;
  h += fbm(NH, x * 0.004, z * 0.004, 4) * 11 * smoothstep(0.03, 0.35, land);
  const core = smoothstep(0.35, 1.0, land);
  const rid = 1 - Math.abs(fbm(NM, x * 0.0026 + 7, z * 0.0026 + 2, 4));
  h += rid * rid * rid * 95 * core;
  const cl = smoothstep(0.15, 0.45, NC.n(x * 0.0028, z * 0.0028));
  h += cl * 20 * smoothstep(0.004, 0.03, t) * (1 - core * 0.6);
  h += 1.4 * smoothstep(0.0, 0.02, t);
  const k = smoothstep(0, 0.1, t);
  h += fbm(NH, x * 0.02 + 50, z * 0.02 + 50, 3) * 2.2 * k;
  h += fbm(NH, x * 0.07 - 20, z * 0.07 + 8, 2) * 0.45 * k;
  return h;
}

let POIS = [];
export function heightAt(x, z) {
  let h = rawHeight(x, z);
  for (let i = 0; i < POIS.length; i++) {
    const p = POIS[i];
    if (!p.pr) continue;
    const dx = x - p.x, dz = z - p.z, d2 = dx * dx + dz * dz;
    if (d2 < p.pr * p.pr) h += (p.y - h) * (1 - smoothstep(p.pr * 0.6, p.pr, Math.sqrt(d2)));
  }
  return h;
}

export function slopeAt(x, z) {
  const e = 2;
  const hx = heightAt(x + e, z) - heightAt(x - e, z), hz = heightAt(x, z + e) - heightAt(x, z - e);
  return Math.hypot(hx, hz) / (2 * e);
}

export function normalAt(x, z, out = [0, 1, 0]) {
  const e = 1.0;
  const hx = heightAt(x + e, z) - heightAt(x - e, z), hz = heightAt(x, z + e) - heightAt(x, z - e);
  const l = Math.hypot(hx, 2 * e, hz);
  out[0] = -hx / l; out[1] = (2 * e) / l; out[2] = -hz / l;
  return out;
}

export function forestAt(x, z, h, slope) {
  if (h < 2.2 || h > 70) return 0;
  const m = fbm(NF, x * 0.0035, z * 0.0035, 3) * 0.5 + 0.5;
  let f = smoothstep(0.30, 0.6, m);
  const clear = fbm(NC, x * 0.012 + 40, z * 0.012 - 8, 2) * 0.5 + 0.5;
  f *= 1 - smoothstep(0.62, 0.78, clear) * 0.85;
  f *= 1 - smoothstep(0.55, 0.95, slope);
  f *= smoothstep(2.2, 6, h) * (1 - smoothstep(45, 70, h));
  return f;
}
export function detailNoise(x, z) { return NH.n(x * 0.05 + 9, z * 0.05 - 4); }
export function patchNoise(x, z) { return fbm(NF, x * 0.013 + 3, z * 0.013 + 7, 3); }

export function wind(t) {
  const a = 0.7 + Math.sin(t * 0.013) * 0.9 + Math.sin(t * 0.031) * 0.4;
  const sp = 1.3 + Math.sin(t * 0.021) * 0.6;
  return [Math.cos(a) * sp, Math.sin(a) * sp];
}

// ---------------------------------------------------------------------------
// Points of interest (flat clearings with ruins, wrecks, towers ...)
// ---------------------------------------------------------------------------
function P(parts, s, mat, cx, cy, cz, w, h, d, solid = false, extra) {
  parts.push({ s, mat, cx, cy, cz, w, h, d, solid, ...(extra || {}) });
}
function wallX(parts, mat, cx, cz, len, y, H, t = 0.35) { P(parts, 'box', mat, cx, y + H / 2, cz, len, H, t, true); }
function wallZ(parts, mat, cx, cz, len, y, H, t = 0.35) { P(parts, 'box', mat, cx, y + H / 2, cz, t, H, len, true); }
function wallXGap(parts, mat, cx, cz, len, y, H, gap = 1.9) {
  const seg = (len - gap) / 2, off = gap / 2 + seg / 2;
  wallX(parts, mat, cx - off, cz, seg, y, H); wallX(parts, mat, cx + off, cz, seg, y, H);
  P(parts, 'box', mat, cx, y + H - 0.35, cz, gap, 0.7, 0.35, true);
}
function wallZGap(parts, mat, cx, cz, len, y, H, gap = 1.9) {
  const seg = (len - gap) / 2, off = gap / 2 + seg / 2;
  wallZ(parts, mat, cx, cz - off, seg, y, H); wallZ(parts, mat, cx, cz + off, seg, y, H);
  P(parts, 'box', mat, cx, y + H - 0.35, cz, 0.35, 0.7, gap, true);
}
function room(parts, mat, x, z, y, w, d, H, door, gap) {
  const hw = w / 2, hd = d / 2;
  const sides = [[x, z - hd, 'x', w], [x, z + hd, 'x', w], [x + hw, z, 'z', d], [x - hw, z, 'z', d]];
  sides.forEach(([cx, cz, ax, len], i) => {
    if (i === door) (ax === 'x' ? wallXGap : wallZGap)(parts, mat, cx, cz, len, y, H, gap);
    else (ax === 'x' ? wallX : wallZ)(parts, mat, cx, cz, len, y, H);
  });
}
function house(parts, x, z, y, w, d, door, mat = 'wood') {
  room(parts, mat, x, z, y, w, d, 3.2, door, 1.9);
  P(parts, 'box', 'concrete', x, y + 0.04, z, w, 0.08, d, false);
  P(parts, 'box', 'rust', x - w * 0.22, y + 3.35, z, w * 0.56, 0.25, d + 0.6, true);
}

function findSpot(ang, rad, o = {}) {
  const { hmin = 3, hmax = 40, flat = 0.08, clear = 14 } = o;
  const cx = Math.cos(ang) * rad, cz = Math.sin(ang) * rad;
  for (let k = 0; k < 900; k++) {
    const a = k * 2.399963, d = Math.sqrt(k) * 14;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    const h = rawHeight(x, z);
    if (h < hmin || h > hmax) continue;
    let ok = true, sum = 0;
    for (let i = 0; i < 8; i++) {
      const aa = i * Math.PI / 4;
      const hh = rawHeight(x + Math.cos(aa) * clear * 2.2, z + Math.sin(aa) * clear * 2.2);
      if (Math.abs(hh - h) > flat * clear * 2.2 || hh < hmin - 3) { ok = false; break; }
      sum += hh;
    }
    if (ok) return { x, z, y: (sum / 8 + h) / 2 };
  }
  return { x: cx, z: cz, y: Math.max(rawHeight(cx, cz), 3) };
}

function buildPOIs() {
  const list = [];

  { // Old Village
    const p = findSpot(0.45, 0.45 * R, { hmin: 6, hmax: 30, flat: 0.07 });
    const parts = [];
    const hs = [[-22, -14, 9, 7, 1], [6, -26, 8, 7, 1], [24, 2, 7, 8, 3], [-18, 16, 8, 6, 0], [8, 22, 9, 7, 0]];
    for (const [dx, dz, w, d, door] of hs) house(parts, p.x + dx, p.z + dz, p.y, w, d, door);
    P(parts, 'cyly', 'stone', p.x - 2, p.y + 0.6, p.z + 2, 1.8, 1.2, 1.8, true); // well
    P(parts, 'box', 'wood', p.x + 14, p.y + 0.5, p.z - 10, 2.4, 1.0, 1.4, true);   // cart
    list.push({ id: 'village', name: 'Old Village', x: p.x, z: p.z, y: p.y, pr: 52, tc: 52, parts, floors: [],
      caches: [[p.x - 22, p.z - 14], [p.x + 24, p.z + 2], [p.x + 8, p.z + 22]] });
  }
  { // Concrete compound
    const p = findSpot(1.5, 0.3 * R, { hmin: 8, hmax: 50, flat: 0.09, clear: 16 });
    const parts = [], W = 34, D = 26, H = 3.6;
    wallXGap(parts, 'concrete', p.x, p.z - D / 2, W, p.y, H, 4);
    wallXGap(parts, 'concrete', p.x, p.z + D / 2, W, p.y, H, 4);
    wallZ(parts, 'concrete', p.x + W / 2, p.z, D, p.y, H);
    wallZ(parts, 'concrete', p.x - W / 2, p.z, D, p.y, H);
    room(parts, 'concrete', p.x - 6, p.z, p.y, 12, 9, 3.4, 1, 2.2);
    P(parts, 'box', 'concrete', p.x - 6, p.y + 3.55, p.z, 12.6, 0.3, 9.6, true);
    P(parts, 'box', 'metal', p.x + 9, p.y + 0.6, p.z - 6, 1.4, 1.2, 1.4, true);
    P(parts, 'box', 'metal', p.x + 10.6, p.y + 0.6, p.z - 5.2, 1.4, 1.2, 1.4, true);
    P(parts, 'cyly', 'rust', p.x + 10, p.y + 0.55, p.z + 6, 1.0, 1.1, 1.0, true);
    P(parts, 'cyly', 'rust', p.x + 11.2, p.y + 0.55, p.z + 6.6, 1.0, 1.1, 1.0, true);
    list.push({ id: 'compound', name: 'Concrete Compound', x: p.x, z: p.z, y: p.y, pr: 46, tc: 46, parts, floors: [],
      caches: [[p.x - 6, p.z], [p.x + 9, p.z + 2]] });
  }
  { // Relay tower
    const p = findSpot(2.4, 0.28 * R, { hmin: 30, hmax: 95, flat: 0.12, clear: 8 });
    const parts = [], Ht = 34;
    for (const [sx, sz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) P(parts, 'box', 'metal', p.x + sx, p.y + Ht / 2, p.z + sz, 0.4, Ht, 0.4, true);
    for (let k = 1; k <= 6; k++) {
      const yy = p.y + k * 5;
      P(parts, 'box', 'metal', p.x, yy, p.z - 3, 6.4, 0.25, 0.25);
      P(parts, 'box', 'metal', p.x, yy, p.z + 3, 6.4, 0.25, 0.25);
      P(parts, 'box', 'metal', p.x - 3, yy, p.z, 0.25, 0.25, 6.4);
      P(parts, 'box', 'metal', p.x + 3, yy, p.z, 0.25, 0.25, 6.4);
    }
    P(parts, 'box', 'metal', p.x, p.y + Ht + 0.2, p.z, 8, 0.4, 8);
    P(parts, 'box', 'concrete', p.x, p.y + Ht + 1.8, p.z, 5, 2.8, 5, true);
    P(parts, 'cyly', 'metal', p.x, p.y + Ht + 6.5, p.z, 0.25, 7, 0.25);
    P(parts, 'box', 'redlamp', p.x, p.y + Ht + 10.2, p.z, 0.5, 0.5, 0.5, false, { emit: true });
    P(parts, 'box', 'concrete', p.x + 8, p.y + 1.1, p.z, 4, 2.2, 3.6, true);
    list.push({ id: 'tower', name: 'Relay Tower', x: p.x, z: p.z, y: p.y, pr: 30, tc: 30, parts, floors: [], lamp: [p.x, p.y + Ht + 10.2, p.z],
      caches: [[p.x + 8, p.z + 3.5]] });
  }
  { // Crashed cargo plane
    const p = findSpot(3.7, 0.52 * R, { hmin: 6, hmax: 35, flat: 0.08, clear: 14 });
    const parts = [];
    P(parts, 'cylx', 'metal', p.x - 4, p.y + 2.3, p.z, 24, 4.6, 4.6, true);
    P(parts, 'cylx', 'rust', p.x + 14, p.y + 1.6, p.z + 3, 12, 4.2, 4.2, true);
    P(parts, 'box', 'metal', p.x - 4, p.y + 2.0, p.z + 11, 3.4, 0.4, 16, false);
    P(parts, 'box', 'metal', p.x - 4, p.y + 1.6, p.z - 11, 3.4, 0.4, 16, false);
    P(parts, 'box', 'metal', p.x - 16, p.y + 6, p.z, 3, 5.5, 0.5, true);
    P(parts, 'cyly', 'rust', p.x - 3, p.y + 1.2, p.z + 7, 2.2, 2.4, 2.2, true);
    for (let i = 0; i < 7; i++) P(parts, 'box', i % 2 ? 'rust' : 'metal', p.x - 14 + i * 4.3, p.y + 0.3, p.z + (i % 3 - 1) * 6, 1.4, 0.6, 1.1);
    list.push({ id: 'wreck', name: 'Cargo Plane Wreck', x: p.x, z: p.z, y: p.y, pr: 40, tc: 40, parts, floors: [],
      caches: [[p.x + 4, p.z + 5], [p.x - 10, p.z - 5]] });
  }
  { // Harbor pier (walk out over the sea)
    let sx = 0, sz = 0, found = false;
    const ang = 5.2, ux = Math.cos(ang), uz = Math.sin(ang);
    for (let r = R * 1.25; r > R * 0.4; r -= 3) {
      if (rawHeight(ux * r, uz * r) > 1.1) { sx = ux * r; sz = uz * r; found = true; break; }
    }
    if (found) {
      const parts = [], floors = [];
      const alongX = Math.abs(ux) > Math.abs(uz);
      const sgn = alongX ? Math.sign(ux) : Math.sign(uz), L = 44, Wd = 3.6, top = 1.15;
      const x0 = alongX ? sx : sx - Wd / 2, z0 = alongX ? sz - Wd / 2 : sz;
      const minX = alongX ? Math.min(x0, x0 + sgn * L) : x0, maxX = alongX ? Math.max(x0, x0 + sgn * L) : x0 + Wd;
      const minZ = alongX ? z0 : Math.min(z0, z0 + sgn * L), maxZ = alongX ? z0 + Wd : Math.max(z0, z0 + sgn * L);
      floors.push({ minX, maxX, minZ, maxZ, top });
      P(parts, 'box', 'wood', (minX + maxX) / 2, top - 0.12, (minZ + maxZ) / 2, maxX - minX, 0.24, maxZ - minZ);
      for (let k = 0; k <= L; k += 4) {
        const px = alongX ? x0 + sgn * k : x0, pz = alongX ? z0 : z0 + sgn * k;
        P(parts, 'cyly', 'wood', px, -1.2, pz, 0.35, 4.6, 0.35);
        P(parts, 'cyly', 'wood', px + (alongX ? 0 : Wd), -1.2, pz + (alongX ? Wd : 0), 0.35, 4.6, 0.35);
      }
      const ex = alongX ? x0 + sgn * L : x0 + Wd / 2, ez = alongX ? z0 + Wd / 2 : z0 + sgn * L;
      P(parts, 'box', 'wood', ex, top + 0.6, ez, 1.6, 1.2, 1.6, true);
      P(parts, 'box', 'wood', (minX + maxX) / 2 + (alongX ? 0 : 3.2), top + 0.5, (minZ + maxZ) / 2 + (alongX ? 3.2 : 0), 1.2, 1.0, 1.2, false);
      list.push({ id: 'harbor', name: 'Old Pier', x: sx, z: sz, y: 1, pr: 0, tc: 30, parts, floors, caches: [[ex, ez]] });
    }
  }
  { // Standing stones
    const p = findSpot(4.55, 0.32 * R, { hmin: 10, hmax: 60, flat: 0.1, clear: 10 });
    const parts = [];
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      P(parts, 'box', 'stone', p.x + Math.cos(a) * 9, p.y + 1.7, p.z + Math.sin(a) * 9, 1.5, 3.4 + (i % 3) * 0.5, 1.0, true);
    }
    P(parts, 'box', 'stone', p.x, p.y + 0.5, p.z, 3, 1.0, 3, true);
    list.push({ id: 'stones', name: 'Standing Stones', x: p.x, z: p.z, y: p.y, pr: 22, tc: 22, parts, floors: [], caches: [[p.x + 4.5, p.z + 4.5]] });
  }
  { // Survivor camp
    const p = findSpot(5.85, 0.55 * R, { hmin: 4, hmax: 28, flat: 0.08, clear: 10 });
    const parts = [];
    P(parts, 'cone', 'tent', p.x - 6, p.y + 1.1, p.z - 3, 3.4, 2.2, 3.4);
    P(parts, 'cone', 'tent', p.x + 5, p.y + 1.1, p.z - 5, 3.4, 2.2, 3.4);
    P(parts, 'cone', 'tent', p.x + 1, p.y + 1.1, p.z + 7, 3.4, 2.2, 3.4);
    P(parts, 'box', 'wood', p.x - 1, p.y + 0.5, p.z + 1, 1.0, 1.0, 1.0, true);
    P(parts, 'box', 'wood', p.x + 0.3, p.y + 0.5, p.z + 2.2, 1.0, 1.0, 1.0, true);
    P(parts, 'cylx', 'wood', p.x + 3, p.y + 0.3, p.z + 2, 3, 0.6, 0.6);
    P(parts, 'cyly', 'stone', p.x + 2.5, p.y + 0.2, p.z - 1.5, 1.2, 0.4, 1.2);
    P(parts, 'cyly', 'ember', p.x + 2.5, p.y + 0.45, p.z - 1.5, 0.6, 0.2, 0.6, false, { emit: true });
    list.push({ id: 'camp', name: 'Survivor Camp', x: p.x, z: p.z, y: p.y, pr: 26, tc: 26, parts, floors: [], caches: [[p.x - 0.4, p.z + 1.6]] });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Colliders + chunk content (trees / rocks), cached globally
// ---------------------------------------------------------------------------
const CELL = 16;
const cells = new Map();
const cellKey = (gx, gz) => gx * 65536 + gz;
function addToCells(c, minX, maxX, minZ, maxZ) {
  const g0x = Math.floor(minX / CELL), g1x = Math.floor(maxX / CELL), g0z = Math.floor(minZ / CELL), g1z = Math.floor(maxZ / CELL);
  for (let gx = g0x; gx <= g1x; gx++) for (let gz = g0z; gz <= g1z; gz++) {
    const k = cellKey(gx, gz);
    let a = cells.get(k);
    if (!a) { a = []; cells.set(k, a); }
    a.push(c);
  }
}

const FLOORS = [];
POIS = buildPOIs();
for (const p of POIS) {
  for (const f of p.floors) FLOORS.push(f);
  for (const part of p.parts) {
    if (!part.solid) continue;
    const c = { k: 1, minX: part.cx - part.w / 2, maxX: part.cx + part.w / 2, minZ: part.cz - part.d / 2, maxZ: part.cz + part.d / 2, y0: part.cy - part.h / 2, y1: part.cy + part.h / 2, id: -1 };
    addToCells(c, c.minX, c.maxX, c.minZ, c.maxZ);
  }
}
export function getPOIs() { return POIS; }

function nearPOI(x, z) {
  for (let i = 0; i < POIS.length; i++) {
    const p = POIS[i], r = p.tc || p.pr;
    if (!r) continue;
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

export const treeId = (cx, cz, i) => ((cx + 64) * 128 + (cz + 64)) * 1024 + i;
export function decodeTreeId(id) {
  const i = id % 1024, rest = (id - i) / 1024, cz = (rest % 128) - 64, cx = (rest - (rest % 128)) / 128 - 64;
  return { cx, cz, i };
}

const chunks = new Map();
export function getChunk(cx, cz) {
  const key = cx * 4096 + cz;
  let c = chunks.get(key);
  if (c) return c;
  const S = WORLD.chunk, x0 = cx * S, z0 = cz * S, rnd = mulberry32(hash2(cx, cz, 1));
  c = { cx, cz, trees: [], rocks: [] };
  chunks.set(key, c);
  for (let gz = 0; gz < 16; gz++) for (let gx = 0; gx < 16; gx++) {
    const px = x0 + (gx + rnd()) * 8, pz = z0 + (gz + rnd()) * 8, r1 = rnd(), r2 = rnd(), r3 = rnd();
    const h = heightAt(px, pz);
    if (h < 0.7 || nearPOI(px, pz)) continue;
    const sl = slopeAt(px, pz), f = forestAt(px, pz, h, sl);
    let type = -1, s = 1;
    if (f > 0 && r1 < f * 0.85) { type = 0; s = 0.85 + r2 * 0.9; if (f > 0.5 && r3 > 0.7) s *= 1.25; }
    else if (h < 3.8 && h > 0.9 && sl < 0.35 && r1 > 0.9) { type = 1; s = 0.8 + r2 * 0.5; }
    else if (f > 0.1 && r3 < 0.35 && sl < 0.7) { type = 2; s = 0.8 + r2 * 0.9; }
    if (type < 0) continue;
    const hgt = type === 0 ? 11 * s : type === 1 ? 8 * s : 1.2 * s;
    const tree = { x: px, y: h, z: pz, s, type, rot: r2 * 6.283, hgt, id: treeId(cx, cz, c.trees.length) };
    c.trees.push(tree);
    if (type < 2) {
      const col = { k: 0, x: px, z: pz, r: (type === 0 ? 0.45 : 0.3) * s, y0: h - 0.5, y1: h + hgt, id: tree.id };
      tree.col = col;
      addToCells(col, px - col.r, px + col.r, pz - col.r, pz + col.r);
    }
  }
  for (let i = 0; i < 12; i++) {
    const px = x0 + rnd() * S, pz = z0 + rnd() * S, rr = rnd(), rs = rnd(), rot = rnd() * 6.283, sy = 0.6 + rnd() * 0.6;
    const h = heightAt(px, pz);
    if (h < -1.5 || nearPOI(px, pz)) continue;
    const sl = slopeAt(px, pz);
    const p = clamp(sl * 1.4 - 0.15, 0, 0.9) + (h > 55 ? 0.2 : 0) + (h < 2.2 && h > 0 ? 0.05 : 0);
    if (rr < p * 0.6) {
      const s = 0.9 + rs * rs * 4.5;
      c.rocks.push({ x: px, y: h, z: pz, s, sy, rot });
      const col = { k: 0, x: px, z: pz, r: s * 0.85, y0: h - 1, y1: h + s * sy * 1.5, id: -1 };
      addToCells(col, px - col.r, px + col.r, pz - col.r, pz + col.r);
    }
  }
  return c;
}

let stamp = 0;
// Collect solid colliders within r of (x,z). `dead` is an optional Set of destroyed tree ids.
export function queryColliders(x, z, r, out, dead) {
  out.length = 0;
  const S = WORLD.chunk;
  const c0x = Math.floor((x - r) / S), c1x = Math.floor((x + r) / S), c0z = Math.floor((z - r) / S), c1z = Math.floor((z + r) / S);
  for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) getChunk(cx, cz);
  const g0x = Math.floor((x - r) / CELL), g1x = Math.floor((x + r) / CELL), g0z = Math.floor((z - r) / CELL), g1z = Math.floor((z + r) / CELL);
  stamp++;
  for (let gx = g0x; gx <= g1x; gx++) for (let gz = g0z; gz <= g1z; gz++) {
    const a = cells.get(cellKey(gx, gz));
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      const c = a[i];
      if (c._q === stamp) continue;
      c._q = stamp;
      if (dead && c.id >= 0 && dead.has(c.id)) continue;
      out.push(c);
    }
  }
  return out;
}

const _q = [];
// Remove trees within radius r of (x,z); returns ids that were newly destroyed.
export function destroyTrees(x, z, r, dead) {
  const res = [];
  queryColliders(x, z, r + 1, _q, dead);
  for (const c of _q) {
    if (c.k !== 0 || c.id < 0) continue;
    if (Math.hypot(c.x - x, c.z - z) < r) { dead.add(c.id); res.push(c.id); }
  }
  return res;
}

export function floorAt(x, z, y) {
  let h = heightAt(x, z);
  for (let i = 0; i < FLOORS.length; i++) {
    const f = FLOORS[i];
    if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ && f.top <= y + 0.7 && f.top > h) h = f.top;
  }
  return h;
}

// Is a point inside terrain or a solid building box? (used for blast shielding)
export function pointBlocked(x, y, z) {
  if (heightAt(x, z) > y + 0.1) return true;
  queryColliders(x, z, 0.3, _q, null);
  for (const c of _q) if (c.k === 1 && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y > c.y0 && y < c.y1) return true;
  return false;
}
