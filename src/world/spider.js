/**
 * The crawler, simulated in 3D (src/world/view3d.js draws it).
 *
 * Anatomy: a cephalothorax carrying 16 three-segment legs (femur, tibia,
 * tarsus; 8 a side, front and rear pairs longest), a waist, and a larger
 * abdomen with spinnerets at the rear.
 *
 * Two ways of moving, which alternate through the crawl:
 *  - jump: between sections (run.travel) it crouches, launches and flies a
 *    floaty ballistic arc on its dragline. On take-off the legs stream out
 *    behind it; past the apex they swing forward to catch; on landing the
 *    feet grab the web where they are and the body absorbs the impact.
 *  - crawl: inside a section it moves like a real spider, in short eased
 *    bursts with pauses between them, turning while paused; feet stay planted
 *    on web nodes and step individually, alternating groups.
 *
 * update() writes run.spider (incl. `arrived`) and appends silk anchors.
 */

import { LEG_COUNT } from '../core/contracts.js';
import { fork, range } from '../core/rng.js';

export const ABDOMEN = { RX: 20, RY: 15.5, RZ: 12.5, OFF: -15 }; // half-lengths (forward, side, up), centre offset
export const CEPH = { RX: 11, RY: 9.5, RZ: 7, OFF: 9 };
const SILK_CAP = 500;
const SILK_EVERY = 36;
const CELL = 40;
const STEP_TIME = 0.17;
const MAX_TURN = 2.2;
const MAX_TILT = 0.5;
const MAX_TILT_AIR = 0.95;
const LAND_TIME = 0.32;
const LEG_SCALE = [1.18, 1.1, 0.98, 0.92, 0.9, 0.97, 1.06, 1.15]; // front pair .. rear pair, per side

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);
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
    this.rand = fork(seed, 'gait');
    this.world = world;
    this.p = [...p];
    this.v = [0, 0, 0];
    this.F = norm([1, 0, 0.3]);
    this.U = [0, 1, 0];
    this.S = norm(cross(this.F, this.U));
    this.time = 0;
    this.mode = 'crawl';
    this.travelId = null;
    this.launched = false;
    this.airU = 0;
    this.burst = null;
    this.pause = 0.4;
    this.group = 0;
    this.groupT = 0;
    this.travel = 0;
    this.legs = [];
    const perSide = LEG_COUNT / 2;
    for (const side of [-1, 1]) {
      for (let k = 0; k < perSide; k++) {
        const u = k / (perSide - 1); // 0 front .. 1 rear
        const reach = 50 * LEG_SCALE[k % LEG_SCALE.length] * range(rand, 0.96, 1.04);
        this.legs.push({
          side,
          hipAng: side * (0.55 + u * 2.1),
          restAng: side * (0.42 + u * 2.3) + (rand() - 0.5) * 0.12,
          reach,
          femur: reach * 0.44,
          tibia: reach * 0.42,
          tarsus: reach * 0.26,
          group: (k + (side > 0 ? 1 : 0)) % 2,
          phase: rand() * Math.PI * 2,
          foot: [0, 0, 0],
          fv: [0, 0, 0],
          from: [0, 0, 0],
          to: [0, 0, 0],
          step: 1,
          free: false,
          hip: [0, 0, 0],
          knee: [0, 0, 0],
          ankle: [0, 0, 0],
          tip: [0, 0, 0],
        });
      }
    }
    this.plantAll();
  }

  /** Centres of the two body parts. */
  cephCenter() {
    return add(this.p, this.F, CEPH.OFF);
  }

  abdomenCenter() {
    return add(this.p, this.F, ABDOMEN.OFF);
  }

  /** Hip, rest foot, tuck target and outward direction of a leg. */
  legFrame(leg) {
    const { F, S, U } = this;
    const c = this.cephCenter();
    const hip = add(add(c, F, Math.cos(leg.hipAng) * CEPH.RX * 0.85), S, Math.sin(leg.hipAng) * CEPH.RY * 0.85);
    const dir = add(add([0, 0, 0], F, Math.cos(leg.restAng)), S, Math.sin(leg.restAng));
    const rest = add(add(hip, dir, leg.reach * 0.8), U, -leg.reach * 0.36);
    // Drifting pose: legs splayed wide like a falling spider, slowly paddling.
    const sway = Math.sin(this.time * 2.1 + leg.phase) * 0.16;
    const tdir = norm(add(add([0, 0, 0], F, Math.cos(leg.restAng * 0.92 + sway)), S, Math.sin(leg.restAng * 0.92 + sway)));
    const tuck = add(add(hip, tdir, leg.reach * 0.86), U, -leg.reach * (0.16 + 0.06 * Math.sin(this.time * 1.7 + leg.phase)));
    return { hip, rest, tuck, dir };
  }

  plantAll() {
    for (const leg of this.legs) {
      const { rest } = this.legFrame(leg);
      leg.foot = [...(nearestNode(this.world, rest, 14) || rest)];
      leg.step = 1;
      leg.free = false;
    }
    this.solve();
  }

  /** Turn the body toward a direction at a capped rate, keeping it near level. */
  orient(dir, dt, rate = 4, maxTilt = MAX_TILT) {
    let d = norm(dir);
    const tilt = Math.asin(Math.max(-1, Math.min(1, d[1])));
    if (Math.abs(tilt) > maxTilt) {
      const h = norm([d[0], 0, d[2]]);
      const t = Math.sign(tilt) * maxTilt;
      d = [h[0] * Math.cos(t), Math.sin(t), h[2] * Math.cos(t)];
    }
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(this.F, d))));
    if (ang > 1e-4) {
      const step = Math.min(MAX_TURN * dt, ang * (1 - Math.exp(-rate * dt)));
      this.F = norm(lerp3(this.F, d, step / ang));
    }
    const f = this.F[1];
    this.U = norm([-this.F[0] * f, 1 - this.F[1] * f, -this.F[2] * f]);
    this.S = norm(cross(this.F, this.U));
  }

  /** Joint positions: tarsus drops to the foot from the ankle; femur+tibia by 2-bone IK, knee up and out. */
  solve() {
    const { U } = this;
    const body = this.cephCenter();
    for (const leg of this.legs) {
      const { hip } = this.legFrame(leg);
      leg.hip = hip;
      let foot = leg.foot;
      if (leg.step < 1 && !leg.free) foot = add(foot, U, Math.sin(Math.PI * leg.step) * 9);
      const rel = [foot[0] - hip[0], foot[1] - hip[1], foot[2] - hip[2]];
      const out = norm(add(rel, U, -dot(rel, U)));
      leg.ankle = add(foot, norm(add(add([0, 0, 0], out, -0.45), U, 0.9)), leg.tarsus);
      let a = [leg.ankle[0] - hip[0], leg.ankle[1] - hip[1], leg.ankle[2] - hip[2]];
      let d = len(a) || 1e-3;
      const max = leg.femur + leg.tibia - 0.5;
      if (d > max) {
        a = a.map((c) => (c / d) * max);
        d = max;
        leg.ankle = add(hip, a);
      }
      const ax = a.map((c) => c / d);
      const outward = norm([hip[0] - body[0], hip[1] - body[1], hip[2] - body[2]]);
      let b = add(U, outward, 0.45);
      b = norm(add(b, ax, -dot(b, ax)));
      const cosA = Math.max(-1, Math.min(1, (leg.femur ** 2 + d * d - leg.tibia ** 2) / (2 * leg.femur * d)));
      const sinA = Math.sqrt(1 - cosA * cosA);
      leg.knee = add(add(hip, ax, leg.femur * cosA), b, leg.femur * sinA);
      leg.tip = add(leg.ankle, norm([foot[0] - leg.ankle[0], foot[1] - leg.ankle[1], foot[2] - leg.ankle[2]]), leg.tarsus);
    }
  }

  /**
   * Advance one step.
   * @param {number} dt seconds
   * @param {import('../core/contracts.js').RunState} run
   */
  update(dt, run) {
    this.time += dt;
    const prev = [...this.p];
    const tr = run.travel;
    if (tr && tr.id !== this.travelId) {
      this.travelId = tr.id;
      this.mode = 'jump';
      this.burst = null;
      this.launched = false;
      run.spider.arrived = false;
    }

    if (this.mode === 'jump') this.jump(dt, run, tr);
    else if (this.mode === 'land') this.land(dt, run, tr);
    else this.crawl(dt, run);

    for (let i = 0; i < 3; i++) this.v[i] = (this.p[i] - prev[i]) / dt;
    this.legsUpdate(dt, run);
    this.solve();

    // Silk: while crawling, anchor a strand to the web every so often.
    const moved = Math.hypot(this.p[0] - prev[0], this.p[1] - prev[1], this.p[2] - prev[2]);
    if (this.mode === 'crawl') {
      this.travel += moved;
      if (this.travel > SILK_EVERY) {
        this.travel = 0;
        this.anchor(run);
      }
    }

    run.spider.x = this.p[0];
    run.spider.y = this.p[1];
    run.spider.z = this.p[2];
    [run.spider.vx, run.spider.vy, run.spider.vz] = this.v;
    run.spider.heading = Math.atan2(this.F[2], this.F[0]);
  }

  anchor(run) {
    const sp = this.spinneret();
    const n = nearestNode(this.world, sp, 16) || sp;
    run.silk.push({ x: n[0], y: n[1], z: n[2], s: run.silkSection, t: run.t });
    if (run.silk.length > SILK_CAP) run.silk.shift();
  }

  /**
   * Crouch, launch, fly a floaty ballistic arc, land. Horizontal travel is
   * linear in time and height parabolic, like a real jump; a slightly
   * lowered gravity (high apex, long airtime) makes it float.
   */
  jump(dt, run, tr) {
    const T = run.t - tr.t0;
    const flat = norm([tr.to[0] - tr.from[0], 0, tr.to[2] - tr.from[2]]);
    if (T < tr.crouch) {
      // Anticipation: sink onto the legs and turn toward the target.
      const k = ease(T / tr.crouch);
      this.p = add(tr.from, this.U, -8 * k);
      this.orient(flat, dt, 7);
      return;
    }
    if (!this.launched) {
      this.launched = true;
      this.launchAt = [...this.p];
      this.anchor(run);
      // Push off: feet let go and kick back as the body leaves.
      for (const leg of this.legs) {
        leg.free = true;
        leg.step = 1;
        leg.fv = flat.map((c) => -c * 90);
      }
    }
    const u = Math.min(1, (T - tr.crouch) / tr.air);
    const base = lerp3(this.launchAt, tr.to, u);
    this.p = add(base, [0, 1, 0], tr.apex * 4 * u * (1 - u));
    const vel = [tr.to[0] - this.launchAt[0], tr.to[1] - this.launchAt[1] + tr.apex * 4 * (1 - 2 * u), tr.to[2] - this.launchAt[2]];
    this.orient(vel, dt, 6, MAX_TILT_AIR);
    this.airU = u;
    if (u >= 1) {
      this.mode = 'land';
      this.landT = 0;
      // Feet grab the web wherever they come down.
      for (const leg of this.legs) {
        leg.free = false;
        leg.from = [...leg.foot];
        leg.to = nearestNode(this.world, leg.foot, 18) || leg.foot;
        leg.step = 0;
      }
    }
  }

  /** Absorb the landing: dip, recover, then crawl. */
  land(dt, run, tr) {
    this.landT += dt;
    const k = Math.min(1, this.landT / LAND_TIME);
    this.p = add(tr.to, this.U, -7 * Math.sin(Math.PI * k));
    this.orient([this.F[0], 0, this.F[2]], dt, 4);
    if (k >= 1) {
      this.mode = 'crawl';
      this.pause = range(this.rand, 0.15, 0.35);
      run.spider.arrived = true;
      this.anchor(run);
    }
  }

  /** Move in eased bursts toward the goal, pausing and turning between them. */
  crawl(dt, run) {
    const g = run.spiderGoal;
    const goal = [g.x, g.y, g.z ?? 0];
    if (this.burst) {
      const b = this.burst;
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      this.p = lerp3(b.from, b.to, smoother(u));
      this.orient([b.to[0] - b.from[0], b.to[1] - b.from[1], b.to[2] - b.from[2]], dt, 5);
      if (u >= 1) {
        this.burst = null;
        this.pause = range(this.rand, 0.15, 0.55);
      }
      return;
    }
    const to = [goal[0] - this.p[0], goal[1] - this.p[1], goal[2] - this.p[2]];
    const dist = len(to);
    if (this.pause > 0) {
      this.pause -= dt;
      if (dist > 8) this.orient(to, dt, 1.6); // turn toward where it will go next
      return;
    }
    if (dist < 8) {
      this.pause = range(this.rand, 0.6, 1.4);
      return;
    }
    const L = Math.min(dist, range(this.rand, 20, 44));
    const n = norm(to);
    const meander = range(this.rand, -0.45, 0.45);
    const dir = norm(add(add([0, 0, 0], n, Math.cos(meander)), this.S, Math.sin(meander)));
    this.burst = { from: [...this.p], to: add(this.p, dir, L), t: 0, dur: 0.32 + L / 115 };
  }

  legsUpdate(dt, run) {
    const moving = this.mode === 'crawl' && this.burst;
    this.groupT += dt;
    if (this.groupT > 0.14) {
      this.groupT = 0;
      this.group ^= 1;
    }
    let stepping = this.legs.reduce((n, l) => n + (l.step < 1 ? 1 : 0), 0);
    const airborne = this.mode === 'jump' && this.launched;
    const body = this.cephCenter();
    // Direction of flight, flattened, for legs streaming behind.
    const back = norm([-this.F[0], -this.F[1] * 0.3, -this.F[2]]);
    const reachOut = airborne ? Math.max(0, Math.min(1, (this.airU - 0.45) / 0.3)) : 0;
    for (const leg of this.legs) {
      const fr = this.legFrame(leg);
      if (leg.free) {
        // In the air: legs trail behind the body, then swing forward to catch the web.
        const out = norm([fr.hip[0] - body[0], fr.hip[1] - body[1], fr.hip[2] - body[2]]);
        const flow = Math.sin(this.time * 6 + leg.phase) * 0.12;
        const trail = add(add(add(fr.hip, back, leg.reach * (0.72 + flow)), out, leg.reach * 0.42), this.U, -leg.reach * 0.18);
        const ready = add(fr.rest, this.U, leg.reach * 0.12);
        const target = lerp3(trail, ready, ease(reachOut));
        for (let j = 0; j < 3; j++) {
          leg.fv[j] += ((target[j] - leg.foot[j]) * 60 - leg.fv[j] * 9.5) * dt;
          leg.foot[j] += leg.fv[j] * dt;
        }
        continue;
      }
      if (leg.step < 1) {
        leg.step = Math.min(1, leg.step + dt / (this.mode === 'land' ? 0.16 : STEP_TIME));
        leg.foot = lerp3(leg.from, leg.to, ease(leg.step));
        continue;
      }
      if (this.mode === 'jump') continue; // crouching: feet stay put
      const { hip, rest } = fr;
      const off = Math.hypot(leg.foot[0] - rest[0], leg.foot[1] - rest[1], leg.foot[2] - rest[2]);
      const rel = [leg.foot[0] - hip[0], leg.foot[1] - hip[1], leg.foot[2] - hip[2]];
      const ang = Math.atan2(dot(rel, this.S), dot(rel, this.F));
      const twist = Math.abs(Math.atan2(Math.sin(ang - leg.restAng), Math.cos(ang - leg.restAng)));
      const stretch = len(rel) / (leg.femur + leg.tibia + leg.tarsus);
      const urgent = off > leg.reach * 0.6 || twist > 0.9 || stretch > 0.97;
      const due = off > leg.reach * 0.24 || twist > 0.42;
      if ((urgent || (moving && due && leg.group === this.group)) && stepping < 6) {
        const lead = moving ? norm([this.burst.to[0] - this.p[0], this.burst.to[1] - this.p[1], this.burst.to[2] - this.p[2]]) : [0, 0, 0];
        const target = add(rest, lead, moving ? 11 : 0);
        leg.from = [...leg.foot];
        leg.to = nearestNode(this.world, target, 14) || target;
        leg.step = 0;
        stepping++;
      }
    }
  }

  /** Rear of the abdomen, where silk leaves the body. */
  spinneret() {
    return add(this.p, this.F, ABDOMEN.OFF - ABDOMEN.RX);
  }

  /** Front of the cephalothorax (eyes, fangs, palps). */
  face() {
    return add(this.p, this.F, CEPH.OFF + CEPH.RX * 0.85);
  }
}
