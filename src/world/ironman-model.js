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
 * gunmetal, lights with hot white cores, a studio-in-space environment that
 * turns with the camera, and a key light that casts his own shadows.
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
// The brightest the suit's shading may get: above 1 it rolls off toward this. A point light's glint on the
// near-mirror clear coat is otherwise thousands of times white, and blooms into a square halo.
const HIGHLIGHT_CAP = 3;

/*
 * The environment the armour reflects, drawn on the GPU into an equirect: deep space with faint nebulae and
 * stars, lit like a studio (a big warm softbox over the camera's left shoulder, a hard strip on its right for
 * the long highlights down the plates, a soft top light), cyan and blue-white rim strips behind him, and the warm
 * glow of the stardust under his feet. Its frame: +z toward the camera, +x the camera's right; the materials
 * turn it with the camera (see suitLights().place).
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
  // The stardust underfoot: a warm glow from below.
  col += vec3(1.0, 0.62, 0.40) * 0.16 * smoothstep(0.0, -0.75, d.y) * (0.6 + 0.8 * n2);
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
  col += vec3(1.00, 0.93, 0.84) * 2.6 * softbox(d, vec3(-0.55, 0.55, 0.65), Y, vec2(0.42, 0.7), 0.22); // key
  col += vec3(0.86, 0.92, 1.00) * 2.2 * softbox(d, vec3(0.85, 0.22, 0.48), Y, vec2(0.05, 1.1), 0.04); // strip
  col += vec3(0.80, 0.86, 1.00) * 0.7 * softbox(d, vec3(0.0, 1.0, 0.12), vec3(0.0, 0.0, 1.0), vec2(0.9, 0.35), 0.4); // top
  col += vec3(0.45, 0.82, 1.00) * 2.6 * softbox(d, vec3(-0.85, 0.25, -0.55), Y, vec2(0.10, 0.9), 0.08); // cyan rim
  col += vec3(0.66, 0.72, 1.00) * 2.0 * softbox(d, vec3(0.85, 0.15, -0.55), Y, vec2(0.08, 0.8), 0.08); // blue-white rim
  gl_FragColor = vec4(col, 1.0);
}`;

/** The environment as a PMREM texture (see ENV_FRAG). */
function spaceEnvironment(renderer) {
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
float sdHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 sdHash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float sdNoise1(float x) { float i = floor(x), f = fract(x); return mix(sdHash12(vec2(i, 0.37)), sdHash12(vec2(i + 1.0, 0.37)), f * f * (3.0 - 2.0 * f)); }
`;
const AO_GLSL = /* glsl */ `
float ambientOcclusion = mix(1.0, vOcclusion.x, ${AO_STRENGTH.toFixed(3)});
float cavity = mix(1.0, vOcclusion.y * mix(1.0, vOcclusion.x, 0.5), ${CAVITY_STRENGTH.toFixed(3)});
reflectedLight.indirectDiffuse *= ambientOcclusion;
reflectedLight.directDiffuse *= cavity;
reflectedLight.directSpecular *= cavity;
#if defined( USE_CLEARCOAT )
  clearcoatSpecularIndirect *= ambientOcclusion;
  clearcoatSpecularDirect *= cavity;
#endif
#if defined( USE_ENVMAP )
  float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness );
#endif
`;
const CAP_GLSL = /* glsl */ `
{
  vec3 over = max(outgoingLight - 1.0, 0.0);
  outgoingLight = min(outgoingLight, 1.0) + over / (1.0 + over / ${(HIGHLIGHT_CAP - 1).toFixed(2)});
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
  vec2 fp = vUv * FLAKE_SCALE;
  vec3 fh = sdHash32(floor(fp));
  float fw = length(fwidth(fp));
  float vis = 1.0 - smoothstep(0.25, 0.9, fw);
  vec3 tilt = (fh - 0.5) * (2.0 * FLAKE_TILT * vis);
  normal = normalize(normal + tilt - dot(tilt, normal) * normal);
}
`;
const BRUSHED_GLSL = /* glsl */ `
{
  float s = vUv.y * BRUSH_SCALE;
  float fade = 1.0 - smoothstep(0.3, 1.0, fwidth(s));
  float streak = 0.6 * sdNoise1(s) + 0.4 * sdNoise1(s * 3.7 + 11.0);
  roughnessFactor = clamp(roughnessFactor * (1.0 + BRUSH_AMP * fade * (streak - 0.5)), 0.0, 1.0);
}
`;

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
  if (o.flakes || o.brushed) m.defines = { ...m.defines, USE_UV: '' };
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 occlusion;\nvarying vec2 vOcclusion;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOcclusion = occlusion;');
    let fs = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${defs.join('\n')}\n${NOISE_GLSL}`)
      .replace('#include <aomap_fragment>', AO_GLSL)
      .replace('#include <opaque_fragment>', CAP_GLSL);
    if (o.brushed) fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${BRUSHED_GLSL}`);
    if (o.flakes) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FLAKES_GLSL}`);
    if (o.candy) fs = fs.replace('#include <lights_physical_fragment>', `${CANDY_GLSL}\n#include <lights_physical_fragment>`);
    sh.fragmentShader = fs;
  };
  const key = JSON.stringify(o);
  m.customProgramCacheKey = () => key;
  return m;
}

/** The environment's turn about the vertical, shared by every suit material (set by suitLights().place). */
const envRotation = new THREE.Euler();

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
        clearcoatRoughness: 0.03,
        envMapIntensity: 0.75,
      }),
      { candy: [0.93, 0.5, 0.52], flakes: { scale: 3600, tilt: 0.08 } },
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
        envMapIntensity: 0.85,
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
    // The eyes, arc reactor and the palm and vent lights behind glass: hot white cores falling off to cyan
    // (baked into the emissive map), blooming.
    Light: detail(
      new THREE.MeshPhysicalMaterial({
        ...common,
        color: 0x060a0c,
        roughness: 0.15,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.05,
        emissive: 0xffffff,
        emissiveMap: tex(LIGHT_EMISSIVE, true),
        emissiveIntensity: 1.7,
      }),
    ),
  };
  for (const m of Object.values(mats)) m.envMapRotation = envRotation;
  return mats;
}

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
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  const group = new THREE.Group();
  const fill = new THREE.HemisphereLight(0x9fb4ff, 0x2a1a12, 0.35);
  const key = new THREE.DirectionalLight(0xfff0de, 2.4);
  const rimC = new THREE.DirectionalLight(0x6fd0ff, 3);
  const rimB = new THREE.DirectionalLight(0xa8bcff, 2.2);
  key.castShadow = true;
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -SHADOW_HALF;
  sc.right = sc.top = SHADOW_HALF;
  sc.near = LIGHT_DIST - 40;
  sc.far = LIGHT_DIST + 40;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.06;
  key.shadow.radius = 2.5;
  for (const l of [key, rimC, rimB]) l.target = target;
  group.add(fill, key, rimC, rimB);
  const f = new THREE.Vector3();
  const r = new THREE.Vector3();
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
          o.frustumCulled = false; // skinned: its bounds move with the pose
          o.castShadow = o.receiveShadow = true;
          const occ = o.geometry.getAttribute('_occlusion');
          if (occ) o.geometry.setAttribute('occlusion', occ).deleteAttribute('_occlusion');
        }
        if (o.isBone) bones[o.name] = o;
      });
      const done = () => onReady({ scene: gltf.scene, bones, materials: mats });
      warmUp(renderer, gltf.scene, anchor).then(done, done);
    },
    (e) => console.error('Iron Man model failed to load', e),
  );
}

/**
 * Compile the model's shaders for the scene it will join, off the main thread where the browser supports
 * it (KHR_parallel_shader_compile): the physical materials are big, and compiling them at first draw stalls
 * a frame for a noticeable moment.
 */
function warmUp(renderer, object, anchor) {
  let root = anchor;
  while (root?.parent) root = root.parent;
  if (!renderer?.compileAsync || !root?.isScene) return Promise.resolve();
  // Compile as the composer's passes draw: into a linear render target (no tone mapping or sRGB encoding).
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  let p;
  try {
    p = renderer.compileAsync(object, new THREE.PerspectiveCamera(), root);
  } finally {
    renderer.setRenderTarget(prev);
  }
  return p.finally(() => rt.dispose());
}
