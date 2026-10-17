// IPv6 network layer: interface addressing, SLAAC from Router Advertisements, routing tables, IPv6 ACLs and
// Neighbor Discovery. Companion of routing.js (IPv4); the packet walk is in trace6.js.
//
// State (plain JSON, addresses as 32-hex-digit strings, see ipv6.js):
//  router  d.ipv6Routing (ipv6 unicast-routing), d.routes6 [{net,len,nh,iface,ad}], d.acls6 {NAME:{entries}}
//          per port/subinterface cfg.ipv6 = { enable, addrs:[{addr,len,eui}], ll, raSuppress:null|'periodic'|'all',
//          filterIn, filterOut }
//  host    d.ipcfg.static6 = { addrs:[{addr,len}], gw } (netplan), d.ipcfg.acceptRa (default true),
//          d.v6 = learned SLAAC state { addrs:{key:{prefix,len,addr,temp,valid,pref,router}}, routers:{ll:{dev,iface,until}},
//                 onlink:{key:{net,len,until,router}} } with absolute simulation times.
//
// Behaviour (RFC 4861 Neighbor Discovery, RFC 4862 SLAAC):
//  - Every IPv6-enabled interface has a link-local address: IOS and Linux use modified EUI-64 (Ubuntu 24.04 with
//    networkd: IPv6LinkLocalAddressGenerationMode=eui64 and SLAAC Token=eui64 by default); Windows uses a randomized
//    interface identifier (stable per adapter) and the same identifier for its public SLAAC address, plus a temporary
//    (RFC 4941) address per prefix, which it prefers as a source.
//  - A router sends RAs on an interface only with `ipv6 unicast-routing`, the interface up and IPv6-enabled, and RAs not
//    suppressed. `ipv6 nd ra suppress` stops periodic RAs but still answers Router Solicitations; `... suppress all`
//    stops both (Cisco IOS IPv6 command reference). An interface that starts advertising sends its initial RAs at
//    once (RFC 4861 6.2.4 allows up to 16 s; modelled as immediate). Periodic RAs every 200 s (IOS default interval).
//  - RA contents: every global prefix of the interface, on-link (L) and autonomous (A); valid 2592000 s, preferred
//    604800 s; router lifetime 1800 s (IOS defaults). A host forms an address only from a /64 (RFC 4862 5.5.3 d: prefix
//    length + interface identifier length must be 128).
//  - Simplifications: DAD always succeeds; prefixes a router stops advertising are dropped by its hosts at the next RA
//    (IOS really keeps advertising nothing and hosts keep the address until its lifetime ends); no RDNSS / DHCPv6
//    (hosts keep resolving over IPv4: AAAA records are fetched from their DHCPv4-provided DNS server); no redirects.
import {
  prefix6, inPrefix6, isLinkLocal6, isGlobal6, eui64, linkLocalFromIid, hashIid, withIid, solicitedNode,
} from './ipv6.js';

export const RA_INTERVAL = 200;
export const RA_ROUTER_LIFETIME = 1800;
export const PREFIX_VALID = 2592000;
export const PREFIX_PREFERRED = 604800;
export const FF00 = 'ff' + '0'.repeat(30);

const pfxKey = (net, len) => `${net}/${len}`;

// ---------------------------------------------------------------- interface identifiers

/** The 64-bit interface identifier a host uses for SLAAC (and link-local). */
export function hostIid(d) {
  const mac = d.ports[d.nic]?.mac || d.mac;
  if (d.os === 'windows') return hashIid(mac, 'windows-random-iid');
  return eui64(mac);
}

export function hostLinkLocal(d) { return linkLocalFromIid(hostIid(d)); }

/** Windows temporary (privacy) address identifier for a prefix (RFC 4941). */
export function tempIid(d, prefix) { return hashIid(d.ports[d.nic]?.mac || d.mac, prefix, 'rfc4941-temporary'); }

export function hostV6Enabled(d) {
  return (d.kind === 'host') && d.ipcfg?.v6Disabled !== true && d.os !== 'isp';
}

// ---------------------------------------------------------------- host configuration

/**
 * Effective IPv6 configuration of a host NIC.
 * { enabled, linkUp, ll, addrs:[{addr,len,kind:'static'|'slaac'|'temp',deprecated}], routers:[{addr,dev,iface,kind,until}],
 *   onlink:[{net,len}], acceptRa }
 */
export function hostAddr6(eng, d) {
  const enabled = hostV6Enabled(d);
  const linkUp = enabled ? eng.portUp(d.id, d.nic) : false;
  const out = { enabled, linkUp, ll: null, addrs: [], routers: [], onlink: [], acceptRa: d.ipcfg?.acceptRa !== false };
  if (!enabled) return out;
  out.ll = hostLinkLocal(d);
  const t = eng.s.t;
  const st = d.ipcfg?.static6;
  for (const a of st?.addrs || []) {
    out.addrs.push({ addr: a.addr, len: a.len, kind: 'static' });
    out.onlink.push({ net: prefix6(a.addr, a.len), len: a.len });
  }
  if (st?.gw) out.routers.push({ addr: st.gw, kind: 'static', dev: null, iface: null, until: null });
  const v6 = d.v6;
  if (v6 && out.acceptRa) {
    for (const p of Object.values(v6.onlink || {})) if (p.until > t && !out.onlink.some(o => o.net === p.net && o.len === p.len)) out.onlink.push({ net: p.net, len: p.len });
    for (const a of Object.values(v6.addrs || {})) {
      if (a.valid <= t) continue;
      const deprecated = a.pref <= t;
      if (!out.addrs.some(x => x.addr === a.addr)) out.addrs.push({ addr: a.addr, len: a.len, kind: 'slaac', deprecated, valid: a.valid, pref: a.pref });
      if (a.temp && !out.addrs.some(x => x.addr === a.temp)) out.addrs.push({ addr: a.temp, len: a.len, kind: 'temp', deprecated, valid: Math.min(a.valid, a.tempValid ?? a.valid), pref: Math.min(a.pref, a.tempPref ?? a.pref) });
    }
    for (const [ll, r] of Object.entries(v6.routers || {}).sort((x, y) => x[0].localeCompare(y[0]))) if (r.until > t) out.routers.push({ addr: ll, kind: 'ra', dev: r.dev, iface: r.iface, until: r.until });
  }
  return out;
}

/** Host routing decision for an IPv6 destination. Returns { nh, onLink } | { error } */
export function hostNextHop6(a, dst) {
  if (!a.enabled) return { error: 'no-address' };
  if (isLinkLocal6(dst)) return { nh: dst, onLink: true };
  if (a.onlink.some(p => inPrefix6(dst, p.net, p.len))) return { nh: dst, onLink: true };
  const r = a.routers[0];
  if (!r) return { error: 'no-route' };
  return { nh: r.addr, onLink: false, router: r };
}

/**
 * Source address selection, simplified RFC 6724 section 5: link-local destinations use the link-local address;
 * otherwise a global address (Windows prefers its temporary address, rule 7; deprecated addresses last, rule 3),
 * falling back to the link-local address (which routers will not forward off-link).
 */
export function selectSource6(d, a, dst) {
  if (isLinkLocal6(dst) || !a.addrs.length) return a.ll;
  const rank = x => (x.deprecated ? 10 : 0) + (d.os === 'windows' ? (x.kind === 'temp' ? 0 : x.kind === 'static' ? 1 : 2) : (x.kind === 'static' ? 0 : x.kind === 'slaac' ? 1 : 2));
  return [...a.addrs].sort((x, y) => rank(x) - rank(y))[0].addr;
}

/** True when the host can send to an IPv6 global destination with a global source (RFC 6724 rule 1/2 "usable"). */
export function v6Usable(eng, d, dst) {
  const a = hostAddr6(eng, d);
  if (!a.enabled || !a.linkUp) return false;
  if (!a.addrs.some(x => isGlobal6(x.addr))) return false;
  const r = hostNextHop6(a, dst);
  return !r.error;
}

/** A host's addresses an incoming packet or a Neighbor Solicitation can target. */
export function hostOwns6(eng, d, addr) {
  const a = hostAddr6(eng, d);
  if (!a.enabled || !a.linkUp) return false;
  return a.ll === addr || a.addrs.some(x => x.addr === addr);
}

// ---------------------------------------------------------------- router interfaces

export function ifV6(cfg) { return cfg?.ipv6 || null; }

export function v6IfEnabled(cfg) {
  const v = cfg?.ipv6;
  return !!v && (v.enable || (v.addrs || []).length > 0 || !!v.ll);
}

/** All IPv6-enabled L3 interfaces: [{ name, port, tag, ll, addrs:[{addr,len,eui}], up, cfg }] */
export function l3Ifaces6(eng, d) {
  const out = [];
  if (d.kind === 'router') {
    const mk = (name, port, tag, cfg, up) => {
      const mac = d.ports[port].mac;
      const iid = eui64(mac);
      const v = cfg.ipv6;
      const addrs = (v.addrs || []).map(a => ({ addr: a.eui ? withIid(prefix6(a.addr, Math.min(a.len, 64)), iid) : a.addr, len: a.len, eui: !!a.eui }));
      out.push({ name, port, tag, ll: v.ll || linkLocalFromIid(iid), addrs, up, cfg });
    };
    for (const p of Object.values(d.ports)) if (v6IfEnabled(p)) mk(p.name, p.name, null, p, eng.portUp(d.id, p.name));
    for (const s of Object.values(d.subifs || {})) if (v6IfEnabled(s)) mk(s.name, s.parent, s.native ? null : s.vlan, s, eng.portUp(d.id, s.parent) && s.adminUp);
  } else if (d.kind === 'host') {
    const a = hostAddr6(eng, d);
    if (a.enabled) out.push({ name: d.nic, port: d.nic, tag: null, ll: a.ll, addrs: a.addrs.map(x => ({ addr: x.addr, len: x.len })), up: a.linkUp, cfg: d.ports[d.nic], host: a });
  }
  return out;
}

export function routerOwns6(eng, d, addr, ingressName = null) {
  return l3Ifaces6(eng, d).some(i => i.up && (i.addrs.some(a => a.addr === addr) || (i.ll === addr && (ingressName === null || i.name === ingressName))));
}

/** The address a router uses as the source of what it originates out of (or about) an interface. */
export function routerSource6(eng, d, ifc, dst) {
  if (dst && isLinkLocal6(dst)) return ifc?.ll ?? null;
  const g = ifc?.addrs?.[0]?.addr;
  if (g) return g;
  const any = l3Ifaces6(eng, d).find(i => i.up && i.addrs.length);
  return any ? any.addrs[0].addr : ifc?.ll ?? null;
}

// ---------------------------------------------------------------- routing table

/**
 * IPv6 routing table: C (connected) and L (local /128) for up interfaces, S (static) when resolvable.
 * A static route with an interface (and optional next hop) is installed while that interface is up; one with only a
 * global next hop is installed if the next hop resolves through a connected or (recursively) another static route.
 * Returns { table:[{type,net,len,iface,nh,ad,exitIf?,receive?}], notInstalled }.
 */
export function routeTable6(eng, d) {
  const table = [];
  const notInstalled = [];
  if (d.kind !== 'router') return { table, notInstalled };
  const ifs = l3Ifaces6(eng, d).filter(i => i.up);
  for (const i of ifs) {
    const seen = new Set();
    for (const a of i.addrs) {
      const net = prefix6(a.addr, a.len);
      if (!seen.has(pfxKey(net, a.len))) { seen.add(pfxKey(net, a.len)); table.push({ type: 'C', net, len: a.len, iface: i.name, nh: null, ad: 0 }); }
      table.push({ type: 'L', net: a.addr, len: 128, iface: i.name, nh: null, ad: 0, receive: true });
    }
  }
  const resolve = (nh, depth) => {
    const direct = ifs.find(i => i.addrs.some(a => inPrefix6(nh, a.addr, a.len)));
    if (direct) return direct.name;
    if (depth <= 0) return null;
    let best = null;
    for (const r of d.routes6 || []) {
      if (!r.nh || r.iface || !inPrefix6(nh, r.net, r.len)) continue;
      if (best && best.len >= r.len) continue;
      best = r;
    }
    return best ? resolve(best.nh, depth - 1) : null;
  };
  for (const r of d.routes6 || []) {
    if (r.iface) {
      const i = ifs.find(x => x.name === r.iface);
      if (i) table.push({ type: 'S', net: r.net, len: r.len, iface: r.iface, nh: r.nh ?? null, ad: r.ad ?? 1, exitIf: true });
      else notInstalled.push({ route: r, why: `exit interface ${r.iface} is down or has no IPv6` });
      continue;
    }
    const iface = resolve(r.nh, 3);
    if (iface) table.push({ type: 'S', net: r.net, len: r.len, iface, nh: r.nh, ad: r.ad ?? 1 });
    else notInstalled.push({ route: r, why: 'next hop is not reachable through any connected IPv6 prefix' });
  }
  if (ifs.length) table.push({ type: 'L', net: FF00, len: 8, iface: 'Null0', nh: null, ad: 0, receive: true, null0: true });
  return { table, notInstalled };
}

export function lookup6(table, addr) {
  let best = null;
  for (const r of table) {
    if (r.null0 || !inPrefix6(addr, r.net, r.len)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.ad < best.ad)) best = r;
  }
  return best;
}

// ---------------------------------------------------------------- IPv6 ACLs (ipv6 access-list / ipv6 traffic-filter)

// ICMPv6 message names an ACE can use -> packet icmpType values they match.
const ICMP6_MATCH = {
  'echo-request': ['echo'], 'echo-reply': ['echo-reply'],
  unreachable: ['net-unreachable', 'addr-unreachable', 'port-unreachable', 'scope-unreachable'],
  'no-route': ['net-unreachable'], 'address-unreachable': ['addr-unreachable'], 'port-unreachable': ['port-unreachable'],
  'beyond-scope': ['scope-unreachable'], 'time-exceeded': ['ttl-exceeded'], 'hop-limit': ['ttl-exceeded'],
  'nd-na': ['nd-na'], 'nd-ns': ['nd-ns'], 'router-advertisement': ['router-advertisement'], 'router-solicitation': ['router-solicitation'],
};
export const ICMP6_NAMES = Object.keys(ICMP6_MATCH);

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

const addrMatch6 = (spec, a) => spec.any || (a !== null && a !== undefined && inPrefix6(a, spec.addr, spec.len));

export function aceMatches6(e, pkt) {
  if (e.remark) return false;
  if (e.proto !== 'ipv6' && e.proto !== pkt.proto) return false;
  if (!addrMatch6(e.src, pkt.src) || !addrMatch6(e.dst, pkt.dst)) return false;
  if (e.proto === 'tcp' || e.proto === 'udp') {
    if (!portMatch(e.sop, pkt.sport) || !portMatch(e.dop, pkt.dport)) return false;
  }
  if (e.established && !(pkt.flags || []).some(f => f === 'ack' || f === 'rst')) return false;
  if (e.proto === 'icmp' && e.icmpType && !(ICMP6_MATCH[e.icmpType] || [e.icmpType]).includes(pkt.icmpType)) return false;
  return true;
}

/**
 * Evaluate an IPv6 ACL. IOS semantics: top-down, first match wins; an ACL with at least one entry ends with the
 * implicit "permit icmp any any nd-na", "permit icmp any any nd-ns", "deny ipv6 any any" (so an explicit
 * "deny ipv6 any any" blocks Neighbor Discovery); an applied but undefined ACL permits everything.
 * Returns { permit, entry, implicit, implicitNd, undefinedAcl }.
 */
export function evalAcl6(d, name, pkt, record = true) {
  const acl = d.acls6?.[name];
  if (!acl) return { permit: true, undefinedAcl: true };
  const entries = [...acl.entries].sort((a, b) => a.seq - b.seq);
  for (const e of entries) {
    if (aceMatches6(e, pkt)) {
      if (record) e.matches = (e.matches || 0) + 1;
      return { permit: e.action === 'permit', entry: e };
    }
  }
  if (!entries.some(e => !e.remark)) return { permit: true, empty: true };
  if (pkt.proto === 'icmp' && (pkt.icmpType === 'nd-na' || pkt.icmpType === 'nd-ns')) return { permit: true, implicitNd: true };
  return { permit: false, implicit: true };
}

// ---------------------------------------------------------------- Neighbor Discovery

/** IPv6 addresses an endpoint (from a flood) answers Neighbor Solicitations for. */
export function v6AddrsAt(eng, ep) {
  const d = eng.s.devices[ep.dev];
  if (d.kind === 'host') {
    const a = hostAddr6(eng, d);
    if (!a.enabled || !a.linkUp) return [];
    return [a.ll, ...a.addrs.map(x => x.addr)];
  }
  if (d.kind === 'router') {
    const i = l3Ifaces6(eng, d).find(x => x.name === ep.l3if);
    if (!i || !i.up) return [];
    return [i.ll, ...i.addrs.map(x => x.addr)];
  }
  return [];
}

/**
 * Address resolution (RFC 4861 7.2): a Neighbor Solicitation flooded in the egress broadcast domain, answered by the
 * owner's Neighbor Advertisement. IPv6 ACLs see ND: an inbound traffic-filter on the owner (a router) filters the NS,
 * one on the resolving router's egress interface filters the NA coming back.
 * Returns { ep, flood, blocked? }.
 */
export function ndResolve(eng, devId, egressIf, target, srcAddr, record = false) {
  const fl = eng.flood(devId, egressIf.port, egressIf.tag);
  const me = eng.s.devices[devId];
  for (const ep of fl.endpoints) {
    if (ep.dev === devId) continue;
    if (!v6AddrsAt(eng, ep).includes(target)) continue;
    const od = eng.s.devices[ep.dev];
    if (od.kind === 'router') {
      const oif = l3Ifaces6(eng, od).find(x => x.name === ep.l3if);
      const acl = oif?.cfg.ipv6.filterIn;
      if (acl && !evalAcl6(od, acl, { proto: 'icmp', icmpType: 'nd-ns', src: srcAddr, dst: solicitedNode(target) }, record).permit) {
        return { ep: null, flood: fl, blocked: { dev: od.id, iface: oif.name, acl, what: 'Neighbor Solicitation' } };
      }
    }
    if (me.kind === 'router') {
      const mif = l3Ifaces6(eng, me).find(x => x.name === egressIf.name);
      const acl = mif?.cfg.ipv6.filterIn;
      if (acl && !evalAcl6(me, acl, { proto: 'icmp', icmpType: 'nd-na', src: target, dst: srcAddr }, record).permit) {
        return { ep: null, flood: fl, blocked: { dev: me.id, iface: mif.name, acl, what: 'Neighbor Advertisement' } };
      }
    }
    return { ep, flood: fl };
  }
  return { ep: null, flood: fl };
}

// ---------------------------------------------------------------- Router Advertisements and SLAAC

/** What a router interface puts in its RAs, and whether it sends them. */
export function raInfo(d, ifc) {
  const v = ifc.cfg.ipv6;
  const prefixes = [];
  for (const a of ifc.addrs) {
    const net = prefix6(a.addr, a.len);
    if (!prefixes.some(p => p.net === net && p.len === a.len)) prefixes.push({ net, len: a.len });
  }
  return { advertising: !!d.ipv6Routing && ifc.up, suppress: v.raSuppress || null, prefixes, ll: ifc.ll };
}

/** Every IPv6 interface of every router with its RA state: [{ dev, ifc, ra }]. */
function raInterfaces(eng) {
  const out = [];
  for (const d of Object.values(eng.s.devices)) {
    if (d.kind !== 'router' || d.powered === false) continue;
    for (const ifc of l3Ifaces6(eng, d)) out.push({ dev: d, ifc, ra: raInfo(d, ifc) });
  }
  return out;
}

function acceptsRa(eng, h) {
  return h.kind === 'host' && h.powered !== false && hostV6Enabled(h) && h.ipcfg?.acceptRa !== false && eng.portUp(h.id, h.nic);
}

/** RFC 4862 5.5.3 (simplified): a host processes one RA. Returns true if its configuration changed. */
export function processRa(eng, h, rtr, ifc, ra) {
  const t = eng.s.t;
  const before = JSON.stringify(h.v6 || null);
  const v6 = (h.v6 ||= { addrs: {}, routers: {}, onlink: {} });
  const iid = hostIid(h);
  // prefixes this router advertised last time but no longer does are dropped (see the simplification note above)
  const fromThis = key => (v6.onlink[key]?.router === `${rtr.id}|${ifc.name}`);
  const now = new Set(ra.prefixes.map(p => pfxKey(p.net, p.len)));
  for (const key of Object.keys(v6.onlink)) if (fromThis(key) && !now.has(key)) { delete v6.onlink[key]; delete v6.addrs[key]; }
  for (const p of ra.prefixes) {
    const key = pfxKey(p.net, p.len);
    v6.onlink[key] = { net: p.net, len: p.len, until: t + PREFIX_VALID, router: `${rtr.id}|${ifc.name}` };
    if (p.len !== 64) continue; // RFC 4862 5.5.3 d: only a /64 matches a 64-bit interface identifier
    const prev = v6.addrs[key];
    v6.addrs[key] = {
      prefix: p.net, len: 64, addr: withIid(p.net, iid), temp: h.os === 'windows' ? withIid(p.net, tempIid(h, p.net)) : null,
      valid: t + PREFIX_VALID, pref: t + PREFIX_PREFERRED,
      // Windows defaults: temporary addresses live 7 days, preferred for 1 day (RFC 4941 TEMP_VALID/PREFERRED_LIFETIME)
      tempValid: prev?.tempValid ?? t + 604800, tempPref: prev?.tempPref ?? t + 86400,
      router: `${rtr.id}|${ifc.name}`,
    };
  }
  v6.routers[ra.ll] = { dev: rtr.id, iface: ifc.name, until: t + RA_ROUTER_LIFETIME };
  return JSON.stringify(h.v6) !== before;
}

/** Deliver one RA from a router interface to every accepting host in its broadcast domain. */
function advertise(eng, rtr, ifc, ra, onlyHost = null) {
  let changed = false;
  const fl = eng.flood(rtr.id, ifc.port, ifc.tag);
  const done = new Set();
  for (const ep of fl.endpoints) {
    const h = eng.s.devices[ep.dev];
    if (done.has(h.id) || (onlyHost && h.id !== onlyHost)) continue;
    done.add(h.id);
    if (!acceptsRa(eng, h) || ep.port !== h.nic) continue;
    if (processRa(eng, h, rtr, ifc, ra)) changed = true;
  }
  return changed;
}

/** A host sends a Router Solicitation (link up / boot) and processes the solicited RAs. */
export function routerSolicit(eng, h) {
  if (!acceptsRa(eng, h)) return false;
  let changed = false;
  const fl = eng.flood(h.id, h.nic, null);
  const ll = hostLinkLocal(h);
  for (const ep of fl.endpoints) {
    const rtr = eng.s.devices[ep.dev];
    if (rtr.kind !== 'router') continue;
    const ifc = l3Ifaces6(eng, rtr).find(x => x.name === ep.l3if);
    if (!ifc) continue;
    const ra = raInfo(rtr, ifc);
    if (!ra.advertising || ra.suppress === 'all') continue;
    const acl = ifc.cfg.ipv6.filterIn;
    if (acl && !evalAcl6(rtr, acl, { proto: 'icmp', icmpType: 'router-solicitation', src: ll, dst: 'ff020000000000000000000000000002' }, false).permit) continue;
    if (processRa(eng, h, rtr, ifc, ra)) changed = true;
  }
  return changed;
}

/**
 * Called after every topology/config change: link-up hosts solicit, and interfaces that just started advertising
 * (or changed their prefixes) send their initial unsolicited RAs. Returns true if any host changed.
 */
export function v6AfterChange(eng, ups = []) {
  const s = eng.s;
  let changed = false;
  const memo = s.v6RaMemo || {};
  const next = {};
  for (const { dev, ifc, ra } of raInterfaces(eng)) {
    const key = `${dev.id}|${ifc.name}`;
    const sig = ra.advertising && !ra.suppress ? ra.prefixes.map(p => pfxKey(p.net, p.len)).join(',') + `|${ra.ll}` : null;
    if (sig !== null) next[key] = sig;
    if (sig !== null && memo[key] !== sig) changed = advertise(eng, dev, ifc, ra) || changed;
  }
  if (Object.keys(next).length || Object.keys(memo).length) s.v6RaMemo = next;
  for (const end of ups) {
    const d = s.devices[end.dev];
    if (d.kind === 'host' && d.nic === end.port) changed = routerSolicit(eng, d) || changed;
  }
  return changed;
}

/** Periodic unsolicited RAs (every RA_INTERVAL seconds). */
export function v6Periodic(eng) {
  let changed = false;
  for (const { dev, ifc, ra } of raInterfaces(eng)) if (ra.advertising && !ra.suppress) changed = advertise(eng, dev, ifc, ra) || changed;
  return changed;
}

/** Forget everything learned from RAs (a reboot), then solicit again. */
export function v6Reboot(eng, d) {
  if (d.kind !== 'host') return;
  delete d.v6;
  routerSolicit(eng, d);
}
