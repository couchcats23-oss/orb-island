// Procedural models: orbs, pickups, player avatars (third person) and the first-person viewmodel.
import * as THREE from 'three';
import { ORB, ORB_ORDER, FLAGS } from './rules.js';

const R = 0.09; // visual orb radius
let SH = null;
function shared() {
  if (SH) return SH;
  SH = {
    sphere: new THREE.SphereGeometry(R, 20, 14),
    band: new THREE.TorusGeometry(R * 1.004, 0.014, 8, 28),
    ledG: new THREE.SphereGeometry(0.018, 10, 8),
    vent: new THREE.CylinderGeometry(0.02, 0.02, 0.025, 8),
    cone: new THREE.ConeGeometry(0.022, 0.055, 8),
    box: new THREE.BoxGeometry(1, 1, 1),
    shell: new THREE.MeshStandardMaterial({ color: 0x4a5058, metalness: 0.75, roughness: 0.38 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x15181b, metalness: 0.3, roughness: 0.7 }),
    bands: {},
  };
  for (const k of ORB_ORDER) SH.bands[k] = new THREE.MeshStandardMaterial({ color: ORB[k].color, emissive: ORB[k].color, emissiveIntensity: 0.22, metalness: 0.4, roughness: 0.45 });
  return SH;
}

// ----------------------------------------------------------------------------- orbs
export function makeOrbMesh(type) {
  const s = shared(), g = new THREE.Group();
  const body = new THREE.Mesh(s.sphere, s.shell); g.add(body);
  const band = new THREE.Mesh(s.band, s.bands[type]); band.rotation.x = Math.PI / 2; g.add(band);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 1.2 });
  const led = new THREE.Mesh(s.ledG, ledMat); led.position.set(0, R * 0.97, 0); g.add(led);
  g.userData = { type, led: ledMat, prop: null };
  const around = (geo, mat, n, rotZ, off) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (off || 0), m = new THREE.Mesh(geo, mat);
      m.position.set(Math.cos(a) * R, 0, Math.sin(a) * R); m.rotation.set(0, -a, rotZ); g.add(m);
    }
  };
  if (type === 'implosion') { const b2 = new THREE.Mesh(s.band, s.bands.implosion); b2.rotation.y = Math.PI / 2; g.add(b2); const b3 = new THREE.Mesh(s.band, s.bands.implosion); g.add(b3); }
  else if (type === 'gas') around(s.vent, s.dark, 6, Math.PI / 2);
  else if (type === 'flame') around(s.cone, s.bands.flame, 4, -Math.PI / 2, Math.PI / 4);
  else if (type === 'remote') {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.014, 14), s.dark); pad.position.y = -R * 0.98; g.add(pad);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.05, 6), s.shell); ant.position.set(0.04, R * 0.9, 0); ant.rotation.z = -0.5; g.add(ant);
  } else if (type === 'homing') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 1.55, 0.007, 6, 22), s.shell); ring.rotation.x = Math.PI / 2; ring.position.y = R * 0.55; g.add(ring);
    const prop = new THREE.Group(); prop.position.y = R + 0.025;
    for (let i = 0; i < 2; i++) { const b = new THREE.Mesh(s.box, s.dark); b.scale.set(0.2, 0.004, 0.026); b.rotation.y = i * Math.PI / 2; prop.add(b); }
    g.add(prop); g.userData.prop = prop;
  } else if (type === 'barrier') {
    body.material = new THREE.MeshBasicMaterial({ color: 0x6fffd0, transparent: true, opacity: 0.4 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(R * 0.45, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc8fff0 })); g.add(core);
  }
  return g;
}

// st: 0 fly, 1 rest, 2 implosion suck, 3 homing seek.  extra: fuse (timer) or number (remote)
export function updateOrbMesh(g, st, extra, t, dt) {
  const u = g.userData, led = u.led;
  if (u.type === 'timer') {
    const rate = extra < 2 ? 13 : extra < 4 ? 6 : 2.2;
    led.emissiveIntensity = ((t * rate) % 1) < 0.35 ? 3.2 : 0.1;
  } else if (u.type === 'remote') led.emissiveIntensity = st === 1 ? ((t * 1.4) % 1 < 0.15 ? 3 : 0.15) : 1.2;
  else if (u.type === 'implosion') led.emissiveIntensity = st === 2 ? 3 + Math.sin(t * 40) * 2 : (st === 1 ? 1.5 : 0.6);
  else led.emissiveIntensity = st === 0 ? 0.9 : 0.35;
  if (u.prop) u.prop.rotation.y += dt * (st === 3 ? 70 : st === 0 ? 22 : 0);
  if (st === 0 || st === 3) { g.rotation.x += dt * 9; g.rotation.z += dt * 4; }
  if (st === 2) { const k = 1 + Math.sin(t * 30) * 0.08; g.scale.setScalar(k); }
}

// ----------------------------------------------------------------------------- pickups
let PK = null;
function pkShared() {
  if (PK) return PK;
  PK = {
    chipBody: new THREE.MeshStandardMaterial({ color: 0x0c2a2a, metalness: 0.6, roughness: 0.35, emissive: 0x59ffd0, emissiveIntensity: 0.9 }),
    chipCore: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3, 2.5) }),
    pin: new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.9, roughness: 0.3 }),
    crate: new THREE.MeshStandardMaterial({ color: 0x59633f, metalness: 0.4, roughness: 0.6 }),
    stripe: new THREE.MeshStandardMaterial({ color: 0xd9962b, roughness: 0.6 }),
    plane: new THREE.PlaneGeometry(0.8, 1),
  };
  return PK;
}

export function makePickup(kind, tex) {
  const s = pkShared(), s2 = shared(), g = new THREE.Group(), inner = new THREE.Group();
  g.add(inner);
  let color = 0x59ffd0, off = 0;
  if (kind === 0) { // chip
    const b = new THREE.Mesh(s2.box, s.chipBody); b.scale.set(0.26, 0.035, 0.18); inner.add(b);
    const c = new THREE.Mesh(s2.box, s.chipCore); c.scale.set(0.12, 0.04, 0.08); inner.add(c);
    for (let i = 0; i < 6; i++) for (const sd of [-1, 1]) { const p = new THREE.Mesh(s2.box, s.pin); p.scale.set(0.018, 0.012, 0.03); p.position.set(-0.1 + i * 0.04, 0, sd * 0.1); inner.add(p); }
    g.userData.spin = true; g.userData.bob = true;
  } else if (kind === 1) { // dropped orbs
    color = 0xffa040; off = -0.3;
    [['cracker', -0.15, 0], ['timer', 0.1, -0.1], ['gas', 0.02, 0.14]].forEach(([t, x, z]) => { const o = makeOrbMesh(t); o.scale.setScalar(1.3); o.position.set(x, 0.1, z); inner.add(o); });
  } else { // cache
    color = 0xffd23c; off = -0.3;
    const b = new THREE.Mesh(s2.box, s.crate); b.scale.set(0.56, 0.3, 0.36); b.position.y = 0.15; inner.add(b);
    const st = new THREE.Mesh(s2.box, s.stripe); st.scale.set(0.58, 0.05, 0.38); st.position.y = 0.2; inner.add(st);
    const lid = new THREE.Mesh(s2.box, s2.shell); lid.scale.set(0.1, 0.05, 0.04); lid.position.set(0, 0.2, -0.19); inner.add(lid);
  }
  inner.position.y = off;
  // light column: two crossed planes
  const H = kind === 2 ? 9 : 7;
  const bm = new THREE.MeshBasicMaterial({ map: tex.beam, color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Group();
  for (let i = 0; i < 2; i++) { const p = new THREE.Mesh(s.plane, bm); p.scale.set(1, H, 1); p.rotation.y = i * Math.PI / 2; p.position.y = H / 2 - 0.4; beam.add(p); }
  g.add(beam);
  g.userData.beam = beam; g.userData.inner = inner; g.userData.kind = kind; g.userData.off = off; g.userData.beamMat = bm;
  return g;
}

export function updatePickup(g, t, cam) {
  const u = g.userData;
  if (u.spin) u.inner.rotation.y = t * 1.6;
  if (u.bob) u.inner.position.y = u.off + Math.sin(t * 2.2 + g.position.x) * 0.06;
  const d = Math.hypot(cam.x - g.position.x, cam.z - g.position.z);
  const vis = d < 60;
  u.beam.visible = vis;
  if (vis) u.beamMat.opacity = 0.55 * Math.min(1, (60 - d) / 25) * (0.8 + 0.2 * Math.sin(t * 3 + g.position.z));
}

// ----------------------------------------------------------------------------- avatar
let AV = null;
function avShared() {
  if (AV) return AV;
  AV = {
    box: new THREE.BoxGeometry(1, 1, 1),
    head: new THREE.SphereGeometry(0.115, 14, 10),
    hair: new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    band: new THREE.TorusGeometry(0.118, 0.014, 6, 18),
    orb: new THREE.SphereGeometry(0.038, 8, 6),
    canopy: new THREE.SphereGeometry(2.4, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    dome: new THREE.SphereGeometry(1.15, 20, 14),
    skin: new THREE.MeshStandardMaterial({ color: 0xd2a07a, roughness: 0.8 }),
    pants: new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.9 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.9 }),
    hairM: new THREE.MeshStandardMaterial({ color: 0x1b1612, roughness: 0.9 }),
    strap: new THREE.MeshStandardMaterial({ color: 0x241d16, roughness: 0.8 }),
    eye: new THREE.MeshBasicMaterial({ color: 0x0a0a0a }),
  };
  return AV;
}

function nameTexture(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 56;
  const x = c.getContext('2d');
  x.font = '600 28px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,0.75)'; x.strokeText(name, 128, 30);
  x.fillStyle = '#fff'; x.fillText(name, 128, 30);
  x.fillStyle = color; x.fillRect(48, 50, 160, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Avatar {
  constructor(color, name) {
    const A = avShared(), s2 = shared();
    this.color = color; this.name = name;
    const col = new THREE.Color(color);
    this.jacket = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.62), roughness: 0.85 });
    this.bandM = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: col, emissiveIntensity: 0.15 });
    this.canopyM = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85, side: THREE.DoubleSide });
    this.chipM = new THREE.MeshStandardMaterial({ color: 0x113333, emissive: 0x59ffd0, emissiveIntensity: 0.9 });
    const g = this.group = new THREE.Group();
    const root = this.root = new THREE.Group(); root.position.y = 0.9; g.add(root);
    const mesh = (geo, mat, sx, sy, sz, x, y, z, parent) => { const m = new THREE.Mesh(geo, mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = true; (parent || root).add(m); return m; };
    // legs (pivot at hip)
    this.legL = new THREE.Group(); this.legR = new THREE.Group();
    this.legL.position.set(-0.1, 0, 0); this.legR.position.set(0.1, 0, 0); root.add(this.legL, this.legR);
    for (const l of [this.legL, this.legR]) { mesh(A.box, A.pants, 0.17, 0.82, 0.2, 0, -0.41, 0, l); mesh(A.box, A.shoe, 0.18, 0.1, 0.3, 0, -0.85, -0.04, l); }
    // torso + bandolier
    mesh(A.box, this.jacket, 0.44, 0.6, 0.25, 0, 0.3, 0);
    const strap = mesh(A.box, A.strap, 0.07, 0.8, 0.02, 0, 0.32, -0.135); strap.rotation.z = 0.62;
    for (let i = 0; i < 6; i++) {
      const u = -0.3 + i * 0.12, o = new THREE.Mesh(A.orb, s2.bands[ORB_ORDER[i % 8]]); o.position.set(-Math.sin(0.62) * u + 0.02, 0.32 + Math.cos(0.62) * u, -0.15); o.castShadow = true; root.add(o);
    }
    mesh(A.box, A.pants, 0.45, 0.1, 0.26, 0, 0.02, 0); // belt/hips
    // head
    this.head = new THREE.Group(); this.head.position.set(0, 0.68, 0); root.add(this.head);
    mesh(A.head, A.skin, 1, 1, 1, 0, 0, 0, this.head);
    const hair = mesh(A.hair, A.hairM, 1, 1, 1, 0, 0.01, 0.015, this.head); hair.rotation.x = -0.25;
    const bnd = mesh(A.band, this.bandM, 1, 1, 1, 0, 0.05, 0, this.head); bnd.rotation.x = Math.PI / 2;
    mesh(A.box, A.eye, 0.03, 0.02, 0.01, -0.045, 0.0, -0.112, this.head); mesh(A.box, A.eye, 0.03, 0.02, 0.01, 0.045, 0.0, -0.112, this.head);
    // arms (pivot at shoulder)
    this.armL = new THREE.Group(); this.armR = new THREE.Group();
    this.armL.position.set(-0.28, 0.5, 0); this.armR.position.set(0.28, 0.5, 0); root.add(this.armL, this.armR);
    for (const a of [this.armL, this.armR]) { mesh(A.box, this.jacket, 0.13, 0.34, 0.13, 0, -0.17, 0, a); mesh(A.box, A.skin, 0.1, 0.26, 0.1, 0, -0.45, 0, a); }
    this.chip = mesh(A.box, this.chipM, 0.07, 0.012, 0.06, 0, -0.42, -0.055, this.armL); // chip on the back of the left hand
    // parachute
    const ch = this.chute = new THREE.Group(); ch.visible = false;
    const can = new THREE.Mesh(A.canopy, this.canopyM); can.scale.y = 0.55; can.position.y = 4.1; ch.add(can);
    const pts = [];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push(Math.cos(a) * 2.4, 4.1, Math.sin(a) * 2.4, (i % 2 ? 0.2 : -0.2), 1.45, 0); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    ch.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xdddddd })));
    g.add(ch);
    // shield
    this.dome = new THREE.Mesh(A.dome, new THREE.MeshBasicMaterial({ color: 0x6fffd0, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.dome.position.y = 0.95; this.dome.visible = false; g.add(this.dome);
    // name tag
    this.tagTex = nameTexture(name, color);
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false }));
    this.tag.scale.set(1.5, 0.33, 1); this.tag.position.y = 2.2; g.add(this.tag);
    this.phase = 0; this.speed = 0; this.px = null; this.pz = null; this.throwT = 9; this.sonarT = 9; this.lean = 0; this.t = Math.random() * 10;
  }
  triggerThrow() { this.throwT = 0; }
  triggerSonar() { this.sonarT = 0; }

  update(dt, x, y, z, yaw, pitch, fl, camPos) {
    const g = this.group;
    this.t += dt;
    if (this.px === null) { this.px = x; this.pz = z; }
    const sp = dt > 0 ? Math.hypot(x - this.px, z - this.pz) / dt : 0;
    this.speed += (Math.min(sp, 12) - this.speed) * Math.min(1, dt * 8); this.px = x; this.pz = z;
    g.position.set(x, y, z); g.rotation.y = yaw;
    const dead = fl & FLAGS.DEAD, drop = fl & FLAGS.DROP, swim = fl & FLAGS.SWIM, crouch = fl & FLAGS.CROUCH;
    this.chute.visible = !!drop && !dead;
    this.dome.visible = !!(fl & FLAGS.SHIELD) && !dead;
    if (this.dome.visible) this.dome.material.opacity = 0.17 + Math.sin(this.t * 6) * 0.05;
    this.throwT += dt; this.sonarT += dt;
    const k = Math.min(1, this.speed / 6);
    this.phase += dt * (3 + this.speed * 1.5);
    const sw = Math.sin(this.phase) * 0.85 * k;
    let rootY = 0.9, leanT = 0, rootRX = 0;
    this.legL.rotation.set(sw, 0, 0); this.legR.rotation.set(-sw, 0, 0);
    this.armL.rotation.set(-sw * 0.8, 0, 0.06); this.armR.rotation.set(sw * 0.8, 0, -0.06);
    if (crouch && !swim && !drop) { rootY = 0.55; this.legL.rotation.x = this.legR.rotation.x = 1.0 + sw * 0.4; this.legR.rotation.x = 1.0 - sw * 0.4; leanT = -0.25; }
    if (swim) { leanT = -1.25; rootY = 0.9; const c = this.t * 4 + this.speed; this.armL.rotation.set(-Math.sin(c) * 2.2 - 1.6, 0, 0); this.armR.rotation.set(Math.sin(c) * 2.2 - 1.6, 0, 0); this.legL.rotation.set(Math.sin(c * 1.6) * 0.4, 0, 0); this.legR.rotation.set(-Math.sin(c * 1.6) * 0.4, 0, 0); }
    if (drop) { this.legL.rotation.set(0.25 + Math.sin(this.t * 1.7) * 0.1, 0, 0.1); this.legR.rotation.set(0.15 + Math.cos(this.t * 1.5) * 0.1, 0, -0.1); this.armL.rotation.set(0, 0, -2.7); this.armR.rotation.set(0, 0, 2.7); this.chute.rotation.z = Math.sin(this.t * 0.9) * 0.06; }
    // right arm throw: wind back then fling
    if (this.throwT < 0.45 && !dead) { const u = this.throwT / 0.45; this.armR.rotation.set(u < 0.3 ? -2.4 * (u / 0.3) : -2.4 + 3.6 * ((u - 0.3) / 0.7), 0, -0.1); }
    // chip raised
    let glow = 0.9;
    if (this.sonarT < 2.4 && !dead) { const u = Math.min(1, this.sonarT / 0.25), d = Math.min(1, (2.4 - this.sonarT) / 0.3); this.armL.rotation.set(-1.45 * Math.min(u, d), 0, 0.35 * Math.min(u, d)); glow = 3 + Math.sin(this.t * 22) * 1.2; }
    this.chipM.emissiveIntensity = glow;
    if (dead) { leanT = Math.PI / 2; rootY = 0.14; this.legL.rotation.set(0.1, 0, 0.12); this.legR.rotation.set(0.05, 0, -0.12); this.armL.rotation.set(0.2, 0, 0.5); this.armR.rotation.set(0.3, 0, -0.5); }
    this.lean += (leanT - this.lean) * Math.min(1, dt * 10);
    this.root.rotation.x = this.lean; this.root.position.y += (rootY - this.root.position.y) * Math.min(1, dt * 12);
    this.head.rotation.x = dead ? 0 : Math.max(-0.9, Math.min(0.9, pitch)) * (swim ? 0.3 : 0.8);
    // name tag fades with distance
    const d = camPos ? Math.hypot(camPos.x - x, camPos.y - y, camPos.z - z) : 0;
    const a = dead ? 0 : Math.max(0, Math.min(1, (42 - d) / 12));
    this.tag.visible = a > 0.02; this.tag.material.opacity = a;
    this.tag.position.y = drop ? 2.4 : crouch ? 1.75 : 2.2;
  }

  dispose() {
    this.tagTex.dispose(); this.tag.material.dispose(); this.jacket.dispose(); this.bandM.dispose(); this.canopyM.dispose(); this.chipM.dispose(); this.dome.material.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

// ----------------------------------------------------------------------------- first-person viewmodel
export class Viewmodel {
  constructor(camera, radarCanvas) {
    const A = avShared();
    this.root = new THREE.Group(); camera.add(this.root);
    this.t = 0; this.bobAmp = 0; this.swing = 9; this.raise = 0; this.switchT = 1; this.type = null; this.orbMesh = null;
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x3c4a3e, roughness: 0.9 });
    const glove = new THREE.MeshStandardMaterial({ color: 0xd2a07a, roughness: 0.8 });
    const mk = (geo, mat, sx, sy, sz, x, y, z, p) => { const m = new THREE.Mesh(geo, mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.frustumCulled = false; p.add(m); return m; };
    // right arm
    this.R = new THREE.Group(); this.root.add(this.R);
    mk(A.box, sleeve, 0.1, 0.1, 0.46, 0, 0, 0.1, this.R);
    mk(A.box, glove, 0.085, 0.085, 0.14, 0, 0, -0.18, this.R);
    this.hand = new THREE.Group(); this.hand.position.set(0, 0.07, -0.3); this.R.add(this.hand);
    // left arm
    this.L = new THREE.Group(); this.root.add(this.L);
    mk(A.box, sleeve, 0.1, 0.1, 0.46, 0, 0, 0.1, this.L);
    mk(A.box, glove, 0.11, 0.07, 0.16, 0, 0, -0.18, this.L);
    this.chipM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 2.2, 1.9) });
    mk(A.box, this.chipM, 0.06, 0.012, 0.045, 0, 0.042, -0.1, this.L);
    this.screenTex = null;
    if (radarCanvas) {
      this.screenTex = new THREE.CanvasTexture(radarCanvas); this.screenTex.colorSpace = THREE.SRGBColorSpace;
      const sm = new THREE.MeshBasicMaterial({ map: this.screenTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.screen = new THREE.Mesh(new THREE.CircleGeometry(0.1, 36), sm); this.screen.rotation.x = -Math.PI / 2; this.screen.position.set(0, 0.17, -0.2); this.screen.frustumCulled = false; this.screen.renderOrder = 20; this.L.add(this.screen);
    }
    this.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  }

  setOrb(type) {
    if (type === this.type) return;
    this.type = type; this.switchT = 0;
    if (this.orbMesh) { this.hand.remove(this.orbMesh); this.orbMesh = null; }
    if (type) { const o = makeOrbMesh(type); o.scale.setScalar(1.5); o.traverse((m) => { m.frustumCulled = false; }); this.hand.add(o); this.orbMesh = o; }
  }
  triggerThrow() { this.swing = 0; }
  show(v) { this.root.visible = v; }

  // st: { speed, sprint, crouch, charge (0..1, <0 none), raise (0..1 left hand), air }
  update(dt, st, time) {
    this.t += dt;
    this.bobAmp += ((st.speed > 0.5 && !st.air ? Math.min(1, st.speed / 6) : 0) - this.bobAmp) * Math.min(1, dt * 8);
    const w = this.t * (st.sprint ? 12 : 8.5), bx = Math.sin(w * 0.5) * 0.012 * this.bobAmp, by = Math.abs(Math.sin(w * 0.5)) * 0.014 * this.bobAmp;
    this.switchT = Math.min(1, this.switchT + dt * 4.5);
    const sw = 1 - Math.pow(1 - this.switchT, 3);
    this.swing += dt;
    let rx = 0.25, py = -0.27 - (1 - sw) * 0.3, pz = -0.42 + (st.sprint ? 0.08 : 0), px = 0.26;
    const ch = Math.max(0, st.charge || 0);
    rx += ch * 0.9; pz += ch * 0.16; py += ch * 0.04;
    if (this.swing < 0.32) { const u = this.swing / 0.32, e = Math.sin(u * Math.PI); rx -= e * 1.3; pz -= e * 0.12; }
    this.R.position.set(px + bx, py + by + (st.crouch ? 0.01 : 0), pz); this.R.rotation.set(rx, 0.12, 0.05);
    this.raise += ((st.raise || 0) - this.raise) * Math.min(1, dt * 9);
    const r = this.raise;
    this.L.position.set(-0.3 + 0.1 * r + bx, -0.58 + 0.38 * r + by * (1 - r), -0.4 - 0.06 * r);
    this.L.rotation.set(0.25 + 0.7 * r, -0.05 - 0.1 * r, 0.1 + 0.2 * r);
    if (this.screen) this.screen.visible = r > 0.5;
    if (this.screenTex && r > 0.5) this.screenTex.needsUpdate = true;
    this.chipM.color.setRGB(0.35 + 0.8 * r, 2.2 + 1.5 * r * (0.7 + 0.3 * Math.sin(time * 20)), 1.9);
    if (this.orbMesh) { this.orbMesh.rotation.y += dt * 0.6; const u = this.orbMesh.userData; if (u.led) u.led.emissiveIntensity = 0.6 + Math.sin(time * 6) * 0.4; if (u.prop) u.prop.rotation.y += dt * 4; }
  }
}
