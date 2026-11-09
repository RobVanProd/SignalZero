/* In-browser checks against the built single file (headless Chromium): load, menus, keyboard, every level under
   random input for JS errors / non-finite state, boss -> exit -> results, touch layout, draw cost.
   node tests/browser.js */
const { chromium } = require('/opt/node-tools/node_modules/playwright'); const path = require('path');
(async () => {
  let pass = 0, fail = 0; const check = (n, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? '  [' + info + ']' : ''}`); ok ? pass++ : fail++; };
  const b = await chromium.launch(), url = 'file://' + path.join(__dirname, '../dist/Clax_Play.html');
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } }), pg = await ctx.newPage();
  const errs = [], reqs = []; pg.on('pageerror', e => errs.push(String(e.stack || e).slice(0, 300))); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); pg.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) reqs.push(r.url()); });
  await pg.goto(url + '?test'); await pg.waitForFunction('window.CLAX_READY', null, { timeout: 20000 });
  check('game loads and all art decodes', await pg.evaluate(() => Object.keys(CLAX_ASSETS).every(k => CLAX_DEBUG.images[k] && CLAX_DEBUG.images[k].width > 0)));
  check('title screen visible', await pg.isVisible('#title-screen'));
  await pg.click('#open-guide'); check('field guide opens', await pg.isVisible('#guide-screen')); await pg.keyboard.press('Escape');
  await pg.click('#start'); check('start opens the story', await pg.isVisible('#dialogue-screen') && (await pg.textContent('#speaker')) === 'ADA');
  await pg.click('#dialogue-skip'); check('skip enters play', await pg.evaluate(() => CLAX_DEBUG.G.mode === 'play'));
  await pg.evaluate(() => CLAX_DEBUG.silence());
  const x0 = await pg.evaluate(() => CLAX_DEBUG.G.player.x); await pg.keyboard.down('KeyD'); await pg.waitForTimeout(500); await pg.keyboard.up('KeyD'); const x1 = await pg.evaluate(() => CLAX_DEBUG.G.player.x); check('keyboard moves Clax', x1 > x0 + 60, (x1 - x0).toFixed(0) + 'px');
  await pg.keyboard.down('Space'); await pg.waitForTimeout(120); const vy = await pg.evaluate(() => CLAX_DEBUG.G.player.vy); await pg.keyboard.up('Space'); check('keyboard jump', vy < -200, 'vy ' + vy.toFixed(0));
  await pg.keyboard.press('Escape'); check('pause', await pg.isVisible('#pause-screen')); const px = await pg.evaluate(() => CLAX_DEBUG.G.time); await pg.waitForTimeout(200); check('pause freezes the simulation', px === await pg.evaluate(() => CLAX_DEBUG.G.time)); await pg.keyboard.press('Escape');
  // every level: scripted tour + random input, looking for exceptions and broken state
  for (const lvl of [0, 1, 2]) {
    const r = await pg.evaluate(lvl => {
      const D = CLAX_DEBUG, G = D.G; D.pauseSimulation(true); D.start(lvl); let seed = 99 + lvl, rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647, bad = 0, deaths0 = 0;
      const stops = [G.level.start, ...G.level.checkpoints, ...G.level.npcs, ...G.level.areas.map(a => ({ x: a.x + 200, y: (a.y0 + a.y1) / 2 }))];
      const acts = ['left', 'right', 'right', 'jump', 'jump', 'snap', 'dash', 'down', 'burst', 'up'];
      for (const s of stops) {
        D.teleport(s.x, Math.min(s.y, G.level.height) - 20); G.player.hp = G.player.maxHp;
        for (let k = 0; k < 40; k++) { const keys = acts.filter(() => rnd() < .28); for (const a of keys) if (rnd() < .5) D.press(a); D.advance(.15, keys, k % 4 === 0); const p = G.player; if (![p.x, p.y, p.vx, p.vy, G.camera.x, G.camera.y].every(Number.isFinite)) bad++; }
      }
      D.draw(); return { bad, mode: G.mode, deaths: G.deaths, enemies: G.level.enemies.length, killed: G.kills };
    }, lvl);
    check(`level ${lvl + 1}: 6-minute random-input tour keeps state finite`, r.bad === 0 && ['play', 'dialogue', 'clear'].includes(r.mode), JSON.stringify(r));
  }
  for (const lvl of [0, 1, 2]) {
    const r = await pg.evaluate(lvl => {
      const D = CLAX_DEBUG, G = D.G; D.start(lvl); const B = G.level.boss; D.teleport(B.gate + 200, B.y - 5); D.advance(.5, ['right']); const active = B.active;
      let guard = 0, phases = new Set(); while (!B.dead && guard++ < 400) { G.player.hp = G.player.maxHp; G.player.invincible = 1; phases.add(B.attackPhase); D.damageEnemy(B, 1, G.player.x, true); D.advance(.12, []); }
      const lockedBefore = G.mode === 'play'; D.advance(1, []); D.teleport(G.level.exit.x - 150, G.level.exit.y - 5); D.advance(1.2, ['right']);
      const dlg = G.mode === 'dialogue'; D.skipDialogue(); return { active, dead: B.dead, phases: [...phases], dlg, mode: G.mode, lockedBefore };
    }, lvl);
    check(`level ${lvl + 1}: boss wakes, cycles attacks, dies; exit leads to results`, r.active && r.dead && r.phases.length >= 3 && r.dlg && r.mode === 'clear', JSON.stringify(r));
    check(`level ${lvl + 1}: results screen shown`, await pg.isVisible('#clear-screen'));
  }
  const stats = await pg.evaluate(async () => { const D = CLAX_DEBUG, G = D.G, out = []; for (const lvl of [0, 1, 2]) { D.start(lvl); D.clearMetrics(); const st = [G.level.start, ...G.level.checkpoints]; for (const s of st) { D.teleport(s.x, s.y - 10); for (let k = 0; k < 30; k++) D.advance(.1, ['right']); } out.push(D.renderStats()); } return out; });
  stats.forEach((s, i) => check(`level ${i + 1}: draw p95 under 16.7 ms (headless CPU canvas)`, s.p95 < 16.7, `mean ${s.mean.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(1)} n=${s.samples}`));
  check('no JavaScript errors', errs.length === 0, errs.slice(0, 3).join(' | ')); check('no network requests', reqs.length === 0, reqs.slice(0, 2).join(' '));
  // fall recovery and death
  const fr = await pg.evaluate(() => { const D = CLAX_DEBUG, G = D.G; D.start(0); D.advance(.5, ['right']); const hp = G.player.hp; D.teleport(38 * 64, 31 * 64); D.advance(2.5, []); const a = { hp: G.player.hp, y: G.player.y, grounded: G.player.grounded, deaths: G.deaths }; G.player.hp = .5; G.player.invincible = 0; D.damagePlayer(1, 0); D.advance(1.2, []); return { hp, a, deaths: G.deaths, mode: G.mode, x: G.player.x }; });
  check('falling in a pit costs one hull point and returns to solid ground', fr.a.hp === fr.hp - 1 && fr.a.grounded && fr.a.deaths === 0, JSON.stringify(fr.a)); check('death respawns at the checkpoint', fr.deaths === 1 && fr.mode === 'play');
  await ctx.close();
  const tc = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }), tp = await tc.newPage(); const terr = []; tp.on('pageerror', e => terr.push(String(e)));
  await tp.goto(url + '?test'); await tp.waitForFunction('window.CLAX_READY'); await tp.evaluate(() => { CLAX_DEBUG.silence(); CLAX_DEBUG.start(0); });
  check('touch controls appear on a touch device', await tp.isVisible('.touch-jump')); const tx0 = await tp.evaluate(() => CLAX_DEBUG.G.player.x);
  await tp.evaluate(() => { const e = document.querySelector('.touch-right'); e.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, bubbles: true })); }); await tp.waitForTimeout(400);
  const tx1 = await tp.evaluate(() => CLAX_DEBUG.G.player.x); check('touch button moves Clax', tx1 > tx0 + 40, (tx1 - tx0).toFixed(0) + 'px'); check('no errors on the touch layout', terr.length === 0, terr[0] || '');
  await b.close(); console.log(`\nBROWSER: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
