/**
 * Procedural star clusters. The crawl uses makeBall: a volumetric ball of
 * stardust like the reference footage, detailed at every scale (core,
 * lumps and rim lobes, voids and dust lanes, cosmic-web filaments, curling
 * tendrils, rim shells, sub-clusters, knots, micro-dust, wispy haze), down
 * to hierarchical star families, binaries and short star chains up close,
 * with gas and dust worked into it (dark rifts, pillars and globules with lit
 * rims, ionization fronts, reflection-dust wisps, a frayed dusty edge).
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

/**
 * Hierarchical clumping (a Soneira-Peebles cascade): a sphere of radius R
 * holds a few spheres `lambda` times smaller placed at random inside it, each
 * of those holds its own, and so on down `levels` levels, with a star in each
 * innermost one. Clumps within clumps within clumps, so every zoom level finds
 * new structure; few children per level (eta ~2) make it stringy, more make it
 * bushy. emit(dx, dy, dz, q) gets each star's offset and q, its distance from
 * the centre in units of R, and returns how many stars it added.
 */
function cascade(rand, R, levels, eta, lambda, emit) {
  let n = 0;
  const go = (x, y, z, rad, lv) => {
    if (lv === levels) {
      n += emit(x, y, z, Math.sqrt(x * x + y * y + z * z) / R);
      return;
    }
    const cr = rad / lambda;
    for (let k = eta - 1 + Math.floor(rand() * 3); k > 0; k--) {
      const d = unit(rand);
      const s = (rad - cr) * Math.cbrt(rand());
      go(x + d[0] * s, y + d[1] * s, z + d[2] * s, cr, lv + 1);
    }
  };
  go(0, 0, 0, R, 0);
  return n;
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
    /** Drop every star for which gone(x, y, z) is true, keeping the rest in order; returns how many went. */
    carve(gone) {
      let m = 0;
      for (let i = 0; i < n; i++) {
        if (gone(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) continue;
        pos[m * 3] = pos[i * 3];
        pos[m * 3 + 1] = pos[i * 3 + 1];
        pos[m * 3 + 2] = pos[i * 3 + 2];
        bright[m] = bright[i];
        hot[m] = hot[i];
        m++;
      }
      const cut = n - m;
      n = m;
      return cut;
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
 * Gas and dust (a budget of their own, as a share of the count): front:
 * ionization fronts on void walls and rift faces; trunk: lit skins and dusty
 * columns of the pillars and globules; wisp: reflection-dust striations;
 * fray: streamers at the edge. Then how many pillars (trunks), dark globules,
 * dark rifts through the core and wisp bundles.
 */
const CHARACTER = {
  lumpy: {
    core: 0.05, body: 0.54, web: 0.07, tendril: 0.06, shell: 0.025, sub: 0.08, knot: 0.025, dust: 0.08, haze: 0.04,
    lumps: [5, 8], spread: 0.34, lobes: [10, 16], lobeW: 1.3, clump: 0.6, coreA: [0.1, 0.13],
    tendrils: [3, 5], filaments: [10, 15], voids: [3, 5], lanes: [1, 2], shells: [1, 2],
    front: 0.045, trunk: 0.12, wisp: 0.045, fray: 0.02, fronts: [2, 3], trunks: [2, 4], globules: [7, 11], rifts: [1, 2], wisps: [3, 5],
  },
  filamentary: {
    core: 0.06, body: 0.37, web: 0.14, tendril: 0.19, shell: 0.03, sub: 0.06, knot: 0.03, dust: 0.08, haze: 0.04,
    lumps: [2, 4], spread: 0.22, lobes: [4, 8], lobeW: 0.8, clump: 0.45, coreA: [0.1, 0.13],
    tendrils: [6, 9], filaments: [22, 32], voids: [2, 4], lanes: [1, 3], shells: [1, 3],
    front: 0.035, trunk: 0.08, wisp: 0.07, fray: 0.025, fronts: [1, 2], trunks: [1, 3], globules: [4, 8], rifts: [1, 2], wisps: [4, 7],
  },
  cored: {
    core: 0.1, body: 0.46, web: 0.08, tendril: 0.1, shell: 0.035, sub: 0.06, knot: 0.025, dust: 0.08, haze: 0.04,
    lumps: [3, 5], spread: 0.2, lobes: [5, 9], lobeW: 0.9, clump: 0.42, coreA: [0.12, 0.16],
    tendrils: [4, 7], filaments: [12, 18], voids: [2, 3], lanes: [1, 2], shells: [2, 3],
    front: 0.045, trunk: 0.1, wisp: 0.045, fray: 0.02, fronts: [1, 3], trunks: [2, 3], globules: [5, 9], rifts: [1, 3], wisps: [3, 5],
  },
  balanced: {
    core: 0.07, body: 0.47, web: 0.1, tendril: 0.11, shell: 0.03, sub: 0.07, knot: 0.025, dust: 0.08, haze: 0.04,
    lumps: [3, 6], spread: 0.28, lobes: [6, 11], lobeW: 1, clump: 0.5, coreA: [0.11, 0.14],
    tendrils: [4, 7], filaments: [15, 22], voids: [2, 4], lanes: [1, 2], shells: [1, 3],
    front: 0.04, trunk: 0.1, wisp: 0.055, fray: 0.02, fronts: [1, 2], trunks: [2, 3], globules: [5, 9], rifts: [1, 3], wisps: [3, 6],
  },
};
const PARTS = ['core', 'body', 'web', 'tendril', 'shell', 'sub', 'knot', 'dust', 'haze'];
const GAS = ['front', 'trunk', 'wisp', 'fray'];

/**
 * A clustered ball of stars with structure at every scale: a denser, hotter
 * core; overlapping lumps and rim lobes carved by dark voids and dust lanes;
 * cosmic-web filaments; curling tendrils spiralling out of the core; faint
 * shells at the rim; varied sub-clusters, bright knots and short star
 * chains; very faint micro-dust between it all; and a thin outer haze. Up
 * close the stars clump within clumps (star families, a grainy body),
 * come in binaries and triples, and are mass-segregated: giants sink to
 * the core and the halo is left to faint stars. A noise warp makes
 * the boundary wispy. Then gas and dust: dark rifts, pillars and globules
 * carved out with lit rims, ionization fronts, reflection-dust wisps and a
 * frayed, notched edge. Each ball leans one way (lumpy, filamentary, cored or
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

  // Mass segregation: the massive stars have sunk toward the middle, so the
  // chance of a giant (and of a binary) falls with radius (dd2, squared, in
  // units of r) and the halo is left to the faint ones.
  const giant = (dd2, base) => base * (0.3 + 2.4 * Math.exp(-dd2 * 4));
  const binary = (dd2, base) => base * (0.5 + 1.5 * Math.exp(-dd2 * 3));
  // Binary and multiple stars: with chance pb a fainter, cooler companion a few
  // units off, and now and then a third, wider one (a hierarchical triple).
  // Unresolved from afar; close up the stars come in pairs. Returns stars added.
  const sep = r * 0.0045;
  const star = (x, y, z, b, h, sparkle, pb) => {
    out.push(x, y, z, b, h, sparkle);
    if (!(rand() < pb)) return 1;
    const m = rand() < 0.22 ? 3 : 2;
    for (let k = 1; k < m; k++) {
      const d = randDir();
      const s = sep * (k === 1 ? 0.6 + 1.8 * rand() ** 2 : range(rand, 3.5, 6));
      out.push(x + d[0] * s, y + d[1] * s, z + d[2] * s, b * range(rand, 0.3, 0.8), h * 0.4);
    }
    return m;
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

  // Core: a Plummer sphere, denser and a little hotter, never a blob: its
  // light comes from resolved giants sunk to the middle and close multiples.
  const csq = [range(rand, 0.8, 1.15), range(rand, 0.72, 1), range(rand, 0.8, 1.15)];
  for (let made = 0; made < B.core; ) {
    let s = 1 / Math.sqrt(Math.max(1e-4, rand() ** (-2 / 3) - 1));
    if (s > 2.8) s = 2.8 * Math.sqrt(rand());
    const d = randDir();
    const p = warp(d[0] * s * coreA * csq[0], d[1] * s * coreA * csq[1], d[2] * s * coreA * csq[2]);
    const e = Math.exp(-s * s);
    made += star(p[0], p[1], p[2], range(rand, 0.42, 0.82) * (0.8 + 0.2 * e), 0.32 * Math.exp(-s * s * 0.5), 0.02 * (0.4 + 1.6 * e), 0.1 + 0.08 * e);
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
  /** A warped point of the body (lumps and lobes, carved and textured) into P, or false where rejected. */
  const P = [0, 0, 0, 0, 0];
  const bodyPoint = () => {
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
    if (!keep(x, y, z)) return false;
    const t = tex(x, y, z);
    if (rand() > 0.55 + C.clump * t + 0.2 * grain(x, y, z)) return false;
    const p = warp(x, y, z);
    const dd2 = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / (r * r);
    if (dd2 > 1.3225) return false;
    P[0] = p[0];
    P[1] = p[1];
    P[2] = p[2];
    P[3] = dd2;
    P[4] = t;
    return true;
  };
  // Part of the body is built as star families (below); the rest stays smooth
  // so the lumps still read, but grainy: now and then a few stars hop on from
  // the last by power-law steps (a short Levy flight), so even between the
  // families the stars gather in loose knots and strings at every scale.
  const famN = Math.round(B.body * (0.3 + 0.3 * C.clump));
  for (let made = 0, tries = 0, hop = 0; made < B.body - famN && tries < B.body * 14; tries++) {
    if (hop > 0) {
      hop--;
      const d = randDir();
      const s = r * 0.005 * Math.min(10, rand() ** -0.7);
      P[0] += d[0] * s;
      P[1] += d[1] * s;
      P[2] += d[2] * s;
    } else if (bodyPoint()) {
      hop = rand() < 0.3 ? 1 + Math.floor(rand() * 4) : 0;
    } else continue;
    const dd2 = P[3];
    made += star(P[0], P[1], P[2], range(rand, 0.32, 0.78) * (0.7 + 0.3 * Math.exp(-dd2 * 2)) * Math.max(0.6, 0.9 + 0.1 * P[4]), 0.15 * Math.exp(-dd2 * 5), giant(dd2, 0.018), binary(dd2, 0.06));
  }
  // Star families: hierarchical clumps (clumps of clumps of a few stars) strewn
  // through the lumps like young associations, stringy or bushy. Sizes follow
  // a power law (many small, few large) and bigger ones hold more levels, so
  // the clumping looks alike at every scale. Brighter, hotter and richer in
  // giants toward each family's heart.
  for (let made = 0, tries = 0; made < famN && tries < famN; tries++) {
    if (!bodyPoint()) continue;
    const [cx, cy, cz, dd2] = P;
    const R = r * 0.022 * (1 + 3.4 * rand() ** 2.2);
    const levels = R < r * 0.04 ? 2 : R < r * 0.07 ? 3 : 4;
    const eta = rand() < 0.35 ? 2 : levels < 4 && rand() < 0.4 ? 4 : 3;
    const bf = range(rand, 0.85, 1.15) * (0.75 + 0.25 * Math.exp(-dd2 * 2));
    made += cascade(rand, R, levels, eta, range(rand, 2.1, 2.9), (dx, dy, dz, q) => {
      const e = Math.exp(-q * q * 4);
      return star(cx + dx, cy + dy, cz + dz, range(rand, 0.3, 0.74) * bf * (0.8 + 0.2 * e), 0.06 + 0.16 * e, giant(dd2, 0.016) * (0.6 + 1.0 * e), binary(dd2, 0.08));
    });
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

  // Sub-clusters, each a different kind: tight globular, loose open, stretched,
  // a pair, a young fractal swarm, a trapezium (a few brilliant stars in a
  // faint swarm) or a globular trailing tidal tails.
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
    const type = roll < 0.26 ? 'globular' : roll < 0.38 ? 'open' : roll < 0.5 ? 'stretched' : roll < 0.58 ? 'pair' : roll < 0.74 ? 'fractal' : roll < 0.86 ? 'trapezium' : 'tidal';
    // Richer ones are bigger (a mass-radius relation), so none packs into a smudge.
    const wt = range(rand, 0.5, 1.5);
    subs.push({ c: [c[0], c[1], c[2]], sr: r * range(rand, 0.034, 0.075) * Math.cbrt(wt), type, axis: unit(rand), stretch: range(rand, 1.8, 3), wt, rt: range(rand, 2.2, 3.4) });
  }
  const subW = subs.reduce((s, S) => s + S.wt, 0);
  for (const S of subs) {
    const m = Math.round((B.sub * S.wt) / subW);
    const [cx, cy, cz] = S.c;
    if (S.type === 'fractal') {
      // Young and still clumpy: a few hierarchical swarms of hot stars, not yet mixed into a ball.
      for (let made = 0, g = 0; made < m && g < 8; g++) {
        const ox = cx + (g ? gauss(rand) * S.sr * 0.7 : 0);
        const oy = cy + (g ? gauss(rand) * S.sr * 0.7 : 0);
        const oz = cz + (g ? gauss(rand) * S.sr * 0.7 : 0);
        made += cascade(rand, S.sr * range(rand, 1, 1.6), 3, 3 + (g & 1), range(rand, 2.2, 2.6), (dx, dy, dz, q) =>
          star(ox + dx, oy + dy, oz + dz, range(rand, 0.4, 0.86) * (0.8 + 0.2 * Math.exp(-q * q * 4)), 0.34 * Math.exp(-q * q * 3), 0.05 * Math.exp(-q * q * 3), 0.12),
        );
      }
      continue;
    }
    let made = 0;
    if (S.type === 'trapezium') {
      // The few brilliant hot stars at its heart, each still resolved, wide enough apart to never merge.
      for (let k = 4 + Math.floor(rand() * 4); k > 0; k--, made++) {
        const d = randDir();
        const s = S.sr * range(rand, 0.12, 0.42);
        out.push(cx + d[0] * s, cy + d[1] * s, cz + d[2] * s, range(rand, 0.86, 1), 0.7, 0.5);
      }
    }
    const twin = S.type === 'pair' ? [S.axis[0] * S.sr * 1.6, S.axis[1] * S.sr * 1.6, S.axis[2] * S.sr * 1.6] : null;
    const side = S.type === 'tidal' ? perp(S.axis) : null;
    for (let i = 0; made < m; i++) {
      let x;
      let y;
      let z;
      let b;
      let h;
      let sp = 0.02;
      let pb = 0.12;
      if (S.type === 'open') {
        // Loose: few, bright, scattered stars, rich in wide doubles.
        if (i % 2) {
          made++;
          continue;
        }
        const d = randDir();
        const rr = S.sr * 1.5 * Math.cbrt(rand());
        x = d[0] * rr;
        y = d[1] * rr;
        z = d[2] * rr;
        b = range(rand, 0.6, 1);
        h = 0.2;
        pb = 0.25;
      } else if (side && i % 3 === 0) {
        // Tidal tails: a leading and a trailing stream curling away, fading and thinning outward.
        const t = rand();
        const sg = i % 2 ? 1 : -1;
        const L = S.sr * S.stretch * 2.2;
        const along = sg * (S.sr * 0.5 + t * L);
        const bend = sg * Math.sin(t * Math.PI * 0.8) * L * 0.32;
        const j = S.sr * 0.1 * (1 - 0.5 * t);
        x = S.axis[0] * along + side[0] * bend + gauss(rand) * j;
        y = S.axis[1] * along + side[1] * bend + gauss(rand) * j;
        z = S.axis[2] * along + side[2] * bend + gauss(rand) * j;
        b = range(rand, 0.3, 0.66) * (1 - 0.45 * t);
        h = 0.06;
        sp = 0;
        pb = 0.06;
      } else {
        // Plummer, cut at a tidal radius for a crisp edge. Mass-segregated:
        // each star's scale shrinks with its mass, so the few giants and
        // the binaries sit at the centre among resolved stars while the faint
        // ones spread out (the middle never piles up into a blob).
        const mass = rand();
        let s = 1 / Math.sqrt(Math.max(1e-4, rand() ** (-2 / 3) - 1));
        if (s > S.rt) s = S.rt * Math.sqrt(rand());
        const a = S.sr * (S.type === 'trapezium' ? 0.85 : 0.78 - 0.4 * mass);
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
        const e = Math.exp(-s * s);
        if (S.type === 'trapezium') {
          // The swarm around the trapezium: faint, young, sparse.
          b = range(rand, 0.22, 0.5);
          h = 0.12;
          sp = 0.004;
        } else {
          b = range(rand, 0.3, 0.52) + 0.38 * mass;
          h = 0.3 * mass * Math.exp(-s * s * 0.5);
          sp = mass > 0.95 ? 0.45 : 0;
        }
        pb = (0.08 + 0.12 * e) * (0.5 + mass);
      }
      made += star(cx + x, cy + y, cz + z, b, h, sp, pb);
    }
  }

  // Bright knots seeded on the structure built so far: tight little
  // hierarchies (a few sub-knots of a few stars), so close up each one
  // resolves into its stars instead of a glowing smudge.
  const base = out.n;
  const knotN = Math.round(B.knot * 0.62);
  for (let made = 0; made < knotN; ) {
    const c = out.at(Math.floor(rand() * base));
    const kr = r * range(rand, 0.02, 0.045);
    made += cascade(rand, kr, 3, 3, range(rand, 2.2, 2.7), (dx, dy, dz, q) => {
      const e = Math.exp(-q * q * 4);
      return star(c[0] + dx, c[1] + dy, c[2] + dz, range(rand, 0.5, 0.95), 0.3 * (0.4 + 0.6 * e), 0.04 * e, 0.12);
    });
  }
  // Star chains: short, gently curving strings of a few similar stars (the
  // asterisms an eye picks out), seeded on the structure; spaced to resolve close up.
  for (let k = Math.max(3, Math.round((B.knot - knotN) / 5.5)); k > 0; k--) {
    const c = out.at(Math.floor(rand() * base));
    let d = unit(rand);
    const ax = perp(d);
    const bend = range(rand, -0.35, 0.35);
    const gap = r * range(rand, 0.007, 0.016);
    const b0 = range(rand, 0.5, 0.85);
    for (let i = 3 + Math.floor(rand() * 5); i > 0; i--) {
      out.push(c[0], c[1], c[2], b0 * range(rand, 0.8, 1.15), 0.12, 0.03);
      d = rotate(d, ax, bend * range(rand, 0.4, 1.6));
      const g = gap * range(rand, 0.75, 1.25);
      c[0] += d[0] * g;
      c[1] += d[1] * g;
      c[2] += d[2] * g;
    }
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

  // Gas and dust, made of the same fine points and drawn last, so everything
  // above keeps its random draws. Dark clouds (rifts through the core, pillars
  // pointing at it, small globules, notches in the outline) are carved crisply
  // out of all the stars above, and their skins facing the core are lit as thin
  // bright rims, as are the inner walls of a few voids (ionization fronts).
  // Light here is additive and cannot be absorbed, so the dark reads where it
  // cuts the compact core and between limb-brightened rims. Faint reflection-
  // dust wisps thread the body and fibrous streamers fray its edge. Own budget.
  const gas = {};
  for (const p of GAS) gas[p] = Math.round(count * C[p] * range(rand, 0.8, 1.2));
  const few = Math.min(1, Math.sqrt(count / 20000)); // small balls get fewer features, not smaller ones
  let placed = out.n;
  /** A star already placed between radii lo and hi (in r), or null: dust sits on the structure. */
  const onStructure = (lo, hi) => {
    for (let t = 0; t < 40; t++) {
      const p = out.at(Math.floor(rand() * placed));
      const d2 = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / (r * r);
      if (d2 >= lo * lo && d2 <= hi * hi) return p;
    }
    return null;
  };

  // Rifts: thin, buckled dark sheets radiating from the core, like the Trifid's
  // lanes. Seen anywhere near edge-on, one splits the core with a crisp band.
  const rifts = [];
  for (let k = pick(C.rifts); k > 0; k--) {
    const n = unit(rand);
    const e1 = rotate(perp(n), n, rand() * TAU);
    rifts.push({
      o: [gauss(rand) * coreA * 0.3, gauss(rand) * coreA * 0.3, gauss(rand) * coreA * 0.3],
      n, e1, e2: cross3(n, e1),
      a0: -r * range(rand, 0.04, 0.2), a1: r * range(rand, 0.75, 1.1), wb: r * range(rand, 0.55, 0.95),
      t: r * range(rand, 0.026, 0.042), bend: r * range(rand, 0.02, 0.06), fb: range(rand, 3, 6) / r,
      k1: range(rand, 16, 30) / r, k2: range(rand, 9, 18) / r, ph: [rand() * TAU, rand() * TAU, rand() * TAU],
    });
    const R = rifts[rifts.length - 1];
    R.slab = R.bend * 1.6 + R.t * 1.4 * 1.48;
  }
  /** A rift's mid-surface offset (it buckles) and half-thickness (widening outward, edges wavering) at in-plane (a, b). */
  const riftMid = (R, a, b) => R.bend * (Math.sin(a * R.fb + R.ph[0]) + 0.6 * Math.sin(b * R.fb * 0.8 + R.ph[1]));
  const riftHalf = (R, a, b) => R.t * (0.6 + 0.8 * ((a - R.a0) / (R.a1 - R.a0))) * (1 + 0.3 * Math.sin(a * R.k1 + b * R.k2 * 0.4 + R.ph[1]) + 0.18 * Math.sin(b * R.k1 * 0.7 + R.ph[2]));
  const inRift = (R, x, y, z) => {
    const dx = x - R.o[0];
    const dy = y - R.o[1];
    const dz = z - R.o[2];
    const h0 = dx * R.n[0] + dy * R.n[1] + dz * R.n[2];
    if (h0 > R.slab || h0 < -R.slab) return false; // nowhere near the sheet (most stars)
    const a = dx * R.e1[0] + dy * R.e1[1] + dz * R.e1[2];
    if (a < R.a0 || a > R.a1) return false;
    const b = dx * R.e2[0] + dy * R.e2[1] + dz * R.e2[2];
    if (Math.abs(b) > R.wb * (0.75 + 0.25 * Math.sin(a * R.k2 + R.ph[2]))) return false;
    const h = h0 - riftMid(R, a, b);
    const t = riftHalf(R, a, b);
    return h * h < t * t;
  };

  // Dust clouds, each a lobed head with a tapering (or widening) tail, its
  // inside carved out and a bow cleared in front of its head: pillars rooted
  // past the rim and pointing at the core (elephant trunks, their columns
  // filled with dusty stars, small evaporating nubs on their heads), dark
  // globules, round or cometary with tails streaming away from the core, and
  // one or two bites into the core, where the light is compact enough to show
  // them dark from any side.
  const trunks = [];
  const trunk = (h, ax, len, rh, re, bendAmt, wt, clear = 1, fill = 0) => {
    const n1 = rotate(perp(ax), ax, rand() * TAU);
    const n2 = cross3(ax, n1);
    const bs = gauss(rand) * bendAmt;
    const bt = gauss(rand) * bendAmt;
    const reach = len * 0.5 + Math.max(rh * clear, re) * 1.3 + Math.hypot(bs, bt);
    const T = {
      h, ax, len, rh, re, n1, n2, wt, clear, fill,
      bend: [n1[0] * bs + n2[0] * bt, n1[1] * bs + n2[1] * bt, n1[2] * bs + n2[2] * bt],
      lit: norm([-h[0], -h[1], -h[2]]), // toward the core, the light that rims it
      m1: 2 + Math.floor(rand() * 3), m2: 5 + Math.floor(rand() * 4), a1: range(rand, 0.07, 0.15), a2: range(rand, 0.03, 0.08), p1: rand() * TAU, p2: rand() * TAU,
      bc: [h[0] + ax[0] * len * 0.5, h[1] + ax[1] * len * 0.5, h[2] + ax[2] * len * 0.5], br2: reach * reach,
    };
    trunks.push(T);
    return T;
  };
  /** A dust cloud's radius at fraction s along it and angle phi around it: lobed and fluted, so its edge is crisp but never smooth. */
  const skin = (T, s, phi) => (T.rh + (T.re - T.rh) * s ** 0.8) * (1 + T.a1 * Math.sin(T.m1 * phi + 5 * s + T.p1) + T.a2 * Math.sin(T.m2 * phi - 13 * s + T.p2));
  const inTrunk = (T, x, y, z) => {
    const dx = x - T.h[0];
    const dy = y - T.h[1];
    const dz = z - T.h[2];
    const along = dx * T.ax[0] + dy * T.ax[1] + dz * T.ax[2];
    // In front of the head (s = 0) this is the distance from its centre: a rounded cap.
    const s = T.len > 0 ? Math.max(0, along / T.len) : 0;
    if (s > 1) return false;
    const sl = s * T.len;
    const s2 = s * s;
    const px = dx - T.ax[0] * sl - T.bend[0] * s2;
    const py = dy - T.ax[1] * sl - T.bend[1] * s2;
    const pz = dz - T.ax[2] * sl - T.bend[2] * s2;
    const q2 = px * px + py * py + pz * pz;
    let rad = skin(T, s, Math.atan2(px * T.n2[0] + py * T.n2[1] + pz * T.n2[2], px * T.n1[0] + py * T.n1[1] + pz * T.n1[2]));
    // The bow cleared ahead of the head: widest straight toward the core, closing in at the sides.
    if (along < 0 && T.clear > 1) rad *= 1 + ((T.clear - 1) * -along) / Math.sqrt(q2 + 1e-9);
    return q2 < rad * rad;
  };
  for (let k = Math.max(1, Math.round(pick(C.trunks) * few)); k > 0; k--) {
    const at = onStructure(0.65, 0.98);
    const d = at ? norm(at) : unit(rand);
    const hr = r * range(rand, 0.4, 0.58);
    const h = [d[0] * hr + gauss(rand) * r * 0.03, d[1] * hr + gauss(rand) * r * 0.03, d[2] * hr + gauss(rand) * r * 0.03];
    const ax = norm([d[0] + gauss(rand) * 0.15, d[1] + gauss(rand) * 0.15, d[2] + gauss(rand) * 0.15]);
    const rh = r * range(rand, 0.038, 0.055);
    trunk(h, ax, r * 1.1 - hr, rh, rh * range(rand, 1.3, 1.8), r * 0.035, 1, 2.4, 0.45);
    // Evaporating nubs on the head, each with a newborn star inside.
    for (let e = Math.round(range(rand, 0.6, 3.4)); e > 0; e--) {
      const u = norm([-ax[0] + gauss(rand) * 0.5, -ax[1] + gauss(rand) * 0.5, -ax[2] + gauss(rand) * 0.5]);
      if (u[0] * ax[0] + u[1] * ax[1] + u[2] * ax[2] > -0.2) continue;
      const er = rh * range(rand, 0.2, 0.34);
      const c = [h[0] + u[0] * rh * 0.92, h[1] + u[1] * rh * 0.92, h[2] + u[2] * rh * 0.92];
      trunk(c, norm([-u[0], -u[1], -u[2]]), rh * range(rand, 0.4, 1), er, er * 0.85, 0, 0.04).star = true;
    }
  }
  for (let k = Math.max(1, Math.round(pick(C.globules) * few)); k > 0; k--) {
    const at = onStructure(0.22, 0.82);
    if (!at) continue;
    const R = r * range(rand, 0.024, 0.05);
    const q = norm(at);
    const away = norm([q[0] + gauss(rand) * 0.3, q[1] + gauss(rand) * 0.3, q[2] + gauss(rand) * 0.3]);
    if (rand() < 0.45) trunk(at, away, R * range(rand, 1.5, 3.2), R, R * range(rand, 0.25, 0.5), R * 0.3, 0.16, 1.7);
    else trunk(at, away, 0, R, R, 0, 0.11, 1.5);
  }
  for (let k = rand() < 0.7 ? 1 : 2; k > 0; k--) {
    const d = unit(rand);
    const cd = coreA * range(rand, 1, 1.7);
    trunk([d[0] * cd, d[1] * cd, d[2] * cd], d, 0, coreA * range(rand, 0.4, 0.6), coreA * 0.5, 0, 0.25);
  }

  // Notches: narrow dark wedges bitten into the outline, opening outward.
  const notches = [];
  for (let k = Math.round(range(rand, 8, 14) * few); k > 0; k--) {
    const at = onStructure(0.72, 1);
    if (!at) continue;
    const q = Math.hypot(at[0], at[1], at[2]);
    notches.push({ d: [at[0] / q, at[1] / q, at[2] / q], ra: q * range(rand, 0.84, 0.96), w: range(rand, 0.03, 0.075) });
  }
  /** Is this point inside dark gas? */
  const notchR2 = notches.reduce((m, N) => Math.min(m, N.ra * N.ra), Infinity);
  // The dust clouds' bounding spheres (flat), bucketed in a coarse grid so each star tests only the few near it.
  const tb = new Float64Array(trunks.length * 4);
  const GN = 10;
  const cellAt = (v) => Math.min(GN - 1, Math.max(0, Math.floor(((v + r * 1.3) * GN) / (r * 2.6))));
  const grid = Array.from({ length: GN * GN * GN }, () => []);
  trunks.forEach((T, i) => {
    tb.set([...T.bc, T.br2], i * 4);
    const R = Math.sqrt(T.br2);
    for (let a = cellAt(T.bc[0] - R); a <= cellAt(T.bc[0] + R); a++) {
      for (let b = cellAt(T.bc[1] - R); b <= cellAt(T.bc[1] + R); b++) {
        for (let c = cellAt(T.bc[2] - R); c <= cellAt(T.bc[2] + R); c++) grid[a + GN * (b + GN * c)].push(i);
      }
    }
  });
  const dark = (x, y, z) => {
    const q2 = x * x + y * y + z * z;
    if (q2 > notchR2) {
      const q = Math.sqrt(q2);
      for (let i = 0; i < notches.length; i++) {
        const N = notches[i];
        if (q < N.ra) continue;
        const c = (x * N.d[0] + y * N.d[1] + z * N.d[2]) / q;
        const open = N.w * Math.min(1, (q - N.ra) / (r * 0.18));
        if (c > 0.9 && 1 - c * c < open * open) return true;
      }
    }
    for (let i = 0; i < rifts.length; i++) if (inRift(rifts[i], x, y, z)) return true;
    const near = grid[cellAt(x) + GN * (cellAt(y) + GN * cellAt(z))];
    for (let k = 0; k < near.length; k++) {
      const i = near[k] * 4;
      const dx = x - tb[i];
      const dy = y - tb[i + 1];
      const dz = z - tb[i + 2];
      if (dx * dx + dy * dy + dz * dz < tb[i + 3] && inTrunk(trunks[near[k]], x, y, z)) return true;
    }
    return false;
  };
  // A few stray stars survive inside, as if in front of the dust.
  out.carve((x, y, z) => dark(x, y, z) && rand() > 0.025);
  placed = out.n;

  // Lit skins: a crisp, thin rim where each cloud faces the core (its head
  // brightest, hot and white) and a fainter layer peeling off it; a pillar's
  // column is filled with dimmer dusty stars, thickest just under its skin so
  // its edges read crisply from any side.
  const tw2 = trunks.reduce((s, T) => s + T.wt, 0);
  for (const T of trunks) {
    const m = Math.round((gas.trunk * T.wt) / tw2);
    const cap = T.len > 0 ? 0.42 : 1;
    for (let made = 0, tries = 0; made < m && tries < m * 8; tries++) {
      const phi = rand() * TAU;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const rx = cp * T.n1[0] + sp * T.n2[0];
      const ry = cp * T.n1[1] + sp * T.n2[1];
      const rz = cp * T.n1[2] + sp * T.n2[2];
      const body = rand() < T.fill;
      let s = 0;
      let ox = T.h[0];
      let oy = T.h[1];
      let oz = T.h[2];
      let nx = rx;
      let ny = ry;
      let nz = rz;
      if (!body && rand() < cap) {
        // The head: a hemisphere facing the core (the whole sphere for a round globule).
        const ct = T.len > 0 ? rand() : rand() * 2 - 1;
        const st = Math.sqrt(1 - ct * ct);
        nx = -T.ax[0] * ct + rx * st;
        ny = -T.ax[1] * ct + ry * st;
        nz = -T.ax[2] * ct + rz * st;
      } else {
        s = body ? rand() : rand() ** 1.5;
        const sl = s * T.len;
        const s2 = s * s;
        ox += T.ax[0] * sl + T.bend[0] * s2;
        oy += T.ax[1] * sl + T.bend[1] * s2;
        oz += T.ax[2] * sl + T.bend[2] * s2;
      }
      // Wrapped light: the side facing the core squarely is brightest, the far side unlit.
      const lit = Math.min(1, Math.max(0, (nx * T.lit[0] + ny * T.lit[1] + nz * T.lit[2] + 0.4) / 1.4));
      if (body ? rand() < 0.6 * s : rand() > 0.1 + 0.9 * lit) continue; // a column dissolves toward its root
      const rad = skin(T, s, phi);
      const peel = !body && rand() < 0.12 && lit > 0.5;
      const off = body ? -rad * Math.min(0.95, Math.abs(gauss(rand)) * 0.14) : (peel ? rad * (0.2 + Math.abs(gauss(rand)) * 0.6) : rad * Math.abs(gauss(rand)) * 0.04) + r * 0.0015;
      const x = ox + nx * (rad + off);
      const y = oy + ny * (rad + off);
      const z = oz + nz * (rad + off);
      // A pillar fades where it runs out past the edge of the ball.
      const d = Math.sqrt(x * x + y * y + z * z) / r;
      if (rand() > (1.08 - d) / 0.25) continue;
      if (body) out.push(x, y, z, range(rand, 0.16, 0.42) * (0.45 + 0.55 * lit), 0.04);
      else if (peel) out.push(x, y, z, range(rand, 0.14, 0.3) * (0.4 + 0.6 * lit), 0.08);
      else out.push(x, y, z, range(rand, 0.45, 0.92) * (0.45 + 0.55 * lit), 0.2 + 0.35 * lit, 0.006);
      made++;
    }
    if (T.star) out.push(T.h[0] - T.ax[0] * T.rh * 0.3, T.h[1] - T.ax[1] * T.rh * 0.3, T.h[2] - T.ax[2] * T.rh * 0.3, 1.6, 0.5);
  }

  // Ionization fronts: thin, folded bright rims on the inner walls of a few
  // voids (the side toward the core, always within the body), so the cavity
  // gets a crisp lit edge that fades back into the body behind it.
  const rip = waves(rand, 6, 40 / r, 70 / r); // folds about a tenth of r apart
  const fronts = voids.slice(0, pick(C.fronts));
  const fw = fronts.reduce((s, v) => s + v[3] * v[3], 0);
  for (const v of fronts) {
    const m = Math.round((gas.front * 0.65 * v[3] * v[3]) / fw);
    const D = Math.hypot(v[0], v[1], v[2]) || 1;
    const c = [-v[0] / D, -v[1] / D, -v[2] / D];
    const e1 = perp(c);
    const e2 = cross3(c, e1);
    const alpha = range(rand, 0.6, 1);
    const ca = Math.cos(alpha);
    for (let made = 0, tries = 0; made < m && tries < m * 4; tries++) {
      const ct = 1 - rand() * (1 - ca);
      const q = Math.acos(ct) / alpha;
      if (rand() < q * q) continue; // brightest straight toward the core
      const st = Math.sqrt(1 - ct * ct);
      const phi = rand() * TAU;
      const ux = c[0] * ct + st * (Math.cos(phi) * e1[0] + Math.sin(phi) * e2[0]);
      const uy = c[1] * ct + st * (Math.cos(phi) * e1[1] + Math.sin(phi) * e2[1]);
      const uz = c[2] * ct + st * (Math.cos(phi) * e1[2] + Math.sin(phi) * e2[2]);
      const layer = rand() < 0.15;
      // Folded, so wherever the sheet turns edge-on it shows as a bright line.
      const rad = v[3] * (1 + 0.09 * rip(v[0] + ux * v[3], v[1] + uy * v[3], v[2] + uz * v[3]) + (layer ? 0.03 + Math.abs(gauss(rand)) * 0.1 : Math.abs(gauss(rand)) * 0.012));
      const p = warp(v[0] + ux * rad, v[1] + uy * rad, v[2] + uz * rad);
      if (dark(p[0], p[1], p[2])) continue;
      const edge = 1 - q * q;
      if (layer) out.push(p[0], p[1], p[2], range(rand, 0.16, 0.34) * edge, 0.1);
      else out.push(p[0], p[1], p[2], range(rand, 0.55, 1) * (0.5 + 0.5 * edge), 0.4, 0.008);
      made++;
    }
  }
  // The rifts' lit faces near the core, where the light is: seen edge-on, a
  // dark lane runs between two thin bright seams.
  const seam = Math.round((gas.front * 0.35) / rifts.length);
  for (const R of rifts) {
    for (let made = 0, tries = 0; made < seam && tries < seam * 8; tries++) {
      const a = R.a0 + (R.a1 - R.a0) * 0.6 * rand() ** 1.4;
      const b = gauss(rand) * r * 0.22;
      if (Math.abs(b) > R.wb * 0.7) continue;
      const t = riftHalf(R, a, b);
      const h = riftMid(R, a, b) + (rand() < 0.5 ? -1 : 1) * (t * (1 + Math.abs(gauss(rand)) * 0.08) + r * 0.0015);
      const x = R.o[0] + R.e1[0] * a + R.e2[0] * b + R.n[0] * h;
      const y = R.o[1] + R.e1[1] * a + R.e2[1] * b + R.n[1] * h;
      const z = R.o[2] + R.e1[2] * a + R.e2[2] * b + R.n[2] * h;
      if (rand() > Math.exp(-(x * x + y * y + z * z) / (r * r * 0.12)) || dark(x, y, z)) continue;
      out.push(x, y, z, range(rand, 0.4, 0.85), 0.3, 0.006);
      made++;
    }
  }

  // Reflection-dust wisps: bundles of faint, nearly parallel striations
  // threading the body, each bundle combed along the contours of one broad
  // smooth field across planes square to its own grain, so neighbouring
  // strands run side by side and only slowly part.
  const fa = waves(rand, 5, 2.2 / r, 4.5 / r);
  const GA = [0, 0, 0];
  const flow = (x, y, z, K, o, ref) => {
    fa.grad(x, y, z, GA);
    let cx = GA[1] * K[2] - GA[2] * K[1];
    let cy = GA[2] * K[0] - GA[0] * K[2];
    let cz = GA[0] * K[1] - GA[1] * K[0];
    const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    const sg = cx * ref[0] + cy * ref[1] + cz * ref[2] < 0 ? -1 / l : 1 / l;
    cx *= sg;
    cy *= sg;
    cz *= sg;
    o[0] = cx;
    o[1] = cy;
    o[2] = cz;
    return o;
  };
  const wstep = r * 0.012;
  const strands = [];
  for (let k = Math.max(1, Math.round(pick(C.wisps) * few)); k > 0; k--) {
    const seed = onStructure(0.12, 0.8);
    if (!seed) continue;
    const K = unit(rand);
    const v0 = flow(seed[0], seed[1], seed[2], K, [0, 0, 0], unit(rand));
    const e1 = rotate(perp(v0), v0, rand() * TAU);
    const e2 = cross3(v0, e1);
    const ns = Math.round(range(rand, 2.6, 5.4));
    const sp = r * range(rand, 0.005, 0.012);
    const half = range(rand, 9, 20);
    const wt = range(rand, 0.6, 1.4);
    for (let j = 0; j < ns; j++) {
      const off = (j - (ns - 1) / 2) * sp * (1 + 0.35 * gauss(rand));
      const lat = gauss(rand) * sp * 0.4;
      const s0 = [seed[0] + e1[0] * off + e2[0] * lat, seed[1] + e1[1] * off + e2[1] * lat, seed[2] + e1[2] * off + e2[2] * lat];
      const halves = [];
      for (const sgn of [1, -1]) {
        const p = s0.slice();
        const t = [v0[0] * sgn, v0[1] * sgn, v0[2] * sgn];
        const m = [0, 0, 0];
        const pts = [];
        for (let n = Math.round(half + gauss(rand) * 3); n > 0; n--) {
          // Midpoint steps keep neighbouring strands from crossing.
          flow(p[0], p[1], p[2], K, t, t);
          flow(p[0] + t[0] * wstep * 0.5, p[1] + t[1] * wstep * 0.5, p[2] + t[2] * wstep * 0.5, K, m, t);
          p[0] += m[0] * wstep;
          p[1] += m[1] * wstep;
          p[2] += m[2] * wstep;
          if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] > r * r * 0.9) break;
          pts.push(p[0], p[1], p[2]);
        }
        halves.push(pts);
      }
      const line = [];
      for (let q = halves[0].length - 3; q >= 0; q -= 3) line.push(halves[0][q], halves[0][q + 1], halves[0][q + 2]);
      line.push(s0[0], s0[1], s0[2], ...halves[1]);
      if (line.length >= 12) strands.push({ pts: line, wt, w: r * range(rand, 0.0015, 0.003), b: range(rand, 0.7, 1.2), bead: range(rand, 1, 3) / (r * 0.02), bph: rand() * TAU });
    }
  }
  const sw2 = strands.reduce((s, S) => s + (S.pts.length / 3 - 1) * S.wt, 0);
  for (const S of strands) {
    const segN = S.pts.length / 3 - 1;
    const m = Math.round((gas.wisp * segN * S.wt) / sw2);
    for (let i = 0; i < m; i++) {
      const k = Math.floor(rand() * segN);
      const u = rand();
      const f = (k + u) / segN;
      const a = k * 3;
      const x = S.pts[a] + (S.pts[a + 3] - S.pts[a]) * u + gauss(rand) * S.w;
      const y = S.pts[a + 1] + (S.pts[a + 4] - S.pts[a + 1]) * u + gauss(rand) * S.w;
      const z = S.pts[a + 2] + (S.pts[a + 5] - S.pts[a + 2]) * u + gauss(rand) * S.w;
      if (dark(x, y, z)) continue;
      const bead = 0.65 + 0.35 * Math.sin((k + u) * wstep * S.bead + S.bph);
      out.push(x, y, z, range(rand, 0.18, 0.4) * Math.sin(Math.PI * f) ** 0.7 * bead * S.b, 0);
    }
  }

  // Ragged dusty edges: faint fibrous tufts combed outward from the rim,
  // between the dark notches bitten into it.
  const tufts = Math.max(3, Math.round(range(rand, 14, 24) * few));
  for (let k = 0; k < tufts; k++) {
    const root = onStructure(0.78, 1.02);
    if (!root) continue;
    const q = Math.hypot(root[0], root[1], root[2]);
    const d = norm([root[0] / q + gauss(rand) * 0.2, root[1] / q + gauss(rand) * 0.2, root[2] / q + gauss(rand) * 0.2]);
    const ax = norm(cross3(d, unit(rand)));
    const side = cross3(ax, d);
    const curl = range(rand, -0.8, 0.8);
    const L = r * range(rand, 0.07, 0.22);
    const w = r * range(rand, 0.002, 0.004);
    const fan = range(rand, 0.04, 0.12);
    const m = Math.round((gas.fray / tufts) * range(rand, 0.6, 1.4));
    for (let i = 0; i < m; i++) {
      const t = rand();
      // Curling about ax (square to d): d turns toward side.
      const c = Math.cos(curl * t) * L * t;
      const sn = Math.sin(curl * t) * L * t + (Math.floor(rand() * 3) - 1) * fan * L * t; // two or three fibres splaying apart
      const x = root[0] + d[0] * c + side[0] * sn + gauss(rand) * w * (1 + 2 * t);
      const y = root[1] + d[1] * c + side[1] * sn + gauss(rand) * w * (1 + 2 * t);
      const z = root[2] + d[2] * c + side[2] * sn + gauss(rand) * w * (1 + 2 * t);
      if (dark(x, y, z)) continue;
      out.push(x, y, z, range(rand, 0.1, 0.3) * (1 - 0.7 * t), 0);
    }
  }

  return { ...out.done(), frame: frame(rand) };
}
