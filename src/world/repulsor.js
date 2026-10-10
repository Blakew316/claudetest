/**
 * Iron Man's effects, in world space: the repulsor blasts he fires from his
 * palms at the words he reads, and his thrusters (jet plumes from the boots,
 * and the palms in flight, with a few exhaust sparks). It decides when each repulsor fires
 * and reports it, so the body can recoil and the palm light up.
 *
 * A repulsor fires discrete blasts in an unhurried, slightly irregular rhythm
 * (one every 0.6-1.0 s per hand; the two alternate when both are on a word). Each blast: a small charge
 * building in the palm, a muzzle flash (white-hot core, a cyan shock disc
 * facing the target, short radial streaks and a forward jet), a short, very
 * bright bolt racing to the word with a tapered, motion-blurred streak and a
 * faint ionised trail behind it, then the impact (a flash, an expanding shell,
 * sparks thrown off and a brief afterglow).
 *
 * The firing schedule is a pure function of the animation clock (slot k of a
 * hand fires at a fixed, jittered time), so a seek shows exactly what live
 * playback would; each blast's sparks are analytic (seeded, evaluated at its
 * age), so they are stable from frame to frame and need no integration.
 */

import * as THREE from 'three';

const SPARKS = 300; // exhaust accents
const STREAKS = 640; // bolts, trails, muzzle streaks, impact sparks
const GLOWS = 96; // charge, muzzle and impact glows
const DISCS = 48; // muzzle shock discs and impact shells
const SHOTS = 24; // blasts alive at once (both hands)

const PERIOD = 0.8; // seconds between one hand's blasts (jittered to 0.6-1.0 s); the other hand fires halfway between
const JITTER = 0.25; // of a period
const CHARGE = 0.18; // seconds the palm visibly charges before a blast
const SHOT_LIFE = 0.75; // seconds a blast's effects last (trail, impact afterglow, sparks)
const IMPACT_SPARKS = 14;
const MUZZLE_STREAKS = 6;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Stable hash in [0, 1). */
const hash = (x) => {
  const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** When slot k of a hand fires (seconds on the animation clock); the right hand is half a period behind. */
const slotTime = (side, k) => (k + (side === 'R' ? 0.5 : 0) + JITTER * (hash(k * 1.731 + (side === 'R' ? 91.7 : 13.3)) - 0.5)) * PERIOD;

// Repulsor colours (linear): a white-hot core, a cyan sheath, a deep blue edge.
const CYAN = [0.32, 0.74, 1.0];
const BLUE = [0.12, 0.38, 1.0];

/** Soft round sprites (exhaust sparks): additive, sized in world units, with optional faint cross rays. */
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

/**
 * Hot glows: a tight white-hot core in a cyan halo, sized in world units. A
 * sprite smaller than a few pixels keeps its energy rather than its size, so
 * distant glows stay small and crisp instead of swelling into blobs.
 */
function glowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uHalfH: { value: 450 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 color; // halo colour x intensity
      attribute float size; // world diameter
      attribute float aCore; // white-hot core intensity
      uniform float uHalfH;
      varying vec3 vColor;
      varying float vCore;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float px = size * projectionMatrix[1][1] * uHalfH / max(1.0, -mv.z);
        float s = clamp(px, 6.0, 360.0);
        float k = px / s; // energy kept when the floor holds the sprite open
        gl_PointSize = s;
        gl_Position = projectionMatrix * mv;
        vColor = color * k;
        vCore = aCore * k;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vCore;
      void main() {
        vec2 d = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(d, d);
        if (r2 > 1.0) discard;
        float win = (1.0 - r2) * (1.0 - r2);
        float halo = 0.8 * exp(-r2 * 10.0) + 0.2 * exp(-r2 * 3.0);
        float core = exp(-r2 * 60.0);
        vec3 c = vColor * halo + vec3(1.0, 0.98, 0.95) * vCore * core + vColor * vCore * 0.6 * exp(-r2 * 22.0);
        gl_FragColor = vec4(c * win, 1.0);
      }`,
  });
}

/**
 * Streaks: segments drawn as screen-space ribbons with round caps (a bolt, its
 * trail, a spark's motion blur). Each end has its own half-width and colour
 * (rgb = cyan sheath, a = white-hot core), so a streak can taper and fade
 * along its length. The width never drops below a pixel or two; a streak held
 * open that way gives up brightness instead, so it stays antialiased without
 * getting fatter or brighter in the distance.
 */
function streakMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uHalfRes: { value: new THREE.Vector2(450, 450) }, uMinPx: { value: 1.6 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, // built in screen space: the winding depends on which way the streak points
    vertexShader: /* glsl */ `
      attribute vec3 aB; // the other end (position is end A)
      attribute vec2 aCorner; // x: 0 at A, 1 at B; y: -1 / +1 across
      attribute vec2 aW; // half-widths at A and B (world)
      attribute vec4 aColA;
      attribute vec4 aColB;
      uniform vec2 uHalfRes;
      uniform float uMinPx;
      varying vec2 vP; // pixels: along from A, across from the axis
      varying float vLen;
      varying vec2 vW;
      varying vec4 vColA;
      varying vec4 vColB;
      void main() {
        vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
        if (ca.w < 0.5 || cb.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec2 sa = ca.xy / ca.w * uHalfRes;
        vec2 sb = cb.xy / cb.w * uHalfRes;
        vec2 d = sb - sa;
        float len = length(d);
        vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        float k = projectionMatrix[1][1] * uHalfRes.y;
        float wa = aW.x * k / ca.w;
        float wb = aW.y * k / cb.w;
        float wm = max(max(wa, wb), uMinPx);
        float gain = clamp(max(wa, wb) / wm, 0.3, 1.0);
        wa = max(wa, uMinPx);
        wb = max(wb, uMinPx);
        float atB = aCorner.x;
        float along = atB * len + (atB * 2.0 - 1.0) * wm;
        vec2 s = sa + dir * along + nrm * aCorner.y * wm;
        vec4 c = atB > 0.5 ? cb : ca;
        gl_Position = vec4(s / uHalfRes, c.z / c.w, 1.0);
        vP = vec2(along, aCorner.y * wm);
        vLen = len;
        vW = vec2(wa, wb);
        vColA = aColA * gain;
        vColB = aColB * gain;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      varying float vLen;
      varying vec2 vW;
      varying vec4 vColA;
      varying vec4 vColB;
      void main() {
        float t = clamp(vP.x / max(vLen, 1e-3), 0.0, 1.0);
        float w = mix(vW.x, vW.y, t);
        float dx = vP.x < 0.0 ? -vP.x : max(0.0, vP.x - vLen);
        float r2 = (dx * dx + vP.y * vP.y) / (w * w);
        if (r2 > 1.0) discard;
        vec4 c = mix(vColA, vColB, t);
        float win = (1.0 - r2) * (1.0 - r2);
        float sheath = exp(-r2 * 3.2);
        float core = exp(-r2 * 26.0);
        vec3 col = c.rgb * sheath + vec3(1.0, 0.98, 0.95) * c.a * core + c.rgb * c.a * 0.5 * exp(-r2 * 9.0);
        gl_FragColor = vec4(col * win, 1.0);
      }`,
  });
}

/**
 * Discs: a thin glowing ring with a faint fill, drawn on a quad in world space
 * (a muzzle shock disc facing the target, or an impact's expanding shell facing
 * the camera, which a thin glowing sphere looks like). Antialiased with fwidth.
 */
function discMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      attribute vec3 color;
      attribute vec4 aRing; // ring radius, ring half-thickness (both of the quad's half-size), ring intensity, fill intensity
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vRing;
      void main() {
        vUv = aUv;
        vColor = color;
        vRing = aRing;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vRing;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float th = max(vRing.y, fwidth(r) * 1.25);
        float x = (r - vRing.x) / th;
        float ring = exp(-x * x) * vRing.y / th;
        float fill = smoothstep(vRing.x + th, vRing.x - th, r) * (0.25 + 0.75 * r / max(vRing.x, 1e-3));
        float edge = smoothstep(1.0, 0.8, r);
        vec3 c = vColor * (ring * vRing.z + fill * vRing.w) + vec3(1.0) * ring * vRing.z * 0.35 * exp(-x * x * 3.0);
        gl_FragColor = vec4(c * edge, 1.0);
      }`,
  });
}

export function createRepulsors() {
  const group = new THREE.Group();

  // Streak ribbons: 4 vertices each, every attribute repeated per vertex.
  const stGeo = new THREE.BufferGeometry();
  const stA = new Float32Array(STREAKS * 4 * 3);
  const stB = new Float32Array(STREAKS * 4 * 3);
  const stCorner = new Float32Array(STREAKS * 4 * 2);
  const stW = new Float32Array(STREAKS * 4 * 2);
  const stColA = new Float32Array(STREAKS * 4 * 4);
  const stColB = new Float32Array(STREAKS * 4 * 4);
  const stIdx = new Uint16Array(STREAKS * 6);
  for (let i = 0; i < STREAKS; i++) {
    stIdx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    stCorner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
  }
  const dyn = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
  stGeo.setAttribute('position', dyn(stA, 3));
  stGeo.setAttribute('aB', dyn(stB, 3));
  stGeo.setAttribute('aCorner', new THREE.BufferAttribute(stCorner, 2));
  stGeo.setAttribute('aW', dyn(stW, 2));
  stGeo.setAttribute('aColA', dyn(stColA, 4));
  stGeo.setAttribute('aColB', dyn(stColB, 4));
  stGeo.setIndex(new THREE.BufferAttribute(stIdx, 1));
  const streaks = new THREE.Mesh(stGeo, streakMaterial());
  streaks.frustumCulled = false;
  streaks.renderOrder = 16;

  // Discs: 4 vertices each.
  const dGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DISCS * 4 * 3);
  const dUv = new Float32Array(DISCS * 4 * 2);
  const dCol = new Float32Array(DISCS * 4 * 3);
  const dRing = new Float32Array(DISCS * 4 * 4);
  const dIdx = new Uint16Array(DISCS * 6);
  for (let i = 0; i < DISCS; i++) {
    dIdx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    dUv.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
  }
  dGeo.setAttribute('position', dyn(dPos, 3));
  dGeo.setAttribute('aUv', new THREE.BufferAttribute(dUv, 2));
  dGeo.setAttribute('color', dyn(dCol, 3));
  dGeo.setAttribute('aRing', dyn(dRing, 4));
  dGeo.setIndex(new THREE.BufferAttribute(dIdx, 1));
  const discs = new THREE.Mesh(dGeo, discMaterial());
  discs.frustumCulled = false;
  discs.renderOrder = 16;

  const pointsOf = (n, mat, core) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', dyn(new Float32Array(n * 3), 3));
    g.setAttribute('color', dyn(new Float32Array(n * 3), 3));
    g.setAttribute('size', dyn(new Float32Array(n), 1));
    if (core) g.setAttribute('aCore', dyn(new Float32Array(n), 1));
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    p.renderOrder = 17;
    return p;
  };
  const sparks = pointsOf(SPARKS, spriteMaterial(0));
  const glows = pointsOf(GLOWS, glowMaterial(), true);
  group.add(discs, streaks, glows, sparks);

  const sp = { vel: new Float32Array(SPARKS * 3), age: new Float32Array(SPARKS).fill(9), life: new Float32Array(SPARKS).fill(1), tint: new Float32Array(SPARKS * 3), size: new Float32Array(SPARKS), next: 0, acc: 0 };
  const shots = Array.from({ length: SHOTS }, () => ({
    live: false,
    side: 'L',
    T: 0,
    seed: 0,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    dist: 1,
    tau: 0.08,
  }));
  const seen = new Map(); // word id -> last reach p (+10 once it is retracting)
  const elig = { L: [], R: [] };
  let prevT = -1e9;
  const camPos = new THREE.Vector3();
  const camR = new THREE.Vector3();
  const camU = new THREE.Vector3();
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();
  const d3 = new THREE.Vector3();
  const e3 = new THREE.Vector3();
  const u3 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const n3 = new THREE.Vector3();

  /** Emit an exhaust spark. */
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

  // Per-frame writers into the effect buffers.
  let ns = 0;
  let ng = 0;
  let nd = 0;
  /** A streak from a to b: half-widths wa, wb (world); colours (sheath rgb x intensity, core intensity) at each end. */
  function streak(a, b, wa, wb, r0, g0, b0, k0, r1, g1, b1, k1) {
    if (ns >= STREAKS) return;
    for (let v = 0; v < 4; v++) {
      const j = ns * 4 + v;
      stA[j * 3] = a.x;
      stA[j * 3 + 1] = a.y;
      stA[j * 3 + 2] = a.z;
      stB[j * 3] = b.x;
      stB[j * 3 + 1] = b.y;
      stB[j * 3 + 2] = b.z;
      stW[j * 2] = wa;
      stW[j * 2 + 1] = wb;
      stColA[j * 4] = r0;
      stColA[j * 4 + 1] = g0;
      stColA[j * 4 + 2] = b0;
      stColA[j * 4 + 3] = k0;
      stColB[j * 4] = r1;
      stColB[j * 4 + 1] = g1;
      stColB[j * 4 + 2] = b1;
      stColB[j * 4 + 3] = k1;
    }
    ns++;
  }
  /** A glow at p: world diameter, halo colour x intensity, white core intensity. */
  function glow(p, size, r, g, b, core) {
    if (ng >= GLOWS) return;
    const pa = glows.geometry.attributes.position.array;
    const ca = glows.geometry.attributes.color.array;
    pa[ng * 3] = p.x;
    pa[ng * 3 + 1] = p.y;
    pa[ng * 3 + 2] = p.z;
    ca[ng * 3] = r;
    ca[ng * 3 + 1] = g;
    ca[ng * 3 + 2] = b;
    glows.geometry.attributes.size.array[ng] = size;
    glows.geometry.attributes.aCore.array[ng] = core;
    ng++;
  }
  /** A disc at p spanned by unit vectors u, v: ring radius R and half-thickness th (world), colour, ring and fill intensities. */
  function disc(p, u, v, R, th, r, g, b, ring, fill) {
    if (nd >= DISCS) return;
    const h = R + 3 * th;
    for (let k = 0; k < 4; k++) {
      const su = k & 1 ? 1 : -1;
      const sv = k & 2 ? 1 : -1;
      const j = nd * 4 + k;
      dPos[j * 3] = p.x + (u.x * su + v.x * sv) * h;
      dPos[j * 3 + 1] = p.y + (u.y * su + v.y * sv) * h;
      dPos[j * 3 + 2] = p.z + (u.z * su + v.z * sv) * h;
      dCol[j * 3] = r;
      dCol[j * 3 + 1] = g;
      dCol[j * 3 + 2] = b;
      dRing[j * 4] = R / h;
      dRing[j * 4 + 1] = th / h;
      dRing[j * 4 + 2] = ring;
      dRing[j * 4 + 3] = fill;
    }
    nd++;
  }

  /** Two unit vectors spanning the plane with normal n. */
  function basis(n, u, v) {
    u.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    v.copy(n).cross(u);
  }

  /** Start a blast from slot k of a hand at time T, from the palm at a word. */
  function addShot(side, k, T, palm, at) {
    let s = shots[0];
    for (const c of shots) {
      if (!c.live) {
        s = c;
        break;
      }
      if (c.T < s.T) s = c;
    }
    s.live = true;
    s.side = side;
    s.T = T;
    s.seed = hash(k * 0.917 + (side === 'R' ? 5.1 : 2.3)) * 1000;
    s.from.copy(palm);
    s.to.copy(at);
    s.dir.copy(at).sub(palm);
    s.dist = Math.max(1e-3, s.dir.length());
    s.dir.multiplyScalar(1 / s.dist);
    s.tau = clamp(0.045 + s.dist / 2600, 0.05, 0.12); // the bolt's flight time
  }

  /**
   * Advance and draw one frame.
   * @param {object} o
   * @param {number} o.dt real seconds since the last frame (capped)
   * @param {number} o.time animation clock (seconds)
   * @param {THREE.Camera} o.camera
   * @param {number} o.halfH half the drawing buffer height (px), for sprite sizes
   * @param {number} o.unit world size of the effects relative to the original build (his size)
   * @param {number} o.scale his current scale (larger in flight)
   * @param {{L:THREE.Vector3, R:THREE.Vector3}} o.palms palm centres, world
   * @param {THREE.Vector3[]} o.soles boot soles, world
   * @param {THREE.Vector3} o.head which way his head points (thrust goes the other way)
   * @param {THREE.Vector3} o.vel his velocity, world units/s
   * @param {number} o.thrust 0..1 boot thrusters (off the ground)
   * @param {number} o.fly 0..1 flying (palms join the thrust)
   * @param {{at:number[], id:number, p:number, side:'L'|'R'}[]} o.targets words being read: where, which, how far the director's reach has got (0..1), and the hand on that side
   * @param {{L:number, R:number}} o.aim how far each arm is raised onto its target (0..1)
   * @returns {{fired:{L:number, R:number}, light:number}} blasts fired this frame per hand (the body recoils per blast), and how bright the repulsors burn (lights his armour)
   */
  function update(o) {
    const { dt, time, camera, halfH, unit, scale, palms, soles, head, vel, thrust, fly, targets, aim } = o;
    const aspect = camera.aspect || 1;
    sparks.material.uniforms.uHalfH.value = halfH;
    glows.material.uniforms.uHalfH.value = halfH;
    streaks.material.uniforms.uHalfRes.value.set(halfH * aspect, halfH);
    camera.getWorldPosition(camPos);
    camR.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camU.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const fired = { L: 0, R: 0 };
    ns = 0;
    ng = 0;
    nd = 0;

    // Which words each hand may shoot: on its side, and not being let go (the reach shrinking).
    elig.L.length = 0;
    elig.R.length = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const last = seen.get(t.id);
      let retract = last !== undefined && last >= 10;
      if (last !== undefined && !retract && t.p < last - 1e-4) retract = true;
      seen.set(t.id, t.p + (retract ? 10 : 0));
      if (!retract && (t.side === 'L' || t.side === 'R')) elig[t.side].push(i);
    }
    if (seen.size > targets.length) {
      for (const id of seen.keys()) {
        let found = false;
        for (let i = 0; i < targets.length && !found; i++) found = targets[i].id === id;
        if (!found) seen.delete(id);
      }
    }

    // The schedule: every slot that came due since the last frame fires, if that hand is up on a word.
    const jumped = !(time >= prevT) || time - prevT > 0.5;
    if (jumped) for (const s of shots) s.live = false;
    const t0 = jumped ? time - SHOT_LIFE : prevT; // after a seek, fill in what is already in the air
    prevT = time;
    const ready = { L: false, R: false };
    for (const n of ['L', 'R']) {
      ready[n] = aim[n] > 0.5 && elig[n].length > 0;
      if (!ready[n]) continue;
      for (let k = Math.floor(t0 / PERIOD) - 1, k1 = Math.floor(time / PERIOD) + 1; k <= k1; k++) {
        const T = slotTime(n, k);
        if (T <= t0 || T > time) continue;
        const t = targets[elig[n][((k % elig[n].length) + elig[n].length) % elig[n].length]];
        addShot(n, k, T, palms[n], a3.set(t.at[0], t.at[1], t.at[2]));
        if (!jumped || T > time - 0.07) fired[n]++;
      }
    }

    // Palms: primed while the arm is up, a charge building just before each blast.
    let light = 0;
    const S = unit;
    for (const n of ['L', 'R']) {
      const up = clamp((aim[n] - 0.3) / 0.5, 0, 1) * (elig[n].length ? 1 : 0);
      let q = 0;
      c3.copy(palms[n]);
      if (ready[n]) {
        let k = Math.floor(time / PERIOD) - 1;
        while (slotTime(n, k) <= time) k++;
        q = clamp(1 - (slotTime(n, k) - time) / CHARGE, 0, 1);
        q *= q;
        // The charge gathers just off the palm, toward the word it is about to hit.
        const t = targets[elig[n][((k % elig[n].length) + elig[n].length) % elig[n].length]];
        d3.set(t.at[0], t.at[1], t.at[2]).sub(palms[n]);
        const l = d3.length();
        if (l > 1e-3) c3.addScaledVector(d3, (0.7 * S) / l);
      }
      if (up > 0.01 || q > 0.01) {
        const fl = 0.92 + 0.08 * Math.sin(time * 61 + (n === 'L' ? 0 : 2));
        glow(c3, (1.7 + 1.6 * q) * S, CYAN[0] * (0.22 * up + 0.7 * q) * fl, CYAN[1] * (0.22 * up + 0.7 * q) * fl, (0.22 * up + 0.7 * q) * fl, (0.25 * up + 1.3 * q) * fl);
      }
      light += 0.12 * up + 0.35 * q;
    }

    // Blasts.
    for (const s of shots) {
      if (!s.live) continue;
      const a = time - s.T;
      if (a > SHOT_LIFE || a < 0) {
        s.live = false;
        continue;
      }
      const palm = palms[s.side];
      const { dir, dist, tau, seed } = s;

      // Muzzle: a white-hot flash, a cyan shock disc facing the target, radial streaks and a forward jet.
      if (a < 0.09) {
        const f = Math.exp(-a / 0.018);
        const g = Math.exp(-a / 0.03);
        // Just in front of the palm, so the glove does not hide the flash it throws.
        e3.copy(palm).addScaledVector(dir, 1.4 * S);
        glow(e3, (4.5 + 4 * (1 - Math.exp(-a / 0.012))) * S, CYAN[0] * 0.9 * g, CYAN[1] * 0.9 * g, 0.9 * g, 2.6 * f);
        light += 1.25 * g;
        // The disc faces down the barrel, turned a little toward the camera so it never collapses to a line.
        d3.copy(camPos).sub(palm).normalize();
        n3.copy(dir).addScaledVector(d3, 0.45).normalize();
        basis(n3, u3, v3);
        if (a < 0.06) {
          const fd = Math.exp(-a / 0.016);
          const R = (0.9 + 3.2 * (1 - Math.exp(-a / 0.014))) * S;
          e3.copy(palm).addScaledVector(dir, (0.8 + 20 * a) * S);
          disc(e3, u3, v3, R, R * 0.12, CYAN[0], CYAN[1], CYAN[2], 0.8 * fd, 0.15 * fd);
          const R2 = (0.5 + 1.8 * (1 - Math.exp(-a / 0.01))) * S;
          e3.copy(palm).addScaledVector(dir, (2.2 + 60 * a) * S);
          disc(e3, u3, v3, R2, R2 * 0.14, CYAN[0], CYAN[1], CYAN[2], 0.5 * fd, 0.15 * fd);
        }
        // Forward jet: a short hot cone down the line of fire.
        const jl = (3 + 70 * a) * S;
        b3.copy(palm).addScaledVector(dir, Math.min(jl, dist));
        streak(palm, b3, 1.1 * S, 0.25 * S, CYAN[0] * 0.9 * f, CYAN[1] * 0.9 * f, 0.9 * f, 1.4 * f, BLUE[0] * 0.3 * f, BLUE[1] * 0.3 * f, BLUE[2] * 0.3 * f, 0);
        // Radial streaks fanning out of the palm, mostly forward.
        if (a < 0.06) {
          const fr = Math.exp(-a / 0.018);
          const ext = 1 - Math.exp(-a / 0.012);
          basis(dir, u3, v3);
          for (let i = 0; i < MUZZLE_STREAKS; i++) {
            const th = ((i + 0.6 * hash(seed + i * 3.1)) / MUZZLE_STREAKS) * Math.PI * 2;
            const len = (3 + 6 * hash(seed + i * 5.7)) * S * ext;
            c3.copy(u3).multiplyScalar(Math.cos(th)).addScaledVector(v3, Math.sin(th)).addScaledVector(dir, 0.9 + 0.8 * hash(seed + i * 7.3)).normalize();
            a3.copy(palm).addScaledVector(c3, 0.8 * S);
            b3.copy(palm).addScaledVector(c3, 0.8 * S + len);
            streak(a3, b3, 0.22 * S, 0.08 * S, CYAN[0] * 0.8 * fr, CYAN[1] * 0.8 * fr, 0.8 * fr, 1.1 * fr, BLUE[0] * 0.2 * fr, BLUE[1] * 0.2 * fr, BLUE[2] * 0.2 * fr, 0);
          }
        }
      }

      // The bolt: a short white-hot slug with a tapered, motion-blurred tail, and a hot glow at its head.
      if (a < tau) {
        const u = a / tau;
        const head = u * dist;
        const tail = Math.max(0, head - Math.min(0.4 * dist, 20 * S));
        a3.copy(s.from).addScaledVector(dir, tail);
        b3.copy(s.from).addScaledVector(dir, head);
        streak(a3, b3, 0.15 * S, 0.7 * S, CYAN[0] * 0.06, CYAN[1] * 0.06, 0.06, 0, CYAN[0] * 1.4, CYAN[1] * 1.4, 1.4, 3.2);
        glow(b3, 5 * S, CYAN[0] * 0.5, CYAN[1] * 0.5, 0.5, 1.4);
        // The ionised channel it leaves behind: faint, already fading at the palm end.
        const fA = 0.07 * Math.exp(-a / 0.04);
        streak(s.from, b3, 0.25 * S, 0.25 * S, CYAN[0] * fA, CYAN[1] * fA, fA, 0, CYAN[0] * 0.16, CYAN[1] * 0.16, 0.16, 0.1);
      } else {
        // The channel after the hit: widening a little as it fades, palm end first.
        const ai = a - tau;
        const fA = 0.07 * Math.exp(-a / 0.04);
        const fB = 0.16 * Math.exp(-ai / 0.035);
        if (fB > 0.004) {
          const w = (0.25 + 2.5 * ai) * S;
          streak(s.from, s.to, w, w, CYAN[0] * fA, CYAN[1] * fA, fA, 0, BLUE[0] * fB, BLUE[1] * fB, BLUE[2] * fB, 0);
        }

        // Impact: a flash, an expanding shell, sparks thrown off, a brief afterglow.
        const flash = Math.exp(-ai / 0.022);
        const after = Math.exp(-ai / 0.1);
        const hk = 0.7 * flash + 0.22 * after;
        glow(s.to, (4.5 + 3 * (1 - Math.exp(-ai / 0.02))) * S, CYAN[0] * hk, CYAN[1] * hk, hk, 2.2 * flash + 0.3 * after);
        if (ai < 0.1) {
          const R = (1.5 + 4 * (1 - Math.exp(-ai / 0.03))) * S;
          const fr = Math.exp(-ai / 0.025);
          disc(s.to, camR, camU, R, R * 0.14, CYAN[0], CYAN[1], CYAN[2], 0.45 * fr, 0.06 * fr);
        }
        for (let i = 0; i < IMPACT_SPARKS; i++) {
          const h1 = hash(seed + i * 1.37);
          const life = 0.12 + 0.24 * hash(seed + i * 2.91);
          if (ai > life) continue;
          // Thrown mostly back toward the shooter and out sideways.
          const z = 2 * hash(seed + i * 4.13) - 1;
          const ph = 2 * Math.PI * hash(seed + i * 6.71);
          const rr = Math.sqrt(1 - z * z);
          c3.set(rr * Math.cos(ph), rr * Math.sin(ph), z).addScaledVector(dir, -0.75).normalize();
          const spd = (50 + 160 * h1 * h1) * S;
          const kd = 8; // drag
          const x1 = (spd * (1 - Math.exp(-kd * ai))) / kd;
          const x0 = (spd * (1 - Math.exp(-kd * Math.max(0, ai - 0.03)))) / kd;
          a3.copy(s.to).addScaledVector(c3, x0);
          b3.copy(s.to).addScaledVector(c3, x1);
          const u = ai / life;
          const f = (1 - u) * (1 - u);
          const hot = Math.exp(-ai / 0.06);
          streak(a3, b3, 0.06 * S, 0.2 * S, BLUE[0] * 0.25 * f, BLUE[1] * 0.25 * f, BLUE[2] * 0.25 * f, 0, CYAN[0] * 1.1 * f, CYAN[1] * 1.1 * f, 1.1 * f, 1.3 * f * (0.3 + 0.7 * hot));
        }
      }
    }

    // Thrusters: a jet plume from each boot (off the ground) and palm (in flight, or
    // steadying a hover), streaming away from his head: white-hot at the nozzle,
    // into a cyan sheath that widens and fades to blue, with faint shock diamonds.
    d3.copy(head).multiplyScalar(-1).normalize();
    for (let i = 0; i < 4; i++) {
      const palm = i >= 2;
      const pw = palm ? thrust * (0.35 + 0.65 * fly) : thrust;
      if (pw < 0.02) continue;
      const p = palm ? palms[i === 2 ? 'L' : 'R'] : soles[i];
      const sz = unit * scale * (palm ? 0.8 : 1);
      // Flicker: the plume breathes in length and brightness.
      const fl = 0.86 + 0.09 * Math.sin(time * 53 + i * 1.7) + 0.05 * Math.sin(time * 131 + i * 4.1);
      const L = (5 + 8 * fly + 2 * thrust) * sz * (0.9 + 0.1 * Math.sin(time * 37 + i * 2.3)) * pw;
      const k = pw * fl;
      b3.copy(p).addScaledVector(d3, L);
      streak(p, b3, 1.1 * sz, 2.3 * sz, CYAN[0] * 0.42 * k, CYAN[1] * 0.42 * k, 0.42 * k, 0, BLUE[0] * 0.06 * k, BLUE[1] * 0.06 * k, BLUE[2] * 0.06 * k, 0);
      b3.copy(p).addScaledVector(d3, 0.55 * L);
      streak(p, b3, 0.5 * sz, 0.22 * sz, CYAN[0] * 0.5 * k, CYAN[1] * 0.5 * k, 0.5 * k, 1.5 * k, CYAN[0] * 0.12 * k, CYAN[1] * 0.12 * k, 0.12 * k, 0.15 * k);
      // Shock diamonds: small bright knots spaced down the core, each fainter.
      for (let j = 0; j < 3; j++) {
        const at = (0.2 + 0.17 * j) * L;
        const h = 0.07 * L;
        const kd = k * (0.5 - 0.13 * j) * (0.8 + 0.2 * Math.sin(time * 71 + i * 3 + j * 2));
        a3.copy(p).addScaledVector(d3, at - h);
        b3.copy(p).addScaledVector(d3, at);
        streak(a3, b3, 0.08 * sz, (0.45 - 0.06 * j) * sz, CYAN[0] * kd, CYAN[1] * kd, kd, 0, CYAN[0] * kd, CYAN[1] * kd, kd, 0.9 * kd);
        a3.copy(p).addScaledVector(d3, at + h);
        streak(b3, a3, (0.45 - 0.06 * j) * sz, 0.08 * sz, CYAN[0] * kd, CYAN[1] * kd, kd, 0.9 * kd, CYAN[0] * kd, CYAN[1] * kd, kd, 0);
      }
      // The nozzle itself, white-hot.
      e3.copy(p).addScaledVector(d3, 0.3 * sz);
      glow(e3, 3.2 * sz, CYAN[0] * 0.35 * k, CYAN[1] * 0.35 * k, 0.35 * k, 1.1 * k);
      if (palm) light += 0.5 * pw;
    }

    stGeo.setDrawRange(0, ns * 6);
    if (ns) for (const name of ['position', 'aB', 'aW', 'aColA', 'aColB']) stGeo.attributes[name].needsUpdate = true;
    dGeo.setDrawRange(0, nd * 6);
    if (nd) for (const name of ['position', 'color', 'aRing']) dGeo.attributes[name].needsUpdate = true;
    glows.geometry.setDrawRange(0, ng);
    if (ng) for (const name of ['position', 'color', 'size', 'aCore']) glows.geometry.attributes[name].needsUpdate = true;

    // Exhaust: sparks shooting back from boots (and palms in flight).
    sp.acc += dt * 60 * thrust;
    while (sp.acc >= 1) {
      sp.acc -= 1;
      const n = Math.random() < (fly > 0.3 ? 0.5 : 1) ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
      const p = n < 2 ? soles[n] : palms[n === 2 ? 'L' : 'R'];
      const s = (70 + 60 * fly) * scale;
      spark(p, -head.x * s + (Math.random() - 0.5) * 16 + vel.x * 0.6, -head.y * s + (Math.random() - 0.5) * 16 + vel.y * 0.6, -head.z * s + (Math.random() - 0.5) * 16 + vel.z * 0.6, 0.12 + Math.random() * 0.16, 0.5, 0.7, 1, 0.55 * scale);
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
      sa[i] = sp.size[i] * unit * (1 - 0.4 * u);
    }
    for (const name of ['position', 'color', 'size']) sparks.geometry.attributes[name].needsUpdate = true;
    return { fired, light: Math.min(light, 2) };
  }

  return { group, update };
}
