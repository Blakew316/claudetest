/**
 * The 3D world: one web per prompt section, coiled together through space so
 * the camera has somewhere to travel. Each section is a real orb web (or
 * two) hanging inside a nebula of particles, tied off with anchor lines, and
 * neighbouring webs are strung together with bridge threads. Words sit on
 * the capture spiral, read from the outside in, and every silk junction is a
 * foothold for the spider. Pure data (no WebGL), so the director runs in node.
 *
 * World.wordPos holds [x, y, z] per word; clusters carry cx, cy, cz and r.
 */

import { fork, gauss, range } from '../core/rng.js';
import { sectionColor } from '../core/theme.js';
import { orbWeb, sagThread } from './orbweb.js';

/** Cluster radius from its word count. */
export function clusterRadius(count) {
  return Math.max(150, Math.min(420, 150 + 14 * Math.sqrt(count)));
}

/** Particle count for a cluster. */
export function particleCount(count) {
  return Math.min(3600, Math.round(1500 + 90 * Math.sqrt(count)));
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Random rotation matrix (columns are orthonormal axes). */
function randomBasis(rand) {
  const a = norm([gauss(rand), gauss(rand), gauss(rand)]);
  let b = norm([gauss(rand), gauss(rand), gauss(rand)]);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  b = norm([b[0] - a[0] * d, b[1] - a[1] * d, b[2] - a[2] * d]);
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return [a, b, c];
}

/**
 * Lay clusters out as a coiled chain: each one touches the previous, turns
 * 50-130 degrees from the last step, and is pulled toward the middle of what
 * is already placed, so the whole web reads as one lumpy nebula.
 */
function layout(radii, rand) {
  const out = [];
  let dir = norm([1, 0.15, 0.4]);
  radii.forEach((r, i) => {
    if (i === 0) {
      out.push([0, 0, 0]);
      return;
    }
    const prev = out[i - 1];
    const mid = out.reduce((m, o) => [m[0] + o[0] / out.length, m[1] + o[1] / out.length, m[2] + o[2] / out.length], [0, 0, 0]);
    let best = null;
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 48; attempt++) {
      const yaw = (rand() < 0.5 ? -1 : 1) * range(rand, 0.9, 2.3);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      let d = norm([dir[0] * cy - dir[2] * sy, 0, dir[0] * sy + dir[2] * cy]);
      d = norm([d[0], range(rand, -0.55, 0.55), d[2]]);
      const gap = (radii[i - 1] + r) * range(rand, 0.92, 1.05);
      const c = [prev[0] + d[0] * gap, prev[1] + d[1] * gap, prev[2] + d[2] * gap];
      const clear = out.every((o, j) => Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]) > (radii[j] + r) * 0.82);
      const score = Math.hypot(c[0] - mid[0], c[1] - mid[1], c[2] - mid[2]) + (clear ? 0 : 1e6);
      if (score < bestScore) {
        bestScore = score;
        best = { c, d };
      }
    }
    out.push(best.c);
    dir = best.d;
  });
  return out;
}

/** One cluster's particles: an anisotropic, noise-warped blob plus a few filaments. */
function makeCloud(rand, r, n) {
  const pos = new Float32Array(n * 3);
  const bright = new Float32Array(n);
  const [ax, ay, az] = randomBasis(rand);
  const sx = r * 0.46;
  const sy = r * range(rand, 0.3, 0.42);
  const sz = r * range(rand, 0.18, 0.3);
  const f1 = range(rand, 1.5, 3) / r;
  const f2 = range(rand, 1.5, 3) / r;
  const ph = [rand() * 6, rand() * 6, rand() * 6];
  const filaments = Math.round(n * 0.18);
  for (let i = 0; i < n; i++) {
    let u;
    let v;
    let w;
    if (i < filaments) {
      // Filaments: points along a few curved strands sweeping through the cloud.
      const strand = i % 5;
      const t = rand() * 2 - 1;
      u = t * sx * 1.6;
      v = Math.sin(t * 2.2 + strand * 1.3) * sy * 0.9 + gauss(rand) * r * 0.025;
      w = Math.cos(t * 1.7 + strand * 2.1) * sz * 0.9 + gauss(rand) * r * 0.025;
    } else {
      u = gauss(rand) * sx;
      v = gauss(rand) * sy;
      w = gauss(rand) * sz;
    }
    // Low-frequency warp so the edges are wispy, not ellipsoidal.
    const wu = Math.sin(v * f1 + ph[0]) * r * 0.16;
    const wv = Math.sin(w * f2 + u * f1 + ph[1]) * r * 0.12;
    const ww = Math.sin(u * f2 + ph[2]) * r * 0.1;
    u += wu;
    v += wv;
    w += ww;
    pos[i * 3] = ax[0] * u + ay[0] * v + az[0] * w;
    pos[i * 3 + 1] = ax[1] * u + ay[1] * v + az[1] * w;
    pos[i * 3 + 2] = ax[2] * u + ay[2] * v + az[2] * w;
    const core = Math.exp(-(u * u + v * v + w * w) / (r * r * 0.5));
    bright[i] = rand() < 0.03 ? 1.6 : 0.3 + 0.55 * core + 0.25 * rand();
  }
  return { pos, bright };
}

/** Connect each particle to its nearest 1-2 neighbours within a cutoff (grid hash). */
function makeEdges(pos, r) {
  const n = pos.length / 3;
  const cell = r * 0.09;
  const cut2 = (r * 0.1) ** 2;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  const edges = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const gz = Math.floor(z / cell);
    let b1 = -1;
    let b2 = -1;
    let d1 = cut2;
    let d2 = cut2;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const a = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!a) continue;
          for (const j of a) {
            if (j === i) continue;
            const d = (pos[j * 3] - x) ** 2 + (pos[j * 3 + 1] - y) ** 2 + (pos[j * 3 + 2] - z) ** 2;
            if (d < d1) {
              d2 = d1;
              b2 = b1;
              d1 = d;
              b1 = j;
            } else if (d < d2) {
              d2 = d;
              b2 = j;
            }
          }
        }
    for (const j of [b1, i % 3 === 0 ? b2 : -1]) {
      if (j < 0) continue;
      const id = i < j ? i * n + j : j * n + i;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push(i, j);
    }
  }
  return new Uint32Array(edges);
}


/**
 * Build the 3D world for an analysis. Deterministic for (analysis, seed).
 * @param {import('../core/contracts.js').Analysis} analysis
 * @param {number} seed
 * @returns {import('../core/contracts.js').World}
 */
export function buildWorld(analysis, seed) {
  const sections = analysis.sections;
  const radii = sections.map((s) => clusterRadius(s.count));
  const centers = layout(radii, fork(seed, 'layout'));
  const wordPos = new Float32Array(analysis.words.length * 3);
  const clusters = [];
  const clouds = [];
  const footholds = [];
  sections.forEach((sec, i) => {
    const r = radii[i];
    const [cx, cy, cz] = centers[i];
    const rand = fork(seed, `web:${i}`);
    const cloud = makeCloud(fork(seed, `cloud:${i}`), r, particleCount(sec.count));
    for (let k = 0; k < cloud.pos.length; k += 3) {
      cloud.pos[k] += cx;
      cloud.pos[k + 1] += cy;
      cloud.pos[k + 2] += cz;
    }
    cloud.edges = makeEdges(cloud.pos, r);

    // Orb webs hang roughly vertical: normals near horizontal, each at its own angle.
    const webs = [];
    const yaw = rand() * Math.PI * 2;
    const mainN = [Math.cos(yaw), range(rand, -0.35, 0.35), Math.sin(yaw)];
    webs.push(orbWeb(rand, [cx + gauss(rand) * r * 0.06, cy + gauss(rand) * r * 0.05, cz + gauss(rand) * r * 0.06], mainN, r * 0.82));
    if (sec.count > 14) {
      const y2 = yaw + range(rand, 0.9, 2.2);
      const off = [Math.cos(y2 + 1.2) * r * 0.5, range(rand, -0.3, 0.3) * r, Math.sin(y2 + 1.2) * r * 0.5];
      webs.push(orbWeb(rand, [cx + off[0], cy + off[1], cz + off[2]], [Math.cos(y2), range(rand, -0.4, 0.4), Math.sin(y2)], r * range(rand, 0.42, 0.55)));
    }
    // Anchor lines from each web's frame out into the surrounding cloud.
    const anchors = [];
    const nP = cloud.pos.length / 3;
    for (const w of webs) {
      for (let k = 0; k < 9; k++) {
        const f = w.frame[Math.floor(rand() * w.frame.length)];
        let best = null;
        for (let t = 0; t < 30; t++) {
          const j = Math.floor(rand() * nP);
          const q = [cloud.pos[j * 3], cloud.pos[j * 3 + 1], cloud.pos[j * 3 + 2]];
          const d = Math.hypot(q[0] - f[0], q[1] - f[1], q[2] - f[2]);
          if (d > r * 0.25 && d < r * 0.7 && (!best || rand() < 0.5)) best = q;
        }
        if (best) sagThread(anchors, f, best, 8, 0.04, rand);
      }
      for (let k = 0; k < w.nodes.length; k++) footholds.push(w.nodes[k]);
    }
    cloud.webs = webs;
    cloud.threads = new Float32Array(anchors);

    // Words along the capture spiral, outside in, evenly spaced.
    const spiral = webs.flatMap((w) => w.spiral.slice().reverse());
    for (let w = 0; w < sec.count; w++) {
      const id = sec.start + w;
      let p;
      if (spiral.length >= sec.count) p = spiral[Math.floor(((w + 0.5) / sec.count) * spiral.length)];
      else p = spiral[w] || [cx + gauss(rand) * r * 0.3, cy + gauss(rand) * r * 0.2, cz + gauss(rand) * r * 0.3];
      wordPos[id * 3] = p[0];
      wordPos[id * 3 + 1] = p[1];
      wordPos[id * 3 + 2] = p[2];
    }
    clouds.push(cloud);
    clusters.push({ index: i, cx, cy, cz, r, color: sec.color || sectionColor(i) });
  });

  // Bridges: silk strung frame to frame between neighbouring webs.
  const bridges = [];
  const brand = fork(seed, 'bridges');
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const A = clusters[i];
      const B = clusters[j];
      const L = Math.hypot(B.cx - A.cx, B.cy - A.cy, B.cz - A.cz);
      if (L > (A.r + B.r) * 1.35) continue;
      const fa = clouds[i].webs.flatMap((w) => w.frame);
      const fb = clouds[j].webs.flatMap((w) => w.frame);
      const near = (list, c) => list.slice().sort((p, q) => Math.hypot(p[0] - c.cx, p[1] - c.cy, p[2] - c.cz) - Math.hypot(q[0] - c.cx, q[1] - c.cy, q[2] - c.cz));
      const ea = near(fa, B).slice(0, 8);
      const eb = near(fb, A).slice(0, 8);
      const count = j === i + 1 ? 7 : 3;
      for (let k = 0; k < count; k++) sagThread(bridges, ea[Math.floor(brand() * ea.length)], eb[Math.floor(brand() * eb.length)], 18, 0.05, brand);
    }
  }

  let bx = 0;
  let by = 0;
  let bz = 0;
  clusters.forEach((c) => {
    bx += c.cx / clusters.length;
    by += c.cy / clusters.length;
    bz += c.cz / clusters.length;
  });
  let radius = 200;
  clusters.forEach((c) => (radius = Math.max(radius, Math.hypot(c.cx - bx, c.cy - by, c.cz - bz) + c.r)));
  return {
    clusters,
    wordPos,
    bounds: { x: bx, y: by, z: bz, radius },
    _clouds: clouds,
    _bridges: new Float32Array(bridges),
    _footholds: new Float32Array(footholds),
  };
}

