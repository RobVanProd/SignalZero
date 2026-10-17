// IPv6 packet walk: the same hop-by-hop model as trace.js, with IPv6 rules (RFC 8200, RFC 4861, RFC 4443).
// host source selection + routing decision -> Neighbor Discovery in the L2 domain -> switch forwarding -> router:
// inbound traffic-filter -> own address? -> hop limit -> longest-prefix match -> outbound traffic-filter -> next hop.
// Differences from IPv4 that the incidents rely on:
//  - No NAT (the clinic's delegated /48 is routed end to end) and no fragmentation by routers.
//  - A router without `ipv6 unicast-routing` does not forward (it still answers for its own addresses).
//  - Address resolution failure at a router is not silent: RFC 4861 7.2.2 makes it return ICMPv6 Destination
//    Unreachable code 3 (address unreachable). No route: code 0. A packet with a link-local source that would have to
//    leave its link: code 2 (beyond scope of source address). UDP to a router address: code 4 (port unreachable).
//  - Hop limit: IOS and Linux originate 64, Windows 128 (IOS IPv4 uses 255).
// Simplifications: ACL denies are silent drops (as in IPv4); no Packet Too Big (one MTU everywhere); no ICMPv6 rate
// limiting; no extension headers; no redirects.
import { hostAddr6, hostNextHop6, selectSource6, l3Ifaces6, lookup6, evalAcl6, ndResolve, routerOwns6, routerSource6, hostOwns6 } from './net6.js';
import { fmtIp6, isLinkLocal6 } from './ipv6.js';
import { hostService, pathImpairment } from './trace.js';

const MAX_L3_HOPS = 32;

export function initialHopLimit(d) {
  return d.os === 'windows' ? 128 : 64;
}

function routerService6(pkt) {
  if (pkt.proto === 'icmp') return 'echo';
  if (pkt.proto === 'tcp') return 'tcp-refused';
  return 'udp-closed';
}

/**
 * Send one IPv6 packet. opts as sendPacket (dst/srcIp are 32-hex-digit strings), plus oif: the outgoing interface
 * name for a router sending to a link-local address. Returns the same shape as sendPacket ({ outcome, at, pkt, hops,
 * notes, pass, latency, jitter, icmpFrom?, service? }); pkt.v6 is true.
 */
export function sendPacket6(eng, opts) {
  const st = eng.s;
  const src = st.devices[opts.from];
  const notes = [];
  const hops = [];
  let pass = 1;
  let latency = 0;
  let jitter = 0;
  const fail = (outcome, at, reason, extra = {}) => ({ outcome, at, reason, pkt, hops, notes, pass, latency, jitter, nat: [], ...extra });
  let pkt = { v6: true, src: null, dst: opts.dst, proto: opts.proto, sport: opts.sport ?? 49152, dport: opts.dport, ttl: opts.ttl ?? initialHopLimit(src), icmpType: opts.icmpType ?? 'echo' };
  if (pkt.proto === 'tcp') pkt.flags = opts.flags ?? ['syn'];
  if (opts.emb) pkt.emb = opts.emb;

  let cur = src;
  let egressIf = null;
  let nh = null;
  if (src.kind === 'host') {
    if (!eng.portUp(src.id, src.nic)) return fail('local-error', src.id, 'media-disconnected');
    const a = hostAddr6(eng, src);
    if (!a.enabled) return fail('local-error', src.id, 'no-address');
    pkt.src = opts.srcIp ?? selectSource6(src, a, pkt.dst);
    if (hostOwns6(eng, src, pkt.dst)) return { outcome: 'delivered', at: src.id, service: hostService(src, pkt), pkt, hops, notes, pass, latency, jitter, nat: [] };
    const r = hostNextHop6(a, pkt.dst);
    if (r.error) return fail('local-error', src.id, r.error);
    nh = r.nh;
    egressIf = { name: src.nic, port: src.nic, tag: null };
    notes.push({ dev: src.id, layer: 3, text: r.onLink ? `${fmtIp6(pkt.dst)} is on-link; Neighbor Solicitation for it directly` : `${fmtIp6(pkt.dst)} is off-link; send to the default router ${fmtIp6(r.nh)} (learned from a Router Advertisement${r.router?.kind === 'static' ? ', here configured statically' : ''})` });
  } else if (src.kind === 'router') {
    const ifs = l3Ifaces6(eng, src);
    if (routerOwns6(eng, src, pkt.dst)) {
      pkt.src = pkt.dst;
      return { outcome: 'delivered', at: src.id, service: routerService6(pkt), pkt, hops, notes, pass, latency, jitter, nat: [] };
    }
    if (isLinkLocal6(pkt.dst)) {
      egressIf = ifs.find(i => i.name === opts.oif && i.up);
      if (!egressIf) return fail('local-error', src.id, 'no-route');
      nh = pkt.dst;
    } else {
      const r = lookup6(eng.routes6(src.id).table, pkt.dst);
      if (!r) return fail('local-error', src.id, 'no-route');
      egressIf = ifs.find(i => i.name === r.iface);
      nh = r.nh ?? pkt.dst;
    }
    pkt.src = opts.srcIp ?? routerSource6(eng, src, egressIf, pkt.dst);
  } else {
    return fail('local-error', src.id, 'not-an-ip-device');
  }

  let ingress = null;
  for (let step = 0; step < MAX_L3_HOPS; step++) {
    // ---- Neighbor Discovery for the next hop on the egress segment
    const nd = ndResolve(eng, cur.id, egressIf, nh, cur.kind === 'router' ? (egressIf.ll ?? pkt.src) : pkt.src, opts.record);
    if (!nd.ep) {
      const why = nd.blocked ? `${st.devices[nd.blocked.dev].hostname} ${nd.blocked.iface}: IPv6 ACL ${nd.blocked.acl} dropped the ${nd.blocked.what}` : (nd.flood.drops.find(x => x.stp || x.snoop)?.reason || null);
      notes.push({ dev: cur.id, layer: 2, text: `Neighbor Solicitation for ${fmtIp6(nh)} unanswered on ${egressIf.name}${why ? ` (${why})` : ''}` });
      if (cur.kind === 'host') return fail('local-error', cur.id, 'nd-fail', { nh, ndBlocked: nd.blocked });
      // RFC 4861 7.2.2: the router reports address resolution failure with ICMPv6 address unreachable.
      if (!ingress) return fail('dropped', cur.id, `address resolution for ${fmtIp6(nh)} failed`, { nh, ndBlocked: nd.blocked });
      return fail('addr-unreachable', cur.id, `address resolution for ${fmtIp6(nh)} failed`, { nh, icmpFrom: routerSource6(eng, cur, ingress, pkt.src), ingress: ingress.name, ndBlocked: nd.blocked });
    }
    const imp = pathImpairment(eng, nd.ep.path);
    pass *= imp.pass;
    latency += imp.latency;
    jitter += imp.jitter;
    for (const h of nd.ep.path) hops.push({ kind: 'l2', ...h });
    const next = st.devices[nd.ep.dev];
    hops.push({ kind: 'l3', dev: next.id, iface: nd.ep.l3if, pkt: { ...pkt } });

    // ---- arrival
    cur = next;
    if (cur.kind === 'host') {
      if (!hostOwns6(eng, cur, pkt.dst)) return fail('dropped', cur.id, `${cur.hostname} is not a router; it discards packets for ${fmtIp6(pkt.dst)}`);
      return { outcome: 'delivered', at: cur.id, service: hostService(cur, pkt), pkt, hops, notes, pass, latency, jitter, nat: [], ttl: pkt.ttl };
    }
    if (cur.kind !== 'router') return fail('dropped', cur.id, 'not an IPv6 node');
    ingress = l3Ifaces6(eng, cur).find(i => i.name === nd.ep.l3if);
    if (ingress.cfg.ipv6.filterIn) {
      const r = evalAcl6(cur, ingress.cfg.ipv6.filterIn, pkt, opts.record);
      if (!r.permit) {
        notes.push({ dev: cur.id, layer: 3, text: `${ingress.name} inbound IPv6 traffic-filter ${ingress.cfg.ipv6.filterIn} ${r.implicit ? 'implicit deny ipv6 any any (no line matched)' : `denied by sequence ${r.entry.seq}`}` });
        return fail('dropped', cur.id, `denied inbound by IPv6 ACL ${ingress.cfg.ipv6.filterIn} on ${ingress.name}`, { acl: { name: ingress.cfg.ipv6.filterIn, implicit: !!r.implicit, seq: r.entry?.seq, v6: true } });
      }
    }
    if (routerOwns6(eng, cur, pkt.dst, ingress.name)) {
      return { outcome: 'delivered', at: cur.id, service: routerService6(pkt), pkt, hops, notes, pass, latency, jitter, nat: [], ingress: ingress.name, ttl: pkt.ttl };
    }
    if (!cur.ipv6Routing) {
      notes.push({ dev: cur.id, layer: 3, text: `${cur.hostname} has no "ipv6 unicast-routing": it is an IPv6 host, not a router, and discards packets for other addresses` });
      return fail('dropped', cur.id, 'IPv6 unicast routing is disabled');
    }
    if (pkt.ttl <= 1) return fail('ttl-exceeded', cur.id, 'hop limit exceeded in transit', { icmpFrom: routerSource6(eng, cur, ingress, pkt.src), ingress: ingress.name });
    pkt = { ...pkt, ttl: pkt.ttl - 1 };
    const r = isLinkLocal6(pkt.dst) ? null : lookup6(eng.routes6(cur.id).table, pkt.dst);
    if (!r) {
      notes.push({ dev: cur.id, layer: 3, text: `no IPv6 route to ${fmtIp6(pkt.dst)}` });
      return fail('net-unreachable', cur.id, `no route to ${fmtIp6(pkt.dst)}`, { icmpFrom: routerSource6(eng, cur, ingress, pkt.src), ingress: ingress.name, code: 0 });
    }
    const egress = l3Ifaces6(eng, cur).find(i => i.name === r.iface);
    if (isLinkLocal6(pkt.src) && egress.name !== ingress.name) {
      notes.push({ dev: cur.id, layer: 3, text: `source ${fmtIp6(pkt.src)} is link-local: it may not leave its link (the sender has no global address)` });
      return fail('scope-unreachable', cur.id, 'beyond scope of source address', { icmpFrom: ingress.ll, ingress: ingress.name, code: 2 });
    }
    if (egress.cfg.ipv6.filterOut) {
      const ar = evalAcl6(cur, egress.cfg.ipv6.filterOut, pkt, opts.record);
      if (!ar.permit) {
        notes.push({ dev: cur.id, layer: 3, text: `${egress.name} outbound IPv6 traffic-filter ${egress.cfg.ipv6.filterOut} ${ar.implicit ? 'implicit deny' : `denied by sequence ${ar.entry.seq}`}` });
        return fail('dropped', cur.id, `denied outbound by IPv6 ACL ${egress.cfg.ipv6.filterOut} on ${egress.name}`, { acl: { name: egress.cfg.ipv6.filterOut, implicit: !!ar.implicit, seq: ar.entry?.seq, v6: true } });
      }
    }
    notes.push({ dev: cur.id, layer: 3, text: `IPv6 route ${fmtIp6(pkt.dst)} via ${r.nh ? fmtIp6(r.nh) : 'directly connected'} out ${egress.name} (no NAT: the address is routed end to end)` });
    egressIf = egress;
    nh = r.nh ?? pkt.dst;
    latency += 0.05;
  }
  return fail('dropped', cur.id, 'routing loop (hop limit would expire)');
}
