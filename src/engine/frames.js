// Frames for the apprenticeship's frame view, derived from what the engine recorded for a command (probe results
// with their per-next-hop ARP annotations, see neighbor.js). Nothing here decides an outcome: it re-tells, frame by
// frame, the packet walk that produced the terminal output. Lines use tcpdump -n -e's format (tcpdump 4.99.4, as
// captured in docs/apprenticeship/lab/out/*.frames.txt), without timestamps.
import { fmtIp } from './ipv4.js';
import { macLinux } from './model.js';

const BCAST = 'ffffffffffff';

/** Links a frame crosses from (dev, port): to one target device, or flooded to all (broadcast). */
function linksFor(eng, dev, port, tag, target) {
  const fl = eng.flood(dev, port, tag);
  const set = new Set();
  const reached = [];
  for (const ep of fl.endpoints) {
    if (target && ep.dev !== target) continue;
    for (const h of ep.path) set.add(h.link);
    reached.push(ep.dev);
  }
  // a broadcast is also flooded out of switch ports that lead nowhere useful; drops still carried it that far
  if (!target) for (const d of fl.drops) for (const h of d.path || []) set.add(h.link);
  return { links: [...set], reached };
}

/** The port of `devId` that owns `mac` (a router answers from the interface the request arrived on). */
function portOf(eng, devId, mac) {
  const d = eng.s.devices[devId];
  return Object.values(d.ports).find(p => p.mac === mac)?.name ?? d.nic;
}

function switchesOn(eng, links) {
  const s = new Set();
  for (const id of links) {
    const l = eng.s.links[id];
    for (const end of [l.a, l.b]) if (eng.s.devices[end.dev]?.kind === 'switch') s.add(end.dev);
  }
  return [...s];
}

function arpLine(src, dst, op, a, b) {
  const head = `${macLinux(src)} > ${macLinux(dst)}, ethertype ARP (0x0806), length 42: `;
  return head + (op === 'request' ? `Request who-has ${fmtIp(a)} tell ${fmtIp(b)}, length 28` : `Reply ${fmtIp(a)} is-at ${macLinux(b)}, length 28`);
}

function ipLine(src, dst, pkt, id, seq) {
  const head = `${macLinux(src)} > ${macLinux(dst)}, ethertype IPv4 (0x0800), `;
  if (pkt.proto === 'icmp') {
    const what = { echo: 'echo request', 'echo-reply': 'echo reply' }[pkt.icmpType] || pkt.icmpType;
    const tail = pkt.icmpType === 'echo' || pkt.icmpType === 'echo-reply' ? `, id ${id}, seq ${seq}, length 64` : '';
    return `${head}length 98: ${fmtIp(pkt.src)} > ${fmtIp(pkt.dst)}: ICMP ${what}${tail}`;
  }
  return `${head}${fmtIp(pkt.src)}.${pkt.sport} > ${fmtIp(pkt.dst)}.${pkt.dport}: ${pkt.proto.toUpperCase()}`;
}

/** Frames for one direction of a probe (the request, or the reply). */
function legFrames(eng, leg, ctx) {
  const out = [];
  if (!leg) return out;
  for (const a of leg.arps || []) {
    const dev = eng.s.devices[a.dev];
    const tag = null;
    const seg = linksFor(eng, a.dev, a.port, tag, null);
    const segName = switchesOn(eng, seg.links)[0] || null;
    const common = { from: a.dev, port: a.port, seg: segName, nh: a.nh, srcIp: a.srcIp, srcMac: a.srcMac, dir: ctx.dir, seq: ctx.seq };
    if (a.how === 'queued') {
      out.push({ ...common, kind: 'arp-queued', note: true });
      continue;
    }
    if (a.how === 'resolved' || a.how === 'failed') {
      const tries = a.how === 'failed' ? a.tries : 1;
      for (let i = 0; i < tries; i++) {
        out.push({ ...common, kind: 'arp-request', bcast: true, dst: BCAST, links: seg.links, to: seg.reached.filter(x => x !== a.dev), try: i + 1, tries,
          line: arpLine(a.srcMac, BCAST, 'request', a.nh, a.srcIp) });
      }
      if (a.how === 'failed') {
        out.push({ ...common, kind: 'arp-failed', note: true, tries });
        continue;
      }
      const back = linksFor(eng, a.target, portOf(eng, a.target, a.mac), null, a.dev);
      out.push({ ...common, kind: 'arp-reply', from: a.target, to: [a.dev], dst: a.srcMac, replyMac: a.mac, links: back.links, learned: !!a.learned, proxy: a.proxy,
        line: arpLine(a.mac, a.srcMac, 'reply', a.nh, a.mac) });
    }
    const uni = linksFor(eng, a.dev, a.port, tag, a.target);
    out.push({ ...common, kind: 'ip', dst: a.mac, to: [a.target], links: uni.links, pkt: a.pkt, cached: a.how === 'cached' || a.how === 'stale',
      line: ipLine(a.srcMac, a.mac, a.pkt, ctx.id, ctx.seq), router: dev.kind === 'router' });
    if (a.how === 'stale') {
      // the confirmation ~5 s later: a unicast ARP request to the cached MAC (lab file 01b-cached.frames.txt)
      out.push({ ...common, kind: 'arp-request', bcast: false, dst: a.mac, to: [a.target], links: uni.links, delayed: true, line: arpLine(a.srcMac, a.mac, 'request', a.nh, a.srcIp) });
      const back = linksFor(eng, a.target, portOf(eng, a.target, a.mac), null, a.dev);
      out.push({ ...common, kind: 'arp-reply', from: a.target, to: [a.dev], dst: a.srcMac, replyMac: a.mac, links: back.links, delayed: true, line: arpLine(a.mac, a.srcMac, 'reply', a.nh, a.mac) });
    }
  }
  return out;
}

/**
 * Frames for the probes one command produced. probes: [{ req, r }] in order (r = engine probe result).
 * Returns [{ kind, line?, links, from, to, ... }] including 'note' entries for where and why a packet stopped.
 */
export function framesFor(eng, probes, icmpId = 2314) {
  const frames = [];
  probes.forEach(({ req, r }, i) => {
    const seq = i + 1;
    const fwd = r.fwd;
    if (!fwd) return;
    if (r.status === 'local-error' && !(fwd.arps || []).length) {
      frames.push({ kind: 'not-sent', note: true, from: req.from, reason: fwd.reason, seq, dir: 'request' });
      return;
    }
    frames.push(...legFrames(eng, fwd, { dir: 'request', seq, id: icmpId }));
    if (fwd.outcome === 'dropped') frames.push({ kind: 'dropped', note: true, at: fwd.at, reason: fwd.reason, seq, dir: 'request' });
    if (fwd.outcome === 'delivered' && fwd.at !== req.from) frames.push({ kind: 'delivered', note: true, at: fwd.at, seq, dir: 'request', ttl: fwd.ttl });
    const rep = r.rep;
    if (rep) {
      if (rep.outcome === 'local-error' && !(rep.arps || []).length) frames.push({ kind: 'reply-not-sent', note: true, from: fwd.at, reason: rep.reason, seq, dir: 'reply' });
      else frames.push(...legFrames(eng, rep, { dir: 'reply', seq, id: icmpId }));
      if (rep.outcome === 'dropped') frames.push({ kind: 'dropped', note: true, at: rep.at, reason: rep.reason, seq, dir: 'reply' });
      if (rep.outcome === 'delivered' && rep.at === req.from) frames.push({ kind: 'reply-home', note: true, at: rep.at, seq, dir: 'reply', ttl: rep.ttl });
    }
  });
  // unicast confirmations of DELAY entries happen about 5 s later, after the command's other frames
  return [...frames.filter(f => !f.delayed), ...frames.filter(f => f.delayed)];
}
