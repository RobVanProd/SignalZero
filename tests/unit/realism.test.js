// Regression tests for the second realism pass (review findings 10, 15, 17, 18 and IOS privilege levels).
// Each test fails on the engine before that pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { buildDistrict, dhcpdConf, net } from '../../src/content/district.js';
import { MISSIONS, cli, buildMissionStart } from '../../src/content/missions.js';
import { parseZone } from '../../src/engine/parsers/zone.js';
import { parseDhcpd } from '../../src/engine/parsers/dhcpd.js';
import { saveFile } from '../../src/cli/index.js';
import { parseIp } from '../../src/engine/ipv4.js';

const text = r => (r.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n');
const start = i => { const eng = buildMissionStart(buildDistrict, Engine, i); return { eng, run: cli(eng) }; };
const solved = i => { const s = start(i); MISSIONS[i].reference(s.eng); s.eng.advance(40); return s; };

test('finding 10: a native VLAN mismatch on PVST+ trunks blocks both VLANs (PVID-inconsistent) instead of leaking', () => {
  const { eng, run } = solved(9);
  run('DIST-SW-B', 'enable', 'configure terminal', 'interface range g0/23 - 24', 'switchport trunk native vlan 10', 'switchport trunk allowed vlan add 1', 'end');
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface range g0/23 - 24', 'switchport trunk allowed vlan add 1', 'end');
  eng.advance(40);
  const fl = eng.flood('NURSE-STATION', 'eth0', null);
  assert.ok(!fl.endpoints.some(e => ['EDGE-RTR', 'DISPATCH-01', 'CORE-SRV', 'NURSE-STATION'].includes(e.dev)), `ward VLAN 10 frames must not cross into VLAN 1 and back (reached ${fl.endpoints.map(e => e.dev).join(',')})`);
  const stp = text(run('DIST-SW-B', 'show spanning-tree vlan 10'));
  assert.match(stp, /Gi0\/23\s+Desg BKN\*/);
  assert.match(stp, /\*PVID_Inc/);
  assert.match(text(run('DIST-SW-B', 'show logging')), /%SPANTREE-2-RECV_PVID_ERR: Received BPDU with inconsistent peer vlan id 1 on GigabitEthernet0\/23 VLAN10/);
  // matching the native VLANs restores the port
  run('DIST-SW-B', 'configure terminal', 'interface range g0/23 - 24', 'no switchport trunk native vlan', 'end');
  eng.advance(40);
  assert.doesNotMatch(text(run('DIST-SW-B', 'show spanning-tree vlan 10')), /BKN/);
  assert.match(text(run('DIST-SW-B', 'show logging')), /UNBLOCK_CONSIST_PORT/);
});

test('finding 18: a lease renewal is a unicast to the server, so an inbound ACL that denies guests -> inside drops it unless DHCP is permitted', () => {
  const { eng, run } = solved(4);
  const k = eng.s.devices['GUEST-KIOSK'];
  const guestNet = parseIp(net(eng.s.params, 'guest', 0));
  assert.equal(k.lease.addr >>> 8, guestNet >>> 8, 'reference fix gave the kiosk a guest address');
  // the reference ACL permits bootps first; take that line out
  const acl = text(run('EDGE-RTR', 'enable', 'show access-lists GUEST-IN'));
  const seq = /(\d+) permit udp any any eq bootps/.exec(acl)?.[1];
  assert.ok(seq, `reference ACL permits DHCP: ${acl}`);
  run('EDGE-RTR', 'configure terminal', 'ip access-list extended GUEST-IN', `no ${seq}`, 'end');
  const before = k.lease.addr;
  const r = run('GUEST-KIOSK', 'ipconfig /renew');
  assert.match(text(r), /unable to contact your DHCP server/);
  assert.equal(k.lease.addr, before, 'the unexpired lease is kept');
  run('EDGE-RTR', 'configure terminal', 'ip access-list extended GUEST-IN', '5 permit udp any any eq bootps', 'end');
  assert.doesNotMatch(text(run('GUEST-KIOSK', 'ipconfig /renew')), /unable to contact/);
});

test('finding 18: cameras renew by unicast at T1 through their old gateway (fails), rebind at T2 (NAK, new scope); a PoE bounce is immediate', () => {
  const setup = () => {
    const { eng, run } = start(7);
    const p = eng.s.params;
    run('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${p.vlans.cams}`, `ip address ${net(p, 'cams', 129)} 255.255.255.192`, 'end');
    saveFile(eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', dhcpdConf(p, { camNet: net(p, 'cams', 128), camMask: '255.255.255.192', camRange: [net(p, 'cams', 140), net(p, 'cams', 190)], camGw: net(p, 'cams', 129) }));
    run('CORE-SRV', 'systemctl restart isc-dhcp-server');
    return { eng, run, cams: eng.s.devices.CAMERAS, newNet: parseIp(net(p, 'cams', 128)) };
  };
  const inNew = (c, newNet) => (c.addr >>> 6) === (newNet >>> 6);
  {
    const { eng, cams, newNet } = setup();
    const m = cams.leases[0];
    const lt = m.leaseTime ?? 600;
    // fleet DHCP runs every 60 s: 90 s past T1 the renewal has certainly been tried
    eng.advance(m.obtained + lt * 0.5 - eng.s.t + 90);
    assert.ok(!inNew(cams.leases.find(x => x.mac === m.mac), newNet), 'past T1 the unicast renewal via the old gateway has failed: old address kept');
    eng.advance(m.obtained + lt * 0.875 - eng.s.t + 90);
    assert.ok(inNew(cams.leases.find(x => x.mac === m.mac), newNet), 'past T2 the broadcast rebind is NAKed and the camera re-acquires in the new scope');
  }
  {
    const { eng, run, cams, newNet } = setup();
    run('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/4', 'shutdown', 'no shutdown', 'end');
    eng.advance(3);
    assert.ok(cams.leases.length >= 50 && cams.leases.every(c => inNew(c, newNet)), 'link bounce: INIT-REBOOT, NAK, DORA at once');
  }
});

test('finding 17: "authoritative;" decides between NAK and silence for a request from the wrong network', () => {
  for (const auth of [true, false]) {
    const { eng, run } = solved(1);
    const conf = dhcpdConf(eng.s.params);
    assert.match(conf, /^authoritative;$/m);
    if (!auth) { saveFile(eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', conf.replace(/^authoritative;$/m, '#authoritative;')); run('CORE-SRV', 'systemctl restart isc-dhcp-server'); }
    // DISPATCH-01's switch port moves to the guest VLAN and bounces: INIT-REBOOT for its clinic address via the guest relay
    run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/2', `switchport access vlan ${eng.s.params.vlans.guest}`, 'shutdown', 'no shutdown', 'end');
    const j = text(run('CORE-SRV', 'journalctl -u isc-dhcp-server'));
    if (auth) assert.match(j, /DHCPNAK on [\d.]+ to .*wrong network|wrong network/);
    else assert.match(j, /ignored \(not authoritative\)/);
  }
});

test('finding 15: valid zone-file and dhcpd.conf syntax is accepted; invalid syntax still errors', () => {
  const z = s => parseZone(s, 'ops.example', 'db.ops.example');
  const soa = '@ IN SOA ns1.ops.example. hostmaster.ops.example. ( 2026101501 1h 15m 1w 5m )\n@ IN NS ns1\nns1 IN A 10.42.10.10\nclinic IN A 10.42.10.20\n';
  assert.ok(z(`$TTL 1D\n${soa}`).ok, '$TTL with a unit and SOA timers with units');
  assert.ok(z(`$TTL 1h30m\n${soa}`).ok, 'combined units');
  const noTtl = z(soa);
  assert.ok(noTtl.ok, 'no $TTL: BIND falls back to the SOA minimum');
  assert.equal(noTtl.records.find(r => r.name === 'clinic.ops.example').ttl, 300, 'SOA MINIMUM 5m = 300 s');
  assert.ok(!z(`$TTL 1D\n${soa}clinic IN A 10.42.10.300\n`).ok, 'a bad dotted quad is still an error');
  const d = parseDhcpd(`authoritative;\nddns-update-style none;\nping-check true;\nping-timeout 1;\none-lease-per-client true;\nlog-facility local7;\noption domain-search "ops.example";\noption ntp-servers 10.42.10.10;\noption tftp-server-name "10.42.10.10";\nsubnet 10.42.10.0 netmask 255.255.255.0 {\n  option routers 10.42.10.1;\n  pool {\n    range 10.42.10.100 10.42.10.199;\n  }\n  range dynamic-bootp 10.42.10.200 10.42.10.210;\n}\n`);
  assert.ok(d.ok, `valid ISC syntax accepted: ${d.errors.join(' | ')}`);
  assert.ok(!parseDhcpd('subnet 10.42.10.0 netmask 255.255.255.0 {\n  option routers 10.42.10.1\n}\n').ok, 'a missing semicolon is still an error');
});

test('IOS privilege levels: cable diagnostics are privileged EXEC, so user mode gets invalid input', () => {
  const { run } = start(0);
  const r = text(run('ACCESS-SW', 'show cable-diagnostics tdr interface g0/1'));
  assert.match(r, /% Invalid input detected at '\^' marker/);
  assert.match(text(run('ACCESS-SW', 'enable', 'show cable-diagnostics tdr interface g0/1')), /TDR test|Interface Speed|has not been run|No TDR/i);
});
