// Procedural textures (no external assets needed).
import * as THREE from 'three';
import { mulberry32 } from './rules.js';

function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, { repeat = false, srgb = true, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
const rgb = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

// draw a shape at wrapped offsets so textures tile seamlessly
function wrapped(w, h, x, y, r, fn) {
  for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
    const px = x + ox * w, py = y + oy * h;
    if (px < -r || px > w + r || py < -r || py > h + r) continue;
    fn(px, py);
  }
}

function noiseFill(ctx, w, h, base, vari, count, rnd, rmin = 1, rmax = 6, alpha = 0.35) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h, r = rmin + rnd() * (rmax - rmin);
    const v = (rnd() - 0.5) * 2 * vari;
    wrapped(w, h, x, y, r, (px, py) => {
      ctx.fillStyle = rgb(128 + v, 128 + v, 128 + v, alpha);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function radial(size, stops) {
  const [c, ctx] = cv(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return c;
}

export function makeTextures(maxAniso = 4) {
  const T = {};
  const rnd = mulberry32(777);

  // ground detail (multiplied with vertex colours)
  {
    const [c, ctx] = cv(256, 256);
    ctx.fillStyle = '#b9b9b9'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 256, y = rnd() * 256, r = 0.6 + rnd() * 5, v = 150 + rnd() * 105;
      wrapped(256, 256, x, y, r, (px, py) => { ctx.fillStyle = rgb(v, v, v, 0.22); ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill(); });
    }
    for (let i = 0; i < 900; i++) { // tiny blades
      const x = rnd() * 256, y = rnd() * 256, l = 2 + rnd() * 6, v = 110 + rnd() * 140;
      ctx.strokeStyle = rgb(v, v, v, 0.3); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y - l); ctx.stroke();
    }
    T.detail = tex(c, { repeat: true, aniso: maxAniso });
  }

  // tree atlas: [bark][leaf][frond][bush leaf], 4 cells of 256x256
  {
    const [c, ctx] = cv(1024, 256);
    // bark
    ctx.fillStyle = '#6d5440'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 220; i++) {
      const x = rnd() * 256, w = 2 + rnd() * 7, v = rnd();
      ctx.fillStyle = v > 0.5 ? rgb(60, 44, 32, 0.45) : rgb(150, 124, 98, 0.35);
      ctx.fillRect(x, 0, w, 256);
    }
    for (let i = 0; i < 160; i++) {
      const x = rnd() * 256, y = rnd() * 256;
      ctx.fillStyle = rgb(35, 26, 20, 0.35); ctx.fillRect(x, y, 2 + rnd() * 6, 8 + rnd() * 40);
    }
    // broadleaf leaf cluster
    const leaf = (ox, n, size, hueShift) => {
      for (let i = 0; i < n; i++) {
        const x = ox + 16 + rnd() * 224, y = 16 + rnd() * 224, a = rnd() * 6.283, L = size * (0.6 + rnd() * 0.6), Wd = L * 0.42;
        const g = 90 + rnd() * 90, r = 20 + rnd() * 40 + hueShift, b = 15 + rnd() * 25;
        ctx.save(); ctx.translate(x, y); ctx.rotate(a);
        ctx.fillStyle = rgb(r, g, b);
        ctx.strokeStyle = rgb(r * 0.5, g * 0.55, b * 0.5, 0.9); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(0, 0, L, Wd, 0, 0, 6.283); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = rgb(r * 0.7, g * 1.05, b * 0.7, 0.8);
        ctx.beginPath(); ctx.moveTo(-L, 0); ctx.lineTo(L, 0); ctx.stroke();
        ctx.restore();
      }
    };
    leaf(256, 120, 26, 0);
    // palm frond: rib + leaflets
    {
      const ox = 512;
      ctx.strokeStyle = rgb(70, 110, 40); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ox + 128, 252); ctx.lineTo(ox + 128, 6); ctx.stroke();
      for (let y = 240; y > 10; y -= 6) {
        const len = 18 + (1 - Math.abs(y - 120) / 130) * 96 * (y / 250 + 0.35);
        const g = 110 + rnd() * 70;
        ctx.strokeStyle = rgb(40 + rnd() * 30, g, 30, 0.95); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(ox + 128, y); ctx.lineTo(ox + 128 - len, y - len * 0.45); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ox + 128, y); ctx.lineTo(ox + 128 + len, y - len * 0.45); ctx.stroke();
      }
    }
    leaf(768, 150, 15, 10);
    T.treeAtlas = tex(c, { aniso: maxAniso });
    T.treeAtlas.generateMipmaps = true;
  }

  // grass tuft
  {
    const [c, ctx] = cv(128, 128);
    for (let i = 0; i < 26; i++) {
      const x = 12 + rnd() * 104, h = 50 + rnd() * 74, lean = (rnd() - 0.5) * 40, w = 2 + rnd() * 3;
      const g = ctx.createLinearGradient(0, 128, 0, 128 - h);
      g.addColorStop(0, rgb(40, 70, 20)); g.addColorStop(1, rgb(150 + rnd() * 50, 190 + rnd() * 40, 70));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x - w, 128); ctx.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.6, x + lean, 128 - h); ctx.quadraticCurveTo(x + lean * 0.3 + w, 128 - h * 0.55, x + w, 128); ctx.fill();
    }
    T.grass = tex(c, { aniso: maxAniso });
  }
  // fern
  {
    const [c, ctx] = cv(128, 128);
    const frond = (ang, len) => {
      ctx.save(); ctx.translate(64, 124); ctx.rotate(ang);
      ctx.strokeStyle = rgb(50, 100, 35); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(4, -len * 0.5, 0, -len); ctx.stroke();
      for (let t = 0.12; t < 1; t += 0.06) {
        const y = -len * t, l = (1 - t) * 26 + 5;
        ctx.strokeStyle = rgb(45 + rnd() * 30, 110 + rnd() * 60, 35); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(1, y); ctx.lineTo(-l, y - l * 0.5); ctx.moveTo(1, y); ctx.lineTo(l, y - l * 0.5); ctx.stroke();
      }
      ctx.restore();
    };
    frond(-0.9, 100); frond(-0.45, 112); frond(0, 118); frond(0.45, 112); frond(0.9, 100);
    T.fern = tex(c, { aniso: maxAniso });
  }

  // building materials
  {
    let [c, ctx] = cv(256, 256);
    noiseFill(ctx, 256, 256, '#8c8a85', 40, 1800, rnd, 1, 9, 0.25);
    for (let i = 0; i < 14; i++) { ctx.fillStyle = rgb(40, 50, 35, 0.12); ctx.fillRect(rnd() * 256, 0, 6 + rnd() * 30, 256); }
    T.concrete = tex(c, { repeat: true, aniso: maxAniso });
    [c, ctx] = cv(256, 256);
    ctx.fillStyle = '#7a5b3b'; ctx.fillRect(0, 0, 256, 256);
    for (let p = 0; p < 8; p++) {
      const v = 80 + rnd() * 50; ctx.fillStyle = rgb(v + 40, v + 10, v - 20, 0.9); ctx.fillRect(0, p * 32, 256, 31);
      for (let i = 0; i < 40; i++) { ctx.strokeStyle = rgb(50, 32, 20, 0.35); ctx.beginPath(); const y = p * 32 + rnd() * 30; ctx.moveTo(rnd() * 256, y); ctx.lineTo(rnd() * 256, y + 0.5); ctx.stroke(); }
      ctx.fillStyle = rgb(30, 20, 12, 0.7); ctx.fillRect(0, p * 32 + 31, 256, 1);
    }
    T.wood = tex(c, { repeat: true, aniso: maxAniso });
    [c, ctx] = cv(256, 256);
    noiseFill(ctx, 256, 256, '#8a4a2a', 55, 2200, rnd, 1, 8, 0.4);
    for (let i = 0; i < 400; i++) { ctx.fillStyle = rgb(200, 120, 50, 0.25); ctx.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 10, 2 + rnd() * 6); }
    T.rust = tex(c, { repeat: true, aniso: maxAniso });
    [c, ctx] = cv(256, 256);
    noiseFill(ctx, 256, 256, '#7f878c', 28, 900, rnd, 1, 5, 0.25);
    for (let i = 0; i < 16; i++) { ctx.fillStyle = rgb(30, 34, 38, 0.35); ctx.fillRect(0, i * 16, 256, 1.5); }
    T.metal = tex(c, { repeat: true, aniso: maxAniso });
    [c, ctx] = cv(256, 256);
    noiseFill(ctx, 256, 256, '#77756e', 50, 1500, rnd, 3, 22, 0.3);
    for (let i = 0; i < 90; i++) { ctx.fillStyle = rgb(60, 95, 45, 0.18); wrapped(256, 256, rnd() * 256, rnd() * 256, 18, (px, py) => { ctx.beginPath(); ctx.arc(px, py, 6 + rnd() * 12, 0, 6.283); ctx.fill(); }); }
    T.stone = tex(c, { repeat: true, aniso: maxAniso });
    [c, ctx] = cv(128, 128);
    noiseFill(ctx, 128, 128, '#8f8b63', 25, 600, rnd, 1, 4, 0.3);
    for (let i = 0; i < 8; i++) { ctx.fillStyle = rgb(60, 56, 38, 0.3); ctx.fillRect(i * 16, 0, 2, 128); }
    T.tent = tex(c, { repeat: true, aniso: maxAniso });
  }

  // water normal map (tileable): sum of sines + wrapped blobs -> normals
  {
    const N = 256, hgt = new Float32Array(N * N);
    const waves = [];
    for (let i = 0; i < 14; i++) waves.push([Math.floor(1 + rnd() * 7), Math.floor(1 + rnd() * 7) * (rnd() > 0.5 ? 1 : -1), rnd() * 6.283, 0.3 + rnd() * 0.7]);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let h = 0;
      for (const [fx, fy, ph, a] of waves) h += Math.sin((fx * x + fy * y) / N * 6.283 + ph) * a / (Math.hypot(fx, fy));
      hgt[y * N + x] = h;
    }
    const [c, ctx] = cv(N, N);
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const hl = hgt[y * N + ((x + N - 1) % N)], hr = hgt[y * N + ((x + 1) % N)], hu = hgt[((y + N - 1) % N) * N + x], hd = hgt[((y + 1) % N) * N + x];
      let nx = (hl - hr) * 2.2, ny = (hu - hd) * 2.2, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    T.waterNormal = tex(c, { repeat: true, srgb: false, aniso: maxAniso });
  }

  // sprites
  T.smoke = (() => {
    const [c, ctx] = cv(128, 128);
    ctx.drawImage(radial(128, [[0, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]), 0, 0);
    for (let i = 0; i < 14; i++) {
      const x = 30 + rnd() * 68, y = 30 + rnd() * 68, r = 12 + rnd() * 22;
      ctx.drawImage(radial(64, [[0, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]), x - r, y - r, r * 2, r * 2);
    }
    return tex(c);
  })();
  T.fire = tex(radial(128, [[0, 'rgba(255,255,230,1)'], [0.25, 'rgba(255,200,90,0.9)'], [0.6, 'rgba(255,90,20,0.45)'], [1, 'rgba(255,40,0,0)']]));
  T.glow = tex(radial(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]));
  T.dot = tex(radial(32, [[0, 'rgba(255,255,255,1)'], [0.7, 'rgba(255,255,255,0.85)'], [1, 'rgba(255,255,255,0)']]));
  T.leafBit = (() => {
    const [c, ctx] = cv(32, 32);
    ctx.fillStyle = '#7fbf3f'; ctx.beginPath(); ctx.ellipse(16, 16, 14, 6, 0.6, 0, 6.283); ctx.fill();
    return tex(c);
  })();
  T.cloud = (() => {
    const [c, ctx] = cv(256, 128);
    for (let i = 0; i < 38; i++) {
      const x = 40 + rnd() * 176, y = 42 + rnd() * 44, r = 16 + rnd() * 30;
      ctx.drawImage(radial(64, [[0, 'rgba(255,255,255,0.55)'], [0.6, 'rgba(240,244,250,0.25)'], [1, 'rgba(235,240,250,0)']]), x - r, y - r * 0.8, r * 2, r * 1.6);
    }
    return tex(c);
  })();
  T.scorch = (() => {
    const [c, ctx] = cv(128, 128);
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(8,6,5,0.92)'); g.addColorStop(0.55, 'rgba(12,9,7,0.6)'); g.addColorStop(1, 'rgba(12,9,7,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 40; i++) { ctx.fillStyle = 'rgba(10,8,6,0.35)'; ctx.beginPath(); ctx.arc(64 + (rnd() - 0.5) * 100, 64 + (rnd() - 0.5) * 100, 2 + rnd() * 6, 0, 6.283); ctx.fill(); }
    return tex(c);
  })();
  T.ring = (() => {
    const [c, ctx] = cv(256, 256);
    const g = ctx.createRadialGradient(128, 128, 90, 128, 128, 126);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.7, 'rgba(255,255,255,0.9)'); g.addColorStop(0.85, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    return tex(c);
  })();
  T.beam = (() => {
    const [c, ctx] = cv(32, 128);
    const g = ctx.createLinearGradient(0, 128, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 128);
    const h = ctx.createLinearGradient(0, 0, 32, 0);
    h.addColorStop(0, 'rgba(0,0,0,1)'); h.addColorStop(0.5, 'rgba(0,0,0,0)'); h.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = h; ctx.fillRect(0, 0, 32, 128);
    return tex(c);
  })();
  return T;
}
