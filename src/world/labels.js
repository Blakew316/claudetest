/**
 * Screen-space labels on top of the particle world: one title per section
 * ("rules" / "24/25 words · reading") and a small boxed monospace label for
 * every word the spider has read ("owners · owner", "full · ⚑ vague").
 *
 * Everything here is drawn in CSS pixels at a constant size; positions come
 * from projecting 3D points through the camera (view.project). Labels fade
 * in over 0.25 s from the word's readAt and then stay.
 */

import { BG, FLAG, MONO, QUEUED, TEXT_DIM, withAlpha } from '../core/theme.js';

/** Filler words that never get a label. */
const STOPWORDS = new Set(['the', 'and', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'at', 'by', 'or', 'as', 'be', 'with', 'that', 'this', 'then', 'one']);
/**
 * How long (s) a label stays up after its word is read, before fading. Plain
 * words flash and go, linked words linger, flags stay for the whole section.
 * The ship overview shows only the flags.
 */
const HOLD_PLAIN = 1.4;
const HOLD_LINK = 3.2;
const FADE_OUT = 0.7;

const LABEL_FONT = `11px ${MONO}`;
const TITLE_FONT = `500 20px ${MONO}`;
const SUB_FONT = `11px ${MONO}`;
const FADE_IN = 0.25;
const PAD_X = 3;
const BOX_H = 15;
/**
 * Label opacity for the active section, other sections during the crawl, and
 * the ship overview. The spec suggests 35% for other sections; the reference
 * footage shows finished sections' labels gone during the crawl (they come
 * back in the ship overview), so they settle to OTHER_ALPHA after SETTLE s.
 */
const ACTIVE_ALPHA = 1;
const OTHER_ALPHA = 0;
const SHIP_ALPHA = 0.8;
/** How long (s) a just-finished section's labels take to settle to OTHER_ALPHA. */
const SETTLE = 0.8;

const LABEL_FILL = withAlpha(BG, 0.8);

/** Text-width cache for the 11px label font; cleared when web fonts finish loading. */
const widthCache = new Map();
let fontState = '';

function fontsStatus() {
  try {
    return typeof document !== 'undefined' && document.fonts ? document.fonts.status : 'none';
  } catch {
    return 'none';
  }
}

function measure(ctx, text) {
  let w = widthCache.get(text);
  if (w === undefined) {
    w = Math.ceil(ctx.measureText(text).width);
    widthCache.set(text, w);
  }
  return w;
}

/** The label text for a word: plain, 'word · kind' or 'word · ⚑ vague'. */
export function labelText(word) {
  if (word.vague) return `${word.text} · ⚑ vague`;
  if (word.kind) return `${word.text} · ${word.kind}`;
  return word.text;
}

/**
 * Draw section titles and read-word labels in screen space.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').World} world
 * @param {import('../core/contracts.js').RunState} run
 * @param {import('../core/contracts.js').View} view
 * @param {import('../core/contracts.js').Analysis} analysis
 */
export function drawLabels(ctx, world, run, view, analysis) {
  const st = fontsStatus();
  if (st !== fontState) {
    widthCache.clear();
    fontState = st;
  }
  const { width, height } = view;
  const ship = run.phase === 'ship';
  const t = run.t;
  const p = { x: 0, y: 0 };

  ctx.save();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // Section titles.
  for (const sec of analysis.sections) {
    const c = world.clusters[sec.index];
    if (!c) continue;
    view.project(c.cx, c.cy + c.r * 0.72, c.cz, p);
    if (!p.vis) continue;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x > width || y < -30 || y > height + 30 || x < -260) continue;
    const status = run.status[sec.index];
    const read = run.readCount[sec.index] || 0;
    const statusWord = ship ? 'read' : status;
    ctx.globalAlpha = 1;
    ctx.font = TITLE_FONT;
    ctx.fillStyle = status === 'queued' && !ship ? QUEUED : sec.color;
    ctx.fillText(sec.name, x, y);
    ctx.font = SUB_FONT;
    ctx.fillStyle = TEXT_DIM;
    ctx.globalAlpha = status === 'queued' && !ship ? 0.75 : 0.9;
    ctx.fillText(`${read}/${sec.count} words · ${statusWord}`, x, y + 18);
  }

  // Word labels: other sections first, the active one last (on top).
  ctx.font = LABEL_FONT;
  ctx.lineWidth = 1;
  const order = [];
  for (const sec of analysis.sections) if (sec.index !== run.active) order.push(sec);
  if (run.active < analysis.sections.length) order.push(analysis.sections[run.active]);

  const words = analysis.words;
  const pos = world.wordPos;
  for (const sec of order) {
    const isActive = !ship && sec.index === run.active;
    const status = run.status[sec.index];
    let secAlpha;
    if (ship) secAlpha = SHIP_ALPHA;
    else if (isActive) secAlpha = ACTIVE_ALPHA;
    else {
      // A just-finished section eases down to OTHER_ALPHA instead of popping.
      let last = -1;
      for (let id = sec.start, end = sec.start + sec.count; id < end; id++) {
        if (run.readAt[id] > last) last = run.readAt[id];
      }
      const since = last < 0 ? SETTLE : t - last;
      const k = Math.min(1, Math.max(0, since / SETTLE));
      secAlpha = ACTIVE_ALPHA + (OTHER_ALPHA - ACTIVE_ALPHA) * k;
    }
    if (secAlpha <= 0.01) continue;
    const dropStop = !ship && status === 'done';
    const color = sec.color;
    const border = withAlpha(color, 0.7);

    for (let id = sec.start, end = sec.start + sec.count; id < end; id++) {
      if (run.wordState[id] !== 2) continue;
      const word = words[id];
      if (!word.vague && (ship || dropStop)) continue;
      if (!word.kind && !word.vague && STOPWORDS.has(word.text.toLowerCase())) continue;
      const age = t - run.readAt[id];
      if (age < 0) continue;
      const fade = age >= FADE_IN ? 1 : age / FADE_IN;
      // Ordinary and linked labels fade out after a moment; flags stay.
      const hold = word.vague ? Infinity : word.kind ? HOLD_LINK : HOLD_PLAIN;
      const out = age <= hold ? 1 : Math.max(0, 1 - (age - hold) / FADE_OUT);
      const a = secAlpha * fade * fade * (3 - 2 * fade) * out;
      if (a <= 0.01) continue;
      view.project(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2], p);
      if (!p.vis) continue;
      // Farther labels recede, like the web behind them.
      const depthA = Math.max(0.3, Math.min(1, 1.5 - p.d / (view.camDist * 1.6)));
      const text = labelText(word);
      const w = measure(ctx, text) + PAD_X * 2;
      const bx = Math.round(p.x) + 4;
      const by = Math.round(p.y) - 4 - BOX_H;
      if (bx > width || by > height || bx + w < 0 || by + BOX_H < 0) continue;
      ctx.globalAlpha = a * depthA;
      if (word.vague) {
        ctx.fillStyle = FLAG;
        ctx.fillRect(bx, by, w, BOX_H);
        ctx.fillStyle = BG;
        ctx.fillText(text, bx + PAD_X, by + BOX_H / 2 + 0.5);
      } else {
        ctx.fillStyle = LABEL_FILL;
        ctx.fillRect(bx, by, w, BOX_H);
        ctx.strokeStyle = border;
        ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, BOX_H - 1);
        ctx.fillStyle = color;
        ctx.fillText(text, bx + PAD_X, by + BOX_H / 2 + 0.5);
      }
    }
  }
  ctx.restore();
}

const ringPos = {};

/**
 * Screen-space extras around the spider: rings on the words being held and
 * the "crawler · rules" tag.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').World} world
 * @param {import('../core/contracts.js').RunState} run
 * @param {{dpr:number, project:Function}} view
 * @param {import('../core/contracts.js').Analysis} analysis
 */
export function drawSpiderOverlay(ctx, world, run, view, analysis) {
  ctx.save();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.strokeStyle = withAlpha('#f1edc4', 0.75);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const pos = world.wordPos;
  for (const tn of run.tentacles) {
    if (tn.stage !== 'hold') continue;
    view.project(pos[tn.wordId * 3], pos[tn.wordId * 3 + 1], pos[tn.wordId * 3 + 2], ringPos);
    if (!ringPos.vis) continue;
    ctx.moveTo(ringPos.x + 6, ringPos.y);
    ctx.arc(ringPos.x, ringPos.y, 6, 0, Math.PI * 2);
  }
  ctx.stroke();
  const sec = analysis.sections[run.active];
  if (sec && run.phase !== 'ship') {
    view.project(run.spider.x, run.spider.y, run.spider.z, ringPos);
    if (ringPos.vis) {
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = withAlpha(sec.color, 0.9);
      ctx.fillText(`crawler · ${sec.name}`, ringPos.x + 24, ringPos.y + 28);
    }
  }
  ctx.restore();
}
