/**
 * WebGL renderer (three.js). Draws the 3D webs (particles, constellation
 * edges, glows), the word nodes, the spider (wireframe ellipsoid body,
 * jointed legs, head, palps, tumbling core), its dotted tentacles and silk,
 * through a perspective camera driven by run.camera plus a user orbit offset.
 * Reads run state only. project() maps world points to stage pixels for the
 * 2D label overlay.
 */

import * as THREE from 'three';
import { BG, QUEUED, FLAG, SPIDER, TENTACLE, TEXT } from '../core/theme.js';
import { LEG_COUNT, MAX_TENTACLES } from '../core/contracts.js';
import { BODY } from './spider.js';

export const FOV = 50;
const TENTACLE_DOTS = 220;
const SILK_MAX = 702;

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Latitude/longitude wireframe of a unit sphere, as line segments. */
function latLong(lat = 7, lon = 14, seg = 28) {
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

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createView3D(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(BG, 0.0005);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 60000);
  const glowTex = glowTexture();
  const orbit = { yaw: 0, pitch: 0 };
  const size = { w: 1, h: 1 };
  const tmp = new THREE.Vector3();
  const grey = new THREE.Color(QUEUED).multiplyScalar(0.55);
  const spiderCol = new THREE.Color(SPIDER);
  let W = null;

  function resize(w, h, dpr) {
    size.w = w;
    size.h = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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

    const clusters = world.clusters.map((c, i) => {
      const cloud = world._clouds[i];
      const n = cloud.pos.length / 3;
      const col = new Float32Array(n * 3);
      const stars = [];
      for (let k = 0; k < n; k++) {
        const b = Math.min(1, cloud.bright[k]);
        col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = b;
        if (cloud.bright[k] > 1.2) stars.push(cloud.pos[k * 3], cloud.pos[k * 3 + 1], cloud.pos[k * 3 + 2]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const points = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, ...additive }));
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', g.getAttribute('position'));
      eg.setIndex(new THREE.BufferAttribute(cloud.edges, 1));
      const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ opacity: 0.2, ...additive }));
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
      const starPts = new THREE.Points(sg, new THREE.PointsMaterial({ size: 3.4, sizeAttenuation: false, ...additive }));
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
    const legs = new THREE.LineSegments(dynamicGeometry(LEG_COUNT * 4), new THREE.LineBasicMaterial({ color: SPIDER }));
    const joints = new THREE.Points(dynamicGeometry(LEG_COUNT * 2), new THREE.PointsMaterial({ color: SPIDER, size: 3.6, sizeAttenuation: false }));
    const sphere = new THREE.SphereGeometry(1, 32, 20);
    const body = new THREE.Group();
    body.matrixAutoUpdate = false;
    const fill = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0x082a23 }));
    const rim = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: SPIDER, side: THREE.BackSide }));
    rim.scale.setScalar(1.09);
    const wire = new THREE.LineSegments(latLong(), new THREE.LineBasicMaterial({ color: SPIDER, transparent: true, opacity: 0.8 }));
    wire.scale.setScalar(1.005);
    body.add(fill, rim, wire);
    const head = new THREE.Group();
    const headFill = new THREE.Mesh(sphere, fill.material);
    const headRim = new THREE.Mesh(sphere, rim.material);
    headFill.scale.setScalar(6.2);
    headRim.scale.setScalar(6.9);
    head.add(headFill, headRim);
    const eyes = new THREE.Points(dynamicGeometry(2), new THREE.PointsMaterial({ color: TEXT, size: 3, sizeAttenuation: false }));
    const palps = new THREE.LineSegments(dynamicGeometry(2 * 14 * 2), new THREE.LineBasicMaterial({ color: SPIDER }));
    const core = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 8), new THREE.MeshBasicMaterial({ color: FLAG, depthTest: false, fog: false }));
    core.renderOrder = 20;
    const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: FLAG, opacity: 0.55, fog: false, ...additive, depthTest: false }));
    coreGlow.scale.setScalar(26);
    coreGlow.renderOrder = 19;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: SPIDER, opacity: 0.3, fog: false, ...additive }));
    halo.scale.setScalar(190);
    const tentacles = new THREE.Points(
      dynamicGeometry(MAX_TENTACLES * TENTACLE_DOTS),
      new THREE.PointsMaterial({ color: TENTACLE, size: 3, sizeAttenuation: false, transparent: true, opacity: 1, depthWrite: false, depthTest: false, fog: false }),
    );
    const silk = new THREE.Line(dynamicGeometry(SILK_MAX, 3, 4), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    tentacles.renderOrder = 15;
    root.add(halo, silk, tentacles, legs, joints, body, head, eyes, palps, coreGlow, core);

    W = { root, clusters, words, wcol, wordKey: '', world, analysis, legs, joints, body, head, eyes, palps, core, coreGlow, halo, tentacles, silk };
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
    const yaw = c.yaw + orbit.yaw;
    const pitch = Math.max(-1.3, Math.min(1.4, c.pitch + orbit.pitch));
    camera.position.set(c.x + c.dist * Math.cos(pitch) * Math.sin(yaw), c.y + c.dist * Math.sin(pitch), c.z + c.dist * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(c.x, c.y, c.z);
    camera.updateMatrixWorld();
    fog.density = 0.5 / c.dist;
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
    const fade = 1 - Math.exp(-5 * dt);

    W.clusters.forEach((cl, i) => {
      const on = run.status[i] !== 'queued' ? 1 : 0;
      const glow = ship ? 0.14 : i === run.active ? 0.42 : on ? 0.08 : 0;
      cl.mix += (on - cl.mix) * fade;
      cl.glowA += (glow - cl.glowA) * fade;
      cl.tint.copy(grey).lerp(cl.color, cl.mix);
      cl.points.material.color.copy(cl.tint);
      cl.stars.material.color.copy(cl.tint);
      cl.lines.material.color.copy(cl.tint);
      cl.lines.material.opacity = 0.12 + 0.16 * cl.mix;
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

    // Spider body frame.
    const { p, F, U, S } = spider;
    const m = W.body.matrix;
    m.makeBasis(tmp.set(...F).clone(), new THREE.Vector3(...U), new THREE.Vector3(...S));
    m.scale(new THREE.Vector3(BODY.RX, BODY.RZ, BODY.RY));
    m.setPosition(p[0], p[1], p[2]);
    W.body.matrixWorldNeedsUpdate = true;
    const hp = spider.head();
    W.head.position.set(hp[0], hp[1], hp[2]);
    W.core.position.set(p[0] + U[0] * 2, p[1] + U[1] * 2, p[2] + U[2] * 2);
    W.core.rotation.set(spider.time * 1.3, spider.time * 0.9, spider.time * 0.4);
    W.coreGlow.position.copy(W.core.position);
    W.halo.position.set(p[0], p[1], p[2]);

    const lp = W.legs.geometry.attributes.position.array;
    const jp = W.joints.geometry.attributes.position.array;
    spider.legs.forEach((leg, i) => {
      lp.set(leg.hip, i * 12);
      lp.set(leg.knee, i * 12 + 3);
      lp.set(leg.knee, i * 12 + 6);
      lp.set(leg.drawFoot, i * 12 + 9);
      jp.set(leg.knee, i * 6);
      jp.set(leg.drawFoot, i * 6 + 3);
    });
    W.legs.geometry.attributes.position.needsUpdate = true;
    W.joints.geometry.attributes.position.needsUpdate = true;
    W.legs.geometry.computeBoundingSphere();
    W.joints.geometry.computeBoundingSphere();

    // Eyes and two long curling palps off the head.
    const ep = W.eyes.geometry.attributes.position.array;
    for (let s = 0; s < 2; s++) {
      const sg = s ? 1 : -1;
      for (let k = 0; k < 3; k++) ep[s * 3 + k] = hp[k] + F[k] * 4.5 + S[k] * sg * 2.6 + U[k] * 3.5;
    }
    W.eyes.geometry.attributes.position.needsUpdate = true;
    W.eyes.geometry.computeBoundingSphere();
    const pp = W.palps.geometry.attributes.position.array;
    const sway = Math.sin(spider.time * 4.3) * 0.25;
    let o = 0;
    for (const sg of [-1, 1]) {
      let prev = null;
      for (let k = 0; k <= 14; k++) {
        const u = k / 14;
        // A loop: out along the head, curl back toward the mouth.
        const ang = u * Math.PI * 1.5 + sg * sway;
        const fwd = 4 + Math.sin(ang) * 16 + u * 6;
        const side = sg * (3 + (1 - Math.cos(ang)) * 7);
        const up = -u * 4;
        const pt = [0, 1, 2].map((j) => hp[j] + F[j] * fwd + S[j] * side + U[j] * up);
        if (prev) {
          pp.set(prev, o);
          pp.set(pt, o + 3);
          o += 6;
        }
        prev = pt;
      }
    }
    W.palps.geometry.attributes.position.needsUpdate = true;
    W.palps.geometry.computeBoundingSphere();

    // Tentacles: dotted bezier from the body to each word, bowed upward.
    const tp = W.tentacles.geometry.attributes.position.array;
    let dots = 0;
    const wp = W.world.wordPos;
    for (const tn of run.tentacles) {
      const tx = wp[tn.wordId * 3];
      const ty = wp[tn.wordId * 3 + 1];
      const tz = wp[tn.wordId * 3 + 2];
      const dx = tx - p[0];
      const dy = ty - p[1];
      const dz = tz - p[2];
      const L = Math.hypot(dx, dy, dz) || 1;
      const ox = p[0] + (dx / L) * 16;
      const oy = p[1] + (dy / L) * 16;
      const oz = p[2] + (dz / L) * 16;
      const bow = (tn.wordId % 2 ? 0.22 : 0.14) * L;
      const cx = (ox + tx) / 2 + U[0] * bow;
      const cy = (oy + ty) / 2 + U[1] * bow;
      const cz = (oz + tz) / 2 + U[2] * bow;
      const n = Math.min(TENTACLE_DOTS - 1, Math.max(2, Math.floor(L / 6)));
      const mDots = Math.floor(n * tn.p);
      for (let i = 0; i <= mDots && dots < MAX_TENTACLES * TENTACLE_DOTS; i++) {
        const u = i / n;
        const v = 1 - u;
        tp[dots * 3] = v * v * ox + 2 * v * u * cx + u * u * tx;
        tp[dots * 3 + 1] = v * v * oy + 2 * v * u * cy + u * u * ty;
        tp[dots * 3 + 2] = v * v * oz + 2 * v * u * cz + u * u * tz;
        dots++;
      }
    }
    W.tentacles.geometry.setDrawRange(0, dots);
    W.tentacles.geometry.attributes.position.needsUpdate = true;
    W.tentacles.geometry.computeBoundingSphere();

    // Silk: anchors in section colours, fading with age, live end at the spinneret.
    const sp = W.silk.geometry.attributes.position.array;
    const sc = W.silk.geometry.attributes.color.array;
    const pts = run.silk;
    const n = Math.min(pts.length, SILK_MAX - 1);
    const start = pts.length - n;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const a = pts[start + i];
      sp[i * 3] = a.x;
      sp[i * 3 + 1] = a.y;
      sp[i * 3 + 2] = a.z;
      c.set(analysis.sections[a.s]?.color ?? SPIDER);
      sc[i * 4] = c.r;
      sc[i * 4 + 1] = c.g;
      sc[i * 4 + 2] = c.b;
      sc[i * 4 + 3] = 0.12 + 0.68 * ((i + 1) / n) ** 0.7;
    }
    const tail = spider.spinneret();
    sp.set(tail, n * 3);
    c.set(analysis.sections[run.silkSection]?.color ?? SPIDER);
    sc.set([c.r, c.g, c.b, 0.85], n * 4);
    W.silk.geometry.setDrawRange(0, n + 1);
    W.silk.geometry.attributes.position.needsUpdate = true;
    W.silk.geometry.attributes.color.needsUpdate = true;
    W.silk.geometry.computeBoundingSphere();

    renderer.render(scene, camera);
  }

  return { resize, setWorld, render, project, orbit, camera, spiderColor: spiderCol };
}
