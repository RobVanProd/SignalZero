// Renderers for IOS show commands. Formats follow Cisco IOS 15.x / IOS-XE output closely, trimmed where noted.
import { fmtIp, fmtMask, networkOf, fmtRangeList, inSubnet } from '../engine/ipv4.js';
import { longIf, macCisco } from '../engine/model.js';
import { carries, stpDisabled, stpRecord, bridgePriority, portCost, knowsVlan, allVlans } from '../engine/switching.js';
import { l3Ifaces, describeAddr, hostAddr, lookup } from '../engine/routing.js';
import { wallClock } from '../engine/engine.js';
import { interfaceConfig6, routesConfig6, aclsConfig6 } from './ios-show6.js'; // ---- ipv6

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

export const PORT_NAMES = { 80: 'www', 53: 'domain', 67: 'bootps', 68: 'bootpc', 23: 'telnet', 25: 'smtp', 21: 'ftp', 69: 'tftp', 123: 'ntp', 161: 'snmp', 514: 'syslog', 110: 'pop3', 179: 'bgp' };

function shortIf(name) { return name.replace(/^Gi/, 'Gi').replace(/^Fa/, 'Fa'); }

function cdpIf(name) {
  const m = /^([A-Za-z]+)(.*)$/.exec(name);
  return m ? `${m[1] === 'Gi' ? 'Gig' : m[1]} ${m[2]}` : name;
}

export function portOpText(spec) {
  if (!spec) return '';
  const nm = p => PORT_NAMES[p] ?? String(p);
  if (spec.op === 'range') return ` range ${nm(spec.ports[0])} ${nm(spec.ports[1])}`;
  return ` ${spec.op} ${spec.ports.map(nm).join(' ')}`;
}

export function aceText(acl, e) {
  if (e.remark) return `remark ${e.remark}`;
  const log = e.log ? ' log' : '';
  if (acl.kind === 'standard') {
    if (e.src.any) return `${e.action} any${log}`;
    if (e.src.wild === 0) return `${e.action} host ${fmtIp(e.src.addr)}${log}`;
    return `${e.action} ${fmtIp(e.src.addr)} ${fmtIp(e.src.wild)}${log}`;
  }
  let t = `${e.action} ${e.proto} ${describeAddr(e.src, fmtIp)}${portOpText(e.sop)} ${describeAddr(e.dst, fmtIp)}${portOpText(e.dop)}`;
  if (e.icmpType) t += ` ${e.icmpType}`;
  if (e.established) t += ' established';
  return t + log;
}

function aceShow(acl, e) {
  if (e.remark) return null;
  const log = e.log ? ' log' : '';
  if (acl.kind === 'standard') {
    if (e.src.any) return `${e.action} any${log}`;
    if (e.src.wild === 0) return `${e.action} ${fmtIp(e.src.addr)}${log}`;
    return `${e.action} ${fmtIp(e.src.addr)}, wildcard bits ${fmtIp(e.src.wild)}${log}`;
  }
  return aceText(acl, e);
}

// ------------------------------------------------------------------ running-config

/** One interface's running-config block (no trailing "!"). */
export function interfaceConfig(d, name) {
  const p = d.ports[name];
  const s = d.subifs?.[name];
  const body = [`interface ${longIf(name)}`];
  if (s) {
    if (s.description) body.push(` description ${s.description}`);
    if (s.vlan !== null) body.push(` encapsulation dot1Q ${s.vlan}${s.native ? ' native' : ''}`);
    if (s.ip) body.push(` ip address ${fmtIp(s.ip.addr)} ${fmtMask(s.ip.len)}`);
    for (const h of s.helpers || []) body.push(` ip helper-address ${fmtIp(h)}`);
    if (s.relayTrust) body.push(' ip dhcp relay information trusted');
    if (s.aclIn) body.push(` ip access-group ${s.aclIn} in`);
    if (s.aclOut) body.push(` ip access-group ${s.aclOut} out`);
    if (s.ip && !s.proxyArp) body.push(' no ip proxy-arp');
    if (s.unreachables === false) body.push(' no ip unreachables');
    if (s.nat) body.push(` ip nat ${s.nat}`);
    if (!s.adminUp) body.push(' shutdown');
    body.push(...interfaceConfig6(s)); // ---- ipv6
    return body;
  }
  if (p.description) body.push(` description ${p.description}`);
  if (d.kind === 'switch' && p.kind === 'eth') {
    if (p.mode === 'trunk') {
      if (p.native !== 1) body.push(` switchport trunk native vlan ${p.native}`);
      if (p.allowed !== 'all') body.push(` switchport trunk allowed vlan ${p.allowed.length ? fmtRangeList(p.allowed) : 'none'}`);
      body.push(' switchport mode trunk');
    } else {
      if (p.accessVlan !== 1) body.push(` switchport access vlan ${p.accessVlan}`);
      body.push(' switchport mode access');
    }
    if (p.speed !== 'auto') body.push(` speed ${p.speed}`);
    if (p.duplex !== 'auto') body.push(` duplex ${p.duplex}`);
    if (!p.adminUp) body.push(' shutdown');
    if (p.portfast) body.push(p.mode === 'trunk' ? ' spanning-tree portfast trunk' : ' spanning-tree portfast');
    if (p.bpduguard) body.push(' spanning-tree bpduguard enable');
    if (p.snoopTrust) body.push(' ip dhcp snooping trust');
  } else if (d.kind === 'router' && p.kind === 'eth') {
    if (p.ip) body.push(` ip address ${fmtIp(p.ip.addr)} ${fmtMask(p.ip.len)}`);
    else body.push(' no ip address');
    for (const h of p.helpers || []) body.push(` ip helper-address ${fmtIp(h)}`);
    if (p.relayTrust) body.push(' ip dhcp relay information trusted');
    if (p.aclIn) body.push(` ip access-group ${p.aclIn} in`);
    if (p.aclOut) body.push(` ip access-group ${p.aclOut} out`);
    if (p.ip && !p.proxyArp) body.push(' no ip proxy-arp');
    if (p.nat) body.push(` ip nat ${p.nat}`);
    if (!p.adminUp) body.push(' shutdown');
    body.push(` duplex ${p.duplex}`, ` speed ${p.speed}`);
    body.push(...interfaceConfig6(p)); // ---- ipv6: IOS lists the IPv6 lines after duplex/speed
  }
  return body;
}

/** show running-config interface <if> */
export function runningConfigInterface(eng, d, name) {
  if (!d.ports[name] && !d.subifs?.[name]) return [`% Invalid input detected: no such interface`];
  const body = ['!', ...interfaceConfig(d, name), 'end'];
  return ['Building configuration...', '', `Current configuration : ${body.join('\n').length} bytes`, ...body];
}

export function runningConfig(eng, d) {
  const L = [];
  const w = wallClock(eng.s.t);
  L.push('Building configuration...', '');
  const body = [];
  body.push('!', `! Last configuration change at ${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')} UTC ${w.dow.slice(0, 3)} ${w.mon} ${w.day} ${w.year}`, '!');
  body.push(d.kind === 'router' ? 'version 15.7' : 'version 17.9', 'service timestamps debug datetime msec', 'service timestamps log datetime msec', 'no service password-encryption', '!', `hostname ${d.hostname}`, '!', 'no ip domain lookup');
  if (d.ipv6Routing) body.push('ipv6 unicast-routing'); // ---- ipv6
  body.push('!');
  if (d.relayTrustAll) body.push('ip dhcp relay information trust-all', '!');
  if (d.kind === 'switch') {
    if (d.snoop.vlans.length) body.push(`ip dhcp snooping vlan ${fmtRangeList(d.snoop.vlans)}`);
    if (d.snoop.opt82 === false) body.push('no ip dhcp snooping information option');
    if (d.snoop.enabled) body.push('ip dhcp snooping');
    body.push('vtp mode transparent', '!', `spanning-tree mode ${d.stp.mode}`, 'spanning-tree extend system-id');
    for (const [a, b] of d.stp.disabled || []) body.push(`no spanning-tree vlan ${a === b ? a : `${a}-${b}`}`);
    for (const [v, pr] of Object.entries(d.stp.priority || {})) body.push(`spanning-tree vlan ${v} priority ${pr}`);
    body.push('!');
    for (const [v, name] of Object.entries(d.vlans)) {
      if (v === '1') continue;
      body.push(`vlan ${v}`, ` name ${name}`, '!');
    }
  }
  for (const p of Object.values(d.ports)) {
    if (p.kind === 'console') continue;
    body.push(...interfaceConfig(d, p.name), '!');
    if (d.kind === 'router') {
      for (const s of Object.values(d.subifs).filter(x => x.parent === p.name).sort((a, b) => a.vlan - b.vlan)) body.push(...interfaceConfig(d, s.name), '!');
    }
  }
  if (d.kind === 'switch') body.push('interface Vlan1', ' no ip address', ' shutdown', '!');
  if (d.kind === 'router') {
    for (const r of d.nat) body.push(`ip nat inside source list ${r.acl} interface ${longIf(r.iface)}${r.overload ? ' overload' : ''}`);
    for (const r of d.routes) body.push(`ip route ${fmtIp(r.net)} ${fmtMask(r.len)} ${r.iface ? longIf(r.iface) + (r.nh !== null && r.nh !== undefined ? ' ' + fmtIp(r.nh) : '') : fmtIp(r.nh)}${r.ad && r.ad !== 1 ? ' ' + r.ad : ''}`);
    body.push('!');
    body.push(...routesConfig6(d)); // ---- ipv6: ipv6 route lines
    for (const [name, acl] of Object.entries(d.acls)) {
      if (/^\d+$/.test(name)) {
        for (const e of acl.entries) body.push(`access-list ${name} ${aceText(acl, e)}`);
      } else {
        body.push(`ip access-list ${acl.kind} ${name}`);
        for (const e of [...acl.entries].sort((a, b) => a.seq - b.seq)) body.push(` ${aceText(acl, e)}`);
      }
      body.push('!');
    }
    body.push(...aclsConfig6(d)); // ---- ipv6: ipv6 access-lists
  }
  body.push('line con 0', ' logging synchronous', 'line vty 0 4', ' login local', ' transport input ssh', '!', 'end');
  const bytes = body.join('\n').length;
  L.push(`Current configuration : ${bytes} bytes`, ...body);
  return L;
}

// ------------------------------------------------------------------ interfaces

function ifStatus(eng, d, p) {
  const l = eng.linkAt(d.id, p.name);
  if (p.errDisabled) return { status: 'err-disabled', up: false, line: 'down', reason: 'err-disabled' };
  if (!p.adminUp) return { status: 'disabled', up: false, line: 'down', admin: true };
  if (!l) return { status: 'notconnect', up: false, line: 'down' };
  const ls = eng.linkStatus(l.id);
  if (!ls.up) return { status: 'notconnect', up: false, line: 'down' };
  const side = l.a.dev === d.id && l.a.port === p.name ? 'A' : 'B';
  return { status: 'connected', up: true, line: 'up', speed: ls.speed, duplex: ls['duplex' + side], ls };
}

export function showIpIntBrief(eng, d) {
  const L = [`${pad('Interface', 23)}${pad('IP-Address', 16)}OK? Method Status                Protocol`];
  const row = (name, ipText, status, proto) => L.push(`${pad(longIf(name), 23)}${pad(ipText, 16)}YES ${pad(ipText === 'unassigned' ? 'unset' : 'NVRAM', 7)}${pad(status, 22)}${proto}`);
  for (const p of Object.values(d.ports)) {
    if (p.kind === 'console') continue;
    const st = ifStatus(eng, d, p);
    const status = st.admin ? 'administratively down' : st.up ? 'up' : 'down';
    row(p.name, p.ip ? fmtIp(p.ip.addr) : 'unassigned', status, st.up ? 'up' : 'down');
    if (d.kind === 'router') {
      for (const s of Object.values(d.subifs).filter(x => x.parent === p.name).sort((a, b) => a.vlan - b.vlan)) {
        const sstatus = !s.adminUp ? 'administratively down' : st.up ? 'up' : 'down';
        row(s.name, s.ip ? fmtIp(s.ip.addr) : 'unassigned', sstatus, s.adminUp && st.up ? 'up' : 'down');
      }
    }
  }
  if (d.kind === 'switch') row('Vlan1', 'unassigned', 'administratively down', 'down');
  return L;
}

export function showIntStatus(eng, d) {
  const L = [`${pad('Port', 10)}${pad('Name', 19)}${pad('Status', 13)}${pad('Vlan', 11)}${pad('Duplex', 7)}${pad('Speed', 7)}Type`];
  for (const p of Object.values(d.ports)) {
    if (p.kind === 'console') continue;
    const st = ifStatus(eng, d, p);
    const vlan = p.mode === 'trunk' ? 'trunk' : String(p.accessVlan);
    let dup = p.duplex === 'auto' ? 'auto' : p.duplex;
    let spd = p.speed === 'auto' ? 'auto' : String(p.speed);
    if (st.up) {
      dup = (p.duplex === 'auto' ? 'a-' : '') + st.duplex;
      spd = (p.speed === 'auto' ? 'a-' : '') + st.speed;
    }
    L.push(`${pad(p.name, 10)}${pad(p.description.slice(0, 18), 19)}${pad(st.status, 13)}${pad(vlan, 11)}${lpad(dup, 6)} ${lpad(spd, 6)} 10/100/1000BaseTX`);
  }
  return L;
}

export function showInterface(eng, d, name) {
  const p = d.ports[name];
  const sub = d.subifs?.[name];
  if (!p && !sub) return ['% Invalid input detected: no such interface'];
  if (sub) {
    const parent = d.ports[sub.parent];
    const st = ifStatus(eng, d, parent);
    return [
      `${longIf(name)} is ${!sub.adminUp ? 'administratively down' : st.up ? 'up' : 'down'}, line protocol is ${sub.adminUp && st.up ? 'up' : 'down'}`,
      `  Hardware is PQ3_TSEC, address is ${macCisco(parent.mac)} (bia ${macCisco(parent.mac)})`,
      sub.description ? `  Description: ${sub.description}` : null,
      sub.ip ? `  Internet address is ${fmtIp(sub.ip.addr)}/${sub.ip.len}` : '  Internet address is unassigned',
      '  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,',
      '     reliability 255/255, txload 1/255, rxload 1/255',
      `  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${sub.vlan}.`,
      '  ARP type: ARPA, ARP Timeout 04:00:00',
      '  Keepalive set (10 sec)',
      '  Last clearing of "show interface" counters never',
    ].filter(Boolean);
  }
  const st = ifStatus(eng, d, p);
  const c = p.counters || {};
  const n = k => Math.floor(c[k] || 0);
  const lineState = st.admin ? 'administratively down' : st.up ? 'up' : 'down';
  const L = [
    `${longIf(name)} is ${lineState}, line protocol is ${st.up ? 'up' : 'down'}${d.kind === 'switch' ? ` (${st.status})` : ''}`,
    `  Hardware is Gigabit Ethernet, address is ${macCisco(p.mac)} (bia ${macCisco(p.mac)})`,
  ];
  if (p.description) L.push(`  Description: ${p.description}`);
  if (p.ip) L.push(`  Internet address is ${fmtIp(p.ip.addr)}/${p.ip.len}`);
  L.push('  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,', '     reliability 255/255, txload 1/255, rxload 1/255', '  Encapsulation ARPA, loopback not set', '  Keepalive set (10 sec)');
  if (st.up) {
    const dup = st.duplex === 'full' ? 'Full-duplex' : 'Half-duplex';
    L.push(`  ${dup}, ${st.speed}Mb/s, media type is 10/100/1000BaseTX`);
  } else L.push('  Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX');
  const rate = st.up ? Math.round(40 + (c.bcast || 0) / Math.max(1, eng.s.t) ) : 0;
  L.push(
    '  input flow-control is off, output flow-control is unsupported',
    '  ARP type: ARPA, ARP Timeout 04:00:00',
    `  Last clearing of "show interface" counters ${c.cleared !== undefined ? fmtAgo(eng.s.t - c.cleared) : 'never'}`,
    '  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0',
    '  Queueing strategy: fifo',
    `  5 minute input rate ${rate * 780} bits/sec, ${rate} packets/sec`,
    `  5 minute output rate ${rate * 760} bits/sec, ${rate} packets/sec`,
    `     ${n('inPkts')} packets input, ${n('inPkts') * 512} bytes, 0 no buffer`,
    `     Received ${n('bcast')} broadcasts (${Math.floor(n('bcast') * 0.3)} multicasts)`,
    `     ${n('runts')} runts, 0 giants, 0 throttles`,
    `     ${n('inErr')} input errors, ${n('crc')} CRC, 0 frame, 0 overrun, 0 ignored`,
    '     0 watchdog, 0 multicast, 0 pause input',
    `     ${n('outPkts')} packets output, ${n('outPkts') * 505} bytes, 0 underruns`,
    `     ${n('outErr')} output errors, ${n('collisions')} collisions, 1 interface resets`,
    '     0 unknown protocol drops',
    `     0 babbles, ${n('lateCol')} late collision, 0 deferred`,
    '     0 lost carrier, 0 no carrier, 0 pause output',
    '     0 output buffer failures, 0 output buffers swapped out',
  );
  return L;
}

function fmtAgo(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function showIntTrunk(eng, d) {
  const trunks = Object.values(d.ports).filter(p => p.mode === 'trunk' && p.kind === 'eth');
  const up = trunks.filter(p => ifStatus(eng, d, p).up);
  const L = ['', `${pad('Port', 12)}${pad('Mode', 13)}${pad('Encapsulation', 15)}${pad('Status', 14)}Native vlan`];
  for (const p of up) L.push(`${pad(p.name, 12)}${pad('on', 13)}${pad('802.1q', 15)}${pad('trunking', 14)}${p.native}`);
  L.push('', `${pad('Port', 12)}Vlans allowed on trunk`);
  for (const p of up) L.push(`${pad(p.name, 12)}${p.allowed === 'all' ? '1-4094' : fmtRangeList(p.allowed) || 'none'}`);
  L.push('', `${pad('Port', 12)}Vlans allowed and active in management domain`);
  for (const p of up) {
    const act = Object.keys(d.vlans).map(Number).filter(v => carries(d, p, v));
    L.push(`${pad(p.name, 12)}${fmtRangeList(act) || 'none'}`);
  }
  L.push('', `${pad('Port', 12)}Vlans in spanning tree forwarding state and not pruned`);
  for (const p of up) {
    const fw = Object.keys(d.vlans).map(Number).filter(v => carries(d, p, v) && (stpDisabled(d, v) || stpRecord(eng, d.id, v, p.name)?.st === 'forwarding'));
    L.push(`${pad(p.name, 12)}${fmtRangeList(fw) || 'none'}`);
  }
  return L;
}

export function showVlanBrief(eng, d) {
  const L = [`${pad('VLAN', 5)}${pad('Name', 33)}${pad('Status', 10)}Ports`, '---- -------------------------------- --------- -------------------------------'];
  for (const [v, name] of Object.entries(d.vlans)) {
    const ports = Object.values(d.ports).filter(p => p.kind === 'eth' && p.mode === 'access' && p.accessVlan === Number(v)).map(p => p.name);
    const chunks = [];
    for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(', '));
    L.push(`${pad(v, 5)}${pad(name, 33)}${pad('active', 10)}${chunks[0] || ''}`);
    for (const c of chunks.slice(1)) L.push(`${' '.repeat(48)}${c}`);
  }
  const orphan = Object.values(d.ports).filter(p => p.kind === 'eth' && p.mode === 'access' && !knowsVlan(d, p.accessVlan));
  if (orphan.length) L.push('', `% Ports in VLANs not in the VLAN database (inactive): ${orphan.map(p => `${p.name} (VLAN ${p.accessVlan})`).join(', ')}`);
  for (const id of [1002, 1003, 1004, 1005]) L.push(`${pad(id, 5)}${pad({ 1002: 'fddi-default', 1003: 'token-ring-default', 1004: 'fddinet-default', 1005: 'trnet-default' }[id], 33)}act/unsup`);
  return L;
}

// ------------------------------------------------------------------ spanning tree

export function showSpanningTree(eng, d, vlan) {
  eng.ensure();
  const vlans = vlan ? [vlan] : Object.keys(d.vlans).map(Number);
  const L = [];
  let any = false;
  for (const v of vlans) {
    if (!knowsVlan(d, v)) { if (vlan) L.push(`Spanning tree instance(s) for vlan ${v} does not exist.`); continue; }
    if (stpDisabled(d, v)) { if (vlan) L.push(`Spanning tree instance(s) for vlan ${v} does not exist.`); continue; }
    const ports = Object.values(d.ports).filter(p => stpRecord(eng, d.id, v, p.name));
    if (!ports.length) { if (vlan) L.push(`Spanning tree instance(s) for vlan ${v} does not exist.`); continue; }
    any = true;
    const info = eng.stpInfo?.[v] || {};
    const rootId = info.rootOf?.[d.id] ?? d.id;
    const root = eng.s.devices[rootId];
    const myPrio = bridgePriority(d, v);
    const rootPrio = bridgePriority(root, v);
    const cost = info.dist?.[d.id] ?? 0;
    const rootPort = ports.find(p => stpRecord(eng, d.id, v, p.name).role === 'root');
    const proto = d.stp.mode === 'rapid-pvst' ? 'rstp' : 'ieee';
    L.push(`VLAN${String(v).padStart(4, '0')}`, `  Spanning tree enabled protocol ${proto}`);
    L.push(`  Root ID    Priority    ${rootPrio}`, `             Address     ${macCisco(root.mac)}`);
    if (rootId === d.id) L.push('             This bridge is the root');
    else L.push(`             Cost        ${cost}`, `             Port        ${Object.keys(d.ports).indexOf(rootPort?.name) + 1} (${longIf(rootPort?.name || '')})`);
    L.push('             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec', '');
    L.push(`  Bridge ID  Priority    ${myPrio}  (priority ${myPrio - v} sys-id-ext ${v})`, `             Address     ${macCisco(d.mac)}`, '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec', '             Aging Time  300 sec', '');
    L.push(`${pad('Interface', 20)}Role Sts Cost      Prio.Nbr Type`, '------------------- ---- --- --------- -------- --------------------------------');
    const roleCode = { root: 'Root', designated: 'Desg', alternate: 'Altn', backup: 'Back' };
    const stCode = { forwarding: 'FWD', blocking: 'BLK', listening: 'LIS', learning: 'LRN' };
    for (const p of ports) {
      const r = stpRecord(eng, d.id, v, p.name);
      const l = eng.linkAt(d.id, p.name);
      const c = portCost(l ? eng.linkStatus(l.id).speed : 1000);
      // RSTP has no listening state: discarding. A PVID-inconsistent port is "broken": BKN* and *PVID_Inc.
      const sts = r.inc ? 'BKN*' : (r.st === 'blocking' || r.st === 'listening') && d.stp.mode === 'rapid-pvst' ? 'BLK' : stCode[r.st];
      const type = `${r.p2p === false ? 'Shr' : 'P2p'}${r.edge ? ' Edge' : ''}${d.stp.mode === 'rapid-pvst' && r.peer === 'pvst' ? ' Peer(STP)' : ''}${r.inc ? ` *${r.inc}_Inc` : ''}`;
      L.push(`${pad(p.name, 20)}${pad(roleCode[r.role] || 'Desg', 5)}${pad(sts, 4)}${pad(c, 10)}${pad(`128.${Object.keys(d.ports).indexOf(p.name) + 1}`, 9)}${type}`);
    }
    L.push('');
  }
  if (!any && !vlan) L.push('No spanning tree instance exists.');
  return L;
}

// ------------------------------------------------------------------ MAC / ARP / CDP

/** Derive the MAC table from real flooding: where would frames from each endpoint arrive? */
export function macTable(eng, sw) {
  const rows = [];
  const seen = new Set();
  for (const d of Object.values(eng.s.devices)) {
    const emitters = [];
    if (d.kind === 'host' || d.kind === 'fleet') {
      if (d.powered === false) continue;
      emitters.push({ port: d.nic, tag: null, mac: d.ports[d.nic].mac });
      if (d.kind === 'fleet') for (const m of d.leases.slice(0, 3)) emitters.push({ port: d.nic, tag: null, mac: m.mac });
    } else if (d.kind === 'router') {
      for (const i of l3Ifaces(eng, d)) if (i.up) emitters.push({ port: i.port, tag: i.tag, mac: d.ports[i.port].mac });
    } else continue;
    for (const em of emitters) {
      const fl = eng.flood(d.id, em.port, em.tag);
      for (const ep of [...fl.endpoints, ...fl.drops.map(x => ({ path: x.path || [] }))]) {
        for (const h of ep.path || []) {
          if (h.to.dev !== sw.id) continue;
          const key = `${h.vlan}|${em.mac}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ vlan: h.vlan, mac: em.mac, port: h.to.port });
        }
      }
    }
  }
  rows.sort((a, b) => a.vlan - b.vlan || a.port.localeCompare(b.port, undefined, { numeric: true }));
  return rows;
}

export function showMacTable(eng, sw, filter = {}) {
  let rows = macTable(eng, sw);
  if (filter.mac) rows = rows.filter(r => r.mac === filter.mac);
  if (filter.port) rows = rows.filter(r => r.port === filter.port);
  if (filter.vlan) rows = rows.filter(r => r.vlan === filter.vlan);
  const L = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  for (const r of rows) L.push(`${lpad(r.vlan, 4)}    ${macCisco(r.mac)}    DYNAMIC     ${r.port}`);
  L.push(`Total Mac Addresses for this criterion: ${rows.length}`);
  return L;
}

export function showArp(eng, d) {
  const L = [`${pad('Protocol', 10)}${pad('Address', 17)}${pad('Age (min)', 11)}${pad('Hardware Addr', 16)}${pad('Type', 7)}Interface`];
  for (const i of l3Ifaces(eng, d)) {
    if (!i.up) continue;
    L.push(`${pad('Internet', 10)}${pad(fmtIp(i.addr), 17)}${pad('-', 11)}${pad(macCisco(d.ports[i.port].mac), 16)}${pad('ARPA', 7)}${longIf(i.name)}`);
    const fl = eng.flood(d.id, i.port, i.tag);
    for (const ep of fl.endpoints) {
      const od = eng.s.devices[ep.dev];
      if (od.kind !== 'host') continue;
      const a = hostAddr(eng, od);
      if (a.addr === null || !inSubnet(a.addr, i.addr, i.len)) continue;
      L.push(`${pad('Internet', 10)}${pad(fmtIp(a.addr), 17)}${pad(String(1 + (od.index % 9)), 11)}${pad(macCisco(od.ports[od.nic].mac), 16)}${pad('ARPA', 7)}${longIf(i.name)}`);
    }
  }
  return L;
}

export function showCdp(eng, d) {
  const L = [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,',
    '                  D - Remote, C - CVTA, M - Two-port Mac Relay', '',
    `${pad('Device ID', 17)}${pad('Local Intrfce', 18)}${pad('Holdtme', 11)}${pad('Capability', 12)}${pad('Platform', 10)}Port ID`,
  ];
  for (const p of Object.values(d.ports)) {
    const l = eng.linkAt(d.id, p.name);
    if (!l || !eng.linkStatus(l.id).up) continue;
    const peer = l.a.dev === d.id && l.a.port === p.name ? l.b : l.a;
    const od = eng.s.devices[peer.dev];
    if (od.os !== 'ios') continue;
    L.push(`${pad(od.hostname, 17)}${pad(cdpIf(p.name), 18)}${pad(String(120 + (od.index * 7) % 50), 11)}${pad(od.kind === 'router' ? 'R B S I' : 'S I', 12)}${pad(od.model.slice(0, 9), 10)}${cdpIf(peer.port)}`);
  }
  L.push('', `Total cdp entries displayed : ${L.length - 5}`);
  return L;
}

export function showLogging(eng, d) {
  const L = [
    'Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns)',
    '    Console logging: level debugging',
    '    Buffer logging:  level debugging',
    '', `Log Buffer (8192 bytes):`,
  ];
  for (const e of d.logging || []) L.push(e.text);
  return L;
}

// ------------------------------------------------------------------ routing

function classfulOf(net) {
  const first = net >>> 24;
  if (first < 128) return { net: (net & 0xff000000) >>> 0, len: 8 };
  if (first < 192) return { net: (net & 0xffff0000) >>> 0, len: 16 };
  return { net: (net & 0xffffff00) >>> 0, len: 24 };
}

/** Static route tail: "[1/0] via 198.51.100.1", "... via 198.51.100.1, Gi0/0" or "is directly connected, Gi0/0". */
function staticVia(r) {
  if (r.nh === null || r.nh === undefined) return `is directly connected, ${longIf(r.iface)}`;
  return `[${r.ad}/0] via ${fmtIp(r.nh)}${r.exitIf ? `, ${longIf(r.iface)}` : ''}`;
}

export function showIpRoute(eng, d, only = null) {
  const { table: all, notInstalled } = eng.routes(d.id);
  const table = only ? all.filter(r => only.includes(r.type)) : all;
  const L = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2',
    '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
    '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
    '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
    '       + - replicated route, % - next hop override', '',
  ];
  const def = table.find(r => r.len === 0);
  L.push(def ? `Gateway of last resort is ${fmtIp(def.nh ?? 0)} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  if (def) L.push(`S*    0.0.0.0/0 ${staticVia(def)}`);
  const groups = new Map();
  for (const r of table) {
    if (r.len === 0) continue;
    const c = classfulOf(r.net);
    const k = `${c.net}/${c.len}`;
    if (!groups.has(k)) groups.set(k, { c, routes: [] });
    groups.get(k).routes.push(r);
  }
  for (const { c, routes } of [...groups.values()].sort((a, b) => a.c.net - b.c.net)) {
    const masks = new Set(routes.map(r => r.len));
    if (masks.size > 1) L.push(`      ${fmtIp(c.net)}/${c.len} is variably subnetted, ${routes.length} subnets, ${masks.size} masks`);
    else L.push(`      ${fmtIp(c.net)}/${[...masks][0]} is subnetted, ${routes.length} subnets`);
    routes.sort((a, b) => a.net - b.net || a.len - b.len);
    for (const r of routes) {
      const pfx = masks.size > 1 ? `${fmtIp(r.net)}/${r.len}` : fmtIp(r.net);
      if (r.type === 'S') L.push(`S        ${pfx} ${staticVia(r)}`);
      else L.push(`${r.type}        ${pfx} is directly connected, ${longIf(r.iface)}`);
    }
  }
  return { lines: L, notInstalled };
}

/** show ip route <address>: the longest-match entry, trimmed to the lines that matter. */
export function showIpRouteEntry(eng, d, ip) {
  const best = lookup(eng.routes(d.id).table, ip);
  if (!best) return ['% Network not in table'];
  const pfx = best.len === 0 ? '0.0.0.0/0, supernet' : `${fmtIp(best.net)}/${best.len}`;
  const via = best.nh !== null && best.nh !== undefined ? `${fmtIp(best.nh)}${best.exitIf ? `, via ${longIf(best.iface)}` : ''}` : `directly connected, via ${longIf(best.iface)}`;
  const known = best.type === 'S'
    ? `  Known via "static", distance ${best.ad}, metric 0${best.nh == null ? ' (connected)' : ''}${best.len === 0 ? ', candidate default path' : ''}`
    : `  Known via "connected", distance 0, metric 0 (connected${best.type === 'C' ? ', via interface' : ''})`;
  return [`Routing entry for ${pfx}`, known, '  Routing Descriptor Blocks:', `  * ${via}`, '      Route metric is 0, traffic share count is 1'];
}

/** show ip interface [<if>] (IOS 15 layout, trimmed to the lines a troubleshooter reads). */
export function showIpInterface(eng, d, name) {
  const names = name ? [name] : Object.values(d.ports).filter(p => p.kind === 'eth').flatMap(p => [p.name, ...Object.values(d.subifs || {}).filter(x => x.parent === p.name).sort((a, b) => a.vlan - b.vlan).map(x => x.name)]);
  const L = [];
  for (const n of names) {
    const c = d.ports[n] || d.subifs?.[n];
    if (!c) return ['% Invalid input detected: no such interface'];
    const st = ifStatus(eng, d, d.ports[c.parent || n]);
    const admin = c.parent ? !c.adminUp : st.admin; // same rule as "show ip interface brief"
    L.push(`${longIf(n)} is ${admin ? 'administratively down' : st.up ? 'up' : 'down'}, line protocol is ${!admin && st.up ? 'up' : 'down'}`);
    if (!c.ip) { L.push('  Internet protocol processing disabled'); continue; }
    const helpers = c.helpers || [];
    L.push(`  Internet address is ${fmtIp(c.ip.addr)}/${c.ip.len}`, '  Broadcast address is 255.255.255.255', '  Address determined by non-volatile memory', '  MTU is 1500 bytes');
    if (!helpers.length) L.push('  Helper address is not set');
    else L.push(`  Helper address${helpers.length > 1 ? 'es are' : ' is'} ${fmtIp(helpers[0])}`, ...helpers.slice(1).map(h => `${' '.repeat(helpers.length > 1 ? 23 : 20)}${fmtIp(h)}`));
    L.push('  Directed broadcast forwarding is disabled',
      `  Outgoing access list is ${c.aclOut || 'not set'}`, `  Inbound  access list is ${c.aclIn || 'not set'}`,
      `  Proxy ARP is ${c.proxyArp ? 'enabled' : 'disabled'}`, '  Local Proxy ARP is disabled', '  Security level is default', '  Split horizon is enabled',
      '  ICMP redirects are always sent', `  ICMP unreachables are ${c.unreachables === false ? 'never' : 'always'} sent`, '  ICMP mask replies are never sent',
      '  IP fast switching is enabled', '  IP CEF switching is enabled',
      c.nat ? `  Network address translation is enabled, interface in domain ${c.nat}` : '  Network address translation is disabled');
  }
  return L;
}

/** show interfaces <if> switchport (private-VLAN and capture lines trimmed). */
export function showSwitchport(eng, d, name) {
  const p = d.ports[name];
  if (!p || p.kind !== 'eth') return ['% Invalid input detected: no such interface'];
  const st = ifStatus(eng, d, p);
  const trunk = p.mode === 'trunk';
  const vname = v => (v === 1 ? 'default' : knowsVlan(d, v) ? d.vlans[v] : 'Inactive');
  return [
    `Name: ${p.name}`, 'Switchport: Enabled',
    `Administrative Mode: ${trunk ? 'trunk' : 'static access'}`,
    `Operational Mode: ${!st.up ? 'down' : trunk ? 'trunk' : 'static access'}`,
    'Administrative Trunking Encapsulation: dot1q',
    ...(trunk && st.up ? ['Operational Trunking Encapsulation: dot1q'] : []),
    `Negotiation of Trunking: ${trunk ? 'On' : 'Off'}`,
    `Access Mode VLAN: ${p.accessVlan} (${vname(p.accessVlan)})`,
    `Trunking Native Mode VLAN: ${p.native} (${vname(p.native)})`,
    'Administrative Native VLAN tagging: enabled', 'Voice VLAN: none',
    `Trunking VLANs Enabled: ${p.allowed === 'all' ? 'ALL' : fmtRangeList(p.allowed) || 'NONE'}`,
    'Pruning VLANs Enabled: 2-1001', '', 'Protected: false', 'Unknown unicast blocked: disabled', 'Unknown multicast blocked: disabled', 'Appliance trust: none',
  ];
}

export function showAccessLists(eng, d, name) {
  const L = [];
  for (const [n, acl] of Object.entries(d.acls)) {
    if (name && n !== name) continue;
    L.push(`${acl.kind === 'standard' ? 'Standard' : 'Extended'} IP access list ${n}`);
    for (const e of [...acl.entries].sort((a, b) => a.seq - b.seq)) {
      const t = aceShow(acl, e);
      if (t === null) continue;
      L.push(`    ${e.seq} ${t}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''}`);
    }
  }
  return L;
}

export function showNat(eng, d) {
  const L = [`${pad('Pro', 4)}${pad('Inside global', 22)}${pad('Inside local', 22)}${pad('Outside local', 22)}Outside global`];
  for (const t of (eng.s.natLog || []).filter(x => x.router === d.id).slice(-12)) {
    L.push(`${pad(t.proto, 4)}${pad(`${fmtIp(t.outside)}:${t.port}`, 22)}${pad(`${fmtIp(t.inside)}:${t.insidePort}`, 22)}${pad(`${fmtIp(t.remote)}:${t.remotePort}`, 22)}${fmtIp(t.remote)}:${t.remotePort}`);
  }
  return L;
}

export function showSnooping(eng, d) {
  const L = [`Switch DHCP snooping is ${d.snoop.enabled ? 'enabled' : 'disabled'}`, 'Switch DHCP gleaning is disabled', 'DHCP snooping is configured on following VLANs:', d.snoop.vlans.length ? fmtRangeList(d.snoop.vlans) : 'none', 'DHCP snooping is operational on following VLANs:', d.snoop.enabled && d.snoop.vlans.length ? fmtRangeList(d.snoop.vlans) : 'none', `Insertion of option 82 is ${d.snoop.opt82 === false ? 'disabled' : 'enabled'}`, '   circuit-id default format: vlan-mod-port', '   remote-id: ' + macCisco(d.mac) + ' (MAC)', 'Option 82 on untrusted port is not allowed', 'Verification of hwaddr field is enabled', 'Verification of giaddr field is enabled', 'DHCP snooping trust/rate is configured on the following Interfaces:', '', `${pad('Interface', 27)}${pad('Trusted', 11)}${pad('Allow option', 16)}Rate limit (pps)`, '-----------------------    -------    ------------    ----------------'];
  for (const p of Object.values(d.ports)) if (p.snoopTrust) L.push(`${pad(longIf(p.name), 27)}${pad('yes', 11)}${pad('yes', 16)}unlimited`);
  return L;
}

export function showCpu(eng, d) {
  const storm = [...eng.storms().entries()].some(([, links]) => [...links].some(id => { const l = eng.s.links[id]; return l.a.dev === d.id || l.b.dev === d.id; }));
  const a = storm ? 99 : 3;
  const b = storm ? 96 : 0;
  return [
    `CPU utilization for five seconds: ${a}%/${b}%; one minute: ${storm ? 98 : 2}%; five minutes: ${storm ? 91 : 2}%`,
    ' PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process',
    storm ? ' 192     8812441     4410221       1998 61.43% 60.11% 55.80%   0 ARP Input' : '  95       12014       88231        136  0.31%  0.22%  0.20%   0 IP Input',
    storm ? '  93     3412220     1902117       1793 23.11% 22.84% 21.02%   0 Hulc LED Process' : '  93        8812       45120        195  0.23%  0.21%  0.21%   0 Hulc LED Process',
    storm ? '  61     2210443      999121       2212 11.02% 10.85% 10.11%   0 Spanning Tree' : '  61        2412       30111         80  0.07%  0.05%  0.05%   0 Spanning Tree',
  ];
}

export function showTdr(eng, d, name) {
  const p = d.ports[name];
  if (!p) return ['% Invalid interface'];
  const l = eng.linkAt(d.id, name);
  const w = wallClock(eng.s.t);
  const perm = p.permLength ?? (l ? l.lengthM : 2);
  let status = 'Open';
  let len = perm;
  if (l) {
    const ls = eng.linkStatus(l.id);
    if (ls.up) { status = 'Normal'; len = l.lengthM; }
    else if (l.cut) { status = 'Open'; len = Math.max(1, Math.round(l.lengthM * 0.6)); }
    else status = 'Normal';
  }
  const L = [`TDR test last run on: ${w.mon} ${w.day} ${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')}`, '', 'Interface Speed Local pair Pair length        Remote pair Pair status', '--------- ----- ---------- ------------------ ----------- --------------------'];
  ['A', 'B', 'C', 'D'].forEach((pair, i) => {
    L.push(`${pad(i === 0 ? name : '', 10)}${pad(i === 0 ? 'auto' : '', 6)}${pad(`Pair ${pair}`, 11)}${pad(`${pad(len, 4)} +/- 4  meters`, 19)}${pad(status === 'Normal' ? `Pair ${pair}` : 'N/A', 12)}${status}`);
  });
  return L;
}

export { shortIf, ifStatus };
