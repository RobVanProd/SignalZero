// ---- ospf (Act II): IOS grammar, handlers and show renderers for OSPFv2, vty lines and the SSH client.
// Output layouts follow IOS 15 captures (see docs/topics/ospf.md, "Output wording sources").
import { caretLines, tokenize } from './parser.js';
import { fmtIp, wildcardMatch } from '../engine/ipv4.js';
import { longIf, parentIf } from '../engine/model.js';
import { l3Ifaces } from '../engine/routing.js';
import { ospfIfaces, ospfNeighbors, ospfInterfaceState, ospfDatabase, rtOf, ospfClearProcess, areaLabel, attachedAreas, isAbr, lsaChecksum, ifBandwidth, OSPF_AD, newOspfProcess, sortNetworks } from '../engine/ospf.js';
import { sshConnect } from './ssh.js';

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const p2 = n => String(n).padStart(2, '0');
const hms = sec => { const s = Math.max(0, Math.floor(sec)); return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`; };

/** IOS route/entry age: hh:mm:ss under a day, then 1d02h, then 2w3d. */
export function fmtRouteAge(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 86400) return hms(s);
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d${p2(Math.floor((s % 86400) / 3600))}h`;
  return `${Math.floor(d / 7)}w${d % 7}d`;
}

// ------------------------------------------------------------------ grammar

export function addOspfGrammar(g) {
  g.kwHelp({
    ospf: 'OSPF information', neighbor: 'Neighbor list', database: 'Database summary', protocols: 'IP routing protocol process parameters and statistics',
    router: 'Enable a routing process', 'router-id': 'router-id for this OSPF process', network: 'Enable routing on an IP network', area: 'Set the OSPF area ID',
    'passive-interface': 'Suppress routing updates on an interface', 'auto-cost': 'Calculate OSPF interface cost according to bandwidth',
    'reference-bandwidth': 'Use reference bandwidth method to assign OSPF cost', 'default-information': 'Control distribution of default information',
    originate: 'Distribute a default route', always: 'Always advertise default route', 'log-adjacency-changes': 'Log changes in adjacency state', detail: 'Log all state changes',
    'hello-interval': 'Time between HELLO packets', 'dead-interval': 'Interval after which a neighbor is declared dead', cost: 'Interface cost', priority: 'Router priority',
    'point-to-point': 'Specify OSPF point-to-point network', broadcast: 'Specify OSPF broadcast multi-access network', 'mtu-ignore': 'Ignores the MTU in DBD packets',
    mtu: 'Set IP Maximum Transmission Unit', bandwidth: 'Set bandwidth informational parameter', process: 'Reset OSPF process', debug: 'Debugging functions (see also \'undebug\')',
    undebug: 'Disable debugging functions (see also \'debug\')', hello: 'OSPF hello events', adj: 'OSPF adjacency events', debugging: 'State of each debugging option',
    ssh: 'Open a secure shell client connection', line: 'Configure a terminal line', vty: 'Virtual terminal', 'access-class': 'Filter connections based on an IP access list',
    transport: 'Define transport protocols for line', input: 'Define which protocols to use when connecting to the terminal server', default: 'Set a command to its defaults',
    authentication: 'Enable authentication', 'message-digest': 'Use message-digest authentication', redistribute: 'Redistribute information from another routing protocol',
  });
  const ex = ['user', 'exec'];
  g.add(ex, 'show ip ospf', 'ospf-sh');
  g.add(ex, 'show ip ospf neighbor', 'ospf-sh-nbr');
  g.add(ex, 'show ip ospf neighbor <IF>', 'ospf-sh-nbr');
  g.add(ex, 'show ip ospf interface', 'ospf-sh-if');
  g.add(ex, 'show ip ospf interface brief', 'ospf-sh-ifb');
  g.add(ex, 'show ip ospf interface <IF>', 'ospf-sh-if');
  g.add(ex, 'show ip ospf database', 'ospf-sh-db');
  for (const v of ['router', 'network', 'summary', 'external', 'asbr-summary']) g.add(ex, `show ip ospf database ${v}`, 'unimpl', { alt: 'show ip ospf database' });
  g.add(ex, 'show ip ospf neighbor detail', 'unimpl', { alt: 'show ip ospf neighbor' });
  g.add(ex, 'show ip route ospf', 'sh-route');
  g.add(ex, 'show ip protocols', 'ospf-sh-proto');
  g.add('exec', 'clear ip ospf process', 'ospf-clear');
  g.add('exec', 'debug ip ospf hello', 'ospf-debug');
  g.add('exec', 'debug ip ospf adj', 'ospf-debug');
  g.add('exec', 'no debug ip ospf hello', 'ospf-undebug');
  g.add('exec', 'no debug ip ospf adj', 'ospf-undebug');
  g.add('exec', 'undebug ip ospf hello', 'ospf-undebug');
  g.add('exec', 'undebug ip ospf adj', 'ospf-undebug');
  g.add('exec', 'undebug all', 'ospf-undebug-all');
  g.add('exec', 'no debug all', 'ospf-undebug-all');
  g.add('exec', 'show debugging', 'sh-debug');
  // SSH client (user and privileged EXEC)
  g.add(ex, 'ssh -l <WORD:user> <WORD:host>', 'ssh');
  g.add(ex, 'ssh -v <NUM:ver> -l <WORD:user> <WORD:host>', 'ssh');
  g.add(ex, 'ssh <WORD:host>', 'ssh-nouser');
  // global config
  const sub = ['config', 'router-ospf', 'line'];
  g.add([...sub, 'if'], 'router ospf <NUM:pid>', 'ospf-router');
  g.add(sub, 'no router ospf <NUM:pid>', 'ospf-norouter');
  g.add(['router-ospf', 'line'], 'end', 'end');
  g.add(['router-ospf', 'line'], 'exit', 'sub-exit');
  g.add(['router-ospf', 'line'], 'do <LINE:cmd>', 'do');
  g.add(['router-ospf', 'line'], 'interface <IF>', 'interface');
  g.add([...sub, 'if'], 'line vty <NUM:a> <NUM:b>', 'line');
  g.add([...sub, 'if'], 'line con 0', 'line');
  g.add('config', 'ip ssh version 2', 'noop');
  g.add('config', 'ip domain name <WORD:dom>', 'noop');
  g.add('config', 'ip domain-name <WORD:dom>', 'noop');
  // router ospf
  const ro = 'router-ospf';
  g.add(ro, 'router-id <IP>', 'ospf-rid');
  g.add(ro, 'no router-id', 'ospf-norid');
  g.add(ro, 'no router-id <IP>', 'ospf-norid');
  g.add(ro, 'network <IP:addr> <WILD:wild> area <AREA:area>', 'ospf-net');
  g.add(ro, 'no network <IP:addr> <WILD:wild> area <AREA:area>', 'ospf-nonet');
  g.add(ro, 'passive-interface <IF>', 'ospf-passive');
  g.add(ro, 'passive-interface default', 'ospf-passive-default');
  g.add(ro, 'no passive-interface <IF>', 'ospf-nopassive');
  g.add(ro, 'no passive-interface default', 'ospf-nopassive-default');
  g.add(ro, 'auto-cost reference-bandwidth <NUM:ref>', 'ospf-refbw');
  g.add(ro, 'no auto-cost reference-bandwidth', 'ospf-norefbw');
  g.add(ro, 'no auto-cost', 'ospf-norefbw');
  g.add(ro, 'default-information originate', 'ospf-definfo');
  g.add(ro, 'default-information originate always', 'ospf-definfo');
  g.add(ro, 'no default-information originate', 'ospf-nodefinfo');
  g.add(ro, 'log-adjacency-changes', 'ospf-logadj');
  g.add(ro, 'log-adjacency-changes detail', 'ospf-logadj');
  g.add(ro, 'no log-adjacency-changes', 'ospf-logadj');
  g.add(ro, 'no log-adjacency-changes detail', 'ospf-logadj');
  g.add(ro, 'area <AREA:area> authentication', 'unimpl', { alt: 'match area, hello/dead timers and subnet; OSPF authentication is not simulated in this image' });
  g.add(ro, 'area <AREA:area> authentication message-digest', 'unimpl', { alt: 'OSPF authentication is not simulated in this image' });
  g.add(ro, 'redistribute static subnets', 'unimpl', { alt: 'default-information originate (only the default route can be injected here)' });
  g.add(ro, 'redistribute connected subnets', 'unimpl', { alt: 'network ... area ... (advertise connected subnets with network statements)' });
  g.add(ro, 'maximum-paths <NUM:n>', 'unimpl', { alt: 'equal-cost multipath is not simulated' });
  // interface
  const ifm = 'if';
  g.add(ifm, 'ip ospf cost <NUM:v>', 'ospf-if-cost');
  g.add(ifm, 'no ip ospf cost', 'ospf-if-cost');
  g.add(ifm, 'ip ospf hello-interval <NUM:v>', 'ospf-if-hello');
  g.add(ifm, 'no ip ospf hello-interval', 'ospf-if-hello');
  g.add(ifm, 'ip ospf dead-interval <NUM:v>', 'ospf-if-dead');
  g.add(ifm, 'no ip ospf dead-interval', 'ospf-if-dead');
  g.add(ifm, 'ip ospf network point-to-point', 'ospf-if-net');
  g.add(ifm, 'ip ospf network broadcast', 'ospf-if-net');
  g.add(ifm, 'no ip ospf network', 'ospf-if-net');
  g.add(ifm, 'ip ospf priority <NUM:v>', 'ospf-if-pri');
  g.add(ifm, 'no ip ospf priority', 'ospf-if-pri');
  g.add(ifm, 'ip ospf <NUM:pid> area <AREA:area>', 'ospf-if-area');
  g.add(ifm, 'no ip ospf <NUM:pid> area <AREA:area>', 'ospf-if-noarea');
  g.add(ifm, 'no ip ospf <NUM:pid> area', 'ospf-if-noarea');
  g.add(ifm, 'ip ospf mtu-ignore', 'ospf-if-mtuign');
  g.add(ifm, 'no ip ospf mtu-ignore', 'ospf-if-mtuign');
  g.add(ifm, 'ip mtu <NUM:v>', 'if-ipmtu');
  g.add(ifm, 'no ip mtu', 'if-ipmtu');
  g.add(ifm, 'bandwidth <NUM:v>', 'if-bw');
  g.add(ifm, 'no bandwidth', 'if-bw');
  g.add(ifm, 'ip ospf authentication', 'unimpl', { alt: 'OSPF authentication is not simulated in this image' });
  g.add(ifm, 'ip ospf authentication message-digest', 'unimpl', { alt: 'OSPF authentication is not simulated in this image' });
  g.add(ifm, 'ip ospf authentication-key <WORD:k>', 'unimpl', { alt: 'OSPF authentication is not simulated in this image' });
  g.add(ifm, 'ip ospf message-digest-key <NUM:id> md5 <WORD:k>', 'unimpl', { alt: 'OSPF authentication is not simulated in this image' });
  // line vty / con
  g.add('line', 'access-class <WORD:acl> in', 'vty-acl');
  g.add('line', 'no access-class <WORD:acl> in', 'vty-noacl');
  for (const tr of ['ssh', 'telnet', 'all', 'none', 'telnet ssh', 'ssh telnet']) g.add('line', `transport input ${tr}`, 'vty-transport');
  g.add('line', 'login local', 'noop');
  g.add('line', 'login', 'noop');
  g.add('line', 'logging synchronous', 'noop');
  g.add('line', 'exec-timeout <NUM:m> <NUM:s>', 'noop');
  return g;
}

// ------------------------------------------------------------------ helpers

function ifCfg(dev, sess) {
  if (sess.ctx.sub) return dev.subifs[sess.ctx.sub];
  return dev.ports[sess.ctx.iface];
}

function mut(ctx) {
  ctx.eng.mutated(`${ctx.dev.hostname}: ${ctx.line}`);
  ctx.changed = true;
}

/** Caret under the token holding `value` (for out-of-range numbers). */
function caretAt(ctx, value) {
  const toks = tokenize(ctx.line);
  const t = [...toks].reverse().find(x => x.v === String(value)) || toks[toks.length - 1];
  return { lines: caretLines(ctx.prompt, ctx.line, t ? t.pos : 0) };
}

function inRange(v, a, b) { return Number.isInteger(v) && v >= a && v <= b; }

const newProcess = newOspfProcess;
const wildBits = w => { let c = 0; for (let x = w >>> 0; x; x >>>= 1) c += x & 1; return c; };
const sortNets = sortNetworks;

/** Does interface `name` exist on this router (port or subinterface)? */
function hasIf(dev, name) { return !!(dev.ports[name] && dev.ports[name].kind !== 'console') || !!dev.subifs?.[name]; }

// ------------------------------------------------------------------ handlers

/** Returns a CLI result for OSPF/SSH/vty handlers, or null when the handler is not ours. */
export function ospfHandle(handler, ctx) {
  const { eng, dev, sess, args } = ctx;
  const L = [];
  const note = text => L.push({ t: 'note', text });
  const done = (extra = {}) => ({ lines: L, changed: !!ctx.changed, ...extra });
  const o = dev.ospf;
  const no = /^no\s/i.test(ctx.line);
  switch (handler) {
    // ---- exec
    case 'ospf-sh': L.push(...showIpOspf(eng, dev)); return done();
    case 'ospf-sh-nbr': L.push(...showIpOspfNeighbor(eng, dev, args.if)); eng.event({ type: 'show', host: dev.id, what: 'ospf-neighbor' }); return done();
    case 'ospf-sh-ifb': L.push(...showIpOspfInterfaceBrief(eng, dev)); return done();
    case 'ospf-sh-if': L.push(...showIpOspfInterface(eng, dev, args.if)); eng.event({ type: 'show', host: dev.id, what: 'ospf-interface', iface: args.if ?? null }); return done();
    case 'ospf-sh-db': L.push(...showIpOspfDatabase(eng, dev)); return done();
    case 'ospf-sh-proto': L.push(...showIpProtocols(eng, dev)); return done();
    case 'ospf-clear': {
      if (!o || !rtOf(eng, dev)) return done();
      sess.confirm = { kind: 'ospf-clear', prompt: 'Reset ALL OSPF processes? [no]:' };
      return done();
    }
    case 'ospf-debug': {
      dev.debug ||= {};
      const hello = /hello\s*$/i.test(ctx.line);
      dev.debug[hello ? 'ospfHello' : 'ospfAdj'] = true;
      L.push(hello ? 'OSPF hello events debugging is on' : 'OSPF adjacency events debugging is on');
      note('trainer: debug output goes to the logging buffer in this image: read it with "show logging". Turn it off with "undebug all".');
      return done();
    }
    case 'ospf-undebug': {
      dev.debug ||= {};
      const hello = /hello\s*$/i.test(ctx.line);
      dev.debug[hello ? 'ospfHello' : 'ospfAdj'] = false;
      L.push(hello ? 'OSPF hello events debugging is off' : 'OSPF adjacency events debugging is off');
      return done();
    }
    case 'ospf-undebug-all': dev.debug = {}; L.push('All possible debugging has been turned off'); return done();
    case 'sh-debug': {
      const on = [dev.debug?.ospfHello && '  OSPF hello events debugging is on', dev.debug?.ospfAdj && '  OSPF adjacency events debugging is on'].filter(Boolean);
      if (on.length) L.push('IP routing:', ...on);
      return done();
    }
    case 'ssh': {
      if (args.ver !== undefined && args.ver !== 1 && args.ver !== 2) return caretAt(ctx, args.ver);
      const r = sshConnect(eng, dev, { user: args.user, host: args.host, client: 'ios' });
      return { lines: r.lines, changed: false, ...(r.ok ? { sshOpen: r.open } : {}) };
    }
    case 'ssh-nouser': note('training image: give the user name with -l, for example "ssh -l admin 172.16.42.2".'); return done();

    // ---- global config
    case 'ospf-router': {
      if (!inRange(args.pid, 1, 65535)) return caretAt(ctx, args.pid);
      if (o && o.pid !== args.pid) { note(`training image: one OSPF process per router is simulated; this router already runs "router ospf ${o.pid}".`); return done(); }
      if (!o) { dev.ospf = newProcess(args.pid); mut(ctx); }
      sess.mode = 'router-ospf';
      sess.ctx = { pid: args.pid };
      return done();
    }
    case 'ospf-norouter': {
      if (o && o.pid === args.pid) { delete dev.ospf; mut(ctx); }
      return done();
    }
    case 'line': {
      const con = /\bcon\b/i.test(ctx.line);
      if (!con && (!inRange(args.a, 0, 15) || !inRange(args.b, args.a, 15))) return caretAt(ctx, !inRange(args.a, 0, 15) ? args.a : args.b);
      sess.mode = 'line';
      sess.ctx = { line: con ? 'con' : 'vty' };
      return done();
    }
    case 'vty-acl': case 'vty-noacl': {
      if (sess.ctx.line !== 'vty') { note('training image: access-class is simulated on the vty lines only.'); return done(); }
      dev.vty ||= { acl: null, transport: ['ssh'] };
      if (handler === 'vty-acl') dev.vty.acl = args.acl;
      else if (dev.vty.acl === args.acl) dev.vty.acl = null;
      mut(ctx);
      return done();
    }
    case 'vty-transport': {
      if (sess.ctx.line !== 'vty') return done();
      const w = ctx.line.split(/\s+/).slice(2).map(x => x.toLowerCase());
      dev.vty ||= { acl: null, transport: ['ssh'] };
      dev.vty.transport = w.includes('all') ? ['ssh', 'telnet'] : w.includes('none') ? [] : w;
      mut(ctx);
      return done();
    }

    // ---- router ospf
    case 'ospf-rid': {
      o.rid = args.ip;
      mut(ctx);
      if (rtOf(eng, dev)?.ridPending) L.push('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect');
      return done();
    }
    case 'ospf-norid': {
      const had = o.rid !== null;
      o.rid = null;
      if (had) mut(ctx);
      const rt = rtOf(eng, dev);
      if (had && rt && Object.values(rt.ifs).some(st => Object.keys(st.nbrs).length)) L.push('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect');
      return done();
    }
    case 'ospf-net': {
      const wild = args.wild >>> 0;
      const addr = (args.addr & ~wild) >>> 0;
      const area = args.area;
      const same = o.nets.find(n => n.addr === addr && n.wild === wild);
      // a statement that narrows an existing one into another area moves those interfaces (IOS logs AREACHG)
      const cover = sortNets([...o.nets]).filter(n => n !== same && wildcardMatch(addr, n.addr, n.wild) && wildBits(n.wild) >= wildBits(wild))[0];
      const from = same ?? cover;
      const old = from ? { area: from.area, text: from.text } : null;
      if (same) { if (same.area === area.area) return done(); same.area = area.area; same.text = area.text; }
      else o.nets.push({ addr, wild, area: area.area, text: area.text });
      sortNets(o.nets);
      if (old && old.area !== area.area) eng.syslog(dev, '%OSPF-6-AREACHG', `${fmtIp(addr)} ${fmtIp(~wild >>> 0)} changed from area ${old.text} to area ${area.text}`);
      mut(ctx);
      return done();
    }
    case 'ospf-nonet': {
      const wild = args.wild >>> 0;
      const addr = (args.addr & ~wild) >>> 0;
      const before = o.nets.length;
      o.nets = o.nets.filter(n => !(n.addr === addr && n.wild === wild && n.area === args.area.area));
      if (o.nets.length !== before) mut(ctx);
      return done();
    }
    case 'ospf-passive': case 'ospf-nopassive': {
      if (!hasIf(dev, args.if)) return { lines: caretLines(ctx.prompt, ctx.line, ctx.line.toLowerCase().lastIndexOf(' ') + 1) };
      const passive = handler === 'ospf-passive';
      if (o.passiveDefault) o.active = passive ? o.active.filter(n => n !== args.if) : [...new Set([...o.active, args.if])];
      else o.passive = passive ? [...new Set([...o.passive, args.if])] : o.passive.filter(n => n !== args.if);
      mut(ctx);
      return done();
    }
    case 'ospf-passive-default': case 'ospf-nopassive-default': {
      o.passiveDefault = handler === 'ospf-passive-default';
      o.passive = [];
      o.active = [];
      mut(ctx);
      return done();
    }
    case 'ospf-refbw': case 'ospf-norefbw': {
      if (handler === 'ospf-refbw' && !inRange(args.ref, 1, 4294967)) return caretAt(ctx, args.ref);
      o.refBw = handler === 'ospf-refbw' ? args.ref : 100;
      L.push('% OSPF: Reference bandwidth is changed.', '        Please ensure reference bandwidth is consistent across all routers');
      mut(ctx);
      return done();
    }
    case 'ospf-definfo': o.defInfo = { always: /always\s*$/i.test(ctx.line) }; mut(ctx); return done();
    case 'ospf-nodefinfo': o.defInfo = null; mut(ctx); return done();
    case 'ospf-logadj': {
      const detail = /detail\s*$/i.test(ctx.line);
      if (no) { o.logDetail = false; if (!detail) o.logOff = true; } else { o.logDetail = detail; o.logOff = false; }
      mut(ctx);
      return done();
    }

    // ---- interface
    case 'ospf-if-cost': case 'ospf-if-hello': case 'ospf-if-dead': case 'ospf-if-pri': {
      if (sess.ctx.range) return done();
      const c = ifCfg(dev, sess);
      const field = { 'ospf-if-cost': 'cost', 'ospf-if-hello': 'hello', 'ospf-if-dead': 'dead', 'ospf-if-pri': 'pri' }[handler];
      if (!no) {
        const [a, b] = field === 'pri' ? [0, 255] : [1, 65535];
        if (!inRange(args.v, a, b)) return caretAt(ctx, args.v);
      }
      c.ospf ||= {};
      if (no) delete c.ospf[field];
      else c.ospf[field] = args.v;
      mut(ctx);
      return done();
    }
    case 'ospf-if-net': {
      const c = ifCfg(dev, sess);
      c.ospf ||= {};
      if (no || /broadcast\s*$/i.test(ctx.line)) delete c.ospf.net;
      else c.ospf.net = 'point-to-point';
      mut(ctx);
      return done();
    }
    case 'ospf-if-area': {
      if (!inRange(args.pid, 1, 65535)) return caretAt(ctx, args.pid);
      const c = ifCfg(dev, sess);
      c.ospf ||= {};
      c.ospf.area = { pid: args.pid, area: args.area.area, text: args.area.text };
      // IOS starts the process when an interface names it
      if (!dev.ospf) dev.ospf = newProcess(args.pid);
      mut(ctx);
      return done();
    }
    case 'ospf-if-noarea': {
      const c = ifCfg(dev, sess);
      if (c.ospf?.area && c.ospf.area.pid === args.pid) { delete c.ospf.area; mut(ctx); }
      return done();
    }
    case 'ospf-if-mtuign': { const c = ifCfg(dev, sess); c.ospf ||= {}; c.ospf.mtuIgnore = !no; mut(ctx); return done(); }
    case 'if-ipmtu': {
      const c = ifCfg(dev, sess);
      if (!no && !inRange(args.v, 68, 1500)) return caretAt(ctx, args.v);
      if (no) delete c.mtu; else c.mtu = args.v;
      mut(ctx);
      return done();
    }
    case 'if-bw': {
      const c = ifCfg(dev, sess);
      if (!no && !inRange(args.v, 1, 10000000)) return caretAt(ctx, args.v);
      if (no) delete c.bw; else c.bw = args.v;
      mut(ctx);
      return done();
    }
    default: return null;
  }
}

/** Answer to a pending [confirm]-style question (clear ip ospf process). */
export function confirmAnswer(eng, dev, sess, line) {
  const c = sess.confirm;
  sess.confirm = null;
  if (c.kind === 'ospf-clear' && /^\s*y(es)?\s*$/i.test(line)) {
    ospfClearProcess(eng, dev);
    eng.mutated(`${dev.hostname}: clear ip ospf process`);
    return { lines: [], changed: true };
  }
  return { lines: [] };
}

// ------------------------------------------------------------------ running-config

/** Interface-level lines (inserted into the interface block by ios-show.js). */
export function ospfInterfaceLines(c) {
  const out = [];
  const o = c.ospf || {};
  if (o.net) out.push(` ip ospf network ${o.net}`);
  if (o.hello !== undefined) out.push(` ip ospf hello-interval ${o.hello}`);
  if (o.dead !== undefined) out.push(` ip ospf dead-interval ${o.dead}`);
  if (o.pri !== undefined) out.push(` ip ospf priority ${o.pri}`);
  if (o.cost !== undefined) out.push(` ip ospf cost ${o.cost}`);
  if (o.mtuIgnore) out.push(' ip ospf mtu-ignore');
  if (o.area) out.push(` ip ospf ${o.area.pid} area ${o.area.text}`);
  return out;
}

export function routerOspfConfig(d) {
  const o = d.ospf;
  if (!o) return [];
  const L = [`router ospf ${o.pid}`];
  if (o.rid !== null && o.rid !== undefined) L.push(` router-id ${fmtIp(o.rid)}`);
  if (o.refBw !== 100) L.push(` auto-cost reference-bandwidth ${o.refBw}`);
  if (o.logDetail) L.push(' log-adjacency-changes detail');
  if (o.logOff) L.push(' no log-adjacency-changes');
  if (o.passiveDefault) {
    L.push(' passive-interface default');
    for (const n of o.active) L.push(` no passive-interface ${longIf(n)}`);
  } else for (const n of o.passive) L.push(` passive-interface ${longIf(n)}`);
  for (const n of o.nets) L.push(` network ${fmtIp(n.addr)} ${fmtIp(n.wild)} area ${n.text}`);
  if (o.defInfo) L.push(` default-information originate${o.defInfo.always ? ' always' : ''}`);
  L.push('!');
  return L;
}

export function lineConfig(d) {
  const v = d.vty || { acl: null, transport: ['ssh'] };
  const tr = v.transport.length === 0 ? 'none' : v.transport.length > 1 ? 'all' : v.transport[0];
  return ['line con 0', ' logging synchronous', 'line vty 0 4', ...(v.acl ? [` access-class ${v.acl} in`] : []), ' login local', ` transport input ${tr}`, '!'];
}

// ------------------------------------------------------------------ show renderers

function roleText(r) { return r.role === '-' ? '  -' : r.role; }

export function showIpOspfNeighbor(eng, d, ifName) {
  if (!d.ospf || !rtOf(eng, d)) return [];
  const rows = ospfNeighbors(eng, d).filter(r => !ifName || r.iface === ifName);
  const L = ['', `${pad('Neighbor ID', 16)}${pad('Pri', 6)}${pad('State', 16)}${pad('Dead Time', 12)}${pad('Address', 16)}Interface`];
  for (const r of rows) L.push(`${pad(fmtIp(r.rid), 16)}${lpad(r.pri, 3)}   ${pad(`${r.state}/${roleText(r)}`, 16)}${pad(hms(r.dead), 12)}${pad(fmtIp(r.ip), 16)}${longIf(r.iface)}`);
  return L;
}

const BRIEF_STATE = { DOWN: 'DOWN', WAITING: 'WAIT', DR: 'DR', BDR: 'BDR', DROTHER: 'DROTH', P2P: 'P2P' };

export function showIpOspfInterfaceBrief(eng, d) {
  if (!d.ospf) return [];
  const L = [`${pad('Interface', 13)}${pad('PID', 6)}${pad('Area', 16)}${pad('IP Address/Mask', 19)}${pad('Cost', 6)}${pad('State', 6)}Nbrs F/C`];
  for (const I of ospfIfaces(eng, d)) {
    const s = ospfInterfaceState(eng, d, I);
    L.push(`${pad(I.name, 13)}${pad(d.ospf.pid, 6)}${pad(areaLabel(I.area, I.areaText), 16)}${pad(`${fmtIp(I.addr)}/${I.len}`, 19)}${pad(I.cost, 6)}${pad(BRIEF_STATE[s.state] || s.state, 6)}${s.full}/${s.nbrs.length}`);
  }
  return L;
}

function ifLineState(eng, d, name) {
  const cfg = d.ports[name] || d.subifs?.[name];
  const port = d.ports[parentIf(name)];
  const admin = d.subifs?.[name] ? !cfg.adminUp : !port.adminUp;
  const up = l3Ifaces(eng, d).find(i => i.name === name)?.up ?? eng.portUp(d.id, parentIf(name));
  return `${longIf(name)} is ${admin ? 'administratively down' : up ? 'up' : 'down'}, line protocol is ${!admin && up ? 'up' : 'down'}`;
}

export function showIpOspfInterface(eng, d, only) {
  if (!d.ospf) return [];
  const rt = rtOf(eng, d);
  const ifs = ospfIfaces(eng, d);
  if (only) {
    if (!d.ports[only] && !d.subifs?.[only]) return ['% Invalid input detected: no such interface'];
    if (!ifs.some(I => I.name === only)) return [`${ifLineState(eng, d, only)} `, '  OSPF not enabled on this interface'];
  }
  const L = [];
  const portIndex = n => Object.keys(d.ports).indexOf(parentIf(n)) + 1;
  for (const I of ifs) {
    if (only && I.name !== only) continue;
    const s = ospfInterfaceState(eng, d, I);
    const st = s.st;
    const nbrById = ip => Object.values(st?.nbrs || {}).find(n => n.ip === ip);
    const ridOf = ip => (ip === I.addr ? rt?.rid : nbrById(ip)?.rid);
    const type = I.type === 'point-to-point' ? 'POINT_TO_POINT' : 'BROADCAST';
    L.push(`${ifLineState(eng, d, I.name)} `,
      `  Internet Address ${fmtIp(I.addr)}/${I.len}, Interface ID ${portIndex(I.name)}, Area ${areaLabel(I.area, I.areaText)}`,
      `  Attached via ${I.via === 'interface' ? 'Interface Enable' : 'Network Statement'}`,
      `  Process ID ${d.ospf.pid}, Router ID ${rt?.rid != null ? fmtIp(rt.rid) : '0.0.0.0'}, Network Type ${type}, Cost: ${I.cost}`,
      '  Topology-MTID    Cost    Disabled    Shutdown      Topology Name',
      `        0           ${pad(I.cost, 10)}no          no            Base`);
    const stateText = s.state === 'P2P' ? 'POINT_TO_POINT' : s.state;
    L.push(`  Transmit Delay is 1 sec, State ${stateText}${I.type === 'point-to-point' ? '' : `, Priority ${I.pri}`}`);
    if (I.type === 'broadcast' && I.up) {
      if (st && st.dr && st.state !== 'WAITING') L.push(`  Designated Router (ID) ${fmtIp(ridOf(st.dr) ?? 0)}, Interface address ${fmtIp(st.dr)}`);
      else L.push('  No designated router on this network');
      if (st && st.bdr && st.state !== 'WAITING') L.push(`  Backup Designated router (ID) ${fmtIp(ridOf(st.bdr) ?? 0)}, Interface address ${fmtIp(st.bdr)}`);
      else L.push('  No backup designated router on this network');
    }
    L.push(`  Timer intervals configured, Hello ${I.hello}, Dead ${I.dead}, Wait ${I.dead}, Retransmit 5`, `    oob-resync timeout ${I.dead}`);
    if (I.passive) L.push('    No Hellos (Passive interface)');
    else if (I.up && s.helloDue !== null) L.push(`    Hello due in ${hms(Math.ceil(s.helloDue))}`);
    if (st?.state === 'WAITING' && st.wait !== null) L.push(`    Wait time before Designated router selection ${hms(Math.ceil(st.wait - eng.s.t))}`);
    L.push('  Supports Link-local Signaling (LLS)', '  Cisco NSF helper support enabled', '  IETF NSF helper support enabled');
    L.push(`  Index 1/${portIndex(I.name)}/${portIndex(I.name)}, flood queue length 0`, '  Next 0x0(0)/0x0(0)/0x0(0)', `  Last flood scan length is ${s.full ? 1 : 0}, maximum is ${s.full ? 1 : 0}`, '  Last flood scan time is 0 msec, maximum is 0 msec');
    L.push(`  Neighbor Count is ${s.nbrs.length}, Adjacent neighbor count is ${s.full} `);
    for (const n of s.nbrs.filter(x => x.state === 'FULL')) {
      const tag = I.type === 'broadcast' ? (n.ip === st.dr ? '  (Designated Router)' : n.ip === st.bdr ? '  (Backup Designated Router)' : '') : '';
      L.push(`    Adjacent with neighbor ${fmtIp(n.rid)}${tag}`);
    }
    L.push('  Suppress hello for 0 neighbor(s)');
  }
  return L;
}

export function showIpOspf(eng, d) {
  const o = d.ospf;
  if (!o) return [];
  const rt = rtOf(eng, d);
  if (!rt || rt.rid === null) return [` Routing Process "ospf ${o.pid}" with ID 0.0.0.0`, ' %OSPF: Router process is not running, router-id not configured'];
  const ifs = ospfIfaces(eng, d);
  const areas = attachedAreas(ifs);
  const allAreas = [...new Set(ifs.map(I => I.area))].sort((a, b) => a - b);
  const db = ospfDatabase(eng, d);
  const ext = db.ext.length;
  const L = [` Routing Process "ospf ${o.pid}" with ID ${fmtIp(rt.rid)}`,
    ` Start time: ${hms(rt.started)}.${String(Math.floor((rt.started % 1) * 1000)).padStart(3, '0')}, Time elapsed: ${hms(eng.s.t - rt.started)}.000`,
    ' Supports only single TOS(TOS0) routes', ' Supports opaque LSA', ' Supports Link-local Signaling (LLS)', ' Supports area transit capability', ' Supports NSSA (compatible with RFC 3101)',
    ' Event-log enabled, Maximum number of events: 1000, Mode: cyclic'];
  if (isAbr(areas)) L.push(' It is an area border router');
  if (Object.values(rt.ext).some(l => !l.dead && l.adv === rt.rid)) L.push(' It is an autonomous system boundary router', ' Redistributing External Routes from,');
  L.push(' Router is not originating router-LSAs with maximum metric',
    ' Initial SPF schedule delay 5000 msecs', ' Minimum hold time between two consecutive SPFs 10000 msecs', ' Maximum wait time between two consecutive SPFs 10000 msecs',
    ' Incremental-SPF disabled', ' Minimum LSA interval 5 secs', ' Minimum LSA arrival 1000 msecs', ' LSA group pacing timer 240 secs', ' Interface flood pacing timer 33 msecs', ' Retransmission pacing timer 66 msecs',
    ` Number of external LSA ${ext}. Checksum Sum 0x${hex6(db.ext.reduce((a, l) => a + lsaChecksum(l), 0))}`, ' Number of opaque AS LSA 0. Checksum Sum 0x000000',
    ' Number of DCbitless external and opaque AS LSA 0', ' Number of DoNotAge external and opaque AS LSA 0',
    ` Number of areas in this router is ${allAreas.length}. ${allAreas.length} normal 0 stub 0 nssa`, ' Number of areas transit capable is 0', ' External flood list length 0',
    ' IETF NSF helper support enabled', ' Cisco NSF helper support enabled', ` Reference bandwidth unit is ${o.refBw} mbps`);
  for (const A of allAreas) {
    const inA = ifs.filter(I => I.area === A);
    const lsas = db.areas.find(x => x.area === A)?.lsas || [];
    const text = areaLabel(A, inA[0]?.areaText);
    L.push(`    Area ${A === 0 ? `BACKBONE(${text})` : text}`,
      `        Number of interfaces in this area is ${inA.length}`, '        Area has no authentication',
      rt.spf.last !== null ? `        SPF algorithm last executed ${hms(eng.s.t - rt.spf.last)}.000 ago` : '        SPF algorithm last executed never',
      `        SPF algorithm executed ${rt.spf.runs} times`, '        Area ranges are',
      `        Number of LSA ${lsas.length}. Checksum Sum 0x${hex6(lsas.reduce((a, l) => a + lsaChecksum(l), 0))}`,
      '        Number of opaque link LSA 0. Checksum Sum 0x000000', '        Number of DCbitless LSA 0', '        Number of indication LSA 0', '        Number of DoNotAge LSA 0', '        Flood list length 0', '');
  }
  return L;
}

const hex6 = n => (n >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(-6);
const seqText = s => `0x${(s >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export function showIpOspfDatabase(eng, d) {
  const db = ospfDatabase(eng, d);
  if (!db) return [];
  const t = eng.s.t;
  const age = l => Math.min(3600, Math.floor(t - l.born));
  const row = (l, extra) => `${pad(fmtIp(l.id), 16)}${pad(fmtIp(l.adv), 16)}${pad(age(l), 12)}${pad(seqText(l.seq), 11)}0x${hex6(lsaChecksum(l))}${extra !== undefined ? ` ${extra}` : ''}`;
  const sortL = xs => [...xs].sort((a, b) => a.id - b.id || a.adv - b.adv);
  const L = ['', `            OSPF Router with ID (${fmtIp(db.rid)}) (Process ID ${db.pid})`];
  for (const { area, lsas } of db.areas) {
    const sec = (title, type, head, extra) => {
      const xs = sortL(lsas.filter(l => l.type === type));
      if (!xs.length) return;
      L.push('', `                ${title} (Area ${area})`, '', head);
      for (const l of xs) L.push(row(l, extra?.(l)));
    };
    sec('Router Link States', 1, `${pad('Link ID', 16)}${pad('ADV Router', 16)}${pad('Age', 12)}${pad('Seq#', 11)}Checksum Link count`, l => l.body.links.length);
    sec('Net Link States', 2, `${pad('Link ID', 16)}${pad('ADV Router', 16)}${pad('Age', 12)}${pad('Seq#', 11)}Checksum`);
    sec('Summary Net Link States', 3, `${pad('Link ID', 16)}${pad('ADV Router', 16)}${pad('Age', 12)}${pad('Seq#', 11)}Checksum`);
    sec('Summary ASB Link States', 4, `${pad('Link ID', 16)}${pad('ADV Router', 16)}${pad('Age', 12)}${pad('Seq#', 11)}Checksum`);
  }
  if (db.ext.length) {
    L.push('', '                Type-5 AS External Link States', '', `${pad('Link ID', 16)}${pad('ADV Router', 16)}${pad('Age', 12)}${pad('Seq#', 11)}Checksum Tag`);
    for (const l of sortL(db.ext)) L.push(row(l, l.body.tag));
  }
  return L;
}

export function showIpProtocols(eng, d) {
  const L = ['*** IP Routing is NSF aware ***', ''];
  const o = d.ospf;
  if (!o) return L;
  const rt = rtOf(eng, d);
  const ifs = ospfIfaces(eng, d);
  const areas = [...new Set(ifs.map(I => I.area))];
  L.push(`Routing Protocol is "ospf ${o.pid}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set',
    `  Router ID ${rt?.rid != null ? fmtIp(rt.rid) : '0.0.0.0'}`);
  if (isAbr(attachedAreas(ifs))) L.push('  It is an area border router');
  if (o.defInfo) L.push('  It is an autonomous system boundary router', '  Redistributing External Routes from,');
  L.push(`  Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`, '  Maximum path: 4', '  Routing for Networks:');
  for (const n of o.nets) L.push(`    ${fmtIp(n.addr)} ${fmtIp(n.wild)} area ${n.text}`);
  const explicit = ifs.filter(I => I.via === 'interface');
  for (const A of [...new Set(explicit.map(I => I.area))]) {
    L.push(`  Routing on Interfaces Configured Explicitly (Area ${areaLabel(A, explicit.find(I => I.area === A).areaText)}):`);
    for (const I of explicit.filter(x => x.area === A)) L.push(`    ${longIf(I.name)}`);
  }
  const all = [...Object.values(d.ports).filter(p => p.kind === 'eth').map(p => p.name), ...Object.keys(d.subifs || {})];
  const passive = all.filter(n => (o.passiveDefault ? !o.active.includes(n) : o.passive.includes(n)));
  if (passive.length) { L.push('  Passive Interface(s):'); for (const n of passive) L.push(`    ${longIf(n)}`); }
  L.push('  Routing Information Sources:', `    ${pad('Gateway', 16)}Distance      Last Update`);
  const src = new Map();
  for (const r of rt?.rib || []) src.set(r.src, Math.max(src.get(r.src) ?? -Infinity, r.since));
  for (const [gw, since] of [...src.entries()].sort((a, b) => a[0] - b[0])) L.push(`    ${pad(fmtIp(gw), 16)}${lpad(OSPF_AD, 8)}      ${fmtRouteAge(eng.s.t - since)}`);
  L.push(`  Distance: (default is ${OSPF_AD})`, '');
  return L;
}

// ------------------------------------------------------------------ show ip route pieces (used by ios-show.js)

/** One OSPF route line as IOS 15 prints it under a classful header (code padded to 9 columns). */
export function ospfRouteText(eng, r) {
  return `[${OSPF_AD}/${r.metric}] via ${fmtIp(r.nh)}, ${fmtRouteAge(eng.s.t - r.since)}, ${longIf(r.iface)}`;
}

export function ospfRouteEntry(eng, d, r) {
  const age = fmtRouteAge(eng.s.t - r.since);
  const pfx = r.len === 0 ? '0.0.0.0/0, supernet' : `${fmtIp(r.net)}/${r.len}`;
  const typeText = r.code === 'O' ? 'type intra area' : /IA/.test(r.code) ? 'type inter area' : null;
  const L = [`Routing entry for ${pfx}`, `  Known via "ospf ${d.ospf?.pid ?? 1}", distance ${OSPF_AD}, metric ${r.metric}${typeText ? `, ${typeText}` : r.len === 0 ? ', candidate default path' : ''}`];
  if (!typeText) L.push(`  Tag ${d.ospf?.pid ?? 1}, type extern ${/E1/.test(r.code) ? 1 : 2}, forward metric ${r.fwd ?? 1}`);
  L.push(`  Last update from ${fmtIp(r.nh)} on ${longIf(r.iface)}, ${age} ago`, '  Routing Descriptor Blocks:', `  * ${fmtIp(r.nh)}, from ${fmtIp(r.src)}, ${age} ago, via ${longIf(r.iface)}`, `      Route metric is ${r.metric}, traffic share count is 1`);
  return L;
}

/** show interfaces BW/MTU line values. */
export function ifBwMtu(cfg, name) {
  return { bw: ifBandwidth(cfg, name), mtu: cfg?.mtu ?? 1500 };
}

