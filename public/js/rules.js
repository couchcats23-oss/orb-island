// Shared game rules & constants (imported by both the Node server and the browser client).

export const RULES = {
  maxPlayers: 12,
  minPlayers: 2,
  lobbyCountdown: 25,   // seconds once min players reached
  fullCountdown: 6,     // seconds when lobby is full
  matchTime: 780,       // 13 minutes
  endScreen: 14,
  chipGoal: 3,          // chips taken from other players needed to win
  hp: 100,

  // Chip sonar (left hand IC chip)
  sonarRadius: 150,
  sonarCooldown: 4.0,
  sonarWindow: 0.5,     // two pings inside this window and range cancel each other out

  // Player movement
  eye: 1.7, eyeCrouch: 1.05, radius: 0.42, height: 1.8,
  walk: 5.0, sprint: 8.4, crouch: 2.5, swim: 2.4,
  jump: 5.2, gravity: 15,
  dropHeight: 110, dropSpeed: 5.5, dropGlide: 4.5,

  // Orbs
  throwMin: 9, throwMax: 31, chargeTime: 1.1,
  pickupRadius: 2.3,
  cacheRespawn: 100,
};

// Order matters: the index is what goes over the wire.
export const ORB_ORDER = ['cracker', 'timer', 'implosion', 'gas', 'homing', 'remote', 'flame', 'barrier'];
export const SPECIALS = ['implosion', 'gas', 'homing', 'remote', 'flame', 'barrier'];

export const ORB = {
  cracker:   { name: 'Cracker',     blast: 7.0, kill: 2.0, color: '#ff9a3c', desc: 'Explodes on impact. The most common orb: simple, reliable, low yield.' },
  timer:     { name: 'Timer',       blast: 9.5, kill: 2.8, fuse: 10, color: '#ffd23c', desc: 'Counts down from 10s (adjust with Z / X). Throw it so it bursts at head height.' },
  implosion: { name: 'Implosion',   blast: 8.0, kill: 4.2, delay: 0.6, suck: 1.8, pull: 11, trees: 9, color: '#8f7bff', desc: 'Sticks to what it hits, drags everything inward, then collapses. Flattens trees.' },
  gas:       { name: 'Blazing Gas', life: 16, r: 9.5, dps: 15, color: '#ffb347', desc: 'Releases a burning toxic cloud that drifts with the wind. Flushes people out of forest.' },
  homing:    { name: 'Homing',      blast: 4.2, kill: 1.4, speed: 10, arm: 0.7, seek: 40, life: 16, color: '#4cd2ff', desc: 'Small propeller orb that locks onto the nearest player. Weak blast.' },
  remote:    { name: 'Remote',      blast: 7.5, kill: 2.6, life: 150, color: '#ff4d6d', desc: 'Sticks to any surface. Detonate with G (oldest first) or Shift+G (all).' },
  flame:     { name: 'Flame',       len: 14, width: 1.5, life: 9, dps: 26, color: '#ff5a1f', desc: '1300°C oil. Splits into four lines of fire in a cross pattern.' },
  barrier:   { name: 'Barrier',     dur: 7, color: '#6fffd0', desc: 'Not thrown. Wraps you in an energy barrier that stops blasts, gas and fire.' },
};

export function orbDamage(type, d) {
  const o = ORB[type];
  if (!o || o.blast === undefined) return 0;
  if (d <= o.kill) return 100;
  if (d >= o.blast) return 0;
  return 100 * (1 - (d - o.kill) / (o.blast - o.kill));
}

export function makeLoadout(rnd) {
  const s = [...SPECIALS];
  for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
  return ['cracker', 'cracker', 'cracker', 'timer', 'timer', s[0], s[1], s[2]];
}

export const FLAGS = { CROUCH: 1, SPRINT: 2, SWIM: 4, DROP: 8, DEAD: 16, SHIELD: 32, BURN: 64, MOVING: 128 };

export const PLAYER_COLORS = [
  '#4cc9f0', '#f72585', '#b5e48c', '#ffd166', '#c77dff', '#ff7b54',
  '#2ec4b6', '#e63946', '#90be6d', '#f9c74f', '#9d8df1', '#00b4d8',
];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
