/**
 * Camera state for the 3D stage. run.camera is an orbit rig:
 *   { x, y, z }  the point looked at
 *   dist         distance from it
 *   yaw, pitch   orbit angles (radians; pitch > 0 looks down from above)
 *   v            per-channel velocities for the spring smoothing
 * The director eases it toward a target each step with a critically damped
 * spring, so every move accelerates and settles smoothly instead of lurching;
 * view3d.js turns it into a perspective camera (plus the viewer's drag).
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
