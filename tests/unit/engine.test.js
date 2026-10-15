import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { negotiate } from '../../src/engine/link.js';
import { portDefaults } from '../../src/engine/model.js';
import { evalAcl } from '../../src/engine/routing.js';
import { parseIp as ip } from '../../src/engine/ipv4.js';
import { parseDhcpd } from '../../src/engine/parsers/dhcpd.js';
import { parseZone } from '../../src/engine/parsers/zone.js';
import { parseNetplan } from '../../src/engine/parsers/netplan.js';
import { parseAce } from '../../src/cli/ios.js';
import { Grammar } from '../../src/cli/parser.js';
import { buildDistrict, patchConnect } from '../../src/content/district.js';
import { buildMissionStart, cli } from '../../src/content/missions.js';

test('speed/duplex negotiation follows 802.3 parallel detection', () => {
  const auto = portDefaults('a');
  const fixed100full = portDefaults('b', { speed: 100, duplex: 'full' });
  const n1 = negotiate(auto, auto);
  assert.deepEqual([n1.speed, n1.duplexA, n1.duplexB, n1.mismatch], [1000, 'full', 'full', false]);
  const n2 = negotiate(auto, fixed100full);
  assert.deepEqual([n2.speed, n2.duplexA, n2.duplexB, n2.mismatch], [100, 'half', 'full', true]);
  const n3 = negotiate(fixed100full, portDefaults('c', { speed: 100, duplex: 'full' }));
  assert.equal(n3.mismatch, false);
  assert.equal(negotiate(fixed100full, portDefaults('d', { speed: 10, duplex: 'full' })).up, false);
  // speed fixed but duplex auto keeps negotiation on
  const n4 = negotiate(auto, portDefaults('e', { speed: 100 }));
  assert.deepEqual([n4.speed, n4.duplexA, n4.mismatch], [100, 'full', false]);
});

test('ACLs: first match wins, implicit deny, undefined ACL permits', () => {
  const r = { acls: { T: { kind: 'extended', entries: [
    { seq: 10, action: 'permit', proto: 'udp', src: { addr: ip('10.0.30.0'), wild: ip('0.0.0.255') }, dst: { addr: ip('10.0.10.10'), wild: 0 }, dop: { op: 'eq', ports: [53] } },
    { seq: 20, action: 'deny', proto: 'ip', src: { addr: ip('10.0.30.0'), wild: ip('0.0.0.255') }, dst: { addr: ip('10.0.0.0'), wild: ip('0.0.255.255') } },
  ] } } };
  const pkt = (dst, proto, dport) => ({ src: ip('10.0.30.7'), dst: ip(dst), proto, sport: 50000, dport });
  assert.equal(evalAcl(r, 'T', pkt('10.0.10.10', 'udp', 53)).permit, true);
  assert.equal(evalAcl(r, 'T', pkt('10.0.10.10', 'tcp', 53)).permit, false);
  const imp = evalAcl(r, 'T', pkt('8.8.8.8', 'udp', 53));
  assert.equal(imp.permit, false);
  assert.equal(imp.implicit, true);
  assert.equal(evalAcl(r, 'MISSING', pkt('10.0.10.10', 'tcp', 22)).permit, true);
});

test('ACE parser handles host/any/wildcards/ports and reports the bad token', () => {
  const ok = parseAce('extended', 'permit tcp 10.1.0.0 0.0.255.255 host 10.2.2.2 eq www 443'.split(' '));
  assert.deepEqual(ok.ace.dop, { op: 'eq', ports: [80, 443] });
  assert.equal(parseAce('extended', 'permit tcp any hots 1.1.1.1'.split(' ')).errTok, 3);
  assert.equal(parseAce('standard', 'deny 10.0.0.5'.split(' ')).ace.src.wild, 0);
});

test('IOS grammar: unique-prefix abbreviation, ambiguity and incomplete commands', () => {
  const g = new Grammar();
  g.add('exec', 'show interfaces status', 'a');
  g.add('exec', 'show ip interface brief', 'b');
  g.add('exec', 'show ip route', 'c');
  g.add('exec', 'show spanning-tree', 'd');
  g.add('exec', 'show interfaces <IF>', 'e');
  assert.equal(g.match('exec', 'sh ip int br').cmd.handler, 'b');
  assert.equal(g.match('exec', 'sh int g0/1').args.if, 'Gi0/1');
  assert.equal(g.match('exec', 'sh int stat').cmd.handler, 'a');
  assert.equal(g.match('exec', 'sh i').error, 'ambiguous');
  assert.equal(g.match('exec', 'show ip').error, 'incomplete');
  const bad = g.match('exec', 'show ipp route');
  assert.equal(bad.error, 'invalid');
  assert.equal(bad.pos, 5);
});

test('dhcpd.conf parser: real error wording and semantic checks', () => {
  const good = parseDhcpd('subnet 10.1.1.0 netmask 255.255.255.0 {\n range 10.1.1.10 10.1.1.20;\n option routers 10.1.1.1;\n}\n');
  assert.equal(good.ok, true);
  assert.equal(good.cfg.subnets[0].ranges[0][1] - good.cfg.subnets[0].ranges[0][0], 10);
  const semi = parseDhcpd('subnet 10.1.1.0 netmask 255.255.255.0 {\n option routers 10.1.1.1\n}\n', 'x.conf');
  assert.match(semi.errors[0], /x\.conf line 3: semicolon expected\./);
  const range = parseDhcpd('subnet 10.1.1.0 netmask 255.255.255.224 {\n range 10.1.1.10 10.1.1.100;\n}\n');
  assert.match(range.errors[0], /not on net 10\.1\.1\.0\/255\.255\.255\.224!/);
  const bad = parseDhcpd('subnet 10.1.1.5 netmask 255.255.255.0 {\n}\n');
  assert.match(bad.errors[0], /bad subnet number\/mask combination/);
});

test('zone parser: SOA/NS required, bad dotted quad, CNAME conflicts, relative names', () => {
  const base = '$TTL 300\n@ IN SOA ns1 admin ( 1 2 3 4 5 )\n  IN NS ns1\nns1 IN A 10.0.0.1\n';
  const z = parseZone(base + 'www IN CNAME ns1\n', 'ex.test');
  assert.equal(z.ok, true);
  assert.equal(z.records.find(r => r.type === 'CNAME').target, 'ns1.ex.test');
  assert.match(parseZone(base + 'x IN A 10.0.0.999\n', 'ex.test').errors[0], /bad dotted quad/);
  assert.match(parseZone(base + 'ns1 IN CNAME www\n', 'ex.test').errors[0], /CNAME and other data/);
  assert.match(parseZone('$TTL 1\nx IN A 1.2.3.4\n', 'ex.test').errors[0], /no SOA/);
});

test('netplan parser', () => {
  const t = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      addresses: [10.0.0.5/24]\n      routes:\n        - to: default\n          via: 10.0.0.1\n      nameservers:\n        addresses: [10.0.0.53]\n';
  const r = parseNetplan(t, 'f.yaml', 'eth0');
  assert.equal(r.ok, true);
  assert.equal(r.cfg.gw, ip('10.0.0.1'));
  assert.equal(parseNetplan(t.replace('10.0.0.5/24', '10.0.0.5'), 'f.yaml', 'eth0').ok, false);
});

test('STP: root bridge, root/alternate ports, and 802.1D timers', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 5);
  const run = cli(eng);
  for (const sw of ['ACCESS-SW', 'DIST-SW-B']) run(sw, 'enable', 'configure terminal', 'spanning-tree vlan 1-4094', 'end');
  const rec = p => eng.s.stpState['DIST-SW-B'][10][p];
  assert.equal(rec('Gi0/23').role, 'root');
  assert.equal(rec('Gi0/24').role, 'alternate');
  assert.equal(rec('Gi0/24').st, 'blocking');
  assert.equal(rec('Gi0/23').st, 'listening');
  eng.advance(16);
  assert.equal(rec('Gi0/23').st, 'learning');
  eng.advance(15);
  assert.equal(rec('Gi0/23').st, 'forwarding');
  assert.equal(eng.storms().size, 0);
  // lower priority on DIST-SW-B makes it root for VLAN 10
  run('DIST-SW-B', 'configure terminal', 'spanning-tree vlan 10 priority 4096', 'end');
  assert.equal(eng.stpInfo[10].rootOf['ACCESS-SW'], 'DIST-SW-B');
  run('DIST-SW-B', 'configure terminal');
  const p = run('DIST-SW-B', 'spanning-tree vlan 10 priority 5000');
  assert.ok(p.lines.some(l => /increments of 4096/.test(l)));
});

test('TTL and NAT: replies come back through PAT with correct TTL', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 5);
  const r = eng.probe({ from: 'DISPATCH-01', dst: ip('203.0.113.20'), proto: 'icmp', record: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.kind, 'reply');
  assert.equal(r.ttl, 62, 'Linux 64 minus two routers');
  assert.ok(eng.s.natLog.some(n => n.outside === ip('198.51.100.2')));
  // same-subnet ping: no router hop, TTL unchanged
  const l = eng.probe({ from: 'DISPATCH-01', dst: ip('10.42.10.20'), proto: 'icmp' });
  assert.equal(l.ttl, 64);
});

test('removing NAT breaks only the return path (asymmetric failure)', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 5);
  cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.10', 'no ip nat inside', 'end');
  const r = eng.probe({ from: 'DISPATCH-01', dst: ip('203.0.113.20'), proto: 'icmp' });
  assert.equal(r.status, 'timeout');
  assert.equal(r.fwd.outcome, 'delivered', 'the request still arrives');
  assert.equal(r.replyLost, true, 'the reply has no route back to a private address');
});

test('Windows APIPA retry and DHCP INIT-REBOOT NAK after a VLAN move', () => {
  const eng = buildMissionStart(buildDistrict, Engine, 4);
  const run = cli(eng);
  const k = eng.s.devices['GUEST-KIOSK'];
  const before = k.lease.addr;
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/6', 'switchport access vlan 30', 'end');
  assert.equal(k.lease.addr, before, 'no link flap, so the client keeps its stale lease');
  const r = run('GUEST-KIOSK', 'ipconfig /renew');
  assert.ok(r.frames.some(f => /NAK/.test(f.info)), 'server NAKs the old-subnet address');
  assert.notEqual(k.lease.addr, before);
});

test('BPDU guard err-disables an edge port that hears a switch', () => {
  const eng = new Engine(buildDistrict());
  eng.converge();
  const run = cli(eng);
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/23', 'spanning-tree bpduguard enable', 'end');
  eng.s.devices['DIST-SW-B'].powered = true;
  patchConnect(eng, 'P07', 'P09');
  assert.equal(eng.s.devices['ACCESS-SW'].ports['Gi0/23'].errDisabled, 'bpduguard');
  const st = run('ACCESS-SW', 'show interfaces status');
  assert.ok(st.lines.some(l => /^Gi0\/23 .*err-disabled/.test(l)));
});
