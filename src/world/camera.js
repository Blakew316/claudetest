/**
 * Camera maths shared by every canvas renderer.
 *
 * World units are roughly CSS pixels at zoom 1. The camera stores the world
 * point at the centre of the stage. `view` is rebuilt by main.js each frame:
 *   { width, height, dpr, time, camera: {x, y, zoom} }
 * where width/height are the stage size in CSS pixels.
 */

/** Put ctx into world space: subsequent drawing uses world coordinates. */
export function applyWorldTransform(ctx, view) {
  const { camera, width, height, dpr } = view;
  const s = dpr * camera.zoom;
  ctx.setTransform(s, 0, 0, s, dpr * (width / 2 - camera.x * camera.zoom), dpr * (height / 2 - camera.y * camera.zoom));
}

/** Put ctx into screen space (CSS pixels), for text that must not scale with zoom. */
export function applyScreenTransform(ctx, view) {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}

/** World -> screen (CSS px). Writes into `out` to avoid allocation in hot loops. */
export function worldToScreen(view, x, y, out = { x: 0, y: 0 }) {
  const { camera, width, height } = view;
  out.x = (x - camera.x) * camera.zoom + width / 2;
  out.y = (y - camera.y) * camera.zoom + height / 2;
  return out;
}

/** Screen (CSS px) -> world. */
export function screenToWorld(view, sx, sy, out = { x: 0, y: 0 }) {
  const { camera, width, height } = view;
  out.x = (sx - width / 2) / camera.zoom + camera.x;
  out.y = (sy - height / 2) / camera.zoom + camera.y;
  return out;
}

/** Camera {x,y,zoom} that fits world bounds inside the stage with a margin (CSS px). */
export function fitBounds(bounds, width, height, margin = 60) {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = Math.min((width - margin * 2) / w, (height - margin * 2) / h);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom: Math.max(0.05, zoom) };
}

/**
 * Critically-damped follow toward a target camera. `stiffness` ~ 1/seconds;
 * frame-rate independent.
 */
export function followCamera(camera, target, dt, stiffness = 3) {
  const k = 1 - Math.exp(-stiffness * dt);
  camera.x += (target.x - camera.x) * k;
  camera.y += (target.y - camera.y) * k;
  // Zoom eases in log space so zooming out and in feel symmetric.
  const lz = Math.log(camera.zoom) + (Math.log(target.zoom) - Math.log(camera.zoom)) * k;
  camera.zoom = Math.exp(lz);
  return camera;
}

/** Is a world point (with a world-space radius) on screen? */
export function isVisible(view, x, y, radius = 0) {
  const { camera, width, height } = view;
  const sx = (x - camera.x) * camera.zoom + width / 2;
  const sy = (y - camera.y) * camera.zoom + height / 2;
  const r = radius * camera.zoom;
  return sx + r >= 0 && sx - r <= width && sy + r >= 0 && sy - r <= height;
}
