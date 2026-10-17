// ---- ipv6: Cisco IOS IPv6 grammar and handlers (routers). Hooked into ios.js with one call per extension point.
// Commands: ipv6 unicast-routing · interface: ipv6 address X/len [eui-64] | ipv6 address FE80::X link-local |
// ipv6 enable | ipv6 nd ra suppress [all] | ipv6 traffic-filter NAME in|out · ipv6 route P/len {NH | IF [NH]} [AD] ·
// ipv6 access-list NAME (config-ipv6-acl: [sequence N] permit|deny ...) · show ipv6 interface [brief|IF] ·
// show ipv6 route [static|connected|local|ADDR] · show ipv6 neighbors · show ipv6 access-list [NAME] ·
// ping / traceroute to IPv6 addresses (a link-local destination prompts for the output interface, as IOS does).
import { caretLines, tokenize } from './parser.js';
import * as S6 from './ios-show6.js';
import { parseIp6, parseCidr6, fmtIp6Ios, isLinkLocal6, prefix6, overlaps6, fmtCidr6Ios } from '../engine/ipv6.js';
import { canonIf, longIf, parentIf } from '../engine/model.js';
import { l3Ifaces6, ICMP6_NAMES, routerOwns6 } from '../engine/net6.js';

const PORT_NUM = { www: 80, http: 80, https: 443, domain: 53, bootps: 67, bootpc: 68, telnet: 23, smtp: 25, ftp: 21, tftp: 69, ntp: 123, snmp: 161, syslog: 514, pop3: 110, bgp: 179, isakmp: 500, 'dhcpv6-client': 546, 'dhcpv6-server': 547 };
const U = fmtIp6Ios;

export function addIpv6Grammar(g) {
  // "?" help is one string per keyword in this parser: add IPv6 keywords without changing existing IPv4 help.
  const help = {
    ipv6: 'IPv6 configuration commands', 'unicast-routing': 'Enable unicast routing', 'eui-64': 'Use eui-64 interface identifier', 'link-local': 'Use link-local address',
    nd: 'IPv6 interface Neighbor Discovery subcommands', ra: 'Router Advertisement control', suppress: 'Suppress IPv6 Router Advertisements', all: 'Suppress all IPv6 RA',
    'traffic-filter': 'Access control list for packets', sequence: 'Sequence number for this entry', cef: 'Cisco Express Forwarding for IPv6',
    local: 'Local routes', connected: 'Connected', static: 'Static routes', dns: 'Set DNS server for RA', protocols: 'IPv6 Routing Protocols', traffic: 'IPv6 traffic statistics',
  };
  for (const [k, v] of Object.entries(help)) if (!(k in g.help)) g.help[k] = v;
  const ex = ['user', 'exec'];
  g.add(ex, 'show ipv6 interface brief', 'v6-sh-ib');
  g.add(ex, 'show ipv6 interface', 'v6-sh-int');
  g.add(ex, 'show ipv6 interface <IF>', 'v6-sh-int');
  g.add(ex, 'show ipv6 route', 'v6-sh-route');
  g.add(ex, 'show ipv6 route static', 'v6-sh-route');
  g.add(ex, 'show ipv6 route connected', 'v6-sh-route');
  g.add(ex, 'show ipv6 route local', 'v6-sh-route');
  g.add(ex, 'show ipv6 route <IP6:addr>', 'v6-sh-route');
  g.add(ex, 'show ipv6 neighbors', 'v6-sh-nd');
  g.add(ex, 'show ipv6 neighbors <IF>', 'v6-sh-nd');
  g.add(ex, 'show ipv6 access-list', 'v6-sh-acl');
  g.add(ex, 'show ipv6 access-list <WORD:name>', 'v6-sh-acl');
  g.add('exec', 'clear ipv6 neighbors', 'noop');
  g.add('exec', 'clear ipv6 access-list', 'v6-clear-acl');
  g.add(ex, 'ping <IP6:ip6>', 'v6-ping');
  g.add(ex, 'ping ipv6 <IP6:ip6>', 'v6-ping');
  g.add(ex, 'ping <IP6:ip6> source <NH6:src>', 'v6-ping');
  g.add(ex, 'ping ipv6 <IP6:ip6> source <NH6:src>', 'v6-ping');
  g.add(ex, 'traceroute <IP6:ip6>', 'v6-trace');
  g.add(ex, 'traceroute ipv6 <IP6:ip6>', 'v6-trace');
  const unimpl = (modes, template, alt) => g.add(modes, template, 'unimpl', { alt });
  unimpl(ex, 'show ipv6 protocols', 'show ipv6 route (static routes only here)');
  unimpl(ex, 'show ipv6 dhcp pool', 'show ipv6 interface (this network uses SLAAC)');
  unimpl(ex, 'show ipv6 traffic', 'show ipv6 access-list');

  g.add('config', 'ipv6 unicast-routing', 'v6-routing');
  g.add('config', 'no ipv6 unicast-routing', 'v6-routing');
  g.add('config', 'ipv6 cef', 'noop');
  g.add('config', 'ipv6 route <PFX6:pfx> <NH6:nh>', 'v6-route');
  g.add('config', 'ipv6 route <PFX6:pfx> <NH6:nh> <NUM:ad>', 'v6-route');
  g.add('config', 'ipv6 route <PFX6:pfx> <IF:oif> <IP6:nh>', 'v6-route');
  g.add('config', 'ipv6 route <PFX6:pfx> <IF:oif> <IP6:nh> <NUM:ad>', 'v6-route');
  g.add('config', 'no ipv6 route <PFX6:pfx> <NH6:nh>', 'v6-noroute');
  g.add('config', 'no ipv6 route <PFX6:pfx> <IF:oif> <IP6:nh>', 'v6-noroute');
  g.add('config', 'no ipv6 route <PFX6:pfx>', 'v6-noroute');
  g.add(['config', 'acl6', 'acl-ext', 'acl-std'], 'ipv6 access-list <WORD:name>', 'v6-acl');
  g.add('config', 'no ipv6 access-list <WORD:name>', 'v6-noacl');
  unimpl('config', 'ipv6 dhcp pool <WORD:name>', 'SLAAC: ipv6 address <prefix>/64 on the LAN interface');
  g.add('acl6', 'ip access-list extended <WORD:name>', 'acl-ext');
  g.add('acl6', 'ip access-list standard <WORD:name>', 'acl-std');

  g.add('if', 'ipv6 address <PFX6:pfx>', 'v6-addr');
  g.add('if', 'ipv6 address <PFX6:pfx> eui-64', 'v6-addr');
  g.add('if', 'ipv6 address <IP6:ll> link-local', 'v6-addr');
  g.add('if', 'no ipv6 address', 'v6-noaddr');
  g.add('if', 'no ipv6 address <PFX6:pfx>', 'v6-noaddr');
  g.add('if', 'no ipv6 address <PFX6:pfx> eui-64', 'v6-noaddr');
  g.add('if', 'no ipv6 address <IP6:ll> link-local', 'v6-noaddr');
  g.add('if', 'ipv6 enable', 'v6-enable');
  g.add('if', 'no ipv6 enable', 'v6-enable');
  g.add('if', 'ipv6 nd ra suppress', 'v6-ra');
  g.add('if', 'ipv6 nd ra suppress all', 'v6-ra');
  g.add('if', 'no ipv6 nd ra suppress', 'v6-ra');
  g.add('if', 'no ipv6 nd ra suppress all', 'v6-ra');
  g.add('if', 'ipv6 traffic-filter <WORD:acl> in', 'v6-filter');
  g.add('if', 'ipv6 traffic-filter <WORD:acl> out', 'v6-filter');
  g.add('if', 'no ipv6 traffic-filter <WORD:acl> in', 'v6-filter');
  g.add('if', 'no ipv6 traffic-filter <WORD:acl> out', 'v6-filter');
  // Valid on IOS XE 3.9S and later, not simulated: DNS reaches clinic hosts over IPv4 here.
  unimpl('if', 'ipv6 nd ra dns server <LINE:rest>', 'hosts here resolve AAAA records through their DHCPv4 DNS server');
  unimpl('if', 'ipv6 nd other-config-flag', 'this network uses SLAAC only');
  unimpl('if', 'ipv6 nd managed-config-flag', 'this network uses SLAAC only');
  unimpl('if', 'ipv6 dhcp server <LINE:rest>', 'this network uses SLAAC only');

  g.add('acl6', 'permit <LINE:rest>', 'v6-ace');
  g.add('acl6', 'deny <LINE:rest>', 'v6-ace');
  g.add('acl6', 'sequence <NUM:seq> <LINE:rest>', 'v6-ace');
  g.add('acl6', 'remark <LINE:text>', 'v6-remark');
  g.add('acl6', 'no sequence <NUM:seq>', 'v6-ace-del');
  g.add('acl6', 'no permit <LINE:rest>', 'v6-ace-no');
  g.add('acl6', 'no deny <LINE:rest>', 'v6-ace-no');
  g.add('acl6', 'exit', 'sub-exit');
  g.add('acl6', 'end', 'end');
  g.add('acl6', 'do <LINE:cmd>', 'do');
  g.add('acl6', 'interface <IF>', 'interface');
}

// ------------------------------------------------------------------ IPv6 ACE parsing

function parseAddr6(toks, i) {
  const t = toks[i]?.toLowerCase();
  if (t === 'any') return { spec: { any: true }, next: i + 1 };
  if (t === 'host') {
    const a = parseIp6(toks[i + 1] || '');
    if (a === null) return { err: i + 1 };
    return { spec: { addr: a, len: 128 }, next: i + 2 };
  }
  const c = parseCidr6(toks[i] || '');
  if (!c) return { err: i };
  return { spec: { addr: prefix6(c.addr, c.len), len: c.len }, next: i + 1 };
}

function portNum(t) {
  if (t === undefined) return null;
  if (/^\d+$/.test(t)) { const n = Number(t); return n <= 65535 ? n : null; }
  return PORT_NUM[t.toLowerCase()] ?? null;
}

function parsePort(toks, i) {
  const op = toks[i]?.toLowerCase();
  if (!['eq', 'neq', 'lt', 'gt', 'range'].includes(op)) return { spec: null, next: i };
  if (op === 'range') {
    const a = portNum(toks[i + 1]);
    const b = portNum(toks[i + 2]);
    if (a === null) return { err: i + 1 };
    if (b === null) return { err: i + 2 };
    return { spec: { op, ports: [a, b] }, next: i + 3 };
  }
  const p = portNum(toks[i + 1]);
  if (p === null) return { err: i + 1 };
  return { spec: { op, ports: [p] }, next: i + 2 };
}

/** Parse "permit tcp 2001:DB8:42:30::/64 any eq 443 log" (IOS IPv6 ACL entry). Returns { ace } or { errTok }. */
export function parseAce6(toks) {
  const action = toks[0]?.toLowerCase();
  if (!['permit', 'deny'].includes(action)) return { errTok: 0 };
  const proto = toks[1]?.toLowerCase();
  if (!['ipv6', 'tcp', 'udp', 'icmp'].includes(proto)) return { errTok: 1 };
  const s = parseAddr6(toks, 2);
  if (s.err !== undefined) return { errTok: s.err };
  let i = s.next;
  let sop = null;
  let dop = null;
  if (proto === 'tcp' || proto === 'udp') { const sp = parsePort(toks, i); if (sp.err !== undefined) return { errTok: sp.err }; sop = sp.spec; i = sp.next; }
  const d = parseAddr6(toks, i);
  if (d.err !== undefined) return { errTok: d.err };
  i = d.next;
  if (proto === 'tcp' || proto === 'udp') { const dp = parsePort(toks, i); if (dp.err !== undefined) return { errTok: dp.err }; dop = dp.spec; i = dp.next; }
  let icmpType = null;
  if (proto === 'icmp' && toks[i] && ICMP6_NAMES.includes(toks[i].toLowerCase())) { icmpType = toks[i].toLowerCase(); i++; }
  let log = false;
  let established = false;
  for (; i < toks.length; i++) {
    const t = toks[i].toLowerCase();
    if (t === 'log' && !log) log = true;
    else if (t === 'established' && proto === 'tcp' && !established) established = true;
    else return { errTok: i };
  }
  return { ace: { action, proto, src: s.spec, sop, dst: d.spec, dop, icmpType, log, ...(established ? { established } : {}) } };
}

const sameAce = (a, b) => JSON.stringify({ ...a, seq: 0, matches: 0 }) === JSON.stringify({ ...b, seq: 0, matches: 0 });
const nextSeq = acl => (acl.entries.length ? Math.max(...acl.entries.map(e => e.seq)) + 10 : 10);

// ------------------------------------------------------------------ handlers

function v6cfg(t) {
  return (t.ipv6 ||= { enable: false, addrs: [], ll: null, raSuppress: null, filterIn: null, filterOut: null });
}

function ifName(sess) { return sess.ctx.sub || sess.ctx.iface; }

/** Run an IPv6 handler; returns a result, or null if the handler is not an IPv6 one. */
export function runIpv6(handler, ctx, api) {
  if (!handler.startsWith('v6-')) return null;
  const { eng, dev, sess, args } = ctx;
  const L = [];
  const done = (extra = {}) => ({ lines: L, changed: !!ctx.changed, ...extra });
  const note = text => L.push({ t: 'note', text });
  const mut = () => api.mut(ctx);
  const no = /^no\s/i.test(ctx.line);
  switch (handler) {
    // ---------------- show
    case 'v6-sh-ib': L.push(...S6.showIpv6IntBrief(eng, dev)); eng.event({ type: 'show', host: dev.id, what: 'ipv6-interface' }); return done();
    case 'v6-sh-int': L.push(...S6.showIpv6Interface(eng, dev, args.if)); eng.event({ type: 'show', host: dev.id, what: 'ipv6-interface' }); return done();
    case 'v6-sh-route': {
      const only = /\bstatic\s*$/i.test(ctx.line) ? ['S'] : /\bconnected\s*$/i.test(ctx.line) ? ['C'] : /\blocal\s*$/i.test(ctx.line) ? ['L'] : null;
      const r = S6.showIpv6Route(eng, dev, only, args.addr ?? null);
      L.push(...r.lines);
      eng.event({ type: 'show', host: dev.id, what: 'ipv6-route' });
      return done({ meta: { notInstalled: r.notInstalled } });
    }
    case 'v6-sh-nd': { const t = S6.showIpv6Neighbors(eng, dev); L.push(...(args.if ? [t[0], ...t.slice(1).filter(l => l.endsWith(` ${args.if}`))] : t)); return done(); }
    case 'v6-sh-acl': L.push(...S6.showIpv6AccessList(eng, dev, args.name)); eng.event({ type: 'show', host: dev.id, what: 'ipv6-acl' }); return done();
    case 'v6-clear-acl': for (const a of Object.values(dev.acls6 || {})) for (const e of a.entries) delete e.matches; return done();
    case 'v6-ping': return ping6(ctx, L, note, done);
    case 'v6-trace': return trace6(ctx, L, note, done);

    // ---------------- global config
    case 'v6-routing': dev.ipv6Routing = !no; mut(); return done();
    case 'v6-route': {
      const pfx = args.pfx;
      const net = prefix6(pfx.addr, pfx.len);
      let iface = null;
      let nh = null;
      if (args.oif) { iface = args.oif; nh = args.nh; } else if (typeof args.nh === 'string' && args.nh.length === 32 && !/[^0-9a-f]/.test(args.nh)) nh = args.nh; else iface = args.nh;
      if (iface && !dev.ports[parentIf(iface)]) return { lines: caretLines(ctx.prompt, ctx.line, ctx.line.toLowerCase().indexOf(String(iface).toLowerCase().slice(0, 2))) };
      if (nh && isLinkLocal6(nh) && !iface) { L.push('% Interface has to be specified for a link-local nexthop'); return done(); }
      if (nh && routerOwns6(eng, dev, nh)) { L.push('%Invalid next hop address (it\'s this router)'); return done(); }
      const r = { net, len: pfx.len, nh, iface, ad: args.ad ?? 1 };
      dev.routes6 ||= [];
      const exists = dev.routes6.find(x => x.net === r.net && x.len === r.len && x.nh === r.nh && x.iface === r.iface);
      if (exists) { exists.ad = r.ad; return done(); }
      dev.routes6.push(r);
      mut();
      return done();
    }
    case 'v6-noroute': {
      const pfx = args.pfx;
      const net = prefix6(pfx.addr, pfx.len);
      const before = (dev.routes6 || []).length;
      const nhArg = args.oif ? args.nh : args.nh;
      dev.routes6 = (dev.routes6 || []).filter(x => {
        if (x.net !== net || x.len !== pfx.len) return true;
        if (args.oif) return !(x.iface === args.oif && x.nh === args.nh);
        if (nhArg === undefined) return false;
        return !(x.nh === nhArg || (x.iface === nhArg && !x.nh));
      });
      if (dev.routes6.length === before) L.push('%No matching route to delete');
      else mut();
      return done();
    }
    case 'v6-acl': {
      dev.acls6 ||= {};
      if (!dev.acls6[args.name]) { dev.acls6[args.name] = { entries: [] }; mut(); }
      sess.mode = 'acl6';
      sess.ctx = { acl6: args.name };
      return done();
    }
    case 'v6-noacl': if (dev.acls6?.[args.name]) { delete dev.acls6[args.name]; mut(); } return done();
    case 'v6-ace': {
      const acl = dev.acls6[sess.ctx.acl6];
      let text = ctx.line;
      let seq = null;
      const sm = /^sequence\s+(\d+)\s+(.*)$/i.exec(ctx.line);
      if (sm) { seq = Number(sm[1]); text = sm[2]; }
      const toks = tokenize(text).map(t => t.v);
      const r = parseAce6(toks);
      if (r.errTok !== undefined) {
        if (r.errTok >= toks.length) return { lines: ['% Incomplete command.', ''] };
        const base = ctx.line.length - text.length;
        return { lines: caretLines(ctx.prompt, ctx.line, base + tokenize(text)[r.errTok].pos) };
      }
      if (acl.entries.some(e => !e.remark && sameAce(e, r.ace))) return done();
      seq ??= nextSeq(acl);
      if (acl.entries.some(e => e.seq === seq)) { L.push('% Duplicate sequence number'); return done(); }
      acl.entries.push({ seq, ...r.ace });
      acl.entries.sort((a, b) => a.seq - b.seq);
      mut();
      return done();
    }
    case 'v6-remark': { const acl = dev.acls6[sess.ctx.acl6]; acl.entries.push({ seq: nextSeq(acl), remark: args.text }); mut(); return done(); }
    case 'v6-ace-del': { const acl = dev.acls6[sess.ctx.acl6]; const n = acl.entries.length; acl.entries = acl.entries.filter(e => e.seq !== args.seq); if (n !== acl.entries.length) mut(); return done(); }
    case 'v6-ace-no': {
      const acl = dev.acls6[sess.ctx.acl6];
      const r = parseAce6(tokenize(ctx.line.replace(/^no\s+/i, '')).map(t => t.v));
      if (!r.ace) return { lines: ['% Invalid access list entry'] };
      const n = acl.entries.length;
      acl.entries = acl.entries.filter(e => e.remark || !sameAce(e, r.ace));
      if (n !== acl.entries.length) mut();
      return done();
    }

    // ---------------- interface
    case 'v6-addr': {
      const t = api.ifTarget(ctx);
      if (!t) return { lines: ['% IPv6 is configured on routed interfaces'] };
      if (sess.ctx.sub && t.vlan === null) { L.push('% Configuring IPv6 on a LAN subinterface is only allowed if that', 'subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,', 'or ISL vLAN.'); return done(); }
      const v = v6cfg(t);
      if (args.ll !== undefined) {
        if (!isLinkLocal6(args.ll)) { L.push(`% ${U(args.ll)} is not a link-local address`); return done(); }
        v.ll = args.ll;
        mut();
        return done();
      }
      const eui = /\beui-64\s*$/i.test(ctx.line);
      const { addr, len } = args.pfx;
      if (isLinkLocal6(addr)) { L.push(`% ${U(addr)} is a link-local address; use the link-local keyword`); return done(); }
      if (eui && len > 64) { L.push('% Invalid prefix length for an EUI-64 address (must be /64 or shorter)'); return done(); }
      const name = ifName(sess);
      for (const other of l3Ifaces6(eng, dev)) {
        if (other.name === name) continue;
        const clash = other.addrs.find(a => overlaps6(addr, len, a.addr, a.len));
        if (clash) { L.push(`% ${fmtCidr6Ios(addr, len)} overlaps with ${longIf(other.name)}`); return done(); }
      }
      const entry = eui ? { addr: prefix6(addr, len), len, eui: true } : { addr, len, eui: false };
      if (!v.addrs.some(a => a.addr === entry.addr && a.len === entry.len && !!a.eui === entry.eui)) v.addrs.push(entry);
      mut();
      return done();
    }
    case 'v6-noaddr': {
      const t = api.ifTarget(ctx);
      if (!t?.ipv6) return done();
      const v = t.ipv6;
      if (args.ll !== undefined) { if (v.ll === args.ll) v.ll = null; }
      else if (args.pfx) {
        const eui = /\beui-64\s*$/i.test(ctx.line);
        v.addrs = v.addrs.filter(a => !(a.len === args.pfx.len && (eui ? a.eui && a.addr === prefix6(args.pfx.addr, args.pfx.len) : !a.eui && a.addr === args.pfx.addr)));
      } else { v.addrs = []; v.ll = null; }
      mut();
      return done();
    }
    case 'v6-enable': { const t = api.ifTarget(ctx); if (!t) return done(); v6cfg(t).enable = !no; mut(); return done(); }
    case 'v6-ra': {
      const t = api.ifTarget(ctx);
      if (!t) return done();
      v6cfg(t).raSuppress = no ? null : /\ball\s*$/i.test(ctx.line) ? 'all' : 'periodic';
      mut();
      return done();
    }
    case 'v6-filter': {
      const t = api.ifTarget(ctx);
      if (!t) return done();
      const dir = /\bout\s*$/i.test(ctx.line) ? 'filterOut' : 'filterIn';
      const v = v6cfg(t);
      if (no) { if (v[dir] === args.acl) v[dir] = null; } else v[dir] = args.acl;
      mut();
      return done();
    }
    default:
      L.push(`% Command not implemented in this training image: ${ctx.line}`);
      return done();
  }
}

// ------------------------------------------------------------------ ping / traceroute

function srcFor(eng, dev, src) {
  if (src === undefined) return { ok: true };
  const ifs = l3Ifaces6(eng, dev).filter(i => i.up);
  if (typeof src === 'string' && src.length === 32 && !/[^0-9a-f]/.test(src)) {
    if (!ifs.some(i => i.ll === src || i.addrs.some(a => a.addr === src))) return { ok: false, msg: '% Invalid source address- IPv6 address not on any of our up interfaces' };
    return { ok: true, srcIp: src };
  }
  const i = ifs.find(x => x.name === src);
  if (!i) return { ok: false, msg: '% Invalid source interface - IPv6 not enabled or interface is down' };
  return { ok: true, srcIp: i.addrs[0]?.addr ?? i.ll };
}

function ping6(ctx, L, note, done) {
  const { eng, dev, sess, args } = ctx;
  const dst = args.ip6;
  const s = srcFor(eng, dev, args.src);
  if (!s.ok) { L.push(s.msg); return done(); }
  if (isLinkLocal6(dst) && !ctx.oif) {
    // IOS asks which interface a link-local destination is on.
    sess.pending = { kind: 'ping6-oif', line: ctx.line, dst, src: args.src };
    L.push('Output Interface: ');
    return done();
  }
  return runPing6(eng, dev, dst, s.srcIp, ctx.oif ?? null, L, done);
}

/** The answer to IOS's "Output Interface:" prompt. */
export function answerPending(eng, dev, sess, line) {
  const p = sess.pending;
  sess.pending = null;
  const L = [];
  const done = (extra = {}) => ({ lines: L, ...extra });
  const oif = canonIf(line.trim());
  const ifc = oif && l3Ifaces6(eng, dev).find(i => i.name === oif && i.up);
  if (!ifc) { L.push('% Invalid interface. Use full interface name without spaces (e.g. Serial0/1)'); return done(); }
  const s = srcFor(eng, dev, p.src);
  return runPing6(eng, dev, p.dst, s.srcIp, oif, L, done);
}

function runPing6(eng, dev, dst, srcIp, oif, L, done) {
  L.push('Type escape sequence to abort.', `Sending 5, 100-byte ICMP Echos to ${U(dst)}, timeout is 2 seconds:`);
  if (srcIp !== undefined) L.push(`Packet sent with a source address of ${U(srcIp)}${oif ? `%${longIf(oif)}` : ''}`);
  let marks = '';
  let ok = 0;
  const rtts = [];
  for (let i = 0; i < 5; i++) {
    const r = eng.probe({ from: dev.id, dst, proto: 'icmp', record: true, srcIp, oif });
    if (r.status === 'local-error' && r.reason === 'no-route') { L.push('% No valid route for destination', 'Success rate is 0 percent (0/1)'); eng.event({ type: 'ping', host: dev.id, ip: dst, ok: false, v6: true }); return done(); }
    if (r.status === 'ok' && r.kind === 'reply' && eng.rand() < r.pass) { marks += '!'; ok++; rtts.push(Math.max(1, Math.round(r.rttMs + eng.rand() * (r.jitter || 0.2)))); }
    else if (r.status === 'ok' && /unreachable/.test(r.kind)) marks += 'U';
    else if (r.status === 'ok' && r.kind === 'ttl-exceeded') marks += '&';
    else marks += '.';
  }
  L.push(marks, `Success rate is ${ok * 20} percent (${ok}/5)${ok ? `, round-trip min/avg/max = ${Math.min(...rtts)}/${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}/${Math.max(...rtts)} ms` : ''}`);
  eng.event({ type: 'ping', host: dev.id, ip: dst, ok: ok > 0, v6: true });
  return done();
}

function trace6(ctx, L, note, done) {
  const { eng, dev, args } = ctx;
  const dst = args.ip6;
  L.push('Type escape sequence to abort.', `Tracing the route to ${U(dst)}`, '');
  for (let ttl = 1; ttl <= 30; ttl++) {
    const r = eng.probe({ from: dev.id, dst, proto: 'udp', dport: 33434 + ttl, ttl, record: true });
    if (r.status === 'local-error') { L.push('% No valid route for destination'); break; }
    if (r.status !== 'ok') {
      L.push(`  ${ttl} *  *  * `);
      if (ttl >= 3 && L.slice(-3).every(x => /\*  \*  \*/.test(x))) { note('(trainer: remaining hops also time out; output shortened)'); break; }
      continue;
    }
    const ms = () => Math.max(1, Math.round(r.rttMs + eng.rand()));
    const flag = r.kind === 'net-unreachable' ? ' !N' : r.kind === 'addr-unreachable' ? ' !H' : r.kind === 'scope-unreachable' ? ' !S' : '';
    L.push(`  ${ttl} ${U(r.responderIp)} ${ms()} msec${flag} ${ms()} msec${flag} ${ms()} msec${flag}`);
    if (r.kind !== 'ttl-exceeded') break;
  }
  eng.event({ type: 'trace', host: dev.id, ip: dst, v6: true });
  return done();
}
