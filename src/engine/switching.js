// Layer 2: VLAN membership, 802.1Q tagging, per-VLAN spanning tree, frame flooding and loop detection.
//
// Spanning tree model (PVST+ / Rapid PVST+, simplified but role-correct):
//  - Root bridge per VLAN = lowest (priority + VLAN sys-id-ext, MAC).
//  - Root port = lowest (root path cost, designated bridge ID, designated port ID, own port ID).
//  - Designated port per segment = lowest (root path cost of bridge, bridge ID, port ID).
//  - Everything else is alternate/backup and discards.
//  - A switch with STP disabled for a VLAN, and any unmanaged bridge, is transparent: it forwards on every
//    port and floods BPDUs, so it behaves like a shared segment between STP speakers.
//  - 802.1D timers: blocking -> listening (15 s) -> learning (15 s) -> forwarding.
//  - Rapid PVST+ (802.1w per VLAN): edge (PortFast) ports forward immediately; a new root port forwards in ~1 s
//    (a local decision); a designated port forwards in ~1 s only through proposal/agreement, i.e. on a
//    point-to-point (full-duplex) link to another Rapid PVST+ switch. Toward a router, a host without PortFast,
//    a legacy PVST+ switch or a shared (half-duplex) link it falls back to discarding (15 s) -> learning (15 s).
//    The timed discarding phase reuses the 'listening' state record; show spanning-tree prints it as BLK.
//  - PVID check (PVST+ and Rapid PVST+): SSTP BPDUs carry the sending VLAN. A native VLAN mismatch on a switch-to-switch
//    trunk makes the receiving switch put the port in PVID-inconsistent state ("broken", BKN*) for its own native VLAN
//    and the peer's, so untagged frames do not leak between the two VLANs. A switch with STP disabled for the VLAN sends
//    no BPDU and checks nothing: then the leak is real.

export const FORWARD_DELAY = 15;
export const RAPID_DELAY = 1;

export function stpDisabled(sw, vlan) {
  return (sw.stp.disabled || []).some(([a, b]) => vlan >= a && vlan <= b);
}

export function knowsVlan(sw, v) {
  return sw.vlans[v] !== undefined;
}

export function trunkAllows(port, v) {
  return port.allowed === 'all' || port.allowed.includes(v);
}

/** VLANs a switch port carries (as configured; link state not considered). */
export function portVlans(sw, port) {
  if (port.mode === 'access') return knowsVlan(sw, port.accessVlan) ? [port.accessVlan] : [];
  return Object.keys(sw.vlans).map(Number).filter(v => trunkAllows(port, v));
}

export function carries(sw, port, v) {
  if (!knowsVlan(sw, v)) return false;
  if (port.mode === 'access') return port.accessVlan === v;
  return trunkAllows(port, v);
}

export function egressTag(port, v) {
  if (port.mode === 'access') return null;
  return v === port.native ? null : v;
}

/** VLAN a frame is classified into on ingress, or {drop: reason}. */
export function ingressVlan(sw, port, tag) {
  if (port.mode === 'access') {
    if (tag !== null && tag !== port.accessVlan) return { drop: 'tagged frame on access port' };
    if (!knowsVlan(sw, port.accessVlan)) return { drop: `VLAN ${port.accessVlan} not in VLAN database (port inactive)` };
    return { vlan: port.accessVlan };
  }
  const v = tag === null ? port.native : tag;
  if (!trunkAllows(port, v)) return { drop: `VLAN ${v} not allowed on trunk` };
  if (!knowsVlan(sw, v)) return { drop: `VLAN ${v} not in VLAN database` };
  return { vlan: v };
}

/** Whether two switch ports exchange VLAN v frames consistently (same VLAN on both ends). */
export function consistentCarriage(swA, pA, swB, pB, v) {
  if (!carries(swA, pA, v) || !carries(swB, pB, v)) return false;
  return (egressTag(pA, v) === null) === (egressTag(pB, v) === null);
}

export function bridgePriority(sw, v) {
  return (sw.stp.priority?.[v] ?? 32768) + v;
}

/** Bridge ID as a comparable tuple [priority + sys-id-ext, MAC]. */
function bid(sw, v) {
  return [bridgePriority(sw, v), parseInt(sw.mac, 16)];
}

function cmpTuple(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function portIdOf(sw, portName) {
  const idx = Object.keys(sw.ports).indexOf(portName) + 1;
  return 128 * 1000 + idx;
}

export function portCost(speed) {
  if (speed === 10) return 100;
  if (speed === 100) return 19;
  if (speed === 1000) return 4;
  if (speed === 10000) return 2;
  return 19;
}

/**
 * Ports in PVID-inconsistent state. Map("dev|port" -> { local, peer, vlans: [blocked VLAN ids] }).
 * The neighbour sends its native-VLAN SSTP BPDU untagged with PVID = its native VLAN (if it runs STP there); this
 * switch classifies the frame into its own native VLAN, and its STP instance there sees the wrong PVID.
 */
export function pvidInconsistencies(eng) {
  const st = eng.s;
  const out = new Map();
  for (const l of Object.values(st.links)) {
    if (!eng.linkStatus(l.id).up) continue;
    const da = st.devices[l.a.dev];
    const db = st.devices[l.b.dev];
    if (da.kind !== 'switch' || db.kind !== 'switch') continue;
    const pa = da.ports[l.a.port];
    const pb = db.ports[l.b.port];
    if (pa.mode !== 'trunk' || pb.mode !== 'trunk' || pa.native === pb.native) continue;
    for (const [x, px, y, py] of [[da, pa, db, pb], [db, pb, da, pa]]) {
      const nX = px.native;
      const nY = py.native;
      if (!carries(y, py, nY) || stpDisabled(y, nY)) continue; // no untagged BPDU from the peer
      if (!carries(x, px, nX) || stpDisabled(x, nX)) continue; // nothing here checks the PVID
      const vlans = [nX];
      if (carries(x, px, nY) && !stpDisabled(x, nY)) vlans.push(nY);
      out.set(`${x.id}|${px.name}`, { local: nX, peer: nY, vlans });
    }
  }
  return out;
}

/**
 * Compute target STP roles for one VLAN. Returns Map("dev|port" -> { role, edge, rootId }).
 * Roles: root | designated | alternate | backup | nostp. inc: 'PVID' marks a PVID-inconsistent (broken) port.
 */
export function computeStpRoles(eng, v, pvid = pvidInconsistencies(eng)) {
  const st = eng.s;
  const roles = new Map();
  const isTransparent = d => d.kind === 'bridge' || (d.kind === 'switch' && knowsVlan(d, v) && stpDisabled(d, v));
  const isSpeaker = d => d.kind === 'switch' && knowsVlan(d, v) && !stpDisabled(d, v);

  // Union-find over transparent nodes.
  const parent = {};
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (const d of Object.values(st.devices)) if (isTransparent(d)) parent[d.id] = d.id;

  const upLinks = Object.values(st.links).filter(l => eng.linkStatus(l.id).up);
  const carriesHere = (d, p) => (d.kind === 'bridge' ? true : carries(d, p, v));
  for (const l of upLinks) {
    const da = st.devices[l.a.dev];
    const db = st.devices[l.b.dev];
    if (isTransparent(da) && isTransparent(db)) {
      const pa = da.ports[l.a.port];
      const pb = db.ports[l.b.port];
      if (carriesHere(da, pa) && carriesHere(db, pb)) union(da.id, db.id);
    }
  }

  // Segments: arrays of attachments {dev, port, cost}.
  const segments = [];
  const compSeg = {};
  const broken = [];
  for (const l of upLinks) {
    for (const [me, other] of [[l.a, l.b], [l.b, l.a]]) {
      const d = st.devices[me.dev];
      if (!isSpeaker(d)) continue;
      const p = d.ports[me.port];
      if (!carries(d, p, v)) continue;
      const inc = pvid.get(`${d.id}|${me.port}`);
      if (inc && inc.vlans.includes(v)) { broken.push({ dev: d.id, port: me.port, inc }); continue; }
      const od = st.devices[other.dev];
      const op = od.ports[other.port];
      const ls = eng.linkStatus(l.id);
      const cost = portCost(ls.speed);
      const att = { dev: d.id, port: me.port, cost, edgeCfg: p.portfast, p2p: ls.duplexA === 'full' && ls.duplexB === 'full' };
      if (isSpeaker(od)) {
        if (!consistentCarriage(d, p, od, op, v)) { segments.push({ atts: [att], edge: true }); continue; }
        // two-speaker segment keyed by link id; add once per side
        let seg = segments.find(s => s.link === l.id);
        if (!seg) { seg = { link: l.id, atts: [] }; segments.push(seg); }
        seg.atts.push(att);
      } else if (isTransparent(od) && carriesHere(od, op)) {
        const root = find(od.id);
        if (!compSeg[root]) { compSeg[root] = { comp: root, atts: [] }; segments.push(compSeg[root]); }
        compSeg[root].atts.push(att);
      } else {
        segments.push({ atts: [att], edge: true });
      }
    }
  }

  // Components of speakers connected through segments.
  const speakers = Object.values(st.devices).filter(isSpeaker);
  const adj = new Map(speakers.map(s => [s.id, new Set()]));
  for (const seg of segments) for (const a of seg.atts) for (const b of seg.atts) if (a.dev !== b.dev) adj.get(a.dev).add(b.dev);
  const seen = new Set();
  const dist = {};
  const rootOf = {};
  for (const s of speakers) {
    if (seen.has(s.id)) continue;
    const comp = [];
    const q = [s.id];
    seen.add(s.id);
    while (q.length) {
      const x = q.shift();
      comp.push(x);
      for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); q.push(y); }
    }
    let root = comp[0];
    for (const id of comp) if (cmpTuple(bid(st.devices[id], v), bid(st.devices[root], v)) < 0) root = id;
    for (const id of comp) rootOf[id] = root;
    dist[root] = 0;
  }
  // Bellman-Ford relaxation of root path cost.
  for (let iter = 0; iter < speakers.length + 1; iter++) {
    let changed = false;
    for (const seg of segments) {
      for (const a of seg.atts) {
        if (dist[a.dev] === undefined) continue;
        for (const b of seg.atts) {
          if (b.dev === a.dev) continue;
          const cand = dist[a.dev] + b.cost;
          if (dist[b.dev] === undefined || cand < dist[b.dev]) { dist[b.dev] = cand; changed = true; }
        }
      }
    }
    if (!changed) break;
  }

  const cmp = cmpTuple;
  // Root ports.
  const rootPort = {};
  for (const s of speakers) {
    if (rootOf[s.id] === s.id) continue;
    let best = null;
    for (const seg of segments) {
      for (const mine of seg.atts.filter(a => a.dev === s.id)) {
        for (const other of seg.atts) {
          if (other.dev === s.id || dist[other.dev] === undefined) continue;
          const t = [dist[other.dev] + mine.cost, ...bid(st.devices[other.dev], v), portIdOf(st.devices[other.dev], other.port), portIdOf(s, mine.port)];
          if (!best || cmp(t, best.t) < 0) best = { t, port: mine.port };
        }
      }
    }
    if (best) rootPort[s.id] = best.port;
  }
  // Designated ports per segment.
  for (const seg of segments) {
    let des = null;
    for (const a of seg.atts) {
      const t = [dist[a.dev] ?? 1e9, ...bid(st.devices[a.dev], v), portIdOf(st.devices[a.dev], a.port)];
      if (!des || cmp(t, des.t) < 0) des = { t, att: a };
    }
    for (const a of seg.atts) {
      const key = `${a.dev}|${a.port}`;
      let role;
      if (rootPort[a.dev] === a.port) role = 'root';
      else if (des.att === a) role = 'designated';
      else role = des.att.dev === a.dev ? 'backup' : 'alternate';
      // STP mode of the neighbour on a two-switch link ('rapid-pvst' | 'pvst'); null for shared/edge segments.
      const peer = seg.link && seg.atts.length === 2 ? st.devices[seg.atts.find(x => x !== a).dev].stp.mode : null;
      roles.set(key, { role, edge: !!(seg.edge || seg.atts.length === 1) && a.edgeCfg, rootId: rootOf[a.dev], cost: dist[a.dev] ?? 0, p2p: a.p2p && !seg.comp, peer });
    }
  }
  // PVID-inconsistent ports take no part in the topology: blocked ("broken") for this VLAN.
  for (const b of broken) {
    const l = eng.linkAt(b.dev, b.port);
    const ls = l ? eng.linkStatus(l.id) : null;
    roles.set(`${b.dev}|${b.port}`, { role: 'designated', edge: false, inc: 'PVID', rootId: rootOf[b.dev], cost: dist[b.dev] ?? 0, p2p: !!ls && ls.duplexA === 'full' && ls.duplexB === 'full', peer: null });
  }
  // Transparent switches forward on every carrying port.
  for (const d of Object.values(st.devices)) {
    if (d.kind !== 'switch' || !knowsVlan(d, v) || !stpDisabled(d, v)) continue;
    for (const p of Object.values(d.ports)) if (carries(d, p, v)) roles.set(`${d.id}|${p.name}`, { role: 'nostp', edge: false });
  }
  return { roles, rootOf, dist };
}

/** All VLAN ids that exist on any switch. */
export function allVlans(st) {
  const s = new Set();
  for (const d of Object.values(st.devices)) if (d.kind === 'switch') for (const v of Object.keys(d.vlans)) s.add(Number(v));
  return [...s].sort((a, b) => a - b);
}

/**
 * Reconcile actual port states with target roles. converge=true settles instantly (scenario setup).
 * Returns true if any state changed.
 */
export function applyStp(eng, converge = false) {
  const st = eng.s;
  st.stpState = st.stpState || {};
  const now = st.t;
  let changed = false;
  const live = new Set();
  const info = {};
  const pvid = pvidInconsistencies(eng);
  eng.pvid = pvid;
  for (const v of allVlans(st)) {
    const { roles, rootOf, dist } = computeStpRoles(eng, v, pvid);
    info[v] = { rootOf, dist };
    for (const [key, r] of roles) {
      const [devId, port] = key.split('|');
      const sw = st.devices[devId];
      const rapid = sw.stp.mode === 'rapid-pvst';
      live.add(`${devId}|${v}|${port}`);
      st.stpState[devId] = st.stpState[devId] || {};
      const byV = (st.stpState[devId][v] = st.stpState[devId][v] || {});
      // A port joining a freshly enabled STP instance starts from blocking (802.1D initialisation).
      const cur = byV[port] && byV[port].role === 'nostp' && r.role !== 'nostp' ? null : byV[port];
      const wantFwd = r.role === 'root' || r.role === 'designated' || r.role === 'nostp';
      let next = cur ? { ...cur } : null;
      if (r.inc) {
        next = cur && cur.inc ? { ...cur } : { st: 'blocking', since: now };
        next.inc = r.inc;
      } else if (cur && cur.inc) {
        // Consistency restored: the port starts over from blocking like any port joining the topology.
        next = converge ? { st: wantFwd ? 'forwarding' : 'blocking', since: now } : null;
        if (!next) {
          const fast = rapid && (r.role === 'root' || (r.p2p && r.peer === 'rapid-pvst'));
          next = r.edge ? { st: 'forwarding', since: now } : !wantFwd ? { st: 'blocking', since: now } : fast ? { st: 'learning', since: now, rapid: true } : { st: 'listening', since: now };
        }
      } else if (converge || r.role === 'nostp') {
        next = { st: wantFwd ? 'forwarding' : 'blocking', since: now };
      } else if (!wantFwd) {
        if (!cur || cur.st !== 'blocking') next = { st: 'blocking', since: now };
      } else {
        const fast = rapid && (r.role === 'root' || (r.p2p && r.peer === 'rapid-pvst'));
        if (!cur || cur.st === 'blocking') {
          if (r.edge) next = { st: 'forwarding', since: now };
          else if (fast) next = { st: 'learning', since: now, rapid: true };
          else next = { st: 'listening', since: now }; // on a Rapid PVST+ switch this is RSTP "discarding" (shown BLK)
        } else if (fast && (cur.st === 'listening' || (cur.st === 'learning' && !cur.rapid))) {
          // An RSTP neighbour appeared (or the port became root): the handshake cuts the timer short.
          next = { st: 'learning', since: now, rapid: true };
        }
      }
      next.role = r.role;
      next.edge = r.edge;
      next.p2p = r.p2p ?? true;
      next.peer = r.peer ?? null;
      if (!r.inc) delete next.inc;
      if (!cur || cur.st !== next.st || cur.role !== next.role || !!cur.inc !== !!next.inc) changed = true;
      byV[port] = next;
    }
  }
  // Remove records for ports that no longer participate (link down / VLAN removed).
  for (const devId of Object.keys(st.stpState)) {
    for (const v of Object.keys(st.stpState[devId])) {
      for (const port of Object.keys(st.stpState[devId][v])) {
        if (!live.has(`${devId}|${v}|${port}`)) { delete st.stpState[devId][v][port]; changed = true; }
      }
    }
  }
  eng.stpInfo = info;
  return changed;
}

/** Advance STP timers. Returns true if any port changed state. */
export function tickStp(eng) {
  const st = eng.s;
  let changed = false;
  for (const devId of Object.keys(st.stpState || {})) {
    for (const v of Object.keys(st.stpState[devId])) {
      for (const rec of Object.values(st.stpState[devId][v])) {
        if (rec.st === 'listening' && st.t >= rec.since + FORWARD_DELAY) { rec.st = 'learning'; rec.since += FORWARD_DELAY; changed = true; }
        const d = rec.rapid ? RAPID_DELAY : FORWARD_DELAY;
        if (rec.st === 'learning' && st.t >= rec.since + d) { rec.st = 'forwarding'; rec.since += d; changed = true; }
      }
    }
  }
  return changed;
}

export function stpForwarding(eng, sw, portName, v) {
  if (sw.kind !== 'switch') return true;
  if (stpDisabled(sw, v)) return true;
  const rec = eng.s.stpState?.[sw.id]?.[v]?.[portName];
  return !!rec && rec.st === 'forwarding';
}

export function stpRecord(eng, swId, v, portName) {
  return eng.s.stpState?.[swId]?.[v]?.[portName] || null;
}

/** Whether a switch/bridge port currently forwards VLAN v (for loop detection). */
function forwardsVlan(eng, d, p, v) {
  if (d.kind === 'bridge') return true;
  return carries(d, p, v) && stpForwarding(eng, d, p.name, v);
}

/** Detect forwarding loops per VLAN. Returns Map(vlan -> Set(linkIds in the looping component)). */
export function detectStorms(eng) {
  const st = eng.s;
  const storms = new Map();
  const l2 = d => d.kind === 'switch' || d.kind === 'bridge';
  for (const v of allVlans(st)) {
    const parent = {};
    const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const edges = [];
    let cycleRoots = new Set();
    for (const l of Object.values(st.links)) {
      if (!eng.linkStatus(l.id).up) continue;
      const da = st.devices[l.a.dev];
      const db = st.devices[l.b.dev];
      if (!l2(da) || !l2(db)) continue;
      const pa = da.ports[l.a.port];
      const pb = db.ports[l.b.port];
      if (da.kind === 'switch' && db.kind === 'switch' && !consistentCarriage(da, pa, db, pb, v)) continue;
      if (da.kind === 'switch' && !knowsVlan(da, v)) continue;
      if (db.kind === 'switch' && !knowsVlan(db, v)) continue;
      if (!forwardsVlan(eng, da, pa, v) || !forwardsVlan(eng, db, pb, v)) continue;
      for (const id of [da.id, db.id]) if (parent[id] === undefined) parent[id] = id;
      const ra = find(da.id);
      const rb = find(db.id);
      if (ra === rb) cycleRoots.add(ra);
      else parent[ra] = rb;
      edges.push(l);
    }
    if (!cycleRoots.size) continue;
    cycleRoots = new Set([...cycleRoots].map(find));
    const linkSet = new Set();
    for (const l of edges) if (cycleRoots.has(find(l.a.dev))) linkSet.add(l.id);
    // Every link carrying v inside the looping domain is saturated, including access ports to hosts.
    const domainDevs = new Set();
    for (const l of edges) if (cycleRoots.has(find(l.a.dev))) { domainDevs.add(l.a.dev); domainDevs.add(l.b.dev); }
    for (const l of Object.values(st.links)) {
      if (!eng.linkStatus(l.id).up) continue;
      for (const [me] of [[l.a], [l.b]]) {
        const d = st.devices[me.dev];
        if (!domainDevs.has(d.id) || d.kind !== 'switch') continue;
        if (carries(d, d.ports[me.port], v)) linkSet.add(l.id);
      }
    }
    storms.set(v, linkSet);
  }
  return storms;
}

/**
 * Flood a frame out of (devId, portName) with an 802.1Q tag (null = untagged).
 * Returns { endpoints: [{dev, port, tag, l3if, path}], drops: [{dev, port, reason}] }.
 * opts.serverMsg marks DHCP server->client messages (subject to DHCP snooping).
 */
export function flood(eng, devId, portName, tag, opts = {}) {
  const st = eng.s;
  const endpoints = [];
  const drops = [];
  const visited = new Set();
  const queue = [];
  const send = (dev, port, t, path, vlan) => {
    const l = eng.linkAt(dev, port);
    if (!l || !eng.linkStatus(l.id).up) return;
    const peer = l.a.dev === dev && l.a.port === port ? l.b : l.a;
    const hop = { link: l.id, from: { dev, port }, to: { dev: peer.dev, port: peer.port }, tag: t, vlan };
    queue.push({ dev: peer.dev, port: peer.port, tag: t, path: [...path, hop] });
  };
  send(devId, portName, tag, []);
  while (queue.length) {
    const cur = queue.shift();
    const key = `${cur.dev}|${cur.port}|${cur.tag}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const d = st.devices[cur.dev];
    const p = d.ports[cur.port];
    if (d.kind === 'switch') {
      const iv = ingressVlan(d, p, cur.tag);
      if (iv.drop) { drops.push({ dev: d.id, port: p.name, reason: iv.drop }); continue; }
      const v = iv.vlan;
      const last = cur.path[cur.path.length - 1];
      if (last && last.vlan === undefined) last.vlan = v;
      if (!stpForwarding(eng, d, p.name, v)) {
        const rec = stpRecord(eng, d.id, v, p.name);
        drops.push({ dev: d.id, port: p.name, reason: rec?.inc ? `STP broken (${rec.inc} inconsistent) on VLAN ${v}` : `STP ${rec ? rec.st : 'blocking'} on VLAN ${v}`, stp: true });
        continue;
      }
      if (opts.serverMsg && d.snoop.enabled && d.snoop.vlans.includes(v) && !p.snoopTrust) {
        drops.push({ dev: d.id, port: p.name, reason: `DHCP snooping: server message on untrusted port (VLAN ${v})`, snoop: true });
        continue;
      }
      for (const q of Object.values(d.ports)) {
        if (q.name === p.name || !carries(d, q, v) || !stpForwarding(eng, d, q.name, v)) continue;
        send(d.id, q.name, egressTag(q, v), cur.path, v);
      }
    } else if (d.kind === 'bridge') {
      for (const q of Object.values(d.ports)) if (q.name !== p.name) send(d.id, q.name, cur.tag, cur.path);
    } else if (d.kind === 'router') {
      let l3if = null;
      if (cur.tag === null) {
        // ---- ipv6: a routed port with only IPv6 configured also terminates untagged frames
        if (p.ip || p.ipv6?.enable || p.ipv6?.addrs?.length || p.ipv6?.ll) l3if = p.name;
        else {
          const nat = Object.values(d.subifs).find(s => s.parent === p.name && s.native);
          if (nat) l3if = nat.name;
        }
      } else {
        const sub = Object.values(d.subifs).find(s => s.parent === p.name && s.vlan === cur.tag);
        if (sub) l3if = sub.name;
      }
      if (l3if) endpoints.push({ dev: d.id, port: p.name, tag: cur.tag, l3if, path: cur.path });
      else drops.push({ dev: d.id, port: p.name, reason: cur.tag === null ? 'router port has no IP for untagged frames' : `no subinterface for VLAN ${cur.tag}` });
    } else {
      if (cur.tag === null) endpoints.push({ dev: d.id, port: p.name, tag: null, l3if: p.name, path: cur.path });
      else drops.push({ dev: d.id, port: p.name, reason: 'host NIC ignores 802.1Q-tagged frame' });
    }
  }
  return { endpoints, drops };
}
