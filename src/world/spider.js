/**
 * The crawler, simulated in 3D (no rendering here; src/world/view3d.js draws
 * it). A body with a forward/up/side frame glides through the web with
 * gait-driven surges; 16 jointed legs (8 a side) keep their feet planted on
 * web nodes and step one by one, in alternating groups, when they fall
 * behind or twist too far; knees arch upward like a real spider's. Silk is
 * spun from the rear and anchored to web nodes as it travels.
 *
 * update() writes run.spider and appends silk anchors to run.silk.
 */

import { LEG_COUNT } from '../core/contracts.js';
import { fork, range } from '../core/rng.js';

export const BODY = { RX: 22, RY: 17, RZ: 12 }; // half-lengths along forward, side, up
const SILK_CAP = 700;
const SILK_EVERY = 44;
const CELL = 40;
const STEP_TIME = 0.13;
const MAX_TURN = 2.4; // rad/s; legs re-grip before they can cross
const MAX_TILT = 0.55; // body pitch limit, radians

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const ease = (u) => u * u * (3 - 2 * u);

/** 3D grid of every web particle, built once per world. */
function nodeGrid(world) {
  if (world._nodeGrid) return world._nodeGrid;
  const grid = new Map();
  for (const cloud of world._clouds || []) {
    const p = cloud.pos;
    for (let k = 0; k < p.length; k += 3) {
      const key = `${Math.floor(p[k] / CELL)},${Math.floor(p[k + 1] / CELL)},${Math.floor(p[k + 2] / CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(p[k], p[k + 1], p[k + 2]);
    }
  }
  world._nodeGrid = grid;
  return grid;
}

/** Nearest web node to p within radius r, or null. */
function nearestNode(world, p, r) {
  if (!world) return null;
  const grid = nodeGrid(world);
  let best = null;
  let bd = r * r;
  const [x, y, z] = p;
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
    for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const cell = grid.get(`${cx},${cy},${cz}`);
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 3) {
          const d = (cell[k] - x) ** 2 + (cell[k + 1] - y) ** 2 + (cell[k + 2] - z) ** 2;
          if (d < bd) {
            bd = d;
            best = [cell[k], cell[k + 1], cell[k + 2]];
          }
        }
      }
  return best;
}

export class Spider {
  /**
   * @param {number[]} p start position [x, y, z]
   * @param {number} seed
   * @param {import('../core/contracts.js').World} [world] web the feet grip
   */
  constructor(p, seed = 1, world = null) {
    const rand = fork(seed, 'spider');
    this.world = world;
    this.p = [...p];
    this.v = [0, 0, 0];
    this.F = norm([1, 0, 0.3]);
    this.U = [0, 1, 0];
    this.S = norm(cross(this.F, this.U));
    this.time = 0;
    this.gait = 0;
    this.group = 0;
    this.travel = 0;
    this.legs = [];
    const perSide = LEG_COUNT / 2;
    for (const side of [-1, 1]) {
      for (let k = 0; k < perSide; k++) {
        const u = k / (perSide - 1); // 0 front .. 1 rear
        const reach = (0.85 + 0.3 * Math.sin(Math.PI * (0.15 + 0.7 * u))) * 50 * range(rand, 0.9, 1.1);
        this.legs.push({
          hipAng: side * (0.4 + u * 2.35),
          restAng: side * (0.5 + u * 2.15) + (rand() - 0.5) * 0.14,
          reach,
          femur: reach * range(rand, 0.6, 0.66),
          tibia: reach * range(rand, 0.66, 0.74),
          group: (k + (side > 0 ? 1 : 0)) % 2,
          foot: [0, 0, 0],
          from: [0, 0, 0],
          to: [0, 0, 0],
          step: 1,
          hip: [0, 0, 0],
          knee: [0, 0, 0],
          drawFoot: [0, 0, 0],
        });
      }
    }
    this.plantAll();
  }

  /** Hip and rest-foot positions of a leg. */
  legFrame(leg) {
    const { RX, RY } = BODY;
    const { p, F, S, U } = this;
    const hc = Math.cos(leg.hipAng) * RX * 0.9;
    const hs = Math.sin(leg.hipAng) * RY * 0.9;
    const hip = [p[0] + F[0] * hc + S[0] * hs, p[1] + F[1] * hc + S[1] * hs, p[2] + F[2] * hc + S[2] * hs];
    const rc = Math.cos(leg.restAng);
    const rs = Math.sin(leg.restAng);
    const out = leg.reach * 0.74;
    const down = leg.reach * 0.32;
    const rest = [
      hip[0] + (F[0] * rc + S[0] * rs) * out - U[0] * down,
      hip[1] + (F[1] * rc + S[1] * rs) * out - U[1] * down,
      hip[2] + (F[2] * rc + S[2] * rs) * out - U[2] * down,
    ];
    return { hip, rest };
  }

  plantAll() {
    for (const leg of this.legs) {
      const { rest } = this.legFrame(leg);
      leg.foot = [...(nearestNode(this.world, rest, 14) || rest)];
      leg.step = 1;
    }
    this.solve();
  }

  /** Turn the body toward a direction at a capped rate, keeping it near level. */
  orient(dir, dt) {
    let d = norm(dir);
    const tilt = Math.asin(Math.max(-1, Math.min(1, d[1])));
    if (Math.abs(tilt) > MAX_TILT) {
      const h = norm([d[0], 0, d[2]]);
      const t = Math.sign(tilt) * MAX_TILT;
      d = [h[0] * Math.cos(t), Math.sin(t), h[2] * Math.cos(t)];
    }
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(this.F, d))));
    if (ang > 1e-4) {
      const step = Math.min(MAX_TURN * dt, ang * (1 - Math.exp(-5 * dt)));
      const t = step / ang;
      this.F = norm([this.F[0] + (d[0] - this.F[0]) * t, this.F[1] + (d[1] - this.F[1]) * t, this.F[2] + (d[2] - this.F[2]) * t]);
    }
    const f = this.F[1];
    this.U = norm([-this.F[0] * f, 1 - this.F[1] * f, -this.F[2] * f]);
    this.S = norm(cross(this.F, this.U));
  }

  /** Knee positions: 2-segment IK, bending up and outward. */
  solve() {
    const { p, U } = this;
    for (const leg of this.legs) {
      const { hip } = this.legFrame(leg);
      leg.hip = hip;
      let foot = leg.foot;
      if (leg.step < 1) {
        const lift = Math.sin(Math.PI * leg.step) * 10;
        foot = [foot[0] + U[0] * lift, foot[1] + U[1] * lift, foot[2] + U[2] * lift];
      }
      let a = [foot[0] - hip[0], foot[1] - hip[1], foot[2] - hip[2]];
      let d = len(a) || 1e-3;
      const max = leg.femur + leg.tibia - 0.5;
      if (d > max) {
        a = [(a[0] / d) * max, (a[1] / d) * max, (a[2] / d) * max];
        d = max;
      }
      const ax = [a[0] / d, a[1] / d, a[2] / d];
      const out = norm([hip[0] - p[0], hip[1] - p[1], hip[2] - p[2]]);
      let b = [U[0] + out[0] * 0.5, U[1] + out[1] * 0.5, U[2] + out[2] * 0.5];
      const bd = dot(b, ax);
      b = norm([b[0] - ax[0] * bd, b[1] - ax[1] * bd, b[2] - ax[2] * bd]);
      const cosA = Math.max(-1, Math.min(1, (leg.femur ** 2 + d * d - leg.tibia ** 2) / (2 * leg.femur * d)));
      const sinA = Math.sqrt(1 - cosA * cosA);
      leg.knee = [
        hip[0] + ax[0] * leg.femur * cosA + b[0] * leg.femur * sinA,
        hip[1] + ax[1] * leg.femur * cosA + b[1] * leg.femur * sinA,
        hip[2] + ax[2] * leg.femur * cosA + b[2] * leg.femur * sinA,
      ];
      leg.drawFoot = [hip[0] + a[0], hip[1] + a[1], hip[2] + a[2]];
    }
  }

  /**
   * Advance one step toward run.spiderGoal.
   * @param {number} dt seconds
   * @param {import('../core/contracts.js').RunState} run
   */
  update(dt, run) {
    this.time += dt;
    const g = run.spiderGoal;
    const to = [g.x - this.p[0], g.y - this.p[1], (g.z ?? 0) - this.p[2]];
    const dist = len(to);
    if (dist > 4000) {
      this.p = [g.x, g.y, g.z ?? 0];
      this.v = [0, 0, 0];
      run.silk.length = 0;
      this.plantAll();
    }

    // Body: arrive at the goal; speed surges with each gait beat.
    const walking = run.phase === 'walk' || run.phase === 'ship';
    const top = walking ? 300 : 60;
    const speed0 = len(this.v);
    this.gait += dt * (3 + speed0 / 28);
    const surge = 0.55 + 0.45 * Math.abs(Math.sin(this.gait * Math.PI));
    const want = dist > 4 ? Math.min(top, dist * 2.4) * surge : 0;
    const k = 1 - Math.exp(-5 * dt);
    for (let i = 0; i < 3; i++) {
      const w = dist > 1e-3 ? (to[i] / dist) * want : 0;
      this.v[i] += (w - this.v[i]) * k;
      this.p[i] += this.v[i] * dt;
    }
    const speed = len(this.v);
    if (speed > 6) this.orient(this.v, dt);

    // Legs: planted feet; step when behind or twisted, alternating groups.
    if (this.gait >= 1) {
      this.gait -= 1;
      this.group ^= 1;
    }
    let stepping = this.legs.reduce((n, l) => n + (l.step < 1 ? 1 : 0), 0);
    const lead = Math.min(28, speed * STEP_TIME * 1.1);
    const lv = speed > 1 ? this.v.map((c) => (c / speed) * lead) : [0, 0, 0];
    for (const leg of this.legs) {
      if (leg.step < 1) {
        leg.step = Math.min(1, leg.step + dt / STEP_TIME);
        const e = ease(leg.step);
        leg.foot = leg.from.map((c, i) => c + (leg.to[i] - c) * e);
        continue;
      }
      const { hip, rest } = this.legFrame(leg);
      const off = Math.hypot(leg.foot[0] - rest[0], leg.foot[1] - rest[1], leg.foot[2] - rest[2]);
      const rel = [leg.foot[0] - hip[0], leg.foot[1] - hip[1], leg.foot[2] - hip[2]];
      const ang = Math.atan2(dot(rel, this.S), dot(rel, this.F));
      const twist = Math.abs(Math.atan2(Math.sin(ang - leg.restAng), Math.cos(ang - leg.restAng)));
      const stretch = len(rel) / (leg.femur + leg.tibia);
      const urgent = off > leg.reach * 0.55 || twist > 0.85 || stretch > 0.98;
      const due = off > leg.reach * 0.25 || twist > 0.45;
      if ((urgent || (due && leg.group === this.group)) && stepping < 7) {
        const target = [rest[0] + lv[0], rest[1] + lv[1], rest[2] + lv[2]];
        leg.from = [...leg.foot];
        leg.to = nearestNode(this.world, target, 14) || target;
        leg.step = 0;
        stepping++;
      }
    }
    this.solve();

    // Silk: anchor a strand to the web every so often as it travels.
    this.travel += speed * dt;
    if (this.travel > SILK_EVERY) {
      this.travel = 0;
      const sp = this.spinneret();
      const n = nearestNode(this.world, sp, 16) || sp;
      run.silk.push({ x: n[0], y: n[1], z: n[2], s: run.silkSection, t: run.t });
      if (run.silk.length > SILK_CAP) run.silk.shift();
    }

    run.spider.x = this.p[0];
    run.spider.y = this.p[1];
    run.spider.z = this.p[2];
    run.spider.vx = this.v[0];
    run.spider.vy = this.v[1];
    run.spider.vz = this.v[2];
    run.spider.heading = Math.atan2(this.F[2], this.F[0]);
  }

  /** Rear of the abdomen, where silk leaves the body. */
  spinneret() {
    const r = BODY.RX;
    return [this.p[0] - this.F[0] * r, this.p[1] - this.F[1] * r, this.p[2] - this.F[2] * r];
  }

  /** Head centre. */
  head() {
    const r = BODY.RX + 6;
    return [this.p[0] + this.F[0] * r, this.p[1] + this.F[1] * r, this.p[2] + this.F[2] * r];
  }
}
