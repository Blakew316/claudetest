/**
 * The crawler, simulated in 3D (src/world/view3d.js draws it).
 *
 * Anatomy: a cephalothorax carrying 16 three-segment legs (femur, tibia,
 * tarsus; 8 a side, front and rear pairs longest), a waist, and an abdomen
 * that swings behind on its own lag, spinnerets at its tip.
 *
 * Movement alternates between:
 *  - jump (between sections, run.travel): crouch, launch on a dragline, a
 *    floaty ballistic arc with the legs streaming behind and swinging forward
 *    to catch in the last quarter, a landing that absorbs the impact, grabs
 *    the stars and settles the feet with a short shuffle. The first travel is
 *    an abseil: a slow descent on the dragline with the legs hanging gathered
 *    under the body, opening to reach for footholds just before contact.
 *  - crawl (inside a section): purposeful walks alternate with pauses. Walking,
 *    the legs step in a ripple along each side (a metachronal wave) that runs
 *    the way the feet drift past the body, so a foot always lands behind a
 *    neighbour that has already stepped. Pausing, the body lowers and shifts
 *    its weight, the front pair lift one after the other to feel the air and
 *    tap the stars ahead, the palps twitch, the abdomen breathes. Each silk
 *    anchor is a dab: the abdomen dips toward it.
 *
 * Legs never cross: every leg swings in its own vertical plane through its
 * hip (the knee bends up within it), and the planes are kept in order around
 * the body with air between them. Footholds are stars picked to respect that
 * order, never shared, level with the stance; a leg whose neighbours leave no
 * room waits a beat; poses off the web are blended as angles, so a fan in
 * order stays in order. Heading turns (yaw and pitch) through eased turn
 * rates, so it never snaps.
 *
 * Read by the renderer: p, b, F/U/S, time, gait, legs[].hip/knee/ankle/tip,
 * cephCenter(), abdomenFrame(), face(), spinneret(); also exposed for it:
 * palpTap [left, right], breath, dip, feel, pose, behaviour.
 *
 * update() writes run.spider (incl. `arrived`) and appends silk anchors.
 *
 * Everything here is in full-size units; spider.js wraps it to draw the
 * spider at SCALE in the world (so these tuned numbers never need touching).
 */

import { LEG_COUNT } from '../core/contracts.js';
import { fork, range } from '../core/rng.js';

export const ABDOMEN = { RX: 20, RY: 15.5, RZ: 12.5 };
export const CEPH = { RX: 11, RY: 9.5, RZ: 7, OFF: 9 };
const SILK_CAP = 500;
const SILK_EVERY = 40;
const CELL = 30;
const STRIDE = 28; // sim units of body travel per gait cycle: about half a leg length, as a real spider strides
const CRUISE = 52; // walking speed, sim units/s (26 in the world at SCALE 0.5)
const MAX_TURN = 0.7; // rad/s
const MAX_TILT = 1.05;
const MAX_TILT_AIR = 0.9;
// Touchdown to walking on (s): the hero's three-point landing (the impact, a held kneel, the rise:
// see ironman.js), the body's compress, rebound and settle taking the first LAND_ABSORB of it.
export const LAND_TIME = 1.9;
const LAND_ABSORB = 0.6;
const PUSH_TIME = 0.1; // the rear legs stay planted this long after launch, extending as they push off
const LET_GO = 0.5; // a foot letting go of its star still lags the body by this share of the body's speed
const IMPACT = 0.08; // a landing's kick to the body and abdomen is spread over this long
const BRAKE = 0.25; // stopping to crouch, it brakes out of its walk over this long
const WAVE = 0.53; // gait phase lag between neighbouring legs on a side: an alternating tetrapod (L1 R2 L3 R4 / R1 L2 R3 L4) with a slight ripple
const FOOT_GAP = 7; // two feet never closer than this
const STAND = 0.15; // a foot that has just come down stands at least this long before it lifts again (unless it must)
const TURN_ARM = 28; // turning in place advances the gait as if walking this radius
const TAP_TIME = 0.46;
const LEG_SCALE = [1.24, 1.08, 0.94, 1.16]; // legs I..IV: I and IV longest, III shortest, as in a real spider
const UP = [0, 1, 0];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ease = (u) => u * u * (3 - 2 * u);
/** Minimum-jerk 0..1 (no jump in speed or acceleration at either end): how a limb reaches. */
const minJerk = (u) => u * u * u * (10 + u * (6 * u - 15));
/** 0 below a, 1 above b, eased between (a < b). */
const smooth = (a, b, x) => ease(clamp((x - a) / (b - a), 0, 1));
const frac = (x) => x - Math.floor(x);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Rotate v about a unit axis k by angle a (Rodrigues). */
const rotate = (v, k, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
};
const zeroPose = () => ({ lower: 0, shiftF: 0, shiftS: 0, pitch: 0, roll: 0 });

/** Grid of footholds (stars), falling back to cloud particles; built once per world. */
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

/** Call fn(x, y, z, d2) for every foothold within r of p. */
function eachNode(world, p, r, fn) {
  const grid = nodeGrid(world);
  const [x, y, z] = p;
  const r2 = r * r;
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
    for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const cell = grid.get(`${cx},${cy},${cz}`);
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 3) {
          const d = (cell[k] - x) ** 2 + (cell[k + 1] - y) ** 2 + (cell[k + 2] - z) ** 2;
          if (d < r2) fn(cell[k], cell[k + 1], cell[k + 2], d);
        }
      }
}

/** Nearest foothold to p within radius r, or null. */
function nearestNode(world, p, r) {
  if (!world) return null;
  let best = null;
  let bd = Infinity;
  eachNode(world, p, r, (x, y, z, d) => {
    if (d < bd) {
      bd = d;
      best = [x, y, z];
    }
  });
  return best;
}

export class Spider {
  /**
   * @param {number[]} p start position [x, y, z]
   * @param {number} seed
   * @param {import('../core/contracts.js').World} [world] stars the feet grip
   */
  constructor(p, seed = 1, world = null) {
    const rand = fork(seed, 'spider');
    this.rand = fork(seed, 'gait');
    this.world = world;
    this.p = [...p]; // travel position
    this.b = [...p]; // body position incl. bob, sway, crouch and weight shift
    this.v = [0, 0, 0];
    // Heading frame (where it is going): yaw and pitch, each turning at a smoothed rate...
    this.yaw = Math.atan2(0.3, 1);
    this.pitch = 0;
    this.yawV = 0;
    this.pitchV = 0;
    this.yawA = 0;
    this.pitchA = 0;
    this.heading();
    // ...and the body frame drawn on screen: the heading tilted by the pose (pitch, roll).
    this.F = [...this.hF];
    this.U = [...this.hU];
    this.S = [...this.hS];
    this.aF = [...this.F]; // abdomen direction, lags behind F
    this.aD = [...this.F]; // ...as drawn: plus breathing and silk dabs
    this.aL = [1, 0, 0]; // aD in the body frame (F, U, S), and its rate
    this.aLV = [0, 0, 0];
    this.time = 0;
    this.mode = 'crawl';
    /** What it is doing, for anyone who wants to show it: pause, walk, settle, crouch, air, abseil, land. */
    this.behaviour = 'pause';
    this.travelId = null;
    this.jumps = 0;
    this.launched = false;
    this.abseil = false;
    this.abKick = 0; // abdomen swing from launch and landing (rad, + is down), a damped spring
    this.abKickV = 0;
    this.impact = null; // a landing's kick, delivered over the few frames the legs take the load
    this.airU = 0;
    this.speed = 0;
    this.speedV = 0;
    this.gaitAmp = 0; // 0..1 how strongly the walk rocks the body, eased so it never pops
    this.gaitAmpV = 0;
    this.coastV = [0, 0, 0]; // walking velocity it brakes out of when it stops to crouch
    this.speedT = 0; // the speed it means to go, eased so it never surges at once
    this.goalN = null; // direction to the goal as it steers by it, eased so a new waypoint never kinks the path
    this.turnCap = 0; // turn-rate limit, eased so turns lean in and straighten out with the walk
    this.walking = false;
    this.intentT = 0.3;
    this.pauseT = 0;
    this.feelAt = [Infinity, Infinity];
    this.feelEnd = 0;
    this.shiftT = 0;
    this.settleT = 0;
    this.shuffle = null;
    this.gait = 0;
    this.rock = 0; // phase the body rocks to: the gait's while crawling, coasting on after
    this.rockRate = 0;
    this.loco = 0;
    this.waveRev = [false, false]; // per side: ripple runs rear to front (feet drifting forward past the body)
    this.travel = 0;
    this.meander = rand() * 10;
    /** Body pose offsets (world units / radians): lower, shiftF, shiftS, pitch (nose up), roll. */
    this.pose = zeroPose();
    this.poseV = zeroPose();
    this.poseT = zeroPose();
    this.poseS = zeroPose(); // poseT as the springs chase it (eased in the crawl)
    /** Palp flick per side [left, right], same scale as the renderer's idle palp tap (about +-0.35, twitches to +-0.9). */
    this.palpTap = [0, 0];
    this.palpTw = [0, 0];
    this.palpTwV = [0, 0];
    this.palpKick = [0, 0];
    this.palpKickT = [0, 0];
    this.palpNext = [0.4, 0.7];
    this.palpAmp = 0.18;
    this.breathAmp = 1;
    /** Abdomen scale to breathe with (matches the renderer's own breath). */
    this.breath = 1;
    /** 0..1 how far the abdomen is dipped toward the newest silk anchor. */
    this.dip = 0;
    this.dipT = 9;
    this.dipAt = null;
    /** 0..1 how raised the front pair are, feeling the air. */
    this.feel = 0;
    this.landOff = [0, 0, 0];
    this.landV = [0, 0, 0];
    this.legs = [];
    const perSide = LEG_COUNT / 2;
    for (const side of [-1, 1]) {
      for (let k = 0; k < perSide; k++) {
        const u = k / (perSide - 1); // 0 front .. 1 rear
        const reach = 60 * LEG_SCALE[k % LEG_SCALE.length] * range(rand, 0.96, 1.04);
        this.legs.push({
          side,
          k,
          hipAng: side * (0.6 + u * 1.65),
          // Rear legs splay out to the side so they clear the abdomen.
          restAng: side * (0.36 + u * 1.85 + (rand() - 0.5) * 0.05),
          reach,
          femur: reach * 0.44,
          tibia: reach * 0.42,
          tarsus: reach * 0.26,
          phase: rand() * Math.PI * 2,
          mode: 'plant', // plant | step | feel | air
          due: false, // its beat in the ripple came; it steps as soon as its neighbours leave room
          foot: [0, 0, 0],
          from: [0, 0, 0],
          to: [0, 0, 0],
          step: 1,
          stepDur: 0.2,
          lift: 6,
          carry: [0, 0, 0], // the foot's speed as its step began, times the step's duration
          footV: [0, 0, 0], // foot velocity over the last frame (from last, the foot a frame ago)
          last: null,
          planted: -1, // when the foot last came down
          rel: [0, 0, 0], // foot in the body frame, for air and feel
          relV: [0, 0, 0],
          launchAng: null, // pose (angles) it left the web in
          airT: 0,
          airy: 0,
          bend: null,
          feelT: 0,
          tapT: 0,
          tapNext: 0.6,
          tapTo: null,
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
    const F = this.aD;
    const U = norm(add(this.U, F, -dot(this.U, F)));
    const S = norm(cross(F, U));
    return { c: add(waist, F, -ABDOMEN.RX * 0.86), F, U, S };
  }

  /** Hip (on the drawn body) and rest foot (from the heading, ignoring bob and weight shift) of a leg. */
  legFrame(leg) {
    const { F, S, hF, hU, hS } = this;
    const c = this.cephCenter();
    const hx = Math.cos(leg.hipAng) * CEPH.RX * 0.85;
    const hz = Math.sin(leg.hipAng) * CEPH.RY * 0.85;
    const hip = add(add(c, F, hx), S, hz);
    const dir = add(scale(hF, Math.cos(leg.restAng)), hS, Math.sin(leg.restAng));
    const hip0 = add(add(this.p, hF, CEPH.OFF + hx), hS, hz);
    const rest = add(add(hip0, dir, leg.reach * 0.8), hU, -leg.reach * 0.36);
    return { hip, rest, dir };
  }

  /** Body-frame (F, U, S about the cephalothorax) foot of a leg held at azimuth a, elevation el, extension ext. */
  poseLocal(leg, a, el, ext) {
    const L = (leg.femur + leg.tibia + leg.tarsus) * ext;
    const ce = Math.cos(el);
    return [Math.cos(leg.hipAng) * CEPH.RX * 0.85 + Math.cos(a) * ce * L, Math.sin(el) * L, Math.sin(leg.hipAng) * CEPH.RY * 0.85 + Math.sin(a) * ce * L];
  }

  toWorld(l) {
    return add(add(add(this.cephCenter(), this.F, l[0]), this.U, l[1]), this.S, l[2]);
  }

  toLocal(q) {
    const d = sub(q, this.cephCenter());
    return [dot(d, this.F), dot(d, this.U), dot(d, this.S)];
  }

  /*
   * Poses off the web are held as angles from the hip, [azimuth (0 ahead,
   * PI behind), elevation, extension], and blended as angles: two fans that
   * are in order stay in order all the way between them, so no leg ever
   * sweeps through a neighbour.
   */

  /**
   * Streaming behind in flight: the fan sweeps back, more so toward the rear,
   * front legs riding high and rear legs low, so every leg keeps clear air
   * between its neighbours (and the rear pair clear of the abdomen).
   */
  trailPose(leg) {
    const u = leg.k / (LEG_COUNT / 2 - 1);
    const t = this.time;
    const a0 = Math.abs(leg.restAng);
    return [
      a0 + (0.3 + 0.35 * u) * (2.45 - a0) + Math.sin(t * 4.6 - leg.k * 0.45 + leg.side) * 0.03,
      0.55 - 1.1 * u + Math.sin(t * 3.7 - leg.k * 0.5 + leg.side) * 0.04,
      0.9,
    ];
  }

  /** Aiming before a leap: the forelegs raised and held out toward the target. */
  aimPose(leg) {
    return [Math.abs(leg.restAng) * 0.7, 0.35 + Math.sin(this.time * 2.6 + leg.phase) * 0.03, 0.85];
  }

  /** In flight, legs I and II reach ahead toward the landing. */
  reachPose(leg) {
    return [Math.abs(leg.restAng) * 0.75, 0.2 - 0.25 * leg.k + Math.sin(this.time * 3.3 + leg.phase) * 0.03, 0.92];
  }

  /** Reaching to catch: spread forward and down, each leg toward its own foothold. */
  catchPose(leg) {
    return [Math.abs(leg.restAng) * 0.92, -0.55 + Math.sin(this.time * 3 + leg.phase) * 0.03, 0.92];
  }

  /** Dangling on the dragline: legs gathered under the body, knees out, swaying a little. */
  hangPose(leg) {
    return [Math.abs(leg.restAng) * 0.94 + 0.04, -1.0 + Math.sin(this.time * 1.7 + leg.k * 0.35 + leg.side) * 0.04, 0.58 + Math.sin(this.time * 1.1 + leg.phase) * 0.02];
  }

  /** Angles of a body-frame foot position from the leg's hip. */
  anglesOf(leg, rel) {
    const d = [rel[0] - Math.cos(leg.hipAng) * CEPH.RX * 0.85, rel[1], rel[2] - Math.sin(leg.hipAng) * CEPH.RY * 0.85];
    const L = len(d) || 1e-3;
    return [Math.atan2(d[2] * leg.side, d[0]), Math.asin(clamp(d[1] / L, -1, 1)), L / (leg.femur + leg.tibia + leg.tarsus)];
  }

  /** Where a leg in the air wants its foot (body frame). */
  airTarget(leg, dt) {
    let ang;
    if (this.mode !== 'jump') ang = this.hangPose(leg);
    else if (!this.launched) ang = this.aimPose(leg);
    else if (this.abseil) ang = lerp3(this.hangPose(leg), this.catchPose(leg), smooth(0.62, 0.9, this.airU));
    // A jumping spider flies forelegs first: I and II reach ahead the whole way,
    // III and IV, having driven the jump, stream behind and swing forward to land.
    else if (leg.k < 2) ang = lerp3(this.reachPose(leg), this.catchPose(leg), smooth(0.6, 0.9, this.airU));
    else ang = lerp3(this.trailPose(leg), this.catchPose(leg), smooth(0.58, 0.9, this.airU));
    // Leaving the web, each leg swings from where its foot was into the flight pose.
    leg.airT += dt;
    if (leg.launchAng) ang = lerp3(leg.launchAng, ang, ease(clamp(leg.airT / 0.4, 0, 1)));
    return this.poseLocal(leg, leg.side * ang[0], ang[1], ang[2]);
  }

  /** A front leg raised, feeling the air ahead, now and then tapping a star. */
  feelTarget(leg, dt) {
    leg.feelT += dt;
    const t = this.time;
    const ph = leg.phase;
    const raise = ease(clamp(leg.feelT / 0.55, 0, 1));
    const a = 0.22 + 0.07 * Math.sin(t * 1.25 + ph);
    const el = -0.42 + raise * (0.55 + 0.08 * Math.sin(t * 2.3 + ph * 1.7) + 0.03 * Math.sin(t * 5.9 + ph));
    const ext = 0.8 + 0.05 * Math.sin(t * 1.6 + ph * 0.6);
    let target = this.poseLocal(leg, leg.side * a, el, ext);
    leg.tapNext -= dt;
    if (leg.tapNext <= 0 && leg.tapT <= 0 && leg.feelT > 0.7) {
      leg.tapT = TAP_TIME;
      leg.tapNext = range(this.rand, 0.7, 1.5);
      const probe = this.toWorld(this.poseLocal(leg, leg.side * 0.28, -0.38, 0.88));
      leg.tapTo = this.toLocal(nearestNode(this.world, probe, 9) || probe);
    }
    if (leg.tapT > 0) {
      leg.tapT = Math.max(0, leg.tapT - dt);
      const e = Math.sin(Math.PI * (1 - leg.tapT / TAP_TIME));
      target = lerp3(target, leg.tapTo, e * e);
    }
    return target;
  }

  /** Body-frame foot springs toward its pose: smooth, critically damped, carried along with the body. */
  followPose(leg, dt) {
    // Still pushing off: the foot stays on its star while the body leaves, the leg extending,
    // until the push is spent or the leg is at full stretch (it lets go, never dragged off).
    if (leg.holdT > 0) {
      const rel = this.toLocal(leg.foot);
      const drift = scale(sub(rel, leg.rel), 1 / dt); // the star sliding back past the body
      const full = leg.femur + leg.tibia + leg.tarsus;
      leg.holdT = len(sub(leg.foot, this.legFrame(leg).hip)) > 0.95 * full ? 0 : leg.holdT - dt;
      if (leg.holdT > 0) {
        leg.rel = rel;
        leg.relV = [0, 0, 0];
        leg.airT = 0;
        leg.launchAng = this.anglesOf(leg, rel); // so it swings into flight from where it let go
        return;
      }
      // Letting go, the foot is pulled after the body over a few frames, not all in one.
      leg.relV = scale(drift, LET_GO);
    }
    const target = leg.mode === 'feel' ? this.feelTarget(leg, dt) : this.airTarget(leg, dt);
    const k = leg.mode === 'feel' ? 70 : 45;
    const c = 2 * Math.sqrt(k);
    for (let j = 0; j < 3; j++) {
      leg.relV[j] += ((target[j] - leg.rel[j]) * k - leg.relV[j] * c) * dt;
      leg.rel[j] += leg.relV[j] * dt;
    }
    leg.foot = this.toWorld(leg.rel);
  }

  /** Let go of the silk: the foot is carried in the body frame from where it is. */
  release(leg, push = [0, 0, 0]) {
    leg.rel = this.toLocal(leg.foot);
    leg.relV = [...push];
    leg.launchAng = this.anglesOf(leg, leg.rel);
    leg.airT = 0;
    leg.mode = 'air';
    leg.step = 1;
    leg.due = false;
  }

  plantAll() {
    this.frame();
    let found = 0;
    for (const leg of this.legs) leg.mode = 'air'; // not holding anything yet: no constraint on neighbours
    for (const leg of this.legs) {
      const { rest } = this.legFrame(leg);
      const n = this.pickFoothold(leg, rest, 16);
      leg.foot = n || [...rest];
      leg.mode = 'plant';
      leg.step = 1;
      if (this.picked) found++;
    }
    // Nothing to stand on (it starts in the void above the first cluster): hang.
    if (this.world && found < this.legs.length / 2) {
      for (const leg of this.legs) {
        const [a, el, ext] = this.hangPose(leg);
        leg.rel = this.poseLocal(leg, leg.side * a, el, ext);
        leg.relV = [0, 0, 0];
        leg.mode = 'air';
        leg.airy = 1;
        leg.foot = this.toWorld(leg.rel);
      }
    }
    this.solve(0);
  }

  /**
   * Choose a star for a foot near target: never one another foot holds or is
   * stepping to, always between its neighbours around the body, below the hip
   * and within reach. Falls back to the target itself, kept in order.
   */
  pickFoothold(leg, target, r) {
    const { hU } = this;
    const hip = this.legFrame(leg).hip;
    const h0 = this.hip0(leg);
    const full = leg.femur + leg.tibia + leg.tarsus;
    let [lo, hi] = this.window(leg);
    if (lo >= hi) {
      // Neighbours crowd in: the only place left is the middle between them.
      const mid = (lo + hi) / 2;
      lo = mid - 0.03;
      hi = mid + 0.03;
    }
    const held = [];
    for (const o of this.legs) if (o !== leg && (o.mode === 'plant' || o.mode === 'step')) held.push(o.mode === 'step' ? o.to : o.foot);
    let best = null;
    let bs = Infinity;
    const gap2 = FOOT_GAP * FOOT_GAP;
    if (this.world) {
      eachNode(this.world, target, r, (x, y, z, d2) => {
        // Prefer stars level with where the foot was meant to go: legs keep an even stance.
        const q = [x, y, z];
        const dv = dot(sub(q, target), hU);
        d2 += 1.5 * dv * dv;
        if (d2 >= bs) return;
        const a = this.legAz(leg, q, h0);
        if (a < lo || a > hi) return;
        const hv = sub(q, hip);
        if (dot(hv, hU) > -leg.reach * 0.1) return;
        const dl = len(hv);
        if (dl > full * 0.94 || dl < leg.reach * 0.5) return;
        for (const o of held) if ((o[0] - x) ** 2 + (o[1] - y) ** 2 + (o[2] - z) ** 2 < gap2) return;
        bs = d2;
        best = q;
      });
    }
    this.picked = !!best;
    if (best) return best;
    // No star: stand on the target, swung back between the neighbours if it strayed.
    const a = this.legAz(leg, target, h0);
    const fix = a < lo ? lo - a : a > hi ? hi - a : 0;
    if (!fix) return null;
    return add(h0, rotate(sub(target, h0), hU, -fix * leg.side));
  }

  /**
   * The azimuths (from its hip) a leg's foot may take: each leg swings in its
   * own vertical plane, and keeping those planes in order, with air between,
   * keeps the legs from ever crossing. Closed (lo >= hi) when a neighbour has
   * to move first.
   */
  window(leg) {
    const base = leg.side < 0 ? 0 : LEG_COUNT / 2;
    const margin = (o) => (o.mode === 'feel' ? 0.24 : 0.09);
    const prev = this.legs[base + leg.k - 1];
    const next = this.legs[base + leg.k + 1];
    const lo = leg.k > 0 ? this.footAz(prev) + margin(prev) : 0.08;
    const hi = leg.k < LEG_COUNT / 2 - 1 ? this.footAz(next) - margin(next) : 2.6;
    return [lo, hi];
  }

  /** Hip on the undisturbed body (heading frame, no bob or lean): the pivot of the leg's plane. */
  hip0(leg) {
    return add(add(this.p, this.hF, CEPH.OFF + Math.cos(leg.hipAng) * CEPH.RX * 0.85), this.hS, Math.sin(leg.hipAng) * CEPH.RY * 0.85);
  }

  /** Azimuth of point q seen from a leg's hip: 0 straight ahead, PI straight back, on the leg's own side. */
  legAz(leg, q, h0 = this.hip0(leg)) {
    const d = sub(q, h0);
    return Math.atan2(dot(d, this.hS) * leg.side, dot(d, this.hF));
  }

  /**
   * Turn the heading toward a direction: yaw about the vertical and pitch
   * within a tilt limit (so it never rolls over the top), each through a
   * turn rate that itself eases in and out, so nothing snaps.
   */
  orient(dir, dt, rate = 4, maxTilt = MAX_TILT, maxTurn = MAX_TURN) {
    const d = norm(dir);
    const flat = Math.hypot(d[0], d[2]);
    let yawErr = flat > 1e-4 ? wrap(Math.atan2(d[2], d[0]) - this.yaw) : 0;
    // Straight behind: keep turning the way it already is, rather than dithering.
    if (Math.abs(yawErr) > 2.8 && this.yawV * yawErr < 0) yawErr -= Math.sign(yawErr) * 2 * Math.PI;
    const pitchErr = clamp(Math.asin(clamp(d[1], -1, 1)), -maxTilt, maxTilt) - this.pitch;
    // Aimed near straight up or down, the bearing swings wildly at the least change: it stops yawing after it.
    let wy = rate * yawErr * smooth(0, 0.3, flat);
    let wp = rate * pitchErr;
    const wl = Math.hypot(wy, wp);
    if (wl > maxTurn) {
      wy *= maxTurn / wl;
      wp *= maxTurn / wl;
    }
    // The rates follow through a critically damped spring: a turn's angular
    // acceleration ramps up and down too, so it never starts or stops with a kick.
    const W = 14;
    this.yawA += ((wy - this.yawV) * W * W - this.yawA * 2 * W) * dt;
    this.pitchA += ((wp - this.pitchV) * W * W - this.pitchA * 2 * W) * dt;
    this.yawV += this.yawA * dt;
    this.pitchV += this.pitchA * dt;
    this.yaw = wrap(this.yaw + this.yawV * dt);
    this.pitch = clamp(this.pitch + this.pitchV * dt, -MAX_TILT - 0.05, MAX_TILT + 0.05);
    this.heading();
  }

  /** Heading frame from yaw and pitch; its up stays on the sky's side. */
  heading() {
    const cp = Math.cos(this.pitch);
    this.hF = [cp * Math.cos(this.yaw), Math.sin(this.pitch), cp * Math.sin(this.yaw)];
    const f = this.hF[1];
    this.hU = norm([-this.hF[0] * f, 1 - f * f, -this.hF[2] * f]);
    this.hS = norm(cross(this.hF, this.hU));
    // Angular velocity (world), for predicting where feet are carried.
    this.w = add(scale(UP, -this.yawV), this.hS, this.pitchV);
  }

  /** Body frame and position: the heading tilted by the pose, the body bobbing and shifting its weight. */
  frame() {
    const { hF, hU, hS, pose } = this;
    let F = rotate(hF, hS, pose.pitch);
    let U = rotate(hU, hS, pose.pitch);
    U = norm(rotate(U, F, pose.roll));
    F = norm(F);
    this.F = F;
    this.U = U;
    this.S = norm(cross(F, U));
    const { gaitAmp } = this;
    const bob = Math.sin(this.rock * Math.PI * 4) * 0.6 * gaitAmp + Math.sin(this.time * 1.9) * 0.35;
    const sway = Math.sin(this.rock * Math.PI * 2) * 0.7 * gaitAmp;
    // Walking it runs low, and surges a little with each push of its legs.
    const crouch = 1.4 * gaitAmp;
    const surge = Math.sin(this.rock * Math.PI * 4 + 0.8) * 0.5 * gaitAmp;
    this.b = add(add(add(this.p, hU, bob - pose.lower - crouch), hS, sway + pose.shiftS), hF, pose.shiftF + surge);
  }

  /** Joint positions: tarsus drops to the foot from the ankle (or carries on the leg's line in the air); femur+tibia by 2-bone IK. */
  solve(dt = 0) {
    const { U } = this;
    const blend = dt > 0 ? 1 - Math.exp(-28 * dt) : 1;
    const airyK = dt > 0 ? 1 - Math.exp(-8 * dt) : 1;
    // In flight the feet stream back off the ends of the legs, until they reach to catch.
    const drag = this.mode === 'jump' && this.launched && !this.abseil ? 0.55 * (1 - smooth(0.58, 0.9, this.airU)) : 0;
    for (const leg of this.legs) {
      const { hip } = this.legFrame(leg);
      leg.hip = hip;
      leg.airy += ((leg.mode === 'air' ? 1 : leg.mode === 'feel' ? 0.55 : 0) - leg.airy) * airyK;
      const foot = leg.foot;
      const rel = sub(foot, hip);
      const rl = len(rel) || 1e-3;
      const out = norm(add(rel, U, -dot(rel, U)));
      const drop = norm(add(scale(out, -0.45), U, 0.9));
      const line = norm(add(add(scale(rel, -1 / rl), U, 0.3), this.F, drag * leg.airy));
      leg.ankle = add(foot, norm(lerp3(drop, line, leg.airy)), leg.tarsus);
      let a = sub(leg.ankle, hip);
      let d = len(a) || 1e-3;
      // Near full reach femur and tibia ease to just short of straight (so the knee never
      // pops), and the tarsus tips to keep the foot on its star for as long as it can.
      const max = leg.femur + leg.tibia - 0.5;
      const soft = 3;
      if (d > max - soft) {
        const ds = max - soft * Math.exp((max - soft - d) / soft);
        // The ankle: ds from the hip, a tarsus from the foot, as near its own pose as it can.
        const n = scale(rel, 1 / rl);
        const x = (ds * ds - leg.tarsus ** 2 + rl * rl) / (2 * rl);
        const r2 = ds * ds - x * x;
        const c = add(hip, n, Math.min(x, ds));
        const w = sub(leg.ankle, c);
        // Out of reach it eases onto the line to the foot, rather than snapping onto it.
        const r = r2 > 1 ? Math.sqrt(r2) : Math.max(0, 0.5 + r2 / 2);
        leg.ankle = add(c, norm(add(w, n, -dot(w, n))), r);
        a = sub(leg.ankle, hip);
        d = len(a) || 1e-3;
      }
      const ax = scale(a, 1 / d);
      // Knee up, in the leg's own vertical plane (so it never strays into a neighbour's); eased so it never flips.
      let bend = add(U, ax, -dot(U, ax));
      if (len(bend) < 0.15 && leg.bend) bend = leg.bend;
      bend = norm(bend);
      if (leg.bend) {
        bend = lerp3(leg.bend, bend, blend);
        bend = norm(add(bend, ax, -dot(bend, ax)));
      }
      leg.bend = bend;
      const cosA = clamp((leg.femur ** 2 + d * d - leg.tibia ** 2) / (2 * leg.femur * d), -1, 1);
      const sinA = Math.sqrt(1 - cosA * cosA);
      leg.knee = add(add(hip, ax, leg.femur * cosA), bend, leg.femur * sinA);
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
    const prevF = [...this.hF];
    const tr = run.travel;
    if (tr && tr.id !== this.travelId) this.beginTravel(run, tr);

    if (this.mode === 'jump') this.jump(dt, run, tr);
    else if (this.mode === 'land') this.land(dt, run, tr);
    else this.crawl(dt, run);

    for (let i = 0; i < 3; i++) this.v[i] = (this.p[i] - prev[i]) / dt;
    const moved = len(sub(this.p, prev));
    const turn = Math.acos(clamp(dot(prevF, this.hF), -1, 1));

    // The walk rocks the body on the gait's phase, its strength easing in and out
    // (critically damped) so stopping to leap never pops the body. Leaving the crawl
    // the gait's tempo drops at once to the turning rate, so the rocking coasts down instead.
    const amp = this.mode === 'crawl' ? Math.min(1, this.speed / CRUISE) : 0;
    this.gaitAmpV += ((amp - this.gaitAmp) * 144 - this.gaitAmpV * 24) * dt;
    this.gaitAmp += this.gaitAmpV * dt;
    if (this.mode === 'crawl') {
      this.rockRate = (this.gait - this.rock) / dt;
      this.rock = this.gait;
    } else {
      this.rockRate *= Math.exp(-4 * dt);
      this.rock += this.rockRate * dt;
    }
    if (this.impact) {
      // A landing's kick arrives as a short push while the legs load, not all in one step.
      const im = this.impact;
      const f = smooth(0, IMPACT, im.t + dt) - smooth(0, IMPACT, im.t);
      im.t += dt;
      this.poseV.pitch += im.pitch * f;
      this.poseV.lower += im.lower * f;
      this.abKickV += im.ab * f;
      if (im.t >= IMPACT) this.impact = null;
    }
    // Pose springs: crouching, weight shifts and leans ease in and out. In the crawl
    // the targets glide too, so a weight shift starts as gently as it ends.
    const chase = this.mode === 'crawl' ? 1 - Math.exp(-8 * dt) : 1;
    for (const key of Object.keys(this.pose)) {
      const k = 14;
      this.poseS[key] += (this.poseT[key] - this.poseS[key]) * chase;
      this.poseV[key] += ((this.poseS[key] - this.pose[key]) * k - this.poseV[key] * 2 * Math.sqrt(k)) * dt;
      this.pose[key] += this.poseV[key] * dt;
    }
    this.frame();
    this.abdomen(dt);
    this.palps(dt);
    this.legsUpdate(dt, run, turn);
    this.solve(dt);
    this.feel = this.legs.reduce((s, l) => s + (l.mode === 'feel' ? ease(clamp(l.feelT / 0.55, 0, 1)) : 0), 0) / 2;

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
    run.spider.heading = Math.atan2(this.hF[2], this.hF[0]);
  }

  /** The abdomen trails the body, wags with the stride, breathes, and dips to dab each silk anchor. */
  abdomen(dt) {
    const wag = rotate(this.F, this.U, Math.sin(this.time * 1.3) * 0.06 + Math.sin(this.rock * Math.PI * 2) * 0.08 * this.gaitAmp);
    // It swings, but never so far that it brushes the rear legs: the further it
    // lags the harder it is drawn along, a soft stop rather than a jolt.
    const lag0 = Math.acos(clamp(dot(this.aF, this.F), -1, 1));
    const follow = (this.mode === 'jump' ? 3 : 5) * (1 + 6 * smooth(0.15, 0.25, lag0));
    this.aF = norm(lerp3(this.aF, wag, 1 - Math.exp(-follow * dt)));
    const lag = Math.acos(clamp(dot(this.aF, this.F), -1, 1));
    if (lag > 0.22) this.aF = norm(add(scale(this.F, Math.sin(lag - 0.22)), this.aF, Math.sin(0.22)));
    const Sa = norm(cross(this.aF, this.U));
    const breathe = Math.sin(this.time * 2.1);
    this.breath = 1 + 0.03 * breathe;
    this.breathAmp += ((this.walking ? 0.5 : 1) - this.breathAmp) * (1 - Math.exp(-4 * dt));
    // Inertia: launch and landing swing the abdomen down; it overshoots a little and settles.
    const KA = 70;
    this.abKickV += (-KA * this.abKick - 2 * 0.45 * Math.sqrt(KA) * this.abKickV) * dt;
    this.abKick = clamp(this.abKick + this.abKickV * dt, -0.3, 0.38);
    let aD = rotate(this.aF, Sa, 0.02 * breathe * this.breathAmp);
    this.dipT += dt;
    const t = this.dipT;
    this.dip = t < 0.16 ? ease(t / 0.16) : t < 0.3 ? 1 : 1 - smooth(0.3, 0.75, t);
    if (this.dip > 0 && this.dipAt) {
      const down = rotate(this.aF, Sa, 0.3);
      const toward = norm(sub(add(this.b, this.F, -1), this.dipAt));
      // Toward the anchor only while it lies behind, faded so the swing never snaps across.
      const goal = norm(lerp3(down, toward, 0.5 * smooth(0.35, 0.65, dot(toward, this.aF))));
      aD = norm(lerp3(aD, goal, this.dip * 0.8));
    }
    // It has mass: the drawn abdomen follows that pose (held relative to the body)
    // through a critically damped spring, so a fresh dab or a kick never snaps it.
    const l = [dot(aD, this.F), dot(aD, this.U), dot(aD, this.S)];
    for (let j = 0; j < 3; j++) {
      this.aLV[j] += ((l[j] - this.aL[j]) * 400 - this.aLV[j] * 40) * dt;
      this.aL[j] += this.aLV[j] * dt;
    }
    const a = norm(this.aL);
    const aw = norm(add(add(scale(this.F, a[0]), this.U, a[1]), this.S, a[2]));
    // The launch and landing swing rides on top: it is a spring of its own.
    this.aD = rotate(aw, norm(cross(aw, this.U)), this.abKick);
  }

  /** Palps flick now and then (more often while it stands and feels), over a slow idle sway. */
  palps(dt) {
    const still = this.mode === 'crawl' && !this.walking;
    // The sway calms as it stops and quickens as it sets off, never all at once.
    this.palpAmp += ((still ? 0.18 : 0.35) - this.palpAmp) * (1 - Math.exp(-4 * dt));
    for (let s = 0; s < 2; s++) {
      this.palpNext[s] -= dt;
      if (this.palpNext[s] <= 0) {
        this.palpKick[s] = (this.rand() < 0.5 ? -1 : 1) * range(this.rand, 0.25, 0.6) * (this.mode === 'crawl' ? 1 : 0.4);
        this.palpKickT[s] = range(this.rand, 0.07, 0.15);
        this.palpNext[s] = still ? range(this.rand, 0.25, 0.9) : range(this.rand, 0.7, 1.8);
      }
      if (this.palpKickT[s] > 0) {
        this.palpKickT[s] -= dt;
        if (this.palpKickT[s] <= 0) this.palpKick[s] = 0;
      }
      const K = 260;
      this.palpTwV[s] += ((this.palpKick[s] - this.palpTw[s]) * K - this.palpTwV[s] * 2 * 0.7 * Math.sqrt(K)) * dt;
      this.palpTw[s] += this.palpTwV[s] * dt;
      this.palpTap[s] = Math.sin(this.time * 3.1 + (s ? 1.4 : 0)) * this.palpAmp + this.palpTw[s];
    }
  }

  anchor(run) {
    const sp = this.spinneret();
    const n = nearestNode(this.world, sp, 18) || sp;
    run.silk.push({ x: n[0], y: n[1], z: n[2], s: run.silkSection, t: run.t });
    if (run.silk.length > SILK_CAP) run.silk.shift();
    this.dipAt = n;
    // A new dab while the last is still down carries on from where the abdomen is (on the dab's rise).
    this.dipT = this.dip > 0 ? 0.16 * (0.5 - Math.sin(Math.asin(clamp(1 - 2 * this.dip, -1, 1)) / 3)) : 0;
  }

  /** A new travel: drop whatever it was doing and get ready to jump (or, the first time, to abseil). */
  beginTravel(run, tr) {
    this.travelId = tr.id;
    this.midAir = this.mode === 'jump' && this.launched;
    this.coastV = this.mode === 'crawl' ? [...this.v] : [0, 0, 0];
    this.goalN = null;
    this.turnCap = 0;
    this.mode = 'jump';
    this.jumps++;
    // Only a travel with no crouch is an abseil; every other one is a real leap.
    this.abseil = tr.crouch < 0.02;
    this.launched = false;
    this.crouchAnchored = false;
    this.speed = 0;
    this.speedV = 0;
    this.speedT = 0;
    this.walking = false;
    this.shuffle = null;
    this.feelAt = [Infinity, Infinity];
    this.poseT = zeroPose();
    run.spider.arrived = false;
    for (const leg of this.legs) if (leg.mode === 'feel') this.startStep(leg, this.legFrame(leg).rest, 0.22, 2);
  }

  /**
   * Aim, crouch, launch, fly a floaty ballistic arc, land. Like a real
   * jumping spider it first pivots to face the target squarely, then sinks
   * with its forelegs raised, and leaps straight: no turning in the air.
   * Horizontal travel is linear in time and height parabolic; a lowered
   * gravity (high apex, long airtime) makes it float. The abseil instead
   * eases down the dragline, swinging a little.
   */
  jump(dt, run, tr) {
    const crouch = this.midAir ? 0 : tr.crouch;
    const aim = this.midAir ? 0 : Math.min(tr.aim || 0, crouch * 0.7);
    const T = run.t - tr.t0;
    let flat = [tr.to[0] - tr.from[0], 0, tr.to[2] - tr.from[2]];
    flat = Math.hypot(flat[0], flat[2]) > 4 ? norm(flat) : norm([this.hF[0], 0, this.hF[2]]);
    // It brakes out of its walk (velocity easing to rest) rather than stopping dead.
    const tb = Math.min(T + dt, BRAKE); // tr.from is where it stood a step ago
    const coast = scale(this.coastV, tb - (tb * tb) / BRAKE + tb ** 3 / (3 * BRAKE * BRAKE));
    if (T < aim) {
      // Aim: a quick pivot on the spot, feet stepping round, fast enough to be square-on in time.
      this.behaviour = 'aim';
      this.p = add(tr.from, coast);
      const off = Math.abs(wrap(Math.atan2(flat[2], flat[0]) - this.yaw));
      this.orient(flat, dt, 6, MAX_TILT, Math.max(1, (1.25 * off) / Math.max(0.1, aim - T)));
      return;
    }
    if (T < crouch) {
      this.behaviour = 'crouch';
      const k = ease((T - aim) / (crouch - aim));
      // Wind-up: sink deep, rock back over the rear legs, nose up a touch, and
      // a last quiver of tension just before the spring lets go.
      const quiver = Math.sin(T * 70) * 0.3 * smooth(0.7, 1, (T - aim) / (crouch - aim));
      this.p = add(add(tr.from, coast), this.hU, -(10 * k + quiver));
      this.orient(flat, dt, 6, MAX_TILT, 1.2); // settles any last few degrees of the aim
      // The forelegs come up and point at the target.
      if (!this.abseil) for (const leg of this.legs) if (leg.k === 0 && leg.mode === 'plant') this.release(leg);
      this.poseT.pitch = 0.16 * k;
      this.poseT.shiftF = -3.2 * k;
      if (!this.crouchAnchored && T > crouch * 0.4) {
        this.crouchAnchored = true;
        this.anchor(run);
      }
      return;
    }
    if (!this.launched) {
      this.launched = true;
      this.launchAt = [...this.p];
      this.poseT = zeroPose();
      if (!this.crouchAnchored && !this.abseil) this.anchor(run);
      const v0 = add(scale(sub(tr.to, this.launchAt), 1 / tr.air), UP, this.abseil ? 0 : (4 * tr.apex) / tr.air);
      const push = scale([dot(v0, this.F), dot(v0, this.U), dot(v0, this.S)], -0.12);
      for (const leg of this.legs) if (leg.mode !== 'air') this.release(leg, push);
      this.spreadLaunch();
      // Push-off: the rear legs keep their grip a moment and extend behind the body.
      if (!this.abseil) for (const leg of this.legs) if (leg.k >= 2) leg.holdT = PUSH_TIME * (0.8 + 0.2 * (leg.k - 2)); // legs III and IV drive the jump
      // The abdomen lags the launch and swings down.
      if (!this.abseil) this.impact = { t: 0, pitch: 0, lower: 0, ab: 3.2 }; // spread over the push, like a landing's
    }
    const u = Math.min(1, (T - crouch) / tr.air);
    this.airU = u;
    if (this.abseil) {
      this.behaviour = 'abseil';
      const h = (1 - Math.cos(Math.PI * u)) / 2;
      const side = norm(cross(flat, UP));
      const sway = Math.sin((T - crouch) * 2.1) * 5 * (1 - u) ** 1.5;
      this.p = add(lerp3(this.launchAt, tr.to, h), side, sway);
      // Nose tipped down while it hangs, levelling out to land.
      const pitch = -0.5 * (1 - smooth(0.4, 0.82, u));
      this.orient(add(scale(flat, Math.cos(pitch)), UP, Math.sin(pitch)), dt, 2.5, MAX_TILT_AIR);
    } else {
      this.behaviour = 'air';
      // A slight roll and correction in the air, as the dragline steadies it.
      this.poseT.roll = 0.07 * Math.sin(u * Math.PI * 2 + 0.6) * (1 - u);
      // Powered flight: away with the push's momentum, accelerating to the middle of
      // the leap and braking into the landing; height a low arc through the stars.
      const h = 0.35 * u + 0.65 * ease(u);
      this.p = add(lerp3(this.launchAt, tr.to, h), UP, tr.apex * 4 * u * (1 - u));
      // The dragline steadies the body, so it stays near level rather than tracking
      // its path like an arrow: nose a little up off the push, a little down to land
      // front feet first, and no turning (there is nothing to turn against).
      const across = Math.hypot(tr.to[0] - this.launchAt[0], tr.to[2] - this.launchAt[2]) || 1;
      const climb = Math.atan2(tr.to[1] - this.launchAt[1] + tr.apex * 4 * (1 - 2 * u), across);
      const land = smooth(0.6, 0.85, u);
      const pitch = clamp(climb * 0.3, -0.3, 0.3) * (1 - land) - 0.16 * land * (1 - smooth(0.93, 1, u));
      this.orient(add(scale(flat, Math.cos(pitch)), UP, Math.sin(pitch)), dt, 4, MAX_TILT_AIR, 0.6);
    }
    if (u >= 1) {
      this.touchDown(run, tr);
      // The step that touches down carries on past the arc's end at the speed it came in (not
      // stopping short at the end for a step, which would stall the body for a frame at contact).
      this.landOff = scale(this.landV, Math.max(0, T - crouch - tr.air));
      this.p = add(tr.to, this.landOff);
    }
  }

  /** Feet that pushed off bunched together fan apart as they rise, so the swing into flight starts in order. */
  spreadLaunch() {
    const per = LEG_COUNT / 2;
    for (const base of [0, per]) {
      const ang = (k) => this.legs[base + k].launchAng;
      if (this.legs.slice(base, base + per).some((l) => !l.launchAng)) continue;
      for (let k = 1; k < per; k++) ang(k)[0] = Math.max(ang(k)[0], ang(k - 1)[0] + 0.14);
      ang(per - 1)[0] = Math.min(ang(per - 1)[0], 2.45);
      for (let k = per - 2; k >= 0; k--) ang(k)[0] = Math.min(ang(k)[0], ang(k + 1)[0] - 0.14);
      // ...and level: a foot that pushed off from a star far below its neighbours' comes up into line.
      const el = Array.from({ length: per }, (_, k) => clamp(ang(k)[1], -0.75, -0.15));
      for (let k = 0; k < per; k++) {
        ang(k)[1] = (el[Math.max(0, k - 1)] + 2 * el[k] + el[Math.min(per - 1, k + 1)]) / 4;
        ang(k)[2] = clamp(ang(k)[2], 0.65, 0.95);
      }
    }
  }

  /** Contact: the incoming velocity goes into a damped spring the legs absorb; every foot grabs a star. */
  touchDown(run, tr) {
    this.mode = 'land';
    this.behaviour = 'land';
    this.landT = 0;
    const s = len(this.v);
    this.landOff = [0, 0, 0];
    this.landV = [...this.v]; // (all of it: a capped speed would halve a fast landing's in one step)
    // The impact: the nose dips, the body compresses, the abdomen swings on.
    const hit = clamp(s / 110, 0.4, 1);
    this.poseT = zeroPose();
    this.impact = { t: 0, pitch: -1.5 * hit, lower: 16 * hit, ab: 4.2 * hit };
    // Front legs touch first, then the rest in a quick ripple.
    const order = [];
    for (let k = 0; k < LEG_COUNT / 2; k++) for (const side of [-1, 1]) order.push(this.legs[(side < 0 ? 0 : LEG_COUNT / 2) + k]);
    for (const leg of order) {
      const target = add(leg.foot, this.hU, -3);
      leg.mode = 'plant';
      this.startStep(leg, target, 0.08 + leg.k * 0.014, 2, 14);
    }
  }

  /** Absorb the landing: the spring dips and recovers, then it settles its feet and crawls. */
  land(dt, run, tr) {
    this.landT += dt;
    const k = Math.min(1, this.landT / LAND_ABSORB);
    const K = 220;
    const C = 2 * 0.72 * Math.sqrt(K);
    for (let j = 0; j < 3; j++) {
      this.landV[j] += (-K * this.landOff[j] - C * this.landV[j]) * dt;
      this.landOff[j] += this.landV[j] * dt;
    }
    // Compress, rebound once, settle (a damped oscillation peaking near the first sixth), the
    // compression growing from contact rather than jumping in on top of the incoming speed.
    const A = this.abseil ? 2.5 : 5.5;
    const dip = (A * Math.exp(-3.4 * k) * Math.sin(Math.PI * 2.1 * k) * smooth(0, 0.12, k)) / 0.5;
    this.p = add(add(tr.to, this.landOff), this.hU, -dip);
    this.orient([this.hF[0], 0, this.hF[2]], dt, 3);
    if (this.landT >= LAND_TIME) {
      this.mode = 'crawl';
      run.spider.arrived = true;
      this.anchor(run);
      this.beginShuffle();
      this.beginPause(range(this.rand, 1.0, 1.5), true);
    }
  }

  /** After landing: each foot in turn, rear to front, lifts and re-grips a little nearer its rest. */
  beginShuffle() {
    const queue = [];
    let at = 0.05;
    for (let k = LEG_COUNT / 2 - 1; k >= 0; k--) {
      for (const side of k % 2 ? [-1, 1] : [1, -1]) {
        queue.push({ leg: this.legs[(side < 0 ? 0 : LEG_COUNT / 2) + k], at });
        at += range(this.rand, 0.035, 0.07);
      }
    }
    this.shuffle = { t: 0, queue, end: at + 0.25 };
  }

  beginPause(dur, landing = false) {
    this.walking = false;
    this.pauseT = 0;
    this.behaviour = landing ? 'settle' : 'pause';
    this.weightShift();
    this.feelAt = [Infinity, Infinity];
    // Most longer pauses: the forelegs come up one after the other, feel about, tap, and settle back down.
    if (!landing && dur > 0.95 && this.rand() < 0.8) {
      dur = Math.max(dur, range(this.rand, 1.6, 2.2));
      const first = this.rand() < 0.5 ? 0 : 1;
      this.feelAt[first] = range(this.rand, 0.12, 0.35);
      this.feelAt[1 - first] = this.feelAt[first] + range(this.rand, 0.08, 0.3);
      this.feelEnd = dur - 0.36;
    }
    this.intentT = dur;
  }

  /** Lower the body a touch and lean onto other feet. */
  weightShift() {
    this.poseT.lower = range(this.rand, 1.6, 3.0);
    this.poseT.shiftS = range(this.rand, -1.6, 1.6);
    this.poseT.shiftF = range(this.rand, -1.2, 0.5);
    this.poseT.roll = this.poseT.shiftS * 0.022;
    this.poseT.pitch = 0;
    this.shiftT = range(this.rand, 0.7, 1.4);
  }

  beginWalk(dur) {
    this.walking = true;
    this.intentT = dur;
    this.behaviour = 'walk';
    this.poseT = zeroPose();
    this.feelAt = [Infinity, Infinity];
    for (const leg of this.legs) if (leg.mode === 'feel') this.lowerFeeler(leg);
  }

  lowerFeeler(leg) {
    const { rest } = this.legFrame(leg);
    this.startStep(leg, add(rest, this.hF, 4), 0.34, 2);
  }

  /**
   * Inside a section: walk where it faces in purposeful bursts, pause to feel
   * and shift its weight. Speed eases through a spring so it never starts or
   * stops dead; heading meanders gently toward the goal.
   */
  crawl(dt, run) {
    const g = run.spiderGoal;
    const to = sub([g.x, g.y, g.z ?? 0], this.p);
    const dist = len(to);
    this.intentT -= dt;
    if (this.shuffle) this.shuffleStep(dt);
    if (this.walking) {
      if (this.intentT <= 0 || dist < 8) this.beginPause(dist > 150 ? range(this.rand, 0.35, 0.7) : range(this.rand, 0.8, 1.8));
    } else {
      this.pauseT += dt;
      if (this.intentT <= 0 && !this.shuffle) {
        if (dist > 14) this.beginWalk(range(this.rand, 1.1, 2.4) * (dist > 150 ? 1.7 : 1));
        else this.beginPause(range(this.rand, 1.0, 2.2));
      }
    }
    if (!this.walking) this.stand(dt);
    else this.poseT.roll = clamp(-dot(this.w, this.hU) * 0.08, -0.06, 0.06);

    // The goal hops on to the next waypoint now and then: it swings its course round over a moment.
    const n0 = dist > 1e-6 ? scale(to, 1 / dist) : this.hF;
    this.goalN = this.goalN ? norm(lerp3(this.goalN, n0, 1 - Math.exp(-2.5 * dt))) : n0;
    const n = this.goalN;
    const facing = Math.max(0.15, dot(this.hF, n));
    // The speed it means to go eases too, so a burst gathers and dies away rather than kicking in.
    const target = this.walking ? Math.min(CRUISE, dist * 1.2) * facing : 0;
    this.speedT += (target - this.speedT) * (1 - Math.exp(-10 * dt));
    this.speedV += ((this.speedT - this.speed) * 36 - this.speedV * 12) * dt;
    this.speed = Math.max(0, this.speed + this.speedV * dt);
    const wander = Math.sin(this.time * 0.9 + this.meander) * 0.32 + Math.sin(this.time * 2.1 + this.meander * 2) * 0.12;
    // It steers as it walks: setting off it leans into the turn, slowing to a halt it straightens
    // out with its speed (not all at once), and right by the goal it stops steering so it never circles it.
    const moving = Math.min(1, this.speed / CRUISE);
    let aim = n;
    let rate = 0.8;
    let cap = 0;
    if (this.walking || moving > 0.1) {
      aim = rotate(n, this.hU, wander);
      rate = 2.2;
      cap = MAX_TURN * (this.walking ? 1 : moving) * smooth(6, 14, dist);
    }
    // Standing it holds its heading, unless the goal has drifted well off to one side; never while feeling.
    else if (this.feel < 0.05 && dist > 10 && facing < 0.85) cap = 0.4;
    this.turnCap += (cap - this.turnCap) * (1 - Math.exp(-6 * dt));
    this.orient(aim, dt, rate, MAX_TILT, this.turnCap);
    // Mostly along the body, a little straight to the goal so it never orbits it.
    const dir = norm(add(scale(this.hF, 0.75), n, 0.25));
    this.p = add(this.p, dir, this.speed * dt);
  }

  /** Standing still: weight shifts now and then, the front pair rise to feel the air and come down before it moves on. */
  stand(dt) {
    this.shiftT -= dt;
    if (this.shiftT <= 0) this.weightShift();
    for (let s = 0; s < 2; s++) {
      const leg = this.legs[s ? LEG_COUNT / 2 : 0];
      // Only once it has all but stopped, and with time left to feel about.
      if (leg.mode === 'plant' && this.pauseT >= this.feelAt[s] && this.pauseT < this.feelEnd - 0.5 && this.speed < 8) {
        leg.mode = 'feel';
        leg.rel = this.toLocal(leg.foot);
        leg.relV = [0, 0, 0];
        leg.feelT = 0;
        leg.tapT = 0;
        leg.tapNext = range(this.rand, 0.75, 1.2);
      }
      if (leg.mode === 'feel' && this.pauseT >= this.feelEnd) this.lowerFeeler(leg);
    }
    // Rearing slightly while the forelegs are up, weight back on the rear legs.
    const up = this.feel;
    this.poseT.pitch = up * 0.05;
    if (up > 0.5) this.poseT.shiftF = Math.min(this.poseT.shiftF, -0.8);
  }

  shuffleStep(dt) {
    const sh = this.shuffle;
    sh.t += dt;
    while (sh.queue.length && sh.queue[0].at <= sh.t) {
      const item = sh.queue[0];
      const { leg } = item;
      // A foot waits for a neighbour still in the air, so two swings never cross.
      const busy = this.legs.some((o) => o.side === leg.side && Math.abs(o.k - leg.k) === 1 && o.mode === 'step' && o.step < 0.7);
      if (busy && item.waits < 6) {
        item.waits = (item.waits || 0) + 1;
        item.at += 0.05;
        sh.queue.sort((p, q) => p.at - q.at);
        break;
      }
      sh.queue.shift();
      if (leg.mode !== 'plant') continue;
      const { rest } = this.legFrame(leg);
      const jitter = add(scale(this.hF, range(this.rand, -2.5, 2.5)), this.hS, range(this.rand, -2.5, 2.5));
      this.startStep(leg, add(rest, jitter), range(this.rand, 0.17, 0.24), range(this.rand, 2.5, 4));
    }
    if (!sh.queue.length && sh.t > sh.end) this.shuffle = null;
  }

  /**
   * Lift a foot and swing it to a star near target, in dur (up to most for a long reach, unless that would whip).
   * Unless forced, a step that would land where it stands is skipped.
   */
  startStep(leg, target, dur, lift, r = 12, force = true, most = 0.34) {
    const to = this.pickFoothold(leg, target, r) || target;
    leg.due = false;
    if (!force && len(sub(to, leg.foot)) < 3) return false;
    leg.from = [...leg.foot];
    leg.to = to;
    leg.step = 0;
    // A long reach takes a little longer: feet never whip, even on a short beat (a foot
    // a quick pivot left far behind swings back at no more than 300/s on average).
    const span = len(sub(to, leg.foot));
    leg.stepDur = Math.max(dur, Math.min(most, span / 120), Math.min(0.34, span / 300));
    // Leave at the speed the foot already had (zero from a plant): a foot caught from the
    // air carries on (up to 240/s) and slows onto its star, never on down past it (carried
    // down no more than 2.5 times the drop to the star, the path stays above it).
    let carry = scale(leg.footV, leg.stepDur);
    const down = Math.min(0, 2.5 * dot(sub(to, leg.foot), this.hU)) - dot(carry, this.hU);
    if (down > 0) carry = add(carry, this.hU, down);
    const cl = len(carry);
    const cap = 240 * leg.stepDur;
    leg.carry = cl > cap ? scale(carry, cap / cl) : carry;
    leg.lift = lift;
    leg.mode = 'step';
    return true;
  }

  legsUpdate(dt, run, turn) {
    const crawling = this.mode === 'crawl';
    const crouching = this.mode === 'jump' && !this.launched;
    // Cadence follows the fastest-drifting foot (front and rear corners), so turning steps as briskly as walking.
    let loco = 0;
    for (const [f, s] of [[45, 28], [45, -28], [-40, 34], [-40, -34]]) {
      const r = add(scale(this.hF, f), this.hS, s);
      const vr = add(this.v, cross(this.w, r));
      loco = Math.max(loco, len(add(vr, this.hU, -dot(vr, this.hU))));
    }
    if (!crawling) loco = (turn / dt) * TURN_ARM;
    this.loco = loco;
    const locomoting = (crawling || crouching) && this.loco > 2.5 && !this.shuffle;
    const prevGait = this.gait;
    this.gait += (this.loco * dt) / STRIDE;
    const cycle = STRIDE / Math.max(1, this.loco);
    const swing = clamp(cycle * 0.32, crouching ? 0.18 : 0.13, 0.26); // pivoting to aim, steps stay unhurried
    let stepping = this.legs.reduce((c, l) => c + (l.mode === 'step' ? 1 : 0), 0);
    // The ripple runs the way the feet on that side drift past the body: the
    // leg a foot drifts toward has always just stepped, so it lands with room.
    for (let s = 0; s < 2; s++) {
      const drift = -dot(add(this.v, cross(this.w, scale(this.hS, (s ? 1 : -1) * 40))), this.hF);
      if (drift > 2) this.waveRev[s] = true;
      else if (drift < -2) this.waveRev[s] = false;
    }
    for (const leg of this.legs) {
      if (leg.mode === 'air' && crawling && (this.jumps > 0 || this.walking)) {
        this.startStep(leg, this.legFrame(leg).rest, 0.25, 2);
        stepping++;
        continue;
      }
      if (leg.mode === 'air' || leg.mode === 'feel') {
        this.followPose(leg, dt);
        continue;
      }
      if (leg.mode === 'step') {
        leg.step = Math.min(1, leg.step + dt / leg.stepDur);
        const u = leg.step;
        // Lift, swing, place: the foot peels up briskly (highest at u = 0.4), travels on
        // a minimum-jerk path, and lowers softly onto its star: no pop at either end.
        // A foot that was already moving (caught from the air, a raised foreleg) carries
        // on at its own speed for a moment rather than stopping dead.
        const h = minJerk(clamp((u - 0.04) / 0.88, 0, 1));
        const up = (u * u * (1 - u) ** 3) / 0.03456;
        leg.foot = add(add(lerp3(leg.from, leg.to, h), this.hU, up * leg.lift), leg.carry, u * (1 - u) ** 2);
        if (u >= 1) {
          leg.mode = 'plant';
          leg.foot = [...leg.to];
          leg.planted = this.time;
        }
        continue;
      }
      if (!crawling && !crouching) continue; // landing: feet hold
      const { hip, rest } = this.legFrame(leg);
      const off = len(sub(leg.foot, rest));
      const rel = sub(leg.foot, hip);
      const twist = Math.abs(wrap(Math.atan2(dot(rel, this.hS), dot(rel, this.hF)) - leg.restAng));
      const stretch = len(rel) / (leg.femur + leg.tibia + leg.tarsus);
      const above = dot(rel, this.hU) > -leg.reach * 0.05;
      const rev = this.waveRev[leg.side > 0 ? 1 : 0];
      const go = frac((rev ? leg.k : LEG_COUNT / 2 - 1 - leg.k) * WAVE + (leg.side > 0 ? 0.5 : 0));
      const wave = locomoting && frac(prevGait + go) > frac(this.gait + go);
      const urgent = off > leg.reach * 0.55 || twist > 0.5 || this.footAz(leg) > 2.45 || stretch > 0.96 || above || this.crowded(leg);
      // A beat is never dropped: the leg stays due until its neighbours leave it room to land,
      // until the neighbour it swings toward has nearly put its own foot down, and until its
      // own foot, if it has only just come down, has stood a moment (it never stutters).
      if (wave || urgent) leg.due = true;
      const lead = leg.k + (rev ? 1 : -1);
      const ahead = lead >= 0 && lead < LEG_COUNT / 2 ? this.legs[(leg.side < 0 ? 0 : LEG_COUNT / 2) + lead] : null;
      const critical = stretch > 0.96 || above || this.footAz(leg) > 2.6; // never let a rear foot drag under the abdomen
      const blocked = ((ahead && ahead.mode === 'step' && ahead.step < 0.6) || this.time - leg.planted < STAND) && !critical;
      if (leg.due && !blocked && stepping < 5) {
        const [lo, hi] = this.window(leg);
        const target = locomoting ? this.stepTarget(rest, cycle, swing, leg) : rest;
        const gaitAmp = Math.min(1, this.loco / CRUISE);
        // Walking, a foot is back down within half a cycle: it stands before its next beat, never stutters.
        const most = locomoting ? Math.min(0.34, cycle * 0.5) : 0.34;
        if (lo < hi && this.startStep(leg, target, swing, locomoting ? 5 + 4 * gaitAmp : 5, 12, critical, most)) stepping++;
      }
    }
    // Standing: one foot at a time eases back under the body when it has drifted.
    if (crawling && !locomoting && !this.shuffle) {
      this.settleT -= dt;
      if (this.settleT <= 0) {
        let worst = null;
        let we = 0.22;
        for (const leg of this.legs) {
          if (leg.mode !== 'plant' || this.time - leg.planted < STAND) continue;
          const nb = this.legs.filter((o) => o.side === leg.side && Math.abs(o.k - leg.k) === 1);
          if (nb.some((o) => o.mode === 'step')) continue;
          const [lo, hi] = this.window(leg);
          if (lo >= hi) continue;
          const { hip, rest } = this.legFrame(leg);
          const rel = sub(leg.foot, hip);
          const twist = Math.abs(wrap(Math.atan2(dot(rel, this.hS), dot(rel, this.hF)) - leg.restAng));
          const e = len(sub(leg.foot, rest)) / leg.reach + twist * 0.5;
          if (e > we) {
            we = e;
            worst = leg;
          }
        }
        if (worst) this.startStep(worst, this.legFrame(worst).rest, 0.24, 4);
        this.settleT = range(this.rand, 0.08, 0.16);
      }
    }
    // How fast each foot is going, so a step can leave at that speed.
    for (const leg of this.legs) {
      leg.footV = leg.last ? scale(sub(leg.foot, leg.last), 1 / dt) : [0, 0, 0];
      leg.last = [...leg.foot];
    }
  }

  /** Azimuth of a leg's plane (to its foot, or the star it is stepping to) from its hip; rest azimuth when it is off the web. */
  footAz(leg) {
    if (leg.mode === 'air') return Math.abs(leg.restAng);
    return this.legAz(leg, leg.mode === 'step' ? leg.to : leg.foot);
  }

  /** A planted foot about to be overtaken by a neighbour's: it moves first (the one further from its rest does). */
  crowded(leg) {
    const base = leg.side < 0 ? 0 : LEG_COUNT / 2;
    const a = this.footAz(leg);
    const drift = Math.abs(a - Math.abs(leg.restAng));
    for (const dk of [-1, 1]) {
      const k = leg.k + dk;
      if (k < 0 || k >= LEG_COUNT / 2) continue;
      const o = this.legs[base + k];
      if (o.mode === 'air') continue;
      const ao = this.footAz(o);
      // A raised foreleg sweeps about, so its neighbour keeps a wider berth.
      if (o.mode === 'feel') {
        if ((ao - a) * dk < 0.16) return true;
      } else if ((ao - a) * dk < 0.05 && (o.mode === 'step' || drift >= Math.abs(ao - Math.abs(o.restAng)))) return true;
    }
    return false;
  }

  /** Where a walking foot lands: half a stride ahead of where its rest point will be, turning included. */
  stepTarget(rest, cycle, swing, leg) {
    const vr = add(this.v, cross(this.w, sub(rest, this.p)));
    let ahead = scale(vr, (cycle + swing) * 0.5);
    const al = len(ahead);
    const cap = leg.reach * 0.42;
    if (al > cap) ahead = scale(ahead, cap / al);
    return add(rest, ahead);
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
