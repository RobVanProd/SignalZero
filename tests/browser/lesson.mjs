// Browser test for Apprenticeship Lesson 1, driven through the real UI (clicks and typed commands), on a desktop
// and a phone viewport. Usage: npm run build && npm run test:lesson. Screenshots go to tests/browser/out/lesson-*.png.
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
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push(`PASS ${name} (${Date.now() - t0} ms)`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); throw e; }
};

async function open(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const p = await ctx.newPage();
  p.setDefaultTimeout(90000); // software WebGL shares the CPU with the page: clicks can wait behind a frame
  const errors = [];
  p.on('pageerror', e => errors.push(String(e.stack || e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${url}?q=low`);
  await p.waitForFunction(() => window.__SZ__ && !document.getElementById('loading'), null, { timeout: 180000 });
  await p.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  return { p, ctx, errors };
}

const phase = p => p.evaluate(() => window.__SZ__.lesson()?.phase);
const stepId = p => p.evaluate(() => window.__SZ__.lesson()?.step?.id);

/** Type a command in the bench console of `dev` (switching tab if needed) and press Enter. */
async function type(p, dev, line, mobile = false) {
  if (mobile) await p.click('.bn-tab[data-tab="console"]');
  await p.click(`.bn-devtab:has-text("${dev}")`);
  await p.fill('.bn-term input', line);
  await p.press('.bn-term input', 'Enter');
  if (mobile) await p.click('.bn-tab[data-tab="lesson"]');
}

async function predictRight(p) {
  if ((await phase(p)) !== 'predict') return;
  const k = await p.evaluate(() => window.__SZ__.lesson().step.predict.options.findIndex(o => o.correct));
  await p.locator('.bn-card .bn-opt').nth(k).click();
}

async function continueThrough(p) {
  // result -> (check) -> next
  await p.click('.bn-card button:has-text("Continue")');
  if ((await phase(p)) === 'check') {
    const k = await p.evaluate(() => { const r = window.__SZ__.lesson(); return r.step.check.options.findIndex(o => o.correct || o.fault === r.st.transferFault); });
    await p.locator('.bn-card .bn-opt').nth(k).click();
    await p.click('.bn-card button:has-text("Continue")');
  }
  if ((await phase(p)) === 'explain') {
    await p.fill('.bn-card textarea', 'ip route showed the default gateway was not the router, and ping got no replies.');
    await p.click('.bn-card button:has-text("Submit")');
  }
  // a refresher card can appear when a misconception was seen twice
  while (await p.locator('.bn-card button:has-text("Got it")').count()) await p.click('.bn-card button:has-text("Got it")');
}

try {
  const { p, ctx, errors } = await open({ width: 1440, height: 900 });
  await step('title offers the apprenticeship', async () => {
    await p.waitForSelector('#title .btn.apprentice');
    await p.screenshot({ path: path.join(OUT, 'lesson-00-title.png') });
    await p.click('#title .btn.apprentice');
    await p.waitForSelector('.bench .bn-card h2');
    assert.equal(await p.evaluate(() => window.__SZ__.mode()), 'lesson');
    assert.match(await p.textContent('.bench .bn-card'), /The problem/);
    await p.screenshot({ path: path.join(OUT, 'lesson-01-intro.png') });
  });
  await step('scope disclosure opens from the labels', async () => {
    await p.click('.bn-label.accel');
    await p.waitForSelector('text=Accelerated time');
    assert.match(await p.textContent('.overlay .card'), /15–45 s/);
    await p.click('.overlay .card button:has-text("Close")');
  });
  await step('step 1: the address, typed in the console', async () => {
    await p.click('.bn-card button:has-text("Start")');
    assert.equal(await stepId(p), 'address');
    await type(p, 'PC-A', 'ip -4 addr');
    await p.waitForSelector('.bn-stamp');
    assert.match(await p.textContent('.bn-out'), /inet 192\.168\.10\.11\/24/);
    await continueThrough(p);
  });
  await step('step 2: prediction, ping, frames animate with ARP broadcast first', async () => {
    assert.equal(await stepId(p), 'local');
    assert.equal(await phase(p), 'predict');
    await p.screenshot({ path: path.join(OUT, 'lesson-02-predict.png') });
    await predictRight(p);
    await p.click('.bn-cmd .chip');
    assert.equal(await p.inputValue('.bn-term input'), 'ping -c 3 192.168.10.12');
    await p.press('.bn-term input', 'Enter');
    await p.waitForSelector('.bn-stamp');
    const first = await p.textContent('.bn-flist .bn-frow');
    assert.match(first, /ARP request \(broadcast\) · PC-A asks for 192\.168\.10\.12/);
    assert.ok(await p.locator('.bn-link.lit.bc').count() >= 2, 'broadcast lights every link on the segment');
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, 'lesson-03-frames.png') });
    // the diagram shows PC-A's live ARP table
    assert.match(await p.textContent('.bn-svg'), /192\.168\.10\.12 → 0a:12 REACHABLE/);
    await continueThrough(p);
  });
  await step('step 3: cache — second ping sends no ARP', async () => {
    assert.equal(await stepId(p), 'cache');
    await predictRight(p);
    await type(p, 'PC-A', 'ip neigh');
    await type(p, 'PC-A', 'ping -c 1 192.168.10.12');
    assert.doesNotMatch(await p.textContent('.bn-flist'), /ARP request \(broadcast\)/);
    assert.equal(await p.locator('.bn-stamp').count(), 0, 'the ARP-failure demo is still to come');
    await type(p, 'PC-A', 'ping -c 2 192.168.10.99');
    assert.match(await p.textContent('.bn-out'), /From 192\.168\.10\.11 icmp_seq=1 Destination Host Unreachable/);
    assert.match(await p.textContent('.bn-flist'), /try 3\/3/);
    await p.waitForSelector('.bn-stamp');
    await continueThrough(p);
  });
  await step('step 4: no route — nothing sent', async () => {
    await predictRight(p);
    await type(p, 'PC-A', 'ping -c 2 192.168.20.10');
    assert.match(await p.textContent('.bn-out'), /ping: connect: Network is unreachable/);
    assert.match(await p.textContent('.bn-frames'), /Nothing was sent|nothing sent/);
    await type(p, 'PC-A', 'ip route get 192.168.20.10');
    await p.waitForSelector('.bn-stamp');
    await continueThrough(p);
  });
  await step('step 5: an off-subnet gateway is refused with a lesson note; the right one works', async () => {
    assert.equal(await stepId(p), 'gateway');
    // predict wrong on purpose: the misconception is recorded and the result explains it
    await p.locator('.bn-card .bn-opt').nth(0).click();
    await type(p, 'PC-A', 'ip route add default via 192.168.20.1');
    assert.match(await p.textContent('.bn-out'), /Error: Nexthop has invalid gateway\./);
    assert.match(await p.textContent('.bn-out'), /A gateway must be on PC-A's own network/);
    await type(p, 'PC-A', 'ip route add default via 192.168.10.1');
    assert.equal(await p.locator('.bn-stamp').count(), 0, 'not done until verified with a ping');
    await type(p, 'PC-A', 'ping -c 3 192.168.20.10');
    await p.waitForSelector('.bn-stamp');
    assert.match(await p.textContent('.bn-card .bn-pred'), /You predicted/);
    assert.match(await p.textContent('.bn-flist'), /ARP request \(broadcast\) · PC-A asks for 192\.168\.10\.1/);
    assert.match(await p.textContent('.bn-flist'), /Echo request · R1 → SRV \(forwarded\)/);
    await p.screenshot({ path: path.join(OUT, 'lesson-04-routed.png') });
    await continueThrough(p);
  });
  await step('step 6: return path — silence, then restored', async () => {
    assert.equal(await stepId(p), 'return');
    await predictRight(p);
    await type(p, 'SRV', 'ip route del default');
    await type(p, 'PC-A', 'ping -c 2 192.168.20.10');
    assert.match(await p.textContent('.bn-out'), /2 packets transmitted, 0 received, 100% packet loss/);
    assert.match(await p.textContent('.bn-flist'), /SRV: reply not sent/);
    await type(p, 'SRV', 'ip route add default via 192.168.20.1');
    await type(p, 'PC-A', 'ping -c 2 192.168.20.10');
    await p.waitForSelector('.bn-stamp');
    await continueThrough(p);
  });
  await step('step 7: practice on Bench B (/26) with concept-first hints', async () => {
    assert.equal(await stepId(p), 'practice');
    await predictRight(p);
    assert.equal(await p.locator('.bn-cmds').count(), 0, 'no command list in supported practice');
    await p.click('.bn-card button:has-text("Hint 1")');
    assert.match(await p.textContent('.bn-card .bn-hint'), /IDEA/);
    assert.match(await p.textContent('.bn-svg'), /10\.20\.30\.64\/26/);
    await type(p, 'PC-B', 'ip route add default via 10.20.30.1');
    assert.match(await p.textContent('.bn-out'), /Nexthop has invalid gateway/);
    assert.match(await p.textContent('.bn-out'), /10\.20\.30\.64 to 10\.20\.30\.127/);
    assert.doesNotMatch(await p.textContent('.bn-out'), /R1's address on that network is/, 'supported practice does not give the answer away');
    await type(p, 'PC-B', 'ip route add default via 10.20.30.126');
    await type(p, 'PC-B', 'ping -c 2 10.20.31.25');
    await p.waitForSelector('.bn-stamp');
    await continueThrough(p);
  });
  await step('step 8: fault — diagnose, repair with an alternative valid fix, verify', async () => {
    assert.equal(await stepId(p), 'fault');
    assert.doesNotMatch(await p.textContent('.bn-svg'), /192\.168\.10\.254/, 'the diagram does not give the fault away');
    await type(p, 'PC-A', 'ping -c 2 192.168.20.10');
    assert.match(await p.textContent('.bn-out'), /From 192\.168\.10\.11 icmp_seq=1 Destination Host Unreachable/);
    await type(p, 'PC-A', 'ip neigh');
    assert.match(await p.textContent('.bn-out'), /192\.168\.10\.254 dev eth0 FAILED/);
    await p.screenshot({ path: path.join(OUT, 'lesson-05-fault.png') });
    // a specific route instead of fixing the default: valid, so accepted
    await type(p, 'PC-A', 'ip route add 192.168.20.0/24 via 192.168.10.1');
    await type(p, 'PC-A', 'ping -c 1 192.168.20.10');
    await p.waitForSelector('.bn-stamp');
    await continueThrough(p);
  });
  await step('step 9: transfer — no hints, fix whichever fault this run drew, explain it', async () => {
    assert.equal(await stepId(p), 'transfer');
    assert.equal(await p.locator('.bn-card button:has-text("Hint")').count(), 0);
    const fault = await p.evaluate(() => window.__SZ__.lesson().st.transferFault);
    if (fault === 'no-return') await type(p, 'SRV', 'ip route add default via 10.20.31.1');
    else await type(p, 'PC-A', 'ip route replace default via 10.20.30.126');
    await type(p, 'PC-A', 'ping -c 1 10.20.31.25');
    await p.waitForSelector('.bn-stamp');
    await continueThrough(p);
    await p.waitForSelector('text=LESSON COMPLETE');
    await p.screenshot({ path: path.join(OUT, 'lesson-06-summary.png') });
    const tele = await p.evaluate(() => window.__SZ__.app.telemetry.session.events.filter(e => /^lesson-/.test(e.type)).map(e => e.type));
    for (const t of ['lesson-predict', 'lesson-cmd', 'lesson-check', 'lesson-explain', 'lesson-hint', 'lesson-finished']) assert.ok(tele.includes(t), `telemetry has ${t}`);
  });
  await step('no page errors on desktop', async () => { assert.deepEqual(errors, []); });
  await ctx.close();

  const m = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await step('phone: lesson tabs, console and frames usable', async () => {
    await m.p.click('#title .btn.apprentice');
    await m.p.waitForSelector('.bn-tabs .bn-tab');
    await m.p.click('.bn-card button:has-text("Start")');
    await type(m.p, 'PC-A', 'ip -4 addr', true);
    await m.p.waitForSelector('.bn-stamp');
    await continueThrough(m.p);
    await predictRight(m.p);
    await type(m.p, 'PC-A', 'ping -c 1 192.168.10.12', true);
    await m.p.click('.bn-tab[data-tab="network"]');
    await m.p.waitForSelector('.bn-flist .bn-frow');
    const overflow = await m.p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, 'no horizontal scroll');
    await m.p.screenshot({ path: path.join(OUT, 'lesson-07-phone-frames.png') });
    await m.p.click('.bn-tab[data-tab="lesson"]');
    await m.p.screenshot({ path: path.join(OUT, 'lesson-08-phone-card.png') });
  });
  await step('no page errors on the phone', async () => { assert.deepEqual(m.errors, []); });
  await m.ctx.close();
} finally {
  console.log(results.join('\n'));
  await browser.close();
  server.close();
}
