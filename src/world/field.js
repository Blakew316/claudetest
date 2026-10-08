/**
 * The 3D web: one volumetric nebula of particles per prompt section, linked
 * by a sparse constellation of edges, laid out as a winding chain through
 * space so the camera has somewhere to travel. Pure data (no WebGL), so the
 * director can run in node.
 *
 * World.wordPos holds [x, y, z] per word; clusters carry cx, cy, cz and r.
 */

import { fork, gauss, range } from '../core/rng.js';
import { sectionColor } from '../core/theme.js';

/** Cluster radius from its word count. */
export function clusterRadius(count) {
  return Math.max(150, Math.min(420, 150 + 14 * Math.sqrt(count)));
}

/** Particle count for a cluster. */
export function particleCount(count) {
  return Math.min(5200, Math.round(2400 + 130 * Math.sqrt(count)));
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

/** Choose well-spread particles for the words, ordered along a sweep so reading travels. */
function placeWords(cloud, r, count, rand) {
  const n = cloud.pos.length / 3;
  const picks = [];
  const minD = (r * 0.95) / Math.sqrt(Math.max(1, count));
  const used = new Set();
  for (let tries = 0; picks.length < count && tries < count * 60; tries++) {
    const i = Math.floor(rand() * n);
    if (used.has(i)) continue;
    const x = cloud.pos[i * 3];
    const y = cloud.pos[i * 3 + 1];
    const z = cloud.pos[i * 3 + 2];
    if (Math.hypot(x, y, z) > r * 0.8) continue;
    const relax = tries > count * 30 ? 0.4 : 1;
    if (picks.some((p) => Math.hypot(p[0] - x, p[1] - y, p[2] - z) < minD * relax)) continue;
    used.add(i);
    picks.push([x, y, z]);
  }
  while (picks.length < count) picks.push([gauss(rand) * r * 0.3, gauss(rand) * r * 0.2, gauss(rand) * r * 0.2]);
  const sweep = norm([gauss(rand), gauss(rand) * 0.5, gauss(rand)]);
  picks.sort((a, b) => a[0] * sweep[0] + a[1] * sweep[1] + a[2] * sweep[2] - (b[0] * sweep[0] + b[1] * sweep[1] + b[2] * sweep[2]));
  return picks;
}

/**
 * Long silk threads: sagging curves between particles, as line-segment
 * endpoints. Within a cluster they span it; bridges join neighbouring
 * clusters so the space between webs is strung with silk too.
 */
function sagThread(out, a, b, sub, sag, rand) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const bow = (rand() - 0.5) * L * 0.08;
  let prev = a;
  for (let k = 1; k <= sub; k++) {
    const u = k / sub;
    const s = Math.sin(Math.PI * u);
    const p = [a[0] + (b[0] - a[0]) * u + bow * s, a[1] + (b[1] - a[1]) * u - sag * L * s, a[2] + (b[2] - a[2]) * u - bow * s * 0.5];
    out.push(...prev, ...p);
    prev = p;
  }
}

function clusterThreads(cloud, r, rand, count) {
  const out = [];
  const n = cloud.pos.length / 3;
  const at = (i) => [cloud.pos[i * 3], cloud.pos[i * 3 + 1], cloud.pos[i * 3 + 2]];
  for (let t = 0, tries = 0; t < count && tries < count * 20; tries++) {
    const a = at(Math.floor(rand() * n));
    const b = at(Math.floor(rand() * n));
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (L < r * 0.5 || L > r * 1.6) continue;
    sagThread(out, a, b, 10, 0.05, rand);
    t++;
  }
  return new Float32Array(out);
}

function bridgeThreads(clusters, clouds, rand) {
  const out = [];
  const pick = (ci, toward) => {
    // The particle among a sample that faces the other cluster best.
    const cloud = clouds[ci];
    const c = clusters[ci];
    const n = cloud.pos.length / 3;
    let best = null;
    let score = -Infinity;
    for (let k = 0; k < 40; k++) {
      const i = Math.floor(rand() * n);
      const p = [cloud.pos[i * 3], cloud.pos[i * 3 + 1], cloud.pos[i * 3 + 2]];
      const sc = (p[0] - c.cx) * toward[0] + (p[1] - c.cy) * toward[1] + (p[2] - c.cz) * toward[2] + rand() * c.r * 0.3;
      if (sc > score) {
        score = sc;
        best = p;
      }
    }
    return best;
  };
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const A = clusters[i];
      const B = clusters[j];
      const d = [B.cx - A.cx, B.cy - A.cy, B.cz - A.cz];
      const L = Math.hypot(...d);
      if (L > (A.r + B.r) * 1.35) continue;
      const u = d.map((x) => x / L);
      const count = j === i + 1 ? 12 : 6;
      for (let k = 0; k < count; k++) sagThread(out, pick(i, u), pick(j, u.map((x) => -x)), 16, 0.035, rand);
    }
  }
  return new Float32Array(out);
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
    const cloud = makeCloud(fork(seed, `cloud:${i}`), r, particleCount(sec.count));
    for (let k = 0; k < cloud.pos.length; k += 3) {
      cloud.pos[k] += cx;
      cloud.pos[k + 1] += cy;
      cloud.pos[k + 2] += cz;
    }
    const rel = makeCloudRel(cloud, cx, cy, cz);
    cloud.edges = makeEdges(cloud.pos, r);
    cloud.threads = clusterThreads(cloud, r, fork(seed, `threads:${i}`), Math.round(30 + sec.count * 0.6));
    const words = placeWords(rel, r, sec.count, fork(seed, `words:${i}`));
    for (let w = 0; w < sec.count; w++) {
      const id = sec.start + w;
      wordPos[id * 3] = cx + words[w][0];
      wordPos[id * 3 + 1] = cy + words[w][1];
      wordPos[id * 3 + 2] = cz + words[w][2];
    }
    clouds.push(cloud);
    clusters.push({ index: i, cx, cy, cz, r, color: sec.color || sectionColor(i) });
  });
  // Bounding sphere of everything, for the overview shot.
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
  const bridges = bridgeThreads(clusters, clouds, fork(seed, 'bridges'));
  return { clusters, wordPos, bounds: { x: bx, y: by, z: bz, radius }, _clouds: clouds, _bridges: bridges };
}

/** Positions relative to the cluster centre, for word placement. */
function makeCloudRel(cloud, cx, cy, cz) {
  const pos = new Float32Array(cloud.pos.length);
  for (let k = 0; k < pos.length; k += 3) {
    pos[k] = cloud.pos[k] - cx;
    pos[k + 1] = cloud.pos[k + 1] - cy;
    pos[k + 2] = cloud.pos[k + 2] - cz;
  }
  return { pos };
}
