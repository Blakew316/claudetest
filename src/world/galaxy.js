/**
 * Procedural star clusters, each a small universe of its own: spiral,
 * barred spiral, elliptical, ring, nebula and lenticular morphologies, built
 * from a bright hot core, arms or discs, knots of star-forming clumps and a
 * faint halo, then tipped into a random orientation. Pure data.
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
