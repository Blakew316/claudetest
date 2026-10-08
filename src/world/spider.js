/**
 * The crawler: a wireframe body with a turning pink core, 16 soft spoke legs
 * that sway with lag, and a gait that hops node to node across the particle
 * web, spinning silk from its rear and anchoring a strand at every landing.
 *
 * Spider.update moves it toward run.spiderGoal one hop at a time and writes
 * run.spider plus silk anchors into run.silk; the draw functions only read.
 */

import { SPIDER, FLAG, TENTACLE, MONO, TEXT, sectionColor, withAlpha } from '../core/theme.js';
import { LEG_COUNT } from '../core/contracts.js';
import { applyWorldTransform, applyScreenTransform, worldToScreen } from './camera.js';
import { fork, range } from '../core/rng.js';

const RX = 24; // body half-length along the heading
const RY = 19;
const HOP_WALK = 88; // hop length while travelling between sections
const HOP_READ = 42; // short repositioning hops while reading
const SILK_CAP = 700;
const CELL = 48; // spatial grid for web nodes

const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Grid of every web particle in world space, built once per world. */
function nodeGrid(world) {
  if (world._nodeGrid) return world._nodeGrid;
  const grid = new Map();
  const clouds = world._clouds || [];
  world.clusters.forEach((c, i) => {
    const px = clouds[i]?.px;
    if (!px) return;
    for (let k = 0; k < px.length; k += 2) {
      const x = c.cx + px[k];
      const y = c.cy + px[k + 1];
      const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(x, y);
    }
  });
  world._nodeGrid = grid;
  return grid;
}

export class Spider {
  /**
   * @param {number} x world position
   * @param {number} y
   * @param {number} seed
   * @param {import('../core/contracts.js').World} [world] web to hop across (optional)
   */
  constructor(x, y, seed = 1, world = null) {
    const rand = fork(seed, 'spider');
    this.rand = fork(seed, 'hops');
    this.world = world;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.heading = -Math.PI / 2;
    this.headingTarget = this.heading;
    this.time = 0;
    this.hop = null;
    this.pause = 0;
    this.activity = 0; // 0 resting .. 1 mid-hop, eased; drives leg flutter
    this.calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.spokes = [];
    for (let i = 0; i < LEG_COUNT; i++) {
      // Evenly around the body, skipping the head so it reads as the front.
      const ang = Math.PI * 0.16 + (i / LEG_COUNT) * Math.PI * 1.68 + (rand() - 0.5) * 0.08;
      this.spokes.push({ ang, len: range(rand, 30, 44), tx: x, ty: y, vx: 0, vy: 0, ph: rand() * Math.PI * 2 });
    }
    this.snapSpokes();
  }

  /** Base point, outward direction and rest tip of a spoke in world space. */
  spokeFrame(s, out) {
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const ca = Math.cos(s.ang);
    const sa = Math.sin(s.ang);
    // Point on the ellipse outline and its outward normal, body frame.
    const bx = ca * RX * 0.96;
    const by = sa * RY * 0.96;
    let nx = ca / RX;
    let ny = sa / RY;
    const nl = Math.hypot(nx, ny);
    nx /= nl;
    ny /= nl;
    const sway = this.calm ? 0 : 0.09 * Math.sin(this.time * 2.4 + s.ph) + 0.2 * this.activity * Math.sin(this.time * 19 + s.ph * 3);
    const cs = Math.cos(sway);
    const ss = Math.sin(sway);
    const dx = nx * cs - ny * ss;
    const dy = nx * ss + ny * cs;
    out.bx = this.x + bx * ch - by * sh;
    out.by = this.y + bx * sh + by * ch;
    out.dx = dx * ch - dy * sh;
    out.dy = dx * sh + dy * ch;
    out.rx = out.bx + out.dx * s.len;
    out.ry = out.by + out.dy * s.len;
    return out;
  }

  snapSpokes() {
    const f = {};
    for (const s of this.spokes) {
      this.spokeFrame(s, f);
      s.tx = f.rx;
      s.ty = f.ry;
      s.vx = s.vy = 0;
    }
  }

  /** Pick the next landing point: a web node roughly hopLen toward the goal. */
  planHop(gx, gy, hopLen) {
    const dx = gx - this.x;
    const dy = gy - this.y;
    const d = Math.hypot(dx, dy);
    if (d <= hopLen * 1.15) return { x: gx, y: gy };
    const ux = dx / d;
    const uy = dy / d;
    // Aim a little off the straight line so the route meanders like a real crawl.
    const swerve = (this.rand() - 0.5) * 0.7;
    const ax = ux * Math.cos(swerve) - uy * Math.sin(swerve);
    const ay = ux * Math.sin(swerve) + uy * Math.cos(swerve);
    const ix = this.x + ax * hopLen;
    const iy = this.y + ay * hopLen;
    const grid = this.world ? nodeGrid(this.world) : null;
    if (!grid) return { x: ix, y: iy };
    const rad = hopLen * 0.45;
    let best = null;
    let bestScore = Infinity;
    const c0x = Math.floor((ix - rad) / CELL);
    const c1x = Math.floor((ix + rad) / CELL);
    const c0y = Math.floor((iy - rad) / CELL);
    const c1y = Math.floor((iy + rad) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const cell = grid.get(`${cx},${cy}`);
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 2) {
          const nx = cell[k];
          const ny = cell[k + 1];
          const off = Math.hypot(nx - ix, ny - iy);
          if (off > rad) continue;
          const step = Math.hypot(nx - this.x, ny - this.y);
          if (step < hopLen * 0.45) continue;
          // Prefer nodes near the aim point that still make progress toward the goal.
          const score = off - ((nx - this.x) * ux + (ny - this.y) * uy) * 0.25;
          if (score < bestScore) {
            bestScore = score;
            best = { x: nx, y: ny };
          }
        }
      }
    }
    return best || { x: ix, y: iy };
  }

  /**
   * Advance one step toward run.spiderGoal; writes run.spider and silk anchors.
   * @param {number} dt seconds
   * @param {import('../core/contracts.js').RunState} run
   */
  update(dt, run) {
    this.time += dt;
    const px = this.x;
    const py = this.y;
    const g = run.spiderGoal;

    if (Math.hypot(g.x - this.x, g.y - this.y) > 3000) {
      this.x = g.x;
      this.y = g.y;
      this.hop = null;
      run.silk.length = 0;
      this.snapSpokes();
    }

    if (this.hop) {
      const h = this.hop;
      h.t += dt;
      const u = Math.min(1, h.t / h.dur);
      const e = smoother(u);
      // A slight sideways arc makes each hop read as a jump, not a slide.
      const lift = Math.sin(Math.PI * u) * h.arc;
      this.x = h.fx + (h.tx - h.fx) * e - h.uy * lift;
      this.y = h.fy + (h.ty - h.fy) * e + h.ux * lift;
      if (u >= 1) {
        this.hop = null;
        run.silk.push({ x: this.x, y: this.y, s: run.silkSection, t: run.t });
        if (run.silk.length > SILK_CAP) run.silk.shift();
        const walking = run.phase === 'walk';
        this.pause = walking ? range(this.rand, 0.03, 0.1) : range(this.rand, 0.25, 0.6);
      }
    } else if (this.pause > 0) {
      this.pause -= dt;
    } else {
      const d = Math.hypot(g.x - this.x, g.y - this.y);
      const walking = run.phase === 'walk' || run.phase === 'ship';
      if (d > (walking ? 12 : 24)) {
        const hopLen = walking ? HOP_WALK : HOP_READ;
        const to = this.planHop(g.x, g.y, hopLen);
        const len = Math.hypot(to.x - this.x, to.y - this.y);
        if (len > 1) {
          this.hop = {
            fx: this.x,
            fy: this.y,
            tx: to.x,
            ty: to.y,
            ux: (to.x - this.x) / len,
            uy: (to.y - this.y) / len,
            t: 0,
            dur: 0.1 + len / 650,
            arc: (this.rand() - 0.5) * Math.min(10, len * 0.12),
          };
          // Face the hop, but while reading only nudge the body so it doesn't spin.
          const turn = wrap(Math.atan2(to.y - this.y, to.x - this.x) - this.heading);
          const maxTurn = walking ? Math.PI : 0.45;
          this.headingTarget = this.heading + Math.max(-maxTurn, Math.min(maxTurn, turn));
        }
      }
    }

    this.activity += ((this.hop ? 1 : 0) - this.activity) * (1 - Math.exp(-10 * dt));
    this.heading += wrap(this.headingTarget - this.heading) * (1 - Math.exp(-3 * dt));
    this.vx = (this.x - px) / dt;
    this.vy = (this.y - py) / dt;

    // Spokes: damped springs toward their rest tips, so they trail and settle.
    const f = {};
    for (const s of this.spokes) {
      this.spokeFrame(s, f);
      s.vx += ((f.rx - s.tx) * 380 - s.vx * 28) * dt;
      s.vy += ((f.ry - s.ty) * 380 - s.vy * 28) * dt;
      s.tx += s.vx * dt;
      s.ty += s.vy * dt;
      // Keep each spoke between 70% and 125% of its length from its base.
      const ex = s.tx - f.bx;
      const ey = s.ty - f.by;
      const el = Math.hypot(ex, ey) || 1;
      const cl = Math.max(s.len * 0.7, Math.min(s.len * 1.25, el));
      s.tx = f.bx + (ex / el) * cl;
      s.ty = f.by + (ey / el) * cl;
    }

    run.spider.x = this.x;
    run.spider.y = this.y;
    run.spider.vx = this.vx;
    run.spider.vy = this.vy;
    run.spider.heading = this.heading;
  }

  /**
   * Draw glow, spokes, head, body and core in world space.
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('../core/contracts.js').RunState} run
   * @param {import('../core/contracts.js').View} view
   */
  draw(ctx, run, view) {
    applyWorldTransform(ctx, view);
    const px = 1 / view.camera.zoom;
    const t = this.time;
    const { x, y, heading } = this;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(x, y, 4, x, y, 80);
    glow.addColorStop(0, withAlpha(SPIDER, 0.26));
    glow.addColorStop(1, withAlpha(SPIDER, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - 82, y - 82, 164, 164);
    ctx.restore();

    // Spokes: a soft curve from the body to the lagging tip.
    const f = {};
    ctx.strokeStyle = withAlpha(SPIDER, 0.9);
    ctx.lineWidth = Math.max(1.1 * px, 0.8);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const s of this.spokes) {
      this.spokeFrame(s, f);
      ctx.moveTo(f.bx, f.by);
      ctx.quadraticCurveTo(f.bx + f.dx * s.len * 0.55, f.by + f.dy * s.len * 0.55, s.tx, s.ty);
    }
    ctx.stroke();
    ctx.fillStyle = SPIDER;
    ctx.beginPath();
    const r = 1.9 * px;
    for (const s of this.spokes) {
      ctx.moveTo(s.tx + r, s.ty);
      ctx.arc(s.tx, s.ty, r, 0, Math.PI * 2);
    }
    ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);

    // Head with eyes and two looping palps, at the front.
    const hx = RX + 5;
    ctx.strokeStyle = SPIDER;
    ctx.lineWidth = 1.2 * px;
    ctx.fillStyle = 'rgba(6,16,15,0.88)';
    ctx.beginPath();
    ctx.arc(hx, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.fillRect(hx + 1.5, -3.4, 2.2, 2.2);
    ctx.fillRect(hx + 1.5, 1.2, 2.2, 2.2);
    const palp = this.calm ? 0 : Math.sin(t * 5) * 1.5;
    ctx.beginPath();
    for (const sgn of [-1, 1]) {
      ctx.moveTo(hx + 5, sgn * 4);
      ctx.bezierCurveTo(hx + 18, sgn * (12 + palp), hx + 22, sgn * 2, hx + 13, sgn * 5);
    }
    ctx.stroke();

    // Body: dark fill, a slowly turning lat/long mesh, bright outline.
    ctx.beginPath();
    ctx.ellipse(0, 0, RX, RY, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,18,16,0.85)';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = withAlpha(SPIDER, 0.48);
    ctx.lineWidth = 0.8 * px;
    ctx.beginPath();
    const spin = this.calm ? 0 : t * 0.45;
    for (let k = 0; k < 14; k++) {
      const th = (k / 14) * Math.PI * 2 + spin;
      if (Math.cos(th) < 0) continue;
      const mx = RX * Math.sin(th);
      ctx.moveTo(mx, -RY);
      ctx.lineTo(mx, RY);
    }
    for (let k = -4; k <= 4; k++) {
      const my = RY * Math.sin((k / 5) * (Math.PI / 2));
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

    // Spinneret at the rear, where the silk leaves the body.
    ctx.fillStyle = SPIDER;
    ctx.beginPath();
    ctx.arc(-RX, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(this.calm ? 0.6 : t * 1.1);
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
 * Silk: straight strands between landing anchors in each section's colour,
 * older strands fading, plus the live strand paying out from the spinneret.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../core/contracts.js').RunState} run
 * @param {import('../core/contracts.js').View} view
 * @param {import('../core/contracts.js').Analysis} analysis
 */
export function drawSilk(ctx, run, view, analysis) {
  const pts = run.silk;
  if (!pts.length) return;
  applyWorldTransform(ctx, view);
  const px = 1 / view.camera.zoom;
  const colorOf = (s) => analysis.sections[s]?.color ?? SPIDER;
  ctx.lineWidth = 1.2 * px;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const n = pts.length;
  // Group consecutive segments by colour and age bucket to keep draw calls low.
  let i = 1;
  while (i < n) {
    const s = pts[i].s;
    const bucket = Math.floor(((n - i) / n) * 6);
    ctx.strokeStyle = withAlpha(colorOf(s), 0.75 - bucket * 0.11);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    while (i < n && pts[i].s === s && Math.floor(((n - i) / n) * 6) === bucket) {
      ctx.lineTo(pts[i].x, pts[i].y);
      i++;
    }
    ctx.stroke();
  }
  // Anchor knots.
  ctx.fillStyle = withAlpha(TENTACLE, 0.55);
  ctx.beginPath();
  for (let k = Math.max(0, n - 120); k < n; k++) ctx.rect(pts[k].x - 1.2 * px, pts[k].y - 1.2 * px, 2.4 * px, 2.4 * px);
  ctx.fill();
  // Live strand from the last anchor to the spinneret.
  const last = pts[n - 1];
  const h = run.spider.heading;
  const sx = run.spider.x - Math.cos(h) * RX;
  const sy = run.spider.y - Math.sin(h) * RX;
  ctx.strokeStyle = withAlpha(colorOf(run.silkSection), 0.9);
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(sx, sy);
  ctx.stroke();
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
  const z = Math.min(1.4, view.camera.zoom);
  ctx.font = `11px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = withAlpha(color, 0.9);
  ctx.fillText(`crawler · ${name}`, tagPos.x + 38 * z, tagPos.y + 48 * z);
}
