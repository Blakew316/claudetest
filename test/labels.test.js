/**
 * Tests for the word labels (src/world/labels.js) at the hero camera's close
 * framing: a label whose word is off screen is pinned where the line from him
 * to it leaves the frame; one whose word is behind him and would sit on his
 * body moves aside on a leader.
 * Run: node --test test/labels.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawLabels, edgePoint } from '../src/world/labels.js';

const rect = { left: 10, top: 100, right: 1070, bottom: 1330 };
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('a ray from the middle leaves through the edge it points at', () => {
  const e = edgePoint(rect, 1, 0);
  assert.ok(near(e.x, 1070) && near(e.y, 715));
  const up = edgePoint(rect, 0, -1);
  assert.ok(near(up.x, 540) && near(up.y, 100));
});

test('from his chest, a diagonal leaves through the nearer edge', () => {
  const e = edgePoint(rect, 1, 1, 900, 700);
  assert.ok(near(e.x, 1070) && near(e.y, 870));
});

test('an origin off the frame is brought inside it first', () => {
  const e = edgePoint(rect, -1, 0, 2000, 500);
  assert.ok(near(e.x, 10) && near(e.y, 500));
});

/** A canvas context that records where text goes and whether lines are drawn. */
function recorder() {
  const texts = [];
  let strokes = 0;
  const ctx = new Proxy(
    {},
    {
      get(t, k) {
        if (k === 'fillText') return (s, x, y) => texts.push({ s, x, y });
        if (k === 'stroke') return () => strokes++;
        if (k === 'measureText') return (s) => ({ width: s.length * 7 });
        if (k in t) return t[k];
        return () => {};
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    },
  );
  return { ctx, texts, strokes: () => strokes };
}

/** One section with one read word; the camera puts the word at (wx, wy) on an 800x600 stage, d away. */
function scene(wx, wy, d, vis = true) {
  const analysis = { sections: [{ index: 0, start: 0, count: 1, name: 'role', color: '#88aaff' }], words: [{ text: 'studio', section: 0 }] };
  const world = { clusters: [], wordPos: new Float32Array([0, 0, 0]) };
  const run = { phase: 'read', active: 0, t: 10, status: ['reading'], readCount: [1], wordState: [2], readAt: [9.5] };
  const view = { width: 800, height: 600, dpr: 1, camDist: 100, project: (x, y, z, out) => Object.assign(out, { x: wx, y: wy, vis, d }) };
  return { analysis, world, run, view };
}

test('a label whose word is behind him, over his body, moves aside on a leader', () => {
  const s = scene(400, 300, 300);
  // His silhouette: one thick upright segment through the middle of the stage, 150 from the lens.
  s.view.hero = { on: true, n: 1, seg: new Float32Array([400, 150, 400, 500, 40]), d: 150, chestX: 400, chestY: 250 };
  const r = recorder();
  drawLabels(r.ctx, s.world, s.run, s.view, s.analysis);
  const t = r.texts.find((x) => x.s === 'studio');
  assert.ok(t && (t.x > 440 || t.x + 6 * 7 < 360), `label at x ${t?.x}`);
  assert.ok(r.strokes() > 0, 'a leader line');
});

test('a label whose word is in front of him stays on its word', () => {
  const s = scene(400, 300, 100);
  s.view.hero = { on: true, n: 1, seg: new Float32Array([400, 150, 400, 500, 40]), d: 150, chestX: 400, chestY: 250 };
  const r = recorder();
  drawLabels(r.ctx, s.world, s.run, s.view, s.analysis);
  const t = r.texts.find((x) => x.s === 'studio');
  assert.ok(t && Math.abs(t.x - 407) < 2, `label at x ${t?.x}`);
});

test('a label whose word is off screen is pinned inside the frame, the way to its word', () => {
  const s = scene(1400, 300, 300);
  s.view.hero = { on: true, n: 1, seg: new Float32Array([400, 150, 400, 500, 40]), d: 150, chestX: 400, chestY: 250 };
  const r = recorder();
  drawLabels(r.ctx, s.world, s.run, s.view, s.analysis);
  const t = r.texts.find((x) => x.s === 'studio');
  assert.ok(t && t.x > 600 && t.x < 800, `label at x ${t?.x}`);
});
