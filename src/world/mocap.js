/**
 * Motion-captured clips (Mixamo, baked onto the driver rig by the mocap bake tool): a clip's pose at a
 * time, blended between its frames: the 22 driver bones' local rotations (the rig's rest is no
 * rotation) and the hips' offset from their rest (model units, his frame: +z front, +x left). A clip can
 * be mirrored (left for right: Thanos casts with his left, the gauntlet hand). See mocap-clips.js for the
 * clips and mocap-path.js for where they carry him.
 */

import BIN from '../../assets/mocap/clips.bin';
import { BONES, CLIPS, FPS } from './mocap-clips.js';

export { BONES };
const NB = BONES.length;
// (The pose data as 16-bit words: copied if the inlined bytes are not 2-aligned.)
const bytes = BIN.byteOffset % 2 ? BIN.slice() : BIN;
const data = new Map();
for (const [name, c] of Object.entries(CLIPS)) {
  const q = new Int16Array(bytes.buffer, bytes.byteOffset + c.offset, c.frames * NB * 4);
  const h = new Int16Array(bytes.buffer, bytes.byteOffset + c.offset + c.frames * NB * 8, c.frames * 3);
  data.set(name, { c, q, h });
}
// Mirroring: each bone's twin on the other side.
const TWIN = BONES.map((b) => {
  const t = b.endsWith('L') ? b.slice(0, -1) + 'R' : b.endsWith('R') ? b.slice(0, -1) + 'L' : b;
  return BONES.indexOf(t);
});

/** A pose to sample into: per bone a quaternion (x, y, z, w), and the hips' offset. */
export function pose() {
  return { q: new Float32Array(NB * 4), hips: [0, 0, 0] };
}

/**
 * The clip's pose t seconds in (held at its last frame, or looping), into out.
 * @param {string} name
 * @param {number} t
 * @param {boolean} loop
 * @param {boolean} mirror
 * @param {{q: Float32Array, hips: number[]}} out
 */
export function sample(name, t, loop, mirror, out) {
  const d = data.get(name);
  if (!d) throw new Error(`no mocap clip ${name}`);
  const last = d.c.frames - 1;
  let f = t * FPS;
  if (loop) f -= Math.floor(f / last) * last;
  else f = Math.max(0, Math.min(last, f));
  const i0 = Math.min(last - 1, Math.floor(f));
  const a = f - i0;
  const { q, h } = d;
  for (let b = 0; b < NB; b++) {
    const o0 = (i0 * NB + b) * 4;
    const o1 = o0 + NB * 4;
    let x1 = q[o1];
    let y1 = q[o1 + 1];
    let z1 = q[o1 + 2];
    let w1 = q[o1 + 3];
    if (q[o0] * x1 + q[o0 + 1] * y1 + q[o0 + 2] * z1 + q[o0 + 3] * w1 < 0) {
      x1 = -x1;
      y1 = -y1;
      z1 = -z1;
      w1 = -w1;
    }
    let x = q[o0] + (x1 - q[o0]) * a;
    let y = q[o0 + 1] + (y1 - q[o0 + 1]) * a;
    let z = q[o0 + 2] + (z1 - q[o0 + 2]) * a;
    let w = q[o0 + 3] + (w1 - q[o0 + 3]) * a;
    const l = Math.hypot(x, y, z, w) || 1;
    x /= l;
    y /= l;
    z /= l;
    w /= l;
    // Mirrored across his midline (x): the bone's twin, its rotation reflected.
    const o = (mirror ? TWIN[b] : b) * 4;
    out.q[o] = x;
    out.q[o + 1] = mirror ? -y : y;
    out.q[o + 2] = mirror ? -z : z;
    out.q[o + 3] = w;
  }
  const k0 = i0 * 3;
  out.hips[0] = ((h[k0] + (h[k0 + 3] - h[k0]) * a) / 1000) * (mirror ? -1 : 1);
  out.hips[1] = (h[k0 + 1] + (h[k0 + 4] - h[k0 + 1]) * a) / 1000;
  out.hips[2] = (h[k0 + 2] + (h[k0 + 5] - h[k0 + 2]) * a) / 1000;
  return out;
}
