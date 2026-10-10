/**
 * The fight between Iron Man and Thanos, scripted as motion-captured clips (world/mocap-clips.js) for each
 * of them, deterministic at SIM_DT (the director steps it; world/view3d.js plays it):
 *  - an exchange: one of them plays an attack; each hand the clip thrusts out fires a bolt at the other,
 *    landing a flight time later;
 *  - the other's answer to it, decided as it is fired: struck (a hit reaction as the bolt lands, a heavy
 *    blast knocking him down and getting him up again), or a dodge as it comes, or it goes wide;
 *  - his counter once he has recovered; now and then a strafe round each other, or a breath, between.
 * Each of them is carried over the ground along the clip's own path (so his feet stay planted), facing
 * the way the clip started him: at the other. Between clips he plays his fighting idle, turning to keep
 * his face to the other. If they drift too far apart Thanos walks in (no clip: the procedural walk).
 *
 * state (read by the view): { on, hero: Side, foe: Side, bolts }, where Side = { cur, prev } (the clip
 * playing and the one it eases in over: { clip, mirror, loop, t0 } or { clip: null } walking) and bolts =
 * [{ id, by, hand, tFire, tHit, power, miss }].
 */

import { fork, range } from '../core/rng.js';
import { clip, pathAt } from '../world/mocap-path.js';

const K = 46 / 3.585; // world units per model unit (world/ironman.js K)
export const FADE = 0.25; // s: a clip eases in over the one before
const IDLE = 'Fighting Idle';
const TURN = 1.6; // rad/s, at most, idling and turning to keep his face to the other
const BOLT_SPEED = 520; // world units/s (world/repulsor.js BOLT_SPEED), clamped to BOLT_T
const BOLT_T = [0.15, 0.35];
const NEAR = 55; // they keep between NEAR and FAR (= SPREAD x the stand-off) apart (world units): too far, Thanos
const SPREAD = 1.35; // walks in to the stand-off, even while Iron Man is still getting up
// What each of them throws: the clip, mirrored (left for right), which of its thrusts fire (by time, s),
// how often it is picked, and how heavy its blasts are (1: can knock him down).
const ATTACKS = {
  hero: [
    { clip: 'Standing 1H Magic Attack 01', mirror: false, fire: [{ hand: 'R', t: 0.933 }], odds: 3, power: 0.6 },
    { clip: 'Standing 2H Magic Attack 01', mirror: false, fire: [{ hand: 'R', t: 1.167 }, { hand: 'L', t: 1.333 }], odds: 2, power: 0.75 },
    { clip: 'Fireball', mirror: false, fire: [{ hand: 'R', t: 2.0 }], odds: 1, power: 1 },
  ],
  foe: [
    { clip: 'Fireball', mirror: true, fire: [{ hand: 'L', t: 2.0 }], odds: 2, power: 1 },
    { clip: 'Standing 1H Magic Attack 01', mirror: true, fire: [{ hand: 'L', t: 0.933 }], odds: 3, power: 0.7 },
    { clip: 'Standing 2H Magic Attack 05', mirror: false, fire: [{ hand: 'L', t: 0.6 }, { hand: 'R', t: 0.767 }, { hand: 'L', t: 2.1 }], odds: 1, power: 1 },
  ],
};
const HITS = ['Hit Reaction', 'Hit Reaction (1)', 'Hit Reaction (2)', 'Head Hit', 'Big Stomach Hit'];
const DOWNS = [
  ['Knocked Down', 'Getting Up'],
  ['Stumble Backwards', 'Getting Up'],
];
const DODGES = ['Dodging', 'Dodging (1)'];
const STRAFES = { L: 'Left Strafe Walking', R: 'Right Strafe Walk' };
// A heavy blast landing plays in slow motion: time runs at as little as 1 - SLOW_BY, from SLOW[0] s before
// it lands, back to speed by SLOW[1] s after (fight time).
const SLOW_BY = 0.7;
const SLOW = [0.12, 1.0];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const pick = (rand, list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
const pickOdds = (rand, list) => {
  let s = 0;
  for (const x of list) s += x.odds;
  let r = rand() * s;
  for (const x of list) if ((r -= x.odds) < 0) return x;
  return list[list.length - 1];
};

function side() {
  return { cur: null, prev: null, queue: [], x: 0, z: 0, yaw: 0, free: 0, attacked: -9 };
}

export function createFight(seed) {
  const rand = fork(seed, 'fight');
  const state = { on: false, hero: side(), foe: side(), bolts: [], heavy: [] };
  let nextId = -10;
  let nextBeat = 0;
  let lastBy = 'foe';
  let opening = false; // (an engagement opens with fire, not a strafe)
  let STAND = 80; // how far apart they fight (see begin)
  let FAR = STAND * SPREAD;
  const P = [0, 0];

  /** Start an act on a side at t (facing yaw), from where he stands. */
  function start(f, act, t) {
    f.prev = f.cur && f.cur.clip ? { ...f.cur, endedAt: t } : f.cur;
    act.t0 = t;
    act.yaw = act.yaw ?? f.yaw;
    act.lastP = [0, 0];
    f.cur = act;
  }

  const ends = (a) => (a.clip && !a.loop ? a.t0 + clip(a.clip).duration : Infinity);
  const busy = (f, t) => f.queue.length > 0 || (f.cur && f.cur.kind !== 'idle' && f.cur.kind !== 'strafe' && t < ends(f.cur));

  /**
   * Carry him on along his clip's path to t, turned to his facing as it is now (so a strafe that keeps
   * turning to face the other curves round him).
   */
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

  /** Plan the next beat at t: an exchange (whoever did not attack last, mostly), a strafe, or a breath. */
  function beat(t, d) {
    const r = rand();
    if (d > FAR) {
      // Too far apart: Thanos walks in on him (no clip: the procedural walk).
      start(state.foe, { clip: null, kind: 'walk' }, t);
      state.foe.walkTo = t + 2.5;
      nextBeat = t + 1.2;
      return;
    }
    if (!opening && r < 0.2 && d > NEAR) {
      // Circling: both strafe the same way round, a cycle or two.
      const dir = rand() < 0.5 ? 'L' : 'R';
      const cycles = rand() < 0.75 ? 1 : 2;
      for (const k of ['hero', 'foe']) {
        const name = STRAFES[dir];
        start(state[k], { clip: name, mirror: false, loop: true, kind: 'strafe', until: t + cycles * clip(name).duration }, t);
      }
      nextBeat = t + cycles * clip(STRAFES[dir]).duration + range(rand, 0.2, 0.5);
      return;
    }
    const by = rand() < 0.7 ? (lastBy === 'hero' ? 'foe' : 'hero') : lastBy;
    opening = false;
    exchange(by, t, d);
  }

  /** `by` attacks the other at t; the other's answer is decided now, as it will be fired. */
  function exchange(by, t, d) {
    const A = state[by];
    const B = state[by === 'hero' ? 'foe' : 'hero'];
    const atk = pickOdds(rand, ATTACKS[by]);
    start(A, { clip: atk.clip, mirror: atk.mirror, loop: false, kind: 'attack' }, t);
    A.queue.length = 0;
    lastBy = by;
    const r = rand();
    const outcome = r < 0.55 ? 'hit' : r < 0.85 ? 'dodge' : 'miss';
    const heavy = outcome === 'hit' && atk.power >= 1 && rand() < 0.6;
    let first = Infinity;
    atk.fire.forEach((f, i) => {
      const tFire = t + f.t;
      const tHit = tFire + Math.min(BOLT_T[1], Math.max(BOLT_T[0], d / BOLT_SPEED));
      // (After the first, the rest of a volley follow it: a dodge evades them all, a hit lands them all.)
      state.bolts.push({ id: nextId--, by, hand: f.hand, tFire, tHit, power: heavy ? 1 : atk.power, miss: outcome !== 'hit' });
      if (i === 0) first = tHit;
    });
    const firstFire = t + atk.fire[0].t;
    if (outcome === 'hit') {
      if (heavy) {
        state.heavy.push(first);
        const [down, up] = pick(rand, DOWNS);
        B.queue = [
          { at: first - 0.02, act: { clip: down, mirror: rand() < 0.5, loop: false, kind: 'react' } },
          { at: first - 0.02 + clip(down).duration - FADE, act: { clip: up, mirror: false, loop: false, kind: 'react' } },
        ];
        nextBeat = first + clip(down).duration + clip(up).duration + range(rand, 0.3, 0.7);
      } else {
        B.queue = [{ at: first - 0.02, act: { clip: pick(rand, HITS), mirror: rand() < 0.5, loop: false, kind: 'react' } }];
        nextBeat = Math.max(t + clip(atk.clip).duration, first + 1.2) + range(rand, 0.1, 0.5);
      }
    } else if (outcome === 'dodge') {
      const name = pick(rand, DODGES);
      B.queue = [{ at: firstFire - 0.2, act: { clip: name, mirror: rand() < 0.5, loop: false, kind: 'dodge' } }];
      nextBeat = Math.max(t + clip(atk.clip).duration, firstFire + clip(name).duration) + range(rand, 0.1, 0.4);
    } else nextBeat = t + clip(atk.clip).duration + range(rand, 0.1, 0.4);
  }

  return {
    state,
    /** The engagement begins at t, the two of them where they stand, to be fought `stand` apart. */
    begin(t, hero, foe, stand = 80) {
      state.on = true;
      STAND = stand;
      FAR = stand * SPREAD;
      for (const [k, p] of [['hero', hero], ['foe', foe]]) {
        const f = state[k];
        f.x = p.x;
        f.z = p.z;
        f.yaw = p.yaw;
        f.queue.length = 0;
        f.cur = null;
        start(f, { clip: IDLE, mirror: false, loop: true, kind: 'idle' }, t);
      }
      nextBeat = t + range(rand, 0.5, 0.9);
      opening = true;
    },
    /** It is over (he is taking off): the clips ease out, the bolts in the air finish. */
    end(t) {
      if (!state.on) return;
      state.on = false;
      for (const k of ['hero', 'foe']) {
        const f = state[k];
        f.queue.length = 0;
        start(f, { clip: null, kind: 'none' }, t);
      }
      state.bolts = state.bolts.filter((b) => b.tFire <= t);
    },
    /** Whether he is free to leave (standing in his idle, nothing coming). */
    calm(t) {
      return !busy(state.hero, t) && !busy(state.foe, t) && !state.bolts.some((b) => b.tHit > t);
    },
    /**
     * Advance to t: start what is due, carry each along his clip, keep the idle faces turned to each other,
     * plan the next beat. `winding` (the section's words are done): no new exchanges, so he comes to rest.
     */
    step(t, dt, winding) {
      if (!state.on) {
        state.bolts = state.bolts.filter((b) => t < b.tHit + 1.5);
        return;
      }
      const H = state.hero;
      const F = state.foe;
      for (const [f, o] of [[H, F], [F, H]]) {
        // Due next: a struck fighter's attack is cut short (and its bolts not yet fired with it).
        while (f.queue.length && f.queue[0].at <= t) {
          const q = f.queue.shift();
          if (f.cur && f.cur.kind === 'attack') {
            const who = f === H ? 'hero' : 'foe';
            state.bolts = state.bolts.filter((b) => !(b.by === who && b.tFire > t));
          }
          q.act.yaw = Math.atan2(o.z - f.z, o.x - f.x);
          start(f, q.act, t);
        }
        const a = f.cur;
        // A clip run out (or a strafe or walk over): back to his idle, facing the other.
        if (a && ((a.clip && !a.loop && t >= ends(a)) || (a.until && t >= a.until) || (a.kind === 'walk' && (t >= f.walkTo || Math.hypot(o.x - f.x, o.z - f.z) < STAND + 5)))) {
          carry(f, t);
          start(f, { clip: IDLE, mirror: false, loop: true, kind: 'idle', yaw: Math.atan2(o.z - f.z, o.x - f.x) }, t);
        }
        carry(f, t);
        if (f.cur.kind === 'idle' || f.cur.kind === 'strafe') {
          const want = Math.atan2(o.z - f.z, o.x - f.x);
          const turn = wrap(want - f.cur.yaw);
          f.cur.yaw += Math.sign(turn) * Math.min(Math.abs(turn), TURN * dt);
        }
        f.yaw = f.cur.yaw ?? f.yaw;
      }
      // Thrown too far apart: Thanos walks in on him at once, whatever Iron Man is doing.
      const d = Math.hypot(F.x - H.x, F.z - H.z);
      if (d > FAR && F.cur && F.cur.kind === 'idle' && !F.queue.length) {
        start(F, { clip: null, kind: 'walk' }, t);
        F.walkTo = t + 3;
      }
      if (!winding && t >= nextBeat && !busy(H, t) && !busy(F, t) && F.cur.kind !== 'walk') beat(t, d);
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
    /** Each one's pin for his walker (null while he walks on his own). */
    pin(k) {
      const f = state[k];
      if (!state.on || !f.cur || !f.cur.clip) return null;
      return { x: f.x, z: f.z, yaw: f.yaw };
    },
    /** Where Thanos walks to, when he walks in (world x, z). */
    walkGoal() {
      const H = state.hero;
      const F = state.foe;
      const d = Math.hypot(F.x - H.x, F.z - H.z) || 1;
      return { x: H.x + ((F.x - H.x) / d) * STAND, z: H.z + ((F.z - H.z) / d) * STAND };
    },
    /** Track where the walker actually is (when he walks on his own). */
    at(k, x, z, yaw) {
      const f = state[k];
      if (f.cur && f.cur.clip) return;
      f.x = x;
      f.z = z;
      f.yaw = yaw;
    },
  };
}
