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
import { BALL_KINDS, makeBall } from './galaxy.js';

/** Cluster radius from its word count. */
export function clusterRadius(count) {
  return Math.max(140, Math.min(340, 140 + 11 * Math.sqrt(count)));
}

/** Star count for a cluster. */
export function particleCount(count) {
  return Math.min(36000, Math.round(21500 + 1750 * Math.sqrt(count)));
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
 * within `cut` (and every 6th to a second one). Stars are bucketed into a
 * dense grid of `cut`-sized cells (a counting sort), so each search scans at
 * most nine contiguous runs of three cells, its own run first; runs that
 * cannot hold a closer star are skipped, so dense cores stay cheap. Stars
 * fainter than `minBright` (micro-dust, haze) neither start nor end a link,
 * so the web traces the structure rather than fraying the edges.
 */
function makeEdges(pos, cut, stride = 2, bright = null, minBright = 0) {
  const n = pos.length / 3;
  if (!n) return new Uint32Array(0);
  const linked = (i) => !bright || bright[i] >= minBright;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n * 3; i += 3) {
    x0 = Math.min(x0, pos[i]);
    x1 = Math.max(x1, pos[i]);
    y0 = Math.min(y0, pos[i + 1]);
    y1 = Math.max(y1, pos[i + 1]);
    z0 = Math.min(z0, pos[i + 2]);
    z1 = Math.max(z1, pos[i + 2]);
  }
  // Cells at least `cut` wide (wider only if the grid would be huge), so the 3x3x3 scan is exact.
  let cell = cut;
  const dims = () => [Math.floor((x1 - x0) / cell) + 1, Math.floor((y1 - y0) / cell) + 1, Math.floor((z1 - z0) / cell) + 1];
  let [nx, ny, nz] = dims();
  while (nx * ny * nz > 4e6) {
    cell *= 1.3;
    [nx, ny, nz] = dims();
  }
  const cells = nx * ny * nz;
  const cellOf = new Int32Array(n);
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < n; i++) {
    if (!linked(i)) {
      cellOf[i] = -1;
      continue;
    }
    const c = Math.floor((pos[i * 3] - x0) / cell) + nx * (Math.floor((pos[i * 3 + 1] - y0) / cell) + ny * Math.floor((pos[i * 3 + 2] - z0) / cell));
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) if (cellOf[i] >= 0) order[fill[cellOf[i]]++] = i;

  // The nine (dy, dz) rows, own row first, then faces, then corners.
  const ROWS = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
  const cut2 = cut * cut;
  const edges = new Uint32Array(Math.ceil(n / stride) * 2 + Math.ceil(n / 6) * 2 + 2);
  let e = 0;
  for (let i = 0; i < n; i += stride) {
    if (cellOf[i] < 0) continue;
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const ix = Math.floor((x - x0) / cell);
    const iy = Math.floor((y - y0) / cell);
    const iz = Math.floor((z - z0) / cell);
    const ly = y - y0 - iy * cell;
    const lz = z - z0 - iz * cell;
    const two = i % 6 === 0;
    let b1 = -1;
    let b2 = -1;
    let d1 = cut2;
    let d2 = cut2;
    for (let q = 0; q < 18; q += 2) {
      const dy = ROWS[q];
      const dz = ROWS[q + 1];
      const cy = iy + dy;
      const cz = iz + dz;
      if (cy < 0 || cz < 0 || cy >= ny || cz >= nz) continue;
      const gy = dy > 0 ? cell - ly : dy < 0 ? ly : 0;
      const gz = dz > 0 ? cell - lz : dz < 0 ? lz : 0;
      if (gy * gy + gz * gz >= (two ? d2 : d1)) continue;
      const row = nx * (cy + ny * cz);
      const hi = start[row + Math.min(nx - 1, ix + 1) + 1];
      for (let k = start[row + Math.max(0, ix - 1)]; k < hi; k++) {
        const j = order[k];
        if (j === i) continue;
        const ex = pos[j * 3] - x;
        const ey = pos[j * 3 + 1] - y;
        const ez = pos[j * 3 + 2] - z;
        const d = ex * ex + ey * ey + ez * ez;
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
    if (b1 >= 0) {
      edges[e++] = i;
      edges[e++] = b1;
    }
    if (b2 >= 0 && two) {
      edges[e++] = i;
      edges[e++] = b2;
    }
  }
  return edges.slice(0, e);
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
    if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] > r * r * 0.64) continue;
    const relax = tries > count * 100 ? 0.45 : 1;
    const lim = (minD * relax) ** 2;
    if (picks.some((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < lim)) continue;
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

/**
 * A tidal stream of stardust from one cluster to another: a river of several
 * thin strands braided around a bowed path (they gather at the ends and part
 * in the middle), beaded with small knots, inside a faint diffuse envelope.
 * Given `arc` ({a, b} points), the river instead runs from a to b under the
 * same upward arch the spider leaps along (see director travelTo), so its
 * jump between consecutive sections follows the river.
 */
function stream(A, B, rand, count, arc = null) {
  const leap = !!arc;
  const a = leap ? arc.a : [A.cx, A.cy, A.cz];
  const b = leap ? arc.b : [B.cx, B.cy, B.cz];
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...d) || 1;
  const t0 = norm(d);
  const dot3 = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const flat = (v) => norm([v[0] - t0[0] * dot3(v, t0), v[1] - t0[1] * dot3(v, t0), v[2] - t0[2] * dot3(v, t0)]);
  const rnd = flat([gauss(rand), gauss(rand), gauss(rand)]);
  const n1 = leap ? flat([0, 1, 0]) : rnd;
  const n2 = norm([t0[1] * n1[2] - t0[2] * n1[1], t0[2] * n1[0] - t0[0] * n1[2], t0[0] * n1[1] - t0[1] * n1[0]]);
  // Leap: a world-up parabola like the jump's (apex about 0.31 of the span); otherwise a sideways bow.
  const bowV = leap ? [0, Math.max(55, L * 0.31), 0] : n1.map((v) => v * L * range(rand, 0.08, 0.2) * (rand() < 0.5 ? -1 : 1));
  const shape = leap ? (t) => 4 * t * (1 - t) : (t) => Math.sin(Math.PI * t);
  const sway = L * range(rand, -0.06, 0.06) * (leap ? 0.4 : 1);
  const path = (t) => {
    const s = shape(t);
    const s2 = Math.sin(Math.PI * 2 * t) * sway;
    return [a[0] + d[0] * t + bowV[0] * s + n2[0] * s2, a[1] + d[1] * t + bowV[1] * s + n2[1] * s2, a[2] + d[2] * t + bowV[2] * s + n2[2] * s2];
  };
  const strands = [];
  const S = leap ? Math.round(range(rand, 3, 5)) : Math.round(range(rand, 2, 3));
  for (let k = 0; k < S; k++) strands.push({ phase: (k / S) * Math.PI * 2 + range(rand, -0.4, 0.4), rad: range(rand, 0.6, 1.1), th: range(rand, 1.6, 3.2), bead: range(rand, 5, 12), bph: rand() * Math.PI * 2 });
  const twist = range(rand, 0.7, 1.6) * Math.PI * 2 * (rand() < 0.5 ? -1 : 1);
  // A leap river is wider than the spider, so it reads around it in flight.
  const width = leap ? 14 + L * range(rand, 0.08, 0.1) : 7 + L * range(rand, 0.035, 0.055);
  // Most stars lie between the clusters, fewer deep inside them.
  const along = () => {
    const u = rand();
    return 0.5 + (u - 0.5) * (0.7 + 0.3 * Math.abs(u - 0.5) * 2);
  };
  const pos = new Float32Array(count * 3);
  const bright = new Float32Array(count);
  let i = 0;
  const put = (p, br) => {
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
    bright[i] = br;
    i++;
  };
  const strandAt = (st, t) => {
    const s = Math.sin(Math.PI * t);
    const ang = st.phase + twist * t;
    const w = width * st.rad * (0.22 + 0.78 * s);
    const c = path(t);
    return [c[0] + (n1[0] * Math.cos(ang) + n2[0] * Math.sin(ang)) * w, c[1] + (n1[1] * Math.cos(ang) + n2[1] * Math.sin(ang)) * w, c[2] + (n1[2] * Math.cos(ang) + n2[2] * Math.sin(ang)) * w];
  };
  const nStrand = Math.round(count * 0.64);
  const nKnot = Math.round(count * 0.12);
  // Braided strands, beaded along their length.
  for (let guard = 0; i < nStrand && guard < nStrand * 6; guard++) {
    const st = strands[Math.floor(rand() * S)];
    const t = along();
    const bead = 0.5 + 0.5 * Math.sin(t * st.bead * Math.PI * 2 + st.bph);
    if (rand() > 0.35 + 0.65 * bead) continue;
    const s = Math.sin(Math.PI * t);
    const c = strandAt(st, t);
    const th = st.th * (0.7 + 0.6 * s);
    put([c[0] + gauss(rand) * th, c[1] + gauss(rand) * th, c[2] + gauss(rand) * th], range(rand, 0.45, 1) * (0.55 + 0.45 * s));
  }
  // Small knots strung along the strands.
  const K = Math.max(3, Math.round(nKnot / 30));
  for (let k = 0; k < K && i < count; k++) {
    const st = strands[Math.floor(rand() * S)];
    const c = strandAt(st, range(rand, 0.15, 0.85));
    const m = Math.round((nKnot / K) * range(rand, 0.6, 1.4));
    const kr = range(rand, 2.5, 5);
    for (let j = 0; j < m && i < count; j++) put([c[0] + gauss(rand) * kr, c[1] + gauss(rand) * kr, c[2] + gauss(rand) * kr], range(rand, 0.6, 1));
  }
  // Faint diffuse envelope around the braid.
  while (i < count) {
    const t = along();
    const s = Math.sin(Math.PI * t);
    const c = path(t);
    const spread = (5 + width * 0.8 * s) * (rand() < 0.15 ? 1.8 : 1);
    put([c[0] + gauss(rand) * spread, c[1] + gauss(rand) * spread, c[2] + gauss(rand) * spread], range(rand, 0.08, 0.3) * (0.5 + 0.5 * s));
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
  // Neighbouring sections get different characters: lumpy, filamentary, cored, balanced.
  const kindAt = Math.floor(fork(seed, 'kinds')() * BALL_KINDS.length);
  sections.forEach((sec, i) => {
    const r = radii[i];
    const [cx, cy, cz] = centers[i];
    const g = makeBall(fork(seed, `ball:${i}`), r, particleCount(sec.count), { kind: BALL_KINDS[(kindAt + i) % BALL_KINDS.length] });
    for (let k = 0; k < g.pos.length; k += 3) {
      g.pos[k] += cx;
      g.pos[k + 1] += cy;
      g.pos[k + 2] += cz;
    }
    g.edges = makeEdges(g.pos, r * 0.05, 1, g.bright, 0.17);
    const words = placeWords(g, cx, cy, cz, r, sec.count, fork(seed, `words:${i}`), false);
    words.forEach((p, w) => wordPos.set(p, (sec.start + w) * 3));
    clouds.push(g);
    clusters.push({ index: i, cx, cy, cz, r, color: sec.color || sectionColor(i) });
  });

  // A few more balls with no words, to make the whole ecosystem bigger.
  const xrand = fork(seed, 'extras');
  const xr = Array.from({ length: Math.max(4, Math.round(sections.length * 1.15)) }, () => clusterRadius(range(xrand, 12, 44)));
  placeExtras(centers, radii, xr, xrand).forEach(([cx, cy, cz], k) => {
    const r = xr[k];
    const g = makeBall(fork(seed, `extra:${k}`), r, Math.round(particleCount(range(xrand, 12, 44)) * 0.5));
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
      if (!route) {
        streams.push(stream(A, B, srand, 1200));
        continue;
      }
      // The leap: from the last word read in A to where the first words of B hang.
      const sa = sections[i];
      const sb = sections[j];
      const last = (sa.start + Math.max(0, sa.count - 1)) * 3;
      const first = Math.min(6, sb.count);
      const to = [0, 0, 0];
      for (let w = 0; w < first; w++) for (let k = 0; k < 3; k++) to[k] += wordPos[(sb.start + w) * 3 + k] / Math.max(1, first);
      const ok = sa.count > 0 && sb.count > 0;
      streams.push(stream(A, B, srand, 4000, ok ? { a: [wordPos[last], wordPos[last + 1], wordPos[last + 2]], b: to } : { a: [A.cx, A.cy, A.cz], b: [B.cx, B.cy, B.cz] }));
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
