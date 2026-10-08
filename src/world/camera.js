/**
 * Camera state for the 3D stage. run.camera is an orbit rig:
 *   { x, y, z }  the point looked at
 *   dist         distance from it
 *   yaw, pitch   orbit angles (radians; pitch > 0 looks down from above)
 * The director eases it toward a target each step; view3d.js turns it into a
 * perspective camera (plus the viewer's drag offset).
 */

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Ease camera toward target; frame-rate independent. `stiffness` ~ 1/seconds. */
export function followCamera(camera, target, dt, stiffness = 2.6) {
  const k = 1 - Math.exp(-stiffness * dt);
  camera.x += (target.x - camera.x) * k;
  camera.y += (target.y - camera.y) * k;
  camera.z += (target.z - camera.z) * k;
  camera.dist = Math.exp(Math.log(camera.dist) + (Math.log(target.dist) - Math.log(camera.dist)) * k);
  camera.yaw += wrap(target.yaw - camera.yaw) * k;
  camera.pitch += (target.pitch - camera.pitch) * k;
  return camera;
}

/** Distance at which a sphere of radius r fills `fill` of the narrower stage side. */
export function fitDistance(r, aspect, fovDeg = 50, fill = 0.85) {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  return r / (half * Math.min(1, aspect) * fill);
}
