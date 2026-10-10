/**
 * Iron Man's effects, in world space: the repulsor rays he fires from his
 * palms at the words he reads (white-hot core in a cyan sheath, pulsing and
 * shimmering, with flares at the palm and the impact and sparks off the hit),
 * and his thrusters (flares at the boots, and palms in flight, with exhaust
 * sparks). It decides when each repulsor fires and reports it, so the body can
 * recoil and the palm light up.
 */

import * as THREE from 'three';

const MAX_BEAMS = 32;
const SPARKS = 900;
const FLARES = 48;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

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

export function createRepulsors() {
  const group = new THREE.Group();
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
  group.add(beams, flares, sparks);
  const sp = { vel: new Float32Array(SPARKS * 3), age: new Float32Array(SPARKS).fill(9), life: new Float32Array(SPARKS).fill(1), tint: new Float32Array(SPARKS * 3), size: new Float32Array(SPARKS), next: 0, acc: 0 };
  const seen = new Map();
  const charge = { L: 0, R: 0 };
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();

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
   * @returns {{fired:{L:number, R:number}, light:number}} shots fired this frame per hand (the body recoils), and how bright the repulsors burn (lights his armour)
   */
  function update(o) {
    const { dt, time, camera, halfH, unit, scale, palms, soles, head, vel, thrust, fly, targets, aim } = o;
    flares.material.uniforms.uHalfH.value = halfH;
    sparks.material.uniforms.uHalfH.value = halfH;
    beams.material.uniforms.uTime.value = time;
    const fired = { L: 0, R: 0 };
    const ids = new Set();
    for (const t of targets) {
      ids.add(t.id);
      if (!seen.has(t.id)) {
        seen.set(t.id, t.side);
        fired[t.side]++;
        charge[t.side] = 1;
      }
    }
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    for (const n of ['L', 'R']) charge[n] *= Math.exp(-6 * dt);

    // Rays.
    let nb = 0;
    camera.getWorldPosition(c3);
    for (const t of targets) {
      if (nb >= MAX_BEAMS) break;
      const from = palms[t.side];
      a3.set(t.at[0], t.at[1], t.at[2]);
      const to = b3.copy(from).lerp(a3, clamp(t.p, 0, 1));
      const len = from.distanceTo(to);
      if (len < 0.5) continue;
      const toCam = a3.copy(from).add(to).multiplyScalar(0.5).sub(c3).multiplyScalar(-1);
      const dir = to.clone().sub(from).normalize();
      const w = (1.5 + 0.6 * Math.min(1, len / 150)) * unit; // half-width: the cyan sheath; the white core is a fifth of it
      const sideV = dir.clone().cross(toCam).normalize().multiplyScalar(w);
      const off = nb * 4;
      const corners = [[from, 1], [from, -1], [to, 1], [to, -1]];
      corners.forEach(([p, s], k2) => {
        bPos[(off + k2) * 3] = p.x + sideV.x * s;
        bPos[(off + k2) * 3 + 1] = p.y + sideV.y * s;
        bPos[(off + k2) * 3 + 2] = p.z + sideV.z * s;
        bUv[(off + k2) * 2] = k2 < 2 ? 0 : 1;
        bUv[(off + k2) * 2 + 1] = s;
        bInfo[(off + k2) * 3] = len;
        bInfo[(off + k2) * 3 + 1] = (t.id * 0.618) % 1;
        bInfo[(off + k2) * 3 + 2] = 0.9 + 0.1 * Math.sin(time * 31 + t.id);
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
      fs[nf] = size * unit * scale;
      nf++;
    };
    const flick = 0.85 + 0.15 * Math.sin(time * 47);
    let light = 0;
    const firing = { L: false, R: false };
    for (const t of targets) firing[t.side] = true;
    for (const n of ['L', 'R']) {
      const fire = clamp(aim[n], 0, 1) * (firing[n] ? 1 : 0);
      const ch = charge[n];
      const pw = Math.max(fire * 0.7 + Math.min(1.5, ch * 1.4), thrust * 0.8); // the charge flashes up, then holds while firing
      if (pw > 0.02) flare(palms[n], 0.75 * pw * flick, 0.9 * pw * flick, 1.0 * pw * flick, 3.2 + 3 * Math.min(1, ch));
      light += pw;
    }
    if (thrust > 0.05) for (const s of soles) flare(s, 0.8 * thrust * flick, 0.9 * thrust * flick, thrust * flick, 4.2);
    for (const t of targets) if (t.p >= 1) flare(a3.set(t.at[0], t.at[1], t.at[2]), 0.9 * flick, 0.95 * flick, 1.0 * flick, 3.4 + 0.6 * Math.sin(time * 23 + t.id));
    flares.geometry.setDrawRange(0, nf);
    for (const name of ['position', 'color', 'size']) flares.geometry.attributes[name].needsUpdate = true;

    // Exhaust: sparks shooting back from boots (and palms in flight).
    sp.acc += dt * 500 * thrust;
    while (sp.acc >= 1) {
      sp.acc -= 1;
      const n = Math.random() < (fly > 0.3 ? 0.5 : 1) ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
      const p = n < 2 ? soles[n] : palms[n === 2 ? 'L' : 'R'];
      const s = (70 + 60 * fly) * scale;
      spark(p, -head.x * s + (Math.random() - 0.5) * 16 + vel.x * 0.6, -head.y * s + (Math.random() - 0.5) * 16 + vel.y * 0.6, -head.z * s + (Math.random() - 0.5) * 16 + vel.z * 0.6, 0.16 + Math.random() * 0.2, 0.8, 0.9, 1, 1.0 * scale);
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
    return { fired, light };
  }

  return { group, update };
}
