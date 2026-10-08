/**
 * The timeline. Owns every RunState mutation (except run.spider, which
 * Spider.update writes): boot, then walk + read for each section, then the
 * ship overview. Pure simulation, no DOM, deterministic at SIM_DT, so
 * seek(t) reproduces exactly what live playback would show.
 */

import { createRunState, MAX_TENTACLES, SIM_DT } from '../core/contracts.js';
import { computeScore } from '../analyze/score.js';
import { fitBounds, followCamera } from '../world/camera.js';
import { Spider } from '../world/spider.js';

const BOOT = 0.8;
const REACH = 0.18;
const HOLD = 0.35;
const RETRACT = 0.2;
const SHIP_SETTLE = 1.5;
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
  let run;
  let spider;
  let cursor; // next word id to reach in the active section
  let readAcc;
  let recent; // read timestamps for words/second
  let scoreTick;

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
    spider = new Spider(c0 ? c0.cx : 0, c0 ? c0.cy : 0, seed, world);
    run.spider.x = spider.x;
    run.spider.y = spider.y;
    run.spiderGoal = { x: spider.x, y: spider.y };
    cursor = 0;
    readAcc = 0;
    recent = [];
    run.silk.push({ x: spider.x, y: spider.y, s: 0, t: 0 });
    scoreTick = 0;
    Object.assign(run.camera, cameraTarget());
  }

  function log(verb, text, section) {
    run.log.push({ clock: clock(), verb, text, section });
    if (run.log.length > LOG_CAP) run.log.shift();
    run.logSeq++;
  }

  function cameraTarget() {
    const { width, height } = getStage();
    if (run.phase === 'ship' || !world.clusters[run.active]) {
      return fitBounds(world.bounds, width, height, Math.min(width, height) * 0.1);
    }
    const c = world.clusters[run.active];
    const zoom = Math.max(0.6, Math.min(1.8, (0.7 * Math.min(width, height)) / (2 * c.r)));
    return { x: run.spider.x * 0.7 + c.cx * 0.3, y: run.spider.y * 0.7 + c.cy * 0.3, zoom };
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
    run.spiderGoal = w ? { x: c.cx * 0.6 + w.x * 0.4, y: c.cy * 0.6 + w.y * 0.4 } : { x: c.cx, y: c.cy };
  }

  function enterShip() {
    run.active = n;
    run.status.fill('done');
    setPhase('ship');
    // Rest on the cluster nearest the middle of the whole web.
    const mx = (world.bounds.minX + world.bounds.maxX) / 2;
    const my = (world.bounds.minY + world.bounds.maxY) / 2;
    let best = world.clusters[0];
    for (const c of world.clusters) {
      if (Math.hypot(c.cx - mx, c.cy - my) < Math.hypot(best.cx - mx, best.cy - my)) best = c;
    }
    if (best) run.spiderGoal = { x: best.cx, y: best.cy };
  }

  function centroid(from, to) {
    if (to <= from) return null;
    let x = 0;
    let y = 0;
    for (let id = from; id < to; id++) {
      x += world.wordPos[id * 2];
      y += world.wordPos[id * 2 + 1];
    }
    return { x: x / (to - from), y: y / (to - from) };
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
        tn.p = Math.min(1, age / REACH);
        if (tn.p >= 1) {
          tn.stage = 'hold';
          markRead(tn.wordId);
        }
      } else if (tn.stage === 'hold') {
        if (age > REACH + HOLD) tn.stage = 'retract';
      } else {
        tn.p -= dt / RETRACT;
        if (tn.p <= 0) run.tentacles.splice(i, 1);
      }
    }
  }

  function stepRead(dt) {
    const sec = analysis.sections[run.active];
    const end = sec.start + sec.count;
    const rate = Math.max(8, Math.min(40, sec.count / 1.9));
    readAcc += dt;
    while (readAcc >= 1 / rate && cursor < end) {
      const reaching = run.tentacles.reduce((k, tn) => k + (tn.stage !== 'retract' ? 1 : 0), 0);
      if (reaching >= MAX_TENTACLES) break;
      readAcc -= 1 / rate;
      run.wordState[cursor] = 1;
      run.tentacles.push({ wordId: cursor, born: run.t, stage: 'reach', p: 0 });
      cursor++;
    }
    if (cursor >= end) readAcc = 0;
    const c = world.clusters[run.active];
    const w = centroid(cursor, Math.min(end, cursor + 6));
    if (w) run.spiderGoal = { x: c.cx * 0.35 + w.x * 0.65, y: c.cy * 0.35 + w.y * 0.65 };
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
      const g = run.spiderGoal;
      if (Math.hypot(run.spider.x - g.x, run.spider.y - g.y) < 30 || run.phaseT > 3.5) setPhase('read');
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

    followCamera(run.camera, cameraTarget(), dt, run.phase === 'ship' ? 2 : 2.6);
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
