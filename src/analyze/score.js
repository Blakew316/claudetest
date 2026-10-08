/**
 * The spec score: a single 0..100 number for "how ready is this prompt",
 * computed from what the crawler has read so far. Pure; the director calls it
 * every step with run.counts.
 *
 *   coverage    = read / total words
 *   specificity = min(1, (linked / basis) / LINK_TARGET)    linked words per word, saturating at ~18%
 *   vagueness   = min(1, (flagged / basis) / VAGUE_LIMIT)   vague words per word, maxing out at 12%
 *   quality     = clamp(BASE + (1 - BASE) * specificity - VAGUE_WEIGHT * vagueness, 0, 1)
 *   score       = round(100 * coverage * quality)
 *
 * basis = max(read, MIN_BASIS), so a ten-word prompt can't hit 100 on one
 * lucky link. Coverage multiplies everything, so the score climbs as the
 * crawl proceeds; reading a vague word costs a point or two on the spot.
 *
 * The built-in sample finishes at 83 (205 words, 50 linked, 7 flagged).
 */

/** Linked words per read word at which specificity is maxed out. */
export const LINK_TARGET = 0.18;
/** Vague words per read word at which the vagueness penalty is maxed out. */
export const VAGUE_LIMIT = 0.12;
/** Quality of a prompt with no links and no flags (half marks: nothing wrong, nothing pinned down). */
export const BASE = 0.5;
/** How much of the quality the worst vagueness takes away. */
export const VAGUE_WEIGHT = 0.6;
/** Rates are measured over at least this many words. */
export const MIN_BASIS = 30;

/** One or two plain sentences for the HUD's info tooltip. */
export const SCORE_EXPLAINER =
  'The score climbs as the crawler reads more of the prompt and finds specific words (owners, approvals, claims, specs and files), up to about one in every six words. Each vague word it flags pulls the score back down.';

/**
 * Score what has been read so far.
 * @param {import('../core/contracts.js').Analysis} analysis
 * @param {{read:number, linked:number, flagged:number}} counts  RunState.counts (linked includes guessed links)
 * @returns {number} integer 0..100
 */
export function computeScore(analysis, counts) {
  const total = Math.max(0, num(analysis && analysis.totals && analysis.totals.words, analysis && analysis.words ? analysis.words.length : 0));
  if (!total || !counts) return 0;
  const read = clamp(num(counts.read, 0), 0, total);
  if (read <= 0) return 0;
  const linked = clamp(num(counts.linked, 0), 0, read);
  const flagged = clamp(num(counts.flagged, 0), 0, read);

  const coverage = read / total;
  const basis = Math.max(read, MIN_BASIS);
  const specificity = Math.min(1, linked / basis / LINK_TARGET);
  const vagueness = Math.min(1, flagged / basis / VAGUE_LIMIT);
  const quality = clamp(BASE + (1 - BASE) * specificity - VAGUE_WEIGHT * vagueness, 0, 1);
  return clamp(Math.round(100 * coverage * quality), 0, 100);
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
