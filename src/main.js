/**
 * Boot and frame loop: parse the prompt, build the world, run the director at
 * a fixed step, render the stage and feed the HUD. Exposes window.crawler
 * for scripted screenshots.
 */

import { parsePrompt } from './analyze/parse.js';
import { SAMPLE_PROMPT, SAMPLE_FILE_NAME } from './analyze/sample.js';
import { SCORE_EXPLAINER } from './analyze/score.js';
import { buildWorld, drawWorld } from './world/field.js';
import { drawLabels } from './world/labels.js';
import { drawSilk, drawTentacles, drawTag } from './world/spider.js';
import { createDirector } from './sim/director.js';
import { createHud } from './hud/hud.js';
import { hashString } from './core/rng.js';
import { BG } from './core/theme.js';
import { SIM_DT } from './core/contracts.js';

const STORE_KEY = 'prompt-crawler:prompt';
const canvas = document.getElementById('stage');
const wrap = document.getElementById('stage-wrap');
const ctx = canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = { width: 1, height: 1, dpr: 1 };
let text;
let fileName;
let analysis;
let world;
let director;
let hud;
let speed = 1;
let paused = false;
let acc = 0;
let lastFrame = performance.now();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved.text === 'string' && saved.text.trim()) return saved;
  } catch {
    /* storage unavailable: use the sample */
  }
  return { text: SAMPLE_PROMPT, fileName: SAMPLE_FILE_NAME };
}

function save() {
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
  canvas.width = Math.round(stage.width * stage.dpr);
  canvas.height = Math.round(stage.height * stage.dpr);
}

/** (Re)start the crawl on a prompt. */
function start(promptText, name) {
  text = promptText;
  analysis = parsePrompt(text, { fileName: name });
  fileName = analysis.fileName;
  const seed = hashString(text);
  world = buildWorld(analysis, seed);
  director = createDirector(analysis, world, () => stage, seed);
  acc = 0;
  if (hud) hud.reset(analysis);
  save();
  if (reducedMotion) {
    director.seekSection(analysis.sections.length);
    document.getElementById('btn-play-crawl').hidden = false;
  }
  render(true);
}

function render(force = false) {
  const run = director.run;
  const view = { width: stage.width, height: stage.height, dpr: stage.dpr, time: run.t, camera: run.camera, reducedMotion };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawWorld(ctx, world, run, view, analysis);
  drawSilk(ctx, run, view, analysis);
  drawTentacles(ctx, world, run, view);
  director.spider.draw(ctx, run, view);
  drawLabels(ctx, world, run, view, analysis);
  if (run.phase !== 'ship') drawTag(ctx, run, view, analysis);
  hud.update(run, { program: director.program, force });
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused && !(reducedMotion && director.run.done)) {
    acc += dt * speed;
    let guard = 0;
    while (acc >= SIM_DT && guard++ < 40) {
      director.step();
      acc -= SIM_DT;
    }
  }
  render();
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
    acc = 0;
  },
  onSpeed: (n) => (speed = n),
  onSeekSection: (i) => {
    document.getElementById('btn-play-crawl').hidden = true;
    director.seekSection(i);
    acc = 0;
    render(true);
  },
  onSubmitPrompt: (t, name) => start(t, name),
  onLoadSample: () => start(SAMPLE_PROMPT, SAMPLE_FILE_NAME),
});

document.getElementById('btn-play-crawl').addEventListener('click', (e) => {
  e.currentTarget.hidden = true;
  director.reset();
  acc = 0;
});

resize();
window.addEventListener('resize', () => {
  resize();
  render(true);
});
const initial = load();
start(initial.text, initial.fileName);
document.fonts?.ready.then(() => render(true));
requestAnimationFrame(frame);

window.crawler = {
  seek(t) {
    director.seek(t);
    render(true);
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
};
