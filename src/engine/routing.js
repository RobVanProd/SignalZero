// Layer 3: interface addressing, routing tables (connected + recursive static), ACLs and PAT.
import { inSubnet, networkOf, wildcardMatch, isApipa, parseIp } from './ipv4.js';

/** Effective IPv4 configuration of a host NIC. */
export function hostAddr(eng, d) {
  if (d.kind === 'fleet') {
    const m = d.leases[0];
    return m ? { addr: m.addr, len: m.len, gw: m.gw, dns: m.dns || [], source: 'dhcp' } : { addr: null, source: 'none' };
  }
  const up = eng.portUp(d.id, d.nic);
  if (!d.ipcfg.dhcp && d.ipcfg.static) {
    const s = d.ipcfg.static;
    return { addr: s.addr, len: s.len, gw: s.gw ?? null, dns: s.dns || [], source: 'static', linkUp: up };
  }
  if (d.lease) return { addr: d.lease.addr, len: d.lease.len, gw: d.lease.gw, dns: d.lease.dns || [], source: 'dhcp', domain: d.lease.domain, linkUp: up };
  if (d.apipa && !d.released) return { addr: d.apipa, len: 16, gw: null, dns: [], source: 'apipa', linkUp: up };
  return { addr: null, source: 'none', linkUp: up };
}

/** All L3 interfaces of a device: [{ name, port, tag, addr, len, up, cfg }] */
export function l3Ifaces(eng, d) {
  const out = [];
  if (d.kind === 'router') {
    for (const p of Object.values(d.ports)) {
      if (!p.ip) continue;
      out.push({ name: p.name, port: p.name, tag: null, addr: p.ip.addr, len: p.ip.len, up: eng.portUp(d.id, p.name), cfg: p });
    }
    for (const s of Object.values(d.subifs)) {
      if (!s.ip) continue;
      const parentUp = eng.portUp(d.id, s.parent);
      out.push({ name: s.name, port: s.parent, tag: s.native ? null : s.vlan, addr: s.ip.addr, len: s.ip.len, up: parentUp && s.adminUp, cfg: s });
    }
  } else if (d.kind === 'host' || d.kind === 'fleet') {
    const a = hostAddr(eng, d);
    if (a.addr !== null) {
      out.push({ name: d.nic, port: d.nic, tag: null, addr: a.addr, len: a.len, gw: a.gw, up: eng.portUp(d.id, d.nic), cfg: d.ports[d.nic] });
    }
  }
  return out;
}

export function ownsIp(eng, d, ip) {
  return l3Ifaces(eng, d).some(i => i.addr === ip);
}

/**
 * Router table. Returns [{ type:'C'|'L'|'S', net, len, iface, nh, ad }] for installed routes only,
 * plus eng.lastRouteNotes explaining why configured statics were not installed.
 */
export function routeTable(eng, d) {
  const table = [];
  const ifs = l3Ifaces(eng, d).filter(i => i.up);
  for (const i of ifs) {
    table.push({ type: 'C', net: networkOf(i.addr, i.len), len: i.len, iface: i.name, nh: null, ad: 0 });
    table.push({ type: 'L', net: i.addr, len: 32, iface: i.name, nh: null, ad: 0 });
  }
  const notInstalled = [];
  const resolve = (nh, depth) => {
    const direct = ifs.find(i => inSubnet(nh, i.addr, i.len));
    if (direct) return direct.name;
    if (depth <= 0) return null;
    // recursive: via another static route
    let best = null;
    for (const r of d.routes) {
      if (r.nh === null || !inSubnet(nh, r.net, r.len)) continue;
      if (best && best.len >= r.len) continue;
      best = r;
    }
    return best ? resolve(best.nh, depth - 1) : null;
  };
  for (const r of d.routes) {
    if (r.iface) {
      const i = ifs.find(x => x.name === r.iface);
      if (i) table.push({ type: 'S', net: r.net, len: r.len, iface: r.iface, nh: r.nh ?? null, ad: r.ad ?? 1, exitIf: true });
      else notInstalled.push({ route: r, why: `exit interface ${r.iface} is down` });
      continue;
    }
    const iface = resolve(r.nh, 3);
    if (iface) table.push({ type: 'S', net: r.net, len: r.len, iface, nh: r.nh, ad: r.ad ?? 1 });
    else notInstalled.push({ route: r, why: 'next hop is not reachable through any connected network' });
  }
  return { table, notInstalled };
}

export function lookup(table, ip) {
  let best = null;
  for (const r of table) {
    if (!inSubnet(ip, r.net, r.len)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.ad < best.ad)) best = r;
  }
  return best;
}

/** Host routing decision. Returns { nh } | { error } */
export function hostNextHop(a, dst) {
  if (a.addr === null) return { error: 'no-address' };
  if (inSubnet(dst, a.addr, a.len)) return { nh: dst, onLink: true };
  if (dst === 0xffffffff) return { nh: dst, onLink: true };
  if (a.gw === null || a.gw === undefined) return { error: 'no-route' };
  if (!inSubnet(a.gw, a.addr, a.len)) return { error: 'gateway-off-link' };
  return { nh: a.gw, onLink: false };
}

// ---------------------------------------------------------------- ACLs

const PROTO_NUM = { icmp: 1, tcp: 6, udp: 17 };

function portMatch(spec, port) {
  if (!spec) return true;
  if (port === undefined || port === null) return false;
  switch (spec.op) {
    case 'eq': return spec.ports.includes(port);
    case 'neq': return !spec.ports.includes(port);
    case 'lt': return port < spec.ports[0];
    case 'gt': return port > spec.ports[0];
    case 'range': return port >= spec.ports[0] && port <= spec.ports[1];
    default: return false;
  }
}

function addrMatch(spec, ip) {
  if (spec.any) return true;
  return wildcardMatch(ip, spec.addr, spec.wild);
}

// ICMP message names an ACE can use -> the packet icmpType values they match.
const ICMP_MATCH = { unreachable: ['net-unreachable', 'host-unreachable', 'port-unreachable'], 'time-exceeded': ['ttl-exceeded'], 'ttl-exceeded': ['ttl-exceeded'] };

export function aceMatches(acl, e, pkt) {
  if (e.remark) return false;
  if (acl.kind === 'standard') return addrMatch(e.src, pkt.src);
  if (e.proto !== 'ip' && PROTO_NUM[e.proto] !== PROTO_NUM[pkt.proto]) return false;
  if (!addrMatch(e.src, pkt.src) || !addrMatch(e.dst, pkt.dst)) return false;
  if (e.proto === 'tcp' || e.proto === 'udp') {
    if (!portMatch(e.sop, pkt.sport) || !portMatch(e.dop, pkt.dport)) return false;
  }
  // `established` matches only segments with ACK or RST set, i.e. not a connection-opening SYN.
  if (e.established && !(pkt.flags || []).some(f => f === 'ack' || f === 'rst')) return false;
  if (e.proto === 'icmp' && e.icmpType && !(ICMP_MATCH[e.icmpType] || [e.icmpType]).includes(pkt.icmpType)) return false;
  return true;
}

/**
 * Evaluate an ACL. An ACL that is referenced but not defined permits everything (IOS behaviour).
 * Returns { permit, entry, implicit, undefinedAcl }.
 */
export function evalAcl(d, name, pkt, record = true) {
  const acl = d.acls[name];
  if (!acl) return { permit: true, undefinedAcl: true };
  const entries = [...acl.entries].sort((a, b) => a.seq - b.seq);
  for (const e of entries) {
    if (aceMatches(acl, e, pkt)) {
      if (record) e.matches = (e.matches || 0) + 1;
      return { permit: e.action === 'permit', entry: e };
    }
  }
  return { permit: false, implicit: true };
}

// ---------------------------------------------------------------- NAT (PAT / overload on interface)

/** Find a NAT rule that translates pkt leaving through egress (inside -> outside). */
export function natOutbound(d, ingress, egress, pkt) {
  if (!ingress || !egress) return null;
  if (ingress.cfg.nat !== 'inside' || egress.cfg.nat !== 'outside') return null;
  for (const rule of d.nat) {
    if (rule.iface !== egress.name) continue;
    const r = evalAcl(d, rule.acl, { ...pkt }, false);
    if (rule.acl && d.acls[rule.acl] && r.permit) return { outside: egress.addr, rule };
  }
  return null;
}

export const ANY_IP = parseIp('0.0.0.0');

export function describeAddr(spec, fmt) {
  if (spec.any) return 'any';
  if (spec.wild === 0) return `host ${fmt(spec.addr)}`;
  return `${fmt(spec.addr)} ${fmt(spec.wild)}`;
}

export function isApipaAddr(ip) { return isApipa(ip); }
