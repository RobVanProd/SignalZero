import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { generateChallenge, buildHealthy, healthReport, randomParams, rngFrom, FAULTS, ChallengeRun } from '../../src/content/challenges.js';
import { cli } from '../../src/content/missions.js';

test('healthy builds are healthy across randomised addressing plans', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const eng = buildHealthy(randomParams(rngFrom(seed * 7919)));
    const h = healthReport(eng);
    assert.ok(h.ok, `seed ${seed}: ${JSON.stringify(h.flows.filter(f => !f.ok))}`);
  }
});

test('every fault class breaks something users notice, and its reference repair restores everything', () => {
  const healthy = buildHealthy(randomParams(rngFrom(99)));
  for (const f of FAULTS) {
    const eng = new Engine(healthy.snapshot());
    eng.ensure();
    const ctx = f.inject(eng, rngFrom(5));
    eng.advance(2);
    assert.equal(healthReport(eng).ok, false, `${f.id} should break a flow`);
    f.fix(eng, ctx);
    eng.advance(3);
    const h = healthReport(eng);
    assert.ok(h.ok, `${f.id} repair: ${JSON.stringify(h.flows.filter(x => !x.ok))}`);
  }
});

test('generator: 40 seeds, single and double faults, all verified solvable', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const ch = generateChallenge(seed * 104729, { faults: seed % 3 === 0 ? 2 : 1 });
    assert.ok(ch.failing.length > 0);
    assert.ok(ch.ticket.length > 0);
    // addressing must not follow the campaign convention (VLAN id == third octet)
    for (const role of ['clinic', 'staff', 'guest', 'cams']) assert.notEqual(ch.params.vlans[role], ch.params.octets[role]);
  }
});

test('challenge run: completion needs health plus a verification after the fix', () => {
  const ch = generateChallenge(424242, { faults: 1 });
  const run = new ChallengeRun(ch);
  assert.equal(run.evaluate().status, 'open');
  const f = FAULTS.find(x => x.id === ch.faults[0].id);
  f.fix(ch.eng, ch.faults[0].ctx);
  ch.eng.advance(3);
  const mid = run.evaluate();
  assert.equal(mid.status, 'verify');
  run.markBefore();
  cli(ch.eng)('DISPATCH-01', 'curl https://clinic.ops.example/health');
  const done = run.evaluate('command');
  assert.equal(done.status, 'won');
  assert.equal(done.result.unguided, true);
});
