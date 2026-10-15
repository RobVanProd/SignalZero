// District 04: the campaign network. Built as plain JSON state for the engine.
// Addressing convention (campaign only): VLAN n -> 10.42.n.0/24. Challenges randomise this so players
// do not learn a convention instead of the skill.
import { device, addPort, link, resetDeviceCounter } from '../engine/model.js';
import { parseIp as ip } from '../engine/ipv4.js';

export const DEFAULT_PARAMS = {
  site: 42,
  vlans: { clinic: 10, staff: 20, guest: 30, cams: 40, doors: 41 },
  // third octet of each role's subnet (campaign: equal to the VLAN id; challenges: decoupled)
  octets: { clinic: 10, staff: 20, guest: 30, cams: 40 },
  wan: { local: '198.51.100.2', peer: '198.51.100.1', len: 30 },
};

/** Address in a role's subnet. `role` is a key of params.octets, or a VLAN id for legacy calls. */
export function net(p, role, host) {
  return `10.${p.site}.${p.octets[role]}.${host}`;
}

export function dhcpdConf(p, o = {}) {
  const v = p.vlans;
  const camNet = o.camNet ?? net(p, "cams", 0);
  const camMask = o.camMask ?? '255.255.255.224';
  const camRange = o.camRange ?? [net(p, "cams", 10), net(p, "cams", 30)];
  const camGw = o.camGw ?? net(p, "cams", 1);
  return `# /etc/dhcp/dhcpd.conf -- CORE-SRV (ISC DHCP 4.4)
# Change control: night shift. Test with: dhcpd -t -cf /etc/dhcp/dhcpd.conf

authoritative;
default-lease-time 28800;
max-lease-time 86400;
option domain-name "ops.example";
option domain-name-servers ${net(p, "clinic", 10)};

# VLAN ${v.clinic} CLINIC
subnet ${net(p, "clinic", 0)} netmask 255.255.255.0 {
  range ${net(p, "clinic", 100)} ${net(p, "clinic", 199)};
  option routers ${net(p, "clinic", 1)}${o.clinicTypo ? '' : ';'}
}

# VLAN ${v.staff} STAFF
subnet ${net(p, "staff", 0)} netmask 255.255.255.0 {
  range ${net(p, "staff", 100)} ${net(p, "staff", 199)};
  option routers ${net(p, "staff", 1)};
}

# VLAN ${v.guest} GUEST WI-FI
subnet ${net(p, "guest", 0)} netmask 255.255.255.0 {
  range ${net(p, "guest", 50)} ${net(p, "guest", 250)};
  option routers ${net(p, "guest", 1)};
  default-lease-time 3600;
}

# VLAN ${v.cams} CAMERAS (short lease: cameras renew at T1 = 300 s)
subnet ${camNet} netmask ${camMask} {
  range ${camRange[0]} ${camRange[1]};
  option routers ${camGw};
  default-lease-time 600;
}
`;
}

export function zoneFile(p, clinicIp, serial = 2026101401) {
  return `; /etc/bind/db.ops.example -- authoritative zone for ops.example
; Bump the serial when you edit. Check: named-checkzone ops.example /etc/bind/db.ops.example
; Apply:  rndc reload
$TTL 300
@        IN SOA  core-srv.ops.example. hostmaster.ops.example. (
                 ${serial} ; serial
                 3600       ; refresh
                 900        ; retry
                 604800     ; expire
                 300 )      ; negative-cache TTL
         IN NS   core-srv.ops.example.
core-srv IN A    ${net(p, 'clinic', 10)}
edge-rtr IN A    ${net(p, 'clinic', 1)}
clinic   IN A    ${clinicIp}
nvr      IN A    ${net(p, 'clinic', 30)}
`;
}

const NAMED_CONF = `// /etc/bind/named.conf.local
zone "ops.example" {
    type master;
    file "/etc/bind/db.ops.example";
};
`;
const NAMED_OPTIONS = `// /etc/bind/named.conf.options
options {
    directory "/var/cache/bind";
    recursion yes;
    allow-recursion { 10.0.0.0/8; };
    forwarders { 203.0.113.53; };
    dnssec-validation auto;
    listen-on { any; };
};
`;

function nginxSite(names, routes, extra = {}) {
  return { names, cert: { names: extra.certNames ?? names }, routes, default: !!extra.default };
}

function web(sites, ports = [443, 80]) {
  return { kind: 'web', unit: 'nginx', active: true, listen: ports.map(port => ({ proto: 'tcp', port })), sites };
}

function sshd() { return { kind: 'ssh', unit: 'ssh', active: true, listen: [{ proto: 'tcp', port: 22 }] }; }

/**
 * Build the district at the start of the night shift (Act 0): five latent faults are present.
 * Sector B equipment exists but is powered off / unpatched until Act I missions bring it in.
 */
export function buildDistrict(params = DEFAULT_PARAMS) {
  const p = params;
  const v = p.vlans;
  resetDeviceCounter();
  const D = {};
  const add = d => { D[d.id] = d; return d; };

  // ---------------------------------------------------------- EDGE-RTR
  const rtr = add(device('EDGE-RTR', 'router', 'ios', { model: 'ISR4331', map: { x: 260, y: 90 }, role: 'Gateway / inter-VLAN routing / NAT' }));
  addPort(rtr, 'Gi0/0', { ip: { addr: ip(p.wan.local), len: p.wan.len }, nat: 'outside', description: 'WAN to ISP (circuit DC-44817)' });
  addPort(rtr, 'Gi0/1', { description: 'TRUNK to ACCESS-SW Gi0/1' });
  addPort(rtr, 'Gi0/2', { adminUp: false });
  addPort(rtr, 'Con0', { kind: 'console' });
  const sub = (role, host, len, extra = {}) => {
    const vlan = v[role];
    const name = `Gi0/1.${vlan}`;
    rtr.subifs[name] = { name, parent: 'Gi0/1', vlan, native: false, adminUp: true, ip: { addr: ip(net(p, role === 'doors' ? 'cams' : role, host)), len }, helpers: [], aclIn: null, aclOut: null, nat: 'inside', proxyArp: false, unreachables: true, description: '', ...extra };
  };
  const helper = ip(net(p, "clinic", 10));
  sub('clinic', 1, 24, { description: 'CLINIC' });
  sub('staff', 1, 24, { description: 'STAFF', helpers: [] }); // FAULT (M7): missing ip helper-address
  sub('guest', 1, 24, { description: 'GUEST', helpers: [helper] });
  sub('cams', 1, 27, { description: 'CAMERAS', helpers: [helper] });
  // Door controllers share the camera /24 (10.x.40.64/27): the overlap trap for M8.
  sub('doors', 65, 27, { description: 'DOOR-CONTROLLERS' });
  rtr.acls['NAT-INSIDE'] = { kind: 'standard', entries: [{ seq: 10, action: 'permit', src: { addr: ip(`10.${p.site}.0.0`), wild: ip('0.0.255.255') } }] };
  rtr.nat.push({ acl: 'NAT-INSIDE', iface: 'Gi0/0', overload: true });
  // FAULT (M4): typo in the default route next hop; IOS accepts it but cannot install it.
  rtr.routes.push({ net: 0, len: 0, nh: ip('198.51.100.5') });

  // ---------------------------------------------------------- ISP + Internet
  const isp = add(device('ISP-PE', 'router', 'isp', { managed: false, model: 'Provider edge', map: { x: 90, y: 90 }, role: 'Internet service provider edge', zone: 'offsite' }));
  addPort(isp, 'Gi0/0', { ip: { addr: ip(p.wan.peer), len: p.wan.len } });
  addPort(isp, 'Gi0/1', { ip: { addr: ip('203.0.113.1'), len: 24 } });
  const inet = add(device('INTERNET', 'bridge', 'none', { managed: false, map: { x: 40, y: 200 }, zone: 'offsite' }));
  for (let i = 1; i <= 6; i++) addPort(inet, `p${i}`);
  const inetHost = (id, addr, services, role) => {
    const d = add(device(id, 'host', 'linux', { managed: false, ipcfg: { dhcp: false, static: { addr: ip(addr), len: 24, gw: ip('203.0.113.1'), dns: [] } }, services, role, zone: 'offsite' }));
    addPort(d, 'eth0');
    return d;
  };
  inetHost('BACKUP', '203.0.113.20', { nginx: web([nginxSite(['backup.example.net'], { '/health': { status: 200, body: '{"backup":"ready","uploads":"accepted"}' }, '/': { status: 200, body: '{"service":"backup-api","version":"3.2"}' } }, { default: true })]) }, 'Remote backup service');
  inetHost('PORTAL', '203.0.113.80', { nginx: web([nginxSite(['portal.example.net'], { '/': { status: 200, body: '<html><title>Guest portal</title>Welcome to City Clinic guest Wi-Fi</html>', type: 'text/html' }, '/health': { status: 200, body: '{"portal":"up"}' } }, { default: true })]) }, 'Public web portal');
  inetHost('RESOLVER', '203.0.113.53', { 'public-dns': { kind: 'dns', unit: 'unbound', active: true, listen: [{ proto: 'udp', port: 53 }] } }, 'Public recursive DNS resolver');
  inetHost('SIP-GW', '203.0.113.50', { sip: { kind: 'sip', unit: 'kamailio', active: true, listen: [{ proto: 'udp', port: 5060 }, { proto: 'tcp', port: 5061 }] } }, 'Regional dispatch voice gateway');

  // ---------------------------------------------------------- ACCESS-SW
  const sw = add(device('ACCESS-SW', 'switch', 'ios', { model: 'C9200-24P', map: { x: 420, y: 190 }, role: 'Access switch, NOC floor' }));
  for (let i = 1; i <= 24; i++) addPort(sw, `Gi0/${i}`, { portfast: true });
  addPort(sw, 'Con0', { kind: 'console' });
  sw.vlans = { 1: 'default', [v.clinic]: 'CLINIC', [v.staff]: 'STAFF', [v.guest]: 'GUEST', [v.cams]: 'CAMERAS', [v.doors]: 'DOORS' };
  const trunk = (sw2, name, desc) => Object.assign(sw2.ports[name], { mode: 'trunk', allowed: [v.clinic, v.staff, v.guest, v.cams, v.doors], native: 1, portfast: false, description: desc });
  const access = (sw2, name, vlan, desc) => Object.assign(sw2.ports[name], { mode: 'access', accessVlan: vlan, description: desc });
  trunk(sw, 'Gi0/1', 'UPLINK EDGE-RTR');
  access(sw, 'Gi0/2', v.clinic, 'DISPATCH-01');
  access(sw, 'Gi0/3', v.clinic, 'CORE-SRV');
  access(sw, 'Gi0/4', v.clinic, 'CLINIC-APP');
  access(sw, 'Gi0/5', v.clinic, 'CLINIC-OLD (decom pending)');
  access(sw, 'Gi0/6', v.clinic, 'GUEST-AP'); // FAULT (M5): guest AP lives in the clinic VLAN
  access(sw, 'Gi0/7', v.clinic, 'CCTV-NVR');
  access(sw, 'Gi0/9', v.guest, 'LOBBY JACK L-09');
  access(sw, 'Gi0/10', v.guest, 'LOBBY JACK L-10');
  trunk(sw, 'Gi0/23', 'RISER A to SECTOR B');
  trunk(sw, 'Gi0/24', 'RISER B to SECTOR B');
  for (const n of ['Gi0/10', 'Gi0/11', 'Gi0/12', 'Gi0/13', 'Gi0/14', 'Gi0/15', 'Gi0/16', 'Gi0/17', 'Gi0/18', 'Gi0/19', 'Gi0/20', 'Gi0/21', 'Gi0/22']) sw.ports[n].adminUp = true;

  // ---------------------------------------------------------- NOC hosts
  const win = (id, nic = 'eth0', extra = {}) => {
    const d = add(device(id, 'host', 'windows', { ipcfg: { dhcp: true, static: null }, ...extra }));
    addPort(d, nic, nic === 'wlan0' ? { kind: 'wifi', media: 'wifi' } : {});
    d.nic = nic;
    return d;
  };
  const lin = (id, addr, len, gw, services, extra = {}) => {
    const d = add(device(id, 'host', 'linux', { ipcfg: { dhcp: false, static: { addr: ip(addr), len, gw: ip(gw), dns: [ip(net(p, "clinic", 10))] } }, services, ...extra }));
    addPort(d, 'eth0');
    return d;
  };
  const dispatch = win('DISPATCH-01', 'eth0', { map: { x: 300, y: 300 }, role: 'Clinic dispatch workstation' });
  dispatch.apipa = ip('169.254.17.44'); // booted while the uplink was down: DHCP failed
  dispatch.nextDhcpRetry = 300;

  const core = lin('CORE-SRV', net(p, "clinic", 10), 24, net(p, "clinic", 1), {
    'isc-dhcp-server': { kind: 'dhcp', unit: 'isc-dhcp-server', active: false, failed: true, conf: '/etc/dhcp/dhcpd.conf', listen: [{ proto: 'udp', port: 67 }], leases: {} },
    named: { kind: 'dns', unit: 'named', active: true, listen: [{ proto: 'udp', port: 53 }, { proto: 'tcp', port: 53 }], zones: [{ zone: 'ops.example', file: '/etc/bind/db.ops.example' }], forwarders: [ip('203.0.113.53')], recursion: true },
    sshd: sshd(),
  }, { map: { x: 560, y: 90 }, role: 'DHCP + DNS server (Ubuntu 24.04)' });
  // FAULT (M2): last night's edit left a missing semicolon; the service crashed at 01:52.
  core.files['/etc/dhcp/dhcpd.conf'] = dhcpdConf(p, { clinicTypo: true });
  // FAULT (M3): clinic still points at the decommissioned server.
  core.files['/etc/bind/db.ops.example'] = zoneFile(p, net(p, "clinic", 99));
  core.files['/etc/bind/named.conf.local'] = NAMED_CONF;
  core.files['/etc/bind/named.conf.options'] = NAMED_OPTIONS;
  core.files['/etc/hostname'] = 'core-srv\n';
  core.journalSeed = [
    ['dhcpd', '/etc/dhcp/dhcpd.conf line 14: semicolon expected.'],
    ['dhcpd', '}'],
    ['dhcpd', '^'],
    ['dhcpd', 'Configuration file errors encountered -- exiting'],
    ['systemd', 'isc-dhcp-server.service: Main process exited, code=exited, status=1/FAILURE'],
    ['systemd', "isc-dhcp-server.service: Failed with result 'exit-code'."],
  ];

  const clinicHealth = { '/health': { status: 200, body: '{"service":"clinic-records","state":"healthy","db":"ok"}' }, '/': { status: 200, body: '<html><title>Clinic Records</title></html>', type: 'text/html' } };
  lin('CLINIC-APP', net(p, "clinic", 20), 24, net(p, "clinic", 1), { nginx: web([nginxSite(['clinic.ops.example'], clinicHealth, { default: true })]), sshd: sshd() }, { map: { x: 720, y: 190 }, role: 'Clinic records application (nginx)' });
  lin('CLINIC-OLD', net(p, "clinic", 99), 24, net(p, "clinic", 1), { nginx: web([nginxSite(['clinic.ops.example'], { '*': { status: 503, body: '<html><title>503</title>This server was decommissioned on 2026-10-01. Records moved.</html>', type: 'text/html' } }, { default: true })]) }, { map: { x: 720, y: 290 }, role: 'Decommissioned clinic server (still powered)' });
  lin('CCTV-NVR', net(p, "clinic", 30), 24, net(p, "clinic", 1), { rtsp: { kind: 'rtsp', unit: 'nvr-ingest', active: true, listen: [{ proto: 'tcp', port: 554 }] }, sshd: sshd() }, { map: { x: 560, y: 300 }, role: 'Video recorder (RTSP ingest)' });

  // Guest Wi-Fi: unmanaged AP bridging the kiosk.
  const ap = add(device('GUEST-AP', 'bridge', 'none', { managed: false, map: { x: 560, y: 380 }, role: 'Guest wireless access point' }));
  addPort(ap, 'eth0');
  addPort(ap, 'wlan0', { kind: 'wifi', media: 'wifi' });
  const kiosk = win('GUEST-KIOSK', 'wlan0', { map: { x: 720, y: 380 }, role: 'Lobby guest kiosk (Wi-Fi)' });

  // ---------------------------------------------------------- Sector B (Act I)
  const swb = add(device('DIST-SW-B', 'switch', 'ios', { model: 'C9200-24P', map: { x: 420, y: 470 }, role: 'Sector B distribution switch', zone: 'sectorb' }));
  for (let i = 1; i <= 24; i++) addPort(swb, `Gi0/${i}`, { portfast: true });
  addPort(swb, 'Con0', { kind: 'console' });
  swb.vlans = { ...sw.vlans };
  trunk(swb, 'Gi0/23', 'RISER A to NOC');
  trunk(swb, 'Gi0/24', 'RISER B to NOC');
  access(swb, 'Gi0/2', v.clinic, 'NURSE-STATION');
  access(swb, 'Gi0/3', v.staff, 'STAFF-LAPTOP');
  access(swb, 'Gi0/4', v.cams, 'CAMERA PoE BANK');
  access(swb, 'Gi0/5', v.doors, 'DOOR-CTRL');
  access(swb, 'Gi0/6', v.clinic, 'VOIP-PHONE');
  const nurse = win('NURSE-STATION', 'eth0', { map: { x: 300, y: 560 }, role: 'Ward nurse station', zone: 'sectorb' });
  const staff = win('STAFF-LAPTOP', 'eth0', { map: { x: 420, y: 600 }, role: 'Staff laptop', zone: 'sectorb' });
  const cams = add(device('CAMERAS', 'fleet', 'linux', { count: 50, map: { x: 560, y: 560 }, role: '50 PoE IP cameras', zone: 'sectorb' }));
  addPort(cams, 'eth0');
  lin('DOOR-CTRL', net(p, "cams", 70), 27, net(p, "cams", 65), { sshd: sshd() }, { map: { x: 700, y: 560 }, role: 'Door access controller', zone: 'sectorb' });
  const phone = add(device('VOIP-PHONE', 'host', 'linux', { ipcfg: { dhcp: true, static: null }, map: { x: 200, y: 600 }, role: 'Dispatch desk phone', zone: 'sectorb' }));
  addPort(phone, 'eth0');
  for (const d of [swb, nurse, staff, cams, D['DOOR-CTRL'], phone]) d.powered = false;

  // ---------------------------------------------------------- links
  const L = {};
  const lk = (id, a, b, o) => { L[id] = link(id, a, b, o); };
  lk('wan', ['EDGE-RTR', 'Gi0/0'], ['ISP-PE', 'Gi0/0'], { latencyMs: 4.2, label: 'WAN circuit', lengthM: 40 });
  lk('isp-core', ['ISP-PE', 'Gi0/1'], ['INTERNET', 'p1'], { latencyMs: 5.8, lengthM: 30 });
  lk('inet-backup', ['INTERNET', 'p2'], ['BACKUP', 'eth0'], { latencyMs: 1.5 });
  lk('inet-portal', ['INTERNET', 'p3'], ['PORTAL', 'eth0'], { latencyMs: 1.5 });
  lk('inet-resolver', ['INTERNET', 'p4'], ['RESOLVER', 'eth0'], { latencyMs: 1.2 });
  lk('inet-sip', ['INTERNET', 'p5'], ['SIP-GW', 'eth0'], { latencyMs: 2.4 });
  // FAULT (M1): the router-to-switch patch cord is missing at RACK C.
  lk('sw-dispatch', ['ACCESS-SW', 'Gi0/2'], ['DISPATCH-01', 'eth0'], { lengthM: 18 });
  lk('sw-core', ['ACCESS-SW', 'Gi0/3'], ['CORE-SRV', 'eth0']);
  lk('sw-clinic', ['ACCESS-SW', 'Gi0/4'], ['CLINIC-APP', 'eth0']);
  lk('sw-old', ['ACCESS-SW', 'Gi0/5'], ['CLINIC-OLD', 'eth0']);
  lk('sw-ap', ['ACCESS-SW', 'Gi0/6'], ['GUEST-AP', 'eth0'], { lengthM: 34 });
  lk('sw-nvr', ['ACCESS-SW', 'Gi0/7'], ['CCTV-NVR', 'eth0']);
  lk('ap-kiosk', ['GUEST-AP', 'wlan0'], ['GUEST-KIOSK', 'wlan0'], { media: 'wifi', latencyMs: 2.2 });
  lk('swb-nurse', ['DIST-SW-B', 'Gi0/2'], ['NURSE-STATION', 'eth0'], { lengthM: 22 });
  lk('swb-staff', ['DIST-SW-B', 'Gi0/3'], ['STAFF-LAPTOP', 'eth0'], { lengthM: 15 });
  lk('swb-cams', ['DIST-SW-B', 'Gi0/4'], ['CAMERAS', 'eth0'], { lengthM: 60 });
  lk('swb-door', ['DIST-SW-B', 'Gi0/5'], ['DOOR-CTRL', 'eth0'], { lengthM: 40 });
  lk('swb-phone', ['DIST-SW-B', 'Gi0/6'], ['VOIP-PHONE', 'eth0'], { lengthM: 12 });

  const state = {
    version: 3,
    params: p,
    t: 0,
    devices: D,
    links: L,
    patch: { cords: [] },
    internet: { names: { 'backup.example.net': '203.0.113.20', 'portal.example.net': '203.0.113.80', 'sip.example.net': '203.0.113.50', 'resolver.example.net': '203.0.113.53' } },
    flows: [],
  };
  return state;
}

/**
 * RACK C patch panel. Each front port is permanently wired (behind the panel) to one device port.
 * A front patch cord between two panel ports creates a link between the two device ports.
 */
export const PATCH_PANEL = [
  { id: 'P01', dev: 'EDGE-RTR', port: 'Gi0/1', label: 'EDGE-RTR Gi0/1 · LAN' },
  { id: 'P02', dev: 'EDGE-RTR', port: 'Gi0/2', label: 'EDGE-RTR Gi0/2 · spare' },
  { id: 'P03', dev: 'EDGE-RTR', port: 'Con0', label: 'EDGE-RTR CONSOLE' },
  { id: 'P04', dev: 'ACCESS-SW', port: 'Gi0/1', label: 'ACCESS-SW Gi0/1 · uplink' },
  { id: 'P05', dev: 'ACCESS-SW', port: 'Gi0/12', label: 'ACCESS-SW Gi0/12 · spare' },
  { id: 'P06', dev: 'ACCESS-SW', port: 'Con0', label: 'ACCESS-SW CONSOLE' },
  { id: 'P07', dev: 'ACCESS-SW', port: 'Gi0/23', label: 'ACCESS-SW Gi0/23 · riser A' },
  { id: 'P08', dev: 'ACCESS-SW', port: 'Gi0/24', label: 'ACCESS-SW Gi0/24 · riser B' },
  { id: 'P09', dev: 'DIST-SW-B', port: 'Gi0/23', label: 'SECTOR B Gi0/23 · riser A' },
  { id: 'P10', dev: 'DIST-SW-B', port: 'Gi0/24', label: 'SECTOR B Gi0/24 · riser B' },
];

export function patchLinkId(a, b) {
  const [x, y] = [a, b].sort();
  return `patch:${x}-${y}`;
}

/** Connect two patch panel ports. Returns { ok, msg }. */
export function patchConnect(eng, a, b, actor = 'player') {
  const s = eng.s;
  if (a === b) return { ok: false, msg: 'A patch cord needs two different ports.' };
  const pa = PATCH_PANEL.find(x => x.id === a);
  const pb = PATCH_PANEL.find(x => x.id === b);
  if (!pa || !pb) return { ok: false, msg: 'Unknown panel port.' };
  for (const used of s.patch.cords) {
    if (used.includes(a) || used.includes(b)) return { ok: false, msg: `Port ${used.includes(a) ? a : b} already has a cord in it. Unplug it first.` };
  }
  if (eng.linkAt(pa.dev, pa.port) || eng.linkAt(pb.dev, pb.port)) return { ok: false, msg: 'That device port is already cabled elsewhere.' };
  const id = patchLinkId(a, b);
  s.links[id] = link(id, [pa.dev, pa.port], [pb.dev, pb.port], { patch: 'RACK-C', label: `${a}↔${b}`, lengthM: 2 + (pa.dev.includes('DIST') || pb.dev.includes('DIST') ? 45 : 0) });
  s.patch.cords.push([a, b]);
  eng.mutated(`patch ${a} <-> ${b}`, actor);
  return { ok: true, id };
}

export function patchDisconnect(eng, a, actor = 'player') {
  const s = eng.s;
  const cord = s.patch.cords.find(c => c.includes(a));
  if (!cord) return { ok: false, msg: `Nothing is plugged into ${a}.` };
  s.patch.cords = s.patch.cords.filter(c => c !== cord);
  delete s.links[patchLinkId(cord[0], cord[1])];
  eng.mutated(`unpatch ${cord[0]} <-> ${cord[1]}`, actor);
  return { ok: true, cord };
}
