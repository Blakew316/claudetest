/**
 * Bundle the app into one self-contained page: dist/index.html, with the CSS
 * and the minified JS inlined (only Google Fonts stays external). Works from
 * file:// and is what Netlify publishes.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const out = await build({
  entryPoints: [new URL('src/main.js', root).pathname],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await readFile(new URL('src/styles.css', root), 'utf8');
let html = await readFile(new URL('index.html', root), 'utf8');
html = html
  .replace('<link rel="stylesheet" href="./src/styles.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="./src/main.js"></script>', () => `<script>${js}</script>`);
if (html.includes('./src/')) throw new Error('build: index.html still references ./src/');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/index.html', root), html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
