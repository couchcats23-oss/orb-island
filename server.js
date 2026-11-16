// Orb Island server: zero dependencies (Node 18+).
//  - serves ./public
//  - minimal RFC6455 WebSocket implementation
//  - matchmaking queue / lobbies (public + private codes)
//  - authoritative orb, gas, fire, sonar, pickup & win-condition simulation
//  - WebRTC signalling relay for in-match voice chat
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  WORLD, heightAt, normalAt, slopeAt, queryColliders, destroyTrees, floorAt, pointBlocked, getPOIs, wind,
} from './public/js/terrain.js';
import {
  RULES, ORB, ORB_ORDER, orbDamage, makeLoadout, FLAGS, PLAYER_COLORS, mulberry32,
} from './public/js/rules.js';

import { Brain, LEVELS, PERSONAS, BOT_NAMES } from './bot_brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS) || RULES.minPlayers;
const MAX_PLAYERS = Math.min(Number(process.env.MAX_PLAYERS) || RULES.maxPlayers, PLAYER_COLORS.length);
const COUNTDOWN = Number(process.env.COUNTDOWN) || RULES.lobbyCountdown;
const TICK = 1 / 30;
const SIM_SPEED = Math.max(1, Number(process.env.SIM_SPEED) || 1); // >1 only for fast-forward testing

const r2 = (v) => Math.round(v * 100) / 100;
const clampN = (v, a, b, d = 0) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);
const uid = () => crypto.randomBytes(4).toString('hex').slice(0, 6);

// ---------------------------------------------------------------------------
// HTTP (static files + tiny JSON API)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.txt': 'text/plain',
};

function iceServers() {
  const list = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
  if (process.env.TURN_URL) list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  return list;
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: iceServers(), minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS }));
  }
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(stats()));
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Minimal WebSocket
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
const textFrame = (str) => wsFrame(1, Buffer.from(str));

class Conn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket; this.onMessage = onMessage; this.onClose = onClose;
    this.buf = Buffer.alloc(0); this.frags = []; this.closed = false; this.last = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  finish() { if (this.closed) return; this.closed = true; try { this.socket.destroy(); } catch {} this.onClose(); }
  onData(chunk) {
    this.last = Date.now();
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 1 << 20) return this.finish();
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return this.finish();
      const total = off + (masked ? 4 : 0) + len;
      if (b.length < total) return;
      let payload = b.subarray(off + (masked ? 4 : 0), total);
      if (masked) {
        const mask = b.subarray(off, off + 4), out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else payload = Buffer.from(payload);
      this.buf = b.subarray(total);
      if (op === 8) { try { this.socket.write(wsFrame(8, Buffer.alloc(0))); } catch {} return this.finish(); }
      if (op === 9) { try { this.socket.write(wsFrame(10, payload)); } catch {} continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        this.frags.push(payload);
        if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.onMessage(msg); }
      }
    }
  }
  sendRaw(frame) { if (!this.closed && !this.socket.destroyed) { try { this.socket.write(frame); } catch {} } }
  send(obj) { this.sendRaw(textFrame(JSON.stringify(obj))); }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const player = new Player(uid());
  player.conn = new Conn(socket, (m) => handleMessage(player, m), () => dropPlayer(player));
  players.set(player.id, player);
  player.send({ t: 'welcome', id: player.id, min: MIN_PLAYERS, max: MAX_PLAYERS });
});

// ---------------------------------------------------------------------------
// Players & lobbies
// ---------------------------------------------------------------------------
const players = new Map();
const lobbies = new Map();
let lobbySeq = 1;

class Player {
  constructor(id) {
    this.id = id; this.name = 'Player'; this.conn = null; this.lobby = null; this.color = PLAYER_COLORS[0];
    this.msgCount = 0; this.msgWindow = Date.now(); this.lastChat = 0; this.queuedAt = 0;
    this.bot = null; // set for computer-controlled players (practice matches)
    this.resetMatch();
  }
  resetMatch() {
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.pitch = 0; this.fl = 0;
    this.hp = RULES.hp; this.alive = false; this.phase = 'none';
    this.chips = 0; this.kills = 0; this.deaths = 0;
    this.loadout = new Array(8).fill(null);
    this.remotes = []; this.remoteCounter = 0;
    this.shieldUntil = 0; this.burnUntil = 0; this.sonarReady = 0; this.throwReady = 0;
    this.lastSt = 0; this.lastMoving = 0; this.speed = 0;
    this.lastHitBy = null; this.lastHitAt = -99; this.oob = 0;
  }
  send(o) { if (this.conn) this.conn.send(o); else if (this.bot) this.bot.onMsg(o); }
}

const humansIn = (l) => { let n = 0; for (const p of l.players.values()) if (!p.bot) n++; return n; };

function stats() {
  let queued = 0, inMatch = 0, practice = 0;
  for (const l of lobbies.values()) {
    const n = humansIn(l);
    if (l.practice) practice++;
    else if (l.state === 'waiting') queued += n; else inMatch += n;
  }
  return { online: players.size, searching: queued, inMatch, lobbies: lobbies.size, practice };
}

// ---- practice matches against bots -------------------------------------------------------
const MAX_PRACTICE = Number(process.env.MAX_PRACTICE) || 4;
const BOT_DEBUG = !!process.env.BOT_DEBUG;
let botSeq = 0;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function createPractice(host, opts) {
  let practiceCount = 0;
  for (const l of lobbies.values()) if (l.practice) practiceCount++;
  if (practiceCount >= MAX_PRACTICE) return false;
  const l = new Lobby(lobbySeq++, null);
  l.practice = true;
  lobbies.set(l.id, l);
  l.add(host);
  const n = Math.max(MIN_PLAYERS - 1, Math.min(MAX_PLAYERS - 1, Math.round(Number(opts && opts.bots)) || 5), 1);
  const level = opts && (LEVELS[opts.level] || opts.level === 'mixed') ? opts.level : 'normal';
  const names = shuffle([...BOT_NAMES]), kinds = shuffle(Object.keys(PERSONAS));
  for (let i = 0; i < n; i++) {
    const b = new Player('b' + (++botSeq));
    b.name = names[i % names.length] + (i >= names.length ? i : '');
    const lv = level === 'mixed' ? ['easy', 'normal', 'normal', 'hard', 'hard'][Math.floor(Math.random() * 5)] : level;
    b.bot = new Brain(b, l, lv, kinds[i % kinds.length]);
    l.add(b);
  }
  return true;
}

function findLobby(code) {
  let best = null;
  for (const l of lobbies.values()) {
    if (l.practice || l.state !== 'waiting' || l.players.size >= MAX_PLAYERS) continue;
    if ((l.code || '') !== (code || '')) continue;
    if (!best || l.players.size > best.players.size) best = l;
  }
  if (!best) { best = new Lobby(lobbySeq++, code); lobbies.set(best.id, best); }
  return best;
}

function leaveLobby(p) {
  const l = p.lobby;
  if (!l) return;
  l.remove(p);
  p.lobby = null;
  if (humansIn(l) === 0) lobbies.delete(l.id); // empty (bots alone do not keep a lobby alive)
}

function dropPlayer(p) {
  leaveLobby(p);
  players.delete(p.id);
}

function handleMessage(p, raw) {
  const now = Date.now();
  if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgCount = 0; }
  if (++p.msgCount > 600) return;
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  try {
    switch (m.t) {
      case 'hello': p.name = String(m.name || 'Player').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16) || 'Player'; break;
      case 'queue': {
        if (p.lobby) leaveLobby(p);
        if (typeof m.name === 'string') p.name = m.name.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16) || p.name;
        if (m.practice && typeof m.practice === 'object') {
          if (!createPractice(p, m.practice)) p.send({ t: 'left', why: 'busy' });
          break;
        }
        const code = typeof m.code === 'string' ? m.code.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) : '';
        const l = findLobby(code || null);
        l.add(p);
        break;
      }
      case 'leave': leaveLobby(p); p.send({ t: 'left' }); break;
      case 'st': if (p.lobby) p.lobby.onState(p, m); break;
      case 'throw': if (p.lobby) p.lobby.onThrow(p, m); break;
      case 'det': if (p.lobby) p.lobby.onDetonate(p, m); break;
      case 'sonar': if (p.lobby) p.lobby.onSonar(p); break;
      case 'chat': if (p.lobby && now - p.lastChat > 400) {
        p.lastChat = now;
        const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 140);
        if (text) p.lobby.broadcast({ t: 'chat', id: p.id, name: p.name, text });
      } break;
      case 'rtc': {
        const to = p.lobby && p.lobby.players.get(String(m.to));
        if (to) to.send({ t: 'rtc', from: p.id, d: m.d });
        break;
      }
      case 'ping': p.send({ t: 'pong', c: m.c }); break;
      default: break;
    }
  } catch (e) { console.error('msg error', m.t, e); }
}

// ---------------------------------------------------------------------------
// Spawn selection
// ---------------------------------------------------------------------------
function pickSpawns(n, rnd) {
  const cand = [];
  for (let i = 0; i < 500 && cand.length < 120; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * WORLD.R * 1.0;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = heightAt(x, z);
    if (h > 3 && h < 45 && slopeAt(x, z) < 0.35) cand.push({ x, z });
  }
  if (cand.length === 0) cand.push({ x: 0, z: 0 });
  const chosen = [cand[Math.floor(rnd() * cand.length)]];
  while (chosen.length < n) {
    let best = null, bd = -1;
    for (const c of cand) {
      let md = 1e9;
      for (const s of chosen) md = Math.min(md, Math.hypot(c.x - s.x, c.z - s.z));
      if (md > bd) { bd = md; best = c; }
    }
    chosen.push(best || cand[0]);
  }
  return chosen;
}

function randomCacheItems(rnd) {
  const bag = ['cracker', 'cracker', 'cracker', 'timer', 'timer', 'implosion', 'gas', 'gas', 'homing', 'homing', 'remote', 'flame', 'flame', 'barrier'];
  return [bag[Math.floor(rnd() * bag.length)], bag[Math.floor(rnd() * bag.length)]];
}

// ---------------------------------------------------------------------------
// Lobby / match
// ---------------------------------------------------------------------------
const _col = [];

class Lobby {
  constructor(id, code) {
    this.id = id; this.code = code || null;
    this.players = new Map();
    this.state = 'waiting';
    this.countdown = null; this.lastInfo = 0;
    this.rnd = mulberry32((Date.now() ^ (id * 7919)) >>> 0);
    this.t = 0; this.tick = 0; this.idc = 1; this.startCount = 0; this.endsAt = 0;
    this.orbs = new Map(); this.clouds = []; this.fires = []; this.pickups = new Map(); this.pings = [];
    this.deadTrees = new Set();
    this.practice = false; // true: private match against bots
  }
  nid() { return this.idc++; }
  broadcast(o) {
    const f = textFrame(JSON.stringify(o));
    for (const p of this.players.values()) { if (p.conn) p.conn.sendRaw(f); else if (p.bot && o.t === 'ev') p.bot.onEv(o); }
  }
  info() {
    return {
      t: 'lobby', id: this.id, code: this.code, state: this.state, min: MIN_PLAYERS, max: MAX_PLAYERS, practice: this.practice,
      countdown: this.countdown === null ? null : Math.max(0, Math.ceil(this.countdown)),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot })),
    };
  }
  sendInfo() { this.lastInfo = Date.now(); this.broadcast(this.info()); }
  add(p) {
    const used = new Set([...this.players.values()].map((q) => q.color));
    p.color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
    p.lobby = this; p.resetMatch();
    this.players.set(p.id, p);
    this.sendInfo();
  }
  remove(p) {
    this.players.delete(p.id);
    if (this.state === 'running') {
      if (p.alive) { this.killPlayer(p, null, 'left'); }
    }
    if (this.state === 'waiting') {
      if (this.players.size < MIN_PLAYERS) this.countdown = null;
      this.sendInfo();
    } else this.broadcast({ t: 'ev', k: 'left', id: p.id });
  }

  // ---- lifecycle ----------------------------------------------------------
  update(dt) {
    if (this.state === 'waiting') {
      if (this.players.size >= MIN_PLAYERS) {
        if (this.countdown === null) this.countdown = this.practice ? 4 : COUNTDOWN;
        if (this.players.size >= MAX_PLAYERS) this.countdown = Math.min(this.countdown, RULES.fullCountdown);
        this.countdown -= dt;
        if (this.countdown <= 0) return this.start();
      } else this.countdown = null;
      if (Date.now() - this.lastInfo > 1000) this.sendInfo();
    } else if (this.state === 'running') this.step(dt);
    else if (this.state === 'ended') {
      this.t += dt;
      if (this.t >= this.endsAt) this.reset();
    }
  }

  reset() {
    this.state = 'waiting'; this.countdown = null; this.orbs.clear(); this.clouds = []; this.fires = []; this.pickups.clear(); this.pings = [];
    this.deadTrees = new Set();
    for (const p of this.players.values()) p.resetMatch();
    this.sendInfo();
  }

  start() {
    this.state = 'running'; this.t = 0; this.lastDeathT = 0; this.tick = 0; this.idc = 1;
    this.orbs.clear(); this.clouds = []; this.fires = []; this.pickups.clear(); this.pings = [];
    this.deadTrees = new Set();
    const list = [...this.players.values()];
    this.startCount = list.length;
    const spawns = pickSpawns(list.length, this.rnd);
    if (process.env.BOT_CLOSE) { // testing aid: everyone drops within ~70 m of the first spawn
      const c = spawns[0];
      for (let i = 1; i < spawns.length; i++) spawns[i] = { x: c.x + (this.rnd() - 0.5) * 140, z: c.z + (this.rnd() - 0.5) * 140 };
    }
    list.forEach((p, i) => {
      p.resetMatch();
      const s = spawns[i];
      p.x = s.x; p.z = s.z; p.y = heightAt(s.x, s.z) + RULES.dropHeight;
      p.alive = true; p.phase = 'drop'; p.lastSt = 0; p.lastMoving = 0;
      p.loadout = makeLoadout(this.rnd);
    });
    for (const poi of getPOIs()) {
      for (const [x, z] of poi.caches) {
        const id = this.nid();
        this.pickups.set(id, { id, k: 'cache', x, z, y: floorAt(x, z, 50) + 0.45, items: randomCacheItems(this.rnd), active: true, respawnAt: 0 });
      }
    }
    const plist = list.map((p) => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot }));
    for (const p of list) {
      if (p.bot) continue;
      p.send({
        t: 'start', you: p.id, seed: WORLD.seed, players: plist, goal: RULES.chipGoal, matchTime: RULES.matchTime,
        spawn: { x: p.x, y: p.y, z: p.z }, loadout: p.loadout.map((x) => ORB_ORDER.indexOf(x)),
        pickups: this.pickupList(),
      });
    }
    for (const p of list) if (p.bot) p.bot.begin();
  }

  pickupList() {
    const out = [];
    for (const k of this.pickups.values()) if (k.active) out.push(this.pkWire(k));
    return out;
  }
  pkWire(k) { return { id: k.id, k: k.k === 'chip' ? 0 : k.k === 'orbs' ? 1 : 2, x: r2(k.x), y: r2(k.y), z: r2(k.z), n: k.n || 0 }; }

  end(winnerId, reason) {
    if (this.state !== 'running') return;
    this.state = 'ended'; this.t = 0; this.endsAt = RULES.endScreen;
    const results = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, chips: p.chips, kills: p.kills, deaths: p.deaths, alive: p.alive, bot: !!p.bot }));
    results.sort((a, b) => (b.id === winnerId) - (a.id === winnerId) || b.chips - a.chips || b.kills - a.kills);
    this.broadcast({ t: 'end', winner: winnerId, reason, results });
    this.orbs.clear(); this.clouds = []; this.fires = [];
  }

  // ---- player messages ----------------------------------------------------
  onState(p, m) {
    if (this.state !== 'running' || !p.alive) return;
    const nx = clampN(m.x, -4000, 4000), ny = clampN(m.y, -200, 600), nz = clampN(m.z, -4000, 4000);
    const dt = Math.max(0.02, this.t - p.lastSt);
    const dist = Math.hypot(nx - p.x, nz - p.z);
    if (p.lastSt > 0 && p.phase === 'play' && dist > RULES.sprint * 2.2 * dt + 3) {
      p.send({ t: 'fix', x: r2(p.x), y: r2(p.y), z: r2(p.z) });
      return;
    }
    p.speed = p.speed * 0.6 + (dist / dt) * 0.4;
    p.x = nx; p.y = ny; p.z = nz;
    p.yaw = clampN(m.yaw, -10, 10); p.pitch = clampN(m.pitch, -1.6, 1.6);
    p.fl = (m.fl | 0) & (FLAGS.CROUCH | FLAGS.SPRINT | FLAGS.SWIM);
    p.lastSt = this.t;
    if (p.speed > 0.7) p.lastMoving = this.t;
    if (p.phase === 'drop' && ny - Math.max(heightAt(nx, nz), -1.1) < 2.0) p.phase = 'play';
  }

  eyePos(p) { return [p.x, p.y + ((p.fl & FLAGS.CROUCH) ? RULES.eyeCrouch : RULES.eye), p.z]; }

  onThrow(p, m) {
    if (this.state !== 'running' || !p.alive || p.phase !== 'play') return;
    if (this.t < p.throwReady) return;
    const slot = m.slot | 0;
    if (slot < 0 || slot > 7 || !p.loadout[slot]) return;
    const type = p.loadout[slot];
    p.throwReady = this.t + 0.45;
    if (type === 'barrier') {
      p.loadout[slot] = null;
      p.shieldUntil = this.t + ORB.barrier.dur;
      this.broadcast({ t: 'ev', k: 'barrier', id: p.id });
      this.sendInv(p);
      return;
    }
    let dx = clampN(m.d && m.d[0], -1, 1), dy = clampN(m.d && m.d[1], -1, 1), dz = clampN(m.d && m.d[2], -1, 1);
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const pw = clampN(m.pw, 0, 1, 0.6);
    const sp = RULES.throwMin + (RULES.throwMax - RULES.throwMin) * pw;
    const [ex, ey, ez] = this.eyePos(p);
    const o = {
      id: this.nid(), type, owner: p.id, x: ex + dx * 0.7, y: ey + dy * 0.7 - 0.15, z: ez + dz * 0.7,
      vx: dx * sp, vy: dy * sp, vz: dz * sp, age: 0, st: 0, fuse: type === 'timer' ? clampN(Number(m.fuse), 1, ORB.timer.fuse, ORB.timer.fuse) : 0,
      num: 0, stuckAt: 0, target: null,
    };
    if (type === 'remote') o.num = ++p.remoteCounter;
    p.loadout[slot] = null;
    this.orbs.set(o.id, o);
    if (type === 'remote') p.remotes.push(o.id);
    this.sendInv(p);
    this.broadcast({ t: 'ev', k: 'throw', id: p.id, o: ORB_ORDER.indexOf(type), x: r2(o.x), y: r2(o.y), z: r2(o.z) });
  }

  sendInv(p) { p.send({ t: 'inv', l: p.loadout.map((x) => (x ? ORB_ORDER.indexOf(x) : -1)) }); }

  onDetonate(p, m) {
    if (this.state !== 'running' || !p.alive) return;
    const ids = m.all ? [...p.remotes] : p.remotes.slice(0, 1);
    for (const id of ids) {
      const o = this.orbs.get(id);
      p.remotes = p.remotes.filter((x) => x !== id);
      if (o) this.explode(o, o.x, o.y, o.z);
    }
  }

  onSonar(p) {
    if (this.state !== 'running' || !p.alive || p.phase !== 'play' || this.t < p.sonarReady) return;
    p.sonarReady = this.t + RULES.sonarCooldown;
    this.pings.push({ pid: p.id, t: this.t, x: p.x, z: p.z, done: false });
  }

  // ---- simulation ---------------------------------------------------------
  hurt(p, dmg, by, kind, ox, oz) {
    if (!p.alive || p.phase !== 'play' || dmg <= 0) return;
    if (this.t < p.shieldUntil && kind !== 'sea') { p.send({ t: 'shield' }); return; }
    p.hp -= dmg;
    if (by && by !== p.id) { p.lastHitBy = by; p.lastHitAt = this.t; }
    p.send({ t: 'hit', d: Math.round(dmg), k: kind, x: r2(ox ?? p.x), z: r2(oz ?? p.z), hp: Math.max(0, Math.round(p.hp)) });
    if (p.hp <= 0) this.killPlayer(p, by, kind);
  }

  killPlayer(p, by, kind) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.deaths++; this.lastDeathT = this.t; // bots read this to detect a stalemate
    if (!by && p.lastHitBy && this.t - p.lastHitAt < 12) by = p.lastHitBy;
    const killer = by && by !== p.id ? this.players.get(by) : null;
    if (killer) killer.kills++;
    const ground = Math.max(floorAt(p.x, p.z, p.y + 1), 0);
    const add = [];
    const nChips = p.chips + 1;
    const chip = { id: this.nid(), k: 'chip', x: p.x, z: p.z, y: ground + 0.5, n: nChips, active: true };
    this.pickups.set(chip.id, chip); add.push(this.pkWire(chip));
    const items = p.loadout.filter(Boolean);
    if (items.length) {
      const pk = { id: this.nid(), k: 'orbs', x: p.x + 1.1, z: p.z + 0.6, y: ground + 0.4, items, active: true };
      this.pickups.set(pk.id, pk); add.push(this.pkWire(pk));
    }
    p.loadout = new Array(8).fill(null); p.chips = 0;
    for (const id of p.remotes) { const o = this.orbs.get(id); if (o) this.orbs.delete(id); }
    p.remotes = [];
    this.broadcast({ t: 'ev', k: 'death', id: p.id, by: killer ? killer.id : (by === p.id ? p.id : null), kind: kind || 'blast', x: r2(p.x), y: r2(p.y), z: r2(p.z) });
    this.broadcast({ t: 'pk', add, del: [] });
    this.checkWin();
  }

  checkWin() {
    if (this.state !== 'running') return;
    let alive = 0, last = null;
    for (const p of this.players.values()) {
      if (p.alive) { alive++; last = p; if (p.chips >= RULES.chipGoal) return this.end(p.id, 'chips'); }
    }
    if (this.startCount >= 2 && alive <= 1) this.end(last ? last.id : null, last ? 'last' : 'draw');
  }

  explode(o, x, y, z) {
    if (!this.orbs.delete(o.id)) return;
    const owner = this.players.get(o.owner);
    if (owner) owner.remotes = owner.remotes.filter((id) => id !== o.id);
    const def = ORB[o.type];
    if (BOT_DEBUG) { let nd = 1e9, nn = ''; for (const q of this.players.values()) { if (!q.alive || q.id === o.owner || q.phase !== 'play') continue; const dd = Math.hypot(q.x - x, q.y + 0.9 - y, q.z - z); if (dd < nd) { nd = dd; nn = q.name; } } const ow = this.players.get(o.owner); console.log(`  boom ${o.type} by ${ow ? ow.name : '?'} t=${this.t.toFixed(1)} nearest enemy ${nn} ${nd.toFixed(1)}m` + (o.expect ? ` | landed ${Math.hypot(x - o.expect.x, z - o.expect.z).toFixed(1)}m from predicted (age ${o.age.toFixed(1)} vs ${o.expect.t.toFixed(1)}), ${Math.hypot(x - o.expect.ox, z - o.expect.oz).toFixed(0)}m from thrower` : '')); }
    this.broadcast({ t: 'ev', k: 'boom', o: ORB_ORDER.indexOf(o.type), x: r2(x), y: r2(y), z: r2(z), by: o.owner });
    const treeR = o.type === 'implosion' ? def.trees : def.blast ? def.blast * 0.45 : 0;
    if (treeR > 0) destroyTrees(x, z, treeR, this.deadTrees);
    for (const p of [...this.players.values()]) {
      if (!p.alive || p.phase !== 'play') continue;
      const d = Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z);
      let dmg = orbDamage(o.type, d);
      if (dmg <= 0) continue;
      let blocked = 0;
      for (let i = 1; i <= 5; i++) {
        const f = i / 6;
        if (pointBlocked(x + (p.x - x) * f, y + (p.y + 0.9 - y) * f, z + (p.z - z) * f)) blocked++;
      }
      if (blocked >= 2) dmg *= 0.2;
      this.hurt(p, dmg, o.owner, 'blast', x, z);
    }
  }

  burstGas(o, x, y, z) {
    this.orbs.delete(o.id);
    const c = { id: this.nid(), x, y: y + 0.4, z, age: 0, life: ORB.gas.life, owner: o.owner, r: 2 };
    this.clouds.push(c);
    this.broadcast({ t: 'ev', k: 'gas', id: c.id, x: r2(c.x), y: r2(c.y), z: r2(c.z), life: c.life });
  }

  burstFlame(o, x, y, z) {
    this.orbs.delete(o.id);
    const base = Math.atan2(o.vz, o.vx);
    for (let i = 0; i < 4; i++) {
      const a = base + i * Math.PI / 2;
      this.fires.push({ id: this.nid(), x, y, z, ax: Math.cos(a), az: Math.sin(a), age: 0, life: ORB.flame.life, owner: o.owner });
    }
    this.broadcast({ t: 'ev', k: 'flame', x: r2(x), y: r2(y), z: r2(z), a: r2(base), life: ORB.flame.life, by: o.owner });
    destroyTrees(x, z, 3.5, this.deadTrees);
  }

  collideOrb(o) {
    // terrain / pier
    const g = floorAt(o.x, o.z, o.y);
    const R = 0.14;
    if (o.y - R <= g) {
      const n = normalAt(o.x, o.z);
      return { n, y: g + R, kind: 'ground' };
    }
    queryColliders(o.x, o.z, 1.2, _col, this.deadTrees);
    for (const c of _col) {
      if (c.k === 0) {
        if (o.y < c.y0 || o.y > c.y1) continue;
        const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz);
        if (d < c.r + R) { const l = d || 1; return { n: [dx / l, 0, dz / l], px: c.x + (dx / l) * (c.r + R + 0.01), pz: c.z + (dz / l) * (c.r + R + 0.01), kind: 'tree' }; }
      } else {
        if (o.y < c.y0 - R || o.y > c.y1 + R) continue;
        if (o.x > c.minX - R && o.x < c.maxX + R && o.z > c.minZ - R && o.z < c.maxZ + R) {
          const pens = [
            [o.x - (c.minX - R), -1, 0, 0], [(c.maxX + R) - o.x, 1, 0, 0],
            [o.z - (c.minZ - R), 0, 0, -1], [(c.maxZ + R) - o.z, 0, 0, 1],
            [o.y - (c.y0 - R), 0, -1, 0], [(c.y1 + R) - o.y, 0, 1, 0],
          ];
          let best = null;
          for (const p of pens) if (!best || p[0] < best[0]) best = p;
          const n = [0, 0, 0];
          if (best === pens[0]) n[0] = -1; else if (best === pens[1]) n[0] = 1;
          else if (best === pens[2]) n[2] = -1; else if (best === pens[3]) n[2] = 1;
          else if (best === pens[4]) n[1] = -1; else n[1] = 1;
          return { n, push: best[0] + 0.01, kind: 'box' };
        }
      }
    }
    for (const p of this.players.values()) {
      if (!p.alive || p.phase !== 'play') continue;
      if (p.id === o.owner && o.age < 0.3) continue;
      const top = (p.fl & FLAGS.CROUCH) ? 1.15 : 1.8;
      if (o.y > p.y - 0.1 && o.y < p.y + top && Math.hypot(o.x - p.x, o.z - p.z) < 0.55) return { n: [0, 1, 0], kind: 'player', player: p };
    }
    return null;
  }

  onImpact(o, hit) {
    switch (o.type) {
      case 'cracker': return this.explode(o, o.x, o.y, o.z);
      case 'gas': return this.burstGas(o, o.x, o.y, o.z);
      case 'flame': return this.burstFlame(o, o.x, o.y, o.z);
      case 'implosion': case 'remote':
        o.vx = o.vy = o.vz = 0; o.st = 1; o.stuckAt = o.age; return;
      default: { // timer + homing bounce
        const n = hit.n, e = 0.38;
        const vn = o.vx * n[0] + o.vy * n[1] + o.vz * n[2];
        if (vn < 0) {
          o.vx -= (1 + e) * vn * n[0]; o.vy -= (1 + e) * vn * n[1]; o.vz -= (1 + e) * vn * n[2];
          const f = hit.kind === 'ground' ? 0.72 : 0.9;
          const nvn = o.vx * n[0] + o.vy * n[1] + o.vz * n[2];
          const tx = o.vx - nvn * n[0], ty = o.vy - nvn * n[1], tz = o.vz - nvn * n[2];
          o.vx = tx * f + nvn * n[0]; o.vy = ty * f + nvn * n[1]; o.vz = tz * f + nvn * n[2];
        }
        if (hit.kind === 'ground' && Math.hypot(o.vx, o.vy, o.vz) < 1.4) { o.vx = o.vy = o.vz = 0; o.st = 1; }
      }
    }
  }

  stepOrb(o, dt) {
    o.age += dt;
    const def = ORB[o.type];
    if (o.type === 'timer' && o.age >= o.fuse) return this.explode(o, o.x, o.y, o.z);
    if (o.type === 'remote' && o.age >= def.life) return this.explode(o, o.x, o.y, o.z);
    if (o.type === 'implosion' && o.st >= 1) {
      const since = o.age - o.stuckAt;
      if (since >= def.delay && o.st === 1) o.st = 2;
      if (since >= def.delay + def.suck) return this.explode(o, o.x, o.y, o.z);
      return;
    }
    if (o.type === 'homing') {
      if (o.age > def.life) return this.explode(o, o.x, o.y, o.z);
      if (o.age > def.arm && o.st !== 3) {
        let best = null, bd = def.seek;
        for (const p of this.players.values()) {
          if (!p.alive || p.phase !== 'play' || p.id === o.owner) continue;
          const d = Math.hypot(p.x - o.x, p.z - o.z);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) { o.st = 3; o.target = best.id; }
      }
      if (o.st === 3) {
        const t = this.players.get(o.target);
        if (!t || !t.alive) { o.st = 0; o.target = null; }
        else {
          const ty = Math.max(t.y + 0.9, floorAt(o.x, o.z, o.y) + 1.2);
          const dx = t.x - o.x, dy = ty - o.y, dz = t.z - o.z, d = Math.hypot(dx, dy, dz);
          if (d < 1.7) return this.explode(o, o.x, o.y, o.z);
          const cs = Math.hypot(o.vx, o.vy, o.vz) || def.speed;
          const turn = Math.min(1, 6 * dt);
          let vx = o.vx + (dx / d * def.speed - o.vx) * turn, vy = o.vy + (dy / d * def.speed - o.vy) * turn, vz = o.vz + (dz / d * def.speed - o.vz) * turn;
          const l = Math.hypot(vx, vy, vz) || 1; const sp = Math.min(def.speed, Math.max(cs, 4));
          o.vx = vx / l * sp; o.vy = vy / l * sp; o.vz = vz / l * sp;
          const sub = 2, h = dt / sub;
          for (let s = 0; s < sub; s++) {
            o.x += o.vx * h; o.y += o.vy * h; o.z += o.vz * h;
            const hit = this.collideOrb(o);
            if (hit) return this.explode(o, o.x, o.y, o.z);
          }
          return;
        }
      }
    }
    if (o.st === 1) return; // resting
    const sub = 2, h = dt / sub;
    for (let s = 0; s < sub; s++) {
      o.vy -= 9.8 * h;
      o.x += o.vx * h; o.y += o.vy * h; o.z += o.vz * h;
      const hit = this.collideOrb(o);
      if (hit) {
        if (hit.y !== undefined) o.y = hit.y;
        if (hit.px !== undefined) { o.x = hit.px; o.z = hit.pz; }
        if (hit.push !== undefined) { o.x += hit.n[0] * hit.push; o.y += hit.n[1] * hit.push; o.z += hit.n[2] * hit.push; }
        this.onImpact(o, hit);
        if (!this.orbs.has(o.id) || o.st === 1) return;
      }
      if (Math.abs(o.x) > 4500 || Math.abs(o.z) > 4500 || o.y < -120) { this.orbs.delete(o.id); return; }
    }
  }

  resolvePings() {
    const R = RULES.sonarRadius;
    for (const P of this.pings) {
      if (P.done || this.t - P.t < RULES.sonarWindow) continue;
      P.done = true;
      const owner = this.players.get(P.pid);
      if (!owner) continue;
      const cancelled = this.pings.some((Q) => Q !== P && Q.pid !== P.pid && Math.abs(Q.t - P.t) <= RULES.sonarWindow && Math.hypot(Q.x - P.x, Q.z - P.z) <= R);
      if (cancelled) { owner.send({ t: 'sonar', cancel: true }); continue; }
      const blips = [];
      for (const q of this.players.values()) {
        if (q === owner || !q.alive || q.phase === 'none') continue;
        const d = Math.hypot(q.x - P.x, q.z - P.z);
        if (d > R) continue;
        q.send({ t: 'pinged', x: r2(P.x), z: r2(P.z) });
        if (q.phase === 'drop' || this.t - q.lastMoving < 1.0) blips.push([r2(q.x), r2(q.z)]);
      }
      owner.send({ t: 'sonar', ox: r2(P.x), oz: r2(P.z), r: R, blips });
    }
    this.pings = this.pings.filter((P) => this.t - P.t < 2);
  }

  pickupStep() {
    for (const pk of this.pickups.values()) {
      if (!pk.active) { if (pk.k === 'cache' && this.t >= pk.respawnAt) { pk.active = true; pk.items = randomCacheItems(this.rnd); this.broadcast({ t: 'pk', add: [this.pkWire(pk)], del: [] }); } continue; }
      for (const p of this.players.values()) {
        if (!p.alive || p.phase !== 'play') continue;
        if (Math.hypot(p.x - pk.x, p.z - pk.z) > RULES.pickupRadius || Math.abs(p.y - (pk.y - 0.45)) > 3) continue;
        if (pk.k === 'chip') {
          p.chips += pk.n; this.pickups.delete(pk.id);
          this.broadcast({ t: 'pk', add: [], del: [pk.id] });
          this.broadcast({ t: 'ev', k: 'chip', id: p.id, n: pk.n });
          this.checkWin();
        } else {
          let changed = false;
          while (pk.items.length) {
            const slot = p.loadout.indexOf(null);
            if (slot < 0) break;
            p.loadout[slot] = pk.items.shift(); changed = true;
          }
          if (changed) { this.sendInv(p); p.send({ t: 'ev', k: 'got' }); }
          if (!pk.items.length) {
            this.broadcast({ t: 'pk', add: [], del: [pk.id] });
            if (pk.k === 'cache') { pk.active = false; pk.respawnAt = this.t + RULES.cacheRespawn; } else this.pickups.delete(pk.id);
          }
        }
        break;
      }
    }
  }

  step(dt) {
    this.t += dt; this.tick++;
    const w = wind(this.t);
    const t0 = BOT_DEBUG ? process.hrtime.bigint() : 0n;
    for (const p of this.players.values()) if (p.bot) { try { p.bot.update(dt); } catch (e) { console.error('bot error', p.name, e); } }
    if (BOT_DEBUG) {
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      this.botUs = (this.botUs || 0) + us; this.botMax = Math.max(this.botMax || 0, us);
      if (this.tick % 450 === 0) {
        console.log(`[practice ${this.id}] t=${this.t.toFixed(0)}s bot cpu avg ${(this.botUs / 450).toFixed(0)}us max ${this.botMax.toFixed(0)}us / tick`);
        this.botUs = 0; this.botMax = 0;
        for (const p of this.players.values()) if (p.bot) console.log(`   ${p.name.padEnd(8)} ${p.bot.levelName.padEnd(6)} ${p.bot.personaName.padEnd(9)} ${(p.alive ? p.bot.state : 'DEAD').padEnd(7)} hp=${Math.round(p.hp)} chips=${p.chips} kills=${p.kills} orbs=${p.bot.ammo()} scans=${p.bot.scans || 0} contacts=${p.bot.fresh(40).length} goal=${p.bot.goalKind} c=${JSON.stringify(p.bot.cstat || {})} s=${JSON.stringify(p.bot.sstat || {})} @${Math.round(p.x)},${Math.round(p.z)}`);
      }
    }
    for (const o of [...this.orbs.values()]) this.stepOrb(o, dt);
    // gas
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.age += dt;
      if (c.age >= c.life) { this.clouds.splice(i, 1); continue; }
      c.r = ORB.gas.r * Math.min(1, 0.3 + c.age / 2.2);
      c.x += w[0] * 0.8 * dt; c.z += w[1] * 0.8 * dt;
      const g = heightAt(c.x, c.z); if (c.y < g + 0.4) c.y = g + 0.4;
      for (const p of this.players.values()) {
        if (!p.alive || p.phase !== 'play') continue;
        if (Math.hypot(p.x - c.x, p.z - c.z) < c.r && Math.abs(p.y + 0.9 - c.y) < 4.5) this.hurt(p, ORB.gas.dps * dt, c.owner, 'gas', c.x, c.z);
      }
    }
    // fire lines
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.age += dt;
      if (f.age >= f.life) { this.fires.splice(i, 1); continue; }
      const grow = Math.min(1, f.age / 0.6) * ORB.flame.len;
      for (const p of this.players.values()) {
        if (!p.alive || p.phase !== 'play') continue;
        const rx = p.x - f.x, rz = p.z - f.z, tproj = Math.max(0, Math.min(grow, rx * f.ax + rz * f.az));
        const d = Math.hypot(rx - f.ax * tproj, rz - f.az * tproj);
        if (d < ORB.flame.width / 2 + 0.55 && Math.abs(p.y - heightAt(f.x + f.ax * tproj, f.z + f.az * tproj)) < 3.5) {
          this.hurt(p, ORB.flame.dps * dt, f.owner, 'fire', f.x, f.z);
          p.burnUntil = this.t + 3;
        }
      }
    }
    // burning, sea, drop failsafe
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.phase === 'drop' && this.t > 45) p.phase = 'play';
      if (p.phase !== 'play') continue;
      if (this.t < p.burnUntil) {
        if ((p.fl & FLAGS.SWIM)) p.burnUntil = 0; else this.hurt(p, 9 * dt, p.lastHitBy, 'fire');
      }
      if (heightAt(p.x, p.z) < WORLD.killDepth) this.hurt(p, 10 * dt, null, 'sea');
    }
    this.resolvePings();
    this.pickupStep();
    if (this.tick % 15 === 0 && this.t > 5) {
      // time limit
      if (this.t >= RULES.matchTime) {
        let best = null;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (!best || p.chips > best.chips || (p.chips === best.chips && p.hp > best.hp)) best = p;
        }
        this.end(best ? best.id : null, 'time');
        return;
      }
    }
    if (this.tick % 2 === 0) this.snapshot();
  }

  snapshot() {
    const pl = [];
    for (const p of this.players.values()) {
      if (p.phase === 'none') continue;
      let fl = p.fl;
      if (!p.alive) fl |= FLAGS.DEAD;
      if (p.phase === 'drop') fl |= FLAGS.DROP;
      if (this.t < p.shieldUntil) fl |= FLAGS.SHIELD;
      if (this.t < p.burnUntil) fl |= FLAGS.BURN;
      if (this.t - p.lastMoving < 0.4) fl |= FLAGS.MOVING;
      pl.push([p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), fl, Math.round(p.hp), p.chips]);
    }
    const orbs = [];
    for (const o of this.orbs.values()) {
      orbs.push([o.id, ORB_ORDER.indexOf(o.type), r2(o.x), r2(o.y), r2(o.z), o.st, o.owner, o.type === 'timer' ? r2(Math.max(0, o.fuse - o.age)) : o.num]);
    }
    const g = this.clouds.map((c) => [c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.r), r2(c.age)]);
    this.broadcast({ t: 'snap', n: this.tick, tm: r2(this.t), p: pl, o: orbs, g });
  }
}

setInterval(() => {
  for (const l of [...lobbies.values()]) l.update(TICK);
  const now = Date.now();
  for (const p of players.values()) if (p.conn && now - p.conn.last > 60000) p.conn.finish();
}, TICK * 1000 / SIM_SPEED);

process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

server.listen(PORT, HOST, () => {
  console.log(`\n  ORB ISLAND server running`);
  console.log(`  -> http://localhost:${PORT}`);
  console.log(`  players per match: ${MIN_PLAYERS}-${MAX_PLAYERS}   (MIN_PLAYERS=1 to test solo)\n`);
});
