/**
 * The crawler: a procedural spider with a wireframe body, a rotating pink
 * core, 16 IK legs that plant and step, dotted tentacles that reach for the
 * words being read, and a silk line trailing behind it.
 *
 * Spider.update steers toward run.spiderGoal and writes run.spider; the draw
 * functions only read run state.
 */

import { SPIDER, FLAG, TENTACLE, MONO, sectionColor, withAlpha, TEXT } from '../core/theme.js';
import { LEG_COUNT } from '../core/contracts.js';
import { applyWorldTransform, applyScreenTransform, worldToScreen } from './camera.js';
import { fork, range } from '../core/rng.js';

const RX = 26; // body half-length along the heading
const RY = 20;
const UPPER = 30;
const LOWER = 32;
const MAX_SPEED = 520;
const STEP_TIME = 0.09;

export class Spider {
  /**
   * @param {number} x world position
   * @param {number} y
   * @param {number} seed
   */
  constructor(x, y, seed = 1) {
    const rand = fork(seed, 'spider');
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.heading = -Math.PI / 2;
    this.time = 0;
    this.phase = rand() * 10;
    this.gait = 0;
    this.gaitTimer = 0;
    this.legs = [];
    for (let i = 0; i < LEG_COUNT; i++) {
      const a = (i / LEG_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.25;
      const reach = range(rand, 0.9, 0.98) * (UPPER + LOWER);
      this.legs.push({ a, reach, fx: 0, fy: 0, sx: 0, sy: 0, tx: 0, ty: 0, step: 1, group: i % 2, jit: rand() * 100 });
    }
    this.plantAll();
  }

  /** Put every foot on its rest point (used at start and after a teleport). */
  plantAll() {
    for (const leg of this.legs) {
      const r = this.rest(leg, 0, 0);
      leg.fx = leg.sx = leg.tx = r.x;
      leg.fy = leg.sy = leg.ty = r.y;
      leg.step = 1;
    }
  }

  /** Rest point of a leg, leading slightly in the direction of travel. */
  rest(leg, leadX, leadY) {
    const a = leg.a + this.heading;
    return { x: this.x + Math.cos(a) * leg.reach + leadX, y: this.y + Math.sin(a) * leg.reach + leadY };
  }

  /**
   * Advance one step toward run.spiderGoal and write run.spider.
   * @param {number} dt seconds
   * @param {import('../core/contracts.js').RunState} run
   */
  update(dt, run) {
    this.time += dt;
    const g = run.spiderGoal;
    let dx = g.x - this.x;
    let dy = g.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 3000) {
      this.x = g.x;
      this.y = g.y;
      this.vx = this.vy = 0;
      this.plantAll();
    } else {
      // Arrive behaviour with a lateral wander so long walks curve.
      const speed = Math.min(MAX_SPEED, dist * 3.2);
      const nx = dist > 1e-3 ? dx / dist : 0;
      const ny = dist > 1e-3 ? dy / dist : 0;
      const wander = Math.sin(this.time * 1.7 + this.phase) * 0.35 * Math.min(1, dist / 200);
      const wx = (nx - ny * wander) * speed;
      const wy = (ny + nx * wander) * speed;
      const k = 1 - Math.exp(-7 * dt);
      this.vx += (wx - this.vx) * k;
      this.vy += (wy - this.vy) * k;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 25) {
      const target = Math.atan2(this.vy, this.vx);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-6 * dt));
    }

    // Gait: alternate groups; a leg steps when its foot falls too far behind.
    this.gaitTimer += dt;
    if (this.gaitTimer > 0.07) {
      this.gaitTimer = 0;
      this.gait ^= 1;
    }
    // Feet lead slightly in the direction of travel, capped so legs stay near-straight.
    const leadLen = Math.min(14, sp * 0.06);
    const leadX = sp > 1 ? (this.vx / sp) * leadLen : 0;
    const leadY = sp > 1 ? (this.vy / sp) * leadLen : 0;
    for (const leg of this.legs) {
      if (leg.step < 1) {
        leg.step = Math.min(1, leg.step + dt / STEP_TIME);
        const e = leg.step * leg.step * (3 - 2 * leg.step);
        leg.fx = leg.sx + (leg.tx - leg.sx) * e;
        leg.fy = leg.sy + (leg.ty - leg.sy) * e;
        continue;
      }
      const r = this.rest(leg, leadX, leadY);
      const off = Math.hypot(leg.fx - r.x, leg.fy - r.y);
      if ((off > leg.reach * 0.42 && leg.group === this.gait) || off > leg.reach * 0.9) {
        leg.sx = leg.fx;
        leg.sy = leg.fy;
        leg.tx = r.x;
        leg.ty = r.y;
        leg.step = 0;
      }
    }
    run.spider.x = this.x;
    run.spider.y = this.y;
    run.spider.vx = this.vx;
    run.spider.vy = this.vy;
    run.spider.heading = this.heading;
  }

  /**
   * Draw glow, legs, body, core and head in world space.
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('../core/contracts.js').RunState} run
   * @param {import('../core/contracts.js').View} view
   */
  draw(ctx, run, view) {
    applyWorldTransform(ctx, view);
    const z = view.camera.zoom;
    const px = 1 / z; // one screen pixel in world units
    const t = this.time;
    const { x, y, heading } = this;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(x, y, 4, x, y, 78);
    glow.addColorStop(0, withAlpha(SPIDER, 0.28));
    glow.addColorStop(1, withAlpha(SPIDER, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - 80, y - 80, 160, 160);
    ctx.restore();

    // Legs: two-segment IK, knee bent away from the body.
    const twitch = view.reducedMotion ? 0 : 1.1;
    ctx.strokeStyle = withAlpha(SPIDER, 0.92);
    ctx.lineWidth = Math.max(1.1 * px, 0.9);
    const dots = [];
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    ctx.beginPath();
    for (const leg of this.legs) {
      // Hip on the body outline, in body frame, rotated into the world.
      const bx = Math.cos(leg.a) * RX * 0.9;
      const by = Math.sin(leg.a) * RY * 0.9;
      const hx = x + bx * ch - by * sh;
      const hy = y + bx * sh + by * ch;
      const lift = leg.step < 1 ? Math.sin(leg.step * Math.PI) * 7 : 0;
      let fx = leg.fx + Math.sin(t * 21 + leg.jit) * twitch;
      let fy = leg.fy + Math.cos(t * 17 + leg.jit) * twitch - lift;
      let dx = fx - hx;
      let dy = fy - hy;
      let d = Math.hypot(dx, dy);
      const maxD = UPPER + LOWER - 0.5;
      if (d > maxD) {
        fx = hx + (dx / d) * maxD;
        fy = hy + (dy / d) * maxD;
        dx = fx - hx;
        dy = fy - hy;
        d = maxD;
      }
      d = Math.max(d, 1e-3);
      const cosA = (UPPER * UPPER + d * d - LOWER * LOWER) / (2 * UPPER * d);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
      const base = Math.atan2(dy, dx);
      // Pick the knee side that sits farther from the body centre.
      let kx = hx + Math.cos(base + ang) * UPPER;
      let ky = hy + Math.sin(base + ang) * UPPER;
      const k2x = hx + Math.cos(base - ang) * UPPER;
      const k2y = hy + Math.sin(base - ang) * UPPER;
      if (Math.hypot(k2x - x, k2y - y) > Math.hypot(kx - x, ky - y)) {
        kx = k2x;
        ky = k2y;
      }
      ctx.moveTo(hx, hy);
      ctx.lineTo(kx, ky);
      ctx.lineTo(fx, fy);
      dots.push(kx, ky, fx, fy);
    }
    ctx.stroke();
    ctx.fillStyle = SPIDER;
    ctx.beginPath();
    for (let i = 0; i < dots.length; i += 4) {
      ctx.moveTo(dots[i] + 1.4 * px, dots[i + 1]);
      ctx.arc(dots[i], dots[i + 1], 1.4 * px, 0, Math.PI * 2);
      ctx.moveTo(dots[i + 2] + 2 * px, dots[i + 3]);
      ctx.arc(dots[i + 2], dots[i + 3], 2 * px, 0, Math.PI * 2);
    }
    ctx.fill();

    // Body in its own frame: heading along +x.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);

    // Head, eyes and pedipalps sit ahead of the body.
    const hx = RX + 6;
    ctx.fillStyle = 'rgba(6,16,15,0.85)';
    ctx.strokeStyle = SPIDER;
    ctx.lineWidth = 1.3 * px;
    ctx.beginPath();
    ctx.arc(hx, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.fillRect(hx + 2, -3.2, 2, 2);
    ctx.fillRect(hx + 2, 1.2, 2, 2);
    ctx.beginPath();
    for (const s of [-1, 1]) {
      ctx.moveTo(hx + 5, s * 4);
      ctx.quadraticCurveTo(hx + 16, s * 9, hx + 22, s * 4.5);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(0, 0, RX, RY, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,18,16,0.82)';
    ctx.fill();
    ctx.save();
    ctx.clip();
    // Wireframe: meridians scroll as if the body were a turning ellipsoid.
    ctx.strokeStyle = withAlpha(SPIDER, 0.5);
    ctx.lineWidth = 0.8 * px;
    ctx.beginPath();
    const spin = view.reducedMotion ? 0 : t * 1.4;
    for (let k = 0; k < 12; k++) {
      const th = ((k / 12) * Math.PI * 2 + spin) % (Math.PI * 2);
      if (Math.cos(th) < 0) continue;
      const mx = RX * Math.sin(th);
      ctx.moveTo(mx, -RY);
      ctx.lineTo(mx, RY);
    }
    for (let k = -3; k <= 3; k++) {
      const my = RY * Math.sin((k / 4) * (Math.PI / 2));
      ctx.moveTo(-RX, my);
      ctx.lineTo(RX, my);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = SPIDER;
    ctx.lineWidth = 1.6 * px;
    ctx.beginPath();
    ctx.ellipse(0, 0, RX, RY, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Core.
    ctx.rotate(view.reducedMotion ? 0.6 : t * 2.2);
    ctx.shadowColor = FLAG;
    ctx.shadowBlur = 10;
    ctx.fillStyle = FLAG;
    ctx.fillRect(-4.6, -4.6, 9.2, 9.2);
    ctx.restore();
  }
}

/**
 * Dotted tentacles from the body to the words being read, with a ring on the target.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').World} world
 * @param {import('../core/contracts.js').RunState} run
 * @param {import('../core/contracts.js').View} view
 */
export function drawTentacles(ctx, world, run, view) {
  if (!run.tentacles.length) return;
  applyWorldTransform(ctx, view);
  const px = 1 / view.camera.zoom;
  const gap = 5 * px;
  const dot = 1.7 * px;
  const sx = run.spider.x;
  const sy = run.spider.y;
  ctx.fillStyle = withAlpha(TENTACLE, 0.88);
  ctx.beginPath();
  const rings = [];
  for (const tn of run.tentacles) {
    const tx = world.wordPos[tn.wordId * 2];
    const ty = world.wordPos[tn.wordId * 2 + 1];
    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const ox = sx + (dx / len) * 18;
    const oy = sy + (dy / len) * 18;
    const bow = (tn.wordId % 2 ? 1 : -1) * 0.16 * len;
    const cx = (ox + tx) / 2 - (dy / len) * bow;
    const cy = (oy + ty) / 2 + (dx / len) * bow;
    const n = Math.max(2, Math.floor((len * 1.05) / gap));
    const m = Math.floor(n * tn.p);
    for (let i = 0; i <= m; i++) {
      const u = i / n;
      const v = 1 - u;
      const bx = v * v * ox + 2 * v * u * cx + u * u * tx;
      const by = v * v * oy + 2 * v * u * cy + u * u * ty;
      ctx.rect(bx - dot / 2, by - dot / 2, dot, dot);
    }
    if (tn.stage === 'hold') rings.push(tx, ty);
  }
  ctx.fill();
  if (rings.length) {
    ctx.strokeStyle = withAlpha(TENTACLE, 0.75);
    ctx.lineWidth = 1 * px;
    ctx.beginPath();
    for (let i = 0; i < rings.length; i += 2) {
      ctx.moveTo(rings[i] + 5 * px + 2, rings[i + 1]);
      ctx.arc(rings[i], rings[i + 1], 5 * px + 2, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

/**
 * The silk line behind the spider, fading toward its tail.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').RunState} run
 * @param {import('../core/contracts.js').View} view
 * @param {import('../core/contracts.js').Analysis} analysis
 */
export function drawSilk(ctx, run, view, analysis) {
  const pts = run.silk;
  if (pts.length < 3) return;
  applyWorldTransform(ctx, view);
  const color = analysis.sections[run.silkSection]?.color ?? SPIDER;
  ctx.lineWidth = 1.3 / view.camera.zoom;
  ctx.lineCap = 'round';
  const chunks = 8;
  const per = Math.ceil(pts.length / chunks);
  for (let c = 0; c < chunks; c++) {
    const a = c * per;
    const b = Math.min(pts.length - 1, a + per + 1);
    if (b - a < 2) continue;
    ctx.strokeStyle = withAlpha(color, 0.08 + 0.72 * ((c + 1) / chunks));
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    for (let i = a + 1; i < b; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.stroke();
  }
}

const tagPos = { x: 0, y: 0 };

/**
 * "crawler · rules" tag beside the spider, screen space.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').RunState} run
 * @param {import('../core/contracts.js').View} view
 * @param {import('../core/contracts.js').Analysis} analysis
 */
export function drawTag(ctx, run, view, analysis) {
  const sec = analysis.sections[run.active];
  const name = sec ? sec.name : 'ship';
  const color = sec ? sec.color : sectionColor(0);
  applyScreenTransform(ctx, view);
  worldToScreen(view, run.spider.x, run.spider.y, tagPos);
  ctx.font = `11px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = withAlpha(color, 0.9);
  ctx.fillText(`crawler · ${name}`, tagPos.x + 34 * Math.min(1.4, view.camera.zoom), tagPos.y + 44 * Math.min(1.4, view.camera.zoom));
}
