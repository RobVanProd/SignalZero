// ---- ipv6: renderers for IOS IPv6 show commands and running-config lines.
// Formats follow Cisco IOS 15.x output as printed in the Cisco IOS IPv6 Command Reference (show ipv6 interface,
// show ipv6 route, show ipv6 neighbors, show ipv6 access-list) and widely published lab captures; IOS prints IPv6
// addresses in uppercase. Spacing that could not be confirmed is listed in docs/topics/ipv6.md.
import { fmtIp6Ios, fmtCidr6Ios, prefix6, solicitedNode } from '../engine/ipv6.js';
import { l3Ifaces6, raInfo, hostAddr6, RA_INTERVAL, RA_ROUTER_LIFETIME } from '../engine/net6.js';
import { longIf, macCisco } from '../engine/model.js';
import { ifStatus, PORT_NAMES } from './ios-show.js';

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const U = fmtIp6Ios;

// ------------------------------------------------------------------ ACE text

export function addr6Text(spec) {
  if (spec.any) return 'any';
  if (spec.len === 128) return `host ${U(spec.addr)}`;
  return fmtCidr6Ios(spec.addr, spec.len);
}

function portOp(spec) {
  if (!spec) return '';
  const nm = p => PORT_NAMES[p] ?? String(p);
  if (spec.op === 'range') return ` range ${nm(spec.ports[0])} ${nm(spec.ports[1])}`;
  return ` ${spec.op} ${spec.ports.map(nm).join(' ')}`;
}

export function ace6Text(e) {
  if (e.remark) return `remark ${e.remark}`;
  let t = `${e.action} ${e.proto} ${addr6Text(e.src)}${portOp(e.sop)} ${addr6Text(e.dst)}${portOp(e.dop)}`;
  if (e.icmpType) t += ` ${e.icmpType}`;
  if (e.established) t += ' established';
  if (e.log) t += ' log';
  return t;
}

// ------------------------------------------------------------------ running-config

/** IPv6 lines inside an interface block (IOS lists them after the IPv4 and media lines). */
export function interfaceConfig6(cfg) {
  const v = cfg?.ipv6;
  if (!v) return [];
  const L = [];
  if (v.ll) L.push(` ipv6 address ${U(v.ll)} link-local`);
  for (const a of v.addrs || []) L.push(a.eui ? ` ipv6 address ${fmtCidr6Ios(a.addr, a.len)} eui-64` : ` ipv6 address ${U(a.addr)}/${a.len}`);
  if (v.enable) L.push(' ipv6 enable');
  if (v.raSuppress === 'all') L.push(' ipv6 nd ra suppress all');
  else if (v.raSuppress) L.push(' ipv6 nd ra suppress');
  if (v.filterIn) L.push(` ipv6 traffic-filter ${v.filterIn} in`);
  if (v.filterOut) L.push(` ipv6 traffic-filter ${v.filterOut} out`);
  return L;
}

export function route6Text(r) {
  const tail = r.iface ? ` ${longIf(r.iface)}${r.nh ? ` ${U(r.nh)}` : ''}` : ` ${U(r.nh)}`;
  return `ipv6 route ${fmtCidr6Ios(r.net, r.len)}${tail}${r.ad && r.ad !== 1 ? ` ${r.ad}` : ''}`;
}

/** ipv6 route lines (after the IPv4 static routes). */
export function routesConfig6(d) {
  const L = [];
  for (const r of d.routes6 || []) L.push(route6Text(r));
  if ((d.routes6 || []).length) L.push('!');
  return L;
}

/** ipv6 access-list blocks (after the IPv4 access lists). */
export function aclsConfig6(d) {
  const L = [];
  for (const [name, acl] of Object.entries(d.acls6 || {})) {
    L.push(`ipv6 access-list ${name}`);
    for (const e of [...acl.entries].sort((a, b) => a.seq - b.seq)) L.push(` ${ace6Text(e)}`);
    L.push('!');
  }
  return L;
}

// ------------------------------------------------------------------ show ipv6 interface brief / show ipv6 interface

function ifRows(d) {
  const rows = [];
  for (const p of Object.values(d.ports)) {
    if (p.kind === 'console') continue;
    rows.push({ name: p.name, cfg: p, parent: p });
    for (const s of Object.values(d.subifs || {}).filter(x => x.parent === p.name).sort((a, b) => a.vlan - b.vlan)) rows.push({ name: s.name, cfg: s, parent: p, sub: true });
  }
  return rows;
}

function stateOf(eng, d, row) {
  const st = ifStatus(eng, d, row.parent);
  const admin = row.sub ? !row.cfg.adminUp : st.admin;
  return { admin, status: admin ? 'administratively down' : st.up ? 'up' : 'down', proto: !admin && st.up ? 'up' : 'down' };
}

export function showIpv6IntBrief(eng, d) {
  const ifs = l3Ifaces6(eng, d);
  const L = [];
  for (const row of ifRows(d)) {
    const s = stateOf(eng, d, row);
    L.push(`${pad(longIf(row.name), 23)}[${s.status}/${s.proto}]`);
    const i = ifs.find(x => x.name === row.name);
    if (!i) { L.push('    unassigned'); continue; }
    L.push(`    ${U(i.ll)}`);
    for (const a of i.addrs) L.push(`    ${U(a.addr)}`);
  }
  return L;
}

export function showIpv6Interface(eng, d, name) {
  const rows = ifRows(d).filter(r => !name || r.name === name);
  if (name && !rows.length) return ['% Invalid input detected: no such interface'];
  const ifs = l3Ifaces6(eng, d);
  const L = [];
  for (const row of rows) {
    const i = ifs.find(x => x.name === row.name);
    if (!i) { if (name) { const s = stateOf(eng, d, row); L.push(`${longIf(row.name)} is ${s.status}, line protocol is ${s.proto}`, '  IPv6 is disabled'); } continue; }
    const s = stateOf(eng, d, row);
    const v = row.cfg.ipv6;
    L.push(`${longIf(row.name)} is ${s.status}, line protocol is ${s.proto}`);
    L.push(`  IPv6 is ${s.proto === 'up' ? 'enabled' : 'tentative'}, link-local address is ${U(i.ll)}${s.proto === 'up' ? '' : ' [TEN]'}`);
    if (row.cfg.description) L.push(`  Description: ${row.cfg.description}`);
    L.push('  No Virtual link-local address(es):');
    if (i.addrs.length) {
      L.push('  Global unicast address(es):');
      for (const a of i.addrs) L.push(`    ${U(a.addr)}, subnet is ${fmtCidr6Ios(a.addr, a.len)}${a.eui ? ' [EUI]' : ''}${s.proto === 'up' ? '' : ' [TEN]'}`);
    } else L.push('  No global unicast address is configured');
    const groups = ['FF02::1'];
    if (d.ipv6Routing) groups.push('FF02::2');
    for (const a of [i.ll, ...i.addrs.map(x => x.addr)]) { const g = U(solicitedNode(a)); if (!groups.includes(g)) groups.push(g); }
    L.push('  Joined group address(es):', ...groups.map(g => `    ${g}`));
    L.push('  MTU is 1500 bytes', '  ICMP error messages limited to one every 100 milliseconds', '  ICMP redirects are enabled', '  ICMP unreachables are sent');
    if (v.filterIn) L.push(`  Input features: Access List`, `  Inbound access list ${v.filterIn}`);
    if (v.filterOut) L.push(`  Outgoing access list ${v.filterOut}`);
    L.push('  ND DAD is enabled, number of DAD attempts: 1', '  ND reachable time is 30000 milliseconds (using 30000)');
    if (d.ipv6Routing) {
      L.push('  ND advertised reachable time is 0 (unspecified)', '  ND advertised retransmit interval is 0 (unspecified)');
      const ra = raInfo(d, i);
      if (ra.suppress) L.push(`  ND RAs are suppressed (${ra.suppress === 'all' ? 'all' : 'periodic'})`);
      else L.push(`  ND router advertisements are sent every ${RA_INTERVAL} seconds`, `  ND router advertisements live for ${RA_ROUTER_LIFETIME} seconds`);
      L.push('  ND advertised default router preference is Medium', '  Hosts use stateless autoconfig for addresses.');
    }
  }
  return L;
}

// ------------------------------------------------------------------ show ipv6 route

const CODES6 = [
  'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
  '       B - BGP, HA - Home Agent, MR - Mobile Router, R - RIP',
  '       H - NHRP, I1 - ISIS L1, I2 - ISIS L2, IA - ISIS interarea',
  '       IS - ISIS summary, D - EIGRP, EX - EIGRP external, NM - NEMO',
  '       ND - Neighbor Discovery, l - LISP',
  '       O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
  '       ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2',
];

function routeLines(r) {
  const head = `${pad(r.type, 4)}${fmtCidr6Ios(r.net, r.len)} [${r.ad}/0]`;
  let via;
  if (r.receive) via = `     via ${longIf(r.iface)}, receive`;
  else if (r.type === 'C' || (r.type === 'S' && !r.nh)) via = `     via ${longIf(r.iface)}, directly connected`;
  else via = `     via ${U(r.nh)}${r.exitIf ? `, ${longIf(r.iface)}` : ''}`;
  return [head, via];
}

const ORDER = r => (r.null0 ? 'z' : r.net) + String(r.len).padStart(3, '0') + (r.type === 'L' ? 'b' : 'a');

export function showIpv6Route(eng, d, only = null, addr = null) {
  const { table: all, notInstalled } = eng.routes6(d.id);
  let table = only ? all.filter(r => only.includes(r.type)) : all;
  if (addr) {
    let best = null;
    for (const r of all) if (!r.null0 && prefix6(addr, r.len) === r.net && (!best || r.len > best.len)) best = r;
    table = best ? [best] : [];
  }
  const L = [`IPv6 Routing Table - default - ${all.length} entries`, ...CODES6];
  if (addr && !table.length) return { lines: ['% Route not found'], notInstalled };
  for (const r of [...table].sort((a, b) => ORDER(a).localeCompare(ORDER(b)))) L.push(...routeLines(r));
  return { lines: L, notInstalled };
}

// ------------------------------------------------------------------ show ipv6 neighbors

/** Neighbor cache, derived (like show ip arp) from who is reachable on each IPv6 segment. */
export function showIpv6Neighbors(eng, d) {
  const L = [`${pad('IPv6 Address', 42)}Age Link-layer Addr State Interface`];
  for (const i of l3Ifaces6(eng, d)) {
    if (!i.up) continue;
    const fl = eng.flood(d.id, i.port, i.tag);
    for (const ep of fl.endpoints) {
      const od = eng.s.devices[ep.dev];
      let addrs = [];
      let mac = null;
      if (od.kind === 'host') {
        const a = hostAddr6(eng, od);
        if (!a.enabled || !a.linkUp) continue;
        mac = od.ports[od.nic].mac;
        addrs = [...a.addrs.filter(x => i.addrs.some(y => prefix6(x.addr, y.len) === prefix6(y.addr, y.len))).map(x => x.addr), a.ll];
        if (!a.addrs.length) continue; // a host that never talked to us beyond DAD
      } else if (od.kind === 'router') {
        const oi = l3Ifaces6(eng, od).find(x => x.name === ep.l3if);
        if (!oi || !oi.up) continue;
        mac = od.ports[oi.port].mac;
        addrs = [...oi.addrs.filter(x => i.addrs.some(y => prefix6(x.addr, y.len) === prefix6(y.addr, y.len))).map(x => x.addr), oi.ll];
      } else continue;
      for (const a of addrs) L.push(`${pad(U(a), 42)}${lpad(String(od.index % 4), 3)} ${pad(macCisco(mac), 15)} ${pad(od.kind === 'router' ? 'REACH' : 'STALE', 5)} ${i.name}`);
    }
  }
  return L;
}

// ------------------------------------------------------------------ show ipv6 access-list

export function showIpv6AccessList(eng, d, name) {
  const L = [];
  for (const [n, acl] of Object.entries(d.acls6 || {})) {
    if (name && n !== name) continue;
    L.push(`IPv6 access list ${n}`);
    for (const e of [...acl.entries].sort((a, b) => a.seq - b.seq)) {
      if (e.remark) continue;
      L.push(`    ${ace6Text(e)}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''} sequence ${e.seq}`);
    }
  }
  return L;
}
