// Packet path engine. Walks one IPv4 packet hop by hop through the topology:
// host routing decision -> ARP in the L2 domain -> switch forwarding -> router ingress ACL -> NAT outside->inside
// -> TTL -> longest-prefix match -> NAT inside->outside (PAT) -> egress ACL -> next hop ... -> destination service.
// That is the IOS order of operations: an outbound ACL on the NAT outside interface sees the inside-global source.
// Replies are traced independently, so asymmetric failures (missing return route, NAT) surface naturally.
// TCP segments carry flags (the probe's SYN, a SYN-ACK or RST reply) so `established` ACEs can match;
// ICMP errors carry the embedded header of the packet that triggered them, which is what PAT un-translates.
//
// Simplifications (documented in docs/SIMULATION_MODEL.md):
//  - ACL denies are silent drops (as if `no ip unreachables` were set for filtered traffic).
//  - Routers do send ICMP net-unreachable for missing routes, time-exceeded for TTL expiry, and port-unreachable
//    for UDP to one of their own addresses (unless `no ip unreachables`).
//  - ARP failure at a router is a silent drop.
import { flood } from './switching.js';
import { hostAddr, hostNextHop, l3Ifaces, routeTable, lookup, evalAcl, natOutbound } from './routing.js';
import { fmtIp, inSubnet } from './ipv4.js';
import { sendPacket6, initialHopLimit } from './trace6.js';

const MAX_L3_HOPS = 32;

export function initialTtl(d) {
  if (d.os === 'windows') return 128;
  if (d.os === 'ios' || d.os === 'isp') return 255;
  return 64;
}

function endpointAddrs(eng, ep) {
  const d = eng.s.devices[ep.dev];
  if (d.kind === 'fleet') return d.leases.map(l => l.addr);
  const ifc = l3Ifaces(eng, d).find(i => i.name === ep.l3if && i.up);
  return ifc ? [ifc.addr] : [];
}

/** ARP: find the endpoint answering for `ip` on the segment reached from (dev, port, tag). */
export function arpResolve(eng, devId, port, tag, ip) {
  const fl = eng.flood(devId, port, tag);
  const owners = fl.endpoints.filter(ep => ep.dev !== devId && endpointAddrs(eng, ep).includes(ip));
  if (owners.length) return { ep: owners[0], conflict: owners.length > 1 ? owners : null, flood: fl };
  // Proxy ARP: a router interface on the segment that has a route to ip via another interface.
  for (const ep of fl.endpoints) {
    const d = eng.s.devices[ep.dev];
    if (d.kind !== 'router') continue;
    const ifc = l3Ifaces(eng, d).find(i => i.name === ep.l3if);
    if (!ifc || !ifc.up || !ifc.cfg.proxyArp) continue;
    const r = lookup(eng.routes(d.id).table, ip);
    if (r && r.iface !== ifc.name) return { ep, proxy: true, flood: fl };
  }
  return { ep: null, flood: fl };
}

export function pathImpairment(eng, path) {
  let pass = 1;
  let latency = 0;
  let jitter = 0;
  for (const hop of path) {
    const imp = eng.linkImpairment(hop.link, hop.vlan);
    pass *= 1 - imp.loss;
    latency += imp.latency;
    jitter += imp.jitter;
  }
  return { pass, latency, jitter };
}

/** What a router does with a packet addressed to one of its own interfaces. */
function routerService(pkt, ingress, dev) {
  if (pkt.proto === 'icmp') return 'echo';
  // ---- ospf (Act II): IOS routers with SSH on their vty lines accept TCP 22 (access-class is checked by the session)
  if (pkt.proto === 'tcp' && pkt.dport === 22 && dev?.os === 'ios' && (dev.vty?.transport ?? ['ssh']).includes('ssh')) return 'tcp-open';
  if (pkt.proto === 'tcp') return 'tcp-refused';
  return ingress?.cfg.unreachables === false ? 'filtered-host' : 'udp-closed';
}

/** What a host does with a packet addressed to it. Listeners are dual-stack unless they name a family (4 or 6). */
export function hostService(d, pkt) {
  if (pkt.proto === 'icmp') {
    if (!d.firewall.icmp) return 'filtered-host';
    return 'echo';
  }
  if ((d.firewall.drop || []).some(r => r.proto === pkt.proto && r.port === pkt.dport)) return 'filtered-host';
  const fam = pkt.v6 ? 6 : 4;
  // DHCP services here are DHCPv4 (ISC dhcpd -4, dnsmasq's DHCPv4 side): no IPv6 socket.
  const listening = Object.values(d.services || {}).some(svc => svc.active && !(fam === 6 && svc.kind === 'dhcp') && (svc.listen || []).some(l => l.proto === pkt.proto && l.port === pkt.dport && (!l.family || l.family === fam)));
  if (pkt.proto === 'tcp') return listening ? 'tcp-open' : 'tcp-refused';
  return listening ? 'udp-open' : 'udp-closed';
}

/**
 * Send one packet. opts: { from, srcIp?, dst, proto, sport?, dport?, ttl?, nat?, record?, icmpType?, flags?, emb? }
 * flags: TCP flags (default ['syn']); emb: header embedded in an ICMP error { proto, src, dst, sport, dport }.
 * Returns { outcome, at, pkt, hops, notes, pass, latency, jitter, icmpFrom?, service? }
 */
export function sendPacket(eng, opts) {
  // ---- IPv6 addresses are hex strings: walk the packet with the IPv6 rules (trace6.js)
  if (typeof opts.dst === 'string') return sendPacket6(eng, opts);
  const st = eng.s;
  const src = st.devices[opts.from];
  const notes = [];
  const hops = [];
  const nat = opts.nat || [];
  let pass = 1;
  let latency = 0;
  let jitter = 0;
  const fail = (outcome, at, reason, extra = {}) => ({ outcome, at, reason, pkt, hops, notes, pass, latency, jitter, nat, ...extra });

  let pkt = { src: null, dst: opts.dst, proto: opts.proto, sport: opts.sport ?? 49152, dport: opts.dport, ttl: opts.ttl ?? initialTtl(src), icmpType: opts.icmpType ?? 'echo' };
  if (pkt.proto === 'tcp') pkt.flags = opts.flags ?? ['syn'];
  if (opts.emb) pkt.emb = opts.emb;

  // ---- origin
  let cur = src;
  let ingress = null; // l3 iface object the packet arrived on (for routers)
  let egressIf = null;
  let nh = null;

  if (src.kind === 'host' || src.kind === 'fleet') {
    if (!eng.portUp(src.id, src.nic)) return fail('local-error', src.id, 'media-disconnected');
    const a = src.kind === 'fleet' && opts.member ? { addr: opts.member.addr, len: opts.member.len, gw: opts.member.gw } : hostAddr(eng, src);
    pkt.src = opts.srcIp ?? a.addr;
    if (a.addr === null) return fail('local-error', src.id, 'no-address');
    if (pkt.dst === a.addr) return { outcome: 'delivered', at: src.id, service: hostService(src, pkt), pkt, hops, notes, pass, latency, jitter, nat };
    const r = hostNextHop(a, pkt.dst);
    if (r.error) return fail('local-error', src.id, r.error);
    nh = r.nh;
    egressIf = { name: src.nic, port: src.nic, tag: null, addr: a.addr, len: a.len };
    notes.push({ dev: src.id, layer: 3, text: r.onLink ? `${fmtIp(pkt.dst)} is on-link (${fmtIp(a.addr)}/${a.len}); ARP for it directly` : `${fmtIp(pkt.dst)} is off-link; send to default gateway ${fmtIp(a.gw)}` });
  } else if (src.kind === 'router') {
    const rt = eng.routes(src.id);
    if (l3Ifaces(eng, src).some(i => i.addr === pkt.dst && i.up)) {
      pkt.src = pkt.dst;
      return { outcome: 'delivered', at: src.id, service: routerService(pkt, null, src), pkt, hops, notes, pass, latency, jitter, nat };
    }
    const r = lookup(rt.table, pkt.dst);
    if (!r) return fail('local-error', src.id, 'no-route');
    egressIf = l3Ifaces(eng, src).find(i => i.name === r.iface);
    pkt.src = opts.srcIp ?? egressIf.addr;
    nh = r.nh ?? pkt.dst;
  } else {
    return fail('local-error', src.id, 'not-an-ip-device');
  }

  for (let step = 0; step < MAX_L3_HOPS; step++) {
    // ---- L2 delivery to next hop on egress segment
    const arp = arpResolve(eng, cur.id, egressIf.port, egressIf.tag, nh);
    if (!arp.ep) {
      const why = arp.flood.drops.find(x => x.stp || x.snoop) || null;
      notes.push({ dev: cur.id, layer: 2, text: `ARP for ${fmtIp(nh)} unanswered on ${egressIf.name}${why ? ` (${why.reason} at ${st.devices[why.dev].hostname} ${why.port})` : ''}` });
      if (cur.kind === 'router' && nh === pkt.dst && !inSubnet(nh, egressIf.addr, egressIf.len)) notes.push({ dev: cur.id, layer: 3, text: `static route names only the exit interface: ${cur.hostname} ARPs for every destination and needs proxy ARP from the next router` });
      if (cur.kind === 'host' || cur.kind === 'fleet') return fail('local-error', cur.id, 'arp-fail', { nh });
      return fail('dropped', cur.id, `ARP for next hop ${fmtIp(nh)} failed (encapsulation failed)`, { nh });
    }
    if (arp.conflict) notes.push({ dev: cur.id, layer: 2, text: `Duplicate IP: ${arp.conflict.length} devices answer ARP for ${fmtIp(nh)}` });
    if (arp.proxy) notes.push({ dev: arp.ep.dev, layer: 2, text: `proxy ARP answered for ${fmtIp(nh)}` });
    const imp = pathImpairment(eng, arp.ep.path);
    pass *= imp.pass;
    latency += imp.latency;
    jitter += imp.jitter;
    for (const h of arp.ep.path) hops.push({ kind: 'l2', ...h });
    const next = st.devices[arp.ep.dev];
    hops.push({ kind: 'l3', dev: next.id, iface: arp.ep.l3if, pkt: { ...pkt } });

    // ---- arrival
    cur = next;
    if (cur.kind === 'host' || cur.kind === 'fleet') {
      const owns = cur.kind === 'fleet' ? cur.leases.some(l => l.addr === pkt.dst) : hostAddr(eng, cur).addr === pkt.dst;
      if (!owns) return fail('dropped', cur.id, `${cur.hostname} is not a router; it discards packets for ${fmtIp(pkt.dst)}`);
      return { outcome: 'delivered', at: cur.id, service: hostService(cur, pkt), pkt, hops, notes, pass, latency, jitter, nat, ttl: pkt.ttl };
    }
    // router
    ingress = l3Ifaces(eng, cur).find(i => i.name === arp.ep.l3if);
    if (ingress.cfg.aclIn) {
      const r = evalAcl(cur, ingress.cfg.aclIn, pkt, opts.record);
      if (!r.permit) {
        notes.push({ dev: cur.id, layer: 3, text: `${ingress.name} inbound ACL ${ingress.cfg.aclIn} ${r.implicit ? 'implicit deny (no line matched)' : `denied by line ${r.entry.seq}`}` });
        return fail('dropped', cur.id, `denied inbound by ACL ${ingress.cfg.aclIn} on ${ingress.name}`, { acl: { name: ingress.cfg.aclIn, implicit: !!r.implicit, seq: r.entry?.seq } });
      }
    }
    // NAT outside -> inside (after the input ACL). An ICMP error is matched on the header it embeds.
    if (ingress.cfg.nat === 'outside') {
      const e = pkt.emb;
      const tr = nat.find(n => n.router === cur.id && n.outside === pkt.dst && (e ? n.proto === e.proto && n.port === e.sport : n.proto === pkt.proto && n.port === pkt.dport));
      if (tr && e) {
        notes.push({ dev: cur.id, layer: 3, text: `PAT: ICMP ${pkt.icmpType} about ${e.proto} ${fmtIp(e.src)}:${e.sport} -> inside ${fmtIp(tr.inside)}:${tr.insidePort} (embedded header translated too)` });
        pkt = { ...pkt, dst: tr.inside, emb: { ...e, src: tr.inside, sport: tr.insidePort } };
      } else if (tr) {
        notes.push({ dev: cur.id, layer: 3, text: `PAT: ${fmtIp(pkt.dst)}:${pkt.dport} -> inside ${fmtIp(tr.inside)}:${tr.insidePort}` });
        pkt = { ...pkt, dst: tr.inside, dport: tr.insidePort };
      }
    }
    if (l3Ifaces(eng, cur).some(i => i.addr === pkt.dst && i.up)) {
      return { outcome: 'delivered', at: cur.id, service: routerService(pkt, ingress, cur), pkt, hops, notes, pass, latency, jitter, nat, ingress: ingress.name, ttl: pkt.ttl };
    }
    if (pkt.ttl <= 1) {
      return fail('ttl-exceeded', cur.id, 'TTL expired in transit', { icmpFrom: ingress.addr, ingress: ingress.name });
    }
    pkt = { ...pkt, ttl: pkt.ttl - 1 };
    const rt = eng.routes(cur.id);
    const r = lookup(rt.table, pkt.dst);
    if (!r) {
      notes.push({ dev: cur.id, layer: 3, text: `no route to ${fmtIp(pkt.dst)} (and no gateway of last resort)` });
      if (ingress.cfg.unreachables === false) return fail('dropped', cur.id, `no route to ${fmtIp(pkt.dst)}`);
      return fail('net-unreachable', cur.id, `no route to ${fmtIp(pkt.dst)}`, { icmpFrom: ingress.addr, ingress: ingress.name });
    }
    const egress = l3Ifaces(eng, cur).find(i => i.name === r.iface);
    // NAT inside -> outside happens after routing and before the output ACL.
    const xl = natOutbound(cur, ingress, egress, pkt);
    if (xl) {
      const port = pkt.sport;
      nat.push({ router: cur.id, proto: pkt.proto, inside: pkt.src, insidePort: pkt.sport, outside: xl.outside, port });
      notes.push({ dev: cur.id, layer: 3, text: `PAT: inside ${fmtIp(pkt.src)}:${pkt.sport} -> outside ${fmtIp(xl.outside)}:${port}` });
      pkt = { ...pkt, src: xl.outside, sport: port };
    }
    if (egress.cfg.aclOut) {
      const ar = evalAcl(cur, egress.cfg.aclOut, pkt, opts.record);
      if (!ar.permit) {
        notes.push({ dev: cur.id, layer: 3, text: `${egress.name} outbound ACL ${egress.cfg.aclOut} ${ar.implicit ? 'implicit deny' : `denied by line ${ar.entry.seq}`}${xl ? ` (evaluated after PAT: source is now ${fmtIp(pkt.src)})` : ''}` });
        return fail('dropped', cur.id, `denied outbound by ACL ${egress.cfg.aclOut} on ${egress.name}`, { acl: { name: egress.cfg.aclOut, implicit: !!ar.implicit, seq: ar.entry?.seq } });
      }
    }
    notes.push({ dev: cur.id, layer: 3, text: `route ${fmtIp(pkt.dst)} via ${r.nh != null ? fmtIp(r.nh) : 'directly connected'} out ${egress.name}` });
    egressIf = egress;
    nh = r.nh ?? pkt.dst;
    latency += 0.05;
  }
  return fail('dropped', cur.id, 'routing loop (TTL would expire)');
}

/** Response packet type for a forward outcome. */
function responseFor(fwd, req) {
  switch (fwd.outcome) {
    case 'delivered':
      switch (fwd.service) {
        case 'echo': return { proto: 'icmp', icmpType: 'echo-reply', kind: 'reply' };
        case 'tcp-open': return { proto: 'tcp', kind: 'syn-ack', flags: ['syn', 'ack'] };
        case 'tcp-refused': return { proto: 'tcp', kind: 'rst', flags: ['rst', 'ack'] };
        case 'udp-open': return { proto: 'udp', kind: 'udp-reply' };
        case 'udp-closed': return { proto: 'icmp', icmpType: 'port-unreachable', kind: 'port-unreachable' };
        default: return null; // filtered: silence
      }
    case 'ttl-exceeded': return { proto: 'icmp', icmpType: 'ttl-exceeded', kind: 'ttl-exceeded', fromIp: fwd.icmpFrom };
    case 'net-unreachable': return { proto: 'icmp', icmpType: 'net-unreachable', kind: 'net-unreachable', fromIp: fwd.icmpFrom };
    // ICMPv6 destination unreachable, code 3 (address unreachable) and code 2 (beyond scope of source address)
    case 'addr-unreachable': return { proto: 'icmp', icmpType: 'addr-unreachable', kind: 'addr-unreachable', fromIp: fwd.icmpFrom };
    case 'scope-unreachable': return { proto: 'icmp', icmpType: 'scope-unreachable', kind: 'scope-unreachable', fromIp: fwd.icmpFrom };
    default: return null;
  }
}

/**
 * Round trip probe: forward packet + independent reply.
 * Returns { status, kind, fwd, rep, responderIp, ttl, rttMs, pass }
 *   status: 'ok' (reply received), 'timeout', 'local-error'
 *   kind:   reply | syn-ack | rst | udp-reply | port-unreachable | ttl-exceeded | net-unreachable
 *           (IPv6 also: addr-unreachable, scope-unreachable). req.dst may be an IPv6 hex string; result.v6 marks it.
 */
export function probe(eng, req) {
  const src = eng.s.devices[req.from];
  const fwd = sendPacket(eng, { ...req, nat: [] });
  if (fwd.outcome === 'local-error') return { status: 'local-error', reason: fwd.reason, fwd };
  const resp = responseFor(fwd, req);
  if (!resp) return { status: 'timeout', fwd, lostAt: fwd.at, lostReason: fwd.reason || 'no response (filtered)' };
  const responder = eng.s.devices[fwd.at];
  const fromIp = resp.fromIp ?? fwd.pkt.dst;
  const v6 = typeof req.dst === 'string';
  if (fwd.at === req.from) {
    return { status: 'ok', kind: resp.kind, fwd, rep: null, responderIp: fromIp, ttl: v6 ? initialHopLimit(src) : initialTtl(src), rttMs: 0.02, pass: 1, ...(v6 ? { v6 } : {}) };
  }
  const isErr = resp.proto === 'icmp' && resp.kind !== 'reply';
  const f = fwd.pkt;
  const rep = sendPacket(eng, {
    from: responder.id, srcIp: fromIp, dst: f.src, proto: resp.proto, icmpType: resp.icmpType, flags: resp.flags,
    sport: f.dport, dport: f.sport, nat: fwd.nat, record: req.record,
    emb: isErr ? { proto: f.proto, src: f.src, dst: f.dst, sport: f.sport, dport: f.dport } : undefined,
    ...(v6 ? { oif: fwd.ingress } : {}),
  });
  const backHome = rep.outcome === 'delivered' && rep.at === req.from;
  if (!backHome) return { status: 'timeout', fwd, rep, lostAt: rep.at, lostReason: `reply lost: ${rep.reason || rep.outcome}`, replyLost: true, ...(v6 ? { v6 } : {}) };
  const rtt = 0.05 + fwd.latency + rep.latency;
  return { status: 'ok', kind: resp.kind, fwd, rep, responderIp: fromIp, ttl: rep.pkt.ttl, rttMs: rtt, jitter: fwd.jitter + rep.jitter, pass: fwd.pass * rep.pass, ...(v6 ? { v6 } : {}) };
}
