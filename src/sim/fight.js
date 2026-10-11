/**
 * The fight between Iron Man and Thanos, as the films have them fight, deterministic at SIM_DT (the
 * director steps it; world/view3d.js plays it). Each engagement runs as rounds of beats:
 *  1. the stare-down: both stand, Iron Man upright and ready, Thanos tall and still;
 *  2. Iron Man opens up: repulsors, palm out, arm straight, one hand then the other, side-stepping as
 *     he fires; Thanos walks on into it, catching blasts on the raised gauntlet, barely flinching at
 *     the rest;
 *  3. Thanos answers: he plants and fires the Power Stone from his clenched gauntlet fist; Iron Man
 *     dodges the first on his boot jets and takes the next (a hit reaction; later rounds, knocked down,
 *     getting up again);
 *  4. Iron Man's heavy blast, both palms: it staggers Thanos a step back.
 * Rounds repeat (escalating) while the section's words are read; then Iron Man leaves for the next ball.
 * Captured motion (world/mocap-clips.js) plays Iron Man's side-steps, dodges, hit reactions, knockdowns
 * and getting up, and Thanos's stagger; the rest (stance, repulsor and gauntlet firing, the block,
 * Thanos's walk) is the rig's own procedural animation. A clip carries him along its own path (his
 * walker pinned to it, feet planted); otherwise he stands or walks on his own, facing the other.
 *
 * state (read by the view): { on, hero: Side, foe: Side, bolts }, Side = { cur, prev } where an act is
 * { kind, clip|null, mirror, loop, t0, aim: 'L'|'R'|'both'|null, block, thrust, weight } and a bolt is
 * { id, by, hand, tFire, tHit, power, outcome: 'hit'|'block'|'dodge'|'miss' }.
 */

import { fork, range } from '../core/rng.js';
import { clip, pathAt } from '../world/mocap-path.js';

const K = 46 / 3.585; // world units per model unit (world/ironman.js K)
export const FADE = 0.3; // s: a clip eases in over what was playing
const TURN = 1.4; // rad/s, at most, standing and turning to keep his face to the other
const BOLT_SPEED = 520; // world units/s (world/repulsor.js BOLT_SPEED), clamped to BOLT_T
const BOLT_T = [0.15, 0.35];
const SPREAD = 1.4; // thrown further apart than this x the stand-off, Thanos walks back in
const HITS = ['Hit Reaction', 'Hit Reaction (1)', 'Head Hit', 'Big Stomach Hit'];
const STAGGER = 'Hit Reaction (2)'; // Thanos's stagger, played at a weight (he is not thrown about)
const STAGGER_W = 0.65;
const STRAFE = { L: 'Left Strafe Walking', R: 'Right Strafe Walk' };
// A heavy blast landing plays in slow motion: time runs at as little as 1 - SLOW_BY, from SLOW[0] s before
// it lands, back to speed by SLOW[1] s after (fight time).
const SLOW_BY = 0.7;
const SLOW = [0.12, 1.0];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const pick = (rand, list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

function side() {
  return { cur: null, prev: null, queue: [], x: 0, z: 0, yaw: 0 };
}

export function createFight(seed) {
  const rand = fork(seed, 'fight');
  const state = { on: false, hero: side(), foe: side(), bolts: [], heavy: [] };
  let nextId = -10;
  let round = 0;
  let beat = 0; // which beat of the round is next
  let nextAt = 0; // when it starts
  let STAND = 80; // how far apart they fight (see begin)
  const P = [0, 0];

  /** Start an act on a side at t, facing yaw (by default where he faces). */
  function start(f, act, t) {
    f.prev = f.cur && f.cur.clip ? { ...f.cur } : f.cur;
    act.t0 = t;
    act.yaw = act.yaw ?? f.yaw;
    act.lastP = [0, 0];
    f.cur = act;
  }
  const stand = (extra = {}) => ({ kind: 'stand', clip: null, ...extra });
  const ends = (a) => (a.until !== undefined ? a.until : a.clip && !a.loop ? a.t0 + clip(a.clip).duration : Infinity);

  /** Carry him on along his clip's path to t, turned to his facing as it is now. */
  function carry(f, t) {
    const a = f.cur;
    if (!a || !a.clip) return;
    pathAt(a.clip, t - a.t0, a.loop, a.mirror, P);
    const dx = P[0] - a.lastP[0];
    const dz = P[1] - a.lastP[1];
    a.lastP[0] = P[0];
    a.lastP[1] = P[1];
    // (The clip's +z is his front, +x his left: his front is (cos yaw, sin yaw), his left (sin yaw, -cos yaw).)
    const c = Math.cos(a.yaw);
    const s = Math.sin(a.yaw);
    f.x += (dz * c + dx * s) * K;
    f.z += (dz * s - dx * c) * K;
  }

  const dist = () => Math.hypot(state.foe.x - state.hero.x, state.foe.z - state.hero.z);
  const flight = () => Math.min(BOLT_T[1], Math.max(BOLT_T[0], dist() / BOLT_SPEED));
  function bolt(by, hand, tFire, power, outcome) {
    const b = { id: nextId--, by, hand, tFire, tHit: tFire + flight(), power, outcome };
    state.bolts.push(b);
    return b;
  }
  /** Queue an act for a side at time `at`. */
  const queue = (f, at, act) => f.queue.push({ at, act });

  /* ---- the beats: each schedules both sides from t, and returns when the next may start ---- */

  /** The stare-down. */
  function stare(t) {
    start(state.hero, stand(), t);
    start(state.foe, stand(), t);
    return t + range(rand, 0.9, 1.4);
  }

  /** Iron Man opens up, side-stepping; Thanos walks on into it, the gauntlet up for some. */
  function volley(t) {
    const H = state.hero;
    const F = state.foe;
    const dir = rand() < 0.5 ? 'L' : 'R';
    const n = 3 + Math.floor(rand() * 3) + Math.min(2, round);
    const gap = range(rand, 0.32, 0.42);
    const dur = 0.45 + n * gap + 0.4;
    start(H, { kind: 'repulsor', clip: STRAFE[dir], mirror: false, loop: true, aim: 'both', until: t + dur }, t);
    start(F, { kind: 'advance', clip: null, until: t + dur, block: 1 }, t);
    let hand = rand() < 0.5 ? 'L' : 'R';
    for (let i = 0; i < n; i++) {
      const tFire = t + 0.45 + i * gap + range(rand, -0.05, 0.05);
      const r = rand();
      // Thanos catches about half on the gauntlet; the rest he takes, or they go wide.
      const outcome = r < 0.45 ? 'block' : r < 0.85 ? 'hit' : 'miss';
      bolt('hero', hand, tFire, 0.5, outcome);
      hand = hand === 'L' ? 'R' : 'L';
    }
    return t + dur;
  }

  /** Thanos plants and fires from the gauntlet; Iron Man dodges the first on his jets, takes the next. */
  function answer(t) {
    const H = state.hero;
    const F = state.foe;
    const shots = 2 + (round >= 2 && rand() < 0.5 ? 1 : 0);
    const charge = range(rand, 0.55, 0.75);
    const gap = range(rand, 0.75, 0.95);
    start(F, { kind: 'gauntlet', clip: null, aim: 'L', until: t + charge + shots * gap + 0.4 }, t);
    start(H, stand(), t);
    let end = t + charge + shots * gap + 0.6;
    let down = false;
    for (let i = 0; i < shots; i++) {
      const tFire = t + charge + i * gap;
      // The first he sees coming and dodges; the next finds him (from the second round, it may put him down).
      const heavy = i > 0 && !down && round >= 1 && rand() < 0.45;
      const outcome = i === 0 ? 'dodge' : 'hit';
      const b = bolt('foe', 'L', tFire, heavy ? 1 : 0.8, outcome);
      if (outcome === 'dodge') {
        queue(H, tFire - 0.25, { kind: 'dodge', clip: 'Dodging (1)', mirror: rand() < 0.5, loop: false, thrust: 1 });
      } else if (heavy) {
        down = true;
        state.heavy.push(b.tHit);
        queue(H, b.tHit - 0.02, { kind: 'react', clip: 'Knocked Down', mirror: false, loop: false });
        queue(H, b.tHit - 0.02 + clip('Knocked Down').duration - FADE, { kind: 'react', clip: 'Getting Up', mirror: false, loop: false });
        end = Math.max(end, b.tHit + clip('Knocked Down').duration + clip('Getting Up').duration);
      } else {
        queue(H, b.tHit - 0.02, { kind: 'react', clip: pick(rand, HITS), mirror: rand() < 0.5, loop: false });
        end = Math.max(end, b.tHit + 1.4);
      }
    }
    return end + range(rand, 0.2, 0.5);
  }

  /** Iron Man's heavy blast, both palms: Thanos staggers back. */
  function heavy(t) {
    const H = state.hero;
    const F = state.foe;
    const tFire = t + range(rand, 0.6, 0.8);
    start(H, stand({ kind: 'repulsor', aim: 'both', until: tFire + 0.6 }), t);
    start(F, stand(), t);
    const L = bolt('hero', 'L', tFire, 1, 'hit');
    bolt('hero', 'R', tFire + 0.03, 1, 'hit');
    state.heavy.push(L.tHit);
    queue(F, L.tHit - 0.02, { kind: 'react', clip: STAGGER, mirror: rand() < 0.5, loop: false, weight: STAGGER_W });
    return L.tHit + clip(STAGGER).duration * 0.8;
  }

  const BEATS = [stare, volley, answer, heavy];

  return {
    state,
    /** The engagement begins at t, the two of them where they stand, to be fought `stand` apart. */
    begin(t, hero, foe, stand = 80) {
      state.on = true;
      STAND = stand;
      round = 0;
      beat = 0;
      for (const [k, p] of [['hero', hero], ['foe', foe]]) {
        const f = state[k];
        f.x = p.x;
        f.z = p.z;
        f.yaw = p.yaw;
        f.queue.length = 0;
        f.cur = null;
        f.prev = null;
      }
      nextAt = t;
    },
    /** It is over (he is taking off): the clips ease out, the bolts in the air finish. */
    end(t) {
      if (!state.on) return;
      state.on = false;
      for (const k of ['hero', 'foe']) {
        const f = state[k];
        f.queue.length = 0;
        start(f, { kind: 'none', clip: null }, t);
      }
      state.bolts = state.bolts.filter((b) => b.tFire <= t);
    },
    /** Whether he may leave: the round's beat over, nothing coming, both on their feet. */
    calm(t) {
      const busy = (f) => f.queue.length > 0 || (f.cur && f.cur.kind !== 'stand' && f.cur.kind !== 'advance' && t < ends(f.cur));
      return t >= nextAt && !busy(state.hero) && !busy(state.foe) && !state.bolts.some((b) => b.tHit > t);
    },
    /**
     * Advance to t: start what is due, carry each along his clip, keep faces turned to each other, run the
     * next beat when it is time. `winding` (the section's words are done): no new round.
     */
    step(t, dt, winding) {
      if (!state.on) {
        state.bolts = state.bolts.filter((b) => t < b.tHit + 1.5);
        return;
      }
      const H = state.hero;
      const F = state.foe;
      if (t >= nextAt && !(winding && beat === 0)) {
        nextAt = BEATS[beat](t);
        beat = (beat + 1) % BEATS.length;
        if (beat === 0) round++;
      }
      for (const [f, o] of [[H, F], [F, H]]) {
        while (f.queue.length && f.queue[0].at <= t) {
          const q = f.queue.shift();
          q.act.yaw = Math.atan2(o.z - f.z, o.x - f.x);
          start(f, q.act, t);
        }
        const a = f.cur;
        // An act run out: back to standing, facing the other.
        if (a && t >= ends(a) && a.kind !== 'stand') {
          carry(f, t);
          start(f, stand({ yaw: Math.atan2(o.z - f.z, o.x - f.x) }), t);
        }
        carry(f, t);
        // Standing, firing or side-stepping: his face kept to the other.
        if (!f.cur.clip || f.cur.kind === 'repulsor') {
          const want = Math.atan2(o.z - f.z, o.x - f.x);
          const turn = wrap(want - f.cur.yaw);
          f.cur.yaw += Math.sign(turn) * Math.min(Math.abs(turn), TURN * dt);
        }
        f.yaw = f.cur.yaw;
      }
      // Thrown too far apart, Thanos walks back in on him.
      if (F.cur.kind === 'stand' && !F.queue.length && dist() > STAND * SPREAD) start(F, { kind: 'advance', clip: null, until: t + 3 }, t);
      if (F.cur.kind === 'advance' && dist() < STAND * 0.85) F.cur.until = Math.min(F.cur.until, t);
      state.bolts = state.bolts.filter((b) => t < b.tHit + 1.5);
    },
    /** How fast time runs at t (1: normal; a heavy blast landing slows it, see SLOW). */
    timeScale(t) {
      let k = 0;
      for (const h of state.heavy) {
        const u = t - h;
        if (u < -SLOW[0] || u > SLOW[1]) continue;
        const rise = u < 0 ? 1 - (u / -SLOW[0]) ** 2 : 1;
        const fall = u > 0.25 ? 1 - ((u - 0.25) / (SLOW[1] - 0.25)) ** 2 : 1;
        k = Math.max(k, Math.max(0, rise) * Math.max(0, fall));
      }
      if (state.heavy.length > 8) state.heavy.splice(0, state.heavy.length - 8);
      return 1 - SLOW_BY * k;
    },
    /** His walker's pin while a clip carries him (else null: he stands or walks on his own). */
    pin(k) {
      const f = state[k];
      if (!state.on || !f.cur || !f.cur.clip) return null;
      return { x: f.x, z: f.z, yaw: f.yaw };
    },
    /** Whether he is walking in (Thanos advancing). */
    walking(k) {
      const f = state[k];
      return !!(state.on && f.cur && f.cur.kind === 'advance');
    },
    /** Where Thanos walks in to (world x, z). */
    walkGoal() {
      const H = state.hero;
      const F = state.foe;
      const d = dist() || 1;
      return { x: H.x + ((F.x - H.x) / d) * STAND * 0.8, z: H.z + ((F.z - H.z) / d) * STAND * 0.8 };
    },
    /** Track where the walker actually is (when no clip carries him). */
    at(k, x, z, yaw) {
      const f = state[k];
      if (f.cur && f.cur.clip) return;
      f.x = x;
      f.z = z;
      if (!f.cur || f.cur.kind === 'advance' || f.cur.kind === 'none') f.yaw = yaw;
    },
  };
}
