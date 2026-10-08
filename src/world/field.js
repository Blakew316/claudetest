/**
 * The particle world: one wispy nebula cluster per prompt section, laid out
 * as a lumpy zig-zag chain, plus the word nodes the spider reads.
 *
 * buildWorld() is pure data (no canvas, safe in node tests). drawWorld()
 * lazily pre-renders each cluster's static particles and constellation web
 * into offscreen bitmaps (a grey "queued" and a coloured variant, each at a
 * high-res and a low-res level of detail) and per frame only composites those
 * bitmaps, the active cluster's glow, the twinkling stars and the read
 * word-node squares.
 *
 * Private render data lives on the World object under `_`-prefixed keys; the
 * public contract (clusters, wordPos, bounds) is in src/core/contracts.js.
 */

import { fork, gauss, range } from '../core/rng.js';
import { QUEUED, FLAG, sectionColor, withAlpha, mix } from '../core/theme.js';
import { applyWorldTransform } from './camera.js';

// ---------------------------------------------------------------- tuning --

/** Max penetration between any two clusters, as a fraction of the smaller cluster's diameter. */
export const MAX_OVERLAP = 0.25;
/** Centre distance of consecutive clusters, as a multiple of r1 + r2. */
const GAP_MIN = 0.95;
const GAP_MAX = 1.1;

/** Brightness of the grey bitmap for queued clusters. */
const QUEUED_ALPHA = 0.62;
/** Brightness of the coloured bitmap for done clusters during the crawl. */
const DONE_ALPHA = 0.5;
/** Brightness of every cluster in the ship overview. */
const SHIP_ALPHA = 1;
/** Crossfade time constant (s); ~95% of a status change lands in 0.6 s. */
const FADE_TAU = 0.2;
/** Highest-detail bitmap: px per world unit per dpr (good to zoom ~1.6). */
const HI_SCALE = 1.6;
/** Low-detail bitmap used when zoomed out (ship overview). */
const LO_SCALE = 0.55;
/** Max bitmap side in device px. */
const MAX_SIDE = 1600;
/** World size of a read word-node square. */
const NODE_SIZE = 4.2;
/** Faint pre-rendered dust points per web particle. */
const DUST_PER_PARTICLE = 3.5;
/** Share of web particles / dust that sit on filaments (the rest is blob, outskirts, arms). */
const WEB_FILAMENT_SHARE = 0.28;
const DUST_FILAMENT_SHARE = 0.42;
/** Peak alpha of the pre-rendered filament haze. */
const HAZE_ALPHA = 0.045;

// --------------------------------------------------------------- helpers --

/** Fast 2D length (Math.hypot is slow in V8 hot loops). */
const hyp = (x, y) => Math.sqrt(x * x + y * y);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Cluster radius for a section of `count` words. */
export function clusterRadius(count) {
  return clamp(150 + 14 * Math.sqrt(Math.max(0, count)), 150, 420);
}

/** Particle count for a section of `count` words. */
export function particleCount(count) {
  return Math.min(2200, Math.round(700 + 60 * Math.sqrt(Math.max(0, count))));
}

/**
 * Seeded 2D value noise in [-1, 1] with smooth interpolation.
 * @param {() => number} rand
 * @returns {(x:number, y:number) => number}
 */
function makeNoise(rand) {
  const val = new Float32Array(256);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    val[i] = rand() * 2 - 1;
    p[i] = i;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const X = xi & 255;
    const Y = yi & 255;
    const a = val[perm[X + perm[Y]]];
    const b = val[perm[X + 1 + perm[Y]]];
    const c = val[perm[X + perm[Y + 1]]];
    const d = val[perm[X + 1 + perm[Y + 1]]];
    const top = a + (b - a) * u;
    const bot = c + (d - c) * u;
    return top + (bot - top) * v;
  };
}

/** Smallest absolute difference between two angles (0..PI). */
function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d < -Math.PI) d += Math.PI * 2;
  if (d > Math.PI) d -= Math.PI * 2;
  return Math.abs(d);
}

/** Overlap of two circles as a fraction of the smaller one's diameter (0 = touching or apart). */
export function overlapFraction(a, b) {
  const d = hyp(a.cx - b.cx, a.cy - b.cy);
  return Math.max(0, a.r + b.r - d) / (2 * Math.min(a.r, b.r));
}

// ---------------------------------------------------------------- layout --

/**
 * Deterministic zig-zag packing. Cluster 0 sits at the origin; each next
 * cluster touches the previous one (centre distance 0.95–1.1 × (r1+r2)) at
 * an angle that turns away from the last walk direction, prefers spots
 * close to the overall centroid (so the whole reads as one nebula) and never
 * overlaps any cluster by more than MAX_OVERLAP.
 * @param {number[]} radii
 * @param {() => number} rand
 * @returns {{cx:number, cy:number, r:number, dir:number}[]}
 */
function layoutClusters(radii, rand) {
  const out = [];
  let prevDir = -Math.PI / 2 + range(rand, -0.7, 0.2); // first walk heads up / up-left
  let prevTurn = rand() < 0.5 ? 1 : -1;
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i];
    if (i === 0) {
      out.push({ cx: 0, cy: 0, r, dir: prevDir });
      continue;
    }
    let sx = 0;
    let sy = 0;
    for (const c of out) {
      sx += c.cx;
      sy += c.cy;
    }
    const gx = sx / out.length;
    const gy = sy / out.length;
    const spread = out.reduce((m, c) => Math.max(m, c.r), 0) * 2;

    // Try around the previous cluster first; fall back to any cluster.
    const anchors = [out[i - 1], ...out.slice(0, i - 1).reverse()];
    let best = null;
    for (let ai = 0; ai < anchors.length && !best; ai++) {
      const anchor = anchors[ai];
      const relax = ai === 0 ? 1 : 1.08;
      const K = 72;
      const off = rand() * Math.PI * 2;
      for (let k = 0; k < K; k++) {
        const a = off + (k / K) * Math.PI * 2;
        const gap = range(rand, GAP_MIN, GAP_MAX) * relax;
        const d = gap * (anchor.r + r);
        const cand = { cx: anchor.cx + Math.cos(a) * d, cy: anchor.cy + Math.sin(a) * d, r };
        let ok = true;
        let contacts = 0;
        for (const c of out) {
          if (overlapFraction(cand, c) > MAX_OVERLAP) {
            ok = false;
            break;
          }
          if (hyp(cand.cx - c.cx, cand.cy - c.cy) < 1.12 * (c.r + r)) contacts++;
        }
        if (!ok) continue;
        // Turn preference: consecutive walks change direction (90–150° ideal).
        const turn = angleDiff(a, prevDir);
        let turnScore;
        if (i === 1) turnScore = -angleDiff(a, prevDir) * 1.2;
        else turnScore = 1 - Math.abs(turn - 2.1) * 1.1 - (turn < 0.9 ? 2 : 0) - (turn > 2.8 ? 1.2 : 0);
        // Alternate the turn side a little (up, left, down-right, ...).
        const side = Math.sin(a - prevDir) >= 0 ? 1 : -1;
        const sideScore = side !== prevTurn ? 0.35 : 0;
        const centroidDist = hyp(cand.cx - gx, cand.cy - gy) / spread;
        const score = turnScore + sideScore - 2.2 * centroidDist + 0.25 * contacts + rand() * 0.5;
        if (!best || score > best.score) best = { ...cand, score, dir: a, side, anchor };
      }
    }
    if (!best) {
      // Should never happen; place far enough away on a seeded ring.
      const a = rand() * Math.PI * 2;
      const d = spread * 2;
      best = { cx: gx + Math.cos(a) * d, cy: gy + Math.sin(a) * d, r, dir: a, side: 1, anchor: out[i - 1] };
    }
    const walkDir = Math.atan2(best.cy - out[i - 1].cy, best.cx - out[i - 1].cx);
    prevTurn = Math.sin(walkDir - prevDir) >= 0 ? 1 : -1;
    prevDir = walkDir;
    out.push({ cx: best.cx, cy: best.cy, r, dir: walkDir });
  }
  return out;
}

// ----------------------------------------------------------------- cloud --

/**
 * Generate one cluster's static particle cloud (positions relative to the
 * cluster centre): a warped Gaussian blob threaded with filaments and a few
 * wispy arms, a fine nearest-neighbour web, a sparser long-edge web and ~3%
 * twinkling stars.
 * @param {() => number} rand
 * @param {number} r
 * @param {number} count  words in the section
 */
function makeCloud(rand, r, count) {
  const n = particleCount(count);
  const noiseA = makeNoise(rand);
  const noiseB = makeNoise(rand);
  const noiseC = makeNoise(rand);
  const rot = rand() * Math.PI * 2;
  const elong = range(rand, 1.0, 1.4);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const ex = Math.sqrt(elong);
  const ey = 1 / Math.sqrt(elong);
  const f = 1.7 / r;
  const ox = rand() * 50;
  const oy = rand() * 50;
  const warpAmp = 0.2 * r;

  /** Shape transform: elongate, rotate, then domain-warp with two octaves of value noise. */
  const shape = (x, y, out) => {
    const ax = x * ex;
    const ay = y * ey;
    const bx = ax * cr - ay * sr;
    const by = ax * sr + ay * cr;
    const wx = noiseA(bx * f + ox, by * f + oy) + 0.45 * noiseA(bx * f * 2.3 + 31, by * f * 2.3 + 17);
    const wy = noiseB(bx * f + oy, by * f + ox) + 0.45 * noiseB(bx * f * 2.3 + 7, by * f * 2.3 + 41);
    out[0] = bx + wx * warpAmp;
    out[1] = by + wy * warpAmp;
    return out;
  };
  /** Density mask: lumpy edges, low-frequency holes. */
  const keep = (x, y) => {
    const m = noiseC(x * f * 1.3 + 3, y * f * 1.3 + 9);
    return rand() < 0.74 + 0.3 * m;
  };

  const tmp = [0, 0];

  // Skeleton nodes and filaments.
  const M = clamp(Math.round(26 + 0.5 * count), 26, 80);
  const nodes = [];
  while (nodes.length < M) {
    const x = gauss(rand) * 0.36 * r;
    const y = gauss(rand) * 0.36 * r;
    if (x * x + y * y > 1.25 * r * 1.25 * r) continue;
    shape(x, y, tmp);
    nodes.push({ x: tmp[0], y: tmp[1], w: range(rand, 0.6, 1.2) });
  }
  const segs = [];
  const segKey = new Set();
  for (let i = 0; i < M; i++) {
    const near = [];
    for (let j = 0; j < M; j++) {
      if (j === i) continue;
      const d = hyp(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < 0.6 * r) near.push([d, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const k = 2 + (rand() < 0.4 ? 1 : 0);
    for (let q = 0; q < Math.min(k, near.length); q++) {
      const j = near[q][1];
      const key = i < j ? i * 1000 + j : j * 1000 + i;
      if (segKey.has(key)) continue;
      segKey.add(key);
      segs.push({ a: nodes[i], b: nodes[j], len: near[q][0], bow: gauss(rand) * 0.12, thick: range(rand, 0.01, 0.04) });
    }
  }
  let totalLen = 0;
  const cum = new Float32Array(segs.length);
  segs.forEach((s, i) => {
    totalLen += s.len;
    cum[i] = totalLen;
  });

  // Wispy arms reaching out of the blob.
  const arms = [];
  const armCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < armCount; i++) {
    arms.push({ a0: rand() * Math.PI * 2, curl: range(rand, -1.1, 1.1), reach: range(rand, 0.75, 1.1) });
  }

  /**
   * Sample one point from the cloud mixture: filaments, diffuse core,
   * outskirts and curling arms. Returns false when the density mask rejects it.
   * @param {number} wFil  filament share
   * @param {number[]} out
   */
  const samplePoint = (wFil, out) => {
    const u = rand();
    let x;
    let y;
    if (u < wFil && segs.length) {
      const target = rand() * totalLen;
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const s = segs[lo];
      const t = rand();
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const inv = 1 / (s.len || 1);
      const bow = Math.sin(t * Math.PI) * s.bow * s.len;
      const off = gauss(rand) * r * s.thick + bow;
      x = s.a.x + dx * t - dy * inv * off;
      y = s.a.y + dy * t + dx * inv * off;
    } else {
      const v = (u - wFil) / (1 - wFil);
      if (v < 0.64) {
        shape(gauss(rand) * 0.34 * r, gauss(rand) * 0.34 * r, out);
        x = out[0];
        y = out[1];
        if (!keep(x, y)) return false;
      } else if (v < 0.84) {
        shape(gauss(rand) * 0.6 * r, gauss(rand) * 0.6 * r, out);
        x = out[0];
        y = out[1];
        if (!keep(x, y)) return false;
      } else {
        const arm = arms[Math.floor(rand() * arms.length)];
        const t = Math.pow(rand(), 0.8);
        const rad = r * (0.3 + t * arm.reach);
        const ang = arm.a0 + arm.curl * t;
        const spreadA = r * (0.02 + 0.07 * t);
        x = Math.cos(ang) * rad + gauss(rand) * spreadA;
        y = Math.sin(ang) * rad + gauss(rand) * spreadA;
      }
    }
    out[0] = x;
    out[1] = y;
    return true;
  };

  // Web particles: the ones that carry edges, stars and word nodes.
  const px = new Float32Array(n * 2);
  const size = new Float32Array(n);
  const alpha = new Float32Array(n);
  const isStar = new Uint8Array(n);
  let p = 0;
  let guard = 0;
  while (p < n && guard++ < n * 20) {
    if (!samplePoint(WEB_FILAMENT_SHARE, tmp)) continue;
    const x = tmp[0];
    const y = tmp[1];
    const dist = Math.sqrt(x * x + y * y);
    px[p * 2] = x;
    px[p * 2 + 1] = y;
    const fall = 1 - 0.5 * smoothstep(0.55 * r, 1.35 * r, dist);
    alpha[p] = (0.4 + 0.6 * Math.pow(rand(), 0.7)) * fall;
    size[p] = rand() < 0.22 ? range(rand, 1.45, 1.9) : range(rand, 1.05, 1.4);
    if (rand() < 0.03) {
      isStar[p] = 1;
      size[p] = range(rand, 2, 3);
    }
    p++;
  }
  const count2 = p;

  // Dust: faint sub-particles that only exist in the pre-rendered bitmap and
  // give the cloud its fine, dense nebula grain. Free per frame.
  const nd = Math.round(count2 * DUST_PER_PARTICLE);
  const dust = new Float32Array(nd * 3);
  let q = 0;
  guard = 0;
  while (q < nd && guard++ < nd * 20) {
    if (!samplePoint(DUST_FILAMENT_SHARE, tmp)) continue;
    const x = tmp[0];
    const y = tmp[1];
    const dist = Math.sqrt(x * x + y * y);
    const fall = 1 - 0.6 * smoothstep(0.5 * r, 1.4 * r, dist);
    dust[q * 3] = x;
    dust[q * 3 + 1] = y;
    dust[q * 3 + 2] = (0.22 + 0.6 * rand() * rand()) * fall;
    q++;
  }

  // Fine constellation web: 1–3 nearest neighbours within a cutoff, found
  // through a flat grid hash (counting sort into cells, no allocation per query).
  const cutoff = Math.max(18, 0.16 * r);
  const cut2 = cutoff * cutoff;
  let gMinX = Infinity;
  let gMinY = Infinity;
  let gMaxX = -Infinity;
  let gMaxY = -Infinity;
  for (let i = 0; i < count2; i++) {
    const x = px[i * 2];
    const y = px[i * 2 + 1];
    if (x < gMinX) gMinX = x;
    if (x > gMaxX) gMaxX = x;
    if (y < gMinY) gMinY = y;
    if (y > gMaxY) gMaxY = y;
  }
  const GW = Math.max(1, Math.ceil((gMaxX - gMinX) / cutoff) + 1);
  const GH = Math.max(1, Math.ceil((gMaxY - gMinY) / cutoff) + 1);
  const cellOf = new Int32Array(count2);
  const cellStart = new Int32Array(GW * GH + 1);
  for (let i = 0; i < count2; i++) {
    const c = Math.floor((px[i * 2] - gMinX) / cutoff) + Math.floor((px[i * 2 + 1] - gMinY) / cutoff) * GW;
    cellOf[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < GW * GH; c++) cellStart[c + 1] += cellStart[c];
  const fill = cellStart.slice(0, GW * GH);
  const cellItems = new Int32Array(count2);
  for (let i = 0; i < count2; i++) cellItems[fill[cellOf[i]]++] = i;

  const edgeSet = new Set();
  const edges = [];
  const bestD = new Float64Array(3);
  const bestJ = new Int32Array(3);
  for (let i = 0; i < count2; i++) {
    const x = px[i * 2];
    const y = px[i * 2 + 1];
    const cx = cellOf[i] % GW;
    const cy = (cellOf[i] - cx) / GW;
    bestD.fill(Infinity);
    bestJ.fill(-1);
    for (let iy = Math.max(0, cy - 1); iy <= Math.min(GH - 1, cy + 1); iy++) {
      for (let ix = Math.max(0, cx - 1); ix <= Math.min(GW - 1, cx + 1); ix++) {
        const c = ix + iy * GW;
        for (let q = cellStart[c], qe = cellStart[c + 1]; q < qe; q++) {
          const j = cellItems[q];
          if (j === i) continue;
          const dx = px[j * 2] - x;
          const dy = px[j * 2 + 1] - y;
          const d = dx * dx + dy * dy;
          if (d >= cut2 || d >= bestD[2]) continue;
          // Insert into the sorted top-3.
          if (d < bestD[0]) {
            bestD[2] = bestD[1];
            bestJ[2] = bestJ[1];
            bestD[1] = bestD[0];
            bestJ[1] = bestJ[0];
            bestD[0] = d;
            bestJ[0] = j;
          } else if (d < bestD[1]) {
            bestD[2] = bestD[1];
            bestJ[2] = bestJ[1];
            bestD[1] = d;
            bestJ[1] = j;
          } else {
            bestD[2] = d;
            bestJ[2] = j;
          }
        }
      }
    }
    const roll = rand();
    const k = roll < 0.2 ? 1 : roll < 0.65 ? 2 : 3;
    for (let q = 0; q < k; q++) {
      const j = bestJ[q];
      if (j < 0) break;
      const key = i < j ? i * 4096 + j : j * 4096 + i;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push(i, j);
    }
  }

  // Sparse long-edge web between "hub" particles: the polygonal cells.
  const hubs = [];
  for (let i = 0; i < count2; i++) if (rand() < 0.075) hubs.push(i);
  const longEdges = [];
  const hubCut = 0.36 * r;
  for (const i of hubs) {
    const near = [];
    for (const j of hubs) {
      if (j === i) continue;
      const d = hyp(px[j * 2] - px[i * 2], px[j * 2 + 1] - px[i * 2 + 1]);
      if (d < hubCut) near.push(Math.round(d * 64) * 4096 + j);
    }
    near.sort((a, b) => a - b);
    const k = rand() < 0.55 ? 2 : 3;
    for (let q = 0; q < Math.min(k, near.length); q++) {
      const j = near[q] % 4096;
      const key = i < j ? i * 4096 + j : j * 4096 + i;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      longEdges.push(i, j);
    }
  }

  // Extent (relative), for bitmap sizing.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count2; i++) {
    const x = px[i * 2];
    const y = px[i * 2 + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = 0.12 * r;
  for (const nd of nodes) {
    minX = Math.min(minX, nd.x - pad);
    minY = Math.min(minY, nd.y - pad);
    maxX = Math.max(maxX, nd.x + pad);
    maxY = Math.max(maxY, nd.y + pad);
  }
  minX -= 4;
  minY -= 4;
  maxX += 4;
  maxY += 4;

  const stars = [];
  for (let i = 0; i < count2; i++) {
    if (!isStar[i]) continue;
    stars.push({
      x: px[i * 2],
      y: px[i * 2 + 1],
      s: size[i],
      a: range(rand, 0.55, 1),
      phase: rand() * Math.PI * 2,
      speed: range(rand, 0.7, 1.9),
    });
  }

  return {
    r,
    n: count2,
    px: px.subarray(0, count2 * 2),
    size: size.subarray(0, count2),
    alpha: alpha.subarray(0, count2),
    isStar: isStar.subarray(0, count2),
    dust: dust.subarray(0, q * 3),
    edges: Uint16Array.from(edges),
    longEdges: Uint16Array.from(longEdges),
    nodes,
    stars,
    extent: { minX, minY, maxX, maxY },
    bitmaps: { hi: null, lo: null },
  };
}

/**
 * Pick spread-out word nodes on particles within 0.8 r (best-candidate
 * sampling), then order them as a loose sweep along the entry direction so
 * the reading drifts across the cluster instead of jumping around.
 * @returns {Float32Array} relative positions [x0,y0,...]
 */
function placeWords(cloud, r, count, entryDir, rand) {
  const out = new Float32Array(count * 2);
  if (!count) return out;
  const elig = [];
  for (let i = 0; i < cloud.n; i++) {
    if (cloud.isStar[i]) continue;
    if (hyp(cloud.px[i * 2], cloud.px[i * 2 + 1]) <= 0.8 * r) elig.push(i);
  }
  if (elig.length < count * 1.3) {
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.isStar[i]) continue;
      const d = hyp(cloud.px[i * 2], cloud.px[i * 2 + 1]);
      if (d > 0.8 * r && d <= 1.0 * r) elig.push(i);
    }
  }
  const used = new Uint8Array(cloud.n);
  const chosen = [];
  const K = 10;
  for (let w = 0; w < count; w++) {
    let best = -1;
    let bestD = -1;
    for (let k = 0; k < K; k++) {
      const c = elig.length ? elig[Math.floor(rand() * elig.length)] : -1;
      if (c < 0 || used[c]) continue;
      const x = cloud.px[c * 2];
      const y = cloud.px[c * 2 + 1];
      let md = Infinity;
      for (let q = 0; q < chosen.length; q++) {
        const dx = chosen[q][0] - x;
        const dy = chosen[q][1] - y;
        const d = dx * dx + dy * dy;
        if (d < md) md = d;
        if (md < bestD) break;
      }
      if (md > bestD) {
        bestD = md;
        best = c;
      }
    }
    if (best >= 0) {
      used[best] = 1;
      chosen.push([cloud.px[best * 2], cloud.px[best * 2 + 1]]);
    } else {
      // More words than free particles: scatter near the core.
      chosen.push([gauss(rand) * 0.35 * r, gauss(rand) * 0.35 * r]);
    }
  }
  const ux = Math.cos(entryDir);
  const uy = Math.sin(entryDir);
  const keyed = chosen.map((c) => ({ c, k: c[0] * ux + c[1] * uy + gauss(rand) * 0.3 * r }));
  keyed.sort((a, b) => a.k - b.k);
  keyed.forEach((e, i) => {
    out[i * 2] = e.c[0];
    out[i * 2 + 1] = e.c[1];
  });
  return out;
}

// ------------------------------------------------------------ buildWorld --

/**
 * Place one cluster per section and every word on a particle.
 * Deterministic for a given (analysis, seed).
 * @param {import('../core/contracts.js').Analysis} analysis
 * @param {number} seed
 * @returns {import('../core/contracts.js').World}
 */
export function buildWorld(analysis, seed) {
  const sections = analysis.sections;
  const radii = sections.map((s) => clusterRadius(s.count));
  const layout = layoutClusters(radii, fork(seed, 'layout'));
  const wordPos = new Float32Array(analysis.words.length * 2);
  const clusters = [];
  const clouds = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  sections.forEach((sec, i) => {
    const { cx, cy, r, dir } = layout[i];
    const color = sec.color || sectionColor(i);
    const cloud = makeCloud(fork(seed, `cloud:${i}`), r, sec.count);
    clouds.push(cloud);
    const rel = placeWords(cloud, r, sec.count, dir, fork(seed, `words:${i}`));
    for (let w = 0; w < sec.count; w++) {
      const id = sec.start + w;
      if (id >= analysis.words.length) break;
      wordPos[id * 2] = cx + rel[w * 2];
      wordPos[id * 2 + 1] = cy + rel[w * 2 + 1];
    }
    clusters.push({
      index: i,
      cx,
      cy,
      r,
      color,
      labelX: cx - 0.3 * r,
      labelY: cy - 0.86 * r,
    });
    minX = Math.min(minX, cx - r * 1.05);
    minY = Math.min(minY, cy - r * 1.05);
    maxX = Math.max(maxX, cx + r * 1.05);
    maxY = Math.max(maxY, cy + r * 1.05);
  });
  if (!clusters.length) {
    minX = minY = -200;
    maxX = maxY = 200;
  }

  return {
    clusters,
    wordPos,
    bounds: { minX, minY, maxX, maxY },
    _clouds: clouds,
    _vis: null,
    /** Bitmap build counters (debug / harness only). */
    _stats: { bitmaps: 0, bitmapMs: 0 },
  };
}

// ------------------------------------------------------------- bitmaps --

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Render a cloud's static layer (haze, web, particles) into a bitmap.
 * @param {ReturnType<typeof makeCloud>} cloud
 * @param {string} color '#rrggbb'
 * @param {number} scale device px per world unit
 * @param {boolean} grey  queued variant (flatter, no haze)
 */
function renderCloud(cloud, color, scale, grey) {
  const { minX, minY, maxX, maxY } = cloud.extent;
  const w = Math.max(2, Math.ceil((maxX - minX) * scale));
  const h = Math.max(2, Math.ceil((maxY - minY) * scale));
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d');
  g.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
  g.globalCompositeOperation = 'lighter';
  const px = cloud.px;
  const unit = 1 / scale; // one device pixel in world units

  // Soft haze along the filaments so the cloud reads as a nebula, not dots.
  for (const nd of cloud.nodes) {
    const R = cloud.r * 0.34 * nd.w;
    const grad = g.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, R);
    grad.addColorStop(0, withAlpha(color, grey ? HAZE_ALPHA * 0.5 : HAZE_ALPHA));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(nd.x - R, nd.y - R, R * 2, R * 2);
  }

  // Long polygonal web, then the fine web. Bucket by length so short
  // edges are brighter than long ones; one stroke per bucket.
  const strokeBuckets = (list, buckets, baseAlpha, width) => {
    g.lineWidth = Math.max(width, 0.6 * unit);
    // Hairlines thinner than a device pixel keep their visual weight via alpha.
    const thin = Math.sqrt(Math.min(1, (width * scale) / 0.6));
    const paths = buckets.map(() => []);
    for (let e = 0; e < list.length; e += 2) {
      const i = list[e];
      const j = list[e + 1];
      const d = hyp(px[j * 2] - px[i * 2], px[j * 2 + 1] - px[i * 2 + 1]);
      let b = 0;
      while (b < buckets.length - 1 && d > buckets[b]) b++;
      paths[b].push(i, j);
    }
    paths.forEach((path, b) => {
      if (!path.length) return;
      g.strokeStyle = withAlpha(color, baseAlpha * thin * (1 - b * 0.28));
      g.beginPath();
      for (let k = 0; k < path.length; k += 2) {
        const i = path[k];
        const j = path[k + 1];
        g.moveTo(px[i * 2], px[i * 2 + 1]);
        g.lineTo(px[j * 2], px[j * 2 + 1]);
      }
      g.stroke();
    });
  };
  strokeBuckets(cloud.longEdges, [40, 70, Infinity], grey ? 0.16 : 0.22, 0.5);
  strokeBuckets(cloud.edges, [12, 24, Infinity], grey ? 0.22 : 0.3, 0.5);

  // Dots (dust + web particles) bucketed by final alpha. Dots smaller than a
  // device pixel are drawn as one pixel with area-scaled alpha so brightness
  // is consistent across levels of detail.
  const LEVELS = 10;
  const bx = Array.from({ length: LEVELS }, () => []);
  const push = (x, y, size, a) => {
    const spx = size * scale;
    let s = size;
    if (spx < 1) {
      // Partly area-scaled: zoomed-out clouds stay crisp and bright like the reference overview.
      a *= spx;
      s = unit;
    }
    if (a < 0.004) return;
    const b = Math.min(LEVELS - 1, Math.floor(Math.sqrt(a) * LEVELS));
    bx[b].push(x - s / 2, y - s / 2, s);
  };
  const dust = cloud.dust;
  const dustSize = 1.0;
  const dustGain = grey ? 0.85 : 1;
  for (let i = 0; i < dust.length; i += 3) push(dust[i], dust[i + 1], dustSize, dust[i + 2] * dustGain);
  const pGain = grey ? 0.8 : 1;
  for (let i = 0; i < cloud.n; i++) {
    if (cloud.isStar[i]) continue;
    push(px[i * 2], px[i * 2 + 1], cloud.size[i], cloud.alpha[i] * pGain);
  }
  bx.forEach((list, b) => {
    if (!list.length) return;
    const a = ((b + 0.5) / LEVELS) ** 2;
    g.fillStyle = withAlpha(color, Math.min(1, a));
    for (let k = 0; k < list.length; k += 3) g.fillRect(list[k], list[k + 1], list[k + 2], list[k + 2]);
  });
  return { canvas, scale, minX, minY, w, h };
}

/** Ensure a cluster's bitmaps for one level of detail exist at the right scale. */
function ensureLevel(cloud, color, lod, dpr, stats) {
  const { minX, minY, maxX, maxY } = cloud.extent;
  const side = Math.max(maxX - minX, maxY - minY);
  const want = Math.min((lod === 'hi' ? HI_SCALE : LO_SCALE) * dpr, MAX_SIDE / side);
  const cur = cloud.bitmaps[lod];
  if (cur && Math.abs(cur.scale - want) < 1e-6) return cur;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const level = {
    scale: want,
    color: renderCloud(cloud, color, want, false),
    // The grey variant is dim and soft: render it at a lower resolution.
    grey: renderCloud(cloud, QUEUED, lod === 'hi' ? want * 0.65 : want, true),
  };
  cloud.bitmaps[lod] = level;
  if (stats) {
    stats.bitmaps++;
    stats.bitmapMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }
  return level;
}

// ------------------------------------------------------------- drawWorld --

/**
 * Per-cluster visual levels eased toward the status targets over ~0.6 s of
 * run time. Snaps on the first frame, after a seek (time jumps) or restart.
 */
function updateLevels(world, run) {
  const n = world.clusters.length;
  const ship = run.phase === 'ship';
  let vis = world._vis;
  const fresh = !vis || vis.run !== run || vis.n !== n;
  const dt = fresh ? 0 : run.t - vis.t;
  const snap = fresh || dt < 0 || dt > 0.25;
  if (fresh) {
    vis = world._vis = { run, n, t: run.t, grey: new Float32Array(n), color: new Float32Array(n), glow: new Float32Array(n) };
  }
  const k = snap ? 1 : 1 - Math.exp(-dt / FADE_TAU);
  for (let i = 0; i < n; i++) {
    const st = run.status[i];
    let tg = 0;
    let tc = 0;
    let tw = 0;
    if (ship) {
      tc = SHIP_ALPHA;
      tw = 0.3;
    } else if (st === 'reading' || (i === run.active && run.phase !== 'boot' && st !== 'queued')) {
      tc = 1;
      tw = 1;
    } else if (st === 'done') {
      tc = DONE_ALPHA;
    } else {
      tg = 1;
    }
    vis.grey[i] += (tg - vis.grey[i]) * k;
    vis.color[i] += (tc - vis.color[i]) * k;
    vis.glow[i] += (tw - vis.glow[i]) * k;
  }
  vis.t = run.t;
  return vis;
}

/**
 * Draw one bitmap level (grey + colour) of a cluster. Mipmapped filtering
 * ('medium') only when the bitmap is noticeably downscaled, where plain
 * bilinear would shimmer; otherwise the cheaper 'low'.
 */
function blitLevel(ctx, c, level, greyA, colorA, need) {
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = level.scale > need * 1.25 ? 'medium' : 'low';
  if (greyA > 0.003) {
    const b = level.grey;
    ctx.globalAlpha = greyA;
    ctx.drawImage(b.canvas, c.cx + b.minX, c.cy + b.minY, b.w / b.scale, b.h / b.scale);
  }
  if (colorA > 0.003) {
    const b = level.color;
    ctx.globalAlpha = colorA;
    ctx.drawImage(b.canvas, c.cx + b.minX, c.cy + b.minY, b.w / b.scale, b.h / b.scale);
  }
}

/**
 * Draw the world (clusters, glow, stars, read word nodes) in world space.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').World} world
 * @param {import('../core/contracts.js').RunState} run
 * @param {import('../core/contracts.js').View} view
 * @param {import('../core/contracts.js').Analysis} analysis
 */
export function drawWorld(ctx, world, run, view, analysis) {
  const vis = updateLevels(world, run);
  const { camera, width, height } = view;
  const dpr = view.dpr || 1;
  const zoom = camera.zoom;
  const need = zoom * dpr;
  const time = view.time ?? run.t;
  const halfW = width / 2 / zoom;
  const halfH = height / 2 / zoom;
  const vx0 = camera.x - halfW;
  const vx1 = camera.x + halfW;
  const vy0 = camera.y - halfH;
  const vy1 = camera.y + halfH;

  ctx.save();
  applyWorldTransform(ctx, view);
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;

  // LOD crossfade: lo below ~1.4x its scale, hi above ~2.2x.
  const loScale = LO_SCALE * dpr;
  const hiMix = smoothstep(loScale * 1.25, loScale * 2.0, need);

  let budget = 1; // extra bitmap levels pre-warmed per frame
  const visible = new Uint8Array(world.clusters.length);
  for (const c of world.clusters) {
    const cloud = world._clouds[c.index];
    const e = cloud.extent;
    if (c.cx + e.maxX < vx0 || c.cx + e.minX > vx1 || c.cy + e.maxY < vy0 || c.cy + e.minY > vy1) {
      // Off-screen: warm a bitmap in the background, one per frame.
      if (budget > 0 && !cloud.bitmaps.hi) {
        ensureLevel(cloud, c.color, 'hi', dpr, world._stats);
        budget--;
      }
      continue;
    }
    visible[c.index] = 1;
    const i = c.index;
    const greyA = vis.grey[i] * QUEUED_ALPHA;
    const colorA = vis.color[i];

    // Glow behind the active cluster.
    const glow = vis.glow[i];
    if (glow > 0.01) {
      const R = c.r * 1.2;
      const grad = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, R);
      grad.addColorStop(0, withAlpha(c.color, 0.11 * glow));
      grad.addColorStop(0.5, withAlpha(c.color, 0.045 * glow));
      grad.addColorStop(1, withAlpha(c.color, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(c.cx - R, c.cy - R, R * 2, R * 2);
    }

    if (hiMix < 1) blitLevel(ctx, c, ensureLevel(cloud, c.color, 'lo', dpr, world._stats), greyA * (1 - hiMix), colorA * (1 - hiMix), need);
    if (hiMix > 0) blitLevel(ctx, c, ensureLevel(cloud, c.color, 'hi', dpr, world._stats), greyA * hiMix, colorA * hiMix, need);

    // Twinkling stars.
    const total = vis.grey[i] * QUEUED_ALPHA + colorA;
    if (total > 0.01) {
      const tint = colorA / (total || 1);
      ctx.fillStyle = tint >= 0.999 ? c.color : mix(QUEUED, c.color, tint);
      const minS = 1.6 / zoom;
      for (const s of cloud.stars) {
        const tw = view.reducedMotion ? 0.8 : 0.6 + 0.4 * Math.sin(time * s.speed + s.phase);
        ctx.globalAlpha = Math.min(1, s.a * tw * Math.min(1, total * 1.25));
        const sz = Math.max(s.s, minS);
        ctx.fillRect(c.cx + s.x - sz / 2, c.cy + s.y - sz / 2, sz, sz);
      }
    }
  }

  // Read word nodes: small bright squares (vague ones pink), with a quick pop.
  const words = analysis.words;
  const pos = world.wordPos;
  const base = Math.max(NODE_SIZE, 2.6 / zoom);
  const t = run.t;
  for (const sec of analysis.sections) {
    if (!visible[sec.index]) continue;
    const color = sec.color || world.clusters[sec.index].color;
    for (let pass = 0; pass < 2; pass++) {
      // pass 0: soft halo, pass 1: the square itself
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      let lastVague = false;
      for (let id = sec.start, end = sec.start + sec.count; id < end; id++) {
        if (run.wordState[id] !== 2) continue;
        const vague = words[id].vague;
        if (vague !== lastVague) {
          ctx.fillStyle = vague ? FLAG : color;
          lastVague = vague;
        }
        const age = t - run.readAt[id];
        const pop = age >= 0 && age < 0.35 ? 1 + 1.4 * (1 - age / 0.35) * (1 - age / 0.35) : 1;
        const x = pos[id * 2];
        const y = pos[id * 2 + 1];
        if (x < vx0 - 20 || x > vx1 + 20 || y < vy0 - 20 || y > vy1 + 20) continue;
        if (pass === 0) {
          const s = base * 2.1 * pop;
          ctx.globalAlpha = 0.13;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        } else {
          const s = base * pop;
          ctx.globalAlpha = 1;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
    }
  }

  ctx.restore();
}
