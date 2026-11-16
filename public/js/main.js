// Entry point: renderer, loading, menu / matchmaking / lobby UI, settings, results, main loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { S, set, applyPreset, onChange, save } from './settings.js';
import { RULES, ORB, ORB_ORDER } from './rules.js';
import { makeTextures } from './textures.js';
import { World } from './world.js';
import { Effects } from './effects.js';
import { AudioEngine } from './audio.js';
import { Net } from './net.js';
import { Voice } from './voice.js';
import { HUD, orbIcon } from './hud.js';
import { Game } from './game.js';

window.__orbBooted = true;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (id, v) => $(id).classList.toggle('hidden', !v);

// ------------------------------------------------------------------ renderer / scene
const canvas = $('view');

// Create the WebGL2 context ourselves so we can retry with gentler options (some older GPUs / Chromebooks refuse
// the first set) and, if it still fails, explain what is wrong instead of just crashing.
function createGL() {
  const tries = [
    { antialias: false, powerPreference: 'high-performance', stencil: false },
    { antialias: false, powerPreference: 'default', stencil: false },
    { antialias: false, alpha: false },
    {},
  ];
  for (const attrs of tries) {
    try { const gl = canvas.getContext('webgl2', attrs); if (gl) return gl; } catch (e) { /* try next */ }
  }
  return null;
}
function explainNoGL() {
  let gl1 = false;
  try { const c = document.createElement('canvas'); gl1 = !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch (e) { /* none */ }
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
  const msg = 'This browser could not start WebGL 2, which the game needs. ' +
    '(Chrome version: ' + (m ? m[1] : 'unknown') + '; basic WebGL 1: ' + (gl1 ? 'yes' : 'no') + ')\n' +
    'Things to try: open https://get.webgl.org/webgl2/ to test your browser; make sure hardware acceleration is on; ' +
    'in Chrome open chrome://flags/#ignore-gpu-blocklist, set it to Enabled and restart the browser; update Chrome / the OS; ' +
    'or play on a newer computer.';
  const t = document.getElementById('load-text'); if (t) t.textContent = 'Your browser could not start WebGL 2.';
  throw new Error(msg);
}
const gl = createGL() || explainNoGL();
const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(S.fov, innerWidth / innerHeight, 0.1, 6000);
camera.rotation.order = 'YXZ';
scene.add(camera);
let composer = null;

function buildComposer() {
  if (composer) { try { composer.dispose(); } catch {} }
  const pr = Math.min(devicePixelRatio || 1, 2) * S.renderScale;
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
  composer = new EffectComposer(renderer);
  const samples = Math.min(S.aa || 0, renderer.capabilities.maxSamples || 0);
  composer.renderTarget1.samples = samples; composer.renderTarget2.samples = samples;
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  if (S.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.65, 0.95));
  composer.addPass(new OutputPass());
}
function onResize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  if (composer) { composer.setPixelRatio(Math.min(devicePixelRatio || 1, 2) * S.renderScale); composer.setSize(innerWidth, innerHeight); }
}
window.addEventListener('resize', onResize);

// ------------------------------------------------------------------ subsystems (created in boot)
let world, effects, audio, net, voice, hud, game, tex;
let state = 'loading'; // loading | menu | queue | match | results
let lobbyInfo = null, colors = {}, lobbyJoinedAt = 0, endAt = 0, firstLock = true;

// ------------------------------------------------------------------ boot
async function boot() {
  buildComposer();
  tex = makeTextures(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  world = new World(scene, renderer, camera, tex);
  await world.init((p) => { $('load-fill').style.width = Math.round(p * 100) + '%'; $('load-text').textContent = p < 1 ? 'Surveying the island…' : 'Ready'; });
  effects = new Effects(scene, camera, tex);
  audio = new AudioEngine(); net = new Net(); voice = new Voice(audio, net); hud = new HUD();
  game = new Game({ scene, camera, renderer, world, effects, audio, voice, net, hud, tex });
  voice.onChange = updateMicUI;
  game.onLock = onLockChange;
  bindUI(); bindNet(); buildSettingsUI(); buildHowTo();
  $('in-name').value = S.name || ''; $('in-code').value = S.code || '';
  try { const pr = JSON.parse(localStorage.getItem('orb-island-practice')); if (pr) { $('in-bots').value = String(pr.bots); $('in-level').value = pr.level; } else $('in-level').value = 'normal'; } catch { /* defaults */ }
  onChange(onSettingChanged);
  window.__orb = { game, net, hud, world, effects, audio, voice, camera, scene, renderer, S };
  show('loading', false); setState('menu');
  pollStats(); setInterval(pollStats, 6000);
  requestAnimationFrame(frame);
}

function setState(s) {
  state = s;
  show('menu', s === 'menu'); show('lobby', s === 'queue');
  show('results', s === 'results');
  if (s !== 'match') show('pause', false);
  if (s === 'menu' || s === 'queue') { hud && hud.show(false); }
  updatePause();
}

// ------------------------------------------------------------------ menu / lobby
async function pollStats() {
  if (state !== 'menu') return;
  try { const r = await (await fetch('/api/stats')).json(); $('stats').textContent = `${r.online} online · ${r.searching} searching · ${r.inMatch} in match`; } catch { $('stats').textContent = 'Server offline'; }
}

async function play() {
  const name = ($('in-name').value || '').trim().slice(0, 16) || 'Player';
  const code = ($('in-code').value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  set('name', name); set('code', code);
  audio.init(); audio.resume(); audio.uiClick(); audio.startMusic();
  setState('queue'); lobbyInfo = null; lobbyJoinedAt = performance.now();
  $('lb-status').textContent = 'Connecting to server…'; $('lb-count').textContent = ''; $('lb-players').innerHTML = ''; $('lb-chat-log').innerHTML = ''; show('lb-code', false);
  try { await net.connect(); } catch (e) { setState('menu'); alert('Could not reach the game server.\n' + e.message); return; }
  net.send({ t: 'queue', name, code });
}

function practice() {
  const name = ($('in-name').value || '').trim().slice(0, 16) || 'Player';
  const bots = Number($('in-bots').value) || 5, level = $('in-level').value || 'normal';
  set('name', name);
  try { localStorage.setItem('orb-island-practice', JSON.stringify({ bots, level })); } catch {}
  audio.init(); audio.resume(); audio.uiClick(); audio.startMusic();
  setState('queue'); lobbyInfo = null; lobbyJoinedAt = performance.now();
  $('lb-status').textContent = 'Connecting to server…'; $('lb-count').textContent = ''; $('lb-players').innerHTML = ''; $('lb-chat-log').innerHTML = ''; show('lb-code', false);
  net.connect().then(() => net.send({ t: 'queue', name, code: '', practice: { bots, level } }))
    .catch((e) => { setState('menu'); alert('Could not reach the game server.\n' + e.message); });
}

function leaveToMenu() {
  net.send({ t: 'leave' });
  game.stop(false); voice.closeAll(); audio.stopAmbience();
  setState('menu'); pollStats();
}

function renderLobby(m) {
  lobbyInfo = m;
  for (const p of m.players) colors[p.id] = p.color;
  show('lb-code', !!m.code); if (m.code) $('lb-code').textContent = 'CODE ' + m.code;
  $('lb-title').textContent = m.practice ? 'PRACTICE vs BOTS' : m.code ? 'PRIVATE LOBBY' : 'MATCHMAKING';
  show('lb-voice-note', !m.practice); $('lobby').classList.toggle('practice-lobby', !!m.practice); $('btn-cancel').textContent = m.practice ? 'Cancel practice' : 'Leave queue';
  const n = m.players.length, full = n >= m.max;
  let status;
  if (m.practice) status = m.countdown !== null ? 'Practice match ready' : 'Setting up…';
  else if (n < m.min) status = `Searching for players… (${n}/${m.min} needed)`;
  else if (m.countdown !== null) status = full ? 'Lobby full' : 'Match found';
  else status = 'Waiting…';
  $('lb-status').textContent = status;
  const waited = (performance.now() - lobbyJoinedAt) / 1000;
  $('lb-count').textContent = n >= m.min && m.countdown !== null ? `Drop in ${m.countdown}s` : (waited > 15 && n < m.min ? 'Nobody else yet. Invite friends, or share a private lobby code.' : '');
  $('lb-players').innerHTML = m.players.map((p) => `<div class="pl" data-id="${esc(p.id)}"><i style="background:${p.color}"></i><span class="nm">${esc(p.name)}</span>${p.id === net.id ? '<em>you</em>' : ''}${p.bot ? '<em class="bot">bot</em>' : ''}<span class="mic"></span></div>`).join('') + (m.practice ? '' : `<div class="muted small-text">${n}/${m.max} players</div>`);
  voice.setPeers(m.players.filter((p) => !p.bot).map((p) => p.id), net.id); // bots have no voice
}

function bindNet() {
  net.on('lobby', (m) => {
    if (state === 'results' || state === 'match') {
      if (m.state !== 'waiting') return;
      game.stop(false); audio.stopAmbience(); lobbyJoinedAt = performance.now(); setState('queue');
    }
    if (state === 'queue') renderLobby(m);
  });
  net.on('start', (m) => {
    if (state !== 'queue') return;
    audio.stopMusic(); game.begin(m); setState('match'); firstLock = true; updatePause();
  });
  net.on('end', (m) => { if (state !== 'match') return; game.finish(); showResults(m); });
  net.on('left', (m) => { if (state === 'queue') setState('menu'); if (m && m.why === 'busy') alert('The server is running its maximum number of practice matches right now. Try again in a minute.'); });
  net.on('close', () => {
    if (state === 'menu' || state === 'loading') return;
    game.stop(false); voice.closeAll(); audio.stopAmbience(); audio.stopMusic(); setState('menu'); $('stats').textContent = 'Disconnected from server';
  });
  net.on('chat', (m) => {
    const col = colors[m.id] || '#fff';
    if (state === 'match' || state === 'results') hud.chat(m.name, col, m.text);
    else { const d = document.createElement('div'); d.className = 'cl'; d.innerHTML = `<b style="color:${col}">${esc(m.name)}</b> ${esc(m.text)}`; const log = $('lb-chat-log'); log.append(d); log.scrollTop = log.scrollHeight; }
  });
}

// ------------------------------------------------------------------ pause / lock
function overlayOpen() { return !$('settings').classList.contains('hidden') || !$('howto').classList.contains('hidden'); }
function updatePause() {
  if (!game) return;
  const want = state === 'match' && game.active && !game.ended && !game.locked;
  show('pause', want);
  if (want) $('pause-title').textContent = firstLock ? 'DROP READY' : 'PAUSED';
}
function onLockChange(locked) { if (locked) firstLock = false; updatePause(); }
function lockPointer() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch {} }

// ------------------------------------------------------------------ results
function showResults(m) {
  const names = { yes: 1 };
  const win = m.results.find((r) => r.id === m.winner);
  const you = m.winner === net.id;
  $('res-title').textContent = you ? 'VICTORY' : win ? `${win.name.toUpperCase()} WINS` : 'NO SURVIVORS';
  $('res-title').className = 'panel-head ' + (you ? 'win' : '');
  $('res-sub').textContent = { chips: `Collected ${game.goal} chips`, last: 'Last one standing', time: 'Time expired: most chips wins', draw: 'Everyone fell' }[m.reason] || '';
  $('res-body').innerHTML = m.results.map((r, i) => `<tr class="${r.id === net.id ? 'me' : ''} ${r.id === m.winner ? 'winner' : ''}"><td>${i + 1}</td><td><i style="background:${r.color}"></i>${esc(r.name)}${r.bot ? '<span class="botTag">bot</span>' : ''}</td><td>${r.chips}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.id === m.winner ? '★' : ''}</td></tr>`).join('');
  endAt = performance.now() + RULES.endScreen * 1000;
  setState('results');
}

// ------------------------------------------------------------------ UI wiring
function bindUI() {
  $('btn-play').onclick = play;
  $('btn-practice').onclick = practice;
  $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
  $('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
  $('btn-settings').onclick = () => openOverlay('settings');
  $('btn-lb-settings').onclick = () => openOverlay('settings');
  $('btn-pause-settings').onclick = () => openOverlay('settings');
  $('btn-how').onclick = () => openOverlay('howto');
  $('btn-pause-how').onclick = () => openOverlay('howto');
  $('btn-cancel').onclick = leaveToMenu;
  $('btn-leave').onclick = leaveToMenu;
  $('btn-res-leave').onclick = leaveToMenu;
  $('btn-resume').onclick = lockPointer;
  $('pause').addEventListener('click', (e) => { if (!e.target.closest('button') && !e.target.closest('.panel')) lockPointer(); else if (e.target.closest('.panel') && !e.target.closest('button')) lockPointer(); });
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { show(b.dataset.close, false); audio && audio.uiClick(); }; });
  $('btn-mic').onclick = () => { voice.enableMic(); };
  $('lb-chat-input').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { const t = e.target.value.trim(); if (t) net.send({ t: 'chat', text: t }); e.target.value = ''; }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.code === 'Escape') { for (const id of ['settings', 'howto']) if (!$(id).classList.contains('hidden')) { show(id, false); return; } }
    if (state === 'queue' && e.code === 'KeyV' && !e.repeat) { if (voice.micState === 'on') voice.setPtt(true); else voice.enableMic(); }
  });
  window.addEventListener('keyup', (e) => { if (state === 'queue' && e.code === 'KeyV') voice.setPtt(false); });
  document.addEventListener('click', () => { if (audio) { audio.init(); audio.resume(); } }, { once: false });
}
function openOverlay(id) { show(id, true); if (id === 'settings') refreshSettingsUI(); audio && audio.uiClick(); }

function updateMicUI() {
  const v = voice, el = $('mic-state'), b = $('btn-mic');
  const t = { off: 'Microphone off', requesting: 'Waiting for permission…', on: S.ptt ? 'Mic ready · hold V to talk' : 'Mic live', denied: 'Microphone blocked by browser', unsupported: 'Mic needs HTTPS or localhost' }[v.micState];
  el.textContent = t || '';
  b.classList.toggle('hidden', v.micState === 'on');
  b.textContent = v.micState === 'denied' ? 'Retry microphone' : 'Enable microphone';
}

// ------------------------------------------------------------------ settings UI
const SCHEMA = {
  Graphics: [
    { k: 'preset', type: 'select', label: 'Quality preset', opts: [['potato', 'Potato (weak laptops / Chromebooks)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']], hint: 'Pick the closest to your GPU, then fine-tune below.' },
    { k: 'renderScale', type: 'range', min: 0.5, max: 1.25, step: 0.05, label: 'Render scale', fmt: (v) => Math.round(v * 100) + '%', hint: 'Biggest single FPS lever. Lower = blurrier but faster.' },
    { k: 'drawDist', type: 'range', min: 250, max: 1400, step: 50, label: 'View distance', fmt: (v) => v + ' m' },
    { k: 'treeDist', type: 'range', min: 150, max: 900, step: 50, label: 'Tree distance', fmt: (v) => v + ' m' },
    { k: 'foliageDetail', type: 'select', label: 'Foliage detail', opts: [[0, 'Low'], [1, 'Medium'], [2, 'High']] },
    { k: 'grass', type: 'select', label: 'Grass & ferns', opts: [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High']] },
    { k: 'shadows', type: 'select', label: 'Shadows', opts: [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High']] },
    { k: 'shadowDist', type: 'range', min: 40, max: 200, step: 10, label: 'Shadow distance', fmt: (v) => v + ' m' },
    { k: 'water', type: 'select', label: 'Water quality', opts: [[0, 'Simple'], [1, 'Standard'], [2, 'High']] },
    { k: 'effects', type: 'select', label: 'Effects (smoke, fire, debris)', opts: [[1, 'Low'], [2, 'Medium'], [3, 'High']] },
    { k: 'aa', type: 'select', label: 'Anti-aliasing (MSAA)', opts: [[0, 'Off'], [2, '2×'], [4, '4×'], [8, '8×']] },
    { k: 'bloom', type: 'check', label: 'Bloom / glow' },
    { k: 'fov', type: 'range', min: 60, max: 110, step: 1, label: 'Field of view', fmt: (v) => v + '°' },
    { k: 'fpsCap', type: 'select', label: 'FPS limit', opts: [[0, 'Unlimited'], [30, '30'], [60, '60'], [90, '90'], [120, '120'], [144, '144']] },
    { k: 'bob', type: 'check', label: 'Camera bob' },
    { k: 'showFps', type: 'check', label: 'Show FPS counter' },
  ],
  Audio: [
    { k: 'masterVol', type: 'range', min: 0, max: 1, step: 0.05, label: 'Master volume', fmt: pct },
    { k: 'sfxVol', type: 'range', min: 0, max: 1.5, step: 0.05, label: 'Effects', fmt: pct },
    { k: 'ambVol', type: 'range', min: 0, max: 1.5, step: 0.05, label: 'Ambience', fmt: pct },
    { k: 'musicVol', type: 'range', min: 0, max: 1, step: 0.05, label: 'Music', fmt: pct },
    { k: 'voiceVol', type: 'range', min: 0, max: 2, step: 0.05, label: 'Voice chat', fmt: pct },
  ],
  Controls: [
    { k: 'sens', type: 'range', min: 0.2, max: 3, step: 0.05, label: 'Mouse sensitivity', fmt: (v) => v.toFixed(2) + '×' },
    { k: 'invertY', type: 'check', label: 'Invert Y axis' },
  ],
  Voice: [
    { k: 'voiceMode', type: 'select', label: 'Voice range', opts: [['prox', 'Proximity (3D, fades with distance)'], ['global', 'Global (everyone hears everyone)']], hint: 'Proximity: you hear players near you, in the direction they are. Global: classic party chat.' },
    { k: 'ptt', type: 'check', label: 'Push-to-talk (hold V)' },
    { k: 'micOn', type: 'check', label: 'Microphone enabled' },
    { type: 'button', label: 'Enable / test microphone', fn: () => voice.enableMic() },
  ],
};
function pct(v) { return Math.round(v * 100) + '%'; }
let curTab = 'Graphics';

function buildSettingsUI() {
  const tabs = $('set-tabs'); tabs.innerHTML = '';
  for (const name of Object.keys(SCHEMA)) {
    const b = document.createElement('button'); b.textContent = name; b.className = name === curTab ? 'on' : ''; b.onclick = () => { curTab = name; buildSettingsUI(); };
    tabs.append(b);
  }
  const body = $('set-body'); body.innerHTML = '';
  for (const f of SCHEMA[curTab]) {
    const row = document.createElement('div'); row.className = 'srow';
    if (f.type === 'button') { const b = document.createElement('button'); b.className = 'ghost small'; b.textContent = f.label; b.onclick = f.fn; row.append(b); body.append(row); continue; }
    const lab = document.createElement('label'); lab.textContent = f.label; row.append(lab);
    let input;
    if (f.type === 'range') {
      input = document.createElement('input'); input.type = 'range'; input.min = f.min; input.max = f.max; input.step = f.step; input.value = S[f.k];
      const val = document.createElement('span'); val.className = 'val'; val.textContent = f.fmt(+S[f.k]);
      input.oninput = () => { val.textContent = f.fmt(+input.value); };
      input.onchange = () => set(f.k, +input.value);
      row.append(input, val);
    } else if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, t] of f.opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.append(o); }
      input.value = String(S[f.k]);
      input.onchange = () => { if (f.k === 'preset') { if (input.value !== 'custom') applyPreset(input.value); } else set(f.k, isNaN(+input.value) ? input.value : +input.value); };
      row.append(input);
    } else if (f.type === 'check') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!S[f.k];
      input.onchange = () => set(f.k, input.checked);
      row.append(input);
    }
    if (f.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = f.hint; row.append(h); }
    body.append(row);
  }
}
function refreshSettingsUI() { buildSettingsUI(); }

function onSettingChanged(key) {
  const worldKeys = ['drawDist', 'treeDist', 'shadows', 'shadowDist', 'grass', 'water', 'foliageDetail', 'preset'];
  const compKeys = ['aa', 'bloom', 'renderScale', 'preset'];
  if (worldKeys.includes(key)) world.applySettings();
  if (compKeys.includes(key)) buildComposer();
  if (key === 'fov') { camera.fov = S.fov; camera.updateProjectionMatrix(); }
  if (['ptt', 'micOn'].includes(key)) { voice.refresh(); updateMicUI(); }
  if (key === 'preset' && !$('settings').classList.contains('hidden')) buildSettingsUI();
  if (key === 'showFps') show('fps', !!S.showFps);
}

function buildHowTo() {
  $('how-goal').textContent = RULES.chipGoal;
  $('orb-list').innerHTML = ORB_ORDER.map((k) => {
    const o = ORB[k], c = orbIcon(k, 56);
    return `<div class="orb"><img width="44" height="44" src="${c.toDataURL()}" alt=""><div><b style="color:${o.color}">${o.name}</b><span>${esc(o.desc)}</span></div></div>`;
  }).join('');
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), fpsT = 0, fpsN = 0, lastFrame = 0, errs = 0, lobbyVoiceT = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (S.fpsCap > 0 && ts - lastFrame < 1000 / S.fpsCap - 1.5) return;
  lastFrame = ts;
  const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
  try {
    const inGame = game.active && (state === 'match' || state === 'results');
    if (inGame) game.update(dt);
    else {
      const t = ts / 1000, a = t * 0.045;
      camera.position.set(Math.cos(a) * 640, 150 + Math.sin(t * 0.13) * 28, Math.sin(a) * 640);
      camera.lookAt(0, 22, 0);
      if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); }
      if (ts - lobbyVoiceT > 200 && state === 'queue') { lobbyVoiceT = ts; voice.update(() => null, false); lobbySpeakers(); }
    }
    if (!inGame && camera.fov === 60 && state === 'match') camera.fov = S.fov;
    world.update(dt, camera.position, inGame && game.focus ? game.focus : camera.position);
    effects.update(dt, camera, renderer);
    if (state === 'results') { const s = Math.max(0, Math.ceil((endAt - performance.now()) / 1000)); $('res-next').textContent = `Returning to the lobby in ${s}s`; }
    composer.render(dt);
    if (S.showFps) { fpsN++; fpsT += dt; if (fpsT >= 0.5) { $('fps').textContent = Math.round(fpsN / fpsT) + ' FPS · ' + net.pingMs + ' ms'; fpsN = 0; fpsT = 0; } }
  } catch (e) {
    if (errs++ < 3) { const b = $('errbox'); b.classList.remove('hidden'); b.querySelector('pre').textContent += (e && e.stack ? e.stack : String(e)) + '\n'; }
    console.error(e);
  }
}
function lobbySpeakers() {
  document.querySelectorAll('#lb-players .pl').forEach((el) => {
    const id = el.dataset.id, sp = id === net.id ? voice.localSpeaking() : voice.speaking(id);
    el.classList.toggle('talk', !!sp);
    el.querySelector('.mic').textContent = (id === net.id || el.querySelector('.bot')) ? '' : (voice.state(id) === 'connected' ? '🔊' : '…');
  });
}

boot().catch((e) => {
  console.error(e);
  const b = $('errbox'); b.classList.remove('hidden'); b.querySelector('pre').textContent += (e && e.stack ? e.stack : String(e)) + '\n';
  $('load-text').textContent = 'Failed to start. See error below.';
});
