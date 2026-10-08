/**
 * The crawler, simulated in 3D (src/world/view3d.js draws it).
 *
 * Anatomy: a cephalothorax carrying 16 three-segment legs (femur, tibia,
 * tarsus; 8 a side, front and rear pairs longest), a waist, and an abdomen
 * that swings behind on its own lag, spinnerets at its tip.
 *
 * Movement alternates between:
 *  - jump (between sections, run.travel): crouch, launch on a dragline, a
 *    floaty ballistic arc with legs streaming behind and then swinging
 *    forward to catch, a landing that grabs the silk and absorbs the impact.
 *  - crawl (inside a section): walks where it faces, speed easing up and
 *    down through walk/pause intents; legs step in a rolling wave as it
 *    goes (metachronal gait), feet always on silk; the body bobs and sways
 *    with each stride; while paused a front leg sometimes taps the web.
 *
 * update() writes run.spider (incl. `arrived`) and appends silk anchors.
 */

import { LEG_COUNT } from '../core/contracts.js';
import { fork, range } from '../core/rng.js';

/** Overall size of the spider relative to the world (1 = the original, larger build). */
export const SCALE = 0.5;
export const ABDOMEN = { RX: 20 * SCALE, RY: 15.5 * SCALE, RZ: 12.5 * SCALE };
export const CEPH = { RX: 11 * SCALE, RY: 9.5 * SCALE, RZ: 7 * SCALE, OFF: 9 * SCALE };
const SILK_CAP = 500;
const SILK_EVERY = 34 * SCALE;
const CELL = 30;
const STRIDE = 15 * SCALE; // world units of travel per gait cycle
const CRUISE = 25; // walking speed, world units/s (smaller spider, shorter strides, quicker legs)
const MAX_TURN = 2;
const MAX_TILT = 1.05;
const MAX_TILT_AIR = 0.95;
const LAND_TIME = 0.36;
const LEG_SCALE = [1.18, 1.1, 0.98, 0.92, 0.9, 0.97, 1.06, 1.15]; // front pair .. rear pair, per side

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ease = (u) => u * u * (3 - 2 * u);
const frac = (x) => x - Math.floor(x);
/** Rotate v about a unit axis k by angle a (Rodrigues). */
const rotate = (v, k, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
};

/** Grid of footholds (silk junctions), falling back to cloud particles; built once per world. */
function nodeGrid(world) {
  if (world._nodeGrid) return world._nodeGrid;
  const grid = new Map();
  const put = (p) => {
    for (let k = 0; k < p.length; k += 3) {
      const key = `${Math.floor(p[k] / CELL)},${Math.floor(p[k + 1] / CELL)},${Math.floor(p[k + 2] / CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(p[k], p[k + 1], p[k + 2]);
    }
  };
  if (world._footholds?.length) put(world._footholds);
  else for (const cloud of world._clouds || []) put(cloud.pos);
  world._nodeGrid = grid;
  return grid;
}

/** Nearest foothold to p within radius r, or null. */
function nearestNode(world, p, r) {
  if (!world) return null;
  r = Math.max(8, r * SCALE); // search radii below are in full-size units
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
    this.p = [...p]; // travel position
    this.b = [...p]; // body position incl. bob and sway
    this.v = [0, 0, 0];
    this.F = norm([1, 0, 0.3]);
    this.U = [0, 1, 0];
    this.S = norm(cross(this.F, this.U));
    this.aF = [...this.F]; // abdomen direction, lags behind F
    this.time = 0;
    this.mode = 'crawl';
    this.travelId = null;
    this.launched = false;
    this.airU = 0;
    this.speed = 0;
    this.speedV = 0;
    this.walking = false;
    this.intentT = 0.3;
    this.gait = 0;
    this.travel = 0;
    this.meander = rand() * 10;
    this.legs = [];
    const perSide = LEG_COUNT / 2;
    for (const side of [-1, 1]) {
      for (let k = 0; k < perSide; k++) {
        const u = k / (perSide - 1); // 0 front .. 1 rear
        const reach = 50 * SCALE * LEG_SCALE[k % LEG_SCALE.length] * range(rand, 0.96, 1.04);
        this.legs.push({
          side,
          k,
          hipAng: side * (0.55 + u * 2.1),
          restAng: side * (0.42 + u * 2.3) + (rand() - 0.5) * 0.12,
          reach,
          femur: reach * 0.44,
          tibia: reach * 0.42,
          tarsus: reach * 0.26,
          // Rolling wave: alternate sides and neighbours, front to back.
          gaitOff: frac((k % 2) * 0.5 + (side > 0 ? 0.5 : 0) + k * 0.07),
          phase: rand() * Math.PI * 2,
          foot: [0, 0, 0],
          fv: [0, 0, 0],
          from: [0, 0, 0],
          to: [0, 0, 0],
          step: 1,
          stepDur: 0.2,
          lift: 9 * SCALE,
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

  /** Centre of the cephalothorax (head-chest). */
  cephCenter() {
    return add(this.b, this.F, CEPH.OFF);
  }

  /** Abdomen centre and orientation frame (it hangs off the waist and lags behind). */
  abdomenFrame() {
    const waist = add(this.b, this.F, -1);
    const F = this.aF;
    const U = norm(add(this.U, F, -dot(this.U, F)));
    const S = norm(cross(F, U));
    return { c: add(waist, F, -ABDOMEN.RX * 0.86), F, U, S };
  }

  /** Hip and rest foot of a leg. */
  legFrame(leg) {
    const { F, S, U } = this;
    const c = this.cephCenter();
    const hip = add(add(c, F, Math.cos(leg.hipAng) * CEPH.RX * 0.85), S, Math.sin(leg.hipAng) * CEPH.RY * 0.85);
    const dir = add(add([0, 0, 0], F, Math.cos(leg.restAng)), S, Math.sin(leg.restAng));
    const rest = add(add(hip, dir, leg.reach * 0.8), U, -leg.reach * 0.36);
    return { hip, rest, dir };
  }

  plantAll() {
    for (const leg of this.legs) {
      const { rest } = this.legFrame(leg);
      leg.foot = [...(nearestNode(this.world, rest, 16) || rest)];
      leg.step = 1;
      leg.free = false;
    }
    this.solve();
  }

  /** Turn the body toward a direction at a capped rate, within a tilt limit. */
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
      if (leg.step < 1 && !leg.free) foot = add(foot, U, Math.sin(Math.PI * leg.step) * leg.lift);
      const rel = sub(foot, hip);
      const out = norm(add(rel, U, -dot(rel, U)));
      leg.ankle = add(foot, norm(add(add([0, 0, 0], out, -0.45), U, 0.9)), leg.tarsus);
      let a = sub(leg.ankle, hip);
      let d = len(a) || 1e-3;
      const max = leg.femur + leg.tibia - 0.5;
      if (d > max) {
        a = a.map((c) => (c / d) * max);
        d = max;
        leg.ankle = add(hip, a);
      }
      const ax = a.map((c) => c / d);
      const outward = norm(sub(hip, body));
      let b = add(U, outward, 0.45);
      b = norm(add(b, ax, -dot(b, ax)));
      const cosA = Math.max(-1, Math.min(1, (leg.femur ** 2 + d * d - leg.tibia ** 2) / (2 * leg.femur * d)));
      const sinA = Math.sqrt(1 - cosA * cosA);
      leg.knee = add(add(hip, ax, leg.femur * cosA), b, leg.femur * sinA);
      leg.tip = add(leg.ankle, norm(sub(foot, leg.ankle)), leg.tarsus);
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
      this.launched = false;
      this.speed = 0;
      this.speedV = 0;
      run.spider.arrived = false;
    }

    if (this.mode === 'jump') this.jump(dt, run, tr);
    else if (this.mode === 'land') this.land(dt, run, tr);
    else this.crawl(dt, run);

    for (let i = 0; i < 3; i++) this.v[i] = (this.p[i] - prev[i]) / dt;
    const moved = len(sub(this.p, prev));

    // Body bob and sway with the stride; the abdomen trails and wags.
    const gaitAmp = this.mode === 'crawl' ? Math.min(1, this.speed / CRUISE) : 0;
    const bob = (Math.sin(this.gait * Math.PI * 4) * 1.1 * gaitAmp + Math.sin(this.time * 1.9) * 0.35) * SCALE;
    const sway = Math.sin(this.gait * Math.PI * 2) * 1.2 * gaitAmp * SCALE;
    this.b = add(add(this.p, this.U, bob), this.S, sway);
    const wag = rotate(this.F, this.U, Math.sin(this.time * 1.3) * 0.07 + Math.sin(this.gait * Math.PI * 2) * 0.1 * gaitAmp);
    this.aF = norm(lerp3(this.aF, wag, 1 - Math.exp(-(this.mode === 'jump' ? 3 : 5) * dt)));

    this.legsUpdate(dt, run, moved);
    this.solve();

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
    const n = nearestNode(this.world, sp, 18) || sp;
    run.silk.push({ x: n[0], y: n[1], z: n[2], s: run.silkSection, t: run.t });
    if (run.silk.length > SILK_CAP) run.silk.shift();
  }

  /**
   * Crouch, launch, fly a floaty ballistic arc, land. Horizontal travel is
   * linear in time and height parabolic, like a real jump; a lowered
   * gravity (high apex, long airtime) makes it float.
   */
  jump(dt, run, tr) {
    const T = run.t - tr.t0;
    const flat = norm([tr.to[0] - tr.from[0], 0, tr.to[2] - tr.from[2]]);
    if (T < tr.crouch) {
      const k = ease(T / tr.crouch);
      this.p = add(tr.from, this.U, -8 * SCALE * k);
      this.orient(flat, dt, 7);
      return;
    }
    if (!this.launched) {
      this.launched = true;
      this.launchAt = [...this.p];
      this.anchor(run);
      for (const leg of this.legs) {
        leg.free = true;
        leg.step = 1;
        leg.fv = flat.map((c) => -c * 90 * SCALE);
      }
    }
    const u = Math.min(1, (T - tr.crouch) / tr.air);
    // Soft launch and soft landing along the path; height stays a parabola.
    const h = u * 0.6 + ease(u) * 0.4;
    this.p = add(lerp3(this.launchAt, tr.to, h), [0, 1, 0], tr.apex * 4 * u * (1 - u));
    const vel = [tr.to[0] - this.launchAt[0], tr.to[1] - this.launchAt[1] + tr.apex * 4 * (1 - 2 * u), tr.to[2] - this.launchAt[2]];
    this.orient(vel, dt, 6, MAX_TILT_AIR);
    this.airU = u;
    if (u >= 1) {
      this.mode = 'land';
      this.landT = 0;
      for (const leg of this.legs) {
        leg.free = false;
        leg.from = [...leg.foot];
        leg.to = nearestNode(this.world, leg.foot, 20) || leg.foot;
        leg.step = 0;
        leg.stepDur = 0.16;
        leg.lift = 4;
      }
    }
  }

  /** Absorb the landing: dip, recover, then crawl. */
  land(dt, run, tr) {
    this.landT += dt;
    const k = Math.min(1, this.landT / LAND_TIME);
    this.p = add(tr.to, this.U, -7 * SCALE * Math.sin(Math.PI * k) * (1 - k * 0.3));
    this.orient([this.F[0], 0, this.F[2]], dt, 4);
    if (k >= 1) {
      this.mode = 'crawl';
      this.walking = false;
      this.intentT = range(this.rand, 0.15, 0.35);
      run.spider.arrived = true;
      this.anchor(run);
    }
  }

  /**
   * Walk where it faces. Intents alternate walking and pausing; speed eases
   * through a spring so it never starts or stops dead; heading meanders
   * gently toward the goal.
   */
  crawl(dt, run) {
    const g = run.spiderGoal;
    const to = sub([g.x, g.y, g.z ?? 0], this.p);
    const dist = len(to);
    this.intentT -= dt;
    if (this.intentT <= 0) {
      this.walking = !this.walking && dist > 10 * SCALE;
      this.intentT = this.walking ? range(this.rand, 0.7, 1.5) : range(this.rand, 0.25, 0.8);
      if (!this.walking && this.rand() < 0.45) this.tap();
    }
    if (dist < 10 * SCALE) this.walking = false;
    const n = norm(to);
    const facing = Math.max(0.15, dot(this.F, n));
    const target = this.walking ? Math.min(CRUISE, dist * 1.5) * facing : 0;
    this.speedV += ((target - this.speed) * 36 - this.speedV * 11) * dt;
    this.speed = Math.max(0, this.speed + this.speedV * dt);
    const wander = Math.sin(this.time * 0.9 + this.meander) * 0.32 + Math.sin(this.time * 2.1 + this.meander * 2) * 0.12;
    const want = dist > 10 * SCALE ? rotate(n, this.U, wander) : this.F;
    this.orient(want, dt, this.walking ? 2.6 : 1.2);
    // Mostly along the body, a little straight to the goal so it never orbits it.
    const dir = norm(add(add([0, 0, 0], this.F, 0.75), n, 0.25));
    this.p = add(this.p, dir, this.speed * dt);
  }

  /** A front leg lifts and taps the silk, feeling the web. */
  tap() {
    const legs = this.legs.filter((l) => l.k < 2 && l.step >= 1 && !l.free);
    if (!legs.length) return;
    const leg = legs[Math.floor(this.rand() * legs.length)];
    const probe = add(add(leg.foot, this.F, range(this.rand, 3, 8) * SCALE), this.S, range(this.rand, -4, 4) * SCALE);
    leg.from = [...leg.foot];
    leg.to = nearestNode(this.world, probe, 10) || leg.foot;
    leg.step = 0;
    leg.stepDur = 0.32;
    leg.lift = 14 * SCALE;
  }

  legsUpdate(dt, run, moved) {
    const airborne = this.mode === 'jump' && this.launched;
    const walking = this.mode === 'crawl' && this.speed > 2;
    const prevGait = this.gait;
    this.gait += moved / STRIDE;
    const cycle = this.speed > 1 ? STRIDE / this.speed : 1;
    const body = this.cephCenter();
    const back = norm([-this.F[0], -this.F[1] * 0.3, -this.F[2]]);
    const reachOut = airborne ? Math.max(0, Math.min(1, (this.airU - 0.45) / 0.3)) : 0;
    const vdir = this.speed > 1 ? norm(this.v) : this.F;
    let stepping = this.legs.reduce((c, l) => c + (l.step < 1 ? 1 : 0), 0);
    for (const leg of this.legs) {
      const fr = this.legFrame(leg);
      if (leg.free) {
        // In the air: legs stream behind the body, then swing forward to catch.
        const out = norm(sub(fr.hip, body));
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
        leg.step = Math.min(1, leg.step + dt / leg.stepDur);
        // Swing fast through the middle of the step, settle onto the silk.
        leg.foot = lerp3(leg.from, leg.to, ease(ease(leg.step)));
        continue;
      }
      if (this.mode === 'jump') continue; // crouching: feet stay put
      const { hip, rest } = fr;
      const off = len(sub(leg.foot, rest));
      const rel = sub(leg.foot, hip);
      const ang = Math.atan2(dot(rel, this.S), dot(rel, this.F));
      const twist = Math.abs(Math.atan2(Math.sin(ang - leg.restAng), Math.cos(ang - leg.restAng)));
      const stretch = len(rel) / (leg.femur + leg.tibia + leg.tarsus);
      // The wave: a leg lifts when its phase in the gait cycle comes round.
      const wave = walking && frac(prevGait + leg.gaitOff) > frac(this.gait + leg.gaitOff);
      const urgent = off > leg.reach * 0.6 || twist > 0.9 || stretch > 0.97;
      const settle = !walking && (off > leg.reach * 0.3 || twist > 0.5);
      if ((wave || urgent || settle) && stepping < 7) {
        const target = add(rest, vdir, walking ? STRIDE * 0.55 : 0);
        leg.from = [...leg.foot];
        leg.to = nearestNode(this.world, target, 12) || target;
        leg.step = 0;
        leg.stepDur = walking ? Math.max(0.11, Math.min(0.26, cycle * 0.38)) : 0.24;
        leg.lift = (walking ? 8 : 6) * SCALE;
        stepping++;
      }
    }
  }

  /** Rear of the abdomen, where silk leaves the body. */
  spinneret() {
    const a = this.abdomenFrame();
    return add(a.c, a.F, -ABDOMEN.RX);
  }

  /** Front of the cephalothorax (eyes, fangs, palps). */
  face() {
    return add(this.b, this.F, CEPH.OFF + CEPH.RX * 0.85);
  }
}
