// Small helpers shared by the bot modules.
const TAU = Math.PI * 2;
export const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
export const rnd = (a, b) => a + Math.random() * (b - a);
export const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// yaw convention shared with the client: forward = (-sin yaw, -cos yaw)
export const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
