/**
 * Camera shake from blasts striking home: kick(amount) on an impact (repulsor.js does, for hits on a
 * fighter), offset(time) each frame for the camera (view3d.js placeCamera adds it to the shot).
 *
 * Each kick is a jolt that dies away in a few tenths of a second, as a camera operator's hands take
 * the shock: smooth noise, not per-frame jitter, its amplitude decaying from the moment the kick
 * lands. With no kick in the last couple of seconds the offset is exactly zero, so a still shot
 * stays still. A kick is stamped on the clock of the first offset() after it, so the two modules
 * need not share a clock; a seek back past a kick drops it.
 */

const MAX = 12; // kicks remembered (older ones are long gone by then)
const TAU = 0.2; // seconds: how fast a kick dies away
const LIFE = 1.4; // ... until it is dropped
const kicks = [];
let n = 0; // kicks so far (each its own stretch of noise)
const out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

/** Smooth 1D noise in [-1, 1]. */
function noise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/**
 * A jolt: amount ~0.3 for a blast landing on a fighter, ~1 for a heavy one (they add up, to a limit).
 * @param {number} amount
 */
export function kick(amount) {
  if (!(amount > 0)) return;
  if (kicks.length >= MAX) kicks.shift();
  kicks.push({ a: Math.min(amount, 2), t0: null, seed: (++n * 37.137) % 100 });
}

/**
 * The shake at a time: translation (x, y, z: fractions of the camera's distance to its subject, along
 * its own right, up and back) and rotation (yaw, pitch, roll: radians). Zero when nothing has struck.
 * @param {number} time seconds (the camera's clock)
 * @returns {{x:number, y:number, z:number, yaw:number, pitch:number, roll:number}} the same object every call
 */
export function offset(time) {
  out.x = out.y = out.z = out.yaw = out.pitch = out.roll = 0;
  let total = 0;
  for (let i = kicks.length - 1; i >= 0; i--) {
    const k = kicks[i];
    if (k.t0 === null) k.t0 = time;
    const age = time - k.t0;
    if (age < -0.05 || age > LIFE) {
      kicks.splice(i, 1);
      continue;
    }
    if (age <= 0) continue;
    // A hard onset (a few ms) and an exponential settle; the high frequencies die first.
    const env = k.a * Math.min(1, age / 0.012) * Math.exp(-age / TAU);
    const f = 17 - 7 * Math.min(1, age / 0.5); // Hz: a sharp rattle settling to a sway
    const s = time * f + k.seed;
    out.yaw += env * 0.012 * noise(s);
    out.pitch += env * 0.01 * noise(s + 31.7);
    out.roll += env * 0.006 * noise(s * 0.7 + 57.3);
    out.x += env * 0.0035 * noise(s * 0.8 + 11.9);
    out.y += env * 0.0035 * noise(s * 0.8 + 77.1);
    total += env;
  }
  // (A pile-up of kicks saturates rather than shaking the shot apart.)
  if (total > 1.5) {
    const k = 1.5 / total;
    out.x *= k;
    out.y *= k;
    out.yaw *= k;
    out.pitch *= k;
    out.roll *= k;
  }
  return out;
}

/** Forget every kick (a new run). */
export function resetShake() {
  kicks.length = 0;
}
