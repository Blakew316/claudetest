/**
 * The DOM around the stage: stats line, tabs, section header, controls, the
 * six dashboard panels, the prompt editor and the flag list. Reads run state
 * only; user actions go out through `handlers`. Updates are throttled to
 * ~20 Hz and only touch the DOM when a value changed.
 */

import { AMBER, FLAG, SPIDER, TEXT_FAINT, MONO, PANEL_BORDER, withAlpha } from '../core/theme.js';

const $ = (id) => document.getElementById(id);
const HEAT_CELLS = 12;
const LOG_ROWS = 15;

/** Short radar axis label for a section name. */
function axisLabel(name) {
  const known = { role: 'ROLE', objective: 'OBJ', context: 'CTX', roles: 'TEAM', rules: 'RULES', review: 'REV', start: 'START' };
  return known[name] || name.slice(0, 5).toUpperCase();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Size a canvas to its CSS box at device resolution; returns a ctx in CSS px or null if hidden. */
function fitCanvas(cv) {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * @param {import('../core/contracts.js').Analysis} analysis
 * @param {{onPause:Function, onPlay:Function, onReplay:Function, onSpeed:(n:number)=>void,
 *   onSeekSection:(i:number)=>void, onSubmitPrompt:(text:string, fileName?:string)=>void,
 *   onLoadSample:Function, getPromptText:()=>string, scoreExplainer:string}} handlers
 */
export function createHud(analysis, handlers) {
  let A = analysis;
  let last = 0;
  const prev = {};
  const speeds = [1, 2, 4];
  let speedIx = 0;
  let paused = false;

  // ---- static controls ----
  $('explainer').textContent = handlers.scoreExplainer;
  $('btn-info').addEventListener('click', () => {
    const ex = $('explainer');
    ex.hidden = !ex.hidden;
    $('btn-info').setAttribute('aria-expanded', String(!ex.hidden));
  });
  $('btn-pause').addEventListener('click', () => setPaused(!paused));
  $('btn-replay').addEventListener('click', () => {
    setPaused(false);
    handlers.onReplay();
  });
  $('btn-speed').addEventListener('click', () => {
    speedIx = (speedIx + 1) % speeds.length;
    $('btn-speed').textContent = `${speeds[speedIx]}×`;
    handlers.onSpeed(speeds[speedIx]);
  });

  function setPaused(p) {
    paused = p;
    $('btn-pause').textContent = p ? 'Play' : 'Pause';
    if (p) handlers.onPause();
    else handlers.onPlay();
  }

  // ---- editor ----
  const editor = $('editor');
  const openEditor = () => {
    $('prompt-text').value = handlers.getPromptText();
    editor.showModal();
    $('prompt-text').focus();
  };
  $('btn-edit').addEventListener('click', openEditor);
  $('btn-cancel').addEventListener('click', () => editor.close());
  $('btn-sample').addEventListener('click', () => {
    editor.close();
    handlers.onLoadSample();
  });
  $('editor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('prompt-text').value;
    if (!text.trim()) {
      $('prompt-text').focus();
      return;
    }
    editor.close();
    handlers.onSubmitPrompt(text);
  });
  $('prompt-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) $('prompt-text').value = await f.text();
    e.target.value = '';
  });

  // Drop a file anywhere to crawl it.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    $('drop-hint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-hint').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const text = await f.text();
    if (text.trim()) handlers.onSubmitPrompt(text, f.name);
  });

  // ---- flag list ----
  const flagsDlg = $('flags');
  $('btn-flags').addEventListener('click', () => {
    renderFlags();
    flagsDlg.showModal();
  });
  $('btn-flags-close').addEventListener('click', () => flagsDlg.close());
  $('btn-copy').addEventListener('click', () => {
    const text = A.flags.map((f, i) => `${i + 1}. [${A.sections[f.section].name}] "${f.word}": ${f.question}`).join('\n');
    const done = () => ($('btn-copy').textContent = 'Copied');
    navigator.clipboard?.writeText(text).then(done, () => selectText($('flag-list')));
    if (!navigator.clipboard) selectText($('flag-list'));
  });
  function selectText(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function renderFlags() {
    $('btn-copy').textContent = 'Copy questions';
    $('flag-list').innerHTML = A.flags.length
      ? A.flags
          .map((f) => {
            const sent = escapeHtml(f.sentence);
            const w = escapeHtml(f.word);
            const ix = sent.toLowerCase().indexOf(w.toLowerCase());
            const marked = ix >= 0 ? `${sent.slice(0, ix)}<mark>${sent.slice(ix, ix + w.length)}</mark>${sent.slice(ix + w.length)}` : sent;
            return `<li><span class="sec">${escapeHtml(A.sections[f.section].name)}</span> · ${marked}<div class="q">${escapeHtml(f.question)}</div></li>`;
          })
          .join('')
      : '<li>No vague words found. Nothing to ask.</li>';
  }

  // Keys: Space pause, R replay, E edit.
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('textarea, input, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && !e.target.closest?.('button')) {
      e.preventDefault();
      setPaused(!paused);
    } else if (e.key === 'r' || e.key === 'R') {
      setPaused(false);
      handlers.onReplay();
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      openEditor();
    }
  });

  // ---- per-analysis structure ----
  function build() {
    for (const k of Object.keys(prev)) delete prev[k];
    $('s-file').textContent = A.fileName;
    $('m-sections').textContent = String(A.sections.length);
    $('m-total').textContent = String(A.words.length);
    $('tabs').innerHTML = [...A.sections.map((s) => s.name), 'ship'].map((n, i) => `<button type="button" data-i="${i}">${escapeHtml(n)}</button>`).join('');
    $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => handlers.onSeekSection(Number(b.dataset.i))));
    $('secs').innerHTML = A.sections
      .map((s) => `<li><span class="nm">${escapeHtml(s.name)}</span><span class="ct">0/${s.count}</span><span class="bar"><i style="background:${s.color}"></i></span></li>`)
      .join('');
    const kinds = [['claims', 'claim'], ['owners', 'owner'], ['approvals', 'approval']];
    $('kinds').innerHTML = kinds.map(([label]) => `<li><span>${label}</span><span class="bar"><i></i></span><b>0</b></li>`).join('');
    $('heat').innerHTML = A.sections
      .map((s) => `<div class="row"><span>${escapeHtml(s.abbr)}</span>${'<i></i>'.repeat(HEAT_CELLS)}</div>`)
      .join('');
    $('log').innerHTML = '<li>&nbsp;</li>'.repeat(LOG_ROWS);
  }
  build();

  function set(id, value) {
    if (prev[id] === value) return;
    prev[id] = value;
    $(id).textContent = value;
  }

  // ---- canvases ----
  function drawRadar(run) {
    const c = fitCanvas($('radar'));
    if (!c) return;
    const { ctx, w, h } = c;
    const n = A.sections.length;
    if (n < 3) return;
    const cx = w / 2;
    const cy = h / 2 + 2;
    const R = Math.min(w * 0.36, h / 2 - 12);
    const pt = (i, r) => [cx + Math.sin((i / n) * Math.PI * 2) * r, cy - Math.cos((i / n) * Math.PI * 2) * r];
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) ctx[i ? 'lineTo' : 'moveTo'](...pt(i % n, (R * ring) / 3));
      ctx.stroke();
    }
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = TEXT_FAINT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, R + 10);
      ctx.fillText(axisLabel(A.sections[i].name), x, y);
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const s = A.sections[i];
      const f = s.count ? run.readCount[i] / s.count : 0;
      ctx[i ? 'lineTo' : 'moveTo'](...pt(i, Math.max(1.5, f * R)));
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(SPIDER, 0.42);
    ctx.fill();
    ctx.strokeStyle = SPIDER;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function drawSpark(run) {
    const c = fitCanvas($('spark'));
    if (!c) return;
    const { ctx, w, h } = c;
    const hist = run.scoreHistory;
    // A live trace: score history plus a gentle carrier so the line breathes like the reference.
    const N = 60;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const s = hist.length ? hist[Math.max(0, hist.length - N + i)] ?? hist[0] : 0;
      const wave = Math.sin(i * 0.22 + run.t * 2.2) * 0.22 + Math.sin(i * 0.09 - run.t) * 0.12;
      const x = (i / (N - 1)) * w;
      const y = h / 2 - wave * h * 0.9 - (s / 100 - 0.5) * h * 0.25;
      ctx[i ? 'lineTo' : 'moveTo'](x, y);
    }
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  function drawGauge(run) {
    const c = fitCanvas($('gauge'));
    if (!c) return;
    const { ctx, w, h } = c;
    const cx = w / 2;
    const cy = h / 2 + 4;
    const R = Math.min(w, h) / 2 - 8;
    const a0 = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const col = run.score >= 80 ? SPIDER : run.score >= 30 ? AMBER : FLAG;
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(5, R * 0.16);
    ctx.strokeStyle = '#161921';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep * Math.max(0.01, run.score / 100));
    ctx.stroke();
    ctx.fillStyle = '#e6e8ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(R * 0.62)}px ${MONO}`;
    ctx.fillText(String(run.score), cx, cy - R * 0.05);
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = '#8a8f9c';
    ctx.fillText('spec score', cx, cy + R * 0.42);
  }

  function renderCode(chars, program) {
    let left = chars;
    let html = '';
    for (const line of program.split('\n')) {
      if (left <= 0) break;
      const part = line.slice(0, left);
      left -= line.length + 1;
      const t = line.trim();
      const cls = t.startsWith('#') ? 'cm' : /^(for|if|else)\b/.test(t) ? 'kw' : / = /.test(t) ? 'as' : '';
      html += `${cls ? `<span class="${cls}">` : ''}${escapeHtml(part)}${cls ? '</span>' : ''}${left > 0 ? '\n' : ''}`;
    }
    return `${html}<span class="cursor"></span>`;
  }

  /**
   * @param {import('../core/contracts.js').RunState} run
   * @param {{program:string, force?:boolean}} opts
   */
  function update(run, opts) {
    const now = performance.now();
    if (!opts.force && now - last < 50) return;
    last = now;
    const total = A.words.length;
    const n = A.sections.length;
    const sec = A.sections[run.active];
    const ship = run.active >= n;

    set('s-words', `${run.counts.read}/${total}`);
    set('s-links', String(run.counts.linked));
    set('s-flags', String(run.counts.flagged));
    set('s-t', run.t.toFixed(2));
    set('s-frame', String(run.frame).padStart(4, '0'));

    // Header + tabs + live region only change with the active section.
    const key = `${run.active}:${run.phase === 'boot'}`;
    if (prev.head !== key) {
      prev.head = key;
      delete prev['head-sub'];
      const color = ship ? '#e6e8ee' : sec.color;
      const num = String(Math.min(run.active + 1, n + 1)).padStart(2, '0');
      $('head').style.borderLeftColor = color;
      if (run.phase === 'boot') {
        $('head-title').textContent = '00 BOOT';
        $('head-sub').textContent = `${total} words · ${n} sections`;
        $('head-sub').style.color = color;
      } else {
        $('head-title').textContent = `${num} ${ship ? 'SHIP' : sec.name.toUpperCase()}`;
        $('head-sub').style.color = ship ? '#e6e8ee' : color;
      }
      if (!ship && run.phase !== 'boot') {
        $('head-sub').textContent = sec.subtitle;
        $('live').textContent = `Reading section ${sec.name}`;
      }
    }
    if (ship) {
      set('head-sub', `${run.counts.read} words read · ${run.counts.flagged} flagged · ${run.counts.guessed} guessed`);
      if (prev.liveShip !== true) {
        prev.liveShip = true;
        $('live').textContent = `Done. ${run.counts.flagged} flags to ask about. Spec score ${run.score}.`;
      }
    } else prev.liveShip = false;

    const tabsKey = run.status.join() + run.active;
    if (prev.tabs !== tabsKey) {
      prev.tabs = tabsKey;
      $('tabs').querySelectorAll('button').forEach((b, i) => {
        const active = i === run.active;
        b.className = active ? 'active' : i < n && run.status[i] === 'done' ? 'done' : '';
        b.style.background = active ? (i < n ? A.sections[i].color : '#e6e8ee') : '';
        b.setAttribute('aria-current', active ? 'step' : 'false');
      });
    }
    const label = ship ? `Finished: ${run.counts.read} words read, ${run.counts.flagged} flagged, spec score ${run.score}` : `Reading section ${sec?.name ?? ''}, ${run.counts.read} of ${total} words`;
    if (prev.aria !== label) {
      prev.aria = label;
      $('stage').setAttribute('aria-label', label);
    }

    // Crawl log.
    if (prev.logSeq !== run.logSeq) {
      prev.logSeq = run.logSeq;
      const rows = run.log.slice(-LOG_ROWS);
      const pad = LOG_ROWS - rows.length;
      $('log').innerHTML =
        '<li>&nbsp;</li>'.repeat(pad) +
        rows
          .map((e, i) => {
            const fade = Math.min(1, 0.25 + (pad + i) / (LOG_ROWS * 0.5));
            const color = A.sections[e.section]?.color ?? '#e6e8ee';
            return `<li style="opacity:${fade.toFixed(2)}"><span class="tm">${e.clock}</span><span class="vb ${e.verb}">${e.verb}</span> <span style="color:${e.verb === 'walk' ? 'var(--mint)' : color}">${escapeHtml(e.text)}</span></li>`;
          })
          .join('');
    }
    set('m-wps', `${run.wps} w/s`);

    // Sections.
    const secKey = run.readCount.join() + run.active;
    if (prev.secs !== secKey) {
      prev.secs = secKey;
      $('secs').querySelectorAll('li').forEach((li, i) => {
        const s = A.sections[i];
        li.className = i === run.active ? 'active' : '';
        li.querySelector('.nm').style.color = i === run.active ? s.color : '';
        li.querySelector('.ct').textContent = `${run.readCount[i]}/${s.count}`;
        li.querySelector('.bar i').style.width = `${s.count ? (100 * run.readCount[i]) / s.count : 0}%`;
      });
      // Word heat: each cell is a bucket of the section's words.
      $('heat').querySelectorAll('.row').forEach((row, i) => {
        const s = A.sections[i];
        row.querySelectorAll('i').forEach((cell, k) => {
          const from = s.start + Math.floor((k * s.count) / HEAT_CELLS);
          const to = s.start + Math.floor(((k + 1) * s.count) / HEAT_CELLS);
          let read = 0;
          for (let id = from; id < to; id++) if (run.wordState[id] === 2) read++;
          const f = to > from ? read / (to - from) : 0;
          cell.style.background = f > 0 ? withAlpha(s.color, 0.25 + 0.75 * f) : '';
        });
      });
    }

    // Kind bars.
    const by = A.totals.byKind;
    const kc = [
      [run.counts.claims, by.claim],
      [run.counts.owners, by.owner],
      [run.counts.approvals, by.approval],
    ];
    const kKey = kc.map((k) => k[0]).join();
    if (prev.kinds !== kKey) {
      prev.kinds = kKey;
      $('kinds').querySelectorAll('li').forEach((li, i) => {
        li.querySelector('i').style.width = `${kc[i][1] ? (100 * kc[i][0]) / kc[i][1] : 0}%`;
        li.querySelector('b').textContent = String(kc[i][0]);
      });
    }

    set('wpm', `${run.wps * 60}/m`);
    set('t-read', String(run.counts.read));
    set('t-linked', String(run.counts.linked));
    set('t-flagged', String(run.counts.flagged));
    set('t-guessed', String(run.counts.guessed));
    set('btn-flags', `flags to ask · ${run.counts.flagged}`);
    set('m-lps', `${run.lps} l/s`);

    if (prev.code !== run.codeChars) {
      prev.code = run.codeChars;
      $('code').innerHTML = renderCode(run.codeChars, opts.program);
    }

    drawRadar(run);
    drawSpark(run);
    drawGauge(run);
  }

  return {
    update,
    reset(analysis2) {
      A = analysis2;
      build();
    },
    setPaused,
  };
}
