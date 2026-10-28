// Reliability fuzz: thousands of seeded random commands (valid, abbreviated, mutated, garbage, config sequences,
// "?" help, Tab completion) on every console in every incident start and in generated challenges.
// The simulator must never throw, must always answer with a list of lines, and its state must stay serialisable;
// read-only commands must never break a healthy network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { buildDistrict } from '../../src/content/district.js';
import { MISSIONS, buildMissionStart } from '../../src/content/missions.js';
import { rngFrom, randomParams, buildHealthy, healthReport, generateChallenge } from '../../src/content/challenges.js';
import { createSession, execute, complete } from '../../src/cli/index.js';

const IOS = [
  'enable', 'disable', 'show interfaces status', 'show ip interface brief', 'show ip interface', 'show ip route', 'show ip route 0.0.0.0',
  'show ip route static', 'show running-config', 'show running-config interface g0/X', 'show vlan brief', 'show interfaces trunk',
  'show spanning-tree', 'show spanning-tree vlan Y', 'show mac address-table', 'show mac address-table dynamic', 'show logging',
  'show cdp neighbors', 'show access-lists', 'show ip access-lists GUEST-IN', 'show ip nat translations', 'show ip dhcp snooping',
  'show processes cpu sorted', 'show interfaces g0/X', 'show interfaces g0/X switchport', 'show interfaces status err-disabled',
  'show cable-diagnostics tdr interface g0/X', 'test cable-diagnostics tdr interface g0/X', 'ping 10.42.10.10', 'ping 203.0.113.20 source g0/1',
  'traceroute 203.0.113.20', 'write memory', 'configure terminal', 'interface g0/X', 'interface range g0/1 - 4', 'interface g0/1.Y',
  'switchport access vlan Y', 'switchport mode trunk', 'switchport mode access', 'switchport trunk allowed vlan add Y',
  'switchport trunk allowed vlan remove Y', 'switchport trunk native vlan Y', 'no switchport trunk native vlan', 'shutdown', 'no shutdown',
  'speed 100', 'speed auto', 'duplex full', 'no duplex', 'spanning-tree portfast', 'spanning-tree portfast trunk', 'spanning-tree bpduguard enable',
  'spanning-tree vlan Y root primary', 'spanning-tree vlan Y root secondary', 'spanning-tree mode rapid-pvst', 'spanning-tree mode pvst',
  'no spanning-tree vlan Y', 'spanning-tree vlan Y', 'ip dhcp snooping', 'ip dhcp snooping vlan Y', 'no ip dhcp snooping information option',
  'ip dhcp snooping trust', 'ip access-list extended FUZZ', 'permit tcp any any established', 'deny ip any any log', 'permit udp any any eq bootps',
  'permit icmp any any echo-reply', '15 deny udp 10.42.Y.0 0.0.0.255 any range 1000 2000', 'no 10', 'ip access-group FUZZ in',
  'ip helper-address 10.42.10.10', 'no ip helper-address', 'ip address 10.42.Y.1 255.255.255.0', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1',
  'no ip route 0.0.0.0 0.0.0.0 198.51.100.5', 'ip route 0.0.0.0 0.0.0.0 g0/0', 'ip nat inside', 'no ip nat inside', 'ip proxy-arp', 'no ip unreachables',
  'vlan Y', 'name FUZZ', 'no vlan Y', 'exit', 'end', 'do show ip interface brief', '?', 'show ?', 'show ip ?', 'interface ?',
  'sh int st | include Gi0', 'sh run | section interface', 'sh run | begin router', 'sh log | exclude CDP',
];
const WIN = [
  'ipconfig', 'ipconfig /all', 'ipconfig /release', 'ipconfig /renew', 'ipconfig /flushdns', 'ipconfig /displaydns', 'ping 10.42.10.1',
  'ping -n 2 clinic.ops.example', 'tracert 203.0.113.20', 'tracert -d 10.42.10.10', 'pathping backup.example.net', 'nslookup clinic.ops.example',
  'nslookup portal.example.net 10.42.10.10', 'curl https://clinic.ops.example/health', 'curl -v https://backup.example.net/health',
  'curl -k https://10.42.10.20/', 'curl http://portal.example.net/', 'arp -a', 'route print', 'help', 'hostname', 'whoami', 'cls',
];
const LNX = [
  'systemctl status isc-dhcp-server', 'systemctl restart isc-dhcp-server', 'systemctl stop named', 'systemctl start named', 'systemctl reload named',
  'systemctl status nginx', 'journalctl -u isc-dhcp-server', 'journalctl -u named | tail -n 5', 'journalctl -u isc-dhcp-server | grep -i free',
  'cat /etc/dhcp/dhcpd.conf', 'dhcpd -t -cf /etc/dhcp/dhcpd.conf', 'named-checkzone ops.example /etc/bind/db.ops.example', 'rndc reload',
  'rndc reload ops.example', 'rndc reload nosuch.zone', 'dhcp-lease-list', 'ip a', 'ip route', 'ss -tulpn', 'dig clinic.ops.example',
  'dig @10.42.10.10 portal.example.net', 'nslookup clinic.ops.example', 'ping -c 2 10.42.10.1', 'traceroute 203.0.113.20',
  'curl https://clinic.ops.example/health', 'cat /etc/netplan/01-netcfg.yaml', 'netplan apply', 'help', 'ls', 'pwd', 'sudo -i',
  'nano /etc/dhcp/dhcpd.conf', 'cat /etc/bind/db.ops.example | grep clinic',
  'ip neigh', 'ip route get 10.42.10.1', 'ip route add default via 10.42.10.1', 'ip route replace default via 10.42.10.254', 'ip route del default', 'ip neigh flush all', 'tcpdump -n', 'arp -a',
];
const READ_ONLY = {
  ios: c => /^(show|sh |enable|disable|ping|traceroute|\?|do show)/.test(c) && !/test cable/.test(c),
  windows: c => /^(ipconfig( \/all| \/displaydns)?$|ping|tracert|pathping|nslookup|curl|arp|route print|help|hostname|whoami)/.test(c),
  linux: c => /^(systemctl status|journalctl|cat|dhcpd -t|named-checkzone|dhcp-lease-list|ip |ss |dig|nslookup|ping|traceroute|curl|help|ls|pwd)/.test(c) && !/^ip .*\b(add|del|replace|flush)\b/.test(c),
};
const JUNK = ['%', '$(rm -rf /)', '\u0000', '999.1.1.1', '-', '""', '|', '| include', '10.42.10.', 'g0/99', 'gi9/9/9', '4096', '-1', 'ÿ', '\t', '   '];

function mutate(cmd, rnd) {
  let c = cmd.replace(/X/g, () => String(Math.floor(rnd() * 30))).replace(/Y/g, () => String([1, 10, 20, 30, 40, 41, 0, 4094, 4095, 99999][Math.floor(rnd() * 10)]));
  const r = rnd();
  if (r < 0.15) c = c.split(' ').map(w => (w.length > 2 && rnd() < 0.6 ? w.slice(0, 1 + Math.floor(rnd() * (w.length - 1))) : w)).join(' ');
  else if (r < 0.25) c = `${c} ${JUNK[Math.floor(rnd() * JUNK.length)]}`;
  else if (r < 0.3) c = c.toUpperCase();
  else if (r < 0.35) c = JUNK[Math.floor(rnd() * JUNK.length)];
  else if (r < 0.38) c = '';
  else if (r < 0.42) c = `${c.split(' ').slice(0, -1).join(' ')} ?`;
  return c;
}

function fuzzEngine(eng, rnd, perDevice, { readOnly = false } = {}) {
  let n = 0;
  const devs = Object.values(eng.s.devices).filter(d => ['ios', 'windows', 'linux'].includes(d.os) && ['host', 'switch', 'router'].includes(d.kind) && d.powered !== false);
  for (const d of devs) {
    const pool = d.os === 'ios' ? IOS : d.os === 'windows' ? WIN : LNX;
    const sess = createSession(eng, d.id);
    for (let i = 0; i < perDevice; i++) {
      const base = pool[Math.floor(rnd() * pool.length)];
      if (readOnly && !READ_ONLY[d.os](base)) continue;
      const line = readOnly ? base.replace(/X/g, '1').replace(/Y/g, '10') : mutate(base, rnd);
      let r;
      try { r = execute(eng, sess, line); } catch (e) { assert.fail(`${d.id} threw on ${JSON.stringify(line)}: ${e.stack}`); }
      assert.ok(Array.isArray(r.lines), `${d.id}: ${JSON.stringify(line)} returned no lines array`);
      for (const l of r.lines) assert.ok(typeof l === 'string' || (l && typeof l.text === 'string'), `${d.id}: ${JSON.stringify(line)} returned a malformed line`);
      if (!readOnly && rnd() < 0.2) { try { complete(eng, sess, line.slice(0, Math.max(0, line.length - 2))); } catch (e) { assert.fail(`${d.id} Tab-completion threw on ${JSON.stringify(line)}: ${e.stack}`); } }
      n++;
    }
    if (!readOnly) { try { eng.advance(5 + Math.floor(rnd() * 40)); } catch (e) { assert.fail(`advance after ${d.id} commands threw: ${e.stack}`); } }
  }
  JSON.parse(JSON.stringify(eng.s));
  return n;
}

test('fuzz: every console in every incident start survives random, abbreviated and garbage commands', () => {
  const rnd = rngFrom(20261017);
  let total = 0;
  for (let i = 0; i < MISSIONS.length; i++) total += fuzzEngine(buildMissionStart(buildDistrict, Engine, i), rnd, 60);
  assert.ok(total > 8000, `ran ${total} commands`);
});

test('fuzz: generated challenges survive random commands, and time keeps running afterwards', () => {
  const rnd = rngFrom(4242);
  let total = 0;
  for (const seed of [3, 17, 27, 101]) {
    const ch = generateChallenge(seed, { faults: 2 });
    total += fuzzEngine(ch.eng, rnd, 40);
    ch.eng.advance(600);
  }
  assert.ok(total > 1000, `ran ${total} commands`);
});

test('fuzz: read-only commands never change a healthy network', () => {
  for (const seed of [5, 9]) {
    const eng = buildHealthy(randomParams(rngFrom(seed)));
    assert.ok(healthReport(eng).ok, 'healthy to begin with');
    const changes = eng.s.changeSeq;
    const n = fuzzEngine(eng, rngFrom(seed * 7), 120, { readOnly: true });
    assert.ok(n > 300, `ran ${n} read-only commands`);
    eng.advance(30);
    const h = healthReport(eng);
    assert.ok(h.ok, `still healthy: ${JSON.stringify(h.flows.filter(f => !f.ok))}`);
    assert.equal(eng.s.changeSeq, changes, 'no configuration change was recorded');
  }
});
