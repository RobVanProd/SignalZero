// Cisco IOS-like CLI for routers and switches. A subset, but with real syntax, modes, abbreviations,
// "?" help, caret errors, running-config, and behaviour driven by the engine.
import { Grammar, caretLines, tokenize } from './parser.js';
import * as S from './ios-show.js';
import { fmtIp, parseIp, maskToPrefix, networkOf, overlaps, fmtMask, inSubnet } from '../engine/ipv4.js';
import { longIf, canonIf, parentIf, portDefaults } from '../engine/model.js';
import { initialTtl } from '../engine/trace.js';
import { l3Ifaces } from '../engine/routing.js';

const PORT_NUM = { www: 80, http: 80, domain: 53, bootps: 67, bootpc: 68, telnet: 23, smtp: 25, ftp: 21, tftp: 69, ntp: 123, snmp: 161, syslog: 514, pop3: 110, bgp: 179, isakmp: 500 };

function promptFor(dev, sess) {
  const h = dev.hostname;
  switch (sess.mode) {
    case 'user': return `${h}>`;
    case 'exec': return `${h}#`;
    case 'config': return `${h}(config)#`;
    case 'if': return sess.ctx.sub ? `${h}(config-subif)#` : sess.ctx.range ? `${h}(config-if-range)#` : `${h}(config-if)#`;
    case 'acl-ext': return `${h}(config-ext-nacl)#`;
    case 'acl-std': return `${h}(config-std-nacl)#`;
    case 'vlan': return `${h}(config-vlan)#`;
    default: return `${h}#`;
  }
}

// ------------------------------------------------------------------ ACE parsing
function parseAddrSpec(toks, i) {
  const t = toks[i]?.toLowerCase();
  if (t === 'any') return { spec: { any: true }, next: i + 1 };
  if (t === 'host') {
    const ip = parseIp(toks[i + 1] || '');
    if (ip === null) return { err: i + 1 };
    return { spec: { addr: ip, wild: 0 }, next: i + 2 };
  }
  const ip = parseIp(toks[i] || '');
  if (ip === null) return { err: i };
  const w = parseIp(toks[i + 1] || '');
  if (w === null) return { err: i + 1 };
  return { spec: { addr: (ip & ~w) >>> 0, wild: w }, next: i + 2 };
}

function parsePortNum(t) {
  if (t === undefined) return null;
  if (/^\d+$/.test(t)) { const n = Number(t); return n <= 65535 ? n : null; }
  return PORT_NUM[t.toLowerCase()] ?? null;
}

function parsePortSpec(toks, i) {
  const op = toks[i]?.toLowerCase();
  if (!['eq', 'neq', 'lt', 'gt', 'range'].includes(op)) return { spec: null, next: i };
  if (op === 'range') {
    const a = parsePortNum(toks[i + 1]);
    const b = parsePortNum(toks[i + 2]);
    if (a === null) return { err: i + 1 };
    if (b === null) return { err: i + 2 };
    return { spec: { op, ports: [a, b] }, next: i + 3 };
  }
  const ports = [];
  let j = i + 1;
  while (j < toks.length && parsePortNum(toks[j]) !== null && (op === 'eq' || ports.length === 0)) { ports.push(parsePortNum(toks[j])); j++; }
  if (!ports.length) return { err: i + 1 };
  return { spec: { op, ports }, next: j };
}

const ICMP_NAMES = ['echo', 'echo-reply', 'unreachable', 'net-unreachable', 'host-unreachable', 'port-unreachable', 'time-exceeded', 'ttl-exceeded'];

/** Parse "permit tcp any host 1.2.3.4 eq 443" etc. Returns { ace } or { errTok } (token index). */
export function parseAce(kind, toks) {
  const action = toks[0]?.toLowerCase();
  if (!['permit', 'deny'].includes(action)) return { errTok: 0 };
  if (kind === 'standard') {
    const a = parseAddrSpec(toks, 1);
    if (a.err !== undefined) {
      // "permit 10.0.0.0" without wildcard means host in a standard ACL
      const ip = parseIp(toks[1] || '');
      if (ip !== null && toks.length === 2) return { ace: { action, src: { addr: ip, wild: 0 } } };
      return { errTok: a.err };
    }
    const log = toks[a.next]?.toLowerCase() === 'log';
    if (a.next + (log ? 1 : 0) < toks.length) return { errTok: a.next + (log ? 1 : 0) };
    return { ace: { action, src: a.spec, ...(log ? { log } : {}) } };
  }
  const proto = toks[1]?.toLowerCase();
  if (!['ip', 'tcp', 'udp', 'icmp'].includes(proto)) return { errTok: 1 };
  const s = parseAddrSpec(toks, 2);
  if (s.err !== undefined) return { errTok: s.err };
  let i = s.next;
  let sop = null;
  let dop = null;
  if (proto === 'tcp' || proto === 'udp') {
    const sp = parsePortSpec(toks, i);
    if (sp.err !== undefined) return { errTok: sp.err };
    sop = sp.spec; i = sp.next;
  }
  const d = parseAddrSpec(toks, i);
  if (d.err !== undefined) return { errTok: d.err };
  i = d.next;
  if (proto === 'tcp' || proto === 'udp') {
    const dp = parsePortSpec(toks, i);
    if (dp.err !== undefined) return { errTok: dp.err };
    dop = dp.spec; i = dp.next;
  }
  let icmpType = null;
  if (proto === 'icmp' && toks[i] && ICMP_NAMES.includes(toks[i].toLowerCase())) { icmpType = toks[i].toLowerCase(); i++; }
  // Trailing options, in any order: `established` (TCP only) and `log`.
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

function sameAce(a, b) {
  return JSON.stringify({ ...a, seq: 0, matches: 0 }) === JSON.stringify({ ...b, seq: 0, matches: 0 });
}

// ------------------------------------------------------------------ grammar

function buildGrammar(kind) {
  const g = new Grammar();
  g.kwHelp({
    show: 'Show running system information', enable: 'Turn on privileged commands', configure: 'Enter configuration mode', terminal: 'Configure from the terminal',
    interface: 'Select an interface to configure', ip: 'Global IP configuration subcommands', route: 'Establish static routes', 'running-config': 'Current operating configuration',
    shutdown: 'Shutdown the selected interface', no: 'Negate a command or set its defaults', description: 'Interface specific description', exit: 'Exit from configure mode',
    end: 'Exit from configure mode', switchport: 'Set switching mode characteristics', vlan: 'VLAN commands', 'spanning-tree': 'Spanning Tree Subsystem', ping: 'Send echo messages',
    traceroute: 'Trace route to destination', brief: 'Brief summary of IP status and configuration', interfaces: 'Interface status and configuration', status: 'Show interface line status',
    trunk: 'Show interface trunk information', access: 'Set access mode characteristics of the interface', mode: 'Set trunking mode of the interface', allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
    native: 'Set trunking native characteristics when interface is in trunking mode', speed: 'Configure speed operation.', duplex: 'Configure duplex operation.', address: 'Set the IP address of an interface',
    'helper-address': 'Specify a destination address for UDP broadcasts', 'access-group': 'Specify access control for packets', 'access-list': 'Named access-list', 'access-lists': 'List access lists',
    encapsulation: 'Set encapsulation type for an interface', nat: 'NAT configuration commands', dhcp: 'Configure DHCP server and relay parameters', snooping: 'DHCP Snooping', trust: 'DHCP Snooping trust config',
    portfast: 'Spanning tree portfast options', bpduguard: "Don't accept BPDUs on this interface", mac: 'MAC configuration', 'address-table': 'MAC forwarding table', cdp: 'CDP information', neighbors: 'CDP neighbor entries',
    logging: 'Show the contents of logging buffers', clear: 'Reset functions', counters: 'Clear counters on one or all interfaces', write: 'Write running configuration to memory', copy: 'Copy from one file to another',
    hostname: 'Set system\'s network name', arp: 'ARP table', processes: 'Active process statistics', cpu: 'Show CPU usage information', test: 'Test subsystems', 'cable-diagnostics': 'Cable diagnostics', tdr: 'Time Domain Reflectometer',
    do: 'To run exec commands in config mode', version: 'System hardware and software status', range: 'interface range command', name: 'Ascii name of the VLAN', priority: 'Set the bridge priority for the spanning tree',
    extended: 'Extended Access List', standard: 'Standard Access List', permit: 'Specify packets to forward', deny: 'Specify packets to reject', remark: 'Access list entry comment', inside: 'Inside interface for address translation', outside: 'Outside interface for address translation',
    'proxy-arp': 'Enable proxy ARP', unreachables: 'Enable sending ICMP Unreachable messages', disable: 'Turn off privileged commands', clock: 'Display the system clock', vtp: 'VTP information', translations: 'Translation entries', summary: 'Summary of port states',
  });
  const ex = ['user', 'exec'];
  // exec
  g.add('user', 'enable', 'enable');
  g.add('exec', 'disable', 'disable');
  g.add(ex, 'exit', 'logout');
  g.add(ex, 'logout', 'logout');
  g.add('exec', 'configure terminal', 'conf-t');
  g.add(ex, 'terminal length <NUM>', 'noop');
  g.add('exec', 'show running-config', 'sh-run');
  g.add('exec', 'show startup-config', 'sh-start');
  g.add(ex, 'show version', 'sh-ver');
  g.add(ex, 'show clock', 'sh-clock');
  g.add(ex, 'show ip interface brief', 'sh-ipib');
  g.add(ex, 'show interfaces', 'sh-int-all');
  g.add(ex, 'show interfaces <IF>', 'sh-int');
  g.add(ex, 'show cdp neighbors', 'sh-cdp');
  g.add(ex, 'show cdp neighbors detail', 'sh-cdp');
  g.add('exec', 'show logging', 'sh-log');
  g.add('exec', 'clear logging', 'clear-log');
  g.add('exec', 'clear counters', 'clear-counters');
  g.add('exec', 'clear counters <IF>', 'clear-counters');
  g.add(ex, 'show processes cpu', 'sh-cpu');
  g.add(ex, 'show processes cpu sorted', 'sh-cpu');
  g.add('exec', 'write memory', 'write');
  g.add('exec', 'write', 'write');
  g.add('exec', 'copy running-config startup-config', 'write');
  g.add(ex, 'ping <IP>', 'ping');
  g.add(ex, 'traceroute <IP>', 'trace');
  g.add('exec', 'show running-config interface <IF>', 'sh-run-if');
  // Valid IOS that this image does not simulate: answer with a labelled note, never a fake syntax error.
  const unimpl = (modes, template, alt) => g.add(modes, template, 'unimpl', { alt });
  if (kind === 'switch') {
    g.add(ex, 'show interfaces status', 'sh-int-status');
    g.add(ex, 'show interfaces trunk', 'sh-int-trunk');
    g.add(ex, 'show vlan brief', 'sh-vlan');
    g.add(ex, 'show vlan', 'sh-vlan');
    g.add(ex, 'show spanning-tree', 'sh-stp');
    g.add(ex, 'show spanning-tree vlan <VLAN>', 'sh-stp');
    g.add(ex, 'show spanning-tree summary', 'sh-stp-sum');
    g.add(ex, 'show mac address-table', 'sh-mac');
    g.add(ex, 'show mac address-table interface <IF>', 'sh-mac');
    g.add(ex, 'show mac address-table vlan <VLAN>', 'sh-mac');
    g.add(ex, 'show mac address-table address <WORD:mac>', 'sh-mac');
    g.add(ex, 'show mac address-table dynamic', 'sh-mac');
    g.add(ex, 'show mac address-table dynamic interface <IF>', 'sh-mac');
    g.add(ex, 'show mac address-table dynamic vlan <VLAN>', 'sh-mac');
    g.add(ex, 'show mac address-table dynamic address <WORD:mac>', 'sh-mac');
    g.add(ex, 'show interfaces <IF> switchport', 'sh-int-sw');
    g.add(ex, 'show interfaces <IF> status', 'sh-int-status');
    g.add(ex, 'show interfaces status err-disabled', 'sh-int-errdis');
    unimpl(ex, 'show spanning-tree interface <IF>', 'show spanning-tree vlan <id>');
    unimpl(ex, 'show spanning-tree root', 'show spanning-tree vlan <id>');
    unimpl(ex, 'show spanning-tree blockedports', 'show spanning-tree vlan <id>');
    unimpl(ex, 'show ip dhcp snooping binding', 'show ip dhcp snooping');
    unimpl(ex, 'show vlan id <VLAN>', 'show vlan brief');
    unimpl(ex, 'show errdisable recovery', 'show interfaces status err-disabled');
    g.add(ex, 'show ip dhcp snooping', 'sh-snoop');
    g.add(ex, 'show vtp status', 'sh-vtp');
    // Both TDR commands are privileged EXEC on Catalyst IOS: in user mode "cable-diagnostics" is invalid input.
    g.add('exec', 'test cable-diagnostics tdr interface <IF>', 'tdr-run');
    g.add('exec', 'show cable-diagnostics tdr interface <IF>', 'tdr-show');
  }
  if (kind === 'router') {
    g.add(ex, 'show ip route', 'sh-route');
    g.add(ex, 'show ip route static', 'sh-route');
    g.add(ex, 'show ip route connected', 'sh-route');
    g.add(ex, 'show ip route <IP>', 'sh-route-entry');
    g.add(ex, 'show ip interface', 'sh-ipint');
    g.add(ex, 'show ip interface <IF>', 'sh-ipint');
    g.add(ex, 'show ip access-lists <WORD:name>', 'sh-acl');
    g.add(ex, 'ping <IP> source <NH:src>', 'ping');
    unimpl(ex, 'show ip nat statistics', 'show ip nat translations');
    unimpl('exec', 'clear ip nat translation *', 'show ip nat translations');
    unimpl(ex, 'show ip protocols', 'show ip route (this network uses static routes only)');
    unimpl(ex, 'show standby', 'show ip interface brief (no HSRP is configured here)');
    unimpl(ex, 'show standby brief', 'show ip interface brief (no HSRP is configured here)');
    g.add(ex, 'show ip arp', 'sh-arp');
    g.add(ex, 'show arp', 'sh-arp');
    g.add(ex, 'show access-lists', 'sh-acl');
    g.add(ex, 'show access-lists <WORD:name>', 'sh-acl');
    g.add(ex, 'show ip access-lists', 'sh-acl');
    g.add(ex, 'show ip nat translations', 'sh-nat');
  }
  // global config
  const cfg = 'config';
  g.add(cfg, 'exit', 'cfg-exit');
  g.add(['config', 'if', 'acl-ext', 'acl-std', 'vlan'], 'end', 'end');
  g.add(['config', 'if', 'acl-ext', 'acl-std', 'vlan'], 'do <LINE:cmd>', 'do');
  g.add(cfg, 'hostname <WORD:name>', 'hostname');
  g.add(['config', 'if', 'acl-ext', 'acl-std', 'vlan'], 'interface <IF>', 'interface');
  g.add(cfg, 'no ip domain-lookup', 'noop');
  g.add(cfg, 'no ip domain lookup', 'noop');
  g.add(cfg, 'ip routing', 'noop');
  g.add(cfg, 'service timestamps log datetime msec', 'noop');
  if (kind === 'switch') {
    g.add(['config', 'if'], 'interface range <LINE:range>', 'if-range');
    g.add(['config', 'vlan'], 'vlan <VLAN>', 'vlan');
    g.add(cfg, 'no vlan <VLAN>', 'no-vlan');
    g.add('vlan', 'name <WORD:name>', 'vlan-name');
    g.add('vlan', 'exit', 'sub-exit');
    g.add(cfg, 'spanning-tree mode pvst', 'stp-mode');
    g.add(cfg, 'spanning-tree mode rapid-pvst', 'stp-mode');
    g.add(cfg, 'spanning-tree vlan <VLIST>', 'stp-on');
    g.add(cfg, 'no spanning-tree vlan <VLIST>', 'stp-off');
    g.add(cfg, 'spanning-tree vlan <VLIST> priority <NUM:prio>', 'stp-prio');
    g.add(cfg, 'spanning-tree vlan <VLIST> root primary', 'stp-root');
    g.add(cfg, 'spanning-tree vlan <VLIST> root secondary', 'stp-root');
    g.add(cfg, 'no spanning-tree vlan <VLIST> priority', 'stp-prio-clear');
    g.add(cfg, 'ip dhcp snooping', 'snoop-on');
    g.add(cfg, 'no ip dhcp snooping', 'snoop-off');
    g.add(cfg, 'ip dhcp snooping vlan <VLIST>', 'snoop-vlan');
    g.add(cfg, 'no ip dhcp snooping vlan <VLIST>', 'snoop-novlan');
    g.add(cfg, 'ip dhcp snooping information option', 'snoop-o82');
    g.add(cfg, 'no ip dhcp snooping information option', 'snoop-o82');
    g.add(cfg, 'vtp mode transparent', 'noop');
  }
  if (kind === 'router') {
    g.add(cfg, 'ip route <IP:net> <MASK> <NH>', 'route');
    g.add(cfg, 'ip route <IP:net> <MASK> <NH> <NUM:ad>', 'route');
    g.add(cfg, 'ip route <IP:net> <MASK> <IF> <IP:nh>', 'route-ifnh');
    g.add(cfg, 'no ip route <IP:net> <MASK> <NH>', 'no-route');
    g.add(cfg, 'no ip route <IP:net> <MASK>', 'no-route-all');
    g.add(['config', 'acl-ext', 'acl-std'], 'ip access-list extended <WORD:name>', 'acl-ext');
    g.add(['config', 'acl-ext', 'acl-std'], 'ip access-list standard <WORD:name>', 'acl-std');
    g.add(cfg, 'no ip access-list extended <WORD:name>', 'no-acl');
    g.add(cfg, 'no ip access-list standard <WORD:name>', 'no-acl');
    g.add(cfg, 'access-list <NUM:num> <LINE:rest>', 'acl-num');
    g.add(cfg, 'no access-list <NUM:num>', 'no-acl-num');
    g.add(cfg, 'ip dhcp relay information trust-all', 'relay-trust-all');
    g.add(cfg, 'no ip dhcp relay information trust-all', 'relay-trust-all');
    g.add(cfg, 'ip nat inside source list <WORD:acl> interface <IF> overload', 'nat-rule');
    g.add(cfg, 'no ip nat inside source list <WORD:acl> interface <IF> overload', 'no-nat-rule');
    g.add(['acl-ext', 'acl-std'], 'permit <LINE:rest>', 'ace');
    g.add(['acl-ext', 'acl-std'], 'deny <LINE:rest>', 'ace');
    g.add(['acl-ext', 'acl-std'], '<NUM:seq> <LINE:rest>', 'ace-seq');
    g.add(['acl-ext', 'acl-std'], 'remark <LINE:text>', 'remark');
    g.add(['acl-ext', 'acl-std'], 'no <NUM:seq>', 'ace-del');
    g.add(['acl-ext', 'acl-std'], 'no permit <LINE:rest>', 'ace-no');
    g.add(['acl-ext', 'acl-std'], 'no deny <LINE:rest>', 'ace-no');
    g.add(['acl-ext', 'acl-std'], 'exit', 'sub-exit');
  }
  // interface config
  const ifm = 'if';
  g.add(ifm, 'exit', 'sub-exit');
  g.add(ifm, 'shutdown', 'shut');
  g.add(ifm, 'no shutdown', 'noshut');
  g.add(ifm, 'description <LINE:text>', 'desc');
  g.add(ifm, 'no description', 'nodesc');
  g.add(ifm, 'speed 10', 'speed');
  g.add(ifm, 'speed 100', 'speed');
  g.add(ifm, 'speed 1000', 'speed');
  g.add(ifm, 'speed auto', 'speed');
  g.add(ifm, 'no speed', 'speed-auto');
  g.add(ifm, 'duplex full', 'duplex');
  g.add(ifm, 'duplex half', 'duplex');
  g.add(ifm, 'duplex auto', 'duplex');
  g.add(ifm, 'no duplex', 'duplex-auto');
  if (kind === 'switch') {
    g.add(ifm, 'switchport mode access', 'sw-mode');
    g.add(ifm, 'switchport mode trunk', 'sw-mode');
    g.add(ifm, 'switchport access vlan <VLAN>', 'sw-access');
    g.add(ifm, 'no switchport access vlan', 'sw-access-default');
    g.add(ifm, 'switchport trunk allowed vlan <VLIST>', 'sw-allowed');
    g.add(ifm, 'switchport trunk allowed vlan add <VLIST>', 'sw-allowed-add');
    g.add(ifm, 'switchport trunk allowed vlan remove <VLIST>', 'sw-allowed-remove');
    g.add(ifm, 'switchport trunk allowed vlan all', 'sw-allowed-all');
    g.add(ifm, 'switchport trunk allowed vlan none', 'sw-allowed-none');
    g.add(ifm, 'switchport trunk native vlan <VLAN>', 'sw-native');
    g.add(ifm, 'no switchport trunk native vlan', 'sw-native-default');
    g.add(ifm, 'no switchport trunk allowed vlan', 'sw-allowed-all');
    g.add(ifm, 'no switchport nonegotiate', 'noop');
    g.add(ifm, 'switchport trunk encapsulation dot1q', 'noop');
    g.add(ifm, 'switchport nonegotiate', 'noop');
    g.add(ifm, 'spanning-tree portfast', 'portfast');
    g.add(ifm, 'spanning-tree portfast trunk', 'portfast');
    g.add(ifm, 'no spanning-tree portfast', 'no-portfast');
    g.add(ifm, 'spanning-tree bpduguard enable', 'bpduguard');
    g.add(ifm, 'spanning-tree bpduguard disable', 'no-bpduguard');
    g.add(ifm, 'no spanning-tree bpduguard', 'no-bpduguard');
    g.add(ifm, 'ip dhcp snooping trust', 'snoop-trust');
    g.add(ifm, 'no ip dhcp snooping trust', 'snoop-untrust');
  }
  if (kind === 'router') {
    g.add(ifm, 'ip address <IP> <MASK>', 'ip-addr');
    g.add(ifm, 'no ip address', 'no-ip-addr');
    g.add(ifm, 'ip dhcp relay information trusted', 'relay-trust');
    g.add(ifm, 'no ip dhcp relay information trusted', 'relay-trust');
    g.add(ifm, 'ip helper-address <IP>', 'helper');
    g.add(ifm, 'no ip helper-address <IP>', 'no-helper');
    g.add(ifm, 'no ip helper-address', 'no-helper');
    g.add(ifm, 'ip access-group <WORD:acl> in', 'acg');
    g.add(ifm, 'ip access-group <WORD:acl> out', 'acg');
    g.add(ifm, 'no ip access-group <WORD:acl> in', 'no-acg');
    g.add(ifm, 'no ip access-group <WORD:acl> out', 'no-acg');
    g.add(ifm, 'ip nat inside', 'nat-if');
    g.add(ifm, 'ip nat outside', 'nat-if');
    g.add(ifm, 'no ip nat inside', 'no-nat-if');
    g.add(ifm, 'no ip nat outside', 'no-nat-if');
    g.add(ifm, 'encapsulation dot1Q <VLAN>', 'encap');
    g.add(ifm, 'encapsulation dot1Q <VLAN> native', 'encap');
    g.add(ifm, 'ip proxy-arp', 'proxy');
    g.add(ifm, 'no ip proxy-arp', 'no-proxy');
    g.add(ifm, 'ip unreachables', 'unreach');
    g.add(ifm, 'no ip unreachables', 'no-unreach');
  }
  return g;
}

const GRAMMARS = { router: buildGrammar('router'), switch: buildGrammar('switch') };

export function iosSession(dev) {
  return { dev: dev.id, os: 'ios', mode: 'user', ctx: {}, history: [] };
}

export function iosPrompt(eng, sess) { return promptFor(eng.s.devices[sess.dev], sess); }

function applyPipe(lines, pipe) {
  if (!pipe) return lines;
  const m = /^\s*(include|inc|i|exclude|exc|e|begin|beg|b|section|sec|s)\s+(.+)$/i.exec(pipe);
  if (!m) return ['% Invalid input detected after "|".'];
  const kind = m[1][0].toLowerCase();
  let re;
  try { re = new RegExp(m[2].trim(), 'i'); } catch { re = new RegExp(m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  if (kind === 'i') return lines.filter(l => re.test(l));
  if (kind === 'e') return lines.filter(l => !re.test(l));
  if (kind === 'b') { const i = lines.findIndex(l => re.test(l)); return i < 0 ? [] : lines.slice(i); }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && re.test(lines[i])) {
      out.push(lines[i]);
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) out.push(lines[++i]);
    }
  }
  return out;
}

function normaliseIfSpacing(line) {
  return line.replace(/\b(gigabitethernet|gigabit|giga|gig|gi|g|fastethernet|fa|f|tengigabitethernet|te)\s+(\d+\/)/gi, '$1$2');
}

/** Execute one line. Returns { lines, prompt, changed, clear } */
export function iosExecute(eng, sess, raw) {
  const dev = eng.s.devices[sess.dev];
  const g = GRAMMARS[dev.kind === 'router' ? 'router' : 'switch'];
  const prompt = promptFor(dev, sess);
  let line = normaliseIfSpacing(raw.replace(/\t/g, ' '));
  if (!line.trim()) return { lines: [], prompt };
  if (line.trim().startsWith('!')) return { lines: [], prompt };
  if (line.endsWith('?')) {
    const h = g.helpFor(sess.mode, line.slice(0, -1));
    return { lines: h.length ? h : ['% Unrecognized command'], prompt, keep: line.slice(0, -1) };
  }
  let pipe = null;
  const bar = line.indexOf('|');
  if (bar >= 0 && /^\s*(sh|show|do)/i.test(line)) { pipe = line.slice(bar + 1); line = line.slice(0, bar); }
  const m = g.match(sess.mode, line);
  if (m.error) {
    if (m.error === 'ambiguous') return { lines: [`% Ambiguous command:  "${line.trim()}"`], prompt };
    if (m.error === 'incomplete') return { lines: ['% Incomplete command.', ''], prompt };
    if (sess.mode === 'user' && /^\s*(conf|sh\w*\s+(run|start|cable|log)|wr|test\s|cl)/i.test(line)) return { lines: [...caretLines(prompt, line, m.pos), '(Hint: privileged commands need "enable" first.)'].map((x, i) => (i === 2 ? { t: 'note', text: x } : x)), prompt };
    return { lines: caretLines(prompt, line, m.pos), prompt };
  }
  const ctx = { eng, dev, sess, args: m.args, line: line.trim(), raw, prompt, cmd: m.cmd };
  const out = run(m.cmd.handler, ctx);
  const lines = applyPipe(out.lines || [], pipe);
  return { ...out, lines, prompt: promptFor(dev, sess) };
}

function mut(ctx, what) {
  ctx.eng.mutated(`${ctx.dev.hostname}: ${what ?? ctx.line}`);
  ctx.changed = true;
}

function ifTargets(ctx) {
  const { dev, sess } = ctx;
  if (sess.ctx.range) return sess.ctx.range.map(n => dev.ports[n]);
  if (sess.ctx.sub) return [dev.subifs[sess.ctx.sub]];
  return [dev.ports[sess.ctx.iface]];
}

function run(handler, ctx) {
  const { eng, dev, sess, args } = ctx;
  const L = [];
  const done = (extra = {}) => ({ lines: L, changed: !!ctx.changed, ...extra });
  const note = text => L.push({ t: 'note', text });
  switch (handler) {
    case 'noop': return done();
    case 'enable': sess.mode = 'exec'; return done();
    case 'disable': sess.mode = 'user'; return done();
    case 'logout': sess.mode = 'user'; return done({ logout: true, lines: ['', `${dev.hostname} con0 is now available`, '', 'Press RETURN to get started.'] });
    case 'conf-t': sess.mode = 'config'; L.push('Enter configuration commands, one per line.  End with CNTL/Z.'); return done();
    case 'end': sess.mode = 'exec'; sess.ctx = {}; return done();
    case 'cfg-exit': sess.mode = 'exec'; sess.ctx = {}; return done();
    case 'sub-exit': sess.mode = 'config'; sess.ctx = {}; return done();
    case 'do': {
      const saved = sess.mode;
      sess.mode = 'exec';
      const r = iosExecute(eng, sess, args.cmd);
      sess.mode = saved;
      return { ...r, changed: r.changed };
    }
    case 'hostname': dev.hostname = args.name; mut(ctx); return done();

    // ---------------- show
    case 'sh-run': L.push(...S.runningConfig(eng, dev)); return done();
    case 'sh-run-if': L.push(...S.runningConfigInterface(eng, dev, args.if)); return done();
    case 'sh-int-sw': L.push(...S.showSwitchport(eng, dev, args.if)); return done();
    case 'sh-int-errdis': {
      L.push(`${'Port'.padEnd(10)}${'Name'.padEnd(19)}${'Status'.padEnd(13)}${'Reason'.padEnd(21)}Err-disabled Vlans`);
      for (const p of Object.values(dev.ports)) if (p.errDisabled) L.push(`${p.name.padEnd(10)}${p.description.slice(0, 18).padEnd(19)}${'err-disabled'.padEnd(13)}${p.errDisabled}`);
      return done();
    }
    case 'sh-ipint': L.push(...S.showIpInterface(eng, dev, args.if)); return done();
    case 'sh-route-entry': L.push(...S.showIpRouteEntry(eng, dev, args.ip)); eng.event({ type: 'show', host: dev.id, what: 'route' }); return done();
    case 'unimpl': note(`training image: "${ctx.line}" is valid IOS but is not simulated here.${ctx.cmd.alt ? ` Try: ${ctx.cmd.alt}` : ''}`); return done();
    case 'sh-start': {
      if (!dev.startup) { L.push(...S.runningConfig(eng, dev).slice(2)); return done(); }
      L.push(...dev.startup);
      return done();
    }
    case 'sh-ver': L.push(dev.kind === 'router' ? 'Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M8, RELEASE SOFTWARE (fc2)' : 'Cisco IOS XE Software, Version 17.09.04a', `${dev.hostname} uptime is 41 weeks, 3 days, 2 hours, ${Math.floor(eng.s.t / 60) + 17} minutes`, `cisco ${dev.model} processor with 1048576K bytes of memory.`, `${Object.keys(dev.ports).length - 1} Gigabit Ethernet interfaces`, 'Configuration register is 0x2102'); return done();
    case 'sh-clock': { const s = eng.stamp().split(' ').pop(); L.push(`*${s} UTC Thu Oct 15 2026`); return done(); }
    case 'sh-ipib': L.push(...S.showIpIntBrief(eng, dev)); return done();
    case 'sh-int': L.push(...S.showInterface(eng, dev, args.if)); return done();
    case 'sh-int-all': for (const p of Object.values(dev.ports)) if (p.kind === 'eth') L.push(...S.showInterface(eng, dev, p.name)); return done();
    case 'sh-int-status': { const t = S.showIntStatus(eng, dev); L.push(...(args.if ? [t[0], ...t.slice(1).filter(l => l.startsWith(`${args.if} `))] : t)); return done(); }
    case 'sh-int-trunk': L.push(...S.showIntTrunk(eng, dev)); return done();
    case 'sh-vlan': L.push(...S.showVlanBrief(eng, dev)); return done();
    case 'sh-stp': L.push(...S.showSpanningTree(eng, dev, args.vlan)); eng.event({ type: 'show', host: dev.id, what: 'stp' }); return done();
    case 'sh-stp-sum': {
      L.push(`Switch is in ${dev.stp.mode} mode`, `Root bridge for: ${Object.keys(dev.vlans).filter(v => eng.stpInfo?.[v]?.rootOf?.[dev.id] === dev.id).map(v => 'VLAN' + String(v).padStart(4, '0')).join(', ') || 'none'}`);
      const dis = (dev.stp.disabled || []).map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(',');
      if (dis) L.push(`Spanning tree disabled for VLANs: ${dis}`);
      L.push('EtherChannel misconfig guard            is enabled', 'Portfast Default                        is disabled', 'PortFast BPDU Guard Default             is disabled');
      return done();
    }
    case 'sh-mac': {
      const f = {};
      if (args.if) f.port = args.if;
      if (args.vlan) f.vlan = args.vlan;
      if (args.mac) f.mac = args.mac.toLowerCase().replace(/[.:-]/g, '');
      L.push(...S.showMacTable(eng, dev, f));
      eng.event({ type: 'show', host: dev.id, what: 'mac', filter: f });
      return done();
    }
    case 'sh-cdp': L.push(...S.showCdp(eng, dev)); return done();
    case 'sh-log': L.push(...S.showLogging(eng, dev)); eng.event({ type: 'show', host: dev.id, what: 'logging' }); return done();
    case 'clear-log': dev.logging = []; L.push('Clear logging buffer [confirm]', ''); return done();
    case 'clear-counters': {
      L.push(`Clear "show interface" counters on ${args.if ? 'this interface' : 'all interfaces'} [confirm]`);
      for (const p of Object.values(dev.ports)) if (!args.if || p.name === args.if) p.counters = { inPkts: 0, outPkts: 0, bcast: 0, crc: 0, runts: 0, lateCol: 0, collisions: 0, inErr: 0, outErr: 0, cleared: eng.s.t };
      eng.syslog(dev, '%CLEAR-5-COUNTERS', `Clear counter on ${args.if ? 'interface ' + longIf(args.if) : 'all interfaces'} by console`);
      return done();
    }
    case 'sh-cpu': L.push(...S.showCpu(eng, dev)); return done();
    case 'write': L.push('Building configuration...', '[OK]'); dev.startup = S.runningConfig(eng, dev).slice(2); dev.savedSeq = eng.s.changeSeq; eng.event({ type: 'save', host: dev.id }); return done();
    case 'sh-route': {
      const only = /\bstatic\s*$/i.test(ctx.line) ? ['S'] : /\bconnected\s*$/i.test(ctx.line) ? ['C', 'L'] : null;
      const r = S.showIpRoute(eng, dev, only);
      L.push(...r.lines);
      eng.event({ type: 'show', host: dev.id, what: 'route' });
      return done({ meta: { notInstalled: r.notInstalled } });
    }
    case 'sh-arp': L.push(...S.showArp(eng, dev)); return done();
    case 'sh-acl': L.push(...S.showAccessLists(eng, dev, args.name)); return done();
    case 'sh-nat': L.push(...S.showNat(eng, dev)); return done();
    case 'sh-snoop': L.push(...S.showSnooping(eng, dev)); return done();
    case 'sh-vtp': L.push('VTP Version capable             : 1 to 3', 'VTP version running             : 1', 'VTP Domain Name                 : ', 'VTP Operating Mode              : Transparent', `Number of existing VLANs        : ${Object.keys(dev.vlans).length + 4}`); return done();
    case 'tdr-run': {
      L.push(`TDR test started on interface ${args.if}`, 'A TDR test can take a few seconds to run on an interface', "Use 'show cable-diagnostics tdr' to read the TDR results.");
      dev.tdrRun = dev.tdrRun || {};
      dev.tdrRun[args.if] = eng.s.t;
      return done();
    }
    case 'tdr-show': {
      if (dev.tdrRun?.[args.if] === undefined) { L.push(`% TDR test was never issued on ${args.if}`); return done(); }
      L.push(...S.showTdr(eng, dev, args.if));
      eng.event({ type: 'tdr', host: dev.id, port: args.if });
      return done();
    }
    case 'ping': {
      let srcIp;
      if (args.src !== undefined) {
        const ifc = l3Ifaces(eng, dev).find(i => i.up && (typeof args.src === 'number' ? i.addr === args.src : i.name === args.src));
        if (!ifc) { L.push(typeof args.src === 'number' ? '% Invalid source address- IP address not on any of our up interfaces' : '% Invalid source interface - IP not enabled or interface is down'); return done(); }
        srcIp = ifc.addr;
      }
      L.push('Type escape sequence to abort.', `Sending 5, 100-byte ICMP Echos to ${fmtIp(args.ip)}, timeout is 2 seconds:`);
      if (srcIp !== undefined) L.push(`Packet sent with a source address of ${fmtIp(srcIp)} `);
      let marks = '';
      let ok = 0;
      const rtts = [];
      for (let i = 0; i < 5; i++) {
        const r = eng.probe({ from: dev.id, dst: args.ip, proto: 'icmp', record: true, srcIp });
        if (r.status === 'ok' && r.kind === 'reply' && eng.rand() < r.pass) { marks += '!'; ok++; rtts.push(Math.max(1, Math.round(r.rttMs + eng.rand() * (r.jitter || 0.2)))); }
        else if (r.status === 'ok' && r.kind === 'net-unreachable') marks += 'U';
        else marks += '.';
      }
      L.push(marks, `Success rate is ${ok * 20} percent (${ok}/5)${ok ? `, round-trip min/avg/max = ${Math.min(...rtts)}/${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}/${Math.max(...rtts)} ms` : ''}`);
      eng.event({ type: 'ping', host: dev.id, ip: args.ip, ok: ok > 0 });
      return done();
    }
    case 'trace': {
      L.push('Type escape sequence to abort.', `Tracing the route to ${fmtIp(args.ip)}`, 'VRF info: (vrf in name/id, vrf out name/id)');
      for (let ttl = 1; ttl <= 30; ttl++) {
        const r = eng.probe({ from: dev.id, dst: args.ip, proto: 'icmp', ttl, record: true });
        if (r.status !== 'ok') {
          L.push(`  ${ttl} *  *  * `);
          if (ttl >= 3 && L.slice(-3).every(x => /\*  \*  \*/.test(x))) { note('(trainer: remaining hops also time out; output shortened)'); break; }
          continue;
        }
        const ms = () => Math.max(1, Math.round(r.rttMs + eng.rand()));
        const flag = r.kind === 'net-unreachable' ? ' !N' : '';
        L.push(`  ${ttl} ${fmtIp(r.responderIp)} ${ms()} msec${flag} ${ms()} msec${flag} ${ms()} msec${flag}`);
        if (r.kind !== 'ttl-exceeded') break;
      }
      eng.event({ type: 'trace', host: dev.id, ip: args.ip });
      return done();
    }

    // ---------------- config
    case 'interface': {
      const name = args.if;
      const parent = parentIf(name);
      if (!dev.ports[parent] || dev.ports[parent].kind === 'console') return { lines: caretLines(ctx.prompt, ctx.line, ctx.line.toLowerCase().indexOf(' ') + 1) };
      if (name !== parent) {
        if (dev.kind !== 'router') return { lines: ['% Subinterfaces are not supported on this switch port.'] };
        if (!dev.subifs[name]) {
          dev.subifs[name] = { name, parent, vlan: null, native: false, adminUp: true, ip: null, helpers: [], aclIn: null, aclOut: null, nat: null, proxyArp: true, unreachables: true, description: '' };
          mut(ctx, `create ${name}`);
        }
        sess.mode = 'if';
        sess.ctx = { sub: name };
        return done();
      }
      sess.mode = 'if';
      sess.ctx = { iface: name };
      return done();
    }
    case 'if-range': {
      const m = /^(\w+?)(\d+)\/(\d+)\s*-\s*(\d+)$/.exec(args.range.replace(/\s+/g, ' ').trim()) || /^(\w+?)(\d+)\/(\d+)\s*-\s*\w*?\d+\/(\d+)$/.exec(args.range.trim());
      if (!m) return { lines: ['% Invalid range. Example: interface range g0/10 - 20'] };
      const base = canonIf(`${m[1]}${m[2]}/${m[3]}`);
      if (!base) return { lines: ['% Invalid interface type'] };
      const pre = base.replace(/\d+$/, '');
      const names = [];
      for (let i = Number(m[3]); i <= Number(m[4]); i++) if (dev.ports[`${pre}${i}`]) names.push(`${pre}${i}`);
      if (!names.length) return { lines: ['% No interfaces in range'] };
      sess.mode = 'if';
      sess.ctx = { range: names };
      return done();
    }
    case 'vlan': {
      if (!dev.vlans[args.vlan]) { dev.vlans[args.vlan] = `VLAN${String(args.vlan).padStart(4, '0')}`; mut(ctx); }
      sess.mode = 'vlan';
      sess.ctx = { vlan: args.vlan };
      return done();
    }
    case 'vlan-name': dev.vlans[sess.ctx.vlan] = args.name; mut(ctx); return done();
    case 'no-vlan': {
      if (args.vlan === 1) { L.push('%Default VLAN 1 may not be deleted.'); return done(); }
      delete dev.vlans[args.vlan];
      mut(ctx);
      return done();
    }
    case 'stp-mode': dev.stp.mode = /rapid/i.test(ctx.line) ? 'rapid-pvst' : 'pvst'; mut(ctx); return done();
    case 'stp-on': {
      dev.stp.disabled = subtractRanges(dev.stp.disabled || [], args.vlist);
      mut(ctx);
      return done();
    }
    case 'stp-off': {
      dev.stp.disabled = addRanges(dev.stp.disabled || [], args.vlist);
      mut(ctx);
      return done();
    }
    case 'stp-prio': {
      if (args.prio % 4096 !== 0 || args.prio > 61440) {
        L.push('% Bridge Priority must be in increments of 4096.', '% Allowed values are:', '  0     4096  8192  12288 16384 20480 24576 28672', '  32768 36864 40960 45056 49152 53248 57344 61440');
        return done();
      }
      for (const v of args.vlist) dev.stp.priority[v] = args.prio;
      mut(ctx);
      return done();
    }
    case 'stp-root': {
      // The macro writes a plain priority. secondary: 28672. primary: 24576 if that wins the election,
      // otherwise 4096 below the best other bridge (the current root) in this VLAN.
      const secondary = /secondary\s*$/i.test(ctx.line);
      eng.ensure();
      for (const v of args.vlist) {
        let prio = secondary ? 28672 : 24576;
        const info = eng.stpInfo?.[v];
        const mine = info?.rootOf?.[dev.id];
        const others = mine ? Object.keys(info.rootOf).filter(id => id !== dev.id && info.rootOf[id] === mine).map(id => eng.s.devices[id]) : [];
        const best = others.map(o => [o.stp.priority?.[v] ?? 32768, parseInt(o.mac, 16)]).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
        if (!secondary && best && (best[0] < prio || (best[0] === prio && best[1] < parseInt(dev.mac, 16)))) prio = best[0] - 4096;
        if (prio < 0) { note(`training image: VLAN ${v} root already uses priority 0; this switch cannot undercut it (priority left unchanged).`); continue; }
        dev.stp.priority[v] = prio;
      }
      mut(ctx);
      return done();
    }
    case 'stp-prio-clear': for (const v of args.vlist) delete dev.stp.priority[v]; mut(ctx); return done();
    case 'snoop-on': dev.snoop.enabled = true; mut(ctx); return done();
    case 'snoop-off': dev.snoop.enabled = false; mut(ctx); return done();
    case 'snoop-vlan': dev.snoop.vlans = [...new Set([...dev.snoop.vlans, ...args.vlist])].sort((a, b) => a - b); mut(ctx); return done();
    case 'snoop-novlan': dev.snoop.vlans = dev.snoop.vlans.filter(v => !args.vlist.includes(v)); mut(ctx); return done();
    case 'snoop-o82': dev.snoop.opt82 = !/^no\s/i.test(ctx.line); mut(ctx); return done();
    case 'relay-trust-all': dev.relayTrustAll = !/^no\s/i.test(ctx.line); mut(ctx); return done();
    case 'relay-trust': for (const p of ifTargets(ctx)) p.relayTrust = !/^no\s/i.test(ctx.line); mut(ctx); return done();

    case 'route':
    case 'route-ifnh': {
      if (networkOf(args.net, args.mask) !== args.net) { L.push('%Inconsistent address and mask'); return done(); }
      const nh = handler === 'route-ifnh' ? args.nh : args.nh;
      const r = { net: args.net, len: args.mask, nh: typeof nh === 'number' ? nh : null, iface: typeof nh === 'string' ? nh : null, ad: args.ad ?? 1 };
      if (handler === 'route-ifnh') { r.iface = args.if; r.nh = args.nh; }
      if (r.iface && !dev.ports[parentIf(r.iface)]) return { lines: caretLines(ctx.prompt, ctx.line, ctx.line.lastIndexOf(' ') + 1) };
      if (r.nh !== null && l3Owns(dev, r.nh)) { L.push(`%Invalid next hop address (it's this router)`); return done(); }
      const exists = dev.routes.find(x => x.net === r.net && x.len === r.len && x.nh === r.nh && x.iface === r.iface);
      if (exists) { exists.ad = r.ad; return done(); }
      dev.routes.push(r);
      mut(ctx);
      return done();
    }
    case 'no-route': {
      const nh = args.nh;
      const before = dev.routes.length;
      dev.routes = dev.routes.filter(x => !(x.net === args.net && x.len === args.mask && (typeof nh === 'number' ? x.nh === nh : x.iface === nh)));
      if (dev.routes.length === before) L.push('%No matching route to delete');
      else mut(ctx);
      return done();
    }
    case 'no-route-all': {
      const before = dev.routes.length;
      dev.routes = dev.routes.filter(x => !(x.net === args.net && x.len === args.mask));
      if (dev.routes.length === before) L.push('%No matching route to delete');
      else mut(ctx);
      return done();
    }
    case 'acl-ext':
    case 'acl-std': {
      const kind = handler === 'acl-ext' ? 'extended' : 'standard';
      if (dev.acls[args.name] && dev.acls[args.name].kind !== kind) { L.push(`% A named ${dev.acls[args.name].kind} IP access list with this name already exists`); return done(); }
      if (!dev.acls[args.name]) { dev.acls[args.name] = { kind, entries: [] }; mut(ctx); }
      sess.mode = kind === 'extended' ? 'acl-ext' : 'acl-std';
      sess.ctx = { acl: args.name };
      return done();
    }
    case 'no-acl': {
      if (!dev.acls[args.name]) return done();
      delete dev.acls[args.name];
      mut(ctx);
      return done();
    }
    case 'acl-num': {
      const n = args.num;
      const kind = n >= 1 && n <= 99 ? 'standard' : n >= 100 && n <= 199 ? 'extended' : null;
      if (!kind) return { lines: caretLines(ctx.prompt, ctx.line, ctx.line.indexOf(String(n))) };
      const toks = tokenize(args.rest).map(t => t.v);
      if (toks[0]?.toLowerCase() === 'remark') {
        const acl = (dev.acls[String(n)] ||= { kind, entries: [] });
        acl.entries.push({ seq: nextSeq(acl), remark: toks.slice(1).join(' ') });
        mut(ctx);
        return done();
      }
      const r = parseAce(kind, toks);
      if (r.errTok !== undefined) return { lines: caretLines(ctx.prompt, ctx.line, ctx.line.indexOf(args.rest) + tokenize(args.rest)[Math.min(r.errTok, toks.length - 1)]?.pos || 0) };
      const acl = (dev.acls[String(n)] ||= { kind, entries: [] });
      if (acl.entries.some(e => sameAce(e, r.ace))) return done();
      acl.entries.push({ seq: nextSeq(acl), ...r.ace });
      mut(ctx);
      return done();
    }
    case 'no-acl-num': delete dev.acls[String(args.num)]; mut(ctx); return done();
    case 'ace':
    case 'ace-seq': {
      const acl = dev.acls[sess.ctx.acl];
      const text = handler === 'ace' ? ctx.line : args.rest;
      const toks = tokenize(text).map(t => t.v);
      if (handler === 'ace-seq' && toks[0]?.toLowerCase() === 'remark') {
        acl.entries.push({ seq: args.seq, remark: toks.slice(1).join(' ') });
        mut(ctx);
        return done();
      }
      const r = parseAce(acl.kind, toks);
      if (r.errTok !== undefined) {
        const base = ctx.line.indexOf(text);
        const tk = tokenize(text)[Math.min(r.errTok, toks.length - 1)];
        if (r.errTok >= toks.length) return { lines: ['% Incomplete command.', ''] };
        return { lines: caretLines(ctx.prompt, ctx.line, base + (tk ? tk.pos : 0)) };
      }
      if (acl.entries.some(e => !e.remark && sameAce(e, r.ace))) return done();
      const seq = handler === 'ace-seq' ? args.seq : nextSeq(acl);
      if (acl.entries.some(e => e.seq === seq)) { L.push('% Duplicate sequence number'); return done(); }
      acl.entries.push({ seq, ...r.ace });
      acl.entries.sort((a, b) => a.seq - b.seq);
      mut(ctx);
      return done();
    }
    case 'remark': { const acl = dev.acls[sess.ctx.acl]; acl.entries.push({ seq: nextSeq(acl), remark: args.text }); mut(ctx); return done(); }
    case 'ace-del': {
      const acl = dev.acls[sess.ctx.acl];
      const before = acl.entries.length;
      acl.entries = acl.entries.filter(e => e.seq !== args.seq);
      if (before !== acl.entries.length) mut(ctx);
      return done();
    }
    case 'ace-no': {
      const acl = dev.acls[sess.ctx.acl];
      const toks = tokenize(ctx.line.replace(/^no\s+/i, '')).map(t => t.v);
      const r = parseAce(acl.kind, toks);
      if (!r.ace) return { lines: ['% Invalid access list entry'] };
      const before = acl.entries.length;
      acl.entries = acl.entries.filter(e => e.remark || !sameAce(e, r.ace));
      if (before !== acl.entries.length) mut(ctx);
      return done();
    }
    case 'nat-rule': {
      if (!dev.nat.some(r => r.acl === args.acl && r.iface === args.if)) { dev.nat.push({ acl: args.acl, iface: args.if, overload: true }); mut(ctx); }
      return done();
    }
    case 'no-nat-rule': dev.nat = dev.nat.filter(r => !(r.acl === args.acl && r.iface === args.if)); mut(ctx); return done();

    // ---------------- interface
    // Recovering an err-disabled port takes "shutdown" then "no shutdown"; "no shutdown" alone leaves it err-disabled.
    case 'shut': for (const p of ifTargets(ctx)) { p.adminUp = false; p.errDisabled = null; } mut(ctx); return done();
    case 'noshut': for (const p of ifTargets(ctx)) p.adminUp = true; mut(ctx); return done();
    case 'desc': for (const p of ifTargets(ctx)) p.description = args.text; mut(ctx); return done();
    case 'nodesc': for (const p of ifTargets(ctx)) p.description = ''; mut(ctx); return done();
    case 'speed': case 'speed-auto': {
      const v = handler === 'speed-auto' ? 'auto' : ctx.line.split(/\s+/)[1];
      for (const p of ifTargets(ctx)) { if (sess.ctx.sub) return { lines: ['% Invalid input: speed applies to physical interfaces'] }; p.speed = v === 'auto' ? 'auto' : Number(v); }
      mut(ctx);
      return done();
    }
    case 'duplex': case 'duplex-auto': {
      const v = handler === 'duplex-auto' ? 'auto' : ctx.line.split(/\s+/)[1].toLowerCase();
      for (const p of ifTargets(ctx)) { if (sess.ctx.sub) return { lines: ['% Invalid input: duplex applies to physical interfaces'] }; p.duplex = v; }
      mut(ctx);
      return done();
    }
    case 'sw-mode': for (const p of ifTargets(ctx)) { p.mode = /trunk/i.test(ctx.line) ? 'trunk' : 'access'; } mut(ctx); return done();
    case 'sw-access': {
      if (!dev.vlans[args.vlan]) { dev.vlans[args.vlan] = `VLAN${String(args.vlan).padStart(4, '0')}`; L.push('% Access VLAN does not exist. Creating vlan ' + args.vlan); }
      for (const p of ifTargets(ctx)) p.accessVlan = args.vlan;
      mut(ctx);
      return done();
    }
    case 'sw-access-default': for (const p of ifTargets(ctx)) p.accessVlan = 1; mut(ctx); return done();
    case 'sw-allowed': for (const p of ifTargets(ctx)) p.allowed = [...args.vlist]; mut(ctx); return done();
    case 'sw-allowed-add': for (const p of ifTargets(ctx)) p.allowed = p.allowed === 'all' ? 'all' : [...new Set([...p.allowed, ...args.vlist])].sort((a, b) => a - b); mut(ctx); return done();
    case 'sw-allowed-remove': for (const p of ifTargets(ctx)) { const base = p.allowed === 'all' ? range(1, 4094) : p.allowed; p.allowed = base.filter(v => !args.vlist.includes(v)); } mut(ctx); return done();
    case 'sw-allowed-all': for (const p of ifTargets(ctx)) p.allowed = 'all'; mut(ctx); return done();
    case 'sw-allowed-none': for (const p of ifTargets(ctx)) p.allowed = []; mut(ctx); return done();
    case 'sw-native': for (const p of ifTargets(ctx)) p.native = args.vlan; mut(ctx); return done();
    case 'sw-native-default': for (const p of ifTargets(ctx)) p.native = 1; mut(ctx); return done();
    case 'portfast': {
      for (const p of ifTargets(ctx)) p.portfast = true;
      L.push('%Warning: portfast should only be enabled on ports connected to a single', ' host. Connecting hubs, concentrators, switches, bridges, etc... to this', ' interface  when portfast is enabled, can cause temporary bridging loops.', ' Use with CAUTION');
      mut(ctx);
      return done();
    }
    case 'no-portfast': for (const p of ifTargets(ctx)) p.portfast = false; mut(ctx); return done();
    case 'bpduguard': for (const p of ifTargets(ctx)) p.bpduguard = true; mut(ctx); return done();
    case 'no-bpduguard': for (const p of ifTargets(ctx)) p.bpduguard = false; mut(ctx); return done();
    case 'snoop-trust': for (const p of ifTargets(ctx)) p.snoopTrust = true; mut(ctx); return done();
    case 'snoop-untrust': for (const p of ifTargets(ctx)) p.snoopTrust = false; mut(ctx); return done();
    case 'ip-addr': {
      const [t] = ifTargets(ctx);
      const name = sess.ctx.sub || sess.ctx.iface;
      if (sess.ctx.sub && t.vlan === null) { L.push('% Configuring IP routing on a LAN subinterface is only allowed if that', 'subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,', 'or ISL vLAN.'); return done(); }
      const net = networkOf(args.ip, args.mask);
      if (args.mask < 31 && (args.ip === net || args.ip === (net | (~(0xffffffff << (32 - args.mask)) >>> 0)) >>> 0)) { L.push('Bad mask /' + args.mask + ' for address ' + fmtIp(args.ip)); return done(); }
      for (const other of allL3(dev)) {
        if (other.name === name || !other.ip) continue;
        if (overlaps(args.ip, args.mask, other.ip.addr, other.ip.len)) {
          L.push(`% ${fmtIp(net)} overlaps with ${longIf(other.name)}`);
          return done();
        }
      }
      t.ip = { addr: args.ip, len: args.mask };
      mut(ctx);
      return done();
    }
    case 'no-ip-addr': for (const p of ifTargets(ctx)) p.ip = null; mut(ctx); return done();
    case 'helper': for (const p of ifTargets(ctx)) { if (!p.helpers.includes(args.ip)) p.helpers.push(args.ip); } mut(ctx); return done();
    case 'no-helper': for (const p of ifTargets(ctx)) p.helpers = args.ip !== undefined ? p.helpers.filter(h => h !== args.ip) : []; mut(ctx); return done();
    case 'acg': {
      const dir = /\bout\s*$/i.test(ctx.line) ? 'aclOut' : 'aclIn';
      for (const p of ifTargets(ctx)) p[dir] = args.acl;
      mut(ctx);
      return done();
    }
    case 'no-acg': {
      const dir = /\bout\s*$/i.test(ctx.line) ? 'aclOut' : 'aclIn';
      for (const p of ifTargets(ctx)) if (p[dir] === args.acl) p[dir] = null;
      mut(ctx);
      return done();
    }
    case 'nat-if': for (const p of ifTargets(ctx)) p.nat = /outside/i.test(ctx.line) ? 'outside' : 'inside'; mut(ctx); return done();
    case 'no-nat-if': for (const p of ifTargets(ctx)) p.nat = null; mut(ctx); return done();
    case 'encap': {
      if (!sess.ctx.sub) return { lines: ['% Configure encapsulation on a subinterface (e.g. interface g0/1.10)'] };
      const s = dev.subifs[sess.ctx.sub];
      const clash = Object.values(dev.subifs).find(x => x !== s && x.parent === s.parent && x.vlan === args.vlan);
      if (clash) { L.push(`% Configuration of multiple subinterfaces of the same main`, `% interface with the same VID (${args.vlan}) is not permitted.`, `% This VID is already configured on ${longIf(clash.name)}.`); return done(); }
      s.vlan = args.vlan;
      s.native = /native/i.test(ctx.line);
      mut(ctx);
      return done();
    }
    case 'proxy': for (const p of ifTargets(ctx)) p.proxyArp = true; mut(ctx); return done();
    case 'no-proxy': for (const p of ifTargets(ctx)) p.proxyArp = false; mut(ctx); return done();
    case 'unreach': for (const p of ifTargets(ctx)) p.unreachables = true; mut(ctx); return done();
    case 'no-unreach': for (const p of ifTargets(ctx)) p.unreachables = false; mut(ctx); return done();
    default:
      L.push(`% Command not implemented in this training image: ${ctx.line}`);
      return done();
  }
}

function allL3(dev) {
  const out = [];
  for (const p of Object.values(dev.ports)) if (p.ip) out.push({ name: p.name, ip: p.ip });
  for (const s of Object.values(dev.subifs || {})) if (s.ip) out.push({ name: s.name, ip: s.ip });
  return out;
}

function l3Owns(dev, ip) { return allL3(dev).some(x => x.ip.addr === ip); }

function nextSeq(acl) {
  return acl.entries.length ? Math.max(...acl.entries.map(e => e.seq)) + 10 : 10;
}

function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

function addRanges(ranges, list) {
  const set = new Set();
  for (const [a, b] of ranges) for (let v = a; v <= b; v++) set.add(v);
  for (const v of list) set.add(v);
  return toRanges([...set]);
}

function subtractRanges(ranges, list) {
  const set = new Set();
  for (const [a, b] of ranges) for (let v = a; v <= b; v++) set.add(v);
  for (const v of list) set.delete(v);
  return toRanges([...set]);
}

function toRanges(vals) {
  const xs = vals.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push([xs[i], xs[j]]);
    i = j;
  }
  return out;
}

export function iosComplete(eng, sess, line) {
  const dev = eng.s.devices[sess.dev];
  const g = GRAMMARS[dev.kind === 'router' ? 'router' : 'switch'];
  return g.complete(sess.mode, normaliseIfSpacing(line));
}

export { promptFor };
