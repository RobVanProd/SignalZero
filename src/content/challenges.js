// Night Shift challenges: randomised addressing + injected faults, generated from a verified-healthy network.
// The generator proves every challenge is solvable before handing it out:
//   healthy network passes all checks  ->  injected faults break at least one user-facing flow
//   ->  the reference repair (applied to a copy) restores every check.
import { Engine } from '../engine/engine.js';
import { parseIp as ip, fmtIp } from '../engine/ipv4.js';
import { buildDistrict, net, dhcpdConf, zoneFile, DEFAULT_PARAMS, bnet, BRANCH } from './district.js';
import { MISSIONS, enableFlows, cli, httpOk, reaches } from './missions.js';
import { dhcpClient, applyDhcpResult, dhcpdStop } from '../engine/services.js';
import { saveFile } from '../cli/index.js';
import { renderNetplan } from '../engine/parsers/netplan.js';
// ---- ipv6
import { v6Reboot } from '../engine/net6.js';
import { WAN6 } from './district.js';

export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];

export function randomParams(rng) {
  const site = 16 + Math.floor(rng() * 230);
  const pool = [11, 12, 15, 21, 25, 31, 33, 50, 60, 70, 80, 99, 101, 110, 120, 130, 150, 200, 210, 220];
  const take = () => pool.splice(Math.floor(rng() * pool.length), 1)[0];
  const vlans = { clinic: take(), staff: take(), guest: take(), cams: take() };
  vlans.doors = vlans.cams + 1;
  const used = new Set();
  const oct = () => { let o; do { o = 1 + Math.floor(rng() * 250); } while (used.has(o) || Object.values(vlans).includes(o)); used.add(o); return o; };
  return { site, vlans, octets: { clinic: oct(), staff: oct(), guest: oct(), cams: oct() }, wan: DEFAULT_PARAMS.wan };
}

/** A fully repaired district (all campaign missions solved) with every service flow enabled. */
export function buildHealthy(params) {
  const eng = new Engine(buildDistrict(params));
  eng.converge();
  eng.s.flows = [];
  enableFlows(eng, ['clinic', 'backup']);
  for (const m of MISSIONS) {
    m.setup?.(eng);
    m.reference(eng);
    eng.advance(3);
  }
  // remove the rogue device from the final mission
  delete eng.s.links.rogue;
  delete eng.s.links.rogue2;
  delete eng.s.devices['ROGUE-AP'];
  for (const l of Object.values(eng.s.links)) l.cut = false;
  eng.reindex();
  eng.mutated('maintenance window closed', 'system');
  eng.advance(35);
  enableFlows(eng, ['clinic', 'backup', 'guest', 'isolation', 'nurse', 'staff', 'cams', 'voice', 'ipv6', 'branch', 'branch-share']);
  eng.s.changeLog = [];
  eng.s.events = [];
  for (const d of Object.values(eng.s.devices)) { if (d.logging) d.logging = []; if (d.journal) d.journal = d.journal.slice(-20); }
  return eng;
}

export function healthReport(eng) {
  eng.evaluateFlows();
  const flows = eng.s.flows.map(f => ({ id: f.id, label: f.label, ok: !!eng.s.flowState[f.id]?.ok && !eng.s.flowState[f.id]?.degraded, detail: eng.s.flowState[f.id]?.detail }));
  const storm = eng.storms().size > 0;
  return { ok: flows.every(f => f.ok) && !storm, flows, storm };
}

function reboot(eng, id) {
  const d = eng.s.devices[id];
  v6Reboot(eng, d); // ---- ipv6: a reboot forgets what Router Advertisements taught it, then solicits again
  d.dnsCache = {};
  const res = dhcpClient(eng, d, { mode: 'discover', current: null });
  applyDhcpResult(eng, d, res);
}

const P = eng => eng.s.params;
const vl = (eng, r) => eng.s.params.vlans[r];

/**
 * Fault library. inject() changes the healthy network the way a real incident or bad change would;
 * fix() is the reference repair (what an engineer would type), used to prove solvability.
 */
export const FAULTS = [
  {
    id: 'port-shut', title: 'Access port administratively down', objectives: ['2.2', '5.2', '5.5'],
    inject(eng) { const r = cli(eng); r('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/2', 'shutdown', 'end'); return { change: 'DIST-SW-B: interface Gi0/2 shutdown (cable audit, ticket CHG-3110)' }; },
    fix(eng) { cli(eng)('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/2', 'no shutdown', 'end'); eng.advance(2); },
  },
  {
    id: 'wrong-access-vlan', title: 'Host port in the wrong VLAN', objectives: ['2.2', '5.3', '1.7'],
    inject(eng) { cli(eng)('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/2', `switchport access vlan ${vl(eng, 'guest')}`, 'end'); reboot(eng, 'NURSE-STATION'); return { change: 'DIST-SW-B: port moves for the ward refit' }; },
    // No link change on a VLAN move: the PC keeps its guest-subnet lease, and a plain renew (unicast through a gateway it
    // can no longer reach) times out. Release and renew (or bounce the port) makes it start over.
    fix(eng) { cli(eng)('DIST-SW-B', 'enable', 'configure terminal', 'interface g0/2', `switchport access vlan ${vl(eng, 'clinic')}`, 'end'); cli(eng)('NURSE-STATION', 'ipconfig /release', 'ipconfig /renew'); },
  },
  {
    id: 'trunk-pruned', title: 'VLAN removed from the riser trunks', objectives: ['2.2', '5.3'],
    inject(eng) { cli(eng)('DIST-SW-B', 'enable', 'configure terminal', 'interface range g0/23 - 24', `switchport trunk allowed vlan remove ${vl(eng, 'clinic')}`, 'end'); return { change: 'DIST-SW-B: trunk clean-up' }; },
    fix(eng) { cli(eng)('DIST-SW-B', 'enable', 'configure terminal', 'interface range g0/23 - 24', `switchport trunk allowed vlan add ${vl(eng, 'clinic')}`, 'end'); eng.advance(3); },
  },
  {
    id: 'helper-missing', title: 'DHCP relay missing on a gateway', objectives: ['3.4', '2.1', '5.3'],
    inject(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${vl(eng, 'staff')}`, 'no ip helper-address', 'end'); reboot(eng, 'STAFF-LAPTOP'); return { change: 'EDGE-RTR: removed legacy helper addresses' }; },
    fix(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${vl(eng, 'staff')}`, `ip helper-address ${net(P(eng), 'clinic', 10)}`, 'end'); cli(eng)('STAFF-LAPTOP', 'ipconfig /renew'); },
  },
  {
    id: 'dhcp-stopped', title: 'DHCP service stopped', objectives: ['3.4', '5.3', '5.5'],
    inject(eng) { dhcpdStop(eng, eng.s.devices['CORE-SRV']); eng.journal(eng.s.devices['CORE-SRV'], 'systemd', 'Stopped isc-dhcp-server.service - ISC DHCP IPv4 server.'); eng.mutated('dhcpd stopped', 'incident'); reboot(eng, 'NURSE-STATION'); return { change: 'CORE-SRV: patching window (kernel update)' }; },
    fix(eng) { cli(eng)('CORE-SRV', 'systemctl start isc-dhcp-server'); cli(eng)('NURSE-STATION', 'ipconfig /renew'); },
  },
  {
    id: 'dhcp-bad-router', title: 'DHCP scope hands out the wrong gateway', objectives: ['3.4', '1.7', '5.3'],
    inject(eng) {
      const f = '/etc/dhcp/dhcpd.conf';
      const c = eng.s.devices['CORE-SRV'].files[f];
      saveFile(eng, 'CORE-SRV', f, c.replace(`option routers ${net(P(eng), 'staff', 1)};`, `option routers ${net(P(eng), 'staff', 254)};`));
      cli(eng)('CORE-SRV', 'systemctl restart isc-dhcp-server');
      reboot(eng, 'STAFF-LAPTOP');
      return { change: 'CORE-SRV: dhcpd.conf tidy-up' };
    },
    fix(eng) {
      const f = '/etc/dhcp/dhcpd.conf';
      const c = eng.s.devices['CORE-SRV'].files[f];
      saveFile(eng, 'CORE-SRV', f, c.replace(`option routers ${net(P(eng), 'staff', 254)};`, `option routers ${net(P(eng), 'staff', 1)};`));
      cli(eng)('CORE-SRV', 'systemctl restart isc-dhcp-server');
      cli(eng)('STAFF-LAPTOP', 'ipconfig /release', 'ipconfig /renew');
    },
  },
  {
    id: 'dns-stale', title: 'DNS record points at the wrong host', objectives: ['3.4', '5.3', '5.5'],
    inject(eng) { saveFile(eng, 'CORE-SRV', '/etc/bind/db.ops.example', zoneFile(P(eng), net(P(eng), 'clinic', 99), 2026101509)); cli(eng)('CORE-SRV', 'rndc reload'); for (const h of ['DISPATCH-01', 'NURSE-STATION', 'STAFF-LAPTOP']) eng.s.devices[h].dnsCache = {}; return { change: 'CORE-SRV: zone restored from an old backup' }; },
    fix(eng) { saveFile(eng, 'CORE-SRV', '/etc/bind/db.ops.example', zoneFile(P(eng), net(P(eng), 'clinic', 20), 2026101510)); cli(eng)('CORE-SRV', 'rndc reload'); for (const h of ['DISPATCH-01', 'NURSE-STATION', 'STAFF-LAPTOP']) cli(eng)(h, 'ipconfig /flushdns'); },
  },
  {
    id: 'named-stopped', title: 'DNS service down', objectives: ['3.4', '5.3'],
    inject(eng) { eng.s.devices['CORE-SRV'].services.named.active = false; eng.journal(eng.s.devices['CORE-SRV'], 'systemd', 'named.service: Main process exited, code=killed, status=9/KILL'); eng.mutated('named killed (OOM)', 'incident'); for (const h of ['DISPATCH-01', 'NURSE-STATION', 'STAFF-LAPTOP', 'GUEST-KIOSK']) eng.s.devices[h].dnsCache = {}; return { change: 'none recorded' }; },
    fix(eng) { cli(eng)('CORE-SRV', 'systemctl start named'); },
  },
  {
    id: 'default-route', title: 'Default route next hop wrong', objectives: ['2.1', '5.3', '5.5'],
    inject(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 198.51.100.1', 'ip route 0.0.0.0 0.0.0.0 198.51.100.9', 'end'); for (const d of Object.values(eng.s.devices)) if (d.dnsCache) d.dnsCache = {}; return { change: 'EDGE-RTR: WAN migration prep' }; },
    fix(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'no ip route 0.0.0.0 0.0.0.0 198.51.100.9', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1', 'end'); },
  },
  {
    id: 'nat-inside-missing', title: 'PAT not applied to a VLAN', objectives: ['2.1', '5.3'],
    inject(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${vl(eng, 'clinic')}`, 'no ip nat inside', 'end'); return { change: 'EDGE-RTR: interface template re-applied' }; },
    fix(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${vl(eng, 'clinic')}`, 'ip nat inside', 'end'); },
  },
  {
    id: 'acl-dns', title: 'Guest ACL blocks DNS', objectives: ['4.3', '1.4', '5.3'],
    inject(eng) {
      const dns = eng.s.devices['EDGE-RTR'].acls['GUEST-IN'].entries.find(e => e.proto === 'udp' && e.dop?.ports?.includes(53));
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended GUEST-IN', `no ${dns.seq}`, 'end');
      eng.s.devices['GUEST-KIOSK'].dnsCache = {};
      return { change: 'EDGE-RTR: ACL hardening (security review)', seq: dns.seq };
    },
    fix(eng, ctx) { const g = `10.${P(eng).site}.${P(eng).octets.guest}.0`; cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'ip access-list extended GUEST-IN', `${ctx.seq} permit udp ${g} 0.0.0.255 host ${net(P(eng), 'clinic', 10)} eq domain`, 'end'); },
  },
  {
    id: 'stp-off', title: 'Spanning tree disabled with redundant risers', objectives: ['2.2', '5.3', '3.2'],
    inject(eng) { for (const sw of ['ACCESS-SW', 'DIST-SW-B']) eng.s.devices[sw].stp.disabled = [[1, 4094]]; eng.mutated('STP disabled', 'contractor'); eng.advance(2); return { change: 'contractor: "faster port bring-up"' }; },
    fix(eng) { for (const sw of ['ACCESS-SW', 'DIST-SW-B']) cli(eng)(sw, 'enable', 'configure terminal', 'spanning-tree vlan 1-4094', 'end'); eng.advance(3); },
  },
  {
    id: 'duplex', title: 'Duplex mismatch on the voice path', objectives: ['5.2', '5.4', '2.2'],
    inject(eng, rng) {
      const which = pick(rng, [['EDGE-RTR', 'g0/1'], ['DIST-SW-B', 'g0/23'], ['DIST-SW-B', 'g0/6']]);
      cli(eng)(which[0], 'enable', 'configure terminal', `interface ${which[1]}`, 'speed 100', 'duplex full', 'end');
      eng.advance(61);
      return { change: `${which[0]}: interface ${which[1]} hard-coded`, where: which };
    },
    fix(eng, ctx) { cli(eng)(ctx.where[0], 'enable', 'configure terminal', `interface ${ctx.where[1]}`, 'speed auto', 'duplex auto', 'end'); eng.advance(2); },
  },
  {
    id: 'nginx-stopped', title: 'Web service stopped', objectives: ['5.3', '1.4', '5.5'],
    inject(eng) { eng.s.devices['CLINIC-APP'].services.nginx.active = false; eng.journal(eng.s.devices['CLINIC-APP'], 'systemd', 'nginx.service: Deactivated successfully.'); eng.mutated('nginx stopped', 'incident'); return { change: 'CLINIC-APP: certificate renewal script ran' }; },
    fix(eng) { cli(eng)('CLINIC-APP', 'systemctl start nginx'); },
  },
  {
    id: 'server-gateway', title: 'Server has the wrong default gateway', objectives: ['1.7', '5.3', '2.1'],
    inject(eng) {
      const d = eng.s.devices['CLINIC-APP'];
      d.ipcfg.static = { ...d.ipcfg.static, gw: ip(net(P(eng), 'clinic', 254)) };
      d.files['/etc/netplan/01-netcfg.yaml'] = renderNetplan(d.nic, d.ipcfg.static, fmtIp);
      eng.mutated('CLINIC-APP gateway changed', 'incident');
      return { change: 'CLINIC-APP: rebuilt from a template' };
    },
    fix(eng) {
      const d = eng.s.devices['CLINIC-APP'];
      saveFile(eng, 'CLINIC-APP', '/etc/netplan/01-netcfg.yaml', d.files['/etc/netplan/01-netcfg.yaml'].replace(`via: ${net(P(eng), 'clinic', 254)}`, `via: ${net(P(eng), 'clinic', 1)}`));
      cli(eng)('CLINIC-APP', 'netplan apply');
    },
  },
  // ---- ipv6 (Act II)
  {
    id: 'ra-suppressed', title: 'Router advertisements suppressed on the clinic VLAN', objectives: ['1.8', '5.3', '1.7'],
    // "suppress" alone would still answer the Router Solicitation a rebooting host sends; "all" stops that too.
    inject(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${vl(eng, 'clinic')}`, 'ipv6 nd ra suppress all', 'end');
      reboot(eng, 'DISPATCH-01');
      v6Reboot(eng, eng.s.devices['CORE-SRV']); // a static-IPv4 server: only its learned IPv6 state is lost
      return { change: 'EDGE-RTR: "rogue RA" hardening on the clinic VLAN; CORE-SRV and DISPATCH-01 rebooted for patching' };
    },
    fix(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `interface g0/1.${vl(eng, 'clinic')}`, 'no ipv6 nd ra suppress', 'end'); },
  },
  {
    id: 'ipv6-default-route', title: 'IPv6 default route points at a host that does not exist', objectives: ['2.1', '1.8', '5.3'],
    // ::9 is inside the connected WAN /64, so IOS installs the route; Neighbor Discovery for it then fails and
    // EDGE-RTR returns ICMPv6 address unreachable.
    inject(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `no ipv6 route ::/0 ${WAN6.isp}`, 'ipv6 route ::/0 2001:db8:ffff:1::9', 'end'); return { change: 'EDGE-RTR: WAN migration prep (IPv6)' }; },
    fix(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'no ipv6 route ::/0 2001:db8:ffff:1::9', `ipv6 route ::/0 ${WAN6.isp}`, 'end'); },
  },
  {
    id: 'ipv6-acl-nd', title: 'IPv6 edge ACL blocks Neighbor Discovery', objectives: ['4.3', '1.8', '5.3'],
    // An explicit "deny ipv6 any any" comes before IOS's implicit nd-na / nd-ns permits.
    inject(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 access-list WAN6-IN', 'permit tcp any any established', 'permit icmp any any echo-reply', 'permit icmp any any unreachable', 'permit icmp any any time-exceeded', 'deny ipv6 any any log', 'exit', 'interface g0/0', 'ipv6 traffic-filter WAN6-IN in', 'end');
      return { change: 'EDGE-RTR: IPv6 edge filter added (security review SR-118)' };
    },
    fix(eng) { cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'ipv6 access-list WAN6-IN', 'sequence 45 permit icmp any any nd-na', 'sequence 46 permit icmp any any nd-ns', 'end'); },
  },
  // ---- ospf (Act II): the branch clinic over the private WAN. Faults change one router the way a real change would;
  // waits let the dead timer / SPF delay play out (the far end only notices a silent change after its dead interval).
  {
    id: 'ospf-area-mismatch', title: 'OSPF area mismatch on the private WAN', objectives: ['2.1', '5.3', '5.5'],
    inject(eng) {
      cli(eng)('BRANCH-RTR', 'enable', 'configure terminal', 'router ospf 1', `no network ${BRANCH.wanNet} 0.0.0.3 area 0`, `network ${BRANCH.wanNet} 0.0.0.3 area 1`, 'end');
      eng.advance(12);
      return { change: 'BRANCH-RTR: OSPF area clean-up (contractor ticket CHG-3412: "branch is area 1")' };
    },
    fix(eng) {
      cli(eng)('BRANCH-RTR', 'enable', 'configure terminal', 'router ospf 1', `no network ${BRANCH.wanNet} 0.0.0.3 area 1`, `network ${BRANCH.wanNet} 0.0.0.3 area 0`, 'end');
      eng.advance(45);
    },
  },
  {
    id: 'ospf-passive-wan', title: 'Passive interface on the OSPF uplink', objectives: ['2.1', '5.3'],
    inject(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'router ospf 1', 'passive-interface g0/3', 'end');
      eng.advance(12);
      return { change: 'EDGE-RTR: routing hardening, passive-interface on every interface (security review SR-77)' };
    },
    fix(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'router ospf 1', 'no passive-interface g0/3', 'end');
      eng.advance(45);
    },
  },
  {
    id: 'ospf-stale-static', title: 'Static route overrides the OSPF route', objectives: ['2.1', '5.3', '5.5'],
    inject(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `ip route ${bnet(P(eng), 0)} 255.255.255.0 ${net(P(eng), 'clinic', 254)}`, 'end');
      eng.advance(2);
      return { change: 'EDGE-RTR: temporary route for the branch LTE backup test' };
    },
    fix(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', `no ip route ${bnet(P(eng), 0)} 255.255.255.0 ${net(P(eng), 'clinic', 254)}`, 'end');
      eng.advance(3);
    },
  },
  {
    id: 'ospf-network-gap', title: 'Clinic VLAN missing from OSPF', objectives: ['2.1', '5.3'],
    inject(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'router ospf 1', `no network ${net(P(eng), 'clinic', 0)} 0.0.0.255 area 0`, 'end');
      eng.advance(12);
      return { change: 'EDGE-RTR: OSPF network statements tidied (CHG-3420)' };
    },
    fix(eng) {
      cli(eng)('EDGE-RTR', 'enable', 'configure terminal', 'router ospf 1', `network ${net(P(eng), 'clinic', 0)} 0.0.0.255 area 0`, 'end');
      eng.advance(20);
    },
  },
];

const COMPLAINTS = {
  clinic: 'Dispatch cannot open clinic records.',
  backup: 'The offsite backup job failed.',
  guest: 'Lobby guests say the Wi-Fi has no internet.',
  isolation: 'Security scanner: a guest device reached clinic systems.',
  nurse: 'Ward B nurses cannot load patient records.',
  staff: 'Staff laptops in Sector B show "No Internet".',
  cams: 'Some camera feeds are black.',
  voice: 'Dispatch calls are choppy and drop words.',
  ipv6: 'Dispatch says IPv6-only sites will not load.', // ---- ipv6
  branch: 'The branch clinic cannot open clinic records.',
  'branch-share': 'Dispatch cannot open the branch clinic\'s file share.',
};

/**
 * Generate a verified challenge. opts: { faults: 1|2, focus: [objective ids], seed }
 * Returns { eng, seed, params, faults: [{ id, title, objectives, ctx }], ticket, objectives }
 */
export function generateChallenge(seed, opts = {}) {
  const rng = rngFrom(seed);
  const params = randomParams(rng);
  const base = buildHealthy(params);
  const h0 = healthReport(base);
  if (!h0.ok) throw new Error(`healthy build is not healthy for seed ${seed}: ${JSON.stringify(h0.flows.filter(f => !f.ok))}`);
  const snapshot = base.snapshot();
  const n = opts.faults ?? 1;
  const weighted = FAULTS.flatMap(f => (opts.focus?.some(o => f.objectives.includes(o)) ? [f, f, f] : [f]));
  for (let attempt = 0; attempt < 12; attempt++) {
    const chosen = [];
    while (chosen.length < n) {
      const f = pick(rng, weighted);
      if (!chosen.includes(f)) chosen.push(f);
    }
    const eng = new Engine(JSON.parse(JSON.stringify(snapshot)));
    eng.ensure();
    const ctxs = chosen.map(f => f.inject(eng, rng));
    eng.advance(2);
    const broken = healthReport(eng);
    if (broken.ok) continue;
    // Prove solvability on a copy.
    const proof = new Engine(eng.snapshot());
    proof.ensure();
    chosen.forEach((f, i) => f.fix(proof, ctxs[i]));
    proof.advance(3);
    if (!healthReport(proof).ok) continue;
    const failing = broken.flows.filter(f => !f.ok).map(f => f.id);
    eng.s.changeLog = ctxs.map(c => ({ t: eng.s.t - 600, desc: c.change, actor: 'change record', seq: 0 }));
    eng.s.events = [];
    eng.s.eventSeq = 0;
    eng.s.changeSeq = 0;
    return {
      eng, seed, params,
      faults: chosen.map((f, i) => ({ id: f.id, title: f.title, objectives: f.objectives, ctx: ctxs[i] })),
      failing,
      ticket: failing.map(id => COMPLAINTS[id]).filter(Boolean),
      objectives: [...new Set(chosen.flatMap(f => f.objectives))],
    };
  }
  throw new Error(`could not generate a verified challenge for seed ${seed}`);
}

/** Evaluates a challenge run: every flow healthy, no loop, and the player verified after the fix. */
export class ChallengeRun {
  constructor(ch) {
    this.ch = ch;
    this.eng = ch.eng;
    this.okSince = null;
    this.evBefore = null;
    this.hints = 0;
    this.startT = this.eng.s.t;
    this.worst = ch.failing.length;
    this.done = false;
  }

  markBefore() { this.evBefore = this.eng.s.eventSeq; }

  evaluate(source = 'action') {
    if (this.done) return { status: 'won', result: this.result };
    const h = healthReport(this.eng);
    const broken = h.flows.filter(f => !f.ok).length;
    this.worst = Math.max(this.worst, broken);
    if (!h.ok) { this.okSince = null; return { status: 'open', health: h }; }
    if (this.okSince === null) this.okSince = source === 'command' && this.evBefore !== null ? this.evBefore : this.eng.s.eventSeq;
    const verified = this.eng.s.events.some(ev => ev.seq > this.okSince && ['http', 'ping', 'dhcp', 'voip-test', 'pathping'].includes(ev.type) && ev.ok !== false);
    if (!verified) return { status: 'verify', health: h };
    this.done = true;
    const changes = this.eng.s.changeLog.filter(c => c.actor === 'player').length;
    this.result = {
      seed: this.ch.seed, faults: this.ch.faults.map(f => f.id), objectives: this.ch.objectives,
      simSeconds: Math.round(this.eng.s.t - this.startT), hints: this.hints, changes,
      collateral: Math.max(0, this.worst - this.ch.failing.length), unguided: this.hints === 0, completedAt: Date.now(),
    };
    return { status: 'won', health: h, result: this.result };
  }

  /** Method hints never reveal addresses: they name the layer and the instrument. */
  hint() {
    this.hints++;
    const f = this.ch.faults[(this.hints - 1) % this.ch.faults.length];
    const byObj = {
      '2.2': 'Work at Layer 2: interface status, VLAN membership, trunks and spanning tree on the switches between the user and the gateway.',
      '3.4': 'Look at the address the affected client actually has (ipconfig /all) and at the service that should have given it.',
      '2.1': 'Follow the packet past the gateway: tracert from the affected client, then the router\'s routing table and NAT.',
      '1.7': 'Compare the client\'s address, mask and gateway with the router interface for that VLAN.',
      '5.4': 'Measure first (pathping / a test call), then read interface error counters along the path.',
      '5.2': 'Check the physical layer: interface status, speed/duplex, error counters, logs.',
      '4.3': 'Read the ACL hit counters (show access-lists) while repeating the failing test.',
      '5.3': 'Separate name, address, path and service: nslookup, ping by IP, tracert, then curl -v.',
      '1.4': 'Which protocol and port does the failing application need, and does anything filter it?',
      '1.8': 'Check IPv6 layer by layer: does the client have a global IPv6 address and a default router (ipconfig, ip -6 addr, ip -6 route)? Does the router advertise, route and resolve neighbours (show ipv6 interface, show ipv6 route, show ipv6 neighbors, show ipv6 access-list)?', // ---- ipv6
    };
    return byObj[f.objectives[0]] || 'Start where the user is: reproduce the symptom, then test one layer at a time.';
  }
}

export { COMPLAINTS };
