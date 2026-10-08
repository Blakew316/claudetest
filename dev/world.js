/**
 * Dev harness for the particle world and labels (src/world/field.js,
 * src/world/labels.js). Draws ONE still frame on a 1080×1050 canvas (the
 * stage area above the dashboard) for a fake run state picked by the hash:
 *
 *   #a  section 5 'rules' half read, camera on it at zoom 1.1
 *   #b  section 4 'roles' just started, earlier sections done (director zoom)
 *   #c  ship: everything read, camera = fitBounds(world.bounds)
 *   #d  12-section stub prompt, ship overview
 *   #e  12-section stub prompt, mid crawl (section 8)
 *
 * Extra comma-separated flags: `bench` (time drawWorld + drawLabels over
 * 120 frames), `dpr=2` (render at device pixel ratio 2), `seed=N`.
 * Results land in window.__report and the <pre id="out">.
 *
 * It deliberately does NOT import src/analyze/parse.js (written in
 * parallel): the Analysis is a stub built from the sample text.
 */

import { SAMPLE_PROMPT, SAMPLE_FILE_NAME } from '../src/analyze/sample.js';
import { createRunState, LINK_KINDS } from '../src/core/contracts.js';
import { BG, sectionColor } from '../src/core/theme.js';
import { hashString, mulberry32 } from '../src/core/rng.js';
import { fitBounds } from '../src/world/camera.js';
import { buildWorld, drawWorld, overlapFraction } from '../src/world/field.js';
import { drawLabels } from '../src/world/labels.js';

const W = 1080;
const H = 1050;

/**
 * Stub Analysis from markdown-ish text: '## name — tagline' headings,
 * whitespace tokens, fake kinds (every 5th word 'claim', every 7th 'owner',
 * every 13th vague with a question).
 * @param {string} text
 * @param {string} fileName
 * @returns {import('../src/core/contracts.js').Analysis}
 */
export function stubAnalysis(text, fileName) {
  const parts = text.split(/^## /m).slice(1);
  const sections = [];
  const words = [];
  const sentences = [];
  const flags = [];
  let g = 0;
  parts.forEach((part, si) => {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1);
    const [rawName, subtitle = ''] = heading.split(/\s+[—–]\s+/);
    const name = rawName.trim().toLowerCase().slice(0, 18);
    const sec = {
      index: si,
      key: `${name.replace(/[^a-z0-9]+/g, '-')}-${si}`,
      name,
      abbr: name.slice(0, 3).toUpperCase(),
      subtitle,
      color: sectionColor(si),
      start: words.length,
      count: 0,
    };
    const sents = body.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    for (const s of sents) {
      const sIdx = sentences.length;
      sentences.push(s.trim());
      for (const raw of s.split(/\s+/)) {
        const tok = raw.replace(/^[^\w/]+|[^\w]+$/g, '');
        if (!tok) continue;
        g++;
        let kind = null;
        let vague = false;
        let question = null;
        if (g % 13 === 0) {
          vague = true;
          question = `What exactly does "${tok}" mean here?`;
        } else if (g % 7 === 0) kind = 'owner';
        else if (g % 5 === 0) kind = 'claim';
        const id = words.length;
        words.push({ id, section: si, text: tok, kind, guessed: false, vague, question, sentence: sIdx });
        if (vague) flags.push({ wordId: id, word: tok, section: si, sentence: s.trim(), question });
      }
    }
    sec.count = words.length - sec.start;
    sections.push(sec);
  });
  const byKind = Object.fromEntries(LINK_KINDS.map((k) => [k, 0]));
  for (const w of words) if (w.kind) byKind[w.kind]++;
  return {
    fileName,
    sections,
    words,
    sentences,
    flags,
    totals: {
      words: words.length,
      linked: words.filter((w) => w.kind).length,
      vague: flags.length,
      guessed: 0,
      byKind,
    },
    notes: { detectedBy: 'markdown', truncated: false, originalWords: words.length, skippedCodeBlocks: 0 },
  };
}

/** A 12-section stub prompt with varied section lengths (8..140 words). */
export function twelveSectionText(seed = 7) {
  const rand = mulberry32(seed);
  const vocab = ('owner approve claim source file spec the and of to a release cover video manifest.json ' +
    'writer editor 1600px 30s research.md verify report keep draft note brand rules full nice short ' +
    'publish deadline producer staff team budget table chart layout copy credits timestamp quickly').split(' ');
  const names = ['brief', 'goal', 'audience', 'voice', 'sources', 'format', 'budget', 'timeline', 'owners', 'review', 'risks', 'handoff'];
  const sizes = [24, 60, 12, 140, 35, 8, 90, 45, 18, 110, 28, 70];
  let out = '# twelve.prompt\n\n';
  names.forEach((n, i) => {
    out += `## ${n} — part ${i + 1}\n`;
    const ws = [];
    for (let k = 0; k < sizes[i]; k++) ws.push(vocab[Math.floor(rand() * vocab.length)]);
    out += `${ws.join(' ')}.\n\n`;
  });
  return out;
}

/** Director-style zoom: the active cluster spans ~70% of the smaller stage side. */
function crawlZoom(r) {
  return Math.min(1.8, Math.max(0.6, (0.7 * Math.min(W, H)) / (2 * r)));
}

/**
 * Fake RunState: sections before `active` done, `active` reading with
 * `frac` of its words read (the last few still fading in), the rest queued.
 * phase 'ship' marks everything read.
 */
function fakeRun(analysis, world, { active, frac = 0, phase = 'read', zoom }) {
  const run = createRunState(analysis);
  let t = 1.0;
  const ship = phase === 'ship';
  const markRead = (id, at) => {
    const w = analysis.words[id];
    run.wordState[id] = 2;
    run.readAt[id] = at;
    run.readCount[w.section]++;
    run.counts.read++;
    if (w.kind) run.counts.linked++;
    if (w.vague) run.counts.flagged++;
    if (w.kind === 'claim') run.counts.claims++;
    if (w.kind === 'owner') run.counts.owners++;
    if (w.kind === 'approval') run.counts.approvals++;
  };
  for (const s of analysis.sections) {
    if (ship || s.index < active) {
      run.status[s.index] = 'done';
      for (let k = 0; k < s.count; k++) markRead(s.start + k, t + k * 0.06);
      t += s.count * 0.06 + 1.4;
    } else if (s.index === active) {
      run.status[s.index] = 'reading';
      const n = Math.max(0, Math.round(frac * s.count));
      for (let k = 0; k < n; k++) markRead(s.start + k, t + k * 0.06);
      // A few tentacles still reaching.
      for (let k = n; k < Math.min(s.count, n + 4); k++) run.wordState[s.start + k] = 1;
      t += Math.max(0, n - 1) * 0.06 + 0.12;
    } else {
      run.status[s.index] = 'queued';
    }
  }
  run.t = ship ? t + 1.5 : t;
  run.frame = Math.round(run.t * 60);
  run.phase = ship ? 'ship' : 'read';
  run.active = ship ? analysis.sections.length : active;
  if (ship) {
    run.camera = fitBounds(world.bounds, W, H);
  } else {
    const c = world.clusters[active];
    // Camera: blend of the read-word centroid (where the spider is) and the cluster centre.
    let sx = 0;
    let sy = 0;
    let m = 0;
    const s = analysis.sections[active];
    for (let k = 0; k < s.count; k++) {
      if (run.wordState[s.start + k] !== 2) continue;
      sx += world.wordPos[(s.start + k) * 2];
      sy += world.wordPos[(s.start + k) * 2 + 1];
      m++;
    }
    const spx = m ? sx / m : c.cx;
    const spy = m ? sy / m : c.cy;
    run.spider = { x: spx, y: spy, vx: 0, vy: 0, heading: 0 };
    run.camera = { x: spx * 0.7 + c.cx * 0.3, y: spy * 0.7 + c.cy * 0.3, zoom: zoom ?? crawlZoom(c.r) };
  }
  return run;
}

function parseHash() {
  const raw = (location.hash || '#a').slice(1).split(',');
  const opts = { mode: raw[0] || 'a', bench: false, dpr: 1, seed: 1234 };
  for (const p of raw.slice(1)) {
    if (p === 'bench') opts.bench = true;
    else if (p.startsWith('dpr=')) opts.dpr = Number(p.slice(4)) || 1;
    else if (p.startsWith('seed=')) opts.seed = Number(p.slice(5)) || 1;
  }
  return opts;
}

function overlapReport(world) {
  let max = 0;
  let pair = null;
  const cs = world.clusters;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const o = overlapFraction(cs[i], cs[j]);
      if (o > max) {
        max = o;
        pair = [i, j];
      }
    }
  }
  return { maxOverlap: Number(max.toFixed(3)), pair };
}

async function main() {
  const opts = parseHash();
  const twelve = opts.mode === 'd' || opts.mode === 'e';
  const text = twelve ? twelveSectionText() : SAMPLE_PROMPT;
  const analysis = stubAnalysis(text, twelve ? 'twelve.prompt' : SAMPLE_FILE_NAME);
  const seed = opts.seed ^ hashString(text);

  const tb0 = performance.now();
  const world = buildWorld(analysis, seed);
  const buildMs = performance.now() - tb0;

  let run;
  if (opts.mode === 'a') run = fakeRun(analysis, world, { active: 4, frac: 0.5, zoom: 1.1 });
  else if (opts.mode === 'b') run = fakeRun(analysis, world, { active: 3, frac: 0.08 });
  else if (opts.mode === 'c' || opts.mode === 'd') run = fakeRun(analysis, world, { phase: 'ship' });
  else run = fakeRun(analysis, world, { active: 7, frac: 0.6 });

  const canvas = document.getElementById('stage');
  const dpr = opts.dpr;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');

  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* fonts unavailable: fallback stack */
  }

  const view = { width: W, height: H, dpr, time: run.t, camera: run.camera, reducedMotion: false };
  const frame = (time) => {
    view.time = time;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawWorld(ctx, world, run, view, analysis);
    drawLabels(ctx, world, run, view, analysis);
  };

  const tf0 = performance.now();
  frame(run.t);
  ctx.getImageData(0, 0, 1, 1);
  const firstFrameMs = performance.now() - tf0;

  const report = {
    mode: opts.mode,
    dpr,
    sections: analysis.sections.map((s, i) => ({ name: s.name, count: s.count, r: Math.round(world.clusters[i].r) })),
    words: analysis.words.length,
    buildWorldMs: Number(buildMs.toFixed(1)),
    firstFrameMs: Number(firstFrameMs.toFixed(1)),
    camera: { x: Math.round(run.camera.x), y: Math.round(run.camera.y), zoom: Number(run.camera.zoom.toFixed(3)) },
    ...overlapReport(world),
    fonts: document.fonts ? document.fonts.status : 'n/a',
  };

  if (opts.bench) {
    const N = 120;
    const cpu = [];
    for (let f = 0; f < N; f++) {
      const t0 = performance.now();
      frame(run.t + f / 60);
      cpu.push(performance.now() - t0);
    }
    ctx.getImageData(0, 0, 1, 1);
    // World and labels split, with a raster flush each frame (upper bound).
    const worldMs = [];
    const labelMs = [];
    const flushed = [];
    for (let f = 0; f < N; f++) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      view.time = run.t + f / 60;
      const t0 = performance.now();
      drawWorld(ctx, world, run, view, analysis);
      const t1 = performance.now();
      drawLabels(ctx, world, run, view, analysis);
      const t2 = performance.now();
      ctx.getImageData(0, 0, 1, 1);
      const t3 = performance.now();
      worldMs.push(t1 - t0);
      labelMs.push(t2 - t1);
      flushed.push(t3 - t0);
    }
    const avg = (a) => Number((a.reduce((s, v) => s + v, 0) / a.length).toFixed(3));
    const p95 = (a) => Number([...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)].toFixed(3));
    report.bench = {
      frames: N,
      avgWorldPlusLabelsMs: avg(cpu),
      p95WorldPlusLabelsMs: p95(cpu),
      avgWorldMs: avg(worldMs),
      avgLabelsMs: avg(labelMs),
      avgWithRasterFlushMs: avg(flushed),
    };
    frame(run.t);
  }

  window.__report = report;
  document.getElementById('out').textContent = opts.bench ? JSON.stringify(report.bench) : '';
  document.title = `world ${opts.mode} ready`;
}

main().catch((err) => {
  window.__report = { error: String(err && err.stack ? err.stack : err) };
  document.title = 'world error';
  throw err;
});
