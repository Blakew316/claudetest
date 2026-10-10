/**
 * The Thanos model: "Thanos 4K Retextured" by JonnyMANSON on Sketchfab
 * (https://sketchfab.com/3d-models/thanos-4k-retextured-33a76fa5ad654715acc2eef792f6832a), CC-BY-4.0
 * (Thanos is Marvel's). Converted for the web from the uploaded glTF: the exporter's ior and specular
 * extensions dropped, the textures resized (2048 for the body's and head's colour, 1024 for the rest)
 * and WebP-encoded, the mesh welded, quantized and meshopt-compressed. A rigged, skinned figure on an
 * Advanced Skeleton rig (Root_M, Hip_R, Knee_R, Ankle_R, Spine1_M, Chest_M, Shoulder_R, Elbow_R,
 * Wrist_R, ...), in an A-pose: feet at y = 0, facing +z, his left at +x, about 63 units tall.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import GLB from '../../assets/thanos/thanos.glb';

// (The credit the CC-BY-4.0 licence asks for is on the page: index.html, .credit.)

/**
 * Parse the model and hand it over when ready, its bones by name.
 * @param {(m:{scene:THREE.Object3D, bones:Object<string, THREE.Bone>}) => void} onReady
 */
export function loadThanos(onReady) {
  const buf = GLB.buffer.slice(GLB.byteOffset, GLB.byteOffset + GLB.byteLength);
  new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(
    buf,
    '',
    (gltf) => {
      const bones = {};
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false; // skinned: its bounds move with the pose
          const m = o.material;
          if (m && /Gauntlet/.test(m.name)) {
            // The Infinity Gauntlet: gold metal, its stones lit.
            m.metalness = 0.85;
            m.roughness = 0.35;
            m.emissiveIntensity = 2.2;
          }
          if (m && /EyeBall/.test(m.name)) m.depthWrite = false;
        }
        if (o.isBone) bones[o.name.replace(/_\d+$/, '')] = o; // (Hip_R_02 -> Hip_R)
      });
      onReady({ scene: gltf.scene, bones });
    },
    (e) => console.error('Thanos model failed to load', e),
  );
}
