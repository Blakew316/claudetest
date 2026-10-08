# Prompt Crawler

A spider crawls your prompt section by section, links the words that make it
specific (owners, approvals, claims, specs, files) and flags the vague ones
with a question to answer before you ship.

Live: https://gentle-toffee-5c0be3.netlify.app

## Use it

- Click **Your prompt** (or press `E`), paste a prompt, press **Crawl it**.
  You can also drop a `.md` or `.txt` file anywhere on the page.
- Sections come from `## headings`, `<xml>` tags or `LABEL:` lines.
  `## rules — verify · ask · keep · report` sets the section's tagline.
- **flags to ask** (Spec score panel) lists every vague word with its
  question; **Copy questions** copies them.
- Drag the scene to orbit the 3D web; it eases back when you let go.
- `Space` pauses, `R` replays, tabs jump to a section.

## How it decides

Word lists plus a few rules (`src/analyze/lexicon.js`), not a language
model. It catches "make it nice and short"; it does not understand meaning
or spot contradictions. The spec score formula is in `src/analyze/score.js`.

## Develop

```
npm install
npm run dev     # serves the repo at http://localhost:5173
npm test        # analyzer tests
npm run build   # dist/index.html, one self-contained file incl. three.js (what Netlify serves)
```
