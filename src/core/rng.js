/**
 * Seeded randomness. Everything visual in the crawl derives from these so a
 * given prompt always produces the same world, the same walk and the same
 * screenshots (which is what makes the screenshot harness meaningful).
 */

/** 32-bit FNV-1a hash of a string, used to turn prompt text into a seed. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [min, max). */
export function range(rand, min, max) {
  return min + (max - min) * rand();
}

/** Standard normal sample (Box-Muller). */
export function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic child generator, so subsystems don't consume each other's sequence. */
export function fork(seed, salt) {
  return mulberry32(hashString(`${seed}:${salt}`));
}
