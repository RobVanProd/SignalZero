// Reliability fuzz for the IPv6 commands: seeded random IPv6 commands (valid, abbreviated, mutated, garbage, config
// sequences, "?" help, Tab completion) on every console at the M11 start, after the M11 fix and in a generated
// challenge. The simulator must never throw, always answer with a lines array, and keep its state serialisable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { buildDistrict } from '../../src/content/district.js';
import { MISSIONS, buildMissionStart } from '../../src/content/missions.js';
import { rngFrom, generateChallenge, buildHealthy, randomParams, healthReport } from '../../src/content/challenges.js';
import { createSession, execute, complete } from '../../src/cli/index.js';

const IOS6 = [
  'enable', 'configure terminal', 'ipv6 unicast-routing', 'no ipv6 unicast-routing', 'interface g0/X', 'interface g0/1.Y',
  'ipv6 address 2001:db8:42:Y::1/64', 'ipv6 address 2001:db8:42:Y::/64 eui-64', 'ipv6 address fe80::1 link-local', 'ipv6 address 2001:db8:42:Y::1/56',
  'ipv6 address 2001:db8:ffff:1::2/64', 'no ipv6 address', 'no ipv6 address 2001:db8:42:Y::1/64', 'ipv6 enable', 'no ipv6 enable',
  'ipv6 nd ra suppress', 'ipv6 nd ra suppress all', 'no ipv6 nd ra suppress', 'ipv6 nd ra dns server 2001:db8::53 600',
  'ipv6 traffic-filter FUZZ6 in', 'ipv6 traffic-filter FUZZ6 out', 'no ipv6 traffic-filter FUZZ6 in', 'exit', 'end',
  'ipv6 route ::/0 2001:db8:ffff:1::1', 'ipv6 route ::/0 fe80::1', 'ipv6 route ::/0 g0/0 fe80::1', 'ipv6 route ::/0 g0/0', 'ipv6 route 2001:db8:abcd::/48 2001:db8:42:Y::5 250',
  'no ipv6 route ::/0', 'no ipv6 route ::/0 2001:db8:ffff:1::1', 'ipv6 access-list FUZZ6', 'permit tcp any any eq 443', 'deny ipv6 any any log',
  'permit icmp any any nd-na', 'sequence 5 permit icmp any any nd-ns', 'permit udp 2001:db8:42:Y::/64 host 2001:db8:203::53 eq domain', 'permit tcp any any established',
  'deny tcp host 2001:db8::1 eq 80 any', 'no sequence 5', 'remark fuzz', 'no permit tcp any any eq 443', 'no ipv6 access-list FUZZ6',
  'show ipv6 interface brief', 'show ipv6 interface', 'show ipv6 interface g0/X', 'show ipv6 route', 'show ipv6 route static', 'show ipv6 route local',
  'show ipv6 route connected', 'show ipv6 route 2001:db8:203::20', 'show ipv6 neighbors', 'show ipv6 access-list', 'show ipv6 access-list FUZZ6',
  'show running-config', 'ping 2001:db8:203::20', 'ping ipv6 2001:db8:42:Y::1', 'ping fe80::1', 'g0/0', 'traceroute 2001:db8:203::20',
  'ping 2001:db8:203::20 source g0/1.Y', 'show ipv6 ?', 'ipv6 ?', 'ipv6 route ?', 'do show ipv6 route', 'show ipv6 protocols', 'clear ipv6 neighbors',
];
const WIN6 = [
  'ipconfig', 'ipconfig /all', 'ipconfig /renew6', 'ping -6 backup6.example.net', 'ping -4 portal.example.net', 'ping 2001:db8:203::20',
  'ping fe80::1%7', 'ping -6 -n 2 2001:db8:42:Y::1', 'tracert -6 backup6.example.net', 'tracert -d -6 2001:db8:203::80', 'nslookup backup6.example.net',
  'nslookup -type=AAAA portal.example.net', 'nslookup -type=A backup6.example.net', 'curl -6 https://backup6.example.net/health', 'curl -v https://portal.example.net/',
  'curl -4 https://backup6.example.net/health', 'curl -k https://[2001:db8:203::20]/health', 'curl https://[zz::1]/', 'route print -6', 'route print -4', 'route print',
  'netsh interface ipv6 show neighbors', 'netsh int ipv6 sh addr', 'netsh interface ipv6 show route', 'netsh interface ipv4 show neighbors', 'ipconfig /displaydns', 'ipconfig /flushdns',
];
const LNX6 = [
  'ip -6 a', 'ip -6 addr', 'ip -6 route', 'ip -6 r', 'ip -6 neigh', 'ip n', 'ip -4 a', 'ip a', 'ping -6 -c 2 backup6.example.net', 'ping6 -c 1 2001:db8:203::20',
  'ping -4 -c 1 backup6.example.net', 'ping -c 1 fe80::1', 'traceroute -6 backup6.example.net', 'traceroute6 2001:db8:203::80', 'dig AAAA backup6.example.net',
  'dig +short AAAA portal.example.net', 'dig @2001:db8:42:Y::10 clinic.ops.example', 'nslookup portal.example.net', 'nslookup backup6.example.net 2001:db8:203::53',
  'curl -6 https://backup6.example.net/health', 'curl -v https://portal.example.net/', 'curl -v -4 https://portal.example.net/', 'curl -k https://[2001:db8:203::20]/health',
  'ss -tulpn', 'cat /etc/netplan/01-netcfg.yaml', 'netplan apply',
];
const JUNK = ['::', ':::', '2001:db8::/129', 'fe80::1%', '%eth0', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '1.2.3.4::', '[::1]', '0/0', '-6', '-4', 'zz::', '\u0000', '?'];

function mutate(cmd, rnd) {
  let c = cmd.replace(/X/g, () => String(Math.floor(rnd() * 4))).replace(/Y/g, () => String([10, 20, 30, 40, 41, 0, 4094, 99][Math.floor(rnd() * 8)]));
  const r = rnd();
  if (r < 0.15) c = c.split(' ').map(w => (w.length > 2 && !w.includes(':') && rnd() < 0.6 ? w.slice(0, 1 + Math.floor(rnd() * (w.length - 1))) : w)).join(' ');
  else if (r < 0.27) c = `${c} ${JUNK[Math.floor(rnd() * JUNK.length)]}`;
  else if (r < 0.32) c = c.toUpperCase();
  else if (r < 0.38) c = c.replace(/[0-9a-f]{1,4}::/, () => JUNK[Math.floor(rnd() * JUNK.length)]);
  else if (r < 0.42) c = JUNK[Math.floor(rnd() * JUNK.length)];
  else if (r < 0.45) c = `${c.split(' ').slice(0, -1).join(' ')} ?`;
  return c;
}

function fuzz(eng, rnd, perDevice) {
  let n = 0;
  const devs = Object.values(eng.s.devices).filter(d => ['ios', 'windows', 'linux'].includes(d.os) && ['host', 'router', 'switch'].includes(d.kind) && d.powered !== false);
  for (const d of devs) {
    const pool = d.os === 'ios' ? IOS6 : d.os === 'windows' ? WIN6 : LNX6;
    const sess = createSession(eng, d.id);
    for (let i = 0; i < perDevice; i++) {
      const line = mutate(pool[Math.floor(rnd() * pool.length)], rnd);
      let r;
      try { r = execute(eng, sess, line); } catch (e) { assert.fail(`${d.id} threw on ${JSON.stringify(line)}: ${e.stack}`); }
      assert.ok(Array.isArray(r.lines), `${d.id}: ${JSON.stringify(line)} returned no lines array`);
      for (const l of r.lines) assert.ok(typeof l === 'string' || (l && typeof l.text === 'string'), `${d.id}: ${JSON.stringify(line)} returned a malformed line`);
      if (rnd() < 0.15) { try { complete(eng, sess, line.slice(0, Math.max(0, line.length - 2))); } catch (e) { assert.fail(`${d.id} Tab-completion threw on ${JSON.stringify(line)}: ${e.stack}`); } }
      n++;
    }
    try { eng.advance(5 + Math.floor(rnd() * 250)); } catch (e) { assert.fail(`advance after ${d.id} commands threw: ${e.stack}`); }
  }
  const json = JSON.stringify(eng.s, (k, v) => { if (typeof v === 'bigint' || v instanceof Map || v instanceof Set) throw new Error(`non-JSON value at ${k}`); return v; });
  JSON.parse(json);
  return n;
}

const M11 = MISSIONS.findIndex(m => m.id === 'M11');

test('fuzz IPv6: consoles at the M11 start and after its fix survive random IPv6 commands', () => {
  const rnd = rngFrom(6666);
  let total = 0;
  const a = buildMissionStart(buildDistrict, Engine, M11);
  total += fuzz(a, rnd, 70);
  const b = buildMissionStart(buildDistrict, Engine, M11);
  MISSIONS[M11].reference(b);
  total += fuzz(b, rnd, 70);
  assert.ok(total > 2000, `ran ${total} commands`);
});

test('fuzz IPv6: generated challenges survive random IPv6 commands and keep running', () => {
  const rnd = rngFrom(9119);
  let total = 0;
  for (const seed of [11, 64]) {
    const ch = generateChallenge(seed, { faults: 2 });
    total += fuzz(ch.eng, rnd, 30);
    ch.eng.advance(900);
  }
  assert.ok(total > 600, `ran ${total} commands`);
});

test('fuzz IPv6: read-only IPv6 commands never change a healthy dual-stack network', () => {
  const eng = buildHealthy(randomParams(rngFrom(77)));
  assert.ok(healthReport(eng).ok);
  const changes = eng.s.changeSeq;
  const RO = { ios: c => /^(enable|show|ping|traceroute|g0\/0|do show|clear ipv6 neighbors)/.test(c), windows: c => !/flushdns|renew/.test(c), linux: c => !/netplan apply/.test(c) };
  const rnd = rngFrom(78);
  for (const d of Object.values(eng.s.devices).filter(x => ['ios', 'windows', 'linux'].includes(x.os) && ['host', 'router'].includes(x.kind) && x.powered !== false)) {
    const pool = (d.os === 'ios' ? IOS6 : d.os === 'windows' ? WIN6 : LNX6).filter(RO[d.os]);
    const sess = createSession(eng, d.id);
    for (let i = 0; i < 25; i++) execute(eng, sess, pool[Math.floor(rnd() * pool.length)].replace(/X/g, '1').replace(/Y/g, '10'));
  }
  eng.advance(60);
  assert.equal(eng.s.changeSeq, changes, 'no configuration change was recorded');
  const h = healthReport(eng);
  assert.ok(h.ok, JSON.stringify(h.flows.filter(f => !f.ok)));
});
