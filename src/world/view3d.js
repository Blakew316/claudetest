/**
 * WebGL renderer (three.js) for the crawl.
 *
 * Environment: per section a small universe, a dense star cluster (tens of
 * thousands of soft stars with hot white cores, depth of field, twinkle and
 * drift) laced with a fine constellation web; tidal streams of stardust
 * between clusters; floating dust and a deep background starfield for
 * parallax. The stars brighten around the spider as it moves through them.
 * No glow sprites: the light lives in the stars.
 *
 * Spider: shaded 3D anatomy, all real geometry: tapered limb segments with
 * ball joints and hairs, a cephalothorax and a lagging, breathing abdomen
 * (fresnel skin, wire mesh, dorsal chevrons, tumbling core), eight eyes,
 * fangs, palps, spinnerets; plus rippling dotted tentacles and sagging silk.
 *
 * Camera from run.camera (plus a slow handheld drift and the viewer's drag),
 * depth of field focused on the spider, bloom. Reads run state only.
 * project() maps world points to stage pixels for the 2D label overlay.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BG, QUEUED, FLAG, SPIDER, TENTACLE, SECTION_PALETTE } from '../core/theme.js';
import { makeBall } from './galaxy.js';
import { mulberry32 } from '../core/rng.js';
import { LEG_COUNT, MAX_TENTACLES } from '../core/contracts.js';
import { ABDOMEN, CEPH, SCALE as SS } from './spider.js';

export const FOV = 50;
const TENTACLE_DOTS = 200;
const SILK_SUB = 5;
const SILK_MAX = 520 * SILK_SUB + 24;
const MOTES = 500; // dust motes drifting past the lens
const MOTE_BOX = 360; // ...in a box this wide (world units) wrapped round the camera
const HAIRS = 60; // setae per leg: spines on femur and tibia, a dense scopula under the foot
const LR = 1.18; // leg thickness: eight sturdy legs
const LEG_SEGS = 9; // coxa, femur (two, bowed), patella, tibia, metatarsus, tarsus, two claws
const LIMBS = LEG_COUNT * LEG_SEGS + 1 + 4 + 6 + 6; // legs, pedicel, chelicerae (base + fang), palps, spinnerets
const JOINTS = LEG_COUNT * 6;

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const smoothR = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Body shapes, as deformations of the unit sphere (x forward, y up, z side).
 * Cephalothorax: flat underneath, raised over the eye region, sloping down
 * behind, narrowing toward the face.
 */
function cephShape(x, y, z) {
  const zs = 1 - 0.2 * smoothR(0.15, 1, x) + 0.05 * smoothR(0, -0.9, x);
  const ys = y > 0 ? 1 + 0.16 * smoothR(0.05, 0.75, x) - 0.18 * smoothR(-0.1, -0.95, x) : 0.72;
  return [x, y * ys, z * zs];
}

/** Abdomen: egg-shaped, tapering to the spinnerets and a little to the pedicel, with a dorsal hump. */
function abdShape(x, y, z) {
  const t = 1 - 0.34 * smoothR(-0.2, -1, x) - 0.14 * smoothR(0.6, 1, x);
  return [x, y * t * (y > 0 ? 1.08 : 0.9), z * t];
}

/** Apply a shape to a geometry's vertices (and its normals, for meshes). */
function shapeGeometry(g, fn) {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setXYZ(i, x, y, z);
  }
  pos.needsUpdate = true;
  if (g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** Fine setae over the back and sides of a body part, leaning backward. */
function bodyHairs(n, fn, seed) {
  let s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const v = [];
  for (let i = 0, guard = 0; i < n && guard < n * 4; guard++) {
    const u = r() * 2 - 1;
    const th = r() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    if (u < -0.3) continue; // not underneath
    const b = fn(sq * Math.cos(th), u, sq * Math.sin(th));
    const l = Math.hypot(b[0], b[1], b[2]) || 1;
    const len = 0.06 + 0.08 * r();
    v.push(b[0] * 1.01, b[1] * 1.01, b[2] * 1.01, b[0] + (b[0] / l - 0.7) * len, b[1] + (b[1] / l) * len, b[2] + (b[2] / l) * len);
    i++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

/** Latitude/longitude wireframe of a unit sphere, as line segments. */
function latLong(lat, lon, seg = 32) {
  const v = [];
  for (let i = 1; i < lat; i++) {
    const phi = (i / lat) * Math.PI;
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const b = ((k + 1) / seg) * Math.PI * 2;
      v.push(r * Math.cos(a), y, r * Math.sin(a), r * Math.cos(b), y, r * Math.sin(b));
    }
  }
  for (let j = 0; j < lon; j++) {
    const a = (j / lon) * Math.PI * 2;
    for (let k = 0; k < seg; k++) {
      const p = (k / seg) * Math.PI;
      const q = ((k + 1) / seg) * Math.PI;
      v.push(Math.sin(p) * Math.cos(a), Math.cos(p), Math.sin(p) * Math.sin(a), Math.sin(q) * Math.cos(a), Math.cos(q), Math.sin(q) * Math.sin(a));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

/**
 * Dorsal pattern on the abdomen (unit-sphere space: x forward, y up, z side):
 * a midline mark and a row of chevrons down the back.
 */
/** Radial grooves (striae) and the central fovea on the top of the cephalothorax (unit sphere). */
function striae() {
  const v = [];
  const surf = (x, z) => [x, Math.sqrt(Math.max(0, 1 - x * x - z * z)) * 1.012, z];
  const seg = (a, b) => v.push(...a, ...b);
  const cx = -0.12;
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const steps = 6;
    for (let j = 0; j < steps; j++) {
      const r0 = 0.12 + (j / steps) * 0.62;
      const r1 = 0.12 + ((j + 1) / steps) * 0.62;
      seg(surf(cx + Math.cos(a) * r0, Math.sin(a) * r0 * 0.9), surf(cx + Math.cos(a) * r1, Math.sin(a) * r1 * 0.9));
    }
  }
  for (let j = 0; j < 4; j++) seg(surf(cx - 0.12 + j * 0.06, 0), surf(cx - 0.06 + j * 0.06, 0)); // the fovea
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

function chevrons() {
  const v = [];
  const surf = (x, z) => [x, Math.sqrt(Math.max(0, 1 - x * x - z * z)) * 1.012, z];
  const seg = (a, b) => v.push(...a, ...b);
  for (let c = 0; c < 7; c++) {
    const x0 = 0.62 - c * 0.2;
    const w = 0.46 - c * 0.05;
    const steps = 6;
    for (const sg of [-1, 1]) {
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps;
        const t1 = (k + 1) / steps;
        seg(surf(x0 - 0.14 * t0, sg * w * t0), surf(x0 - 0.14 * t1, sg * w * t1));
      }
    }
  }
  for (let k = 0; k < 8; k++) seg(surf(0.75 - k * 0.12, 0), surf(0.75 - (k + 1) * 0.12, 0));
  // Sigilla: four pairs of small dimples where the muscles attach.
  for (let i = 0; i < 4; i++) {
    for (const sg of [-1, 1]) {
      const cx = 0.48 - i * 0.24;
      const cz = sg * (0.2 - i * 0.03);
      const rr = 0.045 - i * 0.006;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const b = ((k + 1) / 10) * Math.PI * 2;
        seg(surf(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr), surf(cx + Math.cos(b) * rr, cz + Math.sin(b) * rr));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

function dynamicGeometry(count, itemSize = 3, colorSize = 0) {
  const g = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize);
  pos.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pos);
  if (colorSize) {
    const col = new THREE.BufferAttribute(new Float32Array(count * colorSize), colorSize);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', col);
  }
  return g;
}

/** Thick screen-space line segments with room for `count` segments, updated in place. */
function fatSegments(count, color, width, opacity = 1) {
  const g = new LineSegmentsGeometry();
  g.setPositions(new Float32Array(count * 6));
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity });
  const l = new LineSegments2(g, m);
  l.frustumCulled = false;
  return l;
}

function writeSegments(line, arr) {
  const data = line.geometry.attributes.instanceStart.data;
  data.array.set(arr);
  data.needsUpdate = true;
}

/**
 * Soft particles with depth of field: crisp at the focal distance, swelling
 * into faint discs in front and behind; they twinkle and drift like dust in
 * air, and brighten near the spider. Needs 'bright' and 'phase' attributes.
 */
function depthPoints(shared, { size, max, drift, dof }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uColor: { value: new THREE.Color(1, 1, 1) },
      uSize: { value: size },
      uMax: { value: max },
      uDrift: { value: drift },
      uDof: { value: dof },
      uGain: { value: 1 },
      uFogK: { value: 1 },
    },
    vertexShader: `
      attribute float bright;
      attribute float phase;
      attribute float hot;
      uniform float uSize, uMax, uScale, uFog, uTime, uFocus, uDpr, uDrift, uDof, uGain, uLightR, uLightGain, uFogK, uClear;
      uniform vec3 uLight;
      varying float vA;
      varying float vBlur;
      varying float vHot;
      varying float vTemp;
      varying float vGlint;
      void main() {
        vec3 p = position + uDrift * vec3(
          sin(uTime * 0.21 + phase * 6.2831),
          sin(uTime * 0.17 + phase * 11.31),
          cos(uTime * 0.19 + phase * 7.73));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float depth = max(1.0, -mv.z);
        float px = uSize * uScale / depth;
        float blur = uDof * clamp(abs(depth - uFocus) / uFocus - 0.12, 0.0, 1.3);
        float grow = 1.0 + blur * 4.0;
        gl_PointSize = clamp(px * grow, 1.0, uMax * uDpr);
        float tw = 0.72 + 0.28 * sin(uTime * (0.7 + phase * 1.9) + phase * 31.0);
        float energy = min(1.0, px) / pow(grow, 1.6);
        float dl = distance(p, uLight);
        float lit = uGain + uLightGain * exp(-dl * dl / (uLightR * uLightR));
        float fz = uFog * depth * uFogK;
        // Clear the stars between the camera and the spider so it always reads,
        // however dense the cluster it is crawling through.
        vec4 lv = viewMatrix * vec4(uLight, 1.0);
        float ld = max(1.0, -lv.z);
        float lateral = length(mv.xy / depth - lv.xy / ld) * ld;
        float front = 1.0 - smoothstep(ld - 40.0, ld - 6.0, depth);
        float clear = 1.0 - 0.88 * front * (1.0 - smoothstep(uClear * 0.3, uClear, lateral));
        vA = bright * tw * energy * lit * clear * exp(-fz * fz);
        vBlur = clamp(blur, 0.0, 1.0);
        vHot = hot;
        // Star temperature from the per-star phase: most near the section hue,
        // some warmer or cooler, a rare few amber or blue-white giants.
        vTemp = fract(phase * 13.73) * 2.0 - 1.0;
        // Only the brightest, sharpest, large-enough stars get a glint.
        vGlint = smoothstep(0.85, 1.0, bright) * (1.0 - clamp(blur, 0.0, 1.0)) * smoothstep(3.0, 7.0, gl_PointSize);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vA;
      varying float vBlur;
      varying float vHot;
      varying float vTemp;
      varying float vGlint;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        if (d > 0.5) discard;
        float sharp = smoothstep(0.5, 0.06, d);
        float disc = smoothstep(0.5, 0.4, d) * (0.55 + 0.45 * smoothstep(0.15, 0.45, d));
        // Hot stars burn toward white at the core of the cluster.
        vec3 c = mix(uColor, vec3(1.0, 0.97, 0.92), vHot * 0.5) * (1.0 - vHot * 0.25);
        float t = abs(vTemp);
        vec3 tint = vTemp > 0.0 ? vec3(1.0, 0.8, 0.58) : vec3(0.74, 0.86, 1.0);
        c *= mix(vec3(1.0), tint, t * t * 0.45);
        c = mix(c, vTemp > 0.0 ? vec3(1.0, 0.74, 0.4) : vec3(0.78, 0.88, 1.0), smoothstep(0.94, 1.0, t) * 0.55);
        // A tiny four-point diffraction glint on the brightest stars (inside the point, never a halo).
        float glint = (exp(-abs(q.x) * 34.0) * exp(-abs(q.y) * 3.2) + exp(-abs(q.y) * 34.0) * exp(-abs(q.x) * 3.2)) * vGlint;
        gl_FragColor = vec4(c * vA * (mix(sharp, disc, vBlur) + glint * 0.55), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Silk: a slow shimmer travels along it, it fades with depth and brightens near the spider. */
function silkMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.2 } },
    vertexShader: `
      uniform float uTime, uFog, uLightR, uLightGain;
      uniform vec3 uLight;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sh = 0.5 + 0.5 * sin(uTime * 1.1 + dot(position, vec3(0.041, 0.029, 0.035)));
        float dl = distance(position, uLight);
        float lit = 1.0 + uLightGain * 0.7 * exp(-dl * dl / (uLightR * uLightR));
        // Square, not pow(): a vertex behind the camera has negative depth and pow() of a negative base is NaN.
        float fz = uFog * -mv.z;
        vA = (0.5 + 0.5 * sh * sh) * lit * exp(-fz * fz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vA;
      void main() { gl_FragColor = vec4(uColor * vA * uOpacity, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Glassy shading for the body and limbs: dark core, bright silhouette (fresnel); instancing-aware. */
function fresnel(core, rim, band = 9) {
  return new THREE.ShaderMaterial({
    uniforms: { uCore: { value: new THREE.Color(core) }, uRim: { value: new THREE.Color(rim) }, uBand: { value: band } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 local = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vec4 mv = modelViewMatrix * local;
        vN = normalize(normalMatrix * nrm);
        vV = normalize(-mv.xyz);
        vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uCore; uniform vec3 uRim; uniform float uBand;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float g = clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float f = g * g;
        float band = 0.5 + 0.5 * sin(vP.y * uBand);
        vec3 c = mix(uCore * (0.62 + 0.76 * band), uRim * (0.85 + 0.15 * band), f * 0.92);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createView3D(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene();
  // An explicit background makes three clear inside each render pass in the
  // render target's colour space; the clear colour alone gets converted twice
  // through the composer and lifts black to grey.
  scene.background = new THREE.Color(BG);
  const fog = new THREE.FogExp2(BG, 0.0005);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 60000);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.35, 0.3));
  composer.addPass(new OutputPass());

  const orbit = { yaw: 0, pitch: 0 };
  const size = { w: 1, h: 1 };
  const tmp = new THREE.Vector3();
  const grey = new THREE.Color(QUEUED).multiplyScalar(0.5);
  const shared = {
    uTime: { value: 0 },
    uFog: { value: 0.0005 },
    uFocus: { value: 800 },
    uScale: { value: 500 },
    uDpr: { value: 1 },
    uLight: { value: new THREE.Vector3() },
    uLightR: { value: 210 },
    uLightGain: { value: 0.55 },
    uClear: { value: 80 * SS },
  };
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const upY = new THREE.Vector3(0, 1, 0);
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vS = new THREE.Vector3();
  let W = null;

  function resize(w, h, dpr) {
    size.w = w;
    size.h = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    shared.uScale.value = (h * dpr) / 2 / Math.tan((FOV * Math.PI) / 360);
    shared.uDpr.value = dpr;
    if (W) for (const l of W.fat) l.material.resolution.set(w, h);
  }

  function disposeTree(obj) {
    obj.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
  }

  /** Build the scene for a world. */
  function setWorld(world, analysis) {
    if (W) {
      scene.remove(W.root);
      disposeTree(W.root);
    }
    const root = new THREE.Group();
    scene.add(root);
    let seed = 1234567;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pointsGeo = (pos, brightFn, hot = null) => {
      const n = pos.length / 3;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('bright', new THREE.BufferAttribute(Float32Array.from({ length: n }, (_, i) => brightFn(i)), 1));
      g.setAttribute('phase', new THREE.BufferAttribute(Float32Array.from({ length: n }, () => rnd()), 1));
      g.setAttribute('hot', new THREE.BufferAttribute(hot || new Float32Array(n), 1));
      return g;
    };

    // Floating dust through the whole space: parallax and foreground bokeh.
    const b = world.bounds;
    const DUST = 5000;
    const dpos = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const rr = b.radius * 2.4 * Math.cbrt(rnd());
      const sq = Math.sqrt(1 - u * u);
      dpos[i * 3] = b.x + rr * sq * Math.cos(th);
      dpos[i * 3 + 1] = b.y + rr * u * 0.6;
      dpos[i * 3 + 2] = b.z + rr * sq * Math.sin(th);
    }
    // Motes: faint specks in a box that wraps round the camera, so there is always
    // something drifting past the lens and every camera move reads in depth.
    const mpos = new Float32Array(MOTES * 3);
    const mbase = Float32Array.from({ length: MOTES * 3 }, () => rnd() * MOTE_BOX);
    const mglow = Float32Array.from({ length: MOTES }, () => 0.05 + 0.08 * rnd());
    const mm = depthPoints(shared, { size: 1, max: 5, drift: 0, dof: 0.6 });
    mm.uniforms.uColor.value.set('#a8b8e0');
    const motes = new THREE.Points(pointsGeo(mpos, () => 0), mm);
    motes.frustumCulled = false;
    root.add(motes);
    const dm = depthPoints(shared, { size: 1.1, max: 16, drift: 7, dof: 1.3 });
    dm.uniforms.uColor.value.set('#8fa0c8');
    root.add(new THREE.Points(pointsGeo(dpos, () => 0.05 + 0.15 * rnd()), dm));
    // Deep background starfield, far beyond everything, for a sense of open space.
    const SKY = 9000;
    const spos = new Float32Array(SKY * 3);
    const shot = new Float32Array(SKY);
    for (let i = 0; i < SKY; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const rr = b.radius * (4 + 3 * rnd());
      const sq = Math.sqrt(1 - u * u);
      spos[i * 3] = b.x + rr * sq * Math.cos(th);
      spos[i * 3 + 1] = b.y + rr * u;
      spos[i * 3 + 2] = b.z + rr * sq * Math.sin(th);
      shot[i] = rnd() < 0.08 ? 0.8 : 0.3 * rnd();
    }
    const sky = depthPoints(shared, { size: 4, max: 3, drift: 0, dof: 0 });
    sky.uniforms.uColor.value.set('#9fb0d8');
    sky.uniforms.uFogK.value = 0;
    root.add(new THREE.Points(pointsGeo(spos, () => (rnd() < 0.05 ? 0.9 : 0.15 + 0.35 * rnd()), shot), sky));
    // Other universes: small cluster balls far out in every direction, hazy with distance.
    const far = mulberry32(98765);
    for (let k = 0; k < 28; k++) {
      const u = far() * 1.6 - 0.8;
      const th = (k / 28) * Math.PI * 2 + far() * 0.3;
      const rr = b.radius * (1.9 + 2.8 * far());
      const sq = Math.sqrt(1 - u * u);
      const g = makeBall(far, 45 + 90 * far(), Math.round(1400 + 1800 * far()));
      for (let i = 0; i < g.pos.length; i += 3) {
        g.pos[i] += b.x + rr * sq * Math.cos(th);
        g.pos[i + 1] += b.y + rr * u * 0.7;
        g.pos[i + 2] += b.z + rr * sq * Math.sin(th);
      }
      const m = depthPoints(shared, { size: 1.6, max: 5, drift: 0.5, dof: 0.3 });
      m.uniforms.uColor.value.set(SECTION_PALETTE[k % 7]).lerp(new THREE.Color('#9fb0d8'), 0.45);
      m.uniforms.uGain.value = 0.32;
      m.uniforms.uFogK.value = 0.2;
      root.add(new THREE.Points(pointsGeo(g.pos, (i) => Math.min(1, g.bright[i]), g.hot), m));
    }

    const clusters = world.clusters.map((c, i) => {
      const g = world._clouds[i];
      // Stars: ordinary ones, and the bright ones drawn larger.
      const n = g.pos.length / 3;
      const big = [];
      for (let k = 0; k < n; k++) if (g.bright[k] > 1.2) big.push(k);
      // A real luminosity function: most stars faint, a few bright (gain is raised to match).
      const points = new THREE.Points(pointsGeo(g.pos, (k) => Math.min(1, g.bright[k]) * (0.22 + 0.78 * rnd() ** 2.4), g.hot), depthPoints(shared, { size: 0.95, max: 7, drift: 1.2, dof: 0.5 }));
      const bpos = new Float32Array(big.length * 3);
      const bhot = new Float32Array(big.length);
      big.forEach((k, j) => {
        bpos.set(g.pos.subarray(k * 3, k * 3 + 3), j * 3);
        bhot[j] = 0.6;
      });
      const stars = new THREE.Points(pointsGeo(bpos, () => 1, bhot), depthPoints(shared, { size: 2.2, max: 12, drift: 0.8, dof: 0.6 }));
      // Constellation web between neighbouring stars.
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', points.geometry.getAttribute('position'));
      eg.setIndex(new THREE.BufferAttribute(g.edges, 1));
      const lines = new THREE.LineSegments(eg, silkMaterial(shared));
      root.add(lines, points, stars);
      return { points, stars, lines, mix: 0, gain: 0.45, color: new THREE.Color(c.color), tint: new THREE.Color() };
    });

    // Tidal streams of stardust between clusters, tinted between their colours.
    const streams = world._streams.map((st) => {
      const pts = new THREE.Points(pointsGeo(st.pos, (k) => st.bright[k]), depthPoints(shared, { size: 0.9, max: 6, drift: 2.5, dof: 0.7 }));
      pts.material.uniforms.uColor.value.copy(new THREE.Color(world.clusters[st.from].color).lerp(new THREE.Color(world.clusters[st.to].color), 0.5)).multiplyScalar(0.8);
      root.add(pts);
      return pts;
    });

    // Word nodes: black (invisible under additive blending) until read.
    const nw = analysis.words.length;
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(world.wordPos, 3));
    const wcol = new THREE.BufferAttribute(new Float32Array(nw * 3), 3);
    wg.setAttribute('color', wcol);
    const words = new THREE.Points(wg, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    root.add(words);

    // Spider: real geometry throughout.
    const hairMat = new THREE.LineBasicMaterial({ color: '#9fffe0', transparent: true, opacity: 0.45 });
    const patMat = new THREE.LineBasicMaterial({ color: '#c9fff0', transparent: true, opacity: 0.85 });
    const skin = fresnel(0x020b0a, '#7dffd6');
    const rimMat = new THREE.MeshBasicMaterial({ color: SPIDER, side: THREE.BackSide });
    const wireMat = new THREE.LineBasicMaterial({ color: SPIDER, transparent: true, opacity: 0.42 });
    // Each body part: a shaped glassy shell, its rim, a fine surface grid, its pattern and a coat of setae.
    const part = (lat, lon, pattern, shape, hairs, seed) => {
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      const shell = shapeGeometry(new THREE.SphereGeometry(1, 48, 32), shape);
      const rim = new THREE.Mesh(shell, rimMat);
      rim.scale.setScalar(1.045);
      const wire = new THREE.LineSegments(shapeGeometry(latLong(lat, lon), shape), wireMat);
      wire.scale.setScalar(1.006);
      grp.add(new THREE.Mesh(shell, skin), rim, wire);
      grp.add(new THREE.LineSegments(shapeGeometry(pattern(), shape), patMat));
      grp.add(new THREE.LineSegments(bodyHairs(hairs, shape, seed), hairMat));
      return grp;
    };
    const abdomen = part(14, 28, chevrons, abdShape, 260, 4242);
    const ceph = part(8, 16, striae, cephShape, 110, 777);
    // Tapered limb segments (base radius 1, tip radius 0.6, spanning y 0..1) and ball joints.
    const limbGeo = new THREE.CylinderGeometry(0.6, 1, 1, 10, 1);
    limbGeo.translate(0, 0.5, 0);
    const limbs = new THREE.InstancedMesh(limbGeo, fresnel(0x020d0b, '#8affdd', 40), LIMBS);
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), fresnel(0x05201b, '#c4fff0', 20), JOINTS);
    limbs.frustumCulled = false;
    joints.frustumCulled = false;
    limbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const hairs = fatSegments(LEG_COUNT * HAIRS, SPIDER, 0.6, 0.55);
    // Eyes: eight glossy domes (two big anterior medians, six smaller), each with a catch-light.
    const eyeBalls = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), fresnel(0x010404, '#dcfff6', 6), 8);
    eyeBalls.frustumCulled = false;
    eyeBalls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const eyes = new THREE.Points(dynamicGeometry(2), new THREE.PointsMaterial({ color: '#ffffff', size: 2.2, sizeAttenuation: false, fog: false }));
    const eyesSmall = new THREE.Points(dynamicGeometry(6), new THREE.PointsMaterial({ color: '#e8fff9', size: 1.3, sizeAttenuation: false, fog: false }));
    const spinnerets = new THREE.Points(dynamicGeometry(3), new THREE.PointsMaterial({ color: SPIDER, size: 2, sizeAttenuation: false }));
    // The heart: a long pulsing vessel along the top of the abdomen, seen through the glassy body.
    const core = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: FLAG, depthTest: false, fog: false, transparent: true, opacity: 0.9 }));
    core.matrixAutoUpdate = false;
    core.renderOrder = 20;
    const tentacles = new THREE.Points(
      dynamicGeometry(MAX_TENTACLES * TENTACLE_DOTS),
      new THREE.PointsMaterial({ color: TENTACLE, size: 3, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false }),
    );
    tentacles.renderOrder = 15;
    const silk = new THREE.Line(dynamicGeometry(SILK_MAX, 3, 4), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    root.add(silk, tentacles, limbs, joints, hairs, spinnerets, abdomen, ceph, eyeBalls, eyes, eyesSmall, core);

    const fat = [hairs];
    W = { root, motes, mbase, mglow, clusters, streams, words, wcol, wordKey: '', world, abdomen, ceph, limbs, joints, hairs, eyeBalls, eyes, eyesSmall, spinnerets, core, tentacles, silk, fat, hairBuf: new Float32Array(LEG_COUNT * HAIRS * 6) };
    for (const l of fat) l.material.resolution.set(size.w, size.h);
  }

  /** World point -> stage CSS pixels. `out.vis` is false when behind the camera. */
  function project(x, y, z, out = {}) {
    tmp.set(x, y, z).project(camera);
    out.x = ((tmp.x + 1) / 2) * size.w;
    out.y = ((1 - tmp.y) / 2) * size.h;
    out.vis = tmp.z > -1 && tmp.z < 1;
    const p = camera.position;
    out.d = Math.hypot(x - p.x, y - p.y, z - p.z);
    return out;
  }

  let bank = 0;
  let lastYaw = null;
  function placeCamera(run, spider, c, t, dt) {
    const focus = spider.b;
    // A slow handheld drift so the view breathes even when the shot is still.
    const hy = 0.006 * Math.sin(t * 0.37) + 0.004 * Math.sin(t * 0.83 + 1.3);
    const hp = 0.004 * Math.sin(t * 0.49 + 0.7) + 0.003 * Math.sin(t * 0.97);
    const yaw = c.yaw + orbit.yaw + hy;
    const pitch = Math.max(-1.3, Math.min(1.4, c.pitch + orbit.pitch + hp));
    // The camera rides a landing's impact: a quick, damped bounce.
    const jolt = (spider.jolt || 0) * c.dist * 0.008;
    camera.position.set(c.x + c.dist * Math.cos(pitch) * Math.sin(yaw), c.y + c.dist * Math.sin(pitch) + jolt, c.z + c.dist * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(c.x, c.y + jolt * 0.4, c.z);
    // Banking into a sweep like a drone, a few degrees at most.
    if (dt > 1e-3) {
      const turn = lastYaw === null ? 0 : yaw - lastYaw;
      const rate = Math.atan2(Math.sin(turn), Math.cos(turn)) / dt;
      bank += (Math.max(-0.06, Math.min(0.06, -0.15 * rate)) - bank) * (1 - Math.exp(-2.5 * dt));
      lastYaw = yaw;
    }
    camera.rotateZ(bank);
    camera.updateMatrixWorld();
    fog.density = 0.45 / c.dist;
    shared.uFog.value = fog.density;
    // Focus pulls onto the spider, so the web in front and behind it softens.
    shared.uFocus.value = Math.max(80, camera.position.distanceTo(tmp.set(focus[0], focus[1], focus[2])));
    shared.uTime.value = t;
  }

  function setBody(grp, center, F, U, S, rx, ry, rz) {
    const m = grp.matrix;
    m.makeBasis(vA.set(...F), vB.set(...U), vS.set(...S));
    m.scale(tmp.set(rx, rz, ry));
    m.setPosition(center[0], center[1], center[2]);
    grp.matrixWorldNeedsUpdate = true;
  }

  /** Place one tapered limb segment from a to b with base radius r. */
  function limb(i, a, b, r) {
    vA.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const L = vA.length() || 1e-3;
    quat.setFromUnitVectors(upY, vA.divideScalar(L));
    mat4.compose(vB.set(a[0], a[1], a[2]), quat, vS.set(r, L, r));
    W.limbs.setMatrixAt(i, mat4);
  }

  function joint(i, p, r) {
    mat4.makeScale(r, r, r);
    mat4.setPosition(p[0], p[1], p[2]);
    W.joints.setMatrixAt(i, mat4);
  }

  /**
   * Render one frame.
   * @param {import('../core/contracts.js').RunState} run
   * @param {import('../core/contracts.js').Analysis} analysis
   * @param {import('./spider.js').Spider} spider
   * @param {number} dt real seconds since last frame (for crossfades)
   * @param {{camera:object, t:number}} [between] camera and clock as drawn between two sim steps
   */
  function render(run, analysis, spider, dt, between = null) {
    if (!W) return;
    const t = between ? between.t : run.t;
    placeCamera(run, spider, between ? between.camera : run.camera, t, dt);
    // Motes wrap round the camera, fading out near the box's faces so none pops.
    const mp = W.motes.geometry.attributes.position;
    const mb = W.motes.geometry.attributes.bright;
    const cp = camera.position;
    for (let i = 0; i < MOTES; i++) {
      let edge = 0;
      for (let j = 0; j < 3; j++) {
        const rel = (((W.mbase[i * 3 + j] - cp.getComponent(j)) % MOTE_BOX) + MOTE_BOX * 1.5) % MOTE_BOX - MOTE_BOX / 2;
        mp.array[i * 3 + j] = cp.getComponent(j) + rel;
        edge = Math.max(edge, Math.abs(rel) / (MOTE_BOX / 2));
      }
      mb.array[i] = W.mglow[i] * (1 - Math.max(0, Math.min(1, (edge - 0.6) / 0.4)));
    }
    mp.needsUpdate = true;
    mb.needsUpdate = true;
    shared.uLight.value.set(...spider.b);
    const ship = run.phase === 'ship';
    const fade = 1 - Math.exp(-4 * dt);

    W.clusters.forEach((cl, i) => {
      // The stars carry the light: the active cluster burns brightest, read ones stay lit.
      // Extra balls (no words) glow softly in their own colour throughout.
      const extra = i >= run.status.length;
      const on = extra || run.status[i] !== 'queued' ? 1 : 0;
      const gain = ship ? 0.8 : extra ? (run.visit && run.visit.cluster === i ? 1.0 : 0.5) : i === run.active ? 1.05 : on ? 0.72 : 0.34;
      cl.mix += (on - cl.mix) * fade;
      cl.gain += (gain - cl.gain) * fade;
      cl.tint.copy(grey).lerp(cl.color, cl.mix);
      for (const m of [cl.points.material, cl.stars.material]) {
        m.uniforms.uColor.value.copy(cl.tint);
        m.uniforms.uGain.value = cl.gain * (m === cl.points.material ? 1.85 : 1);
      }
      cl.lines.material.uniforms.uColor.value.copy(cl.tint);
      cl.lines.material.uniforms.uOpacity.value = (0.03 + 0.05 * cl.mix) * cl.gain;
    });

    // Word nodes recolour only when reading state changes.
    const key = `${run.counts.read}:${run.tentacles.length}:${run.active}`;
    if (key !== W.wordKey) {
      W.wordKey = key;
      const a = W.wcol.array;
      const c = new THREE.Color();
      for (let i = 0; i < analysis.words.length; i++) {
        const st = run.wordState[i];
        if (!st) {
          a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = 0;
          continue;
        }
        const w = analysis.words[i];
        c.set(w.vague && st === 2 ? FLAG : analysis.sections[w.section].color).multiplyScalar(st === 2 ? 1 : 0.5);
        a[i * 3] = c.r;
        a[i * 3 + 1] = c.g;
        a[i * 3 + 2] = c.b;
      }
      W.wcol.needsUpdate = true;
    }

    // Body parts: cephalothorax, and the abdomen hanging off the waist, breathing.
    const { F, U, S } = spider;
    const breath = 1 + 0.03 * Math.sin(spider.time * 2.1);
    const ab = spider.abdomenFrame();
    setBody(W.abdomen, ab.c, ab.F, ab.U, ab.S, ABDOMEN.RX * breath, ABDOMEN.RY * breath, ABDOMEN.RZ * breath);
    setBody(W.ceph, spider.cephCenter(), F, U, S, CEPH.RX, CEPH.RY, CEPH.RZ);
    // Heartbeat: a quick double pulse, then rest.
    const beat = spider.time * 1.6 - Math.floor(spider.time * 1.6);
    const pulse = 1 + 0.18 * (Math.exp(-((beat - 0.1) ** 2) / 0.002) + 0.6 * Math.exp(-((beat - 0.28) ** 2) / 0.002));
    setBody(W.core, add(add(ab.c, ab.U, ABDOMEN.RZ * 0.55), ab.F, ABDOMEN.RX * 0.12), ab.F, ab.U, ab.S, ABDOMEN.RX * 0.44, ABDOMEN.RY * 0.09 * pulse, ABDOMEN.RZ * 0.09 * pulse);

    // Legs: all seven segments (coxa, femur, patella, tibia, metatarsus, tarsus,
    // paired claws) as tapered 3D limbs with ball joints, and setae and spines.
    const hb = W.hairBuf;
    let hi = 0;
    const cc = spider.cephCenter();
    spider.legs.forEach((leg, i) => {
      const { hip, knee, ankle, tip } = leg;
      const coxa0 = lerp3(hip, cc, 0.32);
      const pat = lerp3(knee, ankle, 0.16);
      const tib = lerp3(knee, ankle, 0.6);
      let li = i * LEG_SEGS;
      // A real femur is bowed: bend its middle up and out a little.
      const fl = len3(sub(knee, hip));
      const out = norm(sub(hip, cc));
      const fmid = add(add(lerp3(hip, knee, 0.5), U, fl * 0.07), out, fl * 0.04);
      limb(li++, coxa0, hip, 2.4 * LR * SS);
      limb(li++, hip, fmid, 2.05 * LR * SS);
      limb(li++, fmid, knee, 1.75 * LR * SS);
      limb(li++, knee, pat, 1.55 * LR * SS);
      limb(li++, pat, tib, 1.36 * LR * SS);
      limb(li++, tib, ankle, 0.98 * LR * SS);
      limb(li++, ankle, tip, 0.66 * LR * SS);
      const td = norm(sub(tip, ankle));
      const side = norm(cross(td, U));
      for (const sg of [-1, 1]) limb(li++, tip, add(add(add(tip, td, 1.2 * SS), side, sg * 0.55 * SS), U, -0.7 * SS), 0.26 * SS);
      let ji = i * 6;
      joint(ji++, hip, 2.25 * LR * SS);
      joint(ji++, knee, 1.85 * LR * SS);
      joint(ji++, pat, 1.5 * LR * SS);
      joint(ji++, tib, 1.18 * LR * SS);
      joint(ji++, ankle, 0.92 * LR * SS);
      joint(ji++, tip, 0.55 * LR * SS);
      // Setae along femur, patella-tibia and metatarsus; every 7th a long, stiffer spine.
      // [from, to, radius, count, kind]: setae with a few spines, then the
      // scopula: a dense pad of short hairs under the metatarsus and tarsus.
      const groups = [
        [hip, knee, 1.95 * LR * SS, 16, 0],
        [knee, tib, 1.45 * LR * SS, 18, 0],
        [tib, ankle, 1.0 * LR * SS, 14, 1],
        [ankle, tip, 0.7 * LR * SS, 12, 1],
      ];
      let k = 0;
      for (const [a, c, rad, count, kind] of groups) {
        const dir = norm(sub(c, a));
        const sd = norm(cross(dir, U));
        for (let j = 0; j < count; j++, k++) {
          const t = 0.08 + (j / count) * 0.86;
          const p0 = add(a, sub(c, a), t);
          const around = (k * 2.39996) % (Math.PI * 2);
          // Setae all round (more on top); the scopula only underneath.
          const radial = kind
            ? norm(add(add([0, 0, 0], sd, Math.cos(around) * 0.6), U, -1))
            : norm(add(add([0, 0, 0], sd, Math.cos(around)), U, Math.abs(Math.sin(around)) + 0.25));
          const base = add(p0, radial, rad);
          const spine = !kind && k % 7 === 3;
          const tipDir = kind ? norm(add(radial, dir, 0.6)) : norm(add(radial, dir, spine ? -0.35 : -0.75));
          const lenH = kind ? 1.1 + 0.4 * ((k * 0.618) % 1) : spine ? 4.6 : 2.4 + 0.8 * ((k * 0.618) % 1);
          hb.set(base, hi);
          hb.set(add(base, tipDir, lenH * SS), hi + 3);
          hi += 6;
        }
      }
    });
    // The pedicel: the narrow waist joining cephalothorax and abdomen.
    let li = LEG_COUNT * LEG_SEGS;
    limb(li++, add(cc, F, -CEPH.RX * 0.8), add(ab.c, ab.F, ABDOMEN.RX * 0.88), 1.7 * SS);
    // Fangs (chelicerae) and two jointed palps at the face.
    const face = spider.face();
    // Chelicerae: a stout base, and a curved fang folding in under it, flexing a little.
    for (const sg of [-1, 1]) {
      const base = add(add(face, S, sg * 2.2 * SS), U, -1.0 * SS);
      const tipC = add(add(base, F, 2.4 * SS), U, -3.4 * SS);
      const flex = 0.25 + 0.2 * Math.sin(spider.time * 2.3 + (sg > 0 ? 0.9 : 0));
      limb(li++, base, tipC, 1.8 * SS);
      limb(li++, tipC, add(add(add(tipC, S, -sg * (1.3 + flex) * SS), U, -1.0 * SS), F, 0.5 * SS), 0.42 * SS);
    }
    for (const sg of [-1, 1]) {
      const tap = spider.palpTap ? spider.palpTap[sg > 0 ? 1 : 0] : Math.sin(spider.time * 3.1 + (sg > 0 ? 1.4 : 0)) * 0.35;
      const p0 = add(add(face, S, sg * 3.8 * SS), U, -0.5 * SS);
      const p1 = add(add(add(p0, F, 5 * SS), S, sg * 3.5 * SS), U, (3 + tap * 3) * SS);
      const p2 = add(add(add(p1, F, 6 * SS), S, sg * 1.5 * SS), U, (-2 + tap * 2) * SS);
      const p3 = add(add(p2, F, 4 * SS), U, -4 * SS);
      limb(li++, p0, p1, 1.15 * SS);
      limb(li++, p1, p2, 0.95 * SS);
      limb(li++, p2, p3, 0.75 * SS);
    }
    // Spinnerets: three pairs of short finger-like spigots at the tip of the abdomen.
    const spinTip = spider.spinneret();
    for (let q = 0; q < 3; q++) {
      for (const sg of [-1, 1]) {
        const b0 = add(add(spinTip, ab.S, sg * (0.5 + 0.45 * q) * SS), ab.U, (-0.6 - 0.5 * q) * SS);
        limb(li++, b0, add(add(add(b0, ab.F, -(1.6 - 0.3 * q) * SS), ab.S, sg * 0.5 * SS), ab.U, -0.4 * SS), (0.55 - 0.1 * q) * SS);
      }
    }
    W.limbs.instanceMatrix.needsUpdate = true;
    W.joints.instanceMatrix.needsUpdate = true;
    writeSegments(W.hairs, hb);

    // Eight eyes in two rows on the front of the cephalothorax: two big anterior median eyes.
    const eyeAt = (sx, up) => add(add(add(face, S, sx * SS), U, (up - 2.5) * SS), F, -1.5 * SS);
    const glint = (p, r) => add(add(p, F, r * 0.55), U, r * 0.45);
    const ep = W.eyes.geometry.attributes.position.array;
    const es = W.eyesSmall.geometry.attributes.position.array;
    const eyeDefs = [[-1.5, 4.0, 0.95], [1.5, 4.0, 0.95], [-3.6, 3.4, 0.55], [3.6, 3.4, 0.55], [-2.4, 5.8, 0.45], [2.4, 5.8, 0.45], [-4.6, 4.9, 0.5], [4.6, 4.9, 0.5]];
    eyeDefs.forEach(([sx, up, er], k) => {
      const pe = eyeAt(sx, up);
      const r = er * SS;
      mat4.makeScale(r, r, r);
      mat4.setPosition(pe[0], pe[1], pe[2]);
      W.eyeBalls.setMatrixAt(k, mat4);
      if (k < 2) ep.set(glint(pe, r), k * 3);
      else es.set(glint(pe, r), (k - 2) * 3);
    });
    W.eyeBalls.instanceMatrix.needsUpdate = true;
    for (const e of [W.eyes, W.eyesSmall]) {
      e.geometry.attributes.position.needsUpdate = true;
      e.geometry.computeBoundingSphere();
    }
    const spin = spider.spinneret();
    const sp3 = W.spinnerets.geometry.attributes.position.array;
    for (let k = 0; k < 3; k++) sp3.set(add(add(spin, ab.S, (k - 1) * 2.2 * SS), ab.U, -1.5 * SS), k * 3);
    W.spinnerets.geometry.attributes.position.needsUpdate = true;
    W.spinnerets.geometry.computeBoundingSphere();

    // Tentacles: dotted beziers to the words, rippling like tendrils.
    const tp = W.tentacles.geometry.attributes.position.array;
    let dots = 0;
    const wp = W.world.wordPos;
    const p = spider.cephCenter();
    for (const tn of run.tentacles) {
      const tx = wp[tn.wordId * 3];
      const ty = wp[tn.wordId * 3 + 1];
      const tz = wp[tn.wordId * 3 + 2];
      const dx = tx - p[0];
      const dy = ty - p[1];
      const dz = tz - p[2];
      const L = Math.hypot(dx, dy, dz) || 1;
      const dir = [dx / L, dy / L, dz / L];
      const side = norm(cross(dir, U));
      const o0 = add(p, dir, 12 * SS);
      const bow = (tn.wordId % 2 ? 0.2 : 0.12) * L;
      const ctl = add([(o0[0] + tx) / 2, (o0[1] + ty) / 2, (o0[2] + tz) / 2], U, bow);
      const n = Math.min(TENTACLE_DOTS - 1, Math.max(2, Math.floor(L / 6)));
      const m = Math.floor(n * tn.p);
      const wt = t * 7 + tn.wordId;
      for (let i = 0; i <= m && dots < MAX_TENTACLES * TENTACLE_DOTS; i++) {
        const u = i / n;
        const v = 1 - u;
        const amp = Math.sin(Math.PI * u) * Math.min(6, L * 0.04);
        const wave = Math.sin(wt - u * 9) * amp;
        tp[dots * 3] = v * v * o0[0] + 2 * v * u * ctl[0] + u * u * tx + side[0] * wave;
        tp[dots * 3 + 1] = v * v * o0[1] + 2 * v * u * ctl[1] + u * u * ty + side[1] * wave;
        tp[dots * 3 + 2] = v * v * o0[2] + 2 * v * u * ctl[2] + u * u * tz + side[2] * wave;
        dots++;
      }
    }
    W.tentacles.geometry.setDrawRange(0, dots);
    W.tentacles.geometry.attributes.position.needsUpdate = true;
    W.tentacles.geometry.computeBoundingSphere();

    // Silk: sagging strands between anchors, older ones fading; the live dragline sways.
    const sp = W.silk.geometry.attributes.position.array;
    const sc = W.silk.geometry.attributes.color.array;
    const anchors = run.silk.slice(-Math.floor((SILK_MAX - 24) / SILK_SUB));
    let vi = 0;
    const col = new THREE.Color();
    const pushV = (x, y, z, s, a) => {
      sp[vi * 3] = x;
      sp[vi * 3 + 1] = y;
      sp[vi * 3 + 2] = z;
      col.set(analysis.sections[s]?.color ?? SPIDER);
      sc[vi * 4] = col.r;
      sc[vi * 4 + 1] = col.g;
      sc[vi * 4 + 2] = col.b;
      sc[vi * 4 + 3] = a;
      vi++;
    };
    const strand = (a, b2, s, alpha, subs, swayAmp, sagK = 0.06) => {
      const L = Math.hypot(b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]);
      for (let k = 1; k <= subs; k++) {
        const u = k / subs;
        const sag = Math.sin(Math.PI * u) * L * sagK;
        const sw = Math.sin(Math.PI * u) * swayAmp;
        pushV(a[0] + (b2[0] - a[0]) * u + sw, a[1] + (b2[1] - a[1]) * u - sag, a[2] + (b2[2] - a[2]) * u + sw * 0.6, s, alpha);
      }
    };
    if (anchors.length) {
      const nA = anchors.length;
      pushV(anchors[0].x, anchors[0].y, anchors[0].z, anchors[0].s, 0.1);
      for (let i = 1; i < nA; i++) {
        const a = anchors[i - 1];
        const c = anchors[i];
        strand([a.x, a.y, a.z], [c.x, c.y, c.z], c.s, 0.1 + 0.62 * (i / nA) ** 0.7, SILK_SUB, 0);
      }
      const last = anchors[nA - 1];
      // The live dragline: slack and swaying at rest, pulled near straight by a leap.
      const taut = spider.taut || 0;
      strand([last.x, last.y, last.z], spin, run.silkSection, 0.85, 20, Math.sin(t * 1.3) * 3 * (1 - taut), 0.06 * (1 - 0.8 * taut));
    }
    W.silk.geometry.setDrawRange(0, vi);
    W.silk.geometry.attributes.position.needsUpdate = true;
    W.silk.geometry.attributes.color.needsUpdate = true;
    W.silk.geometry.computeBoundingSphere();

    composer.render();
  }

  return { resize, setWorld, render, project, orbit, camera };
}
