/**
 * Tests for the hero camera (src/sim/director.js): headless runs of the
 * sample prompt, checking that the camera films Iron Man up close and keeps
 * him in frame, never comes too near him or into a ball's nucleus, never
 * lurches, and that seeking reproduces live playback.
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
const TAN = Math.tan((50 * Math.PI) / 360); // view3d FOV
const RUN_TO = 70; // s: the first read, two visits with their flights and landings, and the second section

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
  const H = [s.x, s.y + 13, s.z];
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

for (const [W, H] of [
  [1080, 1350],
  [1440, 900],
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
    while (d.run.t < RUN_TO) {
      d.step();
      const v = view(d, W / H);
      if (d.run.phase === 'read') reading.push(v.share);
      if (v.z <= 0 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) offFrame++;
      nearest = Math.min(nearest, v.gap);
      for (const c of world.clusters) if (!c.extra && Math.hypot(v.eye[0] - c.cx, v.eye[1] - c.cy, v.eye[2] - c.cz) < c.r * 0.19) inNucleus++;
      if (prev) {
        const vel = v.eye.map((x, i) => (x - prev[i]) * 60);
        if (prevV && Math.hypot(...vel.map((x, i) => (x - prevV[i]) * 60)) > 3000) lurches++;
        prevV = vel;
      }
      prev = v.eye;
    }

    test('he fills about half the view height while he reads', () => {
      const m = median(reading);
      assert.ok(m > 0.4 && m < 0.6, `median share ${m.toFixed(2)}`);
    });

    test('he is always in frame', () => {
      assert.equal(offFrame, 0);
    });

    test('the lens keeps clear of him and of every nucleus', () => {
      assert.ok(nearest > 60, `came within ${nearest.toFixed(1)} of him`);
      assert.equal(inNucleus, 0);
    });

    test('it never lurches', () => {
      assert.equal(lurches, 0);
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
