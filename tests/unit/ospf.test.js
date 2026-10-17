// OSPFv2 (RFC 2328) and SSH regression tests for the dynamic-routing build (M12, Act II).
// Small lab topologies pin protocol behaviour; the campaign network pins the mission, SSH and failover timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { device, addPort, link, resetDeviceCounter } from '../../src/engine/model.js';
import { parseIp as ip, fmtIp } from '../../src/engine/ipv4.js';
import { lookup } from '../../src/engine/routing.js';
import { ospfNeighbors, neighborState, ospfIfaces } from '../../src/engine/ospf.js';
import { buildDistrict, DEFAULT_PARAMS } from '../../src/content/district.js';
import { MISSIONS, cli, buildMissionStart, httpOk, reaches } from '../../src/content/missions.js';
import { Campaign } from '../../src/game/campaign.js';
import { Coach } from '../../src/game/coach.js';
import { COACH } from '../../src/content/coach.js';
import { createSession, execute, prompt } from '../../src/cli/index.js';

const text = r => (r.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n');
const M12 = MISSIONS.findIndex(m => m.id === 'M12');

/**
 * Lab network: routers { R1: [['Gi0/0', '10.0.0.1', 24], ...] }, bridges { SEG: 4 } (unmanaged), links [['R1','Gi0/0','SEG','p1'], ...].
 * Returns { eng, run }.
 */
function lab({ routers, bridges = {}, hosts = {}, links }) {
  resetDeviceCounter();
  const D = {};
  const L = {};
  for (const [id, ports] of Object.entries(routers)) {
    const r = device(id, 'router', 'ios', { model: 'ISR4321' });
    for (const [name, addr, len] of ports) addPort(r, name, { ip: { addr: ip(addr), len } });
    addPort(r, 'Con0', { kind: 'console' });
    D[id] = r;
  }
  for (const [id, n] of Object.entries(bridges)) {
    const b = device(id, 'bridge', 'none', { managed: false });
    for (let i = 1; i <= n; i++) addPort(b, `p${i}`);
    D[id] = b;
  }
  for (const [id, [addr, len, gw]] of Object.entries(hosts)) {
    const h = device(id, 'host', 'linux', { ipcfg: { dhcp: false, static: { addr: ip(addr), len, gw: ip(gw), dns: [] } } });
    addPort(h, 'eth0');
    D[id] = h;
  }
  links.forEach(([a, ap, b, bp], i) => { L[`l${i}`] = link(`l${i}`, [a, ap], [b, bp]); });
  // every router port left unlinked gets its own empty LAN switch, so the interface is up/up (a stub network)
  for (const [id, ports] of Object.entries(routers)) {
    for (const [name] of ports) {
      if (links.some(([a, ap, b, bp]) => (a === id && ap === name) || (b === id && bp === name))) continue;
      const sw = device(`LAN-${id}-${name}`, 'bridge', 'none', { managed: false });
      addPort(sw, 'p1');
      D[sw.id] = sw;
      L[`stub-${id}-${name}`] = link(`stub-${id}-${name}`, [id, name], [sw.id, 'p1']);
    }
  }
  const eng = new Engine({ version: 3, params: DEFAULT_PARAMS, t: 0, devices: D, links: L, patch: { cords: [] }, internet: { names: {} }, flows: [] });
  eng.converge();
  return { eng, run: cli(eng) };
}

const ospfOn = (run, dev, rid, ...lines) => run(dev, 'enable', 'configure terminal', 'router ospf 1', `router-id ${rid}`, ...lines, 'end');
const st = (eng, a, b) => neighborState(eng, eng.s.devices[a], b);
const logOf = (run, dev) => text(run(dev, 'show logging'));

test('fresh Ethernet link: neighbours wait out the wait timer (= dead interval), elect DR/BDR, then reach FULL; IOS formats', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(15);
  assert.equal(st(eng, 'R1', 'R2'), '2WAY', 'neighbours see each other but wait for the DR election');
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /State WAITING, Priority 1/);
  assert.match(text(run('R1', 'show ip ospf interface brief')), /^Gi0\/0 {8}1 {5}0 {15}10\.0\.12\.1\/24 {7}1 {5}WAIT {2}0\/1$/m);
  eng.advance(20);
  assert.notEqual(st(eng, 'R1', 'R2'), 'FULL', 'not before the 40 s wait timer');
  eng.advance(12);
  assert.equal(st(eng, 'R1', 'R2'), 'FULL');
  assert.equal(st(eng, 'R2', 'R1'), 'FULL');
  const nb = text(run('R1', 'show ip ospf neighbor'));
  assert.match(nb, /^Neighbor ID {5}Pri {3}State {11}Dead Time {3}Address {9}Interface$/m);
  assert.match(nb, /^2\.2\.2\.2 {11}1 {3}FULL\/DR {9}00:00:[0-4]\d {4}10\.0\.12\.2 {7}GigabitEthernet0\/0$/m, 'higher router ID is DR');
  assert.match(text(run('R2', 'show ip ospf neighbor')), /^1\.1\.1\.1 {11}1 {3}FULL\/BDR /m);
  assert.match(logOf(run, 'R1'), /%OSPF-5-ADJCHG: Process 1, Nbr 2\.2\.2\.2 on GigabitEthernet0\/0 from LOADING to FULL, Loading Done/);
  assert.doesNotMatch(logOf(run, 'R1'), /from INIT to 2WAY/, 'without "log-adjacency-changes detail" only FULL and DOWN are logged');
  const ifo = text(run('R1', 'show ip ospf interface g0/0'));
  assert.match(ifo, /Process ID 1, Router ID 1\.1\.1\.1, Network Type BROADCAST, Cost: 1/);
  assert.match(ifo, /Designated Router \(ID\) 2\.2\.2\.2, Interface address 10\.0\.12\.2/);
  assert.match(ifo, /Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5/);
  assert.match(ifo, /Neighbor Count is 1, Adjacent neighbor count is 1/);
  JSON.parse(JSON.stringify(eng.s));
});

test('log-adjacency-changes detail logs every neighbour state with the IOS reason strings', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'log-adjacency-changes detail', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(50);
  const log = logOf(run, 'R1');
  for (const s of ['from DOWN to INIT, Received Hello', 'from INIT to 2WAY, 2-Way Received', 'from 2WAY to EXSTART, AdjOK?', 'from EXSTART to EXCHANGE, Negotiation Done', 'from EXCHANGE to LOADING, Exchange Done', 'from LOADING to FULL, Loading Done']) assert.ok(log.includes(s), s);
  assert.match(text(run('R1', 'show running-config')), /^ log-adjacency-changes detail$/m);
});

test('point-to-point network type: no election, FULL within a hello interval, "FULL/  -"', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 30]], R2: [['Gi0/0', '10.0.12.2', 30]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  for (const [r, rid] of [['R1', '1.1.1.1'], ['R2', '2.2.2.2']]) {
    run(r, 'enable', 'configure terminal', 'interface g0/0', 'ip ospf network point-to-point', 'exit');
    ospfOn(run, r, rid, 'network 10.0.12.0 0.0.0.3 area 0');
  }
  eng.advance(14);
  assert.equal(st(eng, 'R1', 'R2'), 'FULL');
  assert.match(text(run('R1', 'show ip ospf neighbor')), /^2\.2\.2\.2 {11}0? ?1 {3}FULL\/ {2}- {8}00:00:\d\d/m);
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /Network Type POINT_TO_POINT, Cost: 1[\s\S]*State POINT_TO_POINT/);
  assert.match(text(run('R1', 'show running-config')), /^ ip ospf network point-to-point$/m);
});

test('hello/dead mismatch: no neighbour, debug ip ospf hello names both sides; fixing one end restores FULL within seconds', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
  run('R2', 'enable', 'configure terminal', 'interface g0/0', 'ip ospf hello-interval 5', 'exit');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  assert.match(text(run('R2', 'show ip ospf interface g0/0')), /Hello 5, Dead 20, Wait 20/, 'dead defaults to 4 x hello');
  run('R1', 'debug ip ospf hello');
  eng.advance(60);
  assert.equal(ospfNeighbors(eng, eng.s.devices.R1).length, 0);
  assert.equal(text(run('R1', 'show ip ospf neighbor')).split('\n').length, 2, 'header only');
  const log = logOf(run, 'R1');
  assert.match(log, /OSPF: Mismatched hello parameters from 10\.0\.12\.2/);
  assert.match(log, /OSPF: Dead R 20 C 40, Hello R 5 C 10 {2}Mask R 255\.255\.255\.0 C 255\.255\.255\.0/);
  assert.match(text(run('R1', 'show debugging')), /OSPF hello events debugging is on/);
  assert.match(text(run('R1', 'undebug all')), /All possible debugging has been turned off/);
  run('R2', 'configure terminal', 'interface g0/0', 'no ip ospf hello-interval', 'end');
  eng.advance(16);
  assert.equal(st(eng, 'R1', 'R2'), 'FULL', 'already past the wait timer: FULL within a hello interval plus the exchange');
});

test('area mismatch: no adjacency; the router whose interface is outside area 0 logs ERRRCV (Cisco wording)', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 1');
  eng.advance(60);
  assert.equal(st(eng, 'R1', 'R2'), null);
  assert.match(logOf(run, 'R2'), /%OSPF-4-ERRRCV: Received invalid packet: mismatch area ID, from backbone area must be virtual-link but not found from 10\.0\.12\.1, GigabitEthernet0\/0/);
  assert.doesNotMatch(logOf(run, 'R1'), /ERRRCV/, 'the area-0 side does not log it');
  assert.match(text(run('R2', 'show ip ospf interface brief')), /^Gi0\/0 +1 +1 +10\.0\.12\.2\/24/m);
});

test('subnet mask mismatch on a broadcast link: no adjacency', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 25]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  run('R1', 'debug ip ospf hello');
  eng.advance(60);
  assert.equal(st(eng, 'R1', 'R2'), null);
  assert.match(logOf(run, 'R1'), /Mask R 255\.255\.255\.128 C 255\.255\.255\.0/);
});

test('duplicate router ID: DUP_RTRID_NBR logged, no adjacency; router-id waits for clear ip ospf process ([no]: confirm)', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '9.9.9.9', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '9.9.9.9', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(30);
  assert.equal(ospfNeighbors(eng, eng.s.devices.R1).length, 0);
  assert.match(logOf(run, 'R1'), /%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id 9\.9\.9\.9 from 10\.0\.12\.2 on interface GigabitEthernet0\/0/);
  // no neighbour yet: the new ID applies at once
  run('R2', 'configure terminal', 'router ospf 1', 'router-id 2.2.2.2', 'end');
  eng.advance(50);
  assert.equal(st(eng, 'R1', 'R2'), 'FULL');
  // with a neighbour, IOS asks for a process reset
  const r = run('R2', 'configure terminal', 'router ospf 1', 'router-id 3.3.3.3');
  assert.match(text(r), /% OSPF: Reload or use "clear ip ospf process" command, for this to take effect/);
  run('R2', 'end');
  assert.match(text(run('R2', 'show ip ospf')), /Routing Process "ospf 1" with ID 2\.2\.2\.2/);
  const q = run('R2', 'clear ip ospf process');
  assert.equal(q.prompt, 'Reset ALL OSPF processes? [no]:');
  run('R2', 'no');
  assert.match(text(run('R2', 'show ip ospf')), /with ID 2\.2\.2\.2/, 'answering no keeps the process');
  run('R2', 'clear ip ospf process', 'yes');
  assert.match(text(run('R2', 'show ip ospf')), /with ID 3\.3\.3\.3/);
  assert.match(logOf(run, 'R2'), /Nbr 9\.9\.9\.9 on GigabitEthernet0\/0 from FULL to DOWN, Neighbor Down: Interface down or detached/);
  eng.advance(45); // the restarted interface waits (or hears the DR) before the exchange
  assert.equal(st(eng, 'R1', 'R2'), 'FULL', 'the neighbour re-forms under the new ID');
});

test('passive interfaces send no hellos but are still advertised; passive-interface default + no passive-interface', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24], ['Gi0/1', '192.168.1.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'passive-interface default', 'network 10.0.12.0 0.0.0.255 area 0', 'network 192.168.1.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(60);
  assert.equal(st(eng, 'R2', 'R1'), null, 'no hellos from a passive interface');
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /No Hellos \(Passive interface\)/);
  run('R1', 'configure terminal', 'router ospf 1', 'no passive-interface g0/0', 'end');
  eng.advance(55);
  assert.equal(st(eng, 'R2', 'R1'), 'FULL');
  const rt = text(run('R2', 'show ip route'));
  assert.match(rt, /^O {8}192\.168\.1\.0 \[110\/2\] via 10\.0\.12\.1, 00:00:\d\d, GigabitEthernet0\/0$/m, 'the passive LAN is still advertised');
  const cfg = text(run('R1', 'show running-config'));
  assert.match(cfg, /^router ospf 1\n router-id 1\.1\.1\.1\n passive-interface default\n no passive-interface GigabitEthernet0\/0\n network 10\.0\.12\.0 0\.0\.0\.255 area 0\n network 192\.168\.1\.0 0\.0\.0\.255 area 0\n!$/m);
  assert.match(text(run('R1', 'show ip protocols')), /Passive Interface\(s\):\n {4}GigabitEthernet0\/1/);
});

test('MTU mismatch: the lower-MTU side stays EXSTART, the other EXCHANGE; ip ospf mtu-ignore on the lower side completes the exchange', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  run('R2', 'enable', 'configure terminal', 'interface g0/0', 'ip mtu 1400', 'end');
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(70);
  assert.equal(st(eng, 'R2', 'R1'), 'EXSTART', 'R2 (MTU 1400) rejects DBDs advertising 1500');
  assert.equal(st(eng, 'R1', 'R2'), 'EXCHANGE');
  assert.match(text(run('R2', 'show ip interface g0/0')), /MTU is 1400 bytes/);
  run('R2', 'configure terminal', 'interface g0/0', 'ip ospf mtu-ignore', 'end');
  eng.advance(8);
  assert.equal(st(eng, 'R2', 'R1'), 'FULL');
  assert.equal(st(eng, 'R1', 'R2'), 'FULL');
});

test('DR/BDR election on a shared segment: priority, then router ID; priority 0 never elected; DROTHERs stay 2WAY; non-preemptive', () => {
  const routers = {};
  const links = [];
  for (let i = 1; i <= 4; i++) { routers[`R${i}`] = [['Gi0/0', `10.0.0.${i}`, 24]]; links.push([`R${i}`, 'Gi0/0', 'SEG', `p${i}`]); }
  routers.R5 = [['Gi0/0', '10.0.0.5', 24]];
  links.push(['R5', 'Gi0/0', 'SEG', 'p5']);
  const { eng, run } = lab({ routers, bridges: { SEG: 6 }, links });
  run('R1', 'enable', 'configure terminal', 'interface g0/0', 'ip ospf priority 0', 'end');
  run('R2', 'enable', 'configure terminal', 'interface g0/0', 'ip ospf priority 50', 'end');
  for (let i = 1; i <= 4; i++) ospfOn(run, `R${i}`, `${i}.${i}.${i}.${i}`, 'network 10.0.0.0 0.0.0.255 area 0');
  eng.advance(60);
  const role = (a, b) => ospfNeighbors(eng, eng.s.devices[a]).find(r => r.rid === ip(`${b[1]}.${b[1]}.${b[1]}.${b[1]}`));
  assert.equal(role('R3', 'R2').role, 'DR', 'priority 50 beats higher router IDs');
  assert.equal(role('R3', 'R4').role, 'BDR', 'then the highest router ID');
  assert.equal(role('R3', 'R1').state, '2WAY', 'two DROTHERs stay 2WAY');
  assert.equal(role('R1', 'R3').state, '2WAY');
  assert.equal(role('R1', 'R2').state, 'FULL', 'everyone is FULL with the DR');
  assert.equal(role('R1', 'R4').state, 'FULL', 'and with the BDR');
  assert.match(text(run('R3', 'show ip ospf neighbor')), /^1\.1\.1\.1 {11}0 {3}2WAY\/DROTHER/m);
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /State DROTHER, Priority 0/);
  // a router with a higher priority joining later does not take over (no preemption)
  run('R5', 'enable', 'configure terminal', 'interface g0/0', 'ip ospf priority 200', 'end');
  ospfOn(run, 'R5', '5.5.5.5', 'network 10.0.0.0 0.0.0.255 area 0');
  eng.advance(60);
  assert.equal(role('R3', 'R2').role, 'DR', 'the DR keeps its role');
  assert.equal(role('R5', 'R2').role, 'DR');
  assert.equal(role('R5', 'R2').state, 'FULL');
  // the network LSA lists every router attached to the DR
  const db = text(run('R3', 'show ip ospf database'));
  assert.match(db, /Net Link States \(Area 0\)\n\nLink ID {9}ADV Router {6}Age {9}Seq# {7}Checksum\n10\.0\.0\.2 {8}2\.2\.2\.2 /);
});

test('cost = reference bandwidth / bandwidth (Gi = 1 by default); auto-cost and ip ospf cost change the SPF choice', () => {
  // triangle: R1-R2 direct, and R1-R3-R2
  const { eng, run } = lab({
    routers: { R1: [['Gi0/0', '10.0.12.1', 30], ['Gi0/1', '10.0.13.1', 30]], R2: [['Gi0/0', '10.0.12.2', 30], ['Gi0/1', '10.0.23.2', 30], ['Gi0/2', '192.168.2.1', 24]], R3: [['Gi0/0', '10.0.13.3', 30], ['Gi0/1', '10.0.23.3', 30]] },
    links: [['R1', 'Gi0/0', 'R2', 'Gi0/0'], ['R1', 'Gi0/1', 'R3', 'Gi0/0'], ['R3', 'Gi0/1', 'R2', 'Gi0/1']],
  });
  for (const [r, rid] of [['R1', '1.1.1.1'], ['R2', '2.2.2.2'], ['R3', '3.3.3.3']]) ospfOn(run, r, rid, 'network 0.0.0.0 255.255.255.255 area 0');
  eng.advance(70);
  const via = () => lookup(eng.routes('R1').table, ip('192.168.2.50'));
  assert.equal(fmtIp(via().nh), '10.0.12.2', 'direct path, cost 1 + 1');
  assert.match(text(run('R1', 'show ip route ospf')), /O {8}192\.168\.2\.0 \[110\/2\] via 10\.0\.12\.2/);
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /Cost: 1/);
  run('R1', 'configure terminal', 'interface g0/0', 'ip ospf cost 10', 'end');
  eng.advance(20);
  assert.equal(fmtIp(via().nh), '10.0.13.3', 'cost 10 on the direct link: the two-hop path (1+1+1) wins');
  assert.equal(via().metric, 3);
  const r = run('R1', 'configure terminal', 'interface g0/0', 'no ip ospf cost', 'exit', 'router ospf 1', 'auto-cost reference-bandwidth 10000');
  assert.match(text(r), /% OSPF: Reference bandwidth is changed\.\n {8}Please ensure reference bandwidth is consistent across all routers/);
  run('R1', 'end');
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /Cost: 10/, '10 Gb/s reference / 1 Gb/s = 10');
  assert.match(text(run('R1', 'show ip ospf')), /Reference bandwidth unit is 10000 mbps/);
  run('R1', 'configure terminal', 'interface g0/1', 'bandwidth 100000', 'end');
  assert.match(text(run('R1', 'show ip ospf interface g0/1')), /Cost: 100/, 'bandwidth 100 Mb/s with a 10 Gb/s reference');
  assert.match(text(run('R1', 'show interfaces g0/1')), /BW 100000 Kbit\/sec/);
});

test('network statements: the most specific one wins whatever the order; ip ospf <pid> area on the interface overrides', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24], ['Gi0/1', '10.1.1.1', 24]] }, links: [] });
  const r = ospfOn(run, 'R1', '1.1.1.1', 'network 0.0.0.0 255.255.255.255 area 0', 'network 10.1.1.0 0.0.0.255 area 1');
  void r;
  const brief = text(run('R1', 'show ip ospf interface brief'));
  assert.match(brief, /^Gi0\/1 +1 +1 +10\.1\.1\.1\/24/m);
  assert.match(brief, /^Gi0\/0 +1 +0 +10\.0\.12\.1\/24/m);
  assert.match(logOf(run, 'R1'), /%OSPF-6-AREACHG: 10\.1\.1\.0 255\.255\.255\.0 changed from area 0 to area 1/);
  assert.match(text(run('R1', 'show running-config')), / network 10\.1\.1\.0 0\.0\.0\.255 area 1\n network 0\.0\.0\.0 255\.255\.255\.255 area 0/, 'most specific first');
  run('R1', 'configure terminal', 'interface g0/0', 'ip ospf 1 area 5', 'end');
  assert.match(text(run('R1', 'show ip ospf interface g0/0')), /Area 5\n {2}Attached via Interface Enable/);
  assert.match(text(run('R1', 'show running-config')), /^ ip ospf 1 area 5$/m);
  // the statement is normalised: host bits under the wildcard are cleared
  run('R1', 'configure terminal', 'router ospf 1', 'network 10.1.1.77 0.0.0.255 area 1', 'end');
  assert.equal(eng.s.devices.R1.ospf.nets.filter(n => n.wild === ip('0.0.0.255')).length, 1);
  assert.equal(ospfIfaces(eng, eng.s.devices.R1).length, 2);
});

test('inbound ACL filters OSPF (IP protocol 89): without "permit ospf" the adjacency never forms', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  run('R2', 'enable', 'configure terminal', 'ip access-list extended IN', 'permit tcp any any eq 22', 'exit', 'interface g0/0', 'ip access-group IN in', 'end');
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(60);
  assert.equal(st(eng, 'R2', 'R1'), null);
  run('R2', 'configure terminal', 'ip access-list extended IN', '5 permit ospf any any', 'end');
  assert.match(text(run('R2', 'show running-config')), /^ permit ospf any any$/m, 'named ACLs list no sequence numbers in the running-config');
  eng.advance(20);
  assert.equal(st(eng, 'R2', 'R1'), 'FULL');
  assert.match(text(run('R2', 'show access-lists IN')), /5 permit ospf any any \(\d+ match/);
});

test('broadcast on one end, point-to-point on the other: FULL, but the two-way check keeps the routes out', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 30], ['Gi0/1', '192.168.1.1', 24]], R2: [['Gi0/0', '10.0.12.2', 30]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  run('R1', 'enable', 'configure terminal', 'interface g0/0', 'ip ospf network point-to-point', 'end');
  ospfOn(run, 'R1', '1.1.1.1', 'network 0.0.0.0 255.255.255.255 area 0');
  ospfOn(run, 'R2', '2.2.2.2', 'network 0.0.0.0 255.255.255.255 area 0');
  eng.advance(70);
  assert.equal(st(eng, 'R1', 'R2'), 'FULL');
  assert.equal(st(eng, 'R2', 'R1'), 'FULL');
  assert.equal(lookup(eng.routes('R2').table, ip('192.168.1.10')), null, 'R1\'s LAN is not installed: the LSAs do not describe the link the same way');
  run('R1', 'configure terminal', 'interface g0/0', 'no ip ospf network', 'end');
  eng.advance(70);
  assert.equal(lookup(eng.routes('R2').table, ip('192.168.1.10'))?.type, 'O');
});

test('default-information originate: O*E2 [110/1] at the neighbour; without "always" only while a non-OSPF default exists', () => {
  const { eng, run } = lab({ routers: { R1: [['Gi0/0', '10.0.12.1', 24], ['Gi0/1', '198.51.100.2', 30]], R2: [['Gi0/0', '10.0.12.2', 24]] }, links: [['R1', 'Gi0/0', 'R2', 'Gi0/0']] });
  ospfOn(run, 'R1', '1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0', 'default-information originate');
  ospfOn(run, 'R2', '2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0');
  eng.advance(60);
  assert.equal(lookup(eng.routes('R2').table, ip('8.8.8.8')), null, 'no default route on R1 yet: nothing to originate');
  // a static default whose next hop is on Gi0/1 (no cable: the route is not installed), then one via Gi0/0's subnet
  run('R1', 'configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.12.99', 'end');
  eng.advance(20);
  const rt = text(run('R2', 'show ip route'));
  assert.match(rt, /Gateway of last resort is 10\.0\.12\.1 to network 0\.0\.0\.0/);
  assert.match(rt, /^O\*E2 {2}0\.0\.0\.0\/0 \[110\/1\] via 10\.0\.12\.1, 00:00:\d\d, GigabitEthernet0\/0$/m);
  assert.match(text(run('R2', 'show ip ospf database')), /Type-5 AS External Link States\n\nLink ID {9}ADV Router {6}Age {9}Seq# {7}Checksum Tag\n0\.0\.0\.0 {9}1\.1\.1\.1 /);
  assert.match(text(run('R2', 'show ip route 0.0.0.0')), /Known via "ospf 1", distance 110, metric 1, candidate default path\n {2}Tag 1, type extern 2, forward metric 1/);
  run('R1', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 10.0.12.99', 'end');
  eng.advance(20);
  assert.equal(lookup(eng.routes('R2').table, ip('8.8.8.8')), null, 'conditional origination withdraws with the static');
  run('R1', 'configure terminal', 'router ospf 1', 'default-information originate always', 'end');
  eng.advance(20);
  assert.equal(lookup(eng.routes('R2').table, ip('8.8.8.8'))?.code, 'O*E2');
});

// ------------------------------------------------------------------ the campaign network

function m12Start() { const eng = buildMissionStart(buildDistrict, Engine, M12); return { eng, run: cli(eng) }; }
function m12Solved() { const s = m12Start(); MISSIONS[M12].reference(s.eng); s.eng.advance(10); return s; }

test('M12 start: no neighbour, branch timers 5/20 vs clinic 10/40, a static AD-1 route for the branch LAN', () => {
  const { eng, run } = m12Start();
  assert.equal(ospfNeighbors(eng, eng.s.devices['EDGE-RTR']).length, 0);
  assert.match(text(run('EDGE-RTR', 'enable', 'show ip ospf interface g0/3')), /Hello 10, Dead 40/);
  assert.match(text(run('BRANCH-RTR', 'enable', 'show ip ospf interface g0/0')), /Hello 5, Dead 20/);
  assert.match(text(run('EDGE-RTR', 'show ip route')), /^S {8}10\.43\.10\.0\/24 \[1\/0\] via 10\.42\.10\.254$/m);
  assert.equal(httpOk(eng, 'BRANCH-PC', 'https://clinic.ops.example/health'), false);
  assert.match(text(run('BRANCH-PC', 'curl https://clinic.ops.example/health')), /curl: \(6\) Could not resolve host: clinic\.ops\.example/, 'the first symptom: the clinic DNS server is out of reach, the public one does not know the name');
  assert.match(text(run('BRANCH-PC', 'nslookup clinic.ops.example')), /DNS request timed out/, 'nslookup asks the first DNS server (10.42.10.10)');
  assert.equal(httpOk(eng, 'BRANCH-PC', 'https://portal.example.net/'), true, 'the branch internet works: own PAT, secondary DNS is a public resolver');
  assert.equal(eng.s.changeLog.filter(c => c.actor === 'contractor').length >= 2, true);
});

test('M12: fixing only the timers is not enough (the AD-1 static wins); fixing only the static is not enough (no neighbour)', () => {
  let { eng, run } = m12Start();
  run('BRANCH-RTR', 'enable', 'configure terminal', 'interface g0/0', 'no ip ospf hello-interval', 'end');
  eng.advance(40);
  const m = MISSIONS[M12];
  assert.equal(m.goals[0].check(eng), true, 'adjacency FULL');
  assert.equal(m.goals[2].check(eng), true, 'the branch learned the clinic VLAN');
  assert.equal(m.goals[1].check(eng), false, 'EDGE-RTR still forwards on the static');
  assert.match(text(run('EDGE-RTR', 'enable', 'show ip route 10.43.10.50')), /Known via "static", distance 1, metric 0/);
  assert.match(text(run('EDGE-RTR', 'show ip ospf database')), /Summary Net Link States \(Area 0\)\n\nLink ID[^\n]*\n10\.43\.10\.0 {6}10\.43\.255\.1 /, 'OSPF knows the route');
  assert.match(text(run('BRANCH-RTR', 'ping 10.42.10.20 source g0/2')), /Success rate is 0 percent/, 'from the branch LAN the replies die at EDGE-RTR');
  assert.match(text(run('BRANCH-RTR', 'ping 10.42.10.20')), /Success rate is 100 percent/, 'from the WAN /30 they come back (connected route)');
  ({ eng, run } = m12Start());
  run('EDGE-RTR', 'enable', 'configure terminal', 'no ip route 10.43.10.0 255.255.255.0 10.42.10.254', 'end');
  eng.advance(40);
  assert.equal(m.goals[0].check(eng), false);
  assert.equal(httpOk(eng, 'BRANCH-PC', 'https://clinic.ops.example/health'), false);
});

test('M12 alternative fix: faster timers on both ends and a floating static (AD 250) are accepted; outcome reports the dead interval', () => {
  const { eng, run } = m12Start();
  run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/3', 'ip ospf hello-interval 5', 'exit', 'ip route 10.43.10.0 255.255.255.0 10.42.10.254 250', 'end');
  eng.advance(40);
  const camp = new Campaign(eng, { index: M12, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
  assert.deepEqual(MISSIONS[M12].goals.map(g => g.check(eng)), [true, true, true, true, true]);
  assert.match(text(run('EDGE-RTR', 'show ip route 10.43.10.0')), /Known via "ospf 1", distance 110, metric 2, type inter area/);
  assert.doesNotMatch(text(run('EDGE-RTR', 'show ip route')), /^S {8}10\.43\.10\.0/m, 'the floating static waits behind OSPF');
  camp.markBefore();
  run('DISPATCH-01', 'ping 10.43.10.50');
  run('BRANCH-RTR', 'ping 10.42.10.20 source g0/2');
  const r = camp.evaluate('command');
  assert.equal(r.status, 'won', JSON.stringify(r));
  assert.equal(r.result.outcome.detection, 20);
  assert.match(r.result.outcome.method, /hello 5 s, dead 20 s/);
});

test('M12 is solvable entirely over SSH from the EDGE-RTR console (nested session, exit returns)', () => {
  const eng = buildMissionStart(buildDistrict, Engine, M12);
  const sess = createSession(eng, 'EDGE-RTR');
  const ex = line => execute(eng, sess, line);
  ex('enable');
  assert.match(text(ex('show ip ospf neighbor')), /^Neighbor ID/m);
  const s1 = ex('ssh -l admin 172.16.42.2');
  assert.equal(s1.prompt, 'Password:');
  assert.equal(s1.secret, true);
  assert.equal(ex('notthepassword').prompt, 'Password:', 'a wrong password asks again');
  assert.equal(ex('nightshift').prompt, 'BRANCH-RTR#', 'admin is privilege 15: straight to privileged EXEC');
  assert.equal(eng.s.events.at(-1).line, '********', 'the password is not logged');
  for (const l of ['configure terminal', 'interface g0/0', 'no ip ospf hello-interval', 'end']) ex(l);
  assert.match(eng.s.devices['BRANCH-RTR'].ports['Gi0/0'].ospf ? JSON.stringify(eng.s.devices['BRANCH-RTR'].ports['Gi0/0'].ospf) : '{}', /^\{\}$/);
  eng.advance(25);
  assert.match(text(ex('show ip ospf neighbor')), /^10\.42\.255\.1 {7}1 {3}FULL\/(BDR|DR) /m, 'the command ran on BRANCH-RTR');
  const bye = ex('exit');
  assert.match(text(bye), /\[Connection to 172\.16\.42\.2 closed by foreign host\]/);
  assert.equal(bye.prompt, 'EDGE-RTR#');
  for (const l of ['configure terminal', 'no ip route 10.43.10.0 255.255.255.0 10.42.10.254', 'end']) ex(l);
  eng.advance(15);
  assert.deepEqual(MISSIONS[M12].goals.map(g => g.check(eng)), [true, true, true, true, true]);
  assert.equal(prompt(eng, sess), 'EDGE-RTR#');
  JSON.parse(JSON.stringify(sess));
});

test('SSH clients: IOS and OpenSSH wording for timeout, refusal by access-class and missing server; names; logins to Ubuntu and Windows', () => {
  let { eng, run } = m12Start();
  const t = run('DISPATCH-01', 'ssh admin@172.16.42.2');
  assert.match(text(t), /^ssh: connect to host 172\.16\.42\.2 port 22: Connection timed out$/m, 'no route back from the branch yet');
  assert.match(text(run('EDGE-RTR', 'enable', 'ssh -l admin 10.43.10.1')), /^% Connection timed out; remote host not responding$/m, 'EDGE-RTR follows the stale static');
  ({ eng, run } = m12Solved());
  // internet source: PAT makes it 198.51.100.2, which VTY-MGMT does not permit
  assert.match(text(run('DISPATCH-01', 'ssh admin@198.51.100.10')), /^ssh: connect to host 198\.51\.100\.10 port 22: Connection refused$/m);
  assert.match(text(run('EDGE-RTR', 'enable', 'ssh -l admin 203.0.113.20')), /^% Connection refused by remote host$/m, 'no SSH server there: TCP reset');
  // Ubuntu client to IOS: keyboard-interactive prompt with (user@host)
  const c = run('CORE-SRV', 'ssh admin@10.43.10.1');
  assert.equal(c.prompt, '(admin@10.43.10.1) Password:');
  assert.equal(run('CORE-SRV', 'nightshift').prompt, 'BRANCH-RTR#');
  const out = run('CORE-SRV', 'exit');
  assert.match(text(out), /Connection to 10\.43\.10\.1 closed by remote host\.\nConnection to 10\.43\.10\.1 closed\./);
  assert.equal(out.prompt, 'root@core-srv:~#');
  // Windows client to Ubuntu: password authentication prompt, user shell, logout
  assert.equal(run('DISPATCH-01', 'ssh admin@10.42.10.20').prompt, "admin@10.42.10.20's password:");
  assert.match(text(run('DISPATCH-01', 'wrong')), /Permission denied, please try again\./);
  assert.equal(run('DISPATCH-01', 'nightshift').prompt, 'admin@clinic-app:~$');
  assert.equal(text(run('DISPATCH-01', 'whoami')), 'admin');
  assert.match(text(run('DISPATCH-01', 'exit')), /^logout\nConnection to 10\.42\.10\.20 closed\.$/m);
  // to Windows OpenSSH Server: cmd.exe prompt with user@HOST
  run('DISPATCH-01', 'ssh admin@10.43.10.50');
  assert.equal(run('DISPATCH-01', 'nightshift').prompt, 'admin@BRANCH-PC C:\\Users\\admin>');
  assert.match(text(run('DISPATCH-01', 'curl https://clinic.ops.example/health')), /"state":"healthy"/);
  assert.equal(eng.s.events.filter(e => e.type === 'http').at(-1).host, 'BRANCH-PC', 'the command ran on the branch PC');
  assert.match(text(run('DISPATCH-01', 'exit')), /^Connection to 10\.43\.10\.50 closed\.$/m);
  // a Windows PC without OpenSSH Server: reset
  assert.match(text(run('CORE-SRV', 'ssh admin@10.42.10.100')), /Connection refused|Connection timed out/);
  // three wrong passwords end the attempt
  run('EDGE-RTR', 'ssh -l admin 172.16.42.2');
  run('EDGE-RTR', 'a');
  run('EDGE-RTR', 'b');
  const fail = run('EDGE-RTR', 'c');
  assert.match(text(fail), /% Authentication failed\.\n\n\[Connection to 172\.16\.42\.2 closed by foreign host\]/);
  assert.equal(fail.prompt, 'EDGE-RTR#');
  assert.match(text(run('DISPATCH-01', 'ssh nosuchhost.ops.example')), /^ssh: Could not resolve hostname nosuchhost\.ops\.example: No such host is known\.$/m);
  assert.match(text(run('DISPATCH-01', 'ssh')), /^usage: ssh /m);
});

test('in-band management: a change that breaks the path drops the SSH session that made it', () => {
  const { eng, run } = m12Solved();
  run('DISPATCH-01', 'ssh admin@10.43.10.1', 'nightshift');
  run('DISPATCH-01', 'configure terminal', 'router ospf 1', 'passive-interface g0/0', 'end');
  eng.advance(10); // the routes learned from the lost neighbour go with the next SPF run (5 s)
  const r = run('DISPATCH-01', 'show ip ospf neighbor');
  assert.match(text(r), /client_loop: send disconnect: Broken pipe/);
  assert.equal(r.prompt, 'C:\\Users\\operator>', 'back on the local console');
  assert.equal(eng.s.devices['BRANCH-RTR'].ospf.passive.includes('Gi0/0'), true, 'the change itself was made');
  // the console path (EDGE-RTR, same /30) still works
  run('EDGE-RTR', 'enable', 'ssh -l admin 172.16.42.2', 'nightshift', 'configure terminal', 'router ospf 1', 'no passive-interface g0/0', 'end');
  eng.advance(60);
  assert.equal(st(eng, 'EDGE-RTR', 'BRANCH-RTR'), 'FULL');
});

test('carrier tail cut: the branch drops the neighbour at once, EDGE-RTR only after its 40 s dead timer (then SPF withdraws the route)', () => {
  const { eng, run } = m12Solved();
  assert.equal(st(eng, 'EDGE-RTR', 'BRANCH-RTR'), 'FULL');
  const route = () => lookup(eng.routes('EDGE-RTR').table, ip('10.43.10.50'));
  // last hello EDGE-RTR received: dead time remaining tells when it will give up
  const left = ospfNeighbors(eng, eng.s.devices['EDGE-RTR'])[0].dead;
  eng.s.links['carrier-b'].cut = true;
  eng.mutated('carrier: tail to the branch cut', 'incident');
  assert.equal(st(eng, 'BRANCH-RTR', 'EDGE-RTR'), null, 'the branch port went down: neighbour gone at once');
  assert.match(text(run('BRANCH-RTR', 'enable', 'show logging')), /Nbr 10\.42\.255\.1 on GigabitEthernet0\/0 from FULL to DOWN, Neighbor Down: Interface down or detached/);
  assert.equal(eng.portUp('EDGE-RTR', 'Gi0/3'), true, 'the clinic side still has link to the carrier NTE');
  eng.advance(Math.max(1, Math.floor(left) - 2));
  assert.equal(st(eng, 'EDGE-RTR', 'BRANCH-RTR'), 'FULL', 'EDGE-RTR keeps the neighbour until the dead timer');
  assert.equal(route()?.type, 'O', 'and keeps routing into the dead circuit');
  assert.equal(reaches(eng, 'DISPATCH-01', ip('10.43.10.50'), 'tcp', 445), false);
  eng.advance(4);
  assert.equal(st(eng, 'EDGE-RTR', 'BRANCH-RTR'), null);
  assert.match(text(run('EDGE-RTR', 'enable', 'show logging')), /Nbr 10\.43\.255\.1 on GigabitEthernet0\/3 from FULL to DOWN, Neighbor Down: Dead timer expired/);
  eng.advance(6);
  assert.notEqual(route()?.type, 'O', 'SPF (5 s after the change) withdraws the route');
  // carrier restores the tail: the adjacency comes back by itself
  eng.s.links['carrier-b'].cut = false;
  eng.mutated('carrier: tail restored', 'incident');
  eng.advance(70);
  assert.equal(st(eng, 'EDGE-RTR', 'BRANCH-RTR'), 'FULL');
  assert.equal(httpOk(eng, 'BRANCH-PC', 'https://clinic.ops.example/health'), true);
});

test('M12 solved: O IA at the clinic, O at the branch, ABR summaries, show ip protocols / show ip ospf / route entry formats', () => {
  const { run } = m12Solved();
  run('EDGE-RTR', 'enable');
  run('BRANCH-RTR', 'enable');
  assert.match(text(run('EDGE-RTR', 'show ip route')), /^O IA {5}10\.43\.10\.0\/24 \[110\/2\] via 172\.16\.42\.2, 00:00:\d\d, GigabitEthernet0\/3$/m);
  assert.match(text(run('BRANCH-RTR', 'show ip route ospf')), /^O {8}10\.42\.10\.0\/24 \[110\/2\] via 172\.16\.42\.1, 00:00:\d\d, GigabitEthernet0\/0$/m);
  assert.match(text(run('EDGE-RTR', 'show ip route 10.43.10.50')), /^Routing entry for 10\.43\.10\.0\/24\n {2}Known via "ospf 1", distance 110, metric 2, type inter area\n {2}Last update from 172\.16\.42\.2 on GigabitEthernet0\/3, 00:00:\d\d ago\n {2}Routing Descriptor Blocks:\n {2}\* 172\.16\.42\.2, from 10\.43\.255\.1, 00:00:\d\d ago, via GigabitEthernet0\/3\n {6}Route metric is 2, traffic share count is 1$/m);
  const proto = text(run('EDGE-RTR', 'show ip protocols'));
  assert.match(proto, /^Routing Protocol is "ospf 1"$/m);
  assert.match(proto, /Routing for Networks:\n {4}172\.16\.42\.0 0\.0\.0\.3 area 0\n {4}10\.42\.10\.0 0\.0\.0\.255 area 0/);
  assert.match(proto, /Routing Information Sources:\n {4}Gateway {9}Distance {6}Last Update\n {4}10\.43\.255\.1 {10}110 {6}00:00:\d\d/);
  assert.match(text(run('BRANCH-RTR', 'show ip protocols')), /It is an area border router/);
  const sh = text(run('BRANCH-RTR', 'show ip ospf'));
  assert.match(sh, /^ Routing Process "ospf 1" with ID 10\.43\.255\.1$/m);
  assert.match(sh, /^ It is an area border router$/m);
  assert.match(sh, /^ Number of areas in this router is 2\. 2 normal 0 stub 0 nssa$/m);
  assert.match(sh, /^ {4}Area BACKBONE\(0\)$/m);
  assert.match(sh, /^ {4}Area 1$/m);
  const db = text(run('BRANCH-RTR', 'show ip ospf database'));
  assert.match(db, /^ {12}OSPF Router with ID \(10\.43\.255\.1\) \(Process ID 1\)$/m);
  assert.match(db, /^ {16}Router Link States \(Area 1\)$/m);
  assert.match(db, /^ {16}Summary Net Link States \(Area 1\)\n\nLink ID[^\n]*\n10\.42\.10\.0 {6}10\.43\.255\.1 {5}\d+ +0x8000000\d 0x00[0-9A-F]{4}$/m);
  assert.match(text(run('EDGE-RTR', 'show running-config')), /^interface GigabitEthernet0\/3\n description PRIVATE WAN to BRANCH-RTR \(EVC MEF-42-0043\)\n ip address 172\.16\.42\.1 255\.255\.255\.252\n no ip proxy-arp\n duplex auto\n speed auto$/m);
  assert.match(text(run('BRANCH-RTR', 'show running-config')), /^line vty 0 4\n access-class VTY-MGMT in\n login local\n transport input ssh$/m);
});

test('OSPF state is plain JSON and deterministic: two identical runs give identical states', () => {
  const a = m12Solved();
  const b = m12Solved();
  a.eng.advance(200);
  b.eng.advance(200);
  assert.equal(JSON.stringify(a.eng.s.ospf), JSON.stringify(b.eng.s.ospf));
  const clone = new Engine(JSON.parse(JSON.stringify(a.eng.s)));
  clone.advance(100);
  assert.equal(neighborState(clone, clone.s.devices['EDGE-RTR'], 'BRANCH-RTR'), 'FULL', 'a saved and reloaded game keeps its adjacency');
});

// ------------------------------------------------------------------ coach

test('coach M12: the reference path over SSH ticks every step in order, up to verification', () => {
  const eng = buildMissionStart(buildDistrict, Engine, M12);
  const camp = new Campaign(eng, { index: M12, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
  const said = [];
  const app = { eng, campaign: camp, mode: 'campaign', settings: { coach: true }, progress: {}, touch: false, saveProgress() {}, telemetry: { log() {} }, sound: { ok() {} }, hud: { say: (t, who) => said.push({ who, t }), coachPulse() {} } };
  const coach = new Coach(app);
  coach.reset(MISSIONS[M12]);
  const seen = [];
  const orig = coach.celebrate.bind(coach);
  coach.celebrate = s => { seen.push(s.id); orig(s); };
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
  coach.noteOpen('EDGE-RTR');
  run('EDGE-RTR', 'enable', 'show ip ospf neighbor', 'show ip ospf interface g0/3', 'ssh -l admin 172.16.42.2', 'nightshift', 'show ip ospf interface g0/0');
  const bad = run('EDGE-RTR', 'configure terminal', 'interface g0/0', 'no ip ospf hello-intervall');
  assert.ok(bad.tips.some(t => /The \^ marks/.test(t.text)), 'a typo on the remote router is coached in the EDGE-RTR console');
  run('EDGE-RTR', 'no ip ospf hello-interval', 'end');
  for (let k = 0; k < 30; k++) { eng.advance(1); coach.update(); }
  run('EDGE-RTR', 'show ip ospf neighbor', 'exit', 'show ip route 10.43.10.50', 'configure terminal', 'no ip route 10.43.10.0 255.255.255.0 10.42.10.254', 'end', 'show ip route ospf');
  assert.equal(coach.current()?.id, 'verify', `stuck at ${coach.current()?.id} (ticked ${seen.join(',')})`);
  assert.deepEqual(seen, COACH.M12.slice(0, -1).map(s => s.id), 'every step ticked in order');
  assert.ok(said.some(s => /administrative distance wins/.test(s.t)), 'the AD lesson is explained');
  assert.ok(said.some(s => /four hellos in a row/.test(s.t)), 'the dead-interval lesson is explained');
});
