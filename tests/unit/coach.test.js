import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { buildDistrict, patchConnect, dhcpdConf, zoneFile, net } from '../../src/content/district.js';
import { MISSIONS, cli, buildMissionStart } from '../../src/content/missions.js';
import { Campaign } from '../../src/game/campaign.js';
import { Coach } from '../../src/game/coach.js';
import { iosIs, COACH } from '../../src/content/coach.js';
import { execute, createSession, saveFile } from '../../src/cli/index.js';

test('iosIs accepts IOS abbreviations and interface short names, rejects incomplete forms', () => {
  assert.ok(iosIs('sh int stat', 'show interfaces status'));
  assert.ok(iosIs('en', 'enable'));
  assert.ok(!iosIs('e', 'enable'), 'one letter is ambiguous on IOS');
  assert.ok(!iosIs('show int', 'show interfaces status'));
  assert.ok(iosIs('sh cable-diagnostics tdr int gi0/1', 'show cable-diagnostics tdr interface g0/1'));
  assert.ok(iosIs('show cable-diagnostics tdr interface GigabitEthernet0/1', 'show cable-diagnostics tdr interface g0/1'));
  assert.ok(iosIs('show cable-diagnostics tdr interface g 0/1', 'show cable-diagnostics tdr interface g0/1'));
  assert.ok(!iosIs('show cable-diagnostics tdr g0/1', 'show cable-diagnostics tdr interface g0/1'));
  assert.ok(!iosIs('show cable-diagnostics tdr interface g0/2', 'show cable-diagnostics tdr interface g0/1'));
  assert.ok(iosIs('do sh run | i ip route', 'show running-config'));
});

/** A minimal stand-in for the App: what the coach reads and the feedback it gives. */
function harness(i) {
  const eng = i === 0 ? (() => { const e = new Engine(buildDistrict()); e.converge(); e.s.flows = []; return e; })() : buildMissionStart(buildDistrict, Engine, i);
  const camp = new Campaign(eng, i === 0 ? null : { index: i, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
  if (i === 0) camp.begin(0);
  const said = [];
  const app = {
    eng, campaign: camp, mode: 'campaign', settings: { coach: true }, progress: {}, touch: false,
    saveProgress() {}, telemetry: { log() {} }, sound: { ok() {} },
    hud: { say: (text, who) => said.push({ who, text }), coachPulse() {} },
  };
  const coach = new Coach(app);
  coach.reset(MISSIONS[i]);
  const sessions = {};
  const run = (dev, ...lines) => {
    let r;
    for (const line of lines) {
      sessions[dev] ||= createSession(eng, dev);
      r = execute(eng, sessions[dev], line);
      r.tips = coach.onCommand(dev, line, r);
      coach.update();
    }
    return r;
  };
  const open = id => coach.noteOpen(id);
  return { eng, camp, coach, said, run, open };
}

test('coach M01: every step is reachable with the real commands, in order, with feedback for each', () => {
  const { eng, coach, said, run, open } = harness(0);
  assert.equal(coach.current().id, 'look');
  coach.lookTravel = 2; coach.update();
  coach.walkTravel = 2; coach.update();
  open('map');
  assert.equal(coach.current().id, 'open-sw');
  open('EDGE-RTR');
  assert.ok(said.some(s => /follow the orange marker/.test(s.text)), 'opening the wrong console redirects the player');
  open('ACCESS-SW');
  assert.equal(coach.current().id, 'enable');
  const early = run('ACCESS-SW', 'show cable-diagnostics tdr');
  assert.ok(early.tips.some(t => /user EXEC mode.*Type enable first/.test(t.text)), 'a command typed in user mode is explained');
  run('ACCESS-SW', 'en');
  run('ACCESS-SW', 'sh int stat');
  assert.equal(coach.current().id, 'tdr-run');
  run('ACCESS-SW', 'test cable-diagnostics tdr interface g0/1');
  // the owner's exact stumble: missing "interface"
  const bad = run('ACCESS-SW', 'show cable-diagnostics tdr');
  assert.ok(bad.tips.some(t => /type exactly: show cable-diagnostics tdr interface g0\/1/.test(t.text)), 'incomplete command gets a coaching note');
  const bad2 = run('ACCESS-SW', 'show cable-diagnostics tdr g0/1');
  assert.ok(bad2.tips.some(t => /The \^ marks/.test(t.text)), 'invalid input gets a coaching note');
  assert.equal(coach.current().id, 'tdr-show', 'rejected commands do not tick the step');
  const good = run('ACCESS-SW', 'show cable-diagnostics tdr interface g0/1');
  assert.ok(good.lines.some(l => /Open/.test(l)));
  assert.equal(coach.current().id, 'go-patch');
  assert.ok(said.some(s => /nothing is plugged into the front of the panel/.test(s.text)), 'the TDR result is explained');
  open('PATCH');
  assert.equal(coach.current().id, 'patch');
  patchConnect(eng, 'P01', 'P04');
  coach.update();
  assert.equal(coach.current().id, 'verify');
  assert.equal(said.filter(s => /^COACH · STEP/.test(s.who)).length, coach.steps.length - 1, 'one explanation per completed step');
});

test('coach M01: fixing it directly skips the diagnostic steps instead of getting stuck on them', () => {
  const { eng, coach } = harness(0);
  coach.lookTravel = 2; coach.walkTravel = 2; coach.update();
  patchConnect(eng, 'P01', 'P04');
  coach.update();
  assert.equal(coach.current().id, 'verify');
});

test('coach M02–M04: the reference solution ticks every step up to verification', () => {
  const walk = {
    1: h => {
      h.open('DISPATCH-01'); h.run('DISPATCH-01', 'ipconfig /all');
      h.open('CORE-SRV'); h.run('CORE-SRV', 'systemctl status isc-dhcp-server', 'journalctl -u isc-dhcp-server');
      saveFile(h.eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', dhcpdConf(h.eng.s.params)); h.coach.update();
      h.run('CORE-SRV', 'dhcpd -t -cf /etc/dhcp/dhcpd.conf', 'systemctl start isc-dhcp-server');
      h.open('DISPATCH-01'); h.run('DISPATCH-01', 'ipconfig /renew');
    },
    2: h => {
      h.open('DISPATCH-01'); h.run('DISPATCH-01', 'nslookup clinic.ops.example');
      h.open('map'); h.open('map:ipam');
      saveFile(h.eng, 'CORE-SRV', '/etc/bind/db.ops.example', zoneFile(h.eng.s.params, net(h.eng.s.params, 'clinic', 20), 2026101402)); h.coach.update();
      h.run('CORE-SRV', 'named-checkzone ops.example /etc/bind/db.ops.example', 'rndc reload');
      h.run('DISPATCH-01', 'ipconfig /flushdns');
    },
    3: h => {
      h.open('DISPATCH-01'); h.run('DISPATCH-01', 'tracert backup.example.net', 'tracert 203.0.113.20');
      h.open('EDGE-RTR'); h.run('EDGE-RTR', 'enable', 'show ip route', 'show running-config | include ip route');
      h.run('EDGE-RTR', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 198.51.100.5', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1', 'end');
    },
  };
  for (const i of [1, 2, 3]) {
    const h = harness(i);
    const seen = [];
    const orig = h.coach.celebrate.bind(h.coach);
    h.coach.celebrate = s => { seen.push(s.id); orig(s); };
    walk[i](h);
    const id = MISSIONS[i].id;
    assert.equal(h.coach.current()?.id, 'verify', `${id}: stuck at ${h.coach.current()?.id} (ticked ${seen.join(',')})`);
    assert.deepEqual(seen, COACH[id].slice(0, -1).map(s => s.id), `${id}: every step is ticked in order, none skipped`);
  }
});

test('coach is off in challenges and when the setting is off', () => {
  const h = harness(0);
  h.coach.app.settings.coach = false;
  assert.equal(h.coach.active, false);
  h.coach.app.settings.coach = true;
  h.coach.app.mode = 'challenge';
  assert.equal(h.coach.active, false);
});
