/**
 * Prompt text -> Analysis (see src/core/contracts.js).
 *
 * Pipeline: normalise text, drop fenced code, pull a title H1, split into
 * sections (markdown headings, then top-level XML tags, then LABEL: lines,
 * then paragraphs; the first rule that yields 2+ sections wins), clean each
 * section's markdown into sentences, tokenise, classify every word with
 * lexicon.js, then derive taglines, flags and totals.
 *
 * parsePrompt never throws on string input. Pure and deterministic: the same
 * text always gives the same Analysis.
 */

import { sectionColor } from '../core/theme.js';
import { classifyTokens, normalizeWord } from './lexicon.js';

/** Words read at most; the rest is reported in notes.originalWords. */
export const MAX_WORDS = 1500;
/** Sections at most; the tail is merged into the last one. */
export const MAX_SECTIONS = 12;
/** File name used when neither the caller nor an H1 title gives one. */
export const DEFAULT_FILE_NAME = 'untitled.prompt';
/** Sentences longer than this many words are cut into pieces (keeps flag context readable). */
const MAX_SENTENCE_WORDS = 60;

/**
 * A word: a run of letters/digits that may contain internal . - _ / ' : (and a
 * thousands comma between digits), optionally led by "/" for paths. URLs are
 * one token.
 */
const TOKEN_RE =
  /https?:\/\/[^\s<>()[\]{}"'`]+|www\.[^\s<>()[\]{}"'`]+|\/?[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:(?:[.\-_/'\u2019:]|(?<=\p{N}),(?=\p{N}{3}(?!\p{N})))[\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before
being below between both but by can could did do does doing don't down during each either else few for from
further had has have having he her here hers herself him himself his how i if in into is it it's its itself just
let me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she
should so such than that the their theirs them themselves then there these they this those through to too under
until up upon very was we were what when where which while who whom why will with would you your yours yourself
yourselves also via per must may might shall`.split(/\s+/));

/** Words too generic to make a good tagline even though they are not stopwords. */
const WEAK = new Set(`make makes made use uses using get gets got need needs needed like just every each any
always never ever still even really well sure thing way ways lot one two three four five six seven eight nine ten
first last next new old want wants keep give take put see say says said know try tries goes going go come
something anything everything nothing anyone everyone someone nobody else instead etc yes okay ok`.split(/\s+/));

/* ------------------------------------------------------------------------ */
/* Entry point                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Parse a prompt into sections, words, sentences and flags.
 * @param {string} text  the prompt (markdown, XML-tagged, LABEL: lines or plain prose)
 * @param {{fileName?: string}} [options]  fileName wins over an H1 title when given
 * @returns {import('../core/contracts.js').Analysis}
 */
export function parsePrompt(text, options = {}) {
  const given = options && typeof options.fileName === 'string' ? options.fileName.trim() : '';
  try {
    return parse(typeof text === 'string' ? text : String(text ?? ''), given);
  } catch (err) {
    // Belt and braces: a bug here must not take the whole page down.
    if (typeof console !== 'undefined') console.warn('[parsePrompt] falling back to an empty analysis:', err);
    return emptyAnalysis(given || DEFAULT_FILE_NAME, notesOf('paragraphs', 0, 0));
  }
}

function parse(input, givenName) {
  const src = normalizeText(input);
  const { text: unfenced, skipped } = stripCodeFences(src);
  const { text: body, title } = takeTitle(unfenced);
  const fileName = givenName || fileNameFromTitle(title) || DEFAULT_FILE_NAME;

  let detectedBy = /** @type {'markdown'|'xml'|'labels'|'paragraphs'} */ ('paragraphs');
  let raw = null;
  for (const [name, detect] of /** @type {const} */ ([
    ['markdown', detectMarkdown],
    ['xml', detectXml],
    ['labels', detectLabels],
  ])) {
    const found = detect(body);
    if (found && found.filter((s) => quickCount(s.body) > 0).length >= 2) {
      detectedBy = name;
      raw = found;
      break;
    }
  }
  if (!raw) raw = detectParagraphs(body);

  return build(raw, { fileName, detectedBy, skipped });
}

/* ------------------------------------------------------------------------ */
/* Text normalisation, code fences, title                                   */
/* ------------------------------------------------------------------------ */

function normalizeText(s) {
  return s
    .normalize('NFC')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/\u00A0/g, ' ');
}

/** Remove ``` / ~~~ fenced blocks (blank lines left in their place). */
function stripCodeFences(src) {
  const lines = src.split('\n');
  let skipped = 0;
  let fence = null; // { ch, len }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m && !(m[1][0] === '`' && line.slice(m.index + m[0].length).includes('`'))) {
        fence = { ch: m[1][0], len: m[1].length };
        skipped++;
        lines[i] = '';
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      lines[i] = '';
    }
  }
  return { text: lines.join('\n'), skipped };
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * A lone H1 that comes before every other heading is the document's title:
 * removed from the body and offered as a file name when it looks like one.
 * A lone H1 that is a long sentence becomes plain text (preamble).
 */
function takeTitle(text) {
  const lines = text.split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[2].trim()) heads.push({ i, level: m[1].length, text: m[2].trim() });
  }
  const h1s = heads.filter((h) => h.level === 1);
  if (h1s.length !== 1 || heads[0] !== h1s[0]) return { text, title: null };
  const h1 = h1s[0];
  const plain = cleanInline(h1.text).trim();
  if (looksLikeTitle(plain)) {
    lines[h1.i] = '';
    return { text: lines.join('\n'), title: plain };
  }
  if (heads.length > 1) lines[h1.i] = plain;
  return { text: lines.join('\n'), title: null };
}

function looksLikeFileName(s) {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*\.[A-Za-z0-9]{1,10}$/u.test(s) && !/\s/.test(s);
}

function looksLikeTitle(s) {
  if (!s) return false;
  if (looksLikeFileName(s)) return true;
  const words = s.split(/\s+/).filter(Boolean);
  return words.length <= 6 && s.length <= 48 && !/[.!?]$/.test(s);
}

/** "studio.prompt" stays; "Release Desk Prompt" -> "release-desk.prompt". */
function fileNameFromTitle(title) {
  if (!title) return '';
  if (looksLikeFileName(title)) return title;
  let slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  slug = slug.replace(/-?prompt$/, '').slice(0, 32).replace(/-+$/, '');
  return slug ? `${slug}.prompt` : '';
}

/* ------------------------------------------------------------------------ */
/* Section detectors. Each returns RawSection[] or null.                    */
/* RawSection = { name, subtitle: string|null, body, auto?: number }        */
/* ------------------------------------------------------------------------ */

/** 1. Markdown headings: the shallowest heading level present defines sections. */
function detectMarkdown(text) {
  const lines = text.split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[2].trim()) heads.push({ i, level: m[1].length, text: m[2].trim() });
  }
  if (!heads.length) return null;
  const level = Math.min(...heads.map((h) => h.level));
  const tops = heads.filter((h) => h.level === level);
  const out = [];
  const pre = lines.slice(0, tops[0].i).join('\n');
  pushPreamble(out, pre);
  tops.forEach((h, k) => {
    const end = k + 1 < tops.length ? tops[k + 1].i : lines.length;
    const { name, subtitle } = splitHeading(h.text);
    out.push({ name, subtitle, body: lines.slice(h.i + 1, end).join('\n') });
  });
  return mergeLeadingStub(out);
}

/** 2. Top-level <tag>...</tag> blocks. A single wrapper tag is looked inside. */
function detectXml(text) {
  for (let depth = 0, src = text; depth < 3; depth++) {
    const blocks = topLevelTags(src);
    if (!blocks.length) return null;
    const outside = (a, b) => src.slice(a, b);
    if (blocks.length === 1) {
      const lead = quickCount(outside(0, blocks[0].start)) + quickCount(outside(blocks[0].end, src.length));
      if (lead < 3) { src = blocks[0].inner; continue; }
    }
    const out = [];
    pushPreamble(out, outside(0, blocks[0].start));
    let carry = '';
    blocks.forEach((b, k) => {
      if (k > 0) carry = outside(blocks[k - 1].end, b.start); // text between blocks introduces the next one
      out.push({ name: b.name, subtitle: null, body: `${carry}\n${b.inner}` });
    });
    const tail = outside(blocks[blocks.length - 1].end, src.length);
    if (quickCount(tail) >= 3) out.push({ name: 'closing', subtitle: null, body: tail });
    else if (tail.trim()) out[out.length - 1].body += `\n${tail}`;
    return mergeLeadingStub(out);
  }
  return null;
}

function topLevelTags(src) {
  const OPEN = /<([A-Za-z_][\w.-]*)(\s[^<>]*)?>/g;
  const blocks = [];
  let pos = 0;
  while (pos < src.length) {
    OPEN.lastIndex = pos;
    const m = OPEN.exec(src);
    if (!m) break;
    if (m[0].endsWith('/>')) { pos = m.index + m[0].length; continue; }
    const tag = m[1];
    const pair = new RegExp(`<(/?)${tag.replace(/[.-]/g, '\\$&')}(?:\\s[^<>]*)?>`, 'g');
    pair.lastIndex = m.index + m[0].length;
    let depth = 1;
    let close = null;
    let p;
    while ((p = pair.exec(src))) {
      if (p[1]) depth--;
      else if (!p[0].endsWith('/>')) depth++;
      if (depth === 0) { close = p; break; }
    }
    if (!close) { pos = m.index + m[0].length; continue; }
    blocks.push({
      name: tag.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').toLowerCase(),
      inner: src.slice(m.index + m[0].length, close.index),
      start: m.index,
      end: close.index + close[0].length,
    });
    pos = close.index + close[0].length;
  }
  return blocks;
}

/** 3. "LABEL:" lines (1–3 Title/UPPER words, nothing after) or "ROLE: text" lines. */
function detectLabels(text) {
  const lines = text.split('\n');
  const hits = [];
  const LABEL = /^\s*(\*\*|__)?([\p{L}][\p{L}\p{N} &/_-]{0,40}?)(?:\*\*|__)?\s*:(?:\*\*|__)?(?:\s+(.*))?$/u;
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL.exec(lines[i]);
    if (!m) continue;
    const label = m[2].trim();
    const rest = (m[3] || '').trim();
    const words = label.split(/\s+/);
    if (!label || words.length > 3) continue;
    const upper = /\p{L}{2}/u.test(label) && label === label.toUpperCase() && label !== label.toLowerCase();
    const titled = words.every((w) => /^\p{Lu}/u.test(w));
    const bold = Boolean(m[1]);
    if (rest ? upper || (bold && titled) : titled) hits.push({ i, label, rest });
  }
  if (hits.length < 2) return null;
  const out = [];
  pushPreamble(out, lines.slice(0, hits[0].i).join('\n'));
  hits.forEach((h, k) => {
    const end = k + 1 < hits.length ? hits[k + 1].i : lines.length;
    const { name, subtitle } = splitHeading(h.label);
    out.push({ name, subtitle, body: [h.rest, ...lines.slice(h.i + 1, end)].join('\n') });
  });
  return mergeLeadingStub(out);
}

/** 4. Blank-line paragraphs; a lone paragraph is cut into groups of ~25–40 words. */
function detectParagraphs(text) {
  const paras = text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => quickCount(p) > 0)
    .map((p) => ({ ...leadOf(p), n: 0 }));
  for (const p of paras) p.n = quickCount(p.body);

  /** @type {{name:string|null, subtitle:string|null, body:string, n:number}[]} */
  let groups;
  if (paras.length >= 2) {
    // Tiny paragraphs ("Thanks!") ride along with their neighbour.
    groups = [];
    for (const p of paras) {
      const prev = groups[groups.length - 1];
      if (prev && p.n < 3 && !p.name) { prev.body += `\n\n${p.body}`; prev.n += p.n; }
      else if (prev && prev.n < 3 && !prev.name) { prev.body += `\n\n${p.body}`; prev.n += p.n; prev.name = p.name; }
      else groups.push({ ...p });
    }
    if (groups.length > MAX_SECTIONS) groups = balance(groups, MAX_SECTIONS);
  } else if (paras.length === 1) {
    groups = sentenceGroups(paras[0]);
  } else {
    groups = [];
  }
  return groups.map((g, k) => (g.name
    ? { name: normalizeName(g.name), subtitle: null, body: g.body }
    : { name: `part ${k + 1}`, subtitle: null, body: g.body, auto: k + 1 }));
}

/** "**Goal.** text", "**Goal:** text" or "Goal: text" leads name a paragraph. */
function leadOf(p) {
  const bold = /^(\*\*|__)([^*_\n]{1,40}?)[:.]?\1\s*[:.\u2014\u2013-]?\s+/.exec(p);
  if (bold && bold[2].trim().split(/\s+/).length <= 3) return { name: bold[2].trim(), body: p.slice(bold[0].length) };
  const plain = /^(\p{Lu}[\p{L}]*(?: [\p{L}]+){0,2}):\s+/u.exec(p);
  if (plain) return { name: plain[1], body: p.slice(plain[0].length) };
  return { name: null, body: p };
}

function sentenceGroups(para) {
  const sents = [];
  for (const block of toBlocks(para.body)) {
    for (const s of splitSentences(block)) {
      const n = tokenize(s).length;
      if (n) sents.push({ s, n });
    }
  }
  const groups = [];
  let cur = null;
  for (let k = 0; k < sents.length; k++) {
    if (!cur) cur = { name: null, subtitle: null, body: '', n: 0 };
    cur.body += (cur.body ? ' ' : '') + sents[k].s;
    cur.n += sents[k].n;
    const next = sents[k + 1];
    if (cur.n >= 40 || (cur.n >= 25 && next && cur.n + next.n > 40)) { groups.push(cur); cur = null; }
  }
  if (cur) {
    const prev = groups[groups.length - 1];
    if (prev && cur.n < 12) { prev.body += ` ${cur.body}`; prev.n += cur.n; } else groups.push(cur);
  }
  if (groups.length && para.name) groups[0].name = para.name;
  return groups.length > MAX_SECTIONS ? balance(groups, MAX_SECTIONS) : groups;
}

/** Merge consecutive groups into at most `max` groups of roughly equal word counts. */
function balance(groups, max) {
  const total = groups.reduce((a, g) => a + g.n, 0);
  const out = [];
  let acc = 0;
  for (const g of groups) {
    const slot = Math.min(max - 1, Math.floor((acc / Math.max(1, total)) * max));
    if (out.length <= slot) out.push({ name: g.name, subtitle: null, body: g.body, n: g.n });
    else { const o = out[out.length - 1]; o.body += `\n\n${g.body}`; o.n += g.n; }
    acc += g.n;
  }
  return out;
}

function pushPreamble(out, text) {
  if (text.trim()) out.push({ name: 'preamble', subtitle: null, body: text, preamble: true });
}

/** A preamble under 3 words is folded into the first real section. */
function mergeLeadingStub(out) {
  if (out.length >= 2 && out[0].preamble && quickCount(out[0].body) < 3) {
    out[1] = { ...out[1], body: `${out[0].body}\n${out[1].body}` };
    out.shift();
  }
  return out;
}

/** "role — who the studio works for" -> name + tagline. Splits on — – " - " or ": ". */
function splitHeading(text) {
  const t = cleanInline(text).replace(/\s+/g, ' ').trim();
  const m = /^(.+?)(?:\s*[\u2014\u2013]\s*|\s+-\s+|:\s+)(.+)$/.exec(t);
  if (m && m[1].trim() && m[2].trim()) return { name: normalizeName(m[1]), subtitle: normalizeSubtitle(m[2]) };
  return { name: normalizeName(t.replace(/[:\u2014\u2013-]+$/, '')), subtitle: null };
}

function normalizeName(s) {
  let n = cleanInline(String(s)).toLowerCase().replace(/\s+/g, ' ').trim();
  n = n.replace(/^(?:\(?\d{1,2}[.):]\s*|(?:step|part|section)\s+\d{1,2}[.:)]?\s+)/, '').trim() || n;
  n = n.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}?!]+$/gu, '');
  if (n.length > 18) {
    const cut = n.slice(0, 19).lastIndexOf(' ');
    n = (cut >= 6 ? n.slice(0, cut) : n.slice(0, 18)).trim();
  }
  return n || 'section';
}

function normalizeSubtitle(s) {
  let t = cleanInline(String(s)).replace(/\s+/g, ' ').trim();
  if (t.length > 64) t = `${t.slice(0, 63).replace(/\s+\S*$/, '')}…`;
  return t;
}

/* ------------------------------------------------------------------------ */
/* Markdown cleaning, sentences, tokens                                     */
/* ------------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

/** Strip inline markdown/HTML from one line, keeping the readable text. */
function cleanInline(line) {
  return line
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*+|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, '$1')
    .replace(/([\p{L}\p{N}])_+(?=[^\p{L}\p{N}_]|$)/gu, '$1')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Section body -> cleaned text blocks. Headings, list items and table rows
 * are blocks of their own; consecutive plain lines join (soft wraps).
 */
function toBlocks(body) {
  const blocks = [];
  let cur = [];
  const flush = () => { if (cur.length) { blocks.push(cur.join(' ')); cur = []; } };
  for (let line of body.split('\n')) {
    if (!line.trim()) { flush(); continue; }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) { flush(); continue; } // rule
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) { flush(); continue; } // table divider
    let own = false;
    let m;
    if ((m = HEADING_RE.exec(line))) { line = m[2]; own = true; }
    line = line.replace(/^\s*(?:>\s?)+/, '');
    if ((m = /^\s*(?:[-*+\u2022\u25AA\u25E6]|\d{1,3}[.)]|[A-Za-z][.)])\s+(.*)$/.exec(line))) { line = m[1]; own = true; }
    line = line.replace(/^\[[ xX]\]\s+/, '');
    if (line.includes('|') && /^\s*\|/.test(line)) { line = line.replace(/\|/g, ' '); own = true; }
    line = cleanInline(line).trim();
    if (!line) continue;
    if (own) { flush(); blocks.push(line); } else cur.push(line);
  }
  flush();
  return blocks;
}

const NEVER_SPLIT_AFTER = new Set(['e.g', 'i.e', 'eg', 'ie', 'vs', 'cf', 'approx', 'incl', 'mr', 'mrs', 'ms', 'dr', 'prof', 'v']);
const SPLIT_IF_CAPITAL_AFTER = new Set(['etc', 'no', 'st', 'fig', 'al']);

/** Split a block into sentences on . ! ? followed by whitespace (so "5.5" and "BRAND.md" stay whole). */
function splitSentences(block) {
  const out = [];
  const re = /[.!?\u2026]+["'\u201D\u2019)\]]*(?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(block))) {
    const end = m.index + m[0].length;
    if (m[0][0] === '.') {
      const prevWord = (/([\p{L}.]+)$/u.exec(block.slice(start, m.index)) || [])[1];
      const lw = prevWord ? prevWord.toLowerCase() : '';
      const nextCh = block.slice(end).trimStart()[0] || '';
      if (NEVER_SPLIT_AFTER.has(lw)) continue;
      if (SPLIT_IF_CAPITAL_AFTER.has(lw) && nextCh && !/\p{Lu}/u.test(nextCh)) continue;
    }
    const s = block.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const rest = block.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** @returns {{text:string, index:number}[]} tokens with their offset in `s` */
function tokenize(s) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    let text = m[0];
    if (/^(?:https?:|www\.)/i.test(text)) text = text.replace(/[.,;:!?'")\]}]+$/, '');
    if (text) out.push({ text, index: m.index });
  }
  return out;
}

/** Word count of raw section text, as the parser would count it. */
function quickCount(body) {
  let n = 0;
  for (const block of toBlocks(body)) {
    TOKEN_RE.lastIndex = 0;
    while (TOKEN_RE.exec(block)) n++;
  }
  return n;
}

/* ------------------------------------------------------------------------ */
/* Build the Analysis                                                       */
/* ------------------------------------------------------------------------ */

function notesOf(detectedBy, originalWords, skippedCodeBlocks) {
  return { detectedBy, truncated: originalWords > MAX_WORDS, originalWords, skippedCodeBlocks };
}

function emptyTotals() {
  return { words: 0, linked: 0, vague: 0, guessed: 0, byKind: { owner: 0, approval: 0, claim: 0, spec: 0, file: 0 } };
}

/** One empty-safe section, so consumers never see sections.length === 0. */
function emptyAnalysis(fileName, notes) {
  return {
    fileName,
    sections: [{ index: 0, key: 'prompt', name: 'prompt', abbr: 'PRO', subtitle: 'nothing to read yet', color: sectionColor(0), start: 0, count: 0 }],
    words: [],
    sentences: [],
    flags: [],
    totals: emptyTotals(),
    notes,
  };
}

function build(raw, { fileName, detectedBy, skipped }) {
  /** @type {import('../core/contracts.js').Word[]} */
  const words = [];
  const sentences = [];
  const flagSpans = new Map(); // wordId -> {start, end} within its sentence
  const ranges = []; // per raw section: { raw, start, count }
  let originalWords = 0;

  raw.forEach((rs, r) => {
    const start = words.length;
    for (const block of toBlocks(rs.body)) {
      for (const sent of splitSentences(block)) {
        const toks = tokenize(sent);
        if (!toks.length) continue;
        originalWords += toks.length;
        if (words.length >= MAX_WORDS) continue;
        for (let c = 0; c < toks.length; c += MAX_SENTENCE_WORDS) {
          const chunk = toks.slice(c, c + MAX_SENTENCE_WORDS);
          const from = c === 0 ? 0 : chunk[0].index;
          const last = chunk[chunk.length - 1];
          const to = c + MAX_SENTENCE_WORDS >= toks.length ? sent.length : last.index + last.text.length;
          const raw0 = sent.slice(from, to);
          const lead = raw0.length - raw0.trimStart().length;
          const sentence = raw0.trim();
          const cls = classifyTokens(chunk.map((t) => t.text));
          const sIdx = sentences.push(sentence) - 1;
          const room = MAX_WORDS - words.length;
          for (let k = 0; k < chunk.length && k < room; k++) {
            const c0 = cls[k];
            const id = words.length;
            words.push({
              id,
              section: r,
              text: chunk[k].text,
              kind: c0.vague ? null : c0.kind,
              guessed: c0.vague ? false : Boolean(c0.kind && c0.guessed),
              vague: c0.vague,
              question: c0.vague ? c0.question : null,
              sentence: sIdx,
            });
            if (c0.vague) {
              const s0 = chunk[c0.phraseStart];
              flagSpans.set(id, {
                start: s0.index - from - lead,
                end: chunk[k].index + chunk[k].text.length - from - lead,
              });
            }
          }
          if (words.length >= MAX_WORDS) break;
        }
      }
    }
    ranges.push({ raw: rs, start, count: words.length - start });
  });

  const notes = notesOf(detectedBy, originalWords, skipped);
  const kept = ranges.filter((g) => g.count > 0);
  if (!kept.length) return emptyAnalysis(fileName, notes);

  // Cap the section count: the tail folds into the last kept section.
  let merged = 0;
  if (kept.length > MAX_SECTIONS) {
    const last = kept[MAX_SECTIONS - 1];
    for (const g of kept.slice(MAX_SECTIONS)) { last.count += g.count; merged++; }
    kept.length = MAX_SECTIONS;
  }

  const usedKeys = new Set();
  const sections = kept.map((g, index) => {
    for (let i = g.start; i < g.start + g.count; i++) words[i].section = index;
    const name = g.raw.name || 'section';
    const auto = g.raw.auto ? `part ${index + 1}` : null; // renumber after drops
    const finalName = auto || name;
    return {
      index,
      key: uniqueKey(finalName, usedKeys),
      name: finalName,
      abbr: auto ? `P${String(index + 1).padStart(2, '0')}` : abbrOf(finalName),
      subtitle: g.raw.subtitle || '',
      color: sectionColor(index),
      start: g.start,
      count: g.count,
    };
  });

  for (const s of sections) {
    if (!s.subtitle) s.subtitle = deriveTagline(words.slice(s.start, s.start + s.count));
  }
  if (merged) {
    const last = sections[sections.length - 1];
    last.subtitle = `${last.subtitle} · +${merged} more`;
  }

  const totals = emptyTotals();
  const flags = [];
  for (const w of words) {
    totals.words++;
    if (w.kind) { totals.linked++; totals.byKind[w.kind]++; if (w.guessed) totals.guessed++; }
    if (w.vague) {
      totals.vague++;
      const sentence = sentences[w.sentence];
      const span = flagSpans.get(w.id);
      const phrase = span && span.start >= 0 && span.end <= sentence.length ? sentence.slice(span.start, span.end) : w.text;
      flags.push({
        wordId: w.id,
        word: phrase,
        section: w.section,
        sentence,
        question: w.question,
        start: span && span.start >= 0 ? span.start : Math.max(0, sentence.indexOf(w.text)),
      });
    }
  }

  return { fileName, sections, words, sentences, flags, totals, notes };
}

function uniqueKey(name, used) {
  const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  used.add(key);
  return key;
}

function abbrOf(name) {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.slice(0, 3) || 'SEC').toUpperCase();
}

/**
 * Up to 4 salient words, in first-occurrence order, joined with " · ".
 * Salient: not a stopword or filler; boosted when linked, when it opens a
 * sentence (instructions open with their verb: "Verify…", "Ask…") and when
 * it repeats.
 */
function deriveTagline(ws) {
  const seen = new Map();
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const lw = normalizeWord(w.text);
    if (lw.length < 3 || STOPWORDS.has(lw) || WEAK.has(lw) || w.vague) continue;
    if (/[\p{N}./:]/u.test(lw) || !/^\p{L}/u.test(lw)) continue;
    const key = lw.length > 4 ? lw.replace(/(?:ies|es|s)$/, '') : lw;
    const opens = i === 0 || ws[i - 1].sentence !== w.sentence;
    let e = seen.get(key);
    if (!e) {
      e = { text: lw, first: i, score: 1 + (lw.length >= 5 ? 0.3 : 0) };
      seen.set(key, e);
    } else {
      e.score += 0.6;
    }
    if (w.kind) e.score += 2;
    if (opens) e.score += 2;
  }
  const top = [...seen.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, 4)
    .sort((a, b) => a.first - b.first);
  if (!top.length) return `${ws.length} word${ws.length === 1 ? '' : 's'}`;
  return top.map((e) => e.text).join(' · ');
}
