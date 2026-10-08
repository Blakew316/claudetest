/**
 * Tests for src/analyze: section detection, tokenising, classification,
 * flags, totals and the spec score. Run: node --test test/analyze.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrompt, MAX_WORDS, MAX_SECTIONS, DEFAULT_FILE_NAME } from '../src/analyze/parse.js';
import { classifyTokens, classifyWord, LINK_WORDS, VAGUE_WORDS, VAGUE_PHRASES } from '../src/analyze/lexicon.js';
import { computeScore, SCORE_EXPLAINER } from '../src/analyze/score.js';
import { SAMPLE_PROMPT, SAMPLE_FILE_NAME } from '../src/analyze/sample.js';
import { sectionColor } from '../src/core/theme.js';
import { mulberry32 } from '../src/core/rng.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const sample = () => parsePrompt(SAMPLE_PROMPT, { fileName: SAMPLE_FILE_NAME });

/** Structural invariants every Analysis must satisfy, whatever the input. */
function assertValid(a) {
  assert.ok(typeof a.fileName === 'string' && a.fileName.length > 0, 'fileName');
  assert.ok(a.sections.length >= 1 && a.sections.length <= MAX_SECTIONS, 'section count');
  assert.ok(a.words.length <= MAX_WORDS, 'word cap');
  let next = 0;
  const keys = new Set();
  a.sections.forEach((s, i) => {
    assert.equal(s.index, i);
    assert.equal(s.start, next, `section ${i} is contiguous`);
    assert.ok(Number.isInteger(s.count) && s.count >= 0);
    assert.equal(s.color, sectionColor(i));
    assert.ok(s.name.length > 0 && s.name.length <= 18 && s.name === s.name.toLowerCase(), `name "${s.name}"`);
    assert.equal(s.abbr, s.abbr.toUpperCase());
    assert.ok(s.abbr.length >= 1 && s.abbr.length <= 3);
    assert.equal(typeof s.subtitle, 'string');
    assert.ok(!keys.has(s.key), `unique key ${s.key}`);
    keys.add(s.key);
    next += s.count;
  });
  assert.equal(next, a.words.length, 'sections cover every word');
  const byKind = { owner: 0, approval: 0, claim: 0, spec: 0, file: 0 };
  let linked = 0, vague = 0, guessed = 0;
  a.words.forEach((w, i) => {
    assert.equal(w.id, i);
    const s = a.sections[w.section];
    assert.ok(s && i >= s.start && i < s.start + s.count, `word ${i} inside its section`);
    assert.ok(w.text.length > 0);
    assert.ok(w.sentence >= 0 && w.sentence < a.sentences.length);
    assert.ok(a.sentences[w.sentence].includes(w.text), `sentence holds "${w.text}"`);
    if (w.vague) {
      assert.equal(w.kind, null, 'vague words carry no kind');
      assert.equal(w.guessed, false);
      assert.ok(typeof w.question === 'string' && w.question.includes('?'), 'vague words ask a question');
      vague++;
    } else {
      assert.equal(w.question, null);
    }
    if (w.guessed) assert.ok(w.kind, 'guessed implies a kind');
    if (w.kind) { linked++; byKind[w.kind]++; if (w.guessed) guessed++; }
  });
  assert.deepEqual(a.totals, { words: a.words.length, linked, vague, guessed, byKind });
  assert.equal(a.flags.length, vague);
  for (const f of a.flags) {
    const w = a.words[f.wordId];
    assert.ok(w.vague);
    assert.equal(f.section, w.section);
    assert.equal(f.sentence, a.sentences[w.sentence]);
    assert.equal(f.question, w.question);
    assert.ok(f.sentence.includes(f.word), `flag word "${f.word}" is in its sentence`);
  }
  assert.ok(['markdown', 'xml', 'labels', 'paragraphs'].includes(a.notes.detectedBy));
  assert.equal(typeof a.notes.truncated, 'boolean');
  assert.ok(a.notes.originalWords >= a.words.length);
}

describe('sample prompt', () => {
  test('yields the seven authored sections with their taglines', () => {
    const a = sample();
    assert.equal(a.fileName, 'studio.prompt');
    assert.equal(a.notes.detectedBy, 'markdown');
    assert.deepEqual(a.sections.map((s) => s.name), ['role', 'objective', 'context', 'roles', 'rules', 'review', 'start']);
    assert.deepEqual(a.sections.map((s) => s.subtitle), [
      'who the studio works for',
      'one release · one manual run',
      'sources · files · approvals',
      'six owners · six outputs',
      'verify · ask · keep · report',
      'does every claim trace?',
      'smallest release first',
    ]);
    assert.deepEqual(a.sections.map((s) => s.abbr), ['ROL', 'OBJ', 'CON', 'ROL', 'RUL', 'REV', 'STA']);
    assert.deepEqual(a.sections.map((s) => s.key), ['role', 'objective', 'context', 'roles', 'rules', 'review', 'start']);
    assertValid(a);
  });

  test('word totals are stable', () => {
    const a = sample();
    assert.deepEqual(a.sections.map((s) => s.count), [38, 26, 26, 38, 35, 23, 19]);
    assert.deepEqual(a.totals, {
      words: 205, linked: 50, vague: 7, guessed: 0,
      byKind: { owner: 19, approval: 6, claim: 14, spec: 4, file: 7 },
    });
    assert.deepEqual(a.notes, { detectedBy: 'markdown', truncated: false, originalWords: 205, skippedCodeBlocks: 0 });
    assert.equal(a.sentences.length, 25);
  });

  test('known words classify as expected', () => {
    const a = sample();
    const first = (text) => {
      const w = a.words.find((x) => x.text === text);
      assert.ok(w, `"${text}" is in the sample`);
      return w;
    };
    const expect = {
      owns: 'owner', Owners: 'owner', producer: 'owner', chief: 'owner', staff: 'owner', writers: 'owner', writer: 'owner',
      approve: 'approval', approval: 'approval', Buying: 'approval', publishing: 'approval',
      Verify: 'claim', source: 'claim', Sources: 'claim', claim: 'claim', credits: 'claim', traceable: 'claim', fact: 'claim',
      '1600px': 'spec', '30s': 'spec', '900-word': 'spec', timestamp: 'spec',
      'manifest.json': 'file', 'BRAND.md': 'file', 'research.md': 'file', '/research': 'file', file: 'file', files: 'file',
    };
    for (const [text, kind] of Object.entries(expect)) {
      const w = first(text);
      assert.equal(w.kind, kind, `${text} -> ${kind}`);
      assert.equal(w.guessed, false, `${text} is an exact hit`);
      assert.equal(w.vague, false);
    }
    for (const text of ['full', 'short', 'nice', 'clean', 'taste', 'smallest', 'needed']) {
      const w = first(text);
      assert.equal(w.vague, true, `${text} is vague`);
      assert.equal(w.kind, null);
    }
    // Plain on purpose: no silly links in the demo.
    for (const text of ['release', 'one', 'two-room', 'You', 'you', 'cover', 'brief', 'Ship', 'possible', 'Every']) {
      const w = first(text);
      assert.equal(w.kind, null, `${text} is plain`);
      assert.equal(w.vague, false, `${text} is not vague`);
    }
  });

  test('flags carry the phrase, its sentence and a concrete question', () => {
    const a = sample();
    assert.deepEqual(a.flags.map((f) => f.word), ['full', 'short', 'nice', 'clean', 'taste', 'smallest', 'as needed']);
    const asNeeded = a.flags[6];
    assert.equal(a.words[asNeeded.wordId].text, 'needed', 'a phrase flag sits on its last word');
    assert.equal(asNeeded.sentence, 'Get approval, then repeat as needed.');
    assert.equal(asNeeded.sentence.slice(asNeeded.start, asNeeded.start + asNeeded.word.length), 'as needed');
    assert.equal(a.flags[0].question, 'Full means which items? List them.');
    for (const f of a.flags) assert.match(f.question, /\?/);
  });

  test('is deterministic and CRLF-insensitive', () => {
    assert.deepEqual(sample(), sample());
    assert.deepEqual(parsePrompt(SAMPLE_PROMPT.replace(/\n/g, '\r\n'), { fileName: SAMPLE_FILE_NAME }), sample());
  });
});

describe('lexicon', () => {
  const cls = (sentence) => classifyTokens(sentence.split(' '));
  const at = (sentence, word) => cls(sentence)[sentence.split(' ').indexOf(word)];

  test('tables are readable data', () => {
    for (const kind of ['owner', 'approval', 'claim', 'spec', 'file']) assert.ok(LINK_WORDS[kind].length > 5);
    for (const q of [...Object.values(VAGUE_WORDS), ...Object.values(VAGUE_PHRASES)]) assert.match(q, /\?/);
  });

  test('suffix fallbacks are guessed links', () => {
    assert.deepEqual(classifyWord('approvers'), { kind: 'owner', guessed: true, vague: false, question: null, phraseStart: 0 });
    assert.equal(classifyWord('sourcing').kind, 'claim');
    assert.equal(classifyWord('sourcing').guessed, true);
    assert.equal(classifyWord('merged').kind, 'approval');
    assert.equal(classifyWord('approver').guessed, false);
    assert.equal(classifyWord('engineering').kind, null, 'owners only take plural suffixes');
  });

  test('rule-based spec and file links', () => {
    for (const w of ['5.5', '1600px', '30s', '4k', '16:9', 'v2', '900-word', '2026-10-08', 'png', 'JSON']) {
      assert.equal(classifyWord(w).kind, 'spec', w);
    }
    for (const w of ['BRAND.md', 'manifest.json', '/research', 'src/x', 'docs/a/b', 'https://example.com/a', 'example.com', 'folder']) {
      assert.equal(classifyWord(w).kind, 'file', w);
    }
    for (const w of ['and/or', 'e.g', 'one', 'six', 'release']) assert.equal(classifyWord(w).kind, null, w);
    assert.equal(at('a 1600 pixels wide cover', 'pixels').kind, 'spec');
    assert.equal(at('measure it in pixels please', 'pixels').kind, null);
  });

  test('a nearby number makes a size word specific', () => {
    assert.equal(at('a short 200-word note', 'short').vague, false);
    assert.equal(at('a short two-page note', 'short').vague, false);
    assert.equal(at('a short note', 'short').vague, true);
    assert.equal(at('keep it short and sweet', 'short').vague, true);
  });

  test('context rules stop obvious false positives', () => {
    assert.equal(at('how many words', 'many').vague, false);
    assert.equal(at('as long as it works', 'long').vague, false);
    assert.equal(at('in short do it', 'short').vague, false);
    assert.equal(at('a large language model', 'large').vague, false);
    assert.equal(at('what kind of output', 'of').vague, false);
    assert.equal(at('it is kind of slow', 'of').vague, true);
    assert.equal(at('ask the team lead first', 'lead').kind, 'owner');
    assert.equal(at('send it to the policy lead', 'lead').kind, 'owner');
    assert.equal(at('Lead with the result', 'Lead').kind, null);
    assert.equal(at('this will lead to errors', 'lead').kind, null);
    assert.equal(at('the 2025 user survey', 'user').kind, null);
    assert.equal(at('ask the user first', 'user').kind, 'owner');
    assert.equal(at('thank you', 'you').kind, null);
  });

  test('phrases flag their last word', () => {
    const r = cls('repeat as needed');
    assert.equal(r[2].vague, true);
    assert.equal(r[2].phraseStart, 1);
    assert.equal(r[1].vague, false);
    const s = cls('reply as soon as possible');
    assert.deepEqual(s.map((x) => x.vague), [false, false, false, false, true]);
    assert.equal(s[4].question, VAGUE_PHRASES['as soon as possible']);
    assert.equal(cls('use it if possible')[3].question, VAGUE_PHRASES['if possible']);
  });
});

describe('section detection fallbacks', () => {
  test('markdown: single H1 is the title, H2s are sections, preamble kept', () => {
    const a = parsePrompt('# Release Desk Prompt\n\nRead this whole thing first.\n\n## Tone: calm\nBe calm.\n\n## Scope\nOnly billing questions.');
    assert.equal(a.fileName, 'release-desk.prompt');
    assert.deepEqual(a.sections.map((s) => s.name), ['preamble', 'tone', 'scope']);
    assert.equal(a.sections[1].subtitle, 'calm');
    assertValid(a);
  });

  test('xml: top-level tags become sections', () => {
    const a = parsePrompt(fixture('xml-system-prompt.txt'));
    assert.equal(a.notes.detectedBy, 'xml');
    assert.deepEqual(a.sections.map((s) => s.name), ['preamble', 'context', 'instructions', 'format', 'examples']);
    assert.ok(a.words.some((w) => w.text === 'docs/billing-policy.md' && w.kind === 'file'));
    assert.ok(!a.words.some((w) => /[<>]/.test(w.text)), 'tags are not words');
    assertValid(a);
  });

  test('xml: a single wrapper tag is looked inside', () => {
    const a = parsePrompt('<prompt>\n<role>You are an editor.</role>\n<task>Fix the draft.</task>\n</prompt>');
    assert.equal(a.notes.detectedBy, 'xml');
    assert.deepEqual(a.sections.map((s) => s.name), ['role', 'task']);
  });

  test('xml beats markdown headings nested inside tags', () => {
    const a = parsePrompt('<role>\nYou are an editor.\n</role>\n<task>\n## Steps\n1. Read the draft.\n2. Fix it.\n</task>');
    assert.equal(a.notes.detectedBy, 'xml');
    assert.deepEqual(a.sections.map((s) => s.name), ['role', 'task']);
  });

  test('labels: ROLE: lines and Title: lines', () => {
    const a = parsePrompt(fixture('labels-prompt.txt'));
    assert.equal(a.notes.detectedBy, 'labels');
    assert.deepEqual(a.sections.map((s) => s.name), ['role', 'task', 'audience', 'format', 'constraints']);
    assert.equal(a.words[0].text, 'You', 'inline label text is read');
    assert.ok(!a.words.some((w) => w.text === 'ROLE' || w.text === 'TASK'), 'labels are not words');
    assertValid(a);
    const b = parsePrompt('Role:\nYou are an editor.\n\nOutput Format:\nA list.\n\nNote: this is not a label.');
    assert.deepEqual(b.sections.map((s) => s.name), ['role', 'output format']);
  });

  test('paragraphs: one paragraph splits into ~25–40 word parts', () => {
    const a = parsePrompt(fixture('plain-paragraph.txt'));
    assert.equal(a.notes.detectedBy, 'paragraphs');
    assert.deepEqual(a.sections.map((s) => s.name), ['part 1', 'part 2', 'part 3']);
    assert.deepEqual(a.sections.map((s) => s.abbr), ['P01', 'P02', 'P03']);
    for (const s of a.sections) assert.ok(s.count >= 15 && s.count <= 45, `${s.name} has ${s.count} words`);
    assertValid(a);
  });

  test('paragraphs: blank-line paragraphs, bold leads name them', () => {
    const a = parsePrompt('**Goal.** Write a short launch note for the app.\n\nKeep the tone warm and plain, and mention the waitlist.\n\nThanks!');
    assert.deepEqual(a.sections.map((s) => s.name), ['goal', 'part 2']);
    assert.equal(a.words[0].text, 'Write');
    assert.equal(a.words.at(-1).text, 'Thanks', 'a tiny paragraph rides along with its neighbour');
    assertValid(a);
  });

  test('taglines are derived when not authored', () => {
    const a = parsePrompt(fixture('labels-prompt.txt'));
    const task = a.sections.find((s) => s.name === 'task');
    assert.match(task.subtitle, /^[^·]+( · [^·]+){0,3}$/);
    assert.ok(task.subtitle.includes('claims'), task.subtitle);
  });

  test('more than 12 sections merge the tail into the 12th', () => {
    const text = Array.from({ length: 20 }, (_, i) => `## part ${i}\nAlpha beta gamma delta ${i}.`).join('\n\n');
    const a = parsePrompt(text);
    assert.equal(a.sections.length, 12);
    assert.equal(a.sections[11].count, 9 * 5);
    assert.match(a.sections[11].subtitle, /\+8 more$/);
    assertValid(a);
  });
});

describe('tokenising', () => {
  test('strips markdown and keeps the readable text', () => {
    const a = parsePrompt([
      '## a',
      '- See [the brief](https://x.com/brief) and `npm test`.',
      '1. First item **bold** _em_ snake_case.',
      '> Quoted line &amp; more.',
      '',
      '```js',
      'const hidden = 1;',
      '```',
      '## b',
      '| col one | col two |',
      '|---|---|',
      '| BRAND.md | 16:9 |',
    ].join('\n'));
    assert.deepEqual(a.words.map((w) => w.text), [
      'See', 'the', 'brief', 'and', 'npm', 'test',
      'First', 'item', 'bold', 'em', 'snake_case',
      'Quoted', 'line', 'more',
      'col', 'one', 'col', 'two', 'BRAND.md', '16:9',
    ]);
    assert.equal(a.notes.skippedCodeBlocks, 1);
    assert.ok(!a.words.some((w) => w.text === '1'), 'list numbers are not spec words');
  });

  test('keeps internal punctuation that matters', () => {
    const a = parsePrompt("Use BRAND.md, 5.5 and 1600px at 16:9 for v2. Don't skip /research or the 900-word note. It costs $5,000.");
    const texts = a.words.map((w) => w.text);
    for (const t of ['BRAND.md', '5.5', '1600px', '16:9', 'v2', "Don't", '/research', '900-word', '5,000']) assert.ok(texts.includes(t), t);
  });
});

describe('robustness', () => {
  const emptySafe = (a) => {
    assert.equal(a.sections.length, 1);
    assert.equal(a.sections[0].count, 0);
    assert.equal(a.words.length, 0);
    assert.equal(a.flags.length, 0);
    assert.equal(a.totals.words, 0);
    assertValid(a);
  };

  test('empty and whitespace-only input give one empty-safe section', () => {
    emptySafe(parsePrompt(''));
    emptySafe(parsePrompt('   \n\t\r\n  '));
    emptySafe(parsePrompt('🕷️🕸️ ✨'));
    const fences = parsePrompt('```\ncode only\n```\n\n~~~\nmore\n~~~');
    emptySafe(fences);
    assert.equal(fences.notes.skippedCodeBlocks, 2);
    assert.equal(parsePrompt('').fileName, DEFAULT_FILE_NAME);
  });

  test('never throws on odd input', () => {
    for (const input of [null, undefined, 42, {}, [], '\ud800 lone surrogate', '#', '##', '<a>', '<a></a><b></b>', ':', 'A:\nB:', '**', '[x](y)', '\u0000\u0001', 'é'.normalize('NFD') + 'tude']) {
      assertValid(parsePrompt(input));
    }
  });

  test('fuzz: random mixes of markdown, tags and words stay valid', () => {
    const rand = mulberry32(1234);
    const parts = ['# ', '## ', '### ', '<role>', '</role>', '<task>', '</task>', 'ROLE:', 'Task:', '\n', '\n\n', '\r\n', '```', '~~~',
      '- ', '1. ', '> ', '**', '_', '`', '|', ' — ', ' - ', ': ', 'owner', 'approves', 'the', 'short', 'as needed', 'BRAND.md',
      '/research', '1600px', 'https://a.io/x', '🕷️', '日本語', 'é', '.', '!', '?', ' ', '  ', 'kind of', 'lead', 'user'];
    for (let i = 0; i < 300; i++) {
      let s = '';
      const n = Math.floor(rand() * 80);
      for (let k = 0; k < n; k++) s += parts[Math.floor(rand() * parts.length)];
      assertValid(parsePrompt(s, { fileName: rand() < 0.5 ? 'x.md' : undefined }));
    }
  });

  test('10k words are truncated to 1,500 and parse in under 200 ms', () => {
    const vocab = ['the', 'owner', 'approves', 'each', 'claim', 'with', 'a', 'source', 'in', 'BRAND.md', 'keep', 'it', 'short', 'and', '1600px', 'nice'];
    const words = Array.from({ length: 10000 }, (_, i) => vocab[(i * 7 + (i >> 4)) % vocab.length] + (i % 19 === 18 ? '.' : ''));
    const paragraphs = [];
    for (let i = 0; i < words.length; i += 50) paragraphs.push(words.slice(i, i + 50).join(' '));
    for (const text of [words.join(' '), paragraphs.join('\n\n')]) {
      parsePrompt(text); // warm up the JIT
      const t0 = performance.now();
      const a = parsePrompt(text);
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `parsed in ${ms.toFixed(1)} ms`);
      assert.equal(a.notes.truncated, true);
      assert.equal(a.notes.originalWords, 10000);
      assert.equal(a.words.length, MAX_WORDS);
      assert.equal(a.sections.length, MAX_SECTIONS, 'the read words are spread over 12 parts');
      assertValid(a);
    }
  });

  test('file name: explicit wins, then an H1, then the default', () => {
    assert.equal(parsePrompt('# notes.md\n\n## a\nx y z\n## b\nq r s', { fileName: 'drop.txt' }).fileName, 'drop.txt');
    assert.equal(parsePrompt('# notes.md\n\n## a\nx y z\n## b\nq r s').fileName, 'notes.md');
    assert.equal(parsePrompt('just some words here').fileName, DEFAULT_FILE_NAME);
  });
});

describe('spec score', () => {
  const counts = (a, upto) => {
    const c = { read: 0, linked: 0, flagged: 0, guessed: 0, claims: 0, owners: 0, approvals: 0 };
    for (const w of a.words.slice(0, upto)) {
      c.read++;
      if (w.kind) c.linked++;
      if (w.guessed) c.guessed++;
      if (w.vague) c.flagged++;
    }
    return c;
  };

  test('starts at 0, rises section by section, and finishes the sample in 75..88', () => {
    const a = sample();
    assert.equal(computeScore(a, counts(a, 0)), 0);
    const ends = a.sections.map((s) => computeScore(a, counts(a, s.start + s.count)));
    for (let i = 1; i < ends.length; i++) assert.ok(ends[i] > ends[i - 1], `score rises: ${ends.join(' ')}`);
    const final = ends.at(-1);
    assert.ok(final >= 75 && final <= 88, `finished score ${final}`);
    assert.equal(final, 83);
  });

  test('vague words lower it, links raise it', () => {
    const a = sample();
    const base = { read: 205, linked: 30, flagged: 0 };
    assert.ok(computeScore(a, { ...base, flagged: 10 }) < computeScore(a, base));
    assert.ok(computeScore(a, { ...base, linked: 5 }) < computeScore(a, base));
    assert.equal(computeScore(a, { read: 205, linked: 205, flagged: 0 }), 100);
  });

  test('is a bounded integer for any counts', () => {
    const a = sample();
    for (const c of [{}, { read: -5 }, { read: 1e9, linked: 1e9, flagged: 0 }, { read: 10, linked: 0, flagged: 10 }, { read: NaN }]) {
      const s = computeScore(a, c);
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, `${JSON.stringify(c)} -> ${s}`);
    }
    assert.equal(computeScore(parsePrompt(''), { read: 0, linked: 0, flagged: 0 }), 0);
    assert.equal(computeScore(a, null), 0);
  });

  test('has a plain explainer', () => {
    assert.ok(SCORE_EXPLAINER.length > 40);
    assert.ok((SCORE_EXPLAINER.match(/[.!?](\s|$)/g) || []).length <= 2);
  });
});
