/**
 * Iron Man in place of the spider: the rigged CGTrader suit (see
 * ironman-model.js). The animation is procedural, on a 20-bone driver rig
 * fitted to the model's joints (with clavicles, toes and a knuckle bone,
 * rest pose unrotated); every frame the model's 74 deform bones are turned
 * as the rig's have turned (see drive()), the artist's hover pose blending
 * in while he holds upright in the air.
 *
 * Walking follows human gait: a stride clock with stance ~60% and swing ~40%
 * of the cycle and two double-support phases; the foot rolls heel strike ->
 * foot flat -> heel off (the toes bending flat on the ground) -> toe off; the
 * swing foot is planned to land where the body will be over it at
 * mid-stance; cadence and step length grow with speed as people's do. The
 * pelvis is lowest at double support, shifts over the stance foot, rotates
 * and lists with the stride; the thorax counter-rotates, the arms swing
 * opposite the legs with the elbows flexing, and the head stays level. He
 * starts and stops with settle steps, turns on the spot with pivot steps and
 * stands with breathing, weight shifts and glances when idle. Feet stand on
 * the local ground plane the crawler walks on, slopes included.
 *
 * Shooting: head, then torso and arm come round to the word; the arm extends
 * with a soft elbow, palm out and fingers back like a real repulsor pose,
 * the off hand held ready; standing, he steps into a braced stance. Each
 * blast kicks the arm (muzzle climb), then the shoulder and torso. Flying:
 * he lifts off upright on his thrusters, pitches into head-first flight with
 * his arms at his sides and his palms back, and swings upright again to brake
 * on his boots before he lands, the knees taking the landing.
 */

import * as THREE from 'three';
import { createRepulsors } from './repulsor.js';
import { JOINT, POSE, MODEL_HEIGHT, loadModel } from './ironman-model.js';

const HEIGHT = 46; // world units: he reads at the distances the camera keeps from the crawler
const K = HEIGHT / MODEL_HEIGHT; // world units per model unit (feet at y = 0)
const U = HEIGHT / 2.02; // a body-proportional unit for the few absolute lengths below (tuned on a body 2.02 tall)
const UP = new THREE.Vector3(0, 1, 0);

/*
 * The driver rig's joints, in model units (y up, facing +z, his left at +x),
 * from the model's deform bones; heel and toe tip from its feet.
 */
const J = {
  pelvis: JOINT['DEF-spine'],
  spine: JOINT['DEF-spine002'],
  chest: JOINT['DEF-spine003'],
  neck: JOINT['DEF-spine005'],
  crown: [0, MODEL_HEIGHT, 0.1],
  clav: JOINT['DEF-shoulderL'], // sternoclavicular joint: the shoulder girdle shrugs and braces about it
  shoulder: JOINT['DEF-upper_armL'],
  elbow: JOINT['DEF-forearmL'],
  wrist: JOINT['DEF-handL'],
  palm: JOINT['DEF-palm02L'].map((x, i) => (x + JOINT['DEF-f_middle01L'][i]) / 2),
  fingers: JOINT['DEF-f_middle03L'],
  hip: JOINT['DEF-thighL'],
  knee: JOINT['DEF-shinL'],
  ankle: JOINT['DEF-footL'],
  heel: [JOINT['DEF-footL'][0], 0.07, -0.15], // the heel's core
  ball: JOINT['DEF-toeL'], // ball of the foot: the toes bend here
  toe: [JOINT['DEF-toeL'][0], 0.035, 0.44],
  sole: [JOINT['DEF-footL'][0], 0, 0.1],
};
const side = (p, s) => [p[0] * s, p[1], p[2]];
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const L1 = V(J.knee).distanceTo(V(J.hip)); // thigh
const L2 = V(J.ankle).distanceTo(V(J.knee)); // shin
const LU = V(J.elbow).distanceTo(V(J.shoulder)); // upper arm
const LF = V(J.wrist).distanceTo(V(J.elbow)); // forearm
const ANKLE_H = J.ankle[1]; // ankle above the ground (the sole is at y = 0)
const HIP_DROP = J.pelvis[1] - J.hip[1]; // pelvis above the hip joints
const HIP_W = J.hip[0]; // hip joint off the midline
const LEG = J.hip[1]; // hip joint above the ground: the length the gait scales with
// The foot's contact points, from the ground point under the ankle (mesh units, along the foot).
const HEEL_Z = -0.195 - J.ankle[2]; // the back of the heel
const BALL_Z = J.ball[2] - J.ankle[2];
const BALL_Y = J.ball[1]; // the toe joint, which stays put while the heel rises
const TIP_Z = J.toe[2] + 0.03 - J.ankle[2]; // the toe tips, the last of the foot to leave the ground
// The palm at rest: its normal (the repulsor's axis, from the hand's own bones) and the fingers' direction, left hand.
const KNUCKLE_AT = V(JOINT['DEF-f_middle01L']).sub(V(JOINT['DEF-handL']));
const PALM_N = new THREE.Vector3().crossVectors(KNUCKLE_AT, V(JOINT['DEF-f_index01L']).sub(V(JOINT['DEF-f_pinky01L']))).normalize();
const FINGERS = V(J.fingers).sub(V(J.wrist)).normalize();
// Along the hand (in its plane), across it (toward the thumb), and where the knuckles are from the wrist.
const HAND_ALONG = FINGERS.clone().addScaledVector(PALM_N, -FINGERS.dot(PALM_N)).normalize();
const HAND_ACROSS = new THREE.Vector3().crossVectors(PALM_N, HAND_ALONG);
const KNUCKLES = KNUCKLE_AT.dot(HAND_ALONG);
// The bind pose holds the arms out and a little down (a T-pose); the arm angles below were tuned
// on an A-pose this much lower, so the rig adds the difference.
const ARM_REST_FIX = 1.007 - Math.atan2(J.shoulder[1] - J.wrist[1], J.wrist[0] - J.shoulder[0]);

/* Gait. Times in seconds, lengths in leg lengths (LEG), angles in radians. */
const DS = 0.1; // each double support, as a share of the stride cycle
const SS = 0.5 - DS; // each single support (the other foot swinging)
const TO = { L: 0.5 + DS, R: DS }; // toe-offs in the cycle (heel strikes: L at 0, R at 0.5)
const HS = { L: 0, R: 0.5 };
const W_STAND = 1.05; // feet apart standing (x the hip joints' spacing)
const W_WALK = 0.62; // walking: closer to the line of progression
const TOE_OUT = 0.1;
const HS_ROLL = -0.3; // the foot's pitch at heel strike (toes up)
const RISE_MAX = 0.85; // heel rise allowed by toe off
const TOE_MAX = 0.9; // the toes bend at most this far while the heel rises
const V_GO = 0.2; // leg lengths per second: slower than this he steps only when his feet need it

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u);
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const frac = (x) => x - Math.floor(x);
const hash = (n) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
/** Smooth minimum: like min(a, b) but without a kink (k: the blend width). */
const smin = (a, b, k) => (a + b - Math.sqrt((a - b) * (a - b) + k * k)) / 2;

/**
 * A critically damped (or lightly underdamped) spring toward a target, for every
 * eased value. Sub-stepped so a slow frame cannot make it unstable; after a jump
 * in time (a seek) it lands on its target.
 */
function spring(w = 12, zeta = 1) {
  const s = { x: 0, v: 0, w };
  s.to = (target, dt) => {
    if (dt > 0.3) {
      s.x = target;
      s.v = 0;
      return s.x;
    }
    const n = Math.ceil(dt / 0.008);
    const h = dt / Math.max(1, n);
    for (let i = 0; i < n; i++) {
      s.v += ((target - s.x) * s.w * s.w - s.v * 2 * zeta * s.w) * h;
      s.x += s.v * h;
    }
    return s.x;
  };
  /** A blow: kicks the value so it peaks near `peak` (from rest) a quarter period later. */
  s.kick = (peak) => (s.v += peak * s.w * Math.E);
  return s;
}

/** Bones (rest pose: no rotation, so every bone's axes are the mesh's) and their skinning segments. */
function buildSkeleton() {
  const bones = [];
  const segs = [];
  const make = (name, at, parent, seg) => {
    const b = new THREE.Bone();
    b.name = name;
    b.userData.at = at;
    b.position.set(at[0] - (parent ? parent.userData.at[0] : 0), at[1] - (parent ? parent.userData.at[1] : 0), at[2] - (parent ? parent.userData.at[2] : 0));
    if (parent) parent.add(b);
    if (seg) {
      bones.push(b);
      segs.push(seg);
    }
    return b;
  };
  const root = make('pelvis', J.pelvis, null, [J.pelvis, J.spine, 'mid']);
  const spine = make('spine', J.spine, root, [J.spine, J.chest, 'mid']);
  const chest = make('chest', J.chest, spine, [J.chest, J.neck, 'mid']);
  const neck = make('neck', J.neck, chest, [J.neck, J.crown, 'mid']);
  const limbs = {};
  for (const [s, n] of [[1, 'L'], [-1, 'R']]) {
    const clav = make('clav' + n, side(J.clav, s), chest);
    const sh = make('shoulder' + n, side(J.shoulder, s), clav, [side(J.shoulder, s), side(J.elbow, s), 'arm', s]);
    const el = make('elbow' + n, side(J.elbow, s), sh, [side(J.elbow, s), side(J.wrist, s), 'arm', s]);
    const wr = make('wrist' + n, side(J.wrist, s), el, [side(J.wrist, s), side(J.fingers, s), 'arm', s]);
    const palm = make('palm' + n, side(J.palm, s), wr);
    const hip = make('hip' + n, side(J.hip, s), root, [side(J.hip, s), side(J.knee, s), 'leg', s]);
    const knee = make('knee' + n, side(J.knee, s), hip, [side(J.knee, s), side(J.ankle, s), 'leg', s]);
    // The foot from the heel to the ball, so the heel rolls with the foot rather than staying with the shin.
    const ankle = make('ankle' + n, side(J.ankle, s), knee, [side(J.heel, s), side(J.ball, s), 'leg', s]);
    const toe = make('toe' + n, side(J.ball, s), ankle, [side(J.ball, s), side(J.toe, s), 'leg', s]);
    const sole = make('sole' + n, side(J.sole, s), ankle);
    limbs[n] = {
      s, n, clav, sh, el, wr, palm, hip, knee, ankle, toe, sole,
      restUpper: V(side(J.elbow, s)).sub(V(side(J.shoulder, s))).normalize(),
      restFore: V(side(J.wrist, s)).sub(V(side(J.elbow, s))).normalize(),
      restThigh: V(side(J.knee, s)).sub(V(side(J.hip, s))).normalize(),
      restShin: V(side(J.ankle, s)).sub(V(side(J.knee, s))).normalize(),
      palmN: PALM_N.clone().setX(PALM_N.x * s),
      fingers: FINGERS.clone().setX(FINGERS.x * s),
    };
  }
  // The fingers, bending together at the knuckles (skinned apart from the distance weights, see skinFingers).
  for (const n of ['L', 'R']) {
    const g = limbs[n];
    g.along = HAND_ALONG.clone().setX(HAND_ALONG.x * g.s);
    g.across = HAND_ACROSS.clone().setX(HAND_ACROSS.x * g.s); // toward the thumb
    g.curlAxis = new THREE.Vector3().crossVectors(g.along, g.palmN).normalize(); // + curls the fingers into the palm
    const f = new THREE.Bone();
    f.name = 'fingers' + n;
    const at = V(side(J.wrist, g.s)).addScaledVector(g.along, KNUCKLES);
    f.userData.at = at.toArray();
    f.position.copy(at).sub(V(side(J.wrist, g.s)));
    g.wr.add(f);
    g.knuckles = f;
    bones.push(f);
  }
  return { root, spine, chest, neck, limbs, bones, segs };
}

/* Scratch for basisQ. */
const _ba = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _bm0 = new THREE.Matrix4();
const _bm1 = new THREE.Matrix4();

/** The rotation taking direction a0 to a1 and, about it, b0 to b1 (b only fixes the roll). */
function basisQ(out, a0, b0, a1, b1) {
  const [x0, y0, z0, x1, y1, z1] = _ba;
  x0.copy(a0).normalize();
  y0.copy(b0).addScaledVector(x0, -b0.dot(x0)).normalize();
  z0.crossVectors(x0, y0);
  x1.copy(a1).normalize();
  y1.copy(b1).addScaledVector(x1, -b1.dot(x1));
  if (y1.lengthSq() < 1e-8) y1.copy(y0).addScaledVector(x1, -y0.dot(x1));
  y1.normalize();
  z1.crossVectors(x1, y1);
  _bm0.makeBasis(x0, y0, z0).transpose();
  _bm1.makeBasis(x1, y1, z1).multiply(_bm0);
  return out.setFromRotationMatrix(_bm1);
}

/**
 * @param {THREE.WebGLRenderer} renderer for the suit's reflections
 * @returns {{group: THREE.Group, fx: THREE.Group, update: Function, chest: Function, up: Function, debug: Function}}
 */
export function createIronMan(renderer) {
  const group = new THREE.Group(); // at his pelvis
  const body = new THREE.Group(); // oriented: +y his head, +z his chest
  group.add(body);
  const repulsors = createRepulsors();
  const fx = repulsors.group; // world-space effects: rays, flares, sparks

  // The driver rig and the model's own deform bones, which follow it every frame (see drive());
  // both live in model space.
  const sk = buildSkeleton();
  const rig = new THREE.Group(); // model units, pivoted at the pelvis
  rig.scale.setScalar(K);
  rig.position.set(0, -J.pelvis[1] * K, -J.pelvis[2] * K); // the pelvis on his origin, so the feet are planned under the hips
  const holder = new THREE.Object3D();
  holder.add(sk.root);
  rig.add(holder);
  body.add(rig);
  let model = null;
  loadModel(renderer, (m) => {
    rig.add(m.scene);
    model = rigModel(m);
  });
  const pelvisY0 = sk.root.position.y;

  // Lights for the suit: a soft sky fill, a warm key from over the camera's shoulder, a cool rim.
  const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x1a1020, 1.7);
  const key = new THREE.DirectionalLight(0xfff1e0, 4.2);
  const rim = new THREE.DirectionalLight(0x7fb0ff, 3.2);
  const repulsorLight = new THREE.PointLight(0x9fdcff, 0, 60 * U / 22, 2); // the repulsors light up his own armour
  key.target = body;
  rim.target = body;
  group.add(hemi, key, rim, repulsorLight);

  /* ---------------- state ---------------- */

  const footState = () => ({
    swing: null,
    pos: new THREE.Vector3(), // planted: the ground point under the ankle (world)
    nrm: new THREE.Vector3(0, 1, 0), // the ground's normal there
    yaw: 0,
    rho: 0, // pitch: > 0 heel up (rolling over the ball), < 0 toes up (rocking on the heel)
    rock: 0, // the heel-strike pitch, rolled out over the loading response
    landT: -9,
    toe: 0, // the toes' bend (flat on the ground while the heel rises)
    sigma: 0, // progress through stance (0 heel strike, 1 toe off)
    rhoLo: 0, // the roll it has and may take this frame
    rhoHi: 0,
    flex: 0.087, // the knee bend its leg should have
    ankle: new THREE.Vector3(), // where the ankle is this frame (world)
    last: new THREE.Vector3(), // ... and last frame, for its velocity
    vel: new THREE.Vector3(),
    q: new THREE.Quaternion(), // the foot's orientation this frame (world)
  });
  const swingState = () => ({ u: 0, v0: 0, a0: new THREE.Vector3(), a1: new THREE.Vector3(), yaw0: 0, rho0: 0, toe0: 0, n0: new THREE.Vector3(), tPos: new THREE.Vector3(), tNrm: new THREE.Vector3(), tYaw: 0, tRho: HS_ROLL, lift: 0 });
  const st = {
    phase: TO.L, // the stride clock (0..1): L heel strike at 0, R toe off DS, R heel strike 0.5, L toe off 0.5 + DS
    holding: true, // stopped at a toe off: standing
    feet: null,
    swings: { L: swingState(), R: swingState() },
    grounded: true,
    time: 0,
    gx: 0, // ground gradient under him (dy/dx, dy/dz)
    gz: 0,
    yawRate: 0,
    prevYaw: null,
    acc: new THREE.Vector3(),
    prevV: new THREE.Vector3(),
    aim: { L: { id: -1, fresh: -9, born: -9, has: false, dir: new THREE.Vector3(0, 0, 1), seen: 0 }, R: { id: -1, fresh: -9, born: -9, has: false, dir: new THREE.Vector3(0, 0, 1), seen: 0 } },
    seen: new Map(), // word id -> {t: first seen, p: last reach}
    landDipArmed: false,
    hLast: undefined, // the pelvis height wanted last frame
  };
  const ez = {
    walk: spring(5), fly: spring(9), air: spring(9), crouch: spring(10, 0.9), att: spring(5), hover: spring(6),
    speed: spring(6), active: spring(6), pelvisY: spring(34, 0.95), sway: spring(9, 0.9), land: spring(9, 0.55),
    hips: spring(5, 0.9), twist: spring(7, 0.9), lookY: spring(12, 0.85), lookP: spring(12, 0.85),
    shift: spring(1.6, 0.9), brace: spring(4, 0.9), wide: spring(4, 0.9), lean: spring(5, 0.9),
    arm: { L: spring(14, 0.7), R: spring(14, 0.7) }, aim: { L: spring(9, 0.9), R: spring(9, 0.9) }, guard: { L: spring(6, 0.9), R: spring(6, 0.9) },
    recoil: { L: spring(28, 0.8), R: spring(28, 0.8) }, // a blast's kick through the arm
    kick: { L: spring(13, 0.85), R: spring(13, 0.85) }, // ... and its push through the shoulder and torso
  };
  const heading = new THREE.Vector3(0, 0, 1);
  const leftV = new THREE.Vector3(1, 0, 0);
  const head = new THREE.Vector3(0, 1, 0);
  const chestDir = new THREE.Vector3(0, 0, 1);
  const H = new THREE.Vector3();
  const C = new THREE.Vector3();
  const X = new THREE.Vector3();
  const v = new THREE.Vector3();
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();
  const d3 = new THREE.Vector3();
  const e3 = new THREE.Vector3();
  const f3 = new THREE.Vector3();
  const pxz = new THREE.Vector3(); // the point on the ground under his pelvis
  const hipW = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const q3 = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const rootQ = new THREE.Quaternion();
  const basis = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const flightQ = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const palms = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const soles = [new THREE.Vector3(), new THREE.Vector3()];
  const aimW = { L: 0, R: 0 };
  const fxIn = { palms, soles, head, vel: v, aim: aimW };
  const AX = new THREE.Vector3(1, 0, 0);
  const AY = new THREE.Vector3(0, 1, 0);
  const AZ = new THREE.Vector3(0, 0, 1);

  const perp = (a, n, fallback) => {
    a.addScaledVector(n, -a.dot(n));
    if (a.lengthSq() < 1e-6) a.copy(fallback).addScaledVector(n, -fallback.dot(n));
    return a.normalize();
  };

  /* ---------------- ground ---------------- */

  /**
   * The ground he stands on: the plane through the crawler's leg tips (the
   * surface of the ball it walks), so his feet climb and descend its slopes.
   */
  function fitGround(spider, dt) {
    const L = spider.legs;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const l of L) {
      mx += l.tip[0];
      my += l.tip[1];
      mz += l.tip[2];
    }
    mx /= L.length;
    my /= L.length;
    mz /= L.length;
    let sxx = 0;
    let sxz = 0;
    let szz = 0;
    let sxy = 0;
    let szy = 0;
    for (const l of L) {
      const x = l.tip[0] - mx;
      const y = l.tip[1] - my;
      const z = l.tip[2] - mz;
      sxx += x * x;
      sxz += x * z;
      szz += z * z;
      sxy += x * y;
      szy += z * y;
    }
    const det = sxx * szz - sxz * sxz;
    let gx = 0;
    let gz = 0;
    if (det > 1e-3) {
      gx = (sxy * szz - szy * sxz) / det;
      gz = (szy * sxx - sxy * sxz) / det;
    }
    // A man walks up a 40 degree slope at most; the plane's wobble from star to star is eased out.
    const g = Math.hypot(gx, gz);
    if (g > 0.84) {
      gx *= 0.84 / g;
      gz *= 0.84 / g;
    }
    const k = dt > 0.3 ? 1 : 1 - Math.exp(-5 * dt);
    st.gx += (gx - st.gx) * k;
    st.gz += (gz - st.gz) * k;
    st.gy = my + st.gx * (spider.p[0] - mx) + st.gz * (spider.p[2] - mz); // under his pelvis
  }
  const groundAt = (x, z) => st.gy + st.gx * (x - pxz.x) + st.gz * (z - pxz.z);
  const groundN = (out) => out.set(-st.gx, 1, -st.gz).normalize();

  /* ---------------- feet ---------------- */

  /** The foot's frame flat on the ground: forward along its yaw, up along the ground normal. */
  function flatFrame(out, yaw, nrm) {
    c3.set(Math.sin(yaw), 0, Math.cos(yaw));
    perp(c3, nrm, heading);
    return basisQ(out, AY, AZ, nrm, c3);
  }

  /** Ankle and orientation of a planted foot, rolled by rho about the heel (rho < 0) or the ball (rho > 0). */
  function poseStance(f, Ks) {
    ankleAt(f, f.rho, Ks, f.ankle);
    f.q.copy(q).multiply(q2.setFromAxisAngle(AX, f.rho));
  }

  /** Where a planted foot's ankle would be at roll rho (leaves its flat frame in q). */
  function ankleAt(f, rho, Ks, out) {
    flatFrame(q, f.yaw, f.nrm);
    // Rocking on the heel, or rolling over the toe joint (toes flat) and, the toes fully bent, over their tips.
    const r1 = Math.min(rho, TOE_MAX);
    const pz = (rho < 0 ? HEEL_Z : BALL_Z) * Ks;
    const py = (rho < 0 ? 0 : BALL_Y) * Ks;
    // Ankle relative to the pivot, rotated about the foot's lateral axis.
    let cr = Math.cos(r1);
    let sr = Math.sin(r1);
    const ay = ANKLE_H * Ks - py;
    const az = -pz;
    let y = ay * cr - az * sr + py;
    let z = ay * sr + az * cr + pz;
    if (rho > TOE_MAX) {
      const r2 = rho - TOE_MAX;
      const tz = TIP_Z * Ks;
      cr = Math.cos(r2);
      sr = Math.sin(r2);
      const dz = z - tz;
      z = y * sr + dz * cr + tz;
      y = y * cr - dz * sr;
    }
    return out.set(0, y, z).applyQuaternion(q).add(f.pos);
  }

  /** The ankle (world) of a foot planted at pos/yaw/nrm and pitched to rho on its heel: how a swing ends. */
  function heelStrikeAnkle(out, pos, yaw, nrm, rho, Ks) {
    flatFrame(q3, yaw, nrm);
    const pz = HEEL_Z * Ks;
    const cr = Math.cos(rho);
    const sr = Math.sin(rho);
    const ay = ANKLE_H * Ks;
    const az = -pz;
    return out.set(0, ay * cr - az * sr, ay * sr + az * cr + pz).applyQuaternion(q3).add(pos);
  }

  function plantAll(Ks, yaw, base) {
    st.feet = st.feet || { L: footState(), R: footState() };
    for (const n of ['L', 'R']) {
      const f = st.feet[n];
      const s = n === 'L' ? 1 : -1;
      f.pos.copy(base).addScaledVector(leftV, s * HIP_W * W_STAND * Ks);
      f.pos.y = groundAt(f.pos.x, f.pos.z);
      groundN(f.nrm);
      f.yaw = yaw + s * TOE_OUT;
      f.rho = f.rock = f.toe = 0;
      f.swing = null;
      poseStance(f, Ks);
    }
    st.phase = TO.L;
    st.holding = true;
  }

  /**
   * Gait timing for a speed (leg lengths/s): human cadence rises with the
   * square root of speed (a constant walk ratio), the swing staying ~0.4-0.5 s
   * while the double support stretches out as he slows.
   */
  function timing(vr) {
    const cad = clamp(1.56 * Math.sqrt(Math.max(vr, 0)), 1.5, 2.2); // steps/s (adjusting on the spot, quick small steps)
    const sw = 0.4 + 0.08 * smooth(0, 0.6, vr) - 0.07 * smooth(0.8, 1.7, vr);
    const ds = Math.max(0.07, 1 / cad - sw);
    return { sw, ds, stance: sw + 2 * ds };
  }
  let T = timing(0);

  /**
   * The stance knee's bend through stance (sigma 0..1, heel strike to toe off):
   * a few degrees at heel strike, flexing ~15 degrees as it takes the weight,
   * nearly straight by mid-stance; pre-swing (when the other foot is down) it
   * folds toward the swing's bend.
   */
  function kneeFlex(sigma, amp, pre) {
    const load = smooth(0, 0.18, sigma) * (1 - smooth(0.25, 0.5, sigma));
    return 0.087 + 0.2 * amp * load + 0.6 * pre * smooth(0.82, 1, sigma);
  }
  /** Hip to ankle for a knee bend (mesh units). */
  const legSpan = (flex) => Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * Math.cos(flex));

  /** Where foot n should land, tRem seconds from now: ahead of the hip by a share of the stance, toe out, not across the other foot. */
  function footTarget(n, tRem, Ks, ctx, out) {
    const s = n === 'L' ? 1 : -1;
    const lam = LEG * Ks;
    const ahead = tRem + (ctx.speed > 0.05 * lam ? 0.37 * T.stance : 0); // heel strike nearer than toe off is behind, as measured
    // The body ahead by then (decelerating: not past where it will stop).
    let tA = ahead;
    const along = ctx.acc.dot(v) / Math.max(1e-3, ctx.speed);
    if (along < -1e-3) tA = Math.min(ahead, ctx.speed / -along);
    out.copy(pxz).addScaledVector(v, tA).addScaledVector(ctx.acc, 0.5 * tA * tA * 0.5);
    // On a slope the stance moves up the hill: uphill he plants high ahead and pushes up over the
    // foot, downhill he lands under himself and leaves the foot behind, as on stairs (the shift
    // that asks the same of the leg at heel strike and at toe off).
    if (ctx.speed > 1e-3) {
      const g = ctx.grade;
      const shift = ctx.walk * 0.85 * (LEG - ANKLE_H) * Ks * g / (1 + g * g);
      out.x += (v.x / ctx.across) * shift;
      out.z += (v.z / ctx.across) * shift;
    }
    const yawL = ctx.yaw + clamp(st.yawRate * tRem, -0.6, 0.6);
    const lx = Math.cos(yawL);
    const lz = -Math.sin(yawL);
    const width = (W_STAND + (W_WALK - W_STAND) * ctx.walk + 1.0 * ctx.wide) * HIP_W * Ks;
    out.x += lx * s * width;
    out.z += lz * s * width;
    // Braced to fire: the firing side's foot back, the other forward and a little wider.
    if (ctx.brace) {
      const fwd = s * ctx.brace * 0.16 * lam;
      out.x += Math.sin(yawL) * fwd + lx * s * Math.abs(ctx.brace) * 0.05 * lam;
      out.z += Math.cos(yawL) * fwd + lz * s * Math.abs(ctx.brace) * 0.05 * lam;
    }
    // Not across the line of the other foot, and within a stride of it.
    const o = st.feet[n === 'L' ? 'R' : 'L'].pos;
    const lat = (out.x - o.x) * lx + (out.z - o.z) * lz;
    const minLat = 0.55 * HIP_W * Ks;
    if (s * lat < minLat) {
      out.x += lx * (s * minLat - lat);
      out.z += lz * (s * minLat - lat);
    }
    const dx = out.x - o.x;
    const dz = out.z - o.z;
    const dl = Math.hypot(dx, dz);
    const maxStep = 0.95 * lam;
    if (dl > maxStep) {
      out.x = o.x + (dx * maxStep) / dl;
      out.z = o.z + (dz * maxStep) / dl;
    }
    out.y = groundAt(out.x, out.z);
    // The foot turns with the body, at most ~45 degrees from the other per step (more takes pivot steps).
    const oy = st.feet[n === 'L' ? 'R' : 'L'].yaw;
    return oy + clamp(wrapA(yawL + s * TOE_OUT - oy), -0.8, 0.8);
  }

  /** Does foot n need to step (moving, or out of place: drifted, turned, or the stance changed)? */
  function needs(n, Ks, ctx) {
    if (!st.grounded || ctx.crouch > 0.3) return false;
    if (ctx.speed > V_GO * LEG * Ks) return true;
    const f = st.feet[n];
    const yawT = footTarget(n, T.sw, Ks, ctx, d3);
    const err = Math.hypot(d3.x - f.pos.x, d3.z - f.pos.z) / (LEG * Ks) + Math.abs(wrapA(yawT - f.yaw)) * 0.4;
    return err > 0.15;
  }

  function liftOff(n, Ks, ctx) {
    const f = st.feet[n];
    const sw = st.swings[n];
    sw.u = 0;
    sw.a0.copy(f.ankle);
    sw.yaw0 = f.yaw;
    sw.rho0 = f.rho;
    sw.toe0 = f.toe;
    sw.n0.copy(f.nrm);
    f.swing = sw;
    retarget(n, sw, Ks, ctx);
    // Leaving at the speed the foot already had (no stall at toe off): its share of the swing's travel.
    const dx = sw.a1.x - sw.a0.x;
    const dz = sw.a1.z - sw.a0.z;
    sw.v0 = clamp(((f.vel.x * dx + f.vel.z * dz) / Math.max(1e-3, dx * dx + dz * dz)) * T.sw, 0, 1.2);
    const lam = LEG * Ks;
    const step = Math.hypot(sw.tPos.x - f.pos.x, sw.tPos.z - f.pos.z) / lam;
    // Clearance: a few centimetres of toe clearance, more for a long stride or a step up.
    sw.lift = (0.035 + 0.035 * clamp(step / 0.6, 0, 1.3)) * lam + Math.max(0, sw.tPos.y - f.pos.y) * 0.25;
  }

  function retarget(n, sw, Ks, ctx) {
    const f = st.feet[n];
    sw.tYaw = footTarget(n, (1 - sw.u) * T.sw, Ks, ctx, sw.tPos);
    groundN(sw.tNrm);
    const step = Math.hypot(sw.tPos.x - f.pos.x, sw.tPos.z - f.pos.z) / (LEG * Ks);
    sw.tRho = HS_ROLL * clamp(step / 0.55, 0.25, 1) * (1 - clamp(ctx.grade * 1.6, 0, 0.85)); // a short step, or one up a slope, lands nearly flat
    heelStrikeAnkle(sw.a1, sw.tPos, sw.tYaw, sw.tNrm, sw.tRho, Ks);
  }

  function land(n) {
    const f = st.feet[n];
    const sw = f.swing;
    if (!sw) return;
    f.pos.copy(sw.tPos);
    f.nrm.copy(sw.tNrm);
    f.yaw = sw.tYaw;
    f.rho = f.rock = sw.tRho;
    f.toe = 0;
    f.landT = st.time;
    f.swing = null;
  }

  /** The swing foot's ankle path: a minimum-jerk glide to the heel strike, lifted clear early in the swing. */
  function poseSwing(f, Ks, ctx, n) {
    const sw = f.swing;
    const u = sw.u;
    if (u < 0.72) retarget(n, sw, Ks, ctx);
    const s = minJerk(u) + sw.v0 * u * (1 - u) ** 3 * (1 + 3 * u);
    f.ankle.lerpVectors(sw.a0, sw.a1, s);
    f.ankle.y = sw.a0.y + (sw.a1.y - sw.a0.y) * s + sw.lift * Math.sin(Math.PI * u ** 0.6) ** 1.4; // (the ground is a plane: clear of it all the way)
    // Going downhill the body is still high late in the swing: the foot comes down with it rather
    // than reaching for the ground early (an overreaching, locked knee).
    if (v.y < 0) f.ankle.y -= v.y * T.sw * Math.max(0, s - u);
    f.yaw = sw.yaw0 + wrapA(sw.tYaw - sw.yaw0) * s;
    f.rho = sw.rho0 * (1 - smooth(0, 0.5, u)) + sw.tRho * smooth(0.45, 0.92, u);
    f.toe = sw.toe0 * (1 - smooth(0, 0.35, u));
    a3.lerpVectors(sw.n0, sw.tNrm, s).normalize();
    flatFrame(q, f.yaw, a3);
    f.q.copy(q).multiply(q2.setFromAxisAngle(AX, f.rho));
  }

  /** Planted: the heel rocks down after the strike; late in stance the heel rises over the ball, toes flat. */
  function updateStance(n, f, Ks, ctx) {
    const sigma = (f.sigma = frac(st.phase - HS[n] + 1) / (0.5 + DS));
    const rock = f.rock * (1 - smooth(0, Math.max(0.06, T.ds * 0.9), st.time - f.landT));
    // The heel may peel up through terminal stance, if the foot is behind him and he is striding.
    b3.copy(f.pos).sub(pxz);
    const behind = -(b3.x * heading.x + b3.z * heading.z) / (LEG * Ks);
    f.rhoLo = rock < -1e-3 ? rock : 0;
    // (A real foot: heel off just after mid-stance, ~17 degrees up by the other heel strike, ~50 by toe off.)
    f.rhoHi = rock < -1e-3 ? rock : RISE_MAX * clamp((sigma - 0.5) / 0.5, 0, 1) ** 2.5 * smooth(0.0, 0.18, behind) * clamp(ctx.active * 2, 0, 1);
    f.rho = f.rhoLo;
    // Crouched for a leap: he turns on the balls of his feet instead of stepping.
    if (ctx.crouch > 0.3) {
      const want = ctx.yaw + (n === 'L' ? 1 : -1) * TOE_OUT;
      const dy = clamp(wrapA(want - f.yaw), -3 * ctx.dt, 3 * ctx.dt);
      if (Math.abs(dy) > 1e-5) {
        flatFrame(q, f.yaw, f.nrm);
        a3.set(0, BALL_Y * Ks, BALL_Z * Ks).applyQuaternion(q).add(f.pos); // the ball, fixed
        b3.copy(f.pos).sub(a3).applyAxisAngle(f.nrm, dy);
        f.pos.copy(a3).add(b3);
        f.yaw += dy;
      }
    }
    f.toe = f.rho > 0 ? Math.min(f.rho, TOE_MAX) : 0;
    poseStance(f, Ks);
  }

  /**
   * Run the stride clock: single supports at the swing's pace, double supports
   * stretching with slowness; at each toe off the foot lifts only if it needs
   * to, otherwise he stands (or the other foot steps first).
   */
  function runClock(dt, Ks, ctx) {
    let left = dt;
    let moved = false;
    for (let guard = 0; guard < 8 && left > 1e-7; guard++) {
      const ph = st.phase;
      // At a toe off: go, let the other foot go first, or stand.
      for (const n of ['L', 'R']) {
        if (Math.abs(ph - TO[n]) < 1e-9 && !st.feet[n].swing) {
          const m = n === 'L' ? 'R' : 'L';
          if (needs(n, Ks, ctx)) {
            st.holding = false;
            liftOff(n, Ks, ctx);
          } else if (needs(m, Ks, ctx)) {
            st.phase = TO[m];
            st.holding = false;
            liftOff(m, Ks, ctx);
          } else st.holding = true;
        }
      }
      if (st.holding) return moved;
      const p = st.phase;
      // Segment: single support (a foot swinging) or double support.
      const single = (p >= TO.R && p < HS.R) || p >= TO.L;
      const rate = single ? SS / T.sw : DS / T.ds;
      const bounds = [TO.R, HS.R, TO.L, 1];
      let b = 1;
      for (const x of bounds) if (x > p) {
        b = x;
        break;
      }
      const need = (b - p) / rate;
      if (need > left) {
        st.phase = p + rate * left;
        left = 0;
      } else {
        st.phase = b >= 1 ? 0 : b;
        left -= need;
        if (b === HS.R) land('R');
        if (b >= 1) land('L');
      }
      moved = true;
    }
    return moved;
  }

  /* ---------------- legs ---------------- */

  /**
   * Two-bone IK for one leg toward its ankle target, the knee toward the
   * foot's heading (and the thigh and shin turned with it); soft near full
   * reach so the knee eases straight instead of snapping.
   */
  function solveLeg(g, f) {
    a3.copy(f.ankle).applyMatrix4(inv); // into the pelvis bone's frame (mesh units)
    const t = a3.sub(g.hip.position);
    const reach = L1 + L2;
    const soft = 0.9993 * reach;
    let d = t.length();
    if (d > soft) d = soft + (reach - soft) * (1 - Math.exp(-(d - soft) / (reach - soft)));
    d = Math.max(d, 0.3 * reach);
    const u = t.normalize();
    // Knee pole: where the foot points (in the pelvis frame), a little outward.
    b3.set(0, 0, 1).applyQuaternion(f.q).applyQuaternion(qInv.copy(rootQ).invert());
    b3.y = 0;
    b3.normalize().multiplyScalar(0.75).add(c3.set(g.s * 0.12, 0, 0.25));
    const pole = perp(b3, u, AZ);
    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const d1 = c3.copy(u).multiplyScalar(cosA).addScaledVector(pole, sinA);
    basisQ(g.hip.quaternion, g.restThigh, AZ, d1, pole);
    // Shin: from the knee to the ankle, in the thigh's frame.
    const knee = d1.multiplyScalar(L1);
    const d2 = e3.copy(u).multiplyScalar(d).sub(knee).normalize();
    qInv.copy(g.hip.quaternion).invert();
    d2.applyQuaternion(qInv);
    f3.copy(pole).applyQuaternion(qInv);
    basisQ(g.knee.quaternion, g.restShin, AZ, d2, f3);
    // Foot: its world orientation, in the shin's frame.
    q.copy(rootQ).multiply(g.hip.quaternion).multiply(g.knee.quaternion).invert();
    g.ankle.quaternion.copy(q).multiply(f.q);
    g.toe.quaternion.setFromAxisAngle(AX, -f.toe);
  }

  /* ---------------- arms ---------------- */

  /**
   * The repulsor pose for one arm, as bone rotations (slerped in by the caller):
   * the arm along `dir` from the shoulder with a soft elbow, rolled so the palm
   * faces down before the wrist bends back: palm to the target, fingers up and
   * back. Recoil climbs the muzzle and draws the hand in.
   */
  const aimQ = { sh: new THREE.Quaternion(), el: new THREE.Quaternion(), wr: new THREE.Quaternion() };
  const qUpper = new THREE.Quaternion();
  const qFore = new THREE.Quaternion();
  const qHand = new THREE.Quaternion();
  const qPar = new THREE.Quaternion();
  function aimPose(gA, dir, rec) {
    const s = gA.s;
    // Up, as the arm sees it: the world's, square to the arm.
    const upv = d3.copy(UP).addScaledVector(dir, -dir.dot(UP));
    if (upv.lengthSq() < 1e-4) upv.copy(heading);
    upv.normalize();
    // Muzzle climb: the blast throws the hand up about the arm's lateral axis.
    const d = e3.copy(dir).applyAxisAngle(f3.crossVectors(dir, upv).normalize(), 0.2 * rec).normalize();
    perp(upv, d, heading);
    // Elbow: soft, a little more as the blast drives the hand back.
    const ext = clamp(0.985 - 0.06 * rec, 0.8, 0.99);
    const r = ext * (LU + LF);
    const cosA = clamp((LU * LU + r * r - LF * LF) / (2 * LU * r), -1, 1);
    const ang = Math.acos(cosA);
    // Elbow points out and down from the line (its hinge across the palm's plane).
    const nPre = b3.copy(upv).negate(); // the palm before the wrist bends: facing down
    const elbowOut = c3.crossVectors(d, nPre).multiplyScalar(s); // lateral, away from the body
    elbowOut.addScaledVector(nPre, 0.6).normalize();
    perp(elbowOut, d, nPre);
    const d1 = a3.copy(d).applyAxisAngle(f3.crossVectors(d, elbowOut).normalize(), ang);
    // Upper arm.
    gA.clav.getWorldQuaternion(qPar);
    basisQ(qUpper, gA.restUpper, gA.palmN, d1, nPre);
    aimQ.sh.copy(qPar).invert().multiply(qUpper);
    // Forearm: from the elbow to the wrist on the line.
    const elbow = a3.multiplyScalar(LU);
    const d2 = f3.copy(d).multiplyScalar(r).sub(elbow).normalize();
    basisQ(qFore, gA.restFore, gA.palmN, d2, nPre);
    aimQ.el.copy(qUpper).invert().multiply(qFore);
    // Hand: palm toward the target, tipped up a little; fingers up and back; the blast bends it back further.
    const tip = 0.3 + 0.25 * rec;
    a3.copy(d).addScaledVector(upv, tip).normalize(); // palm normal
    b3.copy(upv).addScaledVector(d, -tip).normalize(); // fingers
    basisQ(qHand, gA.palmN, gA.fingers, a3, b3);
    aimQ.wr.copy(qFore).invert().multiply(qHand);
  }

  /* ---------------- the model, driven by the rig ---------------- */

  const PQ = new Map(); // rig bone -> its orientation in model space (the rig's rest pose is unrotated)
  const fingerCurl = { L: 0.4, R: 0.4 };
  const qc = new THREE.Quaternion();
  const XAX = new THREE.Vector3(1, 0, 0);
  const pelvisRest = V(J.pelvis);
  const pv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  /** Map the model's deform bones onto the rig's, with their rest orientations in model space. */
  function rigModel(m) {
    const drv = {};
    const set = (bone, names) => names.forEach((nm) => (drv[nm] = bone));
    set(sk.root, ['DEF-spine', 'DEF-pelvisL', 'DEF-pelvisR']);
    set(sk.spine, ['DEF-spine001', 'DEF-spine002']);
    set(sk.chest, ['DEF-spine003', 'DEF-spine004', 'DEF-breastL', 'DEF-breastR']);
    set(sk.neck, ['DEF-spine005', 'DEF-spine006']);
    for (const n of ['L', 'R']) {
      const g = sk.limbs[n];
      set(g.clav, [`DEF-shoulder${n}`]);
      set(g.sh, [`DEF-upper_arm${n}`, `DEF-upper_arm${n}001`]);
      set(g.el, [`DEF-forearm${n}`, `DEF-forearm${n}001`]);
      set(g.hip, [`DEF-thigh${n}`, `DEF-thigh${n}001`]);
      set(g.knee, [`DEF-shin${n}`, `DEF-shin${n}001`]);
      set(g.ankle, [`DEF-foot${n}`]);
      set(g.toe, [`DEF-toe${n}`]);
      // The fingers bend at the knuckles with the rig's knuckle bone; the thumb and palm stay with the hand.
      for (const f of ['index', 'middle', 'ring', 'pinky']) set(g.knuckles, ['01', '02', '03'].map((k) => `DEF-f_${f}${k}${n}`));
    }
    const root = m.bones['DEF-spine'];
    const order = [];
    const byBone = new Map();
    root.traverse((b) => {
      if (!b.isBone) return;
      const parent = b === root ? null : byBone.get(b.parent);
      const restQ = (parent ? parent.restQ.clone() : new THREE.Quaternion()).multiply(b.quaternion);
      const side = b.name.endsWith('L') ? 'L' : 'R';
      const e = { bone: b, parent, restQ, q: new THREE.Quaternion(), drv: drv[b.name] || sk.limbs[side].wr, side };
      // The finger joints past the knuckle curl further on their own (the rig bends only the knuckle).
      e.distal = /^DEF-f_.*0[23][LR]$/.test(b.name);
      byBone.set(b, e);
      order.push(e);
    });
    return { m, order, root, rootRest: root.position.clone() };
  }

  /** The rig's orientation of each bone in model space. */
  function rigQuats() {
    sk.root.traverse((b) => {
      let q4 = PQ.get(b);
      if (!q4) PQ.set(b, (q4 = new THREE.Quaternion()));
      if (b === sk.root) q4.copy(b.quaternion);
      else q4.copy(PQ.get(b.parent)).multiply(b.quaternion);
    });
  }

  /**
   * Pose the model: each deform bone turned in model space as its rig bone has turned from
   * rest, the pelvis carried as the rig's is, the finger joints curling with the knuckle; then,
   * upright in the air, the artist's hover pose blended in.
   */
  function drive(md, hover) {
    rigQuats();
    for (const e of md.order) {
      e.q.copy(PQ.get(e.drv)).multiply(e.restQ);
      if (e.parent) e.bone.quaternion.copy(e.parent.q).invert().multiply(e.q);
      else e.bone.quaternion.copy(e.q);
      if (e.distal) e.bone.quaternion.multiply(qc.setFromAxisAngle(XAX, 0.8 * fingerCurl[e.side]));
    }
    md.root.position.copy(md.rootRest).add(a3.copy(sk.root.position).sub(pelvisRest));
    if (hover > 1e-3) {
      const pose = POSE['Fly Pose'];
      for (const e of md.order) {
        const vq = pose[e.bone.name];
        if (!vq) continue;
        e.bone.quaternion.slerp(qc.set(vq[0], vq[1], vq[2], vq[3]), 0.9 * hover);
        if (e.bone === md.root) e.bone.position.lerp(a3.set(vq[4], vq[5], vq[6]), 0.9 * hover);
      }
    }
  }

  /** Centre of a palm, just off its face (world): where the repulsor fires from. */
  function palmOf(md, n, out) {
    const b = md.m.bones;
    const [hand, mid, idx, pinky] = pv;
    b[`DEF-hand${n}`].getWorldPosition(hand);
    b[`DEF-f_middle01${n}`].getWorldPosition(mid);
    b[`DEF-f_index01${n}`].getWorldPosition(idx);
    b[`DEF-f_pinky01${n}`].getWorldPosition(pinky);
    idx.sub(pinky); // across the knuckles
    pinky.copy(mid).sub(hand); // along the hand
    const len = pinky.length();
    hand.crossVectors(pinky, idx).normalize().multiplyScalar(n === 'L' ? 1 : -1); // the palm's face
    b[`DEF-palm02${n}`].getWorldPosition(out);
    return out.add(mid).multiplyScalar(0.5).addScaledVector(hand, 0.3 * len);
  }

  /* ---------------- per frame ---------------- */

  /**
   * Place, pose and light him for this frame, and draw his rays.
   * @param {object} spider the spider as drawn (p, b, F, v, taut, air, crouch, jolt, time, legs)
   * @param {number} frameDt real seconds since the last frame
   * @param {THREE.Camera} camera
   * @param {{at:number[], id:number, p:number}[]} targets words his palms are firing at, and how far each ray has reached
   * @param {number} halfH half the drawing buffer's height (px), for sprite sizes
   */
  function update(spider, frameDt, camera, targets = [], halfH = 450) {
    // A jump in time (a seek) lands every spring and replants the feet; otherwise steps are capped.
    const jumped = frameDt > 0.3;
    const dt = clamp(frameDt, 0, 0.1);
    const sdt = jumped ? frameDt : dt;
    st.time += dt;
    v.set(spider.v[0], spider.v[1], spider.v[2]);
    const speed3 = v.length();
    a3.set(spider.F[0], 0, spider.F[2]);
    if (a3.lengthSq() > 1e-6) heading.copy(a3.normalize());
    leftV.set(heading.z, 0, -heading.x); // his left
    const yaw = Math.atan2(heading.x, heading.z);
    if (st.prevYaw !== null && dt > 0 && !jumped) st.yawRate += (wrapA(yaw - st.prevYaw) / dt - st.yawRate) * (1 - Math.exp(-6 * dt));
    if (jumped) st.yawRate = 0;
    st.prevYaw = yaw;
    if (dt > 0 && !jumped) st.acc.lerp(a3.copy(v).sub(st.prevV).divideScalar(dt), 1 - Math.exp(-5 * dt));
    else if (jumped) st.acc.set(0, 0, 0);
    st.acc.y = 0;
    st.prevV.copy(v);
    const fly = ez.fly.to(spider.taut || 0, sdt);
    const air = ez.air.to(spider.air || 0, sdt);
    const crouch = clamp(ez.crouch.to(spider.crouch && !spider.air ? 1 : 0, sdt), 0, 1.1);
    const g = clamp(Math.max(air, fly), 0, 1); // off the ground
    const scale = 1; // true size in flight too: the in-flight shot comes in close instead
    // Flight attitude: he leaves upright on his thrusters, pitches forward into the flight, and
    // swings back upright to brake on his boots before he lands.
    const uAir = spider.airU || 0;
    const att = clamp(ez.att.to((spider.taut || 0) * smooth(0, 0.24, uAir) * (1 - smooth(0.62, 0.88, uAir)), sdt), 0, 1);
    const Ks = K * scale;
    const lam = LEG * Ks;

    fitGround(spider, sdt);
    pxz.set(spider.p[0], st.gy, spider.p[2]);
    const across = Math.hypot(v.x, v.z);
    // Speed along the slope (climbing a grade covers more ground per stride than its plan view).
    const speed = across * Math.sqrt(1 + (st.gx * heading.x + st.gz * heading.z) ** 2);
    const speedS = ez.speed.to(speed, sdt);
    const vr = speedS / lam;
    const walk = ez.walk.to((1 - g) * clamp(vr / 1.15, 0, 1.3), sdt);
    T = timing(vr);

    /* ---- targets: each hand keeps to its word, taking the newest on its side ---- */
    const now = spider.time;
    for (const t of targets) {
      a3.set(t.at[0] - spider.p[0], 0, t.at[2] - spider.p[2]);
      // The hand on its side; a word nearly straight ahead goes to the hand already up.
      const az = Math.atan2(a3.dot(leftV), a3.dot(heading));
      t.side = az > 0 ? 'L' : 'R';
      if (Math.abs(az) < 0.4 && st.aim.L.has !== st.aim.R.has) t.side = st.aim.L.has ? 'L' : 'R';
      let rec = st.seen.get(t.id);
      if (!rec) st.seen.set(t.id, (rec = { t: now, p: t.p, back: false }));
      rec.back = t.p < rec.p - 1e-4; // retracting
      rec.p = t.p;
      rec.live = true;
    }
    for (const [id, rec] of st.seen) {
      if (!rec.live) st.seen.delete(id);
      else rec.live = false;
    }
    const tgt = { L: null, R: null };
    for (const n of ['L', 'R']) {
      const A = st.aim[n];
      let cur = null;
      let best = null;
      for (const t of targets) {
        if (t.side !== n) continue;
        const rec = st.seen.get(t.id);
        if (t.id === A.id && !rec.back) cur = t;
        if (!best || (!rec.back && (st.seen.get(best.id).back || rec.t > st.seen.get(best.id).t))) best = t;
      }
      // Switch to a newer word, but not more than ~4 times a second (the eye leads, the arm follows).
      const pick = cur && now - A.seen < 0.25 ? cur : best && best.id !== A.id && !st.seen.get(best.id).back ? best : cur || best;
      if (pick && pick.id !== A.id) {
        A.id = pick.id;
        A.seen = now;
      }
      tgt[n] = pick;
      // The arm comes up for a fresh word on its side and stays up between quick shots.
      if (pick && now - st.seen.get(pick.id).t < 1) {
        A.fresh = now;
        A.born = st.seen.get(pick.id).t;
      }
      A.has = now - A.fresh < 0.45;
    }
    // One hand at a time, mostly: walking, only the hand on the newest word's side fires (the other
    // keeps swinging), unless both sides came up together; standing, both may.
    const walkingOn = speedS > 1.5 * V_GO * lam;
    if (st.aim.L.has && st.aim.R.has && walkingOn && Math.abs(st.aim.L.born - st.aim.R.born) > 0.25) {
      const older = st.aim.L.born < st.aim.R.born ? 'L' : 'R';
      st.aim[older].has = false;
    }
    for (const n of ['L', 'R']) if (!st.aim[n].has) tgt[n] = null;
    const firingStill = (st.aim.L.has || st.aim.R.has) && !walkingOn;
    const both = firingStill && st.aim.L.has && st.aim.R.has;
    const brace = ez.brace.to(firingStill && !both ? (st.aim.R.has ? 1 : -1) : 0, sdt);
    const wide = ez.wide.to(both ? 1 : 0, sdt); // firing both ways: feet apart, knees bent

    // Feet: (re)planted where they stand when he comes down, or on a jump in time.
    if (!st.feet || jumped || Math.hypot(st.feet.L.pos.x - spider.p[0], st.feet.L.pos.z - spider.p[2]) > 3 * U) plantAll(Ks, yaw, pxz);
    if (st.grounded && g > 0.6) {
      st.grounded = false;
      st.landDipArmed = true;
    }
    const ctx = { speed: speedS, across: Math.max(1e-3, across), grade: (st.gx * v.x + st.gz * v.z) / Math.max(1e-3, across), yaw, walk: clamp(walk, 0, 1), crouch, acc: st.acc, brace: firingStill ? brace : 0, wide, dt, active: ez.active.x };
    if (!st.grounded && g < 0.35) {
      st.grounded = true;
      // Down on both feet, under the hips, a little apart and one a touch ahead (as a landing is taken).
      plantAll(Ks, yaw, pxz);
      for (const n of ['L', 'R']) {
        const f = st.feet[n];
        const s = n === 'L' ? 1 : -1;
        f.pos.addScaledVector(leftV, s * 0.25 * HIP_W * Ks).addScaledVector(heading, s * 0.06 * lam);
        f.pos.y = groundAt(f.pos.x, f.pos.z);
        poseStance(f, Ks);
      }
      // Coming down: the knees take the landing.
      if (st.landDipArmed) ez.land.kick(0.9);
      st.landDipArmed = false;
    }

    // Off the ground the legs hang under him (as the flight pose lets go, they reach down, not back
    // to where he took off).
    if (!st.grounded) {
      for (const n of ['L', 'R']) {
        const f = st.feet[n];
        f.pos.copy(group.position).addScaledVector(leftV, (n === 'L' ? 1 : -1) * HIP_W * Ks);
        f.pos.y -= J.pelvis[1] * Ks - 0.04 * U;
        f.nrm.copy(UP);
        f.yaw = yaw + (n === 'L' ? 1 : -1) * TOE_OUT;
        f.swing = null;
      }
    }

    /* ---- stride ---- */
    let stepping = false;
    if (st.grounded && dt > 0) stepping = runClock(dt, Ks, ctx);
    const active = clamp(ez.active.to(stepping ? 1 : 0, sdt), 0, 1);
    const ph = st.phase;
    for (const n of ['L', 'R']) {
      const f = st.feet[n];
      if (f.swing) {
        f.swing.u = clamp(frac(ph - TO[n] + 1) / SS, 0, 1);
        poseSwing(f, Ks, ctx, n);
      } else updateStance(n, f, Ks, ctx);
    }

    /* ---- pelvis: over the stance foot, as high as the stance leg's knee allows ---- */
    const amp = active * clamp(walk, 0, 1.2);
    const shift = ez.shift.to((1 - active) * (1 - clamp(walk * 3, 0, 1)) * (hash(Math.floor(now / 3.7)) - 0.5) * 2 * (1 - crouch), sdt); // idle: weight onto one leg, now and then
    const dip = ez.land.to(0, sdt);
    // Over the stance foot (leading the step a little); at rest, the weight shifts.
    const latAmp = (0.034 - 0.012 * clamp(walk, 0, 1)) * lam * active;
    const sway = ez.sway.to(latAmp * Math.sin(2 * Math.PI * (ph - 0.02)) + shift * 0.045 * lam, sdt);
    // The blasts push him back a touch.
    const push = (ez.kick.L.x + ez.kick.R.x) * 0.012 * lam;

    // Orientation: upright on the ground (crouching, he folds forward); head-first, chest down, in flight.
    H.copy(UP).addScaledVector(heading, 0.12 * crouch).normalize();
    C.copy(heading);
    if (att > 0.01 && speed3 > 5) {
      a3.copy(v).divideScalar(speed3);
      H.lerp(a3, att).normalize();
      C.lerp(UP, -att);
    }
    perp(C, H, heading);
    const k = jumped ? 1 : 1 - Math.exp(-9 * dt);
    head.lerp(H, k).normalize();
    chestDir.lerp(C, k);
    perp(chestDir, head, heading);
    X.crossVectors(head, chestDir);
    basis.makeBasis(X, head, chestDir);
    body.quaternion.setFromRotationMatrix(basis);

    /* ---- where he looks and turns: to the newest word, else along the way (glancing about when idle) ---- */
    let lookY = 0;
    let lookP = 0.12 * clamp(walk, 0, 1); // walking: eyes a few steps ahead
    let twistTo = 0;
    let nT = 0;
    let newest = null;
    for (const n of ['L', 'R']) {
      const t = tgt[n];
      if (!t) continue;
      a3.set(t.at[0] - spider.p[0], 0, t.at[2] - spider.p[2]);
      const az = Math.atan2(a3.dot(leftV), a3.x * heading.x + a3.z * heading.z);
      // The firing arm is comfortable a little off the chest's line, on its own side.
      twistTo += az - (n === 'L' ? 0.45 : -0.45);
      nT++;
      if (!newest || st.seen.get(t.id).t > st.seen.get(newest.id).t) newest = t;
    }
    if (newest) {
      a3.set(newest.at[0] - spider.p[0], newest.at[1] - (st.gy + 1.6 * lam), newest.at[2] - spider.p[2]);
      lookY = Math.atan2(a3.dot(leftV), a3.x * heading.x + a3.z * heading.z);
      lookP = -Math.atan2(a3.y, Math.hypot(a3.x, a3.z));
    } else if (!st.aim.L.has && !st.aim.R.has) {
      // Idle glances: a look somewhere every couple of seconds, held, then back.
      const idle = (1 - clamp(walk * 2, 0, 1)) * (1 - crouch);
      const slot = Math.floor(now / 2.3);
      const on = hash(slot * 3.1) > 0.35 ? 1 : 0;
      lookY += idle * on * (hash(slot) - 0.5) * 1.6;
      lookP += idle * on * (hash(slot + 0.37) - 0.6) * 0.5;
    }
    const twist = ez.twist.to(clamp(nT ? twistTo / nT : 0, -0.75, 0.75) * (1 - g), sdt);
    const neckY = ez.lookY.to(clamp(lookY, -1.25, 1.25) * (1 - g), sdt);
    const neckP = ez.lookP.to(clamp(lookP, -0.5, 0.45) * (1 - g), sdt);

    /* ---- pelvis bone: stride rotation and list; the hips lag a turn on the spot ---- */
    const rotAmp = (0.045 + 0.045 * clamp(walk, 0, 1.2)) * active;
    const pelvisYaw = -rotAmp * Math.cos(2 * Math.PI * ph);
    const pelvisRoll = (0.075 * active * Math.sin(2 * Math.PI * (ph + 0.08)) - 0.07 * shift) * (1 - g);
    const feetYaw = Math.atan2(Math.sin(st.feet.L.yaw) + Math.sin(st.feet.R.yaw), Math.cos(st.feet.L.yaw) + Math.cos(st.feet.R.yaw));
    const hips = ez.hips.to(clamp(wrapA(feetYaw - yaw) * 0.6, -0.6, 0.6) * (1 - g) + twist * 0.3, sdt);
    const tilt = 0.025 * active * Math.cos(4 * Math.PI * (ph - 0.1));
    sk.root.position.y = pelvisY0;
    sk.root.rotation.set(tilt, (pelvisYaw + hips) * (1 - g), pelvisRoll);

    // Height: placed provisionally, then raised or lowered so the leading stance leg has the knee
    // bend of its moment in the stride (a soft knee taking the weight after heel strike, nearly
    // straight at mid-stance): the inverted pendulum's rise and fall, lowest at double support.
    if (ez.pelvisY.x === 0 || jumped) ez.pelvisY.x = J.pelvis[1] * Ks;
    const yJolt = Math.min(0, spider.jolt || 0) * 3;
    const onGround = b3.set(spider.p[0], st.gy + ez.pelvisY.x + yJolt, spider.p[2]).addScaledVector(leftV, sway).addScaledVector(heading, -push);
    group.position.copy(onGround);
    group.updateMatrixWorld(true);
    // (Crouching, taking a landing, braced to fire: that much lower than the legs would hold him.)
    const lower = 0.24 * U * clamp(crouch, 0, 1) + Math.max(0, dip) * 0.16 * lam + 0.015 * lam * Math.abs(brace) + 0.02 * lam * wide;
    let hCon = Infinity;
    for (const n of ['L', 'R']) {
      const f = st.feet[n];
      if (f.swing || !st.grounded) continue;
      // This leg holds him up to where it reaches with this moment's knee bend and the heel as
      // far up as it may be. Trailing, it is unloading: it holds nothing up once the other foot is
      // down, and folds (pre-swing) only as its heel comes up.
      f.flex = kneeFlex(f.sigma, amp, active * clamp(walk * 1.5 + 0.3, 0, 1));
      sk.limbs[n].hip.getWorldPosition(hipW);
      ankleAt(f, f.rhoHi, Ks, c3);
      const dT = legSpan(kneeFlex(f.sigma, amp, 0)) * Ks;
      const dx = hipW.x - c3.x;
      const dz = hipW.z - c3.z;
      const hT = c3.y + Math.sqrt(Math.max(0, dT * dT - dx * dx - dz * dz)) - (hipW.y - group.position.y) - st.gy - yJolt + 2 * lam * smooth(0.94, 1, f.sigma) * active;
      hCon = hCon === Infinity ? hT : smin(hCon, hT, 0.004 * lam);
    }
    // The swinging leg reaches for the ground before it lands: the body is already coming down onto it.
    for (const n of ['L', 'R']) {
      const sw = st.feet[n].swing;
      if (!sw || sw.u < 0.4 || !st.grounded) continue;
      sk.limbs[n].hip.getWorldPosition(hipW);
      const dT = legSpan(kneeFlex(0, amp, 0) + 0.06) * Ks; // (a margin: the list and turn of the pelvis by then)
      const tRem = (1 - sw.u) * T.sw; // the hip where it will be at contact
      const dx = hipW.x + v.x * tRem - sw.a1.x;
      const dz = hipW.z + v.z * tRem - sw.a1.z;
      const gyThen = st.gy + (st.gx * v.x + st.gz * v.z) * tRem; // the ground under him by then (on a slope he has climbed or come down)
      const hT = sw.a1.y + Math.sqrt(Math.max(0, dT * dT - dx * dx - dz * dz)) - (hipW.y - group.position.y) - gyThen - yJolt + 0.06 * lam * (1 - smooth(0.4, 0.95, sw.u));
      hCon = hCon === Infinity ? hT : smin(hCon, hT, 0.004 * lam);
    }
    let hDes = hCon === Infinity ? J.pelvis[1] * Ks : hCon;
    // Striding, the body rises only from the end of the loading response to mid-stance (vaulting
    // over the new stance leg), and comes down from there to the next loading response: one
    // smooth rise and fall per step.
    let lead = 1;
    for (const n of ['L', 'R']) if (!st.feet[n].swing) lead = Math.min(lead, st.feet[n].sigma);
    const rising = lead > 0.12 && lead < 0.5;
    if (active > 0.5 && st.grounded && !rising && st.hLast !== undefined && !jumped) hDes = Math.min(hDes, st.hLast + 0.02 * lam * dt);
    st.hLast = hDes;
    // Quick to come down (a leg never left overreaching), gentler going up.
    ez.pelvisY.w = hDes - lower < ez.pelvisY.x ? 60 : 16;
    const pelvisH = ez.pelvisY.to(hDes - lower, sdt);
    onGround.y = st.gy + pelvisH + yJolt;
    group.position.set(onGround.x + (spider.b[0] - onGround.x) * g, onGround.y + (spider.b[1] - onGround.y) * g, onGround.z + (spider.b[2] - onGround.z) * g);
    group.updateMatrixWorld(true);

    /* ---- legs: IK onto the planted and swinging feet, the trailing heel peeling up as it must ---- */
    inv.copy(sk.root.matrixWorld).invert();
    sk.root.getWorldQuaternion(rootQ);
    for (const n of ['L', 'R']) {
      const gL = sk.limbs[n];
      const f = st.feet[n];
      if (!f.swing && st.grounded && g < 0.999) {
        // Longer than this moment's knee bend allows: roll up onto the ball (behind) or back onto
        // the heel (ahead). Pre-swing, the knee flexes and the heel comes well up before toe off.
        gL.hip.getWorldPosition(hipW);
        const reachW = legSpan(f.flex) * Ks;
        if (hipW.distanceTo(f.ankle) > reachW) {
          // Which way rolling helps: back onto the heel if the ankle is ahead of the hip, over the ball if behind.
          const ahead = (f.ankle.x - hipW.x) * heading.x + (f.ankle.z - hipW.z) * heading.z > 0;
          let lo = f.rho;
          let hi = ahead ? -0.5 : f.sigma > 0.5 ? TOE_MAX + 0.6 : Math.max(f.rhoHi, 0.05); // a heel up early rather than a foot sliding
          for (let i = 0; i < 12; i++) {
            f.rho = (lo + hi) / 2;
            poseStance(f, Ks);
            if (hipW.distanceTo(f.ankle) > reachW) lo = f.rho;
            else hi = f.rho;
          }
          f.rho = hi;
          f.toe = f.rho > 0 ? Math.min(f.rho, TOE_MAX) : 0;
          poseStance(f, Ks);
        }
      }
      if (g < 0.999) solveLeg(gL, f);
      if (g > 0.001) {
        const legs = [[gL.hip, 0.12 * att - 0.15 * air * (1 - att), 0, -gL.s * 0.03 * att], [gL.knee, 0.18 * att + 0.35 * air * (1 - att), 0, 0], [gL.ankle, 0.5 * fly + 0.2 * air * (1 - fly), 0, 0]];
        for (const [bone, x, y, z] of legs) {
          if (g >= 0.999) bone.quaternion.setFromEuler(euler.set(x, y, z));
          else bone.quaternion.slerp(flightQ.setFromEuler(euler.set(x, y, z)), g);
        }
        gL.toe.quaternion.slerp(flightQ.identity(), g);
      }
    }

    for (const n of ['L', 'R']) {
      const f = st.feet[n];
      if (dt > 0 && !jumped) f.vel.copy(f.ankle).sub(f.last).divideScalar(dt);
      else f.vel.set(0, 0, 0);
      f.last.copy(f.ankle);
    }

    /* ---- torso and head ---- */
    // Thorax against the pelvis (shoulders counter-rotate), leaning into the walk, up a slope, into a
    // speed-up; chest turned to the words; breathing; the head held level and looking.
    const breath = Math.sin(spider.time * 1.6);
    const cr = clamp(crouch, 0, 1);
    const grade = st.gx * heading.x + st.gz * heading.z;
    const accel = st.acc.dot(heading) / lam;
    const lean = ez.lean.to((0.045 * clamp(walk, 0, 1.2) + 0.35 * clamp(Math.atan(grade), -0.4, 0.6) * (grade > 0 ? 1 : 0.4) + clamp(accel * 0.06, -0.08, 0.1)) * (1 - g), sdt);
    const kickB = ez.kick.L.x + ez.kick.R.x;
    const kickT = (ez.kick.R.x - ez.kick.L.x) * 0.05; // the firing side's shoulder driven back
    const counter = -1.6 * pelvisYaw * (1 - g);
    const turnUp = -(hips) + twist;
    sk.spine.rotation.set(0.5 * lean + 0.32 * cr + 0.012 * breath - 0.02 * kickB, 0.45 * (counter + turnUp) + kickT * 0.4, -pelvisRoll * 0.55);
    sk.chest.rotation.set(0.5 * lean + 0.1 * cr + 0.015 * breath - 0.025 * kickB, 0.55 * (counter + turnUp) + kickT * 0.6, -pelvisRoll * 0.3);
    // Head: cancel what the trunk did under it, then look (85% stabilised, like a real head).
    q.copy(sk.root.quaternion).multiply(sk.spine.quaternion).multiply(sk.chest.quaternion);
    q.slerp(q2.identity(), 0.15).invert();
    q2.setFromEuler(euler.set(neckP - 0.06 * cr - 0.75 * att, neckY, 0, 'YXZ'));
    sk.neck.quaternion.copy(q).multiply(q2);
    euler.order = 'XYZ';

    /* ---- arms ---- */
    // Walking: swinging against the legs (left forward with the right foot), elbows flexing more
    // on the forward swing; firing: up onto the word, the other hand ready.
    sk.root.updateMatrixWorld(true);
    for (const n of ['L', 'R']) {
      const gA = sk.limbs[n];
      const s = gA.s;
      const A = st.aim[n];
      const swingAmp = (0.08 + 0.3 * clamp(walk, 0, 1.2)) * active;
      const ss = n === 'L' ? -1 : 1;
      const armSwing = ez.arm[n].to(ss * swingAmp * Math.cos(2 * Math.PI * (ph + 0.08)) - 0.06 * clamp(walk, 0, 1) - 0.65 * cr, sdt); // (+0.08: the spring's lag)
      const fwd = Math.max(0, armSwing + 0.08);
      const other = n === 'L' ? 'R' : 'L';
      const guard = ez.guard[n].to(st.aim[other].has && !A.has ? 1 - clamp(walk * 1.5, 0, 1) : 0, sdt); // the off hand, while the other fires standing
      const adduct = -s * ((0.44 - 0.08 * clamp(walk, 0, 1)) * (1 - att) + 0.6 * att + ARM_REST_FIX) + s * 0.06 * Math.abs(shift); // arms in by the thighs, a little wider swinging
      const clavY = -s * (0.05 * fwd - 0.04 * guard);
      const clavZ = s * (0.02 * breath + 0.02 * guard) * (1 - att);
      gA.clav.rotation.set(0, clavY, clavZ);
      // (Rotation about x: negative swings the arm forward.)
      // (The off hand: a little back and out to balance the shot, elbow soft, palm turned in.)
      gA.sh.rotation.set(-(armSwing * (1 - 0.5 * guard) - 0.1 * guard) * (1 - att) + 0.3 * att, -s * 0.3 * guard, adduct - s * 0.14 * guard);
      gA.el.rotation.set(-(0.32 + 0.6 * fwd + 0.25 * guard + 0.2 * cr) * (1 - att), 0, 0);
      gA.wr.rotation.set(0.9 * att + 0.1 * guard, 0, 0); // palms back in flight: the repulsors push him along
      // Aim: on its word, the direction eased (a quick, smooth move between words).
      const a = clamp(ez.aim[n].to((A.has ? 1 : 0) * (1 - g) * (1 - cr), sdt), 0, 1);
      aimW[n] = a;
      const rec = ez.recoil[n].to(0, sdt);
      const kb = ez.kick[n].to(0, sdt);
      if (tgt[n]) {
        gA.clav.updateMatrixWorld(true);
        gA.sh.getWorldPosition(b3);
        a3.set(tgt[n].at[0], tgt[n].at[1], tgt[n].at[2]).sub(b3).normalize();
        // Within reach of a shoulder: not across the chest, not far behind.
        const lat = a3.dot(leftV) * s;
        if (lat < -0.15) a3.addScaledVector(leftV, s * (-0.15 - lat));
        const back = a3.dot(heading);
        if (back < -0.45) a3.addScaledVector(heading, -0.45 - back);
        a3.normalize();
        if (A.dir.lengthSq() < 0.5 || a < 0.02) A.dir.copy(a3);
        else A.dir.lerp(a3, 1 - Math.exp(-14 * dt)).normalize();
      }
      if (a > 1e-3) {
        // The shoulder girdle comes forward and up with the arm and is driven back by each blast.
        const raise = clamp(A.dir.y * 1.5 + 0.3, 0, 1);
        gA.clav.rotation.set(0, clavY + a * (-s * (0.12 - 0.18 * kb) - clavY), clavZ + a * (s * (0.1 * raise + 0.04 * kb) - clavZ));
        gA.clav.updateMatrixWorld(true);
        aimPose(gA, A.dir, rec);
        gA.sh.quaternion.slerp(aimQ.sh, a);
        gA.el.quaternion.slerp(aimQ.el, a);
        gA.wr.quaternion.slerp(aimQ.wr, a);
      }
      // Fingers: loosely curled at rest, open and back to fire (flicked further by each blast), straight in flight.
      const curl = (0.42 * (1 - a) - 0.14 * a - 0.18 * rec * a + 0.14 * guard) * (1 - att) + 0.04 * att;
      gA.knuckles.quaternion.setFromAxisAngle(gA.curlAxis, curl);
      fingerCurl[n] = clamp(curl, 0, 1);
    }

    // The model follows the rig; upright in the air, the artist's hover pose blends in.
    const hover = clamp(ez.hover.to(air * (1 - att), sdt), 0, 1);
    if (model) drive(model, hover);
    group.updateMatrixWorld(true);

    // Key over the camera's shoulder, rim from behind him.
    a3.copy(camera.position).sub(group.position);
    const dist = a3.length() || 1;
    key.position.copy(a3).addScaledVector(UP, dist * 0.6).addScaledVector(X, -dist * 0.3);
    rim.position.copy(a3).multiplyScalar(-1).addScaledVector(UP, dist * 0.3);

    /* ---- effects ---- */
    const L = sk.limbs;
    if (model) {
      palmOf(model, 'L', palms.L);
      palmOf(model, 'R', palms.R);
    } else {
      L.L.palm.getWorldPosition(palms.L);
      L.R.palm.getWorldPosition(palms.R);
    }
    L.L.sole.getWorldPosition(soles[0]);
    L.R.sole.getWorldPosition(soles[1]);
    fxIn.dt = dt;
    fxIn.time = spider.time;
    fxIn.camera = camera;
    fxIn.halfH = halfH;
    fxIn.unit = U / 22.8;
    fxIn.scale = scale;
    fxIn.thrust = Math.max(air, fly);
    fxIn.fly = fly;
    fxIn.targets = targets;
    const out = repulsors.update(fxIn);
    // A blast kicks that arm (fast) and pushes through the shoulder and torso (slower); the
    // repulsors light up his own armour.
    for (const n of ['L', 'R']) {
      const shots = out.fired[n] || 0;
      if (!shots) continue;
      ez.recoil[n].kick(Math.min(1.2, 0.7 * Math.sqrt(shots)));
      ez.kick[n].kick(Math.min(1, 0.55 * Math.sqrt(shots)));
    }
    repulsorLight.intensity = 40 * Math.min(2, out.light);
    repulsorLight.position.copy(head).multiplyScalar(0.2 * U);
  }

  return {
    group,
    fx,
    update,
    /** Arc reactor, world space. */
    chest: () => sk.chest.localToWorld(new THREE.Vector3(0, 0.08, 0.3)).toArray(),
    /** Which way his head points, world space. */
    up: () => head.toArray(),
    /** Internal state, for tests and tools. */
    debug: () => st,
  };
}
