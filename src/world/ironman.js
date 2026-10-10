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
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import OBJ from '../../assets/ironman/hero_ironman01.obj';
import TEX_BODY from '../../assets/ironman/hero_ironman01_S04.png';
import TEX_PACK from '../../assets/ironman/hero_ironman01_S04_wp4.png';

const HEIGHT = 46; // world units: he reads at the distances the camera keeps from the crawler
const K = HEIGHT / 2.02; // world units per mesh unit (the mesh stands 2.02 tall, feet at y = 0)
const FLY_SCALE = 1.9; // drawn this much larger in flight, so a leap reads at the camera's distance
const MAX_BEAMS = 32;
const SPARKS = 900;
const FLARES = 48;
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
  knee: [0.14, 0.46, 0.0],
  ankle: [0.175, 0.11, 0.02],
  toe: [0.173, 0.02, 0.22],
  sole: [0.174, 0.013, 0.067],
};
const side = (p, s) => [p[0] * s, p[1], p[2]];
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const L1 = V(J.knee).distanceTo(V(J.hip)); // thigh
const L2 = V(J.ankle).distanceTo(V(J.knee)); // shin
const ANKLE_H = J.ankle[1] - J.sole[1]; // ankle above the sole
const HIP_DROP = J.pelvis[1] - J.hip[1]; // pelvis above the hip joints
const HIP_W = J.hip[0]; // hip joint off the midline

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

/** Squared distance from p to segment ab. */
function segDist2(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / (abx * abx + aby * aby + abz * abz), 0, 1);
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
    for (let k = 0; k < 3; k++) {
      let best = -1;
      for (let b = 0; b < segs.length; b++) if (w[b] > 0 && (best < 0 || w[b] > w[best])) best = b;
      if (best < 0) break;
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

/**
 * Surface maps from the colour texture, once it has loaded: metalness and
 * roughness (green: roughness, blue: metalness, as three reads them), relief
 * (luminance: the silver and gold trim stands proud of the red panels) and
 * glow (the cyan lights: arc reactor, eyes, palms, vents).
 */
function deriveMaps(img) {
  const w = img.width;
  const h = img.height;
  const cv = (fn) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, h);
    const a = d.data;
    for (let i = 0; i < a.length; i += 4) fn(a, i, a[i] / 255, a[i + 1] / 255, a[i + 2] / 255);
    g.putImageData(d, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  };
  const glowOf = (r, g, b) => smooth(0.45, 0.7, b) * smooth(0.4, 0.65, g) * smooth(0.95, 0.6, r - b + 0.3);
  const mr = cv((a, i, r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const gold = smooth(0.35, 0.55, r) * smooth(0.22, 0.4, g) * smooth(0.3, 0.12, b) * smooth(0.45, 0.65, g / Math.max(r, 1e-3));
    const silver = smooth(0.14, 0.06, mx - mn) * smooth(0.2, 0.45, mx);
    const dark = smooth(0.12, 0.03, mx);
    // The red is paint (a dielectric base under the clear coat); gold and silver trim is bare metal.
    const metal = 0.22 + 0.78 * Math.max(gold, silver) - 0.15 * dark;
    const rough = 0.38 - 0.16 * gold - 0.2 * silver + 0.4 * dark;
    a[i] = 0;
    a[i + 1] = clamp(rough, 0.05, 1) * 255;
    a[i + 2] = clamp(metal, 0, 1) * 255;
    a[i + 3] = 255;
  });
  const bump = cv((a, i, r, g, b) => {
    const l = (0.3 * r + 0.59 * g + 0.11 * b) * 255;
    a[i] = a[i + 1] = a[i + 2] = l;
    a[i + 3] = 255;
  });
  const glow = cv((a, i, r, g, b) => {
    const k = glowOf(r, g, b);
    a[i] = r * k * 255;
    a[i + 1] = g * k * 255;
    a[i + 2] = b * k * 255;
    a[i + 3] = 255;
  });
  glow.colorSpace = THREE.SRGBColorSpace;
  return { mr, bump, glow };
}

/** A small space environment for the suit to reflect: dark, with cool and warm nebula light and stars. */
function spaceEnvironment(renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x04050a);
  const panel = (color, intensity, pos, size) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0x7d9bff, 2.2, [0, 9, 2], 9); // a cool sky above
  panel(0xffb46a, 1.6, [-8, -3, 4], 7); // a warm cluster low on one side
  panel(0xff4f9a, 1.1, [8, 1, -5], 6); // magenta on the other
  panel(0x9fe8ff, 3.0, [3, 4, 9], 2.2); // a hard key reflection
  const sg = new THREE.SphereGeometry(0.06, 6, 4);
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 160; i++) {
    const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(1 + 4 * rnd()) }));
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    m.position.set(r * Math.cos(th) * 12, u * 12, r * Math.sin(th) * 12);
    env.add(m);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.02).texture;
  pm.dispose();
  return tex;
}

/** Soft round sprites (flares and sparks): additive, sized in world units, with faint cross rays. */
function spriteMaterial(rays) {
  return new THREE.ShaderMaterial({
    uniforms: { uHalfH: { value: 450 }, uRays: { value: rays } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float size;
      uniform float uHalfH;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * projectionMatrix[1][1] * uHalfH / max(1.0, -mv.z), 0.0, 220.0);
        gl_Position = projectionMatrix * mv;
        vColor = color;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uRays;
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(d, d);
        if (r2 > 1.0) discard;
        float a = exp(-r2 * 7.0) + 0.25 * exp(-r2 * 2.2);
        float rays = exp(-abs(d.x) * 22.0) * exp(-abs(d.y) * 2.4) + exp(-abs(d.y) * 22.0) * exp(-abs(d.x) * 2.4);
        gl_FragColor = vec4(vColor * (a + uRays * rays * (1.0 - r2)), 1.0);
      }`,
  });
}

/** The repulsor ray: a camera-facing ribbon, white-hot core in a cyan sheath, pulsing and flickering. */
function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      attribute vec3 aInfo; // length, seed, power
      varying vec2 vUv;
      varying vec3 vInfo;
      void main() {
        vUv = aUv;
        vInfo = aInfo;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vInfo;
      void main() {
        float L = vInfo.x;
        float x = vUv.x * L;
        float v = vUv.y;
        float seed = vInfo.y;
        float power = vInfo.z;
        // Energy packets racing out from the palm, and a fast shimmer along the beam.
        float pulse = pow(0.5 + 0.5 * sin(x * 0.32 - uTime * 42.0 + seed * 6.3), 8.0);
        float shimmer = 0.82 + 0.18 * sin(x * 1.9 + uTime * 71.0 + seed * 13.0) * sin(x * 0.47 - uTime * 29.0);
        // The core trembles very slightly across the beam.
        float wob = 0.012 * sin(x * 0.11 - uTime * 37.0 + seed * 3.0);
        float vv = v - wob;
        float core = exp(-vv * vv / 0.01);
        float sheath = exp(-vv * vv / 0.12);
        float halo = exp(-abs(vv) * 2.6) * 0.22;
        // A gentle flare where it leaves the palm, fading to full strength a little way out.
        float mouth = 1.0 + 1.6 * exp(-x * 0.45);
        vec3 c = vec3(1.0, 1.0, 1.0) * core * (1.3 + 1.1 * pulse) + vec3(0.32, 0.72, 1.0) * (sheath * (0.75 + 0.7 * pulse) + halo);
        c *= shimmer * mouth * power;
        float fade = smoothstep(1.0, 0.86, abs(v));
        gl_FragColor = vec4(c * fade, 1.0);
      }`,
  });
}

/**
 * @param {THREE.WebGLRenderer} renderer for the suit's reflections
 * @returns {{group: THREE.Group, fx: THREE.Group, update: Function, chest: Function, up: Function}}
 */
export function createIronMan(renderer) {
  const group = new THREE.Group(); // at his pelvis
  const body = new THREE.Group(); // oriented: +y his head, +z his chest
  group.add(body);
  const fx = new THREE.Group(); // world-space effects: rays, flares, sparks

  const envMap = renderer ? spaceEnvironment(renderer) : null;
  const loadTex = (url, onImage) => {
    const t = new THREE.TextureLoader().load(url, (tt) => onImage && onImage(tt.image));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  // Clear-coated metal (the red is a metallic paint); its maps follow once the texture has loaded.
  const suit = (url, sideMode) => {
    const m = new THREE.MeshPhysicalMaterial({ metalness: 0.4, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.12, envMap, envMapIntensity: 1.7, emissive: 0xffffff, emissiveIntensity: 0, side: sideMode, fog: false });
    m.map = loadTex(url, (img) => {
      const d = deriveMaps(img);
      Object.assign(m, { metalnessMap: d.mr, roughnessMap: d.mr, metalness: 1, roughness: 1, bumpMap: d.bump, bumpScale: 1.6, emissiveMap: d.glow, emissiveIntensity: 2.6 });
      m.needsUpdate = true;
    });
    return m;
  };

  const parts = {};
  new OBJLoader().parse(OBJ).traverse((o) => {
    if (o.isMesh) parts[['wp2', 'wp4', 'wp5'].find((k) => o.name.includes(k)) || 'body'] = o.geometry;
  });
  const sk = buildSkeleton();
  skin(parts.body, sk.segs);
  const mesh = new THREE.SkinnedMesh(parts.body, suit(TEX_BODY, THREE.FrontSide));
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
  const pack = new THREE.Mesh(packGeo, suit(TEX_PACK, THREE.DoubleSide));
  pack.scale.setScalar(1e-3);
  sk.chest.add(pack);
  const pelvisY0 = sk.root.position.y;

  // Lights for the suit: a soft sky fill, a warm key from over the camera's shoulder, a cool rim.
  const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x1a1020, 1.7);
  const key = new THREE.DirectionalLight(0xfff1e0, 4.2);
  const rim = new THREE.DirectionalLight(0x7fb0ff, 3.2);
  const repulsorLight = new THREE.PointLight(0x9fdcff, 0, 60 * K / 22, 2); // the repulsors light up his own armour
  key.target = body;
  rim.target = body;
  group.add(hemi, key, rim, repulsorLight);

  // Effects: rays, flares (palms, boots, impacts) and sparks (exhaust, impacts).
  const beamGeo = new THREE.BufferGeometry();
  const bPos = new Float32Array(MAX_BEAMS * 4 * 3);
  const bUv = new Float32Array(MAX_BEAMS * 4 * 2);
  const bInfo = new Float32Array(MAX_BEAMS * 4 * 3);
  const bIdx = new Uint16Array(MAX_BEAMS * 6);
  for (let i = 0; i < MAX_BEAMS; i++) bIdx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  beamGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage));
  beamGeo.setAttribute('aUv', new THREE.BufferAttribute(bUv, 2).setUsage(THREE.DynamicDrawUsage));
  beamGeo.setAttribute('aInfo', new THREE.BufferAttribute(bInfo, 3).setUsage(THREE.DynamicDrawUsage));
  beamGeo.setIndex(new THREE.BufferAttribute(bIdx, 1));
  const beams = new THREE.Mesh(beamGeo, beamMaterial());
  beams.frustumCulled = false;
  beams.renderOrder = 16;
  const pointsOf = (n, mat) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    p.renderOrder = 17;
    return p;
  };
  const flares = pointsOf(FLARES, spriteMaterial(1));
  const sparks = pointsOf(SPARKS, spriteMaterial(0));
  fx.add(beams, flares, sparks);
  const sp = { vel: new Float32Array(SPARKS * 3), age: new Float32Array(SPARKS).fill(9), life: new Float32Array(SPARKS).fill(1), tint: new Float32Array(SPARKS * 3), size: new Float32Array(SPARKS), next: 0, acc: 0 };

  // State.
  const st = { phase: 0, feet: null, lastFoot: 'R', landAt: -9, grounded: true, seen: new Map(), time: 0 };
  const ez = {
    walk: spring(7), fly: spring(9), air: spring(9), crouch: spring(10, 0.9), pack: spring(7, 0.6), scale: spring(6),
    pelvisY: spring(16, 0.85), sway: spring(10), yawP: spring(12), roll: spring(12),
    twist: spring(9, 0.9), lookY: spring(10, 0.9), lookP: spring(10, 0.9),
    arm: { L: spring(9, 0.55), R: spring(9, 0.55) }, aim: { L: spring(11, 0.85), R: spring(11, 0.85) },
    recoil: { L: spring(26, 0.45), R: spring(26, 0.45) }, charge: { L: spring(14), R: spring(14) },
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

  /** Emit a spark. */
  function spark(p, vx, vy, vz, life, r, g, b, size) {
    const i = sp.next;
    sp.next = (sp.next + 1) % SPARKS;
    const pa = sparks.geometry.attributes.position.array;
    pa[i * 3] = p.x;
    pa[i * 3 + 1] = p.y;
    pa[i * 3 + 2] = p.z;
    sp.vel[i * 3] = vx;
    sp.vel[i * 3 + 1] = vy;
    sp.vel[i * 3 + 2] = vz;
    sp.age[i] = 0;
    sp.life[i] = life;
    sp.tint[i * 3] = r;
    sp.tint[i * 3 + 1] = g;
    sp.tint[i * 3 + 2] = b;
    sp.size[i] = size;
  }

  /* ---------------- feet: planner and IK ---------------- */

  /** Where a foot would like to stand now (sole, world), given the body's place, heading and speed. */
  function footHome(n, out, pelvis, ground, lead) {
    const s = n === 'L' ? 1 : -1;
    out.copy(pelvis).addScaledVector(leftV, s * (HIP_W + 0.02) * K).addScaledVector(v, lead);
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
        const err = Math.hypot(f.pos.x - a3.x, f.pos.z - a3.z) + Math.abs(wrapA(f.yaw - yaw)) * 0.25 * K + Math.abs(f.pos.y - ground) * 0.5;
        const bias = n === st.lastFoot ? 0.6 : 1;
        if (err * bias > worst) {
          worst = err * bias;
          pick = n;
        }
      }
      const need = speed > 4 ? 0.16 * K : 0.07 * K;
      if (pick && worst > need) {
        const f = feet[pick];
        f.swing = { u: 0, dur: speed > 4 ? stepDur : 0.34, from: f.pos.clone(), fromYaw: f.yaw, lift: (0.07 + 0.06 * Math.min(1, speed / 26)) * K, target: new THREE.Vector3() };
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
        f.roll = 0.55 * smooth(0.12 * K, 0.38 * K, behind);
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
    a3.copy(f.pos).addScaledVector(UP, ANKLE_H * K + Math.max(0, f.roll) * 0.16 * K);
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
    let dt = clamp(frameDt, 0, 0.1);
    const sdt = jumped ? frameDt : dt;
    st.time += dt;
    flares.material.uniforms.uHalfH.value = halfH;
    sparks.material.uniforms.uHalfH.value = halfH;
    beams.material.uniforms.uTime.value = spider.time;
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
    if (!st.feet || Math.hypot(st.feet.L.pos.x - spider.p[0], st.feet.L.pos.z - spider.p[2]) > 3 * K) {
      st.feet = {};
      for (const n of ['L', 'R']) st.feet[n] = { pos: footHome(n, new THREE.Vector3(), a3.set(spider.p[0], gy, spider.p[2]), gy, 0), yaw, roll: 0, swing: null };
    }
    if (st.grounded && g > 0.6) st.grounded = false;
    if (!st.grounded && g < 0.35) {
      st.grounded = true;
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
    const stand = (J.pelvis[1] - 0.035) * K;
    if (ez.pelvisY.x === 0) ez.pelvisY.x = stand;
    const pelvisH = ez.pelvisY.to(Math.min(stand, top) - 0.3 * K * clamp(crouch, 0, 1), sdt);
    const sway = ez.sway.to(-swingSide * 0.022 * K * walk, sdt);
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
    const lead = clamp((a3.x * heading.x + a3.z * heading.z) / (0.35 * K), -1, 1); // + when the left foot is ahead
    const pelvisYaw = ez.yawP.to(-0.13 * lead * walk * (1 - g), sdt);
    const pelvisRoll = ez.roll.to(swingSide * 0.06 * walk * (1 - g), sdt);
    sk.root.position.y = pelvisY0;
    sk.root.rotation.set(0, pelvisYaw, pelvisRoll);
    group.updateMatrixWorld(true);

    // Targets: each side's nearest word; a new ray kicks that arm back and charges the palm.
    const tgt = { L: null, R: null };
    const ids = new Set();
    for (const t of targets) {
      a3.set(t.at[0] - group.position.x, t.at[1] - group.position.y, t.at[2] - group.position.z);
      const n = a3.dot(leftV) > 0 ? 'L' : 'R';
      t.side = n;
      ids.add(t.id);
      if (!st.seen.has(t.id)) {
        st.seen.set(t.id, n);
        ez.recoil[n].v += 9;
        ez.charge[n].v += 30;
      }
      if (!tgt[n] || a3.lengthSq() < tgt[n].lengthSq()) tgt[n] = a3.clone();
    }
    for (const id of [...st.seen.keys()]) if (!ids.has(id)) st.seen.delete(id);
    let twistTo = 0;
    let lookY = 0;
    let lookP = 0;
    let nT = 0;
    for (const n of ['L', 'R']) {
      ez.aim[n].to((tgt[n] ? 1 : 0) * (1 - g), sdt);
      ez.recoil[n].to(0, sdt);
      ez.charge[n].to(0, sdt);
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
      const adduct = -gA.s * (0.42 * (1 - fly) + 0.6 * fly);
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

    // The back thrusters form out of the suit for flight and fold away on landing.
    const ps = clamp(ez.pack.to(fly > 0.3 ? 1 : 0, sdt), 0, 1.2) * 0.6;
    pack.scale.setScalar(Math.max(1e-3, ps));
    pack.visible = ps > 0.01;
    group.updateMatrixWorld(true);

    // Key over the camera's shoulder, rim from behind him.
    a3.copy(camera.position).sub(group.position);
    const dist = a3.length() || 1;
    key.position.copy(a3).addScaledVector(UP, dist * 0.6).addScaledVector(X, -dist * 0.3);
    rim.position.copy(a3).multiplyScalar(-1).addScaledVector(UP, dist * 0.3);

    /* ---- effects ---- */
    const L = sk.limbs;
    const palmW = { L: L.L.palm.getWorldPosition(new THREE.Vector3()), R: L.R.palm.getWorldPosition(new THREE.Vector3()) };
    const soleW = [L.L.sole.getWorldPosition(new THREE.Vector3()), L.R.sole.getWorldPosition(new THREE.Vector3())];
    const thrust = Math.max(air, fly);

    // Rays.
    let nb = 0;
    camera.getWorldPosition(c3);
    for (const t of targets) {
      if (nb >= MAX_BEAMS) break;
      const from = palmW[t.side || 'R'];
      a3.set(t.at[0], t.at[1], t.at[2]);
      const to = b3.copy(from).lerp(a3, clamp(t.p, 0, 1));
      const len = from.distanceTo(to);
      if (len < 0.5) continue;
      const toCam = a3.copy(from).add(to).multiplyScalar(0.5).sub(c3).multiplyScalar(-1);
      const dir = to.clone().sub(from).normalize();
      const w = (1.5 + 0.6 * Math.min(1, len / 150)) * (K / 22.8); // half-width: the cyan sheath; the white core is a fifth of it
      const sideV = dir.clone().cross(toCam).normalize().multiplyScalar(w);
      const o = nb * 4;
      const corners = [[from, 1], [from, -1], [to, 1], [to, -1]];
      corners.forEach(([p, s], k2) => {
        bPos[(o + k2) * 3] = p.x + sideV.x * s;
        bPos[(o + k2) * 3 + 1] = p.y + sideV.y * s;
        bPos[(o + k2) * 3 + 2] = p.z + sideV.z * s;
        bUv[(o + k2) * 2] = k2 < 2 ? 0 : 1;
        bUv[(o + k2) * 2 + 1] = s;
        bInfo[(o + k2) * 3] = len;
        bInfo[(o + k2) * 3 + 1] = (t.id * 0.618) % 1;
        bInfo[(o + k2) * 3 + 2] = 0.9 + 0.1 * Math.sin(spider.time * 31 + t.id);
      });
      nb++;
      // Where it hits: sparks thrown back off the star.
      if (t.p >= 1 && Math.random() < dt * 40) {
        const sv = 25 + 35 * Math.random();
        spark(to, -dir.x * sv + (Math.random() - 0.5) * 40, -dir.y * sv + (Math.random() - 0.5) * 40, -dir.z * sv + (Math.random() - 0.5) * 40, 0.2 + 0.25 * Math.random(), 1, 0.85, 0.6, 0.9);
      }
    }
    beamGeo.setDrawRange(0, nb * 6);
    for (const name of ['position', 'aUv', 'aInfo']) beamGeo.attributes[name].needsUpdate = true;

    // Flares: palms (charging and firing), boots (in the air), and each ray's point of impact.
    const fp = flares.geometry.attributes.position.array;
    const fc = flares.geometry.attributes.color.array;
    const fs = flares.geometry.attributes.size.array;
    let nf = 0;
    const flare = (p, r, g2, b, size) => {
      if (nf >= FLARES) return;
      fp[nf * 3] = p.x;
      fp[nf * 3 + 1] = p.y;
      fp[nf * 3 + 2] = p.z;
      fc[nf * 3] = r;
      fc[nf * 3 + 1] = g2;
      fc[nf * 3 + 2] = b;
      fs[nf] = size * (K / 22.8) * scale;
      nf++;
    };
    const flick = 0.85 + 0.15 * Math.sin(spider.time * 47);
    let lightP = 0;
    for (const n of ['L', 'R']) {
      const fire = clamp(ez.aim[n].x, 0, 1) * (tgt[n] ? 1 : 0);
      const ch = Math.max(0, ez.charge[n].x);
      const pw = Math.max(fire * 0.7 + Math.min(1.5, ch * 1.4), thrust * 0.8); // the charge flashes up, then holds while firing
      if (pw > 0.02) flare(palmW[n], 0.75 * pw * flick, 0.9 * pw * flick, 1.0 * pw * flick, 3.2 + 3 * Math.min(1, ch));
      lightP += pw;
    }
    if (thrust > 0.05) for (const s of soleW) flare(s, 0.8 * thrust * flick, 0.9 * thrust * flick, thrust * flick, 4.2);
    for (const t of targets) if (t.p >= 1) flare(a3.set(t.at[0], t.at[1], t.at[2]), 0.9 * flick, 0.95 * flick, 1.0 * flick, 3.4 + 0.6 * Math.sin(spider.time * 23 + t.id));
    flares.geometry.setDrawRange(0, nf);
    for (const name of ['position', 'color', 'size']) flares.geometry.attributes[name].needsUpdate = true;
    repulsorLight.intensity = 40 * Math.min(2, lightP);
    repulsorLight.position.copy(head).multiplyScalar(0.2 * K);

    // Exhaust: sparks shooting back from boots (and palms in flight).
    sp.acc += dt * 500 * thrust;
    while (sp.acc >= 1) {
      sp.acc -= 1;
      const n = Math.random() < (fly > 0.3 ? 0.5 : 1) ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
      const p = n < 2 ? soleW[n] : palmW[n === 2 ? 'L' : 'R'];
      const s = (70 + 60 * fly) * scale;
      spark(p, -head.x * s + (Math.random() - 0.5) * 16 + v.x * 0.6, -head.y * s + (Math.random() - 0.5) * 16 + v.y * 0.6, -head.z * s + (Math.random() - 0.5) * 16 + v.z * 0.6, 0.16 + Math.random() * 0.2, 0.8, 0.9, 1, 1.0 * scale);
    }
    const pa = sparks.geometry.attributes.position.array;
    const ca = sparks.geometry.attributes.color.array;
    const sa = sparks.geometry.attributes.size.array;
    for (let i = 0; i < SPARKS; i++) {
      sp.age[i] += dt;
      const u = sp.age[i] / sp.life[i];
      if (u >= 1) {
        sa[i] = 0;
        continue;
      }
      pa[i * 3] += sp.vel[i * 3] * dt;
      pa[i * 3 + 1] += sp.vel[i * 3 + 1] * dt;
      pa[i * 3 + 2] += sp.vel[i * 3 + 2] * dt;
      // White-blue at birth, cooling to amber as it fades.
      const a = (1 - u) * (1 - u);
      ca[i * 3] = a * sp.tint[i * 3] * (0.8 + 0.4 * u);
      ca[i * 3 + 1] = a * sp.tint[i * 3 + 1] * (1 - 0.35 * u);
      ca[i * 3 + 2] = a * sp.tint[i * 3 + 2] * (1 - 0.75 * u);
      sa[i] = sp.size[i] * (K / 22.8) * (1 - 0.4 * u);
    }
    for (const name of ['position', 'color', 'size']) sparks.geometry.attributes[name].needsUpdate = true;
  }

  return {
    group,
    fx,
    update,
    /** Arc reactor, world space. */
    chest: () => sk.chest.localToWorld(new THREE.Vector3(0, 0.04, 0.19)).toArray(),
    /** Which way his head points, world space. */
    up: () => head.toArray(),
  };
}
