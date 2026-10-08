/**
 * WebGL renderer (three.js) for the crawl.
 *
 * Environment: per section, real orb webs whose silk carries its own light
 * (shimmering threads, glittering dew drops), hanging in a nebula of soft
 * particles with depth of field, twinkle and drift; anchor lines and bridges
 * of silk between webs; floating dust for parallax. The web brightens around
 * the spider as it moves through it. No glow sprites: light lives on the silk.
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
import { BG, QUEUED, FLAG, SPIDER, TENTACLE } from '../core/theme.js';
import { LEG_COUNT, MAX_TENTACLES } from '../core/contracts.js';
import { ABDOMEN, CEPH } from './spider.js';

export const FOV = 50;
const TENTACLE_DOTS = 200;
const SILK_SUB = 5;
const SILK_MAX = 520 * SILK_SUB + 24;
const HAIRS = 10;
const LIMBS = LEG_COUNT * 3 + 2 + 6; // legs, fangs, palps
const JOINTS = LEG_COUNT * 4;
const WHITE = new THREE.Color(1, 1, 1);

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

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
function chevrons() {
  const v = [];
  const surf = (x, z) => [x, Math.sqrt(Math.max(0, 1 - x * x - z * z)) * 1.012, z];
  const seg = (a, b) => v.push(...a, ...b);
  for (let c = 0; c < 5; c++) {
    const x0 = 0.55 - c * 0.26;
    const w = 0.42 - c * 0.06;
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
    },
    vertexShader: `
      attribute float bright;
      attribute float phase;
      uniform float uSize, uMax, uScale, uFog, uTime, uFocus, uDpr, uDrift, uDof, uGain, uLightR, uLightGain;
      uniform vec3 uLight;
      varying float vA;
      varying float vBlur;
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
        float fz = uFog * depth;
        vA = bright * tw * energy * lit * exp(-fz * fz);
        vBlur = clamp(blur, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vA;
      varying float vBlur;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float sharp = smoothstep(0.5, 0.06, d);
        float disc = smoothstep(0.5, 0.4, d) * (0.55 + 0.45 * smoothstep(0.15, 0.45, d));
        gl_FragColor = vec4(uColor * vA * mix(sharp, disc, vBlur), 1.0);
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
        vec3 c = mix(uCore * (0.8 + 0.4 * band), uRim, f * 0.92);
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
    uLightGain: { value: 0.9 },
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
    const pointsGeo = (pos, brightFn) => {
      const n = pos.length / 3;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('bright', new THREE.BufferAttribute(Float32Array.from({ length: n }, (_, i) => brightFn(i)), 1));
      g.setAttribute('phase', new THREE.BufferAttribute(Float32Array.from({ length: n }, () => rnd()), 1));
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
    const dm = depthPoints(shared, { size: 1.1, max: 16, drift: 7, dof: 1.3 });
    dm.uniforms.uColor.value.set('#8fa0c8');
    root.add(new THREE.Points(pointsGeo(dpos, () => 0.05 + 0.15 * rnd()), dm));

    const clusters = world.clusters.map((c, i) => {
      const cloud = world._clouds[i];
      // Nebula particles around the webs.
      const points = new THREE.Points(pointsGeo(cloud.pos, (k) => Math.min(1, cloud.bright[k]) * 0.8), depthPoints(shared, { size: 1.0, max: 8, drift: 1.6, dof: 0.45 }));
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', points.geometry.getAttribute('position'));
      eg.setIndex(new THREE.BufferAttribute(cloud.edges, 1));
      const lines = new THREE.LineSegments(eg, silkMaterial(shared));
      // The orb webs themselves, and their anchor lines.
      const webArr = new Float32Array(cloud.webs.reduce((n, w) => n + w.segs.length, 0));
      let o = 0;
      for (const w of cloud.webs) {
        webArr.set(w.segs, o);
        o += w.segs.length;
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(webArr, 3));
      const web = new THREE.LineSegments(wg, silkMaterial(shared));
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(cloud.threads, 3));
      const threads = new THREE.LineSegments(tg, silkMaterial(shared));
      // Dew caught on the spiral: tiny glittering beads.
      const dewArr = new Float32Array(cloud.webs.reduce((n, w) => n + w.dew.length, 0));
      o = 0;
      for (const w of cloud.webs) {
        dewArr.set(w.dew, o);
        o += w.dew.length;
      }
      const dew = new THREE.Points(pointsGeo(dewArr, () => 0.7 + 0.3 * rnd()), depthPoints(shared, { size: 1.9, max: 7, drift: 0.25, dof: 0.6 }));
      root.add(lines, threads, web, points, dew);
      return { points, lines, web, threads, dew, mix: 0, gain: 0.45, color: new THREE.Color(c.color), tint: new THREE.Color() };
    });

    // Bridges: silk strung between neighbouring webs.
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(world._bridges, 3));
    const bridges = new THREE.LineSegments(bg, silkMaterial(shared));
    bridges.material.uniforms.uColor.value.set('#b9c6e6');
    bridges.material.uniforms.uOpacity.value = 0.2;
    root.add(bridges);

    // Word nodes: black (invisible under additive blending) until read.
    const nw = analysis.words.length;
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(world.wordPos, 3));
    const wcol = new THREE.BufferAttribute(new Float32Array(nw * 3), 3);
    wg.setAttribute('color', wcol);
    const words = new THREE.Points(wg, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    root.add(words);

    // Spider: real geometry throughout.
    const sphere = new THREE.SphereGeometry(1, 40, 24);
    const skin = fresnel(0x020b0a, '#7dffd6');
    const rimMat = new THREE.MeshBasicMaterial({ color: SPIDER, side: THREE.BackSide });
    const wireMat = new THREE.LineBasicMaterial({ color: SPIDER, transparent: true, opacity: 0.7 });
    const part = (lat, lon, pattern) => {
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      const rim = new THREE.Mesh(sphere, rimMat);
      rim.scale.setScalar(1.045);
      const wire = new THREE.LineSegments(latLong(lat, lon), wireMat);
      wire.scale.setScalar(1.006);
      grp.add(new THREE.Mesh(sphere, skin), rim, wire);
      if (pattern) grp.add(new THREE.LineSegments(chevrons(), new THREE.LineBasicMaterial({ color: '#c9fff0', transparent: true, opacity: 0.85 })));
      return grp;
    };
    const abdomen = part(9, 18, true);
    const ceph = part(5, 10, false);
    // Tapered limb segments (base radius 1, tip radius 0.6, spanning y 0..1) and ball joints.
    const limbGeo = new THREE.CylinderGeometry(0.6, 1, 1, 10, 1);
    limbGeo.translate(0, 0.5, 0);
    const limbs = new THREE.InstancedMesh(limbGeo, fresnel(0x020d0b, '#8affdd', 40), LIMBS);
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), fresnel(0x05201b, '#c4fff0', 20), JOINTS);
    limbs.frustumCulled = false;
    joints.frustumCulled = false;
    limbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const hairs = fatSegments(LEG_COUNT * HAIRS, SPIDER, 0.8, 0.55);
    const eyes = new THREE.Points(dynamicGeometry(8), new THREE.PointsMaterial({ color: '#eafff8', size: 3.2, sizeAttenuation: false, fog: false }));
    const spinnerets = new THREE.Points(dynamicGeometry(3), new THREE.PointsMaterial({ color: SPIDER, size: 3, sizeAttenuation: false }));
    const core = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 7), new THREE.MeshBasicMaterial({ color: FLAG, depthTest: false, fog: false }));
    core.renderOrder = 20;
    const tentacles = new THREE.Points(
      dynamicGeometry(MAX_TENTACLES * TENTACLE_DOTS),
      new THREE.PointsMaterial({ color: TENTACLE, size: 3, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false }),
    );
    tentacles.renderOrder = 15;
    const silk = new THREE.Line(dynamicGeometry(SILK_MAX, 3, 4), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    root.add(silk, tentacles, limbs, joints, hairs, spinnerets, abdomen, ceph, eyes, core);

    const fat = [hairs];
    W = { root, clusters, words, wcol, wordKey: '', world, abdomen, ceph, limbs, joints, hairs, eyes, spinnerets, core, tentacles, silk, fat, hairBuf: new Float32Array(LEG_COUNT * HAIRS * 6) };
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

  function placeCamera(run, focus) {
    const c = run.camera;
    const t = run.t;
    // A slow handheld drift so the view breathes even when the shot is still.
    const hy = 0.006 * Math.sin(t * 0.37) + 0.004 * Math.sin(t * 0.83 + 1.3);
    const hp = 0.004 * Math.sin(t * 0.49 + 0.7) + 0.003 * Math.sin(t * 0.97);
    const yaw = c.yaw + orbit.yaw + hy;
    const pitch = Math.max(-1.3, Math.min(1.4, c.pitch + orbit.pitch + hp));
    camera.position.set(c.x + c.dist * Math.cos(pitch) * Math.sin(yaw), c.y + c.dist * Math.sin(pitch), c.z + c.dist * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(c.x, c.y, c.z);
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
   */
  function render(run, analysis, spider, dt) {
    if (!W) return;
    placeCamera(run, spider.b);
    shared.uLight.value.set(...spider.b);
    const ship = run.phase === 'ship';
    const fade = 1 - Math.exp(-4 * dt);

    W.clusters.forEach((cl, i) => {
      // The web carries the light: the active web burns brightest, read webs stay lit.
      const on = run.status[i] !== 'queued' ? 1 : 0;
      const gain = ship ? 0.8 : i === run.active ? 1.35 : on ? 0.85 : 0.4;
      cl.mix += (on - cl.mix) * fade;
      cl.gain += (gain - cl.gain) * fade;
      cl.tint.copy(grey).lerp(cl.color, cl.mix);
      for (const m of [cl.points.material, cl.dew.material]) {
        m.uniforms.uColor.value.copy(cl.tint);
        m.uniforms.uGain.value = cl.gain;
      }
      cl.dew.material.uniforms.uColor.value.lerp(WHITE, 0.45);
      cl.lines.material.uniforms.uColor.value.copy(cl.tint);
      cl.lines.material.uniforms.uOpacity.value = (0.05 + 0.07 * cl.mix) * cl.gain;
      cl.web.material.uniforms.uColor.value.copy(cl.tint);
      cl.web.material.uniforms.uOpacity.value = (0.12 + 0.17 * cl.mix) * cl.gain;
      cl.threads.material.uniforms.uColor.value.copy(cl.tint);
      cl.threads.material.uniforms.uOpacity.value = (0.12 + 0.14 * cl.mix) * cl.gain;
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
    W.core.position.set(...add(ab.c, ab.U, 3));
    W.core.rotation.set(spider.time * 1.1, spider.time * 0.8, spider.time * 0.35);

    // Legs as tapered 3D segments with ball joints; hairs along femur and tibia.
    const hb = W.hairBuf;
    let hi = 0;
    spider.legs.forEach((leg, i) => {
      limb(i * 3, leg.hip, leg.knee, 1.9);
      limb(i * 3 + 1, leg.knee, leg.ankle, 1.35);
      limb(i * 3 + 2, leg.ankle, leg.tip, 0.85);
      joint(i * 4, leg.hip, 2.1);
      joint(i * 4 + 1, leg.knee, 1.75);
      joint(i * 4 + 2, leg.ankle, 1.25);
      joint(i * 4 + 3, leg.tip, 0.7);
      const segs = [
        [leg.hip, leg.knee, 1.8],
        [leg.knee, leg.ankle, 1.3],
      ];
      for (let k = 0; k < HAIRS; k++) {
        const [a, c, rad] = segs[k < HAIRS / 2 ? 0 : 1];
        const t = 0.12 + ((k % (HAIRS / 2)) / (HAIRS / 2)) * 0.8;
        const dir = norm(sub(c, a));
        const p0 = add(a, sub(c, a), t);
        const around = (k * 2.4) % (Math.PI * 2);
        const side = norm(cross(dir, U));
        const radial = norm(add(add([0, 0, 0], side, Math.cos(around)), U, Math.abs(Math.sin(around)) + 0.3));
        const base = add(p0, radial, rad);
        // Hairs lean back toward the body, like setae.
        const tipDir = norm(add(radial, dir, -0.7));
        hb.set(base, hi);
        hb.set(add(base, tipDir, 3.6), hi + 3);
        hi += 6;
      }
    });
    // Fangs (chelicerae) and two jointed palps at the face.
    const face = spider.face();
    let li = LEG_COUNT * 3;
    for (const sg of [-1, 1]) {
      const base = add(add(face, S, sg * 2.4), U, -1.5);
      limb(li++, base, add(add(base, F, 4), U, -5), 1.5);
    }
    for (const sg of [-1, 1]) {
      const tap = Math.sin(spider.time * 3.1 + (sg > 0 ? 1.4 : 0)) * 0.35;
      const p0 = add(add(face, S, sg * 3.8), U, -0.5);
      const p1 = add(add(add(p0, F, 5), S, sg * 3.5), U, 3 + tap * 3);
      const p2 = add(add(add(p1, F, 6), S, sg * 1.5), U, -2 + tap * 2);
      const p3 = add(add(p2, F, 4), U, -4);
      limb(li++, p0, p1, 1.15);
      limb(li++, p1, p2, 0.95);
      limb(li++, p2, p3, 0.75);
    }
    W.limbs.instanceMatrix.needsUpdate = true;
    W.joints.instanceMatrix.needsUpdate = true;
    writeSegments(W.hairs, hb);

    // Eight eyes in two rows on the front of the cephalothorax.
    const ep = W.eyes.geometry.attributes.position.array;
    const eyes = [
      [-1.6, 4.2], [1.6, 4.2], [-3.6, 3.4], [3.6, 3.4],
      [-2.4, 5.6], [2.4, 5.6], [-4.6, 4.8], [4.6, 4.8],
    ];
    eyes.forEach(([sx, up], k) => ep.set(add(add(add(face, S, sx), U, up - 2.5), F, -1.5), k * 3));
    W.eyes.geometry.attributes.position.needsUpdate = true;
    W.eyes.geometry.computeBoundingSphere();
    const spin = spider.spinneret();
    const sp3 = W.spinnerets.geometry.attributes.position.array;
    for (let k = 0; k < 3; k++) sp3.set(add(add(spin, ab.S, (k - 1) * 2.2), ab.U, -1.5), k * 3);
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
      const o0 = add(p, dir, 12);
      const bow = (tn.wordId % 2 ? 0.2 : 0.12) * L;
      const ctl = add([(o0[0] + tx) / 2, (o0[1] + ty) / 2, (o0[2] + tz) / 2], U, bow);
      const n = Math.min(TENTACLE_DOTS - 1, Math.max(2, Math.floor(L / 6)));
      const m = Math.floor(n * tn.p);
      const wt = run.t * 7 + tn.wordId;
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
    const strand = (a, b2, s, alpha, subs, swayAmp) => {
      const L = Math.hypot(b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]);
      for (let k = 1; k <= subs; k++) {
        const u = k / subs;
        const sag = Math.sin(Math.PI * u) * L * 0.06;
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
      strand([last.x, last.y, last.z], spin, run.silkSection, 0.85, 20, Math.sin(run.t * 1.3) * 3);
    }
    W.silk.geometry.setDrawRange(0, vi);
    W.silk.geometry.attributes.position.needsUpdate = true;
    W.silk.geometry.attributes.color.needsUpdate = true;
    W.silk.geometry.computeBoundingSphere();

    composer.render();
  }

  return { resize, setWorld, render, project, orbit, camera };
}
