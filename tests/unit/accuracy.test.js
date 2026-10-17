// Networking-accuracy regressions: each test pins real device behaviour that an independent review found the
// simulator getting wrong (ACL `established`, NAT/ACL order, ICMP through PAT, RSTP, BIND reloads, IOS CLI...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { evalAcl } from '../../src/engine/routing.js';
import { resolveName } from '../../src/engine/services.js';
import { parseIp as ip } from '../../src/engine/ipv4.js';
import { parseAce } from '../../src/cli/ios.js';
import { saveFile } from '../../src/cli/index.js';
import { buildDistrict, dhcpdConf } from '../../src/content/district.js';
import { MISSIONS, cli, buildMissionStart, httpOk } from '../../src/content/missions.js';
import { Campaign } from '../../src/game/campaign.js';

const start = i => buildMissionStart(buildDistrict, Engine, i);
/** Whole campaign solved (the state players leave the night shift in). */
function solved() {
  const eng = start(9);
  MISSIONS[9].reference(eng);
  eng.advance(40);
  return eng;
}
const text = r => (r.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n');

test('ACL "established" matches only TCP segments with ACK or RST, and is kept, shown and combinable with log', () => {
  const ace = parseAce('extended', 'permit tcp any any established log'.split(' ')).ace;
  assert.equal(ace.established, true);
  assert.equal(ace.log, true);
  assert.equal(parseAce('extended', 'permit tcp any any log established'.split(' ')).ace.established, true);
  assert.equal(parseAce('extended', 'permit udp any any established'.split(' ')).errTok, 4, 'established is TCP-only');
  assert.equal(parseAce('standard', 'deny any log'.split(' ')).ace.log, true);
  const r = { acls: { T: { kind: 'extended', entries: [{ seq: 10, ...ace }] } } };
  const seg = flags => ({ src: ip('1.1.1.1'), dst: ip('2.2.2.2'), proto: 'tcp', sport: 443, dport: 50000, flags });
  assert.equal(evalAcl(r, 'T', seg(['syn'])).permit, false, 'a SYN opening a connection is not "established"');
  assert.equal(evalAcl(r, 'T', seg(['syn', 'ack'])).permit, true);
  assert.equal(evalAcl(r, 'T', seg(['rst', 'ack'])).permit, true);

  // Classic stateless edge filter: inbound on the WAN, allow only replies to connections we opened.
  const eng = solved();
  const run = cli(eng);
  run('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended WAN-IN', 'permit tcp any any established log', 'permit udp any eq domain any', 'exit', 'interface g0/0', 'ip access-group WAN-IN in', 'end');
  assert.ok(text(run('EDGE-RTR', 'show access-lists WAN-IN')).includes('10 permit tcp any any established log'));
  assert.ok(text(run('EDGE-RTR', 'show running-config')).includes(' permit tcp any any established log'));
  assert.equal(httpOk(eng, 'DISPATCH-01', 'https://backup.example.net/health'), true, 'the SYN-ACK of an outbound connection carries ACK');
  const inbound = eng.probe({ from: 'BACKUP', dst: ip('198.51.100.2'), proto: 'tcp', dport: 22 });
  assert.equal(inbound.status, 'timeout', 'an unsolicited inbound SYN is dropped');
  assert.equal(inbound.fwd.acl.name, 'WAN-IN');
});

test('IOS order of operations: outbound ACL on the NAT outside interface sees the inside-global source; inbound ACL runs before un-NAT', () => {
  const eng = solved();
  const run = cli(eng);
  const probe = () => eng.probe({ from: 'DISPATCH-01', dst: ip('203.0.113.20'), proto: 'tcp', dport: 443 });
  run('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended WAN-OUT', 'permit ip 10.42.10.0 0.0.0.255 any', 'exit', 'interface g0/0', 'ip access-group WAN-OUT out', 'end');
  const local = probe();
  assert.equal(local.status, 'timeout', 'inside-local source no longer exists after PAT');
  assert.equal(local.fwd.acl.implicit, true);
  run('EDGE-RTR', 'configure terminal', 'no ip access-list extended WAN-OUT', 'ip access-list extended WAN-OUT', 'permit ip host 198.51.100.2 any', 'end');
  assert.equal(probe().kind, 'syn-ack', 'the translated source matches');
  // Outside -> inside: the input ACL is checked against the inside-global destination, before un-NAT.
  run('EDGE-RTR', 'configure terminal', 'interface g0/0', 'no ip access-group WAN-OUT out', 'exit', 'ip access-list extended WAN-IN', 'permit ip any 10.42.0.0 0.0.255.255', 'exit', 'interface g0/0', 'ip access-group WAN-IN in', 'end');
  assert.equal(probe().replyLost, true, 'reply addressed to 198.51.100.2 hits the implicit deny');
  run('EDGE-RTR', 'configure terminal', 'ip access-list extended WAN-IN', 'permit ip any host 198.51.100.2', 'end');
  assert.equal(probe().kind, 'syn-ack');
});

test('PAT un-translates ICMP errors by their embedded header, so traceroute and port-unreachable work through NAT', () => {
  const eng = solved();
  for (const proto of ['udp', 'tcp', 'icmp']) {
    const r = eng.probe({ from: 'CLINIC-APP', dst: ip('203.0.113.20'), proto, dport: 33436, ttl: 2 });
    assert.equal(r.status, 'ok', `${proto} time-exceeded comes back through PAT`);
    assert.equal(r.kind, 'ttl-exceeded');
    assert.equal(r.responderIp, ip('198.51.100.1'));
  }
  const closed = eng.probe({ from: 'CLINIC-APP', dst: ip('203.0.113.20'), proto: 'udp', dport: 9999 });
  assert.equal(closed.kind, 'port-unreachable');
  const t = text(cli(eng)('CLINIC-APP', 'traceroute 203.0.113.20'));
  assert.match(t, /^ 2 {2}198\.51\.100\.1 /m);
  assert.match(t, /^ 3 {2}203\.0\.113\.20 /m);
});

test('Rapid PVST+: fast only via edge ports or proposal/agreement with an RSTP neighbour; 2 x forward delay otherwise', () => {
  const eng = solved();
  const run = cli(eng);
  const rec = (sw, p) => eng.s.stpState[sw][10][p];
  // Trunk to the router (no BPDUs) without PortFast: discarding 15 s -> learning 15 s -> forwarding.
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/1', 'no spanning-tree portfast', 'shutdown', 'no shutdown', 'end');
  eng.advance(1);
  assert.equal(rec('ACCESS-SW', 'Gi0/1').st, 'listening', 'timed discarding phase');
  assert.ok(text(run('ACCESS-SW', 'show spanning-tree vlan 10')).match(/^Gi0\/1 +Desg BLK/m), 'shown as BLK (discarding) in rapid-pvst');
  eng.advance(15);
  assert.equal(rec('ACCESS-SW', 'Gi0/1').st, 'learning');
  eng.advance(15);
  assert.equal(rec('ACCESS-SW', 'Gi0/1').st, 'forwarding');
  // A host port without PortFast is no faster.
  run('ACCESS-SW', 'configure terminal', 'interface g0/4', 'no spanning-tree portfast', 'shutdown', 'no shutdown', 'end');
  eng.advance(3);
  assert.notEqual(rec('ACCESS-SW', 'Gi0/4').st, 'forwarding');
  eng.advance(28);
  assert.equal(rec('ACCESS-SW', 'Gi0/4').st, 'forwarding');
  // PortFast trunk toward the router: edge, forwards at once.
  run('ACCESS-SW', 'configure terminal', 'interface g0/1', 'spanning-tree portfast trunk', 'shutdown', 'no shutdown', 'end');
  assert.equal(rec('ACCESS-SW', 'Gi0/1').st, 'forwarding');
  // Riser between two Rapid PVST+ switches: the designated port forwards after a ~1 s handshake.
  run('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/23', 'shutdown', 'no shutdown', 'end');
  eng.advance(2);
  assert.equal(rec('ACCESS-SW', 'Gi0/23').st, 'forwarding');
  // Legacy neighbour: the same designated port falls back to 802.1D timing, and IOS flags the peer.
  run('DIST-SW-B', 'configure terminal', 'spanning-tree mode pvst', 'interface g0/23', 'shutdown', 'no shutdown', 'end');
  eng.advance(2);
  assert.equal(rec('ACCESS-SW', 'Gi0/23').st, 'listening');
  assert.match(text(run('ACCESS-SW', 'show spanning-tree vlan 10')), /^Gi0\/23 .*P2p Peer\(STP\)$/m);
});

test('M06: riser failover is rapid only when both switches run Rapid PVST+, and the debrief names the mixed case', () => {
  const outcome = modes => {
    const eng = start(5);
    const camp = new Campaign(eng, { index: 5, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
    const run = cli(eng);
    for (const [sw, mode] of Object.entries(modes)) run(sw, 'enable', 'configure terminal', `spanning-tree mode ${mode}`, 'spanning-tree vlan 1-4094', 'end');
    eng.advance(31);
    camp.markBefore();
    run('NURSE-STATION', 'curl https://clinic.ops.example/health');
    let r = camp.evaluate('command');
    for (let k = 0; k < 200 && r.status !== 'won'; k++) { eng.advance(1); r = camp.tick() || r; }
    assert.equal(r.status, 'won');
    return r.result.outcome;
  };
  const both = outcome({ 'ACCESS-SW': 'rapid-pvst', 'DIST-SW-B': 'rapid-pvst' });
  assert.ok(both.outage <= 3, `both rapid: ${both.outage}`);
  assert.match(both.method, /Rapid PVST\+ on both/);
  // The alternate port sits on DIST-SW-B; if it is a legacy 802.1D bridge the new root port listens + learns.
  const mixed = outcome({ 'ACCESS-SW': 'rapid-pvst', 'DIST-SW-B': 'pvst' });
  assert.ok(mixed.outage >= 28 && mixed.outage <= 40, `mixed: ${mixed.outage}`);
  assert.match(mixed.method, /mixed modes \(DIST-SW-B still runs legacy/);
  assert.doesNotMatch(mixed.method, /rapid/i);
  assert.match(MISSIONS[5].hints[2], /BOTH switches/);
});

test('BIND: a failed reload keeps serving the last good zone; a zone that never loaded answers SERVFAIL, not NXDOMAIN', () => {
  const eng = solved();
  const run = cli(eng);
  const f = '/etc/bind/db.ops.example';
  const good = eng.s.devices['CORE-SRV'].files[f];
  saveFile(eng, 'CORE-SRV', f, good.replace('10.42.10.20', '10.42.10.300'));
  const rndc = text(run('CORE-SRV', 'rndc reload'));
  assert.match(rndc, /^server reload successful/, 'rndc only reports that named accepted the reload');
  const j = text(run('CORE-SRV', 'journalctl -u named -n 6'));
  assert.match(j, /dns_rdata_fromtext: \/etc\/bind\/db\.ops\.example:14: near '10\.42\.10\.300': bad dotted quad/);
  assert.match(j, /zone ops\.example\/IN: loading from master file \/etc\/bind\/db\.ops\.example failed: bad dotted quad/);
  assert.match(j, /zone ops\.example\/IN: not loaded due to errors\./);
  const stillGood = resolveName(eng, eng.s.devices['CLINIC-APP'], 'clinic.ops.example');
  assert.equal(stillGood.addr, ip('10.42.10.20'), 'old copy still served');
  assert.equal(stillGood.aa, true);
  // A restart throws the old copy away: names in the zone get SERVFAIL and are never forwarded upstream.
  run('CORE-SRV', 'systemctl restart named');
  const sf = resolveName(eng, eng.s.devices['CLINIC-APP'], 'clinic.ops.example');
  assert.equal(sf.rcode, 'SERVFAIL');
  assert.match(text(run('DISPATCH-01', 'nslookup clinic.ops.example')), /Server failed/);
  assert.equal(resolveName(eng, eng.s.devices['CLINIC-APP'], 'backup.example.net').ok, true, 'other names still resolve');
  saveFile(eng, 'CORE-SRV', f, good);
  run('CORE-SRV', 'rndc reload');
  assert.equal(resolveName(eng, eng.s.devices['CLINIC-APP'], 'clinic.ops.example').rcode, 'NOERROR');
});

test('err-disabled needs shutdown then no shutdown; BPDU guard needs a live link to hear a BPDU', () => {
  const eng = solved();
  const run = cli(eng);
  const p = eng.s.devices['ACCESS-SW'].ports['Gi0/2'];
  p.errDisabled = 'bpduguard';
  eng.mutated('test: err-disable', 'incident');
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/2', 'no shutdown', 'end');
  assert.equal(p.errDisabled, 'bpduguard', '"no shutdown" alone does not recover');
  assert.match(text(run('ACCESS-SW', 'show interfaces status err-disabled')), /^Gi0\/2 .*err-disabled bpduguard/m);
  run('ACCESS-SW', 'configure terminal', 'interface g0/2', 'shutdown', 'no shutdown', 'end');
  assert.equal(p.errDisabled, null);
  assert.equal(eng.portUp('ACCESS-SW', 'Gi0/2'), true);
  // A cut riser carries no BPDUs, so enabling BPDU guard on it does nothing until the link returns.
  const lid = eng.linkAt('ACCESS-SW', 'Gi0/24').id;
  eng.s.links[lid].cut = true;
  eng.mutated('test: cut riser B', 'incident');
  run('ACCESS-SW', 'configure terminal', 'interface g0/24', 'spanning-tree bpduguard enable', 'end');
  assert.equal(eng.s.devices['ACCESS-SW'].ports['Gi0/24'].errDisabled, null);
  eng.s.links[lid].cut = false;
  eng.mutated('test: riser B repaired', 'incident');
  assert.equal(eng.s.devices['ACCESS-SW'].ports['Gi0/24'].errDisabled, 'bpduguard');
});

test('teaching text matches the simulator: M02 parser line, M04 tracert, M08 subnet overlap', () => {
  // M02: dhcpd names line 14 (the "}") but the missing ";" ends line 13.
  let eng = start(1);
  const lines = eng.s.devices['CORE-SRV'].files['/etc/dhcp/dhcpd.conf'].split('\n');
  assert.equal(lines[13].trim(), '}');
  assert.ok(!lines[12].trim().endsWith(';'));
  assert.match(text(cli(eng)('CORE-SRV', 'dhcpd -t -cf /etc/dhcp/dhcpd.conf')), /line 14: semicolon expected/);
  assert.match(MISSIONS[1].hints[2], /line 13/);
  assert.doesNotMatch(MISSIONS[1].hints[2], /on the line the log names/);
  // M04: hop 1 is the gateway, hop 2 is the gateway reporting net unreachable.
  eng = start(3);
  const tr = text(cli(eng)('DISPATCH-01', 'tracert 203.0.113.20'));
  assert.match(tr, /^ +1 .*10\.42\.10\.1$/m);
  assert.match(tr, /^ +2 {2}10\.42\.10\.1 {2}reports: Destination net unreachable\.$/m);
  assert.match(MISSIONS[3].debrief.evidence, /hop 2 "10\.42\.10\.1 reports: Destination net unreachable\."/);
  assert.doesNotMatch(MISSIONS[3].debrief.evidence, /ended at hop 1/);
  // M08: 10.42.40.0/26 (.0-.63) does not overlap the door /27 (.64-.95); 10.42.40.0/25 does.
  eng = start(7);
  const run = cli(eng);
  assert.match(text(run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.40', 'ip address 10.42.40.1 255.255.255.128')), /overlaps with GigabitEthernet0\/1\.41/);
  assert.equal(text(run('EDGE-RTR', 'ip address 10.42.40.1 255.255.255.192', 'end')), '');
  saveFile(eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', dhcpdConf(eng.s.params, { camNet: '10.42.40.0', camMask: '255.255.255.192', camRange: ['10.42.40.10', '10.42.40.62'], camGw: '10.42.40.1' }));
  run('CORE-SRV', 'systemctl restart isc-dhcp-server');
  run('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/4', 'shutdown', 'no shutdown', 'end');
  eng.advance(5);
  assert.ok([...MISSIONS[7].goals, ...MISSIONS[7].constraints].every(g => g.check(eng)), '10.42.40.0/26 is a valid M08 fix');
  assert.doesNotMatch(MISSIONS[7].hints[1], /10\.42\.40\.0\/26 or \/25 would overlap/);
  assert.match(MISSIONS[7].hints[1], /10\.42\.40\.0\/26 \(\.0–\.63\)/);
});

test('static route to an exit interface only: shown as directly connected, ARPs for the destination, needs proxy ARP', () => {
  const eng = start(3);
  const run = cli(eng);
  run('EDGE-RTR', 'enable', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 198.51.100.5', 'ip route 0.0.0.0 0.0.0.0 g0/0', 'end');
  const rt = text(run('EDGE-RTR', 'show ip route'));
  assert.match(rt, /Gateway of last resort is 0\.0\.0\.0 to network 0\.0\.0\.0/);
  assert.match(rt, /^S\* {4}0\.0\.0\.0\/0 is directly connected, GigabitEthernet0\/0$/m);
  assert.doesNotMatch(rt, /via 0\.0\.0\.0/);
  const r = eng.probe({ from: 'DISPATCH-01', dst: ip('203.0.113.20'), proto: 'icmp' });
  assert.equal(r.status, 'timeout');
  assert.match(r.fwd.reason, /ARP for next hop 203\.0\.113\.20 failed/, 'ARPs for the destination itself, never for 0.0.0.0');
  assert.ok(r.fwd.notes.some(n => /needs proxy ARP/.test(n.text)));
  assert.equal(eng.s.devices['ISP-PE'].ports['Gi0/0'].proxyArp, false, 'documented choice: the provider edge does not proxy-ARP');
  run('EDGE-RTR', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 g0/0', 'ip route 0.0.0.0 0.0.0.0 g0/0 198.51.100.1', 'end');
  assert.match(text(run('EDGE-RTR', 'show ip route')), /^S\* {4}0\.0\.0\.0\/0 \[1\/0\] via 198\.51\.100\.1, GigabitEthernet0\/0$/m);
  assert.equal(httpOk(eng, 'DISPATCH-01', 'https://backup.example.net/health'), true);
});

test('DNS server down vs path down: ICMP port unreachable is "connection refused", silence is a timeout', () => {
  const eng = solved();
  const run = cli(eng);
  run('CORE-SRV', 'systemctl stop named');
  const dig = text(run('CLINIC-APP', 'dig clinic.ops.example'));
  assert.equal((dig.match(/;; communications error to 10\.42\.10\.10#53: connection refused/g) || []).length, 3);
  assert.match(dig, /;; no servers could be reached/);
  assert.equal(resolveName(eng, eng.s.devices['DISPATCH-01'], 'clinic.ops.example').error, 'refused');
  const ns = text(run('DISPATCH-01', 'nslookup clinic.ops.example'));
  assert.match(ns, /No response from server/);
  assert.match(ns, /nothing listens on UDP 53/);
  // Path down instead (server unplugged): no ICMP at all, so the client times out.
  run('CORE-SRV', 'systemctl start named');
  run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/3', 'shutdown', 'end');
  assert.match(text(run('CLINIC-APP', 'dig clinic.ops.example')), /#53: timed out/);
});

test('spanning-tree vlan root primary undercuts a lower root priority; root secondary sets 28672', () => {
  const eng = solved();
  const run = cli(eng);
  const prio = (sw, v) => eng.s.devices[sw].stp.priority[v];
  run('ACCESS-SW', 'enable', 'configure terminal', 'spanning-tree vlan 10 priority 8192', 'end');
  run('DIST-SW-B', 'enable', 'configure terminal', 'spanning-tree vlan 10,20 root primary', 'end');
  assert.equal(prio('DIST-SW-B', 10), 4096, '4096 below the current root (8192)');
  assert.equal(prio('DIST-SW-B', 20), 24576, 'current root at the default: 24576 is enough');
  assert.equal(eng.stpInfo[10].rootOf['ACCESS-SW'], 'DIST-SW-B');
  assert.equal(eng.stpInfo[20].rootOf['ACCESS-SW'], 'DIST-SW-B');
  run('ACCESS-SW', 'configure terminal', 'spanning-tree vlan 30 root secondary', 'end');
  assert.equal(prio('ACCESS-SW', 30), 28672);
  assert.match(text(run('DIST-SW-B', 'show running-config')), /^spanning-tree vlan 10 priority 4096$/m);
});

test('valid IOS show/ping commands work or answer with a labelled training-image note, never a fake syntax error', () => {
  const eng = solved();
  const run = cli(eng);
  const sw = c => text(run('ACCESS-SW', 'enable', c));
  const rt = c => text(run('EDGE-RTR', 'enable', c));
  assert.match(sw('show running-config interface g0/1'), /^interface GigabitEthernet0\/1\n description UPLINK EDGE-RTR\n[\s\S]* spanning-tree portfast trunk\n[\s\S]*\nend$/m);
  assert.match(sw('show mac address-table dynamic vlan 30'), /DYNAMIC +Gi0\/6/);
  assert.match(sw('show interfaces g0/6 switchport'), /Administrative Mode: static access\nOperational Mode: static access[\s\S]*Access Mode VLAN: 30 \(GUEST\)/);
  assert.match(sw('show interfaces g0/1 switchport'), /Operational Mode: trunk[\s\S]*Trunking VLANs Enabled: 10,20,30,40-41/);
  assert.match(sw('show interfaces g0/2 status'), /^Gi0\/2 +DISPATCH-01 +connected/m);
  assert.match(rt('show ip access-lists GUEST-IN'), /^Extended IP access list GUEST-IN$/m);
  assert.match(rt('show ip route 203.0.113.20'), /^Routing entry for 0\.0\.0\.0\/0, supernet\n {2}Known via "static", distance 1, metric 0, candidate default path\n[\s\S]*\* 198\.51\.100\.1$/m);
  assert.match(rt('show ip route 10.42.30.7'), /Routing entry for 10\.42\.30\.0\/24[\s\S]*directly connected, via GigabitEthernet0\/1\.30/);
  assert.match(rt('show ip route static'), /^S\* {4}0\.0\.0\.0\/0/m);
  assert.doesNotMatch(rt('show ip route static'), /^C /m);
  const ipint = rt('show ip interface g0/1.30');
  assert.match(ipint, /Helper address is 10\.42\.10\.10/);
  assert.match(ipint, /Inbound {2}access list is GUEST-IN/);
  assert.match(rt('ping 203.0.113.20 source 198.51.100.2'), /Packet sent with a source address of 198\.51\.100\.2[\s\S]*!!!!!/);
  assert.match(rt('ping 203.0.113.20 source g0/1.10'), /Packet sent with a source address of 10\.42\.10\.1[\s\S]*Success rate is 0 percent/, 'router-sourced traffic is not NATed');
  // "show ip protocols" is simulated since the OSPF build (Act II): with no routing protocol IOS prints only the NSF banner.
  assert.match(rt('show ip protocols'), /^\*\*\* IP Routing is NSF aware \*\*\*$/m);
  for (const [dev, c] of [['ACCESS-SW', 'show spanning-tree interface g0/1'], ['ACCESS-SW', 'show ip dhcp snooping binding'], ['ACCESS-SW', 'show errdisable recovery'], ['EDGE-RTR', 'show ip nat statistics']]) {
    const out = text(run(dev, c));
    assert.doesNotMatch(out, /Invalid input/, c);
    assert.match(out, /training image: .* is valid IOS but is not simulated here/, c);
  }
});

test('M10: snooping option 82 with giaddr 0 is dropped by the IOS relay unless insertion is off or the relay trusts it', () => {
  const eng = start(9);
  const run = cli(eng);
  const kiosk = () => eng.s.devices['GUEST-KIOSK'].lease;
  run('ACCESS-SW', 'enable', 'configure terminal', 'ip dhcp snooping', 'ip dhcp snooping vlan 30', 'interface g0/1', 'ip dhcp snooping trust', 'end');
  assert.match(text(run('ACCESS-SW', 'show ip dhcp snooping')), /Insertion of option 82 is enabled/);
  const r = text(run('GUEST-KIOSK', 'ipconfig /release', 'ipconfig /renew'));
  assert.match(r, /unable to contact your DHCP server/);
  assert.match(r, /relay dropped the request: option 82/);
  assert.equal(kiosk(), null);
  // Either fix works: trust relay information on the relay interface...
  run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.30', 'ip dhcp relay information trusted', 'end');
  run('GUEST-KIOSK', 'ipconfig /renew');
  assert.equal(kiosk()?.serverDev, 'CORE-SRV');
  // ...or stop the switch inserting option 82 (the reference fix).
  run('EDGE-RTR', 'configure terminal', 'interface g0/1.30', 'no ip dhcp relay information trusted', 'end');
  run('ACCESS-SW', 'configure terminal', 'no ip dhcp snooping information option', 'end');
  assert.match(text(run('ACCESS-SW', 'show ip dhcp snooping')), /Insertion of option 82 is disabled/);
  assert.match(text(run('ACCESS-SW', 'show running-config')), /^no ip dhcp snooping information option$/m);
  run('GUEST-KIOSK', 'ipconfig /release', 'ipconfig /renew');
  assert.equal(kiosk()?.serverDev, 'CORE-SRV');
  assert.match(MISSIONS[9].hints[2], /no ip dhcp snooping information option/);
});

test('low-severity IOS defaults: UDP to a router address gets port unreachable; new subinterfaces keep proxy ARP on', () => {
  const eng = solved();
  const r = eng.probe({ from: 'CLINIC-APP', dst: ip('10.42.10.1'), proto: 'udp', dport: 33434 });
  assert.equal(r.kind, 'port-unreachable', 'not a TCP reset');
  const run = cli(eng);
  run('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1.50', 'encapsulation dot1Q 50', 'ip address 10.42.50.1 255.255.255.0', 'end');
  const cfg = text(run('EDGE-RTR', 'show running-config interface g0/1.50'));
  assert.doesNotMatch(cfg, /no ip proxy-arp/);
  assert.match(text(run('EDGE-RTR', 'show ip interface g0/1.50')), /Proxy ARP is enabled/);
});
