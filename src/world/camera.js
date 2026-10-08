/**
 * Camera state for the 3D stage. run.camera is an orbit rig:
 *   { x, y, z }  the point looked at
 *   dist         distance from it
 *   yaw, pitch   orbit angles (radians; pitch > 0 looks down from above)
 *   v            per-channel velocities for the spring smoothing
 * The camera sits at look-at + dist * (cos p sin y, sin p, cos p cos y).
 * The director eases it toward a target each step with a critically damped
 * spring, so every move accelerates and settles smoothly instead of lurching;
 * view3d.js turns it into a perspective camera (plus the viewer's drag).
 *
 * Also here: the cinematographer's helpers. Keyframed shots are sampled with
 * a C1 Hermite spline (so a sequence of sub-shots flows without stopping),
 * the camera is kept out of the dense core of every cluster ball, and
 * candidate angles are scored for a clear line of sight to the subject.
 */

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Critically damped spring step (Unity-style SmoothDamp). Returns [value, velocity]. */
function smoothDamp(cur, target, vel, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  return [target + (change + temp) * e, (vel - omega * temp) * e];
}

/**
 * Ease camera toward target. `move` is the smoothing time (s) for where it
 * looks, `turn` for distance and angles; bigger is calmer.
 */
export function followCamera(camera, target, dt, move = 1.4, turn = 2.4) {
  const v = camera.v || (camera.v = { x: 0, y: 0, z: 0, dist: 0, yaw: 0, pitch: 0 });
  [camera.x, v.x] = smoothDamp(camera.x, target.x, v.x, move, dt);
  [camera.y, v.y] = smoothDamp(camera.y, target.y, v.y, move, dt);
  [camera.z, v.z] = smoothDamp(camera.z, target.z, v.z, move, dt);
  const ld = Math.log(camera.dist);
  const [nd, vd] = smoothDamp(ld, Math.log(target.dist), v.dist, turn, dt);
  camera.dist = Math.exp(nd);
  v.dist = vd;
  [camera.yaw, v.yaw] = smoothDamp(camera.yaw, camera.yaw + wrap(target.yaw - camera.yaw), v.yaw, turn, dt);
  [camera.pitch, v.pitch] = smoothDamp(camera.pitch, target.pitch, v.pitch, turn, dt);
  return camera;
}

/** Distance at which a sphere of radius r fills `fill` of the narrower stage side. */
export function fitDistance(r, aspect, fovDeg = 50, fill = 0.85) {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  return r / (half * Math.min(1, aspect) * fill);
}

/** Unit vector from the look-at point toward the camera. */
export function orbitDir(yaw, pitch, out = [0, 0, 0]) {
  const cp = Math.cos(pitch);
  out[0] = cp * Math.sin(yaw);
  out[1] = Math.sin(pitch);
  out[2] = cp * Math.cos(yaw);
  return out;
}

const KEY_CHANNELS = ['b', 'w', 'ld', 'yaw', 'pitch'];

/**
 * Sample a keyframed shot at time t. Keys are {t, b, w, ld, yaw, pitch},
 * sorted by t; between them a Catmull-Rom (non-uniform) Hermite spline, so
 * the camera keeps flowing through a key instead of stopping on it; the
 * first and last keys ease in and out. Holds the end keys outside the range.
 */
export function sampleKeys(keys, t, out = {}) {
  const n = keys.length;
  if (t <= keys[0].t || n === 1) return Object.assign(out, keys[0]);
  if (t >= keys[n - 1].t) return Object.assign(out, keys[n - 1]);
  let i = 0;
  while (i < n - 2 && keys[i + 1].t < t) i++;
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k0 = keys[i - 1];
  const k3 = keys[i + 2];
  const h = k2.t - k1.t || 1e-6;
  const s = (t - k1.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  for (const ch of KEY_CHANNELS) {
    const m1 = k0 ? ((k2[ch] - k0[ch]) / (k2.t - k0.t)) * h : 0;
    const m2 = k3 ? ((k3[ch] - k1[ch]) / (k3.t - k1.t)) * h : 0;
    out[ch] = h00 * k1[ch] + h10 * m1 + h01 * k2[ch] + h11 * m2;
  }
  out.t = t;
  return out;
}

const spans = new Float64Array(256);

/**
 * Camera distance for a target looking at (x, y, z) from direction d that
 * keeps the camera outside every cluster ball's dense core (k * r).
 * Along the ray each ball blocks an interval of distances; the camera may sit
 * anywhere in the free gap it is already in (`ref`, its current distance;
 * pushed out of a core first if it is in one), so it is never asked to fly
 * through a ball to reach its target: the ball the subject sits in pushes it
 * out, a ball in between holds it in front. Never closer than `min`.
 */
export function clearDistance(x, y, z, d, dist, clusters, k = 0.9, min = 0, ref = dist) {
  let m = 0;
  for (const c of clusters) {
    if (m >= spans.length) break;
    const R = c.r * k;
    const ox = x - c.cx;
    const oy = y - c.cy;
    const oz = z - c.cz;
    const b = ox * d[0] + oy * d[1] + oz * d[2];
    const cc = ox * ox + oy * oy + oz * oz - R * R;
    const disc = b * b - cc;
    if (disc <= 0) continue;
    const root = Math.sqrt(disc);
    const exit = -b + root;
    if (exit <= 0) continue;
    spans[m++] = -b - root - 2;
    spans[m++] = exit + 2;
  }
  const find = (v) => {
    for (let i = 0; i < m; i += 2) if (v > spans[i] && v < spans[i + 1]) return i;
    return -1;
  };
  // Where the camera is now; if that is inside a core, the nearest way out.
  let r = Math.max(ref, min);
  let j = find(r);
  if (j >= 0) {
    const out = spans[j] < min || spans[j + 1] - r < r - spans[j];
    for (let guard = 0; j >= 0 && guard < 32; guard++) {
      r = out ? spans[j + 1] : spans[j];
      j = find(r);
    }
    if (r < min) {
      r = Math.max(ref, min);
      for (let guard = 0, i = find(r); i >= 0 && guard < 32; guard++, i = find(r)) r = spans[i + 1];
    }
  }
  // The free gap around it.
  let lo = min;
  let hi = Infinity;
  for (let i = 0; i < m; i += 2) {
    if (spans[i + 1] <= r) lo = Math.max(lo, spans[i + 1]);
    else if (spans[i] >= r) hi = Math.min(hi, spans[i]);
  }
  return Math.max(lo, Math.min(hi, dist));
}

/**
 * How badly a camera at (look-at + dist * d) sees the look-at point: the
 * dense cores of other balls that cut the line of sight, plus how far the
 * camera would have to be pushed out of a core. 0 is a clean shot.
 */
export function shotCost(x, y, z, d, dist, clusters, skip = []) {
  let cost = 0;
  const px = x + d[0] * dist;
  const py = y + d[1] * dist;
  const pz = z + d[2] * dist;
  for (const c of clusters) {
    // Camera inside a ball: it would be pushed out, losing the framing.
    const inside = Math.hypot(px - c.cx, py - c.cy, pz - c.cz) / (c.r * 0.95);
    if (inside < 1) cost += 1.6 * (1 - inside) + 0.6;
    if (skip.includes(c.index)) continue;
    // Another ball's core between the camera and the subject.
    const ox = c.cx - x;
    const oy = c.cy - y;
    const oz = c.cz - z;
    const along = Math.max(0, Math.min(dist, ox * d[0] + oy * d[1] + oz * d[2]));
    const miss = Math.hypot(ox - d[0] * along, oy - d[1] * along, oz - d[2] * along) / (c.r * 0.85);
    if (miss < 1) cost += (1 - miss) * (0.4 + 0.6 * (along / dist));
  }
  return cost;
}
