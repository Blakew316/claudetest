/**
 * The crawler as the rest of the app sees it: the full-size simulation in
 * spider-sim.js, shrunk to SCALE in the world.
 *
 * The simulation keeps its own full-size units (every stride, lift, dip and
 * speed in it is tuned at that size). This wrapper hands it a world scaled up
 * by 1/SCALE (footholds, travel, goals) and scales everything it reports back
 * down: run.spider, the silk anchors, and the fields and methods the renderer
 * reads (p, b, F/U/S, time, gait, legs[].hip/knee/ankle/tip, cephCenter(),
 * abdomenFrame(), face(), spinneret(), palpTap, breath, dip, feel), plus at(),
 * the spider as drawn between two steps.
 */

import { ABDOMEN as SIM_ABDOMEN, CEPH as SIM_CEPH, Spider as SpiderSim } from './spider-sim.js';

/** Size of the spider relative to the world (1 = the full-size build). */
export const SCALE = 0.5;
export const ABDOMEN = { RX: SIM_ABDOMEN.RX * SCALE, RY: SIM_ABDOMEN.RY * SCALE, RZ: SIM_ABDOMEN.RZ * SCALE };
export const CEPH = { RX: SIM_CEPH.RX * SCALE, RY: SIM_CEPH.RY * SCALE, RZ: SIM_CEPH.RZ * SCALE, OFF: SIM_CEPH.OFF * SCALE };

const K = 1 / SCALE;
const up = (v) => [v[0] * K, v[1] * K, v[2] * K];
const down = (v, out = [0, 0, 0]) => {
  out[0] = v[0] * SCALE;
  out[1] = v[1] * SCALE;
  out[2] = v[2] * SCALE;
  return out;
};
const copy = (v, out) => {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
  return out;
};
const mix = (a, b, t, out) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};
const unit = (v) => {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= L;
  v[1] /= L;
  v[2] /= L;
  return v;
};

const POINTS = ['p', 'b', 'v', 'cC', 'fC', 'sC', 'aC'];
const AXES = ['F', 'U', 'S', 'aF', 'aU', 'aS'];
const JOINTS = ['hip', 'knee', 'ankle', 'tip', 'foot'];

/** What the renderer reads, at world scale (cC/fC/sC: cephalothorax centre, face, spinneret; a*: abdomen frame). */
function pose(legs) {
  const o = { time: 0, taut: 0, jolt: 0, air: 0, crouch: 0, palpTap: [0, 0], legs: Array.from({ length: legs }, () => Object.fromEntries(JOINTS.map((j) => [j, [0, 0, 0]]))) };
  for (const k of [...POINTS, ...AXES]) o[k] = [0, 0, 0];
  return o;
}

/** The world as the simulation sees it: footholds scaled up; built once per world. */
function simWorld(world) {
  if (!world) return null;
  if (!world._simWorld) {
    const src = world._footholds || new Float32Array(0);
    const f = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) f[i] = src[i] * K;
    world._simWorld = { _footholds: f };
  }
  return world._simWorld;
}

export class Spider {
  /**
   * @param {number[]} p start position [x, y, z] in the world
   * @param {number} seed
   * @param {import('../core/contracts.js').World} [world]
   */
  constructor(p, seed = 1, world = null) {
    this.sim = new SpiderSim(up(p), seed, simWorld(world));
    this.simRun = { t: 0, silkSection: 0, travel: null, spiderGoal: { x: 0, y: 0, z: 0 }, spider: { arrived: false }, silk: [] };
    this.lastTravel = null;
    this.taut = 0; // the dragline pulled taut by a leap, eased so it never snaps slack
    this.hit = 0; // a landing's impact (0..1) and the time since, for the camera's jolt
    this.hitAge = 9;
    this.p = [0, 0, 0];
    this.b = [0, 0, 0];
    this.legs = this.sim.legs.map(() => ({ hip: [0, 0, 0], knee: [0, 0, 0], ankle: [0, 0, 0], tip: [0, 0, 0], foot: [0, 0, 0] }));
    // The last two steps, and the spider as drawn between them (see at()).
    const n = this.legs.length;
    this.prev = pose(n);
    this.cur = pose(n);
    const d = (this.drawn = pose(n));
    d.cephCenter = () => [...d.cC];
    d.face = () => [...d.fC];
    d.spinneret = () => [...d.sC];
    d.abdomenFrame = () => ({ c: [...d.aC], F: d.aF, U: d.aU, S: d.aS });
    this.sync();
    this.capture(this.prev);
  }

  /** Advance one step: translate run into the simulation's units and its results back. */
  update(dt, run) {
    const r = this.simRun;
    r.t = run.t;
    r.silkSection = run.silkSection;
    const tr = run.travel;
    if (tr !== this.lastTravel) {
      this.lastTravel = tr;
      r.travel = tr ? { ...tr, from: up(tr.from), to: up(tr.to), apex: tr.apex * K } : null;
    }
    const g = run.spiderGoal;
    r.spiderGoal.x = g.x * K;
    r.spiderGoal.y = g.y * K;
    r.spiderGoal.z = (g.z ?? 0) * K;
    r.spider.arrived = run.spider.arrived;
    r.silk.length = 0;
    [this.prev, this.cur] = [this.cur, this.prev];
    this.sim.update(dt, r);
    const flying = this.sim.mode === 'jump' && this.sim.launched && !this.sim.abseil;
    if (this.sim.mode === 'land' && this.wasFlying) {
      const v = this.sim.landV;
      this.hit = Math.min(1, Math.hypot(v[0], v[1], v[2]) / 110);
      this.hitAge = 0;
    } else this.hitAge += dt;
    this.wasFlying = flying;
    this.taut += ((flying ? 1 : 0) - this.taut) * (1 - Math.exp(-(flying ? 8 : 2.5) * dt));
    const s = r.spider;
    run.spider.x = s.x * SCALE;
    run.spider.y = s.y * SCALE;
    run.spider.z = s.z * SCALE;
    run.spider.vx = s.vx * SCALE;
    run.spider.vy = s.vy * SCALE;
    run.spider.vz = s.vz * SCALE;
    run.spider.heading = s.heading;
    run.spider.arrived = s.arrived;
    for (const a of r.silk) {
      run.silk.push({ ...a, x: a.x * SCALE, y: a.y * SCALE, z: a.z * SCALE });
      if (run.silk.length > 500) run.silk.shift();
    }
    this.sync();
  }

  /** Copy the simulation's state out at world scale (in place: no allocation per frame). */
  sync() {
    const m = this.sim;
    down(m.p, this.p);
    down(m.b, this.b);
    this.F = m.F;
    this.U = m.U;
    this.S = m.S;
    this.time = m.time;
    this.gait = m.gait;
    this.palpTap = m.palpTap;
    this.breath = m.breath;
    this.dip = m.dip;
    this.feel = m.feel;
    m.legs.forEach((l, i) => {
      const o = this.legs[i];
      down(l.hip, o.hip);
      down(l.knee, o.knee);
      down(l.ankle, o.ankle);
      down(l.tip, o.tip);
      down(l.foot, o.foot);
    });
    this.capture(this.cur);
  }

  /** Record this step's drawn state into `o`. */
  capture(o) {
    const m = this.sim;
    down(m.p, o.p);
    down(m.b, o.b);
    down(m.v, o.v);
    copy(m.F, o.F);
    copy(m.U, o.U);
    copy(m.S, o.S);
    down(m.cephCenter(), o.cC);
    down(m.face(), o.fC);
    down(m.spinneret(), o.sC);
    const a = m.abdomenFrame();
    down(a.c, o.aC);
    copy(a.F, o.aF);
    copy(a.U, o.aU);
    copy(a.S, o.aS);
    o.time = m.time;
    o.air = m.mode === 'jump' && m.launched ? 1 : 0; // off the web (leaping or abseiling)
    o.crouch = m.mode === 'jump' && !m.launched ? 1 : 0; // aiming and winding up a leap
    o.taut = this.taut;
    o.jolt = -this.hit * Math.exp(-7 * this.hitAge) * Math.sin(38 * this.hitAge);
    o.palpTap[0] = m.palpTap[0];
    o.palpTap[1] = m.palpTap[1];
    m.legs.forEach((l, i) => {
      for (const j of JOINTS) down(l[j], o.legs[i][j]);
    });
  }

  /**
   * The spider as drawn `alpha` (0..1) of the way from the previous step to the
   * latest. The simulation runs at a fixed 60 Hz; drawing in between keeps the
   * motion smooth on faster or uneven displays instead of stepping. Same fields
   * and methods the renderer uses on the spider itself; the simulation is untouched.
   */
  at(alpha) {
    const a = this.prev;
    const c = this.cur;
    const d = this.drawn;
    for (const k of POINTS) mix(a[k], c[k], alpha, d[k]);
    for (const k of AXES) unit(mix(a[k], c[k], alpha, d[k]));
    d.time = a.time + (c.time - a.time) * alpha;
    d.air = c.air;
    d.crouch = c.crouch;
    d.taut = a.taut + (c.taut - a.taut) * alpha;
    d.jolt = a.jolt + (c.jolt - a.jolt) * alpha;
    d.palpTap[0] = a.palpTap[0] + (c.palpTap[0] - a.palpTap[0]) * alpha;
    d.palpTap[1] = a.palpTap[1] + (c.palpTap[1] - a.palpTap[1]) * alpha;
    d.legs.forEach((l, i) => {
      for (const j of JOINTS) mix(a.legs[i][j], c.legs[i][j], alpha, l[j]);
    });
    return d;
  }

  cephCenter() {
    return down(this.sim.cephCenter());
  }

  abdomenFrame() {
    const a = this.sim.abdomenFrame();
    a.c = down(a.c);
    return a;
  }

  face() {
    return down(this.sim.face());
  }

  spinneret() {
    return down(this.sim.spinneret());
  }
}
