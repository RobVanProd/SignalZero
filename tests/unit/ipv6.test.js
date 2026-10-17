// IPv6 dual stack (M11): address math, SLAAC/RA, Neighbor Discovery, ICMPv6, IPv6 routing and ACLs, AAAA and
// Happy Eyeballs, the IOS / Windows / Ubuntu output, the M11 mission, its coach and its challenge faults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import {
  parseIp6, parseIp6Zone, parseCidr6, fmtIp6, fmtIp6Ios, fmtAddr, prefix6, inPrefix6, eui64, linkLocalFromIid,
  isLinkLocal6, isGlobal6, solicitedNode,
} from '../../src/engine/ipv6.js';
import { hostAddr6, evalAcl6, v6Reboot, l3Ifaces6 } from '../../src/engine/net6.js';
import { httpRequest } from '../../src/engine/services.js';
import { parseZone } from '../../src/engine/parsers/zone.js';
import { parseNetplan } from '../../src/engine/parsers/netplan.js';
import { parseIp as ip } from '../../src/engine/ipv4.js';
import { buildDistrict } from '../../src/content/district.js';
import { MISSIONS, cli, buildMissionStart, httpOk } from '../../src/content/missions.js';
import { FAULTS, buildHealthy, healthReport, randomParams, rngFrom } from '../../src/content/challenges.js';
import { Campaign } from '../../src/game/campaign.js';
import { Coach } from '../../src/game/coach.js';
import { COACH } from '../../src/content/coach.js';
import { createSession, execute, saveFile } from '../../src/cli/index.js';

const M11 = MISSIONS.findIndex(m => m.id === 'M11');
const text = r => (r.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n');
const start = () => { const eng = buildMissionStart(buildDistrict, Engine, M11); return { eng, run: cli(eng) }; };
const solved = () => { const s = start(); MISSIONS[M11].reference(s.eng); return s; };
const six = t => parseIp6(t);
const kinds = (eng, id) => hostAddr6(eng, eng.s.devices[id]).addrs.map(x => x.kind).sort();

// ------------------------------------------------------------------ address math (RFC 4291, RFC 5952)

test('IPv6 text parsing accepts every RFC 4291 form and rejects malformed ones', () => {
  assert.equal(parseIp6('2001:0DB8:0000:0000:0000:0000:0000:0001'), '20010db8000000000000000000000001');
  assert.equal(parseIp6('2001:db8::1'), '20010db8000000000000000000000001');
  assert.equal(parseIp6('::'), '0'.repeat(32));
  assert.equal(parseIp6('::1'), '0'.repeat(31) + '1');
  assert.equal(parseIp6('1::'), '0001' + '0'.repeat(28));
  assert.equal(parseIp6('::ffff:192.0.2.1'), '00000000000000000000ffffc0000201', 'embedded IPv4 in the last 32 bits');
  assert.equal(parseIp6('[2001:db8::1]'), parseIp6('2001:db8::1'), 'URL brackets');
  for (const bad of ['1:::2', '::1::', '2001:db8::g', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', '12345::', '1.2.3.4', '', ':1', '1:2:3:4:5:6:7::8:9', '1.2.3.4::', '::256.1.1.1', 'fe80::1%eth0']) {
    assert.equal(parseIp6(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(parseIp6('1:2:3:4:5:6:7::'), '00010002000300040005000600070000', '"::" may stand for a single group');
  assert.deepEqual(parseIp6Zone('fe80::1%eth0'), { addr: parseIp6('fe80::1'), zone: 'eth0' });
  assert.deepEqual(parseIp6Zone('fe80::1%7'), { addr: parseIp6('fe80::1'), zone: '7' });
  assert.deepEqual(parseCidr6('2001:db8:42:10::1/64'), { addr: parseIp6('2001:db8:42:10::1'), len: 64 });
  assert.equal(parseCidr6('2001:db8::/129'), null);
});

test('RFC 5952 canonical text: lowercase, no leading zeros, longest zero run, no single-group "::"', () => {
  assert.equal(fmtIp6(six('2001:0DB8:0:0:1:0:0:1')), '2001:db8::1:0:0:1', 'first of two equal runs');
  assert.equal(fmtIp6(six('2001:db8:0:0:0:1:0:0')), '2001:db8::1:0:0', 'longest run wins');
  assert.equal(fmtIp6(six('2001:db8:0:1:1:1:1:1')), '2001:db8:0:1:1:1:1:1', 'a single zero group is not compressed');
  assert.equal(fmtIp6(six('0:0:0:0:0:0:0:0')), '::');
  assert.equal(fmtIp6(six('fe80:0:0:0:0:0:0:1')), 'fe80::1');
  assert.equal(fmtIp6Ios(six('2001:db8:42:10::1')), '2001:DB8:42:10::1', 'IOS prints uppercase');
  assert.equal(fmtAddr(ip('10.42.10.1')), '10.42.10.1');
  assert.equal(fmtAddr(six('2001:db8::1')), '2001:db8::1');
  for (const t of ['2001:db8::1', '::', 'fe80::42:1aff:fe00:102', '2001:db8:42:10:8343:2941:57e8:5257', '::ffff:192.0.2.1']) assert.equal(fmtIp6(parseIp6(t)), t);
});

test('prefix math, modified EUI-64 (RFC 4291 appendix A) and address types', () => {
  assert.equal(fmtIp6(prefix6(six('2001:db8:42:10:abcd::1'), 64)), '2001:db8:42:10::');
  assert.equal(fmtIp6(prefix6(six('2001:db8:42:ff::1'), 56)), '2001:db8:42::');
  assert.equal(fmtIp6(prefix6(six('2001:db8:42:1f::1'), 59)), '2001:db8:42::');
  assert.ok(inPrefix6(six('2001:db8:42:10::99'), six('2001:db8:42::'), 48));
  assert.ok(!inPrefix6(six('2001:db8:43::1'), six('2001:db8:42::'), 48));
  assert.equal(eui64('00aa003f2a1c'), '02aa00fffe3f2a1c', 'the RFC 4291 example MAC 00-AA-00-3F-2A-1C');
  assert.equal(fmtIp6(linkLocalFromIid(eui64('02421a000102'))), 'fe80::42:1aff:fe00:102', 'U/L bit inverted (locally administered 02 -> 00)');
  assert.ok(isLinkLocal6(six('febf::1')) && !isLinkLocal6(six('fec0::1')), 'fe80::/10');
  assert.ok(isGlobal6(six('2001:db8::1')) && !isGlobal6(six('fe80::1')) && !isGlobal6(six('ff02::1')) && !isGlobal6(six('::1')));
  assert.equal(fmtIp6(solicitedNode(six('2001:db8:42:10::1'))), 'ff02::1:ff00:1');
});

// ------------------------------------------------------------------ M11 start: link-local only

test('M11 start: every host has only its link-local address; no router advertises', () => {
  const { eng, run } = start();
  for (const id of ['DISPATCH-01', 'CORE-SRV', 'CLINIC-APP', 'NURSE-STATION']) {
    const a = hostAddr6(eng, eng.s.devices[id]);
    assert.ok(a.enabled && isLinkLocal6(a.ll), `${id} has a link-local address`);
    assert.equal(a.addrs.length, 0, `${id} has no global address`);
    assert.equal(a.routers.length, 0, `${id} has no IPv6 default router`);
  }
  const ipc = text(run('DISPATCH-01', 'ipconfig'));
  assert.match(ipc, /Link-local IPv6 Address \. \. \. \. : fe80::[0-9a-f:]+%7\n/, 'Windows shows the zone index');
  assert.doesNotMatch(ipc, /^ {3}IPv6 Address/m);
  assert.match(ipc, /Default Gateway \. \. \. \. \. \. \. \. : 10\.42\.10\.1$/m, 'only the IPv4 gateway');
  assert.equal(text(run('CORE-SRV', 'ip -6 route')), 'fe80::/64 dev eth0 proto kernel metric 256 pref medium');
  assert.match(text(run('EDGE-RTR', 'enable', 'show ipv6 interface brief')), /GigabitEthernet0\/1\.10  \[up\/up\]\n {4}unassigned/);
  // the backup flow now targets the IPv6-only endpoint and fails; the IPv4 flows are fine
  assert.equal(eng.s.flowState.backup.ok, false);
  assert.equal(eng.s.flowState.ipv6.ok, false);
  assert.equal(eng.s.flowState.clinic.ok, true);
});

test('IPv6 stays off before M11: no router advertises and no host learns an address in any earlier mission', () => {
  for (let i = 0; i < M11; i++) {
    const eng = buildMissionStart(buildDistrict, Engine, i);
    MISSIONS[i].reference(eng);
    eng.advance(450);
    for (const d of Object.values(eng.s.devices)) {
      if (d.kind !== 'host') continue;
      assert.equal(d.v6, undefined, `${MISSIONS[i].id}: ${d.id} learned no IPv6 state`);
    }
    assert.ok(Object.values(eng.s.devices).filter(d => d.kind === 'router' && d.os === 'ios').every(d => !d.ipv6Routing), `${MISSIONS[i].id}: no clinic router routes IPv6`);
  }
});

test('dual stack does not change any earlier goal: M01–M10 goal results are the same before and after the M11 fix', () => {
  const { eng } = start();
  const before = MISSIONS.slice(0, M11).map(m => m.goals.map(g => g.check(eng)));
  MISSIONS[M11].reference(eng);
  eng.advance(10);
  const after = MISSIONS.slice(0, M11).map(m => m.goals.map(g => g.check(eng)));
  assert.deepEqual(after, before);
  assert.ok(MISSIONS[M11].constraints.every(c => c.check(eng)), 'M11 constraints (IPv4 keeps working) hold');
});

// ------------------------------------------------------------------ the pitfalls

test('pitfall: addresses without "ipv6 unicast-routing" send no RAs, so hosts stay link-local only', () => {
  const { eng, run } = start();
  run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/0', 'ipv6 address 2001:db8:ffff:1::2/64', 'interface g0/1.10', 'ipv6 address 2001:db8:42:10::1/64', 'exit', 'ipv6 route ::/0 2001:db8:ffff:1::1', 'end');
  eng.advance(400);
  assert.equal(hostAddr6(eng, eng.s.devices['DISPATCH-01']).addrs.length, 0);
  assert.deepEqual(MISSIONS[M11].goals.map(g => g.check(eng)), [false, false, false, false]);
  assert.doesNotMatch(text(run('EDGE-RTR', 'show ipv6 interface g0/1.10')), /router advertisements are sent/);
  // a non-routing IOS box still discards transit IPv6 (it is a host)
  const p = eng.probe({ from: 'CORE-SRV', dst: six('2001:db8:203::20'), proto: 'icmp' });
  assert.equal(p.status, 'local-error', 'and the server has no route anyway');
  run('EDGE-RTR', 'configure terminal', 'ipv6 unicast-routing', 'end');
  assert.deepEqual(kinds(eng, 'DISPATCH-01'), ['slaac', 'temp'], 'initial RAs once the interface starts advertising');
  assert.deepEqual(MISSIONS[M11].goals.map(g => g.check(eng)), [true, true, true, true]);
  assert.match(text(run('EDGE-RTR', 'show ipv6 interface g0/1.10')), /ND router advertisements are sent every 200 seconds\n {2}ND router advertisements live for 1800 seconds/);
});

test('pitfall: only a /64 lets hosts autoconfigure (RFC 4862 5.5.3); eui-64 on the router is fine', () => {
  const { eng, run } = start();
  run('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 unicast-routing', 'interface g0/1.10', 'ipv6 address 2001:db8:42:10::1/56', 'end');
  const a = hostAddr6(eng, eng.s.devices['DISPATCH-01']);
  assert.equal(a.addrs.length, 0, 'no address from a /56');
  assert.equal(a.routers.length, 1, 'but the router is learned');
  run('EDGE-RTR', 'configure terminal', 'interface g0/1.10', 'no ipv6 address 2001:db8:42:10::1/56', 'ipv6 address 2001:db8:42:10::/64 eui-64', 'end');
  assert.deepEqual(kinds(eng, 'DISPATCH-01'), ['slaac', 'temp']);
  const show = text(run('EDGE-RTR', 'show ipv6 interface g0/1.10'));
  assert.match(show, /2001:DB8:42:10:42:1AFF:FE00:102, subnet is 2001:DB8:42:10::\/64 \[EUI\]/);
  assert.match(text(run('EDGE-RTR', 'show running-config interface g0/1.10')), / ipv6 address 2001:DB8:42:10::\/64 eui-64/);
});

test('pitfall: a link-local next hop needs the exit interface; the WAN address must be the one the ISP routes to', () => {
  const { eng, run } = start();
  const r = run('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 route ::/0 fe80::1');
  assert.equal(text(r), '% Interface has to be specified for a link-local nexthop');
  assert.equal((eng.s.devices['EDGE-RTR'].routes6 || []).length, 0);
  // eui-64 on the WAN: everything looks configured, but the ISP's /48 route points at ::2, which does not exist
  run('EDGE-RTR', 'ipv6 unicast-routing', 'ipv6 route ::/0 g0/0 fe80::1', 'interface g0/0', 'ipv6 address 2001:db8:ffff:1::/64 eui-64', 'interface g0/1.10', 'ipv6 address 2001:db8:42:10::1/64', 'end');
  assert.match(text(run('EDGE-RTR', 'show ipv6 route static')), /S {3}::\/0 \[1\/0\]\n {5}via FE80::1, GigabitEthernet0\/0/);
  assert.equal(MISSIONS[M11].goals[0].check(eng), true);
  assert.equal(MISSIONS[M11].goals[2].check(eng), false, 'replies are lost: the ISP cannot resolve 2001:db8:ffff:1::2');
  run('EDGE-RTR', 'configure terminal', 'interface g0/0', 'ipv6 address 2001:db8:ffff:1::2/64', 'end');
  assert.equal(MISSIONS[M11].goals[2].check(eng), true, 'the link-local next hop with exit interface is a valid fix');
});

test('no IPv6 NAT: the clinic source address arrives unchanged at the internet host', () => {
  const { eng } = solved();
  const disp = hostAddr6(eng, eng.s.devices['DISPATCH-01']);
  const temp = disp.addrs.find(x => x.kind === 'temp').addr;
  const p = eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:203::80'), proto: 'tcp', dport: 443 });
  assert.equal(p.kind, 'syn-ack');
  assert.equal(p.fwd.pkt.src, temp, 'Windows sources from its temporary address (RFC 6724 rule 7), untranslated');
  assert.equal(p.fwd.nat.length, 0);
  assert.equal(p.fwd.hops.filter(h => h.kind === 'l3').at(-1).pkt.src, temp);
});

// ------------------------------------------------------------------ RAs, ND, ICMPv6

test('"ipv6 nd ra suppress" still answers Router Solicitations; "suppress all" does not', () => {
  const { eng, run } = solved();
  const d = eng.s.devices['DISPATCH-01'];
  run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.10', 'ipv6 nd ra suppress', 'end');
  v6Reboot(eng, d);
  assert.deepEqual(kinds(eng, 'DISPATCH-01'), ['slaac', 'temp'], 'the solicited RA still arrives');
  assert.match(text(run('EDGE-RTR', 'show ipv6 interface g0/1.10')), /ND RAs are suppressed \(periodic\)/);
  run('EDGE-RTR', 'configure terminal', 'interface g0/1.10', 'ipv6 nd ra suppress all', 'end');
  v6Reboot(eng, d);
  eng.advance(400);
  assert.equal(hostAddr6(eng, d).addrs.length, 0, 'no RA at all, even after periodic intervals');
  run('EDGE-RTR', 'configure terminal', 'interface g0/1.10', 'no ipv6 nd ra suppress', 'end');
  assert.deepEqual(kinds(eng, 'DISPATCH-01'), ['slaac', 'temp']);
});

test('ICMPv6: hop limit exceeded, no route (code 0), address unreachable (code 3), port unreachable (code 4)', () => {
  const { eng, run } = solved();
  const t = eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:203::20'), proto: 'icmp', ttl: 2 });
  assert.equal(t.kind, 'ttl-exceeded');
  assert.equal(fmtIp6(t.responderIp), '2001:db8:ffff:1::1');
  const nr = eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:999::1'), proto: 'icmp' });
  assert.equal(nr.kind, 'net-unreachable', 'the ISP has no route for it');
  const au = eng.probe({ from: 'BACKUP', dst: six('2001:db8:42:10::99'), proto: 'icmp' });
  assert.equal(au.kind, 'addr-unreachable', 'RFC 4861 7.2.2: the last router reports failed address resolution');
  assert.equal(fmtIp6(au.responderIp), '2001:db8:ffff:1::2');
  const pu = eng.probe({ from: 'CORE-SRV', dst: six('2001:db8:42:10::1'), proto: 'udp', dport: 33434 });
  assert.equal(pu.kind, 'port-unreachable');
  // Windows ping shows the hop-limit error the IPv4 way, and no TTL in echo replies
  assert.match(text(run('DISPATCH-01', 'ping -6 -n 1 2001:db8:999::1')), /Reply from 2001:db8:ffff:1::1: Destination net unreachable\./);
  assert.match(text(run('DISPATCH-01', 'ping -6 -n 1 2001:db8:203::20')), /Reply from 2001:db8:203::20: time=\d+ms\n/);
  assert.match(text(run('CORE-SRV', 'ping -6 -c 1 2001:db8:999::1')), /From 2001:db8:ffff:1::1 icmp_seq=1 Destination unreachable: No route/);
  assert.match(text(run('CORE-SRV', 'traceroute -6 2001:db8:203::20')), /^traceroute to 2001:db8:203::20 \(2001:db8:203::20\), 30 hops max, 80 byte packets\n 1 {2}2001:db8:42:10::1 \(2001:db8:42:10::1\) /);
});

test('Neighbor Discovery replaces ARP and shows up in every neighbor table', () => {
  const { eng, run } = solved();
  const rll = l3Ifaces6(eng, eng.s.devices['EDGE-RTR']).find(i => i.name === 'Gi0/1.10').ll;
  assert.match(text(run('CORE-SRV', 'ip -6 neigh')), new RegExp(`^${fmtIp6(rll)} dev eth0 lladdr 02:42:1a:00:01:02 router STALE$`));
  assert.match(text(run('DISPATCH-01', 'netsh interface ipv6 show neighbors')), new RegExp(`${fmtIp6(rll)} +02-42-1a-00-01-02  Reachable \\(Router\\)`));
  const nd = text(run('EDGE-RTR', 'enable', 'show ipv6 neighbors'));
  assert.match(nd, /^IPv6 Address {30}Age Link-layer Addr State Interface$/m);
  assert.match(nd, /^FE80::1 {35} {2}\d 0242\.1a00\.0201 {2}REACH Gi0\/0$/m);
});

// ------------------------------------------------------------------ IPv6 ACLs

test('IPv6 ACLs: implicit nd-na / nd-ns permits before the implicit deny; an explicit deny blocks ND', () => {
  const acl = { acls6: { T: { entries: [{ seq: 10, action: 'permit', proto: 'tcp', src: { any: true }, dst: { any: true }, sop: null, dop: { op: 'eq', ports: [443] } }] } } };
  assert.equal(evalAcl6(acl, 'T', { proto: 'icmp', icmpType: 'nd-ns' }).implicitNd, true);
  assert.equal(evalAcl6(acl, 'T', { proto: 'icmp', icmpType: 'echo' }).implicit, true);
  assert.equal(evalAcl6(acl, 'NONE', { proto: 'icmp', icmpType: 'echo' }).permit, true, 'an undefined ACL permits');
  assert.equal(evalAcl6({ acls6: { E: { entries: [] } } }, 'E', { proto: 'udp' }).permit, true, 'an ACL with no entries permits');
  const { eng, run } = solved();
  run('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 access-list ONLY443', 'permit tcp any any eq 443', 'exit', 'interface g0/1.10', 'ipv6 traffic-filter ONLY443 in', 'end');
  assert.equal(eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:203::80'), proto: 'tcp', dport: 443 }).kind, 'syn-ack', 'ND still works');
  assert.equal(eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:203::80'), proto: 'icmp' }).status, 'timeout', 'echo hits the implicit deny');
  run('EDGE-RTR', 'configure terminal', 'ipv6 access-list ONLY443', 'deny ipv6 any any log', 'end');
  const p = eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:203::80'), proto: 'tcp', dport: 443 });
  assert.equal(p.reason, 'nd-fail', 'the explicit deny drops the host\'s Neighbor Solicitation');
  assert.match(text(run('DISPATCH-01', 'ping -6 -n 1 2001:db8:203::80')), /Reply from 2001:db8:42:10:[0-9a-f:]+: Destination host unreachable\./);
  const show = text(run('EDGE-RTR', 'show ipv6 access-list ONLY443'));
  assert.match(show, /^IPv6 access list ONLY443\n {4}permit tcp any any eq 443 \(\d+ match(es)?\) sequence 10\n {4}deny ipv6 any any log \(\d+ match(es)?\) sequence 20$/);
  run('EDGE-RTR', 'configure terminal', 'ipv6 access-list ONLY443', 'sequence 15 permit icmp any any nd-ns', 'sequence 16 permit icmp any any nd-na', 'end');
  assert.equal(eng.probe({ from: 'DISPATCH-01', dst: six('2001:db8:203::80'), proto: 'tcp', dport: 443 }).kind, 'syn-ack');
  const rc = text(run('EDGE-RTR', 'show running-config'));
  assert.match(rc, /\nipv6 access-list ONLY443\n permit tcp any any eq 443\n permit icmp any any nd-ns\n permit icmp any any nd-na\n deny ipv6 any any log\n!/);
  assert.match(rc, /interface GigabitEthernet0\/1\.10\n(?: .*\n)* ipv6 traffic-filter ONLY443 in\n/);
  const bad = run('EDGE-RTR', 'configure terminal', 'ipv6 access-list ONLY443', '15 permit ipv6 any any');
  assert.match(text(bad), /% Invalid input detected/, 'IPv6 ACL entries take "sequence N", not a bare number');
});

test('IOS running-config and show ipv6 route after the reference fix', () => {
  const { run } = solved();
  const rc = text(run('EDGE-RTR', 'enable', 'show running-config'));
  assert.match(rc, /\nno ip domain lookup\nipv6 unicast-routing\n!/);
  assert.match(rc, /interface GigabitEthernet0\/0\n(?: .*\n)* speed auto\n ipv6 address 2001:DB8:FFFF:1::2\/64\n!/);
  assert.match(rc, /\nipv6 route ::\/0 2001:DB8:FFFF:1::1\n!/);
  const rt = text(run('EDGE-RTR', 'show ipv6 route'));
  assert.match(rt, /^IPv6 Routing Table - default - \d+ entries\nCodes: C - Connected, L - Local, S - Static, U - Per-user Static route/);
  assert.match(rt, /S {3}::\/0 \[1\/0\]\n {5}via 2001:DB8:FFFF:1::1\n/);
  assert.match(rt, /C {3}2001:DB8:42:10::\/64 \[0\/0\]\n {5}via GigabitEthernet0\/1\.10, directly connected\nL {3}2001:DB8:42:10::1\/128 \[0\/0\]\n {5}via GigabitEthernet0\/1\.10, receive/);
  assert.match(rt, /L {3}FF00::\/8 \[0\/0\]\n {5}via Null0, receive$/);
  assert.match(text(run('EDGE-RTR', 'ping 2001:db8:203::20')), /Sending 5, 100-byte ICMP Echos to 2001:DB8:203::20, timeout is 2 seconds:\n!!!!!/);
  assert.match(text(run('EDGE-RTR', 'traceroute 2001:db8:203::20')), /Tracing the route to 2001:DB8:203::20\n\n {2}1 2001:DB8:FFFF:1::1 \d+ msec/);
  assert.match(text(run('EDGE-RTR', 'ping 2001:db8:abcd::1')), /\nUUUUU\nSuccess rate is 0 percent \(0\/5\)/, 'the ISP answers "no route"');
  run('EDGE-RTR', 'configure terminal', 'no ipv6 route ::/0', 'end');
  assert.match(text(run('EDGE-RTR', 'ping 2001:db8:abcd::1')), /% No valid route for destination\nSuccess rate is 0 percent \(0\/1\)/);
  run('EDGE-RTR', 'configure terminal', 'ipv6 route ::/0 2001:db8:ffff:1::1', 'end');
  // a link-local destination: IOS asks for the output interface
  assert.equal(text(run('EDGE-RTR', 'ping fe80::1')), 'Output Interface: ');
  assert.match(text(run('EDGE-RTR', 'g0/0')), /!!!!!/);
});

// ------------------------------------------------------------------ hosts: Windows and Ubuntu output

test('Windows after SLAAC: IPv6, temporary and link-local addresses, IPv6 gateway first, DHCPv6 lines in /all', () => {
  const { run } = solved();
  const all = text(run('DISPATCH-01', 'ipconfig /all'));
  assert.match(all, / {3}IPv6 Address\. \. \. \. \. \. \. \. \. \. : 2001:db8:42:10:[0-9a-f:]+\(Preferred\)\n {3}Temporary IPv6 Address\. \. \. \. \. : 2001:db8:42:10:[0-9a-f:]+\(Preferred\)\n {3}Link-local IPv6 Address \. \. \. \. : fe80::[0-9a-f:]+%7\(Preferred\)\n {3}IPv4 Address/);
  assert.match(all, /Default Gateway \. \. \. \. \. \. \. \. : fe80::42:1aff:fe00:102%7\n {37}10\.42\.10\.1\n/);
  assert.match(all, /DHCP Server \. \. \. \. \. \. \. \. \. \. : 10\.42\.10\.10\n {3}DHCPv6 IAID \. \. \. \. \. \. \. \. \. \. : \d+\n {3}DHCPv6 Client DUID\. \. \. \. \. \. \. : 00-01-00-01-[0-9A-F-]+-02-42-1A-00-09-01\n/);
  // the public SLAAC address and the link-local address share Windows' randomized interface ID
  const pub = /IPv6 Address[ .]+: (\S+)\(Preferred\)/.exec(all)[1];
  const ll = /Link-local IPv6 Address[ .]+: (\S+)%7/.exec(all)[1];
  assert.equal(pub.split(':').slice(-4).join(':'), ll.split(':').slice(-4).join(':'));
  const rp = text(run('DISPATCH-01', 'route print -6'));
  assert.match(rp, /IPv6 Route Table\n=+\nActive Routes:\n If Metric Network Destination {6}Gateway\n {2}7 {4}281 ::\/0 {21}fe80::42:1aff:fe00:102\n/);
  assert.doesNotMatch(rp, /IPv4 Route Table/);
  const addrs = text(run('DISPATCH-01', 'netsh interface ipv6 show addresses'));
  assert.match(addrs, /Public {5}Preferred {4}29d23h59m {3}6d23h59m 2001:db8:42:10:/);
  assert.match(addrs, /Temporary {2}Preferred {5}6d23h59m {2}23h59m\d+s 2001:db8:42:10:/);
});

test('Ubuntu after SLAAC: ip -6 addr / route show the RA-learned address and default route', () => {
  const { run } = solved();
  const a = text(run('CORE-SRV', 'ip -6 addr'));
  assert.match(a, / {4}inet6 2001:db8:42:10:42:1aff:fe00:a01\/64 scope global dynamic mngtmpaddr noprefixroute \n {7}valid_lft \d+sec preferred_lft \d+sec\n {4}inet6 fe80::42:1aff:fe00:a01\/64 scope link /, 'EUI-64 SLAAC address (networkd default)');
  const r = text(run('CORE-SRV', 'ip -6 route'));
  assert.match(r, /^2001:db8:42:10::\/64 dev eth0 proto ra metric 1024 expires \d+sec pref medium$/m);
  assert.match(r, /^default via fe80::42:1aff:fe00:102 dev eth0 proto ra metric 1024 expires 17\d\dsec pref medium$/m);
  assert.match(text(run('CORE-SRV', 'ip a')), /inet 10\.42\.10\.10\/24[^\n]*\n {7}valid_lft forever preferred_lft forever\n {4}inet6 2001:db8:42:10:/, 'both families in "ip a"');
  assert.doesNotMatch(text(run('CORE-SRV', 'ip -4 a')), /inet6/);
  assert.match(text(run('CORE-SRV', 'ping -6 -c 1 backup6.example.net')), /^PING backup6\.example\.net \(2001:db8:203::20\) 56 data bytes\n64 bytes from 2001:db8:203::20: icmp_seq=1 ttl=62 time=/);
  assert.match(text(run('CORE-SRV', 'ss -tulpn')), /tcp {3}LISTEN 0 {6}4096 {14}\[::\]:22 {15}\[::\]:\*/);
  assert.doesNotMatch(text(run('CORE-SRV', 'ss -tulpn')), /\[::\]:67/, 'ISC dhcpd (DHCPv4) has no IPv6 socket');
});

test('netplan: static IPv6 addresses and an IPv6 default route (Ubuntu 24.04 syntax)', () => {
  const y = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      accept-ra: false\n      addresses:\n        - 10.42.10.20/24\n        - "2001:db8:42:10::20/64"\n      routes:\n        - to: default\n          via: 10.42.10.1\n        - to: default\n          via: "fe80::42:1aff:fe00:102"\n      nameservers:\n        addresses: [10.42.10.10]\n';
  const r = parseNetplan(y, '/etc/netplan/01-netcfg.yaml', 'eth0');
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.cfg, { addr: ip('10.42.10.20'), len: 24, gw: ip('10.42.10.1'), dns: [ip('10.42.10.10')] }, 'the IPv4 fields are unchanged');
  assert.deepEqual(r.v6, { addrs: [{ addr: six('2001:db8:42:10::20'), len: 64 }], gw: six('fe80::42:1aff:fe00:102') });
  assert.equal(r.acceptRa, false);
  assert.ok(parseNetplan('network:\n  ethernets:\n    eth0:\n      addresses: [10.0.0.5/24, "2001:db8::5/64"]\n      gateway6: 2001:db8::1\n', 'p', 'eth0').v6.gw === six('2001:db8::1'), 'deprecated gateway6 is still read');
  assert.match(parseNetplan('network:\n  ethernets:\n    eth0:\n      addresses: [10.0.0.5/24, "2001:db8::zz/64"]\n', 'p', 'eth0').error, /malformed address '2001:db8::zz\/64', must be X\.X\.X\.X\/NN or X:X:X:X:X:X:X:X\/NN/);
  const { eng, run } = solved();
  saveFile(eng, 'CLINIC-APP', '/etc/netplan/01-netcfg.yaml', y);
  assert.equal(text(run('CLINIC-APP', 'netplan apply')), '');
  assert.deepEqual(kinds(eng, 'CLINIC-APP'), ['static'], 'accept-ra: false drops the SLAAC address');
  assert.match(text(run('CLINIC-APP', 'ip -6 r')), /^default via fe80::42:1aff:fe00:102 dev eth0 proto static metric 1024 pref medium$/m);
  assert.equal(eng.probe({ from: 'CLINIC-APP', dst: six('2001:db8:203::20'), proto: 'icmp' }).kind, 'reply');
});

// ------------------------------------------------------------------ DNS: AAAA records and resolver behaviour

test('zone files: AAAA records load, are served, and a bad one fails with BIND\'s wording', () => {
  const z = parseZone('$TTL 300\n@ IN SOA ns. h. ( 1 1h 15m 1w 300 )\n  IN NS ns.\nclinic IN AAAA 2001:DB8:42:10::20\n', 'ops.example', 'db');
  assert.ok(z.ok);
  assert.equal(z.records.find(r => r.type === 'AAAA').addr6, six('2001:db8:42:10::20'));
  const bad = parseZone('$TTL 300\n@ IN SOA ns. h. ( 1 1h 15m 1w 300 )\n  IN NS ns.\nx IN AAAA 2001:db8::zz\n', 'ops.example', 'db');
  assert.equal(bad.errors[0], "dns_rdata_fromtext: db:4: near '2001:db8::zz': bad IPv6 address");
  const { eng, run } = solved();
  const f = '/etc/bind/db.ops.example';
  saveFile(eng, 'CORE-SRV', f, eng.s.devices['CORE-SRV'].files[f] + 'clinic   IN AAAA 2001:db8:42:10::20\n');
  run('CORE-SRV', 'rndc reload');
  assert.match(text(run('CORE-SRV', 'dig AAAA clinic.ops.example')), /;; ANSWER SECTION:\nclinic\.ops\.example\.\t300\tIN\tAAAA\t2001:db8:42:10::20\n/);
  assert.equal(text(run('CORE-SRV', 'dig +short AAAA clinic.ops.example')), '2001:db8:42:10::20');
  assert.match(text(run('DISPATCH-01', 'nslookup clinic.ops.example')), /Name: {4}clinic\.ops\.example\nAddresses: {2}2001:db8:42:10::20\n {10}10\.42\.10\.20\n/);
});

test('resolvers: Windows asks for AAAA only with a global IPv6 address; glibc always does; nslookup always does', () => {
  const { eng, run } = start();
  const c = text(run('DISPATCH-01', 'curl https://backup6.example.net/health'));
  assert.match(c, /^curl: \(6\) Could not resolve host: backup6\.example\.net/, 'Windows sent no AAAA query (link-local only)');
  assert.match(text(run('DISPATCH-01', 'nslookup backup6.example.net')), /Name: {4}backup6\.example\.net\nAddress: {2}2001:db8:203::20\n/);
  assert.match(text(run('DISPATCH-01', 'nslookup -type=AAAA backup6.example.net')), /backup6\.example\.net\tAAAA IPv6 address = 2001:db8:203::20/);
  const v = text(run('CORE-SRV', 'curl -v https://backup6.example.net/health'));
  assert.match(v, /\* IPv6: 2001:db8:203::20\n\* IPv4: \(none\)\n\* {3}Trying \[2001:db8:203::20\]:443\.\.\.\n\* Immediate connect fail for 2001:db8:203::20: Network is unreachable\ncurl: \(7\) Failed to connect to backup6\.example\.net port 443 after 0 ms: Couldn't connect to server/, 'glibc returned the AAAA; connect() fails at once');
  assert.match(text(run('CORE-SRV', 'ping -4 backup6.example.net')), /ping: backup6\.example\.net: No address associated with hostname/);
  assert.match(text(run('DISPATCH-01', 'ping -4 backup6.example.net')), /Ping request could not find host backup6\.example\.net/);
  assert.match(text(run('DISPATCH-01', 'ping -6 backup6.example.net')), /PING: transmit failed\. General failure\./, '-6 asks for AAAA; there is no IPv6 route');
});

test('address selection and Happy Eyeballs: IPv6 preferred once usable; a broken IPv6 path falls back to IPv4', () => {
  const { eng, run } = start();
  const before = httpRequest(eng, eng.s.devices['DISPATCH-01'], 'https://portal.example.net/', { noCache: true });
  assert.equal(before.family, 4, 'without a global IPv6 address IPv4 is used');
  MISSIONS[M11].reference(eng);
  const after = httpRequest(eng, eng.s.devices['DISPATCH-01'], 'https://portal.example.net/', { noCache: true });
  assert.equal(after.family, 6, 'RFC 6724: a usable IPv6 destination sorts first');
  assert.match(text(run('DISPATCH-01', 'ping portal.example.net')), /Pinging portal\.example\.net \[2001:db8:203::80\] with 32 bytes of data:/);
  assert.match(text(run('DISPATCH-01', 'ping -4 portal.example.net')), /Pinging portal\.example\.net \[203\.0\.113\.80\] with 32 bytes of data:/);
  // drop IPv6 HTTPS at the edge: curl tries IPv6 first, then IPv4, and still succeeds
  run('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 access-list NO443', 'deny tcp any any eq 443', 'permit ipv6 any any', 'exit', 'interface g0/0', 'ipv6 traffic-filter NO443 out', 'end');
  const he = text(run('DISPATCH-01', 'curl -v https://portal.example.net/'));
  assert.match(he, /\* Host portal\.example\.net:443 was resolved\.\n\* IPv6: 2001:db8:203::80\n\* IPv4: 203\.0\.113\.80\n\* {3}Trying \[2001:db8:203::80\]:443\.\.\.\n\* {3}Trying 203\.0\.113\.80:443\.\.\.\n\* Connected to portal\.example\.net \(203\.0\.113\.80\) port 443/);
  assert.match(he, /Welcome to City Clinic guest Wi-Fi/);
  assert.match(text(run('DISPATCH-01', 'curl -6 https://portal.example.net/')), /curl: \(28\) Failed to connect to portal\.example\.net port 443 after 21\d+ ms: Timed out/);
  assert.equal(httpOk(eng, 'CORE-SRV', 'https://backup6.example.net/health'), false, 'an IPv6-only name has nothing to fall back to');
});

// ------------------------------------------------------------------ mission, coach, faults

test('M11: several correct fixes win, the evidence must be IPv6 from inside, and a /64-less fix does not', () => {
  const variants = [
    run => run('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 unicast-routing', 'interface g0/0', 'ipv6 address 2001:db8:ffff:1::2/64', 'interface g0/1.10', 'ipv6 address 2001:db8:42:10::/64 eui-64', 'exit', 'ipv6 route ::/0 g0/0 fe80::1', 'end'),
    run => run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.10', 'ipv6 address 2001:db8:42:10::1/64', 'interface g0/0', 'ipv6 address 2001:DB8:FFFF:1::2/64', 'exit', 'ipv6 route ::/0 2001:db8:ffff:1::1', 'ipv6 unicast-routing', 'end'),
  ];
  for (const v of variants) {
    const { eng, run } = start();
    const camp = new Campaign(eng, { index: M11, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
    v(run);
    camp.markBefore();
    const mid = camp.evaluate('action');
    assert.equal(mid.status, 'verify', JSON.stringify(mid.goals));
    camp.markBefore();
    run('BACKUP', 'curl -k https://backup6.example.net/health');
    assert.equal(camp.evaluate('command').status, 'verify', 'a test from the internet side is not evidence');
    run('DISPATCH-01', 'curl https://backup6.example.net/health');
    assert.equal(camp.evaluate('command').status, 'won');
  }
});

test('coach M11: the reference path ticks every step, in order, up to verification', () => {
  const eng = buildMissionStart(buildDistrict, Engine, M11);
  const camp = new Campaign(eng, { index: M11, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
  const said = [];
  const app = { eng, campaign: camp, mode: 'campaign', settings: { coach: true }, progress: {}, touch: false, saveProgress() {}, telemetry: { log() {} }, sound: { ok() {} }, hud: { say: (t, who) => said.push({ who, t }), coachPulse() {} } };
  const coach = new Coach(app);
  coach.reset(MISSIONS[M11]);
  const seen = [];
  const orig = coach.celebrate.bind(coach);
  coach.celebrate = s => { seen.push(s.id); orig(s); };
  const sessions = {};
  const run = (dev, ...lines) => { for (const l of lines) { sessions[dev] ||= createSession(eng, dev); const r = execute(eng, sessions[dev], l); coach.onCommand(dev, l, r); coach.update(); } };
  coach.noteOpen('DISPATCH-01'); run('DISPATCH-01', 'ipconfig', 'nslookup backup6.example.net');
  coach.noteOpen('CORE-SRV'); run('CORE-SRV', 'ip -6 route');
  coach.noteOpen('EDGE-RTR'); run('EDGE-RTR', 'enable', 'show ipv6 interface brief', 'configure terminal', 'ipv6 unicast-routing', 'interface g0/0', 'ipv6 address 2001:db8:ffff:1::2/64', 'interface g0/1.10', 'ipv6 address 2001:db8:42:10::1/64', 'exit', 'ipv6 route ::/0 2001:db8:ffff:1::1', 'end');
  run('DISPATCH-01', 'ipconfig');
  assert.equal(coach.current()?.id, 'verify', `stuck at ${coach.current()?.id} (ticked ${seen.join(',')})`);
  assert.deepEqual(seen, COACH.M11.slice(0, -1).map(s => s.id), 'every step ticked in order, none skipped');
  assert.equal(said.filter(s => /^COACH · STEP/.test(s.who)).length, COACH.M11.length - 1, 'one explanation per completed step');
});

test('IPv6 challenge faults: each breaks a user-visible flow, shows its cause on the router, and its fix restores everything', () => {
  const healthy = buildHealthy(randomParams(rngFrom(31337)));
  assert.ok(healthReport(healthy).ok, JSON.stringify(healthReport(healthy).flows.filter(f => !f.ok)));
  const cause = {
    'ra-suppressed': ['show ipv6 interface', /ND RAs are suppressed \(all\)/],
    'ipv6-default-route': ['show ipv6 route static', /via 2001:DB8:FFFF:1::9/],
    'ipv6-acl-nd': ['show ipv6 access-list', /deny ipv6 any any log \(\d+ match/],
  };
  for (const id of Object.keys(cause)) {
    const f = FAULTS.find(x => x.id === id);
    assert.ok(f, id);
    const eng = new Engine(healthy.snapshot());
    eng.ensure();
    const ctx = f.inject(eng, rngFrom(5));
    eng.advance(2);
    const broken = healthReport(eng);
    assert.ok(!broken.ok && broken.flows.some(x => ['backup', 'ipv6'].includes(x.id) && !x.ok), `${id} breaks an IPv6 flow`);
    assert.ok(broken.flows.filter(x => !['backup', 'ipv6'].includes(x.id)).every(x => x.ok), `${id} leaves IPv4 flows alone`);
    assert.match(text(cli(eng)('EDGE-RTR', 'enable', cause[id][0])), cause[id][1]);
    f.fix(eng, ctx);
    eng.advance(3);
    assert.ok(healthReport(eng).ok, `${id} fix: ${JSON.stringify(healthReport(eng).flows.filter(x => !x.ok))}`);
  }
});

test('state stays plain JSON (no BigInt, Map or Set) after IPv6 traffic and time', () => {
  const { eng, run } = solved();
  run('DISPATCH-01', 'curl -v https://backup6.example.net/health', 'ping portal.example.net', 'tracert -6 backup6.example.net');
  run('CORE-SRV', 'ping -6 -c 2 2001:db8:203::20', 'traceroute -6 2001:db8:203::20');
  eng.advance(1000);
  const json = JSON.stringify(eng.s);
  assert.deepEqual(JSON.parse(json), eng.s);
  const copy = new Engine(JSON.parse(json));
  copy.ensure();
  assert.equal(httpOk(copy, 'CORE-SRV', 'https://backup6.example.net/health'), true, 'a restored snapshot behaves the same');
});
