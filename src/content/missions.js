// The night-shift campaign. Every goal is a behavioural check against the engine (does the traffic
// actually flow / is it actually blocked?), never a check of one specific config line, so any correct
// fix passes and a "fix" that breaks something else fails the constraints.
import { parseIp as ip, inSubnet, fmtIp } from '../engine/ipv4.js';
import { hostAddr, l3Ifaces } from '../engine/routing.js';
import { httpRequest, dhcpDryRun, dhcpClient, applyDhcpResult } from '../engine/services.js';
import { device, addPort, link } from '../engine/model.js';
import { net, patchConnect, dhcpdConf, zoneFile } from './district.js';
import { createSession, execute, saveFile } from '../cli/index.js';

const A = (eng, role, host) => ip(net(eng.s.params, role, host));
const V = (eng, role) => eng.s.params.vlans[role];

/** Run CLI lines on a device (used by reference solutions and tests). */
export function cli(eng) {
  const S = {};
  return (dev, ...lines) => {
    let r;
    for (const line of lines) {
      S[dev] ||= createSession(eng, dev);
      r = execute(eng, S[dev], line);
    }
    return r;
  };
}

export function httpOk(eng, from, url) {
  const d = eng.s.devices[from];
  if (!d || d.powered === false) return false;
  return !!httpRequest(eng, d, url, { noCache: true }).ok;
}

export function reaches(eng, from, dst, proto = 'icmp', port) {
  const r = eng.probe({ from, dst, proto, dport: port });
  if (r.status !== 'ok') return false;
  if (proto === 'tcp') return r.kind === 'syn-ack';
  if (proto === 'udp') return r.kind === 'udp-reply';
  return r.kind === 'reply';
}

export function leaseIn(eng, hostId, role) {
  const d = eng.s.devices[hostId];
  if (!d?.lease || d.lease.serverDev !== 'CORE-SRV') return false;
  return inSubnet(d.lease.addr, A(eng, role, 0), 24) && eng.portUp(d.id, d.nic);
}

export function flowDefs(eng) {
  return {
    clinic: { id: 'clinic', label: 'Dispatch → clinic records', from: 'DISPATCH-01', kind: 'http', url: 'https://clinic.ops.example/health', district: 'clinic' },
    backup: { id: 'backup', label: 'Records → offsite backup', from: 'CORE-SRV', kind: 'http', url: 'https://backup.example.net/health', district: 'data' },
    guest: { id: 'guest', label: 'Guest Wi-Fi → internet', from: 'GUEST-KIOSK', kind: 'http', url: 'https://portal.example.net/', district: 'public' },
    isolation: { id: 'isolation', label: 'Guest ✕ clinic systems', from: 'GUEST-KIOSK', kind: 'probe', dst: A(eng, 'clinic', 20), proto: 'tcp', port: 443, expect: 'blocked', district: 'security' },
    nurse: { id: 'nurse', label: 'Ward B → clinic records', from: 'NURSE-STATION', kind: 'http', url: 'https://clinic.ops.example/health', district: 'ward' },
    staff: { id: 'staff', label: 'Staff laptops → records', from: 'STAFF-LAPTOP', kind: 'http', url: 'https://clinic.ops.example/health', district: 'ward' },
    cams: { id: 'cams', label: 'Cameras → video recorder', from: 'CAMERAS', kind: 'fleet', dst: A(eng, 'clinic', 30), proto: 'tcp', port: 554, district: 'security' },
    voice: { id: 'voice', label: 'Dispatch voice line', from: 'VOIP-PHONE', kind: 'voice', dst: ip('203.0.113.50'), port: 5060, district: 'voice' },
  };
}

export function enableFlows(eng, ids) {
  const defs = flowDefs(eng);
  for (const id of ids) if (!eng.s.flows.some(f => f.id === id)) eng.s.flows.push(defs[id]);
  eng.evaluateFlows();
}

function powerOn(eng, ids) {
  for (const id of ids) eng.s.devices[id].powered = true;
  eng.mutated(`power on ${ids.join(', ')}`, 'incident');
}

const isShow = ev => ev.type === 'command' && /^(sh|sho|show|do\s+sh)/i.test(ev.line || '');
const clinicTarget = ev => /clinic\.ops\.example|\b10\.\d+\.\d+\.20\b/.test(`${ev.url || ''} ${ev.target || ''} ${ev.hostname || ''}`);

export const MISSIONS = [
  // ------------------------------------------------------------------------------------------ ACT 0
  {
    id: 'M01', act: 0, code: 'LAYER 1 · CABLING', title: 'THE BROKEN LINK',
    objectives: ['1.5', '2.4', '5.2', '5.5', '5.1'],
    station: 'patch',
    brief: 'Night shift, 02:17. The day tech left a note on Rack C: "tidied the patch cords". Since then, nothing in the clinic can reach the gateway.',
    task: 'Find the missing physical link between EDGE-RTR and ACCESS-SW, restore it, and confirm on a device that the interface came up.',
    radioStart: 'Operator, the whole clinic floor lost the gateway at 01:50. Start at the access switch and work outward.',
    radioWin: 'Uplink is up. Dispatch still has no usable address though. Check the DHCP service.',
    goals: [{ label: 'EDGE-RTR Gi0/1 ↔ ACCESS-SW Gi0/1 has link', check: eng => { const p = eng.peerOf('EDGE-RTR', 'Gi0/1'); return !!p && p.dev === 'ACCESS-SW' && p.port === 'Gi0/1' && eng.portUp('EDGE-RTR', 'Gi0/1'); } }],
    evidence: [{ label: 'Confirm the link from a device console (a show command on ACCESS-SW or EDGE-RTR)', match: ev => isShow(ev) && ['ACCESS-SW', 'EDGE-RTR'].includes(ev.host) }],
    hints: [
      'Everything that needs the router crosses ACCESS-SW Gi0/1. At the switch console: "enable", then "show interfaces status". Which port has no link?',
      'Gi0/1 is "notconnect". Test the cable from the switch: "test cable-diagnostics tdr interface g0/1", then "show cable-diagnostics tdr interface g0/1". All four pairs "Open" at about 2 m means the break is right at the patch panel, not inside the wall.',
      'At RACK C, patch "EDGE-RTR Gi0/1 · LAN" to "ACCESS-SW Gi0/1 · uplink". Console ports use the same RJ-45 socket but carry serial management, not Ethernet. Then run "show interfaces status" again.',
    ],
    debrief: {
      failure: 'The router-to-switch patch cord was missing at the patch panel, so every VLAN lost its gateway at once.',
      evidence: 'ACCESS-SW Gi0/1 "notconnect"; TDR showed all pairs open ~2 m away, i.e. at the panel. Hosts on the same switch could still reach each other.',
      fix: 'Patch EDGE-RTR Gi0/1 to ACCESS-SW Gi0/1, then confirm "connected" / "up up" on a device.',
      why: 'Layer 1 has to be right before anything above it can work. A link light proves electrical link only, not addressing, routing or services.',
      real: ['Cisco: show interfaces status · show ip interface brief · show cdp neighbors · test cable-diagnostics tdr', 'Field: cable tester / tone & probe, follow the labels, check both ends'],
      pitfalls: ['Plugging Ethernet into a console port: same connector, no link.', 'Trunk ports run spanning tree: a new switch-to-switch or router link takes ~30 s (listening + learning) before it forwards with classic PVST+.'],
    },
    reference(eng) { patchConnect(eng, 'P01', 'P04'); eng.advance(31); },
  },
  {
    id: 'M02', act: 0, code: 'NETWORK SERVICES · DHCP', title: 'NO ONE HAS AN ADDRESS',
    objectives: ['3.4', '5.3', '5.5', '1.4', '1.7'],
    station: 'client',
    brief: 'The uplink is back but DISPATCH-01 still cannot reach anything beyond its own cable.',
    task: 'Work out why the dispatch PC has no usable address, repair the DHCP service, and get the PC a real lease.',
    radioStart: 'Dispatch says their screen shows "No Internet". Start at the PC itself.',
    radioWin: 'Dispatch has an address. But the clinic records app opens a "decommissioned" page. Something sends them to the wrong place.',
    goals: [{ label: 'DISPATCH-01 holds a lease from CORE-SRV in the clinic subnet', check: eng => leaseIn(eng, 'DISPATCH-01', 'clinic') }],
    evidence: [{ label: 'Confirm the lease on DISPATCH-01 (ipconfig)', match: ev => (ev.type === 'dhcp' && ev.host === 'DISPATCH-01' && ev.ok) || (ev.type === 'command' && ev.host === 'DISPATCH-01' && /^ipconfig/i.test(ev.line)) }],
    hints: [
      'At DISPATCH-01 run "ipconfig /all". An "Autoconfiguration IPv4 Address" in 169.254.0.0/16 (APIPA) means the PC asked for DHCP and nobody answered.',
      'The DHCP server is CORE-SRV. Check it: "systemctl status isc-dhcp-server", and read why it stopped: "journalctl -u isc-dhcp-server". Logs usually name the exact file and line.',
      'Open the file with "nano /etc/dhcp/dhcpd.conf". A parser reports where it noticed the error, which for a missing ";" is the next token: the log names line 14 (a "}"), so the statement missing its ";" ends on line 13. Fix it, save, test with "dhcpd -t -cf /etc/dhcp/dhcpd.conf", then "systemctl start isc-dhcp-server" and "ipconfig /renew" on DISPATCH-01.',
    ],
    debrief: {
      failure: 'isc-dhcp-server had crashed on a config syntax error (missing semicolon), so DISCOVER broadcasts went unanswered and Windows fell back to APIPA.',
      evidence: '169.254.x.x address with no gateway; "systemctl status" = failed; journal: "dhcpd.conf line 14: semicolon expected." pointing at the "}" that followed the unterminated "option routers" line 13.',
      fix: 'Correct the config, validate it with dhcpd -t before restarting, start the service, renew the client.',
      why: 'DHCP is DORA: Discover (broadcast) → Offer → Request → Ack. No Offer means no lease; the client self-assigns a link-local address that cannot leave the subnet.',
      real: ['Windows: ipconfig /all · ipconfig /release · ipconfig /renew', 'Linux: systemctl status · journalctl -u · dhcpd -t -cf <file>', 'Ports: client UDP 68 ↔ server UDP 67'],
      pitfalls: ['Restarting a service without testing the config first: it just fails again.', 'Editing only the line the error names: parsers report where they noticed the problem, often the line after the real mistake.', 'APIPA clients retry on their own every few minutes; renew to test now.'],
    },
    reference(eng) {
      saveFile(eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', dhcpdConf(eng.s.params));
      const run = cli(eng);
      run('CORE-SRV', 'systemctl start isc-dhcp-server');
      run('DISPATCH-01', 'ipconfig /renew');
    },
  },
  {
    id: 'M03', act: 0, code: 'NETWORK SERVICES · DNS', title: 'THE WRONG DESTINATION',
    objectives: ['3.4', '5.3', '5.5', '1.4', '3.1'],
    station: 'client',
    brief: 'Dispatch can reach things now, but clinic.ops.example opens a "server decommissioned" page. The clinic app was migrated to a new server two weeks ago.',
    task: 'Find out where the clinic name really points, correct it at the source, and prove the HTTPS service answers from dispatch.',
    radioStart: 'Records team swears the new server is healthy. Check what the name resolves to versus the inventory.',
    radioWin: 'Clinic records are loading. Next: the offsite backup has failed every night this week.',
    goals: [
      { label: 'clinic.ops.example resolves to CLINIC-APP', check: eng => { const r = httpRequest(eng, eng.s.devices['DISPATCH-01'], 'https://clinic.ops.example/health', { noCache: true }); return r.ip === A(eng, 'clinic', 20); } },
      { label: 'HTTPS health check from DISPATCH-01 succeeds', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') },
    ],
    evidence: [{ label: 'Prove it from DISPATCH-01: curl https://clinic.ops.example/health returns 200', match: ev => ev.type === 'http' && ev.host === 'DISPATCH-01' && /clinic\.ops\.example/.test(ev.url) && ev.status === 200 }],
    hints: [
      'Compare two facts at DISPATCH-01: "nslookup clinic.ops.example" (what DNS says) and the IPAM sheet on the network map (where CLINIC-APP really lives). Ping succeeding only proves something answers.',
      'The A record points at CLINIC-OLD, which is still powered and serving a 503. The zone file is on CORE-SRV: "cat /etc/bind/db.ops.example".',
      'Edit it with nano: point "clinic" at the CLINIC-APP address and bump the serial. Check with "named-checkzone ops.example /etc/bind/db.ops.example", apply with "rndc reload". DISPATCH-01 may still cache the old answer: "ipconfig /displaydns", "ipconfig /flushdns", then curl again.',
    ],
    debrief: {
      failure: 'A stale DNS A record still pointed clinic.ops.example at the decommissioned server, which was alive and answering with HTTP 503.',
      evidence: 'Ping by name succeeded (wrong host is up). nslookup returned .99, the IPAM sheet says CLINIC-APP is .20. curl showed the 503 body.',
      fix: 'Correct the A record in the authoritative zone, reload BIND, flush the client resolver cache, verify with an application-level test.',
      why: 'ping proves ICMP reachability of whatever the name resolves to, not that it is the right host or that the app works. Clients cache answers for the record TTL (300 s here); nslookup bypasses the Windows cache, ping and curl do not.',
      real: ['Windows: nslookup · ipconfig /displaydns · ipconfig /flushdns · curl -v', 'BIND: named-checkzone · rndc reload · bump the SOA serial so secondaries transfer'],
      pitfalls: ['Editing the zone but forgetting rndc reload.', 'Fixing DNS but testing from a client with a cached stale answer.', 'Treating "ping works" as "service works".'],
    },
    reference(eng) {
      saveFile(eng, 'CORE-SRV', '/etc/bind/db.ops.example', zoneFile(eng.s.params, net(eng.s.params, 'clinic', 20), 2026101402));
      const run = cli(eng);
      run('CORE-SRV', 'rndc reload');
      run('DISPATCH-01', 'ipconfig /flushdns');
    },
  },
  {
    id: 'M04', act: 0, code: 'ROUTING · WAN', title: 'THE LAST HOP',
    objectives: ['2.1', '5.3', '5.5', '1.7'],
    station: 'router',
    brief: 'Offsite backups have failed for six nights. Nothing past EDGE-RTR answers, and external names do not resolve either.',
    task: 'Trace the path toward the backup service, find where it ends, repair routing, and verify the backup API over HTTPS.',
    radioStart: 'Backup vendor says their side is green. Trace the path from inside our network.',
    radioWin: 'Backups are uploading again. Security now reports a guest device poking at clinic systems. The lobby Wi-Fi.',
    goals: [
      { label: 'EDGE-RTR has a usable default route', check: eng => eng.routes('EDGE-RTR').table.some(r => r.len === 0) },
      { label: 'DISPATCH-01 reaches https://backup.example.net', check: eng => httpOk(eng, 'DISPATCH-01', 'https://backup.example.net/health') },
    ],
    evidence: [{ label: 'Prove the backup API answers: curl https://backup.example.net/health (200) from an inside host', match: ev => ev.type === 'http' && /backup\.example\.net/.test(ev.url) && ev.status === 200 }],
    hints: [
      'At DISPATCH-01: "tracert 203.0.113.20". Which device reports the failure, and what does it say?',
      'EDGE-RTR replies "Destination net unreachable": it has no route out. On EDGE-RTR, compare "show ip route" (Gateway of last resort?) with "show running-config | include ip route" and the WAN subnet in "show ip interface brief". Is the configured next hop on any connected network?',
      'The provider end of the /30 is 198.51.100.1. In config mode: "no ip route 0.0.0.0 0.0.0.0 198.51.100.5", then "ip route 0.0.0.0 0.0.0.0 198.51.100.1". Verify with "curl https://backup.example.net/health" at DISPATCH-01.',
    ],
    debrief: {
      failure: 'The default route pointed at 198.51.100.5, a typo outside the 198.51.100.0/30 WAN subnet. IOS accepted the command but could not install the route, so there was no gateway of last resort.',
      evidence: 'tracert listed EDGE-RTR (10.42.10.1) at hop 1, then hop 2 "10.42.10.1 reports: Destination net unreachable.": the gateway itself had no route onward. "show ip route": "Gateway of last resort is not set" while running-config showed the route.',
      fix: 'Replace the static default route with the provider next hop 198.51.100.1 and verify end to end at the application.',
      why: 'A static route is only installed if its next hop is reachable via a connected (or recursively resolved) route. Configured ≠ installed: always check the routing table, not just the config.',
      real: ['Cisco: show ip route · show running-config | include ip route · traceroute', 'Windows: tracert · pathping', 'PAT translated inside addresses to 198.51.100.2 on the way out (show ip nat translations).'],
      pitfalls: ['A /30 has only two usable addresses: .1 and .2.', 'Fixing routing and testing only with ping. The goal is the HTTPS service.'],
    },
    reference(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 198.51.100.5', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1', 'end');
    },
  },
  {
    id: 'M05', act: 0, code: 'SWITCHING · SECURITY', title: 'UNINVITED GUEST',
    objectives: ['2.2', '4.1', '4.3', '1.4', '5.3'],
    station: 'switch',
    brief: 'The lobby guest kiosk can open clinic records. Guests and patient data are sharing a network.',
    task: 'Put guests in their own segment, stop them reaching internal systems, keep their internet working, and prove both from the guest kiosk.',
    radioStart: 'Compliance is on the phone. Guests must not reach anything internal, but the lobby still needs internet.',
    radioWin: 'Guest isolation confirmed and the lobby is online. Facilities is connecting Sector B tonight. Watch the floor.',
    setup(eng) {
      enableFlows(eng, ['guest', 'isolation']);
      const k = eng.s.devices['GUEST-KIOSK'];
      const res = dhcpClient(eng, k, { mode: 'renew' });
      applyDhcpResult(eng, k, res);
      eng.mutated('guest kiosk reboot', 'incident');
    },
    goals: [
      { label: 'GUEST-KIOSK has a lease in the guest subnet', check: eng => leaseIn(eng, 'GUEST-KIOSK', 'guest') },
      { label: 'Guest cannot reach clinic records (TCP 443)', check: eng => !reaches(eng, 'GUEST-KIOSK', A(eng, 'clinic', 20), 'tcp', 443) },
      { label: 'Guest cannot reach CORE-SRV management (TCP 22)', check: eng => !reaches(eng, 'GUEST-KIOSK', A(eng, 'clinic', 10), 'tcp', 22) },
      { label: 'Guest still reaches https://portal.example.net', check: eng => httpOk(eng, 'GUEST-KIOSK', 'https://portal.example.net/') },
    ],
    constraints: [
      { label: 'Dispatch still reaches clinic records', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') },
      { label: 'Backups still reach the offsite API', check: eng => httpOk(eng, 'CORE-SRV', 'https://backup.example.net/health') },
    ],
    evidence: [
      { label: 'From GUEST-KIOSK, show the clinic is now blocked (curl or ping fails)', match: ev => ev.host === 'GUEST-KIOSK' && (ev.type === 'http' || ev.type === 'ping') && clinicTarget(ev) && !ev.ok },
      { label: 'From GUEST-KIOSK, show the internet still works (curl https://portal.example.net)', match: ev => ev.host === 'GUEST-KIOSK' && ev.type === 'http' && /portal\.example\.net/.test(ev.url) && ev.status === 200 },
    ],
    hints: [
      'Prove the exposure first. At GUEST-KIOSK: "ipconfig /all" and "curl https://clinic.ops.example/health". Which subnet did the guest get?',
      'On ACCESS-SW, "show vlan brief": the guest AP port Gi0/6 sits in the clinic VLAN. Move it ("interface g0/6", "switchport access vlan 30") and renew the kiosk. It still reaches the clinic: VLANs split broadcast domains, but EDGE-RTR routes between them.',
      'On EDGE-RTR, filter inbound on the guest subinterface. Guests still need DNS from 10.42.10.10 (or a public resolver), so permit that first: "ip access-list extended GUEST-IN", "permit udp 10.42.30.0 0.0.0.255 host 10.42.10.10 eq domain", "deny ip 10.42.30.0 0.0.0.255 10.42.0.0 0.0.255.255", "permit ip any any"; then "interface g0/1.30", "ip access-group GUEST-IN in". Test both directions from the kiosk.',
    ],
    debrief: {
      failure: 'The guest AP was patched into the clinic VLAN, so guests were on the clinic subnet with direct Layer 2 access.',
      evidence: 'Kiosk had a 10.42.10.x lease and curl to the clinic returned 200; "show vlan brief" listed Gi0/6 in VLAN 10.',
      fix: 'Move the AP port to the guest VLAN (separate broadcast domain/subnet), then filter routed traffic from guests to internal ranges with an inbound ACL, while explicitly permitting what guests need (DNS) and leaving internet access open.',
      why: 'Segmentation needs both: a VLAN alone still lets the router forward between subnets; an ACL alone cannot filter traffic that never reaches the router. ACLs are processed top-down, first match wins, and every ACL ends with an implicit deny.',
      real: ['Cisco: show vlan brief · switchport access vlan · ip access-list extended · ip access-group in · show access-lists (watch the match counters)', 'Design: give guests a public resolver or a DNS-only permit; deny RFC 1918 destinations; apply as close to the source as possible.'],
      pitfalls: ['Forgetting DNS: the guest "has no internet" because names stop resolving.', 'Forgetting "permit ip any any": the implicit deny blocks the internet too.', 'Changing the VLAN but not renewing: the client keeps its old-subnet lease until it renews.'],
    },
    reference(eng) {
      const run = cli(eng);
      run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/6', `switchport access vlan ${V(eng, 'guest')}`, 'end');
      run('GUEST-KIOSK', 'ipconfig /renew');
      const g = `10.${eng.s.params.site}.${eng.s.params.octets.guest}.0`;
      run('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended GUEST-IN',
        `permit udp ${g} 0.0.0.255 host ${net(eng.s.params, 'clinic', 10)} eq domain`,
        `deny ip ${g} 0.0.0.255 10.${eng.s.params.site}.0.0 0.0.255.255`,
        'permit ip any any', 'exit', `interface g0/1.${V(eng, 'guest')}`, 'ip access-group GUEST-IN in', 'end');
    },
  },

  // ------------------------------------------------------------------------------------------ ACT I
  {
    id: 'M06', act: 1, code: 'SWITCHING · STP', title: 'BROADCAST STORM',
    objectives: ['2.2', '5.3', '3.2', '1.6', '5.1'],
    station: 'switch',
    brief: 'A contractor connected Sector B with two riser cables "for redundancy" and turned off spanning tree "to make ports come up faster". The whole clinic VLAN just fell over.',
    task: 'Stop the storm, restore Sector B and the clinic floor, and decide how much redundancy you keep. A riser may fail later tonight.',
    radioStart: 'Everything is down at once and the switch fans are screaming. Do not reboot anything until you know why.',
    radioWin: 'Storm is over. Construction crew in the riser shaft tonight. Stand by.',
    setup(eng) {
      for (const sw of ['ACCESS-SW', 'DIST-SW-B']) eng.s.devices[sw].stp.disabled = [[1, 4094]];
      eng.mutated('contractor: no spanning-tree vlan 1-4094 on ACCESS-SW and DIST-SW-B', 'contractor');
      patchConnect(eng, 'P07', 'P09', 'incident');
      powerOn(eng, ['DIST-SW-B', 'NURSE-STATION', 'DOOR-CTRL']);
      eng.advance(1);
      patchConnect(eng, 'P08', 'P10', 'incident');
      enableFlows(eng, ['nurse']);
      eng.advance(2);
    },
    goals: [
      { label: 'No forwarding loop in any VLAN', check: eng => eng.storms().size === 0 },
      { label: 'NURSE-STATION reaches clinic records', check: eng => httpOk(eng, 'NURSE-STATION', 'https://clinic.ops.example/health') },
      { label: 'DISPATCH-01 reaches clinic records', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') },
    ],
    evidence: [{ label: 'Verify from a clinic host (curl the clinic health check from NURSE-STATION or DISPATCH-01)', match: ev => ev.type === 'http' && ['NURSE-STATION', 'DISPATCH-01'].includes(ev.host) && /clinic\.ops\.example/.test(ev.url) && ev.status === 200 }],
    aftershock: {
      delay: 15,
      radio: 'Riser A just went dark. The construction crew cut a cable in the shaft.',
      trigger(eng) {
        // Cut the riser that currently carries Sector B traffic.
        const risers = ['patch:P07-P09', 'patch:P08-P10'].filter(id => eng.s.links[id] && eng.linkStatus(id).up && !eng.s.links[id].cut);
        const rec = id => eng.s.stpState?.['DIST-SW-B']?.[V(eng, 'clinic')]?.[id === 'patch:P07-P09' ? 'Gi0/23' : 'Gi0/24'];
        const target = risers.find(id => !rec(id) || rec(id).st === 'forwarding') || risers[0];
        if (!target) return null;
        eng.s.links[target].cut = true;
        eng.mutated(`riser ${target} cut`, 'incident');
        return target;
      },
      goals: [{ label: 'Ward B reaches clinic records again', check: eng => eng.storms().size === 0 && httpOk(eng, 'NURSE-STATION', 'https://clinic.ops.example/health') }],
    },
    outcome(eng, ctx) {
      const sw = ['ACCESS-SW', 'DIST-SW-B'].map(id => eng.s.devices[id]);
      const stpOn = sw.map(d => !(d.stp.disabled || []).some(([a, b]) => V(eng, 'clinic') >= a && V(eng, 'clinic') <= b));
      const rapid = sw.map((d, i) => stpOn[i] && d.stp.mode === 'rapid-pvst');
      const legacy = sw.filter((d, i) => stpOn[i] && !rapid[i]).map(d => d.hostname);
      // Only Rapid PVST+ on both switches guarantees a rapid failover: ports on, or facing, a legacy switch use 802.1D timers.
      const method = !stpOn.some(Boolean) ? 'Removed the redundant path by hand'
        : rapid.every(Boolean) ? 'Re-enabled spanning tree (Rapid PVST+ on both switches)'
          : rapid.some(Boolean) ? `Re-enabled spanning tree with mixed modes (${legacy.join(', ')} still runs legacy 802.1D pvst)`
            : 'Re-enabled spanning tree (PVST+)';
      return {
        method,
        outage: ctx.outage,
        compare: [
          { option: 'Rapid PVST+ on both switches', outage: '≈1–2 s', redundancy: 'kept' },
          { option: 'PVST+ (802.1D timers)', outage: '≈30 s (15 s listening + 15 s learning)', redundancy: 'kept' },
          { option: 'Mixed modes (one switch still PVST+)', outage: 'up to ≈30 s: ports facing the legacy switch use 802.1D timers', redundancy: 'kept' },
          { option: 'Shut / unplug one riser', outage: 'until a human notices and re-enables the other riser', redundancy: 'lost' },
        ],
      };
    },
    hints: [
      'Everything in VLAN 10 failed at the same instant and links are still "up". On ACCESS-SW: "show logging" and "show processes cpu sorted". What does a host MAC "flapping between Gi0/23 and Gi0/24" mean?',
      'The two risers form a Layer 2 loop. "show spanning-tree vlan 10" says no instance exists: STP is disabled, so broadcasts circle forever and multiply.',
      'Either re-enable STP ("spanning-tree vlan 1-4094" in config mode on both switches), or as a stopgap shut one riser port. "spanning-tree mode rapid-pvst" on BOTH switches makes a riser failover take about a second; RSTP is only rapid between RSTP speakers. Enabling STP restarts every port: PortFast host ports forward at once, but the trunk to EDGE-RTR (a router sends no BPDUs) waits 30 s unless you mark it as an edge port ("interface g0/1", "spanning-tree portfast trunk" on ACCESS-SW). Then curl the clinic from NURSE-STATION. Consider what each choice does if a riser fails later.',
    ],
    debrief: {
      failure: 'Two parallel links between switches with spanning tree disabled created a Layer 2 loop. Broadcast and unknown-unicast frames looped and multiplied, saturating links and switch CPUs.',
      evidence: 'Every VLAN 10 service failed at once while all links stayed up; %SW_MATM-4-MACFLAP_NOTIF between the two risers; CPU at 99%; "Spanning tree instance(s) for vlan 10 does not exist."',
      fix: 'Restore loop prevention (STP/RSTP) so one riser blocks and takes over on failure, or remove the redundant path manually.',
      why: 'Ethernet frames have no TTL. STP elects a root bridge and blocks redundant ports, keeping redundancy without loops. Classic 802.1D waits 30 s (listening + learning) before a port forwards. Rapid PVST+ (802.1w) is fast only where it can be: an alternate port takes over as root port at once, and a designated port forwards after a proposal/agreement handshake, which needs a Rapid PVST+ neighbour on a point-to-point (full-duplex) link. Toward a legacy PVST+ switch, a router or a host without PortFast it falls back to the same 30 s.',
      real: ['Cisco: show spanning-tree (Type column: P2p, Shr, Edge, "Peer(STP)" = legacy neighbour) · show logging · show processes cpu sorted · show interfaces (broadcast counters)', 'Edge ports: spanning-tree portfast (access) or spanning-tree portfast trunk (a trunk to a router or server) + bpduguard enable. Never disable STP to "speed up" ports; use PortFast on edge ports instead.'],
      pitfalls: ['Rebooting the switches: the loop comes straight back.', 'Disabling STP to make ports come up faster: PortFast on edge ports is the correct fix for that.', 'Rapid PVST+ on only one switch: the riser between them still runs 802.1D timers.'],
    },
    reference(eng) {
      const run = cli(eng);
      // The router-on-a-stick trunk is an edge port (routers do not bridge or send BPDUs): forward at once.
      run('ACCESS-SW', 'enable', 'configure terminal', 'interface g0/1', 'spanning-tree portfast trunk', 'end');
      for (const sw of ['ACCESS-SW', 'DIST-SW-B']) run(sw, 'enable', 'configure terminal', 'spanning-tree mode rapid-pvst', 'spanning-tree vlan 1-4094', 'end');
      eng.advance(3);
    },
  },
  {
    id: 'M07', act: 1, code: 'NETWORK SERVICES · DHCP RELAY', title: 'A DIFFERENT FLOOR',
    objectives: ['3.4', '2.1', '5.3', '1.4'],
    station: 'router',
    brief: 'Staff laptops in Sector B sit in VLAN 20. They all show "No Internet". The DHCP server is healthy and the clinic VLAN gets leases fine.',
    task: 'Find out why staff clients never get a lease, fix it without moving the DHCP server, and verify a staff laptop reaches the records app.',
    radioStart: 'The ward manager cannot log in to the records app from her laptop. Same building, different VLAN.',
    radioWin: 'Staff are online. Next problem: half the new cameras in Sector B are dark.',
    setup(eng) { powerOn(eng, ['STAFF-LAPTOP']); enableFlows(eng, ['staff']); },
    goals: [
      { label: 'STAFF-LAPTOP holds a lease from CORE-SRV in the staff subnet', check: eng => leaseIn(eng, 'STAFF-LAPTOP', 'staff') },
      { label: 'STAFF-LAPTOP reaches clinic records', check: eng => httpOk(eng, 'STAFF-LAPTOP', 'https://clinic.ops.example/health') },
    ],
    constraints: [{ label: 'Dispatch still reaches clinic records', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') }],
    evidence: [{ label: 'From STAFF-LAPTOP, curl the clinic health check (200)', match: ev => ev.type === 'http' && ev.host === 'STAFF-LAPTOP' && /clinic\.ops\.example/.test(ev.url) && ev.status === 200 }],
    hints: [
      'At STAFF-LAPTOP, "ipconfig /all": APIPA. Yet CORE-SRV is running and dispatch renews fine. What is different about VLAN 20?',
      'A DHCP Discover is a broadcast; routers do not forward broadcasts. On CORE-SRV, "journalctl -u isc-dhcp-server" never shows a Discover via 10.42.20.1. On EDGE-RTR compare "show running-config | section Gi0/1.20" with "show running-config | section Gi0/1.30".',
      'Add a relay on the staff gateway: "interface g0/1.20", "ip helper-address 10.42.10.10". Then "ipconfig /renew" on STAFF-LAPTOP. The server chooses the scope from the relay address (giaddr).',
    ],
    debrief: {
      failure: 'The staff VLAN gateway had no DHCP relay (ip helper-address), so Discover broadcasts died at the router and never reached CORE-SRV in VLAN 10.',
      evidence: 'APIPA on the staff laptop; no Discover from the staff subnet in the dhcpd journal; Gi0/1.30 had a helper, Gi0/1.20 did not.',
      fix: 'Configure ip helper-address on the staff subinterface pointing at the DHCP server. The relay converts the broadcast into a unicast with giaddr set to the gateway address.',
      why: 'Broadcasts stay inside their broadcast domain. A relay agent forwards DHCP across subnets; the server uses giaddr to choose the matching subnet declaration (scope).',
      real: ['Cisco: ip helper-address (also forwards some other UDP broadcasts by default)', 'Linux: journalctl -u isc-dhcp-server shows "via <giaddr>" for relayed requests'],
      pitfalls: ['Adding a scope on the server but no relay (or vice versa).', 'Pointing the helper at the wrong address or at a subnet the ACLs block.'],
    },
    reference(eng) {
      const run = cli(eng);
      run('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${V(eng, 'staff')}`, `ip helper-address ${net(eng.s.params, 'clinic', 10)}`, 'end');
      run('STAFF-LAPTOP', 'ipconfig /renew');
    },
  },
  {
    id: 'M08', act: 1, code: 'IPv4 ADDRESSING · SUBNETTING', title: 'FIFTY CAMERAS',
    objectives: ['1.7', '3.4', '3.1', '5.3'],
    station: 'server',
    brief: 'Facilities installed 50 IP cameras in Sector B on VLAN 40. Only some of them stream to the recorder.',
    task: 'Find why cameras run out of addresses, re-plan the camera subnet so all 50 fit without overlapping anything, and get every camera streaming.',
    radioStart: 'Security wants all fifty feeds before the morning shift. The door controllers in VLAN 41 must keep working.',
    radioWin: 'All fifty feeds are recording. Dispatch is complaining that calls sound robotic.',
    setup(eng) { powerOn(eng, ['CAMERAS']); enableFlows(eng, ['cams']); eng.advance(1); },
    goals: [
      { label: 'All 50 cameras hold a lease in the camera gateway\'s subnet', check: eng => {
        const f = eng.s.devices.CAMERAS;
        const gw = l3Ifaces(eng, eng.s.devices['EDGE-RTR']).find(i => i.name === `Gi0/1.${V(eng, 'cams')}`);
        return !!gw && f.leases.length === f.count && f.leases.every(m => inSubnet(m.addr, gw.addr, gw.len) && m.len === gw.len && m.gw === gw.addr);
      } },
      { label: 'All 50 cameras stream to the recorder (TCP 554)', check: eng => { eng.evaluateFlows(); return !!eng.s.flowState.cams?.ok; } },
    ],
    constraints: [
      { label: 'Door controllers still reach their gateway', check: eng => reaches(eng, 'DOOR-CTRL', A(eng, 'cams', 65), 'icmp') },
      { label: 'Dispatch still reaches clinic records', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') },
    ],
    evidence: [{ label: 'Confirm all 50 feeds (CCTV wall in Sector B, or dhcp-lease-list on CORE-SRV)', match: ev => (ev.type === 'view' && ev.what === 'cctv') || (ev.host === 'CORE-SRV' && ev.type === 'command' && /lease|journalctl/.test(ev.line)) }],
    hints: [
      'Only some cameras stream. On CORE-SRV: "journalctl -u isc-dhcp-server | grep -i free". What does "no free leases" say about the scope?',
      'The camera scope is a /27: 30 usable addresses, and the pool (.10–.30) is only 21. Fifty cameras need at least a /26 (62 usable). 10.42.40.64/27 (.64–.95) already belongs to the door controllers (EDGE-RTR Gi0/1.41). A /26 starts on a multiple of 64: 10.42.40.0/26 (.0–.63) and 10.42.40.128/26 (.128–.191) are both free, but 10.42.40.64/26 or 10.42.40.0/25 would contain the door block. Pick a free block.',
      'Example: 10.42.40.128/26. EDGE-RTR: "interface g0/1.40", "ip address 10.42.40.129 255.255.255.192". dhcpd.conf: "subnet 10.42.40.128 netmask 255.255.255.192", "range 10.42.40.140 10.42.40.190;", "option routers 10.42.40.129;". Restart the service. Cameras renew at T1 (5 min) — or bounce their PoE port (DIST-SW-B: "interface g0/4", "shutdown", "no shutdown").',
    ],
    debrief: {
      failure: 'The camera subnet was a /27 with a 21-address pool: the scope ran out after 21 cameras ("no free leases").',
      evidence: 'Feed count stuck at 21/50; dhcpd journal "network 10.42.40.0/27: no free leases"; IPAM shows 10.42.40.64/27 in use by VLAN 41.',
      fix: 'Re-address the camera VLAN to a non-overlapping block of at least /26, update the gateway and the scope together, and make clients re-acquire.',
      why: 'Usable hosts = 2^(32−prefix) − 2. /27 → 30, /26 → 62, /25 → 126. Subnets must not overlap, and the DHCP scope, the router interface and the clients\' gateway must agree.',
      real: ['Cisco IOS refuses overlapping interface subnets ("% ... overlaps with ...").', 'ISC DHCP: subnet/netmask must match the relay\'s interface subnet (giaddr) and range must sit inside it.', 'Update IPAM/documentation as part of the change.'],
      pitfalls: ['Changing the scope but not the router interface (clients get a gateway that does not exist).', 'Forgetting existing leases: clients keep old addresses until they renew.', 'Choosing a /25 that swallows the door-controller /27.'],
    },
    reference(eng) {
      const p = eng.s.params;
      const run = cli(eng);
      run('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${V(eng, 'cams')}`, `ip address ${net(p, 'cams', 129)} 255.255.255.192`, 'end');
      saveFile(eng, 'CORE-SRV', '/etc/dhcp/dhcpd.conf', dhcpdConf(p, { camNet: net(p, 'cams', 128), camMask: '255.255.255.192', camRange: [net(p, 'cams', 140), net(p, 'cams', 190)], camGw: net(p, 'cams', 129) }));
      run('CORE-SRV', 'systemctl restart isc-dhcp-server');
      run('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/4', 'shutdown', 'no shutdown', 'end');
      eng.advance(3);
    },
  },
  {
    id: 'M09', act: 1, code: 'PERFORMANCE · DUPLEX', title: 'THE 1% PROBLEM',
    objectives: ['5.4', '5.2', '2.2', '3.2', '5.5'],
    station: 'phone',
    brief: 'Nothing is down, but emergency calls from the dispatch desk sound robotic and drop words. Last week someone "fixed a flapping link" on EDGE-RTR.',
    task: 'Measure where quality is lost, find the physical-layer cause from interface evidence, fix it, and prove call quality with a test call.',
    radioStart: 'Ambulance crews say they cannot understand dispatch. This is a life-safety line.',
    radioWin: 'Call quality is clean. One more: the lobby says guests are getting strange addresses.',
    setup(eng) {
      powerOn(eng, ['VOIP-PHONE']);
      Object.assign(eng.s.devices['EDGE-RTR'].ports['Gi0/1'], { speed: 100, duplex: 'full' });
      eng.mutated('EDGE-RTR: interface Gi0/1 speed 100 / duplex full (ticket CHG-2291 "stop link flapping")', 'previous tech');
      enableFlows(eng, ['voice']);
      eng.advance(65);
    },
    goals: [
      { label: 'No duplex mismatch on any active link', check: eng => Object.values(eng.s.links).every(l => !eng.linkStatus(l.id).up || !eng.linkStatus(l.id).mismatch) },
      { label: 'Voice line MOS ≥ 4.0', check: eng => { eng.evaluateFlows(); const m = eng.s.flowState.voice?.metric; return !!m && m.mos >= 4.0; } },
    ],
    constraints: [{ label: 'Dispatch still reaches clinic records', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') }],
    evidence: [{ label: 'Place a test call from the dispatch phone (MOS ≥ 4.0), or show 0% loss with pathping', match: ev => (ev.type === 'voip-test' && ev.mos >= 4.0) || (ev.type === 'pathping' && ev.loss === 0) }],
    outcome(eng) {
      const p = eng.s.devices['EDGE-RTR'].ports['Gi0/1'];
      const ls = eng.linkStatus(eng.linkAt('EDGE-RTR', 'Gi0/1').id);
      return { method: p.speed === 'auto' && p.duplex === 'auto' ? 'Returned EDGE-RTR Gi0/1 to auto-negotiation' : `Hard-coded both ends (${ls.speed} Mb/s ${ls.duplexA})`, speed: ls.speed };
    },
    hints: [
      'Measure before touching anything. At DISPATCH-01: "pathping backup.example.net" shows on which link loss starts.',
      'Loss starts on the first link: ACCESS-SW Gi0/1 ↔ EDGE-RTR Gi0/1. Run "show interfaces g0/1" on both ends: one reports Half-duplex with late collisions, the other Full-duplex with CRC errors and runts. "show logging" has a CDP duplex-mismatch message.',
      'Hard-setting speed and duplex on one end disables auto-negotiation there; the auto end can detect speed but not duplex, so it falls back to half duplex. Make both ends agree: on EDGE-RTR "interface g0/1", "speed auto", "duplex auto". Then "clear counters", wait, re-check, and place a test call.',
    ],
    debrief: {
      failure: 'EDGE-RTR Gi0/1 was hard-coded to 100/full while ACCESS-SW stayed on auto. With negotiation off on one end, the switch used parallel detection: 100 Mb/s but half duplex. Half duplex on one end and full on the other = duplex mismatch.',
      evidence: 'Link up, low but steady loss and jitter; pathping loss from hop 1; half-duplex side: collisions and late collisions; full-duplex side: CRC errors and runts; %CDP-4-DUPLEX_MISMATCH.',
      fix: 'Set both ends the same: both auto (preferred, here 1000/full), or both hard-coded to identical speed and duplex.',
      why: 'The full-duplex end transmits whenever it likes; the half-duplex end sees that as collisions, backs off and retransmits, and frames get truncated. Bulk TCP hides it by retransmitting; real-time voice cannot.',
      real: ['Cisco: show interfaces (duplex line, CRC, runts, late collision) · show interfaces status (a-full vs full) · clear counters', 'Windows: pathping; Linux: mtr', 'Voice targets: MOS ≥ 4.0, loss < 1%, jitter < 30 ms, one-way delay < 150 ms'],
      pitfalls: ['Calling it "the ISP" because ping mostly works.', 'Fixing one end only: always change both ends of a link together.'],
    },
    reference(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'interface g0/1', 'speed auto', 'duplex auto', 'end');
      eng.advance(2);
    },
  },
  {
    id: 'M10', act: 1, code: 'SECURITY · ROGUE DHCP', title: 'SOMEONE ELSE\'S NETWORK',
    objectives: ['4.2', '4.3', '3.4', '5.3', '2.2'],
    station: 'guest',
    brief: 'The lobby kiosk rebooted and now gets an address nobody here assigned. Its gateway is not ours. Anything a guest types could be going through someone else\'s box.',
    task: 'Find where the rogue DHCP server is plugged in, contain it, prevent it from happening again, and get the kiosk a legitimate lease.',
    radioStart: 'A visitor left a "travel router" somewhere in the lobby. Find it from the network side.',
    radioWin: 'Lobby is clean. That is the night. Good work, operator.',
    setup(eng) {
      const s = eng.s;
      const rogue = device('ROGUE-AP', 'host', 'linux', { index: 90, ipcfg: { dhcp: false, static: { addr: ip('192.168.8.1'), len: 24, gw: null, dns: [] } }, map: { x: 720, y: 460 }, role: 'Unknown device (travel router)', zone: 'lobby' });
      addPort(rogue, 'eth0');
      rogue.services = { 'rogue-dhcp': { kind: 'dhcp', unit: 'dnsmasq', active: true, listen: [{ proto: 'udp', port: 67 }], first: ip('192.168.8.100'), len: 24, gw: ip('192.168.8.1'), dns: [ip('192.168.8.1')] } };
      s.devices['ROGUE-AP'] = rogue;
      s.links['rogue'] = link('rogue', ['ACCESS-SW', 'Gi0/9'], ['ROGUE-AP', 'eth0'], { lengthM: 25 });
      eng.reindex();
      eng.mutated('unknown device connected at lobby jack L-09', 'incident');
      const k = s.devices['GUEST-KIOSK'];
      const res = dhcpClient(eng, k, { mode: 'discover', current: null });
      applyDhcpResult(eng, k, res);
      eng.mutated('guest kiosk reboot', 'incident');
    },
    goals: [
      { label: 'GUEST-KIOSK holds a legitimate lease in the guest subnet', check: eng => leaseIn(eng, 'GUEST-KIOSK', 'guest') },
      { label: 'Guest still reaches https://portal.example.net', check: eng => httpOk(eng, 'GUEST-KIOSK', 'https://portal.example.net/') },
      { label: 'A new guest client would get a legitimate lease', check: eng => { const r = dhcpDryRun(eng, eng.s.devices['GUEST-KIOSK']); return r.ok && !r.rogue; } },
    ],
    constraints: [
      { label: 'Guest isolation still holds', check: eng => !reaches(eng, 'GUEST-KIOSK', A(eng, 'clinic', 20), 'tcp', 443) },
      { label: 'Dispatch still reaches clinic records', check: eng => httpOk(eng, 'DISPATCH-01', 'https://clinic.ops.example/health') },
    ],
    evidence: [
      { label: 'Renew the kiosk and confirm a lease from our server', match: ev => ev.type === 'dhcp' && ev.host === 'GUEST-KIOSK' && ev.ok && !ev.rogue },
      { label: 'From the kiosk, curl https://portal.example.net (200)', match: ev => ev.type === 'http' && ev.host === 'GUEST-KIOSK' && /portal\.example\.net/.test(ev.url) && ev.status === 200 },
    ],
    aftershock: {
      delay: 25,
      radio: 'Lobby again: the visitor moved their travel router to the other wall jack and the kiosk was rebooted.',
      trigger(eng) {
        const s = eng.s;
        if (!s.links.rogue) return null;
        delete s.links.rogue;
        s.links['rogue2'] = link('rogue2', ['ACCESS-SW', 'Gi0/10'], ['ROGUE-AP', 'eth0'], { lengthM: 25 });
        eng.reindex();
        eng.mutated('rogue device moved to lobby jack L-10', 'incident');
        const k = s.devices['GUEST-KIOSK'];
        const res = dhcpClient(eng, k, { mode: 'discover', current: null });
        applyDhcpResult(eng, k, res);
        eng.mutated('guest kiosk reboot', 'incident');
        return 'rogue2';
      },
      goals: [
        { label: 'GUEST-KIOSK holds a legitimate lease', check: eng => leaseIn(eng, 'GUEST-KIOSK', 'guest') && httpOk(eng, 'GUEST-KIOSK', 'https://portal.example.net/') },
        { label: 'New guest clients get legitimate leases', check: eng => { const r = dhcpDryRun(eng, eng.s.devices['GUEST-KIOSK']); return r.ok && !r.rogue; } },
      ],
    },
    outcome(eng, ctx) {
      const sw = eng.s.devices['ACCESS-SW'];
      const snoop = sw.snoop.enabled && sw.snoop.vlans.includes(V(eng, 'guest'));
      return { method: snoop ? 'DHCP snooping on the guest VLAN (prevention)' : 'Shut the port (containment only)', outage: ctx.outage, prevented: ctx.outage === 0 };
    },
    hints: [
      'At GUEST-KIOSK, "ipconfig /all". Look at "DHCP Server" and "Default Gateway". Do they belong to this network?',
      'Something on the guest VLAN answers DHCP before our relay can. Find its port from the switch: "show mac address-table vlan 30" (or "interface g0/9", "g0/10"...). The rogue\'s MAC will be on a lobby jack, not on Gi0/1 or Gi0/6.',
      'Contain: shut that port. Prevent: DHCP snooping on ACCESS-SW: "ip dhcp snooping", "ip dhcp snooping vlan 30", then trust only the uplink where legitimate offers arrive: "interface g0/1", "ip dhcp snooping trust". Our server sits behind an IOS relay (EDGE-RTR), and snooping inserts option 82 with giaddr 0, which that relay drops by default: also enter "no ip dhcp snooping information option" on ACCESS-SW. Then "ipconfig /release" and "ipconfig /renew" on the kiosk.',
    ],
    debrief: {
      failure: 'A consumer travel router running its own DHCP server was plugged into a guest-VLAN wall jack. It answered Discovers faster than the relayed server, handing guests its own gateway and DNS: a classic on-path position.',
      evidence: 'Kiosk lease 192.168.8.x with DHCP Server 192.168.8.1; that MAC learned on a lobby access port; no matching lease in CORE-SRV\'s journal.',
      fix: 'Contain by shutting the port; prevent with DHCP snooping on the guest VLAN, trusting only the port facing the legitimate server/relay, and turning off option 82 insertion because the legitimate server sits behind an IOS relay.',
      why: 'DHCP has no authentication; clients take the first offer. Snooping drops server-side DHCP messages (Offer/Ack) arriving on untrusted ports and builds a binding table that DAI and IP Source Guard can use. By default it also inserts option 82 (relay agent information) but leaves giaddr 0.0.0.0; an IOS relay drops such requests on interfaces not trusted for relay information.',
      real: ['Cisco: ip dhcp snooping · ip dhcp snooping vlan · ip dhcp snooping trust · show ip dhcp snooping ("Insertion of option 82 is ...")', 'Option 82 with an upstream IOS relay: "no ip dhcp snooping information option" on the access switch, or "ip dhcp relay information trusted" on the relay interface ("ip dhcp relay information trust-all" globally).'],
      pitfalls: ['Enabling snooping without trusting the uplink: legitimate offers get dropped too and everyone falls back to APIPA.', 'Leaving option 82 insertion on with an IOS relay upstream: the relay silently drops every request from the snooped VLAN.', 'Only shutting the port: the rogue moves to the next jack.'],
    },
    reference(eng) {
      const run = cli(eng);
      run('ACCESS-SW', 'enable', 'configure terminal', 'ip dhcp snooping', `ip dhcp snooping vlan ${V(eng, 'guest')}`, 'no ip dhcp snooping information option', 'interface g0/1', 'ip dhcp snooping trust', 'end');
      run('GUEST-KIOSK', 'ipconfig /release', 'ipconfig /renew');
    },
  },
];

export const ACTS = [
  { id: 0, title: 'ACT 0 · FIRST LIGHT', blurb: 'Five latent faults, one district. Each fix reveals the next layer.' },
  { id: 1, title: 'ACT I · GROWING PAINS', blurb: 'Sector B comes online: loops, relays, subnets, physics and an intruder.' },
];

/** Build the canonical start state for mission index i (earlier missions solved by reference). */
export function buildMissionStart(buildDistrict, Engine, i, params) {
  const eng = new Engine(buildDistrict(params));
  eng.converge();
  eng.s.flows = [];
  enableFlows(eng, ['clinic', 'backup']);
  for (let j = 0; j < i; j++) {
    MISSIONS[j].setup?.(eng);
    MISSIONS[j].reference(eng);
    eng.advance(5);
  }
  MISSIONS[i].setup?.(eng);
  eng.evaluateFlows();
  return eng;
}

export function describeIp(n) { return fmtIp(n); }
