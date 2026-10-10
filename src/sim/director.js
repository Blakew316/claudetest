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
 *  - leaps: the camera starts turning during the crouch, frames the flight
 *    side-on (from the nearer side, unless a neighbouring ball blocks it) so
 *    the trailing legs and the next ball are both in shot, and settles into the
 *    next establishing view on landing, all on one slow turn;
 *  - finale: a rising orbit of the whole nebula, then a slow closing drift onto
 *    the spider resting on an outer ball with the nebula behind it.
 * Each move is pre-visualised against the world before it is used: the
 * camera never sits inside a ball's dense core, and angles are chosen for a
 * clear line of sight to the spider.
 *
 * Pacing: each section's read time grows with its word count (5-12.5 s), and
 * the whole run is held under ~4 minutes however long the prompt.
 *
 * Placement: the crawler lands, strolls and reads in the middle of each ball
 * (about a quarter of its radius out, round its heart), its words all round
 * it, and leaps on from there (see planRoutes).
 */

import { createRunState, MAX_TENTACLES, SIM_DT } from '../core/contracts.js';
import { computeScore } from '../analyze/score.js';
import { clearDistance, fitDistance, followCamera, orbitDir, sampleKeys, shotCost } from '../world/camera.js';
import { fork, range } from '../core/rng.js';
import { Spider } from '../world/spider.js';

const BOOT = 0.4;
const INTRO_AIR = 7.5; // the opening fly-in, while the spider wakes and walks on the first ball
const INTRO_HOLD = 1.0; // breath on the first ball before reading starts
const BREATH = 0.8; // after a landing, before the first reach
const LAND = 0.36; // the spider's landing absorb (spider.js LAND_TIME)
const SHIP_SETTLE = 22; // the finale: orbit the nebula, then drift onto the spider
const TAIL = 1.5; // last reach + hold + retract after the final word
const GAP = 1.04; // mean gap between reaches, in units of 1/rate (see nextGap)
const RATE_CAP = 11; // reaches per second at most; denser sections read a phrase per reach
const RUN_BUDGET = 300; // seconds: even a 1500-word, 12-section prompt finishes under ~5 min
const MIN_READ = 7;
const MAX_READ = 18;
const LOG_CAP = 40;
// Between sections the spider also leaps through the extra (no-word) balls:
// it lands inside, on the side facing where it came from, and crosses toward
// the side facing where it goes next, for at most VISIT_CRAWL seconds.
const VISIT_CRAWL = 3.5;
const VISIT_EASE = 1.4; // the camera eases back out this long before the next leap
const VISIT_DIST = 0.7; // of the ball's fit distance, once landed
const VISIT_TURN = 0.16; // rad/s round it
const TURN_U = 0.12; // the leap's camera turn finishes this far into the reading
const LEAP_TURN = 1.1; // rad/s: the turn to the side-on leap view averages no faster than this
// While the spider crawls through a ball the camera comes in close and keeps
// revolving round it (rising and dipping once), so the stardust slides past in
// depth; it eases back out to the keyed wide view before the leap.
const ORBIT_U = [0.08, 0.92]; // reading-progress window of the close orbit
const ORBIT_RATE = 0.16; // rad/s round the spider
const ORBIT_DIST = 0.7; // of the ball's fit distance
const PI = Math.PI;
const ROAM_SPEED = 13; // world units/s it averages over a read, pauses included: a stroll, stopping often to fire
// He reads from the middle of each ball, the stars all round him, not from its
// rim: he lands, strolls and leaves about a quarter of its radius out (in the
// dense half of its stars), circling its heart but out of the blinding nucleus.
const LAND_IN = 0.24; // lands this far out from the middle, toward the section's first words
const EXIT_IN = 0.26; // leaves from this far out, on the side facing where it leaps next
const RING = [0.15, 0.28]; // strolls round the middle this far out (radii)
const VISIT_IN = 0.3; // crosses the extra balls this far in
const REST_IN = 0.32; // and rests this far in for the finale
const WAY = 0.2; // a waypoint every this much of the stroll (radii): a few strides apart
const SLOPE = 0.2; // rise over run at most: he walks, he does not climb
const ROAM_REACH = 0.1; // the goal moves on to the next waypoint once it is this close (radii)
const ZOOM_MAX = 1.0; // camera zoom rate cap, log distance per second (~1.7% a frame)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => x * x * (3 - 2 * x);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Planned read time for a section (s): longer sections linger, within limits. */
const readSeconds = (count) => (count ? clamp(5.5 + 1.5 * Math.sqrt(count), MIN_READ, MAX_READ) : 2.5);
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
    'spider = Crawler(legs=8, tentacles=22)',
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
  const visits = planVisits();
  const readT = planReadTimes();
  const routes = planRoutes();

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
  let roamIdx; // next waypoint of the active section's route
  let visitQueue; // extra balls still to visit before the next section
  let visit; // the extra ball being visited: { c, land, exit, crawl, t0, yaw0, pitch0, spin }
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

  /**
   * The point k radii out from the middle of ball c toward P (heights
   * flattened, so it stays near the ball's waist), or P itself if nearer.
   */
  function toward(c, P, k) {
    if (!P) return { x: c.cx, y: c.cy, z: c.cz };
    const dx = P.x - c.cx;
    const dy = (P.y - c.cy) * 0.6;
    const dz = P.z - c.cz;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return { x: c.cx, y: c.cy, z: c.cz + k * c.r }; // no side to favour (a section with no words): any, but not the nucleus
    const s = Math.min(l, k * c.r) / l;
    return { x: c.cx + dx * s, y: c.cy + dy * s, z: c.cz + dz * s };
  }

  /** Where section i's first words hang (the middle of its ball if it has none). */
  function firstWords(i) {
    const sec = analysis.sections[i];
    const c = clusters[i];
    return centroid(sec.start, Math.min(sec.start + 6, sec.start + sec.count)) || { x: c.cx, y: c.cy, z: c.cz };
  }

  /** Where the spider lands on section i: well inside the ball, on the side its first words hang. */
  function landing(i) {
    return toward(clusters[i], firstWords(i), LAND_IN);
  }

  /** Where section i's last words hang. */
  function leaving(i) {
    const a = analysis.sections[i];
    return centroid(Math.max(a.start, a.start + a.count - 4), a.start + a.count) || { x: clusters[i].cx, y: clusters[i].cy, z: clusters[i].cz };
  }

  /** Where the leg after section i heads: the next section's first words, or the middle for the finale. */
  function legEnd(i) {
    return i + 1 < n ? firstWords(i + 1) : { x: B.x, y: B.y, z: B.z };
  }

  /**
   * Assign every extra ball to the gap after a section where it is the
   * smallest detour (gaps already holding one cost more, so they spread
   * out), and order each gap's balls along the way.
   */
  function planVisits() {
    const gaps = Array.from({ length: n }, () => []);
    if (!n) return gaps;
    const d = (P, c) => Math.hypot(P.x - c.cx, P.y - c.cy, P.z - c.cz);
    for (const c of clusters) {
      if (!c.extra) continue;
      let best = 0;
      let bestCost = Infinity;
      for (let i = 0; i < n; i++) {
        const A = leaving(i);
        const E = legEnd(i);
        const cost = d(A, c) + d(E, c) - Math.hypot(E.x - A.x, E.y - A.y, E.z - A.z) + gaps[i].length * 260;
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      }
      gaps[best].push(c);
    }
    gaps.forEach((g, i) => {
      const A = leaving(i);
      g.sort((p, q) => d(A, p) - d(A, q));
    });
    return gaps;
  }

  /**
   * Each read is a stroll round the heart of its ball: from where it lands,
   * curving round the middle (whichever way round suits the read's length and
   * carries on the way it came in, swinging in or out a little), level but for
   * a gentle rise or fall, to the side facing where it goes next. No sharp
   * turns and nothing steep: he walks it.
   */
  function planRoutes() {
    return analysis.sections.map((sec, i) => {
      const c = clusters[i];
      const rand = fork(seed, `roam:${i}`);
      const start = landing(i);
      const nx = visits[i][0];
      const exit = toward(c, nx ? { x: nx.cx, y: nx.cy, z: nx.cz } : legEnd(i), EXIT_IN);
      const want = ROAM_SPEED * readT[i] * 0.8;
      const lo = RING[0] * c.r;
      const hi = RING[1] * c.r;
      // Round the middle, seen from above: where it lands and where it leaves.
      const a0 = Math.atan2(start.z - c.cz, start.x - c.cx);
      const a1 = Math.atan2(exit.z - c.cz, exit.x - c.cx);
      const rs = clamp(Math.hypot(start.x - c.cx, start.z - c.cz), lo, hi);
      const re = clamp(Math.hypot(exit.x - c.cx, exit.z - c.cz), lo, hi);
      // The way it was leaping as it came in, from the previous ball.
      const from = i > 0 ? visits[i - 1][visits[i - 1].length - 1] || clusters[i - 1] : null;
      const inX = from ? start.x - from.cx : 0;
      const inZ = from ? start.z - from.cz : 0;
      const inL = Math.hypot(inX, inZ) || 1;
      const short = wrap(a1 - a0);
      let best = null;
      for (const sweep of [short, short - (short < 0 ? -1 : 1) * 2 * PI]) {
        // Swing in or out so the way round is about as long as the read wants.
        const mid = (rs + re) / 2;
        const bulge = clamp(((want / Math.max(0.2, Math.abs(sweep)) - mid) * PI) / 2, lo - mid, hi - mid);
        const len = Math.abs(sweep) * (mid + (2 / PI) * bulge);
        // How well setting off round this way carries on from the leap in (1: straight on).
        const along = ((sweep < 0 ? -1 : 1) * (Math.cos(a0) * inZ - Math.sin(a0) * inX)) / inL;
        // Too short leaves him standing about; too long only means he leaves from partway round.
        const cost = (1.5 * Math.max(0, want - len) + 0.4 * Math.max(0, len - want)) / want + 0.1 * (1 - along) + 0.05 * rand();
        if (!best || cost < best.cost) best = { sweep, bulge, len, cost };
      }
      const K = Math.max(2, Math.round(best.len / (WAY * c.r)));
      const ph = rand() * PI * 2;
      const route = [start];
      for (let k = 1; k < K; k++) {
        const f = k / K;
        const a = a0 + best.sweep * f;
        const rr = clamp(lerp(rs, re, f) + best.bulge * Math.sin(PI * f) + c.r * 0.025 * Math.sin(3 * PI * f + ph), lo, hi);
        const x = c.cx + Math.cos(a) * rr;
        const z = c.cz + Math.sin(a) * rr;
        // Level, drifting gently toward the exit's height, never steeper than SLOPE.
        const prev = route[route.length - 1];
        const run = Math.hypot(x - prev.x, z - prev.z);
        const y = prev.y + clamp(lerp(start.y, exit.y, f) + c.r * 0.04 * Math.sin(2 * PI * f + ph) - prev.y, -SLOPE * run, SLOPE * run);
        route.push({ x, y, z });
      }
      // ...and no steeper into the exit.
      const last = route[route.length - 1];
      const run = Math.hypot(exit.x - last.x, exit.z - last.z);
      exit.y = last.y + clamp(exit.y - last.y, -SLOPE * run, SLOPE * run);
      route.push(exit);
      return route;
    });
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
    for (const g of visits) fixed += g.length * (0.48 + airTime(400) + LAND + 0.3 + VISIT_CRAWL + VISIT_EASE);
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
    const route = routes[i];
    let left = ROAM_SPEED * readT[i] * clamp(u, 0, 1);
    for (let k = 1; k < route.length; k++) {
      const a = route[k - 1];
      const b = route[k];
      const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (left <= L) {
        const t = L > 0 ? left / L : 0;
        return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
      }
      left -= L;
    }
    return route[route.length - 1];
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
        makeKey(1, 0.5, 0.95 * fit, Ya + s * 0.12, lerp(Pa, Pe, 0.35)),
      ];
    if (recipe === 1)
      // A slow wide orbit to the new elevation first, then push in from there.
      return [
        E,
        makeKey(0.12, 0.34, estDist * 0.97, Ye + s * 0.06, Pe),
        makeKey(0.46, 0.55, 0.92 * fit, Ya, Pa),
        makeKey(0.8, 0.88, 0.7 * fit, Ya + s * 0.16, Pa),
        makeKey(1, 0.5, 0.95 * fit, Ya + s * 0.26, lerp(Pa, Pe, 0.3)),
      ];
    // Drift in close, rise or sink round it, then hang back a little.
    return [
      E,
      makeKey(0.3, 0.86, 0.72 * fit, Ye + s * 0.3, Pe),
      makeKey(0.62, 0.84, 0.8 * fit, Ya, Pa),
      makeKey(0.84, 0.72, 0.92 * fit, Ya + s * 0.18, lerp(Pa, Pe, 0.25)),
      makeKey(1, 0.5, 0.95 * fit, Ya + s * 0.28, lerp(Pa, Pe, 0.4)),
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
      const tm = tr.crouch + tr.air * 0.08;
      const tEnd = tr.dur + BREATH + TURN_U * readT[i];
      const line = lerp(cam.pitch, Pe, tm / tEnd);
      const leapYaw = Math.atan2(goal.x - from[0], goal.z - from[2]);
      const skip = [i, i - 1];
      const flightCost = (y, pitch) => leapCost(from, goal, tr.apex, c, y, pitch, skip);
      let bestCost = Infinity;
      air = { yaw: cam.yaw, pitch: line, t: tm, hold: tr.crouch + tr.air + 0.25, end: tEnd };
      for (const pitch of [line, clamp(line + 0.2, -0.4, 1.0)]) {
        for (let k = -4; k <= 4; k++) {
          const y = cam.yaw + k * 0.15;
          const endOn = Math.abs(Math.cos(y - leapYaw)) * Math.cos(pitch);
          const cost = 0.8 * Math.abs(y - cam.yaw) + 0.5 * endOn + 0.15 * Math.abs(pitch - line) + flightCost(y, pitch);
          if (cost < bestCost) {
            bestCost = cost;
            air = { yaw: y, pitch, t: tm, hold: tr.crouch + tr.air + 0.25, end: tEnd };
          }
        }
      }
      if (Math.abs(air.yaw - cam.yaw) > 0.05) {
        turn = Math.sign(air.yaw - cam.yaw);
        moving = true;
      }
      // Whatever was clearest, watch the leap itself side-on and low, so the arc
      // reads: from the nearer side, unless the other sees it far more clearly
      // (leaping out of the middle of one ball into the middle of the next, a
      // neighbouring ball can stand right in the way of one side).
      let side = 0;
      let sideCost = Infinity;
      for (const off of [PI / 2, -PI / 2]) {
        const d = wrap(leapYaw + off - cam.yaw);
        const cost = 0.4 * Math.abs(d) + flightCost(cam.yaw + d, 0.12);
        if (cost < sideCost) {
          sideCost = cost;
          side = d;
        }
      }
      air.yaw = cam.yaw + side;
      air.pitch = 0.12;
      // A big turn takes longer (later into the flight), so it never whips round.
      air.t = Math.min(Math.max(air.t, Math.abs(side) / LEAP_TURN), air.hold - 0.3);
      yawRef = air.yaw;
    }

    // Pre-visualise candidate moves (where the establishing view sits, which
    // way the arc swings, how far, to which elevation) and keep the one with
    // the clearest view of the spider all the way through, preferring to keep
    // turning the way the camera already is.
    const estDist = 1.0 * fit;
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
    plans[i] = { E, keys, air, T: readT[i], fit, turnKeys: null, walkT: 0, ...chooseOrbit(i, keys, fit, readT[i], turn) };
    if (air) {
      // The camera starts turning as the spider crouches (anticipation), is
      // side-on to the arc mid-flight, and arrives on the establishing view
      // just as reading begins: one unhurried turn across the whole leap.
      // It runs on a little into the reading so even a big change of
      // elevation stays slow.
      const ang = (t, yaw, pitch) => ({ t, b: 0, w: 0, ld: 0, yaw, pitch });
      const to = sampleKeys(keys, TURN_U, {});
      // Side-on is held through the whole flight; the move to the next view starts after touchdown.
      plans[i].turnKeys = [ang(0, cam.yaw, cam.pitch), ang(air.t, air.yaw, air.pitch), ang(Math.min(air.hold, air.end - 0.3), air.yaw, air.pitch), ang(air.end, to.yaw, to.pitch)];
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
    const rest = best ? { x: best.cx + restDir[0] * best.r * REST_IN, y: best.cy + restDir[1] * best.r * REST_IN, z: best.cz + restDir[2] * best.r * REST_IN } : { x: B.x, y: B.y, z: B.z };
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
    visitQueue = [];
    visit = null;
    run.visit = null;
    run.logSeq = 0;
    planRand = fork(seed, 'camera');
    cadence = fork(seed, 'cadence');
    plans = [];
    ship = null;
    lastRecipe = Math.floor(planRand() * 3);
    const c0 = clusters[0];
    // Start inside the first ball, a short walk from its first words; it wakes
    // and walks over to them while the camera flies in.
    const w0 = n && c0 ? landing(0) : null;
    const start = w0 ? [lerp(w0.x, c0.cx, 0.2), lerp(w0.y, c0.cy, 0.2), lerp(w0.z, c0.cz, 0.2)] : [0, 0, 0];
    spider = new Spider(start, seed, world);
    run.spider.arrived = true;
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

    // The opening: already close on the first ball, looking down past the
    // spider, then a slow glide round and in to the first reading view.
    const fitB = fitDistance(B.radius, aspect(), 50, 0.92);
    run.camera = { x: B.x, y: B.y, z: B.z, dist: fitB * 2.1, yaw: planRand() * PI * 2, pitch: 0.98 };
    intro = null;
    if (n && c0) {
      const goal = landing(0);
      planSection(0, null, goal);
      const p = plans[0];
      const E = p.E;
      const turn = planRand() < 0.5 ? -1 : 1;
      const y0 = E.yaw - turn * 0.9;
      const tEnd = BOOT + INTRO_AIR + LAND + INTRO_HOLD * 0.6;
      intro = [
        makeKey(0, 0.55, p.fit * 1.3, y0, 0.85, 1),
        makeKey(tEnd * 0.5, 0.6, p.fit * 1.0, lerp(y0, E.yaw, 0.55), lerp(0.85, E.pitch, 0.5), 1),
        { ...E, t: tEnd },
      ];
      const s0 = run.spider;
      run.camera = { x: lerp(c0.cx, s0.x, 0.55), y: lerp(c0.cy, s0.y, 0.55), z: lerp(c0.cz, s0.z, 0.55), dist: p.fit * 1.3, yaw: y0, pitch: 0.85 };
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

  /**
   * Pre-visualise a leap (from, to goal over an arc of height apex, into ball
   * c) as framed from (yaw, pitch): what blocks it, and how far the camera
   * would be pushed out of its framing to see past the balls. Lower is better.
   */
  function leapCost(from, goal, apex, c, yaw, pitch, skip) {
    orbitDir(yaw, pitch, dir);
    let cost = 0;
    let ref = -1;
    for (let k = 0; k <= 5; k++) {
      const u = k / 5;
      const h = 4 * u * (1 - u) * apex;
      airFrame({ x: lerp(from[0], goal.x, u), y: lerp(from[1], goal.y, u) + h, z: lerp(from[2], goal.z, u) }, goal, c);
      const dist = clearDistance(tgt.x, tgt.y, tgt.z, dir, tgt.dist, clusters, 0.9, tgt.dist * 0.45, ref < 0 ? tgt.dist : ref);
      ref = dist;
      cost += (shotCost(tgt.x, tgt.y, tgt.z, dir, dist, clusters, skip) + 0.8 * Math.abs(Math.log(dist / tgt.dist))) / 6;
    }
    return cost;
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
    if (run.phase === 'visit') return visitFrame();
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
      // The close orbit round the crawling spider (pre-checked in chooseOrbit).
      // The extra turn only ever grows, so the pan never reverses; the pull in
      // eases off at the end of the window.
      return applyOrbit(tgt, run.active, u, p.spin, p.orbitRate, p.T, run.spider, p.fit, p.orbitNear);
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

  /** Weight of the close orbit at orbit progress v (0..1): eases in and out. */
  function orbitWeight(v) {
    return smooth(clamp(v / 0.25, 0, 1)) * (1 - smooth(clamp((v - 0.75) / 0.25, 0, 1)));
  }

  /** Close-orbit target for section i at reading progress u, written over a keyed target t. */
  function applyOrbit(t, i, u, spin, rate, T, sp, fit, near = ORBIT_DIST) {
    if (!near) return t;
    const c = clusters[i];
    const v = clamp((u - ORBIT_U[0]) / (ORBIT_U[1] - ORBIT_U[0]), 0, 1);
    const ow = orbitWeight(v);
    t.x = lerp(t.x, lerp(c.cx, sp.x, 0.9), ow);
    t.y = lerp(t.y, lerp(c.cy, sp.y, 0.9), ow);
    t.z = lerp(t.z, lerp(c.cz, sp.z, 0.9), ow);
    t.dist = lerp(t.dist, fit * near, ow);
    t.yaw += spin * rate * T * (ORBIT_U[1] - ORBIT_U[0]) * smooth(v);
    t.pitch = clamp(t.pitch + ow * 0.3 * Math.sin(2 * PI * v), -0.5, 1.25);
    return t;
  }

  /**
   * Pre-visualise the close orbit on section i: which way round and how far
   * it can turn without the camera passing through another ball (or deep
   * into this one). Prefers the full orbit the same way as the keyed arc.
   */
  function chooseOrbit(i, keys, fit, T, turn) {
    const c = clusters[i];
    const base = Math.sign(keys[keys.length - 1].yaw - keys[0].yaw) || turn;
    let best = { spin: base, orbitRate: 0, orbitNear: ORBIT_DIST };
    let bestCost = Infinity;
    const probe = { x: 0, y: 0, z: 0, dist: 0, yaw: 0, pitch: 0 };
    const pos = [0, 0, 0];
    for (const near of [ORBIT_DIST, ORBIT_DIST * 1.25, ORBIT_DIST * 0.8])
    for (const spin of [base, -base]) {
      for (const rate of [ORBIT_RATE, ORBIT_RATE * 0.6, ORBIT_RATE * 0.3]) {
        let cost = (spin === base ? 0 : 0.3) + (ORBIT_RATE - rate) * 3 + Math.abs(near - ORBIT_DIST);
        for (let k = 0; k <= 16; k++) {
          const u = lerp(ORBIT_U[0], ORBIT_U[1], k / 16);
          const ky = sampleKeys(keys, u, key);
          const sp = spiderAt(i, u);
          probe.x = lerp(c.cx, sp.x, ky.w);
          probe.y = lerp(c.cy, sp.y, ky.w);
          probe.z = lerp(c.cz, sp.z, ky.w);
          probe.dist = Math.exp(ky.ld);
          probe.yaw = ky.yaw;
          probe.pitch = ky.pitch;
          applyOrbit(probe, i, u, spin, rate, T, sp, fit, near);
          orbitDir(probe.yaw, probe.pitch, pos);
          const x = probe.x + pos[0] * probe.dist;
          const y = probe.y + pos[1] * probe.dist;
          const z = probe.z + pos[2] * probe.dist;
          for (const o of clusters) {
            const d = Math.hypot(x - o.cx, y - o.cy, z - o.cz);
            if (o !== c && !o.extra && d < o.r * 0.95) cost += 1;
            else if (o === c && d < o.r * 0.6) cost += 0.5;
          }
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = { spin, orbitRate: rate, orbitNear: near };
        }
      }
    }
    if (bestCost >= 2) best.orbitNear = 0; // boxed in: no close orbit, keep to the keyed moves
    return best;
  }

  /**
   * Camera through a visit: in the air it frames the spider and the ball it
   * is leaping for; once it lands it closes in and circles it over the ball.
   * The angles keep turning the way they were, easing to a three-quarter view.
   */
  function visitFrame() {
    const c = visit.c;
    const s = run.spider;
    const tr = run.travel;
    if (tr && run.phaseT < tr.crouch + tr.air) airFrame(s, run.spiderGoal, c);
    else {
      tgt.x = lerp(c.cx, s.x, 0.8);
      tgt.y = lerp(c.cy, s.y, 0.8);
      tgt.z = lerp(c.cz, s.z, 0.8);
      const out = visit.leaveAt ? smooth(clamp(1 - (visit.leaveAt - run.phaseT) / VISIT_EASE, 0, 1)) : 0;
      tgt.dist = fitR(c.r) * lerp(VISIT_DIST, 1.0, out);
    }
    // Low and side-on through the leap; once landed, rise into a slow circle round it.
    const flown = tr ? tr.crouch + tr.air : 0;
    const since = Math.max(0, run.phaseT - flown);
    tgt.yaw = visit.yaw0 + visit.spin * VISIT_TURN * since;
    const airPitch = lerp(visit.pitch0, 0.18, smooth(clamp(run.phaseT / 1.2, 0, 1)));
    tgt.pitch = lerp(airPitch, 0.42 + 0.16 * Math.sin(since * 0.5), smooth(clamp(since / 2, 0, 1)));
    return tgt;
  }

  /** Keep the target camera position out of every ball's dense core. */
  function keepClear(t) {
    orbitDir(t.yaw, t.pitch, dir);
    t.dist = clearDistance(t.x, t.y, t.z, dir, t.dist, clusters, 0.9, Math.max(110, t.dist * 0.45), run.camera.dist);
    return t;
  }

  function stepCamera(dt) {
    const d0 = run.camera.dist;
    const t = keepClear(cameraTarget());
    // The springs lag the target's angles (always, in an orbit), so clear the
    // target distance along the camera's actual direction too; otherwise the
    // spring steers it into a core and the backstop shoves it out, every frame.
    const cam0 = run.camera;
    orbitDir(cam0.yaw, cam0.pitch, dir);
    t.dist = clearDistance(cam0.x, cam0.y, cam0.z, dir, t.dist, clusters, 0.9, Math.max(90, t.dist * 0.45), cam0.dist);
    // Spring smoothing (seconds): the keyframes carry the shape, the springs
    // round off every change so nothing lurches.
    if (run.phase === 'ship') followCamera(run.camera, t, dt, 1.3, 1.5);
    else if (run.active === 0 && run.phase !== 'read') followCamera(run.camera, t, dt, 0.7, 0.8);
    else if (run.phase === 'walk') followCamera(run.camera, t, dt, 0.85, 0.7);
    else if (run.phase === 'visit') followCamera(run.camera, t, dt, 0.85, 1.0);
    else followCamera(run.camera, t, dt, 0.8, 1.4);
    // Backstop for corners the springs cut through a ball: only ever outward,
    // and gently, so it can't fight the springs.
    const cam = run.camera;
    orbitDir(cam.yaw, cam.pitch, dir);
    const safe = clearDistance(cam.x, cam.y, cam.z, dir, cam.dist, clusters, 0.85, cam.dist);
    if (safe > cam.dist) cam.dist += (safe - cam.dist) * (1 - Math.exp(-3 * dt));
    // Never zoom faster than ZOOM_MAX (log distance per second), whatever the
    // geometry asks for: a blocked shot that suddenly clears must not lurch.
    const step = Math.log(cam.dist / d0);
    if (Math.abs(step) > ZOOM_MAX * dt) {
      cam.dist = d0 * Math.exp(Math.sign(step) * ZOOM_MAX * dt);
      if (cam.v) cam.v.dist = clamp(cam.v.dist, -ZOOM_MAX, ZOOM_MAX);
    }
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
    // The first ball: it is already there, so it walks over instead of leaping.
    if (i > 0) {
      travelTo(run.spiderGoal, i);
      planSection(i, from, goal);
    }
  }

  /** Jump to a point: crouch, a floaty ballistic arc, landing (the spider follows run.travel). */
  function travelTo(goal, id) {
    const from = [run.spider.x, run.spider.y, run.spider.z];
    const to = [goal.x, goal.y, goal.z];
    const L = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1;
    const first = run.silk.length <= 1 && run.counts.read === 0;
    // A jumping spider turns to face its target before it leaps: time for that
    // quick pivot, from how far round it has to turn.
    const hF = spider.sim.hF;
    const turn = Math.atan2(to[2] - from[2], to[0] - from[0]) - Math.atan2(hF[2], hF[0]);
    const off = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
    const aim = first || Math.hypot(to[0] - from[0], to[2] - from[2]) < 2 || off < 0.25 ? 0 : 0.3 + (0.55 * off) / Math.PI;
    const crouch = first ? 0 : aim + range(cadence, 0.4, 0.55);
    const air = first ? INTRO_AIR : airTime(L);
    run.travel = {
      id: `${id}:${run.t.toFixed(3)}`,
      from,
      to,
      t0: run.t,
      crouch,
      aim,
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
    // Leap across to the resting ball, or just stroll over to where it rests in it.
    if (away > ship.cluster.r * 1.1) travelTo(run.spiderGoal, 'ship');
  }

  function enterRead() {
    plans[run.active].walkT = run.phaseT;
    setPhase('read');
    roamIdx = 1;
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
    // Walk the ball along its route, reaching for the words as it goes.
    const route = routes[run.active];
    const s = run.spider;
    const g = route[Math.min(roamIdx, route.length - 1)];
    if (roamIdx < route.length - 1 && Math.hypot(s.x - g.x, s.y - g.y, s.z - g.z) < ROAM_REACH * clusters[run.active].r) roamIdx++;
    const goal = route[Math.min(roamIdx, route.length - 1)];
    run.spiderGoal = { x: goal.x, y: goal.y, z: goal.z };
    const T = plans[run.active].T;
    // Leave once the words are read and the shot has eased back out.
    if (cursor >= end && run.tentacles.length === 0 && run.phaseT >= T - 0.25) {
      run.status[run.active] = 'done';
      visitQueue = visits[run.active].slice();
      nextLeg();
    }
  }

  /** After a read: the next extra ball to leap through, else the next section, else the finale. */
  function nextLeg() {
    if (visitQueue.length) enterVisit(visitQueue.shift());
    else if (run.active + 1 < n) enterWalk(run.active + 1);
    else enterShip();
  }

  /** A point inside ball c, well in from its rim, on the side facing P. */
  function sideFacing(c, P) {
    return toward(c, P, VISIT_IN);
  }

  function enterVisit(c) {
    setPhase('visit');
    const nx = visitQueue[0];
    const next = nx ? { x: nx.cx, y: nx.cy, z: nx.cz } : legEnd(run.active);
    const cam = run.camera;
    const sp = run.spider;
    const land = sideFacing(c, sp);
    run.visit = { cluster: c.index };
    run.spiderGoal = { ...land };
    travelTo(run.spiderGoal, `x${c.index}`);
    // Watch the leap side-on, turning at most 1.1 rad: from the nearer side,
    // unless the other sees the flight far more clearly.
    const tr = run.travel;
    const leapYaw = Math.atan2(land.x - sp.x, land.z - sp.z);
    const a = clusters[run.active];
    const skip = a && Math.hypot(sp.x - a.cx, sp.y - a.cy, sp.z - a.cz) < a.r ? [a.index] : [];
    let airYaw = cam.yaw;
    let bestCost = Infinity;
    for (const side of [PI / 2, -PI / 2]) {
      const d = clamp(wrap(leapYaw + side - cam.yaw), -1.1, 1.1);
      const cost = 0.4 * Math.abs(d) + leapCost(tr.from, land, tr.apex, c, cam.yaw + d, 0.18, skip);
      if (cost < bestCost) {
        bestCost = cost;
        airYaw = cam.yaw + d;
      }
    }
    visit = {
      c,
      land,
      exit: sideFacing(c, next),
      crawl: false,
      t0: 0,
      leaveAt: 0,
      yaw0: airYaw,
      pitch0: cam.pitch,
      spin: 0,
    };
    visit.spin = visitSpin(c, visit.land, airYaw, Math.abs(cam.v?.yaw || 0) > 0.01 ? Math.sign(cam.v.yaw) : 1);
  }

  /**
   * Which way to circle a visited ball (preferring the way the camera already
   * turns) so the camera stays clear of every section ball; 0 if neither is.
   */
  function visitSpin(c, land, yaw0, prefer) {
    const fit = fitR(c.r);
    const pos = [0, 0, 0];
    let best = 0;
    let bestCost = Infinity;
    for (const spin of [prefer, -prefer]) {
      let cost = spin === prefer ? 0 : 0.2;
      for (let k = 0; k <= 10; k++) {
        const yaw = yaw0 + spin * VISIT_TURN * (k / 10) * (VISIT_CRAWL + 2);
        orbitDir(yaw, 0.42, pos);
        const x = lerp(c.cx, land.x, 0.8) + pos[0] * fit * VISIT_DIST;
        const y = lerp(c.cy, land.y, 0.8) + pos[1] * fit * VISIT_DIST;
        const z = lerp(c.cz, land.z, 0.8) + pos[2] * fit * VISIT_DIST;
        for (const o of clusters) if (!o.extra && Math.hypot(x - o.cx, y - o.cy, z - o.cz) < o.r * 0.95) cost += 1;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = spin;
      }
    }
    return bestCost >= 2 ? 0 : best;
  }

  function stepVisit() {
    const tr = run.travel;
    if (!visit.crawl && ((run.spider.arrived && run.phaseT > tr.dur + 0.3) || run.phaseT > tr.dur + 3)) {
      // Landed: crawl over the ball toward where it leaps next.
      visit.crawl = true;
      visit.t0 = run.phaseT;
      run.spiderGoal = { ...visit.exit };
    }
    if (!visit.crawl) return;
    const s = run.spider;
    const e = visit.exit;
    // Across (or out of time): a beat while the camera eases back out, then leap on.
    if (!visit.leaveAt && (Math.hypot(s.x - e.x, s.y - e.y, s.z - e.z) < 8 || run.phaseT - visit.t0 > VISIT_CRAWL)) visit.leaveAt = run.phaseT + VISIT_EASE;
    if (visit.leaveAt && run.phaseT >= visit.leaveAt) {
      run.visit = null;
      nextLeg();
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
      const dur = run.active === 0 ? INTRO_AIR + LAND : run.travel.dur;
      if ((run.spider.arrived && run.phaseT > dur + breath) || run.phaseT > dur + breath + 2) enterRead();
    } else if (run.phase === 'read') {
      stepRead(dt);
    } else if (run.phase === 'visit') {
      stepVisit();
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
