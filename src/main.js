/**
 * Boot and frame loop: parse the prompt, build the 3D world, run the director
 * at a fixed step, render the WebGL stage plus the 2D label overlay, and feed
 * the HUD. Dragging the stage orbits the camera; it eases back when released.
 * Exposes window.crawler for scripted screenshots.
 */

import { parsePrompt } from './analyze/parse.js';
import { SAMPLE_PROMPT, SAMPLE_FILE_NAME } from './analyze/sample.js';
import { SCORE_EXPLAINER } from './analyze/score.js';
import { buildWorld } from './world/field.js';
import { drawLabels, drawSpiderOverlay } from './world/labels.js';
import { createView3D } from './world/view3d.js';
import { createDirector } from './sim/director.js';
import { createHud } from './hud/hud.js';
import { hashString } from './core/rng.js';
import { SIM_DT } from './core/contracts.js';

const STORE_KEY = 'prompt-crawler:prompt';
const canvas = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const wrap = document.getElementById('stage-wrap');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = { width: 1, height: 1, dpr: 1 };
let view3d;
try {
  view3d = createView3D(canvas);
} catch {
  wrap.insertAdjacentHTML('beforeend', '<p style="position:absolute;inset:40% 0 auto;text-align:center;color:var(--dim)">This needs WebGL. Try a current Chrome, Safari, Edge or Firefox.</p>');
}
let text;
let analysis;
let world;
let director;
let hud;
let speed = 1;
let paused = false;
let acc = 0;
// The camera and clock one step back, so frames between 60 Hz steps are drawn
// in between (see Spider.at); `fresh` after a jump in time draws the latest step as is.
const camPrev = { x: 0, y: 0, z: 0, dist: 1, yaw: 0, pitch: 0 };
const camDrawn = { ...camPrev };
let tPrev = 0;
let fresh = true;
let lastFrame = performance.now();
let dragging = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved.text === 'string' && saved.text.trim()) return saved;
  } catch {
    /* storage unavailable: use the sample */
  }
  return { text: SAMPLE_PROMPT, fileName: SAMPLE_FILE_NAME };
}

function save(fileName) {
  try {
    if (text === SAMPLE_PROMPT) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify({ text, fileName }));
  } catch {
    /* not persisted; fine */
  }
}

function resize() {
  stage.width = Math.max(1, wrap.clientWidth);
  stage.height = Math.max(1, wrap.clientHeight);
  stage.dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width = Math.round(stage.width * stage.dpr);
  overlay.height = Math.round(stage.height * stage.dpr);
  view3d?.resize(stage.width, stage.height, stage.dpr);
}

/** (Re)start the crawl on a prompt. */
function start(promptText, name) {
  text = promptText;
  analysis = parsePrompt(text, { fileName: name });
  const seed = hashString(text);
  world = buildWorld(analysis, seed);
  director = createDirector(analysis, world, () => stage, seed);
  view3d?.setWorld(world, analysis);
  resync();
  hud.reset(analysis);
  save(analysis.fileName);
  if (reducedMotion) {
    director.seekSection(analysis.sections.length);
    document.getElementById('btn-play-crawl').hidden = false;
  }
  render(10, true);
}

/** Start drawing from the director's current state (after a restart or seek). */
function resync() {
  acc = 0;
  fresh = true;
}

function render(dt, force = false) {
  const run = director.run;
  if (view3d) {
    const k = fresh ? 1 : Math.min(1, acc / SIM_DT);
    const c = run.camera;
    const turn = c.yaw - camPrev.yaw;
    camDrawn.yaw = camPrev.yaw + (turn - 2 * Math.PI * Math.round(turn / (2 * Math.PI))) * k;
    for (const f of ['x', 'y', 'z', 'dist', 'pitch']) camDrawn[f] = camPrev[f] + (c[f] - camPrev[f]) * k;
    const spider = director.spider.at(k);
    view3d.render(run, analysis, spider, dt, { camera: camDrawn, t: tPrev + (run.t - tPrev) * k });
    const view = { width: stage.width, height: stage.height, dpr: stage.dpr, project: view3d.project, camDist: camDrawn.dist, spider: spider.p };
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    drawLabels(octx, world, run, view, analysis);
    drawSpiderOverlay(octx, world, run, view, analysis);
  }
  hud.update(run, { force });
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused && !(reducedMotion && director.run.done)) {
    acc += dt * speed;
    let guard = 0;
    while (acc >= SIM_DT && guard++ < 40) {
      Object.assign(camPrev, director.run.camera);
      tPrev = director.run.t;
      director.step();
      acc -= SIM_DT;
      fresh = false;
    }
  }
  // Released drag eases the view back to the director's camera.
  if (view3d && !dragging) {
    const k = Math.exp(-1.2 * dt);
    view3d.orbit.yaw *= k;
    view3d.orbit.pitch *= k;
  }
  render(dt);
  requestAnimationFrame(frame);
}

hud = createHud(parsePrompt('', {}), {
  scoreExplainer: SCORE_EXPLAINER,
  getPromptText: () => text,
  onPause: () => (paused = true),
  onPlay: () => (paused = false),
  onReplay: () => {
    document.getElementById('btn-play-crawl').hidden = true;
    director.reset();
    resync();
  },
  onSpeed: (n) => (speed = n),
  onSeekSection: (i) => {
    document.getElementById('btn-play-crawl').hidden = true;
    director.seekSection(i);
    resync();
    render(10, true);
  },
  onSubmitPrompt: (t, name) => start(t, name),
  onLoadSample: () => start(SAMPLE_PROMPT, SAMPLE_FILE_NAME),
});

document.getElementById('btn-play-crawl').addEventListener('click', (e) => {
  e.currentTarget.hidden = true;
  director.reset();
  resync();
});

// Drag to orbit the scene.
canvas.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !view3d) return;
  view3d.orbit.yaw -= (e.clientX - dragging.x) * 0.006;
  view3d.orbit.pitch = Math.max(-1.4, Math.min(1.2, view3d.orbit.pitch + (e.clientY - dragging.y) * 0.005));
  dragging.x = e.clientX;
  dragging.y = e.clientY;
});
const endDrag = () => {
  dragging = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

resize();
window.addEventListener('resize', () => {
  resize();
  render(0, true);
});
const initial = load();
start(initial.text, initial.fileName);
document.fonts?.ready.then(() => render(0, true));
requestAnimationFrame(frame);

window.crawler = {
  seek(t) {
    director.seek(t);
    resync();
    render(10, true);
  },
  play: () => (paused = false),
  pause: () => (paused = true),
  restart: (t) => start(t ?? SAMPLE_PROMPT, t ? undefined : SAMPLE_FILE_NAME),
  get state() {
    return director.run;
  },
  get analysis() {
    return analysis;
  },
  get world() {
    return world;
  },
  project: (x, y, z) => view3d?.project(x, y, z, {}),
};
