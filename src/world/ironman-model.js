/**
 * The Iron Man model: a rigged, skinned suit from CGTrader (supplied with the
 * project; Iron Man is Marvel's), converted from the artist's FBX for the web:
 * the 74 deform bones of its Rigify rig in a clean hierarchy, the mesh welded,
 * decimated to about 60% (some 175k triangles) and meshopt-compressed, the PBR
 * textures resized (the flat maps folded into material constants), and the
 * artist's five poses baked onto the deform bones (poses.json: per bone, the
 * local quaternion and position). joints.json holds every bone's rest position
 * in model units (feet at y = 0, facing +z, his left at +x).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import GLB from '../../assets/ironman-mk/ironman.glb';
import POSES from '../../assets/ironman-mk/poses.json';
import JOINTS from '../../assets/ironman-mk/joints.json';
import RED_NORMAL from '../../assets/ironman-mk/red_normal.webp';
import GOLD_COLOR from '../../assets/ironman-mk/gold_color.webp';
import GOLD_NORMAL from '../../assets/ironman-mk/gold_normal.webp';
import GOLD_ORM from '../../assets/ironman-mk/gold_orm.webp';
import SILVER_COLOR from '../../assets/ironman-mk/silver_color.webp';
import SILVER_NORMAL from '../../assets/ironman-mk/silver_normal.webp';
import SILVER_ORM from '../../assets/ironman-mk/silver_orm.webp';
import LIGHT_EMISSIVE from '../../assets/ironman-mk/light_emissive.webp';

/** Rest positions of the deform bones (model units). */
export const JOINT = JOINTS;
/** The artist's poses: 'T Pose', 'pose 2', 'Fly Pose', 'Fire Pose', 'Landing Pose'. */
export const POSE = POSES;
/** Height of the model, feet to crown (model units). */
export const MODEL_HEIGHT = 3.585;

/** A small space environment for the armour to reflect: dark, with cool and warm nebula light and stars. */
function spaceEnvironment(renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x05060b);
  const panel = (color, intensity, pos, size) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0x9fb4ff, 2.4, [0, 9, 2], 10); // a cool sky above
  panel(0xffc48a, 1.7, [-8, -2, 5], 8); // a warm cluster low on one side
  panel(0xff5f9e, 1.0, [8, 1, -5], 6); // magenta on the other
  panel(0xffffff, 4.0, [4, 5, 9], 2.6); // a hard key, for the long highlights on the plates
  panel(0x7fd8ff, 2.0, [-6, 4, -8], 3); // a cyan rim from behind
  const sg = new THREE.SphereGeometry(0.06, 6, 4);
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 180; i++) {
    const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(1 + 5 * rnd()) }));
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    m.position.set(r * Math.cos(th) * 12, u * 12, r * Math.sin(th) * 12);
    env.add(m);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.02).texture;
  pm.dispose();
  return tex;
}

/** The suit's materials, by the names the mesh carries: candy-red clear-coated paint, gold and silver metal, and the lights. */
function materials(renderer) {
  const envMap = renderer ? spaceEnvironment(renderer) : null;
  const loader = new THREE.TextureLoader();
  // The UVs come straight from the FBX (v up), so the images are not flipped the glTF way.
  const tex = (url, srgb = false) => {
    const t = loader.load(url);
    t.flipY = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const common = { envMap, fog: false };
  return {
    Red: new THREE.MeshPhysicalMaterial({
      ...common,
      color: new THREE.Color().setRGB(0.28, 0.012, 0.012, THREE.SRGBColorSpace),
      metalness: 0.5,
      roughness: 0.16,
      normalMap: tex(RED_NORMAL),
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.5,
    }),
    Gold: new THREE.MeshPhysicalMaterial({ ...common, map: tex(GOLD_COLOR, true), metalnessMap: tex(GOLD_ORM), roughnessMap: tex(GOLD_ORM), normalMap: tex(GOLD_NORMAL), metalness: 1, roughness: 1, clearcoat: 0.4, clearcoatRoughness: 0.1, envMapIntensity: 1.5 }),
    Silver: new THREE.MeshStandardMaterial({ ...common, map: tex(SILVER_COLOR, true), metalnessMap: tex(SILVER_ORM), roughnessMap: tex(SILVER_ORM), normalMap: tex(SILVER_NORMAL), metalness: 1, roughness: 1, envMapIntensity: 1.3 }),
    // The eyes, arc reactor and the palm and vent lights: hot white centres that bloom cyan.
    Light: new THREE.MeshStandardMaterial({ ...common, color: 0x0a1418, emissive: 0xbfeeff, emissiveMap: tex(LIGHT_EMISSIVE, true), emissiveIntensity: 5, roughness: 0.3, metalness: 0 }),
  };
}

/**
 * Parse the model and hand it over when ready (the decoder runs asynchronously).
 * @param {THREE.WebGLRenderer} [renderer] for the reflections
 * @param {(m:{scene:THREE.Object3D, bones:Object<string, THREE.Bone>, materials:Object}) => void} onReady
 */
export function loadModel(renderer, onReady) {
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
        }
        if (o.isBone) bones[o.name] = o;
      });
      onReady({ scene: gltf.scene, bones, materials: mats });
    },
    (e) => console.error('Iron Man model failed to load', e),
  );
}
