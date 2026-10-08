/**
 * Procedural orb webs in 3D: irregular radials from a hub to a frame, a
 * sagging capture spiral wound between them, a dense hub, dew drops caught
 * on the silk, and a gentle billow out of plane so no web is perfectly flat.
 * Pure data (Float32Arrays of line-segment endpoints and points).
 */

import { range } from '../core/rng.js';

const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Build one orb web.
 * @param {() => number} rand
 * @param {number[]} center [x, y, z]
 * @param {number[]} normal plane normal (webs hang roughly vertical: keep it near horizontal)
 * @param {number} radius
 * @returns {{segs: Float32Array, nodes: Float32Array, dew: Float32Array, spiral: number[][], frame: number[][]}}
 */
export function orbWeb(rand, center, normal, radius) {
  const n = norm(normal);
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(ref, n));
  const v = cross(n, u);
  const billowPhase = rand() * Math.PI * 2;
  const billow = radius * range(rand, 0.04, 0.09);
  const tilt = range(rand, -0.25, 0.25);

  /** Point on the web at angle a, distance r from the hub, billowed out of plane. */
  const at = (a, r) => {
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const out = billow * (r / radius) ** 2 * Math.sin(a * 2 + billowPhase) + tilt * x * 0.15;
    return [
      center[0] + u[0] * x + v[0] * y + n[0] * out,
      center[1] + u[1] * x + v[1] * y + n[1] * out,
      center[2] + u[2] * x + v[2] * y + n[2] * out,
    ];
  };

  const segs = [];
  const nodes = [];
  const dew = [];
  const spiral = [];
  const frame = [];
  const line = (a, b) => segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  /** Silk sags between its ends: toward the hub and a little with gravity. */
  const sagLine = (a, b, sagIn, subs) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let prev = a;
    for (let k = 1; k <= subs; k++) {
      const t = k / subs;
      const s = Math.sin(Math.PI * t);
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const toHub = norm([center[0] - p[0], center[1] - p[1], center[2] - p[2]]);
      p[0] += toHub[0] * sagIn * L * s;
      p[1] += toHub[1] * sagIn * L * s - 0.025 * L * s;
      p[2] += toHub[2] * sagIn * L * s;
      line(prev, p);
      prev = p;
    }
  };

  // Radials: irregular spacing and frame distance, a little flattened on top.
  const R = Math.round(range(rand, 18, 28));
  const ang = [];
  const reach = [];
  for (let i = 0; i < R; i++) {
    ang.push((i / R) * Math.PI * 2 + (rand() - 0.5) * ((Math.PI * 2) / R) * 0.55);
    reach.push(radius * range(rand, 0.8, 1.04) * (1 - 0.1 * Math.max(0, Math.sin(ang[i]))));
  }
  const hub = radius * 0.06;
  for (let i = 0; i < R; i++) {
    const a = at(ang[i], hub);
    const b = at(ang[i], reach[i]);
    line(a, b);
    frame.push(b);
    for (let r = hub; r < reach[i]; r += 9) nodes.push(...at(ang[i], r));
  }
  // Frame threads between radial ends.
  for (let i = 0; i < R; i++) {
    const a = frame[i];
    const b = frame[(i + 1) % R];
    sagLine(a, b, -0.02, 4);
    nodes.push(...a);
  }
  // Hub: a small, dense, irregular mesh.
  for (const hr of [0.35, 0.65, 1, 1.5, 2.1]) {
    for (let i = 0; i < R; i++) line(at(ang[i], hub * hr), at(ang[(i + 1) % R], hub * hr * range(rand, 0.9, 1.1)));
  }
  // Capture spiral, wound outward, sagging between radials, with a few gaps.
  const r0 = radius * 0.17;
  const turns = Math.round(range(rand, 13, 19));
  const mean = reach.reduce((s, x) => s + x, 0) / R;
  const step = (mean * 0.93 - r0) / turns;
  let prev = null;
  for (let k = 0; k < turns * R; k++) {
    const i = k % R;
    const r = r0 + step * (k / R) + (rand() - 0.5) * step * 0.15;
    if (r > reach[i] * 0.94) {
      prev = null;
      continue;
    }
    const p = at(ang[i], r);
    if (prev && rand() > 0.035) {
      sagLine(prev, p, 0.05, 3);
      if (rand() < 0.16) {
        const t = rand();
        dew.push(prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t - 0.4, prev[2] + (p[2] - prev[2]) * t);
      }
    }
    nodes.push(...p);
    spiral.push(p);
    prev = p;
  }
  return { segs: new Float32Array(segs), nodes: new Float32Array(nodes), dew: new Float32Array(dew), spiral, frame };
}

/** A sagging thread between two points, appended to `out` as segment endpoints. */
export function sagThread(out, a, b, sub, sag, rand) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const bow = (rand() - 0.5) * L * 0.08;
  let prev = a;
  for (let k = 1; k <= sub; k++) {
    const t = k / sub;
    const s = Math.sin(Math.PI * t);
    const p = [a[0] + (b[0] - a[0]) * t + bow * s, a[1] + (b[1] - a[1]) * t - sag * L * s, a[2] + (b[2] - a[2]) * t - bow * s * 0.5];
    out.push(...prev, ...p);
    prev = p;
  }
}
