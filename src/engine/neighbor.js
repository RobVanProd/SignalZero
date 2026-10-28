// IPv4 neighbour (ARP) tables, learned only from traffic the player causes (probes with `record`).
// The packet walk in trace.js resolves next hops from the topology itself, so these tables never change whether a
// packet is delivered; they record what each device has learned, which is what `ip neigh`, `arp -a` and the
// lesson's frame view show.
//
// States follow Linux NUD (include/net/neighbour.h, verified in docs/apprenticeship/lab):
//   resolved by our own request            -> REACHABLE; after the reachable time it reads STALE
//   a request for us arrives from a sender -> STALE entry for the sender (RFC 826: the target records the sender)
//   we send using a STALE entry            -> DELAY; about 5 s later a unicast ARP request confirms it (REACHABLE)
//   our requests go unanswered             -> FAILED
// Simplifications: the reachable time is fixed at 30 s (Linux picks 15-45 s at random around base_reachable_time),
// DELAY always confirms after 5 s if the neighbour still answers ARP, and entries are never garbage-collected.
import { arpResolve } from './trace.js';

export const REACHABLE_TIME = 30;
export const DELAY_FIRST_PROBE = 5;
export const ARP_TRIES = 3; // net.ipv4.neigh.*.mcast_solicit: three broadcast requests, one per second, then FAILED

const key = (iface, ip) => `${iface}|${ip}`;

export function neighTable(d) { return (d.neigh ||= {}); }

export function neighEntry(d, iface, ip) { return d.neigh?.[key(iface, ip)] || null; }

/** The state an entry shows at time `now` (see the header for the rules). */
export function neighState(eng, d, e, now = eng.s.t) {
  if (!e) return null;
  if (e.state === 'FAILED') return 'FAILED';
  if (e.state === 'STALE') return 'STALE';
  if (e.state === 'DELAY') {
    if (now - e.t < DELAY_FIRST_PROBE) return 'DELAY';
    // the unicast probe: answered only if that MAC still owns the address on the segment
    const still = e.port ? arpResolve(eng, d.id, e.port, e.tag ?? null, e.ip) : null;
    const mac = still?.ep ? macOfEndpoint(eng, still.ep) : null;
    if (mac !== e.mac) return 'FAILED';
    return now - e.t - DELAY_FIRST_PROBE < REACHABLE_TIME ? 'REACHABLE' : 'STALE';
  }
  return now - e.t < REACHABLE_TIME ? 'REACHABLE' : 'STALE';
}

export function macOfEndpoint(eng, ep) {
  const d = eng.s.devices[ep.dev];
  return d?.ports?.[ep.port]?.mac ?? null;
}

/** Rows for display: [{ ip, iface, mac, state }] in insertion order (like the kernel's hash walk, roughly). */
export function neighbors(eng, d) {
  return Object.values(d.neigh || {}).map(e => ({ ip: e.ip, iface: e.iface, mac: e.state === 'FAILED' ? null : e.mac, state: neighState(eng, d, e) }));
}

export function flushNeigh(d, iface = null) {
  if (!d.neigh) return 0;
  let n = 0;
  for (const [k, e] of Object.entries(d.neigh)) if (!iface || e.iface === iface) { delete d.neigh[k]; n++; }
  return n;
}

/**
 * Before sending to next hop `nh` out of `egress` ({ name, port, tag, addr }): what the sender's table says.
 * Returns 'reachable' (send at once), 'stale' (send at once, entry goes DELAY) or 'resolve' (ARP needed).
 */
export function neighBefore(eng, d, egress, nh) {
  const e = neighEntry(d, egress.name, nh);
  const st = neighState(eng, d, e);
  if (!st || st === 'FAILED') return 'resolve';
  if (st === 'STALE') return 'stale';
  return 'reachable';
}

/**
 * Record the outcome of one next-hop delivery. `res` is arpResolve's result.
 * Returns the annotation the frame view uses: { dev, iface, nh, how, mac, target, learned }.
 */
export function neighRecord(eng, d, egress, nh, res) {
  const now = eng.s.t;
  const table = neighTable(d);
  const before = neighBefore(eng, d, egress, nh);
  const k = key(egress.name, nh);
  const srcMac = d.ports[egress.port]?.mac;
  if (!res.ep) {
    // echoes sent while the same resolution is still running wait for it (lab: one round of 3 requests covered
    // `ping -c 4`; the simulator runs a command's echoes at one instant, so "same instant" means "same round")
    if (table[k]?.state === 'FAILED' && table[k].t === now) return { dev: d.id, iface: egress.name, port: egress.port, nh, how: 'queued', srcMac, srcIp: egress.addr };
    table[k] = { ip: nh, iface: egress.name, port: egress.port, tag: egress.tag, mac: null, state: 'FAILED', t: now };
    return { dev: d.id, iface: egress.name, port: egress.port, nh, how: 'failed', srcMac, srcIp: egress.addr, tries: ARP_TRIES };
  }
  const mac = macOfEndpoint(eng, res.ep);
  const note = { dev: d.id, iface: egress.name, port: egress.port, nh, mac, srcMac, srcIp: egress.addr, target: res.ep.dev, proxy: !!res.proxy };
  if (before === 'reachable' && table[k].mac === mac) return { ...note, how: 'cached' };
  if (before === 'stale' && table[k].mac === mac) {
    table[k] = { ...table[k], state: 'DELAY', t: now };
    return { ...note, how: 'stale' };
  }
  table[k] = { ip: nh, iface: egress.name, port: egress.port, tag: egress.tag, mac, state: 'REACHABLE', t: now };
  // the target of a request records the sender (a proxy-ARP router answers for someone else and records too)
  const tgt = eng.s.devices[res.ep.dev];
  if (tgt && egress.addr !== null && egress.addr !== undefined) {
    const tt = neighTable(tgt);
    const tk = key(res.ep.l3if, egress.addr);
    const cur = tt[tk];
    if (!cur || cur.mac !== srcMac || neighState(eng, tgt, cur, now) === 'FAILED') {
      tt[tk] = { ip: egress.addr, iface: res.ep.l3if, port: res.ep.port, tag: res.ep.tag ?? null, mac: srcMac, state: 'STALE', t: now };
      note.learned = true;
    }
  }
  return { ...note, how: 'resolved' };
}
