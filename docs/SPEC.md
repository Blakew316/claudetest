# Prompt Crawler: build spec

A single-page web app. A procedural spider crawls a prompt section by section
through glowing particle clouds. It reaches out with dotted tentacles to read
every word, links the words that make a prompt specific (owners, approvals,
claims, specs, files) and flags the vague ones in pink. A six-panel dashboard
updates live. At the end it zooms out to a "ship" overview and lists the
questions the author should answer.

The user pastes their own prompt (or drops a `.md`/`.txt` file) and the crawl
reruns on it. The built-in sample is `src/analyze/sample.js`.

Reference look: a 1080×1350 screen recording (portrait). Everything below
describes that footage and how to reproduce it.

## Stack and constraints

- Vanilla JS ES modules, no framework, no runtime dependencies. Canvas 2D for
  the stage, DOM for the HUD.
- Dev: `npm run dev` serves the repo root; `index.html` loads `src/main.js`.
- `npm run build` uses esbuild to emit **one self-contained file**,
  `dist/prompt-crawler.html` (CSS and JS inlined), which must work from
  `file://` and as a sandboxed artifact (no network except Google Fonts; no
  `alert/confirm/prompt`; no query-string state; `localStorage` wrapped in
  try/catch).
- Font: JetBrains Mono from Google Fonts (400, 500, 700) with the `MONO`
  fallback stack from `src/core/theme.js`. Canvas text must re-render once
  `document.fonts.ready` resolves.
- Deterministic: the sim steps at a fixed `SIM_DT` (1/60 s). The same prompt
  produces the same frames. `window.crawler` exposes
  `{ seek(t), play(), pause(), restart(text?), state, analysis, world }` for
  the screenshot harness. `seek(t)` restarts and fast-forwards the sim to time
  `t` without rendering intermediate frames, then renders once.
- Single dark look by design: `color-scheme: dark` on `:root`, explicit
  background on `body`; every colour is a CSS custom property mirrored from
  `src/core/theme.js`.
- `prefers-reduced-motion: reduce`: open directly on the finished ship view
  with a "Play crawl" button; when played, no leg jitter or camera shake.

## Files and ownership

| Path | Owner | What |
| --- | --- | --- |
| `src/core/*`, `src/world/camera.js`, `src/analyze/sample.js` | done | contracts, rng, theme, camera, sample prompt |
| `src/analyze/{parse,lexicon,score}.js`, `test/analyze.test.js` | analysis | prompt to `Analysis` |
| `src/world/{field,labels}.js` | world | clusters, word nodes, labels |
| `src/world/spider.js` | spider | spider, legs, tentacles, silk, tag |
| `index.html`, `src/styles.css`, `src/hud/*` | hud | top bar, tabs, header, six panels, controls, editor, flag list |
| `src/sim/director.js`, `src/main.js`, `scripts/*`, `test/director.test.js` | integration | timeline, loop, build, screenshot harness |

Contracts live in `src/core/contracts.js`. Do not change a contract without
updating every consumer.

## Analysis (`src/analyze`)

`parsePrompt(text, { fileName }) -> Analysis` (in `parse.js`).

Section detection, first rule that yields at least 2 sections wins
(`notes.detectedBy`):
1. **markdown**: `#`–`######` headings. If there is exactly one H1 and it
   precedes H2s, the H1 becomes `fileName` (when it looks like a file name or
   short title) and H2s are sections. Text before the first section heading
   becomes a `preamble` section if it has 3+ words.
2. **xml**: top-level `<tag>…</tag>` blocks (common in Claude prompts).
3. **labels**: lines that are only `LABEL:` / `Label:` (1–3 words), or start
   with `ROLE:` style uppercase labels.
4. **paragraphs**: blank-line paragraphs; one paragraph is split into
   sentence groups of ~25–40 words. Names are `part 1`, `part 2`, … unless a
   paragraph starts with a short bolded/labelled lead.

Heading text `name — tagline` (em dash, en dash, ` - ` or `: `) splits into
name and subtitle. Without a tagline, derive one: up to 4 salient words (not
stopwords, first occurrence order, preferring verbs/nouns that appear in the
section) joined with ` · `. Section `name` is lower-cased, max 18 chars.
`abbr` is the first 3 letters upper-cased. `key` is a unique slug.

Tokenising: strip markdown syntax (`#`, `*`, `_` emphasis, backticks, `>`,
list bullets, link URLs keep their text). Skip fenced code blocks (count them
in `notes.skippedCodeBlocks`). A word is a run of letters/digits that may
contain internal `.` `-` `_` `/` `'` `:` (keeps `BRAND.md`, `5.5`,
`1600px`, `/research`, `900-word`, `16:9`, `don't`). Leading `/` is kept for
paths. Edge punctuation is stripped. Every token counts, stopwords included.
Cap at 1,500 words (`notes.truncated`, `notes.originalWords`); cap at 12
sections (merge the tail into the 12th).

Classification (`lexicon.js`, data-driven tables plus a few rules) assigns
each word either a link `kind`, a `vague` flag, or nothing:
- **owner**: people and agents with responsibility: you, owner/owners/owns,
  producer, writer, editor, designer, researcher, publisher, staff, chief,
  team, lead, manager, reviewer, client, customer, user, stakeholder,
  engineer, developer, author, operator, assistant, agent, approver.
- **approval**: approve/approval/approved/approves, sign-off, signoff,
  permission, consent, authorize, confirm, gate, buying, purchase, spend,
  publish/publishing, merge, deploy.
- **claim**: claim/claims, fact/facts, source/sources/sourced, cite,
  citation, evidence, verify/verified, trace/traceable, quote, credit/credits,
  reference, proof, accurate.
- **spec**: numbers with or without units (`5.5`, `1600px`, `30s`, `4k`,
  `16:9`, `v2`, `900-word`, ISO dates), media formats (`png wav mp4 pdf svg
  csv json`), timestamp, deadline, pixel/percent words with numbers.
- **file**: tokens with a file extension (`BRAND.md`, `manifest.json`),
  paths (`/research`, `src/x`), URLs, and the words file/files, folder,
  directory, manifest, repo.
- **vague**: a table of words and phrases, each with a question to ask:
  full, short, long, nice, clean, good, great, better, best, appropriate,
  relevant, proper, properly, some, several, various, many, few, soon,
  quickly, fast, asap, simple, simply, easy, basically, maybe, probably,
  perhaps, etc, stuff, things, taste, vibe, polished, smallest, small, large,
  robust, seamless, intuitive, modern, engaging, high-quality, plus phrases
  `as needed`, `if possible`, `and so on`, `when necessary`, `as
  appropriate`, `a bit`, `kind of`, `sort of`. For a phrase, the flag goes
  on its last word. A size/quantity/time word is **not** vague when a number
  sits within 2 words of it (`short 200-word note` is specific). Questions are
  concrete, e.g. `full` → "Full means which items? List them."
- Exact (case-insensitive) lexicon hits are links with `guessed: false`.
  Stem/suffix fallback hits (`approvers`, `sourcing`) are links with
  `guessed: true`.

`computeScore(analysis, counts) -> 0..100` (in `score.js`) is a pure, documented
function of what has been read so far. It rises with coverage
(`read/total`), with specificity (linked words per read word, saturating
around 18%), and falls with vague flags per read word. The finished sample
must land between 75 and 88. Export the formula's description as
`SCORE_EXPLAINER` (one or two plain sentences) for the HUD tooltip.

Tests (`node --test`): sample yields 7 sections named role, objective,
context, roles, rules, review, start with the authored taglines; word totals
are stable; known words classify as expected; xml/labels/paragraph fallbacks
work; empty and whitespace-only input returns one empty-safe section rather
than throwing; a 10k-word input is truncated and parses in < 200 ms.

## World (`src/world/field.js`, `src/world/labels.js`)

`buildWorld(analysis, seed) -> World` places one cluster per section.
- Cluster radius `r = 150 + 14 * sqrt(count)` (clamped 150..420).
- Layout: deterministic packing. Cluster 0 at the origin; each next cluster
  goes at a seeded angle chosen so consecutive clusters change direction
  (the spider's walks zig-zag: up, left, down-right, …), touching or slightly
  overlapping existing clusters (centre distance ≈ 0.95–1.1 × (r1+r2)), never
  overlapping by more than 25%. The overview of all clusters reads as one
  lumpy nebula.
- Particles: 700 + 60 × sqrt(count) per cluster (cap 2,200). Gaussian blob
  warped by low-frequency value noise so edges are wispy, not circular.
  1–3 nearest-neighbour edges per particle within a distance cutoff (grid
  hash) so it reads as a constellation web. About 3% are brighter "stars"
  (2–3 px squares); the rest 1–1.5 px.
- Word nodes: each word of the section sits on a particle within 0.8 r,
  spread out (Poisson-ish, avoid clumping). `wordPos` holds their positions.
- Colour by status: `queued` clusters draw desaturated grey (`QUEUED`) at
  low alpha; `reading`/`done` draw in the section colour; the active cluster
  gets a soft radial glow in its colour behind it. Status changes crossfade
  over ~0.6 s (use `run.t`).
- Read word nodes: small bright square in the section colour; vague words a
  pink square; unread word nodes are ordinary particles.
- Ambient life: slow twinkle on stars; nothing jitters.
- Performance: pre-render each cluster's static particles and edges once to
  offscreen canvases (a grey and a coloured variant, crossfaded with
  `globalAlpha`), sized to the cluster bounds at a resolution good for zoom
  up to ~1.6 at dpr 2 (cap ~1,600 px per side). Per frame, draw only the
  bitmaps, the glow, stars and the word-node squares. `drawWorld` must stay
  under ~4 ms per frame at 1080×1350.

`drawWorld(ctx, world, run, view, analysis)` draws in world space (use
`applyWorldTransform`).

`drawLabels(ctx, world, run, view, analysis)` draws in **screen space** at a
constant size regardless of zoom:
- Section title at `labelX/labelY`: name in 20 px section colour (queued:
  grey), and beneath it 11 px dim `24/25 words · reading` (`queued`,
  `reading`, `done`).
- Word labels for read words, monospace 11 px, 1 px box, 3 px padding:
  - plain word: box border and text in the section colour (border ~70%
    alpha, fill `rgba(5,6,9,0.78)`).
  - linked word: `word · kind` (e.g. `owners · owner`, `BRAND.md · file`).
  - vague word: filled `FLAG` box, dark text: `word · ⚑ vague`.
  Labels fade in over 0.25 s from `readAt`, sit just up-right of the node,
  and stay. Labels of the active section are full opacity; other sections'
  labels at 35% during the crawl. In the ship phase all labels show at about
  80% so the overview is dense and colourful (the reference shows heavy
  overlap there and that is fine).
  Plain stopword labels ("the", "and", "a", "of", "to", "in", "is", "it", "for")
  may be skipped once their section is done, to reduce clutter.
- Cull anything off-screen.

## Spider (`src/world/spider.js`)

`class Spider { constructor(x, y, seed); update(dt, run, world); draw(ctx, run, view); }`
plus `drawTentacles(ctx, world, run, view)`, `drawSilk(ctx, run, view, analysis)`,
`drawTag(ctx, run, view, analysis)`.

- `update` steers toward `run.spiderGoal` (arrive behaviour, max speed ~520
  world u/s, slight lateral wander so paths curve) and writes `run.spider`
  `{x, y, vx, vy, heading}`; heading eases toward the velocity direction.
- Body: ellipse ~26×20 u, rotated to heading. Teal (`SPIDER`) 1.5 px
  outline, a wireframe grid of latitude/longitude lines clipped inside the
  ellipse that slowly scrolls (pseudo-3D rotation), dark translucent fill,
  and a soft teal glow around it (radial gradient, additive).
  Core: a pink (`FLAG`) square ~9 u, rotating.
- Head: small circle ~7 u ahead of the body along the heading, two eye dots,
  two short curved pedipalps.
- 16 legs (`LEG_COUNT`) radiating all around the body (sea-urchin silhouette
  in the reference), each a 2-segment IK limb (~30 + 30 u) with a dot at the
  knee and the foot. Feet are planted in world space and step when the foot
  is too far from its rest point (rest point leads in the direction of travel),
  in two alternating groups, with a short arc lift. While stationary, feet
  still twitch slightly (disabled under reduced motion).
- Tentacles: for each `run.tentacles` entry, a dotted curve (quadratic
  bezier bowed slightly sideways) from the body edge to the word node, dots
  every ~5 screen px, 1.6 px, `TENTACLE` colour, drawn up to `p` of its
  length; a small ring (r ~5 u) around the target node while holding.
- Silk: the `run.silk` polyline as a smooth 1.2 px curve in the colour of
  `run.silkSection`, fading toward its tail.
- Tag: `crawler · <section name>` in 11 px section colour just below-right of
  the body, screen space.

## Director (`src/sim/director.js`)

`createDirector(analysis, world, spider) -> { step(dt), seek(t), run }`.
Pure sim, no DOM. Fixed step. Timeline:
- `boot` (0.8 s): spider at cluster 0, legs unfold, camera at cluster 0.
- per section: `walk` → spider goal = cluster centre (with a small offset
  toward its words); ends when within ~30 u (or after 2.5 s). Log one
  `walk → name` entry when it starts. `wps` decays to 0.
- `read`: every `1/rate` s start a tentacle to the next unread word (reading
  order) while fewer than `MAX_TENTACLES` are active. Rate =
  clamp(count / 2.4, 8, 40) words/s, so a section takes ~2.4 s. Tentacle
  reach 0.18 s → word becomes read (`wordState=2`, `readAt=t`), counts update,
  one log entry (`read` / `link` / `flag`) → hold 0.5 s → retract 0.2 s →
  removed. Spider goal drifts toward the centroid of the next ~6 unread
  words. Section done when all words are read and tentacles have retracted.
- `ship`: camera eases to fit all clusters; status all done; `done=true`
  after 1.5 s. Spider idles near the centre of the cluster nearest the
  overall centroid.
- Camera target while crawling: spider position blended 70/30 with the
  active cluster centre, zoom such that the active cluster spans ~70% of the
  smaller stage dimension (clamped 0.6..1.8).
- Score: `computeScore` every step; `scoreHistory` at 10 Hz.
- `codeChars` advances at ~15 lines/s worth of characters during reading and
  stops when the whole program is shown.
- Silk: append the spider position when it moved > 6 u; keep ~260 points;
  `silkSection` = the section it is walking away from.
Total for the sample ≈ 24–28 s.

## HUD (`index.html`, `src/styles.css`, `src/hud/*`)

Layout (full viewport, never scrolls the body): stage canvas fills the page;
overlays on top of it; the dashboard row docks at the bottom.

- **Top stats bar** (one line, 11 px, uppercase dim labels, bold values):
  `SWARM prompt-crawler · LEGS 16 · TENTACLES 22 (mint) · WORDS READ 154/181 ·
  LINKS 39 (amber) · FLAGS 9 (pink) · T 16.65 · FRAME 0998`; right-aligned the
  file name in pink. Values use tabular numbers.
- **Tabs**: one equal-width cell per section plus `ship`. Active cell filled
  with the section colour, dark text; done cells light text on `#111319`;
  queued cells faint text. Clicking a tab seeks to the start of that
  section's read (or the ship view).
- **Section header** (top-left of stage): 4 px colour bar, `05 RULES` 26 px
  bold, tagline 13 px in the section colour beneath. Ship header:
  `08 SHIP` / `181 words read · 12 flagged · 2 guessed`.
- **Controls** (top-right under the file name, small ghost buttons with
  visible focus): pause/play, replay, speed (1×/2×/4×), "Your prompt".
  Keys: Space, R, E. The "Your prompt" panel is an overlay with a labelled
  textarea pre-filled with the current prompt, a format hint ("Sections come
  from ## headings, <xml> tags or LABEL: lines. Add ' — tagline' after a
  heading."), buttons "Crawl it" and "Load sample", a file picker; dropping a
  .md/.txt anywhere also crawls it. Last prompt is kept in localStorage.
- **Dashboard**: 6 panels in one row (`CRAWL LOG`, `SECTIONS`, `COVERAGE
  RADAR`, `WORD HEAT`, `SPEC SCORE`, `CRAWLER.PY`), each: bg `PANEL_BG`, 1 px
  `PANEL_BORDER`, 2 px radius, 10 px padding, 11 px bold uppercase title with
  a meta value right-aligned (mint, except crawler.py's in pink).
  - CRAWL LOG (`N w/s`): last ~15 entries, newest at the bottom, the top
    rows fading. `HH:MM` dim, verb coloured (read dim white, link amber,
    flag pink, walk mint), word in its section colour; walk rows read
    `walk → rules`.
  - SECTIONS (`7`): name + `n/total` right, 3 px bar in the section colour;
    the active row's name bold in its colour; footer `words → kinds → links`
    dim.
  - COVERAGE RADAR (`live`): polygon with one axis per section (abbr labels:
    ROLE, OBJ, CTX, TEAM, …, derive short labels), 3 grid rings, filled mint
    at ~45% with a mint stroke, value = section read fraction. Below: three
    rows claims / owners / approvals with mint bars and counts.
  - WORD HEAT (total words): one row per section (abbr), 12 cells; each
    cell is a bucket of that section's words, lit in the section colour in
    proportion to how many are read, dark when none. Then `words per second`
    and a large `1320/m` (words per minute), then rows read (white), linked
    (amber), flagged (pink), guessed (mint).
  - SPEC SCORE (`live`): an amber sparkline of `scoreHistory` at the top;
    a 270° gauge with a dark track whose arc is pink below 30, amber 30–79,
    mint 80+; the number large in the centre, `spec score` beneath; footer
    `flags to ask · N` in pink (a button: opens the flag list) and `ask,
    don't guess` dim. An info affordance shows `SCORE_EXPLAINER`.
  - CRAWLER.PY (`15 l/s`): the program below revealed `codeChars` at a time
    with a pink block cursor; comment dim, assignment lines mint, `for`/`if`
    lines pink, other lines white; no wrapping (clip).
    ```
    # crawler.py · reads a prompt
    graph = load("studio.prompt")
    spider = Crawler(legs=16, tentacles=22)

    for section in graph.sections:
        spider.walk_to(section)
        for word in spider.reach(section):
            kind = classify(word)
            if kind == "vague":
                flags.append(word)
            else:
                graph.link(word, kind)
    ```
    (`studio.prompt` is replaced by the current file name.)
- **Flag list** overlay ("Questions before you ship"): one row per flag with
  the section, the word highlighted inside its sentence, and the question.
  A "Copy questions" button (clipboard inside the click handler; fallback to
  selecting the text). Available any time; auto-opens never.
- Responsive: at ≥ 900 px wide the dashboard is a 6-column row, height
  ~22% of the viewport (min 220 px, max 300 px). Below 900 px the dashboard
  becomes a horizontally scrollable strip (its own `overflow-x: auto`,
  scroll-snap, panels ~260 px wide) and the stats bar wraps; tabs scroll
  horizontally. Side gutters ≥ 8 px; nothing makes the body scroll sideways.
- Accessibility: the canvas has `role="img"` and an `aria-label` kept
  current ("Reading section rules, 154 of 181 words"); a visually hidden
  polite live region announces section changes; all controls are buttons
  with labels and a visible focus ring; the editor and flag list trap focus
  and close on Escape.
- HUD updates are throttled to ~20 Hz and only write the DOM when a value
  changed.

`createHud(root, analysis, handlers) -> { update(run, analysis), reset(analysis) }`
where `handlers = { onPause, onPlay, onReplay, onSpeed(n), onSeekSection(i),
onSubmitPrompt(text, fileName), onLoadSample() }`.

## Screenshot harness (`scripts/shoot.mjs`)

Uses the globally installed Playwright
(`createRequire(import.meta.url)('/opt/node22/lib/node_modules/playwright')`,
falling back to `require('playwright')`; `chromium.launch()` finds the bundled
browser). Serves the repo (or opens `dist/prompt-crawler.html`
via `file://`), sets the viewport to 1080×1350, and for each requested time
calls `window.crawler.seek(t)` then saves `shots/t_<t>.png`. Also supports
`--size 1440x900` and `--size 390x844`. Prints console errors and fails on
any.
