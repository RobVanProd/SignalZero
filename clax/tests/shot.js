// Dev helper: node tests/shot.js <level> <out.png> "<js to run in page>"  — runs a snippet against CLAX_DEBUG and screenshots.
const { chromium } = require('/opt/node-tools/node_modules/playwright'); const path = require('path');
(async () => {
  const [lvl, out, code = ''] = process.argv.slice(2);
  const b = await chromium.launch(), pg = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e.stack || e))); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.goto('file://' + path.join(__dirname, '../dist/Clax_Play.html') + '?test');
  await pg.waitForFunction('window.CLAX_READY', null, { timeout: 15000 }).catch(() => {});
  const r = await pg.evaluate(async ([lvl, code]) => { const D = window.CLAX_DEBUG; if (!D) return 'no debug'; D.silence(); D.pauseSimulation(true); D.start(+lvl); const f = new Function('D', 'G', 'P', code + '\n;D.draw();return D.snapshot();'); return f(D, D.G, D.P); }, [lvl, code]).catch(e => 'EVAL ' + e.message);
  console.log(JSON.stringify(r)); if (errs.length) console.log('ERRORS', errs.slice(0, 5).join('\n'));
  await pg.screenshot({ path: out }); await b.close();
})();
