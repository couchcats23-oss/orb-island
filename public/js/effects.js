// Particle-based effects: explosions, gas clouds, fire lines, implosion pull, sonar rings, scorch decals.
import * as THREE from 'three';
import { S } from './settings.js';
import { heightAt, normalAt } from './terrain.js';
import { ORB } from './rules.js';

const STRIDE = 20;
const rnd = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const lerp = (a, b, t) => a + (b - a) * t;

class Particles {
  constructor(scene, max, map, additive) {
    this.max = max; this.n = 0;
    this.d = new Float32Array(max * STRIDE);
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3); this.aCol = new THREE.BufferAttribute(this.col, 4); this.aSize = new THREE.BufferAttribute(this.size, 1);
    for (const a of [this.aPos, this.aCol, this.aSize]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aColor', this.aCol); g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 800 } },
      vertexShader: `attribute float aSize; attribute vec4 aColor; varying vec4 vColor; uniform float uScale;
        void main(){ vColor = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 900.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uMap; varying vec4 vColor;
        void main(){ vec4 t = texture2D(uMap, gl_PointCoord); float a = vColor.a * t.a; if (a < 0.01) discard; gl_FragColor = vec4(vColor.rgb * t.rgb, a); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.pts = new THREE.Points(g, this.mat); this.pts.frustumCulled = false; this.pts.renderOrder = 5;
    scene.add(this.pts);
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, a0, grav = 0, drag = 0) {
    if (this.n >= this.max) return;
    const o = this.n++ * STRIDE, d = this.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = life; d[o + 7] = 0; d[o + 8] = s0; d[o + 9] = s1;
    d[o + 10] = c0[0]; d[o + 11] = c0[1]; d[o + 12] = c0[2]; d[o + 13] = c1[0]; d[o + 14] = c1[1]; d[o + 15] = c1[2];
    d[o + 16] = a0; d[o + 17] = grav; d[o + 18] = drag;
  }
  update(dt) {
    const d = this.d;
    let i = 0;
    while (i < this.n) {
      const o = i * STRIDE;
      d[o + 7] += dt;
      const age = d[o + 7], life = d[o + 6];
      if (age >= life) {
        const l = (--this.n) * STRIDE;
        if (l !== o) for (let k = 0; k < STRIDE; k++) d[o + k] = d[l + k];
        continue;
      }
      const drag = Math.exp(-d[o + 18] * dt);
      d[o + 3] *= drag; d[o + 4] = d[o + 4] * drag - d[o + 17] * dt; d[o + 5] *= drag;
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
      const t = age / life;
      this.pos[i * 3] = d[o]; this.pos[i * 3 + 1] = d[o + 1]; this.pos[i * 3 + 2] = d[o + 2];
      this.size[i] = lerp(d[o + 8], d[o + 9], t);
      this.col[i * 4] = lerp(d[o + 10], d[o + 13], t); this.col[i * 4 + 1] = lerp(d[o + 11], d[o + 14], t); this.col[i * 4 + 2] = lerp(d[o + 12], d[o + 15], t);
      this.col[i * 4 + 3] = d[o + 16] * Math.min(1, t * 10) * (1 - t);
      i++;
    }
    this.pts.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, camera, tex) {
    this.scene = scene; this.camera = camera; this.tex = tex;
    this.smoke = new Particles(scene, 2600, tex.smoke, false);
    this.fire = new Particles(scene, 1800, tex.fire, true);
    this.bits = new Particles(scene, 900, tex.dot, false);
    this.leaves = new Particles(scene, 500, tex.leafBit, false);
    this.shake = 0;
    this.rings = []; this.lights = []; this.decals = []; this.streaks = []; this.gas = new Map(); this.sucks = [];
    const flat = new THREE.PlaneGeometry(1, 1); flat.rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(flat, new THREE.MeshBasicMaterial({ map: tex.ring, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      m.visible = false; m.renderOrder = 4; m.frustumCulled = false; scene.add(m); this.rings.push({ m, t: 1, dur: 1, r: 1, op: 1 });
    }
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffa050, 0, 70, 2); l.userData = { t: 1, dur: 0.5, peak: 0 }; scene.add(l); this.lights.push(l);
    }
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(flat, new THREE.MeshBasicMaterial({ map: tex.scorch, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      m.visible = false; m.frustumCulled = false; scene.add(m); this.decals.push({ m, t: 0 });
    }
    this.decalIdx = 0; this.ringIdx = 0; this.lightIdx = 0;
  }

  q() { return [0.45, 0.75, 1][Math.max(0, Math.min(2, (S.effects || 3) - 1))]; }
  addShake(v) { this.shake = Math.min(1.2, Math.max(this.shake, v)); }

  ring(x, y, z, radius, dur, color = 0xffc080, opacity = 0.8, depth = true) {
    const r = this.rings[this.ringIdx++ % this.rings.length];
    r.t = 0; r.dur = dur; r.r = radius; r.op = opacity;
    r.m.position.set(x, y, z); r.m.visible = true; r.m.material.color.set(color); r.m.material.depthTest = depth; r.m.material.needsUpdate = true;
  }
  flash(x, y, z, color, peak, dur) {
    const l = this.lights[this.lightIdx++ % this.lights.length];
    l.position.set(x, y + 1.5, z); l.color.set(color); l.userData = { t: 0, dur, peak };
  }
  scorch(x, y, z, radius) {
    const d = this.decals[this.decalIdx++ % this.decals.length];
    const n = normalAt(x, z);
    d.m.position.set(x, y + 0.05, z);
    d.m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], n[1], n[2]));
    d.m.scale.set(radius * 2, 1, radius * 2); d.m.visible = true; d.t = 0; d.m.material.opacity = 1;
  }

  boom(kind, p) {
    const q = this.q();
    const size = { cracker: 1, timer: 1.35, implosion: 1.3, remote: 1.15, homing: 0.6, flame: 0.8, gas: 0.45 }[kind] || 1;
    const warm = kind === 'homing' ? [[0.7, 0.9, 1], [0.1, 0.3, 0.9]] : kind === 'implosion' ? [[0.85, 0.8, 1], [0.35, 0.2, 0.9]] : kind === 'remote' ? [[1, 0.55, 0.35], [0.7, 0.1, 0.05]] : [[1, 0.8, 0.4], [0.9, 0.25, 0.05]];
    const nF = Math.round(34 * size * q), nS = Math.round(30 * size * q), nB = Math.round(34 * size * q);
    for (let i = 0; i < nF; i++) {
      const a = rnd(6.283), up = rnd(0.2, 1), sp = rnd(2, 9) * size;
      this.fire.emit(p.x, p.y + 0.4, p.z, Math.cos(a) * sp * (1 - up * 0.4), up * sp * 1.1, Math.sin(a) * sp * (1 - up * 0.4), rnd(0.35, 0.9), rnd(1.5, 2.6) * size, rnd(3, 5) * size, warm[0], warm[1], 0.95, 0, 2.2);
    }
    for (let i = 0; i < nS; i++) {
      const a = rnd(6.283), sp = rnd(1, 6) * size, g = rnd(0.12, 0.28);
      this.smoke.emit(p.x, p.y + 0.5, p.z, Math.cos(a) * sp, rnd(2, 6) * size, Math.sin(a) * sp, rnd(2.5, 5), rnd(2, 3.5) * size, rnd(6, 10) * size, [g, g, g * 0.95], [g * 1.3, g * 1.3, g * 1.3], 0.7, -0.4, 1.4);
    }
    for (let i = 0; i < nB; i++) {
      const a = rnd(6.283), sp = rnd(5, 18) * size, up = rnd(4, 14) * size;
      this.bits.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * sp, up, Math.sin(a) * sp, rnd(0.8, 2), rnd(0.12, 0.3), 0.1, [0.25, 0.2, 0.15], [0.12, 0.1, 0.08], 1, 22, 0.2);
    }
    if (kind === 'implosion') {
      for (let i = 0; i < 50 * q; i++) { const a = rnd(6.283), sp = rnd(8, 22); this.smoke.emit(p.x, p.y + 0.5, p.z, Math.cos(a) * sp, rnd(0.5, 4), Math.sin(a) * sp, rnd(1.5, 3.5), rnd(2, 3), rnd(7, 11), [0.3, 0.26, 0.2], [0.5, 0.45, 0.38], 0.7, 0, 1.8); }
    }
    const R = ORB[kind] && ORB[kind].blast ? ORB[kind].blast : 5;
    this.ring(p.x, p.y + 0.3, p.z, R * 1.6, 0.55, kind === 'implosion' ? 0xaaa0ff : 0xffd0a0, 0.9);
    this.flash(p.x, p.y, p.z, kind === 'homing' ? 0x80c0ff : kind === 'implosion' ? 0xb0a0ff : 0xffa050, 260 * size, 0.55);
    if (kind !== 'gas') this.scorch(p.x, heightAt(p.x, p.z), p.z, (ORB[kind] && ORB[kind].blast ? ORB[kind].blast : 4) * 0.55);
    const d = Math.hypot(p.x - this.camera.position.x, p.y - this.camera.position.y, p.z - this.camera.position.z);
    this.addShake(Math.max(0, 1 - d / (60 * size)) * 0.9 * size);
  }

  treeBurst(t) {
    const n = Math.round(14 * this.q());
    for (let i = 0; i < n; i++) {
      const a = rnd(6.283), sp = rnd(1, 5);
      this.leaves.emit(t.x + rnd(-1.5, 1.5), t.y + t.hgt * rnd(0.6, 1), t.z + rnd(-1.5, 1.5), Math.cos(a) * sp, rnd(0, 4), Math.sin(a) * sp, rnd(2, 4), rnd(0.35, 0.6), 0.3, [0.7, 1, 0.6], [0.5, 0.7, 0.3], 1, 3, 0.8);
    }
    this.bits.emit(t.x, t.y + 1, t.z, 0, 2, 0, 1, 0.3, 0.1, [0.3, 0.2, 0.1], [0.2, 0.15, 0.1], 1, 6, 0.5);
  }

  sonarRing(x, y, z, radius) { this.ring(x, y + 0.4, z, radius * 2, 1.7, 0x78ffdc, 0.5, false); }

  // gas clouds mirror server snapshot entries [id,x,y,z,r,age]
  syncGas(list, dt) {
    const seen = new Set();
    for (const [id, x, y, z, r, age] of list) {
      seen.add(id);
      let c = this.gas.get(id);
      if (!c) { c = { x, y, z, r, age, acc: 0 }; this.gas.set(id, c); }
      c.x = x; c.y = y; c.z = z; c.r = r; c.age = age;
    }
    for (const id of [...this.gas.keys()]) if (!seen.has(id)) this.gas.delete(id);
  }
  _updateGas(dt) {
    for (const c of this.gas.values()) {
      c.acc += dt * c.r * c.r * 0.9 * this.q();
      while (c.acc > 1) {
        c.acc -= 1;
        const a = rnd(6.283), rr = Math.sqrt(Math.random()) * c.r * 0.9, x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
        const y = Math.max(c.y, heightAt(x, z)) + rnd(0.3, 3.2);
        const hot = Math.random() < 0.28;
        this.smoke.emit(x, y, z, rnd(-0.4, 0.4), rnd(0.1, 0.7), rnd(-0.4, 0.4), rnd(2.2, 3.6), rnd(3, 4.5), rnd(6.5, 9), hot ? [0.95, 0.55, 0.2] : [0.55, 0.45, 0.2], [0.35, 0.28, 0.15], hot ? 0.34 : 0.28, 0, 0.3);
        if (hot) this.fire.emit(x, y, z, rnd(-0.5, 0.5), rnd(0.2, 1), rnd(-0.5, 0.5), rnd(0.5, 1.1), rnd(0.8, 1.6), rnd(2, 3), [1, 0.6, 0.2], [0.8, 0.1, 0.02], 0.45, 0, 0.5);
      }
    }
  }

  // flame cross: 4 streaks of fire
  addStreaks(x, y, z, base, life) {
    for (let i = 0; i < 4; i++) {
      const a = base + i * Math.PI / 2;
      this.streaks.push({ x, y, z, ax: Math.cos(a), az: Math.sin(a), age: 0, life, acc: 0 });
    }
  }
  _updateStreaks(dt) {
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.age += dt;
      if (s.age >= s.life) { this.streaks.splice(i, 1); continue; }
      const len = Math.min(1, s.age / 0.6) * ORB.flame.len, fade = Math.min(1, (s.life - s.age) / 1.5);
      s.acc += dt * len * 5 * this.q() * fade;
      while (s.acc > 1) {
        s.acc -= 1;
        const t = Math.random() * len, x = s.x + s.ax * t + rnd(-0.6, 0.6), z = s.z + s.az * t + rnd(-0.6, 0.6), y = heightAt(x, z);
        this.fire.emit(x, y + 0.2, z, rnd(-0.3, 0.3), rnd(1.2, 3.2), rnd(-0.3, 0.3), rnd(0.5, 1.0), rnd(0.9, 1.5), rnd(0.3, 0.8), [1, 0.78, 0.35], [0.9, 0.2, 0.03], 0.85, 0, 0.5);
        if (Math.random() < 0.3) this.smoke.emit(x, y + 1, z, rnd(-0.3, 0.3), rnd(1, 2.5), rnd(-0.3, 0.3), rnd(1.5, 2.5), 1.2, 3.4, [0.15, 0.13, 0.12], [0.25, 0.23, 0.2], 0.4, -0.2, 0.5);
      }
    }
  }

  // implosion: dust and glow pulled inward
  implosionSuck(x, y, z, dur) { this.sucks.push({ x, y, z, age: 0, dur, acc: 0 }); }
  _updateSucks(dt) {
    for (let i = this.sucks.length - 1; i >= 0; i--) {
      const s = this.sucks[i];
      s.age += dt;
      if (s.age >= s.dur) { this.sucks.splice(i, 1); continue; }
      s.acc += dt * 70 * this.q();
      while (s.acc > 1) {
        s.acc -= 1;
        const a = rnd(6.283), el = rnd(-0.2, 1.2), rr = rnd(5, ORB.implosion.pull), x = s.x + Math.cos(a) * rr, z = s.z + Math.sin(a) * rr, y = Math.max(heightAt(x, z), s.y - 1) + el * 3;
        const dx = s.x - x, dy = s.y - y, dz = s.z - z, l = Math.hypot(dx, dy, dz) || 1, sp = rr * 1.9;
        const dust = Math.random() < 0.5;
        (dust ? this.smoke : this.fire).emit(x, y, z, dx / l * sp, dy / l * sp, dz / l * sp, rr / sp, dust ? 1.4 : 0.9, 0.2, dust ? [0.45, 0.4, 0.32] : [0.7, 0.65, 1], dust ? [0.3, 0.27, 0.22] : [0.3, 0.2, 0.9], dust ? 0.5 : 0.7, 0, 0);
      }
    }
  }

  update(dt, camera, renderer) {
    const h = renderer.domElement.height, fov = camera.fov * Math.PI / 180, scale = h / (2 * Math.tan(fov / 2));
    for (const p of [this.smoke, this.fire, this.bits, this.leaves]) { p.mat.uniforms.uScale.value = scale; p.update(dt); }
    this._updateGas(dt); this._updateStreaks(dt); this._updateSucks(dt);
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.t += dt;
      const t = r.t / r.dur;
      if (t >= 1) { r.m.visible = false; continue; }
      const e = 1 - Math.pow(1 - t, 2.2);
      r.m.scale.set(r.r * e + 0.1, 1, r.r * e + 0.1); r.m.material.opacity = r.op * (1 - t);
    }
    for (const l of this.lights) {
      const u = l.userData; u.t += dt;
      l.intensity = u.t >= u.dur ? 0 : u.peak * Math.pow(1 - u.t / u.dur, 2);
    }
    for (const d of this.decals) {
      if (!d.m.visible) continue;
      d.t += dt;
      if (d.t > 50) { d.m.material.opacity = Math.max(0, 1 - (d.t - 50) / 10); if (d.t > 60) d.m.visible = false; }
    }
    this.shake = Math.max(0, this.shake - dt * 1.8);
  }
}
