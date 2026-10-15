// Bundles the game into one self-contained offline HTML file: dist/signal-zero.html
// three.js is bundled from node_modules (no CDN at runtime).
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

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
  const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
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
