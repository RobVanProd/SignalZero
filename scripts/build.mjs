// Bundles the game into one self-contained offline HTML file: dist/signal-zero.html
// three.js is bundled from node_modules (no CDN at runtime).
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

// OFL-1.1 fonts, latin subset, embedded so the single HTML file works offline (licences: docs/THIRD_PARTY.md).
const FONTS = [
  ['Big Shoulders Display', 'big-shoulders-display', [600, 800, 900]],
  ['IBM Plex Mono', 'ibm-plex-mono', [400, 600]],
  ['IBM Plex Sans Condensed', 'ibm-plex-sans-condensed', [400, 600]],
];
function fontFaces() {
  let out = '';
  for (const [family, pkg, weights] of FONTS) {
    for (const w of weights) {
      const file = join(root, 'node_modules/@fontsource', pkg, 'files', `${pkg}-latin-${w}-normal.woff2`);
      const b64 = readFileSync(file).toString('base64');
      out += `@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}\n`;
    }
  }
  return out;
}

async function build() {
  const t0 = Date.now();
  const res = await esbuild.build({
    entryPoints: [join(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    minify: !dev,
    sourcemap: false,
    write: false,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"', __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  });
  const js = res.outputFiles[0].text;
  const css = fontFaces() + readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
  let html = readFileSync(join(root, 'src/index.html'), 'utf8');
  html = html.replace('/*__STYLES__*/', () => css).replace('/*__SCRIPT__*/', () => js.replace(/<\/script/gi, '<\\/script'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/signal-zero.html'), html);
  console.log(`Built dist/signal-zero.html  ${(html.length / 1024).toFixed(0)} KB  in ${Date.now() - t0} ms`);
}

await build();
if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer = null;
  fsWatch(join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch(e => console.error(e.message)), 120);
  });
  console.log('watching src/ ...');
}
