/**
 * Tests for the hero camera (src/sim/director.js): headless runs of the
 * sample prompt, checking that the camera films Iron Man up close and keeps
 * him in frame, seldom from behind, never comes too near him or into a
 * ball's nucleus, never lurches (but for its deliberate cut to each landing),
 * films each superhero landing from in front, low and close, keeps Thanos in the
 * frame with him while they fight (squared up to each other), and that seeking
 * reproduces live playback.
 * Run: node --test test/camera.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrompt } from '../src/analyze/parse.js';
import { SAMPLE_PROMPT, SAMPLE_FILE_NAME } from '../src/analyze/sample.js';
import { buildWorld } from '../src/world/field.js';
import { createDirector } from '../src/sim/director.js';
import { hashString } from '../src/core/rng.js';

const HERO_H = 46; // world/ironman.js HEIGHT
const KNEEL_H = 28; // ...kneeling in the superhero landing
const TAN = Math.tan((50 * Math.PI) / 360); // view3d FOV
const RUN_TO = 110; // s: the first reads with their flights and landings
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const PI = Math.PI;

const seed = hashString(SAMPLE_PROMPT);
const analysis = parsePrompt(SAMPLE_PROMPT, { fileName: SAMPLE_FILE_NAME });
const world = buildWorld(analysis, seed);

/** The lens and where his middle (or point P) falls on screen (NDC) for the current step. */
function view(d, aspect, P = null) {
  const c = d.run.camera;
  const s = d.run.spider;
  const cp = Math.cos(c.pitch);
  const eye = [c.x + c.dist * cp * Math.sin(c.yaw), c.y + c.dist * Math.sin(c.pitch), c.z + c.dist * cp * Math.cos(c.yaw)];
  let f = [c.x - eye[0], c.y - eye[1], c.z - eye[2]];
  const fl = Math.hypot(...f);
  f = f.map((v) => v / fl);
  const rl = Math.hypot(f[0], f[2]);
  const r = [-f[2] / rl, 0, f[0] / rl];
  const u = [-r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1]];
  const sim = d.spider.sim;
  // (In a leap his middle rides the crawler point; flying in the fight, he is up over it, his hover pose
  // riding about 8 higher still: sim/fight.js alt.)
  const alt = d.run.duel ? d.run.duel.hero.alt : 0;
  const H = P || [s.x, s.y + (sim.mode === 'jump' && sim.launched ? 0 : 13) + alt + 8 * Math.min(1, alt / 10), s.z];
  const q = [H[0] - eye[0], H[1] - eye[1], H[2] - eye[2]];
  const z = q[0] * f[0] + q[1] * f[1] + q[2] * f[2];
  return {
    eye,
    gap: Math.hypot(...q),
    x: (q[0] * r[0] + q[2] * r[2]) / z / (TAN * aspect),
    y: (q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / z / TAN,
    z,
    share: HERO_H / (z * 2 * TAN), // of the view height, standing
  };
}

/** Where his chest faces (a bearing, as atan2(x, z)): his heading, twisted toward the words he fires at. */
function chest(d, s) {
  const hx = Math.cos(s.heading);
  const hz = Math.sin(s.heading);
  let tw = 0;
  let k = 0;
  for (const tn of d.run.tentacles) {
    const ax = world.wordPos[tn.wordId * 3] - s.x;
    const az = world.wordPos[tn.wordId * 3 + 2] - s.z;
    const ang = Math.atan2(ax * hz - az * hx, ax * hx + az * hz); // > 0: on his left
    tw += ang - (ang > 0 ? 0.45 : -0.45);
    k++;
  }
  const t = Math.max(-0.75, Math.min(0.75, k ? tw / k : 0));
  return Math.atan2(hx * Math.cos(t) + hz * Math.sin(t), hz * Math.cos(t) - hx * Math.sin(t));
}

function median(a) {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}

// Portrait (the default), landscape, and a phone held upright (where the shots pull back a little).
for (const [W, H, least] of [
  [1080, 1350, 0.4],
  [1440, 900, 0.4],
  [390, 844, 0.3],
]) {
  describe(`hero camera at ${W}x${H}`, () => {
    const d = createDirector(analysis, world, () => ({ width: W, height: H }), seed);
    const reading = [];
    const fighting = []; // ... while Thanos fights him (a two-shot: each of them smaller)
    let fightSteps = 0;
    let foeOff = 0; // Thanos out of the frame while they fight
    let squared = 0; // ... both facing the other (within 35 degrees)
    let offFrame = 0;
    let nearest = Infinity;
    let inNucleus = 0;
    let lurches = 0;
    let prev = null;
    let prevV = null;
    let cuts = 0;
    let landings = 0;
    let mode = '';
    let leapCuts = 0;
    let touch = -1;
    let touchYaw = 0;
    const kneel = []; // per step of each kneel: [his kneeling share of the view height (a little less on a phone), lens off his front (rad), lens height over his middle (rad)]
    let back = 0;
    let backRun = 0;
    let backLongest = 0;
    while (d.run.t < RUN_TO) {
      d.step();
      const v = view(d, W / H);
      const s = d.run.spider;
      const F = d.run.foe;
      const fight = !!(F && F.state === 'here');
      // (Thanos withdrawing through his portal is still a two-shot.)
      if (d.run.phase === 'read') (fight || (F && F.state === 'leaving') ? fighting : reading).push(v.share);
      if (fight) {
        fightSteps++;
        const fv = view(d, W / H, [F.x, F.y + 13, F.z]);
        if (fv.z <= 0 || Math.abs(fv.x) > 0.9 || Math.abs(fv.y) > 0.9) foeOff++;
        const toFoe = Math.atan2(F.z - s.z, F.x - s.x);
        if (Math.abs(wrap(toFoe - s.heading)) < 0.61 && Math.abs(wrap(toFoe + PI - F.heading)) < 0.61) squared++;
      }
      if (v.z <= 0 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) offFrame++;
      nearest = Math.min(nearest, v.gap);
      for (const c of world.clusters) if (!c.extra && Math.hypot(v.eye[0] - c.cx, v.eye[1] - c.cy, v.eye[2] - c.cz) < c.r * 0.19) inNucleus++;
      // A deliberate cut is no lurch: the follow restarts after it.
      if (d.run.camera.cut !== cuts) {
        cuts = d.run.camera.cut;
        prev = prevV = null;
        // (The fight cuts in close on its big blows; a leap and its landing are one unbroken move.)
        if (d.spider.sim.mode === 'jump' || d.spider.sim.mode === 'land') leapCuts++;
      }
      if (prev) {
        const vel = v.eye.map((x, i) => (x - prev[i]) * 60);
        if (prevV && Math.hypot(...vel.map((x, i) => (x - prevV[i]) * 60)) > 3000) lurches++;
        prevV = vel;
      }
      prev = v.eye;
      // Reading: from behind him (the lens more than 120 degrees off where his chest faces: his heading,
      // turned toward the words he fires at as world/ironman.js turns him), how much and for how long at a time.
      const bearing = Math.atan2(v.eye[0] - s.x, v.eye[2] - s.z);
      const isBack = d.run.phase === 'read' && !fight && !(F && F.state === 'leaving') && Math.abs(wrap(bearing - chest(d, s))) > (2 * Math.PI) / 3;
      back += isBack ? 1 : 0;
      backRun = isBack ? backRun + 1 / 60 : 0;
      backLongest = Math.max(backLongest, backRun);
      // The superhero landing.
      const m = d.spider.sim.mode;
      if (m === 'land' && mode !== 'land') {
        landings++;
        touch = d.run.t;
        touchYaw = Math.atan2(Math.cos(s.heading), Math.sin(s.heading));
      }
      mode = m;
      if (m === 'land' && d.run.t - touch > 0.3 && d.run.t - touch < 0.9) {
        const mid = [s.x, s.y - 5, s.z];
        const z = Math.hypot(v.eye[0] - mid[0], v.eye[1] - mid[1], v.eye[2] - mid[2]);
        kneel.push([KNEEL_H / (2 * z * TAN), Math.abs(wrap(bearing - touchYaw)), Math.asin((v.eye[1] - mid[1]) / z)]);
      }
    }

    test('he fills about half the view height while he reads (a little less on a phone)', () => {
      if (reading.length) {
        const m = median(reading);
        assert.ok(m > least && m < 0.6, `median share ${m.toFixed(2)}`);
      }
      // Fighting, the two-shot has them both, full figure (thrown down, getting up, Thanos walking in on him):
      // each smaller, on a narrow screen markedly (it frames them nearer along the line between them), still
      // big enough to read.
      const mf = median(fighting);
      assert.ok(mf > 0.6 * least && mf < 0.6, `median share fighting ${mf.toFixed(2)}`);
    });

    test('fighting, they face each other and Thanos stays in the frame with him', () => {
      assert.ok(fightSteps > 60 * 30, `${(fightSteps / 60).toFixed(0)} s of fighting`);
      assert.ok(foeOff / fightSteps < 0.05, `Thanos out of frame ${((100 * foeOff) / fightSteps).toFixed(0)}% of the fight`);
      assert.ok(squared / fightSteps > 0.85, `squared up ${((100 * squared) / fightSteps).toFixed(0)}% of the fight`);
    });

    test('he is always in frame', () => {
      assert.equal(offFrame, 0);
    });

    test('the lens keeps clear of him and of every nucleus', () => {
      assert.ok(nearest > 45, `came within ${nearest.toFixed(1)} of him`);
      assert.equal(inNucleus, 0);
    });

    test('it never lurches', () => {
      assert.equal(lurches, 0);
    });

    test('it seldom films him from behind while he reads, and never for long', () => {
      // (Over these first two reads it was 38-57% of the time, for up to 4 s at a stretch.) A calm camera that
      // does not circle him to keep his front (it made people queasy) sees his back more: about a third.
      const share = back / reading.length;
      assert.ok(share < 0.4, `from behind ${(100 * share).toFixed(0)}% of the time`);
      assert.ok(backLongest < 5.5, `from behind for ${backLongest.toFixed(1)} s at a stretch`);
    });

    test('it swings round onto each landing (no cuts) and films the kneel from in front, low and close', () => {
      assert.ok(landings >= 2, `${landings} landings`);
      assert.equal(leapCuts, 0);
      const med = (k) => median(kneel.map((r) => r[k]));
      assert.ok(med(0) > 0.3 && med(0) < 0.7, `kneeling he fills ${med(0).toFixed(2)} of the view height`);
      assert.ok(med(1) < 0.7, `the lens is ${((med(1) * 180) / Math.PI).toFixed(0)} degrees off his front`);
      assert.ok(med(2) < 0, 'the lens looks up at him');
    });
  });
}

test('seeking reproduces live playback, camera included', () => {
  const live = createDirector(analysis, world, () => ({ width: 1080, height: 1350 }), seed);
  while (live.run.t < 30) live.step();
  const seeked = createDirector(analysis, world, () => ({ width: 1080, height: 1350 }), seed);
  seeked.seek(live.run.t);
  for (const k of ['x', 'y', 'z', 'dist', 'yaw', 'pitch']) assert.ok(Math.abs(live.run.camera[k] - seeked.run.camera[k]) < 1e-9, k);
});
