// The network engine: one source of truth for every CLI, the 3D world, the HUD and mission checks.
import { linkStatus } from './link.js';
import { applyStp, tickStp, detectStorms, flood, carries } from './switching.js';
import { routeTable } from './routing.js';
import { probe, sendPacket } from './trace.js';
import { dhcpClient, applyDhcpResult, fleetDhcp, dhcpHostTick, httpRequest, namedLoad, dhcpdStart } from './services.js';
import { longIf, macCisco } from './model.js';
import { routeTable6, v6AfterChange, v6Periodic, RA_INTERVAL } from './net6.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const EPOCH_MS = Date.UTC(2026, 9, 15, 2, 17, 0); // shift starts 02:17 (displayed as local wall time)

export function wallClock(t) {
  const d = new Date(EPOCH_MS + t * 1000);
  return {
    mon: MONTHS[d.getUTCMonth()], day: d.getUTCDate(), dow: DAYS[d.getUTCDay()], year: d.getUTCFullYear(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
  };
}
const p2 = n => String(n).padStart(2, '0');

/** Simplified ITU-T G.107 E-model: MOS from one-way delay (ms), jitter (ms) and loss (%). */
export function estimateMos(delay, jitter, lossPct) {
  const eff = delay + 2 * jitter + 10;
  const id = eff < 160 ? eff / 40 : (eff - 120) / 10;
  const ie = lossPct * 2.5;
  const r = Math.max(0, Math.min(100, 93.2 - id - ie));
  return Math.max(1, Math.min(4.5, 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r)));
}

export class Engine {
  constructor(state) {
    this.s = state;
    const s = this.s;
    s.t ??= 0;
    s.rngState ??= 0x5eed;
    s.events ??= [];
    s.eventSeq ??= 0;
    s.changeSeq ??= 0;
    s.changeLog ??= [];
    s.linkMemo ??= {};
    s.flows ??= [];
    s.flowState ??= {};
    s.timers ??= { fleet: 0, storm: 0, cdp: 0, flows: 0 };
    s.internet ??= { names: {} };
    s.timers.ra ??= RA_INTERVAL; // ---- ipv6: periodic Router Advertisements
    this.cache = {};
    this.rev = 0;
    this._stpDirty = true;
    this.listeners = new Set();
    this.reindex();
  }

  // ------------------------------------------------------------ indexes & caches
  reindex() {
    this.portIndex = new Map();
    for (const l of Object.values(this.s.links)) {
      this.portIndex.set(`${l.a.dev}|${l.a.port}`, l);
      this.portIndex.set(`${l.b.dev}|${l.b.port}`, l);
    }
  }

  linkAt(dev, port) { return this.portIndex.get(`${dev}|${port}`) || null; }

  peerOf(dev, port) {
    const l = this.linkAt(dev, port);
    if (!l) return null;
    return l.a.dev === dev && l.a.port === port ? l.b : l.a;
  }

  changed() {
    this.rev++;
    this.cache = {};
    this._stpDirty = true;
  }

  ensure() {
    if (!this._stpDirty) return;
    this._stpDirty = false;
    this.cache = {};
    applyStp(this, false);
    this.cache = {};
  }

  linkStatus(id) {
    const c = (this.cache.ls ||= new Map());
    if (!c.has(id)) c.set(id, linkStatus(this.s, this.s.links[id]));
    return c.get(id);
  }

  portUp(dev, port) {
    const l = this.linkAt(dev, port);
    return !!l && this.linkStatus(l.id).up;
  }

  flood(dev, port, tag, opts = {}) {
    this.ensure();
    const c = (this.cache.flood ||= new Map());
    const key = `${dev}|${port}|${tag}|${opts.serverMsg ? 1 : 0}`;
    if (!c.has(key)) c.set(key, flood(this, dev, port, tag, opts));
    return c.get(key);
  }

  routes(devId) {
    const c = (this.cache.rt ||= new Map());
    if (!c.has(devId)) c.set(devId, routeTable(this, this.s.devices[devId]));
    return c.get(devId);
  }

  /** IPv6 routing table of a router (net6.js). */
  routes6(devId) {
    const c = (this.cache.rt6 ||= new Map());
    if (!c.has(devId)) c.set(devId, routeTable6(this, this.s.devices[devId]));
    return c.get(devId);
  }

  storms() {
    this.ensure();
    if (!this.cache.storms) this.cache.storms = detectStorms(this);
    return this.cache.storms;
  }

  /** Loss / latency / jitter contributed by one link for a frame in VLAN v. */
  linkImpairment(linkId, v) {
    const l = this.s.links[linkId];
    const ls = this.linkStatus(linkId);
    let loss = 0;
    let latency = l.latencyMs ?? 0.12;
    let jitter = 0.02;
    if (ls.mismatch) { loss += 0.06; latency += 4; jitter += 18; }
    if (ls.overLength) { loss += 0.02; }
    for (const [sv, links] of this.storms()) {
      if (!links.has(linkId)) continue;
      if (v === sv || v === undefined) { loss = Math.max(loss, 0.97); latency += 220; jitter += 160; }
      else { loss = Math.max(loss, 0.55); latency += 80; jitter += 60; }
    }
    return { loss: Math.min(loss, 0.99), latency, jitter };
  }

  probe(req) {
    this.ensure();
    const r = probe(this, req);
    if (req.record && r.fwd?.nat?.length) {
      const log = (this.s.natLog ||= []);
      for (const n of r.fwd.nat) log.push({ ...n, remote: req.dst, remotePort: req.dport ?? n.port, t: this.s.t });
      if (log.length > 40) log.splice(0, log.length - 40);
    }
    return r;
  }
  send(req) { this.ensure(); return sendPacket(this, req); }

  rand() {
    // mulberry32, stored in state for deterministic replays
    let t = (this.s.rngState = (this.s.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------ logs & events
  stamp(t = this.s.t) {
    const w = wallClock(t);
    return `${w.mon} ${p2(w.day)} ${p2(w.hh)}:${p2(w.mm)}:${p2(w.ss)}.${String(w.ms).padStart(3, '0')}`;
  }

  syslog(dev, code, msg) {
    if (!dev || !dev.logging) return;
    dev.logging.push({ t: this.s.t, text: `*${this.stamp()}: ${code}: ${msg}` });
    if (dev.logging.length > 250) dev.logging.splice(0, dev.logging.length - 250);
  }

  journal(dev, unit, msg) {
    if (!dev || !dev.journal) return;
    dev.journal.push({ t: this.s.t, unit, msg });
    if (dev.journal.length > 500) dev.journal.splice(0, dev.journal.length - 500);
  }

  event(e) {
    const rec = { ...e, t: this.s.t, changeSeq: this.s.changeSeq, seq: ++this.s.eventSeq };
    this.s.events.push(rec);
    if (this.s.events.length > 400) this.s.events.splice(0, this.s.events.length - 400);
    for (const fn of this.listeners) fn({ type: 'event', event: rec });
    return rec;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Record a configuration change made by the player (or a scripted incident). */
  mutated(desc, actor = 'player') {
    this.s.changeSeq++;
    this.s.changeLog.push({ t: this.s.t, desc, actor, seq: this.s.changeSeq });
    if (this.s.changeLog.length > 300) this.s.changeLog.splice(0, this.s.changeLog.length - 300);
    this.changed();
    this.reindex();
    this.afterTopologyChange();
    for (const fn of this.listeners) fn({ type: 'mutation', desc, actor });
  }

  // ------------------------------------------------------------ transitions
  /** Detect link transitions; emit syslog; trigger DHCP on media connect; BPDU guard. */
  afterTopologyChange(silent = false) {
    this.ensure();
    const s = this.s;
    // BPDU guard: an edge port that hears an STP speaker err-disables.
    for (const l of Object.values(s.links)) {
      for (const [me, other] of [[l.a, l.b], [l.b, l.a]]) {
        const d = s.devices[me.dev];
        const p = d.ports[me.port];
        if (d.kind !== 'switch' || !p.bpduguard || p.errDisabled || !p.adminUp) continue;
        const od = s.devices[other.dev];
        if (od.kind !== 'switch' || !this.linkStatus(l.id).up) continue; // no link, no BPDUs
        const speaks = Object.keys(od.vlans).some(v => carries(od, od.ports[other.port], Number(v)) && !(od.stp.disabled || []).some(([a, b]) => v >= a && v <= b));
        if (!speaks) continue;
        p.errDisabled = 'bpduguard';
        if (!silent) {
          this.syslog(d, '%SPANTREE-2-BLOCK_BPDUGUARD', `Received BPDU on port ${longIf(p.name)} with BPDU Guard enabled. Disabling port.`);
          this.syslog(d, '%PM-4-ERR_DISABLE', `bpduguard error detected on ${p.name}, putting ${p.name} in err-disable state`);
        }
        this.changed();
        this.ensure();
      }
    }
    this.pvidLogs(silent);
    const ups = [];
    for (const l of Object.values(s.links)) {
      const up = this.linkStatus(l.id).up;
      const was = s.linkMemo[l.id] ?? false; // links created after setup start 'down'
      if (was === up) continue;
      s.linkMemo[l.id] = up;
      for (const end of [l.a, l.b]) {
        const d = s.devices[end.dev];
        if (!silent && (d.os === 'ios') && d.logging) {
          const adminDown = !d.ports[end.port].adminUp;
          this.syslog(d, '%LINK-' + (adminDown ? '5' : '3') + '-UPDOWN', `Interface ${longIf(end.port)}, changed state to ${up ? 'up' : adminDown ? 'administratively down' : 'down'}`);
          this.syslog(d, '%LINEPROTO-5-UPDOWN', `Line protocol on Interface ${longIf(end.port)}, changed state to ${up ? 'up' : 'down'}`);
        }
        if (up) ups.push(end);
      }
    }
    this.checkStormOnset();
    // Media connect: DHCP clients start (DORA) or re-confirm a remembered lease (INIT-REBOOT).
    for (const end of ups) {
      const d = s.devices[end.dev];
      if (d.kind === 'host' && d.ipcfg.dhcp && d.nic === end.port && d.managedDhcp !== false) {
        const res = dhcpClient(this, d, { mode: 'reboot' });
        applyDhcpResult(this, d, res);
        this.ensure();
      }
      if (d.kind === 'fleet' && d.nic === end.port) fleetDhcp(this, d, { all: true });
    }
    // ---- ipv6: link-up hosts send Router Solicitations; newly advertising router interfaces send initial RAs
    v6AfterChange(this, ups);
    this.evaluateFlows();
  }

  /** Settle a freshly built scenario: STP converged, link memo set, no logs. */
  converge() {
    this.changed();
    this._stpDirty = false;
    applyStp(this, true);
    this.cache = {};
    for (const l of Object.values(this.s.links)) this.s.linkMemo[l.id] = this.linkStatus(l.id).up;
    this.pvidLogs(true);
    for (const d of Object.values(this.s.devices)) {
      if (d.kind !== 'host') continue;
      if (d.services?.named?.active) namedLoad(this, d);
      if (d.services?.['isc-dhcp-server']?.active) {
        const r = dhcpdStart(this, d);
        if (!r.ok) d.services['isc-dhcp-server'].active = false;
      }
    }
    this.changed();
    this.ensure();
    v6AfterChange(this, []); // ---- ipv6: RAs from interfaces that already advertise at build time
    this.evaluateFlows();
  }

  // ------------------------------------------------------------ time
  advance(dt) {
    const s = this.s;
    const steps = Math.max(1, Math.ceil(dt / 1));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      s.t += h;
      if (tickStp(this)) { this.cache = {}; this.rev++; this.checkStormOnset(); this.evaluateFlows(); }
      this.tickCounters(h);
      for (const d of Object.values(s.devices)) {
        if (d.kind !== 'host' || !d.ipcfg.dhcp || d.released || d.managedDhcp === false || d.powered === false) continue;
        if (!this.portUp(d.id, d.nic)) continue;
        // Leased clients follow the RFC 2131 timers: T1 unicast renewal, T2 broadcast rebinding, expiry.
        if (d.lease) { if (dhcpHostTick(this, d)) this.evaluateFlows(); continue; }
        // Clients without a lease (Windows on APIPA, dhclient after a failed attempt) retry every 5 minutes.
        if (s.t >= (d.nextDhcpRetry ?? 300)) {
          const res = dhcpClient(this, d, { mode: 'discover' });
          applyDhcpResult(this, d, res);
          if (res.ok) this.evaluateFlows();
        }
      }
      if (s.t >= s.timers.fleet) {
        s.timers.fleet = s.t + 60;
        for (const d of Object.values(s.devices)) if (d.kind === 'fleet' && this.portUp(d.id, d.nic)) fleetDhcp(this, d);
      }
      if (s.t >= s.timers.ra) { s.timers.ra = s.t + RA_INTERVAL; if (v6Periodic(this)) this.evaluateFlows(); } // ---- ipv6
      if (s.t >= s.timers.storm) { s.timers.storm = s.t + 12; this.stormLogs(); }
      if (s.t >= s.timers.cdp) { s.timers.cdp = s.t + 60; this.cdpLogs(); }
      if (s.t >= s.timers.flows) { s.timers.flows = s.t + 5; this.evaluateFlows(); }
    }
    for (const fn of this.listeners) fn({ type: 'tick', t: s.t });
  }

  tickCounters(dt) {
    const s = this.s;
    const storms = this.storms();
    for (const l of Object.values(s.links)) {
      const ls = this.linkStatus(l.id);
      if (!ls.up) continue;
      let stormRate = 0;
      for (const [, links] of storms) if (links.has(l.id)) stormRate += 48000;
      for (const [side, dup] of [['a', ls.duplexA], ['b', ls.duplexB]]) {
        const end = l[side];
        const p = s.devices[end.dev].ports[end.port];
        const c = (p.counters ||= { inPkts: 0, outPkts: 0, bcast: 0, crc: 0, runts: 0, lateCol: 0, collisions: 0, inErr: 0, outErr: 0 });
        const rate = 40 + stormRate;
        c.inPkts += rate * dt;
        c.outPkts += rate * dt;
        c.bcast += (2 + stormRate) * dt;
        if (ls.mismatch) {
          if (dup === 'half') { c.collisions += 6 * dt; c.lateCol += 1.6 * dt; c.outErr += 1.6 * dt; }
          else { c.crc += 2.4 * dt; c.runts += 1.1 * dt; c.inErr += 3.5 * dt; }
        }
      }
    }
  }

  /** PVST+ PVID-inconsistency syslog: entering the state on BPDU receipt, leaving it when the native VLANs match. */
  pvidLogs(silent = false) {
    const s = this.s;
    const now = {};
    for (const [key, inc] of this.pvid || []) now[key] = { local: inc.local, peer: inc.peer, vlans: [...inc.vlans] };
    const prev = s.pvidMemo || {};
    const vl = v => `VLAN${String(v).padStart(4, '0')}`;
    if (!silent) {
      for (const [key, inc] of Object.entries(now)) {
        const [devId, port] = key.split('|');
        const d = s.devices[devId];
        const fresh = inc.vlans.filter(v => !(prev[key]?.vlans || []).includes(v));
        if (!fresh.length) continue;
        this.syslog(d, '%SPANTREE-2-RECV_PVID_ERR', `Received BPDU with inconsistent peer vlan id ${inc.peer} on ${longIf(port)} VLAN${inc.local}.`);
        if (fresh.includes(inc.peer)) this.syslog(d, '%SPANTREE-2-BLOCK_PVID_PEER', `Blocking ${longIf(port)} on ${vl(inc.peer)}. Inconsistent peer vlan.`);
        if (fresh.includes(inc.local)) this.syslog(d, '%SPANTREE-2-BLOCK_PVID_LOCAL', `Blocking ${longIf(port)} on ${vl(inc.local)}. Inconsistent local vlan.`);
      }
      for (const [key, old] of Object.entries(prev)) {
        const [devId, port] = key.split('|');
        if (!this.portUp(devId, port)) continue; // link went down: no BPDUs, nothing to report
        for (const v of old.vlans) if (!(now[key]?.vlans || []).includes(v)) this.syslog(s.devices[devId], '%SPANTREE-2-UNBLOCK_CONSIST_PORT', `Unblocking ${longIf(port)} on ${vl(v)}. Port consistency restored.`);
      }
    }
    s.pvidMemo = now;
  }

  /** Log immediately when a new VLAN starts looping (switches notice MAC flapping within seconds). */
  checkStormOnset() {
    const now = [...this.storms().keys()].sort().join(',');
    if (now !== (this.s.stormMemo ?? '')) {
      const prev = new Set((this.s.stormMemo || '').split(',').filter(Boolean));
      this.s.stormMemo = now;
      if ([...this.storms().keys()].some(v => !prev.has(String(v)))) this.stormLogs();
    }
  }

  stormLogs() {
    const s = this.s;
    for (const [v, links] of this.storms()) {
      const sws = new Map();
      for (const id of links) {
        const l = s.links[id];
        for (const end of [l.a, l.b]) {
          const d = s.devices[end.dev];
          if (d.kind !== 'switch') continue;
          const other = end === l.a ? s.devices[l.b.dev] : s.devices[l.a.dev];
          if (other.kind !== 'switch' && other.kind !== 'bridge') continue;
          if (!sws.has(d.id)) sws.set(d.id, []);
          sws.get(d.id).push(end.port);
        }
      }
      const host = Object.values(s.devices).find(d => d.kind === 'host' && this.hostVlan(d) === v);
      for (const [id, ports] of sws) {
        const uniq = [...new Set(ports)].sort();
        if (uniq.length < 2) continue;
        const mac = host ? macCisco(host.ports[host.nic].mac) : '0000.0c07.ac0a';
        this.syslog(s.devices[id], '%SW_MATM-4-MACFLAP_NOTIF', `Host ${mac} in vlan ${v} is flapping between port ${uniq[0]} and port ${uniq[1]}`);
      }
    }
  }

  cdpLogs() {
    const s = this.s;
    for (const l of Object.values(s.links)) {
      const ls = this.linkStatus(l.id);
      if (!ls.up) continue;
      const da = s.devices[l.a.dev];
      const db = s.devices[l.b.dev];
      if (da.os !== 'ios' || db.os !== 'ios') continue;
      if (ls.mismatch) {
        this.syslog(da, '%CDP-4-DUPLEX_MISMATCH', `duplex mismatch discovered on ${longIf(l.a.port)} (not ${ls.duplexB} duplex), with ${db.hostname} ${longIf(l.b.port)} (${ls.duplexB} duplex).`);
        this.syslog(db, '%CDP-4-DUPLEX_MISMATCH', `duplex mismatch discovered on ${longIf(l.b.port)} (not ${ls.duplexA} duplex), with ${da.hostname} ${longIf(l.a.port)} (${ls.duplexA} duplex).`);
      }
      const pa = da.ports[l.a.port];
      const pb = db.ports[l.b.port];
      if (da.kind === 'switch' && db.kind === 'switch' && pa.mode === 'trunk' && pb.mode === 'trunk' && pa.native !== pb.native) {
        this.syslog(da, '%CDP-4-NATIVE_VLAN_MISMATCH', `Native VLAN mismatch discovered on ${longIf(l.a.port)} (${pa.native}), with ${db.hostname} ${longIf(l.b.port)} (${pb.native}).`);
        this.syslog(db, '%CDP-4-NATIVE_VLAN_MISMATCH', `Native VLAN mismatch discovered on ${longIf(l.b.port)} (${pb.native}), with ${da.hostname} ${longIf(l.a.port)} (${pa.native}).`);
      }
    }
  }

  /** VLAN of the switch access port a host is attached to (null if none). */
  hostVlan(d) {
    const peer = this.peerOf(d.id, d.nic);
    if (!peer) return null;
    const sw = this.s.devices[peer.dev];
    if (sw.kind === 'bridge') {
      const up = Object.values(sw.ports).map(p => this.peerOf(sw.id, p.name)).find(x => x && this.s.devices[x.dev].kind === 'switch');
      if (!up) return null;
      const s2 = this.s.devices[up.dev];
      const pp = s2.ports[up.port];
      return pp.mode === 'access' ? pp.accessVlan : pp.native;
    }
    if (sw.kind !== 'switch') return null;
    const p = sw.ports[peer.port];
    return p.mode === 'access' ? p.accessVlan : p.native;
  }

  // ------------------------------------------------------------ service flows (the "living city")
  evaluateFlows() {
    const s = this.s;
    for (const f of s.flows) {
      const from = s.devices[f.from];
      if (!from || from.powered === false) { s.flowState[f.id] = { ok: false, detail: 'device offline', t: s.t, links: [] }; continue; }
      let ok = false;
      let detail = '';
      let hops = [];
      let degraded = false;
      let metric = null;
      if (f.kind === 'http') {
        const r = httpRequest(this, from, f.url, {});
        ok = r.ok;
        detail = r.ok ? `HTTP ${r.status}` : r.status ? `HTTP ${r.status}` : r.error?.msg || r.stage;
        hops = [...(r.connect?.fwd?.hops || []), ...(r.connect?.rep?.hops || [])];
        degraded = r.ok && r.connect && r.connect.pass < 0.9;
      } else if (f.kind === 'fleet') {
        const n = from.leases.length;
        let reach = 0;
        let sample = null;
        for (const m of from.leases) {
          const r = this.probe({ from: from.id, member: m, dst: f.dst, proto: f.proto || 'tcp', dport: f.port });
          if (!sample) sample = r;
          if (r.status === 'ok' && r.kind === 'syn-ack' && r.pass >= 0.5) reach++;
        }
        ok = reach === from.count;
        detail = `${reach}/${from.count} streaming`;
        metric = { reach, total: from.count, leased: n };
        hops = sample ? [...(sample.fwd?.hops || []), ...(sample.rep?.hops || [])] : [];
      } else if (f.kind === 'voice') {
        const r = this.probe({ from: from.id, dst: f.dst, proto: 'udp', dport: f.port });
        const up = r.status === 'ok' && r.kind === 'udp-reply';
        const loss = up ? (1 - r.pass) * 100 : 100;
        const mos = up ? estimateMos(r.rttMs / 2, r.jitter || 0, loss) : 1;
        metric = { mos, loss, jitter: r.jitter || 0, latency: r.rttMs || 0 };
        ok = up && mos >= 3.6;
        degraded = up && mos < 4.0;
        detail = up ? `MOS ${mos.toFixed(1)} · loss ${loss.toFixed(1)}% · jitter ${(r.jitter || 0).toFixed(0)} ms` : 'no SIP response';
        hops = [...(r.fwd?.hops || []), ...(r.rep?.hops || [])];
      } else {
        const r = this.probe({ from: from.id, dst: f.dst, proto: f.proto || 'icmp', dport: f.port });
        const reach = r.status === 'ok' && (f.proto === 'tcp' ? r.kind === 'syn-ack' : r.kind === 'reply' || r.kind === 'udp-reply');
        ok = f.expect === 'blocked' ? !reach : reach;
        detail = f.expect === 'blocked' ? (reach ? 'EXPOSED: reachable' : 'blocked') : reach ? `${r.rttMs.toFixed(1)} ms` : r.lostReason || r.reason || 'timeout';
        degraded = reach && r.pass < 0.9;
        hops = [...(r.fwd?.hops || []), ...(r.rep?.hops || [])];
      }
      s.flowState[f.id] = { ok, degraded, detail, metric, t: s.t, links: hops.filter(h => h.kind === 'l2').map(h => ({ link: h.link, from: h.from.dev, to: h.to.dev })) };
    }
  }

  // ------------------------------------------------------------ high level checks used by missions
  httpCheck(fromId, url) { this.ensure(); return httpRequest(this, this.s.devices[fromId], url, {}); }

  snapshot() { return JSON.parse(JSON.stringify(this.s)); }
}
