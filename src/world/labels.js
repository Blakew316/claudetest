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

/**
 * How long (s) a word's label is up once it is read (Infinity for a flag,
 * which stays the whole section; 0 for a filler word, which gets none). The
 * camera uses this to keep the labels on screen while they are.
 */
export function labelLife(word) {
  if (word.vague) return Infinity;
  if (word.kind) return HOLD_LINK + FADE_OUT;
  return STOPWORDS.has(word.text.toLowerCase()) ? 0 : HOLD_PLAIN + FADE_OUT;
}

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
/**
 * The camera films Iron Man close, so many of the words he reads are off
 * screen: a label of the section being read that is still recent (PIN_AGE s)
 * is pinned to the frame's edge, inside this margin (CSS px: the HUD's
 * title block across the top), with a chevron pointing the way to its word.
 */
const PIN_AGE = 4;
const INSET = { top: 112, right: 12, bottom: 18, left: 12 };
const CHEVRON = 6;
/** A label that would sit over him while its word is behind him moves aside, this far clear, on a leader. */
const CLEAR = 8;

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
 * Where on the frame's edge (inside `rect`, {left, top, right, bottom} in px)
 * a ray from (ox, oy) (its middle by default) in direction (dx, dy) leaves it.
 * @returns {{x:number, y:number}}
 */
export function edgePoint(rect, dx, dy, ox = (rect.left + rect.right) / 2, oy = (rect.top + rect.bottom) / 2) {
  const cx = Math.max(rect.left, Math.min(rect.right, ox));
  const cy = Math.max(rect.top, Math.min(rect.bottom, oy));
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  let t = Infinity;
  if (ux > 1e-6) t = Math.min(t, (rect.right - cx) / ux);
  if (ux < -1e-6) t = Math.min(t, (rect.left - cx) / ux);
  if (uy > 1e-6) t = Math.min(t, (rect.bottom - cy) / uy);
  if (uy < -1e-6) t = Math.min(t, (rect.top - cy) / uy);
  if (!Number.isFinite(t)) t = 0;
  return { x: cx + ux * t, y: cy + uy * t };
}

/**
 * Calls fn(x, y, r) for points along each of his silhouette's segments (see
 * view3d silhouette), close enough that their discs cover it; stops early
 * once fn returns true. Returns whether it did.
 */
function eachHeroDisc(hero, fn) {
  const g = hero.seg;
  for (let i = 0; i < hero.n; i++) {
    const x0 = g[i * 5];
    const y0 = g[i * 5 + 1];
    const x1 = g[i * 5 + 2];
    const y1 = g[i * 5 + 3];
    const r = g[i * 5 + 4];
    const k = Math.min(16, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(2, r))));
    for (let j = 0; j <= k; j++) if (fn(x0 + ((x1 - x0) * j) / k, y0 + ((y1 - y0) * j) / k, r)) return true;
  }
  return false;
}

/** Whether a box (x, y, w, h) overlaps his silhouette. */
function overHero(hero, x, y, w, h) {
  return eachHeroDisc(hero, (px, py, r) => Math.hypot(px - Math.max(x, Math.min(x + w, px)), py - Math.max(y, Math.min(y + h, py))) < r);
}

/** How far across the screen his silhouette reaches between heights y0 and y1: [left, right] (px). */
function heroSpan(hero, y0, y1) {
  let lo = Infinity;
  let hi = -Infinity;
  eachHeroDisc(hero, (px, py, r) => {
    if (py + r >= y0 && py - r <= y1) {
      lo = Math.min(lo, px - r);
      hi = Math.max(hi, px + r);
    }
    return false;
  });
  return [lo, hi];
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
  const hero = view.hero && view.hero.on ? view.hero : null;
  const rect = { left: INSET.left, top: Math.min(INSET.top, height * 0.2), right: width - INSET.right, bottom: height - INSET.bottom };
  const pinned = []; // boxes already pinned to the edge, [x, y, w] each
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
      const text = labelText(word);
      const w = measure(ctx, text) + PAD_X * 2;
      let bx = Math.round(p.x) + 4;
      let by = Math.round(p.y) - 4 - BOX_H;
      // Farther labels recede, like the web behind them.
      let depthA = Math.max(0.3, Math.min(1, 1.5 - p.d / (view.camDist * 1.6)));
      let lead = false; // a leader line from the word to its moved label
      let chev = null; // the way to a pinned label's word
      if (!p.vis || bx > width || by > height || bx + w < 0 || by + BOX_H < 0) {
        // Off screen: a recent label of the section being read is pinned to the edge, where the line from
        // him to its word (his beam's way) leaves the frame.
        if (!isActive || age > PIN_AGE) continue;
        const ox = p.vis && hero ? hero.chestX : width / 2;
        const oy = p.vis && hero ? hero.chestY : height / 2;
        let dx = p.x - ox;
        let dy = p.y - oy;
        if (!p.vis) [dx, dy] = [-dx, -dy]; // (behind the lens the projection is mirrored)
        const l = Math.hypot(dx, dy) || 1;
        chev = { x: dx / l, y: dy / l };
        const e = edgePoint(rect, dx, dy, ox, oy);
        const pin = (ex, ey) => [Math.round(Math.max(rect.left, Math.min(rect.right - w, ex - w / 2 - chev.x * (w / 2 + CHEVRON + 2)))), Math.round(Math.max(rect.top, Math.min(rect.bottom - BOX_H, ey - BOX_H / 2 - chev.y * (BOX_H / 2 + CHEVRON + 2))))];
        [bx, by] = pin(e.x, e.y);
        // Stacked along the edge, clear of the labels already pinned there.
        const side = Math.abs(chev.x) * height > Math.abs(chev.y) * width; // a left or right edge
        for (let k = 1; k < 12 && pinned.some(([x, y, pw]) => bx < x + pw + 3 && x < bx + w + 3 && by < y + BOX_H + 3 && y < by + BOX_H + 3); k++) {
          const step = (k % 2 ? 1 : -1) * Math.ceil(k / 2);
          [bx, by] = pin(e.x + (side ? 0 : step * (w + 6)), e.y + (side ? step * (BOX_H + 4) : 0));
        }
        pinned.push([bx, by, w]);
        depthA = 0.9;
      } else if (hero && p.d > hero.d && overHero(hero, bx, by, w, BOX_H)) {
        // Behind him, it would sit on his body: aside, on whichever side of him is nearer, on a leader.
        const [lo, hi] = heroSpan(hero, by - 2, by + BOX_H + 2);
        const left = Math.round(lo - CLEAR - w);
        const right = Math.round(hi + CLEAR);
        bx = (p.x - lo < hi - p.x && left > 0) || right + w > width ? left : right;
        lead = true;
      }
      ctx.globalAlpha = a * depthA;
      if (lead) {
        ctx.strokeStyle = border;
        ctx.globalAlpha = a * depthA * 0.6;
        ctx.beginPath();
        ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
        ctx.lineTo(bx < p.x ? bx + w : bx, by + BOX_H / 2);
        ctx.stroke();
        ctx.globalAlpha = a * depthA;
      }
      if (chev) {
        // The chevron, just outside the label on the side of its word.
        const cx = bx + w / 2 + chev.x * (w / 2 + 3);
        const cy = by + BOX_H / 2 + chev.y * (BOX_H / 2 + 3);
        const tx = cx + chev.x * CHEVRON;
        const ty = cy + chev.y * CHEVRON;
        ctx.fillStyle = word.vague ? FLAG : color;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(cx - chev.y * CHEVRON * 0.6, cy + chev.x * CHEVRON * 0.6);
        ctx.lineTo(cx + chev.y * CHEVRON * 0.6, cy - chev.x * CHEVRON * 0.6);
        ctx.closePath();
        ctx.fill();
      }
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
const TAG_BELOW = 14; // world units: the crawler tag sits this far below the crawler point (under Iron Man's feet)

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
    // Under his feet, not across him: the camera films him close up (below his lowest foot on screen, when it is known).
    const [x, y, z] = view.spider ?? [run.spider.x, run.spider.y, run.spider.z];
    view.project(x, y - TAG_BELOW, z, ringPos);
    const hero = view.hero;
    if (hero && hero.on && Number.isFinite(hero.footY)) {
      ringPos.x = hero.footX;
      ringPos.y = hero.footY + 2;
      ringPos.vis = true;
    }
    if (ringPos.vis) {
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = withAlpha(sec.color, 0.9);
      ctx.fillText(`crawler · ${sec.name}`, ringPos.x, ringPos.y + 12);
    }
  }
  ctx.restore();
}
