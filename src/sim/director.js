/**
 * The timeline. Owns every RunState mutation (except run.spider, which
 * Spider.update writes): boot, then walk + read for each section, then the
 * ship overview. Pure simulation, no DOM, deterministic at SIM_DT, so
 * seek(t) reproduces exactly what live playback would show.
 */

import { createRunState, MAX_TENTACLES, SIM_DT } from '../core/contracts.js';
import { computeScore } from '../analyze/score.js';
import { fitDistance, followCamera } from '../world/camera.js';
import { fork, range } from '../core/rng.js';
import { Spider } from '../world/spider.js';

const BOOT = 0.4;
const SHIP_SETTLE = 4;
const READ_SECONDS = 2.8; // target time to read a section
const LOG_CAP = 40;

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
  // Each section gets its own vantage point: a gentle sway left and right of
  // the previous one (alternating), low enough to look into the web.
  const camRand = fork(seed, 'camera');
  const angles = [];
  for (let i = 0; i < n; i++) {
    const prev = angles[i - 1];
    angles.push({
      yaw: prev ? prev.yaw + (i % 2 ? 1 : -1) * range(camRand, 0.2, 0.45) : camRand() * Math.PI * 2,
      pitch: range(camRand, 0.22, 0.48),
    });
  }
  let run;
  let spider;
  let cursor; // next word id to reach in the active section
  let readAcc;
  let recent; // read timestamps for words/second
  let scoreTick;
  let cadence;
  let nextReach;

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

  function reset() {
    run = createRunState(analysis);
    run.logSeq = 0;
    const c0 = world.clusters[0];
    // Start hanging above the first web; the opening is a descent into it.
    const start = c0 ? [c0.cx - c0.r * 0.5, c0.cy + c0.r * 1.1, c0.cz + c0.r * 0.3] : [0, 0, 0];
    spider = new Spider(start, seed, world);
    cadence = fork(seed, 'cadence');
    nextReach = 0;
    [run.spider.x, run.spider.y, run.spider.z] = spider.p;
    run.spiderGoal = { x: spider.p[0], y: spider.p[1], z: spider.p[2] };
    cursor = 0;
    readAcc = 0;
    recent = [];
    run.silk.push({ x: spider.p[0], y: spider.p[1], z: spider.p[2], s: 0, t: 0 });
    scoreTick = 0;
    run.camera = cameraTarget();
  }

  function log(verb, text, section) {
    run.log.push({ clock: clock(), verb, text, section });
    if (run.log.length > LOG_CAP) run.log.shift();
    run.logSeq++;
  }

  function cameraTarget() {
    const { width, height } = getStage();
    const aspect = width / Math.max(1, height);
    if (run.phase === 'ship' || !world.clusters[run.active]) {
      const b = world.bounds;
      const last = angles[Math.max(0, n - 1)] || { yaw: 0.6, pitch: 0.5 };
      return { x: b.x, y: b.y, z: b.z, dist: fitDistance(b.radius, aspect, 50, 0.92), yaw: last.yaw + run.phaseT * 0.025, pitch: 0.5 };
    }
    const c = world.clusters[run.active];
    const a = angles[run.active];
    const s = run.spider;
    // Travelling: ride along with the spider. Reading: look between it and its web, drifting slowly.
    const drift = run.phase === 'read' ? run.phaseT * 0.03 : 0;
    const push = run.phase === 'read' ? 1 - 0.14 * Math.min(1, run.phaseT / 5) : 1;
    const w = run.phase === 'walk' ? 0.78 : 0.5;
    return {
      x: s.x * w + c.cx * (1 - w),
      y: s.y * w + c.cy * (1 - w),
      z: s.z * w + c.cz * (1 - w),
      dist: fitDistance(c.r, aspect, 50, 0.95) * push,
      yaw: a.yaw + drift,
      pitch: a.pitch,
    };
  }

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
    const c = world.clusters[i];
    const w = centroid(sec.start, Math.min(sec.start + 6, sec.start + sec.count));
    run.spiderGoal = w ? { x: c.cx * 0.6 + w.x * 0.4, y: c.cy * 0.6 + w.y * 0.4, z: c.cz * 0.6 + w.z * 0.4 } : { x: c.cx, y: c.cy, z: c.cz };
    travelTo(run.spiderGoal, i);
  }

  /** Jump to a point: crouch, a floaty ballistic arc, landing (the spider follows run.travel). */
  function travelTo(goal, id) {
    const from = [run.spider.x, run.spider.y, run.spider.z];
    const to = [goal.x, goal.y, goal.z];
    const L = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1;
    const first = run.silk.length <= 1 && run.counts.read === 0;
    const crouch = first ? 0 : range(cadence, 0.18, 0.26);
    const air = Math.max(1.0, Math.min(1.9, 0.75 + L / 560));
    run.travel = {
      id: `${id}:${run.t.toFixed(3)}`,
      from,
      to,
      t0: run.t,
      crouch,
      air,
      apex: first ? 24 : Math.max(45, L * range(cadence, 0.24, 0.32)),
      dur: crouch + air + 0.32,
    };
  }

  function enterShip() {
    run.active = n;
    run.status.fill('done');
    setPhase('ship');
    // Rest on the cluster nearest the middle of the whole web.
    const b = world.bounds;
    let best = world.clusters[0];
    const dist = (c) => Math.hypot(c.cx - b.x, c.cy - b.y, c.cz - b.z);
    for (const c of world.clusters) if (dist(c) < dist(best)) best = c;
    if (best) {
      run.spiderGoal = { x: best.cx, y: best.cy, z: best.cz };
      travelTo(run.spiderGoal, 'ship');
    }
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
          markRead(tn.wordId);
        }
      } else if (tn.stage === 'hold') {
        if (age > tn.reach + tn.hold) tn.stage = 'retract';
      } else {
        tn.p -= dt / tn.retract;
        if (tn.p <= 0) run.tentacles.splice(i, 1);
      }
    }
  }

  function stepRead(dt) {
    const sec = analysis.sections[run.active];
    const end = sec.start + sec.count;
    // Irregular cadence: little flurries of reaches with hesitations between, like attention.
    const rate = Math.max(6, Math.min(28, sec.count / READ_SECONDS));
    readAcc += dt;
    while (readAcc >= nextReach && cursor < end) {
      const reaching = run.tentacles.reduce((k, tn) => k + (tn.stage !== 'retract' ? 1 : 0), 0);
      if (reaching >= MAX_TENTACLES) break;
      readAcc -= nextReach;
      nextReach = (cadence() < 0.3 ? range(cadence, 0.15, 0.5) : range(cadence, 0.8, 1.6)) / rate;
      run.wordState[cursor] = 1;
      run.tentacles.push({
        wordId: cursor,
        born: run.t,
        stage: 'reach',
        p: 0,
        reach: range(cadence, 0.22, 0.42),
        hold: range(cadence, 0.3, 0.75),
        retract: range(cadence, 0.25, 0.45),
      });
      cursor++;
    }
    if (cursor >= end) readAcc = 0;
    const c = world.clusters[run.active];
    const w = centroid(cursor, Math.min(end, cursor + 6));
    if (w) run.spiderGoal = { x: c.cx * 0.35 + w.x * 0.65, y: c.cy * 0.35 + w.y * 0.65, z: c.cz * 0.35 + w.z * 0.65 };
    if (cursor >= end && run.tentacles.length === 0) {
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
      if ((run.spider.arrived && run.phaseT > run.travel.dur + 0.15) || run.phaseT > run.travel.dur + 2) setPhase('read');
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

    // Spring smoothing (seconds): calm while reading, slow sweeping travel between sections.
    if (run.phase === 'walk') followCamera(run.camera, cameraTarget(), dt, 1.0, 2.4);
    else if (run.phase === 'ship') followCamera(run.camera, cameraTarget(), dt, 1.4, 1.4);
    else followCamera(run.camera, cameraTarget(), dt, 1.2, 2.2);
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
