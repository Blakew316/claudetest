/**
 * The data contracts every module agrees on. Read this before touching any
 * other file: analysis (what the prompt says) is produced once by
 * src/analyze, world (where things are) once by src/world/field.js, and the
 * run state (what has happened so far) is mutated ONLY by src/sim/director.js
 * (plus `run.spider`, which Spider.update writes). Renderers and the HUD only
 * read.
 *
 * @typedef {'owner'|'approval'|'claim'|'spec'|'file'} LinkKind
 *
 * @typedef {Object} Word
 * @property {number} id          global index 0..N-1 in reading order
 * @property {number} section     index into analysis.sections
 * @property {string} text        the word as written, edge punctuation stripped
 * @property {LinkKind|null} kind link kind, or null for a plain word
 * @property {boolean} guessed    kind came from a stem/suffix fallback, not an exact lexicon hit
 * @property {boolean} vague      flagged as vague (vague words never also carry a kind)
 * @property {string|null} question  for vague words, the question to put to the author
 * @property {number} sentence    index into analysis.sentences
 *
 * @typedef {Object} Section
 * @property {number} index
 * @property {string} key       unique slug ('role', 'roles', 'part-3')
 * @property {string} name      display name, lower case ('role')
 * @property {string} abbr      3-letter upper case ('ROL'); duplicates allowed
 * @property {string} subtitle  tagline ('who the studio works for')
 * @property {string} color     theme.sectionColor(index)
 * @property {number} start     id of its first word
 * @property {number} count     number of words
 *
 * @typedef {Object} Flag
 * @property {number} wordId
 * @property {string} word
 * @property {number} section
 * @property {string} sentence   the full sentence the word sits in
 * @property {string} question
 *
 * @typedef {Object} Analysis
 * @property {string} fileName   shown top-right, e.g. 'studio.prompt'
 * @property {Section[]} sections
 * @property {Word[]} words
 * @property {string[]} sentences
 * @property {Flag[]} flags
 * @property {{words:number, linked:number, vague:number, guessed:number,
 *             byKind:{owner:number, approval:number, claim:number, spec:number, file:number}}} totals
 * @property {{detectedBy:'markdown'|'xml'|'labels'|'paragraphs', truncated:boolean,
 *             originalWords:number, skippedCodeBlocks:number}} notes
 *
 * @typedef {Object} Cluster
 * @property {number} index
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} r          rough radius of the particle cloud (world units)
 * @property {string} color
 *
 * @typedef {Object} World
 * @property {Cluster[]} clusters
 * @property {Float32Array} wordPos   [x0, y0, z0, x1, y1, z1, ...] 3D position of each word node
 * @property {{x:number, y:number, z:number, radius:number}} bounds  bounding sphere
 *
 * @typedef {Object} Tentacle
 * @property {number} wordId
 * @property {number} born       run.t when it started reaching
 * @property {'reach'|'hold'|'retract'} stage
 * @property {number} p          0..1 extension
 *
 * @typedef {Object} LogEntry
 * @property {string} clock      wall clock 'HH:MM'
 * @property {'read'|'link'|'flag'|'walk'} verb
 * @property {string} text       the word, or '→ rules' for walk
 * @property {number} section
 *
 * @typedef {Object} View   rebuilt by main.js every frame
 * @property {number} width   stage width, CSS px
 * @property {number} height  stage height, CSS px
 * @property {number} dpr
 * @property {number} time    run.t (sim seconds), for idle animation
 * @property {(x:number, y:number, z:number, out?:object) => {x:number, y:number, vis:boolean, d:number}} project
 * @property {number} camDist
 */

export const LINK_KINDS = /** @type {const} */ (['owner', 'approval', 'claim', 'spec', 'file']);

/** Maximum simultaneous tentacles (the "TENTACLES 22" readout). */
export const MAX_TENTACLES = 22;
/** Leg count (the "LEGS 16" readout). */
export const LEG_COUNT = 8; // a real spider: four pairs
/** Fixed simulation step. The sim is deterministic at this step. */
export const SIM_DT = 1 / 60;

/**
 * @typedef {Object} RunState
 * @property {number} t                 sim seconds since start
 * @property {number} frame             sim frames since start
 * @property {'boot'|'walk'|'read'|'visit'|'ship'} phase
 * @property {number} phaseT            seconds since the phase began
 * @property {number} active            active section; === sections.length in 'ship'
 * @property {('queued'|'reading'|'done')[]} status   per section
 * @property {Uint8Array} wordState     per word: 0 unread, 1 tentacle reaching, 2 read
 * @property {Float32Array} readAt      per word: run.t when read, -1 if unread
 * @property {number[]} readCount       per section
 * @property {{read:number, linked:number, flagged:number, guessed:number,
 *             claims:number, owners:number, approvals:number}} counts
 * @property {Tentacle[]} tentacles
 * @property {LogEntry[]} log           newest last, capped at 40
 * @property {number} wps               smoothed words/second, 0 while walking
 * @property {number} score             0..100
 * @property {number[]} scoreHistory    sampled at 10 Hz, capped at 120
 * @property {{x:number, y:number, z:number, vx:number, vy:number, vz:number, heading:number}} spider  written by Spider.update
 * @property {{x:number, y:number, z:number}} spiderGoal   where the director wants the spider
 * @property {{x:number, y:number, s:number, t:number}[]} silk  silk anchors (s = section colour), written by Spider.update, newest last
 * @property {number} silkSection       section whose colour new silk is spun in
 * @property {{x:number, y:number, z:number, dist:number, yaw:number, pitch:number}} camera  orbit rig, see world/camera.js
 * @property {number} codeChars         characters of crawler.py revealed so far
 * @property {number} lps               crawler.py lines/second for the panel header
 * @property {{id:string, from:number[], c1:number[], c2:number[], to:number[], t0:number, dur:number}} [travel]
 * @property {{cluster:number}|null} [visit]  the extra (no-word) ball being leapt through, if any
 *           current drift between sections (cubic bezier), set by the director, followed by Spider
 * @property {boolean} done             ship phase has settled
 */

/** Fresh run state for an analysis. Only the director should call this. */
export function createRunState(analysis) {
  const n = analysis.words.length;
  return {
    t: 0,
    frame: 0,
    phase: 'boot',
    phaseT: 0,
    active: 0,
    status: analysis.sections.map(() => 'queued'),
    wordState: new Uint8Array(n),
    readAt: new Float32Array(n).fill(-1),
    readCount: analysis.sections.map(() => 0),
    counts: { read: 0, linked: 0, flagged: 0, guessed: 0, claims: 0, owners: 0, approvals: 0 },
    tentacles: [],
    log: [],
    wps: 0,
    score: 0,
    scoreHistory: [],
    spider: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0 },
    spiderGoal: { x: 0, y: 0, z: 0 },
    silk: [],
    silkSection: 0,
    camera: { x: 0, y: 0, z: 0, dist: 1000, yaw: 0, pitch: 0.5 },
    codeChars: 0,
    lps: 0,
    done: false,
  };
}
