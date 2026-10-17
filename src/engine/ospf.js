// OSPFv2 (RFC 2328) for the IOS routers: one process per router, area 0 plus non-backbone areas.
//
// What is modelled (each against the RFC clause noted at the code):
//  - Interfaces join the process through `network <addr> <wildcard> area <id>` (most specific statement wins, as
//    current IOS does) or `ip ospf <pid> area <id>` on the interface (takes precedence). Passive interfaces are
//    advertised but send and process no hellos.
//  - Hello protocol (10.5): area, mask (broadcast only), hello and dead intervals must match; a duplicate router ID
//    is logged and ignored. Hellos are multicast on the segment, so they cross L2 (bridges, VLANs) and are subject to
//    the receiving interface's inbound ACL (IP protocol 89). Locally generated hellos skip outbound ACLs (IOS).
//  - Neighbour state machine (10.3): DOWN -> INIT -> 2WAY -> EXSTART -> EXCHANGE -> LOADING -> FULL, one second per
//    database-exchange stage. Dead timer per neighbour; 1-Way hellos drop a neighbour back to INIT.
//  - Interface state machine (9.3): WAITING for the wait timer (= dead interval) on broadcast networks, then the
//    DR/BDR election (9.4: priority, then router ID; non-preemptive; priority 0 never elected). Adjacencies form only
//    with the DR and BDR (10.4); DROTHERs stay 2WAY with each other. point-to-point skips the election.
//  - MTU check on database description packets (10.6): the lower-MTU side rejects the neighbour's DBDs and stays in
//    EXSTART, the other side in EXCHANGE; `ip ospf mtu-ignore` disables the check.
//  - LSDB per router and area, filled by flooding over adjacencies (13): router LSAs (12.4.1), network LSAs from the
//    DR (12.4.2), summary LSAs (type 3) and ASBR summaries (type 4) from ABRs (12.4.3), AS-external type 5 for
//    `default-information originate`. A router keeps the copy it last received: when a neighbour silently disappears,
//    its old LSAs stay usable until this router's dead timer for it expires.
//  - SPF per area (16.1) with the two-way check, inter-area routes (16.2), external routes (16.4), IOS SPF throttle
//    (first run 5 s after a change, at least 10 s between runs).
// Simplifications are listed in docs/topics/ospf.md (no authentication, no NSSA/stub areas, no area ranges,
// no virtual links, no ECMP, no MinLSInterval, simplified LSA checksums).
import { l3Ifaces, evalAcl } from './routing.js';
import { fmtIp, networkOf, prefixToMask, inSubnet, wildcardMatch } from './ipv4.js';
import { longIf } from './model.js';

export const OSPF_AD = 110;
export const DEF_HELLO = 10;
export const DEF_DEAD = 40;
export const SPF_START = 5;
export const SPF_HOLD = 10;
const LS_REFRESH = 1800;
const MAX_AGE = 3600;
const STAGE = 1; // seconds per database-exchange stage
const DBD_GIVEUP = 125; // 25 retransmissions x 5 s (Cisco: limit 25 since 12.2(9))
const TOMBSTONE = 60;
const ALL_SPF = 0xe0000005; // 224.0.0.5
const ORDER = ['DOWN', 'INIT', '2WAY', 'EXSTART', 'EXCHANGE', 'LOADING', 'FULL'];
const rank = s => ORDER.indexOf(s);

// ------------------------------------------------------------------ configuration view

const bitCount = n => { let c = 0; for (let x = n >>> 0; x; x >>>= 1) c += x & 1; return c; };

/** Most specific matching network statement (fewest wildcard bits), as current IOS evaluates them. */
export function matchNetwork(o, addr) {
  let best = null;
  for (const n of o.nets || []) {
    if (!wildcardMatch(addr, n.addr, n.wild)) continue;
    if (!best || bitCount(n.wild) < bitCount(best.wild)) best = n;
  }
  return best;
}

export function isPassive(o, name) {
  return o.passiveDefault ? !(o.active || []).includes(name) : (o.passive || []).includes(name);
}

/** IOS default bandwidth (kbit/s) by interface type; `bandwidth` overrides it. */
export function ifBandwidth(cfg, name) {
  if (cfg?.bw) return cfg.bw;
  if (/^Te/.test(name)) return 10000000;
  if (/^Fa/.test(name)) return 100000;
  return 1000000;
}

/** Interface cost: `ip ospf cost`, else reference bandwidth / interface bandwidth, truncated, at least 1. */
export function ifCost(d, cfg, name) {
  if (cfg?.ospf?.cost) return cfg.ospf.cost;
  const ref = (d.ospf?.refBw ?? 100) * 1000;
  return Math.max(1, Math.min(65535, Math.floor(ref / ifBandwidth(cfg, name))));
}

/** OSPF view of a router's L3 interfaces (configuration plus link state), cached until the engine's next change. */
export function ospfIfaces(eng, d) {
  const o = d.ospf;
  if (!o || d.kind !== 'router') return [];
  const c = (eng.cache.ospfIfs ||= new Map());
  if (!c.has(d.id)) c.set(d.id, computeIfaces(eng, d, o));
  return c.get(d.id);
}

function computeIfaces(eng, d, o) {
  const out = [];
  for (const i of l3Ifaces(eng, d)) {
    const c = i.cfg.ospf || {};
    let area = null;
    let areaText = null;
    let via = null;
    if (c.area && c.area.pid === o.pid) { area = c.area.area; areaText = c.area.text; via = 'interface'; }
    else {
      const n = matchNetwork(o, i.addr);
      if (n) { area = n.area; areaText = n.text; via = 'network'; }
    }
    if (area === null) continue;
    const hello = c.hello ?? DEF_HELLO;
    out.push({
      name: i.name, port: i.port, tag: i.tag, addr: i.addr, len: i.len, up: i.up, cfg: i.cfg, area, areaText, via,
      type: c.net === 'point-to-point' ? 'point-to-point' : 'broadcast',
      hello, dead: c.dead ?? (c.hello ? 4 * c.hello : DEF_DEAD), pri: c.pri ?? 1,
      cost: ifCost(d, i.cfg, i.name), mtu: i.cfg.mtu ?? 1500, mtuIgnore: !!c.mtuIgnore, passive: isPassive(o, i.name),
    });
  }
  return out;
}

export function areaLabel(area, text) {
  return text ?? String(area);
}

/** Configuration object of a fresh `router ospf <pid>` (stored on the device as d.ospf). */
export function newOspfProcess(pid) {
  return { pid, rid: null, nets: [], passiveDefault: false, passive: [], active: [], refBw: 100, defInfo: null, logDetail: false };
}

/** IOS keeps network statements ordered from most to least specific. */
export function sortNetworks(nets) {
  return nets.sort((a, b) => bitCount(a.wild) - bitCount(b.wild) || a.addr - b.addr);
}

// ------------------------------------------------------------------ runtime state (plain JSON in eng.s.ospf)

export function rtOf(eng, d) {
  return eng.s.ospf?.[d.id] || null;
}

function routers(eng) {
  const s = eng.s;
  return Object.values(s.devices).filter(d => d.kind === 'router' && (d.ospf || s.ospf?.[d.id]));
}

function anyOspf(eng) {
  const s = eng.s;
  if (s.ospf && Object.keys(s.ospf).length) return true;
  for (const d of Object.values(s.devices)) if (d.ospf) return true;
  return false;
}

function pickRid(eng, d) {
  if (d.ospf.rid !== null && d.ospf.rid !== undefined) return d.ospf.rid;
  const ups = l3Ifaces(eng, d).filter(i => i.up).map(i => i.addr);
  return ups.length ? Math.max(...ups) : null;
}

function log(eng, d, silent, code, msg) { if (!silent) eng.syslog(d, code, msg); }

function adjLog(eng, d, rt, n, ifName, from, to, why, silent) {
  if (silent || d.ospf?.logOff) return;
  const detail = !!d.ospf?.logDetail;
  if (!detail && to !== 'FULL' && to !== 'DOWN') return;
  eng.syslog(d, '%OSPF-5-ADJCHG', `Process ${rt.pid}, Nbr ${fmtIp(n.rid)} on ${longIf(ifName)} from ${from} to ${to}, ${why}`);
}

function setNbr(eng, d, rt, ifName, n, to, why, silent) {
  const from = n.state;
  if (from === to) return;
  n.state = to;
  n.since = eng.s.t;
  adjLog(eng, d, rt, n, ifName, from, to, why, silent);
}

function startProcess(eng, d, silent) {
  const s = eng.s;
  s.ospf ||= {};
  const rid = pickRid(eng, d);
  if (rid === null) {
    if (!s.ospf[d.id]?.noRid) log(eng, d, silent, '%OSPF-4-NORTRID', `OSPF process ${d.ospf.pid} failed to allocate unique router-id and cannot start`);
    s.ospf[d.id] = { pid: d.ospf.pid, rid: null, noRid: true, ifs: {}, lsdb: {}, ext: {}, rib: [], spf: { due: null, last: null, runs: 0 }, started: s.t };
    return s.ospf[d.id];
  }
  // A (re)started process begins with an empty database and re-learns it from its neighbours; LSAs it advertised
  // under an earlier router ID stay in other routers' databases until they age out (as on IOS).
  s.ospf[d.id] = { pid: d.ospf.pid, rid, started: s.t, ifs: {}, lsdb: {}, ext: {}, rib: [], spf: { due: null, last: null, runs: 0 }, warn: {} };
  return s.ospf[d.id];
}

function dropNeighbors(eng, d, rt, ifName, st, why, silent) {
  for (const [k, n] of Object.entries(st.nbrs)) {
    setNbr(eng, d, rt, ifName, n, 'DOWN', `Neighbor Down: ${why}`, silent);
    delete st.nbrs[k];
  }
}

const ifSig = I => `${I.area}|${I.addr}/${I.len}|${I.type}|${I.passive ? 1 : 0}|${I.up ? 1 : 0}`;

/**
 * Bring the runtime in line with configuration and link state. Called after every mutation and from the tick.
 * Interfaces that go down, leave the process, change area/address/network type or become passive lose their
 * neighbours at once ("Interface down or detached"); the far end only notices when its dead timer expires.
 */
export function ospfReconcile(eng, silent = false) {
  if (!anyOspf(eng)) return false;
  const s = eng.s;
  s.ospf ||= {};
  let changed = false;
  for (const d of routers(eng)) {
    let rt = s.ospf[d.id];
    if (!d.ospf) {
      // `no router ospf`: neighbours go down, our LSAs stay in other routers' databases until they age out.
      if (rt) {
        for (const [name, st] of Object.entries(rt.ifs)) dropNeighbors(eng, d, rt, name, st, 'Interface down or detached', silent);
        delete s.ospf[d.id];
        changed = true;
      }
      continue;
    }
    if (!rt || rt.pid !== d.ospf.pid || (rt.noRid && pickRid(eng, d) !== null)) {
      if (rt) for (const [name, st] of Object.entries(rt.ifs)) dropNeighbors(eng, d, rt, name, st, 'Interface down or detached', silent);
      rt = startProcess(eng, d, silent);
      changed = true;
    }
    if (rt.rid === null) continue;
    // A configured router-id that differs from the running one waits for `clear ip ospf process`, unless the process
    // has no neighbours yet (then IOS takes it at once).
    const want = pickRid(eng, d);
    if (d.ospf.rid !== null && d.ospf.rid !== undefined && want !== rt.rid) {
      const hasNbr = Object.values(rt.ifs).some(st => Object.keys(st.nbrs).length);
      if (!hasNbr) { restart(eng, d, silent); rt = s.ospf[d.id]; changed = true; }
      else rt.ridPending = want;
    } else rt.ridPending = null;
    const ifs = ospfIfaces(eng, d);
    const seen = new Set();
    for (const I of ifs) {
      seen.add(I.name);
      const sig = ifSig(I);
      let st = rt.ifs[I.name];
      if (st && st.sig !== sig) {
        dropNeighbors(eng, d, rt, I.name, st, 'Interface down or detached', silent);
        delete rt.ifs[I.name];
        st = null;
        changed = true;
      }
      if (!st) {
        st = rt.ifs[I.name] = { sig, state: 'DOWN', since: s.t, wait: null, hello: null, dr: 0, bdr: 0, nbrs: {}, params: `${I.hello}|${I.dead}|${I.pri}` };
        if (I.up) {
          if (I.type === 'point-to-point') st.state = 'P2P';
          else if (I.pri === 0) st.state = 'DROTHER'; // ineligible routers skip Waiting (9.3)
          else { st.state = 'WAITING'; st.wait = s.t + I.dead; }
          st.hello = I.passive ? null : s.t;
        }
        changed = true;
        continue;
      }
      const params = `${I.hello}|${I.dead}|${I.pri}`;
      if (st.params !== params) {
        st.params = params;
        // Parameter change: the hello timer restarts and the next hello goes out within a second (simplification).
        if (!I.passive && I.up) st.hello = Math.min(st.hello ?? s.t + 1, s.t + 1);
        if (I.type === 'broadcast' && st.state !== 'WAITING' && I.up) { elect(eng, d, rt, I, st, silent); }
        changed = true;
      }
    }
    for (const [name, st] of Object.entries(rt.ifs)) {
      if (seen.has(name)) continue;
      dropNeighbors(eng, d, rt, name, st, 'Interface down or detached', silent);
      delete rt.ifs[name];
      changed = true;
    }
  }
  // Process removed from a device that no longer exists / is no longer a router.
  for (const id of Object.keys(s.ospf)) if (!s.devices[id] || s.devices[id].kind !== 'router') { delete s.ospf[id]; changed = true; }
  // costs, external origination and the like change LSAs without touching interface state: always re-originate
  lsaUpdate(eng);
  return changed;
}

/** `clear ip ospf process`: neighbours reset, a pending router-id takes effect, LSAs are re-originated. */
export function ospfClearProcess(eng, d) {
  const rt = rtOf(eng, d);
  if (!rt || !d.ospf) return false;
  restart(eng, d, false);
  ospfReconcile(eng);
  return true;
}

function restart(eng, d, silent) {
  const rt = eng.s.ospf[d.id];
  for (const [name, st] of Object.entries(rt.ifs)) dropNeighbors(eng, d, rt, name, st, 'Interface down or detached', silent);
  return startProcess(eng, d, silent);
}

// ------------------------------------------------------------------ hello protocol

function nbrList(st) {
  return Object.values(st.nbrs).filter(n => rank(n.state) >= rank('INIT')).map(n => n.rid);
}

function adjRequired(I, st, n) {
  if (I.type === 'point-to-point') return true;
  return st.dr === I.addr || st.bdr === I.addr || st.dr === n.ip || st.bdr === n.ip;
}

/** RFC 2328 9.4 DR/BDR election on one broadcast interface. */
function elect(eng, d, rt, I, st, silent) {
  const cands = [];
  if (I.pri > 0) cands.push({ rid: rt.rid, ip: I.addr, pri: I.pri, dr: st.dr, bdr: st.bdr, self: true });
  for (const n of Object.values(st.nbrs)) if (rank(n.state) >= rank('2WAY') && n.pri > 0) cands.push({ rid: n.rid, ip: n.ip, pri: n.pri, dr: n.dr, bdr: n.bdr });
  const better = (a, b) => (a.pri !== b.pri ? a.pri > b.pri : a.rid > b.rid);
  const best = xs => xs.reduce((a, c) => (!a || better(c, a) ? c : a), null);
  const pass = () => {
    const notDr = cands.filter(c => c.dr !== c.ip);
    const declBdr = notDr.filter(c => c.bdr === c.ip);
    const bdr = best(declBdr.length ? declBdr : notDr);
    const declDr = cands.filter(c => c.dr === c.ip);
    const dr = declDr.length ? best(declDr) : bdr;
    return { dr: dr?.ip ?? 0, bdr: bdr?.ip ?? 0 };
  };
  let r = pass();
  const me = cands.find(c => c.self);
  const was = { dr: st.dr === I.addr, bdr: st.bdr === I.addr };
  if (me && ((r.dr === I.addr) !== was.dr || (r.bdr === I.addr) !== was.bdr)) {
    me.dr = r.dr;
    me.bdr = r.bdr;
    r = pass();
  }
  const prevDr = st.dr;
  const prevBdr = st.bdr;
  st.dr = r.dr;
  st.bdr = r.bdr;
  st.state = st.dr === I.addr ? 'DR' : st.bdr === I.addr ? 'BDR' : 'DROTHER';
  st.wait = null;
  // A changed DR/BDR view is announced with the next hello within a second (simplification, see docs).
  if ((prevDr !== st.dr || prevBdr !== st.bdr) && !I.passive && st.hello !== null) st.hello = Math.min(st.hello, eng.s.t + 1);
  adjCheck(eng, d, rt, I, st, silent);
  return prevDr !== st.dr;
}

/** RFC 2328 10.4 AdjOK?: start or tear down adjacencies after the DR/BDR changed. */
function adjCheck(eng, d, rt, I, st, silent) {
  for (const n of Object.values(st.nbrs)) {
    const need = adjRequired(I, st, n);
    if (n.state === '2WAY' && need) startExchange(eng, d, rt, I, st, n, silent);
    else if (rank(n.state) >= rank('EXSTART') && !need) setNbr(eng, d, rt, I.name, n, '2WAY', 'AdjOK?', silent);
  }
}

function startExchange(eng, d, rt, I, st, n, silent) {
  setNbr(eng, d, rt, I.name, n, 'EXSTART', 'AdjOK?', silent);
  n.next = eng.s.t + STAGE;
  n.stuckSince = null;
  // The database description packets this sends prove two-way connectivity to the neighbour (10.6: a DBD received
  // in Init raises 2-WayReceived), so its view of us catches up at once.
  const od = eng.s.devices[n.peerDev];
  const ort = od && rtOf(eng, od);
  const ost = ort?.ifs[n.peerIf];
  const back = ost?.nbrs[fmtIp(I.addr)];
  if (back && back.rid === rt.rid && back.state === 'INIT') {
    setNbr(eng, od, ort, n.peerIf, back, '2WAY', '2-Way Received', silent);
    const OI = ospfIfaces(eng, od).find(x => x.name === n.peerIf);
    if (OI && OI.type === 'broadcast' && ost.state !== 'WAITING') elect(eng, od, ort, OI, ost, silent);
    else if (OI && back.state === '2WAY' && adjRequired(OI, ost, back)) startExchange(eng, od, ort, OI, ost, back, silent);
  }
}

function rateLimited(rt, key, t, every = 30) {
  rt.warn ||= {};
  if (rt.warn[key] !== undefined && t - rt.warn[key] < every) return true;
  rt.warn[key] = t;
  return false;
}

/** Router `d` sends a hello on interface I. Returns true if any neighbour state changed. */
function sendHello(eng, d, rt, I, st, silent) {
  const H = { rid: rt.rid, ip: I.addr, len: I.len, area: I.area, hello: I.hello, dead: I.dead, pri: I.pri, dr: st.state === 'WAITING' ? 0 : st.dr, bdr: st.state === 'WAITING' ? 0 : st.bdr, nbrs: nbrList(st), dev: d.id, ifName: I.name };
  const fl = eng.flood(d.id, I.port, I.tag);
  let changed = false;
  for (const ep of fl.endpoints) {
    if (ep.dev === d.id) continue;
    const od = eng.s.devices[ep.dev];
    if (od.kind !== 'router' || !od.ospf) continue;
    const ort = rtOf(eng, od);
    if (!ort || ort.rid === null) continue;
    const J = ospfIfaces(eng, od).find(x => x.name === ep.l3if);
    if (!J || !J.up || J.passive) continue;
    const ost = ort.ifs[J.name];
    if (!ost) continue;
    // Inbound ACLs filter OSPF like any other IP packet (protocol 89).
    if (J.cfg.aclIn && !evalAcl(od, J.cfg.aclIn, { proto: 'ospf', src: I.addr, dst: ALL_SPF }, true).permit) continue;
    if (receiveHello(eng, od, ort, J, ost, H, silent)) changed = true;
  }
  return changed;
}

function debugHello(eng, d, silent, msg) { if (!silent && d.debug?.ospfHello) eng.syslog(d, 'OSPF', msg); }

/** RFC 2328 10.5 hello processing on router `d`, interface J. */
function receiveHello(eng, d, rt, J, st, H, silent) {
  const t = eng.s.t;
  debugHello(eng, d, silent, `Rcv hello from ${fmtIp(H.rid)} area ${H.area} from ${longIf(J.name)} ${fmtIp(H.ip)}`);
  if (H.area !== J.area) {
    // Cisco logs this when an area-0 packet reaches an interface in another area (tech note 6154).
    if (H.area === 0 && !rateLimited(rt, `area|${H.ip}`, t)) log(eng, d, silent, '%OSPF-4-ERRRCV', `Received invalid packet: mismatch area ID, from backbone area must be virtual-link but not found from ${fmtIp(H.ip)}, ${longIf(J.name)}`);
    return false;
  }
  if (H.rid === rt.rid) {
    if (!rateLimited(rt, `dup|${H.ip}`, t)) log(eng, d, silent, '%OSPF-4-DUP_RTRID_NBR', `OSPF detected duplicate router-id ${fmtIp(H.rid)} from ${fmtIp(H.ip)} on interface ${longIf(J.name)}`);
    return false;
  }
  if (J.type === 'broadcast' && !inSubnet(H.ip, J.addr, J.len)) {
    if (!silent && d.debug?.ospfAdj) eng.syslog(d, 'OSPF', `Rcv pkt from ${fmtIp(H.ip)}, ${longIf(J.name)}, area ${J.area} : src not on the same network`);
    return false;
  }
  const maskBad = J.type === 'broadcast' && H.len !== J.len;
  if (maskBad || H.hello !== J.hello || H.dead !== J.dead) {
    debugHello(eng, d, silent, `Mismatched hello parameters from ${fmtIp(H.ip)}`);
    debugHello(eng, d, silent, `Dead R ${H.dead} C ${J.dead}, Hello R ${H.hello} C ${J.hello}  Mask R ${fmtIp(prefixToMask(H.len))} C ${fmtIp(prefixToMask(J.len))}`);
    return false;
  }
  const key = fmtIp(H.ip);
  let n = st.nbrs[key];
  let changed = false;
  if (n && n.rid !== H.rid) { setNbr(eng, d, rt, J.name, n, 'DOWN', 'Neighbor Down: Interface down or detached', silent); delete st.nbrs[key]; n = null; }
  if (!n) {
    n = st.nbrs[key] = { rid: H.rid, ip: H.ip, pri: H.pri, state: 'DOWN', since: t, dead: t + J.dead, dr: H.dr, bdr: H.bdr, peerDev: H.dev, peerIf: H.ifName, next: null, stuckSince: null };
    setNbr(eng, d, rt, J.name, n, 'INIT', 'Received Hello', silent);
    changed = true;
  }
  n.dead = t + J.dead;
  n.peerDev = H.dev;
  n.peerIf = H.ifName;
  const prev = { pri: n.pri, dr: n.dr, bdr: n.bdr };
  n.pri = H.pri;
  n.dr = H.dr;
  n.bdr = H.bdr;
  let nbrChange = false;
  const twoWay = H.nbrs.includes(rt.rid);
  if (twoWay && n.state === 'INIT') { setNbr(eng, d, rt, J.name, n, '2WAY', '2-Way Received', silent); nbrChange = true; changed = true; }
  else if (!twoWay && rank(n.state) >= rank('2WAY')) { setNbr(eng, d, rt, J.name, n, 'INIT', '1-Way', silent); nbrChange = true; changed = true; }
  if (J.type === 'broadcast') {
    if (prev.pri !== n.pri) nbrChange = true;
    const declDr = c => c.dr === H.ip;
    const declBdr = c => c.bdr === H.ip;
    if (declDr(prev) !== declDr(n) || declBdr(prev) !== declBdr(n)) nbrChange = true;
    if (st.state === 'WAITING') {
      // BackupSeen: the neighbour declares itself BDR, or DR with no BDR (9.3).
      if (rank(n.state) >= rank('2WAY') && (declBdr(n) || (declDr(n) && n.bdr === 0))) { elect(eng, d, rt, J, st, silent); changed = true; }
    } else if (nbrChange) { elect(eng, d, rt, J, st, silent); changed = true; }
  }
  if (n.state === '2WAY' && st.state !== 'WAITING' && adjRequired(J, st, n)) { startExchange(eng, d, rt, J, st, n, silent); changed = true; }
  return changed;
}

/** Advance one neighbour through the database exchange. */
function progress(eng, d, rt, I, st, n, silent) {
  const t = eng.s.t;
  if (rank(n.state) < rank('EXSTART') || n.state === 'FULL' || n.next === null || t < n.next) return false;
  const od = eng.s.devices[n.peerDev];
  const P = od && ospfIfaces(eng, od).find(x => x.name === n.peerIf);
  const peerMtu = P ? P.mtu : I.mtu;
  const peerIgnore = P ? P.mtuIgnore : false;
  // negotiation needs the neighbour in the exchange too; until then our DBDs go unanswered (retransmitted)
  const back = od && rtOf(eng, od)?.ifs[n.peerIf]?.nbrs[fmtIp(I.addr)];
  if (!back || back.rid !== rt.rid || rank(back.state) < rank('EXSTART')) return stuck(eng, d, rt, I, st, n, silent);
  if (n.state === 'EXSTART') {
    // 10.6: a DBD advertising a larger MTU than this interface accepts is rejected.
    if (peerMtu > I.mtu && !I.mtuIgnore) return stuck(eng, d, rt, I, st, n, silent);
    setNbr(eng, d, rt, I.name, n, 'EXCHANGE', 'Negotiation Done', silent);
    n.next = t + STAGE;
    n.stuckSince = null;
    return true;
  }
  if (n.state === 'EXCHANGE') {
    if (I.mtu > peerMtu && !peerIgnore) return stuck(eng, d, rt, I, st, n, silent);
    setNbr(eng, d, rt, I.name, n, 'LOADING', 'Exchange Done', silent);
    n.next = t + STAGE;
    return true;
  }
  setNbr(eng, d, rt, I.name, n, 'FULL', 'Loading Done', silent);
  n.next = null;
  return true;
}

function stuck(eng, d, rt, I, st, n, silent) {
  const t = eng.s.t;
  if (n.stuckSince === null) n.stuckSince = t;
  n.next = t + 5;
  if (t - n.stuckSince >= DBD_GIVEUP) {
    setNbr(eng, d, rt, I.name, n, 'DOWN', 'Neighbor Down: Too many DBD retransmitions', silent);
    delete st.nbrs[fmtIp(n.ip)];
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ time

/**
 * One engine step: hellos, wait and dead timers, database exchange, flooding, SPF. Returns true when any router's
 * OSPF routes changed (the engine then drops its route caches and re-evaluates service flows).
 */
export function ospfTick(eng) {
  if (!anyOspf(eng)) return false;
  const s = eng.s;
  const t = s.t;
  // link state can change without a mutation (tests, scripted cuts): keep the runtime in line
  let changed = false;
  for (const d of routers(eng)) {
    const rt = s.ospf?.[d.id];
    if (!d.ospf || !rt || rt.rid === null) { changed = true; break; }
    const ifs = ospfIfaces(eng, d);
    if (ifs.length !== Object.keys(rt.ifs).length || ifs.some(I => rt.ifs[I.name]?.sig !== ifSig(I))) { changed = true; break; }
  }
  if (changed) ospfReconcile(eng);
  let lsa = false;
  for (const d of routers(eng)) {
    const rt = s.ospf?.[d.id];
    if (!rt || rt.rid === null || !d.ospf) continue;
    for (const I of ospfIfaces(eng, d)) {
      const st = rt.ifs[I.name];
      if (!st || !I.up) continue;
      if (st.state === 'WAITING' && st.wait !== null && t >= st.wait) { elect(eng, d, rt, I, st, false); lsa = true; }
      for (const n of Object.values(st.nbrs)) if (progress(eng, d, rt, I, st, n, false)) lsa = true;
      for (const [k, n] of Object.entries(st.nbrs)) {
        if (t < n.dead) continue;
        const was = n.state;
        setNbr(eng, d, rt, I.name, n, 'DOWN', 'Neighbor Down: Dead timer expired', false);
        delete st.nbrs[k];
        if (rank(was) >= rank('2WAY') && I.type === 'broadcast' && st.state !== 'WAITING') elect(eng, d, rt, I, st, false);
        lsa = true;
      }
      if (!I.passive && st.hello !== null && t >= st.hello) {
        st.hello = t + I.hello;
        if (sendHello(eng, d, rt, I, st, false)) lsa = true;
      }
    }
  }
  if (lsa) lsaUpdate(eng);
  // ageing: refresh our LSAs every 30 min, drop MaxAge copies and old tombstones
  if (!s.ospfAgeAt || t >= s.ospfAgeAt) { s.ospfAgeAt = t + 60; if (ageLsdbs(eng)) lsaUpdate(eng); }
  let rib = false;
  for (const d of routers(eng)) {
    const rt = s.ospf?.[d.id];
    if (!rt || rt.rid === null || rt.spf.due === null || t < rt.spf.due) continue;
    if (runSpf(eng, d, rt)) rib = true;
    lsaUpdate(eng); // ABR summaries and external origination depend on the SPF result
  }
  return rib;
}

function ageLsdbs(eng) {
  const s = eng.s;
  let changed = false;
  for (const rt of Object.values(s.ospf || {})) {
    for (const db of [...Object.values(rt.lsdb), rt.ext]) {
      for (const [k, l] of Object.entries(db)) {
        const age = s.t - l.born;
        if (l.dead && age >= TOMBSTONE) { delete db[k]; continue; }
        if (!l.dead && l.adv === rt.rid && age >= LS_REFRESH) { l.seq += 1; l.born = s.t; changed = true; continue; }
        if (!l.dead && age >= MAX_AGE) { delete db[k]; rt.dbChanged = true; changed = true; }
      }
    }
    if (rt.dbChanged) scheduleSpf(eng, rt);
  }
  return changed;
}

function scheduleSpf(eng, rt) {
  rt.dbChanged = false;
  if (rt.spf.due !== null) return;
  rt.spf.due = Math.max(eng.s.t + SPF_START, rt.spf.last !== null ? rt.spf.last + SPF_HOLD : -Infinity);
}

// ------------------------------------------------------------------ LSA origination and flooding

function attachedAreas(ifs) {
  return [...new Set(ifs.filter(I => I.up).map(I => I.area))].sort((a, b) => a - b);
}

function fullNbrs(st) { return Object.values(st.nbrs).filter(n => n.state === 'FULL'); }

function isAbr(areas) { return areas.length > 1 && areas.includes(0); }

function hasExternalDefault(eng, d) {
  const o = d.ospf;
  if (!o?.defInfo) return false;
  if (o.defInfo.always) return true;
  return eng.routes(d.id).table.some(r => r.len === 0 && r.type !== 'O');
}

/** The LSAs router d wants in each area right now: { [area]: { key: lsa } , ext: { key: lsa } }. */
function desiredLsas(eng, d, rt) {
  const ifs = ospfIfaces(eng, d);
  const areas = attachedAreas(ifs);
  const abr = isAbr(areas);
  const asbr = hasExternalDefault(eng, d);
  const out = { ext: {} };
  for (const A of areas) {
    const links = [];
    const lsas = {};
    for (const I of ifs) {
      if (I.area !== A || !I.up) continue;
      const st = rt.ifs[I.name];
      if (!st) continue;
      const stub = { t: 3, id: networkOf(I.addr, I.len), data: I.len, metric: I.cost };
      if (I.type === 'point-to-point') {
        for (const n of fullNbrs(st)) links.push({ t: 1, id: n.rid, data: I.addr, metric: I.cost });
        links.push(stub);
        continue;
      }
      const full = fullNbrs(st);
      const transit = st.state !== 'WAITING' && st.dr !== 0 && ((st.dr === I.addr && full.length > 0) || full.some(n => n.ip === st.dr));
      if (transit) links.push({ t: 2, id: st.dr, data: I.addr, metric: I.cost });
      else links.push(stub);
      if (st.dr === I.addr && full.length > 0) {
        const attached = [rt.rid, ...full.map(n => n.rid)].sort((a, b) => a - b);
        lsas[`2:${I.addr}:${rt.rid}`] = { type: 2, id: I.addr, adv: rt.rid, body: { len: I.len, attached } };
      }
    }
    links.sort((a, b) => a.t - b.t || a.id - b.id || a.data - b.data);
    lsas[`1:${rt.rid}:${rt.rid}`] = { type: 1, id: rt.rid, adv: rt.rid, body: { b: abr, e: asbr, links } };
    out[A] = lsas;
  }
  // ABR summaries from the last SPF results (12.4.3): intra-area routes of each area into every other attached area;
  // inter-area routes learned over the backbone into the non-backbone areas; ASBR summaries likewise.
  if (abr && rt.spfAreas) {
    for (const A of areas) {
      for (const X of areas) {
        if (X === A) continue;
        for (const r of rt.spfAreas[X]?.routes || []) {
          const key = `3:${r.net}/${r.len}:${rt.rid}`;
          const cur = out[A][key];
          if (!cur || cur.body.metric > r.cost) out[A][key] = { type: 3, id: r.net, adv: rt.rid, body: { len: r.len, metric: r.cost } };
        }
        for (const [rid, v] of Object.entries(rt.spfAreas[X]?.routers || {})) {
          if (!v.e || Number(rid) === rt.rid) continue;
          out[A][`4:${rid}:${rt.rid}`] = { type: 4, id: Number(rid), adv: rt.rid, body: { metric: v.dist } };
        }
      }
      if (A !== 0) {
        for (const r of rt.interArea || []) {
          const key = `3:${r.net}/${r.len}:${rt.rid}`;
          if (!out[A][key]) out[A][key] = { type: 3, id: r.net, adv: rt.rid, body: { len: r.len, metric: r.metric } };
        }
      }
    }
  }
  if (asbr) out.ext[`5:0/0:${rt.rid}`] = { type: 5, id: 0, adv: rt.rid, body: { len: 0, metric: 1, e2: true, tag: d.ospf.pid } };
  return out;
}

const sameBody = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function originate(eng, d, rt) {
  const t = eng.s.t;
  const want = desiredLsas(eng, d, rt);
  let changed = false;
  const apply = (db, wanted) => {
    for (const [k, w] of Object.entries(wanted)) {
      const cur = db[k];
      if (cur && !cur.dead && sameBody(cur.body, w.body)) continue;
      db[k] = { ...w, seq: (cur?.seq ?? 0x80000000) + 1, born: t, dead: false };
      changed = true;
    }
    for (const [k, l] of Object.entries(db)) {
      if (l.adv !== rt.rid || l.dead || wanted[k]) continue;
      db[k] = { ...l, seq: l.seq + 1, born: t, dead: true };
      changed = true;
    }
  };
  // an area with no interface left is no longer attached: its database goes with it
  for (const A of Object.keys(rt.lsdb)) if (!(A in want)) { delete rt.lsdb[A]; changed = true; }
  for (const [A, wanted] of Object.entries(want)) {
    if (A === 'ext') continue;
    rt.lsdb[A] ||= {};
    apply(rt.lsdb[A], wanted);
  }
  apply(rt.ext, want.ext);
  if (changed) rt.dbChanged = true;
  return changed;
}

/** Flood newer LSA instances across adjacencies until every database is in step (13, 13.3). */
function flood(eng) {
  const s = eng.s;
  let any = false;
  for (let round = 0; round < 32; round++) {
    let moved = false;
    for (const d of routers(eng)) {
      const rt = s.ospf?.[d.id];
      if (!rt || rt.rid === null || !d.ospf) continue;
      for (const I of ospfIfaces(eng, d)) {
        const st = rt.ifs[I.name];
        if (!st || !I.up) continue;
        for (const n of fullNbrs(st)) {
          const od = s.devices[n.peerDev];
          const ort = od && s.ospf?.[od.id];
          if (!ort || ort.rid !== n.rid) continue;
          const back = ort.ifs[n.peerIf]?.nbrs[fmtIp(I.addr)];
          if (!back || back.rid !== rt.rid || rank(back.state) < rank('EXCHANGE')) continue;
          const A = String(I.area);
          ort.lsdb[A] ||= {};
          if (copyNewer(rt.lsdb[A] || {}, ort.lsdb[A], ort)) moved = true;
          if (copyNewer(rt.ext, ort.ext, ort)) moved = true;
        }
      }
    }
    if (!moved) break;
    any = true;
  }
  return any;
}

/** RFC 2328 13.1: which of two instances of the same LSA is newer (sequence, then checksum, then MaxAge). */
function newer(a, b) {
  if (a.seq !== b.seq) return a.seq > b.seq;
  const ca = lsaChecksum(a);
  const cb = lsaChecksum(b);
  if (ca !== cb) return ca > cb;
  return !!a.dead && !b.dead;
}

function copyNewer(src, dst, to) {
  let moved = false;
  for (const [k, l] of Object.entries(src)) {
    const cur = dst[k];
    if (cur && !newer(l, cur)) continue;
    dst[k] = JSON.parse(JSON.stringify(l));
    to.dbChanged = true;
    moved = true;
  }
  return moved;
}

/** Originate and flood until stable, then schedule SPF wherever a database changed. */
export function lsaUpdate(eng) {
  const s = eng.s;
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const d of routers(eng)) {
      const rt = s.ospf?.[d.id];
      if (!rt || rt.rid === null || !d.ospf) continue;
      if (originate(eng, d, rt)) changed = true;
    }
    if (flood(eng)) changed = true;
    if (!changed) break;
  }
  for (const rt of Object.values(s.ospf || {})) if (rt.dbChanged) scheduleSpf(eng, rt);
}

// ------------------------------------------------------------------ SPF

function liveDb(db) {
  const router = {};
  const network = {};
  const summary = [];
  const asbrSum = [];
  for (const l of Object.values(db || {})) {
    if (l.dead) continue;
    if (l.type === 1) router[l.adv] = l;
    else if (l.type === 2) { if (!network[l.id] || network[l.id].born < l.born) network[l.id] = l; }
    else if (l.type === 3) summary.push(l);
    else if (l.type === 4) asbrSum.push(l);
  }
  return { router, network, summary, asbrSum };
}

/** Dijkstra over one area's LSDB (16.1). Returns { routes: [{net,len,cost,hop,src,local}], routers: {rid:{dist,hop,b,e}} }. */
function spfArea(eng, d, rt, A, ifs) {
  const { router, network } = liveDb(rt.lsdb[String(A)]);
  const out = { routes: [], routers: {} };
  if (!router[rt.rid]) return out;
  const key = v => `${v.k}${v.id}`;
  const lsaOf = v => (v.k === 'R' ? router[v.id] : network[v.id]);
  const dist = new Map();
  const info = new Map();
  const done = new Set();
  const root = { k: 'R', id: rt.rid };
  dist.set(key(root), 0);
  info.set(key(root), { v: root, hop: null });
  const myIf = addr => ifs.find(I => I.area === A && I.up && I.addr === addr);
  for (;;) {
    let cur = null;
    for (const [k, dv] of dist) {
      if (done.has(k)) continue;
      const c = info.get(k).v;
      // equal cost: transit networks before routers (16.1 step 3), then lowest ID for determinism
      if (!cur || dv < cur.d || (dv === cur.d && ((c.k === 'N' && cur.v.k === 'R') || (c.k === cur.v.k && c.id < cur.v.id)))) cur = { k, d: dv, v: c };
    }
    if (!cur) break;
    done.add(cur.k);
    const V = cur.v;
    const L = lsaOf(V);
    if (!L) continue;
    const vhop = info.get(cur.k).hop;
    const relax = (W, cost, hop) => {
      const k = key(W);
      if (done.has(k)) return;
      if (!dist.has(k) || cost < dist.get(k)) { dist.set(k, cost); info.set(k, { v: W, hop }); }
    };
    if (V.k === 'R') {
      for (const ln of L.body.links) {
        if (ln.t === 3) continue;
        const W = ln.t === 1 ? { k: 'R', id: ln.id } : { k: 'N', id: ln.id };
        const WL = lsaOf(W);
        if (!WL) continue;
        // two-way check (16.1 step 2b)
        if (W.k === 'R' && !WL.body.links.some(x => x.t === 1 && x.id === V.id)) continue;
        if (W.k === 'N' && !WL.body.attached.includes(V.id)) continue;
        let hop = vhop;
        if (V.id === rt.rid && V.k === 'R') {
          const I = myIf(ln.data);
          if (!I) continue;
          if (W.k === 'N') hop = { iface: I.name, nh: null };
          else {
            const backLink = WL.body.links.find(x => x.t === 1 && x.id === V.id);
            hop = { iface: I.name, nh: backLink.data };
          }
        }
        relax(W, cur.d + ln.metric, hop);
      }
    } else {
      for (const rid of L.body.attached) {
        const W = { k: 'R', id: rid };
        const WL = router[rid];
        if (!WL) continue;
        const backLink = WL.body.links.find(x => x.t === 2 && x.id === V.id);
        if (!backLink) continue;
        let hop = vhop;
        if (vhop && vhop.nh === null) hop = { iface: vhop.iface, nh: backLink.data }; // network directly attached to us
        relax(W, cur.d, hop);
      }
    }
  }
  const best = new Map();
  const addRoute = (net, len, cost, hop, src, local) => {
    const k = `${net}/${len}`;
    const cur = best.get(k);
    if (!cur || cost < cur.cost) best.set(k, { net, len, cost, hop, src, local });
  };
  for (const [k, dv] of dist) {
    if (!done.has(k)) continue;
    const { v, hop } = info.get(k);
    const L = lsaOf(v);
    if (!L) continue;
    if (v.k === 'N') {
      addRoute(networkOf(v.id, L.body.len), L.body.len, dv, hop, L.adv, !hop || hop.nh === null);
      continue;
    }
    out.routers[v.id] = { dist: dv, hop, b: !!L.body.b, e: !!L.body.e };
    for (const ln of L.body.links) if (ln.t === 3) addRoute(ln.id, ln.data, dv + ln.metric, hop, v.id, v.id === rt.rid);
  }
  out.routes = [...best.values()].sort((a, b) => a.net - b.net || a.len - b.len);
  return out;
}

const CODE_RANK = { 'O': 0, 'O IA': 1, 'O E1': 2, 'O E2': 3 };

/** Full SPF run for router d: intra-area, inter-area (16.2) and external (16.4) routes into rt.rib. */
function runSpf(eng, d, rt) {
  const t = eng.s.t;
  rt.spf.due = null;
  rt.spf.last = t;
  rt.spf.runs += 1;
  const ifs = ospfIfaces(eng, d);
  const areas = attachedAreas(ifs);
  const abr = isAbr(areas);
  rt.spfAreas = {};
  for (const A of areas) rt.spfAreas[A] = spfArea(eng, d, rt, A, ifs);
  const connected = ifs.filter(I => I.up).map(I => `${networkOf(I.addr, I.len)}/${I.len}`);
  const cands = new Map();
  const offer = r => {
    const k = `${r.net}/${r.len}`;
    const cur = cands.get(k);
    if (!cur || CODE_RANK[r.base] < CODE_RANK[cur.base] || (r.base === cur.base && (r.metric < cur.metric || (r.metric === cur.metric && (r.fwd ?? 0) < (cur.fwd ?? 0))))) cands.set(k, r);
  };
  for (const A of areas) {
    for (const r of rt.spfAreas[A].routes) {
      if (r.local || !r.hop || r.hop.nh === null) continue;
      offer({ base: 'O', net: r.net, len: r.len, metric: r.cost, iface: r.hop.iface, nh: r.hop.nh, src: r.src, area: A });
    }
  }
  const intra = new Set([...cands.keys()]);
  for (const A of areas) for (const r of rt.spfAreas[A].routes) intra.add(`${r.net}/${r.len}`);
  // inter-area: an ABR looks only at backbone summaries
  const interAreas = abr ? [0] : areas;
  const inter = [];
  for (const A of interAreas) {
    const { summary } = liveDb(rt.lsdb[String(A)]);
    for (const l of summary) {
      if (l.adv === rt.rid || l.body.metric >= 0xffffff) continue;
      const br = rt.spfAreas[A]?.routers[l.adv];
      if (!br || !br.hop) continue;
      const k = `${l.id}/${l.body.len}`;
      if (intra.has(k)) continue;
      const r = { base: 'O IA', net: l.id, len: l.body.len, metric: br.dist + l.body.metric, iface: br.hop.iface, nh: br.hop.nh, src: l.adv, area: A };
      offer(r);
      inter.push(r);
    }
  }
  rt.interArea = [...new Map(inter.sort((a, b) => a.metric - b.metric).reverse().map(r => [`${r.net}/${r.len}`, r])).values()].map(r => ({ net: r.net, len: r.len, metric: r.metric }));
  // ASBR reachability: intra-area first, then ASBR summaries (type 4)
  const asbrRoute = rid => {
    let best = null;
    for (const A of areas) {
      const v = rt.spfAreas[A].routers[rid];
      if (v && v.hop && (!best || v.dist < best.dist)) best = { dist: v.dist, hop: v.hop };
    }
    if (best) return best;
    for (const A of interAreas) {
      for (const l of liveDb(rt.lsdb[String(A)]).asbrSum) {
        if (l.id !== rid || l.adv === rt.rid) continue;
        const br = rt.spfAreas[A]?.routers[l.adv];
        if (br && br.hop && (!best || br.dist + l.body.metric < best.dist)) best = { dist: br.dist + l.body.metric, hop: br.hop };
      }
    }
    return best;
  };
  for (const l of Object.values(rt.ext)) {
    if (l.dead || l.adv === rt.rid || l.type !== 5) continue;
    const a = asbrRoute(l.adv);
    if (!a) continue;
    const k = `${l.id}/${l.body.len}`;
    if (intra.has(k)) continue;
    const e2 = l.body.e2 !== false;
    offer({ base: e2 ? 'O E2' : 'O E1', net: l.id, len: l.body.len, metric: e2 ? l.body.metric : l.body.metric + a.dist, fwd: a.dist, iface: a.hop.iface, nh: a.hop.nh, src: l.adv });
  }
  const before = JSON.stringify((rt.rib || []).map(({ since, ...r }) => r));
  const prev = new Map((rt.rib || []).map(r => [`${r.net}/${r.len}`, r]));
  const rib = [];
  for (const [k, r] of cands) {
    if (connected.includes(k)) continue;
    const old = prev.get(k);
    const code = r.len === 0 && r.base === 'O E2' ? 'O*E2' : r.len === 0 && r.base === 'O E1' ? 'O*E1' : r.len === 0 && r.base === 'O IA' ? 'O*IA' : r.base;
    const since = old && old.nh === r.nh && old.iface === r.iface && old.code === code ? old.since : t;
    rib.push({ code, net: r.net, len: r.len, metric: r.metric, iface: r.iface, nh: r.nh, src: r.src, since, ...(r.fwd !== undefined ? { fwd: r.fwd } : {}) });
  }
  rib.sort((a, b) => a.net - b.net || a.len - b.len);
  rt.rib = rib;
  return JSON.stringify(rib.map(({ since, ...r }) => r)) !== before;
}

/** OSPF routes offered to the routing table (AD 110). Routes through an interface that is down are withdrawn at once. */
export function ospfRib(eng, d) {
  const rt = eng.s.ospf?.[d.id];
  if (!rt || !d.ospf || rt.rid === null) return [];
  const up = new Set(l3Ifaces(eng, d).filter(i => i.up).map(i => i.name));
  return rt.rib.filter(r => up.has(r.iface)).map(r => ({ type: 'O', code: r.code, net: r.net, len: r.len, iface: r.iface, nh: r.nh, ad: OSPF_AD, metric: r.metric, since: r.since, src: r.src, fwd: r.fwd }));
}

// ------------------------------------------------------------------ views used by the CLI and mission checks

/** Neighbour rows: [{ rid, pri, state, role, dead, ip, iface }] */
export function ospfNeighbors(eng, d) {
  const rt = rtOf(eng, d);
  if (!rt || !d.ospf) return [];
  const rows = [];
  for (const I of ospfIfaces(eng, d)) {
    const st = rt.ifs[I.name];
    if (!st) continue;
    for (const n of Object.values(st.nbrs).sort((a, b) => a.rid - b.rid)) {
      const role = I.type === 'point-to-point' ? '-' : n.ip === st.dr ? 'DR' : n.ip === st.bdr ? 'BDR' : 'DROTHER';
      rows.push({ rid: n.rid, pri: n.pri, state: n.state, role, dead: Math.max(0, n.dead - eng.s.t), ip: n.ip, iface: I.name, area: I.area });
    }
  }
  return rows;
}

/** The neighbour router `peerId` as seen from router d, or null. */
export function neighborState(eng, d, peerId) {
  const peer = eng.s.devices[peerId];
  const prt = peer && rtOf(eng, peer);
  if (!prt) return null;
  const row = ospfNeighbors(eng, d).find(r => r.rid === prt.rid);
  return row ? row.state : null;
}

/** Interface state for show commands: merges config view and runtime. */
export function ospfInterfaceState(eng, d, I) {
  const rt = rtOf(eng, d);
  const st = rt?.ifs[I.name];
  const nbrs = st ? Object.values(st.nbrs) : [];
  let state = 'DOWN';
  if (I.up && st) state = st.state;
  return { st, state, nbrs, full: nbrs.filter(n => n.state === 'FULL').length, helloDue: st && st.hello !== null ? Math.max(0, st.hello - eng.s.t) : null };
}

/** Database view: { rid, pid, areas: [{ area, lsas: [...] }], ext: [...] } (live entries only). */
export function ospfDatabase(eng, d) {
  const rt = rtOf(eng, d);
  if (!rt || rt.rid === null) return null;
  const areas = Object.keys(rt.lsdb).map(Number).sort((a, b) => a - b).filter(A => Object.values(rt.lsdb[String(A)]).some(l => !l.dead));
  return {
    rid: rt.rid, pid: rt.pid,
    areas: areas.map(A => ({ area: A, lsas: Object.values(rt.lsdb[String(A)]).filter(l => !l.dead) })),
    ext: Object.values(rt.ext).filter(l => !l.dead),
  };
}

/** Deterministic stand-in for the LSA Fletcher checksum (format only; see docs). */
export function lsaChecksum(l) {
  const s = JSON.stringify([l.type, l.id, l.adv, l.seq, l.body]);
  let a = 1;
  let b = 0;
  for (let i = 0; i < s.length; i++) { a = (a + s.charCodeAt(i)) % 255; b = (b + a) % 255; }
  return (a << 8) | b;
}

export { attachedAreas, isAbr, ORDER as OSPF_STATES };
