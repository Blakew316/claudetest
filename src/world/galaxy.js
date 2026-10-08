/**
 * Procedural star clusters. The crawl uses makeBall: a volumetric ball of
 * stardust like the reference footage, detailed at every scale (core,
 * lumps and rim lobes, voids and dust lanes, cosmic-web filaments, curling
 * tendrils, rim shells, sub-clusters, knots, micro-dust, wispy haze).
 * makeGalaxy (spiral, barred, ring...) is kept for other looks. Pure data.
 */

import { gauss, range } from '../core/rng.js';

export const MORPHS = ['spiral', 'nebula', 'barred', 'elliptical', 'ring', 'spiral', 'lenticular', 'barred', 'nebula', 'ring', 'elliptical', 'spiral'];

const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Random orthonormal frame: e1, e2 span the disc, n is its normal. */
function frame(rand) {
  const n = norm([gauss(rand), gauss(rand) * 1.4, gauss(rand)]);
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm([ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]]);
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return { e1, e2, n };
}

/**
 * Build one galaxy around the origin.
 * @param {() => number} rand
 * @param {string} morph one of MORPHS
 * @param {number} r radius
 * @param {number} count particle count
 * @returns {{pos: Float32Array, bright: Float32Array, hot: Float32Array, frame: {e1:number[], e2:number[], n:number[]}}}
 */
export function makeGalaxy(rand, morph, r, count) {
  const pts = [];
  const push = (u, v, w, b, h) => pts.push([u, v, w, b, h]);
  const arms = Math.floor(range(rand, 2, 4.99));
  const twist = range(rand, 3.2, 5.6) * (rand() < 0.5 ? -1 : 1);
  const bulge = (n, s, b = 0.95) => {
    for (let i = 0; i < n; i++) {
      const u = gauss(rand) * s;
      const v = gauss(rand) * s * 0.75;
      const w = gauss(rand) * s;
      const d = Math.hypot(u, v, w) / s;
      push(u, v, w, b * (0.55 + 0.45 * Math.exp(-d * d)) , Math.exp(-d * d * 0.6));
    }
  };
  const halo = (n, s) => {
    for (let i = 0; i < n; i++) push(gauss(rand) * s, gauss(rand) * s * 0.7, gauss(rand) * s, range(rand, 0.12, 0.3), 0.05);
  };
  const armPoints = (n, t0, startAngle) => {
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rand() * arms);
      const t = t0 + (1 - t0) * rand() ** 0.7;
      const rr = r * 0.95 * t;
      const ang = startAngle + (k * Math.PI * 2) / arms + twist * t + gauss(rand) * 0.2 * (1 - 0.5 * t);
      const across = gauss(rand) * r * 0.045;
      const u = Math.cos(ang) * rr - Math.sin(ang) * across;
      const w = Math.sin(ang) * rr + Math.cos(ang) * across;
      push(u, gauss(rand) * r * 0.03 * (1 - 0.5 * t), w, range(rand, 0.4, 0.85) * (1 - 0.35 * t), 0.15 * (1 - t));
    }
  };
  const disc = (n, scale, thick) => {
    for (let i = 0; i < n; i++) {
      const rr = Math.min(r, -Math.log(1 - rand() * 0.98) * r * scale);
      const ang = rand() * Math.PI * 2;
      push(Math.cos(ang) * rr, gauss(rand) * r * thick, Math.sin(ang) * rr, range(rand, 0.25, 0.6) * (1 - 0.4 * (rr / r)), 0.1 * Math.exp(-rr / (r * 0.2)));
    }
  };

  const n = count;
  if (morph === 'spiral') {
    bulge(n * 0.15, r * 0.12);
    armPoints(n * 0.58, 0.08, 0);
    disc(n * 0.16, 0.32, 0.025);
    halo(n * 0.04, r * 0.45);
  } else if (morph === 'barred') {
    const bar = n * 0.2;
    for (let i = 0; i < bar; i++) {
      const u = range(rand, -0.34, 0.34) * r;
      push(u, gauss(rand) * r * 0.03, gauss(rand) * r * 0.05, range(rand, 0.55, 0.95), 0.5 * Math.exp(-((u / (r * 0.2)) ** 2)));
    }
    bulge(n * 0.1, r * 0.1);
    armPoints(n * 0.5, 0.34, 0);
    disc(n * 0.14, 0.3, 0.025);
    halo(n * 0.04, r * 0.45);
  } else if (morph === 'elliptical') {
    const ax = [1, range(rand, 0.6, 0.85), range(rand, 0.45, 0.7)];
    for (let i = 0; i < n * 0.94; i++) {
      const tight = rand() < 0.3;
      const s = r * (tight ? 0.12 : 0.36);
      const u = gauss(rand) * s * ax[0];
      const v = gauss(rand) * s * ax[2];
      const w = gauss(rand) * s * ax[1];
      const d = Math.hypot(u, v, w) / (r * 0.3);
      push(u, v, w, range(rand, 0.3, 0.75) * (0.5 + 0.5 * Math.exp(-d * d)), Math.exp(-d * d * 1.5) * 0.9);
    }
    halo(n * 0.06, r * 0.5);
  } else if (morph === 'ring') {
    const R0 = r * range(rand, 0.55, 0.7);
    for (let i = 0; i < n * 0.6; i++) {
      const ang = rand() * Math.PI * 2;
      const rr = R0 + gauss(rand) * r * 0.06 + Math.sin(ang * 3) * r * 0.03;
      push(Math.cos(ang) * rr, gauss(rand) * r * 0.035, Math.sin(ang) * rr, range(rand, 0.45, 0.9), 0.12);
    }
    bulge(n * 0.14, r * 0.09);
    disc(n * 0.2, 0.22, 0.02);
    halo(n * 0.06, r * 0.45);
  } else if (morph === 'lenticular') {
    bulge(n * 0.28, r * 0.14);
    disc(n * 0.66, 0.24, 0.04);
    halo(n * 0.06, r * 0.45);
  } else {
    // Nebula: a warped, filamentary cloud.
    const f1 = range(rand, 1.5, 3) / r;
    const f2 = range(rand, 1.5, 3) / r;
    const ph = [rand() * 6, rand() * 6, rand() * 6];
    for (let i = 0; i < n * 0.96; i++) {
      let u;
      let v;
      let w;
      if (i % 5 === 0) {
        const strand = i % 7;
        const t = rand() * 2 - 1;
        u = t * r * 0.7;
        v = Math.sin(t * 2.2 + strand * 1.3) * r * 0.32 + gauss(rand) * r * 0.02;
        w = Math.cos(t * 1.7 + strand * 2.1) * r * 0.26 + gauss(rand) * r * 0.02;
      } else {
        u = gauss(rand) * r * 0.42;
        v = gauss(rand) * r * 0.3;
        w = gauss(rand) * r * 0.36;
      }
      u += Math.sin(v * f1 + ph[0]) * r * 0.16;
      v += Math.sin(w * f2 + u * f1 + ph[1]) * r * 0.12;
      w += Math.sin(u * f2 + ph[2]) * r * 0.1;
      const d = Math.hypot(u, v, w) / r;
      push(u, v, w, range(rand, 0.3, 0.75) * (0.5 + 0.5 * Math.exp(-d * d * 3)), 0.25 * Math.exp(-d * d * 4));
    }
    halo(n * 0.04, r * 0.5);
  }

  // Star-forming knots: tight bright clumps scattered through the structure.
  if (morph !== 'elliptical') {
    const base = pts.length;
    const knots = Math.round(range(rand, 18, 32));
    for (let k = 0; k < knots; k++) {
      const c = pts[Math.floor(rand() * base)];
      const m = Math.round(range(rand, 30, 80));
      for (let i = 0; i < m; i++) push(c[0] + gauss(rand) * r * 0.022, c[1] + gauss(rand) * r * 0.015, c[2] + gauss(rand) * r * 0.022, range(rand, 0.6, 1), 0.45);
    }
  }
  // A sprinkling of bright stars.
  for (const p of pts) if (rand() < 0.018) p[3] = 1.6;

  const f = frame(rand);
  const N = pts.length;
  const pos = new Float32Array(N * 3);
  const bright = new Float32Array(N);
  const hot = new Float32Array(N);
  pts.forEach(([u, v, w, b, h], i) => {
    pos[i * 3] = f.e1[0] * u + f.n[0] * v + f.e2[0] * w;
    pos[i * 3 + 1] = f.e1[1] * u + f.n[1] * v + f.e2[1] * w;
    pos[i * 3 + 2] = f.e1[2] * u + f.n[2] * v + f.e2[2] * w;
    bright[i] = b;
    hot[i] = Math.min(1, h);
  });
  return { pos, bright, hot, frame: f };
}

const TAU = Math.PI * 2;
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Uniform random unit vector. */
function unit(rand) {
  const u = rand() * 2 - 1;
  const th = rand() * TAU;
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(th), u, s * Math.sin(th)];
}

/** A unit vector perpendicular to unit n. */
function perp(n) {
  return norm(cross3(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
}

/** Rotate v about unit axis k by angle a (Rodrigues). */
function rotate(v, k, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross3(k, v);
  const kd = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/**
 * A smooth random field of unit variance: a handful of plane waves with
 * random directions, wavelengths and phases (a cheap spectral noise). Its
 * level sets are organic, curved sheets; two of them cross in filaments.
 */
function waves(rand, n, kmin, kmax) {
  const k = new Float64Array(n * 4);
  for (let j = 0; j < n; j++) {
    const d = unit(rand);
    const m = range(rand, kmin, kmax);
    k[j * 4] = d[0] * m;
    k[j * 4 + 1] = d[1] * m;
    k[j * 4 + 2] = d[2] * m;
    k[j * 4 + 3] = rand() * TAU;
  }
  const a = Math.sqrt(2 / n);
  const m = n * 4;
  /** Field value at (x, y, z). */
  const field = (x, y, z) => {
    let s = 0;
    for (let j = 0; j < m; j += 4) s += Math.sin(k[j] * x + k[j + 1] * y + k[j + 2] * z + k[j + 3]);
    return s * a;
  };
  /** Field value, with its gradient written into g. */
  field.grad = (x, y, z, g) => {
    let s = 0;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    for (let j = 0; j < m; j += 4) {
      const th = k[j] * x + k[j + 1] * y + k[j + 2] * z + k[j + 3];
      const c = Math.cos(th);
      s += Math.sin(th);
      gx += c * k[j];
      gy += c * k[j + 1];
      gz += c * k[j + 2];
    }
    g[0] = gx * a;
    g[1] = gy * a;
    g[2] = gz * a;
    return s * a;
  };
  return field;
}

/** Growable star buffer (position, brightness, heat) that avoids a JS object per star. */
function starBuffer(cap, rand) {
  let pos = new Float32Array(cap * 3);
  let bright = new Float32Array(cap);
  let hot = new Float32Array(cap);
  let n = 0;
  return {
    get n() {
      return n;
    },
    /** Add a star; `sparkle` is the chance it becomes one of the few big bright stars. */
    push(x, y, z, b, h, sparkle = 0) {
      if (n === cap) {
        cap = Math.ceil(cap * 1.4) + 64;
        const p2 = new Float32Array(cap * 3);
        p2.set(pos);
        pos = p2;
        const b2 = new Float32Array(cap);
        b2.set(bright);
        bright = b2;
        const h2 = new Float32Array(cap);
        h2.set(hot);
        hot = h2;
      }
      pos[n * 3] = x;
      pos[n * 3 + 1] = y;
      pos[n * 3 + 2] = z;
      bright[n] = sparkle && rand() < sparkle ? 1.6 : b;
      hot[n] = h > 1 ? 1 : h;
      n++;
    },
    at(i) {
      return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    },
    done() {
      return { pos: pos.slice(0, n * 3), bright: bright.slice(0, n), hot: hot.slice(0, n) };
    },
  };
}

/** Ball archetypes: each section's ball leans one way while staying a ball. */
export const BALL_KINDS = ['lumpy', 'filamentary', 'cored', 'balanced'];

/**
 * Per ball kind: the share of its stars in each structure, then the shape
 * ranges. core: dense, slightly hotter nucleus (Plummer scale coreA, in r).
 * body: overlapping lumps (spread apart by `spread`) plus lobes at the rim,
 * textured by `clump` and carved by voids and dark lanes. web: cosmic-web
 * filaments. tendril: curling arms spiralling out of the core. shell: faint
 * arcs at the rim. sub: globular sub-clusters. knot: tight bright clumps.
 * dust: very faint micro-dust between structures. haze: thin outer wisps.
 */
const CHARACTER = {
  lumpy: {
    core: 0.05, body: 0.54, web: 0.07, tendril: 0.06, shell: 0.025, sub: 0.08, knot: 0.025, dust: 0.08, haze: 0.04,
    lumps: [5, 8], spread: 0.34, lobes: [10, 16], lobeW: 1.3, clump: 0.6, coreA: [0.1, 0.13],
    tendrils: [3, 5], filaments: [10, 15], voids: [3, 5], lanes: [1, 2], shells: [1, 2],
  },
  filamentary: {
    core: 0.06, body: 0.37, web: 0.14, tendril: 0.19, shell: 0.03, sub: 0.06, knot: 0.03, dust: 0.08, haze: 0.04,
    lumps: [2, 4], spread: 0.22, lobes: [4, 8], lobeW: 0.8, clump: 0.45, coreA: [0.1, 0.13],
    tendrils: [6, 9], filaments: [22, 32], voids: [2, 4], lanes: [1, 3], shells: [1, 3],
  },
  cored: {
    core: 0.1, body: 0.46, web: 0.08, tendril: 0.1, shell: 0.035, sub: 0.06, knot: 0.025, dust: 0.08, haze: 0.04,
    lumps: [3, 5], spread: 0.2, lobes: [5, 9], lobeW: 0.9, clump: 0.42, coreA: [0.12, 0.16],
    tendrils: [4, 7], filaments: [12, 18], voids: [2, 3], lanes: [1, 2], shells: [2, 3],
  },
  balanced: {
    core: 0.07, body: 0.47, web: 0.1, tendril: 0.11, shell: 0.03, sub: 0.07, knot: 0.025, dust: 0.08, haze: 0.04,
    lumps: [3, 6], spread: 0.28, lobes: [6, 11], lobeW: 1, clump: 0.5, coreA: [0.11, 0.14],
    tendrils: [4, 7], filaments: [15, 22], voids: [2, 4], lanes: [1, 2], shells: [1, 3],
  },
};
const PARTS = ['core', 'body', 'web', 'tendril', 'shell', 'sub', 'knot', 'dust', 'haze'];

/**
 * A clustered ball of stars with structure at every scale: a denser, hotter
 * core; overlapping lumps and rim lobes carved by dark voids and dust lanes;
 * cosmic-web filaments; curling tendrils spiralling out of the core; faint
 * shells at the rim; varied globular sub-clusters and bright knots; very
 * faint micro-dust between it all; and a thin outer haze. A noise warp makes
 * the boundary wispy. Each ball leans one way (lumpy, filamentary, cored or
 * balanced, from opts.kind or the seed) but always reads as a ball.
 * @param {() => number} rand
 * @param {number} r radius
 * @param {number} count particle count (the ball holds about this many stars)
 * @param {{kind?: string}} [opts]
 * @returns {{pos: Float32Array, bright: Float32Array, hot: Float32Array, frame: {e1:number[], e2:number[], n:number[]}}}
 */
export function makeBall(rand, r, count, opts = {}) {
  const drawn = BALL_KINDS[Math.floor(rand() * BALL_KINDS.length)];
  const C = CHARACTER[opts.kind] || CHARACTER[drawn];
  const pick = ([a, b]) => Math.round(range(rand, a, b));
  // Star budget per structure, jittered per ball, normalised to the count.
  const share = PARTS.map((p) => C[p] * range(rand, 0.8, 1.2));
  const total = share.reduce((s, v) => s + v, 0);
  const B = {};
  PARTS.forEach((p, i) => (B[p] = Math.round((count * share[i]) / total)));
  const out = starBuffer(Math.ceil(count * 1.03) + 64, rand);
  const dir = [0, 0, 0];
  const randDir = () => {
    const u = rand() * 2 - 1;
    const th = rand() * TAU;
    const s = Math.sqrt(1 - u * u);
    dir[0] = s * Math.cos(th);
    dir[1] = u;
    dir[2] = s * Math.sin(th);
    return dir;
  };

  // Domain warp: two broad octaves bend the ball, a fine one frays its edges.
  const f = [range(rand, 1.6, 2.8) / r, range(rand, 1.6, 2.8) / r, range(rand, 1.6, 2.8) / r];
  const ph = [rand() * 6, rand() * 6, rand() * 6, rand() * 6, rand() * 6, rand() * 6];
  const fine = range(rand, 5.5, 8) / r;
  const W = [0, 0, 0];
  const warp = (x, y, z) => {
    W[0] = x + Math.sin(y * f[0] + ph[0]) * r * 0.11 + Math.sin(z * f[1] * 2.1 + ph[1]) * r * 0.04 + Math.sin((y + z) * fine + ph[3]) * r * 0.016;
    W[1] = y + Math.sin(z * f[1] + x * f[0] * 0.5 + ph[1]) * r * 0.09 + Math.sin((z - x) * fine + ph[4]) * r * 0.016;
    W[2] = z + Math.sin(x * f[2] + ph[2]) * r * 0.1 + Math.sin(y * f[2] * 2.3) * r * 0.035 + Math.sin((x + y) * fine + ph[5]) * r * 0.016;
    return W;
  };

  // Internal shape: dark voids and curved dust lanes carved out of the body (pre-warp space).
  const coreA = r * range(rand, C.coreA[0], C.coreA[1]);
  const voids = [];
  for (let k = pick(C.voids); k > 0; k--) {
    // Big enough to read through the ball's depth; the outer ones bite bays into its outline.
    const vr = r * range(rand, 0.14, 0.3);
    const d = unit(rand);
    const dist = Math.max(coreA * 2.5 + vr, r * range(rand, 0.38, 0.85));
    voids.push([d[0] * dist, d[1] * dist, d[2] * dist, vr, vr * vr * 1.44]);
  }
  const lanes = [];
  for (let k = pick(C.lanes); k > 0; k--) {
    const n = unit(rand);
    const e1 = perp(n);
    lanes.push({ n, e1, e2: cross3(n, e1), R: r * range(rand, 0.32, 0.66), w: r * range(rand, 0.035, 0.065), a0: rand() * TAU, span: range(rand, 1.4, 2.8) });
  }
  /** Does structure survive at this (pre-warp) point? Voids and lanes are nearly empty, with ragged edges. */
  const keep = (x, y, z) => {
    for (const v of voids) {
      const dx = x - v[0];
      const dy = y - v[1];
      const dz = z - v[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > v[4]) continue;
      if (d2 < v[3] * v[3] * (0.64 + 0.8 * rand())) return rand() < 0.04;
    }
    for (const l of lanes) {
      const h = x * l.n[0] + y * l.n[1] + z * l.n[2];
      const px = x * l.e1[0] + y * l.e1[1] + z * l.e1[2];
      const py = x * l.e2[0] + y * l.e2[1] + z * l.e2[2];
      const rel = (Math.atan2(py, px) - l.a0 + TAU * 2) % TAU;
      if (rel > l.span) continue;
      const wv = l.w * Math.sin((Math.PI * rel) / l.span);
      const dr = Math.sqrt(px * px + py * py) - l.R;
      if (dr * dr + h * h < wv * wv * (0.56 + 0.8 * rand())) return rand() < 0.06;
    }
    return true;
  };
  const tex = waves(rand, 6, 9 / r, 16 / r); // mid-scale clumps and gaps
  const grain = waves(rand, 5, 24 / r, 38 / r); // fine clumpiness
  const webA = waves(rand, 10, 5 / r, 13 / r); // cosmic web: level sets...
  const webB = waves(rand, 10, 5 / r, 13 / r); // ...crossing in filaments

  // Core: a Plummer sphere, denser and a little hotter, never a blob.
  const csq = [range(rand, 0.8, 1.15), range(rand, 0.72, 1), range(rand, 0.8, 1.15)];
  for (let i = 0; i < B.core; i++) {
    let s = 1 / Math.sqrt(Math.max(1e-4, rand() ** (-2 / 3) - 1));
    if (s > 2.8) s = 2.8 * Math.sqrt(rand());
    const d = randDir();
    const p = warp(d[0] * s * coreA * csq[0], d[1] * s * coreA * csq[1], d[2] * s * coreA * csq[2]);
    out.push(p[0], p[1], p[2], range(rand, 0.48, 0.86) * (0.8 + 0.2 * Math.exp(-s * s)), 0.32 * Math.exp(-s * s * 0.5), 0.02);
  }

  // Body: overlapping lumps plus smaller lobes bulging at the rim (the cauliflower outline).
  const lumps = [];
  let wsum = 0;
  const L = pick(C.lumps);
  for (let k = 0; k < L; k++) {
    const w = range(rand, 0.6, 1.4);
    wsum += w;
    lumps.push({ c: k === 0 ? [0, 0, 0] : [gauss(rand) * r * C.spread, gauss(rand) * r * C.spread * 0.85, gauss(rand) * r * C.spread], rad: r * range(rand, 0.42, 0.66), w, sq: [range(rand, 0.8, 1.15), range(rand, 0.75, 1.05), range(rand, 0.8, 1.15)], k: 0.62 });
  }
  for (let k = pick(C.lobes); k > 0; k--) {
    const w = range(rand, 0.05, 0.12) * C.lobeW;
    wsum += w;
    const d = unit(rand);
    const dist = r * range(rand, 0.5, 0.8);
    lumps.push({ c: [d[0] * dist, d[1] * dist * 0.9, d[2] * dist], rad: r * range(rand, 0.12, 0.26), w, sq: [1, range(rand, 0.8, 1.1), 1], k: 0.8 });
  }
  for (let made = 0, tries = 0; made < B.body && tries < B.body * 14; tries++) {
    let pk = rand() * wsum;
    let lump = lumps[0];
    for (const l of lumps) {
      pk -= l.w;
      if (pk <= 0) {
        lump = l;
        break;
      }
    }
    const d = randDir();
    const rr = lump.rad * rand() ** lump.k;
    const x = lump.c[0] + d[0] * rr * lump.sq[0];
    const y = lump.c[1] + d[1] * rr * lump.sq[1];
    const z = lump.c[2] + d[2] * rr * lump.sq[2];
    if (!keep(x, y, z)) continue;
    const t = tex(x, y, z);
    if (rand() > 0.55 + C.clump * t + 0.2 * grain(x, y, z)) continue;
    const p = warp(x, y, z);
    const dd2 = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / (r * r);
    if (dd2 > 1.3225) continue;
    out.push(p[0], p[1], p[2], range(rand, 0.32, 0.78) * (0.7 + 0.3 * Math.exp(-dd2 * 2)) * Math.max(0.6, 0.9 + 0.1 * t), 0.15 * Math.exp(-dd2 * 5), 0.018);
    made++;
  }

  // Cosmic web: fine filaments traced along the curves where two smooth
  // fields both cross zero (organic curves that meet and part), then dusted
  // with beaded chains of stars. Where they cross a void they break off at its rim.
  const G = [0, 0, 0];
  const H = [0, 0, 0];
  const project = (q, F) => {
    const v = F.grad(q[0], q[1], q[2], G);
    const g2 = G[0] * G[0] + G[1] * G[1] + G[2] * G[2] + 1e-12;
    q[0] -= (v * G[0]) / g2;
    q[1] -= (v * G[1]) / g2;
    q[2] -= (v * G[2]) / g2;
    return v;
  };
  const lines = [];
  // A mid-scale wiggle shared by all filaments (crossings stay joined) so none runs straight.
  const wf = [range(rand, 8, 13) / r, range(rand, 8, 13) / r, range(rand, 8, 13) / r];
  const wp = [rand() * TAU, rand() * TAU, rand() * TAU];
  const wa = r * 0.03;
  const lim2 = (r * 0.96) ** 2;
  const step = r * 0.024;
  for (let s = 0, guard = 0, want = pick(C.filaments); s < want && guard < want * 5; guard++) {
    const d = unit(rand);
    const rr = r * 0.85 * rand() ** 0.5;
    const q = [d[0] * rr, d[1] * rr, d[2] * rr];
    let va = 1;
    let vb = 1;
    for (let it = 0; it < 5; it++) {
      va = project(q, webA);
      vb = project(q, webB);
    }
    if (Math.abs(va) > 0.05 || Math.abs(vb) > 0.05 || q[0] * q[0] + q[1] * q[1] + q[2] * q[2] > lim2) continue;
    s++;
    const halves = [];
    for (const sgn of [1, -1]) {
      const p = [q[0], q[1], q[2]];
      const half = [];
      let tx = 0;
      let ty = 0;
      let tz = 0;
      for (let n = 0; n < 36; n++) {
        webA.grad(p[0], p[1], p[2], G);
        webB.grad(p[0], p[1], p[2], H);
        let cx = G[1] * H[2] - G[2] * H[1];
        let cy = G[2] * H[0] - G[0] * H[2];
        let cz = G[0] * H[1] - G[1] * H[0];
        const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        cx /= cl;
        cy /= cl;
        cz /= cl;
        if (n === 0 ? sgn < 0 : cx * tx + cy * ty + cz * tz < 0) {
          cx = -cx;
          cy = -cy;
          cz = -cz;
        }
        tx = cx;
        ty = cy;
        tz = cz;
        p[0] += tx * step;
        p[1] += ty * step;
        p[2] += tz * step;
        project(p, webA);
        project(p, webB);
        if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] > lim2) break;
        half.push(p[0], p[1], p[2]);
      }
      halves.push(half);
    }
    const line = [];
    for (let k = halves[0].length - 3; k >= 0; k -= 3) line.push(halves[0][k], halves[0][k + 1], halves[0][k + 2]);
    line.push(q[0], q[1], q[2], ...halves[1]);
    for (let k = 0; k < line.length; k += 3) {
      const [x, y, z] = [line[k], line[k + 1], line[k + 2]];
      line[k] = x + Math.sin(y * wf[0] + wp[0]) * wa;
      line[k + 1] = y + Math.sin(z * wf[1] + wp[1]) * wa;
      line[k + 2] = z + Math.sin(x * wf[2] + wp[2]) * wa;
    }
    if (line.length >= 12) lines.push({ pts: line, bead: range(rand, 0.6, 1.6) / (r * 0.05), bph: rand() * TAU, w: r * range(rand, 0.005, 0.011) });
  }
  const segs = lines.reduce((s, l) => s + l.pts.length / 3 - 1, 0);
  for (let made = 0, tries = 0; segs && made < B.web && tries < B.web * 6; tries++) {
    // Pick a segment uniformly over all filaments (segments are equal length).
    let k = Math.floor(rand() * segs);
    let l = lines[0];
    for (const cand of lines) {
      l = cand;
      if (k < cand.pts.length / 3 - 1) break;
      k -= cand.pts.length / 3 - 1;
    }
    const u = rand();
    const along = (k + u) * step;
    const bead = 0.5 + 0.5 * Math.sin(along * l.bead + l.bph);
    if (rand() > 0.25 + 0.75 * bead) continue;
    const sheath = rand() < 0.3;
    const th = l.w * (sheath ? 3 : 1);
    const a = k * 3;
    const x = l.pts[a] + (l.pts[a + 3] - l.pts[a]) * u + gauss(rand) * th;
    const y = l.pts[a + 1] + (l.pts[a + 4] - l.pts[a + 1]) * u + gauss(rand) * th;
    const z = l.pts[a + 2] + (l.pts[a + 5] - l.pts[a + 2]) * u + gauss(rand) * th;
    if (!keep(x, y, z)) continue;
    const p = warp(x, y, z);
    const dd2 = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / (r * r);
    if (sheath) out.push(p[0], p[1], p[2], range(rand, 0.2, 0.42), 0.02);
    else out.push(p[0], p[1], p[2], range(rand, 0.4, 0.8) * (0.72 + 0.28 * Math.exp(-dd2 * 2)), 0.07, 0.016);
    made++;
  }

  // Tendrils: curling arms spiralling out of the core, beaded, some branching.
  const tendrils = [];
  const tpoint = (T, t) => {
    const dv = rotate(T.d0, T.ax, T.curl * t);
    const s = T.len * t;
    const lift = T.len * T.lift * t * t;
    return { p: [T.o[0] + dv[0] * s + T.ax[0] * lift, T.o[1] + dv[1] * s + T.ax[1] * lift, T.o[2] + dv[2] * s + T.ax[2] * lift], dv };
  };
  for (let k = pick(C.tendrils); k > 0; k--) {
    const d0 = unit(rand);
    const T = { o: [d0[0] * coreA * 0.6, d0[1] * coreA * 0.6, d0[2] * coreA * 0.6], d0, ax: norm(cross3(d0, unit(rand))), curl: range(rand, 1.4, 3) * (rand() < 0.5 ? -1 : 1), len: r * range(rand, 0.7, 1), lift: range(rand, -0.25, 0.25), w0: r * range(rand, 0.016, 0.03), bead: range(rand, 4, 11), bph: rand() * TAU, wt: range(rand, 0.7, 1.3), t0: 0 };
    tendrils.push(T);
    if (rand() < 0.6) {
      const tb = range(rand, 0.3, 0.6);
      const at = tpoint(T, tb);
      const bd = norm([at.dv[0] + gauss(rand) * 0.6, at.dv[1] + gauss(rand) * 0.6, at.dv[2] + gauss(rand) * 0.6]);
      tendrils.push({ o: at.p, d0: bd, ax: norm(cross3(bd, unit(rand))), curl: range(rand, 0.6, 1.6) * (rand() < 0.5 ? -1 : 1), len: T.len * range(rand, 0.3, 0.5), lift: range(rand, -0.3, 0.3), w0: T.w0 * 0.7, bead: range(rand, 4, 9), bph: rand() * TAU, wt: T.wt * 0.35, t0: tb });
    }
  }
  const tw = tendrils.reduce((s, T) => s + T.wt, 0);
  for (const T of tendrils) {
    const m = Math.round((B.tendril * T.wt) / tw);
    for (let made = 0, tries = 0; made < m && tries < m * 8; tries++) {
      const t = rand() ** 0.85;
      const bead = 0.5 + 0.5 * Math.sin(t * T.bead * TAU + T.bph);
      if (rand() > 0.3 + 0.7 * bead * bead) continue;
      const { p } = tpoint(T, t);
      const sheath = rand() < 0.28;
      const th = T.w0 * (1 - 0.5 * t) * (sheath ? 2.6 : 1);
      const q = warp(p[0] + gauss(rand) * th, p[1] + gauss(rand) * th, p[2] + gauss(rand) * th);
      if (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] > r * r * 1.39) continue;
      const fade = 1 - 0.3 * Math.min(1, T.t0 + t * (1 - T.t0));
      if (sheath) out.push(q[0], q[1], q[2], range(rand, 0.24, 0.5) * fade, 0.03);
      else out.push(q[0], q[1], q[2], range(rand, 0.48, 0.9) * fade, 0.17 * (1 - t), 0.022);
      made++;
    }
  }

  // Shells: faint partial arcs at the rim, like the edge of a blown bubble.
  const shells = [];
  for (let k = pick(C.shells); k > 0; k--) {
    const c = unit(rand);
    const e1 = perp(c);
    shells.push({ c, e1, e2: cross3(c, e1), alpha: range(rand, 0.4, 0.85), R: r * range(rand, 0.84, 1.02), th: r * range(rand, 0.008, 0.018), off: r * range(rand, 0.04, 0.12), rip: Math.round(range(rand, 3, 7)), amp: r * range(rand, 0.015, 0.04), wt: range(rand, 0.6, 1.4) });
  }
  const sw = shells.reduce((s, S) => s + S.wt, 0);
  for (const S of shells) {
    const m = Math.round((B.shell * S.wt) / sw);
    const ca = Math.cos(S.alpha);
    for (let made = 0, tries = 0; made < m && tries < m * 6; tries++) {
      const cth = 1 - rand() * (1 - ca);
      const th = Math.acos(cth);
      const q = th / S.alpha;
      if (rand() < q * q * q) continue; // thin out toward the arc's edge
      const sth = Math.sin(th);
      const phi = rand() * TAU;
      const rad = S.R + Math.sin(phi * S.rip + th * 7) * S.amp + gauss(rand) * S.th;
      const ux = S.c[0] * cth + sth * (Math.cos(phi) * S.e1[0] + Math.sin(phi) * S.e2[0]);
      const uy = S.c[1] * cth + sth * (Math.cos(phi) * S.e1[1] + Math.sin(phi) * S.e2[1]);
      const uz = S.c[2] * cth + sth * (Math.cos(phi) * S.e1[2] + Math.sin(phi) * S.e2[2]);
      const p = warp(ux * rad - S.c[0] * S.off, uy * rad - S.c[1] * S.off, uz * rad - S.c[2] * S.off);
      out.push(p[0], p[1], p[2], range(rand, 0.2, 0.46) * (1 - 0.6 * q * q), 0.04);
      made++;
    }
  }

  // Globular sub-clusters, each a different kind: tight globular, loose open, stretched, or a pair.
  const subs = [];
  const ns = Math.max(3, Math.round(range(rand, 7, 13) * Math.min(1, Math.sqrt(count / 20000))));
  const inVoid = (x, y, z) => voids.some((v) => (x - v[0]) ** 2 + (y - v[1]) ** 2 + (z - v[2]) ** 2 < v[3] * v[3] * 1.2);
  for (let k = 0; k < ns; k++) {
    let d = unit(rand);
    let rr = r * range(rand, 0.18, 0.85);
    // They sit on the structure, not floating alone inside a void.
    for (let tries = 0; tries < 8 && inVoid(d[0] * rr, d[1] * rr * 0.85, d[2] * rr); tries++) {
      d = unit(rand);
      rr = r * range(rand, 0.18, 0.85);
    }
    const c = warp(d[0] * rr, d[1] * rr * 0.85, d[2] * rr);
    const roll = rand();
    subs.push({ c: [c[0], c[1], c[2]], sr: r * range(rand, 0.03, 0.085), type: roll < 0.45 ? 'globular' : roll < 0.65 ? 'open' : roll < 0.87 ? 'stretched' : 'pair', axis: unit(rand), stretch: range(rand, 1.8, 3), wt: range(rand, 0.5, 1.5) });
  }
  const subW = subs.reduce((s, S) => s + S.wt, 0);
  for (const S of subs) {
    const m = Math.round((B.sub * S.wt) / subW);
    const twin = S.type === 'pair' ? [S.axis[0] * S.sr * 1.6, S.axis[1] * S.sr * 1.6, S.axis[2] * S.sr * 1.6] : null;
    for (let i = 0; i < m; i++) {
      let x;
      let y;
      let z;
      let b;
      let h;
      if (S.type === 'open') {
        // Loose: few, bright, scattered stars.
        if (i % 2) continue;
        const d = randDir();
        const rr = S.sr * 1.5 * Math.cbrt(rand());
        x = d[0] * rr;
        y = d[1] * rr;
        z = d[2] * rr;
        b = range(rand, 0.6, 1);
        h = 0.2;
      } else {
        let s = 1 / Math.sqrt(Math.max(1e-4, rand() ** (-2 / 3) - 1));
        if (s > 3) s = 3 * Math.sqrt(rand());
        const a = S.sr * 0.5;
        const d = randDir();
        x = d[0] * s * a;
        y = d[1] * s * a;
        z = d[2] * s * a;
        if (S.type === 'stretched') {
          const along = (x * S.axis[0] + y * S.axis[1] + z * S.axis[2]) * (S.stretch - 1);
          x += S.axis[0] * along;
          y += S.axis[1] * along;
          z += S.axis[2] * along;
        } else if (twin && i % 3 === 0) {
          x = x * 0.7 + twin[0];
          y = y * 0.7 + twin[1];
          z = z * 0.7 + twin[2];
        }
        b = range(rand, 0.46, 0.9);
        h = 0.3 * Math.exp(-s * s * 0.8);
      }
      out.push(S.c[0] + x, S.c[1] + y, S.c[2] + z, b, h, 0.02);
    }
  }

  // Bright knots seeded on the structure built so far.
  const base = out.n;
  const K = Math.max(4, Math.round(B.knot / 38));
  for (let k = 0; k < K; k++) {
    const c = out.at(Math.floor(rand() * base));
    const m = Math.round((B.knot / K) * range(rand, 0.6, 1.4));
    const kr = r * range(rand, 0.01, 0.022);
    for (let i = 0; i < m; i++) out.push(c[0] + gauss(rand) * kr, c[1] + gauss(rand) * kr, c[2] + gauss(rand) * kr, range(rand, 0.6, 1), 0.3, 0.02);
  }

  // Micro-dust: very faint stardust filling the space between the structures.
  for (let made = 0, tries = 0; made < B.dust && tries < B.dust * 4; tries++) {
    const d = randDir();
    const rr = r * 1.08 * Math.cbrt(rand());
    if (!keep(d[0] * rr, d[1] * rr, d[2] * rr)) continue;
    const p = warp(d[0] * rr, d[1] * rr, d[2] * rr);
    out.push(p[0], p[1], p[2], range(rand, 0.04, 0.16), 0);
    made++;
  }

  // Thin outer haze of wisps.
  for (let i = 0; i < B.haze; i++) {
    const d = randDir();
    const rr = r * range(rand, 0.8, 1.3);
    const p = warp(d[0] * rr, d[1] * rr * 0.9, d[2] * rr);
    out.push(p[0], p[1], p[2], range(rand, 0.12, 0.3), 0);
  }

  return { ...out.done(), frame: frame(rand) };
}
