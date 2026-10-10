/**
 * The timeline. Owns every RunState mutation (except run.spider, which
 * Spider.update writes): boot, then walk + read for each section, then the
 * ship overview. Pure simulation, no DOM, deterministic at SIM_DT, so
 * seek(t) reproduces exactly what live playback would show.
 *
 * It is also the cinematographer, and Iron Man is its subject: every shot is
 * framed on him (his size on screen, where he sits in the frame, his eyes high
 * in it), and every move is spring smoothed (world/camera.js), with no cuts:
 *  - intro: a brief wide look at the first ball, pushing in onto a front
 *    three-quarter view of him;
 *  - walking, reading, firing: a full-figure two-shot (he fills about half the
 *    view height), from in front of him or his side, rarely and briefly from
 *    behind, with his firing palm and its beam toward the lens's side (the
 *    words they hit are often off screen then: their labels are pinned to the
 *    frame's edge, see world/labels.js); re-planned a few times a second from
 *    where the words he fires at, and the next few, are, but a shot once
 *    settled is held for a few seconds, moves are deliberate, and walking it
 *    turns with him like a tracking shot. Beats: now and then, as a linked
 *    word goes, a push in to a medium shot (the suit and the firing hand up
 *    close); as a flag goes, a moment wider so the flagged word shares the
 *    frame;
 *  - takeoff: as the last words go it goes round to a view of the leap from
 *    behind and to the side it is already on, and holds it through the crouch;
 *  - flight: a chase camera close behind him and to that side, banking a
 *    little, looking down and ahead along his path through the stars;
 *  - landing: through the second half of the flight, a swing round onto a
 *    lens low and in front of where he lands; he flies down into the shot and lands in
 *    the superhero kneel filling half the frame; it pushes in through the
 *    hold, tilts up with him as he rises, then hands back to the two-shot;
 *  - finale: after his last landing a rising orbit of the whole nebula, then a
 *    slow drift back onto him resting with the nebula behind him.
 * The lens keeps out of every ball's blinding nucleus and clear of him, and
 * shots that would sit in other balls or look through a nucleus cost more.
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
import { clearDistance, fitDistance, followCamera, orbitDir, sampleKeys, smoothDamp } from '../world/camera.js';
import { fork, range } from '../core/rng.js';
import { Spider } from '../world/spider.js';
import { labelLife } from '../world/labels.js';
import { LAND_TIME } from '../world/spider-sim.js';

const BOOT = 0.4;
const INTRO_AIR = 7.5; // the opening fly-in, while the spider wakes and walks on the first ball
const INTRO_HOLD = 1.0; // breath on the first ball before reading starts
const BREATH = 0.8; // after a landing, before the first reach
const LAND = LAND_TIME; // touchdown to walking on (the hero's three-point landing)
const SHIP_SETTLE = 22; // the finale: orbit the nebula, then drift onto the spider
const TAIL = 1.5; // last reach + hold + retract after the final word
const GAP = 1.04; // mean gap between reaches, in units of 1/rate (see nextGap)
const RATE_CAP = 11; // reaches per second at most; denser sections read a phrase per reach
const RUN_BUDGET = 420; // seconds: even a 1500-word, 12-section prompt finishes under ~7 min
const MIN_READ = 14;
const MAX_READ = 32;
const LOG_CAP = 40;
// Between sections the spider also leaps through the extra (no-word) balls:
// it lands inside, on the side facing where it came from, and crosses toward
// the side facing where it goes next, for at most VISIT_CRAWL seconds.
const VISIT_CRAWL = 3.5;
const VISITS = false;
const VISIT_EASE = 1.4; // a beat after crossing, before the next leap
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

// The hero camera. Iron Man (world/ironman.js) stands HERO_H tall with his feet
// about 10 below the crawler's body point, so his middle is HERO_MID above it
// and his eyes EYE_UP above that.
const HERO_H = 46;
const HERO_MID = 13;
const EYE_UP = 19;
const LENS_TAN = Math.tan((50 * Math.PI) / 360); // half the vertical field of view (view3d FOV)
// Shot sizes, as the share of the view height he fills standing.
const SIZE_MEDIUM = 0.48; // walking, reading, firing: a full-figure two-shot
const SIZE_WIDE = 0.41; // the two-shot may pull back this far to keep his words in frame...
const SIZE_REVEAL = 0.34; // ...and eases out to this for a moment as a flag lands, so the flagged word shares the frame
const SIZE_TIGHT = 0.8; // now and then, as a linked word goes, in to a medium shot: the suit, the firing hand and its beam up close
const SIZE_VISIT = 0.56; // crossing a ball with no words: a slow push in on him
const SIZE_LAUNCH = 0.46; // the takeoff
const SIZE_OPEN = 0.09; // the brief wide look the run opens on
const SIZE_REST = 0.42; // the finale's last shot of him
const NARROW = 0.8; // aspect (width / height) below which the shots pull back a little (see shotDist)
const SIZE_CHASE = 0.41; // in flight, close behind him (standing size: lying along his path he reads at about a third)
const EYES_TOP = 0.28; // his eyes this far down the frame (of its height) in a full-figure shot, a little lower closer in
// Takeoff and flight are filmed from his side of the camera: from behind and off to one side (rad off straight
// behind him), as near as may be to where the camera already is, so it never has far to swing.
const LAUNCH_OFF = [0.95, 1.9]; // the takeoff: a rear three-quarter view to a side view
const CHASE_OFF = [0.75, 1.35]; // the chase
const CHASE_EL = 0.16; // a little above, looking down and ahead along his path
const CHASE_ROLL = 0.05; // rad: the chase camera banks this much into his side of the frame
// The superhero landing (world/ironman.js): he drops into a kneel, holds it and rises out of it over the
// last KNEEL_RISE of the land phase (LAND_TIME) (world/ironman.js LAND_RISE: it cannot be imported here, as
// that module needs three.js and the suit's model). Kneeling he is KNEEL_H tall, his middle KNEEL_MID above
// the crawler point; risen, he stands RISE_SINK lower than when walking, settling over SINK_SETTLE after.
const KNEEL_RISE = 0.9;
const KNEEL_H = 28;
const KNEEL_MID = -5;
const RISE_SINK = 8.5;
const SINK_SETTLE = 0.9;
const LAND_HOLD = LAND_TIME - KNEEL_RISE; // s after touchdown that he holds the kneel
const LAND_BLEND = 2.2; // once he is up, the landing shot hands back to the two-shot over this long
// Through the second half of the flight the camera swings round (never a cut) onto the landing: a view low
// and in front of where he will land, that he flies down into; it pushes in through the kneel and tilts up
// with him as he rises.
const SWING_U = [0.3, 0.9]; // share of the flight flown as it swings from the chase onto the landing view
const LAND_AZ = 0.55; // rad off straight in front of him
const LAND_EL = -0.3; // rad below his kneeling middle: near his boots, looking up
const SIZE_KNEEL = 0.44; // the kneeling hero fills this much of the view height as he lands...
const SIZE_KNEEL_IN = 0.5; // ...pushing in to this through the hold
const SIZE_RISE = 0.62; // standing, as he rises (the lens holds its place and tilts up with him)
const SHOT_Y_KNEEL = -0.04; // where the kneeling hero's middle sits on screen (NDC)
const KNEEL_SX = -0.14; // ...and across it, on a narrow screen (see landRig)
const LAND_LOOK = 0.4; // at the cut it looks this far from him toward where he lands
const PANS = [-0.3, -0.15, 0, 0.15, 0.3]; // where across the frame the two-shot may put him (NDC)
const ELS = [-0.07, 0.09, 0.25]; // two-shot elevations it chooses between (rad, > 0 looks down)
const PLAN_EVERY = 0.2; // s between re-plans of the two-shot
const AHEAD = 4; // s the two-shot looks ahead (see planAhead)...
const AHEAD_DT = 0.33; // ...in steps of this...
const AHEAD_N = Math.round(AHEAD / AHEAD_DT) + 1;
const AHEAD_BINS = 32; // ...over this many angles round him...
const AHEAD_EVERY = 0.75; // ...again this often...
const AHEAD_LOOK = 1.1; // ...and the camera aims this far along it (its springs lag about that much)
const AZ_RATE = 0.6; // rad/s: the two-shot circles him no faster than this
const MOVE_W = 0.2; // what moving round him costs the look-ahead, per AHEAD_BINS step (so it moves seldom, and not far)
const TRAVEL_W = 0.5; // ...and a re-plan, per rad
const TRACK = 0.75; // walking, the two-shot turns round with him this much of the way he turns (see stepShot)
const SHOT_TURN = 0.5; // s: the two-shot's angle round him eases onto its plan this fast (a move takes 1-1.5 s)
// Holds: once a move settles the two-shot stays put for at least HOLD_MIN, unless keeping it would cost
// KEEP_HELD more than the best shot (it is losing him or his words); afterwards KEEP more.
const HOLD_MIN = 4;
const KEEP_HELD = 0.7;
const KEEP = 0.25;
const HOLD_V = 0.04; // rad/s: settled
const REVERSE_T = 4; // s after a move during which going back the other way costs REVERSE_W
const REVERSE_W = 0.6;
// What a two-shot costs, by how it sees him (his chest, as world/ironman.js turns it toward the words he fires
// at: ARM_OFF to the firing arm's side of the word, at most TWIST_MAX off his heading). A front three-quarter
// view is free; a side view costs FACE_W; a view from behind BACK_W, doubling every BACK_T it has lasted.
const ARM_OFF = 0.45;
const TWIST_MAX = 0.75;
const FACE_W = 0.3;
const BACK_W = 1.5;
const BACK_T = 1.2;
const PALM_W = 0.6; // the back of his firing hand to the lens, the beam going away from it
const WORD_W = 1.5; // losing his words off screen (their labels are then pinned to the frame's edge, see world/labels.js)
const HAND_W = 0.5; // ...and his body hiding the firing hand
// Beats: a tight shot at most every TIGHT_EVERY, held until TIGHT_HOLD after its word goes; a reveal held REVEAL_HOLD.
const TIGHT_EVERY = 10;
const TIGHT_LEVEL = 0.6; // rad: a tight shot's word is at most this far above or below his chest
const TIGHT_HOLD = 2.2;
const REVEAL_EVERY = 4;
const REVEAL_HOLD = 1.6;
const BEAT_GAP = 2.5; // s at the full figure between one beat and the next
const MIN_GAP = 40; // the lens never comes nearer his middle than this
const NUCLEUS = 0.2; // ...nor into a ball's blinding nucleus (radii)
const PRE_LEAP = 2.0; // s over which it drifts round toward the takeoff view once the last words go
const LABEL_CAP = 6; // s: a flag stays up all section, but the camera plans for it this long

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => x * x * (3 - 2 * x);
/** Smoothstep of x from a to b (either order). */
const ss = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Planned read time for a section (s): longer sections linger, within limits. */
const readSeconds = (count) => (count ? clamp(9 + 2.4 * Math.sqrt(count), MIN_READ, MAX_READ) : 2.5);
/** Floaty, unhurried leaps; long gaps take longer and arc higher. */
const airTime = (L) => clamp(1.7 + L / 380, 2.0, 3.6);

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
  let plans; // per-section plans: { T } read time
  let ship; // finale plan
  let roamIdx; // next waypoint of the active section's route
  let visitQueue; // extra balls still to visit before the next section
  let visit; // the extra ball being visited: { c, land, exit, crawl, t0, leaveAt }
  let hc; // the hero camera's state (see resetCamera)
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
    /** The hero camera's own state (its plan, beat, hold), for tools that study it. */
    get hc() {
      return hc;
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

  /**
   * Distance at which he fills `share` of the view height; on a screen
   * narrower than NARROW (a phone held upright) a little further, so the
   * frame keeps enough width round him to follow him as he moves.
   */
  function shotDist(share) {
    return HERO_H / (share * Math.sqrt(Math.min(1, aspect() / NARROW)) * 2 * LENS_TAN);
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
    // (He no longer leaps through the word-less balls between sections: one flight per section, so he
    // spends his time walking and shooting. VISITS turns them back on.)
    for (const c of VISITS ? clusters : []) {
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

  /* ------------------------------------------------------------ planning */

  function makeKey(t, w, dist, yaw, pitch, b = 1) {
    return { t, b, w, ld: Math.log(Math.max(1, dist)), yaw, pitch };
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
      // Pull back once he has landed from his last leap...
      makeKey(0, 0.3, fitB * 1.02, startYaw + turn * 0.12, 0.34, 0),
      makeKey(3.6, 0.16, fitB * 1.04, startYaw + turn * 0.5, 0.42, 0),
      // ...orbit the whole nebula, rising over it...
      makeKey(8.6, 0.08, fitB * 0.98, startYaw + turn * 1.3, 0.74, 0),
      // ...then drift in (the last shot of him takes over from here, see shipTarget).
      makeKey(12.6, 0.55, Math.sqrt(fitB * closeDist) * 1.05, finalYaw - turn * 0.25, 0.46, 0),
      makeKey(SHIP_SETTLE, 0.82, closeDist, finalYaw, pitchEnd, 0),
    ];
    ship = { keys, rest, cluster: best, turn, finalYaw };
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
    plans = analysis.sections.map((s, i) => ({ T: readT[i] }));
    ship = null;
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
    resetCamera();
  }

  function log(verb, text, section) {
    run.log.push({ clock: clock(), verb, text, section });
    if (run.log.length > LOG_CAP) run.log.shift();
    run.logSeq++;
  }

  /* -------------------------------------------------------------- camera */

  const RIG = ['x', 'y', 'z', 'dist', 'yaw', 'pitch', 'move', 'turn', 'lead'];
  /**
   * A camera target: the orbit rig (look-at, distance, angles; see
   * world/camera.js) plus how the follow eases onto it: `move` and `turn` are
   * its smoothing times (s), `lead` how much of his velocity the look-at runs
   * ahead by to make up the follow's lag (1: all of it).
   */
  const rig = () => ({ x: 0, y: 0, z: 0, dist: 1, yaw: 0, pitch: 0, move: 0.5, turn: 0.7, lead: 0 });
  const setEase = (r, move, turn, lead) => {
    r.move = move;
    r.turn = turn;
    r.lead = lead;
    return r;
  };
  // Scratch for the camera maths.
  const H = [0, 0, 0]; // his middle
  const E = [0, 0, 0]; // a lens position
  const F = [0, 0, 0]; // looking from it: forward, right, up
  const R = [0, 0, 0];
  const Up = [0, 0, 0];
  const A = [0, 0, 0];
  const P = [0, 0, 0];
  const scr = { x: 0, y: 0, z: 0 };
  const cand = { sx: 0, xd: 0 };
  const vis = new Float64Array(PANS.length);
  const aimT = rig();
  const C = [0, 1]; // which way his chest faces, in the ground plane (see chestAt)

  /** The opening state of the hero camera: a wide look at the first ball, centred on him. */
  function resetCamera() {
    // It settles on a front three-quarter view of him walking on toward his first words, gliding
    // round from nearer his side as it pushes in.
    const s = run.spider;
    const g = n ? landing(0) : run.spiderGoal;
    const face = Math.hypot(g.x - s.x, g.z - s.z) > 1 ? Math.atan2(g.x - s.x, g.z - s.z) : planRand() * PI * 2;
    const side = planRand() < 0.5 ? -1 : 1;
    const az = face + side * 0.8;
    const az0 = az + side * 0.7;
    const D = shotDist(SIZE_MEDIUM);
    hc = {
      az0,
      plan: { az, el: ELS[1], D, sx: 0 }, // the two-shot the planner wants...
      shot: { az, el: ELS[1], lD: Math.log(D), sx: 0, vAz: 0, vEl: 0, vD: 0, vSx: 0 }, // ...and where it has eased to
      heldAt: -1, // when the two-shot settled (it holds a while from then)
      moveDir: 0, // which way round its last move went, and when
      moveAt: -1e9,
      backT: 0, // s the camera has been behind him, recently (see stepShot)
      beat: { kind: '', t1: 0, at: 0 }, // the two-shot's size beat (see updateBeat)
      beatSeen: 0,
      lastTight: -1e9,
      lastReveal: -1e9,
      preSx: 0,
      cutNow: false, // cut (rather than ease) to the camera target on the next step
      rollT: 0, // the bank the camera leans into
      vRoll: 0,
      planAt: 0,
      leap: null, // the leap being filmed (see beginLeap)
      sched: [], // [x, y, z, t] per word he will fire at soon (see schedule)
      attAhead: [],
      aheadAt: 0, // when to look ahead again (see planAhead)
      path: { t0: 0, n: 0, bin: new Int32Array(AHEAD_N), az: new Float64Array(AHEAD_N), el: new Float64Array(AHEAD_N) },
      pathAt: { az: 0, el: 0 },
      dpA: new Float64Array(AHEAD_BINS * ELS.length),
      dpB: new Float64Array(AHEAD_BINS * ELS.length),
      dpBack: new Int32Array(AHEAD_N * AHEAD_BINS * ELS.length),
      dpFixed: new Float64Array(AHEAD_BINS * ELS.length),
      preT0: -1, // when his last words went: the takeoff is coming
      pre: 0,
      preAz: 0,
      vel: [0, 0, 0], // his velocity, smoothed, for the look-at's lead
      screenDir: 0, // which way he walks across the screen: kept unless there is good reason
      att: [], // [x, y, z, weight] per word he is firing at or about to
      turnWay: {}, // per blend, which way round its yaw goes (see mixRig)
      air: 0, // off the ground (see stepAirborne)
      fly: 0,
      two: rig(),
      open: rig(),
      launch: rig(),
      chase: rig(),
      land: rig(),
      rest: rig(),
      out: rig(),
      keyed: rig(),
      pull: rig(),
    };
    openRig(hc.open);
    const o = hc.open;
    run.camera = { x: o.x, y: o.y, z: o.z, dist: o.dist, yaw: o.yaw, pitch: o.pitch, roll: 0, cut: 0 };
  }

  /**
   * How far off the ground he is, 0..1, eased as world/ironman.js eases it: in
   * the air his pelvis rides the crawler point, on the ground it stands over
   * his feet (settling back there for a second or so after a landing).
   */
  function stepAirborne(dt) {
    const sim = spider.sim;
    hc.air += ((sim.mode === 'jump' && sim.launched ? 1 : 0) - hc.air) * (1 - Math.exp(-9 * dt));
    hc.fly += ((spider.taut || 0) - hc.fly) * (1 - Math.exp(-9 * dt));
  }

  /**
   * His middle in the world: over his feet standing, at the crawler point in
   * the air, and low in the superhero landing's kneel until he rises out of it
   * (world/ironman.js: the last LAND_RISE of the land phase), a little low
   * still for a moment after (see RISE_SINK).
   */
  function heroPoint(out) {
    const s = run.spider;
    let mid = HERO_MID * (1 - clamp(Math.max(hc.air, hc.fly), 0, 1));
    const L = hc.leap;
    if (L && L.touch >= 0 && run.travel && L.id === run.travel.id) {
      const ts = run.t - L.touch;
      const kneel = lerp(L.mid0, KNEEL_MID, ss(0, 0.3, ts));
      mid = lerp(kneel, mid - RISE_SINK * (1 - ss(LAND_TIME, LAND_TIME + SINK_SETTLE, ts)), ss(LAND_HOLD, LAND_TIME, ts));
    }
    out[0] = s.x;
    out[1] = s.y + mid;
    out[2] = s.z;
    return out;
  }

  /** Camera basis looking from e toward p: forward F, right R, up Up. */
  function lookBasis(e, p) {
    F[0] = p[0] - e[0];
    F[1] = p[1] - e[1];
    F[2] = p[2] - e[2];
    const l = Math.hypot(F[0], F[1], F[2]) || 1;
    F[0] /= l;
    F[1] /= l;
    F[2] /= l;
    const rl = Math.hypot(F[0], F[2]) || 1;
    R[0] = -F[2] / rl;
    R[1] = 0;
    R[2] = F[0] / rl;
    Up[0] = -R[2] * F[1];
    Up[1] = R[2] * F[0] - R[0] * F[2];
    Up[2] = R[0] * F[1];
  }

  /** Where (x, y, z) falls on screen through that basis from e (NDC, x right, y up), and its depth. */
  function onScreen(e, x, y, z, asp) {
    const qx = x - e[0];
    const qy = y - e[1];
    const qz = z - e[2];
    const d = qx * F[0] + qy * F[1] + qz * F[2];
    const iz = 1 / Math.max(1e-3, d);
    scr.z = d;
    scr.x = ((qx * R[0] + qz * R[2]) * iz) / (LENS_TAN * asp);
    scr.y = ((qx * Up[0] + qy * Up[1] + qz * Up[2]) * iz) / LENS_TAN;
    return scr;
  }

  /**
   * Rig target for a shot of point p from azimuth az and elevation el (> 0
   * above) at distance D, the view turned so p sits at (sx, sy) on screen
   * (NDC). The look-at point moves off him rather than the lens moving, so
   * the composition holds however the shot then moves.
   */
  function compose(p, az, el, D, sx, sy, out) {
    orbitDir(az, el, dir);
    E[0] = p[0] + dir[0] * D;
    E[1] = p[1] + dir[1] * D;
    E[2] = p[2] + dir[2] * D;
    return aimFrom(E, p, sx, sy, out);
  }

  /** Rig target for a lens at e looking toward p, turned so p sits at (sx, sy) on screen (NDC). */
  function aimFrom(e, p, sx, sy, out) {
    const D = Math.hypot(p[0] - e[0], p[1] - e[1], p[2] - e[2]) || 1;
    if (e !== E) {
      E[0] = e[0];
      E[1] = e[1];
      E[2] = e[2];
    }
    lookBasis(E, p);
    const a = sx * LENS_TAN * aspect();
    const b = sy * LENS_TAN;
    let gx = F[0] - R[0] * a - Up[0] * b;
    let gy = F[1] - Up[1] * b;
    let gz = F[2] - R[2] * a - Up[2] * b;
    const gl = Math.hypot(gx, gy, gz);
    gx /= gl;
    gy /= gl;
    gz /= gl;
    out.x = E[0] + gx * D;
    out.y = E[1] + gy * D;
    out.z = E[2] + gz * D;
    out.dist = D;
    out.yaw = Math.atan2(-gx, -gz);
    out.pitch = Math.asin(clamp(-gy, -1, 1));
    return out;
  }

  function copyRig(a, out) {
    for (const k of RIG) out[k] = a[k];
    return out;
  }

  /**
   * Blend two camera targets: look-at and angles on arcs (so the lens swings
   * round him, never through him), distance in log. Which way round the yaw
   * blends is chosen (the short way) as the blend leaves either end and then held, so
   * a target that wanders past the far side of the other never flips it
   * (`slot` names the blend, to remember it).
   */
  function mixRig(a, b, w, out, slot) {
    const p = hc.turnWay[slot];
    const d = w > 0 && w < 1 && p !== undefined ? p + wrap(b.yaw - a.yaw - p) : wrap(b.yaw - a.yaw);
    hc.turnWay[slot] = d;
    if (w <= 0) return a === out ? out : copyRig(a, out);
    if (w >= 1) return copyRig(b, out);
    out.x = lerp(a.x, b.x, w);
    out.y = lerp(a.y, b.y, w);
    out.z = lerp(a.z, b.z, w);
    out.dist = a.dist * Math.pow(b.dist / a.dist, w);
    out.yaw = a.yaw + d * w;
    out.pitch = lerp(a.pitch, b.pitch, w);
    out.move = lerp(a.move, b.move, w);
    out.turn = lerp(a.turn, b.turn, w);
    out.lead = lerp(a.lead, b.lead, w);
    return out;
  }

  /** While a word's beam is out (or about to be), d s after it went: its weight, else 0. */
  const firing = (d, w) => (d > -0.5 && d < 1.0 ? w : 0);

  /**
   * The words that matter to the shot now (from hc.sched, see schedule): the
   * ones going out and the labels still up, in full, and the next few, less
   * the later they come. [x, y, z, weight, weight while its beam is out] in
   * hc.att.
   */
  function attention() {
    const a = hc.att;
    a.length = 0;
    const s = hc.sched;
    for (let j = 0; j < s.length; j += 6) {
      const d = -s[j + 3]; // s since it went (< 0: still to come)
      const w = s[j + 4] * (d > -0.2 ? 1 - ss(s[j + 5] + 0.4, s[j + 5] + 0.9, d) : 0.6 * Math.exp(d / 1.2));
      if (w > 0.02) a.push(s[j], s[j + 1], s[j + 2], w, firing(d, s[j + 4]));
    }
    return a;
  }

  /**
   * Which way his chest faces (unit, in the ground plane, into C) t s from now:
   * his heading, turned toward the words he fires at then as world/ironman.js
   * turns him (the firing arm a little off the chest's line). Needs H.
   */
  function chestAt(t, hx, hz) {
    const s = hc.sched;
    let tw = 0;
    let k = 0;
    for (let j = 0; j < s.length; j += 6) {
      if (!firing(t - s[j + 3], 1)) continue;
      const ax = s[j] - H[0];
      const az = s[j + 2] - H[2];
      const ang = Math.atan2(ax * hz - az * hx, ax * hx + az * hz); // > 0: on his left
      tw += ang - (ang > 0 ? ARM_OFF : -ARM_OFF);
      k++;
    }
    const a = clamp(k ? tw / k : 0, -TWIST_MAX, TWIST_MAX);
    C[0] = hx * Math.cos(a) + hz * Math.sin(a);
    C[1] = hz * Math.cos(a) - hx * Math.sin(a);
    return C;
  }

  /**
   * What the view of him from the lens just aimed costs (see FACE_W, BACK_W):
   * by its angle off his chest (C), 0 in front of it.
   */
  function facingCost() {
    const hl = Math.hypot(dir[0], dir[2]) || 1;
    const off = Math.acos(clamp((dir[0] * C[0] + dir[2] * C[1]) / hl, -1, 1));
    return FACE_W * ss(1.15, 1.9, off) + BACK_W * (1 + hc.backT / BACK_T) * ss(1.9, 2.5, off) + 0.08 * ss(0.35, 0, off);
  }

  /** Where his middle sits on screen (NDC y) in a shot from distance D: his eyes EYES_TOP down the frame. */
  function shotY(D) {
    return 1 - 2 * (EYES_TOP + (EYE_UP / HERO_H) * (HERO_H / (D * 2 * LENS_TAN)));
  }

  /**
   * How badly a lens at e, looking at p, sits among the stars: in a blinding
   * nucleus, inside another ball than his (its stars all round the lens), or
   * looking through a nucleus at him. 0 is clear.
   */
  function crowding(e, p) {
    let cost = 0;
    const lx = p[0] - e[0];
    const ly = p[1] - e[1];
    const lz = p[2] - e[2];
    const L = Math.hypot(lx, ly, lz) || 1;
    for (const c of clusters) {
      if (c.extra) continue; // dim scenery: flown through
      const ox = c.cx - e[0];
      const oy = c.cy - e[1];
      const oz = c.cz - e[2];
      const d = Math.hypot(ox, oy, oz) / c.r;
      cost += 1.2 * ss(0.45, 0.18, d);
      if (d < 0.85 && Math.hypot(p[0] - c.cx, p[1] - c.cy, p[2] - c.cz) > c.r) cost += 0.4 * ss(0.85, 0.6, d);
      const along = (ox * lx + oy * ly + oz * lz) / L;
      if (along > 0 && along < L) {
        const miss = Math.hypot(ox - (lx / L) * along, oy - (ly / L) * along, oz - (lz / L) * along) / c.r;
        cost += 0.6 * ss(0.3, 0.1, miss);
      }
    }
    return cost;
  }

  /** Point the lens at him (at H) from (az, el) at distance D: E, its basis, and dir. */
  function aimAtHim(az, el, D) {
    orbitDir(az, el, dir);
    E[0] = H[0] + dir[0] * D;
    E[1] = H[1] + dir[1] * D;
    E[2] = H[2] + dir[2] * D;
    lookBasis(E, H);
  }

  /** Which way he walks across the screen from the lens just aimed (-1, 0, 1). */
  function walkDir(moving, hx, hz, asp) {
    if (!moving) return 0;
    onScreen(E, H[0] + hx * 30, H[1], H[2] + hz * 30, asp);
    return scr.x > 0.02 ? 1 : scr.x < -0.02 ? -1 : 0;
  }

  /**
   * The part of a two-shot's cost that does not depend on the words or which
   * way his chest faces, for the lens just aimed: its elevation (a little
   * below his eyes, looking up a touch, is best), the stars round the lens,
   * and flipping which way he walks across the screen.
   */
  function fixedCost(el, xd) {
    return 0.4 * Math.abs(el - 0.04) + crowding(E, H) + (xd && hc.screenDir && xd !== hc.screenDir ? 0.25 : 0);
  }

  /**
   * Score a two-shot of him (at H) from (az, el) at distance D; lower is
   * better. It counts the (weighted) share of his words (hc.att) it would lose,
   * off screen or hidden behind him, for the best of the pans (cand.sx); the
   * firing hands his body would hide, and those it would show from the back
   * (their beams going away from the lens); with lead room the way he walks
   * (cand.xd: which way that is across the screen); how it sees him (see
   * facingCost; his chest in C); then the rest (see fixedCost, or `fixed` if
   * it is already known).
   */
  function twoShotCost(az, el, D, moving, hx, hz, fixed = -1) {
    const asp = aspect();
    aimAtHim(az, el, D);
    const bx = 10 / (D * LENS_TAN * asp); // his half-width on screen, arms in
    const by = HERO_H / 2 / (D * LENS_TAN); // his half-height
    const sy = shotY(D);
    const hl = Math.hypot(dir[0], dir[2]) || 1;
    vis.fill(0);
    let all = 0;
    let hidden = 0;
    let palm = 0;
    let fired = 0;
    const a = hc.att;
    const cy = H[1] + 9; // his chest
    for (let i = 0; i < a.length; i += 5) {
      const w = a[i + 3];
      all += w;
      // The firing hand: an arm's length out from his chest toward the word.
      const dx = a[i] - H[0];
      const dy = a[i + 1] - cy;
      const dz = a[i + 2] - H[2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      onScreen(E, H[0] + (dx / dl) * 20, cy + (dy / dl) * 20, H[2] + (dz / dl) * 20, asp);
      if (scr.z > D + 2 && Math.abs(scr.x) < bx * 0.75 && Math.abs(scr.y) < by) hidden += w;
      if (a[i + 4] > 0) {
        // Its palm (and the beam leaving it) toward the lens's side, not away: across the frame is best.
        const off = Math.acos(clamp((dir[0] * dx + dir[2] * dz) / (hl * (Math.hypot(dx, dz) || 1)), -1, 1));
        palm += a[i + 4] * (ss(1.75, 2.5, off) + 0.3 * ss(0.5, 0.15, off));
        fired += a[i + 4];
      }
      onScreen(E, a[i], a[i + 1], a[i + 2], asp);
      if (scr.z < 12) continue; // behind the lens
      if (scr.z > D && Math.abs(scr.x) < bx && Math.abs(scr.y) < by) continue; // behind him
      for (let k = 0; k < PANS.length; k++) if (Math.abs(scr.x + PANS[k]) < 0.86 && Math.abs(scr.y + sy) < 0.84) vis[k] += w;
    }
    const xd = walkDir(moving, hx, hz, asp);
    // Closer in, he keeps nearer the middle: off to the side his raised arms would leave the frame.
    const panMax = lerp(0.3, 0.1, ss(SIZE_MEDIUM, SIZE_TIGHT, HERO_H / (D * 2 * LENS_TAN))) + 1e-6;
    let best = Infinity;
    for (let k = 0; k < PANS.length; k++) {
      const sx = PANS[k];
      if (Math.abs(sx) > panMax) continue;
      let c = (all > 0 ? WORD_W * (1 - vis[k] / all) : 0) + 0.05 * Math.abs(sx);
      // He walks into the frame, not out of it; with nothing to fire at, from a third of the way across.
      if (xd) c += 0.8 * Math.max(0, sx * xd) + (all > 0 ? 0 : 0.5 * Math.abs(sx + 0.2 * xd));
      if (c < best) {
        best = c;
        cand.sx = sx;
      }
    }
    let cost = best + (all > 0 ? (HAND_W * hidden) / all : 0) + (fired > 0 ? (PALM_W * palm) / fired : 0) + facingCost();
    if (!all) {
      // With nothing to fire at: a front three-quarter tracking shot.
      cost += 0.15 * Math.abs(Math.acos(clamp((dir[0] * hx + dir[2] * hz) / hl, -1, 1)) - 0.75);
    }
    cand.xd = xd;
    return cost + (fixed >= 0 ? fixed : fixedCost(el, xd));
  }

  /** How much a word matters to the shot (its label: a flag most, a link more than a plain word, a filler word none). */
  function wordWeight(id) {
    const w = analysis.words[id];
    return w.vague ? 2 : w.kind ? 1.4 : labelLife(w) > 0 ? 1 : 0.35;
  }

  /**
   * The words that matter to the shot over the next few seconds: those with
   * their labels still up, those being fired at, then the rest in reading
   * order at the read's pace (or, before the read starts, its opening pace).
   * Per word [x, y, z, when it goes (s from now), weight, how long it stays
   * up after] in hc.sched.
   */
  function schedule() {
    const out = hc.sched;
    out.length = 0;
    const sec = analysis.sections[run.active];
    if (!sec || (run.phase !== 'read' && run.phase !== 'walk')) return out;
    const wp = world.wordPos;
    const add = (id, t) => out.push(wp[id * 3], wp[id * 3 + 1], wp[id * 3 + 2], t, wordWeight(id), Math.min(LABEL_CAP, labelLife(analysis.words[id])));
    for (let id = sec.start; id < cursor; id++) {
      if (run.wordState[id] === 1) add(id, -0.2);
      else if (run.wordState[id] === 2) {
        const t = run.readAt[id] - run.t - 0.4;
        if (-t < Math.min(LABEL_CAP, labelLife(analysis.words[id])) + 1.3) add(id, t);
      }
    }
    const end = sec.start + sec.count;
    const reading = run.phase === 'read';
    const per = reading ? GAP / Math.max(0.3, rate) : 0.3; // s between reaches
    let t = reading ? Math.max(0, nextReach - readAcc) : 1.2;
    for (let id = cursor; id < end && t < AHEAD + 2; id += reading ? span : 1, t += per) add(id, t);
    return out;
  }

  /**
   * Look ahead: where round him, and how high, the camera should be over the
   * next AHEAD seconds so that the words he will fire at then (and his firing
   * hand) are in frame, he is seen from a good side and the lens stays out of
   * the stars' cores, circling him no faster than AZ_RATE from where it is
   * now. He is taken to stay about where he is. Dynamic programming over
   * angle and time; re-planned every AHEAD_EVERY, so it keeps to what
   * actually happens. Returns the path sampled every AHEAD_DT from now.
   */
  function planAhead() {
    const sched = hc.sched; // just scheduled (see planTwoShot)
    heroPoint(H);
    const s = run.spider;
    const hx = Math.cos(s.heading);
    const hz = Math.sin(s.heading);
    const moving = Math.hypot(s.vx, s.vz) > 4;
    const NB = AHEAD_BINS;
    const NE = ELS.length;
    const NS = NB * NE;
    const S = Math.round(AHEAD / AHEAD_DT) + 1;
    const binW = (2 * PI) / NB;
    const kmax = Math.max(1, Math.round((AZ_RATE * AHEAD_DT) / binW));
    const D = shotDist(SIZE_MEDIUM);
    const az0 = hc.shot.az;
    const keepAtt = hc.att;
    const keepDir = hc.screenDir;
    hc.att = hc.attAhead;
    let cost = hc.dpA;
    let next = hc.dpB;
    const back = hc.dpBack;
    // He is taken to stay put, so all but the words is the same at every step: once per angle.
    const fixed = hc.dpFixed;
    for (let b = 0; b < NB; b++) {
      for (let e = 0; e < NE; e++) {
        aimAtHim(az0 + (b - NB / 2) * binW, ELS[e], D);
        fixed[b * NE + e] = fixedCost(ELS[e], walkDir(moving, hx, hz, aspect()));
      }
    }
    for (let k = 0; k < S; k++) {
      const t = k * AHEAD_DT;
      // The words that matter then; and keep near the last plan, so re-planning never jumps about.
      const prev = hc.path.n && run.t - hc.path.t0 < AHEAD ? aheadAt(run.t - hc.path.t0 + t, hc.pathAt).az : null;
      hc.att.length = 0;
      for (let j = 0; j < sched.length; j += 6) {
        // From as it goes (the beam) until its label is gone.
        const d = t - sched[j + 3];
        const wt = sched[j + 4] * ss(-0.4, 0, d) * (1 - ss(sched[j + 5] + 0.4, sched[j + 5] + 0.9, d));
        if (wt > 0.01) hc.att.push(sched[j], sched[j + 1], sched[j + 2], wt, firing(d, sched[j + 4]));
      }
      chestAt(t, hx, hz); // (he turns to the words he fires at then)
      for (let b = 0; b < NB; b++) {
        const off = (b - NB / 2) * binW;
        for (let e = 0; e < NE; e++) {
          const st = b * NE + e;
          const local = twoShotCost(az0 + off, ELS[e], D, moving, hx, hz, fixed[st]) + (prev === null ? 0 : 0.25 * Math.abs(wrap(az0 + off - prev)));
          if (k === 0) {
            next[st] = local + 1.5 * Math.abs(off) + 0.5 * Math.abs(ELS[e] - hc.shot.el);
            continue;
          }
          let m = Infinity;
          let arg = 0;
          for (let db = -kmax; db <= kmax; db++) {
            const pb = (b + db + NB) % NB;
            for (let pe = Math.max(0, e - 1); pe <= Math.min(NE - 1, e + 1); pe++) {
              const c = cost[pb * NE + pe] + MOVE_W * Math.abs(db) + 0.08 * Math.abs(pe - e);
              if (c < m) {
                m = c;
                arg = pb * NE + pe;
              }
            }
          }
          next[st] = m + local;
          back[k * NS + st] = arg;
        }
      }
      [cost, next] = [next, cost];
    }
    hc.att = keepAtt;
    hc.screenDir = keepDir;
    let st = 0;
    for (let j = 1; j < NS; j++) if (cost[j] < cost[st]) st = j;
    const path = hc.path;
    path.t0 = run.t;
    path.n = S;
    let prevB = 0;
    for (let k = S - 1; k >= 0; k--) {
      path.bin[k] = Math.floor(st / NE);
      path.el[k] = ELS[st % NE];
      if (k > 0) st = back[k * NS + st];
    }
    // Unwrapped, so the camera circles the short way between samples.
    for (let k = 0; k < S; k++) {
      const b = path.bin[k];
      path.az[k] = k ? path.az[k - 1] + ((((b - prevB + NB / 2) % NB) + NB) % NB - NB / 2) * binW : az0 + (b - NB / 2) * binW;
      prevB = b;
    }
    return path;
  }

  /** The look-ahead path at t seconds from when it was planned (held at its end). */
  function aheadAt(t, out) {
    const p = hc.path;
    const x = clamp(t / AHEAD_DT, 0, p.n - 1);
    const k = Math.min(p.n - 2, Math.floor(x));
    const f = x - k;
    out.az = lerp(p.az[k], p.az[k + 1], f);
    out.el = lerp(p.el[k], p.el[k + 1], f);
    return out;
  }

  /**
   * The two-shot's size beat while he reads: now and then, as a linked word
   * goes, in to a medium shot (the suit's detail, the firing hand and its beam
   * up close), and as a flag goes, out a little so the flagged word and he
   * share the frame; otherwise the full figure. A beat starts as its word is
   * about to go and holds until its label has had its moment.
   */
  function updateBeat() {
    const b = hc.beat;
    if (b.kind && run.t < b.t1) return;
    if (b.kind) {
      b.kind = '';
      b.at = run.t; // back out: a deliberate move too
    }
    if (run.phase !== 'read' || hc.pre > 0 || run.t - b.at < BEAT_GAP) return;
    heroPoint(H);
    const s = hc.sched;
    for (let j = 0; j < s.length; j += 6) {
      const go = s[j + 3]; // s until it goes
      if (go < 0 || go > 0.6) continue;
      const w = s[j + 4];
      const reveal = w >= 2 && run.t - hc.lastReveal > REVEAL_EVERY;
      // (In close only on a word level enough with his chest that the arm firing at it stays in frame.)
      const level = Math.abs(Math.atan2(s[j + 1] - H[1] - 9, Math.hypot(s[j] - H[0], s[j + 2] - H[2]))) < TIGHT_LEVEL;
      if (!reveal && !(w >= 1.4 && level && run.t - hc.lastTight > TIGHT_EVERY)) continue;
      b.kind = reveal ? 'reveal' : 'tight';
      b.t1 = run.t + go + (reveal ? REVEAL_HOLD : TIGHT_HOLD);
      b.at = run.t;
      if (reveal) hc.lastReveal = run.t;
      else hc.lastTight = run.t;
      return;
    }
  }

  /** How far the two-shot stands off for the beat it is on. */
  function beatDist() {
    const k = hc.beat.kind;
    return shotDist(k === 'tight' ? SIZE_TIGHT : k === 'reveal' ? SIZE_REVEAL : run.phase === 'visit' ? SIZE_VISIT : SIZE_MEDIUM);
  }

  /**
   * Re-plan the two-shot. While there are words to fire at it keeps near the
   * look-ahead path (see planAhead), fitting the angle, height and where he
   * sits in the frame to the words he is firing at now (and pulling back a
   * little if that keeps them); otherwise it considers every angle round him,
   * each charged for how far the camera would travel. A shot, once it has
   * settled, is held for HOLD_MIN unless it is losing what matters; then it is
   * kept unless another is clearly better, so the camera rests, then moves
   * with purpose, and does not go straight back the way it came. A new beat
   * (see updateBeat) is a move of its own. While the takeoff nears it goes to
   * the takeoff view.
   */
  function planTwoShot() {
    schedule();
    updateBeat();
    const sec = analysis.sections[run.active];
    const words = run.tentacles.length > 0 || (sec && (run.phase === 'read' || run.phase === 'walk') && cursor < sec.start + sec.count);
    let path = null;
    if (words && hc.pre === 0) {
      if (run.t >= hc.aheadAt) {
        planAhead();
        hc.aheadAt = run.t + AHEAD_EVERY;
      }
      path = aheadAt(run.t - hc.path.t0 + AHEAD_LOOK, hc.pathAt);
    } else hc.aheadAt = 0;
    attention();
    heroPoint(H);
    const s = run.spider;
    const hx = Math.cos(s.heading);
    const hz = Math.sin(s.heading);
    chestAt(0, hx, hz);
    const moving = Math.hypot(s.vx, s.vz) > 4;
    const p = hc.plan;
    if (hc.pre > 0) {
      // The takeoff is coming: round to its view (see updatePre), at its own pace.
      p.az = hc.shot.az + wrap(hc.preAz - hc.shot.az);
      p.el = 0.04;
      p.D = shotDist(SIZE_LAUNCH);
      p.sx = hc.preSx;
      return;
    }
    const Db = beatDist();
    const Dw = run.phase === 'read' && !hc.beat.kind ? shotDist(SIZE_WIDE) : Db;
    const sh = hc.shot;
    if (Math.abs(sh.vAz) < HOLD_V && Math.abs(wrap(p.az - sh.az)) < 0.06) {
      if (hc.heldAt < 0) hc.heldAt = run.t;
    } else hc.heldAt = -1;
    // A beat starting is a move of its own; one ending only changes the size back, unless it is time to move anyway.
    const fresh = hc.beat.at !== hc.beatSeen && hc.beat.kind;
    hc.beatSeen = hc.beat.at;
    const holding = !fresh && !(hc.heldAt >= 0 && run.t - hc.heldAt >= HOLD_MIN);
    const keep = fresh ? 0 : holding ? KEEP_HELD : KEEP;
    const tight = hc.beat.kind === 'tight';
    // Off the path costs (less for a tight beat, which picks its own side of him; and not the shot being held,
    // which keeps to itself until it has had its time); so does travelling, and going straight back.
    const extra = (az, el, D, held = false) =>
      (path && !held ? (tight ? 0.3 : 0.6) * Math.abs(wrap(az - path.az)) + 0.5 * Math.abs(el - path.el) : 0) +
      TRAVEL_W * Math.abs(wrap(az - sh.az)) +
      (D > Db * 1.01 ? 0.22 : 0) +
      (run.t - hc.moveAt < REVERSE_T && wrap(az - sh.az) * hc.moveDir < -0.05 ? REVERSE_W : 0);
    const curD = p.D === Dw ? Dw : Db;
    let bestCost = twoShotCost(p.az, p.el, curD, moving, hx, hz) + extra(p.az, p.el, curD, holding) - keep;
    let bAz = p.az;
    let bEl = p.el;
    let bD = curD;
    let bSx = cand.sx;
    let bXd = cand.xd;
    const from = path && !tight ? path.az : sh.az;
    const steps = path && !tight ? 2 : tight ? 2 : 12;
    for (let k = -steps; k <= steps; k++) {
      const az = from + (k * PI) / (path && !tight ? 24 : 12);
      for (const el of ELS) {
        for (const D of Dw === Db ? [Db] : [Db, Dw]) {
          const cost = twoShotCost(az, el, D, moving, hx, hz) + extra(az, el, D) + 0.5 * Math.abs(el - p.el);
          if (cost < bestCost) {
            bestCost = cost;
            bAz = az;
            bEl = el;
            bD = D;
            bSx = cand.sx;
            bXd = cand.xd;
          }
        }
      }
    }
    const turn = wrap(bAz - sh.az);
    if (Math.abs(wrap(bAz - p.az)) > 0.05) {
      hc.moveDir = Math.sign(turn);
      hc.moveAt = run.t;
      hc.heldAt = -1;
    }
    p.az = sh.az + turn;
    p.el = bEl;
    p.D = bD;
    p.sx = bSx;
    if (bXd) hc.screenDir = bXd;
  }

  /**
   * Ease the two-shot toward its plan: slowly, never circling him faster than
   * AZ_RATE; and keep count of how long it has been seeing him from behind.
   */
  function stepShot(dt) {
    const s = hc.shot;
    const p = hc.plan;
    const sp = run.spider;
    // Walking, it tracks him: as he turns, the shot (and what it plans) turns round with him, so it keeps
    // its angle on him without re-planning; standing, it holds still while he turns to fire.
    const turn = hc.heading === undefined ? 0 : -wrap(sp.heading - hc.heading) * TRACK * ss(3, 10, Math.hypot(sp.vx, sp.vz));
    hc.heading = sp.heading;
    if (turn && hc.pre === 0) {
      s.az += turn;
      p.az += turn;
      for (let k = 0; k < hc.path.n; k++) hc.path.az[k] += turn;
    }
    [s.az, s.vAz] = smoothDamp(s.az, s.az + wrap(p.az - s.az), s.vAz, SHOT_TURN, dt);
    s.vAz = clamp(s.vAz, -AZ_RATE, AZ_RATE);
    [s.el, s.vEl] = smoothDamp(s.el, p.el, s.vEl, 0.9, dt);
    [s.lD, s.vD] = smoothDamp(s.lD, Math.log(p.D), s.vD, 0.7, dt);
    [s.sx, s.vSx] = smoothDamp(s.sx, p.sx, s.vSx, 0.8, dt);
    heroPoint(H);
    chestAt(0, Math.cos(sp.heading), Math.sin(sp.heading));
    orbitDir(s.az, s.el, dir);
    const behind = (dir[0] * C[0] + dir[2] * C[1]) / (Math.hypot(dir[0], dir[2]) || 1) < Math.cos(1.9);
    hc.backT = behind ? hc.backT + dt : Math.max(0, hc.backT - 2 * dt);
  }

  /** The two-shot as it has eased so far, as a camera target. */
  function twoShotRig(out) {
    const s = hc.shot;
    const D = Math.exp(s.lD);
    compose(heroPoint(H), s.az, s.el, D, s.sx, shotY(D), out);
    return setEase(out, 0.4, 0.45, 0.6); // (its angle is eased already, see stepShot: the follow need not add a long tail)
  }

  /** The brief wide look the run opens on: the first ball, him small in the middle of it. */
  function openRig(out) {
    compose(heroPoint(H), hc.az0, 0.62, shotDist(SIZE_OPEN), 0, 0, out);
    return setEase(out, 0.8, 1.0, 0.3);
  }

  /** Where his next leap will take him, so the camera can start round toward the takeoff view in time. */
  function nextGoal() {
    const nx = run.phase === 'read' ? visits[run.active][0] : visitQueue[0];
    if (nx) return sideFacing(nx, run.spider);
    if (run.active + 1 < n) return landing(run.active + 1);
    return { x: B.x, y: B.y, z: B.z };
  }

  /**
   * The takeoff view for a leap heading `yaw` with the camera at azimuth `az`
   * round him: from behind him and off to the camera's side of him, as near as
   * LAUNCH_OFF allows to where it is, so it never has far to swing.
   */
  function launchAz(yaw, az) {
    const off = wrap(az - yaw - PI);
    return yaw + PI + (off < 0 ? -1 : 1) * clamp(Math.abs(off), LAUNCH_OFF[0], LAUNCH_OFF[1]);
  }

  /** Which way (-1, 1) a leap heading `yaw` carries him across the screen from the takeoff view at `az`. */
  function launchDir(yaw, az) {
    heroPoint(H);
    aimAtHim(az, 0.04, shotDist(SIZE_LAUNCH));
    return onScreen(E, H[0] + Math.sin(yaw) * 40, H[1], H[2] + Math.cos(yaw) * 40, aspect()).x > 0 ? 1 : -1;
  }

  /**
   * Once his last words have gone (or he is most of the way across a ball he
   * only visits), go round to the coming takeoff's view, leaving room on
   * screen the way he will go.
   */
  function updatePre() {
    const sec = analysis.sections[run.active];
    const ending =
      (run.phase === 'read' && sec && cursor >= sec.start + sec.count) ||
      (run.phase === 'visit' && visit && visit.crawl && (visit.leaveAt > 0 || run.phaseT - visit.t0 > VISIT_CRAWL - PRE_LEAP));
    if (!ending) {
      hc.preT0 = -1;
      hc.pre = 0;
      return;
    }
    if (hc.preT0 < 0) {
      hc.preT0 = run.t;
      const g = nextGoal();
      const s = run.spider;
      const yaw = Math.atan2(g.x - s.x, g.z - s.z);
      hc.preAz = launchAz(yaw, hc.shot.az);
      hc.preSx = launchDir(yaw, hc.preAz) > 0 ? -0.16 : 0.16;
    }
    hc.pre = ss(0, PRE_LEAP, run.t - hc.preT0);
  }

  /**
   * A new leap: which way it goes; the takeoff and chase views, off to the
   * side of him the camera is on; and the landing view's side (the chase's,
   * unless the other is far clearer of stars).
   */
  function beginLeap(tr) {
    const fx = tr.to[0] - tr.from[0];
    const fz = tr.to[2] - tr.from[2];
    const yaw = Math.hypot(fx, fz) > 4 ? Math.atan2(fx, fz) : run.camera.yaw + PI;
    const launch = launchAz(yaw, hc.shot.az);
    const off = wrap(launch - yaw - PI);
    const side = off < 0 ? -1 : 1;
    const chase = yaw + PI + side * clamp(Math.abs(off), CHASE_OFF[0], CHASE_OFF[1]);
    const G = [tr.to[0], tr.to[1] + KNEEL_MID, tr.to[2]];
    const look = (p, az, el, D) => {
      orbitDir(az, el, dir);
      return crowding([p[0] + dir[0] * D, p[1] + dir[1] * D, p[2] + dir[2] * D], p);
    };
    const Dk = kneelDist(SIZE_KNEEL);
    // (The lens on the chase's side of his path in front of him: azimuth yaw - side * LAND_AZ.)
    let ls = side;
    if (look(G, yaw + ls * LAND_AZ, LAND_EL, Dk) < look(G, yaw - ls * LAND_AZ, LAND_EL, Dk) - 0.6) ls = -ls;
    const xd = launchDir(yaw, launch);
    hc.leap = { id: tr.id, yaw, side, launch, chase, landAz: yaw - ls * LAND_AZ, G, xd, sx: xd > 0 ? -0.16 : 0.16, touch: -1, cut: false, done: false };
  }

  /** Distance at which, kneeling, he fills `share` of the view height. */
  function kneelDist(share) {
    return (shotDist(share) * KNEEL_H) / HERO_H;
  }

  /** Touchdown: the two-shot will take over from the landing view, so it starts from there. */
  function touchdown(L) {
    L.mid0 = HERO_MID * (1 - clamp(Math.max(hc.air, hc.fly), 0, 1)); // his middle as he touches down (see heroPoint)
    L.touch = run.t;
    const s = hc.shot;
    const p = hc.plan;
    s.az = p.az = s.az + wrap(L.landAz - s.az);
    s.el = p.el = ELS[0];
    p.D = shotDist(SIZE_MEDIUM);
    s.lD = Math.log(p.D);
    s.sx = p.sx = 0;
    s.vAz = s.vEl = s.vD = s.vSx = 0;
    hc.heldAt = -1;
    hc.backT = 0;
    hc.planAt = run.t + LAND_HOLD;
  }

  /**
   * The camera through a leap, from `base` (the shot before it, by now on the
   * takeoff view, see updatePre): the takeoff, held through the crouch; the
   * chase, behind him and to the side, banking a little, as he flies; then,
   * from SWING_U of the way, a swing round onto the landing (see landRig), and back to the
   * two-shot once he is up.
   */
  function leapRig(base, out) {
    const L = hc.leap;
    const tr = run.travel;
    const sim = spider.sim;
    heroPoint(H);
    const T = run.t - tr.t0;
    const u = sim.mode === 'jump' ? (sim.launched ? sim.airU : 0) : 1;
    const ts = L.touch >= 0 ? run.t - L.touch : 0;
    const Dl = shotDist(SIZE_LAUNCH);
    compose(H, L.launch, 0.04, Dl, L.sx, shotY(Dl), hc.launch);
    mixRig(base, setEase(hc.launch, 0.45, 0.6, 0.6), ss(0, Math.max(0.05, tr.crouch), T), out, 'launch');
    compose(H, L.chase, CHASE_EL, shotDist(SIZE_CHASE), 0, -0.12, hc.chase);
    const chase = ss(0, 0.3, u);
    mixRig(out, setEase(hc.chase, 0.22, 0.45, 1), chase, out, 'chase');
    const landW = L.touch >= 0 ? 1 : ss(SWING_U[0], SWING_U[1], u);
    hc.rollT = CHASE_ROLL * L.xd * chase * (1 - landW);
    if (landW <= 0) return out;
    mixRig(out, landRig(L, tr, u, ts, hc.land), landW, out, 'land');
    const back = ss(LAND_TIME + 0.15, LAND_TIME + 0.15 + LAND_BLEND, ts);
    if (back >= 1) L.done = true;
    return mixRig(out, hc.two, back, out, 'back');
  }

  /**
   * The landing: a locked-off lens low and almost straight in front of where
   * he lands, looking up. He flies down into the shot (it pans down with him,
   * settled on the spot just before he touches down); it pushes in slowly
   * through the kneel; then holds its place, easing back a little and tilting
   * up with him as he rises.
   */
  function landRig(L, tr, u, ts, out) {
    const G = L.G;
    const down = L.touch >= 0;
    const push = down ? ss(0, LAND_HOLD + 0.2, ts) : 0;
    const rise = down ? ss(LAND_HOLD - 0.1, LAND_TIME, ts) : 0;
    const D = lerp(lerp(kneelDist(SIZE_KNEEL), kneelDist(SIZE_KNEEL_IN), push), shotDist(SIZE_RISE), rise);
    orbitDir(L.landAz, LAND_EL + 0.1 * rise, dir);
    A[0] = G[0] + dir[0] * D;
    A[1] = G[1] + dir[1] * D;
    A[2] = G[2] + dir[2] * D;
    // Looking between him and where he will touch down (his middle there), and more and more at that as he
    // nears it, so it pans little: he comes down into the frame. Once down, at him (see heroPoint: he
    // drops into the kneel, holds it, rises).
    const w = down ? 0 : lerp(LAND_LOOK, 1, ss(SWING_U[0], 0.9, u));
    for (let i = 0; i < 3; i++) P[i] = lerp(H[i], tr.to[i], w);
    const sy = down ? lerp(SHOT_Y_KNEEL * ss(0, 0.3, ts), shotY(D), rise) : 0;
    // (Kneeling he sweeps his left arm out, to the right of the frame from in front: on a narrow screen
    // he sits a little left of the middle to leave it room.)
    const sx = down ? KNEEL_SX * ss(1.2, 0.8, aspect()) * ss(0, 0.3, ts) * (1 - rise) : 0;
    aimFrom(A, P, sx, sy, out);
    return setEase(out, 0.22, 0.22, 0);
  }

  /**
   * The finale: his last leap filmed like any other; once he is down, a rising
   * orbit of the whole nebula (the keys), then back onto him resting with the
   * nebula behind him.
   */
  function shipTarget() {
    if (!ship) return setEase(copyRig(fromKey(makeKey(0, 0, fitDistance(B.radius, aspect(), 50, 0.92), run.camera.yaw, 0.4, 0), null), hc.out), 1.3, 1.5, 0);
    const k = sampleKeys(ship.keys, run.phaseT, key);
    const settled = Math.max(0, run.phaseT - SHIP_SETTLE);
    setEase(copyRig(fromKey(k, ship.cluster), hc.keyed), 1.3, 1.5, 0);
    const L = hc.leap && !hc.leap.done && hc.leap.id === run.travel?.id ? hc.leap : null;
    let hero = hc.two;
    if (L) hero = leapRig(hc.two, hc.out);
    // The last shot of him, the nebula behind him; once settled it drifts slowly on round, so it keeps breathing.
    compose(heroPoint(H), ship.finalYaw + ship.turn * 0.012 * settled, 0.2, shotDist(SIZE_REST), -0.12 * ship.turn, shotY(shotDist(SIZE_REST)), hc.rest);
    hero = mixRig(hero, setEase(hc.rest, 1.0, 1.3, 0.4), ss(9, 13, run.phaseT), hc.out, 'rest');
    // Pulled back once he is up from his last landing (or at once, if he only strolled to his rest).
    const since = run.t - run.phaseT;
    const leapt = hc.leap && run.travel && hc.leap.id === run.travel.id && run.travel.t0 >= since - 1e-6;
    const down = leapt ? (hc.leap.touch >= 0 ? hc.leap.touch - since : 1e6) : 0;
    const wide = ss(down + LAND_TIME + 0.2, down + LAND_TIME + 3.2, run.phaseT) * (1 - ss(12.6, 19.5, run.phaseT));
    // Back from him first (the distance and angles), and only then over to what the keys look at, so he
    // shrinks into the nebula rather than the camera swinging past him.
    const k2 = copyRig(hc.keyed, hc.pull);
    k2.x = hero.x;
    k2.y = hero.y;
    k2.z = hero.z;
    const look = wide * wide;
    mixRig(hero, k2, wide, hc.out, 'keys');
    hc.out.x = lerp(hc.out.x, hc.keyed.x, look);
    hc.out.y = lerp(hc.out.y, hc.keyed.y, look);
    hc.out.z = lerp(hc.out.z, hc.keyed.z, look);
    return hc.out;
  }

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

  function cameraTarget(dt) {
    const L = hc.leap && !hc.leap.done && hc.leap.id === run.travel?.id ? hc.leap : null;
    // The two-shot plans on whenever he is on his feet (it is frozen through the flight
    // and the landing, then restarts from the landing view).
    const sim = spider.sim;
    const flying = L && (sim.launched || sim.mode !== 'jump') && (L.touch < 0 || run.t - L.touch < LAND_HOLD);
    if (!flying) {
      updatePre();
      if (run.t >= hc.planAt) {
        planTwoShot();
        hc.planAt = run.t + PLAN_EVERY;
      }
      stepShot(dt);
    }
    twoShotRig(hc.two);
    if (run.phase === 'ship' || !clusters[run.active]) return shipTarget();
    let out = hc.two;
    if (run.active === 0 && (run.phase === 'boot' || run.phase === 'walk')) out = mixRig(openRig(hc.open), hc.two, ss(0.5, 6.0, run.t), hc.out, 'open');
    if (L) out = leapRig(out, hc.out);
    return out;
  }

  /** Backstops: the lens never comes nearer him than MIN_GAP, nor into a nucleus (eased out, so it can't fight the springs). */
  function guard(dt) {
    const cam = run.camera;
    orbitDir(cam.yaw, cam.pitch, dir);
    heroPoint(H);
    const ox = cam.x - H[0];
    const oy = cam.y - H[1];
    const oz = cam.z - H[2];
    const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    const disc = b * b - (ox * ox + oy * oy + oz * oz - MIN_GAP * MIN_GAP);
    if (disc > 0) {
      const near = -b - Math.sqrt(disc);
      const far = -b + Math.sqrt(disc);
      if (cam.dist > near && cam.dist < far) cam.dist = far;
    }
    const safe = clearDistance(cam.x, cam.y, cam.z, dir, cam.dist, clusters, NUCLEUS, 0, cam.dist);
    if (safe !== cam.dist) cam.dist += (safe - cam.dist) * (1 - Math.exp(-4 * dt));
  }

  function stepCamera(dt) {
    const tr = run.travel;
    if (tr && (!hc.leap || hc.leap.id !== tr.id)) beginLeap(tr);
    const L = hc.leap;
    if (L && tr && L.id === tr.id && L.touch < 0 && run.t > tr.t0 + tr.crouch + 0.05 && spider.sim.mode !== 'jump') touchdown(L);
    stepAirborne(dt);
    const d0 = run.camera.dist;
    const t = cameraTarget(dt);
    // The look-at runs ahead along his (smoothed) velocity by as much as the follow lags.
    const s = run.spider;
    const kv = 1 - Math.exp(-dt / 0.12);
    hc.vel[0] += (s.vx - hc.vel[0]) * kv;
    hc.vel[1] += (s.vy - hc.vel[1]) * kv;
    hc.vel[2] += (s.vz - hc.vel[2]) * kv;
    copyRig(t, aimT);
    const lead = t.lead * t.move;
    aimT.x += hc.vel[0] * lead;
    aimT.y += hc.vel[1] * lead;
    aimT.z += hc.vel[2] * lead;
    const cam = run.camera;
    if (hc.cutNow) {
      // A deliberate cut (to the landing): straight onto the new shot, nothing carried over.
      hc.cutNow = false;
      for (const k of ['x', 'y', 'z', 'dist', 'yaw', 'pitch']) cam[k] = aimT[k];
      cam.v = { x: 0, y: 0, z: 0, dist: 0, yaw: 0, pitch: 0 };
      cam.roll = hc.vRoll = 0;
      cam.cut++;
    } else {
      // Critically damped springs: every change of shot accelerates and settles, nothing lurches.
      followCamera(cam, aimT, dt, t.move, t.turn);
      // Never zoom faster than ZOOM_MAX (log distance per second), whatever the
      // shot asks for: a big change of size must not lurch.
      const step = Math.log(cam.dist / d0);
      if (Math.abs(step) > ZOOM_MAX * dt) {
        cam.dist = d0 * Math.exp(Math.sign(step) * ZOOM_MAX * dt);
        if (cam.v) cam.v.dist = clamp(cam.v.dist, -ZOOM_MAX, ZOOM_MAX);
      }
      // The bank (see leapRig), eased in and out.
      [cam.roll, hc.vRoll] = smoothDamp(cam.roll, hc.rollT, hc.vRoll, 0.5, dt);
    }
    hc.rollT = 0;
    guard(dt);
  }

  /* ---------------------------------------------------------- timeline */

  function setPhase(p) {
    run.phase = p;
    run.phaseT = 0;
  }

  function enterWalk(i) {
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
    if (i > 0) travelTo(run.spiderGoal, i);
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
      apex: first ? 16 : Math.max(24, L * range(cadence, 0.1, 0.15)), // low: he flies through the stars, not over them
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
    const land = sideFacing(c, run.spider);
    run.visit = { cluster: c.index };
    run.spiderGoal = { ...land };
    travelTo(run.spiderGoal, `x${c.index}`);
    visit = { c, land, exit: sideFacing(c, next), crawl: false, t0: 0, leaveAt: 0 };
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
