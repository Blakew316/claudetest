/**
 * The Iron Man model: a rigged, skinned suit from CGTrader (supplied with the
 * project; Iron Man is Marvel's), converted from the artist's FBX for the web:
 * the deform bones of its Rigify rig in a clean hierarchy, the mesh welded at
 * full resolution (some 290k triangles, so the plates' bevels and the
 * silhouette hold up in close-up) and meshopt-compressed, and the artist's
 * five poses baked onto the deform bones (poses.json: per bone, the local
 * quaternion and position). joints.json holds every bone's rest position in
 * model units (feet at y = 0, facing +z, his left at +x).
 *
 * The artist's maps are near flat (the normal maps carry no panel detail: the
 * detail is all in the geometry), so the close-up realism comes from the
 * shading: ambient occlusion baked per vertex (the _OCCLUSION attribute: x the
 * crevices and joints within ~10 cm, y the panel lines within ~1.5 cm),
 * candy-red paint under a clear coat (with metallic flake), brushed gold and
 * gunmetal (MikkTSpace tangents on those two, so the anisotropic highlight
 * runs smoothly instead of breaking on every triangle), lights with hot white
 * cores, a studio-in-space environment that turns with the camera, and a key
 * light that casts his own shadows.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import GLB from '../../assets/ironman-mk/ironman.glb';
import POSES from '../../assets/ironman-mk/poses.json';
import JOINTS from '../../assets/ironman-mk/joints.json';
import GOLD_COLOR from '../../assets/ironman-mk/gold_color.webp';
import GOLD_ORM from '../../assets/ironman-mk/gold_orm.webp';
import SILVER_COLOR from '../../assets/ironman-mk/silver_color.webp';
import SILVER_ORM from '../../assets/ironman-mk/silver_orm.webp';
import LIGHT_EMISSIVE from '../../assets/ironman-mk/light_emissive.webp';

/** Rest positions of the deform bones (model units). */
export const JOINT = JOINTS;
/** The artist's poses: 'T Pose', 'pose 2', 'Fly Pose', 'Fire Pose', 'Landing Pose'. */
export const POSE = POSES;
/** Height of the model, feet to crown (model units). */
export const MODEL_HEIGHT = 3.585;

const ENV_W = 1024; // the environment's equirect width (PMREM cube faces of a quarter of that)
const AO_STRENGTH = 1; // the baked occlusion: crevices and joints (indirect light)
const CAVITY_STRENGTH = 0.85; // ... and the panel lines, which shade the direct light too (micro-shadowing)
const POLISHED_ROUGHNESS = 0.17; // the faceplate's gold
const HEAD_BONE = 'DEF-spine006'; // what carries the faceplate
// The brightest the suit's reflected light may get: above the knee it rolls off toward the cap, its channels
// scaled together so hot gold keeps its colour (there is no tone mapping after: per-channel clipping turned
// the brightest plates into a flat yellow-white haze that bloomed). A point light's glint on the near-mirror
// clear coat is otherwise thousands of times white. The lights' own emission is left alone: they should burn.
const HIGHLIGHT_KNEE = 0.75;
const HIGHLIGHT_CAP = 1.1;
// The lights' emission at their white cores (linear): well over the bloom threshold, so even the eye slits glow.
const LIGHT_GLOW = 3.5;

/*
 * The environment the armour reflects, drawn on the GPU into an equirect: deep space with faint nebulae and
 * stars, lit like a studio (a big warm softbox over the camera's left shoulder, a hard strip on its right for
 * the long highlights down the plates, a soft top light) and cyan and blue-white rim strips behind him (the
 * glow of the stardust below him is added in the shader: see GROUND_GLSL). Its frame: +z toward the camera,
 * +x the camera's right; the materials turn it with the camera (see suitLights().place).
 */
const ENV_FRAG = /* glsl */ `
varying vec2 vUv;
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
// A rounded-rectangle area light seen in direction d: centred on c, its long side along up.
float softbox(vec3 d, vec3 c, vec3 up, vec2 halfSize, float soft) {
  c = normalize(c);
  float k = dot(d, c);
  if (k <= 0.0) return 0.0;
  vec3 p = d / k - c;
  vec3 r = normalize(cross(c, up));
  vec3 u = cross(r, c);
  vec2 q = abs(vec2(dot(p, r), dot(p, u))) - halfSize;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, sd);
}
void main() {
  float lon = (vUv.x - 0.5) * 6.2831853;
  float lat = (vUv.y - 0.5) * 3.1415927;
  vec3 d = vec3(cos(lon) * cos(lat), sin(lat), sin(lon) * cos(lat));
  vec3 Y = vec3(0.0, 1.0, 0.0);
  // Deep space, a touch lighter overhead, and nebulae.
  vec3 col = vec3(0.004, 0.005, 0.010) * (1.2 + 0.8 * d.y);
  float n1 = fbm(d * 2.3 + 4.1), n2 = fbm(d * 3.1 - 2.7);
  col += vec3(0.30, 0.16, 0.62) * 0.10 * smoothstep(0.45, 0.85, n1);
  col += vec3(0.10, 0.42, 0.62) * 0.08 * smoothstep(0.5, 0.9, n2);
  // (The glow of the stardust below him is added in the suit's shader, in the colour of where he is.)
  // Stars, soft and a texel or two across (so their reflections are points, not squares).
  vec3 g = d * 180.0;
  vec3 cell = floor(g);
  float h = hash13(cell);
  if (h > 0.985) {
    vec3 sp = cell + 0.5 + 0.3 * (vec3(hash13(cell + 7.1), hash13(cell + 3.3), hash13(cell + 5.9)) - 0.5);
    float r = length(g - sp);
    col += mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.65), hash13(cell + 1.7)) * (1.5 + 4.0 * hash13(cell + 9.2)) * exp(-r * r * 9.0);
  }
  // The studio.
  col += vec3(1.00, 0.93, 0.84) * 2.2 * softbox(d, vec3(-0.55, 0.55, 0.65), Y, vec2(0.42, 0.7), 0.22); // key
  col += vec3(0.86, 0.92, 1.00) * 2.2 * softbox(d, vec3(0.85, 0.22, 0.48), Y, vec2(0.06, 1.1), 0.12); // strip
  col += vec3(0.80, 0.86, 1.00) * 0.5 * softbox(d, vec3(0.0, 1.0, 0.12), vec3(0.0, 0.0, 1.0), vec2(0.9, 0.35), 0.4); // top
  col += vec3(0.45, 0.82, 1.00) * 2.0 * softbox(d, vec3(-0.85, 0.25, -0.55), Y, vec2(0.10, 0.9), 0.08); // cyan rim
  col += vec3(0.66, 0.72, 1.00) * 2.0 * softbox(d, vec3(0.85, 0.15, -0.55), Y, vec2(0.08, 0.8), 0.08); // blue-white rim
  gl_FragColor = vec4(col, 1.0);
}`;

/** The environment as a PMREM texture (see ENV_FRAG); made once, shared by every figure that reflects it. */
let spaceEnv = null;
export function spaceEnvironment(renderer) {
  if (spaceEnv) return spaceEnv;
  const rt = new THREE.WebGLRenderTarget(ENV_W, ENV_W / 2, { type: THREE.HalfFloatType, depthBuffer: false });
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: ENV_FRAG, depthTest: false, depthWrite: false }),
  );
  const scene = new THREE.Scene();
  scene.add(quad);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.setRenderTarget(prev);
  rt.texture.mapping = THREE.EquirectangularReflectionMapping;
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromEquirectangular(rt.texture).texture;
  pm.dispose();
  rt.dispose();
  quad.geometry.dispose();
  quad.material.dispose();
  spaceEnv = tex;
  return tex;
}

/*
 * Shader additions, shared by the suit's materials (onBeforeCompile).
 * Occlusion: the baked per-vertex terms replace three's aoMap step; the cavity term also shades the direct
 * light, as the panel lines' walls would. Candy: the red lacquer absorbs along the path the light takes through
 * it, so the paint deepens toward the silhouette. Flakes: tiny metal mirrors under the clear coat that glint,
 * fading to the smooth average where a pixel covers many. Brushed: roughness streaks along the grain (the
 * anisotropic highlight runs the same way).
 */
const NOISE_GLSL = /* glsl */ `
varying vec2 vOcclusion;
varying vec3 vRest;
varying float vHead;
uniform vec3 uGroundGlow;
float sdHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 sdHash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float sdNoise1(float x) { float i = floor(x), f = fract(x); return mix(sdHash12(vec2(i, 0.37)), sdHash12(vec2(i + 1.0, 0.37)), f * f * (3.0 - 2.0 * f)); }
`;
const AO_GLSL = /* glsl */ `
float ambientOcclusion = mix(1.0, vOcclusion.x, ${AO_STRENGTH.toFixed(3)});
float cavity = mix(1.0, vOcclusion.y * mix(1.0, vOcclusion.x, 0.5), ${CAVITY_STRENGTH.toFixed(3)});
// A panel line's walls hide most of the sky from its floor, reflections included.
float cavitySpec = mix(1.0, cavity, 0.7);
reflectedLight.indirectDiffuse *= ambientOcclusion * cavity;
reflectedLight.directDiffuse *= cavity;
reflectedLight.directSpecular *= cavity;
#if defined( USE_CLEARCOAT )
  clearcoatSpecularIndirect *= ambientOcclusion * cavitySpec;
  clearcoatSpecularDirect *= cavity;
#endif
#if defined( USE_ENVMAP )
  float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness ) * cavitySpec;
#endif
`;
// The stardust below him glows up at the suit in its own colour (uGroundGlow, set from the scene each
// frame): reflected in the metal and the clear coat, and as a soft light from below. In world space (the
// environment only ever turns about the vertical).
const GROUND_GLSL = /* glsl */ `
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
{
  vec3 nW = inverseTransformDirection(geometryNormal, viewMatrix);
  vec3 rW = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
  iblIrradiance += PI * envMapIntensity * uGroundGlow * pow2(0.5 - 0.5 * nW.y);
  radiance += envMapIntensity * uGroundGlow * (1.0 - smoothstep(-0.7, 0.1 + 0.4 * material.roughness, rW.y));
  #ifdef USE_CLEARCOAT
    vec3 rC = inverseTransformDirection(reflect(-geometryViewDir, geometryClearcoatNormal), viewMatrix);
    clearcoatRadiance += envMapIntensity * uGroundGlow * (1.0 - smoothstep(-0.7, 0.1 + 0.4 * material.clearcoatRoughness, rC.y));
  #endif
}
#endif
`;
const CAP_GLSL = /* glsl */ `
{
  vec3 refl = max(outgoingLight - totalEmissiveRadiance, 0.0);
  float peak = max(max(refl.r, refl.g), refl.b);
  if (peak > ${HIGHLIGHT_KNEE.toFixed(2)}) {
    float over = peak - ${HIGHLIGHT_KNEE.toFixed(2)};
    refl *= (${HIGHLIGHT_KNEE.toFixed(2)} + over / (1.0 + over / ${(HIGHLIGHT_CAP - HIGHLIGHT_KNEE).toFixed(2)})) / peak;
  }
  outgoingLight = refl + totalEmissiveRadiance;
}
#include <opaque_fragment>
`;
const CANDY_GLSL = /* glsl */ `
{
  float nvC = clamp(dot(normal, normalize(vViewPosition)), 0.08, 1.0);
  diffuseColor.rgb *= pow(CANDY_T, vec3(1.0 / nvC - 1.0));
}
`;
const FLAKES_GLSL = /* glsl */ `
{
  // Round flakes in the suit's own (rest-pose) space, so they sit still on it and are not stretched by the
  // UV layout: two lattices of different pitch, each cell holding a flake or not, anywhere it fits in the
  // cell, so no grid shows.
  vec3 tilt = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    vec3 fp = vRest * (FLAKE_SCALE * (1.0 + 0.37 * fk)) + fk * vec3(0.43, 0.29, 0.61);
    vec3 cell = floor(fp) + fk * 101.0;
    vec3 fh = sdHash33(cell);
    vec3 jit = sdHash33(cell + 17.0);
    float inFlake = step(0.3, sdHash33(cell + 53.0).x) * (1.0 - smoothstep(0.22, 0.3, length(fract(fp) - 0.5 - 0.4 * (jit - 0.5))));
    float vis = 1.0 - smoothstep(0.25, 0.9, length(fwidth(fp)));
    tilt += (fh - 0.5) * (2.0 * FLAKE_TILT * vis * inFlake);
  }
  normal = normalize(normal + tilt - dot(tilt, normal) * normal);
}
`;
const BRUSHED_GLSL = /* glsl */ `
// The faceplate (the plates the head carries) is polished, not brushed: no streaks, no anisotropy.
float suitBrushed = 1.0 - smoothstep(0.5, 0.9, vHead);
{
  float s = vUv.y * BRUSH_SCALE;
  float fade = suitBrushed * (1.0 - smoothstep(0.3, 1.0, fwidth(s)));
  float streak = 0.6 * sdNoise1(s) + 0.4 * sdNoise1(s * 3.7 + 11.0);
  roughnessFactor = clamp(roughnessFactor * (1.0 + BRUSH_AMP * fade * (streak - 0.5)), 0.0, 1.0);
  roughnessFactor = mix(${POLISHED_ROUGHNESS.toFixed(3)}, roughnessFactor, suitBrushed);
}
`;
/** three's physical lighting set-up, with the anisotropy scaled by how brushed the surface is. */
const BRUSHED_LIGHTS_GLSL = THREE.ShaderChunk.lights_physical_fragment.replace(
  'vec2 anisotropyV = anisotropyVector;',
  'vec2 anisotropyV = anisotropyVector * max(suitBrushed, 1e-3);',
);

/**
 * Give a material the suit's shader additions.
 * @param {THREE.MeshPhysicalMaterial} m
 * @param {{candy?:number[], flakes?:{scale:number, tilt:number}, brushed?:{scale:number, amp:number}}} o
 */
function detail(m, o = {}) {
  const defs = [];
  if (o.candy) defs.push(`#define CANDY_T vec3(${o.candy.map((x) => x.toFixed(3)).join(', ')})`);
  if (o.flakes) defs.push(`#define FLAKE_SCALE ${o.flakes.scale.toFixed(1)}`, `#define FLAKE_TILT ${o.flakes.tilt.toFixed(3)}`);
  if (o.brushed) defs.push(`#define BRUSH_SCALE ${o.brushed.scale.toFixed(1)}`, `#define BRUSH_AMP ${o.brushed.amp.toFixed(3)}`);
  if (o.brushed) m.defines = { ...m.defines, USE_UV: '' };
  // (The head bone's index in the mesh's skeleton, set once the model is parsed: see loadModel.)
  m.userData.headBone = { value: -1 };
  m.onBeforeCompile = (sh) => {
    // How much of a vertex the head carries (for the faceplate).
    const head = '#ifdef USE_SKINNING\nvHead = dot(skinWeight, vec4(equal(skinIndex, vec4(uHeadBone))));\n#else\nvHead = 0.0;\n#endif';
    sh.uniforms.uHeadBone = m.userData.headBone;
    sh.uniforms.uGroundGlow = groundGlow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 occlusion;\nvarying vec2 vOcclusion;\nvarying vec3 vRest;\nuniform float uHeadBone;\nvarying float vHead;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvOcclusion = occlusion;\nvRest = position;\n${head}`);
    let fs = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${defs.join('\n')}\n${NOISE_GLSL}`)
      .replace('#include <aomap_fragment>', AO_GLSL)
      .replace('#include <lights_fragment_maps>', GROUND_GLSL)
      .replace('#include <opaque_fragment>', CAP_GLSL);
    if (o.brushed) {
      fs = fs
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${BRUSHED_GLSL}`)
        .replace('#include <lights_physical_fragment>', BRUSHED_LIGHTS_GLSL);
    }
    if (o.flakes) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FLAKES_GLSL}`);
    if (o.candy) fs = fs.replace('#include <lights_physical_fragment>', `${CANDY_GLSL}\n#include <lights_physical_fragment>`);
    sh.fragmentShader = fs;
  };
  const key = JSON.stringify(o);
  m.customProgramCacheKey = () => key;
  return m;
}

/*
 * Quality. On a weak GPU the suit drops its costliest touches: his self-shadows (a second skinned pass of
 * the whole mesh, and the shadow lookups on every pixel of him) and the brushed metals' anisotropy (the
 * brush streaks stay); the view drops its multisampling too (see suitQuality). Decided once, from how fast
 * the frames come once he is in (suitFrame), or forced with ?suit=low or ?suit=high in the address.
 */
const PROBE_SKIP = 1.5; // seconds after he appears before timing (shader compiles, textures uploading)
const PROBE_FRAMES = 90; // frames timed
const SLOW_FRAME = 1 / 40; // a frame slower than this (s) counts as slow ...
const SLOW_SHARE = 0.6; // ... and this share of slow frames means a weak GPU
const forced = /[?&]suit=(low|high)/.exec(globalThis.location?.search || '')?.[1];
const suit = { quality: forced || 'high', keys: [], materials: [], readyAt: 0, last: 0, timed: 0, slow: 0 };

/** Apply suit.quality to every key light and material made. */
function applyQuality() {
  const high = suit.quality === 'high';
  for (const k of suit.keys) k.castShadow = high;
  for (const m of suit.materials) if (m.userData.anisotropy) m.anisotropy = high ? m.userData.anisotropy : 0;
}

/**
 * Set the suit's quality ('high' or 'low').
 * @param {'high'|'low'} q
 */
export function setSuitQuality(q) {
  suit.quality = q;
  applyQuality();
}

/** @returns {'high'|'low'} the suit's quality */
export const suitQuality = () => suit.quality;

/**
 * Call once a drawn frame (the view does): times the live frames for a while after he appears, and drops
 * to the low quality if most are slow. Frames stepped by hand (captures) run far slower than the clock
 * they carry, and are not counted.
 * @param {number} dt the frame's clock step (s)
 * @returns {boolean} whether the quality has just dropped
 */
export function suitFrame(dt) {
  const now = performance.now();
  const wall = (now - suit.last) / 1000;
  suit.last = now;
  if (forced || !suit.readyAt || suit.timed >= PROBE_FRAMES || now - suit.readyAt < PROBE_SKIP * 1000) return false;
  // (The live loop's step is the frame's time, capped at 0.1 s; a seek's is longer.)
  const live = dt > 0.1001 ? false : dt >= 0.099 ? wall >= 0.075 : Math.abs(wall - dt) < 0.25 * dt + 0.004;
  if (!live) return false;
  suit.timed++;
  if (wall > SLOW_FRAME) suit.slow++;
  if (suit.timed < PROBE_FRAMES || suit.slow <= SLOW_SHARE * PROBE_FRAMES) return false;
  setSuitQuality('low');
  return true;
}

/** The environment's turn about the vertical, shared by every suit material (set by suitLights().place). */
const envRotation = new THREE.Euler();
/** The radiance of the stardust below him (linear), shared by every suit material (set by suitLights().place). */
const groundGlow = { value: new THREE.Color() };

/** The suit's materials, by the names the mesh carries: candy-red clear-coated paint, gold, gunmetal and the lights. */
function materials(renderer) {
  const envMap = renderer ? spaceEnvironment(renderer) : null;
  const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  const loader = new THREE.TextureLoader();
  // The UVs come straight from the FBX (v up), so the images are not flipped the glTF way.
  const tex = (url, srgb = false) => {
    const t = loader.load(url);
    t.flipY = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(16, maxAniso);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const common = { envMap, fog: false };
  const mats = {
    // Candy apple: red metal flake under a hard, glossy clear coat that carries the white highlights.
    Red: detail(
      new THREE.MeshPhysicalMaterial({
        ...common,
        color: new THREE.Color().setRGB(0.52, 0.022, 0.024, THREE.SRGBColorSpace),
        metalness: 0.7,
        roughness: 0.38,
        clearcoat: 1,
        clearcoatRoughness: 0.1, // (a touch soft: a mirror coat traces every facet of the mesh in its highlights)
        envMapIntensity: 0.75,
      }),
      { candy: [0.93, 0.5, 0.52], flakes: { scale: 650, tilt: 0.09 } },
    ),
    // Champagne gold, satin and brushed; the colour map's grime, brightened to a real metal's reflectance.
    Gold: detail(
      new THREE.MeshPhysicalMaterial({
        ...common,
        map: tex(GOLD_COLOR, true),
        color: new THREE.Color(2.3, 2.0, 1.75),
        roughnessMap: tex(GOLD_ORM),
        roughness: 1.9,
        metalness: 1,
        anisotropy: 0.45,
        envMapIntensity: 0.72,
      }),
      { brushed: { scale: 3400, amp: 0.22 } },
    ),
    // The mechanics between the plates: dark brushed titanium.
    Silver: detail(
      new THREE.MeshPhysicalMaterial({
        ...common,
        map: tex(SILVER_COLOR, true),
        color: new THREE.Color(4.2, 4.3, 4.6),
        roughnessMap: tex(SILVER_ORM),
        roughness: 2.2,
        metalness: 1,
        anisotropy: 0.6,
        envMapIntensity: 0.8,
      }),
      { brushed: { scale: 2600, amp: 0.6 } },
    ),
    // The eyes, arc reactor and the palm and vent lights behind glass: every light, the thin eye slits too,
    // has a hot white core falling off to cyan at its edges (baked into the emissive map), bright enough to
    // bloom; a thin glass coat, so the studio's reflections do not milk them over.
    Light: detail(
      new THREE.MeshPhysicalMaterial({
        ...common,
        color: 0x060a0c,
        roughness: 0.15,
        metalness: 0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.05,
        emissive: 0xffffff,
        emissiveMap: tex(LIGHT_EMISSIVE, true),
        emissiveIntensity: LIGHT_GLOW,
      }),
    ),
  };
  for (const m of Object.values(mats)) {
    m.envMapRotation = envRotation;
    m.userData.anisotropy = m.anisotropy;
    suit.materials.push(m);
  }
  applyQuality();
  return mats;
}

/*
 * Where he is (setSuitSurroundings, from the view each frame): the stardust he stands in lights him. Its
 * glow comes up at the suit from below in the cluster's colour (GROUND_GLSL, and the fill light's ground
 * colour), and where a boot, a knee or a fist meets it, it glows round the contact and lights the armour
 * just above (one small light), flaring as he lands.
 */
const SPACE_GLOW = new THREE.Color(0.72, 0.7, 1.0).multiplyScalar(0.12); // below him in open space: faint periwinkle
const GROUND_GLOW = 0.22; // the glow below him inside a cluster, per unit of its colour as drawn
const FILL_GROUND = new THREE.Color(0x2a1a12); // the fill light's own ground colour
const CONTACT_GLOW = 0.16; // a contact's glow at its centre, per unit of the cluster's colour ...
const CONTACT_WHITE = 0.35; // ... paled toward white (stardust is white stars as much as coloured haze)
const UNDER_LIGHT = 30; // the light the stardust throws up round his contacts (candela per unit of colour)
const UNDER_RANGE = 26; // ... and how far it reaches (world units: boots and shins)
const LAND_FLARE = 2; // extra glow as he lands, fading over FLARE_TIME seconds
const FLARE_TIME = 0.45;
const TOUCH_NEAR = 0.08; // a contact this close to the ground (model units) touches it ...
const TOUCH_FAR = 0.22; // ... and one this far does not;
const REST_SPEED = 0.6; // a contact moving slower than this (model units/s) rests on the ground ...
const MOVE_SPEED = 1.6; // ... and one faster only passes by (a foot coming down through it)
/** What touches the ground: bone, how high its origin sits above the ground when it does, glow radius (model units). */
const CONTACTS = [
  ['DEF-toeL', 0.054, 0.26],
  ['DEF-toeR', 0.054, 0.26],
  ['DEF-footL', 0.2, 0.24], // (the heel, under the ankle)
  ['DEF-footR', 0.2, 0.24],
  ['DEF-shinL', 0.09, 0.24], // the knee (kneeling)
  ['DEF-shinR', 0.09, 0.24],
  ['DEF-handL', 0.15, 0.26], // a fist planted
  ['DEF-handR', 0.15, 0.26],
];
const FOOT_LEN = Math.hypot(...JOINTS['DEF-toeL'].map((x, i) => x - JOINTS['DEF-footL'][i])); // for his scale
const surroundings = { color: new THREE.Color(), glow: 0, ground: null, dt: 0 };

/**
 * Tell the suit where he is.
 * @param {THREE.Color} color the stardust round him as drawn (linear)
 * @param {number} glow how much of it is round him (0 open space .. 1 inside a cluster)
 * @param {{y:number, gx:number, gz:number, x:number, z:number}|null} ground the ground he stands on (null in
 *   the air): its height y at (x, z), and its rise per unit along x and z (world)
 * @param {number} dt seconds since the last frame
 */
export function setSuitSurroundings(color, glow, ground, dt) {
  surroundings.color.copy(color);
  surroundings.glow = glow;
  surroundings.ground = ground;
  surroundings.dt = dt;
}

// A contact's glow: lit dust round it, a flattened ellipse facing the camera (as flat as a pool on the
// ground seen from above, never a thin line seen from the side).
const GLOW_VERT = /* glsl */ `
uniform float uSquash;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  c.xy += position.xy * length(modelMatrix[0].xyz) * vec2(1.0, uSquash);
  gl_Position = projectionMatrix * c;
}`;
const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r2 = dot(vUv - 0.5, vUv - 0.5) * 4.0;
  gl_FragColor = vec4(uColor * (exp(-4.0 * r2) - exp(-4.0)) * step(r2, 1.0), 1.0);
}`;

const UP = new THREE.Vector3(0, 1, 0);
const LIGHT_DIST = 90; // world units from him: well outside his reach, inside the shadow camera's range
const SHADOW_HALF = 32; // the shadow camera's half extent (he is 46 tall, his pelvis at the centre)

/**
 * The lights that model the suit, placed round him from the camera each frame (place): a warm key over the
 * camera's left shoulder that casts his own shadows (arms on the chest, plates on plates), cool cyan and blue
 * rims from behind that cut his silhouette out of space, and a soft sky/ground fill. Also turns the reflected
 * studio (the environment) with the camera, so its highlights stay where the lights are.
 * @param {THREE.WebGLRenderer} [renderer] shadows are switched on here
 * @param {THREE.Object3D} target what the lights aim at (his body)
 */
export function suitLights(renderer, target) {
  if (renderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // (PCF honours the radius below: a soft-edged key)
  }
  const group = new THREE.Group();
  const fill = new THREE.HemisphereLight(0x9fb4ff, 0x2a1a12, 0.35);
  const key = new THREE.DirectionalLight(0xfff0de, 2.4);
  const rimC = new THREE.DirectionalLight(0x6fd0ff, 3);
  const rimB = new THREE.DirectionalLight(0xc4ccff, 1.6);
  suit.keys.push(key);
  applyQuality();
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -SHADOW_HALF;
  sc.right = sc.top = SHADOW_HALF;
  sc.near = LIGHT_DIST - 40;
  sc.far = LIGHT_DIST + 40;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.06;
  key.shadow.radius = 3;
  for (const l of [key, rimC, rimB]) l.target = target;
  const under = new THREE.PointLight(0xffffff, 0, UNDER_RANGE, 2);
  const quad = new THREE.PlaneGeometry(2, 2);
  const glows = CONTACTS.map(() => {
    const m = new THREE.Mesh(
      quad,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uSquash: { value: 1 } },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    m.visible = false;
    m.frustumCulled = false; // (the quad is placed in the shader)
    return m;
  });
  group.add(fill, key, rimC, rimB, under, ...glows);
  const f = new THREE.Vector3();
  const r = new THREE.Vector3();
  const tint = new THREE.Color(); // the stardust's colour
  const tmpC = new THREE.Color();
  const pale = new THREE.Color(); // ... paled, for the contact glows
  const pos = CONTACTS.map(() => new THREE.Vector3());
  const touch = new Float32Array(CONTACTS.length);
  const floor = new Float32Array(CONTACTS.length); // the ground under each
  const rest = new Float32Array(CONTACTS.length).fill(1); // how still each is
  const last = CONTACTS.map(() => new THREE.Vector3());
  let tracked = false; // (last holds last frame's positions)
  const gnd = { y: 0, gx: 0, gz: 0, x: 0, z: 0 }; // the ground he last stood on
  let k = 1; // world units per model unit (his size)
  const mid = new THREE.Vector3();
  const eye = new THREE.Vector3();
  let bones = null;
  let level = 0; // how much he is on the ground, eased
  let flare = 0;
  let airTime = 0; // seconds off the ground
  /** The contact bones, once the model is in. */
  const findBones = () => {
    const found = {};
    group.parent?.traverse((o) => {
      if (o.isBone) found[o.name] = o;
    });
    return CONTACTS.every(([b]) => found[b]) ? CONTACTS.map(([b]) => found[b]) : null;
  };
  /**
   * The glow round his contacts with the ground, and the light it throws up at him.
   * @param {THREE.Camera} camera
   */
  const ground = (camera) => {
    const sur = surroundings;
    const dt = sur.dt;
    if (!bones) bones = findBones();
    const parent = group.parent;
    let w = 0;
    const gr = gnd;
    if (bones && parent && sur.ground) {
      Object.assign(gnd, sur.ground);
      bones.forEach((b, i) => {
        last[i].copy(pos[i]);
        b.getWorldPosition(pos[i]);
      });
      k = pos[0].distanceTo(pos[2]) / FOOT_LEN;
      CONTACTS.forEach(([, lift], i) => {
        floor[i] = gr.y + gr.gx * (pos[i].x - gr.x) + gr.gz * (pos[i].z - gr.z);
        // Near the ground and at rest on it (a seek's jump in time counts as at rest).
        const speed = dt > 0 && dt < 0.3 && tracked ? pos[i].distanceTo(last[i]) / dt / k : 0;
        rest[i] += ((1 - THREE.MathUtils.smoothstep(speed, REST_SPEED, MOVE_SPEED)) - rest[i]) * (1 - Math.exp(-dt / 0.05));
        touch[i] = (1 - THREE.MathUtils.smoothstep(Math.abs(pos[i].y - lift * k - floor[i]) / k, TOUCH_NEAR, TOUCH_FAR)) * rest[i];
        w += touch[i];
      });
      tracked = true;
    } else {
      // Off the ground: the glows fade where they were.
      tracked = false;
      for (let i = 0; i < touch.length; i++) touch[i] *= Math.exp(-dt / 0.1);
    }
    // In quickly as he touches down (flaring if he comes down from the air), out quickly as he leaves.
    const on = sur.ground ? Math.min(1, w) : 0;
    if (on > 0.5 && airTime > 0.3) flare = 1;
    airTime = on > 0.5 ? 0 : airTime + dt;
    flare *= Math.exp(-dt / FLARE_TIME);
    level += (on - level) * (1 - Math.exp(-dt / (on > level ? 0.04 : 0.1)));
    if (level < 0.01 || !bones || !parent) {
      for (const g of glows) g.visible = false;
      under.intensity = 0;
      return;
    }
    const gain = 1 + LAND_FLARE * flare;
    pale.copy(tint).lerp(tmpC.setScalar(tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722), CONTACT_WHITE);
    mid.set(0, 0, 0);
    CONTACTS.forEach(([, , radius], i) => {
      const g = glows[i];
      g.visible = touch[i] > 0.01;
      if (!g.visible) return;
      g.position.set(pos[i].x, floor[i], pos[i].z);
      g.material.uniforms.uSquash.value = Math.max(0.35, Math.abs(eye.copy(camera.position).sub(g.position).normalize().y));
      parent.worldToLocal(g.position);
      g.scale.setScalar(radius * k);
      g.material.uniforms.uColor.value.copy(pale).multiplyScalar(CONTACT_GLOW * touch[i] * level * gain);
      mid.addScaledVector(pos[i], touch[i]);
    });
    // One light for them all, in the dust under the middle of his contacts.
    mid.divideScalar(Math.max(w, 1e-6));
    mid.y = gr.y + gr.gx * (mid.x - gr.x) + gr.gz * (mid.z - gr.z) - 0.15 * k;
    under.position.copy(parent.worldToLocal(mid));
    under.color.copy(tint);
    under.intensity = UNDER_LIGHT * level * gain;
  };
  const at = (l, x, y, z) => l.position.set(0, 0, 0).addScaledVector(r, x).addScaledVector(UP, y).addScaledVector(f, z).setLength(LIGHT_DIST);
  return {
    group,
    /**
     * @param {THREE.Camera} camera
     * @param {THREE.Vector3} center his position (the lights' group sits on him)
     */
    place(camera, center) {
      f.copy(camera.position).sub(center).setY(0);
      if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
      f.normalize();
      r.crossVectors(UP, f); // the camera's right
      at(key, -0.55, 0.75, 0.75);
      at(rimC, -0.8, 0.35, -0.7);
      at(rimB, 0.85, 0.2, -0.65);
      envRotation.y = Math.atan2(f.x, f.z);
      // The stardust round him: its glow from below, in the reflections and the fill.
      const sur = surroundings;
      tint.copy(sur.color);
      groundGlow.value.copy(SPACE_GLOW).lerp(tmpC.copy(tint).multiplyScalar(GROUND_GLOW), sur.glow);
      fill.groundColor.copy(FILL_GROUND).lerp(tmpC.copy(tint).multiplyScalar(0.5), sur.glow);
      ground(camera);
    },
  };
}

/**
 * Parse the model and hand it over when ready. Nothing here blocks the first frames: the meshopt decoder
 * runs asynchronously, and the suit's shaders are compiled in the background (where the browser can) before
 * the model joins the scene.
 * @param {THREE.WebGLRenderer} [renderer] for the reflections and the shader warm-up
 * @param {(m:{scene:THREE.Object3D, bones:Object<string, THREE.Bone>, materials:Object}) => void} onReady
 * @param {THREE.Object3D} [anchor] where the model will be added (its scene supplies the lights to compile for)
 */
export function loadModel(renderer, onReady, anchor) {
  const mats = materials(renderer);
  const buf = GLB.buffer.slice(GLB.byteOffset, GLB.byteOffset + GLB.byteLength);
  new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(
    buf,
    '',
    (gltf) => {
      const bones = {};
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          o.material = mats[o.material.name] || o.material;
          if (o.isSkinnedMesh && o.material.userData.headBone) o.material.userData.headBone.value = o.skeleton.bones.findIndex((b) => b.name === HEAD_BONE);
          o.frustumCulled = false; // skinned: its bounds move with the pose
          o.castShadow = o.receiveShadow = true;
          const occ = o.geometry.getAttribute('_occlusion');
          if (occ) o.geometry.setAttribute('occlusion', occ).deleteAttribute('_occlusion');
        }
        if (o.isBone) bones[o.name] = o;
      });
      const done = () => {
        suit.readyAt = performance.now();
        onReady({ scene: gltf.scene, bones, materials: mats });
      };
      warmUp(renderer, gltf.scene, anchor).then(done, done);
    },
    (e) => console.error('Iron Man model failed to load', e),
  );
}

/**
 * Start compiling the model's shaders for the scene it will join before it is drawn: the physical materials
 * are big, and compiling them at first draw stalls a frame for a noticeable moment. Where the browser can
 * report progress (KHR_parallel_shader_compile) the model waits until they are done; elsewhere the driver
 * still gets a head start.
 */
function warmUp(renderer, object, anchor) {
  let root = anchor;
  while (root?.parent) root = root.parent;
  if (!renderer?.compile || !root?.isScene) return Promise.resolve();
  // Compile as the composer's passes draw: into a linear render target (no tone mapping or sRGB encoding).
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const prev = renderer.getRenderTarget();
  const camera = new THREE.PerspectiveCamera();
  renderer.setRenderTarget(rt);
  let p;
  try {
    p = renderer.extensions.has('KHR_parallel_shader_compile')
      ? renderer.compileAsync(object, camera, root)
      : (renderer.compile(object, camera, root), new Promise((resolve) => setTimeout(resolve, 10)));
  } finally {
    renderer.setRenderTarget(prev);
  }
  return p.finally(() => rt.dispose());
}
