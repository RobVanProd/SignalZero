// Dev helper: frame-by-frame strips of motion -> node tests/strip.js out.png
const { chromium } = require('/opt/node-tools/node_modules/playwright'); const path = require('path'), fs = require('fs');
(async () => {
  const b = await chromium.launch(), pg = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await pg.goto('file://' + path.join(__dirname, '../dist/Clax_Play.html') + '?test'); await pg.waitForFunction('window.CLAX_READY');
  const seqs = { run: [`D.advance(.6,['right'])`, 10, .033, ['right']], jump: [`D.advance(.3,['right']);D.press('jump')`, 10, .085, ['right', 'jump']], turn: [`D.advance(.5,['right'])`, 10, .033, ['left']], snap: [`D.advance(.2,[]);D.press('snap')`, 10, .028, []] };
  const shots = [];
  for (const [name, [setup, n, dt, keys]] of Object.entries(seqs)) {
    await pg.evaluate(setup => { const D = CLAX_DEBUG, G = D.G; D.silence(); D.pauseSimulation(true); D.start(0); G.chapterTimer = 0; G.level.enemies.length = 0; G.level.radio.length = 0; G.level.hints.length = 0; G.level.areas.length = 0; D.teleport(18 * 64, 30 * 64); D.advance(.4, []); G.toastTimer = 0; new Function('D', setup)(D); }, setup);
    for (let i = 0; i < n; i++) { const box = await pg.evaluate(([dt, keys]) => { const D = CLAX_DEBUG, G = D.G; D.advance(dt, keys); const p = G.player; return { x: p.x - G.camera.x, y: p.y - G.camera.y }; }, [dt, keys]); const f = `/tmp/strip_${name}_${i}.png`; await pg.screenshot({ path: f, clip: { x: Math.max(0, box.x - 110), y: Math.max(0, box.y - 200), width: 220, height: 230 } }); shots.push(f); }
  }
  fs.writeFileSync('/tmp/strip.json', JSON.stringify(shots)); await b.close();
})();
