/**
 * The timeline. Owns every RunState mutation (except run.spider, which
 * Spider.update writes): boot, then walk + read for each section, then the
 * ship overview. Pure simulation, no DOM, deterministic at SIM_DT, so
 * seek(t) reproduces exactly what live playback would show.
 *
 * It is also the cinematographer. Every move is keyframed and then spring
 * smoothed (world/camera.js), so there are no cuts:
 *  - intro: far out on the whole nebula from high up, gliding in past the
 *    neighbouring balls while the spider abseils down onto the first one;
 *  - each section: an establishing view of the whole ball, then 2-3 sub-shots
 *    (a slow push-in on the spider, a slow arc round it to another elevation,
 *    in a per-section order), easing back out before the leap;
 *  - leaps: the camera starts turning during the crouch, frames the flight (as
 *    side-on as a small turn allows) so the trailing legs and the next ball are
 *    both in shot, and settles into the next establishing view on landing, all
 *    on one slow turn;
 *  - finale: a rising orbit of the whole nebula, then a slow closing drift onto
 *    the spider resting on an outer ball with the nebula behind it.
 * Each move is pre-visualised against the world before it is used: the
 * camera never sits inside a ball's dense core, and angles are chosen for a
 * clear line of sight to the spider.
 *
 * Pacing: each section's read time grows with its word count (5-12.5 s), and
 * the whole run is held under ~4 minutes however long the prompt.
 */

import { createRunState, MAX_TENTACLES, SIM_DT } from '../core/contracts.js';
import { computeScore } from '../analyze/score.js';
import { clearDistance, fitDistance, followCamera, orbitDir, sampleKeys, shotCost } from '../world/camera.js';
import { fork, range } from '../core/rng.js';
import { Spider } from '../world/spider.js';

const BOOT = 0.4;
const INTRO_AIR = 6.2; // the opening abseil down onto the first cluster
const INTRO_HOLD = 1.0; // breath on the first ball before reading starts
const BREATH = 0.8; // after a landing, before the first reach
const LAND = 0.36; // the spider's landing absorb (spider.js LAND_TIME)
const SHIP_SETTLE = 17; // the finale: orbit the nebula, then drift onto the spider
const TAIL = 1.5; // last reach + hold + retract after the final word
const GAP = 1.04; // mean gap between reaches, in units of 1/rate (see nextGap)
const RATE_CAP = 11; // reaches per second at most; denser sections read a phrase per reach
const RUN_BUDGET = 228; // seconds: even a 1500-word, 12-section prompt finishes under ~4 min
const MIN_READ = 5;
const MAX_READ = 12.5;
const LOG_CAP = 40;
const TURN_U = 0.12; // the leap's camera turn finishes this far into the reading
const PI = Math.PI;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Planned read time for a section (s): longer sections linger, within limits. */
const readSeconds = (count) => (count ? clamp(4 + 1.1 * Math.sqrt(count), MIN_READ, MAX_READ) : 2.5);
/** Floaty, unhurried leaps; long gaps take longer and arc higher. */
const airTime = (L) => clamp(1.7 + L / 380, 2.0, 3.6);

/** Elevation classes, radians of pitch (> 0 looks down). */
const ELEV = { top: 1.12, high: 0.8, three: 0.5, side: 0.12, low: -0.3 };
// Each section's establishing elevation, cycling, like the reference: three-quarter,
// top-down, side-on, high three-quarter, low looking up, top, shallow side.
const EST = ['three', 'top', 'side', 'high', 'low', 'top', 'three'];
// The arc goes to a clearly different elevation.
const ARC_TO = {
  top: ['side', 'three'],
  high: ['side', 'low'],
  three: ['top', 'low'],
  side: ['high', 'top'],
  low: ['three', 'high'],
};

/** Program shown in the CRAWLER.PY panel; revealed as the crawl progresses. */
export function crawlerProgram(fileName) {
  return [
    '# crawler.py · reads a prompt',
    `graph = load("${fileName}")`,
    'spider = Crawler(legs=16, tentacles=22)',
    '',
    'for section in graph.sections:',
    '    spider.walk_to(section)',
    '    for word in spider.reach(section):',
    '        kind = classify(word)',
    '        if kind == "vague":',
    '            flags.append(word)',
    '        else:',
    '            graph.link(word, kind)',
  ].join('\n');
}

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * @param {import('../core/contracts.js').Analysis} analysis
 * @param {import('../core/contracts.js').World} world
 * @param {() => {width:number, height:number}} getStage stage size in CSS px, for camera framing
 * @param {number} seed
 */
export function createDirector(analysis, world, getStage, seed = 1) {
  const n = analysis.sections.length;
  const total = analysis.words.length;
  const program = crawlerProgram(analysis.fileName);
  const clusters = world.clusters;
  const B = world.bounds;
  const readT = planReadTimes();

  let run;
  let spider;
  let cursor; // next word id to reach in the active section
  let readAcc;
  let recent; // read timestamps for words/second
  let scoreTick;
  let cadence;
  let nextReach;
  let rate; // reaches per second in the active section
  let baseRate; // as planned when the section started
  let span; // words read per reach in the active section
  let burstLeft; // quick reaches left in the current flurry
  let planRand;
  let plans; // per-section shot plans
  let intro; // intro keys (absolute run.t)
  let ship; // finale plan
  let lastRecipe;
  const key = {};
  const tgt = { x: 0, y: 0, z: 0, dist: 1, yaw: 0, pitch: 0 };
  const dir = [0, 0, 0];

  const api = {
    get run() {
      return run;
    },
    get spider() {
      return spider;
    },
    program,
    reset,
    step,
    seek,
    seekSection,
  };

  /* ------------------------------------------------------------ geometry */

  function aspect() {
    const { width, height } = getStage();
    return width / Math.max(1, height);
  }

  /** Distance at which a ball of radius r fills the frame (f = 1). */
  function fitR(r) {
    return fitDistance(r, aspect(), 50, 1.15);
  }

  function centroid(from, to) {
    if (to <= from) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let id = from; id < to; id++) {
      x += world.wordPos[id * 3];
      y += world.wordPos[id * 3 + 1];
      z += world.wordPos[id * 3 + 2];
    }
    const k = to - from;
    return { x: x / k, y: y / k, z: z / k };
  }

  /** Where the spider lands on section i: among its first words. */
  function landing(i) {
    const sec = analysis.sections[i];
    const c = clusters[i];
    return centroid(sec.start, Math.min(sec.start + 6, sec.start + sec.count)) || { x: c.cx, y: c.cy, z: c.cz };
  }

  /** Per-section read times, scaled down if the whole run would overrun the budget. */
  function planReadTimes() {
    const out = analysis.sections.map((s) => readSeconds(s.count));
    let fixed = BOOT + INTRO_AIR + LAND + INTRO_HOLD + SHIP_SETTLE;
    for (let i = 1; i < n; i++) {
      const a = analysis.sections[i - 1];
      const from = centroid(Math.max(a.start, a.start + a.count - 4), a.start + a.count) || { x: clusters[i - 1].cx, y: clusters[i - 1].cy, z: clusters[i - 1].cz };
      const to = landing(i);
      fixed += 0.48 + airTime(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)) + LAND + BREATH + 0.2;
    }
    const sum = out.reduce((s, t) => s + t, 0);
    if (sum > 0 && fixed + sum > RUN_BUDGET) {
      const k = Math.max(0, RUN_BUDGET - fixed) / sum;
      for (let i = 0; i < n; i++) out[i] = Math.max(Math.min(out[i], MIN_READ), out[i] * k);
    }
    return out;
  }

  /* --------------------------------------------------------- shot design */

  function makeKey(t, w, dist, yaw, pitch, b = 1) {
    return { t, b, w, ld: Math.log(Math.max(1, dist)), yaw, pitch };
  }

  /** Roughly where the spider is at reading progress u (0..1) of section i. */
  function spiderAt(i, u) {
    const sec = analysis.sections[i];
    const a = sec.start + Math.min(Math.max(0, sec.count - 1), Math.floor(u * sec.count));
    return centroid(a, Math.min(sec.start + sec.count, a + 4)) || landing(i);
  }

  /**
   * The reading move for one section: establishing view, then sub-shots in
   * the recipe's order (u is reading progress 0..1), easing back out at the end.
   */
  function shotKeys(recipe, Ye, Pe, Ya, Pa, s, fit, estDist) {
    const E = makeKey(0, 0.3, estDist, Ye, Pe);
    if (recipe === 0)
      // Push in, then arc round to the new elevation.
      return [
        E,
        makeKey(0.16, 0.34, estDist * 0.97, Ye + s * 0.07, Pe),
        makeKey(0.5, 0.88, 0.7 * fit, Ye + s * 0.24, lerp(Pe, Pa, 0.2)),
        makeKey(0.84, 0.8, 0.85 * fit, Ya, Pa),
        makeKey(1, 0.5, 1.18 * fit, Ya + s * 0.12, lerp(Pa, Pe, 0.35)),
      ];
    if (recipe === 1)
      // A slow wide orbit to the new elevation first, then push in from there.
      return [
        E,
        makeKey(0.12, 0.34, estDist * 0.97, Ye + s * 0.06, Pe),
        makeKey(0.46, 0.55, 1.12 * fit, Ya, Pa),
        makeKey(0.8, 0.88, 0.7 * fit, Ya + s * 0.16, Pa),
        makeKey(1, 0.5, 1.15 * fit, Ya + s * 0.26, lerp(Pa, Pe, 0.3)),
      ];
    // Drift in close, rise or sink round it, then hang back a little.
    return [
      E,
      makeKey(0.3, 0.86, 0.72 * fit, Ye + s * 0.3, Pe),
      makeKey(0.62, 0.84, 0.8 * fit, Ya, Pa),
      makeKey(0.84, 0.72, 0.92 * fit, Ya + s * 0.18, lerp(Pa, Pe, 0.25)),
      makeKey(1, 0.5, 1.15 * fit, Ya + s * 0.28, lerp(Pa, Pe, 0.4)),
    ];
  }

  /**
   * Pre-visualise a keyed reading move on section i: where the camera would
   * really sit once kept clear of the balls, how much it loses its framing to
   * that, and what blocks its view. Lower is better.
   */
  function pathCost(i, keys) {
    const c = clusters[i];
    let cost = 0;
    let ref = -1;
    for (let k = 0; k <= 12; k++) {
      const u = k / 12;
      const q = sampleKeys(keys, u, key);
      const sp = spiderAt(i, u);
      const w = clamp(q.w, 0, 1);
      const x = lerp(c.cx, sp.x, w);
      const y = lerp(c.cy, sp.y, w);
      const z = lerp(c.cz, sp.z, w);
      orbitDir(q.yaw, q.pitch, dir);
      const want = Math.exp(q.ld);
      const dist = clearDistance(x, y, z, dir, want, clusters, 0.9, Math.max(110, want * 0.45), ref < 0 ? want : ref);
      ref = dist;
      cost += shotCost(x, y, z, dir, dist, clusters, [i]) + 0.8 * Math.abs(Math.log(dist / want));
    }
    return cost / 13;
  }

  /**
   * Plan section i: the leap into it (side-on to the arc, on whichever side
   * the camera already is), the establishing view, and a sequence of sub-shots
   * while it reads.
   */
  function planSection(i, from, goal) {
    const c = clusters[i];
    const sec = analysis.sections[i];
    const fit = fitR(c.r);
    const cam = run.camera;
    const estName = EST[i % EST.length];
    const Pe = ELEV[estName] + range(planRand, -0.06, 0.06);
    const opts = ARC_TO[estName];
    const jitter = range(planRand, -0.06, 0.06);

    let air = null;
    let turn = planRand() < 0.5 ? -1 : 1;
    let yawRef = cam.yaw;
    let moving = false; // the camera already has a direction of turn
    if (from) {
      // Pre-visualise the flight from nearby angles and keep the clearest,
      // preferring a side-on view of the arc and the smallest turn. The camera
      // passes this angle late in the flight, on one smooth turn from where the
      // last shot ended to the next establishing view.
      const tr = run.travel;
      const tm = tr.crouch + tr.air * 0.7;
      const tEnd = tr.dur + BREATH + TURN_U * readT[i];
      const line = lerp(cam.pitch, Pe, tm / tEnd);
      const leapYaw = Math.atan2(goal.x - from[0], goal.z - from[2]);
      const skip = [i, i - 1];
      let bestCost = Infinity;
      air = { yaw: cam.yaw, pitch: line, t: tm, end: tEnd };
      for (const pitch of [line, clamp(line + 0.2, -0.4, 1.0)]) {
        for (let k = -4; k <= 4; k++) {
          const y = cam.yaw + k * 0.15;
          const endOn = Math.abs(Math.cos(y - leapYaw)) * Math.cos(pitch);
          orbitDir(y, pitch, dir);
          let cost = 0.8 * Math.abs(y - cam.yaw) + 0.5 * endOn + 0.15 * Math.abs(pitch - line);
          let ref = -1;
          for (let n5 = 0; n5 <= 5; n5++) {
            const u = n5 / 5;
            const h = 4 * u * (1 - u) * tr.apex;
            const sp = { x: lerp(from[0], goal.x, u), y: lerp(from[1], goal.y, u) + h, z: lerp(from[2], goal.z, u) };
            airFrame(sp, goal, c);
            const dist = clearDistance(tgt.x, tgt.y, tgt.z, dir, tgt.dist, clusters, 0.9, tgt.dist * 0.45, ref < 0 ? tgt.dist : ref);
            ref = dist;
            cost += (shotCost(tgt.x, tgt.y, tgt.z, dir, dist, clusters, skip) + 0.8 * Math.abs(Math.log(dist / tgt.dist))) / 6;
          }
          if (cost < bestCost) {
            bestCost = cost;
            air = { yaw: y, pitch, t: tm, end: tEnd };
          }
        }
      }
      if (Math.abs(air.yaw - cam.yaw) > 0.05) {
        turn = Math.sign(air.yaw - cam.yaw);
        moving = true;
      }
      yawRef = air.yaw;
    }

    // Pre-visualise candidate moves (where the establishing view sits, which
    // way the arc swings, how far, to which elevation) and keep the one with
    // the clearest view of the spider all the way through, preferring to keep
    // turning the way the camera already is.
    const estDist = 1.45 * fit;
    const recipe = (lastRecipe + 1 + Math.floor(planRand() * 2)) % 3; // never the same twice running
    lastRecipe = recipe;
    const base = yawRef + turn * range(planRand, 0.1, 0.25);
    const calm = clamp((readT[i] - 3) / 6, 0.5, 1); // short reads get smaller moves, never faster ones
    let keys = null;
    let bestCost = Infinity;
    for (let k = -3; k <= 3; k++) {
      for (const sgn of [turn, -turn]) {
        for (const amt of [0.55 * calm, 0.8 * calm]) {
          for (const name of opts) {
            const Ye = base + k * 0.15;
            if (moving && turn * (Ye - yawRef) < -0.02) continue; // keep turning the same way, no wobble
            const Pa = Pe + clamp(ELEV[name] + jitter - Pe, -0.85 * calm, 0.85 * calm);
            const cand = shotKeys(recipe, Ye, Pe, Ye + sgn * amt, Pa, sgn, fit, estDist);
            const cost = pathCost(i, cand) + 0.3 * Math.abs(k * 0.15) + (sgn === turn ? 0 : 0.12) + 0.06 * planRand();
            if (cost < bestCost) {
              bestCost = cost;
              keys = cand;
            }
          }
        }
      }
    }
    const E = keys[0];
    plans[i] = { E, keys, air, T: readT[i], fit, turnKeys: null, walkT: 0 };
    if (air) {
      // The camera starts turning as the spider crouches (anticipation), is
      // side-on to the arc mid-flight, and arrives on the establishing view
      // just as reading begins: one unhurried turn across the whole leap.
      // It runs on a little into the reading so even a big change of
      // elevation stays slow.
      const ang = (t, yaw, pitch) => ({ t, b: 0, w: 0, ld: 0, yaw, pitch });
      const to = sampleKeys(keys, TURN_U, {});
      plans[i].turnKeys = [ang(0, cam.yaw, cam.pitch), ang(air.t, air.yaw, air.pitch), ang(air.end, to.yaw, to.pitch)];
    }
  }

  /** The finale: where the spider rests and the keys of the orbit and the closing drift. */
  function planShip() {
    const cam = run.camera;
    const turn = Math.abs(cam.v?.yaw || 0) > 0.01 ? Math.sign(cam.v.yaw) : planRand() < 0.5 ? -1 : 1;
    const startYaw = cam.yaw;
    const finalYaw = startYaw + turn * range(planRand, 2.0, 2.5);
    const D = [Math.sin(finalYaw), 0, Math.cos(finalYaw)];
    // Rest on the ball furthest out toward where the camera ends, so the rest of
    // the nebula lies behind the spider. Staying put is preferred when it is close.
    const last = clusters[Math.min(n - 1, run.silkSection)] || clusters[0];
    let best = last;
    let bestScore = -Infinity;
    for (const c of clusters) {
      const score = ((c.cx - B.x) * D[0] + (c.cz - B.z) * D[2]) / B.radius + (c === last ? 0.25 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const fitB = fitDistance(B.radius, aspect(), 50, 0.92);
    const pitchEnd = 0.24;
    const restDir = orbitDir(finalYaw, pitchEnd * 0.6, [0, 0, 0]);
    const rest = best ? { x: best.cx + restDir[0] * best.r * 0.5, y: best.cy + restDir[1] * best.r * 0.5, z: best.cz + restDir[2] * best.r * 0.5 } : { x: B.x, y: B.y, z: B.z };
    const closeDist = best ? fitR(best.r) * 1.25 : fitB;
    const keys = [
      // Pull back while it makes its last leap, keeping it near the middle...
      makeKey(0, 0.3, fitB * 1.02, startYaw + turn * 0.12, 0.34, 0),
      makeKey(3.6, 0.16, fitB * 1.04, startYaw + turn * 0.5, 0.42, 0),
      // ...orbit the whole nebula, rising over it...
      makeKey(8.6, 0.08, fitB * 0.98, startYaw + turn * 1.3, 0.74, 0),
      // ...then drift slowly in onto the spider, the nebula behind it.
      makeKey(12.6, 0.55, Math.sqrt(fitB * closeDist) * 1.05, finalYaw - turn * 0.25, 0.46, 0),
      makeKey(SHIP_SETTLE, 0.82, closeDist, finalYaw, pitchEnd, 0),
    ];
    ship = { keys, rest, cluster: best, turn };
  }

  /* --------------------------------------------------------------- reset */

  function reset() {
    run = createRunState(analysis);
    run.logSeq = 0;
    planRand = fork(seed, 'camera');
    cadence = fork(seed, 'cadence');
    plans = [];
    ship = null;
    lastRecipe = Math.floor(planRand() * 3);
    const c0 = clusters[0];
    // Start hanging high above the first ball; the opening is an abseil down into it.
    const start = c0 ? [c0.cx - c0.r * 0.35, c0.cy + c0.r * 1.75, c0.cz + c0.r * 0.2] : [0, 0, 0];
    spider = new Spider(start, seed, world);
    nextReach = 0;
    rate = 4;
    baseRate = 4;
    span = 1;
    burstLeft = 0;
    [run.spider.x, run.spider.y, run.spider.z] = spider.p;
    run.spiderGoal = { x: spider.p[0], y: spider.p[1], z: spider.p[2] };
    cursor = 0;
    readAcc = 0;
    recent = [];
    run.silk.push({ x: spider.p[0], y: spider.p[1], z: spider.p[2], s: 0, t: 0 });
    scoreTick = 0;

    // The opening: far out on the whole nebula from high up, then a long glide
    // in past the neighbouring balls toward the first one.
    const fitB = fitDistance(B.radius, aspect(), 50, 0.92);
    run.camera = { x: B.x, y: B.y, z: B.z, dist: fitB * 2.1, yaw: planRand() * PI * 2, pitch: 0.98 };
    intro = null;
    if (n && c0) {
      const goal = landing(0);
      planSection(0, null, goal);
      const p = plans[0];
      const E = p.E;
      const turn = planRand() < 0.5 ? -1 : 1;
      const y0 = E.yaw - turn * 1.3;
      run.camera.yaw = y0;
      const tEnd = BOOT + INTRO_AIR + LAND + INTRO_HOLD * 0.6;
      intro = [
        makeKey(0, 0, fitB * 2.1, y0, 0.98, 0),
        makeKey(tEnd * 0.4, 0.12, fitB * 1.25, lerp(y0, E.yaw, 0.45), 0.7, 0.55),
        makeKey(tEnd * 0.78, 0.38, p.fit * 1.75, lerp(y0, E.yaw, 0.88), lerp(0.7, E.pitch, 0.7), 1),
        { ...E, t: tEnd },
      ];
    }
  }

  function log(verb, text, section) {
    run.log.push({ clock: clock(), verb, text, section });
    if (run.log.length > LOG_CAP) run.log.shift();
    run.logSeq++;
  }

  /* -------------------------------------------------------------- camera */

  /** Turn a sampled key (base b: bounds 0 .. cluster 1, spider weight w) into a camera target. */
  function fromKey(k, c) {
    const s = run.spider;
    const b = clamp(k.b, 0, 1);
    const w = clamp(k.w, 0, 1);
    const bx = c ? lerp(B.x, c.cx, b) : B.x;
    const by = c ? lerp(B.y, c.cy, b) : B.y;
    const bz = c ? lerp(B.z, c.cz, b) : B.z;
    tgt.x = lerp(bx, s.x, w);
    tgt.y = lerp(by, s.y, w);
    tgt.z = lerp(bz, s.z, w);
    tgt.dist = Math.exp(k.ld);
    tgt.yaw = k.yaw;
    tgt.pitch = k.pitch;
    return tgt;
  }

  /**
   * Leap framing: look between the flying spider and the ball it is leaping
   * for, far enough back that both (and the legs streaming behind) are in shot.
   */
  function airFrame(s, g, c) {
    tgt.x = s.x * 0.5 + g.x * 0.25 + c.cx * 0.25;
    tgt.y = s.y * 0.5 + g.y * 0.25 + c.cy * 0.25;
    tgt.z = s.z * 0.5 + g.z * 0.25 + c.cz * 0.25;
    const reach = Math.hypot(s.x - c.cx, s.y - c.cy, s.z - c.cz);
    tgt.dist = fitDistance(Math.max(c.r * 0.9, reach * 0.6 + 70), aspect(), 50, 1.0);
    return tgt;
  }

  function cameraTarget() {
    const c = clusters[run.active];
    if (run.phase === 'ship' || !c) {
      if (!ship) return fromKey(makeKey(0, 0, fitDistance(B.radius, aspect(), 50, 0.92), run.camera.yaw, 0.4, 0), null);
      const k = sampleKeys(ship.keys, run.phaseT, key);
      // After it settles, keep breathing: a very slow drift on round.
      if (run.phaseT > SHIP_SETTLE) k.yaw += ship.turn * 0.012 * (run.phaseT - SHIP_SETTLE);
      return fromKey(k, ship.cluster);
    }
    const p = plans[run.active];
    if (run.phase === 'read') {
      const u = run.phaseT / p.T;
      fromKey(sampleKeys(p.keys, u, key), c);
      if (p.turnKeys && u < TURN_U) {
        // Still finishing the turn that began with the leap.
        const a = sampleKeys(p.turnKeys, p.walkT + run.phaseT, key);
        tgt.yaw = a.yaw;
        tgt.pitch = a.pitch;
      }
      return tgt;
    }
    if (run.active === 0 && intro) return fromKey(sampleKeys(intro, run.t, key), c);
    const tr = run.travel;
    // The angles turn smoothly from where the last shot ended, through the
    // side-on leap view, into the next establishing view (p.turnKeys).
    const a = p.turnKeys ? sampleKeys(p.turnKeys, run.phaseT, key) : p.E;
    const yaw = a.yaw;
    const pitch = a.pitch;
    if (p.air && tr && run.phaseT < tr.crouch + tr.air) {
      // Crouch and flight: frame the whole arc, the spider with its legs
      // streaming behind and the ball it is leaping for both in shot.
      airFrame(run.spider, run.spiderGoal, c);
    } else {
      // Landed: settle into the establishing view of the whole ball.
      fromKey(p.E, c);
    }
    tgt.yaw = yaw;
    tgt.pitch = pitch;
    return tgt;
  }

  /** Keep the target camera position out of every ball's dense core. */
  function keepClear(t) {
    orbitDir(t.yaw, t.pitch, dir);
    t.dist = clearDistance(t.x, t.y, t.z, dir, t.dist, clusters, 0.9, Math.max(110, t.dist * 0.45), run.camera.dist);
    return t;
  }

  function stepCamera(dt) {
    const t = keepClear(cameraTarget());
    // Spring smoothing (seconds): the keyframes carry the shape, the springs
    // round off every change so nothing lurches.
    if (run.phase === 'ship') followCamera(run.camera, t, dt, 1.3, 1.5);
    else if (run.active === 0 && run.phase !== 'read') followCamera(run.camera, t, dt, 0.7, 0.8);
    else if (run.phase === 'walk') followCamera(run.camera, t, dt, 0.85, 1.0);
    else followCamera(run.camera, t, dt, 0.8, 1.4);
    // Backstop: the springs may cut a corner through a ball between two clear
    // targets; ease the camera back out of any core it drifts into.
    const cam = run.camera;
    orbitDir(cam.yaw, cam.pitch, dir);
    const safe = clearDistance(cam.x, cam.y, cam.z, dir, cam.dist, clusters, 0.88, 90);
    if (safe !== cam.dist) cam.dist += (safe - cam.dist) * (1 - Math.exp(-10 * dt));
  }

  /* ---------------------------------------------------------- timeline */

  function setPhase(p) {
    run.phase = p;
    run.phaseT = 0;
  }

  function enterWalk(i) {
    const from = i > 0 ? [run.spider.x, run.spider.y, run.spider.z] : null;
    run.active = i;
    run.status[i] = 'reading';
    run.silkSection = i;
    const sec = analysis.sections[i];
    cursor = sec.start;
    readAcc = 0;
    setPhase('walk');
    log('walk', `→ ${sec.name}`, i);
    // Land on the ball where its first words hang.
    const goal = landing(i);
    run.spiderGoal = { x: goal.x, y: goal.y, z: goal.z };
    travelTo(run.spiderGoal, i);
    if (i > 0) planSection(i, from, goal);
  }

  /** Jump to a point: crouch, a floaty ballistic arc, landing (the spider follows run.travel). */
  function travelTo(goal, id) {
    const from = [run.spider.x, run.spider.y, run.spider.z];
    const to = [goal.x, goal.y, goal.z];
    const L = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1;
    const first = run.silk.length <= 1 && run.counts.read === 0;
    const crouch = first ? 0 : range(cadence, 0.4, 0.55);
    const air = first ? INTRO_AIR : airTime(L);
    run.travel = {
      id: `${id}:${run.t.toFixed(3)}`,
      from,
      to,
      t0: run.t,
      crouch,
      air,
      apex: first ? 16 : Math.max(60, L * range(cadence, 0.3, 0.4)),
      dur: crouch + air + LAND,
    };
  }

  function enterShip() {
    run.active = n;
    run.status.fill('done');
    setPhase('ship');
    planShip();
    if (!ship.cluster) return;
    const s = run.spider;
    const away = Math.hypot(s.x - ship.cluster.cx, s.y - ship.cluster.cy, s.z - ship.cluster.cz);
    run.spiderGoal = { ...ship.rest };
    // Leap across to the resting ball, or just stroll round to its outer face.
    if (away > ship.cluster.r * 1.1) travelTo(run.spiderGoal, 'ship');
  }

  function enterRead() {
    plans[run.active].walkT = run.phaseT;
    setPhase('read');
    const sec = analysis.sections[run.active];
    const T = plans[run.active].T;
    const reachTime = Math.max(1, T - TAIL - 0.4);
    span = Math.max(1, Math.ceil((sec.count * GAP) / reachTime / RATE_CAP));
    rate = Math.max(0.6, (Math.ceil(sec.count / span) * GAP) / reachTime);
    baseRate = rate;
    burstLeft = 0;
    readAcc = 0;
    // A beat to look before the first reach.
    nextReach = range(cadence, 0.25, 0.5);
  }

  function markRead(id) {
    const w = analysis.words[id];
    run.wordState[id] = 2;
    run.readAt[id] = run.t;
    run.readCount[w.section]++;
    const c = run.counts;
    c.read++;
    recent.push(run.t);
    if (w.vague) {
      c.flagged++;
      log('flag', w.text, w.section);
    } else if (w.kind) {
      c.linked++;
      if (w.guessed) c.guessed++;
      if (w.kind === 'claim') c.claims++;
      if (w.kind === 'owner') c.owners++;
      if (w.kind === 'approval') c.approvals++;
      log('link', w.text, w.section);
    } else {
      log('read', w.text, w.section);
    }
  }

  function stepTentacles(dt) {
    for (let i = run.tentacles.length - 1; i >= 0; i--) {
      const tn = run.tentacles[i];
      const age = run.t - tn.born;
      if (tn.stage === 'reach') {
        // Ease out: a quick throw that slows as it lands on the word.
        const u = Math.min(1, age / tn.reach);
        tn.p = 1 - (1 - u) * (1 - u);
        if (u >= 1) {
          tn.stage = 'hold';
          for (let k = 0; k < (tn.span || 1); k++) markRead(tn.wordId + k);
        }
      } else if (tn.stage === 'hold') {
        if (age > tn.reach + tn.hold) tn.stage = 'retract';
      } else {
        tn.p -= dt / tn.retract;
        if (tn.p <= 0) run.tentacles.splice(i, 1);
      }
    }
  }

  /**
   * Gap before the next reach: little flurries of quick reaches, then a
   * hesitation, like attention moving through the text (mean ~GAP / rate).
   * Between flurries the pace drifts a little so the section lands near its
   * planned time; a section of only a few words just spaces them out.
   */
  function nextGap() {
    const sec = analysis.sections[run.active];
    const after = Math.ceil(Math.max(0, sec.start + sec.count - cursor - span) / span);
    const budget = plans[run.active].T - TAIL - run.phaseT;
    if (sec.count / span < 8) return clamp(budget / (after + 0.5), 0.3, 3) * range(cadence, 0.75, 1.25);
    if (burstLeft > 0) {
      burstLeft--;
      return range(cadence, 0.22, 0.6) / rate;
    }
    burstLeft = Math.floor(range(cadence, 0, 4.999)); // 1-5 reaches in the next flurry
    if (after > 0 && budget > 0.6) rate = clamp(((after + 1) * GAP) / budget, baseRate * 0.7, baseRate * 1.5);
    return range(cadence, 1.6, 3.0) / rate;
  }

  function stepRead(dt) {
    const sec = analysis.sections[run.active];
    const end = sec.start + sec.count;
    readAcc += dt;
    while (readAcc >= nextReach && cursor < end) {
      const reaching = run.tentacles.reduce((k, tn) => k + (tn.stage !== 'retract' ? 1 : 0), 0);
      if (reaching >= MAX_TENTACLES) break;
      readAcc -= nextReach;
      nextReach = nextGap();
      const take = Math.min(span, end - cursor);
      for (let k = 0; k < take; k++) run.wordState[cursor + k] = 1;
      const hurry = clamp(8 / rate, 0.6, 1);
      run.tentacles.push({
        wordId: cursor,
        span: take,
        born: run.t,
        stage: 'reach',
        p: 0,
        reach: range(cadence, 0.28, 0.5) * Math.sqrt(hurry),
        hold: range(cadence, 0.45, 0.95) * hurry,
        retract: range(cadence, 0.3, 0.55),
      });
      cursor += take;
    }
    if (cursor >= end) readAcc = 0;
    const w = centroid(cursor, Math.min(end, cursor + 4));
    // Crawl over the ball toward the next words.
    if (w) run.spiderGoal = { x: w.x, y: w.y, z: w.z };
    const T = plans[run.active].T;
    // Leave once the words are read and the shot has eased back out.
    if (cursor >= end && run.tentacles.length === 0 && run.phaseT >= T - 0.25) {
      run.status[run.active] = 'done';
      if (run.active + 1 < n) enterWalk(run.active + 1);
      else enterShip();
    }
  }

  /** Advance the simulation by exactly one fixed step. */
  function step(dt = SIM_DT) {
    run.t += dt;
    run.frame++;
    run.phaseT += dt;

    if (run.phase === 'boot') {
      if (run.phaseT >= BOOT) {
        if (n) enterWalk(0);
        else enterShip();
      }
    } else if (run.phase === 'walk') {
      // Read once it has landed and taken a breath.
      const breath = run.active === 0 ? INTRO_HOLD : BREATH;
      if ((run.spider.arrived && run.phaseT > run.travel.dur + breath) || run.phaseT > run.travel.dur + breath + 2) enterRead();
    } else if (run.phase === 'read') {
      stepRead(dt);
    } else if (run.phase === 'ship' && run.phaseT > SHIP_SETTLE) {
      run.done = true;
    }

    stepTentacles(dt);
    spider.update(dt, run);

    while (recent.length && run.t - recent[0] > 1) recent.shift();
    run.wps = recent.length;
    run.score = computeScore(analysis, run.counts);
    scoreTick += dt;
    if (scoreTick >= 0.1) {
      scoreTick -= 0.1;
      run.scoreHistory.push(run.score);
      if (run.scoreHistory.length > 120) run.scoreHistory.shift();
    }
    const progress = total ? run.counts.read / total : 1;
    run.codeChars = Math.round(program.length * Math.min(1, 0.12 + 0.88 * progress));
    run.lps = run.phase === 'read' ? 15 : run.phase === 'ship' ? 0 : 7;

    stepCamera(dt);
  }

  /** Restart and fast-forward to sim time t. */
  function seek(t) {
    reset();
    const steps = Math.max(0, Math.round(t / SIM_DT));
    for (let i = 0; i < steps; i++) step();
  }

  /** Restart and fast-forward to the moment section i starts reading (i === n: the finished ship view). */
  function seekSection(i) {
    reset();
    let guard = 0;
    while (guard++ < 60 * 600) {
      if (i >= n ? run.done : run.active === i && run.phase === 'read') break;
      step();
    }
  }

  reset();
  return api;
}
