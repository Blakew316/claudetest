/**
 * The DOM around the full-screen stage: stats line, tabs, section header,
 * controls, the prompt editor and the flag list. Reads run state only; user
 * actions go out through `handlers`. Updates are throttled to ~20 Hz and only
 * touch the DOM when a value changed.
 */

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
  $('score-stat').title = handlers.scoreExplainer;
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
    $('tabs').innerHTML = [...A.sections.map((s) => s.name), 'ship'].map((n, i) => `<button type="button" data-i="${i}">${escapeHtml(n)}</button>`).join('');
    $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => handlers.onSeekSection(Number(b.dataset.i))));
  }
  build();

  function set(id, value) {
    if (prev[id] === value) return;
    prev[id] = value;
    $(id).textContent = value;
  }

  /**
   * @param {import('../core/contracts.js').RunState} run
   * @param {{force?:boolean}} [opts]
   */
  function update(run, opts = {}) {
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
    set('s-score', String(run.score));
    set('btn-flags', `flags to ask · ${run.counts.flagged}`);

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
