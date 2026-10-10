/**
 * Tests for the hero camera (src/sim/director.js): headless runs of the
 * sample prompt, checking that the camera films Iron Man up close and keeps
 * him in frame, seldom from behind, never comes too near him or into a
 * ball's nucleus, never lurches (but for its deliberate cut to each landing),
 * films each superhero landing from in front, low and close, and that
 * seeking reproduces live playback.
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
const RUN_TO = 70; // s: the first read, two visits with their flights and landings, and the second section
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const seed = hashString(SAMPLE_PROMPT);
const analysis = parsePrompt(SAMPLE_PROMPT, { fileName: SAMPLE_FILE_NAME });
const world = buildWorld(analysis, seed);

/** The lens and where his middle falls on screen (NDC) for the current step. */
function view(d, aspect) {
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
  const H = [s.x, s.y + (sim.mode === 'jump' && sim.launched ? 0 : 13), s.z]; // (in the air his middle rides the crawler point)
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
    let offFrame = 0;
    let nearest = Infinity;
    let inNucleus = 0;
    let lurches = 0;
    let prev = null;
    let prevV = null;
    let cuts = 0;
    let landings = 0;
    let mode = '';
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
      if (d.run.phase === 'read') reading.push(v.share);
      if (v.z <= 0 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) offFrame++;
      nearest = Math.min(nearest, v.gap);
      for (const c of world.clusters) if (!c.extra && Math.hypot(v.eye[0] - c.cx, v.eye[1] - c.cy, v.eye[2] - c.cz) < c.r * 0.19) inNucleus++;
      // A deliberate cut is no lurch: the follow restarts after it.
      if (d.run.camera.cut !== cuts) {
        cuts = d.run.camera.cut;
        prev = prevV = null;
      }
      if (prev) {
        const vel = v.eye.map((x, i) => (x - prev[i]) * 60);
        if (prevV && Math.hypot(...vel.map((x, i) => (x - prevV[i]) * 60)) > 3000) lurches++;
        prevV = vel;
      }
      prev = v.eye;
      // Reading: from behind him (the lens more than 120 degrees off his heading), how much and for how long at a time.
      const bearing = Math.atan2(v.eye[0] - s.x, v.eye[2] - s.z);
      const isBack = d.run.phase === 'read' && Math.abs(wrap(bearing - Math.atan2(Math.cos(s.heading), Math.sin(s.heading)))) > (2 * Math.PI) / 3;
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
      const m = median(reading);
      assert.ok(m > least && m < 0.6, `median share ${m.toFixed(2)}`);
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
      const share = back / reading.length;
      assert.ok(share < 0.15, `from behind ${(100 * share).toFixed(0)}% of the time`);
      assert.ok(backLongest < 3.5, `from behind for ${backLongest.toFixed(1)} s at a stretch`);
    });

    test('it cuts once to each landing and films the kneel from in front, low and close', () => {
      assert.ok(landings >= 3, `${landings} landings`);
      assert.equal(cuts, landings);
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
