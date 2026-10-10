/**
 * The Iron Man suit's surface: a clear-coated physical material per texture,
 * reflecting a small space environment of its own, with metalness/roughness,
 * relief and glow maps derived from the colour texture once it has loaded
 * (red paint, bare gold and silver trim, glowing cyan lights). refine() is the
 * hook for geometric detail on the body mesh before it is skinned.
 */

import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Surface maps from the colour texture, once it has loaded: metalness and
 * roughness (green: roughness, blue: metalness, as three reads them), relief
 * (luminance: the silver and gold trim stands proud of the red panels) and
 * glow (the cyan lights: arc reactor, eyes, palms, vents).
 */
function deriveMaps(img) {
  const w = img.width;
  const h = img.height;
  const cv = (fn) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, h);
    const a = d.data;
    for (let i = 0; i < a.length; i += 4) fn(a, i, a[i] / 255, a[i + 1] / 255, a[i + 2] / 255);
    g.putImageData(d, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  };
  const glowOf = (r, g, b) => smooth(0.45, 0.7, b) * smooth(0.4, 0.65, g) * smooth(0.95, 0.6, r - b + 0.3);
  const mr = cv((a, i, r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const gold = smooth(0.35, 0.55, r) * smooth(0.22, 0.4, g) * smooth(0.3, 0.12, b) * smooth(0.45, 0.65, g / Math.max(r, 1e-3));
    const silver = smooth(0.14, 0.06, mx - mn) * smooth(0.2, 0.45, mx);
    const dark = smooth(0.12, 0.03, mx);
    // The red is paint (a dielectric base under the clear coat); gold and silver trim is bare metal.
    const metal = 0.22 + 0.78 * Math.max(gold, silver) - 0.15 * dark;
    const rough = 0.38 - 0.16 * gold - 0.2 * silver + 0.4 * dark;
    a[i] = 0;
    a[i + 1] = clamp(rough, 0.05, 1) * 255;
    a[i + 2] = clamp(metal, 0, 1) * 255;
    a[i + 3] = 255;
  });
  const bump = cv((a, i, r, g, b) => {
    const l = (0.3 * r + 0.59 * g + 0.11 * b) * 255;
    a[i] = a[i + 1] = a[i + 2] = l;
    a[i + 3] = 255;
  });
  const glow = cv((a, i, r, g, b) => {
    const k = glowOf(r, g, b);
    a[i] = r * k * 255;
    a[i + 1] = g * k * 255;
    a[i + 2] = b * k * 255;
    a[i + 3] = 255;
  });
  glow.colorSpace = THREE.SRGBColorSpace;
  return { mr, bump, glow };
}

/** A small space environment for the suit to reflect: dark, with cool and warm nebula light and stars. */
function spaceEnvironment(renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x04050a);
  const panel = (color, intensity, pos, size) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0x7d9bff, 2.2, [0, 9, 2], 9); // a cool sky above
  panel(0xffb46a, 1.6, [-8, -3, 4], 7); // a warm cluster low on one side
  panel(0xff4f9a, 1.1, [8, 1, -5], 6); // magenta on the other
  panel(0x9fe8ff, 3.0, [3, 4, 9], 2.2); // a hard key reflection
  const sg = new THREE.SphereGeometry(0.06, 6, 4);
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 160; i++) {
    const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(1 + 4 * rnd()) }));
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

/**
 * @param {THREE.WebGLRenderer} [renderer] for the reflections (none without it)
 */
export function createSuit(renderer) {
  const envMap = renderer ? spaceEnvironment(renderer) : null;
  const loadTex = (url, onImage) => {
    const t = new THREE.TextureLoader().load(url, (tt) => onImage && onImage(tt.image));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return {
    /** Clear-coated suit material for a colour texture; its derived maps follow once the texture has loaded. */
    material(url, sideMode = THREE.FrontSide) {
      const m = new THREE.MeshPhysicalMaterial({ metalness: 0.4, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.12, envMap, envMapIntensity: 1.7, emissive: 0xffffff, emissiveIntensity: 0, side: sideMode, fog: false });
      m.map = loadTex(url, (img) => {
        const d = deriveMaps(img);
        Object.assign(m, { metalnessMap: d.mr, roughnessMap: d.mr, metalness: 1, roughness: 1, bumpMap: d.bump, bumpScale: 1.6, emissiveMap: d.glow, emissiveIntensity: 2.6 });
        m.needsUpdate = true;
      });
      return m;
    },
    /** Geometric detail for the body mesh (mesh units), applied before it is rigged; returns the geometry to use. */
    refine(geo) {
      return geo;
    },
  };
}
