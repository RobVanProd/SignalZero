// Application services: DHCP (server, relay, client), DNS (authoritative + forwarding, Windows cache), HTTP(S).
import { fmtIp, parseIp, inSubnet, isApipa } from './ipv4.js';
import { parseDhcpd, subnetOptions } from './parsers/dhcpd.js';
import { parseZone, zoneLoadFailure } from './parsers/zone.js';
import { hostAddr, l3Ifaces, evalAcl } from './routing.js';
import { sendPacket, probe } from './trace.js';
import { macLinux } from './model.js';

// ------------------------------------------------------------------ DHCP server

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

function usedAddrs(svc, sub, exceptMac) {
  const used = new Set();
  for (const [mac, l] of Object.entries(svc.leases)) if (mac !== exceptMac && inSubnet(l.addr, sub.net, sub.len)) used.add(l.addr);
  return used;
}

/** Server-side DISCOVER handling. Returns { offer } or { log } explaining the refusal. */
function serverOffer(eng, server, mac, clientName, giaddr, viaLabel) {
  const svc = server.services['isc-dhcp-server'];
  const cfg = svc.cfg;
  const a = hostAddr(eng, server);
  const key = giaddr ?? a.addr;
  const sub = cfg.subnets.find(s => inSubnet(key, s.net, s.len));
  eng.journal(server, 'dhcpd', `DHCPDISCOVER from ${macLinux(mac)} via ${viaLabel}${sub ? '' : ': unknown network segment'}`);
  if (!sub) return { refused: 'unknown network segment' };
  const fixed = cfg.hosts.find(h => h.mac === mac && h.fixed !== null && inSubnet(h.fixed, sub.net, sub.len));
  let addr = null;
  if (fixed) addr = fixed.fixed;
  else {
    const prev = svc.leases[mac];
    const used = usedAddrs(svc, sub, mac);
    if (prev && inSubnet(prev.addr, sub.net, sub.len) && sub.ranges.some(([x, y]) => prev.addr >= x && prev.addr <= y)) addr = prev.addr;
    else {
      outer: for (const [x, y] of sub.ranges) {
        for (let ip = x; ip <= y; ip++) if (!used.has(ip)) { addr = ip; break outer; }
      }
    }
  }
  if (addr === null) {
    eng.journal(server, 'dhcpd', `DHCPDISCOVER from ${macLinux(mac)} via ${viaLabel}: network ${fmtIp(sub.net)}/${sub.len}: no free leases`);
    return { refused: 'no free leases', subnet: sub };
  }
  const o = subnetOptions(cfg, sub);
  eng.journal(server, 'dhcpd', `DHCPOFFER on ${fmtIp(addr)} to ${macLinux(mac)} (${clientName}) via ${viaLabel}`);
  return { offer: { addr, len: sub.len, gw: o.routers[0] ?? null, dns: o.dns, domain: o.domain, leaseTime: o.leaseTime, server: a.addr, serverDev: server.id, subnet: sub } };
}

function commitLease(eng, server, mac, clientName, offer, viaLabel) {
  const svc = server.services['isc-dhcp-server'];
  eng.journal(server, 'dhcpd', `DHCPREQUEST for ${fmtIp(offer.addr)} (${fmtIp(offer.server)}) from ${macLinux(mac)} (${clientName}) via ${viaLabel}`);
  eng.journal(server, 'dhcpd', `DHCPACK on ${fmtIp(offer.addr)} to ${macLinux(mac)} (${clientName}) via ${viaLabel}`);
  svc.leases[mac] = { addr: offer.addr, client: clientName, t: eng.s.t, ends: eng.s.t + offer.leaseTime };
}

function rogueOffer(eng, rogue, mac) {
  const r = rogue.services['rogue-dhcp'];
  r.next = r.next ?? r.first;
  const lease = r.leases?.[mac];
  const addr = lease ?? r.next++;
  r.leases = r.leases || {};
  r.leases[mac] = addr;
  return { addr, len: r.len, gw: r.gw, dns: r.dns, domain: r.domain ?? null, leaseTime: 43200, server: hostAddr(eng, rogue).addr, serverDev: rogue.id, rogue: true };
}

/**
 * Find DHCP servers a broadcast from (devId, port) can reach. Each candidate:
 * { kind:'direct'|'relay'|'rogue', server, giaddr, relay?, relayIf?, pathLen, offerPath }
 */
function dhcpCandidates(eng, client, port, mac) {
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
        const r = evalAcl(d, ifc.cfg.aclIn, { src: 0, dst: 0xffffffff, proto: 'udp', sport: 68, dport: 67 }, false);
        if (!r.permit) { drops.push(`${d.hostname} ${ifc.name}: DHCP broadcast denied by ACL ${ifc.cfg.aclIn}`); continue; }
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

/** Does a server->client DHCP message reach the client (DHCP snooping, STP)? */
function offerReaches(eng, cand, client, clientPort) {
  let fl;
  if (cand.kind === 'relay') fl = eng.flood(cand.relay.id, cand.relayIf.port, cand.relayIf.tag, { serverMsg: true });
  else fl = eng.flood(cand.server.id, cand.server.nic, null, { serverMsg: true });
  const ok = fl.endpoints.some(ep => ep.dev === client.id && ep.port === clientPort);
  const snoop = fl.drops.filter(d => d.snoop);
  return { ok, snoop, path: fl.endpoints.find(ep => ep.dev === client.id)?.path || [] };
}

function apipaFor(d) {
  // Deterministic per-device link-local address (Windows picks pseudo-randomly; we seed by device index).
  const x = 1 + ((d.index * 37) % 254);
  const y = 1 + ((d.index * 101) % 254);
  return parseIp(`169.254.${x}.${y}`);
}

/**
 * Run a DHCP client exchange for a host (or one fleet member).
 * mode: 'renew' (ipconfig /renew, dhclient) — tries INIT-REBOOT for an existing lease, else DORA.
 * Returns { ok, lease, frames, error, nak, rogue, snoopDrops, notes }
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
  const current = opts.current ?? client.lease;

  const { candidates, drops } = dhcpCandidates(eng, client, port, mac);
  notes.push(...drops);

  // INIT-REBOOT: broadcast REQUEST for the current address; the first server to answer ACKs or NAKs.
  if (current && opts.mode !== 'discover') {
    frame('0.0.0.0', '255.255.255.255', `DHCP Request (requested ${fmtIp(current.addr)})`);
    for (const c of candidates) {
      const reach = offerReaches(eng, c, client, port);
      if (!reach.ok) continue;
      if (c.kind === 'rogue') {
        frame(fmtIp(hostAddr(eng, c.server).addr), '255.255.255.255', 'DHCP NAK');
        notes.push(`${c.server.hostname} answered with NAK (authoritative for its own network)`);
        break;
      }
      const svc = c.server.services['isc-dhcp-server'];
      const key = c.giaddr ?? hostAddr(eng, c.server).addr;
      const sub = svc.cfg.subnets.find(s => inSubnet(key, s.net, s.len));
      const via = c.giaddr !== null ? fmtIp(c.giaddr) : c.server.nic;
      eng.journal(c.server, 'dhcpd', `DHCPREQUEST for ${fmtIp(current.addr)} from ${macLinux(mac)} (${name}) via ${via}`);
      const inRange = sub && sub.ranges.some(([x, y]) => current.addr >= x && current.addr <= y);
      const fixed = sub && svc.cfg.hosts.find(h => h.mac === mac && h.fixed === current.addr);
      const owner = Object.entries(svc.leases).find(([m, l]) => l.addr === current.addr && m !== mac);
      if (sub && (inRange || fixed) && !owner) {
        const o = subnetOptions(svc.cfg, sub);
        const lease = { addr: current.addr, len: sub.len, gw: o.routers[0] ?? null, dns: o.dns, domain: o.domain, leaseTime: o.leaseTime, server: hostAddr(eng, c.server).addr, serverDev: c.server.id };
        svc.leases[mac] = { addr: current.addr, client: name, t: eng.s.t, ends: eng.s.t + o.leaseTime };
        eng.journal(c.server, 'dhcpd', `DHCPACK on ${fmtIp(current.addr)} to ${macLinux(mac)} (${name}) via ${via}`);
        frame(fmtIp(lease.server), fmtIp(current.addr), 'DHCP ACK');
        return { ok: true, lease: { ...lease, obtained: eng.s.t }, frames, notes, renewed: true, via: c.kind };
      }
      eng.journal(c.server, 'dhcpd', `DHCPNAK on ${fmtIp(current.addr)} to ${macLinux(mac)} via ${via}`);
      frame(fmtIp(hostAddr(eng, c.server).addr), '255.255.255.255', 'DHCP NAK');
      notes.push(`${c.server.hostname} refused ${fmtIp(current.addr)}: wrong network for this segment (NAK)`);
      break;
    }
    if (!frames.some(f => /NAK/.test(f.info))) {
      // nobody answered: keep the current lease
      return { ok: false, error: 'timeout', keepLease: true, frames, notes };
    }
  }

  // DORA
  frame('0.0.0.0', '255.255.255.255', 'DHCP Discover');
  const snoopDrops = [];
  for (const c of candidates) {
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
        eng.syslog(eng.s.devices[d.dev], '%DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT', `DHCP_SNOOPING drop message on untrusted port, message type: DHCPOFFER, MAC sa: ${macCiscoOf(c)}`);
      }
      notes.push(`offer from ${c.server.hostname} did not reach ${name}${reach.snoop.length ? ' (dropped by DHCP snooping)' : ''}`);
      continue;
    }
    const from = c.kind === 'relay' ? fmtIp(c.giaddr) : fmtIp(hostAddr(eng, c.server).addr);
    frame(from, fmtIp(offer.addr), `DHCP Offer (${fmtIp(offer.addr)})`, { server: c.server.id });
    frame('0.0.0.0', '255.255.255.255', `DHCP Request (${fmtIp(offer.addr)})`);
    if (c.kind !== 'rogue') commitLease(eng, c.server, mac, name, offer, c.giaddr !== null ? fmtIp(c.giaddr) : c.server.nic);
    frame(from, fmtIp(offer.addr), 'DHCP ACK');
    return { ok: true, lease: { ...offer, obtained: eng.s.t }, frames, notes, rogue: c.kind === 'rogue', via: c.kind, snoopDrops };
  }
  return { ok: false, error: 'timeout', frames, notes, snoopDrops };
}

function macCiscoOf(c) {
  const m = c.server.ports[c.server.nic].mac;
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
    client.lease = res.lease;
    client.released = false;
    client.apipa = null;
    client.dnsCache = {};
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
  if (lease) {
    const srv = eng.s.devices[lease.serverDev];
    const svc = srv?.services?.['isc-dhcp-server'];
    const pr = sendPacket(eng, { from: client.id, dst: lease.server, proto: 'udp', sport: 68, dport: 67 });
    if (svc?.active && pr.outcome === 'delivered') {
      delete svc.leases[client.ports[client.nic].mac];
      eng.journal(srv, 'dhcpd', `DHCPRELEASE of ${fmtIp(lease.addr)} from ${macLinux(client.ports[client.nic].mac)} (${client.hostname}) via ${srv.nic} (found)`);
    }
  }
  client.lease = null;
  client.released = true;
  client.apipa = null;
  eng.changed('dhcp-release');
}

/**
 * Fleet devices (e.g. 50 cameras) behave like many DHCP clients behind one access port.
 * Members without a lease run DORA. Leased members renew at T1 (half the lease time), or immediately
 * when `all` is set (link came up / PoE port bounced), which is when a changed scope NAKs them.
 */
export function fleetDhcp(eng, fleet, opts = {}) {
  const before = JSON.stringify(fleet.leases.map(m => m.addr));
  const kept = [];
  for (const m of fleet.leases) {
    const due = opts.all || eng.s.t >= m.obtained + (m.leaseTime || 600) / 2;
    if (!due) { kept.push(m); continue; }
    const res = dhcpClient(eng, fleet, { mac: m.mac, name: `${fleet.hostname}-${m.n}`, current: m, mode: 'renew' });
    if (res.ok) kept.push({ ...m, ...res.lease });
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
