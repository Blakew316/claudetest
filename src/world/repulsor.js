/**
 * Iron Man's effects, in world space: the repulsor blasts he fires from his
 * palms at the words he reads, and his thrusters (jet plumes from the boots,
 * and the palms in flight, with a few exhaust sparks). It decides when each
 * repulsor fires and reports it, so the body can recoil, and it lights his
 * armour (a short-range light at each palm) and the dust round a flash.
 *
 * A repulsor fires discrete blasts in an unhurried, slightly irregular rhythm
 * (one every 0.9-1.4 s per hand; the two alternate when both are on a word).
 * Each blast is the films' repulsor held to what light and plasma would do in
 * vacuum, paced so the eye can follow it from the hand to the word:
 * - charge: the palm emitter ramps from its idle glow to white-hot over 0.3 s,
 *   a few motes of light spiralling into it, its light spilling onto the
 *   fingers and forearm;
 * - discharge (the frame `fired` reports, so the arm's recoil lands on it): a
 *   small white-hot core just ahead of the palm, a short jet of plasma and a
 *   shock ripple at the palm face, a few fast sparks; the flash lights the suit
 *   and the dust round him;
 * - pushback: the backwash, a thin ring blown back past the hand and gas
 *   venting back round it;
 * - bolt: a white-hot slug in a cyan sheath, flickering along its length,
 *   crossing to the word in 0.15-0.35 s and leaving a faint ionised trail that
 *   fades from the palm end;
 * - impact: a hot white point, an expanding shell of plasma, sparks and embers
 *   flying straight out (no gravity, no air to slow them) and cooling from
 *   white through cyan to nothing, and a faint wisp that dissipates.
 * The hand stays readable throughout: every hot core is small and sits ahead
 * of the palm, and the rings are wider than the hand, framing it.
 *
 * The firing schedule is a pure function of the animation clock (slot k of a
 * hand fires at a fixed, jittered time), so a seek shows exactly what live
 * playback would; each blast's sparks are analytic (seeded, evaluated at its
 * age), so they are stable from frame to frame and need no integration.
 */

import * as THREE from 'three';

const SPARKS = 300; // exhaust accents
const STREAKS = 640; // sparks' motion blur, intake motes, shock diamonds
const BEAMS = 32; // bolts, muzzle jets and trails, thruster plumes
const GLOWS = 192; // palm, flash, impact, ember and wisp glows
const DISCS = 48; // muzzle ripples and impact shells
const SHOTS = 24; // blasts alive at once (both hands)

const PERIOD = 1.15; // seconds between one hand's blasts (jittered to 0.9-1.4 s); the other hand fires halfway between
const JITTER = 0.22; // of a period
const CHARGE = 0.3; // seconds the palm takes to come up to white-hot before a blast
const SHOT_LIFE = 1.4; // seconds a blast's effects last (the last embers)
const BOLT_SPEED = 520; // world units a second (at unit 1): slow enough for the eye to follow it out of the hand
const BOLT_MIN = 0.15; // ... though a near word still takes this long (seconds)
const BOLT_MAX = 0.35; // ... and a far one no longer
const BOLT_LEN = 9; // the bolt's motion-blurred length, world units at unit 1 (about a frame of travel)
const BOLT_W = 0.8; // its half-width (outer glow) at the head; the palm is about 2 wide
const TRAIL_TAU = 0.12; // seconds: how fast the ionised trail behind the bolt fades
const MUZZLE_SPARKS = 5;
const EXHAUST = 8; // gas venting back round the hand: the pushback
const INTAKE_MOTES = 6;
const IMPACT_SPARKS = 12;
const IMPACT_EMBERS = 9;
const IMPACT_WISPS = 3;
const PALM_LIGHT_RANGE = 20; // world units (at unit 1) a palm's light reaches: the hand, the forearm, a little of the chest
const RIPPLE = 0; // disc kinds: a shock front in a plane
const SHELL = 1; // ... a thin sphere of plasma (drawn facing the camera)
const SIDES = ['L', 'R'];
const DISC_ATTRS = ['position', 'color', 'aRing', 'aKind'];
const GLOW_ATTRS = ['position', 'color', 'size', 'aCore'];
const SPARK_ATTRS = ['position', 'color', 'size'];

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
 * Glows, sized in world units. A hot one (core >= 0) is a point of light seen
 * through a lens: a tight white-hot core, a short cyan halo and a glare skirt
 * that falls off like 1/r^2 rather than a Gaussian blob. A soft one (core < 0)
 * is a wisp of glowing gas, soft all through. A sprite smaller than a few
 * pixels keeps its energy rather than its size, so distant glows stay small
 * and crisp instead of swelling into blobs.
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
      attribute float aCore; // white-hot core intensity (< 0: a soft wisp)
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
        vec3 c;
        if (vCore < 0.0) {
          c = vColor * exp(-r2 * 3.5);
        } else {
          float halo = 0.6 * exp(-r2 * 14.0) + 0.4 * 0.03 / (0.03 + r2);
          float core = exp(-r2 * 90.0);
          c = vColor * halo + vec3(1.0, 0.98, 0.95) * vCore * core + vColor * vCore * 0.5 * exp(-r2 * 30.0);
        }
        gl_FragColor = vec4(c * win, 1.0);
      }`,
  });
}

/*
 * Ribbons: segments drawn as screen-space quads with round caps. Each end has
 * its own half-width and colour (rgb = cyan sheath, a = white-hot core), so a
 * ribbon can taper and fade along its length. The width never drops below a
 * pixel or two; a ribbon held open that way gives up brightness instead, so it
 * stays antialiased without getting fatter or brighter in the distance.
 */
const RIBBON_VERTEX = /* glsl */ `
  attribute vec3 aB; // the other end (position is end A)
  attribute vec2 aCorner; // x: 0 at A, 1 at B; y: -1 / +1 across
  attribute vec2 aW; // half-widths at A and B (world)
  attribute vec4 aColA;
  attribute vec4 aColB;
  #ifdef BEAM
  attribute vec4 aFx; // seed, world length, turbulence, outer glow
  varying vec4 vFx;
  #endif
  uniform vec2 uHalfRes;
  uniform float uMinPx;
  varying vec2 vP; // pixels: along from A, across from the axis
  varying float vLen;
  varying vec2 vW;
  varying vec4 vColA;
  varying vec4 vColB;
  varying vec2 vSeg; // the part of A -> B on screen (0..1 along it), once clipped
  void main() {
    vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
    // Clip the segment just in front of the camera's near plane, so a ribbon
    // running past the camera is cut short rather than lost.
    float nearW = 1.05 * projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
    if (ca.w < nearW && cb.w < nearW) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float fa = ca.w < nearW ? (nearW - ca.w) / (cb.w - ca.w) : 0.0;
    float fb = cb.w < nearW ? (nearW - ca.w) / (cb.w - ca.w) : 1.0;
    vec4 pa = mix(ca, cb, fa);
    vec4 pb = mix(ca, cb, fb);
    vec2 sa = pa.xy / pa.w * uHalfRes;
    vec2 sb = pb.xy / pb.w * uHalfRes;
    vec2 d = sb - sa;
    float len = length(d);
    vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float k = projectionMatrix[1][1] * uHalfRes.y;
    float wa = mix(aW.x, aW.y, fa) * k / pa.w;
    float wb = mix(aW.x, aW.y, fb) * k / pb.w;
    float wm = max(max(wa, wb), uMinPx);
    float gain = clamp(max(wa, wb) / wm, 0.3, 1.0);
    wa = max(wa, uMinPx);
    wb = max(wb, uMinPx);
    float atB = aCorner.x;
    float along = atB * len + (atB * 2.0 - 1.0) * wm;
    vec2 s = sa + dir * along + nrm * aCorner.y * wm;
    vec4 c = atB > 0.5 ? pb : pa;
    gl_Position = vec4(s / uHalfRes, c.z / c.w, 1.0);
    vP = vec2(along, aCorner.y * wm);
    vLen = len;
    vW = vec2(wa, wb);
    vColA = mix(aColA, aColB, fa) * gain;
    vColB = mix(aColA, aColB, fb) * gain;
    vSeg = vec2(fa, fb);
    #ifdef BEAM
    vFx = aFx;
    #endif
  }`;

function ribbonMaterial(fragmentShader, beam) {
  return new THREE.ShaderMaterial({
    uniforms: { uHalfRes: { value: new THREE.Vector2(450, 450) }, uMinPx: { value: 1.6 }, uTime: { value: 0 } },
    defines: beam ? { BEAM: '' } : {},
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, // built in screen space: the winding depends on which way it points
    vertexShader: RIBBON_VERTEX,
    fragmentShader,
  });
}

/** Streaks: a spark's motion blur, a mote, a shock diamond. */
function streakMaterial() {
  return ribbonMaterial(/* glsl */ `
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
    }`);
}

/**
 * Beams: a ribbon with a real radial profile, a white-hot core inside a cyan
 * sheath inside a soft blue glow, each kept at least about a pixel wide (and
 * dimmed to match) so a distant beam stays a clean line. Turbulence travels
 * down it: knots of brightness and a slight writhe of the core, in world units
 * along the beam, so it flickers like a stream of plasma rather than a tube.
 */
function beamMaterial() {
  return ribbonMaterial(
    /* glsl */ `
    uniform float uTime;
    varying vec2 vP;
    varying float vLen;
    varying vec2 vW;
    varying vec4 vColA;
    varying vec4 vColB;
    varying vec2 vSeg;
    varying vec4 vFx;
    float noise(float x) {
      float i = floor(x);
      float f = fract(x);
      float a = fract(sin(i * 127.1 + vFx.x) * 43758.5453);
      float b = fract(sin((i + 1.0) * 127.1 + vFx.x) * 43758.5453);
      return mix(a, b, f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
    }
    void main() {
      float t = clamp(vP.x / max(vLen, 1e-3), 0.0, 1.0);
      float w = mix(vW.x, vW.y, t);
      float dx = vP.x < 0.0 ? -vP.x : max(0.0, vP.x - vLen);
      float s = mix(vSeg.x, vSeg.y, t) * vFx.y; // world distance from A
      float tb = vFx.z;
      float knots = 0.6 * noise(s * 0.45 - uTime * 110.0) + 0.4 * noise(s * 1.3 - uTime * 190.0 + 7.0);
      float y = vP.y - tb * w * (0.05 * noise(s * 0.7 + uTime * 47.0 + 3.0) + 0.025 * noise(s * 2.3 - uTime * 83.0 + 11.0));
      float d2 = dx * dx + y * y;
      float r2 = (dx * dx + vP.y * vP.y) / (w * w);
      if (r2 > 1.0) discard;
      vec4 c = mix(vColA, vColB, t);
      float wc = max(0.13 * w, 0.75);
      float ws = max(0.38 * w, 1.3);
      float core = exp(-d2 / (wc * wc)) * (0.13 * w / wc);
      float sheath = exp(-d2 / (ws * ws)) * (0.38 * w / ws);
      float glow = exp(-r2 * 3.0) * (1.0 - r2) * (1.0 - r2);
      float fl = max(0.0, 1.0 + tb * 0.45 * knots);
      vec3 col = vec3(1.0, 0.97, 0.94) * c.a * core * fl + c.rgb * (sheath * fl + vFx.w * glow * vec3(0.35, 0.65, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }`,
    true,
  );
}

/**
 * Discs, drawn on a quad in world space. A ripple is a shock front in a plane
 * (the palm's): sharp outside, a soft wake behind it, a little uneven so it
 * never reads as a drawn circle. A shell is a thin sphere of glowing plasma
 * facing the camera: its brightness follows the path length through it, so
 * its limb glows and its middle is faint, as a real one would look.
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
      attribute vec4 aRing; // radius, thickness (both of the quad's half-size), front intensity, fill intensity
      attribute vec2 aKind; // ripple (0) or shell (1); seed
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vRing;
      varying vec2 vKind;
      void main() {
        vUv = aUv;
        vColor = color;
        vRing = aRing;
        vKind = aKind;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vRing;
      varying vec2 vKind;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float fw = fwidth(r);
        float R = vRing.x;
        float ang = atan(vUv.y, vUv.x);
        vec3 c;
        if (vKind.x < 0.5) {
          float Rw = R * (1.0 + 0.02 * sin(ang * 7.0 + vKind.y) + 0.015 * sin(ang * 13.0 - vKind.y * 1.7));
          float th = max(vRing.y, fw * 1.5);
          float x = (r - Rw) / th;
          float front = x > 0.0 ? exp(-x * x * 4.0) : exp(-x * x * 0.45);
          float fill = 1.0 - smoothstep(0.0, Rw, r);
          c = vColor * (front * vRing.z + fill * vRing.w) + vec3(1.0) * front * vRing.z * 0.3 * exp(-x * x * 6.0);
        } else {
          float h = max(vRing.y, fw * 2.0);
          float Ri = max(R - h, 0.0);
          float L = (sqrt(max(R * R - r * r, 0.0)) - sqrt(max(Ri * Ri - r * r, 0.0))) / sqrt(max(R * R - Ri * Ri, 1e-6));
          L *= 1.0 - smoothstep(R - fw, R + fw, r);
          // A ragged front, not a clean bubble: brighter and fainter lobes round the limb.
          L *= 0.65 + 0.35 * sin(ang * 5.0 + vKind.y) * sin(ang * 3.0 - vKind.y * 0.7) + 0.15 * sin(ang * 11.0 + vKind.y * 2.1);
          float fill = exp(-r * r / max(0.3 * Ri * Ri, 1e-4));
          c = vColor * (L * vRing.z + fill * vRing.w);
        }
        gl_FragColor = vec4(c * (1.0 - smoothstep(0.85, 1.0, r)), 1.0);
      }`,
  });
}

/** A pool of ribbons (4 vertices each, every attribute repeated per vertex), drawn as one mesh. */
function ribbonPool(n, material, fx) {
  const g = new THREE.BufferGeometry();
  const A = new Float32Array(n * 4 * 3);
  const B = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const W = new Float32Array(n * 4 * 2);
  const colA = new Float32Array(n * 4 * 4);
  const colB = new Float32Array(n * 4 * 4);
  const F = fx ? new Float32Array(n * 4 * 4) : null;
  const idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    corner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
  }
  const dyn = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', dyn(A, 3));
  g.setAttribute('aB', dyn(B, 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aW', dyn(W, 2));
  g.setAttribute('aColA', dyn(colA, 4));
  g.setAttribute('aColB', dyn(colB, 4));
  if (fx) g.setAttribute('aFx', dyn(F, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 16;
  const names = fx ? ['position', 'aB', 'aW', 'aColA', 'aColB', 'aFx'] : ['position', 'aB', 'aW', 'aColA', 'aColB'];
  let count = 0;
  return {
    mesh,
    begin() {
      count = 0;
    },
    /** Ribbon a -> b: half-widths wa, wb (world); colours (sheath rgb x intensity, core intensity) at each end; fx (beams): seed, turbulence, glow. */
    add(a, b, wa, wb, r0, g0, b0, k0, r1, g1, b1, k1, seed = 0, turb = 0, glow = 0) {
      if (count >= n) return;
      const len = fx ? a.distanceTo(b) : 0;
      for (let v = 0; v < 4; v++) {
        const j = count * 4 + v;
        A[j * 3] = a.x;
        A[j * 3 + 1] = a.y;
        A[j * 3 + 2] = a.z;
        B[j * 3] = b.x;
        B[j * 3 + 1] = b.y;
        B[j * 3 + 2] = b.z;
        W[j * 2] = wa;
        W[j * 2 + 1] = wb;
        colA[j * 4] = r0;
        colA[j * 4 + 1] = g0;
        colA[j * 4 + 2] = b0;
        colA[j * 4 + 3] = k0;
        colB[j * 4] = r1;
        colB[j * 4 + 1] = g1;
        colB[j * 4 + 2] = b1;
        colB[j * 4 + 3] = k1;
        if (fx) {
          F[j * 4] = seed;
          F[j * 4 + 1] = len;
          F[j * 4 + 2] = turb;
          F[j * 4 + 3] = glow;
        }
      }
      count++;
    },
    end() {
      g.setDrawRange(0, count * 6);
      if (count) for (const name of names) g.attributes[name].needsUpdate = true;
    },
  };
}

export function createRepulsors() {
  const group = new THREE.Group();

  const streaks = ribbonPool(STREAKS, streakMaterial(), false);
  const beams = ribbonPool(BEAMS, beamMaterial(), true);
  const streak = streaks.add;
  const beam = beams.add;

  // Discs: 4 vertices each.
  const dGeo = new THREE.BufferGeometry();
  const dPos = new Float32Array(DISCS * 4 * 3);
  const dUv = new Float32Array(DISCS * 4 * 2);
  const dCol = new Float32Array(DISCS * 4 * 3);
  const dRing = new Float32Array(DISCS * 4 * 4);
  const dKind = new Float32Array(DISCS * 4 * 2);
  const dIdx = new Uint16Array(DISCS * 6);
  for (let i = 0; i < DISCS; i++) {
    dIdx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    dUv.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
  }
  const dyn = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
  dGeo.setAttribute('position', dyn(dPos, 3));
  dGeo.setAttribute('aUv', new THREE.BufferAttribute(dUv, 2));
  dGeo.setAttribute('color', dyn(dCol, 3));
  dGeo.setAttribute('aRing', dyn(dRing, 4));
  dGeo.setAttribute('aKind', dyn(dKind, 2));
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

  // A short-range light at each palm: the charge and the flash light his hand,
  // forearm and chest. Always present (intensity 0 when idle), so the suit's
  // shaders never recompile.
  const palmLights = {
    L: new THREE.PointLight(0xbfe6ff, 0, PALM_LIGHT_RANGE, 2),
    R: new THREE.PointLight(0xbfe6ff, 0, PALM_LIGHT_RANGE, 2),
  };
  group.add(discs, beams.mesh, streaks.mesh, glows, sparks, palmLights.L, palmLights.R);

  // The brightest muzzle flash and impact this frame, for the dust round them
  // to catch (view3d reads these): where, how much brighter, over what radius.
  const flashes = [
    { p: new THREE.Vector3(), k: 0, r: 1 },
    { p: new THREE.Vector3(), k: 0, r: 1 },
  ];
  group.userData.flashes = flashes;

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
    tau: 0.02,
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
  const lightK = { L: 0, R: 0 };
  const lightAt = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const ready = { L: false, R: false }; // each hand up on a word and firing on its schedule
  const out = { fired: { L: 0, R: 0 }, light: 0 }; // update()'s result, reused every frame

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
  let ng = 0;
  let nd = 0;
  /** A glow at p: world diameter, halo colour x intensity, white core intensity (< 0: a soft wisp, no core). */
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
  /** A disc at p spanned by unit vectors u, v: radius R and thickness th (world), colour, front and fill intensities, kind, seed. */
  function disc(p, u, v, R, th, r, g, b, ring, fill, kind, seed) {
    if (nd >= DISCS) return;
    const h = R + 2 * th;
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
      dKind[j * 2] = kind;
      dKind[j * 2 + 1] = seed;
    }
    nd++;
  }
  /** Offer a flash to the dust: keep the brightest muzzle (slot 0) and impact (slot 1). */
  function flashAt(slot, p, k, r) {
    const f = flashes[slot];
    if (k <= f.k) return;
    f.p.copy(p);
    f.k = k;
    f.r = r;
  }

  /** Two unit vectors spanning the plane with normal n. */
  function basis(n, u, v) {
    u.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    v.copy(n).cross(u);
  }
  /** out = a unit vector from hashes h1, h2 (uniform on the sphere). */
  function sphereDir(h1, h2, out) {
    const z = 2 * h1 - 1;
    const ph = 2 * Math.PI * h2;
    const rr = Math.sqrt(1 - z * z);
    return out.set(rr * Math.cos(ph), rr * Math.sin(ph), z);
  }

  /** Start a blast from slot k of a hand at time T, from the palm at a word. */
  function addShot(side, k, T, palm, at, S) {
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
    s.dir.copy(at).sub(palm);
    s.dist = Math.max(1e-3, s.dir.length());
    s.dir.multiplyScalar(1 / s.dist);
    // The bolt leaves the emitter just off the palm's face.
    s.from.copy(palm).addScaledVector(s.dir, Math.min(0.5 * S, 0.5 * s.dist));
    s.to.copy(at);
    s.dist = Math.max(1e-3, s.from.distanceTo(s.to));
    s.tau = clamp(s.dist / (BOLT_SPEED * S), BOLT_MIN, BOLT_MAX); // the bolt's flight time
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
   * @returns {{fired:{L:number, R:number}, light:number}} blasts fired this frame per hand (the body recoils per blast), and how bright the repulsors burn (lights his armour); the same object every frame
   */
  function update(o) {
    const { dt, time, camera, halfH, unit, scale, palms, soles, head, vel, thrust, fly, targets, aim } = o;
    const aspect = camera.aspect || 1;
    sparks.material.uniforms.uHalfH.value = halfH;
    glows.material.uniforms.uHalfH.value = halfH;
    streaks.mesh.material.uniforms.uHalfRes.value.set(halfH * aspect, halfH);
    beams.mesh.material.uniforms.uHalfRes.value.set(halfH * aspect, halfH);
    beams.mesh.material.uniforms.uTime.value = time;
    camera.getWorldPosition(camPos);
    camR.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camU.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const { fired } = out;
    fired.L = fired.R = 0;
    streaks.begin();
    beams.begin();
    ng = 0;
    nd = 0;
    flashes[0].k = 0;
    flashes[1].k = 0;
    const S = unit;

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
    for (const n of SIDES) {
      ready[n] = aim[n] > 0.5 && elig[n].length > 0;
      if (!ready[n]) continue;
      for (let k = Math.floor(t0 / PERIOD) - 1, k1 = Math.floor(time / PERIOD) + 1; k <= k1; k++) {
        const T = slotTime(n, k);
        if (T <= t0 || T > time) continue;
        const t = targets[elig[n][((k % elig[n].length) + elig[n].length) % elig[n].length]];
        addShot(n, k, T, palms[n], a3.set(t.at[0], t.at[1], t.at[2]), S);
        if (!jumped || T > time - 0.07) fired[n]++;
      }
    }

    // Palms: the emitter's glow while the arm is up, and the charge building to each blast:
    // from idle to white-hot, motes of light spiralling in, its light coming up on the hand.
    let light = 0;
    for (const n of SIDES) {
      const up = clamp((aim[n] - 0.3) / 0.5, 0, 1) * (elig[n].length ? 1 : 0);
      let q = 0;
      lightK[n] = 1.2 * up;
      lightAt[n].copy(palms[n]);
      c3.copy(palms[n]);
      if (ready[n]) {
        let k = Math.floor(time / PERIOD) - 1;
        while (slotTime(n, k) <= time) k++;
        const x = clamp(1 - (slotTime(n, k) - time) / CHARGE, 0, 1);
        q = x * x; // slow to start, racing at the end
        const t = targets[elig[n][((k % elig[n].length) + elig[n].length) % elig[n].length]];
        d3.set(t.at[0], t.at[1], t.at[2]).sub(palms[n]);
        const l = d3.length();
        if (l > 1e-3) {
          d3.multiplyScalar(1 / l);
          c3.addScaledVector(d3, 0.6 * S); // just off the palm's face, so the hand stays in view behind it
          lightAt[n].copy(palms[n]).addScaledVector(d3, 0.9 * S);
          if (q > 0.02) {
            // Intake: motes drawn in from round the palm, swirling as they come.
            basis(d3, u3, v3);
            const seed = hash(k * 0.917 + (n === 'R' ? 5.1 : 2.3)) * 1000;
            for (let i = 0; i < INTAKE_MOTES; i++) {
              const h = hash(seed + i * 3.7);
              const qi = clamp((x - 0.15 * h) / (1 - 0.15 * h), 0, 1); // each starts a little later
              if (qi <= 0 || qi >= 0.97) continue;
              const rho = (0.5 + 2.6 * (1 - qi) * (1 - qi) * (0.8 + 0.4 * h)) * S;
              const th = 2 * Math.PI * (i / INTAKE_MOTES + h * 0.3) + 2.2 * qi;
              const fwd = (0.3 + 1.2 * (1 - qi)) * S;
              a3.copy(palms[n]).addScaledVector(d3, fwd).addScaledVector(u3, rho * Math.cos(th)).addScaledVector(v3, rho * Math.sin(th));
              // Its tail: where it was a moment ago (further out, further back round the swirl).
              const qb = Math.max(0, qi - 0.12);
              const rb = (0.5 + 2.6 * (1 - qb) * (1 - qb) * (0.8 + 0.4 * h)) * S;
              const tb = 2 * Math.PI * (i / INTAKE_MOTES + h * 0.3) + 2.2 * qb;
              b3.copy(palms[n]).addScaledVector(d3, (0.3 + 1.2 * (1 - qb)) * S).addScaledVector(u3, rb * Math.cos(tb)).addScaledVector(v3, rb * Math.sin(tb));
              const m = 0.55 * Math.sin(Math.PI * qi);
              streak(b3, a3, 0.04 * S, 0.11 * S, CYAN[0] * 0.1 * m, CYAN[1] * 0.1 * m, 0.1 * m, 0, CYAN[0] * m, CYAN[1] * m, m, 0.8 * m);
            }
          }
        }
      }
      if (up > 0.01 || q > 0.01) {
        const fl = 0.94 + 0.06 * Math.sin(time * 61 + (n === 'L' ? 0 : 2));
        const h = (0.12 * up + 0.55 * q) * fl;
        glow(c3, (1.1 + 0.9 * q) * S, CYAN[0] * h, CYAN[1] * h, h, (0.15 * up + 2 * q * q) * fl);
      }
      lightK[n] += 45 * q;
      light += 0.08 * up + 0.3 * q;
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

      // Muzzle: the cannon going off at the palm face. A small white-hot core just ahead of the
      // palm (never a glare over the hand), a short jet of plasma down the line of fire, a shock
      // ripple in the palm plane and a few fast sparks; the flash lights the hand, suit and dust.
      if (a < 0.24) {
        const f = Math.exp(-a / 0.03);
        e3.copy(palm).addScaledVector(dir, 1.1 * S);
        glow(e3, (1.3 + 0.9 * (1 - Math.exp(-a / 0.012))) * S, CYAN[0] * 0.45 * f, CYAN[1] * 0.45 * f, 0.45 * f, 2.6 * f);
        lightK[s.side] += 260 * f;
        lightAt[s.side].copy(palm).addScaledVector(dir, 1.2 * S);
        light += 1.1 * f;
        flashAt(0, e3, 1.4 * f, 22 * S);
        const fj = Math.exp(-a / 0.045);
        if (fj > 0.02) {
          a3.copy(palm).addScaledVector(dir, 0.4 * S);
          b3.copy(palm).addScaledVector(dir, (0.4 + 5.5 * (1 - Math.exp(-a / 0.015))) * S);
          beam(a3, b3, 0.85 * S, 0.3 * S, CYAN[0] * 0.5 * fj, CYAN[1] * 0.5 * fj, 0.5 * fj, 1.6 * fj, CYAN[0] * 0.2 * fj, CYAN[1] * 0.2 * fj, 0.2 * fj, 0.3 * fj, seed + 7, 1, 0.3);
        }
        // The rings lie across the line of fire, turned a touch toward the camera so they never quite collapse to a line.
        d3.copy(camPos).sub(palm).normalize();
        n3.copy(dir).addScaledVector(d3, 0.15).normalize();
        basis(n3, u3, v3);
        if (a < 0.1) {
          const fr = Math.exp(-a / 0.026);
          const R = (0.6 + 2.2 * (1 - Math.exp(-a / 0.025))) * S;
          e3.copy(palm).addScaledVector(dir, (0.5 + 8 * a) * S);
          disc(e3, u3, v3, R, 0.14 * R, CYAN[0], CYAN[1], CYAN[2], 0.8 * fr, 0.05 * fr, RIPPLE, seed);
        }
        // Pushback: the blast's backwash, a thin ring blown back past the hand and wrist, wider
        // than the hand so it frames it rather than covering it, and gas venting back round it.
        if (a < 0.2) {
          const fb = (1 - Math.exp(-a / 0.012)) * Math.exp(-a / 0.05);
          const back = 4.5 * (1 - Math.exp(-a / 0.05)) * S;
          const R = (1.4 + 2.4 * (1 - Math.exp(-a / 0.04))) * S;
          e3.copy(palm).addScaledVector(dir, 0.3 * S - back);
          disc(e3, u3, v3, R, 0.07 * R, CYAN[0], CYAN[1], CYAN[2], 0.75 * fb, 0, RIPPLE, seed + 5.3);
        }
        basis(dir, u3, v3);
        for (let i = 0; i < EXHAUST; i++) {
          const life = 0.12 + 0.1 * hash(seed + i * 6.1);
          if (a > life) continue;
          // Out from the rim of the palm, swept back past the hand.
          const th = 2 * Math.PI * ((i + 0.5 * hash(seed + i * 2.7)) / EXHAUST);
          c3.copy(u3).multiplyScalar(Math.cos(th)).addScaledVector(v3, Math.sin(th));
          e3.copy(palm).addScaledVector(c3, 1.1 * S);
          c3.multiplyScalar(0.8 + 0.4 * hash(seed + i * 4.9)).addScaledVector(dir, -0.9).normalize();
          const spd = (35 + 35 * hash(seed + i * 8.3)) * S;
          const kd = 9; // the gas spreads and slows
          const x1 = (spd * (1 - Math.exp(-kd * a))) / kd;
          const x0 = (spd * (1 - Math.exp(-kd * Math.max(0, a - 0.025)))) / kd;
          a3.copy(e3).addScaledVector(c3, x0);
          b3.copy(e3).addScaledVector(c3, x1);
          const u = a / life;
          const k = 0.45 * (1 - u) * (1 - u);
          streak(a3, b3, 0.05 * S, 0.16 * S, BLUE[0] * 0.3 * k, BLUE[1] * 0.3 * k, BLUE[2] * 0.3 * k, 0, CYAN[0] * k, CYAN[1] * k, k, 0.4 * k);
        }
        for (let i = 0; i < MUZZLE_SPARKS; i++) {
          const life = 0.06 + 0.08 * hash(seed + i * 5.7);
          if (a > life) continue;
          // Mostly down the line of fire, a few flung wide.
          const th = 2 * Math.PI * hash(seed + i * 3.1);
          const spread = 0.25 + 1.1 * hash(seed + i * 9.2) ** 2;
          c3.copy(u3).multiplyScalar(Math.cos(th) * spread).addScaledVector(v3, Math.sin(th) * spread).add(dir).normalize();
          const spd = (90 + 200 * hash(seed + i * 7.3)) * S;
          a3.copy(palm).addScaledVector(dir, 0.6 * S).addScaledVector(c3, spd * Math.max(0, a - 0.012));
          b3.copy(palm).addScaledVector(dir, 0.6 * S).addScaledVector(c3, spd * a + 0.4 * S);
          const u = a / life;
          const k = (1 - u) * (1 - u);
          streak(a3, b3, 0.05 * S, 0.12 * S, CYAN[0] * 0.3 * k, CYAN[1] * 0.3 * k, 0.3 * k, 0, CYAN[0] * k, CYAN[1] * k, k, 1.4 * k);
        }
      }

      // The bolt: a white-hot slug in a cyan sheath, motion-blurred to about a frame of its travel,
      // leaving the palm along its line of fire and crossing to the word at a speed the eye can follow.
      const v = dist / tau;
      const x = v * a;
      const xHead = Math.min(x, dist);
      const xTail = Math.min(Math.max(0, x - BOLT_LEN * S), dist);
      if (xHead - xTail > 0.01 * S) {
        a3.copy(s.from).addScaledVector(dir, xTail);
        b3.copy(s.from).addScaledVector(dir, xHead);
        const k = 1 + 0.4 * Math.exp(-a / 0.03); // hottest as it leaves the hand
        beam(a3, b3, 0.25 * S, BOLT_W * S, CYAN[0] * 0.08 * k, CYAN[1] * 0.08 * k, 0.08 * k, 0.15 * k, CYAN[0] * 0.55 * k, CYAN[1] * 0.55 * k, 0.55 * k, 2.6 * k, seed, 1, 0.5);
        if (x < dist) glow(b3, 2.2 * S, CYAN[0] * 0.35 * k, CYAN[1] * 0.35 * k, 0.35 * k, 1.3 * k);
      }
      // The ionised trail it leaves: faint, spreading a little, fading from the palm end
      // (each point by how long ago the bolt passed it).
      {
        const ageA = a;
        const ageB = Math.max(0, a - xTail / v);
        const kB = 0.09 * Math.exp(-ageB / TRAIL_TAU);
        if (kB > 0.003 && xTail > 0.01 * S) {
          const kA = 0.09 * Math.exp(-ageA / TRAIL_TAU);
          b3.copy(s.from).addScaledVector(dir, xTail);
          beam(s.from, b3, (0.35 + 2.5 * ageA) * S, (0.35 + 2.5 * ageB) * S, BLUE[0] * kA, BLUE[1] * kA, BLUE[2] * kA, 0, CYAN[0] * kB, CYAN[1] * kB, kB, 0.25 * kB, seed + 3, 0.6, 1.1);
        }
      }

      // Impact: a hot white point as the bolt dumps its energy, an expanding shell of plasma,
      // sparks and embers flying straight out and cooling, a faint wisp dissipating.
      const ai = a - tau;
      if (ai >= 0) {
        const pk = Math.exp(-ai / 0.03);
        const hk = 0.85 * pk + 0.1 * Math.exp(-ai / 0.18);
        glow(s.to, (2.8 + 2.4 * (1 - Math.exp(-ai / 0.02))) * S, CYAN[0] * hk, CYAN[1] * hk, hk, 4 * pk);
        flashAt(1, s.to, 2.6 * pk + 0.3 * Math.exp(-ai / 0.12), 26 * S);
        if (ai < 0.12) {
          const R = (0.6 + 4.6 * (1 - Math.exp(-ai / 0.03))) * S;
          const fs = Math.exp(-ai / 0.025);
          disc(s.to, camR, camU, R, 0.08 * R, CYAN[0], CYAN[1], CYAN[2], 1.1 * fs, 0.12 * fs * pk, SHELL, seed);
        }
        // Flung back toward the shooter and out sideways, in straight lines (no gravity, no air);
        // a little spin-down so they settle rather than vanish at speed.
        for (let i = 0; i < IMPACT_SPARKS; i++) {
          const life = 0.18 + 0.3 * hash(seed + i * 2.91);
          if (ai > life) continue;
          sphereDir(hash(seed + i * 4.13), hash(seed + i * 6.71), c3).addScaledVector(dir, -0.7).normalize();
          const h1 = hash(seed + i * 1.37);
          const spd = (45 + 170 * h1 * h1) * S;
          const kd = 2.5;
          const x1 = (spd * (1 - Math.exp(-kd * ai))) / kd;
          const x0 = (spd * (1 - Math.exp(-kd * Math.max(0, ai - 0.016)))) / kd;
          a3.copy(s.to).addScaledVector(c3, x0);
          b3.copy(s.to).addScaledVector(c3, x1);
          const u = ai / life;
          const f = (1 - u) * (1 - u);
          const cool = Math.exp(-ai / 0.07); // white-hot, cooling to cyan
          streak(a3, b3, 0.04 * S, 0.13 * S, BLUE[0] * 0.3 * f, BLUE[1] * 0.3 * f, BLUE[2] * 0.3 * f, 0, CYAN[0] * 1.2 * f, CYAN[1] * 1.2 * f, 1.2 * f, 2.4 * f * cool);
        }
        for (let i = 0; i < IMPACT_EMBERS; i++) {
          const life = 0.45 + 0.55 * hash(seed + i * 8.17);
          const ae = ai - 0.01;
          if (ae < 0 || ae > life) continue;
          sphereDir(hash(seed + i * 3.33), hash(seed + i * 5.55), c3).addScaledVector(dir, -0.3).normalize();
          const spd = (8 + 26 * hash(seed + i * 9.91)) * S;
          a3.copy(s.to).addScaledVector(c3, spd * ae);
          const u = ae / life;
          const tw = 0.75 + 0.25 * Math.sin(time * 37 + i * 2.1 + seed);
          const k = (1 - u) * (1 - u) * tw;
          const cool = Math.exp(-ae / 0.12);
          // White, then cyan, then a dim blue as it fades.
          glow(a3, 0.7 * S, (CYAN[0] * (1 - u) + BLUE[0] * u) * 0.5 * k, (CYAN[1] * (1 - u) + BLUE[1] * u) * 0.5 * k, 0.5 * k, 1.2 * k * cool);
        }
        for (let i = 0; i < IMPACT_WISPS; i++) {
          const aw = ai - 0.02;
          if (aw < 0 || aw > 0.7) continue;
          sphereDir(hash(seed + i * 7.07), hash(seed + i * 2.22), c3).addScaledVector(dir, -0.5).normalize();
          a3.copy(s.to).addScaledVector(c3, (1.2 + 9 * aw) * S);
          const k = 0.04 * (1 - Math.exp(-aw / 0.04)) * Math.exp(-aw / 0.16);
          glow(a3, (2.5 + 7 * aw) * S, CYAN[0] * 0.6 * k, CYAN[1] * 0.8 * k, k, -1);
        }
      }
    }

    // Thrusters: a jet plume from each boot (off the ground) and palm (in flight, or
    // steadying a hover), streaming away from his head: white-hot at the nozzle, into a
    // cyan sheath that widens and fades to blue, flickering down its length, with faint shock diamonds.
    d3.copy(head).multiplyScalar(-1).normalize();
    for (let i = 0; i < 4; i++) {
      const isPalm = i >= 2;
      const pw = isPalm ? thrust * (0.35 + 0.65 * fly) : thrust;
      if (pw < 0.02) continue;
      const p = isPalm ? palms[i === 2 ? 'L' : 'R'] : soles[i];
      const sz = unit * scale * (isPalm ? 0.8 : 1);
      // Flicker: the plume breathes in length and brightness.
      const fl = 0.88 + 0.08 * Math.sin(time * 53 + i * 1.7) + 0.04 * Math.sin(time * 131 + i * 4.1);
      const L = (5 + 8 * fly + 2 * thrust) * sz * (0.9 + 0.1 * Math.sin(time * 37 + i * 2.3)) * pw;
      const k = pw * fl;
      b3.copy(p).addScaledVector(d3, L);
      beam(p, b3, 1.1 * sz, 2.6 * sz, CYAN[0] * 0.5 * k, CYAN[1] * 0.5 * k, 0.5 * k, 1.2 * k, BLUE[0] * 0.05 * k, BLUE[1] * 0.05 * k, BLUE[2] * 0.05 * k, 0, 17.3 * i, 1.6, 0.5);
      // Shock diamonds: small bright knots spaced down the core, each fainter.
      for (let j = 0; j < 3; j++) {
        const at = (0.2 + 0.17 * j) * L;
        const h = 0.07 * L;
        const kd = k * (0.4 - 0.1 * j) * (0.8 + 0.2 * Math.sin(time * 71 + i * 3 + j * 2));
        a3.copy(p).addScaledVector(d3, at - h);
        b3.copy(p).addScaledVector(d3, at);
        streak(a3, b3, 0.08 * sz, (0.4 - 0.06 * j) * sz, CYAN[0] * kd, CYAN[1] * kd, kd, 0, CYAN[0] * kd, CYAN[1] * kd, kd, 0.9 * kd);
        a3.copy(p).addScaledVector(d3, at + h);
        streak(b3, a3, (0.4 - 0.06 * j) * sz, 0.08 * sz, CYAN[0] * kd, CYAN[1] * kd, kd, 0.9 * kd, CYAN[0] * kd, CYAN[1] * kd, kd, 0);
      }
      // The nozzle itself, white-hot.
      e3.copy(p).addScaledVector(d3, 0.3 * sz);
      glow(e3, 3 * sz, CYAN[0] * 0.3 * k, CYAN[1] * 0.3 * k, 0.3 * k, 1.1 * k);
      if (isPalm) {
        light += 0.5 * pw;
        lightK[i === 2 ? 'L' : 'R'] += 25 * pw;
        lightAt[i === 2 ? 'L' : 'R'].copy(e3);
      }
    }

    streaks.end();
    beams.end();
    dGeo.setDrawRange(0, nd * 6);
    if (nd) for (const name of DISC_ATTRS) dGeo.attributes[name].needsUpdate = true;
    glows.geometry.setDrawRange(0, ng);
    if (ng) for (const name of GLOW_ATTRS) glows.geometry.attributes[name].needsUpdate = true;
    for (const n of SIDES) {
      palmLights[n].position.copy(lightAt[n]);
      palmLights[n].intensity = lightK[n];
      palmLights[n].distance = PALM_LIGHT_RANGE * S;
    }

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
    for (const name of SPARK_ATTRS) sparks.geometry.attributes[name].needsUpdate = true;
    out.light = Math.min(light, 2);
    return out;
  }

  return { group, update };
}
