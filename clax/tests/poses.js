// Dev helper: renders a contact sheet of rig poses -> node tests/poses.js out.png
const { chromium } = require('/opt/node-tools/node_modules/playwright'); const path = require('path'), fs = require('fs');
(async () => {
  const out = process.argv[2];
  const b = await chromium.launch(), pg = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const errs = []; pg.on('pageerror', e => errs.push(String(e.stack || e)));
  await pg.goto('file://' + path.join(__dirname, '../dist/Clax_Play.html') + '?test'); await pg.waitForFunction('window.CLAX_READY');
  await pg.evaluate(() => { const D = CLAX_DEBUG; D.silence(); D.pauseSimulation(true); D.start(0); D.G.chapterTimer = 0; });
  const poses = [
    ['idle', `D.advance(.6,[])`], ['run a', `D.advance(.50,['right'])`], ['run b', `D.advance(.58,['right'])`], ['run c', `D.advance(.66,['right'])`], ['skid', `D.advance(.5,['right']);D.advance(.06,['left'])`],
    ['crouch', `D.advance(.5,['down'])`], ['jump', `D.press('jump');D.advance(.12,['jump','right'])`], ['apex', `D.press('jump');D.advance(.38,['jump','right'])`], ['fall', `D.press('jump');D.advance(.62,['right'])`],
    ['float', `D.press('jump');D.advance(.3,['jump']);D.press('jump');D.advance(.75,['jump'])`], ['dash', `D.press('jump');D.advance(.3,['jump','right']);D.press('dash');D.advance(.1,['right'])`],
    ['snap wind', `D.press('snap');D.advance(.03,[])`], ['snap hit', `D.press('snap');D.advance(.10,[])`], ['snap up', `D.G.player.attackUp=true;D.setHeld(['up']);D.press('snap');D.advance(.11,['up'])`], ['hurt', `D.damagePlayer(1,D.G.player.x+50);D.advance(.15,[])`],
    ['land', `D.press('jump');D.advance(.80,['jump']);`], ['left', `D.advance(.5,['left'])`], ['swing', `D.teleport(70.2*64,1700);D.G.player.vx=300;D.advance(.05,[]);D.press('snap');D.advance(.55,['right'])`], ['wall', `D.teleport(82*64-30,27.5*64);D.advance(.3,['right'])`], ['win', `D.G.player.win=1;D.advance(.3,[])`],
  ];
  const shots = [];
  for (const [name, code] of poses) {
    const box = await pg.evaluate(code => { const D = CLAX_DEBUG, G = D.G; D.start(0); G.chapterTimer = 0; G.level.enemies.length = 0; G.level.radio.length = 0; G.level.hints.length = 0; G.toastTimer = 0; D.teleport(20 * 64, 30 * 64); D.advance(.3, []); new Function('D', code)(D); D.draw(); const p = G.player; return { x: p.x - G.camera.x, y: p.y - G.camera.y }; }, code);
    const f = `/tmp/pose_${shots.length}.png`; await pg.screenshot({ path: f, clip: { x: Math.max(0, box.x - 130), y: Math.max(0, box.y - 230), width: 260, height: 270 } }); shots.push([name, f]);
  }
  if (errs.length) console.log('ERRORS', errs.slice(0, 4).join('\n'));
  fs.writeFileSync('/tmp/poses.json', JSON.stringify(shots)); await b.close();
})();
