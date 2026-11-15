// Island renderer: chunked LOD terrain, instanced forests, grass, ocean, sky, landmarks.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  WORLD, heightAt, forestAt, detailNoise, patchNoise, getChunk, getPOIs, decodeTreeId, destroyTrees as terrainDestroyTrees,
  smoothstep, lerp, wind,
} from './terrain.js';
import { S } from './settings.js';
import { mulberry32 } from './rules.js';

const CH = WORLD.chunk;
const FOG_COLOR = new THREE.Color(0xb3cade);
const HM_RES = 640, HM_HALF = 1400;

const PAL = {
  grassLush: new THREE.Color('#4f8a2a'), grassDry: new THREE.Color('#8b9a43'), jungle: new THREE.Color('#2a5120'),
  dirt: new THREE.Color('#5d4a30'), sand: new THREE.Color('#d9c89a'), wet: new THREE.Color('#9d8f68'),
  rock: new THREE.Color('#6d6a63'), rockHi: new THREE.Color('#9a978f'), moss: new THREE.Color('#3f5b2b'), seabed: new THREE.Color('#bdb48b'),
};
const mixc = (a, b, t) => [lerp(a[0], b.r, t), lerp(a[1], b.g, t), lerp(a[2], b.b, t)];

function groundColor(h, slope, f, x, z, out) {
  const pn = patchNoise(x, z) * 0.5 + 0.5, dn = detailNoise(x, z) * 0.5 + 0.5;
  const t = smoothstep(0.35, 0.7, pn);
  let c = [lerp(PAL.grassDry.r, PAL.grassLush.r, t), lerp(PAL.grassDry.g, PAL.grassLush.g, t), lerp(PAL.grassDry.b, PAL.grassLush.b, t)];
  c = mixc(c, PAL.jungle, f * 0.92);
  c = mixc(c, PAL.dirt, smoothstep(0.66, 0.82, pn) * 0.55 * (0.4 + f));
  const bt = 1 - smoothstep(1.5, 3.6, h + (dn - 0.5) * 1.2);
  c = mixc(c, PAL.sand, bt);
  c = mixc(c, PAL.wet, (1 - smoothstep(0.1, 0.9, h)) * bt);
  if (h < 0) c = mixc(c, PAL.seabed, 1);
  const rt = smoothstep(0.5, 0.95, slope);
  const mossy = (1 - smoothstep(25, 60, h)) * 0.45 * (1 - rt);
  let rc = mixc([PAL.rock.r, PAL.rock.g, PAL.rock.b], PAL.moss, mossy);
  c = [lerp(c[0], rc[0], rt), lerp(c[1], rc[1], rt), lerp(c[2], rc[2], rt)];
  c = mixc(c, PAL.rockHi, smoothstep(62, 98, h) * 0.75);
  const bv = 0.82 + dn * 0.36;
  out[0] = c[0] * bv; out[1] = c[1] * bv; out[2] = c[2] * bv;
}

function scaleBoxUV(g, w, h, d, t = 2) {
  const uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / t, uv.getY(i) * dims[f][1] / t); }
}
function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

export class World {
  constructor(scene, renderer, camera, tex) {
    this.scene = scene; this.renderer = renderer; this.camera = camera; this.tex = tex;
    this.chunks = new Map(); this.empty = new Set(); this.deadTrees = new Set();
    this.time = 0; this.grassTiles = new Map(); this.grassPos = new THREE.Vector3(1e9, 0, 1e9); this.grassDirty = true;
    this.windU = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) } };
    this.lamps = [];
    this._initLighting(); this._initSky(); this._initMaterials(); this._initGeometries();
    this._initOcean(); this._initPOIs(); this._initClouds(); this._initGrass();
    this.applySettings();
  }

  // ------------------------------------------------------------------ setup
  _initLighting() {
    const el = 32 * Math.PI / 180, az = 215 * Math.PI / 180;
    this.sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x55633a, 1.25);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.6);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.35;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.002);
  }

  _initSky() {
    const sky = new Sky();
    sky.scale.setScalar(3000); sky.frustumCulled = false; sky.renderOrder = -10;
    const u = sky.material.uniforms;
    u.turbidity.value = 5; u.rayleigh.value = 1.5; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(this.sunDir);
    this.sky = sky; this.scene.add(sky);
  }

  addWind(mat, amp, hs) {
    const U = this.windU;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime; sh.uniforms.uWind = U.uWind;
      sh.vertexShader = 'uniform float uTime;\nuniform vec2 uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float sway = sin(uTime * 1.4 + ip.x * 0.07 + ip.z * 0.05 + position.y * 0.35) * ${amp.toFixed(3)} * clamp(position.y * ${hs.toFixed(3)}, 0.0, 1.0);
        sway += sin(uTime * 3.1 + ip.x * 0.31 + position.y) * ${(amp * 0.25).toFixed(3)} * clamp(position.y * ${hs.toFixed(3)}, 0.0, 1.0);
        transformed.x += sway * uWind.x;
        transformed.z += sway * uWind.y;`);
    };
    mat.customProgramCacheKey = () => `wind${amp}_${hs}`;
  }

  _initMaterials() {
    const T = this.tex;
    this.matTerrain = new THREE.MeshStandardMaterial({ vertexColors: true, map: T.detail, roughness: 0.97, metalness: 0, side: THREE.DoubleSide });
    this.matTree = new THREE.MeshStandardMaterial({ map: T.treeAtlas, vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.92 });
    this.addWind(this.matTree, 0.16, 0.08);
    this.matGrass = new THREE.MeshStandardMaterial({ map: T.grass, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 1, color: 0xe8ffd8 });
    this.addWind(this.matGrass, 0.22, 1.6);
    this.matFern = new THREE.MeshStandardMaterial({ map: T.fern, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 1 });
    this.addWind(this.matFern, 0.18, 1.0);
    this.matRock = new THREE.MeshStandardMaterial({ map: T.stone, vertexColors: true, roughness: 1 });
    const std = (map, rough = 0.9, metal = 0) => new THREE.MeshStandardMaterial({ map, roughness: rough, metalness: metal });
    this.matPoi = {
      wood: std(T.wood), concrete: std(T.concrete), rust: std(T.rust, 0.8, 0.3), metal: std(T.metal, 0.55, 0.6), stone: std(T.stone), tent: std(T.tent),
    };
  }

  _initGeometries() {
    const rnd = mulberry32(4242);
    const cellUV = (g, i) => { const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 4); return g; };
    const color = (g, r, gg, b) => { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = gg; a[i * 3 + 2] = b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
    const ni = (g) => (g.index ? g.toNonIndexed() : g);
    const Z = new THREE.Vector3(0, 0, 1), ONE = new THREE.Vector3(1, 1, 1);
    const cluster = (cx, cy, cz, rad, count, size, cell, tint) => {
      const list = [];
      for (let i = 0; i < count; i++) {
        const ox = (rnd() - 0.5) * 2, oy = (rnd() - 0.5) * 2, oz = (rnd() - 0.5) * 2;
        const dir = new THREE.Vector3(ox, oy * 0.8 + 0.35, oz).normalize();
        const off = dir.clone().multiplyScalar(rad * (0.45 + rnd() * 0.45));
        const q = new THREE.Quaternion().setFromUnitVectors(Z, dir);
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, rnd() * 6.283));
        const g = new THREE.PlaneGeometry(size * (0.8 + rnd() * 0.4), size * (0.8 + rnd() * 0.4));
        g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(cx + off.x, cy + off.y * 0.85, cz + off.z), q, ONE));
        cellUV(g, cell);
        const t = tint * (0.8 + rnd() * 0.4);
        color(g, t * (0.9 + rnd() * 0.2), t, t * (0.8 + rnd() * 0.2));
        list.push(ni(g));
      }
      return list;
    };
    const core = (x, y, z, r) => { const g = new THREE.IcosahedronGeometry(r, 1); g.translate(x, y, z); cellUV(g, 0); color(g, 0.55, 0.95, 0.5); return ni(g); }; // opaque (bark cell) so the canopy has no see-through holes
    const trunk = (rt, rb, h, seg, hs) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg, hs, true); g.translate(0, h / 2, 0); cellUV(g, 0); color(g, 0.95, 0.9, 0.88); return ni(g); };
    const merge = (list) => mergeGeometries(list, false);

    // broadleaf jungle tree
    const bl = (hi) => {
      const L = [trunk(0.2, 0.46, 8.6, hi ? 8 : 5, hi ? 3 : 1)];
      if (hi) {
        L.push(...cluster(0, 9.4, 0, 3.4, 11, 3.3, 1, 1.15), ...cluster(2.2, 8.1, 0.7, 2.5, 8, 3.0, 1, 1.05), ...cluster(-1.9, 8.5, -1.2, 2.6, 8, 3.0, 1, 1.1), ...cluster(0.4, 10.9, 0.3, 2.1, 7, 2.8, 1, 1.2));
        L.push(core(0, 9.2, 0, 2.0, 1), core(1.2, 8.3, 0.4, 1.4, 1));
      } else {
        L.push(...cluster(0, 9.2, 0, 3.8, 9, 4.4, 1, 1.12), ...cluster(1.5, 8.2, 0.4, 2.8, 5, 4.0, 1, 1.05));
        L.push(core(0, 9.1, 0, 2.3, 1));
      }
      return merge(L);
    };
    // palm
    const palm = (hi) => {
      const g = new THREE.CylinderGeometry(0.13, 0.25, 7, hi ? 7 : 5, hi ? 8 : 3, true);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const t = (p.getY(i) + 3.5) / 7; p.setX(i, p.getX(i) + 1.3 * t * t); p.setY(i, p.getY(i) + 3.5); }
      cellUV(g, 0); color(g, 0.95, 0.9, 0.85);
      const L = [ni(g)];
      const n = hi ? 9 : 6;
      for (let i = 0; i < n; i++) {
        const f = new THREE.PlaneGeometry(1.2, 4.6, 1, 5);
        const fp = f.attributes.position;
        for (let k = 0; k < fp.count; k++) { const y = fp.getY(k) + 2.3, t = y / 4.6; fp.setY(k, y); fp.setZ(k, fp.getZ(k) - t * t * 1.9); }
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, i / n * 6.283 + (i % 2) * 0.2, 0, 'YXZ'));
        f.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(1.3, 6.9, 0), q, ONE));
        cellUV(f, 2);
        const t = 0.9 + rnd() * 0.3; color(f, t * 0.95, t, t * 0.85);
        L.push(ni(f));
      }
      return merge(L);
    };
    // bush
    const bush = () => { const L = [...cluster(0, 0.55, 0, 0.8, 8, 1.5, 3, 1.1), core(0, 0.45, 0, 0.45, 3)]; return merge(L); };
    this.geo = { tree: { 0: { hi: bl(true), lo: bl(false) }, 1: { hi: palm(true), lo: palm(false) }, 2: { hi: bush(), lo: bush() } } };

    // rock
    {
      const g = new THREE.IcosahedronGeometry(1, 2);
      const p = g.attributes.position, n = p.count, cols = new Float32Array(n * 3);
      const hash = (x, y, z) => { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s); };
      for (let i = 0; i < n; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const d = 0.78 + 0.35 * hash(Math.round(x * 3), Math.round(y * 3), Math.round(z * 3)) + 0.12 * Math.sin(x * 4 + z * 3);
        p.setXYZ(i, x * d, y * d * (y < 0 ? 0.5 : 1), z * d);
        const v = 0.6 + hash(Math.round(x * 5), Math.round(z * 5), 1) * 0.4;
        cols[i * 3] = v; cols[i * 3 + 1] = v * 0.97; cols[i * 3 + 2] = v * 0.93;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      g.computeVertexNormals();
      this.geo.rock = g;
    }
    // grass + fern
    {
      const quad = (w, h, ry, tilt = 0) => { const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); g.rotateX(tilt); g.rotateY(ry); return g; };
      this.geo.grass = merge([quad(1.0, 0.75, 0), quad(1.0, 0.75, Math.PI / 2), quad(1.0, 0.75, Math.PI / 4)].map(ni));
      this.geo.fern = merge([quad(1.7, 1.2, 0, -0.45), quad(1.7, 1.2, 2.1, -0.45), quad(1.7, 1.2, 4.2, -0.45)].map(ni));
    }
  }

  _initGrass() {
    this.grassMesh = new THREE.InstancedMesh(this.geo.grass, this.matGrass, 1);
    this.fernMesh = new THREE.InstancedMesh(this.geo.fern, this.matFern, 1);
    for (const m of [this.grassMesh, this.fernMesh]) { m.frustumCulled = false; m.count = 0; m.receiveShadow = true; this.scene.add(m); }
  }

  _initOcean() {
    this.hmData = new Uint8Array(HM_RES * HM_RES * 4);
    for (let i = 0; i < HM_RES * HM_RES; i++) { this.hmData[i * 4] = 0; this.hmData[i * 4 + 3] = 255; }
    this.hmTex = new THREE.DataTexture(this.hmData, HM_RES, HM_RES, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.hmTex.minFilter = this.hmTex.magFilter = THREE.LinearFilter;
    this.hmTex.wrapS = this.hmTex.wrapT = THREE.ClampToEdgeWrapping;
    this.hmTex.generateMipmaps = false; this.hmTex.needsUpdate = true;
    this.oceanU = {
      uTime: { value: 0 }, uCenter: { value: new THREE.Vector2() }, uHalf: { value: 320 },
      uNormal: { value: this.tex.waterNormal }, uHeight: { value: this.hmTex },
      uSunDir: { value: this.sunDir }, uSunColor: { value: new THREE.Color(1.0, 0.88, 0.7) },
      uFogColor: { value: FOG_COLOR }, uFogDen: { value: 0.002 },
      uHorizon: { value: new THREE.Color(0.66, 0.79, 0.92) }, uZenith: { value: new THREE.Color(0.16, 0.36, 0.7) },
      uQuality: { value: 2 },
    };
    const vert = `
      uniform float uTime; uniform vec2 uCenter; uniform float uHalf; uniform float uDisp;
      varying vec3 vWorld;
      float wv(vec2 p, vec2 d, float f, float s, float a){ return sin(dot(p, d) * f + uTime * s) * a; }
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 p = wp.xz;
        float e = max(abs(p.x - uCenter.x), abs(p.y - uCenter.y)) / uHalf;
        float fade = (1.0 - smoothstep(0.7, 1.0, e)) * uDisp;
        float h = wv(p, normalize(vec2(1.0, 0.3)), 0.045, 1.1, 0.34) + wv(p, normalize(vec2(-0.4, 1.0)), 0.07, 1.4, 0.2) + wv(p, normalize(vec2(0.7, -0.9)), 0.13, 1.9, 0.1);
        wp.y += h * fade;
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`;
    const frag = `
      uniform sampler2D uNormal; uniform sampler2D uHeight; uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor;
      uniform vec3 uFogColor; uniform float uFogDen; uniform vec3 uHorizon; uniform vec3 uZenith; uniform float uQuality;
      varying vec3 vWorld;
      void main(){
        vec3 V = normalize(cameraPosition - vWorld);
        vec2 uv1 = vWorld.xz * 0.043 + vec2(uTime * 0.012, uTime * 0.007);
        vec3 n1 = texture2D(uNormal, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = vec3(0.0);
        if (uQuality > 0.5) { vec2 uv2 = vWorld.xz * 0.11 - vec2(uTime * 0.02, -uTime * 0.013); n2 = texture2D(uNormal, uv2).xyz * 2.0 - 1.0; }
        vec3 N = normalize(vec3((n1.x + n2.x) * 0.5, 1.0, (n1.y + n2.y) * 0.5));
        vec2 huv = (vWorld.xz + ${HM_HALF.toFixed(1)}) / ${(HM_HALF * 2).toFixed(1)};
        float hv = texture2D(uHeight, huv).r * 100.0 - 60.0;
        float depth = max(0.0, -hv);
        vec3 col = mix(vec3(0.07, 0.58, 0.60), vec3(0.02, 0.32, 0.46), smoothstep(0.0, 6.0, depth));
        col = mix(col, vec3(0.012, 0.085, 0.19), smoothstep(4.0, 48.0, depth));
        vec3 R = reflect(-V, N);
        float fr = pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.92 + 0.035;
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.45));
        col = mix(col, sky, fr);
        col += uSunColor * pow(max(dot(R, normalize(uSunDir)), 0.0), 380.0) * 3.0;
        if (uQuality > 0.5) {
          float band = sin(depth * 5.0 - uTime * 1.3 + (n1.x + n2.y) * 4.0) * 0.5 + 0.5;
          float foam = smoothstep(0.55, 1.0, band) * (1.0 - smoothstep(0.0, 2.8, depth)) * step(0.001, depth);
          foam += (1.0 - smoothstep(0.0, 0.4, depth)) * 0.85;
          col = mix(col, vec3(0.96, 0.98, 1.0), clamp(foam, 0.0, 1.0) * 0.85);
        } else {
          col = mix(col, vec3(0.96, 0.98, 1.0), (1.0 - smoothstep(0.0, 0.8, depth)) * 0.6);
        }
        float d = length(cameraPosition - vWorld);
        float ff = 1.0 - exp(-pow(d * uFogDen, 2.0));
        col = mix(col, uFogColor, ff);
        gl_FragColor = vec4(col, 1.0);
      }`;
    this.matOceanIn = new THREE.ShaderMaterial({ uniforms: { ...this.oceanU, uDisp: { value: 1 } }, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
    this.matOceanOut = new THREE.ShaderMaterial({ uniforms: { ...this.oceanU, uDisp: { value: 0 } }, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
    this.ocean = new THREE.Group();
    this.oceanIn = new THREE.Mesh(new THREE.BufferGeometry(), this.matOceanIn);
    this.oceanOut = new THREE.Mesh(new THREE.BufferGeometry(), this.matOceanOut);
    this.oceanIn.frustumCulled = false; this.oceanOut.frustumCulled = false;
    this.ocean.add(this.oceanIn, this.oceanOut); this.scene.add(this.ocean);
    this.oceanSeg = 0;
  }

  _buildOceanGeo(seg) {
    if (this.oceanSeg === seg) return;
    this.oceanSeg = seg;
    const INNER = 640, H = INNER / 2, B = 9000;
    this.oceanStep = INNER / seg;
    this.oceanIn.geometry.dispose(); this.oceanOut.geometry.dispose();
    const g = new THREE.PlaneGeometry(INNER, INNER, seg, seg); g.rotateX(-Math.PI / 2);
    this.oceanIn.geometry = g;
    const sh = new THREE.Shape();
    sh.moveTo(-B, -B); sh.lineTo(B, -B); sh.lineTo(B, B); sh.lineTo(-B, B); sh.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-H, -H); hole.lineTo(-H, H); hole.lineTo(H, H); hole.lineTo(H, -H); hole.closePath();
    sh.holes.push(hole);
    const og = new THREE.ShapeGeometry(sh); og.rotateX(-Math.PI / 2);
    this.oceanOut.geometry = og;
    this.oceanU.uHalf.value = H;
    this.matOceanIn.uniforms.uHalf = this.oceanU.uHalf;
  }

  async init(progress = () => {}) {
    // sample the island height field into a texture so the water shader can colour by depth & draw shore foam
    const step = (HM_HALF * 2) / HM_RES;
    for (let j = 0; j < HM_RES; j++) {
      const z = -HM_HALF + (j + 0.5) * step;
      for (let i = 0; i < HM_RES; i++) {
        const x = -HM_HALF + (i + 0.5) * step;
        const h = Math.max(-60, Math.min(40, heightAt(x, z)));
        this.hmData[(j * HM_RES + i) * 4] = Math.round((h + 60) / 100 * 255);
      }
      if (j % 20 === 19) { progress(j / HM_RES); await new Promise((r) => setTimeout(r, 0)); }
    }
    this.hmTex.needsUpdate = true;
    progress(1);
  }

  _initPOIs() {
    this.poiGroup = new THREE.Group(); this.scene.add(this.poiGroup);
    for (const poi of getPOIs()) {
      const by = new Map();
      for (const part of poi.parts) {
        let g;
        if (part.s === 'box') { g = new THREE.BoxGeometry(part.w, part.h, part.d); scaleBoxUV(g, part.w, part.h, part.d); }
        else if (part.s === 'cyly') { g = new THREE.CylinderGeometry(part.w / 2, part.w / 2, part.h, 14); scaleUV(g, Math.PI * part.w / 2, part.h / 2); }
        else if (part.s === 'cylx') { g = new THREE.CylinderGeometry(part.h / 2, part.h / 2, part.w, 18); scaleUV(g, Math.PI * part.h / 2, part.w / 2); g.rotateZ(Math.PI / 2); }
        else { g = new THREE.ConeGeometry(part.w / 2, part.h, 14); scaleUV(g, Math.PI * part.w / 2, part.h / 2); }
        g.translate(part.cx, part.cy, part.cz);
        if (part.emit) {
          const mat = part.mat === 'redlamp' ? new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.15, 0.1) }) : new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff6a1a, emissiveIntensity: 1.8 });
          const m = new THREE.Mesh(g, mat); this.poiGroup.add(m);
          if (part.mat === 'redlamp') this.lamps.push(m);
          continue;
        }
        if (!by.has(part.mat)) by.set(part.mat, []);
        by.get(part.mat).push(g);
      }
      for (const [name, arr] of by) {
        const m = new THREE.Mesh(mergeGeometries(arr, false), this.matPoi[name] || this.matPoi.concrete);
        m.castShadow = true; m.receiveShadow = true;
        this.poiGroup.add(m);
      }
    }
  }

  _initClouds() {
    this.clouds = new THREE.Group(); this.scene.add(this.clouds);
    const rnd = mulberry32(99);
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.tex.cloud, transparent: true, opacity: 0.55 + rnd() * 0.35, fog: false, depthWrite: false });
      const s = new THREE.Sprite(mat);
      const a = rnd() * 6.283, r = 600 + rnd() * 2400;
      s.position.set(Math.cos(a) * r, 520 + rnd() * 380, Math.sin(a) * r);
      s.scale.set(900 + rnd() * 900, 380 + rnd() * 300, 1);
      this.clouds.add(s);
    }
  }

  // --------------------------------------------------------------- settings
  applySettings() {
    const r = this.renderer;
    const fog = this.scene.fog;
    fog.density = 1.7 / S.drawDist;
    this.oceanU.uFogDen.value = fog.density;
    this.oceanU.uQuality.value = S.water === 0 ? 0 : 1;
    this._buildOceanGeo([40, 100, 180][S.water] || 100);
    r.shadowMap.enabled = S.shadows > 0;
    r.shadowMap.type = S.shadows >= 2 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = S.shadows > 0;
    const size = [512, 1024, 2048, 4096][S.shadows] || 1024;
    const sh = this.sun.shadow, d = S.shadowDist;
    sh.mapSize.set(size, size);
    if (sh.map) { sh.map.dispose(); sh.map = null; }
    sh.camera.left = -d; sh.camera.right = d; sh.camera.top = d; sh.camera.bottom = -d;
    sh.camera.near = 10; sh.camera.far = 700; sh.camera.updateProjectionMatrix();
    this.maxGrass = [0, 3500, 8000, 15000][S.grass] || 0;
    this.grassDist = [0, 28, 42, 58][S.grass] || 0;
    this.grassMesh.visible = this.fernMesh.visible = S.grass > 0;
    if (this.grassMesh.instanceMatrix.count < this.maxGrass) {
      for (const k of ['grassMesh', 'fernMesh']) {
        const old = this[k]; this.scene.remove(old); old.dispose();
        const m = new THREE.InstancedMesh(k === 'grassMesh' ? this.geo.grass : this.geo.fern, k === 'grassMesh' ? this.matGrass : this.matFern, Math.max(1, this.maxGrass));
        m.frustumCulled = false; m.count = 0; m.receiveShadow = true; this.scene.add(m); this[k] = m;
      }
    }
    this.grassDirty = true;
    for (const ch of this.chunks.values()) { ch.lodForce = true; ch.dirty = true; }
  }

  // ---------------------------------------------------------------- terrain
  _terrainGeom(cx, cz, seg) {
    const n = seg + 1, step = CH / seg, x0 = cx * CH, z0 = cz * CH, m = n + 2;
    const hs = new Float32Array(m * m);
    let maxH = -1e9;
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) {
      const h = heightAt(x0 + i * step, z0 + j * step);
      hs[(j + 1) * m + (i + 1)] = h;
      if (j >= 0 && j < n && i >= 0 && i < n && h > maxH) maxH = h;
    }
    if (maxH < -3) return null;
    const nv = n * n, total = nv + 4 * n;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), uv = new Float32Array(total * 2);
    const c = [0, 0, 0];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const idx = j * n + i, x = x0 + i * step, z = z0 + j * step, h = hs[(j + 1) * m + (i + 1)];
      const hL = hs[(j + 1) * m + i], hR = hs[(j + 1) * m + i + 2], hD = hs[j * m + i + 1], hU = hs[(j + 2) * m + i + 1];
      let nx = hL - hR, ny = 2 * step, nz = hD - hU;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const slope = Math.hypot(nx, nz) / Math.max(ny, 0.01);
      const f = h > 2 ? forestAt(x, z, h, slope) : 0;
      groundColor(h, slope, f, x, z, c);
      pos[idx * 3] = x; pos[idx * 3 + 1] = h; pos[idx * 3 + 2] = z;
      nor[idx * 3] = nx; nor[idx * 3 + 1] = ny; nor[idx * 3 + 2] = nz;
      col[idx * 3] = c[0]; col[idx * 3 + 1] = c[1]; col[idx * 3 + 2] = c[2];
      uv[idx * 2] = x / 4; uv[idx * 2 + 1] = z / 4;
    }
    const edge = (e, k) => (e === 0 ? k : e === 1 ? (n - 1) * n + k : e === 2 ? k * n : k * n + n - 1);
    for (let e = 0; e < 4; e++) for (let k = 0; k < n; k++) {
      const s = nv + e * n + k, v = edge(e, k);
      pos[s * 3] = pos[v * 3]; pos[s * 3 + 1] = pos[v * 3 + 1] - 10; pos[s * 3 + 2] = pos[v * 3 + 2];
      nor[s * 3] = nor[v * 3]; nor[s * 3 + 1] = nor[v * 3 + 1]; nor[s * 3 + 2] = nor[v * 3 + 2];
      col[s * 3] = col[v * 3]; col[s * 3 + 1] = col[v * 3 + 1]; col[s * 3 + 2] = col[v * 3 + 2];
      uv[s * 2] = uv[v * 2]; uv[s * 2 + 1] = uv[v * 2 + 1];
    }
    const idxArr = new Uint16Array(seg * seg * 6 + 4 * seg * 6);
    let q = 0;
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
      idxArr[q++] = a; idxArr[q++] = cc; idxArr[q++] = b; idxArr[q++] = b; idxArr[q++] = cc; idxArr[q++] = d;
    }
    for (let e = 0; e < 4; e++) for (let k = 0; k < seg; k++) {
      const v0 = edge(e, k), v1 = edge(e, k + 1), s0 = nv + e * n + k, s1 = s0 + 1;
      idxArr[q++] = v0; idxArr[q++] = s0; idxArr[q++] = v1; idxArr[q++] = v1; idxArr[q++] = s0; idxArr[q++] = s1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idxArr, 1));
    return g;
  }

  _lodFor(d, prev) {
    const th = [170, 360, 720];
    const raw = d < th[0] ? 0 : d < th[1] ? 1 : d < th[2] ? 2 : 3;
    if (prev >= 0 && prev !== raw && Math.abs(d - th[Math.min(prev, raw)]) < 25) return prev;
    return raw;
  }

  _buildFoliage(ch) {
    const data = getChunk(ch.cx, ch.cz);
    const groups = [[], [], []];
    for (const t of data.trees) if (!this.deadTrees.has(t.id)) groups[t.type].push(t);
    const dummy = new THREE.Object3D(), meshes = [];
    for (let type = 0; type < 3; type++) {
      const arr = groups[type];
      if (!arr.length) continue;
      const mesh = new THREE.InstancedMesh(this.geo.tree[type].hi, this.matTree, arr.length);
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        dummy.position.set(t.x, t.y - 0.1, t.z); dummy.rotation.set(0, t.rot, 0); dummy.scale.setScalar(t.s); dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
      mesh.userData.type = type; mesh.receiveShadow = false;
      this.scene.add(mesh); meshes.push(mesh);
    }
    let rocks = null;
    if (data.rocks.length) {
      rocks = new THREE.InstancedMesh(this.geo.rock, this.matRock, data.rocks.length);
      data.rocks.forEach((r, i) => {
        dummy.position.set(r.x, r.y + r.s * r.sy * 0.15, r.z); dummy.rotation.set(0, r.rot, 0); dummy.scale.set(r.s, r.s * r.sy, r.s); dummy.updateMatrix();
        rocks.setMatrixAt(i, dummy.matrix);
      });
      rocks.instanceMatrix.needsUpdate = true; rocks.computeBoundingSphere(); rocks.receiveShadow = true;
      this.scene.add(rocks);
    }
    ch.trees = { meshes, rocks, hi: true };
    ch.dirty = false;
  }

  _disposeFoliage(ch) {
    if (!ch.trees) return;
    for (const m of ch.trees.meshes) { this.scene.remove(m); m.dispose(); }
    if (ch.trees.rocks) { this.scene.remove(ch.trees.rocks); ch.trees.rocks.dispose(); }
    ch.trees = null;
  }

  _disposeChunk(key, ch) {
    this._disposeFoliage(ch);
    if (ch.mesh) { this.scene.remove(ch.mesh); ch.mesh.geometry.dispose(); }
    this.chunks.delete(key);
  }

  _updateChunks(cam) {
    const pcx = Math.floor(cam.x / CH), pcz = Math.floor(cam.z / CH);
    const R = S.drawDist, rc = Math.ceil(R / CH) + 1, lim = Math.floor(WORLD.extent / CH);
    const segs = S.drawDist <= 400 ? [32, 16, 8, 8] : [64, 32, 16, 8];
    const need = [];
    for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
      const cx = pcx + dx, cz = pcz + dz;
      if (cx < -lim || cx >= lim || cz < -lim || cz >= lim) continue;
      const d = Math.hypot((cx + 0.5) * CH - cam.x, (cz + 0.5) * CH - cam.z);
      if (d > R + CH * 0.7) continue;
      const key = cx * 4096 + cz;
      if (this.empty.has(key)) continue;
      need.push({ cx, cz, d, key });
    }
    for (const [key, ch] of this.chunks) {
      const d = Math.hypot((ch.cx + 0.5) * CH - cam.x, (ch.cz + 0.5) * CH - cam.z);
      if (d > R + CH * 1.6) this._disposeChunk(key, ch);
    }
    need.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    const hiDist = [60, 100, 160][S.foliageDetail] ?? 100;
    for (const n of need) {
      let ch = this.chunks.get(n.key);
      const over = performance.now() - t0 > 6;
      if (!ch) {
        if (over) continue;
        const lod = this._lodFor(n.d, -1);
        const geo = this._terrainGeom(n.cx, n.cz, segs[lod]);
        if (!geo) { this.empty.add(n.key); continue; }
        const mesh = new THREE.Mesh(geo, this.matTerrain);
        mesh.receiveShadow = true; this.scene.add(mesh);
        ch = { cx: n.cx, cz: n.cz, mesh, lod, trees: null, dirty: true, lodForce: false };
        this.chunks.set(n.key, ch);
      } else {
        const lod = this._lodFor(n.d, ch.lod);
        if ((lod !== ch.lod || ch.lodForce) && !over) {
          const geo = this._terrainGeom(n.cx, n.cz, segs[lod]);
          ch.mesh.geometry.dispose(); ch.mesh.geometry = geo || ch.mesh.geometry; ch.lod = lod; ch.lodForce = false;
        }
      }
      const wantTrees = n.d < S.treeDist + CH * 0.5;
      if (wantTrees && (!ch.trees || ch.dirty) && !over) { this._disposeFoliage(ch); this._buildFoliage(ch); }
      else if (!wantTrees && ch.trees) this._disposeFoliage(ch);
      if (ch.trees) {
        const hi = n.d < hiDist + 60, shadow = S.shadows > 0 && n.d < S.shadowDist + 140;
        if (hi !== ch.trees.hi) {
          ch.trees.hi = hi;
          for (const m of ch.trees.meshes) m.geometry = hi ? this.geo.tree[m.userData.type].hi : this.geo.tree[m.userData.type].lo;
        }
        for (const m of ch.trees.meshes) m.castShadow = shadow && m.userData.type < 2;
        if (ch.trees.rocks) ch.trees.rocks.castShadow = shadow;
      }
    }
  }

  // ------------------------------------------------------------------ grass
  _grassTile(tx, tz) {
    const key = tx * 4096 + tz;
    let t = this.grassTiles.get(key);
    if (t) return t;
    const TS = 32, cells = 20, cs = TS / cells, rnd = mulberry32((tx * 73856093) ^ (tz * 19349663) ^ 0x5bd1e995);
    const out = [];
    const pois = getPOIs();
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
      const x = tx * TS + (i + rnd()) * cs, z = tz * TS + (j + rnd()) * cs, r1 = rnd(), r2 = rnd(), r3 = rnd();
      const h = heightAt(x, z);
      if (h < 1.9) continue;
      const sl = (Math.abs(heightAt(x + 1.5, z) - h) + Math.abs(heightAt(x, z + 1.5) - h)) / 1.5;
      if (sl > 0.8) continue;
      let skip = false;
      for (const p of pois) { if (p.pr && Math.hypot(x - p.x, z - p.z) < p.pr * 0.55) { skip = true; break; } }
      if (skip) continue;
      const f = forestAt(x, z, h, sl);
      const gp = 0.62 * (1 - f * 0.55), fp = f * 0.42;
      if (r1 < gp) out.push(x, h, z, r2 * 6.283, 0.7 + r3 * 0.8, 0);
      else if (r1 < gp + fp) out.push(x, h, z, r2 * 6.283, 0.7 + r3 * 0.7, 1);
    }
    t = new Float32Array(out);
    this.grassTiles.set(key, t);
    if (this.grassTiles.size > 260) { const k0 = this.grassTiles.keys().next().value; this.grassTiles.delete(k0); }
    return t;
  }

  _updateGrass(cam) {
    if (!this.grassDist) return;
    const moved = Math.hypot(cam.x - this.grassPos.x, cam.z - this.grassPos.z);
    const TS = 32, R = this.grassDist;
    // generate missing tiles progressively (2 per frame)
    let made = 0, missing = false;
    const t0x = Math.floor((cam.x - R) / TS), t1x = Math.floor((cam.x + R) / TS), t0z = Math.floor((cam.z - R) / TS), t1z = Math.floor((cam.z + R) / TS);
    for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
      if (!this.grassTiles.has(tx * 4096 + tz)) { if (made < 2) { this._grassTile(tx, tz); made++; this.grassDirty = true; } else missing = true; }
    }
    if (moved < 4 && !this.grassDirty && !missing) return;
    this.grassDirty = missing; this.grassPos.copy(cam);
    const dummy = new THREE.Object3D(), max = this.maxGrass;
    let gi = 0, fi = 0;
    for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
      const tile = this.grassTiles.get(tx * 4096 + tz);
      if (!tile) continue;
      for (let k = 0; k < tile.length; k += 6) {
        const x = tile[k], z = tile[k + 2], d = Math.hypot(x - cam.x, z - cam.z);
        if (d > R) continue;
        const fade = 1 - smoothstep(R * 0.75, R, d), kind = tile[k + 5];
        dummy.position.set(x, tile[k + 1] - 0.03, z); dummy.rotation.set(0, tile[k + 3], 0); dummy.scale.setScalar(tile[k + 4] * fade); dummy.updateMatrix();
        if (kind === 0) { if (gi < max) this.grassMesh.setMatrixAt(gi++, dummy.matrix); }
        else if (fi < max) this.fernMesh.setMatrixAt(fi++, dummy.matrix);
      }
    }
    this.grassMesh.count = gi; this.fernMesh.count = fi;
    this.grassMesh.instanceMatrix.needsUpdate = true; this.fernMesh.instanceMatrix.needsUpdate = true;
  }

  // ----------------------------------------------------------------- update
  update(dt, cam, focus) {
    this.time += dt;
    this.windU.uTime.value = this.time;
    const w = wind(this.time);
    const wl = Math.hypot(w[0], w[1]) || 1;
    this.windU.uWind.value.set(w[0] / wl, w[1] / wl).multiplyScalar(0.7 + wl * 0.3);
    this.sky.position.copy(cam);
    // ocean follows camera on a grid
    const st = this.oceanStep || 4;
    const ox = Math.round(cam.x / st) * st, oz = Math.round(cam.z / st) * st;
    this.ocean.position.set(ox, 0, oz);
    this.oceanU.uTime.value = this.time; this.oceanU.uCenter.value.set(ox, oz);
    // shadow follows player, snapped to texel grid
    if (this.sun.castShadow) {
      const f = focus || cam, texel = (S.shadowDist * 2) / this.sun.shadow.mapSize.x;
      const tx = Math.round(f.x / texel) * texel, tz = Math.round(f.z / texel) * texel, ty = Math.round(f.y / texel) * texel;
      this.sun.target.position.set(tx, ty, tz);
      this.sun.position.set(tx + this.sunDir.x * 300, ty + this.sunDir.y * 300, tz + this.sunDir.z * 300);
      this.sun.target.updateMatrixWorld();
    } else {
      this.sun.position.copy(cam).addScaledVector(this.sunDir, 300); this.sun.target.position.copy(cam);
    }
    this.clouds.position.set(cam.x, 0, cam.z);
    for (const s of this.clouds.children) { s.position.x += w[0] * 6 * dt; if (s.position.x > 3200) s.position.x -= 6400; if (s.position.x < -3200) s.position.x += 6400; }
    const on = (this.time % 1.8) < 0.22;
    for (const l of this.lamps) l.visible = on;
    this._updateChunks(cam);
    this._updateGrass(cam);
  }

  // Remove trees in a radius (returns removed tree records so effects can spawn leaves)
  destroyTrees(x, z, r) {
    const ids = terrainDestroyTrees(x, z, r, this.deadTrees), out = [];
    for (const id of ids) {
      const { cx, cz, i } = decodeTreeId(id);
      out.push(getChunk(cx, cz).trees[i]);
      const ch = this.chunks.get(cx * 4096 + cz);
      if (ch) ch.dirty = true;
    }
    return out;
  }

  resetTrees() {
    this.deadTrees.clear();
    for (const ch of this.chunks.values()) ch.dirty = true;
  }
}
