/**
 * The Space Stone's portal, which Thanos walks through (see sim/director.js,
 * stepFoe): a ring of blue fire stood on end, opening out from a point,
 * swirling as it burns, a deep shimmer spiralling in across it, and closing
 * back to a point behind him. Additive, so it burns into the bloom.
 *
 * The ring is a torus in the proportions of the portal model supplied for it
 * (a 3ds Max torus, tube TUBE of its radius), its fire the model's noise map
 * (assets/portal/noise.webp, from Map__1_Noise.tga) streaming round it; the
 * swirl across it is drawn on a disc inside.
 */

import * as THREE from 'three';
import NOISE from '../../assets/portal/noise.webp';

const RING = 0.82; // the ring's radius, as a share of the quad's half-size
const RADIUS = 32; // world units (Thanos stands ~51 tall)
const CENTRE_Y = 27; // its centre above the ground he walks on
const TUBE = 0.079; // the ring's tube, of its radius

const ringVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const ringFragment = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform float uOpen;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  // The fire streams round the ring and rolls round its tube, two layers of the noise at different scales.
  float n1 = texture2D(uNoise, vec2(vUv.x * 5.0 - uTime * 0.35, vUv.y + uTime * 0.25)).r;
  float n2 = texture2D(uNoise, vec2(vUv.x * 13.0 + uTime * 0.6, vUv.y * 2.0 - uTime * 0.5)).r;
  float n = 0.6 * n1 + 0.4 * n2;
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.5);
  vec3 blue = vec3(0.07, 0.32, 1.0);
  vec3 hot = vec3(0.5, 0.82, 1.0);
  vec3 col = mix(blue, hot, smoothstep(0.45, 0.85, n)) * (0.3 + 1.2 * n) * (0.55 + 0.9 * rim);
  gl_FragColor = vec4(col * uOpen, 1.0);
}`;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uOpen;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  // The fire swirls round the ring, and in across it.
  float sw = a + uTime * 1.6 + r * 3.0;
  float n = 0.6 * noise(vec2(sw * 2.5, r * 8.0 - uTime * 2.0)) + 0.4 * noise(vec2(sw * 6.0, r * 20.0 + uTime * 3.0));
  float ring = exp(-pow((r - ${RING.toFixed(2)} - (n - 0.5) * 0.07) / 0.035, 2.0));
  float halo = 0.35 * exp(-pow((r - ${RING.toFixed(2)}) / 0.14, 2.0));
  float inside = smoothstep(${RING.toFixed(2)}, ${(RING - 0.15).toFixed(2)}, r) * (0.12 + 0.22 * n);
  float arms = 0.3 * pow(0.5 + 0.5 * sin(sw * 5.0 - r * 12.0), 6.0) * smoothstep(${RING.toFixed(2)}, 0.2, r);
  vec3 hot = vec3(0.35, 0.7, 1.0);
  vec3 blue = vec3(0.06, 0.28, 0.9);
  vec3 col = hot * ring * (0.2 + 0.25 * n) + blue * (0.6 * halo + inside + arms);
  gl_FragColor = vec4(col * uOpen * smoothstep(1.0, 0.94, r), 1.0);
}`;

export function createPortal() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpen: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  disc.frustumCulled = false;
  const noise = new THREE.TextureLoader().load(NOISE);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { uNoise: { value: noise }, uTime: { value: 0 }, uOpen: { value: 0 } },
    vertexShader: ringVertex,
    fragmentShader: ringFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(RING, RING * TUBE, 24, 128), ringMat);
  ring.frustumCulled = false;
  const mesh = new THREE.Group(); // (the disc is a quad of half-size 1, the ring's radius RING of it)
  mesh.add(disc, ring);
  mesh.visible = false;
  const at = new THREE.Vector3();

  /**
   * Place and draw it for a frame.
   * @param {{x:number, y:number, z:number, nx:number, nz:number, open:number}|null} P run.foe.portal
   * @param {number} time seconds
   */
  function update(P, time) {
    mesh.visible = !!P && P.open > 0;
    if (!mesh.visible) return;
    // (It bursts open fast and settles; closing, it shrinks back to a point.)
    const o = P.open;
    const grow = 1 - (1 - o) ** 3;
    mesh.position.set(P.x, P.y + CENTRE_Y, P.z);
    mesh.lookAt(at.set(P.x + P.nx, P.y + CENTRE_Y, P.z + P.nz));
    mesh.scale.setScalar((RADIUS / RING) * (0.04 + 0.96 * grow));
    material.uniforms.uTime.value = ringMat.uniforms.uTime.value = time;
    material.uniforms.uOpen.value = ringMat.uniforms.uOpen.value = Math.min(1, 1.5 * o);
  }

  return { mesh, update };
}
