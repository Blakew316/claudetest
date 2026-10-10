/**
 * Iron Man in place of the spider: the nanotech suit (a static OBJ mesh with
 * its textures, from Marvel Future Fight, supplied with the project; Iron Man
 * is Marvel's). The mesh has no rig, so one is built here: a 16-bone
 * skeleton fitted to its A-pose and skin weights from each vertex's distance
 * to the bones, and it is animated procedurally.
 *
 * The spider simulation still decides where the crawler goes. Over a cluster
 * he walks across the stars (a real stride, arms swinging, turning on the
 * spot with small steps), and raises a hand to fire each reading beam (the
 * pulsar rays, drawn in view3d) from his palm. Before a leap he crouches;
 * between clusters he flies head-first, arms at his sides, boots and palms
 * firing, the nanotech back thrusters forming out of the suit; he lands
 * bracing on bent knees. Lit by its own lights (the stars are not lit
 * materials, so these touch only the suit).
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import OBJ from '../../assets/ironman/hero_ironman01.obj';
import TEX_BODY from '../../assets/ironman/hero_ironman01_S04.png';
import TEX_PACK from '../../assets/ironman/hero_ironman01_S04_wp4.png';

const HEIGHT = 46; // world units: he reads at the distances the camera keeps from the crawler
const K = HEIGHT / 2.02; // the mesh stands 2.02 units tall, feet at y = 0
const STRIDE = 0.95 * K; // world units travelled per walk cycle (two steps)
const EXHAUST = 360; // thruster sparks in flight at once
const UP = new THREE.Vector3(0, 1, 0);

/*
 * The skeleton, in mesh units (y up, facing +z, his left at +x), fitted to
 * the A-pose: joint centres from the mesh's own cross-sections.
 */
const J = {
  pelvis: [0, 0.87, 0.07],
  spine: [0, 1.15, 0.06],
  chest: [0, 1.4, 0.06],
  neck: [0, 1.725, 0],
  crown: [0, 1.985, 0.08],
  shoulder: [0.26, 1.535, 0.02],
  elbow: [0.413, 1.286, 0.04],
  wrist: [0.559, 1.062, 0.1],
  palm: [0.618, 0.979, 0.124],
  fingers: [0.66, 0.9, 0.12],
  hip: [0.14, 0.86, 0.06],
  knee: [0.14, 0.46, 0],
  ankle: [0.175, 0.11, 0.02],
  toe: [0.173, 0.02, 0.22],
  sole: [0.174, 0.013, 0.067],
};
const side = (p, s) => [p[0] * s, p[1], p[2]];

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Squared distance from p to segment ab. */
function segDist2(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / (abx * abx + aby * aby + abz * abz)));
  const dx = p[0] - a[0] - abx * t;
  const dy = p[1] - a[1] - aby * t;
  const dz = p[2] - a[2] - abz * t;
  return dx * dx + dy * dy + dz * dz;
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
    limbs[n] = { s, sh, el, wr, palm, hip, knee, ankle, sole };
  }
  return { root, spine, chest, neck, limbs, bones, segs };
}

/**
 * Skin weights: each vertex follows its nearest bones (inverse distance, the
 * three strongest), gated by anatomy so a hip never pulls the belly and an
 * arm never pulls the ribs: legs only below the waist, arms only outside the
 * torso, each limb only on its own side.
 */
function skin(geo, segs) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const idx = new Uint16Array(n * 4);
  const wts = new Float32Array(n * 4);
  const p = [0, 0, 0];
  const w = new Float64Array(segs.length);
  for (let i = 0; i < n; i++) {
    p[0] = pos.getX(i);
    p[1] = pos.getY(i);
    p[2] = pos.getZ(i);
    const ax = Math.abs(p[0]);
    const armGate = smooth(0.2, 0.27, ax);
    const legGate = smooth(0.96, 0.8, p[1]) * smooth(0.36, 0.28, ax);
    for (let b = 0; b < segs.length; b++) {
      const [a, e, kind, s] = segs[b];
      let gate = 1;
      if (kind === 'arm') gate = (s * p[0] > 0 ? 1 : 0) * armGate;
      else if (kind === 'leg') gate = (s * p[0] > -0.01 ? 1 : 0) * legGate;
      else gate = 1 - 0.85 * smooth(0.27, 0.34, ax) * smooth(1.4, 1.2, p[1]); // the torso lets go of the arms below the shoulder
      w[b] = gate / (segDist2(p, a, e) + 1e-4) ** 3;
    }
    // The three strongest, normalised.
    for (let k = 0; k < 4; k++) {
      let best = -1;
      for (let b = 0; b < segs.length; b++) if (w[b] > 0 && (best < 0 || w[b] > w[best])) best = b;
      if (best < 0 || k === 3) break;
      idx[i * 4 + k] = best;
      wts[i * 4 + k] = w[best];
      w[best] = 0;
    }
    const sum = wts[i * 4] + wts[i * 4 + 1] + wts[i * 4 + 2] || 1;
    for (let k = 0; k < 3; k++) wts[i * 4 + k] /= sum;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
}

export function createIronMan() {
  const group = new THREE.Group();
  const body = new THREE.Group(); // oriented: +y his head, +z his chest
  group.add(body);
  const tex = (url) => {
    const t = new THREE.TextureLoader().load(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  // Emissive from its own texture so the dark red and gold still read against black space.
  const suit = (map, sideMode) => new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.32, metalness: 0.6, roughness: 0.36, side: sideMode, fog: false });

  const parts = {};
  new OBJLoader().parse(OBJ).traverse((o) => {
    if (o.isMesh) parts[['wp2', 'wp4', 'wp5'].find((k) => o.name.includes(k)) || 'body'] = o.geometry;
  });
  const sk = buildSkeleton();
  skin(parts.body, sk.segs);
  const mesh = new THREE.SkinnedMesh(parts.body, suit(tex(TEX_BODY), THREE.FrontSide));
  mesh.add(sk.root);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(sk.bones));
  mesh.frustumCulled = false;
  const rig = new THREE.Group(); // mesh units, pivoted at the pelvis
  rig.scale.setScalar(K);
  rig.position.y = -J.pelvis[1] * K;
  rig.add(mesh);
  body.add(rig);
  // The nanotech back thrusters (from the game's flight effect): formed out of the suit for flight.
  const packGeo = parts.wp4.clone();
  packGeo.translate(-J.chest[0], -J.chest[1], -J.chest[2]);
  const pack = new THREE.Mesh(packGeo, suit(tex(TEX_PACK), THREE.DoubleSide));
  pack.scale.setScalar(1e-3);
  sk.chest.add(pack);
  const rest = {
    pelvisY: sk.root.position.y,
    arm: Object.fromEntries(['L', 'R'].map((n) => [n, new THREE.Vector3().subVectors(new THREE.Vector3(...side(J.wrist, sk.limbs[n].s)), new THREE.Vector3(...side(J.shoulder, sk.limbs[n].s))).normalize()])),
  };

  // Lights for the suit: a soft sky fill, a warm key from over the camera's shoulder, a cool rim.
  const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x1a1020, 1.4);
  const key = new THREE.DirectionalLight(0xfff1e0, 2.8);
  const rim = new THREE.DirectionalLight(0x7fb0ff, 2.2);
  key.target = body;
  rim.target = body;
  group.add(hemi, key, rim);

  // Thrusters: a bright core at each boot and palm, and a stream of fine sparks.
  const glowPos = new Float32Array(4 * 3);
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
  const glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({ color: 0xdff4ff, size: 2.4, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  glow.frustumCulled = false;
  const exPos = new Float32Array(EXHAUST * 3);
  const exCol = new Float32Array(EXHAUST * 3);
  const exVel = new Float32Array(EXHAUST * 3);
  const exAge = new Float32Array(EXHAUST).fill(9);
  const exLife = new Float32Array(EXHAUST).fill(1);
  const exGeo = new THREE.BufferGeometry();
  exGeo.setAttribute('position', new THREE.BufferAttribute(exPos, 3));
  exGeo.setAttribute('color', new THREE.BufferAttribute(exCol, 3));
  const exhaust = new THREE.Points(exGeo, new THREE.PointsMaterial({ size: 1.1, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  exhaust.frustumCulled = false;
  group.add(glow, exhaust);

  // Eased state.
  const st = { walk: 0, fly: 0, air: 0, crouch: 0, phase: 0, yaw: null, turn: 0, aim: { L: 0, R: 0 }, pack: 0, hipsY: null };
  const aimAt = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const head = new THREE.Vector3(0, 1, 0);
  const chestDir = new THREE.Vector3(0, 0, 1);
  const heading = new THREE.Vector3(0, 0, 1);
  const H = new THREE.Vector3();
  const C = new THREE.Vector3();
  const X = new THREE.Vector3();
  const v = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const basis = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  let emitAcc = 0;
  let next = 0;

  const perp = (a, n, fallback) => {
    a.addScaledVector(n, -a.dot(n));
    if (a.lengthSq() < 1e-6) a.copy(fallback).addScaledVector(n, -fallback.dot(n));
    return a.normalize();
  };
  const ease = (key, to, rate, dt) => (st[key] += (to - st[key]) * (1 - Math.exp(-rate * dt)));

  /** Pose every bone for this frame. */
  function pose(dt, time, targets) {
    const w = st.walk;
    const f = st.fly;
    const c = st.crouch;
    const ph = st.phase;
    const L = sk.limbs;
    // Legs: hip swing, knee lift in the swing, foot kept near level; crouch and flight blend in.
    for (const n of ['L', 'R']) {
      const g = L[n];
      const psi = ph + (n === 'L' ? 0 : Math.PI);
      let hip = -0.42 * w * Math.sin(psi);
      let knee = w * (0.1 + 0.85 * Math.max(0, Math.cos(psi)) ** 2);
      hip = hip * (1 - c) - 0.75 * c;
      knee = knee * (1 - c) + 1.35 * c;
      hip = hip * (1 - f) + 0.12 * f;
      knee = knee * (1 - f) + 0.18 * f;
      g.hip.rotation.set(hip, 0, -g.s * 0.03 * f);
      g.knee.rotation.set(knee, 0, 0);
      g.ankle.rotation.set(-(hip + knee) * 0.7 * (1 - f) + 0.5 * f, 0, 0);
    }
    // Pelvis and torso: bob, twist and counter-twist; lean into the walk, hunch in the crouch.
    sk.root.position.y = rest.pelvisY - (0.025 * w * Math.cos(2 * ph) + 0.26 * c) * (1 - f);
    sk.root.rotation.set(0, 0.08 * w * Math.sin(ph) * (1 - f), 0);
    sk.spine.rotation.set(0.06 * w + 0.35 * c + 0.012 * Math.sin(time * 1.6), 0, 0);
    sk.chest.rotation.set(0.1 * c + 0.015 * Math.sin(time * 1.6 + 0.4), -0.12 * w * Math.sin(ph) * (1 - f), 0);
    // Head: steady on the walk; tilted back to look ahead when flying head-first.
    sk.neck.rotation.set(-0.06 * c - 0.75 * f, 0.1 * w * Math.sin(ph), 0);
    // Arms: down from the A-pose, swinging against the legs; drawn back in the crouch;
    // along his sides, palms back, in flight; or raised to fire.
    for (const n of ['L', 'R']) {
      const g = L[n];
      const other = ph + (n === 'L' ? Math.PI : 0);
      const swing = -0.35 * w * Math.sin(other) * (1 - c);
      const adduct = -g.s * (0.42 * (1 - f) + 0.6 * f);
      g.sh.rotation.set(swing * (1 - f) + 0.45 * c * (1 - f) + 0.3 * f, 0, adduct);
      g.el.rotation.set(-(0.3 + 0.25 * w * Math.max(0, Math.sin(other))) * (1 - f), 0, 0);
      g.wr.rotation.set(0.9 * f, 0, 0);
      const a = st.aim[n];
      if (a > 1e-3) {
        // Aim: the arm swung from its rest direction onto the target (in the chest's frame), straight, palm out.
        sk.root.updateMatrixWorld(true); // this frame's torso, so the aim is taken from where the shoulder is now
        inv.copy(sk.chest.matrixWorld).invert();
        tmp.copy(targets[n]).applyMatrix4(inv); // target in the chest's frame (mesh units)
        tmp2.set(...side(J.shoulder, g.s)).sub(new THREE.Vector3(...J.chest));
        tmp.sub(tmp2).normalize();
        q.setFromUnitVectors(rest.arm[n], tmp);
        g.sh.quaternion.slerp(q, a);
        g.el.rotation.x *= 1 - a;
        g.wr.rotation.set(0, 0, g.s * 1.0 * a);
      }
    }
  }

  /**
   * Place, pose and light him for this frame.
   * @param {object} spider the spider as drawn (p, b, F, v, taut, air, crouch, jolt, time, legs)
   * @param {number} dt real seconds since the last frame
   * @param {THREE.Camera} camera
   * @param {number[][]} beams world points his palms are firing at
   */
  function update(spider, dt, camera, beams = []) {
    dt = Math.min(dt, 0.1);
    v.set(spider.v[0], spider.v[1], spider.v[2]);
    const speed = v.length();
    tmp.set(spider.F[0], 0, spider.F[2]);
    if (tmp.lengthSq() > 1e-6) heading.copy(tmp.normalize());
    const yaw = Math.atan2(heading.x, heading.z);
    let yawRate = 0;
    if (st.yaw !== null && dt > 0) yawRate = Math.atan2(Math.sin(yaw - st.yaw), Math.cos(yaw - st.yaw)) / dt;
    st.yaw = yaw;
    ease('fly', spider.taut || 0, 6, dt);
    ease('air', spider.air || 0, 5, dt);
    ease('crouch', spider.crouch && !spider.air ? 1 : 0, 6, dt);
    const ground = spider.air ? 0 : 1;
    // Walking (or stepping round on the spot while turning), its cycle locked to the distance covered.
    const across = Math.hypot(v.x, v.z);
    ease('walk', ground * Math.min(1, Math.max(across / 26, Math.abs(yawRate) * 0.35)), 5, dt);
    st.phase += (dt * Math.max(across, Math.abs(yawRate) * 9) * Math.PI * 2) / STRIDE;
    // Hands up to fire: the beam targets on each side of him, the nearest one.
    tmp2.set(-heading.z, 0, heading.x); // his right, world
    const tgt = { L: null, R: null };
    for (const b of beams) {
      tmp.set(b[0] - group.position.x, b[1] - group.position.y, b[2] - group.position.z);
      const n = tmp.dot(tmp2) > 0 ? 'R' : 'L';
      if (!tgt[n] || tmp.lengthSq() < tgt[n].lengthSq()) tgt[n] = tmp.clone();
    }
    for (const n of ['L', 'R']) {
      st.aim[n] += ((tgt[n] ? 1 : 0) * (1 - st.fly) - st.aim[n]) * (1 - Math.exp(-7 * dt));
      if (tgt[n]) aimAt[n].copy(tgt[n]).add(group.position);
    }

    // Orientation: upright, leaning into the walk; head-first and chest down in flight.
    const lean = 0.12 * st.walk;
    const f = st.fly;
    H.copy(UP).addScaledVector(heading, lean).normalize();
    C.copy(heading).addScaledVector(UP, -lean);
    if (f > 0.01 && speed > 5) {
      tmp.copy(v).divideScalar(speed);
      H.lerp(tmp, f).normalize();
      C.lerp(UP, -f);
    }
    perp(C, H, heading);
    const k = 1 - Math.exp(-7 * dt);
    head.lerp(H, k).normalize();
    chestDir.lerp(C, k);
    perp(chestDir, head, heading);
    X.crossVectors(head, chestDir);
    basis.makeBasis(X, head, chestDir);
    body.quaternion.setFromRotationMatrix(basis);
    // Feet on the stars the spider stands on; in the air, where its body flies.
    let gy = 0;
    for (const l of spider.legs) gy += l.tip[1];
    gy /= spider.legs.length;
    const hipsY = gy + J.pelvis[1] * K;
    if (st.hipsY === null) st.hipsY = hipsY;
    st.hipsY += (hipsY - st.hipsY) * (1 - Math.exp(-10 * dt));
    const onGround = [spider.p[0], st.hipsY + Math.min(0, spider.jolt || 0) * 3, spider.p[2]]; // a landing sinks him onto bent knees
    const g = Math.max(st.air, st.fly);
    group.position.set(onGround[0] + (spider.b[0] - onGround[0]) * g, onGround[1] + (spider.b[1] - onGround[1]) * g, onGround[2] + (spider.b[2] - onGround[2]) * g);
    group.updateMatrixWorld(true);
    // Targets into the body's frame for the aim (the chest bone's frame is found in pose()).
    pose(dt, spider.time, aimAt);
    // The back thrusters form out of the suit for flight and fold away on landing.
    ease('pack', st.fly > 0.3 ? 1 : 0, 4, dt);
    const ps = 0.6 * st.pack * (1 + 0.12 * Math.sin(Math.PI * st.pack)); // a sleek rig, not a second body
    pack.scale.setScalar(Math.max(1e-3, ps));
    pack.visible = ps > 0.01;
    group.updateMatrixWorld(true);

    // Key over the camera's shoulder, rim from behind him.
    tmp.copy(camera.position).sub(group.position);
    const d = tmp.length() || 1;
    key.position.copy(tmp).addScaledVector(UP, d * 0.6).addScaledVector(X, -d * 0.3);
    rim.position.copy(tmp).multiplyScalar(-1).addScaledVector(UP, d * 0.3);

    // Thrusters: boots and palms in the air, palms alone while firing.
    const L = sk.limbs;
    const nozzle = [L.L.sole, L.R.sole, L.L.palm, L.R.palm];
    nozzle.forEach((b, i) => {
      b.getWorldPosition(tmp);
      glowPos.set([tmp.x, tmp.y, tmp.z], i * 3);
    });
    const thrust = Math.max(st.air, st.fly);
    const firing = st.aim.L > 0.3 || st.aim.R > 0.3;
    if (thrust > 0.1) glowGeo.setDrawRange(0, 4);
    else glowGeo.setDrawRange(2, firing ? 2 : 0);
    glowGeo.attributes.position.needsUpdate = true;
    glow.material.opacity = 0.75 + 0.25 * Math.sin(spider.time * 40);
    emitAcc += dt * 420 * thrust;
    while (emitAcc >= 1) {
      emitAcc -= 1;
      const n = Math.floor(Math.random() * (st.fly > 0.3 ? 4 : 2));
      const i = next;
      next = (next + 1) % EXHAUST;
      exPos.set(glowPos.subarray(n * 3, n * 3 + 3), i * 3);
      const s = 70 + 50 * st.fly;
      exVel[i * 3] = -head.x * s + (Math.random() - 0.5) * 14 + v.x * 0.6;
      exVel[i * 3 + 1] = -head.y * s + (Math.random() - 0.5) * 14 + v.y * 0.6;
      exVel[i * 3 + 2] = -head.z * s + (Math.random() - 0.5) * 14 + v.z * 0.6;
      exAge[i] = 0;
      exLife[i] = 0.18 + Math.random() * 0.22;
    }
    for (let i = 0; i < EXHAUST; i++) {
      exAge[i] += dt;
      const u = exAge[i] / exLife[i];
      if (u >= 1) {
        exCol[i * 3] = exCol[i * 3 + 1] = exCol[i * 3 + 2] = 0;
        continue;
      }
      exPos[i * 3] += exVel[i * 3] * dt;
      exPos[i * 3 + 1] += exVel[i * 3 + 1] * dt;
      exPos[i * 3 + 2] += exVel[i * 3 + 2] * dt;
      // White-blue at the nozzle, cooling to amber as it fades.
      const a = (1 - u) * (1 - u);
      exCol[i * 3] = a * (0.75 + 0.25 * u);
      exCol[i * 3 + 1] = a * (0.85 - 0.3 * u);
      exCol[i * 3 + 2] = a * (1 - 0.7 * u);
    }
    exGeo.attributes.position.needsUpdate = true;
    exGeo.attributes.color.needsUpdate = true;
  }

  return {
    group,
    update,
    /** Arc reactor, world space. */
    chest: () => sk.chest.localToWorld(new THREE.Vector3(0, 0.04, 0.19)).toArray(),
    /** The palm (world space) that fires at a target: the one on its side of him. */
    palm: (to) => {
      tmp2.set(-heading.z, 0, heading.x);
      const right = (to[0] - group.position.x) * tmp2.x + (to[2] - group.position.z) * tmp2.z > 0;
      const i = right ? 3 : 2;
      return [glowPos[i * 3], glowPos[i * 3 + 1], glowPos[i * 3 + 2]];
    },
    /** Which way his head points, world space. */
    up: () => head.toArray(),
  };
}
