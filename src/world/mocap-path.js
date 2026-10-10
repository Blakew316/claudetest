/**
 * Where a motion-captured clip carries a fighter over the ground: the path its hips take (low-passed),
 * in the clip's own frame (model units: +z his front at the clip's start, +x his left), from 0 at its
 * start. Pure (no three.js, no assets), so the director can move his walker along it in step with the
 * pose the rig plays (world/mocap.js). A looping clip carries on from where each cycle ended; a
 * mirrored one (left for right) goes the other way across.
 */

import { CLIPS, FPS } from './mocap-clips.js';

/** The clip's facts: frames, duration, travels, end [x, z], releases [{hand, t}] (see mocap-clips.js). */
export function clip(name) {
  const c = CLIPS[name];
  if (!c) throw new Error(`no mocap clip ${name}`);
  return c;
}

/**
 * The path at t seconds into the clip, written to out [x, z] (model units).
 * @param {string} name
 * @param {number} t
 * @param {boolean} [loop]
 * @param {boolean} [mirror] left for right
 * @param {number[]} [out]
 */
export function pathAt(name, t, loop = false, mirror = false, out = [0, 0]) {
  const c = clip(name);
  out[0] = 0;
  out[1] = 0;
  if (!c.travels) return out;
  const last = c.frames - 1;
  let f = t * FPS;
  let cycles = 0;
  if (loop) {
    cycles = Math.floor(f / last);
    f -= cycles * last;
  } else f = Math.max(0, Math.min(last, f));
  const i0 = Math.min(last - 1, Math.floor(f));
  const a = f - i0;
  const p = c.path;
  out[0] = p[i0 * 2] + (p[i0 * 2 + 2] - p[i0 * 2]) * a + cycles * c.end[0];
  out[1] = p[i0 * 2 + 1] + (p[i0 * 2 + 3] - p[i0 * 2 + 1]) * a + cycles * c.end[1];
  if (mirror) out[0] = -out[0];
  return out;
}
