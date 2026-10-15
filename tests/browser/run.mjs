// End-to-end browser test with REAL WebGL (Chromium + SwiftShader), not a mocked Three.js.
// Usage: npm run build && npm run test:browser
// Screenshots are written to tests/browser/out/ for human review.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(root, 'tests/browser/out');
fs.mkdirSync(OUT, { recursive: true });
const html = fs.readFileSync(path.join(root, 'dist/signal-zero.html'));
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); });
await new Promise(res => server.listen(0, res));
const url = `http://localhost:${server.address().port}/`;
const exe = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push(`PASS ${name} (${Date.now() - t0} ms)`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); throw e; }
};

async function page(viewport, query, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e.stack || e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(url + query);
  await p.waitForFunction(() => window.__SZ__ && !document.getElementById('loading'), null, { timeout: 90000 });
  return { p, errors, ctx };
}

try {
  const { p, errors } = await page({ width: 1366, height: 800 }, '?q=medium');
  await step('real WebGL2 context (not a mock)', async () => {
    const info = await p.evaluate(() => { const gl = document.querySelector('#view canvas').getContext('webgl2'); return { ok: !!gl, three: !!window.__SZ__.app.world.ctx.renderer.capabilities.isWebGL2 }; });
    assert.ok(info.three, 'renderer is WebGL2');
  });
  await step('title screen renders', async () => {
    await p.waitForSelector('#title .logo');
    await p.screenshot({ path: path.join(OUT, '01-title.png') });
  });
  await step('campaign starts with a briefing', async () => {
    await p.click('text=Begin night shift');
    await p.waitForSelector('text=THE BROKEN LINK');
    await p.screenshot({ path: path.join(OUT, '02-briefing.png') });
    await p.click('text=Start incident');
  });
  await step('M01 solved through the patch panel UI and a show command', async () => {
    await p.evaluate(() => window.__SZ__.travel('PATCH'));
    await p.evaluate(() => window.__SZ__.open('PATCH'));
    await p.click('[data-port="P01"]');
    await p.click('[data-port="P04"]');
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, '03-patch.png') });
    await p.keyboard.press('Escape');
    await p.evaluate(() => window.__SZ__.open('ACCESS-SW'));
    for (const c of ['enable', 'show interfaces status']) { await p.fill('.cmdline input', c); await p.press('.cmdline input', 'Enter'); }
    await p.screenshot({ path: path.join(OUT, '04-terminal.png') });
    await p.waitForSelector('text=INCIDENT 01 RESOLVED', { timeout: 30000 });
    await p.screenshot({ path: path.join(OUT, '05-debrief.png') });
  });
  await step('a win is debriefed and recorded exactly once', async () => {
    await p.waitForTimeout(3500); // the game loop keeps evaluating every simulated second
    assert.equal(await p.locator('.overlay').count(), 1, 'one debrief overlay');
    assert.equal(await p.evaluate(() => window.__SZ__.app.campaign.st.results.length), 1, 'one recorded result');
  });
  await step('M02 briefing follows; Windows console shows APIPA', async () => {
    await p.click('text=Next incident');
    await p.waitForSelector('text=NO ONE HAS AN ADDRESS');
    await p.click('text=Start incident');
    const out = await p.evaluate(() => window.__SZ__.run('DISPATCH-01', 'ipconfig /all'));
    assert.ok(out.some(l => l.includes('169.254.')), 'APIPA address shown');
  });
  await step('packet path animation + capture data for a failing ping', async () => {
    await p.evaluate(() => window.__SZ__.open('DISPATCH-01'));
    await p.fill('.cmdline input', 'ping 10.42.10.1');
    await p.press('.cmdline input', 'Enter');
    await p.click('text=Packet capture');
    await p.waitForSelector('.capture .eyebrow');
    await p.screenshot({ path: path.join(OUT, '06-capture.png') });
    await p.keyboard.press('Escape');
  });
  await step('map window with live topology and IPAM', async () => {
    await p.keyboard.press('KeyM');
    await p.waitForSelector('.map-svg svg');
    await p.screenshot({ path: path.join(OUT, '07-map.png') });
    await p.click('text=IPAM & docs');
    await p.waitForSelector('text=DECOMMISSIONED');
    await p.keyboard.press('Escape');
  });
  await step('world view of the NOC', async () => {
    await p.evaluate(() => window.__SZ__.cam(0, 6.5, 0, -0.04));
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(OUT, '08-noc.png') });
  });
  await step('no uncaught page errors (desktop)', async () => assert.deepEqual(errors, []));

  const c = await page({ width: 1366, height: 800 }, '?q=low');
  await step('Night Shift challenge: ticket, unguided fix from the consoles, closed once', async () => {
    // Seed 27 injects a single 'named-stopped' fault (asserted below, so a generator change fails loudly).
    await c.p.evaluate(() => window.__SZ__.app.startChallenge({ faults: 1, seed: 27 }));
    await c.p.waitForSelector('text=Take the ticket');
    await c.p.screenshot({ path: path.join(OUT, '11-ticket.png') });
    assert.deepEqual(await c.p.evaluate(() => window.__SZ__.app.challenge.ch.faults.map(f => f.id)), ['named-stopped']);
    await c.p.click('text=Take the ticket');
    await c.p.evaluate(() => window.__SZ__.open('DISPATCH-01'));
    for (const cmd of ['nslookup clinic.ops.example']) { await c.p.fill('.cmdline input', cmd); await c.p.press('.cmdline input', 'Enter'); }
    await c.p.screenshot({ path: path.join(OUT, '12-challenge-console.png') });
    await c.p.keyboard.press('Escape');
    await c.p.evaluate(() => window.__SZ__.open('CORE-SRV'));
    await c.p.fill('.cmdline input', 'sudo systemctl start named'); await c.p.press('.cmdline input', 'Enter');
    await c.p.keyboard.press('Escape');
    await c.p.evaluate(() => window.__SZ__.open('DISPATCH-01'));
    await c.p.fill('.cmdline input', 'curl https://clinic.ops.example/health'); await c.p.press('.cmdline input', 'Enter');
    await c.p.waitForSelector('text=TICKET CLOSED', { timeout: 30000 });
    await c.p.waitForTimeout(3500);
    assert.equal(await c.p.locator('.overlay').count(), 1, 'one ticket-closed overlay');
    assert.equal(await c.p.evaluate(() => JSON.parse(localStorage.getItem('signalzero.progress.v1') || '{}').challenges?.length ?? -1), 1, 'one recorded challenge');
    await c.p.screenshot({ path: path.join(OUT, '13-ticket-closed.png') });
  });
  await step('no uncaught page errors (challenge)', async () => assert.deepEqual(c.errors, []));

  const m = await page({ width: 412, height: 860 }, '?q=low', { isMobile: true, hasTouch: true });
  await step('mobile: title, campaign, touch controls, console', async () => {
    await m.p.waitForSelector('#title .logo');
    await m.p.screenshot({ path: path.join(OUT, '09-mobile-title.png') });
    await m.p.click('text=Begin night shift');
    await m.p.click('text=Start incident');
    assert.ok(await m.p.isVisible('#touch .use'), 'USE button visible');
    await m.p.evaluate(() => window.__SZ__.open('DISPATCH-01'));
    await m.p.fill('.cmdline input', 'ipconfig');
    await m.p.press('.cmdline input', 'Enter');
    await m.p.screenshot({ path: path.join(OUT, '10-mobile-console.png') });
  });
  await step('no uncaught page errors (mobile)', async () => assert.deepEqual(m.errors, []));
} finally {
  console.log(results.join('\n'));
  await browser.close();
  server.close();
}
