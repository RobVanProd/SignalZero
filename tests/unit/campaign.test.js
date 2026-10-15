import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { buildDistrict, patchConnect, patchDisconnect, dhcpdConf, zoneFile } from '../../src/content/district.js';
import { MISSIONS, cli, buildMissionStart, httpOk } from '../../src/content/missions.js';
import { Campaign } from '../../src/game/campaign.js';
import { saveFile } from '../../src/cli/index.js';

// Verification steps a careful player would run after fixing each mission.
const VERIFY = {
  M01: run => run('ACCESS-SW', 'enable', 'show interfaces status'),
  M02: run => run('DISPATCH-01', 'ipconfig /all'),
  M03: run => run('DISPATCH-01', 'curl https://clinic.ops.example/health'),
  M04: run => run('DISPATCH-01', 'curl https://backup.example.net/health'),
  M05: run => { run('GUEST-KIOSK', 'curl https://clinic.ops.example/health'); run('GUEST-KIOSK', 'curl https://portal.example.net/'); },
  M06: run => run('NURSE-STATION', 'curl https://clinic.ops.example/health'),
  M07: run => run('STAFF-LAPTOP', 'curl https://clinic.ops.example/health'),
  M08: run => run('CORE-SRV', 'dhcp-lease-list'),
  M09: run => run('DISPATCH-01', 'pathping backup.example.net'),
  M10: run => { run('GUEST-KIOSK', 'ipconfig /renew'); run('GUEST-KIOSK', 'curl https://portal.example.net/'); },
};

function fresh() {
  const eng = new Engine(buildDistrict());
  eng.converge();
  return eng;
}

test('full campaign: each mission starts broken, needs verification, and is won by the reference fix', () => {
  const eng = fresh();
  eng.s.flows = [];
  const camp = new Campaign(eng);
  const run = cli(eng);
  camp.begin(0);
  // flows exist for the HUD from the start
  for (let i = 0; i < MISSIONS.length; i++) {
    const m = MISSIONS[i];
    const pre = camp.evaluate();
    assert.equal(pre.status, 'open', `${m.id} should start unsolved`);
    m.reference(eng);
    camp.markBefore();
    const mid = camp.evaluate('action');
    assert.equal(mid.status, 'verify', `${m.id} must not complete before the player verifies (got ${mid.status}: ${JSON.stringify(mid.goals)} ${JSON.stringify(mid.constraints)})`);
    camp.markBefore();
    VERIFY[m.id](run);
    let r = camp.evaluate('command');
    if (m.aftershock) {
      assert.equal(r.status, 'cleared', `${m.id} should arm its aftershock (got ${r.status} ${JSON.stringify(r.evidence)})`);
      for (let k = 0; k < 400 && r.status !== 'won'; k++) {
        eng.advance(1);
        r = camp.tick() || r;
      }
    }
    assert.equal(r.status, 'won', `${m.id} should be won (got ${r.status}: ${JSON.stringify(r.goals)} ${JSON.stringify(r.evidence)})`);
    if (i + 1 < MISSIONS.length) camp.next();
  }
  assert.equal(camp.st.results.length, MISSIONS.length);
  const m06 = camp.st.results.find(x => x.id === 'M06');
  assert.ok(m06.outcome.outage <= 3, `RSTP reference should converge fast, outage=${m06.outcome.outage}`);
  const m10 = camp.st.results.find(x => x.id === 'M10');
  assert.equal(m10.outcome.outage, 0, 'DHCP snooping should prevent the second rogue episode');
});

test('canonical mission starts are consistent for replay', () => {
  for (let i = 0; i < MISSIONS.length; i++) {
    const eng = buildMissionStart(buildDistrict, Engine, i);
    const camp = new Campaign(eng, { index: i, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
    assert.equal(camp.evaluate().status, 'open', `${MISSIONS[i].id} replay start should be unsolved`);
  }
});

test('M03: ping success is not proof; zone edit needs rndc reload; client cache needs flush', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 2);
  const run = cli(eng);
  const ping = run('DISPATCH-01', 'ping clinic.ops.example');
  assert.ok(ping.lines.some(l => typeof l === 'string' && l.includes('Reply from 10.42.10.99')), 'ping reaches the stale host');
  saveFile(eng, 'CORE-SRV', '/etc/bind/db.ops.example', zoneFile(eng.s.params, '10.42.10.20', 2026101402));
  assert.equal(MISSIONS[2].goals[0].check(eng), false, 'zone file edit without reload changes nothing');
  run('CORE-SRV', 'rndc reload');
  assert.equal(MISSIONS[2].goals[0].check(eng), true);
  // Dispatch app cached the stale answer: curl still hits the old server until flush or TTL expiry.
  eng.s.devices['DISPATCH-01'].dnsCache['clinic.ops.example'] = { addr: (10 << 24 | 42 << 16 | 10 << 8 | 99) >>> 0, expires: eng.s.t + 250, ttl: 300 };
  const stale = run('DISPATCH-01', 'curl https://clinic.ops.example/health');
  assert.ok(stale.lines.join('\n').includes('decommissioned'));
  run('DISPATCH-01', 'ipconfig /flushdns');
  const good = run('DISPATCH-01', 'curl https://clinic.ops.example/health');
  assert.ok(good.lines.join('\n').includes('healthy'));
});

test('M04: a next hop outside the connected subnet is accepted but not installed', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 3);
  const run = cli(eng);
  const r = run('EDGE-RTR', 'enable', 'show ip route');
  assert.ok(r.lines.includes('Gateway of last resort is not set'));
  const t = run('DISPATCH-01', 'tracert 203.0.113.20');
  assert.ok(t.lines.some(l => typeof l === 'string' && l.includes('Destination net unreachable')));
});

test('M05: VLAN alone, ACL alone, ACL without DNS and ACL without permit-any all fail', () => {
  const p = '10.42';
  // VLAN only
  let eng = buildMissionStart(buildDistrict, Engine, 4);
  let run = cli(eng);
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/6', 'switchport access vlan 30', 'end');
  run('GUEST-KIOSK', 'ipconfig /renew');
  assert.equal(MISSIONS[4].goals[0].check(eng), true, 'kiosk is now in the guest subnet');
  assert.equal(MISSIONS[4].goals[1].check(eng), false, 'but the router still forwards guest -> clinic');
  // ACL without the DNS permit
  run('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended GUEST-IN', `deny ip ${p}.30.0 0.0.0.255 ${p}.0.0 0.0.255.255`, 'permit ip any any', 'exit', 'interface g0/1.30', 'ip access-group GUEST-IN in', 'end');
  assert.equal(MISSIONS[4].goals[1].check(eng), true, 'clinic blocked');
  assert.equal(MISSIONS[4].goals[3].check(eng), false, 'portal by name fails: guests lost DNS');
  // Insert the DNS permit before the deny using a sequence number
  run('EDGE-RTR', 'configure terminal', 'ip access-list extended GUEST-IN', `5 permit udp ${p}.30.0 0.0.0.255 host ${p}.10.10 eq domain`, 'end');
  assert.equal(MISSIONS[4].goals[3].check(eng), true, 'portal works once DNS is permitted');
  // remove permit any -> implicit deny kills internet
  run('EDGE-RTR', 'configure terminal', 'ip access-list extended GUEST-IN', 'no 20', 'end');
  assert.equal(MISSIONS[4].goals[3].check(eng), false, 'implicit deny blocks the internet');

  // ACL alone (no VLAN move): the guest is still on the clinic subnet
  eng = buildMissionStart(buildDistrict, Engine, 4);
  run = cli(eng);
  run('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended GUEST-IN', `permit udp ${p}.30.0 0.0.0.255 host ${p}.10.10 eq domain`, `deny ip ${p}.30.0 0.0.0.255 ${p}.0.0 0.0.255.255`, 'permit ip any any', 'exit', 'interface g0/1.30', 'ip access-group GUEST-IN in', 'end');
  assert.equal(MISSIONS[4].goals[1].check(eng), false, 'same-subnet traffic never crosses the ACL');
});

test('M06: three interventions, three different aftershock outcomes', () => {
  const outcomes = {};
  for (const variant of ['rapid', 'pvst', 'shut']) {
    const eng = buildMissionStart(buildDistrict, Engine, 5);
    const camp = new Campaign(eng, { index: 5, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
    const run = cli(eng);
    assert.ok(eng.storms().size > 0, 'storm present at start');
    const log = run('ACCESS-SW', 'enable', 'show logging');
    assert.ok(log.lines.some(l => /MACFLAP/.test(l)), 'MAC flapping evidence');
    if (variant === 'shut') run('ACCESS-SW', 'configure terminal', 'interface g0/24', 'shutdown', 'end');
    else for (const sw of ['ACCESS-SW', 'DIST-SW-B']) run(sw, 'enable', 'configure terminal', ...(variant === 'rapid' ? ['spanning-tree mode rapid-pvst'] : []), 'spanning-tree vlan 1-4094', 'end');
    eng.advance(variant === 'pvst' ? 31 : 3);
    assert.equal(eng.storms().size, 0, `${variant}: storm stopped`);
    camp.markBefore();
    run('NURSE-STATION', 'curl https://clinic.ops.example/health');
    let r = camp.evaluate('command');
    assert.equal(r.status, 'cleared', `${variant}: ${JSON.stringify(r)}`);
    for (let k = 0; k < 200 && r.status !== 'won'; k++) {
      eng.advance(1);
      r = camp.tick() || r;
      if (variant === 'shut' && camp.st.phase === 'after' && eng.s.t - camp.st.cutAt > 90) {
        run('ACCESS-SW', 'configure terminal', 'interface g0/24', 'no shutdown', 'end');
        r = camp.evaluate('action');
      }
    }
    assert.equal(r.status, 'won', variant);
    outcomes[variant] = r.result.outcome.outage;
  }
  assert.ok(outcomes.rapid <= 3, `rapid ${outcomes.rapid}`);
  assert.ok(outcomes.pvst >= 28 && outcomes.pvst <= 40, `pvst ${outcomes.pvst}`);
  assert.ok(outcomes.shut >= 90, `shut ${outcomes.shut}`);
});

test('M07: relay on the wrong subinterface does not help', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 6);
  const run = cli(eng);
  run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.41', 'ip helper-address 10.42.10.10', 'end');
  run('STAFF-LAPTOP', 'ipconfig /renew');
  assert.equal(MISSIONS[6].goals[0].check(eng), false);
  const j = run('CORE-SRV', 'journalctl -u isc-dhcp-server');
  assert.ok(!j.lines.some(l => /via 10\.42\.20\.1/.test(l)));
});

test('M08: overlap is refused by IOS; scope without gateway change fails', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 7);
  const run = cli(eng);
  assert.ok(eng.s.devices.CAMERAS.leases.length < 50 && eng.s.devices.CAMERAS.leases.length > 0, `partial leases (${eng.s.devices.CAMERAS.leases.length})`);
  const j = run('CORE-SRV', 'journalctl -u isc-dhcp-server | grep -i free');
  assert.ok(j.lines.some(l => /no free leases/.test(l)), 'journal shows pool exhaustion');
  const r = run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.40', 'ip address 10.42.40.1 255.255.255.128');
  assert.ok(r.lines.some(l => /overlaps with GigabitEthernet0\/1\.41/.test(l)), 'IOS rejects overlap');
  saveFile(eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', dhcpdConf(eng.s.params, { camNet: '10.42.40.128', camMask: '255.255.255.192', camRange: ['10.42.40.140', '10.42.40.190'], camGw: '10.42.40.129' }));
  run('CORE-SRV', 'systemctl restart isc-dhcp-server');
  run('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/4', 'shutdown', 'no shutdown', 'end');
  assert.equal(MISSIONS[7].goals[0].check(eng), false, 'router still on the old /27');
});

test('M09: hard-coding both ends identically is also a valid fix (at 100 Mb/s)', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 8);
  const run = cli(eng);
  const before = run('ACCESS-SW', 'enable', 'show interfaces g0/1');
  assert.ok(before.lines.some(l => /Half-duplex, 100Mb\/s/.test(l)), 'switch side fell back to half duplex');
  eng.evaluateFlows();
  assert.ok(eng.s.flowState.voice.metric.mos < 3.6, `voice degraded (MOS ${eng.s.flowState.voice.metric.mos})`);
  run('ACCESS-SW', 'configure terminal', 'interface g0/1', 'speed 100', 'duplex full', 'end');
  assert.equal(MISSIONS[8].goals[0].check(eng), true);
  assert.equal(MISSIONS[8].goals[1].check(eng), true);
});

test('M10: snooping without a trusted uplink starves everyone; shut-port is containment only', () => {
  let eng = buildMissionStart(buildDistrict, Engine, 9);
  let run = cli(eng);
  const ipc = run('GUEST-KIOSK', 'ipconfig /all');
  assert.ok(ipc.lines.some(l => typeof l === 'string' && l.includes('DHCP Server') && l.includes('192.168.8.1')));
  run('ACCESS-SW', 'enable', 'configure terminal', 'ip dhcp snooping', 'ip dhcp snooping vlan 30', 'end');
  const r = run('GUEST-KIOSK', 'ipconfig /release', 'ipconfig /renew');
  assert.ok(r.lines.some(l => typeof l === 'string' && l.includes('unable to contact your DHCP server')), 'legit offers dropped on untrusted uplink');
  const log = run('ACCESS-SW', 'show logging');
  assert.ok(log.lines.some(l => /DHCP_SNOOPING/.test(l)));

  eng = buildMissionStart(buildDistrict, Engine, 9);
  run = cli(eng);
  const camp = new Campaign(eng, { index: 9, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/9', 'shutdown', 'end');
  camp.markBefore();
  run('GUEST-KIOSK', 'ipconfig /release', 'ipconfig /renew', 'curl https://portal.example.net/');
  let st = camp.evaluate('command');
  assert.equal(st.status, 'cleared', JSON.stringify(st));
  for (let k = 0; k < 40; k++) { eng.advance(1); st = camp.tick() || st; }
  assert.equal(camp.st.phase, 'after', 'rogue came back on another jack');
  assert.equal(httpOk(eng, 'GUEST-KIOSK', 'https://portal.example.net/'), false);
});

test('patch panel refuses double-plugging and console ports never link', () => {
  const eng = fresh();
  assert.equal(patchConnect(eng, 'P03', 'P04').ok, true);
  assert.equal(eng.linkStatus('patch:P03-P04').up, false, 'console <-> ethernet has no link');
  assert.equal(patchConnect(eng, 'P04', 'P01').ok, false, 'port in use');
  patchDisconnect(eng, 'P04');
  assert.equal(patchConnect(eng, 'P01', 'P04').ok, true);
  assert.equal(eng.linkStatus('patch:P01-P04').up, true);
});
