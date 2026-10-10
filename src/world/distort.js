/**
 * Screen-space heat distortion for the blasts (world/repulsor.js), and the
 * hand-off of their flashes to the dust.
 *
 * The effects that bend light (a shock front racing out from an impact, the
 * heat a bolt leaves in the air, the shimmer over a palm that just fired) draw
 * into their own scene, distortScene: camera-facing quads whose shader writes
 * an offset (rg, in normalised device units: where to look instead for the
 * scene behind) into a half-resolution float buffer. A pass placed after the
 * scene's render and before the bloom looks the scene up through it, with a
 * touch of dispersion where it bends hardest, as a real lens of hot air would.
 * It also holds every pixel to a finite value before the bloom (an overflowing
 * one would be smeared into a glowing square). With nothing distorting and
 * nothing burning bright the pass switches itself off and costs nothing.
 *
 * Wiring (view3d.js): createDistortPass(renderer) -> { pass, setSize, render };
 * add `pass` to the composer right after the RenderPass, call setSize with the
 * drawing buffer's size, and render(camera, uFlashP, uFlashK) just before
 * composer.render() (it also merges the brightest muzzle flash and impact of
 * every visible fighter into the dust's two flash slots).
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** What the distorting effects draw into (each effect module adds its pool here). */
export const distortScene = new THREE.Scene();

const fxs = []; // { group, mesh, flashes }: every effects module, for the frame hook

/** An effects module: its world group (for visibility), its distortion mesh and its two flashes (muzzle, impact). */
export function registerFx(fx) {
  fxs.push(fx);
  distortScene.add(fx.mesh);
}

/** Whether an object is drawn: it and all its parents visible, under a scene. */
function shown(o) {
  let x = o;
  for (; x; x = x.parent) {
    if (!x.visible) return false;
    if (x.isScene) return true;
  }
  return false;
}

const RING = 0; // kinds: a shock front, refracting like a ring lens
const HEAT = 1; // ... turbulent shimmer under a soft envelope

/**
 * A pool of distorting quads (camera-facing, sized in world units), drawn as one mesh.
 * Strengths are world units of apparent displacement at the quad's depth, so a far
 * shock front bends fewer pixels than a near one.
 */
export function createDistortPool(n) {
  const g = new THREE.BufferGeometry();
  const P = new Float32Array(n * 4 * 3);
  const C = new Float32Array(n * 4 * 2);
  const D = new Float32Array(n * 4 * 4);
  const idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    C.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
  }
  const dyn = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', dyn(P, 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(C, 2));
  g.setAttribute('aD', dyn(D, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec4 aD; // half-size (world), kind + seed (kind in the integer part), p1, strength (world)
      varying vec2 vUv;
      varying vec4 vD;
      varying vec2 vK;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aCorner * aD.x;
        gl_Position = projectionMatrix * mv;
        float depth = max(1.0, -mv.z);
        vK = vec2(projectionMatrix[0][0], projectionMatrix[1][1]) / depth; // device units per world unit there
        vUv = aCorner;
        vD = aD;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vD;
      varying vec2 vK;
      float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash2(i), b = hash2(i + vec2(1.0, 0.0)), c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
      }
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float kind = floor(vD.y);
        float seed = fract(vD.y) * 100.0;
        vec2 o;
        if (kind < 0.5) {
          // A shock front: a thin shell of compressed air, bending light by the slope of its thickness
          // (outward ahead of the front, inward behind it), a little uneven round its circumference.
          float ang = atan(vUv.y, vUv.x);
          float R = vD.z * (1.0 + 0.025 * sin(ang * 5.0 + seed) + 0.02 * sin(ang * 11.0 - seed * 1.3));
          float w = 0.12 * vD.z + 0.035;
          float x = (r - R) / w;
          float h = exp(-x * x);
          o = (vUv / max(r, 1e-4)) * (-2.0 * x * h);
        } else {
          // Heat: a field of small, quick swirls of offset, rising through a soft envelope.
          float env = exp(-r * r * 3.0) * (1.0 - r * r);
          vec2 q = vUv * vD.z + vec2(seed, seed * 1.7) + vec2(0.0, -uTime * 2.6);
          o = vec2(vnoise(q) + 0.5 * vnoise(q * 2.3 + 7.1), vnoise(q + 17.3) + 0.5 * vnoise(q * 2.3 - 3.9)) * env;
        }
        o *= vD.w * (1.0 - smoothstep(0.82, 1.0, r));
        gl_FragColor = vec4(o * vK, 0.0, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  let count = 0;
  /** One quad at p, half-size h (world), kind, seed (0..1), p1, strength (world units). */
  function add(p, h, kind, seed, p1, strength) {
    if (count >= n || !(h > 0) || Math.abs(strength) < 1e-5) return;
    for (let v = 0; v < 4; v++) {
      const j = count * 4 + v;
      P[j * 3] = p.x;
      P[j * 3 + 1] = p.y;
      P[j * 3 + 2] = p.z;
      D[j * 4] = h;
      D[j * 4 + 1] = kind + Math.min(0.999, Math.max(0, seed));
      D[j * 4 + 2] = p1;
      D[j * 4 + 3] = strength;
    }
    count++;
  }
  return {
    mesh,
    begin(time) {
      count = 0;
      material.uniforms.uTime.value = time;
    },
    /** A shock front: centre, outer radius R (world), strength (world units of displacement at the front). */
    ring(p, R, strength, seed = 0) {
      const h = R * 1.25 + 0.5;
      add(p, h, RING, seed, R / h, strength);
    },
    /** Heat shimmer: centre, radius (world), strength, swirl density (cycles across it), seed. */
    heat(p, R, strength, density = 3, seed = 0) {
      add(p, R, HEAT, seed, density, strength);
    },
    end() {
      g.setDrawRange(0, count * 6);
      if (count) {
        for (const name of ['position', 'aD']) {
          const a = g.attributes[name];
          a.clearUpdateRanges();
          a.addUpdateRange(0, count * 4 * a.itemSize);
          a.needsUpdate = true;
        }
      }
      mesh.visible = count > 0;
    },
    get count() {
      return count;
    },
  };
}

/**
 * The pass: renders distortScene into a half-res float buffer and looks the
 * frame up through it. render(camera, flashP?, flashK?) once a frame before
 * composer.render(); setSize(w, h) with the drawing buffer's size.
 */
export function createDistortPass(renderer) {
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  const material = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, tDistort: { value: rt.texture }, uOn: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform sampler2D tDistort;
      uniform float uOn;
      varying vec2 vUv;
      void main() {
        vec4 c;
        if (uOn > 0.5) {
          vec2 o = 0.5 * texture2D(tDistort, vUv).rg; // device units -> uv
          c = texture2D(tDiffuse, vUv - o);
          c.r = texture2D(tDiffuse, vUv - o * 1.06).r;
          c.b = texture2D(tDiffuse, vUv - o * 0.94).b;
        } else {
          c = texture2D(tDiffuse, vUv);
        }
        // An overflowing pixel (inf or nan: a light too close to a mirror-like plate) would be smeared by
        // the bloom into a glowing square: hold every pixel to a bright but finite value.
        c.rgb = clamp(c.rgb, 0.0, 48.0);
        gl_FragColor = c;
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const pass = new ShaderPass(material);
  pass.enabled = false;
  const clear = new THREE.Color();
  const best = [null, null];
  return {
    pass,
    setSize(w, h) {
      rt.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    },
    /**
     * Draw this frame's distortion (and, given the dust's flash uniforms, hand it the brightest
     * muzzle flash and impact of any fighter in view).
     * @param {THREE.Camera} camera
     * @param {THREE.Vector4[]} [flashP] uFlashP: where, and the radius lit
     * @param {THREE.Vector2} [flashK] uFlashK: how much brighter
     */
    render(camera, flashP, flashK) {
      let any = false;
      let hot = false;
      best[0] = best[1] = null;
      for (const fx of fxs) {
        const on = shown(fx.group);
        fx.mesh.visible = on && fx.mesh.geometry.drawRange.count > 0;
        any = any || fx.mesh.visible;
        if (!on) continue;
        hot = hot || !!fx.active;
        for (let i = 0; i < 2; i++) if (fx.flashes[i].k > (best[i] ? best[i].k : 0)) best[i] = fx.flashes[i];
      }
      if (flashP && flashK) {
        for (let i = 0; i < 2; i++) {
          const f = best[i];
          if (f) flashP[i].set(f.p.x, f.p.y, f.p.z, f.r);
          flashK.setComponent(i, f ? f.k : 0);
        }
      }
      pass.enabled = any || hot;
      material.uniforms.uOn.value = any ? 1 : 0;
      if (!any) return;
      const prev = renderer.getRenderTarget();
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(distortScene, camera);
      renderer.setRenderTarget(prev);
      renderer.setClearColor(clear, alpha);
    },
  };
}
