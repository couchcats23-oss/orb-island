// Persistent user settings (graphics, audio, controls, voice).
const KEY = 'orbIsland.settings.v1';

export const PRESETS = {
  // Lowest spec: dual-core Celeron-class laptops / Chromebooks with integrated graphics. (effects must stay >= 1)
  potato: { drawDist: 220,  treeDist: 110, shadows: 0, shadowDist: 40,  grass: 0, bloom: false, aa: 0, renderScale: 0.5,  water: 0, effects: 1, foliageDetail: 0 },
  low:   { drawDist: 350,  treeDist: 220, shadows: 0, shadowDist: 60,  grass: 0, bloom: false, aa: 0, renderScale: 0.75, water: 0, effects: 1, foliageDetail: 0 },
  medium: { drawDist: 550,  treeDist: 350, shadows: 1, shadowDist: 80,  grass: 1, bloom: false, aa: 0, renderScale: 1,    water: 1, effects: 2, foliageDetail: 1 },
  high:   { drawDist: 800,  treeDist: 520, shadows: 2, shadowDist: 110, grass: 2, bloom: true,  aa: 4, renderScale: 1,    water: 2, effects: 3, foliageDetail: 2 },
  ultra:  { drawDist: 1200, treeDist: 800, shadows: 3, shadowDist: 150, grass: 3, bloom: true,  aa: 8, renderScale: 1,    water: 2, effects: 3, foliageDetail: 2 },
};

export const DEFAULTS = {
  preset: 'high', ...PRESETS.high,
  fov: 78, sens: 1.0, invertY: false, bob: true, showFps: false, fpsCap: 0,
  masterVol: 0.8, sfxVol: 1.0, ambVol: 0.7, musicVol: 0.35, voiceVol: 1.0,
  voiceMode: 'prox', ptt: true, micOn: true, micGain: 1.0,
  name: '', code: '',
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

const stored = load();
export const S = { ...DEFAULTS };
if (stored) Object.assign(S, stored);
else {
  // First run: pick a sensible preset for the hardware (still changeable in Settings).
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;
  const pick = (cores <= 2 || mem <= 2) ? 'potato' : (cores <= 4 || mem <= 4) ? 'low' : null;
  if (pick) { Object.assign(S, PRESETS[pick]); S.preset = pick; if (pick === 'potato') S.fpsCap = 30; }
}

const subs = new Set();
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
export function set(key, value) {
  S[key] = value;
  if (key in PRESETS.high) S.preset = 'custom';
  save();
  subs.forEach((f) => f(key, value));
}
export function applyPreset(name) {
  if (!PRESETS[name]) return;
  Object.assign(S, PRESETS[name]);
  S.preset = name;
  save();
  subs.forEach((f) => f('preset', name));
}
