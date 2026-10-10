/**
 * Iron Man in place of the spider: the nanotech suit (a static OBJ mesh with
 * its textures, from Marvel Future Fight, supplied with the project; Iron Man
 * is Marvel's). The mesh has no rig, so one is built here: a 16-bone skeleton
 * fitted to its A-pose and skin weights from each vertex's distance to the
 * bones; it is animated procedurally.
 *
 * Walking: the feet are planted on the stars and stepped by a foot planner
 * (no sliding), the legs solved by two-bone IK, the heel striking and the toe
 * pushing off; the pelvis rides over the stance foot (bob, sway, hip drop,
 * twist) with the chest counter-rotating and the arms swinging on springs.
 * Shooting: the torso and head turn to the target, the arm comes up straight
 * with the palm out, the repulsor charges, fires with a kick of recoil, and
 * the ray (a white-hot core in a cyan sheath, pulsing and flickering) holds
 * on the target with a flare and sparks where it hits. Flying: head-first,
 * arms at his sides, boots and palms firing, the nanotech back thrusters
 * formed out of the suit; he is drawn larger in flight so the leap reads.
 *
 * The suit is a physically based, clear-coated metal: metalness, roughness,
 * relief and glow maps derived from its colour texture (red paint, gold and
 * silver trim, cyan lights), reflecting a small space environment of its own.
 */

import * as THREE from 'three';
import { createRepulsors } from './repulsor.js';
import { JOINT, POSE, MODEL_HEIGHT, loadModel } from './ironman-model.js';

const HEIGHT = 46; // world units: he reads at the distances the camera keeps from the crawler
const K = HEIGHT / MODEL_HEIGHT; // world units per model unit (feet at y = 0)
const U = HEIGHT / 2.02; // a body-proportional unit for the gait's distances (step sizes, thresholds, sway)
const FLY_SCALE = 1.9; // drawn this much larger in flight, so a leap reads at the camera's distance
const UP = new THREE.Vector3(0, 1, 0);

/*
 * The skeleton, in mesh units (y up, facing +z, his left at +x), fitted to
 * the A-pose: joint centres from the mesh's own cross-sections.
 */
const J = {
  pelvis: JOINT['DEF-spine'],
  spine: JOINT['DEF-spine002'],
  chest: JOINT['DEF-spine003'],
  neck: JOINT['DEF-spine005'],
  crown: [0, MODEL_HEIGHT, 0.1],
  shoulder: JOINT['DEF-upper_armL'],
  elbow: JOINT['DEF-forearmL'],
  wrist: JOINT['DEF-handL'],
  palm: JOINT['DEF-palm02L'].map((x, i) => (x + JOINT['DEF-f_middle01L'][i]) / 2),
  fingers: JOINT['DEF-f_middle03L'],
  hip: JOINT['DEF-thighL'],
  knee: JOINT['DEF-shinL'],
  ankle: JOINT['DEF-footL'],
  toe: JOINT['DEF-toeL'],
  sole: [JOINT['DEF-footL'][0], 0, 0.1],
};
const side = (p, s) => [p[0] * s, p[1], p[2]];
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const L1 = V(J.knee).distanceTo(V(J.hip)); // thigh
const L2 = V(J.ankle).distanceTo(V(J.knee)); // shin
const ANKLE_H = J.ankle[1] - J.sole[1]; // ankle above the sole
const HIP_DROP = J.pelvis[1] - J.hip[1]; // pelvis above the hip joints
const HIP_W = J.hip[0]; // hip joint off the midline
// The model's bind pose holds the arms out and a little down (a T-pose): how far below level.
const ARM_DROP = Math.atan2(J.shoulder[1] - J.wrist[1], J.wrist[0] - J.shoulder[0]);

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A critically damped (or lightly underdamped) spring toward a target, for every
 * eased value. Sub-stepped so a slow frame cannot make it unstable; after a jump
 * in time (a seek) it lands on its target.
 */
function spring(w = 12, zeta = 1) {
  const s = { x: 0, v: 0 };
  s.to = (target, dt) => {
    if (dt > 0.3) {
      s.x = target;
      s.v = 0;
      return s.x;
    }
    const n = Math.ceil(dt / 0.008);
    const h = dt / Math.max(1, n);
    for (let i = 0; i < n; i++) {
      s.v += ((target - s.x) * w * w - s.v * 2 * zeta * w) * h;
      s.x += s.v * h;
    }
    return s.x;
  };
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
    const sh = make('shoulder' + n, side(J.shoulder, s), chest, [side(J.shoulder, s), side(J.elbow, s), 'arm', s]);
    const el = make('elbow' + n, side(J.elbow, s), sh, [side(J.elbow, s), side(J.wrist, s), 'arm', s]);
    const wr = make('wrist' + n, side(J.wrist, s), el, [side(J.wrist, s), side(J.fingers, s), 'arm', s]);
    const palm = make('palm' + n, side(J.palm, s), wr);
    const hip = make('hip' + n, side(J.hip, s), root, [side(J.hip, s), side(J.knee, s), 'leg', s]);
    const knee = make('knee' + n, side(J.knee, s), hip, [side(J.knee, s), side(J.ankle, s), 'leg', s]);
    const ankle = make('ankle' + n, side(J.ankle, s), knee, [side(J.ankle, s), side(J.toe, s), 'leg', s]);
    const sole = make('sole' + n, side(J.sole, s), ankle);
    limbs[n] = {
      s, n, sh, el, wr, palm, hip, knee, ankle, sole,
      restArm: V(side(J.wrist, s)).sub(V(side(J.shoulder, s))).normalize(),
      restThigh: V(side(J.knee, s)).sub(V(side(J.hip, s))).normalize(),
      restShin: V(side(J.ankle, s)).sub(V(side(J.knee, s))).normalize(),
      restFoot: V(side(J.toe, s)).sub(V(side(J.ankle, s))).normalize(),
    };
  }
  return { root, spine, chest, neck, limbs, bones, segs };
}

/**
 * @param {THREE.WebGLRenderer} renderer for the suit's reflections
 * @returns {{group: THREE.Group, fx: THREE.Group, update: Function, chest: Function, up: Function}}
 */
export function createIronMan(renderer) {
  const group = new THREE.Group(); // at his pelvis
  const body = new THREE.Group(); // oriented: +y his head, +z his chest
  group.add(body);
  const repulsors = createRepulsors();
  const fx = repulsors.group; // world-space effects: rays, flares, sparks

  // The rig the animation drives (16 bones at the model's joints, rest pose unrotated), and the
  // model's own 74 deform bones, which follow it each frame (see drive()). Both live in model space.
  const sk = buildSkeleton();
  const rig = new THREE.Group(); // model units, pivoted at the pelvis
  rig.scale.setScalar(K);
  rig.position.y = -J.pelvis[1] * K;
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

  // State.
  const st = { phase: 0, feet: null, lastFoot: 'R', landAt: -9, grounded: true, time: 0, landedAt: -9, leapt: false };
  const ez = {
    walk: spring(7), fly: spring(9), air: spring(9), crouch: spring(10, 0.9), scale: spring(6), hover: spring(6),
    pelvisY: spring(16, 0.85), sway: spring(10), yawP: spring(12), roll: spring(12),
    twist: spring(9, 0.9), lookY: spring(10, 0.9), lookP: spring(10, 0.9),
    arm: { L: spring(9, 0.55), R: spring(9, 0.55) }, aim: { L: spring(11, 0.85), R: spring(11, 0.85) },
    recoil: { L: spring(26, 0.45), R: spring(26, 0.45) },
  };
  ez.scale.x = 1;
  const aimAt = { L: new THREE.Vector3(), R: new THREE.Vector3() };
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
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const basis = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const flightQ = new THREE.Quaternion();
  const euler = new THREE.Euler();

  const perp = (a, n, fallback) => {
    a.addScaledVector(n, -a.dot(n));
    if (a.lengthSq() < 1e-6) a.copy(fallback).addScaledVector(n, -fallback.dot(n));
    return a.normalize();
  };

  /* ---------------- the model, driven by the rig ---------------- */

  const PQ = new Map(); // rig bone -> its orientation in model space (the rig's rest pose is unrotated)
  const curl = new THREE.Quaternion();
  const XAX = new THREE.Vector3(1, 0, 0);
  const pelvisRest = V(J.pelvis);

  /** Map the model's deform bones onto the rig's, with their rest orientations in model space. */
  function rigModel(m) {
    const drv = {};
    const set = (bone, names) => names.forEach((nm) => (drv[nm] = bone));
    set(sk.root, ['DEF-spine', 'DEF-pelvisL', 'DEF-pelvisR']);
    set(sk.spine, ['DEF-spine001', 'DEF-spine002']);
    set(sk.chest, ['DEF-spine003', 'DEF-spine004', 'DEF-breastL', 'DEF-breastR', 'DEF-shoulderL', 'DEF-shoulderR']);
    set(sk.neck, ['DEF-spine005', 'DEF-spine006']);
    for (const n of ['L', 'R']) {
      const g = sk.limbs[n];
      set(g.sh, [`DEF-upper_arm${n}`, `DEF-upper_arm${n}001`]);
      set(g.el, [`DEF-forearm${n}`, `DEF-forearm${n}001`]);
      set(g.hip, [`DEF-thigh${n}`, `DEF-thigh${n}001`]);
      set(g.knee, [`DEF-shin${n}`, `DEF-shin${n}001`]);
      set(g.ankle, [`DEF-foot${n}`, `DEF-toe${n}`]);
    }
    const root = m.bones['DEF-spine'];
    const order = [];
    const byBone = new Map();
    root.traverse((b) => {
      if (!b.isBone) return;
      const parent = b === root ? null : byBone.get(b.parent);
      const restQ = (parent ? parent.restQ.clone() : new THREE.Quaternion()).multiply(b.quaternion);
      const side = b.name.endsWith('L') ? 'L' : 'R';
      // Hands, palms and fingers follow the wrist of their side.
      const e = { bone: b, name: b.name, parent, restQ, q: new THREE.Quaternion(), drv: drv[b.name] || sk.limbs[side].wr, side, hand: /^DEF-(hand|palm|f_|thumb)/.test(b.name) };
      e.finger = /^DEF-(f_|thumb)/.test(b.name);
      e.thumb = b.name.startsWith('DEF-thumb');
      e.joint = Number((b.name.match(/(\d\d)[LR]$/) || [0, '01'])[1]);
      byBone.set(b, e);
      order.push(e);
    });
    // The right hand mirrors the left: find the reflection of local rotations that maps one onto the other at rest.
    const flips = [[1, -1, -1], [-1, 1, 1], [-1, -1, 1], [1, 1, -1], [-1, 1, -1], [1, -1, 1]];
    let best = null;
    let bestErr = Infinity;
    for (const f of flips) {
      let err = 0;
      for (const e of order) {
        if (!e.hand || e.side !== 'L') continue;
        const r = m.bones[e.name.slice(0, -1) + 'R'];
        if (!r) continue;
        const ql = e.bone.quaternion;
        err += 1 - Math.abs(ql.x * f[0] * r.quaternion.x + ql.y * f[1] * r.quaternion.y + ql.z * f[2] * r.quaternion.z + ql.w * r.quaternion.w);
      }
      if (err < bestErr) {
        bestErr = err;
        best = f;
      }
    }
    return { m, order, root, rootRest: root.position.clone(), flip: best };
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
   * Pose the model: each deform bone turned in model space as its rig bone has turned
   * from rest, the pelvis carried as the rig's is; the hands relaxed (fingers softly
   * curled) or opened palm-out to fire (the artist's repulsor hand); the artist's hover
   * pose off the web and, for a moment on touching down, the superhero landing.
   */
  function drive(md, o) {
    rigQuats();
    for (const e of md.order) {
      e.q.copy(PQ.get(e.drv)).multiply(e.restQ);
      if (e.parent) e.bone.quaternion.copy(e.parent.q).invert().multiply(e.q);
      else e.bone.quaternion.copy(e.q);
    }
    md.root.position.copy(md.rootRest).add(a3.copy(sk.root.position).sub(pelvisRest));
    // Relaxed hands: fingers curled a little more at each joint, the thumb less; open in flight.
    for (const e of md.order) {
      if (!e.finger) continue;
      const c = (e.thumb ? 0.12 : [0, 0.32, 0.42, 0.3][e.joint] || 0.3) * (1 - 0.6 * o.fly);
      e.bone.quaternion.multiply(curl.setFromAxisAngle(XAX, c));
    }
    const blend = (pose, w, keep = null, mirror = false) => {
      if (w <= 1e-3) return;
      for (const e of md.order) {
        if (keep && !keep(e)) continue;
        const v = pose[mirror ? e.name.slice(0, -1) + 'L' : e.name];
        if (!v) continue;
        const f = mirror ? md.flip : [1, 1, 1];
        q2.set(v[0] * f[0], v[1] * f[1], v[2] * f[2], v[3]);
        e.bone.quaternion.slerp(q2, w);
        if (e.bone === md.root) e.bone.position.lerp(a3.set(v[4], v[5], v[6]), w);
      }
    };
    // Firing: the artist's repulsor hand (the left in the pose; mirrored for the right).
    for (const n of ['L', 'R']) blend(POSE['Fire Pose'], clamp(o.aim[n].x, 0, 1), (e) => e.hand && e.side === n, n === 'R');
    blend(POSE['Fly Pose'], 0.9 * o.hover);
    const t = o.land;
    blend(POSE['Landing Pose'], smooth(0, 0.12, t) * (1 - smooth(0.45, 1.1, t)));
  }

  /** Centre of a palm, just off its face (world): where the repulsor fires from. */
  function palmOf(md, n) {
    const b = md.m.bones;
    const hand = b[`DEF-hand${n}`].getWorldPosition(new THREE.Vector3());
    const mid = b[`DEF-f_middle01${n}`].getWorldPosition(new THREE.Vector3());
    const across = b[`DEF-f_index01${n}`].getWorldPosition(new THREE.Vector3()).sub(b[`DEF-f_pinky01${n}`].getWorldPosition(new THREE.Vector3()));
    const along = mid.clone().sub(hand);
    const face = along.clone().cross(across).normalize().multiplyScalar(n === 'L' ? 1 : -1);
    return b[`DEF-palm02${n}`].getWorldPosition(new THREE.Vector3()).add(mid).multiplyScalar(0.5).addScaledVector(face, 0.3 * along.length());
  }

  /* ---------------- feet: planner and IK ---------------- */

  /** Where a foot would like to stand now (sole, world), given the body's place, heading and speed. */
  function footHome(n, out, pelvis, ground, lead) {
    const s = n === 'L' ? 1 : -1;
    out.copy(pelvis).addScaledVector(leftV, s * (HIP_W * K + 0.02 * U)).addScaledVector(v, lead);
    out.y = ground;
    return out;
  }

  function stepFeet(dt, pelvis, ground, speed, yaw) {
    const stepDur = clamp(0.42 - speed * 0.0045, 0.26, 0.42);
    const lead = stepDur * 0.85;
    const feet = st.feet;
    let swinging = null;
    for (const n of ['L', 'R']) if (feet[n].swing) swinging = n;
    if (!swinging && st.time - st.landAt > 0.04) {
      // The foot furthest from where it should be steps next (alternating while walking).
      let pick = null;
      let worst = 0;
      for (const n of ['L', 'R']) {
        const f = feet[n];
        footHome(n, a3, pelvis, ground, lead);
        const err = Math.hypot(f.pos.x - a3.x, f.pos.z - a3.z) + Math.abs(wrapA(f.yaw - yaw)) * 0.25 * U + Math.abs(f.pos.y - ground) * 0.5;
        const bias = n === st.lastFoot ? 0.6 : 1;
        if (err * bias > worst) {
          worst = err * bias;
          pick = n;
        }
      }
      const need = speed > 4 ? 0.16 * U : 0.07 * U;
      if (pick && worst > need) {
        const f = feet[pick];
        f.swing = { u: 0, dur: speed > 4 ? stepDur : 0.34, from: f.pos.clone(), fromYaw: f.yaw, lift: (0.07 + 0.06 * Math.min(1, speed / 26)) * U, target: new THREE.Vector3() };
        st.lastFoot = pick;
      }
    }
    for (const n of ['L', 'R']) {
      const f = feet[n];
      const sw = f.swing;
      if (!sw) {
        // Planted: the heel peels up as the body passes well ahead of it (pushing off the toe).
        b3.copy(f.pos).sub(pelvis);
        const behind = -(b3.x * heading.x + b3.z * heading.z);
        f.roll = 0.55 * smooth(0.12 * U, 0.38 * U, behind);
        continue;
      }
      sw.u = Math.min(1, sw.u + dt / sw.dur);
      if (sw.u < 0.75) footHome(n, sw.target, pelvis, ground, lead);
      const u = sw.u;
      const e = u * u * (3 - 2 * u);
      f.pos.lerpVectors(sw.from, sw.target, e);
      f.pos.y = sw.from.y + (sw.target.y - sw.from.y) * e + sw.lift * Math.sin(Math.PI * u) ** 1.2;
      f.yaw = sw.fromYaw + wrapA(yaw - sw.fromYaw) * e;
      // Toe-off at the start, toes up for the heel strike, flat at contact.
      f.roll = 0.55 * (1 - smooth(0, 0.35, u)) - 0.32 * smooth(0.5, 0.85, u) * (1 - smooth(0.9, 1, u));
      if (u >= 1) {
        f.swing = null;
        f.roll = 0;
        st.landAt = st.time;
      }
    }
  }

  /** Two-bone IK for one leg, the knee toward his front; the foot laid at its yaw and roll. */
  function solveLeg(g, f, rootQ) {
    // Ankle target: above the sole, raised further by the heel peeling up.
    a3.copy(f.pos).addScaledVector(UP, ANKLE_H * K + Math.max(0, f.roll) * 0.16 * U);
    a3.applyMatrix4(inv); // into the pelvis bone's frame (mesh units)
    const t = a3.sub(g.hip.position);
    const reach = L1 + L2;
    const d = clamp(t.length(), 0.35 * reach, 0.995 * reach);
    const u = t.normalize();
    const pole = b3.set(0, 0, 1).addScaledVector(u, -u.z).normalize();
    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const d1 = c3.copy(u).multiplyScalar(cosA).addScaledVector(pole, sinA);
    q.setFromUnitVectors(g.restThigh, d1);
    g.hip.quaternion.copy(q);
    // Shin: from the knee to the ankle target, in the thigh's frame.
    const knee = d1.multiplyScalar(L1);
    const d2 = u.multiplyScalar(d).sub(knee).normalize().applyQuaternion(qInv.copy(q).invert());
    q2.setFromUnitVectors(g.restShin, d2);
    g.knee.quaternion.copy(q2);
    // Foot: pointing along its yaw, pitched by its roll, in the shin's frame.
    const pitch = Math.asin(-g.restFoot.y) + f.roll;
    a3.set(Math.sin(f.yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(f.yaw) * Math.cos(pitch));
    a3.applyQuaternion(qInv.copy(rootQ).invert()).applyQuaternion(qInv.copy(q).multiply(q2).invert());
    g.ankle.quaternion.setFromUnitVectors(g.restFoot, a3.normalize());
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
    if (jumped) st.feet = null;
    const dt = clamp(frameDt, 0, 0.1);
    const sdt = jumped ? frameDt : dt;
    st.time += dt;
    v.set(spider.v[0], spider.v[1], spider.v[2]);
    const speed = v.length();
    a3.set(spider.F[0], 0, spider.F[2]);
    if (a3.lengthSq() > 1e-6) heading.copy(a3.normalize());
    leftV.set(heading.z, 0, -heading.x); // his left
    const yaw = Math.atan2(heading.x, heading.z);
    const fly = ez.fly.to(spider.taut || 0, sdt);
    const air = ez.air.to(spider.air || 0, sdt);
    const crouch = clamp(ez.crouch.to(spider.crouch && !spider.air ? 1 : 0, sdt), 0, 1.1);
    const g = clamp(Math.max(air, fly), 0, 1); // off the ground
    const scale = ez.scale.to(1 + (FLY_SCALE - 1) * (spider.taut || 0), sdt);
    group.scale.setScalar(scale);

    // Ground: where the spider's feet are.
    let gy = 0;
    for (const l of spider.legs) gy += l.tip[1];
    gy /= spider.legs.length;
    const across = Math.hypot(v.x, v.z);
    const walk = ez.walk.to((1 - g) * Math.min(1, across / 26), sdt);

    // Feet: (re)planted where they stand when he comes down, or on a jump in time.
    if (!st.feet || Math.hypot(st.feet.L.pos.x - spider.p[0], st.feet.L.pos.z - spider.p[2]) > 3 * U) {
      st.feet = {};
      for (const n of ['L', 'R']) st.feet[n] = { pos: footHome(n, new THREE.Vector3(), a3.set(spider.p[0], gy, spider.p[2]), gy, 0), yaw, roll: 0, swing: null };
    }
    if (st.grounded && g > 0.6) {
      st.grounded = false;
      st.leapt = false;
    }
    if (fly > 0.5) st.leapt = true;
    if (!st.grounded && g < 0.35) {
      st.grounded = true;
      if (st.leapt) st.landedAt = st.time;
      for (const n of ['L', 'R']) {
        sk.limbs[n].sole.getWorldPosition(b3);
        Object.assign(st.feet[n], { pos: b3.clone().setY(gy), yaw, roll: 0, swing: null });
      }
    }
    const pelvisXZ = new THREE.Vector3(spider.p[0], gy, spider.p[2]);
    if (st.grounded) stepFeet(dt, pelvisXZ, gy, across, yaw);

    // Pelvis: as high as the planted legs allow (so it rides up over the stance foot and dips
    // between steps), lowered in the crouch, swaying over the stance foot, the swing hip dropping.
    let top = (HIP_DROP + 0.97 * (L1 + L2) + ANKLE_H) * K;
    let swingSide = 0;
    for (const n of ['L', 'R']) {
      const f = st.feet[n];
      if (f.swing) {
        swingSide = n === 'L' ? 1 : -1;
        continue;
      }
      const s = n === 'L' ? 1 : -1;
      const hx = pelvisXZ.x + leftV.x * s * HIP_W * K - f.pos.x;
      const hz = pelvisXZ.z + leftV.z * s * HIP_W * K - f.pos.z;
      const legL = 0.985 * (L1 + L2) * K;
      const reachY = Math.sqrt(Math.max(0, legL * legL - hx * hx - hz * hz));
      top = Math.min(top, f.pos.y - gy + ANKLE_H * K + reachY + HIP_DROP * K);
    }
    const stand = J.pelvis[1] * K - 0.035 * U;
    if (ez.pelvisY.x === 0) ez.pelvisY.x = stand;
    const pelvisH = ez.pelvisY.to(Math.min(stand, top) - 0.3 * U * clamp(crouch, 0, 1), sdt);
    const sway = ez.sway.to(-swingSide * 0.022 * U * walk, sdt);
    const onGround = b3.set(spider.p[0], gy + pelvisH + Math.min(0, spider.jolt || 0) * 3, spider.p[2]).addScaledVector(leftV, sway);
    group.position.set(onGround.x + (spider.b[0] - onGround.x) * g, onGround.y + (spider.b[1] - onGround.y) * g, onGround.z + (spider.b[2] - onGround.z) * g);

    // Orientation: upright on the ground (a slight lean into the walk); head-first, chest down, in flight.
    H.copy(UP).addScaledVector(heading, 0.06 * walk + 0.12 * crouch).normalize();
    C.copy(heading);
    if (fly > 0.01 && speed > 5) {
      a3.copy(v).divideScalar(speed);
      H.lerp(a3, clamp(fly, 0, 1)).normalize();
      C.lerp(UP, -clamp(fly, 0, 1));
    }
    perp(C, H, heading);
    const k = 1 - Math.exp(-8 * dt);
    head.lerp(H, k).normalize();
    chestDir.lerp(C, k);
    perp(chestDir, head, heading);
    X.crossVectors(head, chestDir);
    basis.makeBasis(X, head, chestDir);
    body.quaternion.setFromRotationMatrix(basis);

    // Pelvis bone: twist toward the leading leg, the swing hip dropping; the chest counters.
    a3.copy(st.feet.L.pos).sub(st.feet.R.pos);
    const lead = clamp((a3.x * heading.x + a3.z * heading.z) / (0.35 * U), -1, 1); // + when the left foot is ahead
    const pelvisYaw = ez.yawP.to(-0.13 * lead * walk * (1 - g), sdt);
    const pelvisRoll = ez.roll.to(swingSide * 0.06 * walk * (1 - g), sdt);
    sk.root.position.y = pelvisY0;
    sk.root.rotation.set(0, pelvisYaw, pelvisRoll);
    group.updateMatrixWorld(true);

    // Targets: each side's nearest word, fired at by the hand on that side.
    const tgt = { L: null, R: null };
    for (const t of targets) {
      a3.set(t.at[0] - group.position.x, t.at[1] - group.position.y, t.at[2] - group.position.z);
      const n = a3.dot(leftV) > 0 ? 'L' : 'R';
      t.side = n;
      if (!tgt[n] || a3.lengthSq() < tgt[n].lengthSq()) tgt[n] = a3.clone();
    }
    let twistTo = 0;
    let lookY = 0;
    let lookP = 0;
    let nT = 0;
    for (const n of ['L', 'R']) {
      ez.aim[n].to((tgt[n] ? 1 : 0) * (1 - g), sdt);
      ez.recoil[n].to(0, sdt);
      if (tgt[n]) {
        aimAt[n].copy(tgt[n]).add(group.position);
        // Torso and head turn toward the target (the head further).
        const ang = Math.atan2(tgt[n].dot(leftV), tgt[n].x * heading.x + tgt[n].z * heading.z);
        twistTo += ang;
        lookY += ang;
        lookP += Math.atan2(tgt[n].y, Math.hypot(tgt[n].x, tgt[n].z));
        nT++;
      }
    }
    if (nT) {
      twistTo /= nT;
      lookY /= nT;
      lookP /= nT;
    }
    const twist = ez.twist.to(clamp(twistTo * 0.35, -0.45, 0.45) * (1 - g), sdt);
    const neckY = ez.lookY.to(clamp(lookY * 0.55, -0.7, 0.7) * (1 - g), sdt);
    const neckP = ez.lookP.to(clamp(-lookP * 0.5, -0.45, 0.35) * (1 - g), sdt);

    // Torso.
    const breath = Math.sin(spider.time * 1.6);
    const cr = clamp(crouch, 0, 1);
    sk.spine.rotation.set(0.05 * walk + 0.32 * cr + 0.012 * breath, -pelvisYaw * 0.5 + twist * 0.4, -pelvisRoll * 0.6);
    sk.chest.rotation.set(0.1 * cr + 0.015 * breath, -pelvisYaw * 0.45 + twist * 0.6, -pelvisRoll * 0.3);
    sk.neck.rotation.set(-0.06 * cr - 0.75 * fly + neckP, neckY - twist * 0.5, 0);

    // Legs: IK on the planted and stepping feet, blended toward the flight pose off the ground.
    group.updateMatrixWorld(true);
    inv.copy(sk.root.matrixWorld).invert();
    const rootQ = sk.root.getWorldQuaternion(new THREE.Quaternion());
    for (const n of ['L', 'R']) {
      const gL = sk.limbs[n];
      if (g < 0.999) solveLeg(gL, st.feet[n], rootQ);
      if (g > 0.001) {
        const legs = [[gL.hip, 0.12 * fly - 0.15 * air * (1 - fly), 0, -gL.s * 0.03 * fly], [gL.knee, 0.18 * fly + 0.35 * air * (1 - fly), 0, 0], [gL.ankle, 0.5 * fly + 0.2 * air * (1 - fly), 0, 0]];
        for (const [bone, x, y, z] of legs) {
          if (g >= 0.999) bone.quaternion.setFromEuler(euler.set(x, y, z));
          else bone.quaternion.slerp(flightQ.setFromEuler(euler.set(x, y, z)), g);
        }
      }
    }

    // Arms: swinging against the legs on springs (follow-through), or raised to fire.
    for (const n of ['L', 'R']) {
      const gA = sk.limbs[n];
      const otherLead = n === 'L' ? -lead : lead; // the opposite foot leads this arm forward
      const swing = ez.arm[n].to(-0.4 * otherLead * walk, sdt);
      const adduct = -gA.s * ((1.41 - ARM_DROP) * (1 - fly) + (2.02 - ARM_DROP) * fly); // from the bind pose down to the sides
      gA.sh.rotation.set(swing * (1 - fly) + 0.45 * cr * (1 - fly) + 0.3 * fly, 0, adduct);
      gA.el.rotation.set(-(0.28 + 0.3 * Math.max(0, -swing)) * (1 - fly), 0, 0);
      gA.wr.rotation.set(0.9 * fly, 0, 0);
      const a = clamp(ez.aim[n].x, 0, 1);
      if (a > 1e-3) {
        // Aim: the arm swung from rest onto the target in the chest's frame, elbow soft, palm out; recoil kicks it up.
        sk.root.updateMatrixWorld(true);
        inv.copy(sk.chest.matrixWorld).invert();
        a3.copy(aimAt[n]).applyMatrix4(inv).sub(b3.set(...side(J.shoulder, gA.s)).sub(V(J.chest))).normalize();
        q.setFromUnitVectors(gA.restArm, a3);
        gA.sh.quaternion.slerp(q, a);
        const rec = ez.recoil[n].x;
        gA.sh.rotateX(-0.05 * rec * a);
        gA.el.rotation.x = gA.el.rotation.x * (1 - a) - (0.08 + 0.22 * Math.max(0, rec)) * a;
        gA.wr.rotation.set(-0.15 * a, 0, gA.s * 1.15 * a);
      }
    }

    // The model follows the rig, then the artist's poses blend in.
    const hover = clamp(ez.hover.to(air * (1 - clamp(fly * 3, 0, 1)), sdt), 0, 1);
    if (model) drive(model, { hover, land: st.time - st.landedAt, aim: ez.aim, fly, walk });
    group.updateMatrixWorld(true);

    // Key over the camera's shoulder, rim from behind him.
    a3.copy(camera.position).sub(group.position);
    const dist = a3.length() || 1;
    key.position.copy(a3).addScaledVector(UP, dist * 0.6).addScaledVector(X, -dist * 0.3);
    rim.position.copy(a3).multiplyScalar(-1).addScaledVector(UP, dist * 0.3);

    /* ---- effects ---- */
    const L = sk.limbs;
    const out = repulsors.update({
      dt,
      time: spider.time,
      camera,
      halfH,
      unit: U / 22.8,
      scale,
      palms: model ? { L: palmOf(model, 'L'), R: palmOf(model, 'R') } : { L: L.L.palm.getWorldPosition(new THREE.Vector3()), R: L.R.palm.getWorldPosition(new THREE.Vector3()) },
      soles: [L.L.sole.getWorldPosition(new THREE.Vector3()), L.R.sole.getWorldPosition(new THREE.Vector3())],
      head,
      vel: v,
      thrust: Math.max(air, fly),
      fly,
      targets,
      aim: { L: clamp(ez.aim.L.x, 0, 1), R: clamp(ez.aim.R.x, 0, 1) },
    });
    // A shot kicks that arm back; the repulsors light up his own armour.
    for (const n of ['L', 'R']) if (out.fired[n]) ez.recoil[n].v += 9 * out.fired[n];
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
  };
}
