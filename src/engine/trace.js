// Packet path engine. Walks one IPv4 packet hop by hop through the topology:
// host routing decision -> ARP in the L2 domain -> switch forwarding -> router ingress ACL -> TTL ->
// longest-prefix match -> egress ACL -> PAT -> next hop ... -> destination service.
// Replies are traced independently, so asymmetric failures (missing return route, NAT) surface naturally.
//
// Simplifications (documented in docs/SIMULATION_MODEL.md):
//  - ACL denies are silent drops (as if `no ip unreachables` were set for filtered traffic).
//  - Routers do send ICMP net-unreachable for missing routes and time-exceeded for TTL expiry.
//  - ARP failure at a router is a silent drop.
import { flood } from './switching.js';
import { hostAddr, hostNextHop, l3Ifaces, routeTable, lookup, evalAcl, natOutbound } from './routing.js';
import { fmtIp } from './ipv4.js';

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

function pathImpairment(eng, path) {
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

function hostService(d, pkt) {
  if (pkt.proto === 'icmp') {
    if (!d.firewall.icmp) return 'filtered-host';
    return 'echo';
  }
  if ((d.firewall.drop || []).some(r => r.proto === pkt.proto && r.port === pkt.dport)) return 'filtered-host';
  const listening = Object.values(d.services || {}).some(svc => svc.active && (svc.listen || []).some(l => l.proto === pkt.proto && l.port === pkt.dport));
  if (pkt.proto === 'tcp') return listening ? 'tcp-open' : 'tcp-refused';
  return listening ? 'udp-open' : 'udp-closed';
}

/**
 * Send one packet. opts: { from, srcIp?, dst, proto, sport?, dport?, ttl?, nat?, record?, icmpType? }
 * Returns { outcome, at, pkt, hops, notes, pass, latency, jitter, icmpFrom?, service? }
 */
export function sendPacket(eng, opts) {
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
      return { outcome: 'delivered', at: src.id, service: pkt.proto === 'icmp' ? 'echo' : 'tcp-refused', pkt, hops, notes, pass, latency, jitter, nat };
    }
    const r = lookup(rt.table, pkt.dst);
    if (!r) return fail('local-error', src.id, 'no-route');
    egressIf = l3Ifaces(eng, src).find(i => i.name === r.iface);
    pkt.src = opts.srcIp ?? egressIf.addr;
    nh = r.type === 'C' ? pkt.dst : r.nh;
  } else {
    return fail('local-error', src.id, 'not-an-ip-device');
  }

  for (let step = 0; step < MAX_L3_HOPS; step++) {
    // ---- L2 delivery to next hop on egress segment
    const arp = arpResolve(eng, cur.id, egressIf.port, egressIf.tag, nh);
    if (!arp.ep) {
      const why = arp.flood.drops.find(x => x.stp || x.snoop) || null;
      notes.push({ dev: cur.id, layer: 2, text: `ARP for ${fmtIp(nh)} unanswered on ${egressIf.name}${why ? ` (${why.reason} at ${st.devices[why.dev].hostname} ${why.port})` : ''}` });
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
    // NAT un-translation on outside interface
    if (ingress.cfg.nat === 'outside') {
      const tr = nat.find(n => n.router === cur.id && n.outside === pkt.dst && n.proto === pkt.proto && n.port === pkt.dport);
      if (tr) {
        notes.push({ dev: cur.id, layer: 3, text: `PAT: ${fmtIp(pkt.dst)}:${pkt.dport} -> inside ${fmtIp(tr.inside)}:${tr.insidePort}` });
        pkt = { ...pkt, dst: tr.inside, dport: tr.insidePort };
      }
    }
    if (l3Ifaces(eng, cur).some(i => i.addr === pkt.dst && i.up)) {
      return { outcome: 'delivered', at: cur.id, service: pkt.proto === 'icmp' ? 'echo' : 'tcp-refused', pkt, hops, notes, pass, latency, jitter, nat, ingress: ingress.name, ttl: pkt.ttl };
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
    if (egress.cfg.aclOut) {
      const ar = evalAcl(cur, egress.cfg.aclOut, pkt, opts.record);
      if (!ar.permit) {
        notes.push({ dev: cur.id, layer: 3, text: `${egress.name} outbound ACL ${egress.cfg.aclOut} ${ar.implicit ? 'implicit deny' : `denied by line ${ar.entry.seq}`}` });
        return fail('dropped', cur.id, `denied outbound by ACL ${egress.cfg.aclOut} on ${egress.name}`, { acl: { name: egress.cfg.aclOut, implicit: !!ar.implicit, seq: ar.entry?.seq } });
      }
    }
    const xl = natOutbound(cur, ingress, egress, pkt);
    if (xl) {
      const port = pkt.sport;
      nat.push({ router: cur.id, proto: pkt.proto, inside: pkt.src, insidePort: pkt.sport, outside: xl.outside, port });
      notes.push({ dev: cur.id, layer: 3, text: `PAT: inside ${fmtIp(pkt.src)}:${pkt.sport} -> outside ${fmtIp(xl.outside)}:${port}` });
      pkt = { ...pkt, src: xl.outside, sport: port };
    }
    notes.push({ dev: cur.id, layer: 3, text: `route ${fmtIp(pkt.dst)} via ${r.type === 'C' ? 'directly connected' : fmtIp(r.nh)} out ${egress.name}` });
    egressIf = egress;
    nh = r.type === 'C' ? pkt.dst : r.nh;
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
        case 'tcp-open': return { proto: 'tcp', kind: 'syn-ack' };
        case 'tcp-refused': return { proto: 'tcp', kind: 'rst' };
        case 'udp-open': return { proto: 'udp', kind: 'udp-reply' };
        case 'udp-closed': return { proto: 'icmp', icmpType: 'port-unreachable', kind: 'port-unreachable' };
        default: return null; // filtered: silence
      }
    case 'ttl-exceeded': return { proto: 'icmp', icmpType: 'ttl-exceeded', kind: 'ttl-exceeded', fromIp: fwd.icmpFrom };
    case 'net-unreachable': return { proto: 'icmp', icmpType: 'net-unreachable', kind: 'net-unreachable', fromIp: fwd.icmpFrom };
    default: return null;
  }
}

/**
 * Round trip probe: forward packet + independent reply.
 * Returns { status, kind, fwd, rep, responderIp, ttl, rttMs, pass }
 *   status: 'ok' (reply received), 'timeout', 'local-error'
 *   kind:   reply | syn-ack | rst | udp-reply | port-unreachable | ttl-exceeded | net-unreachable
 */
export function probe(eng, req) {
  const src = eng.s.devices[req.from];
  const fwd = sendPacket(eng, { ...req, nat: [] });
  if (fwd.outcome === 'local-error') return { status: 'local-error', reason: fwd.reason, fwd };
  const resp = responseFor(fwd, req);
  if (!resp) return { status: 'timeout', fwd, lostAt: fwd.at, lostReason: fwd.reason || 'no response (filtered)' };
  const responder = eng.s.devices[fwd.at];
  const fromIp = resp.fromIp ?? fwd.pkt.dst;
  if (fwd.at === req.from) {
    return { status: 'ok', kind: resp.kind, fwd, rep: null, responderIp: fromIp, ttl: initialTtl(src), rttMs: 0.02, pass: 1 };
  }
  const rep = sendPacket(eng, {
    from: responder.id, srcIp: fromIp, dst: fwd.pkt.src, proto: resp.proto, icmpType: resp.icmpType,
    sport: fwd.pkt.dport, dport: fwd.pkt.sport, nat: fwd.nat, record: req.record,
  });
  const backHome = rep.outcome === 'delivered' && rep.at === req.from;
  if (!backHome) return { status: 'timeout', fwd, rep, lostAt: rep.at, lostReason: `reply lost: ${rep.reason || rep.outcome}`, replyLost: true };
  const rtt = 0.05 + fwd.latency + rep.latency;
  return { status: 'ok', kind: resp.kind, fwd, rep, responderIp: fromIp, ttl: rep.pkt.ttl, rttMs: rtt, jitter: fwd.jitter + rep.jitter, pass: fwd.pass * rep.pass };
}
