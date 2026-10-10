/**
 * A fighter's energy weapons and thrusters, in world space: Iron Man's
 * repulsor blasts (and, with the Power Stone's palette, Thanos's gauntlet),
 * fired from the palms at the words being read and at the opponent, and the
 * jet plumes from boots and palms. It decides when each blast fires and
 * reports it (the body recoils on it), reports what each blast struck, and
 * lights the armour, the opponent and the dust round its flashes.
 *
 * The look is held to what plasma, light and metal would do on film, shot at
 * 24 fps with a 180-degree shutter (1/48 s), rather than to game sprites:
 * - charge (0.3 s): the palm emitter comes up to white-hot, motes of light
 *   spiralling into it, its light spilling onto the hand and forearm;
 * - discharge: an overexposed flash for a frame or two just off the palm, the
 *   hand and arm lit hard by a real light that dies in a few frames, a faint
 *   shock ripple, the air over the palm shimmering (screen-space heat haze);
 * - bolt: a short, white-hot, slightly elongated plasma slug in a sheath of
 *   the palette's colour, smeared by the shutter into a streak as long as its
 *   speed x 1/48 s, flickering with turbulence, lighting what it passes, and
 *   leaving a faint ionised trail and a ribbon of heat haze in the air. The
 *   Power Stone's is heavier and more violent: a thicker, writhing violet
 *   sheath with small arcs crawling round the core;
 * - impact on a fighter: a very short HDR flash with a real point light that
 *   lights both fighters and the dust; a shock front that refracts the view
 *   behind it and a fast, thin, expanding shell; sparks that behave like metal
 *   (thrown out fast, slowed by drag, pulled down by gravity, cooling white ->
 *   yellow -> orange -> dark red, some bouncing off the ground below) or, for
 *   the Power Stone, violet crackle with a few hot metal sparks off the
 *   armour; glowing embers; a puff of dark smoke lit by the flash, slowly
 *   expanding and rising for a second and a half; for the Power Stone, violet
 *   arcs crawling over the struck area for half a second; a camera kick.
 *   Heavy hits (power >= 0.8) are bigger in every respect, with tumbling debris;
 * - impact on a word: a small, clean burst (a reading effect, not combat).
 *
 * Timing is a pure function of the animation clock: the slot schedule fires
 * slot k of a hand at a fixed, jittered time, explicit shots fire at their
 * tFire, and every drawn element of a blast is evaluated at its age, so a seek
 * shows what live playback would. Sparks, smoke and debris are simulated
 * (gravity, drag, bounces); after a seek they are re-run from their impact.
 */

import * as THREE from 'three';
import { createDistortPool, registerFx } from './distort.js';
import { kick } from './shake.js';

const STREAKS = 1200; // sparks' motion blur, arcs, intake motes, shock diamonds, exhaust
const RIBBONS = 64; // bolts, muzzle jets, trails, thruster plumes
const QUADS = 360; // flashes, glows, embers, wisps, glare, ripples and shells
const SMOKES = 96; // smoke puffs
const PARTS = 480; // simulated impact sparks, crackle and embers
const CHUNKS = 32; // debris (heavy hits)
const DISTORTS = 160; // heat haze and shock fronts
const SHOTS = 32; // blasts alive at once (both hands)
const EXHAUST = 120; // thruster exhaust sparks

const PERIOD = 0.85; // seconds between one hand's blasts (jittered to 0.65-1.05 s); the other hand fires halfway between
const DUEL_PERIOD = 0.42; // ... at an opponent (target ids < 0): a volley
const DUEL_IMPACT = 2.6; // a blast striking an opponent bursts this much bigger than on a word
const JITTER = 0.22; // of a period
const CHARGE = 0.3; // seconds the palm takes to come up to white-hot before a blast
const AFTER = 0.9; // seconds a blast's own drawn aftermath lasts past its arrival (its sparks, smoke and debris live on)
const REFILL = 2.6; // after a seek, blasts fired up to this long before are put back (their smoke still hangs)
const BOLT_SPEED = 520; // world units a second (at unit 1): slow enough for the eye to follow it out of the hand
const BOLT_MIN = 0.15; // ... though a near target still takes this long (seconds)
const BOLT_MAX = 0.35; // ... and a far one no longer
const SHUTTER = 1 / 48; // film shutter: a moving thing is smeared over its travel in this long
const SLUG = 1.8; // the white-hot slug's own length (world units at unit 1); the shutter adds the rest
const BOLT_W = 0.7; // the bolt's half-width (outer glow) at the head; the palm is about 2 wide
const TRAIL_TAU = 0.16; // seconds: how fast the ionised trail behind the bolt fades
const MISS_RUN = 1.5; // a miss flies on to this many times its distance to the target, fading
const GRAVITY = 200; // world units/s^2 (9.8 m/s^2 on figures 46-51 units tall)
const HEAVY = 0.8; // power from which a hit is heavy
const SURFACE = 1.6; // world units (x unit) a hit on a fighter bursts short of the aim point, toward the shooter: on his armour
const MUZZLE_SPARKS = 6;
const EXHAUST_GAS = 8; // gas venting back round the hand: the pushback
const INTAKE_MOTES = 6;
const PALM_LIGHT_RANGE = 20; // world units (at unit 1) a palm's light reaches: the hand, the forearm, a little of the chest
// Lights (candela). The scene's key light is a directional 2.4: an impact's flash, IMPACT_BACK units off the
// armour toward the shooter, is ~50x that on the armour it strikes and ~1x on the shooter 60-80 units away.
// (None may sit much closer to a glossy surface than its own few units: a half-float buffer overflows.)
const IMPACT_LIGHT = 7000; // at the peak of a blast striking a fighter (it lights both, and the dust)
const IMPACT_BACK = 10; // world units it stands off the struck armour, toward the shooter
const BOLT_LIGHT = 280; // a bolt in flight (x unit), once clear of the hand
const MUZZLE_LIGHT = 450; // the palm's flash as it fires (x power)
const IMPACT_LIGHT_RANGE = 320; // world units
const SIDES = ['L', 'R'];
const NONE = [];

// Quad kinds (glows and discs share a pool).
const GLOW = 0; // a hot point of light seen through a lens
const WISP = 1; // soft glowing gas
const RIPPLE = 2; // a shock front in a plane
const SHELL = 3; // a thin sphere of plasma, facing the camera
const GLARE = 4; // veiling glare round an overexposed flash

// Simulated particle kinds.
const METAL = 0; // an incandescent metal spark (gravity, drag, bounces, cooling)
const CRACKLE = 1; // a fleck of the Power Stone's energy, flickering
const EMBER = 2; // a slow glowing fragment (drawn as a glow)
const MOTE = 3; // a spark of the palette's energy, no gravity (words, misses)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Stable hash in [0, 1). */
const hash = (x) => {
  const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** When slot k of a hand fires (seconds on the animation clock); the right hand is half a period behind. */
const slotTime = (side, k, P = PERIOD) => (k + (side === 'R' ? 0.5 : 0) + JITTER * (hash(k * 1.731 + (side === 'R' ? 91.7 : 13.3)) - 0.5)) * P;
/** A bolt's flight time over a distance (seconds) at a unit. */
const flight = (dist, S) => clamp(dist / (BOLT_SPEED * S), BOLT_MIN, BOLT_MAX);

// Repulsor colours (linear): a white-hot core, a cyan sheath, a deep blue edge (another palette can be
// passed to createRepulsors, e.g. the Power Stone's purple for Thanos's gauntlet).
const CYAN0 = [0.32, 0.74, 1.0];
const BLUE0 = [0.12, 0.38, 1.0];

// Incandescence, cool to hot (linear rgb at a temperature 0..1): dark red, orange, yellow, white.
const BB = [
  [0.0, 0, 0, 0],
  [0.15, 0.3, 0.025, 0.004],
  [0.3, 0.95, 0.16, 0.025],
  [0.5, 1.0, 0.42, 0.08],
  [0.7, 1.0, 0.72, 0.3],
  [0.88, 1.0, 0.93, 0.74],
  [1.0, 1.0, 1.0, 1.0],
];
/** out = the colour of metal at temperature T (0..1+), times its brightness (HDR). */
function blackbody(T, out) {
  const t = clamp(T, 0, 1);
  let i = 1;
  while (i < BB.length - 1 && BB[i][0] < t) i++;
  const a = BB[i - 1];
  const b = BB[i];
  const f = (t - a[0]) / (b[0] - a[0]);
  const I = 0.3 + 7 * T * T * T;
  out[0] = (a[1] + (b[1] - a[1]) * f) * I;
  out[1] = (a[2] + (b[2] - a[2]) * f) * I;
  out[2] = (a[3] + (b[3] - a[3]) * f) * I;
  return out;
}

/*
 * Ribbons: segments drawn as screen-space quads with round caps. Each end has
 * its own half-width and colour (rgb = sheath, a = white-hot core), so a
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
    uniforms: { uHalfRes: { value: new THREE.Vector2(450, 450) }, uMinPx: { value: 1.4 }, uTime: { value: 0 } },
    defines: beam ? { BEAM: '' } : {},
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, // built in screen space: the winding depends on which way it points
    vertexShader: RIBBON_VERTEX,
    fragmentShader,
  });
}

/** Streaks: a spark's motion blur, an arc's segment, a mote, a shock diamond. */
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
      float core = exp(-r2 * 22.0);
      vec3 col = c.rgb * sheath + vec3(1.0, 0.97, 0.92) * c.a * core + c.rgb * c.a * 0.5 * exp(-r2 * 8.0);
      gl_FragColor = vec4(col * win, 1.0);
    }`);
}

/**
 * Beams: a ribbon with a real radial profile, a white-hot core inside a
 * sheath inside a soft glow, each kept at least about a pixel wide (and dimmed
 * to match) so a distant one stays a clean line. Turbulence travels down it:
 * knots of brightness and a writhe of the core, in world units along it, so it
 * flickers like a stream of plasma rather than a tube. A bolt (glow < 0) is
 * drawn tail (A) to head (B): its core gathers into a slug at the head.
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
      float r2 = (dx * dx + vP.y * vP.y) / (w * w);
      if (r2 > 1.0) discard;
      float s = mix(vSeg.x, vSeg.y, t) * vFx.y; // world distance from A
      float tb = vFx.z;
      bool bolt = vFx.w < 0.0;
      float knots = 0.6 * noise(s * 0.45 - uTime * 110.0) + 0.4 * noise(s * 1.3 - uTime * 190.0 + 7.0);
      float writhe = 0.05 * noise(s * 0.7 + uTime * 47.0 + 3.0) + 0.025 * noise(s * 2.3 - uTime * 83.0 + 11.0);
      if (bolt) writhe = 0.07 * noise(s * 0.9 + uTime * 70.0 + 3.0) + 0.05 * noise(s * 2.9 - uTime * 150.0 + 11.0);
      float y = vP.y - tb * w * writhe;
      float d2 = dx * dx + y * y;
      vec4 c = mix(vColA, vColB, t);
      float wc = max((bolt ? 0.17 : 0.13) * w, 0.7);
      float ws = max((bolt ? 0.42 : 0.38) * w, 1.2);
      float core = exp(-d2 / (wc * wc)) * ((bolt ? 0.17 : 0.13) * w / wc);
      float sheath = exp(-d2 / (ws * ws)) * ((bolt ? 0.42 : 0.38) * w / ws);
      float glow = exp(-r2 * 3.0) * (1.0 - r2) * (1.0 - r2);
      float fl = max(0.0, 1.0 + tb * 0.45 * knots);
      vec3 col;
      if (bolt) {
        // The slug: the core swells and burns hottest over the head's last stretch.
        float slug = smoothstep(0.45, 0.92, t);
        col = vec3(1.0, 0.97, 0.94) * c.a * core * fl * (0.35 + 1.3 * slug) + c.rgb * (sheath * fl + (-vFx.w) * glow);
      } else {
        col = vec3(1.0, 0.97, 0.94) * c.a * core * fl + c.rgb * (sheath * fl + vFx.w * glow * vec3(0.35, 0.65, 1.0));
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
    true,
  );
}

/** Set an attribute to upload only its first n items this frame. */
function upload(attr, n) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
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
    /** Ribbon a -> b: half-widths wa, wb (world); colours (sheath rgb x intensity, core intensity) at each end; fx (beams): seed, turbulence, glow (< 0: a bolt). */
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
      if (count) for (const name of names) upload(g.attributes[name], count * 4);
      mesh.visible = count > 0;
    },
    get count() {
      return count;
    },
  };
}

/**
 * Glows and discs, on quads. A billboard (aQ.x > 0: its half-size) faces the
 * camera; one smaller than a few pixels keeps its energy rather than its size,
 * so distant glows stay small and crisp instead of swelling into blobs, and it
 * can be pulled toward the lens along the line of sight (aQ.w, world units),
 * which leaves it where it is on screen but in front of the body it bursts on.
 * A ripple's corners are given in world space (aQ.x = 0), in its own plane.
 * - glow: a point of light seen through a lens, a tight white-hot core, a
 *   short halo and a glare skirt that falls off like 1/r^2;
 * - wisp: soft glowing gas; glare: the wide, faint veil round a blinding flash;
 * - ripple: a shock front in a plane, sharp outside, a soft wake behind it, a
 *   little uneven so it never reads as a drawn circle;
 * - shell: a thin sphere of plasma: its brightness follows the path length
 *   through it, so its limb glows and its middle is faint.
 */
function quadMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uHalfH: { value: 450 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec3 color;
      attribute vec4 aQ; // half-size (0: the corners are given), p1, p2, pull
      attribute vec4 aK; // kind, seed, p3, p4
      uniform float uHalfH;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vQ;
      varying vec4 vK;
      varying float vGain;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float gain = 1.0;
        if (aQ.x > 0.0) {
          float depth = max(1.0, -mv.z);
          float px = 2.0 * aQ.x * projectionMatrix[1][1] * uHalfH / depth;
          float s = max(px, 6.0);
          gain = px / s;
          mv.xy += aCorner * aQ.x * (s / px);
          float L = length(mv.xyz);
          mv.xyz *= max(1.0 - aQ.w / L, min(1.0, 3.0 / L));
        }
        gl_Position = projectionMatrix * mv;
        vUv = aCorner;
        vColor = color * gain;
        vGain = gain;
        vQ = aQ;
        vK = aK;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec4 vQ;
      varying vec4 vK;
      varying float vGain;
      void main() {
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        float kind = vK.x;
        vec3 c;
        if (kind < 0.5) {
          float core = vQ.y * vGain;
          float halo = 0.55 * exp(-r2 * 14.0) + 0.45 * 0.02 / (0.02 + r2);
          c = vColor * halo + vec3(1.0, 0.97, 0.93) * core * exp(-r2 * 80.0) + vColor * core * 0.6 * exp(-r2 * 24.0);
          c *= (1.0 - r2) * (1.0 - r2);
        } else if (kind < 1.5) {
          c = vColor * exp(-r2 * 3.5) * (1.0 - r2);
        } else if (kind < 3.5) {
          float r = sqrt(r2);
          float fw = fwidth(r);
          float R = vQ.y;
          float ang = atan(vUv.y, vUv.x);
          float seed = vK.y;
          if (kind < 2.5) {
            float Rw = R * (1.0 + 0.02 * sin(ang * 7.0 + seed) + 0.015 * sin(ang * 13.0 - seed * 1.7));
            float th = max(vQ.z, fw * 1.5);
            float x = (r - Rw) / th;
            float front = x > 0.0 ? exp(-x * x * 4.0) : exp(-x * x * 0.45);
            float fill = 1.0 - smoothstep(0.0, Rw, r);
            c = vColor * (front * vK.z + fill * vK.w) + vec3(1.0) * front * vK.z * 0.3 * exp(-x * x * 6.0);
          } else {
            float h = max(vQ.z, fw * 2.0);
            float Ri = max(R - h, 0.0);
            float L = (sqrt(max(R * R - r * r, 0.0)) - sqrt(max(Ri * Ri - r * r, 0.0))) / sqrt(max(R * R - Ri * Ri, 1e-6));
            L *= 1.0 - smoothstep(R - fw, R + fw, r);
            // A ragged front, not a clean bubble: brighter and fainter lobes round the limb.
            L *= 0.65 + 0.35 * sin(ang * 5.0 + seed) * sin(ang * 3.0 - seed * 0.7) + 0.15 * sin(ang * 11.0 + seed * 2.1);
            float fill = exp(-r * r / max(0.3 * Ri * Ri, 1e-4));
            c = vColor * (L * vK.z + fill * vK.w);
          }
          c *= 1.0 - smoothstep(0.85, 1.0, r);
        } else {
          c = vColor * (0.012 / (0.012 + r2) - 0.012 / 1.012) * (1.0 - r2);
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

/*
 * Smoke: soft puffs cut from a noise texture (four variants in a 2x2 atlas,
 * made here at first use), turning slowly, alpha-blended (premultiplied) so
 * they darken what is behind them. Each is lit from the side its flash was
 * on: the texture is sampled again a little toward the light, and where the
 * density falls away toward it the puff is brighter, as a lit billow is.
 */
let smokeTex = null;
function smokeTexture() {
  if (smokeTex) return smokeTex;
  const N = 128;
  const W = N * 2;
  const data = new Uint8Array(W * W * 4);
  const lat = (i, j, o) => hash(((i & 63) * 157 + (j & 63) * 311 + o * 7.13) * 0.0137);
  const vnoise = (x, y, o) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    let fx = x - i;
    let fy = y - j;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = lat(i, j, o);
    const b = lat(i + 1, j, o);
    const c = lat(i, j + 1, o);
    const d = lat(i + 1, j + 1, o);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (x, y, o) => {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    for (let k = 0; k < 5; k++) {
      s += amp * vnoise(x * f, y * f, o + k * 3.1);
      amp *= 0.5;
      f *= 2.03;
    }
    return s / 0.97;
  };
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell & 1) * N;
    const oy = (cell >> 1) * N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N;
        const v = (y + 0.5) / N;
        // Domain-warped billows inside a soft dome.
        const wx = fbm(u * 3 + 11, v * 3, cell * 5 + 1) - 0.5;
        const wy = fbm(u * 3, v * 3 + 7, cell * 5 + 2) - 0.5;
        const n = fbm(u * 4 + wx * 1.6 + cell * 1.7, v * 4 + wy * 1.6, cell * 5 + 3);
        const r = Math.hypot(u - 0.5, v - 0.5) * 2;
        const dome = Math.max(0, 1 - r * r);
        let d = dome * (0.15 + 1.25 * n * n) - 0.08 * r;
        d = clamp(d * 1.35, 0, 1) * smooth(1, 0.8, r);
        const k = ((oy + y) * W + ox + x) * 4;
        const b = Math.round(255 * d);
        data[k] = data[k + 1] = data[k + 2] = data[k + 3] = b;
      }
    }
  }
  const t = new THREE.DataTexture(data, W, W);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  smokeTex = t;
  return t;
}

function smokeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tSmoke: { value: smokeTexture() } },
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec4 aS; // half-size (world), angle, atlas cell, pull
      attribute vec4 aC; // lit colour (rgb), opacity
      attribute vec4 aH; // inner glow (rgb), direction to the light on screen (angle)
      varying vec2 vUv;
      varying vec2 vCell;
      varying vec4 vC;
      varying vec3 vH;
      varying vec2 vL;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aCorner * aS.x;
        float L = length(mv.xyz);
        mv.xyz *= max(1.0 - aS.w / L, min(1.0, 3.0 / L));
        gl_Position = projectionMatrix * mv;
        float c = cos(aS.y);
        float s = sin(aS.y);
        mat2 rot = mat2(c, s, -s, c);
        vUv = rot * aCorner;
        vCell = vec2(mod(aS.z, 2.0), floor(aS.z / 2.0)) * 0.5;
        vC = aC;
        vH = aH.rgb;
        vL = rot * vec2(cos(aH.w), sin(aH.w));
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSmoke;
      varying vec2 vUv;
      varying vec2 vCell;
      varying vec4 vC;
      varying vec3 vH;
      varying vec2 vL;
      void main() {
        vec2 q = vUv * 0.5 + 0.5;
        if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) discard;
        vec2 tuv = vCell + q * 0.5;
        float d = texture2D(tSmoke, tuv).r;
        float dl = texture2D(tSmoke, tuv + vL * 0.025).r;
        float lit = clamp(0.6 + 3.0 * (d - dl), 0.2, 1.6);
        float a = d * vC.a;
        vec3 rgb = vC.rgb * lit + vH * d * d;
        gl_FragColor = vec4(rgb * a, a);
      }`,
  });
}

/** A pool of camera-facing quads (glows, discs or smoke) with the given per-vertex attributes; one mesh. */
function quadPool(n, material, layout) {
  const g = new THREE.BufferGeometry();
  const C = new Float32Array(n * 4 * 2);
  const idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    C.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
  }
  g.setAttribute('aCorner', new THREE.BufferAttribute(C, 2));
  const arrays = {};
  for (const [name, k] of layout) {
    arrays[name] = new Float32Array(n * 4 * k);
    g.setAttribute(name, new THREE.BufferAttribute(arrays[name], k).setUsage(THREE.DynamicDrawUsage));
  }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  let count = 0;
  return {
    mesh,
    arrays,
    begin() {
      count = 0;
    },
    /** The next quad's index (or -1 when full). */
    next() {
      return count < n ? count++ : -1;
    },
    end() {
      g.setDrawRange(0, count * 6);
      if (count) for (const [name] of layout) upload(g.attributes[name], count * 4);
      mesh.visible = count > 0;
    },
  };
}

export function createRepulsors(palette = {}) {
  const CYAN = palette.sheath || CYAN0;
  const BLUE = palette.edge || BLUE0;
  const lightColor = palette.light ?? 0xbfe6ff;
  // The Power Stone (any palette of its own, unless it says otherwise): heavier, crackling, violent.
  const stone = palette.style ? palette.style === 'stone' : !!palette.sheath;
  const group = new THREE.Group();

  const streaks = ribbonPool(STREAKS, streakMaterial(), false);
  streaks.mesh.renderOrder = 17;
  const beams = ribbonPool(RIBBONS, beamMaterial(), true);
  const streak = streaks.add;
  const beam = beams.add;

  const quads = quadPool(QUADS, quadMaterial(), [
    ['position', 3],
    ['color', 3],
    ['aQ', 4],
    ['aK', 4],
  ]);
  quads.mesh.renderOrder = 16;
  const smoke = quadPool(SMOKES, smokeMaterial(), [
    ['position', 3],
    ['aS', 4],
    ['aC', 4],
    ['aH', 4],
  ]);
  smoke.mesh.renderOrder = 15;

  // Debris: dark metal shards, lit by the scene (and the flash that tore them off).
  const chunkGeo = new THREE.IcosahedronGeometry(1, 0);
  const chunkMat = new THREE.MeshStandardMaterial({ color: 0x55555c, metalness: 0.75, roughness: 0.42, flatShading: true });
  const chunks = new THREE.InstancedMesh(chunkGeo, chunkMat, CHUNKS);
  chunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chunks.frustumCulled = false;
  chunks.count = 0;
  chunks.visible = false;
  {
    const c = new THREE.Color();
    for (let i = 0; i < CHUNKS; i++) chunks.setColorAt(i, c.setScalar(0.55 + 0.45 * hash(i * 3.7)));
  }

  const distort = createDistortPool(DISTORTS);

  // A short-range light at each palm: the charge and the flash light his hand, forearm and chest; and one
  // for the blasts themselves: a bolt in flight lights what it passes, an impact lights both fighters.
  // Always present (intensity 0 when idle), so the suits' shaders never recompile.
  const palmLights = {
    L: new THREE.PointLight(lightColor, 0, PALM_LIGHT_RANGE, 2),
    R: new THREE.PointLight(lightColor, 0, PALM_LIGHT_RANGE, 2),
  };
  const blastLight = new THREE.PointLight(new THREE.Color(lightColor).lerp(new THREE.Color(1, 1, 1), 0.3), 0, IMPACT_LIGHT_RANGE, 2);
  group.add(smoke.mesh, chunks, quads.mesh, beams.mesh, streaks.mesh, palmLights.L, palmLights.R, blastLight);

  // The brightest muzzle flash and impact this frame, for the dust round them
  // to catch (view3d reads these): where, how much brighter, over what radius.
  const flashes = [
    { p: new THREE.Vector3(), k: 0, r: 1 },
    { p: new THREE.Vector3(), k: 0, r: 1 },
  ];
  group.userData.flashes = flashes;
  group.userData.distort = distort.mesh;
  const reg = { group, mesh: distort.mesh, flashes, active: false };
  registerFx(reg);

  const shots = Array.from({ length: SHOTS }, () => ({
    live: false,
    side: 'L',
    T: 0, // when it fired
    tau: 0.2, // its flight time
    tHit: 0, // when it reaches its target (T + tau)
    seed: 0,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    dist: 1,
    id: 0, // the target it was fired at
    power: 0.5,
    miss: false,
    ground: 0,
    burst: false, // its impact's sparks, smoke and debris are out
    fizz: false, // (a miss) its end's fizzle is out
  }));
  const seen = new Map(); // word id -> last reach p (+10 once it is retracting)
  const fired0 = new Map(); // explicit shots already fired: key -> tFire
  const elig = { L: [], R: [] };
  let prevT = -1e9;
  let curTargets = [];
  const camPos = new THREE.Vector3();
  const camR = new THREE.Vector3();
  const camU = new THREE.Vector3();
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();
  const d3 = new THREE.Vector3();
  const e3 = new THREE.Vector3();
  const f3 = new THREE.Vector3();
  const u3 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const n3 = new THREE.Vector3();
  const P3 = new THREE.Vector3();
  const UPV = new THREE.Vector3(0, 1, 0);
  const col = [0, 0, 0];
  const lightK = { L: 0, R: 0 };
  const lightAt = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const ready = { L: false, R: false }; // each hand up on a word and firing on its schedule
  const charge = { L: { x: 0, seed: 0, at: new THREE.Vector3(), on: false }, R: { x: 0, seed: 0, at: new THREE.Vector3(), on: false } };
  const blast = { k: 0, p: new THREE.Vector3() }; // the brightest light of a blast this frame
  const out = { fired: { L: 0, R: 0 }, light: 0, hits: [], misses: [] }; // update()'s result, reused every frame

  /* ---------------- per-frame writers ---------------- */

  const Q = quads.arrays;
  /** A billboard quad: centre, half-size, colour, kind, p1, p2, pull, seed, p3, p4. */
  function bill(p, h, r, g, b, kind, p1, p2, pull, seed, p3, p4) {
    const i = quads.next();
    if (i < 0) return;
    for (let v = 0; v < 4; v++) {
      const j = i * 4 + v;
      Q.position[j * 3] = p.x;
      Q.position[j * 3 + 1] = p.y;
      Q.position[j * 3 + 2] = p.z;
      Q.color[j * 3] = r;
      Q.color[j * 3 + 1] = g;
      Q.color[j * 3 + 2] = b;
      Q.aQ[j * 4] = h;
      Q.aQ[j * 4 + 1] = p1;
      Q.aQ[j * 4 + 2] = p2;
      Q.aQ[j * 4 + 3] = pull;
      Q.aK[j * 4] = kind;
      Q.aK[j * 4 + 1] = seed;
      Q.aK[j * 4 + 2] = p3;
      Q.aK[j * 4 + 3] = p4;
    }
  }
  /** A glow at p: world diameter, halo colour x intensity, white core intensity; pulled toward the lens by pull (world). */
  function glow(p, size, r, g, b, core, pull = 0) {
    if (size <= 0 || r + g + b + core < 1e-4) return;
    bill(p, size / 2, r, g, b, GLOW, core, 0, pull, 0, 0, 0);
  }
  /** Soft glowing gas at p: world diameter, colour x intensity. */
  function wisp(p, size, r, g, b, pull = 0) {
    if (size <= 0 || r + g + b < 1e-4) return;
    bill(p, size / 2, r, g, b, WISP, 0, 0, pull, 0, 0, 0);
  }
  /** The veil of glare round a blinding flash: world diameter, colour x intensity. */
  function glare(p, size, r, g, b, pull = 0) {
    if (size <= 0 || r + g + b < 1e-4) return;
    bill(p, size / 2, r, g, b, GLARE, 0, 0, pull, 0, 0, 0);
  }
  /** A shell at p: radius R and thickness th (world), colour, limb and fill intensities. */
  function shell(p, R, th, r, g, b, ring, fill, seed, pull = 0) {
    const h = R + 2 * th;
    bill(p, h, r, g, b, SHELL, R / h, th / h, pull, seed, ring, fill);
  }
  /** A ripple at p in the plane spanned by unit vectors u, v: radius R and thickness th (world), colour, front and fill intensities. */
  function ripple(p, u, v, R, th, r, g, b, ring, fill, seed) {
    const i = quads.next();
    if (i < 0) return;
    const h = R + 2 * th;
    for (let k = 0; k < 4; k++) {
      const su = k & 1 ? 1 : -1;
      const sv = k & 2 ? 1 : -1;
      const j = i * 4 + k;
      Q.position[j * 3] = p.x + (u.x * su + v.x * sv) * h;
      Q.position[j * 3 + 1] = p.y + (u.y * su + v.y * sv) * h;
      Q.position[j * 3 + 2] = p.z + (u.z * su + v.z * sv) * h;
      Q.color[j * 3] = r;
      Q.color[j * 3 + 1] = g;
      Q.color[j * 3 + 2] = b;
      Q.aQ[j * 4] = 0;
      Q.aQ[j * 4 + 1] = R / h;
      Q.aQ[j * 4 + 2] = th / h;
      Q.aQ[j * 4 + 3] = 0;
      Q.aK[j * 4] = RIPPLE;
      Q.aK[j * 4 + 1] = seed;
      Q.aK[j * 4 + 2] = ring;
      Q.aK[j * 4 + 3] = fill;
    }
  }
  const SM = smoke.arrays;
  /** A smoke puff: centre, half-size, angle, atlas cell, pull, lit colour, opacity, inner glow, light direction (screen angle). */
  function puff(p, h, ang, cell, pull, r, g, b, a, hr, hg, hb, la) {
    const i = smoke.next();
    if (i < 0) return;
    for (let v = 0; v < 4; v++) {
      const j = i * 4 + v;
      SM.position[j * 3] = p.x;
      SM.position[j * 3 + 1] = p.y;
      SM.position[j * 3 + 2] = p.z;
      SM.aS[j * 4] = h;
      SM.aS[j * 4 + 1] = ang;
      SM.aS[j * 4 + 2] = cell;
      SM.aS[j * 4 + 3] = pull;
      SM.aC[j * 4] = r;
      SM.aC[j * 4 + 1] = g;
      SM.aC[j * 4 + 2] = b;
      SM.aC[j * 4 + 3] = a;
      SM.aH[j * 4] = hr;
      SM.aH[j * 4 + 1] = hg;
      SM.aH[j * 4 + 2] = hb;
      SM.aH[j * 4 + 3] = la;
    }
  }
  /** Offer a flash to the dust: keep the brightest muzzle (slot 0) and impact (slot 1). */
  function flashAt(slot, p, k, r) {
    const f = flashes[slot];
    if (k <= f.k) return;
    f.p.copy(p);
    f.k = k;
    f.r = r;
  }
  /** Offer a light to the blast light: the brightest one this frame wins it. */
  function lightUp(p, k) {
    if (k <= blast.k) return;
    blast.k = k;
    blast.p.copy(p);
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

  /**
   * A jagged arc of lightning from a to b (n segments, displaced up to amp across, each knot
   * re-drawn from seed): a white-hot filament in a sheath of the palette's colour.
   */
  const arcD = new THREE.Vector3();
  const arcU = new THREE.Vector3();
  const arcV = new THREE.Vector3();
  const arcA = new THREE.Vector3();
  const arcB = new THREE.Vector3();
  function arc(a, b, n, amp, seed, k, w) {
    arcD.copy(b).sub(a);
    const L = arcD.length();
    if (L < 1e-3 || k < 0.01) return;
    basis(arcD.multiplyScalar(1 / L), arcU, arcV);
    arcA.copy(a);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const env = Math.sin(Math.PI * t); // pinned at both ends
      const jx = (hash(seed + i * 3.17) - 0.5) * 2 * amp * env;
      const jy = (hash(seed + i * 5.71) - 0.5) * 2 * amp * env;
      arcB.copy(a).lerp(b, t).addScaledVector(arcU, jx).addScaledVector(arcV, jy);
      const kk = k * (0.75 + 0.25 * hash(seed + i * 1.3));
      streak(arcA, arcB, w, w, CYAN[0] * kk, CYAN[1] * kk, CYAN[2] * kk, 1.6 * kk, CYAN[0] * kk, CYAN[1] * kk, CYAN[2] * kk, 1.6 * kk);
      arcA.copy(arcB);
    }
  }

  /* ---------------- simulated particles: sparks, embers, crackle ---------------- */

  const pt = {
    p: new Float32Array(PARTS * 3),
    v: new Float32Array(PARTS * 3),
    age: new Float32Array(PARTS).fill(99),
    life: new Float32Array(PARTS).fill(1),
    kind: new Uint8Array(PARTS),
    size: new Float32Array(PARTS),
    heat: new Float32Array(PARTS),
    tau: new Float32Array(PARTS),
    drag: new Float32Array(PARTS),
    grav: new Float32Array(PARTS),
    ground: new Float32Array(PARTS),
    seed: new Float32Array(PARTS),
    next: 0,
  };
  /** Emit a particle; returns its index. */
  function emit(kind, p, dir, spd, life, size, heat, tau, drag, grav, ground, seed) {
    const i = pt.next;
    pt.next = (pt.next + 1) % PARTS;
    pt.p[i * 3] = p.x;
    pt.p[i * 3 + 1] = p.y;
    pt.p[i * 3 + 2] = p.z;
    pt.v[i * 3] = dir.x * spd;
    pt.v[i * 3 + 1] = dir.y * spd;
    pt.v[i * 3 + 2] = dir.z * spd;
    pt.age[i] = 0;
    pt.life[i] = life;
    pt.kind[i] = kind;
    pt.size[i] = size;
    pt.heat[i] = heat;
    pt.tau[i] = tau;
    pt.drag[i] = drag;
    pt.grav[i] = grav;
    pt.ground[i] = ground;
    pt.seed[i] = seed;
    return i;
  }
  /** Advance particle i by dt: gravity, drag, and a bounce off its ground (losing speed and heat). */
  function stepPart(i, dt) {
    const k = Math.exp(-pt.drag[i] * dt);
    let vx = pt.v[i * 3] * k;
    let vy = (pt.v[i * 3 + 1] - pt.grav[i] * dt) * k;
    let vz = pt.v[i * 3 + 2] * k;
    let y = pt.p[i * 3 + 1] + vy * dt;
    const gy = pt.ground[i];
    if (y < gy && vy < 0) {
      y = gy + (gy - y) * 0.3;
      vy = -vy * (0.28 + 0.2 * hash(pt.seed[i] + pt.age[i] * 7.7));
      vx *= 0.6;
      vz *= 0.6;
      pt.heat[i] *= 0.85;
    }
    pt.p[i * 3] += vx * dt;
    pt.p[i * 3 + 1] = y;
    pt.p[i * 3 + 2] += vz * dt;
    pt.v[i * 3] = vx;
    pt.v[i * 3 + 1] = vy;
    pt.v[i * 3 + 2] = vz;
    pt.age[i] += dt;
  }
  /** Run particle i on by t seconds (it was born that long before this frame). */
  function presim(i, t) {
    for (let left = t; left > 1e-6; ) {
      const h = Math.min(left, 1 / 60);
      stepPart(i, h);
      left -= h;
    }
  }

  /* ---------------- smoke ---------------- */

  const sm = {
    p: new Float32Array(SMOKES * 3),
    v: new Float32Array(SMOKES * 3),
    src: new Float32Array(SMOKES * 3), // the flash that lights it
    age: new Float32Array(SMOKES).fill(99),
    life: new Float32Array(SMOKES).fill(1),
    s0: new Float32Array(SMOKES),
    s1: new Float32Array(SMOKES),
    ang: new Float32Array(SMOKES),
    spin: new Float32Array(SMOKES),
    cell: new Float32Array(SMOKES),
    a0: new Float32Array(SMOKES),
    rise: new Float32Array(SMOKES),
    grey: new Float32Array(SMOKES),
    hot: new Float32Array(SMOKES * 3), // inner glow colour
    fl: new Float32Array(SMOKES * 3), // flash colour
    next: 0,
  };
  function stepSmoke(i, dt) {
    const k = Math.exp(-1.6 * dt);
    sm.v[i * 3] *= k;
    sm.v[i * 3 + 1] *= k;
    sm.v[i * 3 + 2] *= k;
    sm.p[i * 3] += sm.v[i * 3] * dt;
    sm.p[i * 3 + 1] += (sm.v[i * 3 + 1] + sm.rise[i]) * dt;
    sm.p[i * 3 + 2] += sm.v[i * 3 + 2] * dt;
    sm.age[i] += dt;
  }

  /* ---------------- debris ---------------- */

  const ch = {
    p: new Float32Array(CHUNKS * 3),
    v: new Float32Array(CHUNKS * 3),
    axis: new Float32Array(CHUNKS * 3),
    shape: new Float32Array(CHUNKS * 3),
    spin: new Float32Array(CHUNKS),
    age: new Float32Array(CHUNKS).fill(99),
    life: new Float32Array(CHUNKS).fill(1),
    size: new Float32Array(CHUNKS),
    ground: new Float32Array(CHUNKS),
    heat: new Float32Array(CHUNKS),
    next: 0,
  };
  function stepChunk(i, dt) {
    const k = Math.exp(-0.5 * dt);
    let vx = ch.v[i * 3] * k;
    let vy = (ch.v[i * 3 + 1] - GRAVITY * dt) * k;
    let vz = ch.v[i * 3 + 2] * k;
    let y = ch.p[i * 3 + 1] + vy * dt;
    const gy = ch.ground[i] + ch.size[i] * 0.5;
    if (y < gy && vy < 0) {
      y = gy;
      vy = -vy * 0.3;
      vx *= 0.5;
      vz *= 0.5;
      ch.spin[i] *= 0.5;
    }
    ch.p[i * 3] += vx * dt;
    ch.p[i * 3 + 1] = y;
    ch.p[i * 3 + 2] += vz * dt;
    ch.v[i * 3] = vx;
    ch.v[i * 3 + 1] = vy;
    ch.v[i * 3 + 2] = vz;
    ch.age[i] += dt;
  }
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  /* ---------------- thruster exhaust ---------------- */

  const ex = { p: new Float32Array(EXHAUST * 3), v: new Float32Array(EXHAUST * 3), age: new Float32Array(EXHAUST).fill(9), life: new Float32Array(EXHAUST).fill(1), size: new Float32Array(EXHAUST), next: 0, acc: 0 };

  /* ---------------- blasts ---------------- */

  /** How big a blast's impact is (world units per unit of the effect). */
  function impactScale(s, S) {
    return (s.id < 0 ? DUEL_IMPACT : 1) * S * (s.power >= HEAVY ? 1.35 : 1);
  }
  /** Where a blast bursts: on a fighter, a little short of the aim point toward the shooter (on his armour). */
  function impactPoint(s, S, out3) {
    return out3.copy(s.to).addScaledVector(s.dir, s.id < 0 ? -SURFACE * S : 0);
  }

  /** Start a blast from a hand at time T (seconds), from the palm at a point. */
  function addShot(side, seed, T, palm, at, S, id, power, miss, ground, tau, tHit) {
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
    s.seed = seed;
    s.id = id;
    s.power = power;
    s.miss = !!miss;
    s.burst = false;
    s.fizz = false;
    s.dir.copy(at).sub(palm);
    s.dist = Math.max(1e-3, s.dir.length());
    s.dir.multiplyScalar(1 / s.dist);
    // The bolt leaves the emitter just off the palm's face.
    s.from.copy(palm).addScaledVector(s.dir, Math.min(0.5 * S, 0.5 * s.dist));
    s.to.copy(at);
    s.dist = Math.max(1e-3, s.from.distanceTo(s.to));
    s.tau = tau > 0 ? tau : flight(s.dist, S);
    s.tHit = tHit !== undefined ? tHit : T + s.tau;
    s.ground = Number.isFinite(ground) ? Math.min(ground, at.y - 2) : at.y - 25;
  }

  /** A hand's time between blasts: a volley at an opponent, else the reading pace. */
  function period(n, targets = curTargets) {
    for (const i of elig[n]) if (targets[i].id < 0) return DUEL_PERIOD;
    return PERIOD;
  }

  /**
   * The impact's sparks, embers, smoke and debris (once, as the blast arrives; ai: how long ago it did).
   * live: it arrived in this frame's play (not put back by a seek), so the camera takes the jolt.
   */
  function burst(s, ai, S, live) {
    const duel = s.id < 0;
    const heavy = s.power >= HEAVY;
    const SI = impactScale(s, S);
    const P = impactPoint(s, S, P3);
    const sd = s.seed;
    n3.copy(s.dir).multiplyScalar(-1); // back toward the shooter
    const born = [];
    if (!duel) {
      // On a word: a small spray of the palette's sparks, in space (no gravity): a reading effect.
      for (let i = 0; i < 10; i++) {
        sphereDir(hash(sd + i * 4.13), hash(sd + i * 6.71), c3).addScaledVector(n3, 0.7).normalize();
        const h = hash(sd + i * 1.37);
        born.push(emit(MOTE, P, c3, (40 + 170 * h * h) * S, 0.18 + 0.3 * hash(sd + i * 2.91), 0.05 * S, 1, 0.07, 2.5, 0, -1e9, sd + i));
      }
      for (const i of born) presim(i, ai);
      return;
    }
    const vs = 0.55 + 0.45 * (SI / DUEL_IMPACT);
    const rs = Math.sqrt(SI / DUEL_IMPACT);
    const ground = s.ground;
    const nMetal = stone ? (heavy ? 18 : 12) : heavy ? 70 : 40;
    const nCrackle = stone ? (heavy ? 60 : 38) : 0;
    const nEmber = heavy ? 20 : 11;
    // Metal: torn off hot and thrown out (mostly back off the armour and up), then drag and gravity.
    for (let i = 0; i < nMetal; i++) {
      const h = (k) => hash(sd + i * 7.31 + k * 1.913);
      sphereDir(h(1), h(2), c3).addScaledVector(n3, 1.0).addScaledVector(UPV, 0.35).normalize();
      born.push(emit(METAL, P, c3, (90 + 430 * h(3) * h(3)) * vs, 0.6 + 0.9 * h(4), (0.05 + 0.05 * h(5)) * rs, 0.95 + 0.2 * h(6), 0.2 + 0.35 * h(7), 1.3 + 1.7 * h(8), GRAVITY, ground, sd + i * 3.3));
    }
    // The Stone's energy: flecks of violet fire flung out fast, flickering out in a fraction of a second.
    for (let i = 0; i < nCrackle; i++) {
      const h = (k) => hash(sd + i * 5.13 + k * 2.371);
      sphereDir(h(1), h(2), c3).addScaledVector(n3, 0.75).normalize();
      born.push(emit(CRACKLE, P, c3, (150 + 560 * h(3) * h(3)) * vs, 0.12 + 0.45 * h(4), (0.06 + 0.05 * h(5)) * rs, 1, 0.1, 4.5, 30, ground, sd + i * 1.7));
    }
    // Embers: slower, bigger fragments glowing as they fall.
    for (let i = 0; i < nEmber; i++) {
      const h = (k) => hash(sd + i * 9.17 + k * 3.131);
      sphereDir(h(1), h(2), c3).addScaledVector(n3, 0.8).addScaledVector(UPV, 0.6).normalize();
      born.push(emit(EMBER, P, c3, (25 + 100 * h(3)) * vs, 0.9 + 1.1 * h(4), (0.28 + 0.25 * h(5)) * rs, 0.8 + 0.2 * h(6), 0.45 + 0.4 * h(7), 1.1, 150, ground, sd + i * 2.9));
    }
    for (const i of born) presim(i, ai);
    // Smoke: a few puffs blown back off the armour, lit by the flash as they form.
    const nSmoke = heavy ? 9 : 5;
    for (let i = 0; i < nSmoke; i++) {
      const h = (k) => hash(sd + i * 3.77 + k * 4.219);
      const j = sm.next;
      sm.next = (sm.next + 1) % SMOKES;
      sphereDir(h(1), h(2), c3);
      a3.copy(P).addScaledVector(n3, (0.6 + 1.6 * h(3)) * SI).addScaledVector(c3, 1.2 * SI);
      sm.p.set([a3.x, a3.y, a3.z], j * 3);
      sm.src.set([P.x, P.y, P.z], j * 3);
      c3.multiplyScalar(6 + 6 * h(4)).addScaledVector(n3, 9 + 16 * h(5)).addScaledVector(UPV, 2 + 4 * h(6)).multiplyScalar(SI / DUEL_IMPACT);
      sm.v.set([c3.x, c3.y, c3.z], j * 3);
      sm.age[j] = 0;
      sm.life[j] = (1.3 + 0.7 * h(7)) * (heavy ? 1.25 : 1);
      sm.s0[j] = (1.8 + 0.8 * h(8)) * SI;
      sm.s1[j] = (5.5 + 3.5 * h(9)) * SI * (heavy ? 1.2 : 1);
      sm.ang[j] = 6.283 * h(10);
      sm.spin[j] = (h(11) - 0.5) * 0.9;
      sm.cell[j] = Math.floor(h(12) * 4);
      sm.a0[j] = (0.42 + 0.25 * h(13)) * (heavy ? 1.2 : 1);
      sm.rise[j] = (2.5 + 2.5 * h(14)) * (SI / DUEL_IMPACT);
      sm.grey[j] = 0.018 + 0.02 * h(15);
      if (stone) sm.hot.set([BLUE[0] * 0.9, BLUE[1] * 0.9, BLUE[2] * 0.9], j * 3);
      else sm.hot.set([1.0, 0.36, 0.08], j * 3);
      sm.fl.set([CYAN[0] * 0.5 + 0.5, CYAN[1] * 0.5 + 0.5, CYAN[2] * 0.5 + 0.5], j * 3);
      for (let left = ai; left > 1e-6; left -= 1 / 60) stepSmoke(j, Math.min(left, 1 / 60));
    }
    // Debris: a heavy hit tears shards off the armour.
    if (heavy) {
      for (let i = 0; i < 10; i++) {
        const h = (k) => hash(sd + i * 6.07 + k * 2.887);
        const j = ch.next;
        ch.next = (ch.next + 1) % CHUNKS;
        sphereDir(h(1), h(2), c3).addScaledVector(n3, 0.9).addScaledVector(UPV, 0.7).normalize();
        const spd = (50 + 170 * h(3)) * vs;
        ch.p.set([P.x, P.y, P.z], j * 3);
        ch.v.set([c3.x * spd, c3.y * spd, c3.z * spd], j * 3);
        sphereDir(h(4), h(5), c3);
        ch.axis.set([c3.x, c3.y, c3.z], j * 3);
        ch.shape.set([0.6 + 0.8 * h(6), 0.25 + 0.4 * h(7), 0.5 + 0.7 * h(8)], j * 3);
        ch.spin[j] = 6 + 14 * h(9);
        ch.age[j] = 0;
        ch.life[j] = 1.3 + 0.8 * h(10);
        ch.size[j] = (0.35 + 0.5 * h(11)) * rs;
        ch.ground[j] = ground;
        ch.heat[j] = 0.8 + 0.2 * h(12);
        for (let left = ai; left > 1e-6; left -= 1 / 60) stepChunk(j, Math.min(left, 1 / 60));
      }
    }
    if (live) kick((heavy ? 0.9 : 0.32) * (stone ? 1.3 : 1));
  }

  /** A miss running out: the bolt's energy dispersing where it fades (a few motes; no burst). */
  function fizzle(s, ai, S, end) {
    for (let i = 0; i < 6; i++) {
      sphereDir(hash(s.seed + i * 4.7), hash(s.seed + i * 8.3), c3).addScaledVector(s.dir, 1.2).normalize();
      const j = emit(MOTE, end, c3, (30 + 90 * hash(s.seed + i * 2.2)) * S, 0.15 + 0.25 * hash(s.seed + i * 3.9), 0.04 * S, 0.8, 0.06, 3, 0, -1e9, s.seed + i);
      presim(j, ai);
    }
  }

  /**
   * Advance and draw one frame.
   *
   * Blasts come from two sources, drawn alike:
   * - the slot schedule: each hand up on a target (o.targets with side set, its arm aimed,
   *   o.aim > 0.5) fires on a jittered rhythm (a volley at an opponent, id < 0);
   * - explicit shots (o.shots): each fires EXACTLY at its tFire from palms[hand] toward at, the
   *   palm charging for 0.3 s before. Its flight time is tHit - tFire when tHit is given (it arrives
   *   at `at` exactly at tHit), else clamp(distance / (520 x unit), 0.15, 0.35) s, as the schedule's.
   *   A shot is identified by key (or id, hand and tFire together), fires once, and is drawn from
   *   wherever it is in its life when first seen (a seek, or a shot added late): in flight, or its
   *   impact's aftermath.
   * A blast reaching its target reports the target's id in `hits` on the frame whose clock crosses
   * its arrival (not on a frame that seeks past it). A miss (shot.miss or target.miss) flies on past
   * `at` to 1.5 x its distance, fading, with no burst on the fighter, and is reported in `misses`
   * instead. A blast on a fighter (id < 0) bursts big (light, shock, sparks bouncing on its ground,
   * smoke, a camera kick; heavy ones, power >= 0.8, more of all and debris); on a word, small.
   *
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
   * @param {{at:number[], id:number, p:number, side:'L'|'R', power?:number, ground?:number, miss?:boolean}[]} o.targets
   *   targets being fired at: where, which (< 0: an opponent), how far the director's reach has got (0..1), the hand
   *   on that side; optionally how hard (0..1, default o.power or 0.5), the height of the ground under it (sparks
   *   bounce there; default at[1] - 25) and whether the blasts go wide
   * @param {{L:number, R:number}} o.aim how far each arm is raised onto its target (0..1)
   * @param {{id:number, hand:'L'|'R', at:number[], tFire:number, tHit?:number, power?:number, miss?:boolean, ground?:number, key?:string}[]} [o.shots]
   *   explicit shots (see above), in addition to the schedule
   * @param {number} [o.power] default power (0..1) of blasts whose target or shot gives none
   * @returns {{fired:{L:number, R:number}, light:number, hits:number[], misses:number[]}} blasts fired this frame per
   *   hand (the body recoils per blast), how bright the repulsors burn (lights his armour), the ids of the targets
   *   struck this frame, and of those missed (passed by) this frame; the same object every frame
   */
  function update(o) {
    const { dt, time, camera, halfH, unit, scale, palms, soles, head, vel, thrust, fly, targets, aim } = o;
    const explicit = o.shots || NONE;
    const power0 = Number.isFinite(o.power) ? o.power : 0.5;
    curTargets = targets;
    const aspect = camera.aspect || 1;
    quads.mesh.material.uniforms.uHalfH.value = halfH;
    streaks.mesh.material.uniforms.uHalfRes.value.set(halfH * aspect, halfH);
    beams.mesh.material.uniforms.uHalfRes.value.set(halfH * aspect, halfH);
    beams.mesh.material.uniforms.uTime.value = time;
    camera.getWorldPosition(camPos);
    camR.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camU.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const { fired } = out;
    fired.L = fired.R = 0;
    out.hits.length = 0;
    out.misses.length = 0;
    streaks.begin();
    beams.begin();
    quads.begin();
    smoke.begin();
    distort.begin(time);
    flashes[0].k = 0;
    flashes[1].k = 0;
    blast.k = 0;
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

    // The clock: a seek (or a stall) puts back what is in the air instead of playing it.
    const jumped = !(time >= prevT) || time - prevT > 0.5;
    const fdt = jumped ? 0 : Math.min(0.1, time - prevT);
    if (jumped) {
      for (const s of shots) s.live = false;
      pt.age.fill(99);
      sm.age.fill(99);
      ch.age.fill(99);
      fired0.clear();
    }
    const t0 = jumped ? time - REFILL : prevT;
    prevT = time;

    // The schedule: every slot that came due since the last frame fires, if that hand is up on a word.
    for (const n of SIDES) {
      ready[n] = aim[n] > 0.5 && elig[n].length > 0;
      if (!ready[n]) continue;
      const P = period(n);
      for (let k = Math.floor(t0 / P) - 1, k1 = Math.floor(time / P) + 1; k <= k1; k++) {
        const T = slotTime(n, k, P);
        if (T <= t0 || T > time) continue;
        const t = targets[elig[n][((k % elig[n].length) + elig[n].length) % elig[n].length]];
        a3.set(t.at[0], t.at[1], t.at[2]);
        const pw = Number.isFinite(t.power) ? t.power : power0;
        addShot(n, hash(k * 0.917 + (n === 'R' ? 5.1 : 2.3)) * 1000, T, palms[n], a3, S, t.id, pw, t.miss, t.ground);
        if (!jumped || T > time - 0.07) fired[n]++;
      }
    }
    // Explicit shots: each exactly at its tFire.
    for (const sh of explicit) {
      if (!sh || !(sh.tFire <= time) || !sh.at) continue;
      const hand = sh.hand === 'L' ? 'L' : 'R';
      const key = sh.key !== undefined ? sh.key : `${sh.id}|${hand}|${sh.tFire}`;
      if (fired0.has(key)) continue;
      fired0.set(key, sh.tFire);
      const tau = Number.isFinite(sh.tHit) && sh.tHit > sh.tFire ? sh.tHit - sh.tFire : 0;
      a3.set(sh.at[0], sh.at[1], sh.at[2]);
      const est = tau || flight(a3.distanceTo(palms[hand]), S);
      if (time - sh.tFire > est * MISS_RUN + REFILL) continue; // long over
      const pw = Number.isFinite(sh.power) ? sh.power : power0;
      addShot(hand, hash(sh.tFire * 13.71 + (hand === 'R' ? 5.1 : 2.3) + (sh.id || 0) * 0.377) * 1000, sh.tFire, palms[hand], a3, S, sh.id, pw, sh.miss, sh.ground, tau, tau ? sh.tHit : undefined);
      if (!jumped && sh.tFire > t0) fired[hand]++;
    }
    if (fired0.size > 64) for (const [k, tf] of fired0) if (tf < time - REFILL - 10) fired0.delete(k);

    // Sparks, smoke and debris already out play on (new ones are run on to their age as they come).
    if (fdt > 0) {
      const nsub = Math.ceil(fdt / (1 / 60) - 1e-6);
      const h = fdt / nsub;
      for (let i = 0; i < PARTS; i++) if (pt.age[i] < pt.life[i]) for (let k = 0; k < nsub; k++) stepPart(i, h);
      for (let i = 0; i < SMOKES; i++) if (sm.age[i] < sm.life[i]) for (let k = 0; k < nsub; k++) stepSmoke(i, h);
      for (let i = 0; i < CHUNKS; i++) if (ch.age[i] < ch.life[i]) for (let k = 0; k < nsub; k++) stepChunk(i, h);
    }

    // Palms: the emitter's glow while the arm is up, and the charge building to each blast:
    // from idle to white-hot, motes of light spiralling in, its light coming up on the hand.
    let light = 0;
    for (const n of SIDES) {
      const C = charge[n];
      C.x = 0;
      C.on = false;
      if (ready[n]) {
        const P = period(n);
        let k = Math.floor(time / P) - 1;
        while (slotTime(n, k, P) <= time) k++;
        const x = clamp(1 - (slotTime(n, k, P) - time) / CHARGE, 0, 1);
        const t = targets[elig[n][((k % elig[n].length) + elig[n].length) % elig[n].length]];
        C.x = x;
        C.seed = hash(k * 0.917 + (n === 'R' ? 5.1 : 2.3)) * 1000;
        C.at.set(t.at[0], t.at[1], t.at[2]);
        C.on = true;
      }
      for (const sh of explicit) {
        if (!sh || !sh.at || (sh.hand === 'L' ? 'L' : 'R') !== n) continue;
        const lead = sh.tFire - time;
        if (!(lead > 0 && lead <= CHARGE)) continue;
        const x = 1 - lead / CHARGE;
        if (x <= C.x) continue;
        C.x = x;
        C.seed = hash(sh.tFire * 13.71 + (n === 'R' ? 5.1 : 2.3) + (sh.id || 0) * 0.377) * 1000;
        C.at.set(sh.at[0], sh.at[1], sh.at[2]);
        C.on = true;
      }
    }
    for (const n of SIDES) {
      const C = charge[n];
      const up = Math.max(clamp((aim[n] - 0.3) / 0.5, 0, 1) * (elig[n].length ? 1 : 0), C.x > 0 ? 0.6 : 0);
      const x = C.x;
      const q = x * x; // slow to start, racing at the end
      lightK[n] = 1.2 * up;
      lightAt[n].copy(palms[n]);
      c3.copy(palms[n]);
      if (C.on) {
        d3.copy(C.at).sub(palms[n]);
        const l = d3.length();
        if (l > 1e-3) {
          d3.multiplyScalar(1 / l);
          c3.addScaledVector(d3, 0.6 * S); // just off the palm's face, so the hand stays in view behind it
          lightAt[n].copy(palms[n]).addScaledVector(d3, 0.9 * S);
          if (q > 0.02) {
            // Intake: motes drawn in from round the palm, swirling as they come.
            basis(d3, u3, v3);
            for (let i = 0; i < INTAKE_MOTES; i++) {
              const h = hash(C.seed + i * 3.7);
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
              const m = 0.6 * Math.sin(Math.PI * qi);
              streak(b3, a3, 0.04 * S, 0.1 * S, CYAN[0] * 0.1 * m, CYAN[1] * 0.1 * m, CYAN[2] * 0.1 * m, 0, CYAN[0] * m, CYAN[1] * m, CYAN[2] * m, 0.9 * m);
            }
            // (The Stone builds with a crackle: arcs flicking round the fist as it comes up.)
            if (stone && q > 0.15) {
              const sl = Math.floor(time * 30);
              for (let j = 0; j < 2; j++) {
                const h1 = hash(C.seed + sl * 1.37 + j * 9.1);
                if (h1 < 0.35) continue;
                const th = 6.283 * hash(C.seed + sl * 2.71 + j);
                a3.copy(c3).addScaledVector(u3, Math.cos(th) * 1.1 * S).addScaledVector(v3, Math.sin(th) * 1.1 * S);
                b3.copy(c3).addScaledVector(u3, Math.cos(th + 2.2) * 1.3 * S).addScaledVector(v3, Math.sin(th + 2.2) * 1.3 * S).addScaledVector(d3, -0.6 * S);
                arc(a3, b3, 4, 0.45 * S, C.seed + sl * 3.1 + j * 17, 0.5 * q, 0.06 * S);
              }
            }
          }
        }
      }
      if (up > 0.01 || q > 0.01) {
        const fl = 0.94 + 0.06 * Math.sin(time * 61 + (n === 'L' ? 0 : 2));
        const h = (0.12 * up + 0.6 * q) * fl;
        glow(c3, (1.1 + 1.0 * q) * S, CYAN[0] * h, CYAN[1] * h, CYAN[2] * h, (0.15 * up + 2.4 * q * q) * fl);
        if (q > 0.05) wisp(c3, 5 * S * (0.6 + 0.4 * q), CYAN[0] * 0.05 * q, CYAN[1] * 0.05 * q, CYAN[2] * 0.05 * q);
      }
      lightK[n] += 60 * q;
      light += 0.08 * up + 0.3 * q;
    }

    // Blasts.
    for (const s of shots) {
      if (!s.live) continue;
      if (!jumped && s.tHit > t0 && s.tHit <= time) (s.miss ? out.misses : out.hits).push(s.id);
      const a = time - s.T;
      if (a < 0) {
        s.live = false;
        continue;
      }
      const palm = palms[s.side];
      const { dir, dist, tau, seed } = s;
      const v = dist / tau; // its speed
      const run = s.miss ? MISS_RUN * dist : dist;
      const ai = a - tau; // since it arrived
      const done = s.miss ? a > MISS_RUN * tau + AFTER : ai > AFTER;
      // Its impact's simulated part, once (run on to its age when it comes late, after a seek).
      if (!s.miss && ai >= 0 && !s.burst) {
        s.burst = true;
        burst(s, ai, S, !jumped && ai < 0.1);
      }
      if (s.miss && a >= MISS_RUN * tau && !s.fizz) {
        s.fizz = true;
        fizzle(s, a - MISS_RUN * tau, S, a3.copy(s.from).addScaledVector(dir, run));
      }
      if (done) {
        s.live = false;
        continue;
      }
      const heavy = s.power >= HEAVY;
      const pk = 0.8 + 0.4 * s.power; // a harder blast burns brighter and thicker

      // Muzzle: the cannon going off at the palm face. An overexposed flash for a frame or two just
      // ahead of the palm, its light hard on the hand and arm and gone in a few frames, a short jet of
      // plasma down the line of fire, a faint shock ripple, gas venting back round the hand, a few
      // fast sparks, and the air over the palm shimmering.
      if (a < 0.6) {
        const f = Math.exp(-a / 0.02);
        e3.copy(palm).addScaledVector(dir, 1.0 * S);
        if (a < 0.2) {
          glow(e3, (1.8 + 1.6 * (1 - Math.exp(-a / 0.01))) * S * pk, CYAN[0] * 0.8 * f, CYAN[1] * 0.8 * f, CYAN[2] * 0.8 * f, 7 * f * pk);
          glare(e3, 14 * S * pk, CYAN[0] * 0.5 * f + 0.15 * f, CYAN[1] * 0.5 * f + 0.15 * f, CYAN[2] * 0.5 * f + 0.15 * f);
          lightK[s.side] += (MUZZLE_LIGHT * f + 60 * Math.exp(-a / 0.07)) * pk;
          lightAt[s.side].copy(palm).addScaledVector(dir, 1.2 * S);
          light += 1.4 * f;
          flashAt(0, e3, 1.8 * f * pk, 24 * S);
          const fj = Math.exp(-a / 0.04);
          if (fj > 0.02) {
            a3.copy(palm).addScaledVector(dir, 0.4 * S);
            b3.copy(palm).addScaledVector(dir, (0.4 + 5 * (1 - Math.exp(-a / 0.012))) * S);
            beam(a3, b3, 0.9 * S, 0.3 * S, CYAN[0] * 0.5 * fj, CYAN[1] * 0.5 * fj, CYAN[2] * 0.5 * fj, 2.2 * fj, CYAN[0] * 0.2 * fj, CYAN[1] * 0.2 * fj, CYAN[2] * 0.2 * fj, 0.3 * fj, seed + 7, 1, 0.3);
          }
          // The ripple lies across the line of fire, turned a touch toward the camera so it never quite collapses to a line.
          d3.copy(camPos).sub(palm).normalize();
          n3.copy(dir).addScaledVector(d3, 0.15).normalize();
          basis(n3, u3, v3);
          if (a < 0.08) {
            const fr = Math.exp(-a / 0.022);
            const R = (0.6 + 2.6 * (1 - Math.exp(-a / 0.022))) * S;
            e3.copy(palm).addScaledVector(dir, (0.5 + 8 * a) * S);
            ripple(e3, u3, v3, R, 0.12 * R, CYAN[0], CYAN[1], CYAN[2], 0.4 * fr, 0.03 * fr, seed);
          }
          basis(dir, u3, v3);
          for (let i = 0; i < EXHAUST_GAS; i++) {
            const life = 0.12 + 0.1 * hash(seed + i * 6.1);
            if (a > life) continue;
            // Out from the rim of the palm, swept back past the hand.
            const th = 2 * Math.PI * ((i + 0.5 * hash(seed + i * 2.7)) / EXHAUST_GAS);
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
            const k = 0.3 * (1 - u) * (1 - u);
            streak(a3, b3, 0.05 * S, 0.16 * S, BLUE[0] * 0.3 * k, BLUE[1] * 0.3 * k, BLUE[2] * 0.3 * k, 0, CYAN[0] * k, CYAN[1] * k, CYAN[2] * k, 0.4 * k);
          }
          for (let i = 0; i < MUZZLE_SPARKS; i++) {
            const life = 0.06 + 0.09 * hash(seed + i * 5.7);
            if (a > life) continue;
            // Mostly down the line of fire, a few flung wide.
            const th = 2 * Math.PI * hash(seed + i * 3.1);
            const spread = 0.25 + 1.1 * hash(seed + i * 9.2) ** 2;
            c3.copy(u3).multiplyScalar(Math.cos(th) * spread).addScaledVector(v3, Math.sin(th) * spread).add(dir).normalize();
            const spd = (90 + 220 * hash(seed + i * 7.3)) * S;
            a3.copy(palm).addScaledVector(dir, 0.6 * S).addScaledVector(c3, spd * Math.max(0, a - SHUTTER));
            b3.copy(palm).addScaledVector(dir, 0.6 * S).addScaledVector(c3, spd * a + 0.3 * S);
            const u = a / life;
            const k = (1 - u) * (1 - u);
            streak(a3, b3, 0.04 * S, 0.1 * S, CYAN[0] * 0.3 * k, CYAN[1] * 0.3 * k, CYAN[2] * 0.3 * k, 0, CYAN[0] * k, CYAN[1] * k, CYAN[2] * k, 1.6 * k);
          }
        }
        // Heat: a shock front racing off the palm and the air over it shimmering a while.
        e3.copy(palm).addScaledVector(dir, 1.0 * S);
        if (a < 0.25) distort.ring(e3, (0.6 + 9 * (1 - Math.exp(-a / 0.05))) * S * pk, 0.32 * S * Math.exp(-a / 0.07) * (1 - Math.exp(-a / 0.006)), hash(seed + 1.1));
        distort.heat(e3, 3.5 * S * pk, 0.16 * S * Math.exp(-a / 0.22) * (1 - Math.exp(-a / 0.02)), 2.5, hash(seed + 2.3));
      }

      // The bolt: a white-hot slug in a sheath of the palette's colour, smeared by the shutter over its
      // travel, crossing to the target at a speed the eye can follow; it lights what it passes.
      const x = v * a;
      const L = v * SHUTTER + SLUG * S * pk;
      const xHead = Math.min(x, run);
      const xTail = clamp(x - L, 0, run);
      const fade = s.miss ? 1 - smooth(0.6 * run, run, xHead) : 1;
      if (xHead - xTail > 0.01 * S && fade > 0.01) {
        a3.copy(s.from).addScaledVector(dir, xTail);
        b3.copy(s.from).addScaledVector(dir, xHead);
        const k = (1 + 0.5 * Math.exp(-a / 0.03)) * fade * pk; // hottest as it leaves the hand
        const W = BOLT_W * S * pk * (stone ? 1.25 : 1);
        beam(a3, b3, 0.35 * W, W, CYAN[0] * 0.06 * k, CYAN[1] * 0.06 * k, CYAN[2] * 0.06 * k, 0.25 * k, CYAN[0] * 0.75 * k, CYAN[1] * 0.75 * k, CYAN[2] * 0.75 * k, 4.5 * k, seed, stone ? 2.2 : 1.2, -0.45);
        if (stone) {
          // The Stone's sheath: wider, writhing, deep violet, wrapped in small arcs.
          beam(a3, b3, 0.6 * W, 2.1 * W, BLUE[0] * 0.04 * k, BLUE[1] * 0.04 * k, BLUE[2] * 0.04 * k, 0, BLUE[0] * 0.3 * k, BLUE[1] * 0.3 * k, BLUE[2] * 0.3 * k, 0, seed + 13, 3.2, -0.35);
          basis(dir, u3, v3);
          const sl = Math.floor(time * 30);
          for (let j = 0; j < 3; j++) {
            const hs = seed + sl * 1.913 + j * 7.7;
            if (hash(hs) < 0.2) continue;
            const th = 6.283 * hash(hs + 0.3);
            const span = 1.8 + 1.6 * hash(hs + 0.6);
            const back = (0.1 + 0.5 * hash(hs + 0.9)) * (xHead - xTail);
            const r0 = (0.9 + 0.5 * hash(hs + 1.2)) * W;
            f3.copy(b3).addScaledVector(dir, -back);
            a3.copy(f3).addScaledVector(u3, Math.cos(th) * r0).addScaledVector(v3, Math.sin(th) * r0);
            f3.addScaledVector(dir, -(0.3 + 0.6 * hash(hs + 1.5)) * (xHead - xTail));
            c3.copy(f3).addScaledVector(u3, Math.cos(th + span) * r0).addScaledVector(v3, Math.sin(th + span) * r0);
            arc(a3, c3, 5, 0.5 * W, hs * 3.1, 0.9 * k, 0.07 * S);
          }
          a3.copy(s.from).addScaledVector(dir, xTail);
        }
        // The slug seen through the lens, and the air round it lit.
        glow(b3, 2.4 * S * pk, CYAN[0] * 0.5 * k, CYAN[1] * 0.5 * k, CYAN[2] * 0.5 * k, 2.2 * k);
        wisp(b3, 9 * S * pk, CYAN[0] * 0.035 * k, CYAN[1] * 0.035 * k, CYAN[2] * 0.035 * k);
        lightUp(b3, BOLT_LIGHT * S * k * smooth(3 * S, 12 * S, xHead));
      }
      // The ionised trail it leaves, and the heat haze in the air behind it, fading from the palm end
      // (each point by how long ago the bolt passed it).
      {
        const ageA = a;
        const ageB = Math.max(0, a - xTail / v);
        const kB = 0.07 * Math.exp(-ageB / TRAIL_TAU) * fade;
        if (kB > 0.003 && xTail > 0.01 * S) {
          const kA = 0.07 * Math.exp(-ageA / TRAIL_TAU) * fade;
          b3.copy(s.from).addScaledVector(dir, xTail);
          const tw = stone ? 1.6 : 1;
          beam(s.from, b3, (0.3 + 2.2 * ageA) * S * tw, (0.3 + 2.2 * ageB) * S * tw, BLUE[0] * kA, BLUE[1] * kA, BLUE[2] * kA, 0, CYAN[0] * kB, CYAN[1] * kB, CYAN[2] * kB, 0.2 * kB, seed + 3, stone ? 1.4 : 0.6, 1.1);
        }
        // Haze: a string of shimmering pockets along the last of the path, each fading as it cools.
        const step = 5 * S;
        const i0 = Math.max(0, Math.floor((xHead - 60 * S) / step));
        for (let i = i0; i * step < xHead; i++) {
          const xi = i * step + step * 0.5 * hash(seed + i);
          if (xi > xHead) break;
          const age = a - xi / v;
          const kh = Math.exp(-age / 0.25) * (1 - Math.exp(-age / 0.02)) * fade;
          if (kh < 0.03) continue;
          a3.copy(s.from).addScaledVector(dir, xi);
          distort.heat(a3, (1.6 + 2 * age) * S * (stone ? 1.4 : 1), 0.22 * S * kh * pk, 2, hash(seed + i * 0.37));
        }
      }

      // Impact (a hit): the drawn part, a function of its age.
      if (!s.miss && ai >= 0 && ai < AFTER) {
        const duel = s.id < 0;
        const SI = impactScale(s, S);
        const P = impactPoint(s, S, P3);
        const pull = duel ? 7 * SI / DUEL_IMPACT + 3 : 0;
        const hk = heavy ? 1.5 : 1;
        const pf = Math.exp(-ai / 0.022); // the flash: a frame or two
        const rise = 1 - Math.exp(-ai / 0.012);
        // A blinding white point and the glare round it.
        glow(P, (3.2 + 2.2 * rise) * SI, CYAN[0] * 1.4 * pf, CYAN[1] * 1.4 * pf, CYAN[2] * 1.4 * pf, 9 * pf * hk, pull);
        if (duel) glare(P, 34 * SI * hk, (CYAN[0] * 0.5 + 0.5) * 0.9 * pf, (CYAN[1] * 0.5 + 0.5) * 0.9 * pf, (CYAN[2] * 0.5 + 0.5) * 0.9 * pf, pull + 4);
        // The fireball: the bolt's energy dumped into a ball of plasma, swelling and going out.
        const fb = Math.exp(-ai / (duel ? 0.08 : 0.05)) * (1 - Math.exp(-ai / 0.008));
        glow(P, (2.5 + 3.5 * (1 - Math.exp(-ai / 0.05))) * SI, CYAN[0] * 0.55 * fb, CYAN[1] * 0.55 * fb, CYAN[2] * 0.55 * fb, 1.6 * fb, pull);
        // Plasma lobes thrown off it, back toward the shooter and out, dissipating.
        n3.copy(dir).multiplyScalar(-1);
        const lobes = duel ? 6 : 3;
        for (let i = 0; i < lobes && ai < 0.45; i++) {
          sphereDir(hash(seed + i * 7.07), hash(seed + i * 2.22), c3).addScaledVector(n3, 0.6).normalize();
          a3.copy(P).addScaledVector(c3, (0.8 + 7 * (1 - Math.exp(-ai / 0.07))) * SI);
          const k = 0.22 * Math.exp(-ai / 0.1) * (1 - Math.exp(-ai / 0.01)) * hk;
          wisp(a3, (2.2 + 9 * ai) * SI, CYAN[0] * k, CYAN[1] * k, CYAN[2] * k, pull);
        }
        // A thin shell of plasma racing out, gone in a tenth of a second.
        if (ai < 0.14) {
          const fs = Math.exp(-ai / 0.03);
          shell(P, (0.8 + (duel ? 10 : 5) * (1 - Math.exp(-ai / 0.035))) * SI * (heavy ? 1.2 : 1), 0.07 * SI * 3, CYAN[0], CYAN[1], CYAN[2], 0.9 * fs, 0.1 * fs * pf, seed, pull);
        }
        // The shock front bending the view behind it, and the heat over the struck area.
        if (ai < 0.6) distort.ring(P, (1.5 + (duel ? 26 : 9) * (1 - Math.exp(-ai / 0.13))) * SI * (heavy ? 1.25 : 1), (duel ? 1.1 : 0.4) * SI * hk * Math.exp(-ai / 0.16) * (1 - Math.exp(-ai / 0.006)), hash(seed + 4.4));
        if (duel) distort.heat(P, 7 * SI, 0.3 * SI * Math.exp(-ai / 0.45) * (1 - Math.exp(-ai / 0.03)), 3, hash(seed + 5.5));
        // Its light: blinding for a frame or two, a short afterglow; on the dust round it too.
        a3.copy(P).addScaledVector(n3, duel ? IMPACT_BACK : 4 * S);
        lightUp(a3, (duel ? IMPACT_LIGHT * hk : 250 * S) * (pf + 0.07 * Math.exp(-ai / 0.25)));
        flashAt(1, P, (3.2 * pf + 0.4 * Math.exp(-ai / 0.12)) * (duel ? 2 * hk : 1), 30 * SI);
        // The Stone on a fighter: arcs crawling over the struck area for half a second.
        if (stone && duel && ai < 0.5) {
          const fade2 = (1 - ai / 0.5) ** 1.5;
          basis(n3, u3, v3);
          const sl = Math.floor(time * 30);
          const na = heavy ? 7 : 5;
          for (let j = 0; j < na; j++) {
            const hs = seed + sl * 2.371 + j * 11.3;
            if (hash(hs) < 0.3) continue;
            const r0 = (0.3 + 1.2 * hash(hs + 0.2)) * SI * 0.6;
            const th = 6.283 * hash(hs + 0.4);
            a3.copy(P).addScaledVector(u3, Math.cos(th) * r0).addScaledVector(v3, Math.sin(th) * r0);
            const r1 = r0 + (1.2 + 2.2 * hash(hs + 0.6)) * SI * 0.6;
            const th1 = th + (hash(hs + 0.8) - 0.5) * 2.4;
            c3.copy(P).addScaledVector(u3, Math.cos(th1) * r1).addScaledVector(v3, Math.sin(th1) * r1).addScaledVector(n3, -0.3 * SI * hash(hs + 1));
            arc(a3, c3, 6, 0.35 * SI, hs * 1.7, 1.3 * fade2, 0.05 * SI);
            glow(a3, 0.9 * SI, CYAN[0] * 0.3 * fade2, CYAN[1] * 0.3 * fade2, CYAN[2] * 0.3 * fade2, 0.6 * fade2, pull * 0.5);
          }
        }
      }
    }

    // Simulated sparks, crackle and embers.
    for (let i = 0; i < PARTS; i++) {
      const age = pt.age[i];
      const life = pt.life[i];
      if (age >= life) continue;
      const u = age / life;
      const vx = pt.v[i * 3];
      const vy = pt.v[i * 3 + 1];
      const vz = pt.v[i * 3 + 2];
      b3.set(pt.p[i * 3], pt.p[i * 3 + 1], pt.p[i * 3 + 2]);
      // Smeared over the shutter (but never longer than a few body widths).
      const sp = Math.hypot(vx, vy, vz);
      const sh = sp > 1e-3 ? Math.min(SHUTTER, (12 * S) / sp) : 0;
      a3.set(b3.x - vx * sh, b3.y - vy * sh, b3.z - vz * sh);
      const w = pt.size[i];
      const kind = pt.kind[i];
      if (kind === METAL) {
        const T = pt.heat[i] * Math.exp(-age / pt.tau[i]);
        if (T < 0.06) continue;
        blackbody(T, col);
        const f = 1 - smooth(0.7, 1, u);
        const kc = Math.max(0, T - 0.6) * 9 * f;
        streak(a3, b3, 0.6 * w, w, col[0] * 0.3 * f, col[1] * 0.3 * f, col[2] * 0.3 * f, 0, col[0] * f, col[1] * f, col[2] * f, kc);
      } else if (kind === CRACKLE) {
        // Flickering: each fleck dims and flares from one twentieth of a second to the next.
        const on = hash(pt.seed[i] + Math.floor(time * 40) * 1.37) > 0.3 ? 1 : 0.2;
        const f = (1 - u) * (1 - u) * on;
        const wh = Math.exp(-age / 0.05); // white-hot, then the Stone's violet
        const r = (CYAN[0] * (1 - wh) + wh) * 1.6 * f;
        const g = (CYAN[1] * (1 - wh) + wh) * 1.6 * f;
        const b = (CYAN[2] * (1 - wh) + wh) * 1.6 * f;
        streak(a3, b3, 0.5 * w, w, r * 0.3, g * 0.3, b * 0.3, 0, r, g, b, (0.8 + 2 * wh) * f);
      } else if (kind === EMBER) {
        const T = pt.heat[i] * Math.exp(-age / pt.tau[i]);
        if (T < 0.08) continue;
        blackbody(T, col);
        const tw = 0.75 + 0.25 * Math.sin(time * 31 + pt.seed[i] * 7);
        const f = (1 - smooth(0.75, 1, u)) * tw * 0.35;
        glow(b3, w * 2, col[0] * f, col[1] * f, col[2] * f, Math.max(0, T - 0.5) * 2 * f);
        streak(a3, b3, 0.25 * w, 0.4 * w, col[0] * 0.3 * f, col[1] * 0.3 * f, col[2] * 0.3 * f, 0, col[0] * f, col[1] * f, col[2] * f, 0);
      } else {
        // A mote of the palette's energy: white, then its colour, then a dim edge, gone.
        const cool = Math.exp(-age / pt.tau[i]) * pt.heat[i];
        const f = (1 - u) * (1 - u) * 1.2;
        const r = (CYAN[0] * (1 - u) + BLUE[0] * u) * f;
        const g = (CYAN[1] * (1 - u) + BLUE[1] * u) * f;
        const b = (CYAN[2] * (1 - u) + BLUE[2] * u) * f;
        streak(a3, b3, 0.5 * w, w, r * 0.25, g * 0.25, b * 0.25, 0, r, g, b, 2.2 * cool * f);
      }
    }

    // Smoke.
    for (let i = 0; i < SMOKES; i++) {
      const age = sm.age[i];
      const life = sm.life[i];
      if (age >= life) continue;
      const u = age / life;
      a3.set(sm.p[i * 3], sm.p[i * 3 + 1], sm.p[i * 3 + 2]);
      const grow = (1 - Math.exp(-age / 0.45)) / (1 - Math.exp(-life / 0.45));
      const size = sm.s0[i] + (sm.s1[i] - sm.s0[i]) * grow;
      const alpha = sm.a0[i] * smooth(0, 0.07, age) * (1 - u) ** 1.6;
      if (alpha < 0.004) continue;
      // Lit by the flash it was born in (and its afterglow), over a dim ambient grey.
      const fl = 3.0 * Math.exp(-age / 0.05) + 0.25 * Math.exp(-age / 0.3);
      const g = sm.grey[i];
      const hot = 0.9 * Math.exp(-age / 0.22);
      b3.set(sm.src[i * 3], sm.src[i * 3 + 1], sm.src[i * 3 + 2]).sub(a3);
      const la = Math.atan2(b3.dot(camU), b3.dot(camR));
      puff(a3, size / 2, sm.ang[i] + sm.spin[i] * age, sm.cell[i], size * 0.35, g + sm.fl[i * 3] * fl, g + sm.fl[i * 3 + 1] * fl, g * 1.05 + sm.fl[i * 3 + 2] * fl, alpha, sm.hot[i * 3] * hot, sm.hot[i * 3 + 1] * hot, sm.hot[i * 3 + 2] * hot, la);
    }

    // Debris.
    let nc = 0;
    for (let i = 0; i < CHUNKS; i++) {
      const age = ch.age[i];
      if (age >= ch.life[i]) continue;
      const sz = ch.size[i] * (1 - smooth(0.8, 1, age / ch.life[i]));
      a3.set(ch.p[i * 3], ch.p[i * 3 + 1], ch.p[i * 3 + 2]);
      c3.set(ch.axis[i * 3], ch.axis[i * 3 + 1], ch.axis[i * 3 + 2]);
      quat.setFromAxisAngle(c3, ch.spin[i] * age);
      scl.set(ch.shape[i * 3] * sz, ch.shape[i * 3 + 1] * sz, ch.shape[i * 3 + 2] * sz);
      mat4.compose(a3, quat, scl);
      chunks.setMatrixAt(nc++, mat4);
      // Still glowing from the blast for a moment.
      const T = ch.heat[i] * Math.exp(-age / 0.35);
      if (T > 0.1) {
        blackbody(T, col);
        glow(a3, sz * 3, col[0] * 0.25, col[1] * 0.25, col[2] * 0.25, 0);
      }
    }
    chunks.count = nc;
    chunks.visible = nc > 0;
    if (nc) chunks.instanceMatrix.needsUpdate = true;

    // Thrusters: a jet plume from each boot (off the ground) and palm (in flight, or
    // steadying a hover), streaming away from his head: white-hot at the nozzle, into a
    // sheath that widens and fades, flickering down its length, with faint shock diamonds.
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
      beam(p, b3, 1.1 * sz, 2.6 * sz, CYAN[0] * 0.5 * k, CYAN[1] * 0.5 * k, CYAN[2] * 0.5 * k, 1.2 * k, BLUE[0] * 0.05 * k, BLUE[1] * 0.05 * k, BLUE[2] * 0.05 * k, 0, 17.3 * i, 1.6, 0.5);
      // Shock diamonds: small bright knots spaced down the core, each fainter.
      for (let j = 0; j < 3; j++) {
        const at = (0.2 + 0.17 * j) * L;
        const h = 0.07 * L;
        const kd = k * (0.4 - 0.1 * j) * (0.8 + 0.2 * Math.sin(time * 71 + i * 3 + j * 2));
        a3.copy(p).addScaledVector(d3, at - h);
        b3.copy(p).addScaledVector(d3, at);
        streak(a3, b3, 0.08 * sz, (0.4 - 0.06 * j) * sz, CYAN[0] * kd, CYAN[1] * kd, CYAN[2] * kd, 0, CYAN[0] * kd, CYAN[1] * kd, CYAN[2] * kd, 0.9 * kd);
        a3.copy(p).addScaledVector(d3, at + h);
        streak(b3, a3, (0.4 - 0.06 * j) * sz, 0.08 * sz, CYAN[0] * kd, CYAN[1] * kd, CYAN[2] * kd, 0.9 * kd, CYAN[0] * kd, CYAN[1] * kd, CYAN[2] * kd, 0);
      }
      // The nozzle itself, white-hot, and the air behind it shimmering.
      e3.copy(p).addScaledVector(d3, 0.3 * sz);
      glow(e3, 3 * sz, CYAN[0] * 0.3 * k, CYAN[1] * 0.3 * k, CYAN[2] * 0.3 * k, 1.1 * k);
      a3.copy(p).addScaledVector(d3, 0.6 * L);
      distort.heat(a3, 0.5 * L + 2 * sz, 0.12 * sz * k, 2.5, 0.13 * i);
      if (isPalm) {
        light += 0.5 * pw;
        lightK[i === 2 ? 'L' : 'R'] += 25 * pw;
        lightAt[i === 2 ? 'L' : 'R'].copy(e3);
      }
    }

    // Exhaust: sparks shooting back from boots (and palms in flight), smeared by the shutter.
    const edt = Math.min(Math.max(dt || 0, 0), 0.1);
    ex.acc += edt * 60 * thrust;
    while (ex.acc >= 1) {
      ex.acc -= 1;
      const n = Math.random() < (fly > 0.3 ? 0.5 : 1) ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
      const p = n < 2 ? soles[n] : palms[n === 2 ? 'L' : 'R'];
      const s = (70 + 60 * fly) * scale;
      const i = ex.next;
      ex.next = (ex.next + 1) % EXHAUST;
      ex.p.set([p.x, p.y, p.z], i * 3);
      ex.v.set([-head.x * s + (Math.random() - 0.5) * 16 + vel.x * 0.6, -head.y * s + (Math.random() - 0.5) * 16 + vel.y * 0.6, -head.z * s + (Math.random() - 0.5) * 16 + vel.z * 0.6], i * 3);
      ex.age[i] = 0;
      ex.life[i] = 0.12 + Math.random() * 0.16;
      ex.size[i] = 0.12 * scale * unit;
    }
    for (let i = 0; i < EXHAUST; i++) {
      if (ex.age[i] >= ex.life[i]) continue;
      ex.age[i] += edt;
      const u = ex.age[i] / ex.life[i];
      if (u >= 1) continue;
      for (let j = 0; j < 3; j++) ex.p[i * 3 + j] += ex.v[i * 3 + j] * edt;
      b3.set(ex.p[i * 3], ex.p[i * 3 + 1], ex.p[i * 3 + 2]);
      a3.set(b3.x - ex.v[i * 3] * SHUTTER, b3.y - ex.v[i * 3 + 1] * SHUTTER, b3.z - ex.v[i * 3 + 2] * SHUTTER);
      // White-blue at birth, cooling to amber as it fades.
      const k = (1 - u) * (1 - u) * 0.8;
      streak(a3, b3, 0.5 * ex.size[i], ex.size[i], 0.5 * k * 0.3, 0.7 * k * 0.3, k * 0.3, 0, (0.5 + 0.5 * u) * k, 0.7 * (1 - 0.35 * u) * k, (1 - 0.75 * u) * k, 0.6 * k * (1 - u));
    }

    streaks.end();
    beams.end();
    quads.end();
    smoke.end();
    distort.end();
    for (const n of SIDES) {
      palmLights[n].position.copy(lightAt[n]);
      palmLights[n].intensity = lightK[n];
      palmLights[n].distance = PALM_LIGHT_RANGE * S;
    }
    blastLight.position.copy(blast.p);
    blastLight.intensity = blast.k;
    // (Anything burning bright this frame: the pass guards the bloom against an overflowing pixel.)
    reg.active = blast.k > 1 || lightK.L > 30 || lightK.R > 30 || streaks.count > 0 || beams.count > 0;
    out.light = Math.min(light, 2);
    return out;
  }

  return { group, update, distort: distort.mesh };
}
