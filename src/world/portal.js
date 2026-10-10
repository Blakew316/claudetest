/**
 * The Space Stone's portal, which Thanos walks through (see sim/director.js,
 * stepFoe): a ring of blue fire stood on end, opening out from a point,
 * swirling as it burns, a deep shimmer spiralling in across it, and closing
 * back to a point behind him. Additive, so it burns into the bloom.
 */

import * as THREE from 'three';

const RING = 0.82; // the ring's radius, as a share of the quad's half-size
const RADIUS = 32; // world units (Thanos stands ~51 tall)
const CENTRE_Y = 27; // its centre above the ground he walks on

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
  vec3 col = hot * ring * (0.5 + 0.6 * n) + blue * (0.6 * halo + inside + arms);
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
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
    material.uniforms.uTime.value = time;
    material.uniforms.uOpen.value = Math.min(1, 1.5 * o);
  }

  return { mesh, update };
}
