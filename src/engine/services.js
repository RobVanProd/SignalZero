// Application services: DHCP (server, relay, client), DNS (authoritative + forwarding, Windows cache), HTTP(S).
import { fmtIp, parseIp, inSubnet, isApipa } from './ipv4.js';
import { parseDhcpd, subnetOptions, isAuthoritative, networkKey } from './parsers/dhcpd.js';
import { parseZone, zoneLoadFailure } from './parsers/zone.js';
import { hostAddr, l3Ifaces, evalAcl } from './routing.js';
import { sendPacket, probe } from './trace.js';
import { macLinux } from './model.js';

// ------------------------------------------------------------------ DHCP server (ISC dhcpd 4.4 behaviour)

const inRanges = (sub, ip) => (sub.ranges || []).some(([a, b]) => ip >= a && ip <= b);
const subnetName = sub => `${fmtIp(sub.net)}/${sub.len}`;

export function dhcpdStart(eng, dev) {
  const svc = dev.services['isc-dhcp-server'];
  const text = dev.files[svc.conf] ?? '';
  const res = parseDhcpd(text, svc.conf);
  const lines = [];
  if (!res.ok) {
    svc.active = false;
    svc.failed = true;
    lines.push(...res.errors);
    lines.push('Configuration file errors encountered -- exiting');
    for (const l of lines) eng.journal(dev, 'dhcpd', l);
    eng.journal(dev, 'systemd', 'isc-dhcp-server.service: Main process exited, code=exited, status=1/FAILURE');
    eng.journal(dev, 'systemd', 'isc-dhcp-server.service: Failed with result \'exit-code\'.');
    return { ok: false, lines };
  }
  const a = hostAddr(eng, dev);
  const ifSub = a.addr !== null ? res.cfg.subnets.find(s => inSubnet(a.addr, s.net, s.len)) : null;
  if (!ifSub) {
    svc.active = false;
    svc.failed = true;
    lines.push(`No subnet declaration for ${dev.nic} (${a.addr !== null ? fmtIp(a.addr) : 'no IPv4 addresses'}).`);
    lines.push(`** Ignoring requests on ${dev.nic}.  If this is not what`, '   you want, please write a subnet declaration', '   in your dhcpd.conf file for the network segment', `   to which interface ${dev.nic} is attached. **`);
    lines.push('Not configured to listen on any interfaces!');
    for (const l of lines) eng.journal(dev, 'dhcpd', l);
    eng.journal(dev, 'systemd', 'isc-dhcp-server.service: Failed with result \'exit-code\'.');
    return { ok: false, lines };
  }
  svc.cfg = res.cfg;
  svc.active = true;
  svc.failed = false;
  svc.leases = svc.leases || {};
  eng.journal(dev, 'dhcpd', 'Internet Systems Consortium DHCP Server 4.4.3-P1');
  // Reading dhcpd.leases: a lease whose address is in no pool of the new configuration is dropped (mdb.c).
  for (const [mac, l] of Object.entries(svc.leases)) {
    if (res.cfg.subnets.some(s => inRanges(s, l.addr))) continue;
    eng.journal(dev, 'dhcpd', `lease ${fmtIp(l.addr)}: no subnet.`);
    delete svc.leases[mac];
  }
  eng.journal(dev, 'dhcpd', `Wrote ${Object.keys(svc.leases).length} leases to leases file.`);
  eng.journal(dev, 'dhcpd', `Listening on LPF/${dev.nic}/${macLinux(dev.ports[dev.nic].mac)}/${fmtIp(ifSub.net)}/${ifSub.len}`);
  eng.journal(dev, 'dhcpd', 'Server starting service.');
  return { ok: true, lines: [] };
}

export function dhcpdStop(eng, dev) {
  const svc = dev.services['isc-dhcp-server'];
  svc.active = false;
  svc.failed = false;
}

const live = (l, now) => l && (l.ends === undefined || l.ends > now);

function usedAddrs(svc, sub, exceptMac, now) {
  const used = new Set();
  for (const [mac, l] of Object.entries(svc.leases)) if (mac !== exceptMac && live(l, now) && inSubnet(l.addr, sub.net, sub.len)) used.add(l.addr);
  return used;
}

/** The subnet declaration a packet comes from: giaddr's subnet when relayed, else the subnet of the server's own interface. */
function packetSubnet(eng, server, cfg, giaddr) {
  const key = giaddr ?? hostAddr(eng, server).addr;
  return key === null ? null : cfg.subnets.find(s => inSubnet(key, s.net, s.len)) || null;
}

function leaseFor(eng, server, sub, addr) {
  const o = subnetOptions(server.services['isc-dhcp-server'].cfg, sub, addr);
  return { addr, len: sub.len, gw: o.routers[0] ?? null, dns: o.dns, domain: o.domain, leaseTime: o.leaseTime, t1: o.t1, t2: o.t2, server: hostAddr(eng, server).addr, serverDev: server.id };
}

/** Server-side DISCOVER handling. Returns { offer } or { refused } explaining the silence. */
function serverOffer(eng, server, mac, clientName, giaddr, viaLabel) {
  const svc = server.services['isc-dhcp-server'];
  const cfg = svc.cfg;
  const now = eng.s.t;
  const sub = packetSubnet(eng, server, cfg, giaddr);
  eng.journal(server, 'dhcpd', `DHCPDISCOVER from ${macLinux(mac)} via ${viaLabel}${sub ? '' : ': unknown network segment'}`);
  if (!sub) return { refused: 'unknown network segment' };
  const net = networkKey(sub);
  const sameNet = s => networkKey(s) === net;
  const fixed = cfg.hosts.find(h => h.mac === mac && h.fixed !== null && cfg.subnets.some(s => sameNet(s) && (h.fixedAll || [h.fixed]).some(ip => inSubnet(ip, s.net, s.len))));
  let addr = null;
  let from = sub;
  if (fixed) {
    addr = (fixed.fixedAll || [fixed.fixed]).find(ip => cfg.subnets.some(s => sameNet(s) && inSubnet(ip, s.net, s.len)));
    from = cfg.subnets.find(s => sameNet(s) && inSubnet(addr, s.net, s.len));
  } else {
    const prev = svc.leases[mac];
    const subs = cfg.subnets.filter(sameNet);
    const prevSub = prev && subs.find(s => inRanges(s, prev.addr));
    if (prevSub) { addr = prev.addr; from = prevSub; } else {
      outer: for (const s of subs) {
        const used = usedAddrs(svc, s, mac, now);
        for (const [x, y] of s.ranges) {
          for (let ip = x; ip <= y; ip++) if (!used.has(ip)) { addr = ip; from = s; break outer; }
        }
      }
    }
  }
  if (addr === null) {
    eng.journal(server, 'dhcpd', `DHCPDISCOVER from ${macLinux(mac)} via ${viaLabel}: network ${sub.shared ? cfg.scopes[sub.shared]?.name || subnetName(sub) : subnetName(sub)}: no free leases`);
    return { refused: 'no free leases', subnet: sub };
  }
  eng.journal(server, 'dhcpd', `DHCPOFFER on ${fmtIp(addr)} to ${macLinux(mac)} (${clientName}) via ${viaLabel}`);
  return { offer: { ...leaseFor(eng, server, from, addr), subnet: from } };
}

function commitLease(eng, server, mac, clientName, lease, viaLabel, sid) {
  const svc = server.services['isc-dhcp-server'];
  eng.journal(server, 'dhcpd', `DHCPREQUEST for ${fmtIp(lease.addr)}${sid !== undefined ? ` (${fmtIp(sid)})` : ''} from ${macLinux(mac)} (${clientName}) via ${viaLabel}`);
  eng.journal(server, 'dhcpd', `DHCPACK on ${fmtIp(lease.addr)} to ${macLinux(mac)} (${clientName}) via ${viaLabel}`);
  svc.leases[mac] = { addr: lease.addr, client: clientName, t: eng.s.t, ends: eng.s.t + lease.leaseTime };
}

/**
 * ISC dhcprequest() for a REQUEST that is not the reply to our own OFFER.
 * kind: 'init-reboot' (requested-IP option, ciaddr 0) | 'renewing' (unicast, ciaddr) | 'rebinding' (broadcast, ciaddr).
 * Returns { ack: lease } | { nak: reason } | { silent: reason } and writes dhcpd's journal lines.
 */
function serverRequest(eng, server, { mac, name, cip, kind, giaddr, via }) {
  const svc = server.services['isc-dhcp-server'];
  const cfg = svc.cfg;
  const now = eng.s.t;
  const csub = cfg.subnets.find(s => inSubnet(cip, s.net, s.len)) || null; // find_subnet(cip)
  // find_lease(): the client's own lease, a free pool address, or a host declaration.
  let lease = false;
  let ours = false;
  if (csub) {
    const host = cfg.hosts.find(h => h.mac === mac && h.fixed !== null);
    const owner = Object.entries(svc.leases).find(([m, l]) => m !== mac && l.addr === cip && live(l, now));
    if (host && (host.fixedAll || [host.fixed]).includes(cip)) lease = true;
    else if (host && (host.fixedAll || [host.fixed]).some(ip => inSubnet(ip, csub.net, csub.len))) ours = true; // "requested address is incorrect"
    else if (inRanges(csub, cip)) { ours = true; lease = !owner; }
  }
  const mine = svc.leases[mac];
  const hn = mine && mine.addr === cip ? ` (${mine.client})` : '';
  const msg = `DHCPREQUEST for ${fmtIp(cip)} from ${macLinux(mac)}${hn} via ${via}`;
  const nak = reason => {
    eng.journal(server, 'dhcpd', `${msg}: ${reason}.`);
    eng.journal(server, 'dhcpd', `DHCPNAK on ${fmtIp(cip)} to ${macLinux(mac)} via ${via}`);
    return { nak: reason };
  };
  // Network check: only possible for INIT-REBOOT (requested address) and relayed REBINDING packets.
  // A unicast RENEWING packet looks local, so dhcpd cannot tell it came from the wrong wire.
  const pnet = packetSubnet(eng, server, cfg, giaddr);
  if (!pnet || (kind === 'rebinding' && giaddr !== null) || kind === 'init-reboot') {
    if (!pnet) {
      if (csub && isAuthoritative(cfg, csub)) return nak('wrong network');
      eng.journal(server, 'dhcpd', `${msg}: ignored (${csub ? 'not authoritative' : 'unknown subnet'}).`);
      return { silent: csub ? 'not authoritative' : 'unknown subnet' };
    }
    if (!csub || networkKey(csub) !== networkKey(pnet)) {
      if (isAuthoritative(cfg, pnet)) return nak('wrong network');
      eng.journal(server, 'dhcpd', `${msg}: ignored (not authoritative).`);
      return { silent: 'not authoritative' };
    }
  }
  if (!lease && ours) {
    eng.journal(server, 'dhcpd', `${msg}: lease ${fmtIp(cip)} unavailable.`);
    eng.journal(server, 'dhcpd', `DHCPNAK on ${fmtIp(cip)} to ${macLinux(mac)} via ${via}`);
    return { nak: 'lease unavailable' };
  }
  if (!lease) {
    eng.journal(server, 'dhcpd', `${msg}: unknown lease ${fmtIp(cip)}.`);
    return { silent: 'unknown lease' };
  }
  const l = leaseFor(eng, server, csub, cip);
  eng.journal(server, 'dhcpd', msg);
  eng.journal(server, 'dhcpd', `DHCPACK on ${fmtIp(cip)} to ${macLinux(mac)} (${name}) via ${via}`);
  svc.leases[mac] = { addr: cip, client: name, t: now, ends: now + l.leaseTime };
  return { ack: l };
}

// A consumer "travel router" runs dnsmasq with dhcp-authoritative (the OpenWrt default).
function rogueOffer(eng, rogue, mac) {
  const r = rogue.services['rogue-dhcp'];
  r.next = r.next ?? r.first;
  const lease = r.leases?.[mac];
  const addr = lease ?? r.next++;
  r.leases = r.leases || {};
  r.leases[mac] = addr;
  return { addr, len: r.len, gw: r.gw, dns: r.dns, domain: r.domain ?? null, leaseTime: 43200, server: hostAddr(eng, rogue).addr, serverDev: rogue.id, rogue: true };
}

function rogueRequest(eng, rogue, mac, cip) {
  const r = rogue.services['rogue-dhcp'];
  if (r.leases?.[mac] === cip) return { ack: { addr: cip, len: r.len, gw: r.gw, dns: r.dns, domain: r.domain ?? null, leaseTime: 43200, server: hostAddr(eng, rogue).addr, serverDev: rogue.id, rogue: true } };
  return { nak: 'not in its lease table' };
}

/**
 * Find DHCP servers a broadcast from (devId, port) can reach. srcIp is the packet's IP source (0.0.0.0 for DISCOVER and
 * INIT-REBOOT, the client's address when REBINDING): an inbound ACL on the relay interface filters the broadcast
 * before the helper forwards it. Each candidate: { kind:'direct'|'relay'|'rogue', server, giaddr, relay?, relayIf?, pathLen }
 */
function dhcpCandidates(eng, client, port, srcIp = 0) {
  const fl = eng.flood(client.id, port, null);
  const out = [];
  const drops = [];
  for (const ep of fl.endpoints) {
    const d = eng.s.devices[ep.dev];
    if (d.kind === 'host') {
      const svc = d.services['isc-dhcp-server'];
      if (svc?.active) out.push({ kind: 'direct', server: d, giaddr: null, pathLen: ep.path.length, ep });
      if (d.services['rogue-dhcp']?.active) out.push({ kind: 'rogue', server: d, giaddr: null, pathLen: ep.path.length, ep });
    } else if (d.kind === 'router') {
      const ifc = l3Ifaces(eng, d).find(i => i.name === ep.l3if);
      if (!ifc || !ifc.up || !ifc.cfg.helpers?.length) continue;
      if (ifc.cfg.aclIn) {
        const r = evalAcl(d, ifc.cfg.aclIn, { src: srcIp, dst: 0xffffffff, proto: 'udp', sport: 68, dport: 67 }, false);
        if (!r.permit) { drops.push(`${d.hostname} ${ifc.name}: DHCP broadcast denied by inbound ACL ${ifc.cfg.aclIn} before the relay could forward it`); continue; }
      }
      // A snooping switch adds option 82 but leaves giaddr 0; an IOS relay drops that on an untrusted interface.
      const o82 = option82Inserter(eng, ep.path);
      if (o82 && !d.relayTrustAll && !ifc.cfg.relayTrust) {
        drops.push(`${d.hostname} ${ifc.name}: relay dropped the request: option 82 (inserted by DHCP snooping on ${o82.hostname}) with giaddr 0.0.0.0 on an interface not trusted for relay information`);
        continue;
      }
      for (const helper of ifc.cfg.helpers) {
        // Relay -> server (unicast from giaddr), then server -> relay.
        const there = sendPacket(eng, { from: d.id, srcIp: ifc.addr, dst: helper, proto: 'udp', sport: 67, dport: 67 });
        if (there.outcome !== 'delivered') { drops.push(`${d.hostname}: relay to ${fmtIp(helper)} failed (${there.reason || there.outcome})`); continue; }
        const srv = eng.s.devices[there.at];
        const svc = srv.services?.['isc-dhcp-server'];
        if (!svc?.active) { drops.push(`${srv.hostname}: no DHCP server listening on UDP 67`); continue; }
        const back = sendPacket(eng, { from: srv.id, dst: ifc.addr, proto: 'udp', sport: 67, dport: 67 });
        if (!(back.outcome === 'delivered' && back.at === d.id)) { drops.push(`${srv.hostname}: reply to relay ${fmtIp(ifc.addr)} lost (${back.reason || back.outcome})`); continue; }
        out.push({ kind: 'relay', server: srv, giaddr: ifc.addr, relay: d, relayIf: ifc, pathLen: ep.path.length + 10, ep, relayPath: there.hops });
      }
    }
  }
  // Ordering: on-segment servers answer before relayed ones; shorter paths first; then by name for determinism.
  out.sort((x, y) => (x.pathLen - y.pathLen) || x.server.id.localeCompare(y.server.id));
  return { candidates: out, drops, flood: fl };
}

/** The snooping switch (if any) that inserted option 82 into a client broadcast along this path. */
function option82Inserter(eng, path) {
  for (const h of path) {
    const sw = eng.s.devices[h.to.dev];
    if (sw.kind !== 'switch' || !sw.snoop.enabled || sw.snoop.opt82 === false || !sw.snoop.vlans.includes(h.vlan)) continue;
    if (!sw.ports[h.to.port].snoopTrust) return sw;
  }
  return null;
}

/** Does a broadcast server->client DHCP message (via relay or on-segment) reach the client (DHCP snooping, STP)? */
function offerReaches(eng, cand, client, clientPort) {
  let fl;
  if (cand.kind === 'relay') fl = eng.flood(cand.relay.id, cand.relayIf.port, cand.relayIf.tag, { serverMsg: true });
  else fl = eng.flood(cand.server.id, cand.server.nic, null, { serverMsg: true });
  const ok = fl.endpoints.some(ep => ep.dev === client.id && ep.port === clientPort);
  const snoop = fl.drops.filter(d => d.snoop);
  return { ok, snoop, path: fl.endpoints.find(ep => ep.dev === client.id)?.path || [] };
}

/** DHCP snooping on a unicast server->client message: dropped where it enters a switch on an untrusted port. */
function unicastSnoopDrop(eng, hops) {
  for (const h of hops) {
    if (h.kind !== 'l2') continue;
    const sw = eng.s.devices[h.to.dev];
    if (sw.kind !== 'switch' || !sw.snoop.enabled || !sw.snoop.vlans.includes(h.vlan)) continue;
    if (!sw.ports[h.to.port].snoopTrust) return { dev: sw.id, port: h.to.port, vlan: h.vlan };
  }
  return null;
}

function apipaFor(d) {
  // Deterministic per-device link-local address (Windows picks pseudo-randomly; we seed by device index).
  const x = 1 + ((d.index * 37) % 254);
  const y = 1 + ((d.index * 101) % 254);
  return parseIp(`169.254.${x}.${y}`);
}

/** RFC 2131 timers of a lease: T1 (default 0.5), T2 (default 0.875) and expiry, as absolute simulation times. */
export function leaseTimes(l) {
  const lt = l.leaseTime || 43200;
  return { t1: l.obtained + (l.t1 ?? lt * 0.5), t2: l.obtained + (l.t2 ?? lt * 0.875), expires: l.obtained + lt };
}

/**
 * Run one DHCP client exchange for a host (or one fleet member: opts.mac, opts.name, opts.current = member lease).
 * mode (RFC 2131 client states):
 *  'discover' INIT: broadcast DISCOVER -> OFFER -> REQUEST -> ACK (DORA).
 *  'reboot'   INIT-REBOOT (start-up or link up with a remembered lease): broadcast REQUEST with the requested-IP
 *             option. ACK keeps the address, NAK restarts DORA. No answer: a Windows client pings the lease's default
 *             gateway and keeps the lease if it answers, otherwise falls back to APIPA; dhclient-style clients
 *             (fleet devices, Linux) fall back to DISCOVER.
 *  'renew'    RENEWING (T1, or ipconfig /renew with a lease): REQUEST unicast to the server identifier from the
 *             current address (ciaddr), routed through the client's own gateway. No answer: the client keeps its
 *             unexpired lease. NAK: back to INIT.
 *  'rebind'   REBINDING (T2): the same REQUEST broadcast; relays forward it. NAK: back to INIT.
 * Returns { ok, lease, frames, error, nak, keepLease, rogue, snoopDrops, notes, mode }
 */
export function dhcpClient(eng, client, opts = {}) {
  const mac = opts.mac ?? client.ports[client.nic].mac;
  const name = opts.name ?? client.hostname;
  const port = client.nic;
  const frames = [];
  const notes = [];
  const xid = '0x' + ((eng.rand() * 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  const frame = (src, dst, info, extra = {}) => frames.push({ t: eng.s.t, src, dst, proto: 'DHCP', info: `${info} - Transaction ID ${xid}`, ...extra });
  if (!eng.portUp(client.id, port)) return { ok: false, error: 'media', frames, notes };
  const current = opts.current !== undefined ? opts.current : client.lease;
  let mode = opts.mode ?? 'reboot';
  if (!current || eng.s.t >= leaseTimes(current).expires) mode = 'discover';
  const fallbackDora = client.kind === 'fleet' || client.os !== 'windows';
  const done = (r) => ({ frames, notes, mode, ...r });

  if (mode === 'renew') {
    // RENEWING: unicast to the server that issued the lease, from the leased address.
    frame(fmtIp(current.addr), fmtIp(current.server), `DHCP Request (renewing ${fmtIp(current.addr)})`);
    const there = sendPacket(eng, { from: client.id, member: client.kind === 'fleet' ? current : undefined, dst: current.server, proto: 'udp', sport: 68, dport: 67 });
    if (there.outcome !== 'delivered') {
      notes.push(`the renewal is a unicast from ${fmtIp(current.addr)} to the DHCP server ${fmtIp(current.server)}; it never arrived (${there.reason || there.outcome}${there.nh !== undefined ? `, next hop ${fmtIp(there.nh)}` : ''})`);
      return done({ ok: false, error: 'timeout', keepLease: true });
    }
    const srv = eng.s.devices[there.at];
    const isc = srv.services?.['isc-dhcp-server'];
    let ans;
    if (isc?.active) ans = serverRequest(eng, srv, { mac, name, cip: current.addr, kind: 'renewing', giaddr: null, via: srv.nic });
    else if (srv.services?.['rogue-dhcp']?.active) ans = rogueRequest(eng, srv, mac, current.addr);
    else {
      notes.push(`${srv.hostname} has nothing listening on UDP 67 (it answers with ICMP port unreachable)`);
      return done({ ok: false, error: 'timeout', keepLease: true });
    }
    if (ans.silent) { notes.push(`${srv.hostname} ignored the renewal (${ans.silent})`); return done({ ok: false, error: 'timeout', keepLease: true }); }
    const back = sendPacket(eng, { from: srv.id, dst: current.addr, proto: 'udp', sport: 67, dport: 68 });
    const snoop = back.outcome === 'delivered' ? unicastSnoopDrop(eng, back.hops) : null;
    if (back.outcome !== 'delivered' || back.at !== client.id || snoop) {
      if (snoop) {
        eng.syslog(eng.s.devices[snoop.dev], '%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT', `DHCP_SNOOPING drop message on untrusted port, message type: ${ans.ack ? 'DHCPACK' : 'DHCPNAK'}, MAC sa: ${macCiscoOf(srv)}`);
        notes.push(`${srv.hostname}'s reply was dropped by DHCP snooping on ${eng.s.devices[snoop.dev].hostname} ${snoop.port}`);
      } else notes.push(`${srv.hostname}'s reply to ${fmtIp(current.addr)} was lost (${back.reason || back.outcome})`);
      return done({ ok: false, error: 'timeout', keepLease: true });
    }
    if (ans.ack) {
      frame(fmtIp(ans.ack.server), fmtIp(current.addr), 'DHCP ACK');
      return done({ ok: true, lease: { ...ans.ack, obtained: eng.s.t }, renewed: true, via: 'unicast', rogue: !!ans.ack.rogue });
    }
    frame(fmtIp(hostAddr(eng, srv).addr), fmtIp(current.addr), 'DHCP NAK');
    notes.push(`${srv.hostname} refused ${fmtIp(current.addr)} (NAK): the client starts over with DISCOVER`);
    return dora(true);
  }

  const srcIp = mode === 'rebind' ? current.addr : 0;
  const { candidates, drops } = dhcpCandidates(eng, client, port, srcIp);
  notes.push(...drops);

  if (mode === 'reboot' || mode === 'rebind') {
    // INIT-REBOOT / REBINDING: broadcast REQUEST; the first server whose answer reaches the client decides.
    frame(mode === 'rebind' ? fmtIp(current.addr) : '0.0.0.0', '255.255.255.255', mode === 'rebind' ? `DHCP Request (rebinding ${fmtIp(current.addr)})` : `DHCP Request (requested ${fmtIp(current.addr)})`);
    let answer = null;
    for (const c of candidates) {
      const via = c.giaddr !== null ? fmtIp(c.giaddr) : c.server.nic;
      const ans = c.kind === 'rogue' ? rogueRequest(eng, c.server, mac, current.addr)
        : serverRequest(eng, c.server, { mac, name, cip: current.addr, kind: mode === 'rebind' ? 'rebinding' : 'init-reboot', giaddr: c.giaddr, via });
      if (ans.silent) { notes.push(`${c.server.hostname} did not answer (${ans.silent})`); continue; }
      const reach = offerReaches(eng, c, client, port);
      if (!reach.ok) {
        for (const d of reach.snoop) eng.syslog(eng.s.devices[d.dev], '%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT', `DHCP_SNOOPING drop message on untrusted port, message type: ${ans.ack ? 'DHCPACK' : 'DHCPNAK'}, MAC sa: ${macCiscoOf(c.server)}`);
        notes.push(`${ans.ack ? 'ACK' : 'NAK'} from ${c.server.hostname} did not reach ${name}${reach.snoop.length ? ' (dropped by DHCP snooping)' : ''}`);
        continue;
      }
      answer = { c, ans };
      break;
    }
    if (answer?.ans.ack) {
      const l = answer.ans.ack;
      frame(fmtIp(answer.c.kind === 'relay' ? answer.c.giaddr : l.server), fmtIp(current.addr), 'DHCP ACK');
      return done({ ok: true, lease: { ...l, obtained: eng.s.t }, renewed: true, via: answer.c.kind, rogue: answer.c.kind === 'rogue' });
    }
    if (answer?.ans.nak) {
      frame(fmtIp(answer.c.kind === 'relay' ? answer.c.giaddr : hostAddr(eng, answer.c.server).addr), '255.255.255.255', 'DHCP NAK');
      notes.push(`${answer.c.server.hostname} refused ${fmtIp(current.addr)}: ${answer.c.kind === 'rogue' ? 'not an address it handed out' : answer.ans.nak} (NAK)`);
      return dora(true);
    }
    // Nobody answered.
    if (mode === 'rebind') return done({ ok: false, error: 'timeout', keepLease: true });
    if (fallbackDora) {
      // dhclient gives up on INIT-REBOOT after its reboot timeout and sends DISCOVER; with no offer either, it goes
      // back to the recorded lease while that is unexpired.
      const r = dora(false);
      return r.ok ? r : { ...r, keepLease: true };
    }
    // Windows: ping the default gateway listed in the lease; if it answers, assume the same network and keep the lease.
    const gw = current.gw;
    const p = gw !== null && gw !== undefined ? probe(eng, { from: client.id, dst: gw, proto: 'icmp' }) : null;
    if (p && p.status === 'ok' && p.kind === 'reply') {
      notes.push(`no DHCP server answered; the default gateway ${fmtIp(gw)} answered a ping, so Windows keeps its unexpired lease`);
      return done({ ok: false, error: 'timeout', keepLease: true, gatewayAnswered: true });
    }
    notes.push(`no DHCP server answered and the lease's default gateway ${gw !== null && gw !== undefined ? fmtIp(gw) : '(none)'} did not answer a ping: Windows assumes it moved to a network without DHCP, uses APIPA and retries every 5 minutes`);
    return done({ ok: false, error: 'timeout' });
  }
  return dora(false);

  function dora(afterNak) {
    frame('0.0.0.0', '255.255.255.255', 'DHCP Discover');
    const cands = mode === 'discover' ? { candidates, drops: [] } : dhcpCandidates(eng, client, port, 0);
    for (const d of cands.drops) if (!notes.includes(d)) notes.push(d);
    const snoopDrops = [];
    for (const c of cands.candidates) {
      let offer;
      if (c.kind === 'rogue') offer = rogueOffer(eng, c.server, mac);
      else {
        const via = c.giaddr !== null ? fmtIp(c.giaddr) : c.server.nic;
        const r = serverOffer(eng, c.server, mac, name, c.giaddr, via);
        if (!r.offer) { notes.push(`${c.server.hostname}: ${r.refused}`); continue; }
        offer = r.offer;
      }
      const reach = offerReaches(eng, c, client, port);
      if (!reach.ok) {
        for (const d of reach.snoop) {
          snoopDrops.push(d);
          eng.syslog(eng.s.devices[d.dev], '%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT', `DHCP_SNOOPING drop message on untrusted port, message type: DHCPOFFER, MAC sa: ${macCiscoOf(c.server)}`);
        }
        notes.push(`offer from ${c.server.hostname} did not reach ${name}${reach.snoop.length ? ' (dropped by DHCP snooping)' : ''}`);
        continue;
      }
      const from = c.kind === 'relay' ? fmtIp(c.giaddr) : fmtIp(hostAddr(eng, c.server).addr);
      frame(from, fmtIp(offer.addr), `DHCP Offer (${fmtIp(offer.addr)})`, { server: c.server.id });
      frame('0.0.0.0', '255.255.255.255', `DHCP Request (${fmtIp(offer.addr)})`);
      if (c.kind !== 'rogue') commitLease(eng, c.server, mac, name, offer, c.giaddr !== null ? fmtIp(c.giaddr) : c.server.nic, offer.server);
      frame(from, fmtIp(offer.addr), 'DHCP ACK');
      const { subnet, ...lease } = offer;
      return done({ ok: true, lease: { ...lease, obtained: eng.s.t }, rogue: c.kind === 'rogue', via: c.kind, snoopDrops, nak: afterNak || undefined });
    }
    return done({ ok: false, error: 'timeout', snoopDrops, nak: afterNak || undefined });
  }
}

function macCiscoOf(srv) {
  const m = srv.ports[srv.nic].mac;
  return `${m.slice(0, 4)}.${m.slice(4, 8)}.${m.slice(8, 12)}`;
}

/**
 * Side-effect-free DHCP exchange (for goal checks): what would this client get if it ran DORA now?
 */
export function dhcpDryRun(eng, client, opts = {}) {
  const saved = [];
  for (const d of Object.values(eng.s.devices)) {
    if (d.services?.['isc-dhcp-server']) saved.push([d.services['isc-dhcp-server'], 'leases', JSON.stringify(d.services['isc-dhcp-server'].leases || {})]);
    if (d.services?.['rogue-dhcp']) saved.push([d.services['rogue-dhcp'], 'leases', JSON.stringify(d.services['rogue-dhcp'].leases || {})], [d.services['rogue-dhcp'], 'next', JSON.stringify(d.services['rogue-dhcp'].next ?? null)]);
  }
  const j = eng.journal;
  const sl = eng.syslog;
  const rng = eng.s.rngState;
  eng.journal = () => {};
  eng.syslog = () => {};
  try {
    return dhcpClient(eng, client, { mode: 'discover', current: null, ...opts });
  } finally {
    eng.journal = j;
    eng.syslog = sl;
    eng.s.rngState = rng;
    for (const [obj, key, val] of saved) obj[key] = JSON.parse(val);
  }
}

/** Apply a client exchange result to a host the way Windows/Linux clients do. */
export function applyDhcpResult(eng, client, res) {
  if (res.ok) {
    const moved = !client.lease || client.lease.addr !== res.lease.addr;
    client.lease = res.lease;
    client.released = false;
    client.apipa = null;
    if (moved) client.dnsCache = {};
  } else if (!res.keepLease) {
    client.lease = null;
    if (res.error !== 'media' && client.os === 'windows') client.apipa = apipaFor(client);
    if (res.error !== 'media' && client.os === 'linux') client.apipa = null;
  }
  client.nextDhcpRetry = eng.s.t + 300;
  eng.changed('dhcp-client');
}

export function dhcpRelease(eng, client) {
  const lease = client.lease;
  let delivered = false;
  if (lease) {
    // DHCPRELEASE is a unicast to the server identifier; no reply, so the client drops its address either way.
    const pr = sendPacket(eng, { from: client.id, dst: lease.server, proto: 'udp', sport: 68, dport: 67 });
    const srv = pr.outcome === 'delivered' ? eng.s.devices[pr.at] : null;
    const svc = srv?.services?.['isc-dhcp-server'];
    if (svc?.active) {
      const mac = client.ports[client.nic].mac;
      const found = svc.leases[mac]?.addr === lease.addr;
      if (found) delete svc.leases[mac];
      eng.journal(srv, 'dhcpd', `DHCPRELEASE of ${fmtIp(lease.addr)} from ${macLinux(mac)} (${client.hostname}) via ${srv.nic} (${found ? '' : 'not '}found)`);
      delivered = true;
    }
  }
  client.lease = null;
  client.released = true;
  client.apipa = null;
  eng.changed('dhcp-release');
  return { delivered };
}

/**
 * Lease timers of a DHCP host (RFC 2131 4.4.5): at T1 a unicast renewal to the server, retried after half the time
 * left to T2 (at least 60 s); from T2 broadcast rebinding, retried after half the time left on the lease; at expiry the
 * address is dropped and the client starts over (INIT). Returns true if the client's configuration changed.
 */
export function dhcpHostTick(eng, d) {
  const l = d.lease;
  if (!l) return false;
  const now = eng.s.t;
  const { t1, t2, expires } = leaseTimes(l);
  if (now < t1 || now < (l.retryAt ?? 0)) return false;
  if (now >= expires) {
    d.lease = null;
    const res = dhcpClient(eng, d, { mode: 'discover', current: null });
    applyDhcpResult(eng, d, res);
    return true;
  }
  const mode = now >= t2 ? 'rebind' : 'renew';
  const res = dhcpClient(eng, d, { mode });
  if (res.ok || !res.keepLease) { applyDhcpResult(eng, d, res); return true; }
  l.retryAt = mode === 'renew' ? Math.min(t2, now + Math.max(60, (t2 - now) / 2)) : Math.min(expires, now + Math.max(60, (expires - now) / 2));
  return false;
}

/**
 * Fleet devices (e.g. 50 cameras) behave like many dhclient-style DHCP clients behind one access port.
 * Members without a lease run DORA. Leased members follow the RFC 2131 timers (unicast renewal at T1, broadcast
 * rebinding at T2, DORA after expiry). opts.all = the link just came up (PoE bounce, cable re-patched): every
 * leased member re-confirms its address with INIT-REBOOT, which is when a changed scope NAKs it.
 */
export function fleetDhcp(eng, fleet, opts = {}) {
  const before = JSON.stringify(fleet.leases.map(m => m.addr));
  const kept = [];
  const now = eng.s.t;
  for (const m of fleet.leases) {
    const call = (mode, current) => dhcpClient(eng, fleet, { mac: m.mac, name: `${fleet.hostname}-${m.n}`, current, mode });
    let res = null;
    if (opts.all) res = call('reboot', m);
    else {
      const { t1, t2, expires } = leaseTimes(m);
      if (now >= expires) { res = call('discover', null); }
      else if (now >= t1 && now >= (m.retryAt ?? 0)) {
        const mode = now >= t2 ? 'rebind' : 'renew';
        res = call(mode, m);
        if (!res.ok && res.keepLease) {
          m.retryAt = mode === 'renew' ? Math.min(t2, now + Math.max(60, (t2 - now) / 2)) : Math.min(expires, now + Math.max(60, (expires - now) / 2));
        }
      }
    }
    if (!res) kept.push(m);
    else if (res.ok) kept.push({ mac: m.mac, n: m.n, ...res.lease });
    else if (res.keepLease) kept.push(m);
  }
  fleet.leases = kept;
  const have = new Set(kept.map(m => m.mac));
  for (let n = 1; n <= fleet.count; n++) {
    const mac = (parseInt(fleet.mac, 16) + 0x1000 + n).toString(16).padStart(12, '0');
    if (have.has(mac)) continue;
    const res = dhcpClient(eng, fleet, { mac, name: `${fleet.hostname}-${n}`, current: null, mode: 'discover' });
    if (!res.ok) break; // pool exhausted or no server: remaining members fail the same way
    fleet.leases.push({ ...res.lease, mac, n });
  }
  fleet.leases.sort((a, b) => a.n - b.n);
  if (JSON.stringify(fleet.leases.map(m => m.addr)) !== before) eng.changed('fleet-dhcp');
  return fleet.leases.length;
}

// ------------------------------------------------------------------ DNS

/**
 * Load named's primary zones. opts.reload (rndc reload / systemctl reload): a zone that fails to load keeps
 * serving the last copy that loaded, as BIND does. On start/restart there is no previous copy: the zone is
 * simply not loaded, and named answers SERVFAIL for names in it (it never forwards them).
 */
export function namedLoad(eng, dev, opts = {}) {
  const svc = dev.services.named;
  const prev = opts.reload ? svc.loaded || {} : {};
  const loaded = {};
  const errors = [];
  for (const z of svc.zones) {
    const res = parseZone(dev.files[z.file] ?? '', z.zone, z.file);
    if (res.ok) {
      loaded[z.zone] = res;
      eng.journal(dev, 'named', `zone ${z.zone}/IN: loaded serial ${res.serial}`);
    } else {
      for (const e of [...res.errors, ...zoneLoadFailure(res)]) eng.journal(dev, 'named', e);
      if (prev[z.zone]) loaded[z.zone] = prev[z.zone];
      errors.push(...res.errors);
    }
  }
  svc.loaded = loaded;
  return { ok: errors.length === 0, errors };
}

/** Most specific zone this server is configured as primary for (loaded or not). */
function zoneFor(svc, qname) {
  let best = null;
  for (const { zone: z } of svc.zones || []) {
    if ((qname === z || qname.endsWith('.' + z)) && (!best || z.length > best.length)) best = z;
  }
  return best;
}

/**
 * Answer a query at a server device. Returns { rcode, answers:[{name,type,ttl,addr|target}], aa }
 * Assumes the query packet already reached the server.
 */
export function serverAnswer(eng, server, qname, qtype = 'A', depth = 0) {
  qname = qname.toLowerCase().replace(/\.$/, '');
  if (server.services['public-dns']?.active) {
    const rec = eng.s.internet.names[qname];
    if (!rec) return { rcode: 'NXDOMAIN', answers: [], aa: false };
    return { rcode: 'NOERROR', answers: [{ name: qname, type: 'A', ttl: 300, addr: parseIp(rec) }], aa: false };
  }
  const svc = server.services.named;
  if (!svc?.active) return { rcode: 'NOSERVICE', answers: [] };
  const z = zoneFor(svc, qname);
  if (z && !svc.loaded?.[z]) return { rcode: 'SERVFAIL', answers: [], aa: false };
  if (z) {
    const recs = svc.loaded[z].records;
    const answers = [];
    let name = qname;
    for (let hop = 0; hop < 8; hop++) {
      const here = recs.filter(r => r.name === name);
      if (!here.length) return answers.length ? { rcode: 'NOERROR', answers, aa: true } : { rcode: 'NXDOMAIN', answers: [], aa: true, soaTtl: svc.loaded[z].soa?.minimum };
      const cname = here.find(r => r.type === 'CNAME');
      if (cname && qtype !== 'CNAME') {
        answers.push({ name, type: 'CNAME', ttl: cname.ttl, target: cname.target });
        name = cname.target;
        if (zoneFor(svc, name) !== z) break;
        continue;
      }
      for (const r of here.filter(r => r.type === qtype)) answers.push({ name, type: r.type, ttl: r.ttl, addr: r.addr, target: r.target, pref: r.pref, text: r.text });
      return { rcode: 'NOERROR', answers, aa: true };
    }
    if (answers.length && depth < 3) {
      const last = answers[answers.length - 1];
      const rest = serverAnswer(eng, server, last.target, qtype, depth + 1);
      return { ...rest, answers: [...answers, ...rest.answers], aa: false };
    }
    return { rcode: 'NOERROR', answers, aa: true };
  }
  if (!svc.recursion) return { rcode: 'REFUSED', answers: [] };
  for (const fwd of svc.forwarders || []) {
    const p = probe(eng, { from: server.id, dst: fwd, proto: 'udp', dport: 53, sport: 33000 + (depth * 7) });
    if (p.status !== 'ok' || p.kind !== 'udp-reply') {
      eng.journal(server, 'named', `timed out resolving '${qname}/${qtype}/IN': ${fmtIp(fwd)}#53`);
      continue;
    }
    const target = eng.s.devices[p.fwd.at];
    const r = serverAnswer(eng, target, qname, qtype, depth + 1);
    return { ...r, aa: false };
  }
  eng.journal(server, 'named', `client: query failed (SERVFAIL) for ${qname}/IN/${qtype} at query.c`);
  return { rcode: 'SERVFAIL', answers: [], aa: false };
}

/**
 * Client-side resolution.
 * opts: { server (override ip), useCache (Windows stub resolver), type }
 * Returns { ok, addr, rcode, server, serverIp, error, fromCache, answers, aa, tried }
 */
export function resolveName(eng, client, name, opts = {}) {
  let qname = name.toLowerCase().replace(/\.$/, '');
  const a = hostAddr(eng, client);
  if (!qname.includes('.') && a.domain) qname = `${qname}.${a.domain}`;
  const literal = parseIp(qname);
  if (literal !== null) return { ok: true, addr: literal, literal: true, qname };
  if (opts.useCache) {
    const c = client.dnsCache?.[qname];
    if (c && c.expires > eng.s.t) return { ok: true, addr: c.addr, fromCache: true, qname, ttlLeft: Math.round(c.expires - eng.s.t) };
  }
  const servers = opts.server !== undefined ? [opts.server] : (a.dns || []);
  if (!servers.length) return { ok: false, error: 'no-dns-servers', qname };
  const tried = [];
  for (const srvIp of servers) {
    const p = probe(eng, { from: client.id, dst: srvIp, proto: 'udp', dport: 53, sport: 50000 + Math.floor(eng.rand() * 9999) });
    tried.push({ ip: srvIp, status: p.status, kind: p.kind, probe: p });
    if (p.status !== 'ok' || p.kind !== 'udp-reply') continue;
    const server = eng.s.devices[p.fwd.at];
    const ans = serverAnswer(eng, server, qname, opts.type || 'A');
    if (ans.rcode === 'NOSERVICE') continue;
    const aRec = ans.answers.filter(x => x.type === 'A').pop();
    if (ans.rcode === 'NOERROR' && aRec) {
      if (opts.useCache && client.dnsCache) client.dnsCache[qname] = { addr: aRec.addr, expires: eng.s.t + aRec.ttl, ttl: aRec.ttl };
      return { ok: true, addr: aRec.addr, rcode: 'NOERROR', serverIp: srvIp, server, answers: ans.answers, aa: ans.aa, qname, tried, probe: p };
    }
    return { ok: false, rcode: ans.rcode, error: ans.rcode.toLowerCase(), serverIp: srvIp, server, answers: ans.answers, aa: ans.aa, qname, tried, probe: p };
  }
  // ICMP port unreachable from every server = host up, nothing listening on UDP 53 ("connection refused"),
  // which clients report at once instead of after a timeout (same idea as a TCP RST for curl).
  const refused = tried.every(t => t.status === 'ok' && t.kind === 'port-unreachable');
  return { ok: false, error: refused ? 'refused' : 'timeout', qname, tried, serverIp: servers[0] };
}

// ------------------------------------------------------------------ HTTP(S)

export function parseUrl(url) {
  const m = /^(https?):\/\/([^/:\s]+)(?::(\d+))?(\/[^\s]*)?$/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return { scheme, host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80, path: m[4] || '/' };
}

/**
 * Perform an HTTP(S) request from a client.
 * Returns { stage, ok, status, headers, body, error:{code,msg}, ip, resolve, connect, tls }
 * stage: 'resolve' | 'connect' | 'tls' | 'http'
 */
export function httpRequest(eng, client, url, opts = {}) {
  const u = parseUrl(url);
  if (!u) return { stage: 'parse', ok: false, error: { code: 3, msg: 'URL rejected: Malformed input to a URL function' } };
  const res = resolveName(eng, client, u.host, { useCache: client.os === 'windows' && !opts.noCache });
  if (!res.ok) return { stage: 'resolve', ok: false, url: u, resolve: res, error: { code: 6, msg: `Could not resolve host: ${u.host}` } };
  const ip = res.addr;
  const p = probe(eng, { from: client.id, dst: ip, proto: 'tcp', dport: u.port, sport: 51000 + Math.floor(eng.rand() * 9000), record: true });
  const base = { url: u, ip, resolve: res, connect: p };
  if (p.status === 'local-error') return { ...base, stage: 'connect', ok: false, error: { code: 7, msg: 'Failed to connect', local: p.reason } };
  if (p.status === 'timeout') return { ...base, stage: 'connect', ok: false, error: { code: 28, msg: 'Timed out' } };
  if (p.kind === 'rst') return { ...base, stage: 'connect', ok: false, error: { code: 7, msg: 'Could not connect to server', refused: true } };
  if (p.kind !== 'syn-ack') return { ...base, stage: 'connect', ok: false, error: { code: 7, msg: 'Could not connect to server' } };
  // loss on a degraded path can still break the session
  if (p.pass < 0.25 && eng.rand() > p.pass * 2) return { ...base, stage: 'http', ok: false, error: { code: 56, msg: 'Recv failure: Connection was reset' } };
  const server = eng.s.devices[p.fwd.at];
  const web = Object.values(server.services).find(s => s.kind === 'web' && s.active && s.listen.some(l => l.port === u.port));
  if (!web) return { ...base, stage: 'connect', ok: false, error: { code: 7, msg: 'Could not connect to server' } };
  const site = web.sites.find(s => s.names.includes(u.host)) || web.sites.find(s => s.default) || web.sites[0];
  if (u.scheme === 'https') {
    const names = site.cert?.names || [];
    const okName = names.some(n => n === u.host || (n.startsWith('*.') && u.host.endsWith(n.slice(1)) && u.host.split('.').length === n.split('.').length));
    if (!okName && !opts.insecure) return { ...base, stage: 'tls', ok: false, server, site, error: { code: 60, msg: 'certificate name mismatch', certNames: names } };
  }
  const route = site.routes?.[u.path] || site.routes?.['*'] || { status: 404, body: '<html><head><title>404 Not Found</title></head></html>', type: 'text/html' };
  const status = route.status;
  const r = { ...base, stage: 'http', ok: status >= 200 && status < 400, status, body: route.body, type: route.type || 'application/json', server, site, rttMs: p.rttMs };
  return r;
}
