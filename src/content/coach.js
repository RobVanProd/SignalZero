// Step-by-step coach for the first incidents. Each step says what to do, where, and why; it is ticked off by
// observing what the player actually did (commands, opened stations, engine state), never by a button.
// Steps are guidance, not gates: the incident is still won by the behavioural checks in missions.js.
//
// step = { id, title, how, where?, cmd?: { dev, text }, done(ctx) -> bool, learned, basic? }
//   where  station id the HUD marker points at
//   cmd    the exact command to type (shown as a fill-in chip in that device's console)
//   basic  controls lesson, auto-skipped once the player has finished it in any campaign
import { parseDhcpd } from '../engine/parsers/dhcpd.js';
import { parseZone } from '../engine/parsers/zone.js';
import { parseIp } from '../engine/ipv4.js';
import { net } from './district.js';

/** Interface token in canonical short form: g0/1, gi0/1, GigabitEthernet0/1 -> g0/1. */
function ifTok(t) {
  const m = /^([a-z]+)-?(\d+(?:\/\d+)*(?:\.\d+)?)$/i.exec(t);
  return m ? m[1][0].toLowerCase() + m[2] : null;
}

/**
 * True when an IOS command line is the target command, allowing IOS unique-prefix abbreviations
 * ("sh int stat"), interface short names, a leading "do", and anything after a pipe.
 */
export function iosIs(line, target) {
  const clean = String(line).toLowerCase().split('|')[0].trim().replace(/^do\s+/, '').replace(/\b([a-z]+)\s+(\d+\/\d+)/g, '$1$2');
  const a = clean.split(/\s+/).filter(Boolean);
  const b = target.toLowerCase().split(/\s+/);
  if (a.length < b.length) return false;
  return b.every((w, i) => (/\d/.test(w) ? ifTok(a[i]) === ifTok(w) || a[i] === w : a[i].length >= Math.min(2, w.length) && w.startsWith(a[i])));
}

const wordsIs = (line, re) => re.test(String(line).trim());

const B = {
  look: {
    id: 'look', basic: true, title: 'Look around',
    how: { desktop: 'Click anywhere on the 3D view to take control of the mouse, then move the mouse to look. Esc gives the mouse back.', touch: 'Drag on the right half of the screen to look around.' },
    done: c => c.app.lookTravel > 1.2,
    learned: 'The small diamond in the middle of the screen is your aim. Whatever it points at, you can use with E (or USE on touch).',
  },
  walk: {
    id: 'walk', basic: true, title: 'Walk',
    how: { desktop: 'Hold W to walk forward; A, S and D strafe and back up.', touch: 'Push the stick in the bottom-left corner to walk.' },
    done: c => c.app.walkTravel > 1.5,
    learned: 'You can walk anywhere in the operations centre. The racks are along the left wall, the dispatch desk is in front of the window, the lobby is behind you.',
  },
  map: {
    id: 'map', basic: true, title: 'Open the network map',
    how: { desktop: 'Press M. The map shows every device and cable. Its QUICK TRAVEL tab walks you to any device. Close it with Esc.', touch: 'Tap MAP. The map shows every device and cable; QUICK TRAVEL walks you to any device. Close it with ×.' },
    done: c => c.app.opened.has('map'),
    learned: 'On the map, lines are cables: solid blue = working, red dashed = down. Look at EDGE-RTR, the router to the internet: no line joins it to ACCESS-SW, the switch every clinic device plugs into. That missing line is tonight\'s first problem.',
  },
};

export const COACH = {
  M01: [
    B.look, B.walk, B.map,
    {
      id: 'open-sw', title: 'Open the switch console', where: 'ACCESS-SW',
      how: 'Follow the orange marker to RACK B and point at the ACCESS-SW switch until it says "PRESS E", then press E. (Or: M → Quick travel → ACCESS-SW, then E.)',
      done: c => c.app.opened.has('ACCESS-SW'),
      learned: 'You are on the switch\'s serial console, just as you would be with a console cable. Every device in the clinic plugs into this switch.',
    },
    {
      id: 'enable', title: 'Enter privileged mode', where: 'ACCESS-SW', cmd: { dev: 'ACCESS-SW', text: 'enable' },
      how: 'Type enable and press Enter.',
      done: c => c.ran('ACCESS-SW', l => iosIs(l, 'enable')),
      learned: 'The prompt changed from ">" to "#": privileged EXEC mode. Most show and test commands need it.',
    },
    {
      id: 'status', title: 'Check which ports have a link', where: 'ACCESS-SW', cmd: { dev: 'ACCESS-SW', text: 'show interfaces status' },
      how: 'Type show interfaces status (the quick command chip fills it in for you).',
      done: c => c.ran('ACCESS-SW', l => iosIs(l, 'show interfaces status')),
      learned: 'Gi0/1, the uplink to the router, says "notconnect": no electrical link at all. That is Layer 1, the physical layer. Nothing above it (addresses, routing, apps) can work until it is fixed.',
    },
    {
      id: 'tdr-run', title: 'Test the cable on Gi0/1', where: 'ACCESS-SW', cmd: { dev: 'ACCESS-SW', text: 'test cable-diagnostics tdr interface g0/1' },
      how: 'Type test cable-diagnostics tdr interface g0/1. The switch sends pulses down the cable and times the echoes (a TDR test).',
      done: c => c.ran('ACCESS-SW', l => iosIs(l, 'test cable-diagnostics tdr interface g0/1')),
      learned: 'The test is running. Cisco prints the results with a separate show command.',
    },
    {
      id: 'tdr-show', title: 'Read the cable test result', where: 'ACCESS-SW', cmd: { dev: 'ACCESS-SW', text: 'show cable-diagnostics tdr interface g0/1' },
      how: 'Type show cable-diagnostics tdr interface g0/1. The word "interface" is required.',
      done: c => c.ran('ACCESS-SW', l => iosIs(l, 'show cable-diagnostics tdr interface g0/1')),
      learned: 'All four pairs are "Open" about 2 m away. "Open" means the copper ends there with nothing attached. The cable from this switch port runs about 2 m to the patch panel in RACK C, so the cable is fine: nothing is plugged into the front of the panel. The day tech removed a patch cord.',
    },
    {
      id: 'go-patch', title: 'Go to the patch panel', where: 'PATCH',
      how: 'Close the console (Esc or ×). Turn to RACK C next to the switch, point at the PATCH PANEL and press E. (Or: M → Quick travel → Patch panel, then E.)',
      done: c => c.app.opened.has('PATCH'),
      learned: 'Each port on the front of the panel is permanently wired, behind the panel, to the device on its label. You fix this by plugging a patch cord into the front.',
    },
    {
      id: 'patch', title: 'Plug in the patch cord', where: 'PATCH',
      how: 'Click P01 "EDGE-RTR Gi0/1 · LAN", then click P04 "ACCESS-SW Gi0/1 · uplink". If you pick the wrong port, click a cord\'s port to unplug it. P03 and P06 are console ports: same plug, but no Ethernet.',
      done: c => c.goal(0),
      learned: 'Link light ON: the router and switch negotiated 1000 Mb/s full duplex. A link light proves the cable, not the network above it, so check it from a device.',
    },
    {
      id: 'verify', title: 'Prove it from the switch', where: 'ACCESS-SW', cmd: { dev: 'ACCESS-SW', text: 'show interfaces status' },
      how: 'Close the panel, open ACCESS-SW again and run show interfaces status. Gi0/1 should now say "connected".',
      done: () => false,
      learned: '',
    },
  ],

  M02: [
    {
      id: 'open-pc', title: 'Go to the dispatch PC', where: 'DISPATCH-01',
      how: 'Follow the marker to the dispatch desk in front of the window and press E on the PC.',
      done: c => c.app.opened.has('DISPATCH-01'),
      learned: 'This is the user\'s Windows PC. Start troubleshooting where the user is: see what the PC itself thinks.',
    },
    {
      id: 'ipconfig', title: 'Look at the PC\'s address', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'ipconfig /all' },
      how: 'Type ipconfig /all.',
      done: c => c.ran('DISPATCH-01', l => wordsIs(l, /^ipconfig\s+\/all\b/i)),
      learned: '"Autoconfiguration IPv4 Address 169.254.x.x" is APIPA: Windows asked for an address by DHCP, nobody answered, so it made one up. 169.254 addresses cannot leave the local cable. The clinic\'s DHCP server is CORE-SRV.',
    },
    {
      id: 'open-srv', title: 'Open the DHCP server', where: 'CORE-SRV',
      how: 'Close the PC (Esc). Go to RACK D and press E on the server KVM screen, or M → Quick travel → CORE-SRV.',
      done: c => c.app.opened.has('CORE-SRV'),
      learned: 'CORE-SRV is an Ubuntu Linux server running two services: ISC DHCP (isc-dhcp-server) and DNS (named).',
    },
    {
      id: 'status', title: 'Is the DHCP service running?', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'systemctl status isc-dhcp-server' },
      how: 'Type systemctl status isc-dhcp-server.',
      done: c => c.ran('CORE-SRV', l => /^(sudo\s+)?systemctl\s+status\s+isc-dhcp-server\b/i.test(l.trim())),
      learned: '"Active: failed". The service crashed, so DHCP requests reach the server but nothing is listening. Next: find out why it stopped.',
    },
    {
      id: 'journal', title: 'Read why it stopped', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'journalctl -u isc-dhcp-server' },
      how: 'Type journalctl -u isc-dhcp-server to read the service\'s log.',
      done: c => c.ev(e => e.type === 'journal' && e.host === 'CORE-SRV' && /dhcp/.test(e.unit || '')),
      learned: '"dhcpd.conf line 14: semicolon expected." Line 14 is only a "}". Parsers report where they noticed the problem, so the statement missing its ";" is the one that ends on line 13.',
    },
    {
      id: 'edit', title: 'Fix the config file', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'nano /etc/dhcp/dhcpd.conf' },
      how: 'Type nano /etc/dhcp/dhcpd.conf. Add the missing ";" at the end of line 13, then save with Ctrl+O and exit with Ctrl+X (or the buttons at the bottom of the editor).',
      done: c => { const t = c.file('CORE-SRV', '/etc/dhcp/dhcpd.conf'); return t !== null && parseDhcpd(t).ok; },
      learned: 'Saved. A changed config file does nothing until the service reads it again.',
    },
    {
      id: 'test', title: 'Test the config before starting', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'dhcpd -t -cf /etc/dhcp/dhcpd.conf' },
      how: 'Type dhcpd -t -cf /etc/dhcp/dhcpd.conf. It checks the file without starting anything.',
      done: c => c.ev(e => e.type === 'configtest' && e.host === 'CORE-SRV' && e.what === 'dhcpd' && e.ok),
      learned: 'No errors. Always test a config before (re)starting a service; otherwise it just fails again, and now you have two problems.',
    },
    {
      id: 'start', title: 'Start the DHCP service', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'systemctl start isc-dhcp-server' },
      how: 'Type systemctl start isc-dhcp-server, then systemctl status isc-dhcp-server if you want to see it running.',
      done: c => c.ev(e => e.type === 'systemctl' && e.host === 'CORE-SRV' && /dhcp/.test(e.unit || '') && e.active),
      learned: 'Running. The server answers requests now, but the PC gave up earlier and will only retry every few minutes. Ask it now.',
    },
    {
      id: 'renew', title: 'Get the PC a real address', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'ipconfig /renew' },
      how: 'Go back to DISPATCH-01 and type ipconfig /renew.',
      done: c => c.goal(0),
      learned: 'The PC went through DORA: Discover (broadcast), Offer, Request, Ack. It now has a 10.42.10.x address, a gateway and a DNS server from CORE-SRV.',
    },
    {
      id: 'verify', title: 'Confirm the lease', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'ipconfig /all' },
      how: 'Type ipconfig /all and check "DHCP Server" and "IPv4 Address".',
      done: () => false, learned: '',
    },
  ],

  M03: [
    {
      id: 'lookup', title: 'Ask DNS where the clinic app is', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'nslookup clinic.ops.example' },
      how: 'At DISPATCH-01 type nslookup clinic.ops.example. nslookup asks the DNS server directly.',
      done: c => c.ev(e => e.type === 'dns' && e.host === 'DISPATCH-01' && /clinic\.ops\.example/.test(e.name || '')),
      learned: 'DNS (CORE-SRV, 10.42.10.10) answers 10.42.10.99. Is that really the clinic app? Compare with the documentation.',
    },
    {
      id: 'ipam', title: 'Check the documentation', where: 'HOLO',
      how: 'Press M (or use the network table) and open the IPAM & DOCS tab. Find 10.42.10.99 and CLINIC-APP.',
      done: c => c.app.opened.has('map:ipam'),
      learned: '10.42.10.99 is CLINIC-OLD, decommissioned but still powered on. CLINIC-APP lives at 10.42.10.20. The DNS record is stale: it still points at the old server.',
    },
    {
      id: 'edit', title: 'Fix the DNS record', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'nano /etc/bind/db.ops.example' },
      how: 'On CORE-SRV type nano /etc/bind/db.ops.example. Change the "clinic" A record to 10.42.10.20 and add 1 to the serial number. Save (Ctrl+O) and exit (Ctrl+X).',
      done: c => {
        const t = c.file('CORE-SRV', '/etc/bind/db.ops.example');
        if (t === null) return false;
        const z = parseZone(t, 'ops.example');
        return z.ok && z.records.some(r => r.type === 'A' && r.name === 'clinic.ops.example' && r.addr === parseIp(net(c.eng.s.params, 'clinic', 20)));
      },
      learned: 'The file is right now, but the DNS server still serves the old copy it loaded at startup.',
    },
    {
      id: 'check', title: 'Check the zone file', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'named-checkzone ops.example /etc/bind/db.ops.example' },
      how: 'Type named-checkzone ops.example /etc/bind/db.ops.example.',
      done: c => c.ev(e => e.type === 'configtest' && e.host === 'CORE-SRV' && e.what === 'zone' && e.ok),
      learned: '"OK" and the new serial. Like dhcpd -t, test before you load.',
    },
    {
      id: 'reload', title: 'Load the corrected zone', where: 'CORE-SRV', cmd: { dev: 'CORE-SRV', text: 'rndc reload' },
      how: 'Type rndc reload.',
      done: c => c.ev(e => e.type === 'rndc' && e.host === 'CORE-SRV' && e.ok) && c.goal(0),
      learned: 'BIND now answers 10.42.10.20. But the dispatch PC cached the old answer and will keep using it until the record\'s TTL (300 s) runs out.',
    },
    {
      id: 'flush', title: 'Clear the PC\'s DNS cache', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'ipconfig /flushdns' },
      how: 'At DISPATCH-01 type ipconfig /flushdns (ipconfig /displaydns shows what it had cached).',
      done: c => c.ev(e => e.type === 'flushdns' && e.host === 'DISPATCH-01'),
      learned: 'Cache cleared. Browsers, ping and curl use that cache; nslookup does not, which is why nslookup can look fixed while the app is still broken.',
    },
    {
      id: 'verify', title: 'Test the actual app', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'curl https://clinic.ops.example/health' },
      how: 'Type curl https://clinic.ops.example/health. Ping only proves something answers; curl proves the app works.',
      done: () => false, learned: '',
    },
  ],

  M04: [
    {
      id: 'trace', title: 'Trace the path to the backup service', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'tracert 203.0.113.20' },
      how: 'At DISPATCH-01 type tracert 203.0.113.20 (the backup service\'s address). Use the address, not the name: tonight even external names fail to resolve, because the DNS server also needs the internet to look them up.',
      done: c => c.ev(e => e.type === 'trace' && e.host === 'DISPATCH-01' && e.ip !== undefined),
      learned: 'Hop 1 is the clinic gateway, EDGE-RTR (10.42.10.1). Hop 2: "10.42.10.1 reports: Destination net unreachable." The router itself has nowhere to send traffic for the internet.',
    },
    {
      id: 'open-rtr', title: 'Open the router console', where: 'EDGE-RTR',
      how: 'Go to RACK A and press E on EDGE-RTR (or M → Quick travel → EDGE-RTR).',
      done: c => c.app.opened.has('EDGE-RTR'),
      learned: 'EDGE-RTR connects the clinic VLANs to the internet provider on Gi0/0.',
    },
    {
      id: 'route', title: 'Read the routing table', where: 'EDGE-RTR', cmd: { dev: 'EDGE-RTR', text: 'show ip route' },
      how: 'Type enable, then show ip route.',
      done: c => c.ran('EDGE-RTR', l => iosIs(l, 'show ip route')),
      learned: '"Gateway of last resort is not set" and no "S*" line: the router has no default route installed, so anything not in a clinic subnet is dropped.',
    },
    {
      id: 'config', title: 'Compare with the configuration', where: 'EDGE-RTR', cmd: { dev: 'EDGE-RTR', text: 'show running-config | include ip route' },
      how: 'Type show running-config | include ip route, then show ip interface brief to see the WAN address on Gi0/0.',
      done: c => c.ran('EDGE-RTR', l => iosIs(l, 'show running-config')),
      learned: 'The config says "ip route 0.0.0.0 0.0.0.0 198.51.100.5", but Gi0/0 is 198.51.100.2 on a /30, which holds only .1 and .2. The next hop .5 is not on any connected network, so IOS keeps the line but cannot install it. The provider\'s end is .1.',
    },
    {
      id: 'fix', title: 'Replace the default route', where: 'EDGE-RTR', cmd: { dev: 'EDGE-RTR', text: 'configure terminal' },
      how: 'Type, one per line: configure terminal · no ip route 0.0.0.0 0.0.0.0 198.51.100.5 · ip route 0.0.0.0 0.0.0.0 198.51.100.1 · end',
      done: c => c.goal(0),
      learned: 'Installed. "show ip route" now shows "S* 0.0.0.0/0 [1/0] via 198.51.100.1" and a gateway of last resort.',
    },
    {
      id: 'verify', title: 'Test the backup service', where: 'DISPATCH-01', cmd: { dev: 'DISPATCH-01', text: 'curl https://backup.example.net/health' },
      how: 'At DISPATCH-01 type curl https://backup.example.net/health.',
      done: () => false, learned: '',
    },
  ],
};

export function coachSteps(missionId) { return COACH[missionId] || null; }
