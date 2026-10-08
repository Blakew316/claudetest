/**
 * The 3D world: one small universe per prompt section, a richly detailed
 * clustered ball of stardust (see galaxy.js makeBall) with a fine
 * constellation web between neighbouring stars,
 * packed together into one compact nebula-ecosystem (neighbours touch and
 * overlap a little), joined by tidal streams of stardust. Words hang on bright
 * stars and are read on a tour around each cluster; every star is a
 * foothold for the spider. Pure data (no WebGL), so the director runs in node.
 *
 * World.wordPos holds [x, y, z] per word; clusters carry cx, cy, cz and r.
 */

import { fork, gauss, range } from '../core/rng.js';
import { sectionColor } from '../core/theme.js';
import { makeBall } from './galaxy.js';

/** Cluster radius from its word count. */
export function clusterRadius(count) {
  return Math.max(140, Math.min(340, 140 + 11 * Math.sqrt(count)));
}

/** Star count for a cluster. */
export function particleCount(count) {
  return Math.min(34000, Math.round(18000 + 1400 * Math.sqrt(count)));
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Lay clusters out as a coiled chain: each one a short jump from the
 * previous, turning 50-130 degrees from the last step, pulled toward the
 * middle of what is already placed so the whole reads as one ecosystem.
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
      // Packed tight like the reference: neighbours touch and overlap a little.
      const gap = (radii[i - 1] + r) * range(rand, 0.74, 0.9);
      const c = [prev[0] + d[0] * gap, prev[1] + d[1] * gap, prev[2] + d[2] * gap];
      const clear = out.every((o, j) => Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]) > (radii[j] + r) * 0.68);
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

/**
 * Constellation web: every `stride`-th star links to its nearest neighbour
 * within `cut` (and every 6th to a second one), via a numeric grid hash.
 */
function makeEdges(pos, cut, stride = 2) {
  const n = pos.length / 3;
  const cell = cut;
  const cut2 = cut * cut;
  const key = (x, y, z) => ((Math.floor(x / cell) * 73856093) ^ (Math.floor(y / cell) * 19349663) ^ (Math.floor(z / cell) * 83492791)) | 0;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  const edges = [];
  for (let i = 0; i < n; i += stride) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    let b1 = -1;
    let b2 = -1;
    let d1 = cut2;
    let d2 = cut2;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const a = grid.get(key(x + dx * cell, y + dy * cell, z + dz * cell));
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
    if (b1 >= 0) edges.push(i, b1);
    if (b2 >= 0 && i % 6 === 0) edges.push(i, b2);
  }
  return new Uint32Array(edges);
}

/**
 * Extra balls with no words, packed onto the outside of the section balls
 * (touching a neighbour, clear of the rest, as close to the middle as they
 * fit), so the whole ecosystem is bigger and fuller.
 */
function placeExtras(centers, radii, extra, rand) {
  const out = [];
  const all = centers.map((c, i) => ({ c, r: radii[i] }));
  for (const r of extra) {
    const mid = all.reduce((m, o) => [m[0] + o.c[0] / all.length, m[1] + o.c[1] / all.length, m[2] + o.c[2] / all.length], [0, 0, 0]);
    let best = null;
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 80; attempt++) {
      const a = all[Math.floor(rand() * all.length)];
      const d = norm([gauss(rand), gauss(rand) * 0.6, gauss(rand)]);
      const gap = (a.r + r) * range(rand, 0.88, 1.0);
      const c = [a.c[0] + d[0] * gap, a.c[1] + d[1] * gap, a.c[2] + d[2] * gap];
      const clear = all.every((o) => Math.hypot(c[0] - o.c[0], c[1] - o.c[1], c[2] - o.c[2]) > (o.r + r) * 0.84);
      const score = Math.hypot(c[0] - mid[0], c[1] - mid[1], c[2] - mid[2]) + (clear ? 0 : 1e6);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    out.push(best);
    all.push({ c: best, r });
  }
  return out;
}

/** Pick well-spread bright stars for the words and order them as a tour around the cluster. */
function placeWords(g, cx, cy, cz, r, count, rand, disc) {
  const n = g.pos.length / 3;
  const picks = [];
  const minD = (r * 0.9) / Math.sqrt(Math.max(1, count));
  for (let tries = 0; picks.length < count && tries < count * 200; tries++) {
    const i = Math.floor(rand() * n);
    if (g.bright[i] < 0.42) continue;
    const p = [g.pos[i * 3] - cx, g.pos[i * 3 + 1] - cy, g.pos[i * 3 + 2] - cz];
    if (Math.hypot(...p) > r * 0.8) continue;
    const relax = tries > count * 100 ? 0.45 : 1;
    if (picks.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < minD * relax)) continue;
    picks.push(p);
  }
  while (picks.length < count) picks.push([gauss(rand) * r * 0.25, gauss(rand) * r * 0.15, gauss(rand) * r * 0.25]);
  const { e1, e2 } = g.frame;
  const dotp = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (disc) {
    // Around the disc, spiralling outward: the spider tours the galaxy.
    const a0 = rand() * Math.PI * 2;
    const key = (p) => {
      const ang = (Math.atan2(dotp(p, e2), dotp(p, e1)) - a0 + Math.PI * 4) % (Math.PI * 2);
      return ang + (Math.hypot(...p) / r) * 0.8;
    };
    picks.sort((a, b) => key(a) - key(b));
  } else {
    const sweep = norm([gauss(rand), gauss(rand) * 0.5, gauss(rand)]);
    picks.sort((a, b) => dotp(a, sweep) - dotp(b, sweep));
  }
  return picks.map((p) => [p[0] + cx, p[1] + cy, p[2] + cz]);
}

/** A curved tidal stream of stardust from one cluster to another. */
function stream(A, B, rand, count) {
  const a = [A.cx, A.cy, A.cz];
  const b = [B.cx, B.cy, B.cz];
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...d);
  const side = norm([-d[2], range(rand, -0.4, 0.4) * L, d[0]]);
  const bow = L * range(rand, 0.1, 0.22) * (rand() < 0.5 ? -1 : 1);
  const pos = new Float32Array(count * 3);
  const bright = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = rand();
    const s = Math.sin(Math.PI * t);
    const spread = (8 + L * 0.05 * s) * (rand() < 0.15 ? 2.2 : 1);
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = a[k] + d[k] * t + side[k] * bow * s + gauss(rand) * spread;
    bright[i] = range(rand, 0.15, 0.55) * (0.5 + 0.5 * s);
  }
  return { pos, bright, from: A.index, to: B.index };
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
  sections.forEach((sec, i) => {
    const r = radii[i];
    const [cx, cy, cz] = centers[i];
    const g = makeBall(fork(seed, `ball:${i}`), r, particleCount(sec.count));
    for (let k = 0; k < g.pos.length; k += 3) {
      g.pos[k] += cx;
      g.pos[k + 1] += cy;
      g.pos[k + 2] += cz;
    }
    g.edges = makeEdges(g.pos, r * 0.05, 1);
    const words = placeWords(g, cx, cy, cz, r, sec.count, fork(seed, `words:${i}`), false);
    words.forEach((p, w) => wordPos.set(p, (sec.start + w) * 3));
    clouds.push(g);
    clusters.push({ index: i, cx, cy, cz, r, color: sec.color || sectionColor(i) });
  });

  // A few more balls with no words, to make the whole ecosystem bigger.
  const xrand = fork(seed, 'extras');
  const xr = Array.from({ length: Math.max(3, Math.round(sections.length * 0.6)) }, () => clusterRadius(range(xrand, 14, 40)));
  placeExtras(centers, radii, xr, xrand).forEach(([cx, cy, cz], k) => {
    const r = xr[k];
    const g = makeBall(fork(seed, `extra:${k}`), r, Math.round(particleCount(range(xrand, 14, 40)) * 0.6));
    for (let q = 0; q < g.pos.length; q += 3) {
      g.pos[q] += cx;
      g.pos[q + 1] += cy;
      g.pos[q + 2] += cz;
    }
    g.edges = makeEdges(g.pos, r * 0.05, 1);
    clouds.push(g);
    clusters.push({ index: sections.length + k, cx, cy, cz, r, color: sectionColor(sections.length + k), extra: true });
  });

  // Tidal streams between neighbouring clusters: the ecosystem's connective tissue.
  // Consecutive sections are always joined (the spider's route); others when close.
  const streams = [];
  const srand = fork(seed, 'streams');
  const nSec = sections.length;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const A = clusters[i];
      const B = clusters[j];
      const L = Math.hypot(B.cx - A.cx, B.cy - A.cy, B.cz - A.cz);
      const route = j === i + 1 && j < nSec;
      if (!route && L > (A.r + B.r) * 1.5) continue;
      streams.push(stream(A, B, srand, route ? 2400 : 1100));
    }
  }

  // Every star is a foothold.
  const total = clouds.reduce((s, g) => s + g.pos.length, 0);
  const footholds = new Float32Array(total);
  let o = 0;
  for (const g of clouds) {
    footholds.set(g.pos, o);
    o += g.pos.length;
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
  return { clusters, wordPos, bounds: { x: bx, y: by, z: bz, radius }, _clouds: clouds, _streams: streams, _footholds: footholds };
}
