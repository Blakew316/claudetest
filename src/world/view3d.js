/**
 * WebGL renderer (three.js) for the crawl.
 *
 * Scene: volumetric webs (soft particles with depth of field, twinkle and a
 * slow drift; shimmering constellation strands; glows), a field of floating
 * dust for parallax, the word nodes, and the spider in detail (fresnel-shaded
 * cephalothorax and breathing abdomen with wire mesh, tumbling core, 16
 * three-segment legs with joints and bristles, eight eyes, fangs, palps,
 * spinnerets), its rippling dotted tentacles and sagging silk. Rendered
 * through a perspective camera from run.camera (plus a slow handheld drift
 * and the viewer's drag) with a bloom pass. Reads run state only.
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
const BRISTLES = 6;

const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.32)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
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
 * Soft particles with depth of field: in focus they are crisp pinpoints; in
 * front of or behind the focal distance they swell into faint bokeh discs.
 * They twinkle and drift slowly, like dust in air. Needs 'bright' and
 * 'phase' attributes. Shared uniforms (time, fog, focus, scale, dpr) come in
 * by reference.
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
    },
    vertexShader: `
      attribute float bright;
      attribute float phase;
      uniform float uSize, uMax, uScale, uFog, uTime, uFocus, uDpr, uDrift, uDof;
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
        float blur = uDof * clamp(abs(depth - uFocus) / uFocus - 0.18, 0.0, 1.3);
        float grow = 1.0 + blur * 4.0;
        gl_PointSize = clamp(px * grow, 1.0, uMax * uDpr);
        float tw = 0.76 + 0.24 * sin(uTime * (0.7 + phase * 1.9) + phase * 31.0);
        // A blurred point spreads the same light over a bigger disc, so it dims.
        float energy = min(1.0, px) / pow(grow, 1.6);
        vA = bright * tw * energy * exp(-pow(uFog * depth, 2.0));
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

/** Web strands with a slow shimmer travelling through them. */
function strandMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.2 } },
    vertexShader: `
      uniform float uTime, uFog;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sh = 0.5 + 0.5 * sin(uTime * 1.1 + dot(position, vec3(0.041, 0.029, 0.035)));
        vA = (0.45 + 0.55 * sh * sh) * exp(-pow(uFog * -mv.z, 2.0));
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

/** Glassy shading: dark core, bright toward the silhouette (fresnel), faint banding. */
function fresnel(core, rim) {
  return new THREE.ShaderMaterial({
    uniforms: { uCore: { value: new THREE.Color(core) }, uRim: { value: new THREE.Color(rim) } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uCore; uniform vec3 uRim;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
        float band = 0.5 + 0.5 * sin(vP.x * 9.0);
        vec3 c = mix(uCore * (0.85 + 0.3 * band), uRim, f * 0.9);
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
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.38, 0.3);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const glowTex = glowTexture();
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
  };
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
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    let seed = 1234567;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    // Floating dust through the whole space: parallax and foreground bokeh.
    const b = world.bounds;
    const DUST = 5000;
    const dpos = new Float32Array(DUST * 3);
    const dbr = new Float32Array(DUST);
    const dph = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const rr = b.radius * 2.4 * Math.cbrt(rnd());
      const sq = Math.sqrt(1 - u * u);
      dpos[i * 3] = b.x + rr * sq * Math.cos(th);
      dpos[i * 3 + 1] = b.y + rr * u * 0.6;
      dpos[i * 3 + 2] = b.z + rr * sq * Math.sin(th);
      dbr[i] = 0.05 + 0.15 * rnd();
      dph[i] = rnd();
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    dg.setAttribute('bright', new THREE.BufferAttribute(dbr, 1));
    dg.setAttribute('phase', new THREE.BufferAttribute(dph, 1));
    const dm = depthPoints(shared, { size: 1.1, max: 16, drift: 7, dof: 1.3 });
    dm.uniforms.uColor.value.set('#8fa0c8');
    root.add(new THREE.Points(dg, dm));

    const clusters = world.clusters.map((c, i) => {
      const cloud = world._clouds[i];
      const n = cloud.pos.length / 3;
      const bright = new Float32Array(n);
      const phase = new Float32Array(n);
      const stars = [];
      const starPh = [];
      for (let k = 0; k < n; k++) {
        bright[k] = Math.min(1, cloud.bright[k]);
        phase[k] = rnd();
        if (cloud.bright[k] > 1.2) {
          stars.push(cloud.pos[k * 3], cloud.pos[k * 3 + 1], cloud.pos[k * 3 + 2]);
          starPh.push(phase[k]);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
      g.setAttribute('bright', new THREE.BufferAttribute(bright, 1));
      g.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
      const points = new THREE.Points(g, depthPoints(shared, { size: 1.0, max: 8, drift: 1.6, dof: 0.45 }));
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', g.getAttribute('position'));
      eg.setIndex(new THREE.BufferAttribute(cloud.edges, 1));
      const lines = new THREE.LineSegments(eg, strandMaterial(shared));
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
      sg.setAttribute('bright', new THREE.Float32BufferAttribute(stars.map(() => 1).slice(0, starPh.length), 1));
      sg.setAttribute('phase', new THREE.Float32BufferAttribute(starPh, 1));
      const starPts = new THREE.Points(sg, depthPoints(shared, { size: 2.1, max: 14, drift: 1.2, dof: 0.6 }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, opacity: 0, fog: false, ...additive }));
      glow.position.set(c.cx, c.cy, c.cz);
      glow.scale.setScalar(c.r * 2.6);
      root.add(lines, points, starPts, glow);
      return { points, lines, stars: starPts, glow, mix: 0, glowA: 0, color: new THREE.Color(c.color), tint: new THREE.Color() };
    });

    // Word nodes: black (invisible under additive blending) until read.
    const nw = analysis.words.length;
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(world.wordPos, 3));
    const wcol = new THREE.BufferAttribute(new Float32Array(nw * 3), 3);
    wg.setAttribute('color', wcol);
    const words = new THREE.Points(wg, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, ...additive }));
    root.add(words);

    // Spider.
    const sphere = new THREE.SphereGeometry(1, 40, 24);
    const skin = fresnel(0x041714, SPIDER);
    const rimMat = new THREE.MeshBasicMaterial({ color: SPIDER, side: THREE.BackSide });
    const wireMat = new THREE.LineBasicMaterial({ color: SPIDER, transparent: true, opacity: 0.75 });
    const part = (lat, lon) => {
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      const fill = new THREE.Mesh(sphere, skin);
      const rim = new THREE.Mesh(sphere, rimMat);
      rim.scale.setScalar(1.05);
      const wire = new THREE.LineSegments(latLong(lat, lon), wireMat);
      wire.scale.setScalar(1.006);
      grp.add(fill, rim, wire);
      return grp;
    };
    const abdomen = part(9, 18);
    const ceph = part(5, 10);
    const legsThick = fatSegments(LEG_COUNT * 2 + 1, SPIDER, 2.1);
    const legsThin = fatSegments(LEG_COUNT + 4, SPIDER, 1.3);
    const bristles = fatSegments(LEG_COUNT * BRISTLES, SPIDER, 0.9, 0.55);
    const palps = fatSegments(2 * 10, SPIDER, 1.3);
    const joints = new THREE.Points(dynamicGeometry(LEG_COUNT * 4 + 3), new THREE.PointsMaterial({ color: SPIDER, size: 3.4, sizeAttenuation: false }));
    const eyes = new THREE.Points(dynamicGeometry(8), new THREE.PointsMaterial({ color: '#eafff8', size: 3.2, sizeAttenuation: false, fog: false }));
    const core = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 8), new THREE.MeshBasicMaterial({ color: FLAG, depthTest: false, fog: false }));
    core.renderOrder = 20;
    const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: FLAG, opacity: 0.6, fog: false, ...additive, depthTest: false }));
    coreGlow.scale.setScalar(30);
    coreGlow.renderOrder = 19;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: SPIDER, opacity: 0.14, fog: false, ...additive }));
    halo.scale.setScalar(170);
    const tentacles = new THREE.Points(
      dynamicGeometry(MAX_TENTACLES * TENTACLE_DOTS),
      new THREE.PointsMaterial({ color: TENTACLE, size: 3, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false }),
    );
    tentacles.renderOrder = 15;
    const silk = new THREE.Line(dynamicGeometry(SILK_MAX, 3, 4), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    root.add(halo, silk, tentacles, legsThick, legsThin, bristles, palps, joints, abdomen, ceph, eyes, coreGlow, core);

    const fat = [legsThick, legsThin, bristles, palps];
    W = {
      root, clusters, words, wcol, wordKey: '', world, analysis, abdomen, ceph, legsThick, legsThin, bristles, palps, joints, eyes, core, coreGlow, halo, tentacles, silk, fat,
      thickBuf: new Float32Array((LEG_COUNT * 2 + 1) * 6),
      thinBuf: new Float32Array((LEG_COUNT + 4) * 6),
      bristleBuf: new Float32Array(LEG_COUNT * BRISTLES * 6),
      palpBuf: new Float32Array(20 * 6),
    };
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

  function placeCamera(run) {
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
    shared.uFocus.value = c.dist;
    shared.uTime.value = t;
  }

  function setBody(grp, center, F, U, S, rx, ry, rz) {
    const m = grp.matrix;
    m.makeBasis(new THREE.Vector3(...F), new THREE.Vector3(...U), new THREE.Vector3(...S));
    m.scale(tmp.set(rx, rz, ry));
    m.setPosition(center[0], center[1], center[2]);
    grp.matrixWorldNeedsUpdate = true;
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
    placeCamera(run);
    const ship = run.phase === 'ship';
    const fade = 1 - Math.exp(-4 * dt);

    W.clusters.forEach((cl, i) => {
      const on = run.status[i] !== 'queued' ? 1 : 0;
      const glow = ship ? 0.06 : i === run.active ? 0.16 : on ? 0.04 : 0;
      cl.mix += (on - cl.mix) * fade;
      cl.glowA += (glow - cl.glowA) * fade;
      cl.tint.copy(grey).lerp(cl.color, cl.mix);
      cl.points.material.uniforms.uColor.value.copy(cl.tint);
      cl.stars.material.uniforms.uColor.value.copy(cl.tint);
      cl.lines.material.uniforms.uColor.value.copy(cl.tint);
      cl.lines.material.uniforms.uOpacity.value = 0.1 + 0.14 * cl.mix;
      cl.glow.material.color.copy(cl.color);
      cl.glow.material.opacity = cl.glowA;
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

    // Body: cephalothorax and a slowly breathing abdomen.
    const { F, U, S } = spider;
    const breath = 1 + 0.03 * Math.sin(spider.time * 2.1);
    const ac = spider.abdomenCenter();
    const cc = spider.cephCenter();
    setBody(W.abdomen, ac, F, U, S, ABDOMEN.RX * breath, ABDOMEN.RY * breath, ABDOMEN.RZ * breath);
    setBody(W.ceph, cc, F, U, S, CEPH.RX, CEPH.RY, CEPH.RZ);
    const corePos = add(ac, U, 3);
    W.core.position.set(...corePos);
    W.core.rotation.set(spider.time * 1.1, spider.time * 0.8, spider.time * 0.35);
    W.coreGlow.position.copy(W.core.position);
    W.halo.position.set(...spider.p);

    // Legs: femur and tibia thick, tarsus thin; joints; bristles along femur and tibia.
    const tb = W.thickBuf;
    const nb = W.thinBuf;
    const bb = W.bristleBuf;
    const jp = W.joints.geometry.attributes.position.array;
    let bi = 0;
    spider.legs.forEach((leg, i) => {
      tb.set(leg.hip, i * 12);
      tb.set(leg.knee, i * 12 + 3);
      tb.set(leg.knee, i * 12 + 6);
      tb.set(leg.ankle, i * 12 + 9);
      nb.set(leg.ankle, i * 6);
      nb.set(leg.tip, i * 6 + 3);
      jp.set(leg.hip, i * 12);
      jp.set(leg.knee, i * 12 + 3);
      jp.set(leg.ankle, i * 12 + 6);
      jp.set(leg.tip, i * 12 + 9);
      const segs = [
        [leg.hip, leg.knee],
        [leg.knee, leg.ankle],
      ];
      for (let k = 0; k < BRISTLES; k++) {
        const [a, c] = segs[k < 3 ? 0 : 1];
        const t = 0.25 + (k % 3) * 0.25;
        const p = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
        const dir = norm([c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        const side = norm(cross(dir, U));
        const sg = k % 2 ? 1 : -1;
        const out = norm(add(add(side, U, 0.8), dir, 0.5 * sg));
        bb.set(p, bi);
        bb.set(add(p, out, 3.2), bi + 3);
        bi += 6;
      }
    });
    // Waist joining the two body parts.
    const waistA = add(spider.p, F, CEPH.OFF - CEPH.RX * 0.9);
    const waistB = add(spider.p, F, ABDOMEN.OFF + ABDOMEN.RX * 0.9);
    tb.set(waistA, LEG_COUNT * 12);
    tb.set(waistB, LEG_COUNT * 12 + 3);
    // Fangs: two short chelicerae under the face.
    const face = spider.face();
    let ni = LEG_COUNT * 6;
    for (const sg of [-1, 1]) {
      const base = add(add(face, S, sg * 2.4), U, -2);
      nb.set(base, ni);
      nb.set(add(add(base, F, 4.5), U, -4.5), ni + 3);
      ni += 6;
    }
    // Spinnerets.
    const spin = spider.spinneret();
    for (let k = 0; k < 3; k++) jp.set(add(add(spin, S, (k - 1) * 2.2), U, -1.5), LEG_COUNT * 12 + k * 3);
    writeSegments(W.legsThick, tb);
    writeSegments(W.legsThin, nb);
    writeSegments(W.bristles, bb);
    W.joints.geometry.attributes.position.needsUpdate = true;
    W.joints.geometry.computeBoundingSphere();

    // Eight eyes in two rows on the front of the cephalothorax.
    const ep = W.eyes.geometry.attributes.position.array;
    const eyes = [
      [-1.6, 4.2], [1.6, 4.2], [-3.6, 3.4], [3.6, 3.4],
      [-2.4, 5.6], [2.4, 5.6], [-4.6, 4.8], [4.6, 4.8],
    ];
    eyes.forEach(([sx, up], k) => ep.set(add(add(add(face, S, sx), U, up - 2.5), F, -1.5), k * 3));
    W.eyes.geometry.attributes.position.needsUpdate = true;
    W.eyes.geometry.computeBoundingSphere();

    // Palps: two jointed feelers that tap slowly.
    const pb = W.palpBuf;
    let o = 0;
    for (const sg of [-1, 1]) {
      const tap = Math.sin(spider.time * 3.1 + (sg > 0 ? 1.4 : 0)) * 0.3;
      let prev = add(add(face, S, sg * 3.6), U, -1);
      for (let k = 1; k <= 10; k++) {
        const u = k / 10;
        const ang = u * 2.2 + tap;
        const pt = add(add(add(add(face, S, sg * (3.6 + Math.sin(ang) * 6)), F, 2 + u * 9), U, -1 + Math.sin(u * Math.PI) * 4 - u * 5), F, 0);
        pb.set(prev, o);
        pb.set(pt, o + 3);
        o += 6;
        prev = pt;
      }
    }
    writeSegments(W.palps, pb);

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
    const pts = run.silk;
    const tail = spider.spinneret();
    const anchors = pts.slice(-Math.floor((SILK_MAX - 24) / SILK_SUB));
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
      strand([last.x, last.y, last.z], tail, run.silkSection, 0.85, 20, Math.sin(run.t * 1.3) * 3);
    }
    W.silk.geometry.setDrawRange(0, vi);
    W.silk.geometry.attributes.position.needsUpdate = true;
    W.silk.geometry.attributes.color.needsUpdate = true;
    W.silk.geometry.computeBoundingSphere();

    composer.render();
  }

  return { resize, setWorld, render, project, orbit, camera };
}
