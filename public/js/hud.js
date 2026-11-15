// DOM HUD: bandolier, vitals, timer, kill feed, chip radar, damage/ping indicators, chat, scoreboard, voice indicators.
import { ORB, ORB_ORDER, RULES } from './rules.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ orb icons (canvas)
const iconCache = {};
export function orbIcon(type, s = 56) {
  const key = type + s;
  if (iconCache[key]) return iconCache[key];
  const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d'), col = ORB[type].color, cx = s / 2, cy = s / 2, r = s * 0.33;
  const glow = x.createRadialGradient(cx, cy, r * 0.6, cx, cy, s * 0.5);
  glow.addColorStop(0, col + '55'); glow.addColorStop(1, col + '00');
  x.fillStyle = glow; x.fillRect(0, 0, s, s);
  const g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#9aa3ad'); g.addColorStop(1, '#262b31');
  x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
  x.strokeStyle = col; x.lineWidth = s * 0.07; x.beginPath(); x.ellipse(cx, cy, r, r * 0.3, 0, 0, 7); x.stroke();
  x.strokeStyle = col; x.fillStyle = col; x.lineWidth = s * 0.045; x.lineCap = 'round';
  const k = r * 0.5;
  switch (type) {
    case 'timer': x.beginPath(); x.arc(cx, cy - r * 0.15, k * 0.55, 0, 7); x.moveTo(cx, cy - r * 0.15); x.lineTo(cx, cy - r * 0.45); x.moveTo(cx, cy - r * 0.15); x.lineTo(cx + k * 0.3, cy - r * 0.1); x.stroke(); break;
    case 'implosion': for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.7; x.beginPath(); x.moveTo(cx + Math.cos(a) * k * 1.0, cy + Math.sin(a) * k * 1.0 - r * 0.1); x.lineTo(cx + Math.cos(a) * k * 0.4, cy + Math.sin(a) * k * 0.4 - r * 0.1); x.stroke(); } break;
    case 'gas': x.beginPath(); x.arc(cx - k * 0.4, cy - r * 0.1, k * 0.35, 0, 7); x.arc(cx + k * 0.1, cy - r * 0.3, k * 0.45, 0, 7); x.arc(cx + k * 0.5, cy - r * 0.05, k * 0.3, 0, 7); x.fill(); break;
    case 'homing': x.beginPath(); x.moveTo(cx - k, cy - r * 0.45); x.lineTo(cx + k, cy - r * 0.45); x.moveTo(cx, cy - r * 0.45); x.lineTo(cx, cy - r * 0.1); x.stroke(); break;
    case 'remote': x.beginPath(); x.arc(cx, cy - r * 0.05, k * 0.25, 0, 7); x.fill(); x.beginPath(); x.arc(cx, cy - r * 0.05, k * 0.65, -0.9, 0.9 - Math.PI * 0.0); x.stroke(); break;
    case 'flame': x.beginPath(); x.moveTo(cx, cy - r * 0.55); x.quadraticCurveTo(cx + k * 0.9, cy - r * 0.05, cx, cy + r * 0.2); x.quadraticCurveTo(cx - k * 0.9, cy - r * 0.05, cx, cy - r * 0.55); x.fill(); break;
    case 'barrier': x.beginPath(); x.arc(cx, cy - r * 0.1, k * 0.8, 0, 7); x.stroke(); break;
    default: x.beginPath(); x.arc(cx, cy - r * 0.15, k * 0.28, 0, 7); x.fill();
  }
  iconCache[key] = c;
  return c;
}

export class HUD {
  constructor() {
    this.root = $('hud');
    this.slotEls = [];
    const band = $('bandolier'); band.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div'); d.className = 'slot empty';
      const cv = document.createElement('canvas'); cv.width = cv.height = 56;
      const k = document.createElement('span'); k.className = 'key'; k.textContent = i + 1;
      d.append(cv, k); band.append(d); this.slotEls.push({ d, cv });
    }
    this.sel = 0; this.inv = new Array(8).fill(null);
    this.rctx = $('radar').getContext('2d');
    this.radar = { has: false, ox: 0, oz: 0, blips: [], t0: -99, R: RULES.sonarRadius, cancelAt: -99 };
    this.readyAt = 0; this.sonarLabel = '';
    this.indicators = [];
    this.chatOpen = false;
    $('chat-log').innerHTML = '';
  }

  show(v) { this.root.classList.toggle('hidden', !v); }
  reset() {
    this.radar.has = false; this.radar.cancelAt = -99; this.readyAt = 0;
    $('killfeed').innerHTML = ''; $('toasts').innerHTML = ''; $('chat-log').innerHTML = '';
    for (const i of this.indicators) i.el.remove();
    this.indicators = [];
    this.setInv(new Array(8).fill(null)); this.charge(-1); this.fuse(null); this.hint(''); this.setSpectate(null);
    $('vignette').style.opacity = 0; $('flashwhite').style.opacity = 0;
  }

  // ----- bandolier
  setInv(list) {
    this.inv = list;
    list.forEach((type, i) => {
      const { d, cv } = this.slotEls[i], x = cv.getContext('2d');
      x.clearRect(0, 0, 56, 56);
      d.classList.toggle('empty', !type);
      if (type) { x.drawImage(orbIcon(type), 0, 0); d.title = ORB[type].name; }
    });
    this.select(this.sel);
  }
  select(i) {
    this.sel = i;
    this.slotEls.forEach((s, k) => s.d.classList.toggle('sel', k === i));
    const t = this.inv[i];
    $('orb-name').textContent = t ? ORB[t].name : 'Empty';
    $('orb-desc').textContent = t ? ORB[t].desc : 'Find orbs in supply caches, or take them from fallen players.';
  }

  // ----- numbers
  setVitals(hp, stam) {
    $('hp-fill').style.width = Math.max(0, Math.min(100, hp)) + '%';
    $('hp-fill').classList.toggle('low', hp <= 35);
    $('hp-num').textContent = Math.ceil(Math.max(0, hp));
    $('st-fill').style.width = Math.max(0, Math.min(1, stam)) * 100 + '%';
  }
  setChips(n, goal) { $('h-chips').textContent = `${n} / ${goal}`; }
  setTimer(sec) { sec = Math.max(0, Math.ceil(sec)); $('h-timer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; $('h-timer').classList.toggle('urgent', sec <= 60); }
  setAlive(a, t) { $('h-alive').textContent = `${a} / ${t}`; }
  charge(v) { const el = $('charge'); if (v < 0) { el.classList.add('hidden'); return; } el.classList.remove('hidden'); $('charge-fill').style.width = v * 100 + '%'; }
  fuse(f) { const el = $('fuse'); if (f === null) { el.classList.add('hidden'); return; } el.classList.remove('hidden'); el.textContent = `FUSE ${f.toFixed(1)}s  ·  Z / X`; }
  hint(t) { const el = $('hint'); el.textContent = t; el.classList.toggle('hidden', !t); }
  setSpectate(name) { const el = $('spectate'); if (!name) { el.classList.add('hidden'); return; } el.classList.remove('hidden'); $('spec-name').textContent = name; }

  toast(text, cls = '') {
    const d = document.createElement('div'); d.className = 'toast ' + cls; d.textContent = text; $('toasts').append(d);
    setTimeout(() => d.classList.add('out'), 2600); setTimeout(() => d.remove(), 3200);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }
  feed(html, cls = '') {
    const d = document.createElement('div'); d.className = 'feed ' + cls; d.innerHTML = html; $('killfeed').append(d);
    setTimeout(() => d.classList.add('out'), 7000); setTimeout(() => d.remove(), 7600);
    while ($('killfeed').children.length > 6) $('killfeed').firstChild.remove();
  }
  nameHtml(p) { return p ? `<b style="color:${p.color}">${esc(p.name)}</b>` : '<b>?</b>'; }

  // ----- damage & direction indicators
  damage(dmg) {
    const v = $('vignette'); v.style.transition = 'none'; v.style.opacity = Math.min(1, 0.35 + dmg / 60);
    requestAnimationFrame(() => { v.style.transition = 'opacity 1.1s ease-out'; v.style.opacity = 0; });
  }
  flash() { const v = $('flashwhite'); v.style.transition = 'none'; v.style.opacity = 0.85; requestAnimationFrame(() => { v.style.transition = 'opacity 1.4s ease-out'; v.style.opacity = 0; }); }
  indicate(kind, x, z, secs) {
    const el = document.createElement('div'); el.className = 'ind ' + kind; $('indicators').append(el);
    this.indicators.push({ el, x, z, until: performance.now() / 1000 + secs, secs, kind });
    while (this.indicators.length > 8) this.indicators.shift().el.remove();
  }
  updateIndicators(now, px, pz, yaw) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let i = this.indicators.length - 1; i >= 0; i--) {
      const it = this.indicators[i], left = it.until - now;
      if (left <= 0) { it.el.remove(); this.indicators.splice(i, 1); continue; }
      const dx = it.x - px, dz = it.z - pz, a = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
      it.el.style.transform = `rotate(${a}rad) translateY(-${it.kind === 'ping' ? 120 : 96}px)`;
      it.el.style.opacity = Math.min(1, left / (it.secs * 0.5));
    }
  }

  // ----- sonar / radar
  sonarResult(msg, now) { this.radar.has = true; this.radar.ox = msg.ox; this.radar.oz = msg.oz; this.radar.R = msg.r; this.radar.blips = msg.blips || []; this.radar.t0 = now; this.radar.cancelAt = -99; }
  sonarCancel(now) { this.radar.cancelAt = now; }
  setSonarCooldown(readyAt) { this.readyAt = readyAt; }

  drawRadar(now, px, pz, yaw) {
    const c = this.rctx, S = 256, cx = S / 2, cy = S / 2, rad = S / 2 - 12, rd = this.radar, R = rd.R;
    c.clearRect(0, 0, S, S);
    c.beginPath(); c.arc(cx, cy, rad + 8, 0, 7); c.fillStyle = 'rgba(3,20,22,0.86)'; c.fill();
    c.lineWidth = 3; c.strokeStyle = 'rgba(89,255,208,0.75)'; c.stroke();
    c.lineWidth = 1; c.strokeStyle = 'rgba(89,255,208,0.2)';
    for (const f of [1 / 3, 2 / 3, 1]) { c.beginPath(); c.arc(cx, cy, rad * f, 0, 7); c.stroke(); }
    c.beginPath(); c.moveTo(cx - rad, cy); c.lineTo(cx + rad, cy); c.moveTo(cx, cy - rad); c.lineTo(cx, cy + rad); c.stroke();
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const ox = rd.has ? rd.ox : px, oz = rd.has ? rd.oz : pz;
    const proj = (x, z) => { const dx = x - ox, dz = z - oz; return [cx + (dx * rx + dz * rz) / R * rad, cy - (dx * fx + dz * fz) / R * rad]; };
    // north tick (world -z) in heading-up space
    c.fillStyle = 'rgba(255,255,255,0.75)'; c.font = '600 13px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('N', cx + (-rz) * (rad + 1), cy + fz * (rad + 1));
    const age = now - rd.t0;
    if (rd.has && age < 12) {
      const [wx, wy] = proj(ox, oz), frac = Math.min(1, age / 1.3);
      if (age < 1.6) { c.strokeStyle = `rgba(120,255,220,${0.9 * (1 - age / 1.6)})`; c.lineWidth = 3; c.beginPath(); c.arc(wx, wy, Math.max(1, frac * rad), 0, 7); c.stroke(); }
      for (const [bx, bz] of rd.blips) {
        const dist = Math.hypot(bx - ox, bz - oz), tb = Math.min(dist / R, 1) * 1.3, since = age - tb;
        if (since < 0) continue;
        const [sx, sy] = proj(bx, bz), a = Math.max(0, 1 - since / 9);
        if (a <= 0) continue;
        c.fillStyle = `rgba(255,120,90,${a})`; c.beginPath(); c.arc(sx, sy, 5.5, 0, 7); c.fill();
        if (since < 0.8) { c.strokeStyle = `rgba(255,150,110,${(1 - since / 0.8) * a})`; c.lineWidth = 2; c.beginPath(); c.arc(sx, sy, 6 + since * 26, 0, 7); c.stroke(); }
      }
    }
    // self
    const [mx, my] = rd.has ? proj(px, pz) : [cx, cy];
    const mxc = Math.max(10, Math.min(S - 10, mx)), myc = Math.max(10, Math.min(S - 10, my));
    c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(mxc, myc - 8); c.lineTo(mxc + 6, myc + 7); c.lineTo(mxc, myc + 3); c.lineTo(mxc - 6, myc + 7); c.closePath(); c.fill();
    // cancel noise
    if (now - rd.cancelAt < 1.8) {
      const a = 1 - (now - rd.cancelAt) / 1.8;
      c.save(); c.beginPath(); c.arc(cx, cy, rad, 0, 7); c.clip();
      for (let i = 0; i < 90; i++) { c.fillStyle = `rgba(150,255,230,${Math.random() * 0.5 * a})`; c.fillRect(Math.random() * S, Math.random() * S, 10 + Math.random() * 50, 2); }
      c.restore();
      c.fillStyle = `rgba(255,220,120,${a})`; c.font = '700 14px system-ui'; c.fillText('SIGNAL CANCELLED', cx, cy - 26);
    }
    // cooldown arc
    const cd = this.readyAt - now;
    if (cd > 0) { c.strokeStyle = 'rgba(255,180,80,0.95)'; c.lineWidth = 5; c.beginPath(); c.arc(cx, cy, rad + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - cd / RULES.sonarCooldown)); c.stroke(); }
    const lab = cd > 0 ? 'RECHARGING' : 'CHIP READY  ·  Q';
    if (lab !== this.sonarLabel) { this.sonarLabel = lab; $('radar-label').textContent = lab; $('radar-label').classList.toggle('ready', cd <= 0); }
  }

  // ----- voice / chat / scoreboard
  setVoice(list) {
    $('voice-hud').innerHTML = list.map((p) => `<div class="vp"><i style="background:${p.color}"></i>${esc(p.name)}</div>`).join('');
  }
  setMic(text, on) { const el = $('mic-ind'); el.textContent = text; el.classList.toggle('on', !!on); el.classList.toggle('hidden', !text); }
  chat(name, color, text) {
    const d = document.createElement('div'); d.className = 'cl'; d.innerHTML = `<b style="color:${color}">${esc(name)}</b> ${esc(text)}`;
    const log = $('chat-log'); log.append(d);
    setTimeout(() => d.classList.add('old'), 9000);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  openChat(v) { this.chatOpen = v; $('chat').classList.toggle('open', v); const i = $('chat-input'); if (v) { i.value = ''; i.focus(); } else i.blur(); }
  scoreboard(on, rows) {
    const el = $('scoreboard'); el.classList.toggle('hidden', !on);
    if (!on) return;
    $('sb-body').innerHTML = rows.map((r) => `<tr class="${r.me ? 'me' : ''} ${r.alive ? '' : 'dead'}"><td><i style="background:${r.color}"></i>${esc(r.name)}${r.talking ? ' 🔊' : ''}</td><td>${r.chips}</td><td>${r.alive ? 'ALIVE' : 'DOWN'}</td></tr>`).join('');
  }
}
