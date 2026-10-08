/**
 * Colour and type tokens shared by the canvas renderers and the HUD.
 * Values were sampled from the reference footage; CSS mirrors them as custom
 * properties in src/styles.css (keep the two in sync).
 */

export const BG = '#07080b';
export const PANEL_BG = '#0b0c10';
export const PANEL_BORDER = '#1c1f28';
export const TEXT = '#e6e8ee';
export const TEXT_DIM = '#8a8f9c';
export const TEXT_FAINT = '#3d424e';
export const QUEUED = '#8d92a0';

/** Hot pink: flags, the spider's core, the file name, crawler.py keywords. */
export const FLAG = '#ff3d7f';
/** Spider body, legs and the "live"/rate meta in panel headers. */
export const SPIDER = '#46e3b7';
/** Dotted tentacles. */
export const TENTACLE = '#f1edc4';
/** Link counts and the spec score sparkline. */
export const AMBER = '#f4b93a';

/** Section palette in reading order; prompts with more sections cycle through the tail. */
export const SECTION_PALETTE = [
  '#e8eaf0', // 01 white   (role)
  '#38c8ea', // 02 cyan    (objective)
  '#f0508a', // 03 pink    (context)
  '#f4b93a', // 04 amber   (roles)
  '#52eab9', // 05 mint    (rules)
  '#9c7cf5', // 06 violet  (review)
  '#e5784f', // 07 orange  (start)
  '#7cc4ff', // 08 sky
  '#c6ef5c', // 09 lime
  '#ff8fd0', // 10 rose
  '#5fd3d3', // 11 aqua
  '#ffd27a', // 12 sand
];

export function sectionColor(index) {
  if (index < SECTION_PALETTE.length) return SECTION_PALETTE[index];
  return SECTION_PALETTE[7 + ((index - 7) % (SECTION_PALETTE.length - 7))];
}

/** '#rrggbb' + alpha -> 'rgba(r,g,b,a)'. */
export function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Linear blend of two hex colours, t in [0,1]. Returns '#rrggbb'. */
export function mix(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ch = (shift) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** Monospace stack used everywhere, canvas included. */
export const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
