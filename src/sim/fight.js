/**
 * The fight between Iron Man and Thanos, as the films have them fight, deterministic at SIM_DT (the
 * director steps it; world/view3d.js plays it). Each engagement runs as rounds of beats:
 *  1. the stand-off: Iron Man lifts off on his jets and holds in the air; Thanos stands his ground;
 *  2. Iron Man opens up from the air, palms out, one hand then the other, drifting sideways as he fires;
 *     Thanos walks on into it, catching blasts on the raised gauntlet, barely flinching at the rest;
 *  3. Thanos answers with the Power Stone from his clenched gauntlet fist: Iron Man jinks clear of the
 *     first on his jets; the next knocks him out of the sky, and he comes down in a hard landing;
 *  4. Thanos walks in on him and takes it hand to hand: a punch Iron Man blocks, a repulsor point-blank
 *     in Thanos's face, and Thanos's lunging swipe that lands and throws him back;
 *  5. Iron Man lifts off again and puts both palms into a heavy blast: it staggers Thanos; he drops
 *     back down to the ground.
 * Rounds repeat while the section's words are read; then Thanos withdraws and Iron Man leaves for the
 * next ball. Captured motion (world/mocap-clips.js) plays both of them; the arms that fire and block
 * (repulsors, the gauntlet raised or clenched to fire) are the rig's own procedural aim over the clip.
 * A clip carries him along its own path (his walker pinned to it, feet planted); in the air he is held
 * at an altitude (alt, world units) over his walker, eased up and down, or falling when knocked down.
 *
 * state (read by the view and the camera): { on, hero: Side, foe: Side, bolts, heavy, impacts }, Side =
 * { cur, prev, alt } where an act is { kind, clip|null, mirror, loop, t0, aim: 'L'|'R'|'both'|null,
 * block, thrust, weight, alt }, a bolt is { id, by, hand, tFire, tHit, power, outcome:
 * 'hit'|'block'|'dodge'|'miss' } and an impact (a blow worth a close shot) is { t, victim: 'hero'|'foe' }.
 */

import { fork, range } from '../core/rng.js';
import { clip, pathAt } from '../world/mocap-path.js';

const K = 46 / 3.585; // world units per model unit (world/ironman.js K)
const FOE_K = K * 1.12; // ... for Thanos, drawn bigger (world/ironman.js THANOS_SIZE)
export const FADE = 0.3; // s: a clip eases in over what was playing
const TURN = 1.4; // rad/s, at most, standing and turning to keep his face to the other
const BOLT_SPEED = 520; // world units/s (world/repulsor.js BOLT_SPEED), clamped to BOLT_T
const BOLT_T = [0.15, 0.35];
const SPREAD = 1.4; // thrown further apart than this x the stand-off, Thanos walks back in
const STAGGER = 'Hit Reaction (2)'; // Thanos's stagger, played at a weight (he is not thrown about)
const STAGGER_W = 0.65;
// Iron Man in the air: hovering (the clip's hips ride a little high), drifting sideways as he fires,
// jinking clear of a blast; knocked out of the sky he falls (G) into a hard landing.
const I_HOVER = 'Floating';
const I_LAND = 'Hard Landing';
const I_BLOCK = 'Body Block';
const I_THROWN = ['Receiving A Big Uppercut', 'Receiving An Uppercut'];
const I_SKY_HIT = 'Receiving A Big Uppercut';
const HOVER = 20; // world units over the ground
const ALT_T = 0.35; // s: how long lifting off or settling takes
const DRIFT = 14; // world units/s, sideways, firing from the air
const JINK = 70; // ... and jinking clear of a blast
const G = 320; // world units/s^2
// Thanos: a heavy, breathing stance; a slow, weighted walk; hand to hand, a swipe and a punch.
const T_IDLE = 'Mutant Breathing Idle';
const T_WALK = 'Mutant Walking';
const T_SWIPE = 'Mutant Swiping';
const T_PUNCH = 'Mutant Punch';
const T_FLINCH = 'Head Hit';
const WALK_V = (Math.hypot(...clip(T_WALK).end) / clip(T_WALK).duration) * FOE_K; // world units/s
const CLOSE = 26; // hand to hand, this far apart (world units): the punch's reach; the swipe lunges in from it
const ADVANCE_TO = 0.6; // under a volley he walks in to this x the stand-off
// (Acts in which he turns to keep his face to the other.)
const TURNS = new Set(['stand', 'repulsor', 'advance', 'gauntlet', 'dodge']);
// A heavy blast landing plays in slow motion: time runs at as little as 1 - SLOW_BY, from SLOW[0] s before
// it lands, back to speed by SLOW[1] s after (fight time).
const SLOW_BY = 0.7;
const SLOW = [0.12, 1.0];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const pick = (rand, list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

function side(k, idle) {
  return { cur: null, prev: null, queue: [], x: 0, z: 0, yaw: 0, k, idle, alt: 0, altV: 0, falling: false };
}

/** A critically damped step of x toward `to` (settling in about T s). */
function spring(x, v, to, T, dt) {
  const w = 2 / T;
  v += (w * w * (to - x) - 2 * w * v) * dt;
  return [x + v * dt, v];
}

export function createFight(seed) {
  const rand = fork(seed, 'fight');
  const state = { on: false, hero: side(K, null), foe: side(FOE_K, T_IDLE), bolts: [], heavy: [], impacts: [] };
  let nextId = -10;
  let round = 0;
  let beat = 0; // which beat of the round is next
  let nextAt = 0; // when it starts
  let STAND = 80; // how far apart they fight (see begin)
  const P = [0, 0];
  const H = state.hero;
  const F = state.foe;

  /** Start an act on a side at t, facing yaw (by default where he faces). */
  function start(f, act, t) {
    f.prev = f.cur && f.cur.clip ? { ...f.cur } : f.cur;
    act.t0 = t;
    act.yaw = act.yaw ?? f.yaw;
    act.lastP = [0, 0];
    f.cur = act;
    // (Knocked out of the air: up a little with the blow, then down.)
    if (act.fall && f.alt > 1) {
      f.falling = true;
      f.altV = 30;
    }
  }
  const stand = (extra = {}) => ({ kind: 'stand', clip: null, ...extra });
  const hover = (extra = {}) => ({ kind: 'stand', clip: I_HOVER, loop: true, alt: HOVER, ...extra });
  /** Standing as he stands: Thanos in his breathing stance; Iron Man, if he is up, hovering. */
  const standFor = (f, extra = {}) =>
    f.idle ? stand({ clip: f.idle, loop: true, ...extra }) : f.cur && f.cur.alt > 0 && extra.alt !== 0 ? hover(extra) : stand(extra);
  const walkIn = (until, extra = {}) => ({ kind: 'advance', clip: T_WALK, loop: true, until, ...extra });
  const ends = (a) => (a.until !== undefined ? a.until : a.clip && !a.loop ? a.t0 + clip(a.clip).duration : Infinity);
  const facing = (f, o) => Math.atan2(o.z - f.z, o.x - f.x);

  /** Carry him on along his clip's path to t, turned to his facing as it is now (and drifting, in the air). */
  function carry(f, t, dt) {
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
    f.x += (dz * c + dx * s) * f.k;
    f.z += (dz * s - dx * c) * f.k;
    if (a.drift) {
      f.x += s * a.drift * dt;
      f.z -= c * a.drift * dt;
    }
  }

  const dist = () => Math.hypot(F.x - H.x, F.z - H.z);
  const flight = () => Math.min(BOLT_T[1], Math.max(BOLT_T[0], dist() / BOLT_SPEED));
  function bolt(by, hand, tFire, power, outcome) {
    const b = { id: nextId--, by, hand, tFire, tHit: tFire + flight(), power, outcome };
    state.bolts.push(b);
    return b;
  }
  /** Queue an act for a side at time `at`. */
  const queue = (f, at, act) => f.queue.push({ at, act });
  /** A blow worth a close shot, and (heavy) slow motion as it lands. */
  function impact(t, victim, slow) {
    state.impacts.push({ t, victim });
    if (slow) state.heavy.push(t);
  }

  /* ---- the beats: each schedules both sides from t, and returns when the next may start ---- */

  /** The stand-off: Iron Man lifts off and holds in the air; Thanos stands his ground. */
  function stare(t) {
    start(H, hover({ thrust: 1 }), t);
    start(F, standFor(F), t);
    return t + range(rand, 0.9, 1.2);
  }

  /** Iron Man opens up from the air, drifting sideways; Thanos walks on into it, the gauntlet up. */
  function volley(t) {
    const dir = rand() < 0.5 ? 1 : -1;
    const n = 3 + Math.floor(rand() * 3) + Math.min(2, round);
    const gap = range(rand, 0.3, 0.38);
    const dur = 0.35 + n * gap + 0.3;
    start(H, hover({ kind: 'repulsor', aim: 'both', drift: dir * DRIFT, until: t + dur }), t);
    start(F, walkIn(t + dur, { block: 1 }), t);
    let hand = rand() < 0.5 ? 'L' : 'R';
    for (let i = 0; i < n; i++) {
      const r = rand();
      // Thanos catches about half on the gauntlet; the rest he takes, or they go wide.
      bolt('hero', hand, t + 0.35 + i * gap + range(rand, -0.04, 0.04), 0.5, r < 0.45 ? 'block' : r < 0.85 ? 'hit' : 'miss');
      hand = hand === 'L' ? 'R' : 'L';
    }
    return t + dur;
  }

  /** The Power Stone: Iron Man jinks clear of the first; the next knocks him out of the sky. */
  function answer(t) {
    const charge = range(rand, 0.45, 0.6);
    const gap = range(rand, 0.65, 0.8);
    start(F, { kind: 'gauntlet', clip: T_IDLE, loop: true, aim: 'L', until: t + charge + gap + 0.4 }, t);
    start(H, hover(), t);
    const first = bolt('foe', 'L', t + charge, 0.8, 'dodge');
    queue(H, first.tFire - 0.2, hover({ kind: 'dodge', drift: (rand() < 0.5 ? 1 : -1) * JINK, thrust: 1, until: first.tFire + 0.3 }));
    const b = bolt('foe', 'L', t + charge + gap, 1, 'hit');
    queue(H, b.tHit - 0.02, { kind: 'react', clip: I_SKY_HIT, mirror: false, loop: false, fall: true, alt: 0 });
    impact(b.tHit, 'hero', true);
    // (He hits the ground about FALL s later: see step, which starts the hard landing.)
    const fall = (30 + Math.sqrt(30 * 30 + 2 * G * HOVER)) / G;
    return b.tHit + fall + clip(I_LAND).duration - FADE;
  }

  /** Thanos walks in: a punch blocked, a repulsor point-blank in his face, and his lunging swipe lands. */
  function close(t) {
    const walk = Math.max(0, dist() - CLOSE) / WALK_V;
    const at = t + walk;
    start(F, walkIn(at + 0.6, { block: 1, close: CLOSE }), t);
    start(H, stand(), t);
    // The punch: Iron Man takes it on his forearms.
    const tPunch = at + clip(T_PUNCH).releases.at(-1).t;
    queue(F, at, { kind: 'melee', clip: T_PUNCH, mirror: rand() < 0.5, loop: false });
    queue(H, tPunch - 0.3, { kind: 'block', clip: I_BLOCK, mirror: rand() < 0.5, loop: false, until: tPunch + 0.55 });
    // Point-blank, from the palm: Thanos's head snaps back.
    const tFire = tPunch + 0.75;
    queue(H, tPunch + 0.5, stand({ kind: 'repulsor', aim: 'R', until: tFire + 0.35 }));
    const b = bolt('hero', 'R', tFire, 0.8, 'hit');
    queue(F, b.tHit - 0.02, { kind: 'react', clip: T_FLINCH, mirror: false, loop: false, weight: 0.6, until: b.tHit + 0.7 });
    // The swipe, lunging in: it lands and throws him back.
    const tS = b.tHit + 0.55;
    queue(F, tS, { kind: 'melee', clip: T_SWIPE, mirror: rand() < 0.5, loop: false });
    const tHit = tS + clip(T_SWIPE).releases[0].t;
    const thrown = pick(rand, I_THROWN);
    queue(H, tHit - 0.02, { kind: 'react', clip: thrown, mirror: false, loop: false });
    impact(tHit, 'hero', false);
    return tHit + clip(thrown).duration * 0.85;
  }

  /** Iron Man lifts off and puts both palms into it: Thanos staggers; he drops back down. */
  function heavy(t) {
    const tFire = t + range(rand, 0.7, 0.85);
    start(H, hover({ kind: 'repulsor', aim: 'both', thrust: 1, until: tFire + 0.5 }), t);
    start(F, standFor(F), t);
    const L = bolt('hero', 'L', tFire, 1, 'hit');
    bolt('hero', 'R', tFire + 0.03, 1, 'hit');
    impact(L.tHit, 'foe', true);
    queue(F, L.tHit - 0.02, { kind: 'react', clip: STAGGER, mirror: rand() < 0.5, loop: false, weight: STAGGER_W });
    queue(H, tFire + 0.5, { kind: 'react', clip: I_LAND, mirror: false, loop: false, alt: 0 });
    return Math.max(L.tHit + clip(STAGGER).duration * 0.7, tFire + 0.5 + clip(I_LAND).duration - FADE);
  }

  const BEATS = [stare, volley, answer, close, heavy];

  /** Altitude: eased to where his act holds him; knocked out of the air, he falls into a hard landing. */
  function fly(f, o, t, dt) {
    if (f.falling) {
      f.altV -= G * dt;
      f.alt += f.altV * dt;
      if (f.alt > 0) return;
      f.alt = f.altV = 0;
      f.falling = false;
      f.queue.length = 0;
      start(f, { kind: 'react', clip: I_LAND, mirror: false, loop: false, alt: 0, yaw: facing(f, o) }, t);
      return;
    }
    [f.alt, f.altV] = spring(f.alt, f.altV, f.cur ? f.cur.alt || 0 : 0, ALT_T, dt);
    if (f.alt < 0.05 && Math.abs(f.altV) < 0.5 && !(f.cur && f.cur.alt)) f.alt = f.altV = 0;
  }

  return {
    state,
    /** The engagement begins at t, the two of them where they stand, to be fought `stand` apart. */
    begin(t, hero, foe, stand = 80) {
      state.on = true;
      STAND = stand;
      round = 0;
      beat = 0;
      for (const [f, p] of [
        [H, hero],
        [F, foe],
      ]) {
        f.x = p.x;
        f.z = p.z;
        f.yaw = p.yaw;
        f.queue.length = 0;
        f.cur = null;
        f.prev = null;
        f.alt = f.altV = 0;
        f.falling = false;
      }
      nextAt = t;
    },
    /** It is over (he is taking off): the clips ease out, the bolts in the air finish, he comes down. */
    end(t) {
      if (!state.on) return;
      state.on = false;
      for (const f of [H, F]) {
        f.queue.length = 0;
        f.falling = false;
        start(f, { kind: 'none', clip: null }, t);
      }
      state.bolts = state.bolts.filter((b) => b.tFire <= t);
    },
    /** Whether he may leave: the round played out (to Iron Man's heavy blast), nothing coming, both on their feet. */
    calm(t) {
      const busy = (f) => f.queue.length > 0 || f.falling || f.alt > 0.5 || (f.cur && f.cur.kind !== 'stand' && f.cur.kind !== 'advance' && t < ends(f.cur));
      return t >= nextAt && beat === 0 && !busy(H) && !busy(F) && !state.bolts.some((b) => b.tHit > t);
    },
    /**
     * Advance to t: start what is due, carry each along his clip, keep faces turned to each other, run the
     * next beat when it is time. `winding` (the section's words are done): no new round.
     */
    step(t, dt, winding) {
      state.impacts = state.impacts.filter((m) => t < m.t + 3);
      if (!state.on) {
        state.bolts = state.bolts.filter((b) => t < b.tHit + 1.5);
        for (const f of [H, F]) [f.alt, f.altV] = spring(f.alt, f.altV, 0, ALT_T, dt);
        return;
      }
      if (t >= nextAt && !(winding && beat === 0)) {
        nextAt = BEATS[beat](t);
        beat = (beat + 1) % BEATS.length;
        if (beat === 0) round++;
      }
      for (const [f, o] of [
        [H, F],
        [F, H],
      ]) {
        while (f.queue.length && f.queue[0].at <= t) {
          const q = f.queue.shift();
          q.act.yaw = facing(f, o);
          start(f, q.act, t);
        }
        const a = f.cur;
        // An act run out: back to standing (or hovering), facing the other.
        if (a && t >= ends(a) && a.kind !== 'stand') {
          carry(f, t, dt);
          start(f, standFor(f, { yaw: facing(f, o) }), t);
        }
        carry(f, t, dt);
        // Standing, firing, hovering: his face kept to the other.
        if (TURNS.has(f.cur.kind)) {
          const turn = wrap(facing(f, o) - f.cur.yaw);
          f.cur.yaw += Math.sign(turn) * Math.min(Math.abs(turn), TURN * dt);
        }
        f.yaw = f.cur.yaw;
        fly(f, o, t, dt);
      }
      // Thrown too far apart, Thanos walks back in on him.
      if (F.cur.kind === 'stand' && !F.queue.length && dist() > STAND * SPREAD) start(F, walkIn(t + 3), t);
      if (F.cur.kind === 'advance' && dist() < (F.cur.close || STAND * ADVANCE_TO)) {
        // (Stopped under fire, he stands his ground behind the gauntlet until the volley is done.)
        if (F.cur.close || !F.cur.block) F.cur.until = Math.min(F.cur.until, t);
        else start(F, standFor(F, { block: 1, until: F.cur.until }), t);
      }
      state.bolts = state.bolts.filter((b) => t < b.tHit + 1.5);
    },
    /** How fast time runs at t (1: normal; a heavy blow landing slows it, see SLOW). */
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
