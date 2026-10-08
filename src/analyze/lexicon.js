/**
 * The crawler's vocabulary: which words make a prompt specific (and what kind
 * of link they are), which words are vague (and what to ask the author), and
 * the handful of context rules that stop the obvious false positives.
 *
 * Everything a reader might want to tweak is a plain table at the top of this
 * file. The functions at the bottom only apply the tables.
 *
 * Decisions worth knowing:
 * - "you" is NOT an owner. Every prompt is addressed to "you", so it says
 *   nothing about who owns what (the reference footage labels it plain too).
 * - Spelled-out numbers ("one", "six") are NOT spec links: "one" is as often
 *   a pronoun as a quantity. Digits are always specific ("1600px", "v2").
 *   Spelled-out numbers DO count as "a number nearby" for the vague-word
 *   exemption ("a short two-page note" is specific).
 * - Exact table hits are links with guessed: false. A word that only matches
 *   after removing a suffix ("approvers" -> "approver", "sourcing" ->
 *   "source") is a link with guessed: true.
 */

/* ------------------------------------------------------------------------ */
/* Link tables: word -> kind. Lower case. Exact hits only.                  */
/* ------------------------------------------------------------------------ */

/** @type {Record<import('../core/contracts.js').LinkKind, string[]>} */
export const LINK_WORDS = {
  // People and agents who are responsible for something.
  owner: [
    'owner', 'owners', 'owns', 'ownership',
    'producer', 'producers', 'writer', 'writers', 'editor', 'editors',
    'designer', 'designers', 'researcher', 'researchers', 'publisher', 'publishers',
    'staff', 'chief', 'team', 'teams', 'manager', 'managers',
    'reviewer', 'reviewers', 'client', 'clients', 'customer', 'customers',
    'user', 'users', 'stakeholder', 'stakeholders', 'engineer', 'engineers',
    'developer', 'developers', 'author', 'authors', 'operator', 'operators',
    'assistant', 'assistants', 'agent', 'agents', 'approver',
    'maintainer', 'maintainers', 'director', 'supervisor',
    // 'lead' is handled by a context rule below ("team lead" yes, "lead with" no).
  ],
  // Gates: someone has to say yes before this happens.
  approval: [
    'approve', 'approves', 'approved', 'approval', 'approvals',
    'sign-off', 'signoff', 'sign-offs', 'permission', 'permissions',
    'consent', 'authorize', 'authorise', 'authorized', 'authorised', 'authorization',
    'confirm', 'confirms', 'confirmed', 'confirmation',
    'gate', 'gates', 'gated', 'buying', 'buy', 'purchase', 'purchases', 'spend',
    'publish', 'publishes', 'publishing', 'merge', 'deploy', 'deploys', 'deployment',
    'veto', 'escalate',
  ],
  // Statements that must be backed by something you can check.
  claim: [
    'claim', 'claims', 'fact', 'facts', 'factual',
    'source', 'sources', 'sourced', 'cite', 'cites', 'cited', 'citation', 'citations',
    'evidence', 'verify', 'verifies', 'verified', 'verification',
    'trace', 'traces', 'traceable', 'quote', 'quotes', 'credit', 'credits',
    'reference', 'references', 'proof', 'prove', 'accurate', 'accuracy',
    'attribution', 'correction', 'corrections', 'corrected', 'fact-check',
  ],
  // Formats and named measurements. (Anything containing a digit is spec by rule.)
  spec: [
    'timestamp', 'timestamps', 'deadline', 'deadlines', 'utc',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'csv', 'tsv',
    'json', 'jsonl', 'yaml', 'xml', 'html', 'markdown',
    'wav', 'mp3', 'mp4', 'mov',
  ],
  // Places where things live. (Extensions, paths and URLs are file by rule.)
  file: [
    'file', 'files', 'filename', 'folder', 'folders', 'directory', 'directories',
    'manifest', 'manifests', 'repo', 'repos', 'repository', 'attachment', 'attachments',
  ],
};

/**
 * Units that only count as spec when a digit-number sits within 2 words
 * ("1600 pixels", "30 percent"). On their own they are plain.
 */
export const UNIT_WORDS = ['px', 'pixel', 'pixels', 'percent', 'dpi', 'fps', 'kb', 'mb', 'gb'];

/** Extensions that make "name.ext" a file. A whitelist, so "e.g" and "5.5" are not files. */
export const FILE_EXTENSIONS = [
  'md', 'mdx', 'txt', 'rtf', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg', 'conf',
  'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'ipynb', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'sql', 'lock', 'log',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'psd', 'ai', 'fig',
  'mp3', 'mp4', 'wav', 'mov', 'aiff', 'flac', 'zip', 'tar', 'gz', 'prompt',
];

/** Top-level domains that make "name.tld" a URL (and so a file link). */
export const URL_TLDS = ['com', 'org', 'net', 'io', 'dev', 'ai', 'app', 'co', 'edu', 'gov', 'uk'];

/** First path segments that make "a/b" a path rather than "and/or". */
export const PATH_ROOTS = [
  'src', 'lib', 'docs', 'doc', 'test', 'tests', 'app', 'apps', 'scripts', 'assets', 'public',
  'dist', 'build', 'research', 'drafts', 'data', 'config', 'notes', 'content', 'pages', 'out',
];

/* ------------------------------------------------------------------------ */
/* Vague words: word -> the question to put to the author.                  */
/* ------------------------------------------------------------------------ */

/** @type {Record<string, string>} */
export const VAGUE_WORDS = {
  full: 'Full means which items? List them.',
  short: 'How short? Give a word, line or time limit.',
  long: 'How long? Give a number with a unit.',
  nice: 'Nice by whose standard? Name a reference or a rule to check against.',
  clean: 'Clean how? Say what must be removed or which style guide applies.',
  good: 'Good against what bar? Describe what a pass looks like.',
  great: 'What separates great from acceptable here? Give a test or an example.',
  better: 'Better than what, and measured how?',
  best: 'Best by which measure? Name the criterion that decides.',
  appropriate: 'Appropriate for whom? State the rule or the audience.',
  relevant: 'Relevant to what? Say what to include and what to leave out.',
  proper: 'What is the proper way here? Spell out the steps or the standard.',
  properly: 'What does done properly look like? Spell out the steps or the standard.',
  some: 'How many? Give a number or a range.',
  several: 'How many is several? Give a number.',
  various: 'Which ones? List them.',
  many: 'How many? Give a number or a threshold.',
  few: 'How few? Give a number.',
  soon: 'By when? Give a date or a time limit.',
  quickly: 'How quickly? Give a time limit.',
  fast: 'How fast? Give a time or a speed target.',
  asap: 'What is the actual deadline?',
  simple: 'Simple how? Say what to leave out.',
  simply: 'Is there a hidden step here? Say exactly what to do.',
  easy: 'Easy for whom? Describe the reader or user.',
  basically: 'Basically, or exactly? State the rule without hedging.',
  maybe: 'Required or optional? Decide, or say when it applies.',
  probably: 'Should it happen or not? Decide, or say when it applies.',
  perhaps: 'Required or optional? Decide, or say when it applies.',
  etc: 'What else is on this list? Finish it.',
  stuff: 'What stuff exactly? Name the items.',
  things: 'Which things? Name them.',
  taste: 'Whose taste decides? Name the person or the reference.',
  vibe: 'What vibe, exactly? Describe it with examples or words you can check.',
  polished: 'Polished means which checks pass? List them.',
  smallest: 'Smallest by what measure? Give the limit, e.g. one file or 200 words.',
  small: 'How small? Give a size or a count.',
  large: 'How large? Give a size or a count.',
  robust: 'Robust against what? List the failure cases to handle.',
  seamless: 'Seamless for whom? Say what must not break or change.',
  intuitive: 'Intuitive to whom? Name the user and the task they must finish unaided.',
  modern: 'Modern like what? Point to an example or a style.',
  engaging: 'Engaging how? Name the response you want from the reader.',
  'high-quality': 'What does high quality mean here? List the checks it must pass.',
  // A few extras in the same spirit.
  someone: 'Who exactly? Name the person or the role.',
  somebody: 'Who exactly? Name the person or the role.',
  somehow: 'How, exactly? Describe the method.',
  reasonable: 'Reasonable by what limit? Give the number or the rule.',
  sufficient: 'How much is sufficient? Give the bar.',
  adequate: 'Adequate by what bar? Describe a pass.',
  optimal: 'Optimal for which goal? Name what to optimise.',
  ideally: 'Is this required or a nice-to-have? Say which.',
};

/** Comparative forms that ask the same question as their base word. */
export const VAGUE_FORMS = {
  shorter: 'short', longer: 'long', smaller: 'small', larger: 'large', bigger: 'large',
  simpler: 'simple', easier: 'easy', cleaner: 'clean', nicer: 'nice', faster: 'fast',
  quicker: 'quickly', 'high-level': 'simple',
};

/** Multi-word phrases. The flag goes on the phrase's last word. */
export const VAGUE_PHRASES = {
  'as needed': 'Needed by whom, and how often? Name the trigger or a limit.',
  'if possible': 'What happens if it is not possible? Say the fallback.',
  'where possible': 'Where is it not possible, and what then? Say the fallback.',
  'and so on': 'What else is on the list? Finish it.',
  'when necessary': 'When is it necessary? Name the condition.',
  'as appropriate': 'Appropriate by what rule? State it.',
  'a bit': 'How much is a bit? Give an amount.',
  'kind of': 'Kind of, or exactly? Say what you mean.',
  'sort of': 'Sort of, or exactly? Say what you mean.',
  'high quality': 'What does high quality mean here? List the checks it must pass.',
  'as soon as possible': 'What is the actual deadline?',
};

/**
 * Size, quantity and time words. These are NOT vague when a number sits
 * within 2 words of them ("a short 200-word note", "under 2 MB, small").
 */
export const MEASURE_WORDS = [
  'short', 'long', 'small', 'smallest', 'large', 'few', 'many', 'several', 'some',
  'soon', 'quickly', 'fast', 'shorter', 'longer', 'smaller', 'larger', 'bigger',
  'faster', 'quicker', 'a bit',
];

/** Spelled-out numbers: count as "a number nearby", but are not spec links on their own. */
export const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred',
  'thousand', 'million', 'dozen', 'half',
];

/* ------------------------------------------------------------------------ */
/* Context rules: frames where a table hit is a false positive.             */
/* ------------------------------------------------------------------------ */

/** "how many words?" asks for a number, it doesn't hedge. */
export const NOT_VAGUE_AFTER_HOW = ['many', 'much', 'long', 'short', 'soon', 'fast', 'few', 'small', 'large', 'big', 'quickly'];

/** "what kind of", "this sort of": a category, not a hedge. */
export const KIND_OF_DETERMINERS = ['what', 'which', 'this', 'that', 'these', 'those', 'the', 'a', 'an', 'any', 'each', 'every', 'same', 'one', 'other'];

/**
 * "lead" is a noun (an owner: "team lead", "the policy lead") unless the
 * frame makes it a verb: sentence start ("Lead with the result"), after one
 * of these words ("will lead", "to lead", "this leads"), or before one of
 * the particles below ("lead with", "lead into").
 */
export const LEAD_VERB_AFTER = [
  'to', 'will', 'would', 'should', 'must', 'can', 'could', 'may', 'might', 'shall', 'and', 'or',
  'not', 'never', 'always', 'i', 'we', 'you', 'they', 'it', 'this', 'that', 'which', 'who',
  'please', 'then', 'also', 'often', 'usually', 'does', 'do', 'did',
];
export const LEAD_VERB_BEFORE = ['with', 'into', 'up', 'off', 'by', 'through', 'them', 'it', 'us'];

/**
 * An owner word used as a modifier is not a person: "user survey",
 * "customer data", "user interface". Owner words directly before these are plain.
 */
export const OWNER_MODIFIES = [
  'survey', 'surveys', 'data', 'input', 'inputs', 'interface', 'interfaces', 'experience',
  'research', 'story', 'stories', 'guide', 'guides', 'manual', 'name', 'names', 'id', 'ids',
  'account', 'accounts', 'base', 'segment', 'segments', 'persona', 'personas', 'feedback',
  'message', 'messages', 'query', 'queries', 'prompt', 'prompts', 'turn', 'turns', 'agent', 'role',
];

/** Inflections that look like a link but almost never are ("auto-categorised spending"). */
export const NEVER_GUESS = ['spending'];

/* ------------------------------------------------------------------------ */
/* Classifier                                                               */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {Object} WordClass
 * @property {import('../core/contracts.js').LinkKind|null} kind
 * @property {boolean} guessed
 * @property {boolean} vague
 * @property {string|null} question
 * @property {number} phraseStart  index of the first token of a flagged phrase (=== own index for single words)
 */

const KIND_OF = new Map();
for (const kind of /** @type {const} */ (['owner', 'approval', 'claim', 'spec', 'file'])) {
  for (const w of LINK_WORDS[kind]) if (!KIND_OF.has(w)) KIND_OF.set(w, kind);
}
const UNITS = new Set(UNIT_WORDS);
const EXTENSIONS = new Set(FILE_EXTENSIONS);
const TLDS = new Set(URL_TLDS);
const ROOTS = new Set(PATH_ROOTS);
const MEASURE = new Set(MEASURE_WORDS);
const NUMBERS = new Set(NUMBER_WORDS);
const HOW_OK = new Set(NOT_VAGUE_AFTER_HOW);
const KIND_DET = new Set(KIND_OF_DETERMINERS);
const LEAD_VERB_PREV = new Set(LEAD_VERB_AFTER);
const LEAD_VERB_NEXT = new Set(LEAD_VERB_BEFORE);
const OWNER_MOD = new Set(OWNER_MODIFIES);
const PHRASES = Object.entries(VAGUE_PHRASES)
  .map(([phrase, question]) => ({ parts: phrase.split(' '), phrase, question }))
  // Longest first, so "as soon as possible" wins over shorter overlaps.
  .sort((a, b) => b.parts.length - a.parts.length);

const HAS_DIGIT = /\p{N}/u;

/** Lower-case, straighten apostrophes, drop a trailing possessive. */
export function normalizeWord(text) {
  let w = String(text).toLowerCase().replace(/[\u2019\u2018]/g, "'");
  if (w.endsWith("'s")) w = w.slice(0, -2);
  else if (w.endsWith("'")) w = w.slice(0, -1);
  return w;
}

/** True for digit numbers and spelled-out numbers, including "two-page", "900-word". */
export function isNumberish(word) {
  const w = normalizeWord(word);
  if (HAS_DIGIT.test(w)) return true;
  if (NUMBERS.has(w)) return true;
  const head = w.split('-')[0];
  return head !== w && NUMBERS.has(head);
}

/** Rule-based file detection: URLs, known extensions, paths. */
function fileByRule(raw, w) {
  if (/^(https?:\/\/|www\.)/.test(w)) return true;
  if (w.startsWith('/') && /\p{L}/u.test(w)) return true;
  if (w.includes('/')) {
    const segs = w.split('/');
    if (segs.length >= 3) return true;
    if (ROOTS.has(segs[0])) return true;
    if (/\.[a-z0-9]+$/.test(segs[segs.length - 1]) && EXTENSIONS.has(segs[segs.length - 1].split('.').pop())) return true;
  }
  const dot = w.lastIndexOf('.');
  if (dot > 0 && dot < w.length - 1) {
    const ext = w.slice(dot + 1);
    const stem = w.slice(0, dot);
    if (EXTENSIONS.has(ext) && /\p{L}/u.test(stem) && stem.length >= 2) return true;
    if (TLDS.has(ext) && /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(stem) && stem.length >= 2) return true;
  }
  return false;
}

/** Suffix fallbacks. Each returns candidate base forms. Owners only take plurals. */
function stemCandidates(w) {
  const out = [];
  const add = (s) => { if (s.length >= 3) out.push(s); };
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith('ing')) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ation')) { add(w.slice(0, -5)); add(w.slice(0, -5) + 'e'); }
  if (w.endsWith('ers')) add(w.slice(0, -3) + 'e');
  return out;
}

function guessKind(w) {
  if (NEVER_GUESS.includes(w)) return null;
  if (w.length < 5 || HAS_DIGIT.test(w) || w.includes('.') || w.includes('/')) return null;
  const plural = w.endsWith('s') && !w.endsWith('ss');
  for (const c of stemCandidates(w)) {
    const kind = KIND_OF.get(c);
    if (!kind || kind === 'spec' || kind === 'file') continue;
    // Owners are nouns: only plural/possessive forms count ("approvers"), not "engineering".
    if (kind === 'owner' && !plural) continue;
    return kind;
  }
  return null;
}

/**
 * Classify one word without context. Good for tests and tooltips; the parser
 * uses classifyTokens so phrase and number-proximity rules apply.
 * @param {string} word
 * @returns {WordClass}
 */
export function classifyWord(word) {
  return classifyTokens([word])[0];
}

/**
 * Classify a run of tokens (one sentence) in reading order.
 * @param {string[]} tokens  words as written
 * @returns {WordClass[]}
 */
export function classifyTokens(tokens) {
  const n = tokens.length;
  const low = tokens.map(normalizeWord);
  const numberAt = low.map((w) => isNumberish(w));
  /** @type {WordClass[]} */
  const out = new Array(n);

  const numberNear = (i, span = 1) => {
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + span - 1 + 2); j++) {
      if ((j < i || j > i + span - 1) && numberAt[j]) return true;
    }
    return false;
  };

  for (let i = 0; i < n; i++) {
    const raw = String(tokens[i]);
    const w = low[i];
    const prev = i > 0 ? low[i - 1] : '';
    const next = i < n - 1 ? low[i + 1] : '';
    /** @type {WordClass} */
    const res = { kind: null, guessed: false, vague: false, question: null, phraseStart: i };
    out[i] = res;
    if (!w) continue;

    // 1. Rule-based links: files, then anything with a digit.
    if (fileByRule(raw, w)) { res.kind = 'file'; continue; }
    if (HAS_DIGIT.test(w)) { res.kind = 'spec'; continue; }

    // 2. Exact table hits, with the few context rules.
    if (UNITS.has(w)) { if (numberNear(i)) res.kind = 'spec'; continue; }
    if (w === 'lead' || w === 'leads') {
      const verb = i === 0 || LEAD_VERB_PREV.has(prev) || LEAD_VERB_NEXT.has(next);
      if (!verb && !OWNER_MOD.has(next)) { res.kind = 'owner'; res.guessed = w !== 'lead'; }
      continue;
    }
    const exact = KIND_OF.get(w);
    if (exact === 'owner' && OWNER_MOD.has(next)) continue; // "user survey", "customer data"
    if (exact) { res.kind = exact; continue; }

    // 3. Vague words (phrases are applied after this loop and win over single words).
    const base = VAGUE_WORDS[w] ? w : VAGUE_FORMS[w];
    if (base && !vagueExempt(w, i, low, numberNear)) {
      res.vague = true;
      res.question = VAGUE_WORDS[base];
      continue;
    }

    // 4. Suffix fallback: a guessed link.
    const guess = guessKind(w);
    if (guess && !(guess === 'owner' && OWNER_MOD.has(next))) { res.kind = guess; res.guessed = true; }
  }

  // Phrases: match on lower-case token windows; flag the last word.
  for (let end = 0; end < n; end++) {
    for (const { parts, phrase, question } of PHRASES) {
      const start = end - parts.length + 1;
      if (start < 0) continue;
      let hit = true;
      for (let k = 0; k < parts.length; k++) if (low[start + k] !== parts[k]) { hit = false; break; }
      if (!hit) continue;
      if ((phrase === 'kind of' || phrase === 'sort of') && start > 0 && KIND_DET.has(low[start - 1])) continue;
      if (MEASURE.has(phrase) && numberNear(start, parts.length)) continue;
      // Words inside the phrase drop any single-word flag ("as soon as possible": not "soon").
      for (let k = start; k < end; k++) {
        if (out[k].vague) { out[k].vague = false; out[k].question = null; }
      }
      const last = out[end];
      last.kind = null;
      last.guessed = false;
      last.vague = true;
      last.question = question;
      last.phraseStart = start;
      break;
    }
  }
  return out;
}

/** Context exemptions for single vague words. */
function vagueExempt(w, i, low, numberNear) {
  const prev = i > 0 ? low[i - 1] : '';
  const next = i < low.length - 1 ? low[i + 1] : '';
  if (prev === 'how' && HOW_OK.has(w)) return true;            // "how many", "how long"
  if (w === 'long' && prev === 'as' && next === 'as') return true; // "as long as"
  if (w === 'soon' && prev === 'as' && next === 'as') return true; // "as soon as" (the phrase rule catches "...possible")
  if (w === 'short' && prev === 'in') return true;            // "in short"
  if ((w === 'large' || w === 'small') && next === 'language') return true; // "large language model"
  if (MEASURE.has(w) && numberNear(i)) return true;            // "a short 200-word note"
  return false;
}
