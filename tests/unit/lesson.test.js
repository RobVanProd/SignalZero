// Apprenticeship Lesson 1: the teaching sequence is complete, ordered and honest. Every step can be finished with
// the real commands; no step reports success while the network is not in the required state; any valid repair
// counts; faults appear only after the ideas needed to diagnose them were taught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS, MISCONCEPTIONS } from '../../src/content/lessons.js';
import { LessonRun, TRANSFER_FAULTS } from '../../src/game/lesson.js';
import { buildBench, BENCH_FAULTS, benchReaches } from '../../src/content/bench.js';
import { createSession, execute } from '../../src/cli/index.js';

const L = LESSONS[0];
const at = (run, id) => { const i = L.steps.findIndex(s => s.id === id); run.enter(i); return run; };
const right = run => { if (run.phase === 'predict') run.predict(run.step.predict.options.findIndex(o => o.correct)); };
function finish(run) {
  assert.ok(run.finishTask(), `step ${run.step.id} is done`);
  for (;;) {
    const ph = run.afterResult();
    if (ph === 'check') run.answerCheck(run.step.check.options.findIndex(o => o.correct || o.fault === run.st.transferFault));
    else if (ph === 'explain') run.answerExplain('the gateway was wrong; ip route showed it');
    else break;
  }
  run.next();
}

/** The whole lesson with the commands a learner types. */
function walk(seed, fixes = {}) {
  const run = new LessonRun(L, { seed });
  const say = (dev, line) => run.run(dev, line);
  run.next();
  say('PC-A', 'ip -4 addr'); finish(run);
  right(run); say('PC-A', 'ping -c 3 192.168.10.12'); finish(run);
  right(run); say('PC-A', 'ip neigh'); say('PC-A', 'ping -c 1 192.168.10.12'); say('PC-A', 'ping -c 2 192.168.10.99'); finish(run);
  right(run); say('PC-A', 'ping -c 2 192.168.20.10'); say('PC-A', 'ip route get 192.168.20.10'); finish(run);
  right(run); say('PC-A', 'ip route add default via 192.168.10.1'); say('PC-A', 'ping -c 3 192.168.20.10'); finish(run);
  right(run); say('SRV', 'ip route del default'); say('PC-A', 'ping -c 2 192.168.20.10'); say('SRV', 'ip route add default via 192.168.20.1'); say('PC-A', 'ping -c 2 192.168.20.10'); finish(run);
  right(run); say('PC-B', 'ip route add default via 10.20.30.126'); say('PC-B', 'ping -c 2 10.20.31.25'); finish(run);
  for (const l of fixes.fault || ['ip route replace default via 192.168.10.1']) say('PC-A', l);
  say('PC-A', 'ping -c 1 192.168.20.10'); finish(run);
  if (run.st.transferFault === 'no-return') say('SRV', 'ip route add default via 10.20.31.1'); else say('PC-A', 'ip route replace default via 10.20.30.126');
  say('PC-A', 'ping -c 1 10.20.31.25'); finish(run);
  return run;
}

test('the lesson can be completed with real commands, for both transfer cases', () => {
  const seen = new Set();
  for (const seed of [0, 1, 2, 3]) {
    const run = walk(seed);
    assert.ok(run.finished);
    assert.equal(run.st.completed.length, L.steps.length);
    seen.add(run.st.transferFault);
  }
  assert.deepEqual([...seen].sort(), [...TRANSFER_FAULTS].sort());
});

test('no task step is complete when it starts (nothing is pre-solved)', () => {
  const run = new LessonRun(L, { seed: 0 });
  L.steps.forEach((s, i) => {
    if (s.kind !== 'task') return;
    run.enter(i);
    if (s.id === 'cache' || s.id === 'return') return; // continue from the previous step's bench, checked in the walk
    assert.equal(run.isDone(), false, s.id);
  });
});

test('a fix is not accepted until the learner has verified it, and success is withdrawn if the network breaks again', () => {
  const run = at(new LessonRun(L, { seed: 0 }), 'fault');
  run.run('PC-A', 'ip route replace default via 192.168.10.1');
  assert.ok(benchReaches(run.eng, 'PC-A', 'SRV'), 'the network is fixed');
  assert.equal(run.isDone(), false, 'but nobody has checked it');
  run.run('PC-A', 'ping -c 1 192.168.20.10');
  assert.equal(run.isDone(), true);
  // a later change invalidates the earlier verification and breaks the network
  run.run('PC-A', 'ip route replace default via 192.168.10.254');
  assert.equal(run.isDone(), false);
  assert.equal(run.finishTask(), false, 'no success while broken');
});

test('alternative valid repairs are accepted; a "fix" that only looks plausible is not', () => {
  for (const fix of [['ip route replace default via 192.168.10.1'], ['ip route del default', 'ip route add default via 192.168.10.1'], ['ip route add 192.168.20.0/24 via 192.168.10.1']]) {
    const run = at(new LessonRun(L, { seed: 0 }), 'fault');
    for (const l of fix) run.run('PC-A', l);
    run.run('PC-A', 'ping -c 1 192.168.20.10');
    assert.equal(run.isDone(), true, fix.join(' ; '));
  }
  const bad = at(new LessonRun(L, { seed: 0 }), 'fault');
  bad.run('PC-A', 'ip route replace default via 192.168.10.12'); // PC-B: ARP works, but PC-B does not route
  bad.run('PC-A', 'ping -c 1 192.168.20.10');
  assert.equal(bad.isDone(), false);
});

test('faults come only after the ideas needed to diagnose them were taught', () => {
  const taught = new Set();
  for (const s of L.steps) {
    for (const r of s.requires || []) assert.ok(taught.has(r), `${s.id} requires "${r}" before it is taught`);
    for (const t of s.teaches || []) taught.add(t);
  }
  const faulty = L.steps.filter(s => s.fresh?.fault);
  assert.ok(faulty.length >= 2 && faulty.every(s => s.requires?.length));
  assert.ok(L.steps.findIndex(s => s.fresh?.fault) > L.steps.findIndex(s => s.support === 'supported'), 'practice comes before any fault');
  // guided -> supported -> independent, never backwards
  const order = { guided: 0, supported: 1, independent: 2 };
  const levels = L.steps.filter(s => s.support).map(s => order[s.support]);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
});

test('placement: four right answers skip to troubleshooting; anything less starts the lesson', () => {
  const pass = new LessonRun(L, { seed: 0 });
  const r = pass.placement(L.placement.map(q => q.options.findIndex(o => o.correct)));
  assert.ok(r.passed);
  assert.equal(pass.step.id, 'fault');
  assert.ok(pass.st.skipped.includes('gateway'));
  const fail = new LessonRun(L, { seed: 0 });
  assert.equal(fail.placement(L.placement.map((q, i) => (i === 1 ? 0 : q.options.findIndex(o => o.correct)))).passed, false);
  assert.equal(fail.step.id, 'intro');
});

test('wrong predictions are recorded and a misconception seen twice brings its refresher', () => {
  const run = at(new LessonRun(L, { seed: 0 }), 'offnet');
  run.predict(0); // "PC-A broadcasts an ARP request for the server" -> arp-remote
  assert.equal(run.pendingRemedy(), null);
  run.run('PC-A', 'ping -c 2 192.168.20.10');
  run.run('PC-A', 'ip route get 192.168.20.10');
  finish(run);
  run.predict(0); // gateway step: "the server's MAC" -> arp-remote again
  assert.equal(run.pendingRemedy(), 'arp-remote');
  assert.ok(MISCONCEPTIONS['arp-remote'].body.length);
  run.taught('arp-remote');
  assert.equal(run.pendingRemedy(), null);
});

test('remediation teaches the idea; guided steps name the answer, supported practice does not', () => {
  const g = at(new LessonRun(L, { seed: 0 }), 'gateway');
  right(g);
  const tg = g.run('PC-A', 'ip route add default via 192.168.20.1').tips.map(t => t.text).join(' ');
  assert.match(tg, /must be on PC-A's own network, 192\.168\.10\.0\/24/);
  assert.match(tg, /R1's address on that network is 192\.168\.10\.1/);
  const p = at(new LessonRun(L, { seed: 0 }), 'practice');
  right(p);
  const tp = p.run('PC-B', 'ip route add default via 10.20.30.1').tips.map(t => t.text).join(' ');
  assert.match(tp, /10\.20\.30\.64 to 10\.20\.30\.127/);
  assert.doesNotMatch(tp, /10\.20\.30\.126/);
  // the independent case gives no tips at all
  const t = at(new LessonRun(L, { seed: 0 }), 'transfer');
  assert.deepEqual(t.run('PC-A', 'ip route add default via 10.20.31.1').tips, []);
});

test('the frame view is derived from the same packets the terminal reported', () => {
  const run = at(new LessonRun(L, { seed: 0 }), 'local');
  right(run);
  const r = run.run('PC-A', 'ping -c 1 192.168.10.12');
  const kinds = r.frames.filter(f => !f.note && !f.delayed).map(f => f.kind);
  assert.deepEqual(kinds, ['arp-request', 'arp-reply', 'ip', 'ip']);
  assert.ok(r.frames[0].bcast);
  // no route: the terminal says so and there are no frames
  const off = at(new LessonRun(L, { seed: 0 }), 'offnet');
  right(off);
  const r2 = off.run('PC-A', 'ping -c 1 192.168.20.10');
  assert.match(r2.lines.join('\n'), /Network is unreachable/);
  assert.deepEqual(r2.frames.map(f => f.kind), ['not-sent']);
});

test('bench faults behave as the lab showed (symptoms per fault)', () => {
  const sym = (fault, v, gw) => {
    const eng = buildBench(v, { gw });
    BENCH_FAULTS[fault].apply(eng, v);
    const out = execute(eng, createSession(eng, 'PC-A'), `ping -c 2 ${v === 'A' ? '192.168.20.10' : '10.20.31.25'}`).lines.join('\n');
    return out;
  };
  assert.match(sym('wrong-gateway', 'A', { 'PC-A': '192.168.10.1' }), /From 192\.168\.10\.11 icmp_seq=1 Destination Host Unreachable[\s\S]*pipe 2/);
  assert.match(sym('gateway-is-host', 'P', { 'PC-A': '10.20.30.126' }), /2 packets transmitted, 0 received, 100% packet loss/);
  assert.doesNotMatch(sym('gateway-is-host', 'P', { 'PC-A': '10.20.30.126' }), /Unreachable/);
  assert.match(sym('no-return', 'P', { 'PC-A': '10.20.30.126' }), /0 received, 100% packet loss/);
});

test('random commands on every bench host never throw (lesson consoles fuzz)', () => {
  const pool = ['ip a', 'ip -4 addr', 'ip r', 'ip route get 192.168.20.10', 'ip route get x', 'ip route add default via 192.168.10.1', 'ip route add default via 1.2.3.4', 'ip route add 10.0.0.0/8 via 192.168.10.12',
    'ip route replace default via 192.168.10.254', 'ip route del default', 'ip route del 10.0.0.0/8', 'ip route add default', 'ip route', 'ip neigh', 'ip neigh flush all', 'ip neigh flush dev eth0', 'ip neigh show 192.168.10.1', 'ip -4 neigh',
    'ping -c 2 192.168.10.12', 'ping -c 1 192.168.20.10', 'ping 10.20.31.25', 'ping', 'ipconfig', 'arp -a', 'tcpdump -n -e', 'ip addr add 1.1.1.1/24 dev eth0', 'ip link set eth0 down', 'route -n', 'help', 'ip route add default via 192.168.10.1 dev eth9', '', '   '];
  let n = 0;
  for (const v of ['A', 'P']) {
    const eng = buildBench(v);
    for (const dev of ['PC-A', 'PC-B', 'SRV']) {
      const sess = createSession(eng, dev);
      for (let i = 0; i < 120; i++) {
        const line = pool[(i * 7 + dev.length * 3) % pool.length];
        const r = execute(eng, sess, line);
        assert.ok(Array.isArray(r.lines), line);
        n++;
      }
      eng.advance(13);
    }
    JSON.parse(JSON.stringify(eng.s));
  }
  assert.ok(n >= 700);
});

test('facilitator start: a playtest can open the transfer case with a chosen fault', () => {
  for (const f of TRANSFER_FAULTS) {
    const run = new LessonRun(L, { seed: 0, startAt: 'transfer', transferFault: f });
    assert.equal(run.step.id, 'transfer');
    assert.equal(run.st.transferFault, f);
    assert.equal(run.isDone(), false);
    assert.equal(run.st.facilitated, 'transfer');
  }
});
