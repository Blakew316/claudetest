/**
 * Tests for the word labels' pinning (src/world/labels.js): a label whose word
 * is off screen is pinned where the line from him to it leaves the frame.
 * Run: node --test test/labels.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgePoint } from '../src/world/labels.js';

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
