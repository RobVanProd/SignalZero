// ---- ipv6: host-side IPv6 output for the Windows 11 and Ubuntu 24.04 shells (ipconfig, route print -6, netsh,
// ip -6 addr/route/neigh). Formats follow published captures of those tools; see docs/topics/ipv6.md for sources
// and for the lines whose exact spacing is unverified.
import { fmtIp6, fmtCidr6, prefix6, parseIp6, solicitedNode } from '../engine/ipv6.js';
import { hostAddr6, hostIid, l3Ifaces6 } from '../engine/net6.js';
import { macWindows, macLinux } from '../engine/model.js';

/** Windows interface index (also the %zone of link-local addresses); matches arp -a's 0x7 / 0x9. */
export const winIfIndex = d => (d.nic === 'wlan0' ? 9 : 7);
export const zoneWin = d => `%${winIfIndex(d)}`;

function life(sec) {
  if (sec === null || sec === undefined || sec === Infinity) return 'infinite';
  let s = Math.max(0, Math.floor(sec));
  const dd = Math.floor(s / 86400); s -= dd * 86400;
  const hh = Math.floor(s / 3600); s -= hh * 3600;
  const mm = Math.floor(s / 60); s -= mm * 60;
  if (dd) return `${dd}d${hh}h${mm}m`;
  if (hh) return `${hh}h${mm}m${s}s`;
  return `${mm}m${s}s`;
}

// ------------------------------------------------------------------ Windows

/**
 * IPv6 lines of ipconfig for one adapter: { addr: [lines before the IPv4 address], gw: [gateway values, IPv6 first],
 * iaid: [/all DHCPv6 lines] }. dots(label) is ipconfig's label formatter.
 */
export function winIpconfig6(eng, d, all, dots) {
  const a = hostAddr6(eng, d);
  const out = { addr: [], gw: [], iaid: [] };
  if (!a.enabled || !a.linkUp) return out;
  const st = x => (all ? (x.deprecated ? '(Deprecated)' : '(Preferred)') : '');
  for (const x of a.addrs.filter(y => y.kind === 'static' || y.kind === 'slaac')) out.addr.push(`${dots('IPv6 Address.')}${fmtIp6(x.addr)}${st(x)}`);
  for (const x of a.addrs.filter(y => y.kind === 'temp')) out.addr.push(`${dots('Temporary IPv6 Address.')}${fmtIp6(x.addr)}${st(x)}`);
  out.addr.push(`${dots('Link-local IPv6 Address')}${fmtIp6(a.ll)}${zoneWin(d)}${all ? '(Preferred)' : ''}`);
  for (const r of a.routers) out.gw.push(`${fmtIp6(r.addr)}${/^fe80/.test(fmtIp6(r.addr)) ? zoneWin(d) : ''}`);
  if (all) {
    const iid = hostIid(d);
    out.iaid.push(`${dots('DHCPv6 IAID')}${(parseInt(iid.slice(0, 7), 16) % 200000000) + 1000000}`);
    // DUID-LLT (RFC 8415 11.2): type 1, hardware type 1 (Ethernet), time, link-layer address
    const t = (0x30a1c2f4 + d.index * 7919).toString(16).padStart(8, '0').slice(-8);
    out.iaid.push(`${dots('DHCPv6 Client DUID.')}${['00', '01', '00', '01', ...t.match(/../g), ...d.ports[d.nic].mac.match(/../g)].join('-').toUpperCase()}`);
  }
  return out;
}

/** route print -6 / netstat -r IPv6 section. */
export function winRoutePrint6(eng, d) {
  const a = hostAddr6(eng, d);
  const idx = winIfIndex(d);
  const L = ['IPv6 Route Table', '===========================================================================', 'Active Routes:', ' If Metric Network Destination      Gateway'];
  const row = (ifi, metric, dst, gw) => {
    const head = `${String(ifi).padStart(3)}${String(metric).padStart(7)} `;
    if (dst.length > 24) L.push(`${head}${dst}`, `${' '.repeat(36)}${gw}`);
    else L.push(`${head}${dst.padEnd(25)}${gw}`);
  };
  const up = a.enabled && a.linkUp;
  if (up) for (const r of a.routers) row(idx, 281, '::/0', fmtIp6(r.addr));
  row(1, 331, '::1/128', 'On-link');
  if (up) {
    for (const p of a.onlink) row(idx, 281, fmtCidr6(p.net, p.len), 'On-link');
    for (const x of a.addrs) row(idx, 281, `${fmtIp6(x.addr)}/128`, 'On-link');
    row(idx, 281, 'fe80::/64', 'On-link');
    row(idx, 281, `${fmtIp6(a.ll)}/128`, 'On-link');
  }
  row(1, 331, 'ff00::/8', 'On-link');
  if (up) row(idx, 281, 'ff00::/8', 'On-link');
  L.push('===========================================================================', 'Persistent Routes:', '  None');
  return L;
}

/** netsh interface ipv6 show neighbors */
export function winNetshNeighbors(eng, d) {
  const a = hostAddr6(eng, d);
  const head = ['', 'Internet Address                              Physical Address   Type', '--------------------------------------------  -----------------  -----------'];
  const row = (addr, mac, type) => `${addr.padEnd(46)}${(mac || '').padEnd(19)}${type}`;
  const L = ['', 'Interface 1: Loopback Pseudo-Interface 1', '', ...head, row('ff02::c', '', 'Permanent'), row('ff02::16', '', 'Permanent'), row('ff02::1:2', '', 'Permanent'), ''];
  L.push(`Interface ${winIfIndex(d)}: ${d.nic === 'wlan0' ? 'Wi-Fi' : 'Ethernet'}`, '', ...head);
  if (a.enabled && a.linkUp) {
    for (const r of a.routers) {
      const rd = eng.s.devices[r.dev];
      const ifc = rd ? l3Ifaces6(eng, rd).find(i => i.name === r.iface) : null;
      const mac = ifc ? rd.ports[ifc.port].mac : null;
      L.push(row(fmtIp6(r.addr), mac ? macWindows(mac).toLowerCase() : '', mac ? 'Reachable (Router)' : 'Unreachable (Router)'));
    }
    // Multicast groups the adapter joined (RFC 2464 7: 33-33 + the low 32 bits of the group address)
    const groups = ['ff02::1', 'ff02::2', 'ff02::c', 'ff02::16', 'ff02::fb', 'ff02::1:2', 'ff02::1:3'].map(parseIp6);
    for (const x of [a.ll, ...a.addrs.map(y => y.addr)]) { const sn = solicitedNode(x); if (!groups.includes(sn)) groups.push(sn); }
    for (const g of groups) L.push(row(fmtIp6(g), `33-33-${g.slice(24).match(/../g).join('-')}`, 'Permanent'));
  }
  return L;
}

/** netsh interface ipv6 show addresses */
export function winNetshAddresses(eng, d) {
  const a = hostAddr6(eng, d);
  const t = eng.s.t;
  const L = ['', `Interface ${winIfIndex(d)}: ${d.nic === 'wlan0' ? 'Wi-Fi' : 'Ethernet'}`, '', 'Addr Type  DAD State   Valid Life Pref. Life Address', '---------  ----------- ---------- ---------- ------------------------'];
  if (!a.enabled || !a.linkUp) return L;
  const row = (type, x, valid, pref, text) => L.push(`${type.padEnd(11)}${(x?.deprecated ? 'Deprecated' : 'Preferred').padEnd(12)}${life(valid).padStart(10)} ${life(pref).padStart(10)} ${text}`);
  for (const x of a.addrs) row(x.kind === 'temp' ? 'Temporary' : x.kind === 'static' ? 'Manual' : 'Public', x, x.valid ? x.valid - t : Infinity, x.pref ? x.pref - t : Infinity, fmtIp6(x.addr));
  row('Other', null, Infinity, Infinity, `${fmtIp6(a.ll)}${zoneWin(d)}`);
  return L;
}

// ------------------------------------------------------------------ Ubuntu (iproute2)

/** inet6 lines for `ip addr` (both families) and `ip -6 addr`. */
export function linuxInet6Lines(eng, d) {
  const a = hostAddr6(eng, d);
  if (!a.enabled || !a.linkUp) return [];
  const t = eng.s.t;
  const L = [];
  for (const x of a.addrs) {
    if (x.kind === 'static') L.push(`    inet6 ${fmtIp6(x.addr)}/${x.len} scope global `, '       valid_lft forever preferred_lft forever');
    else L.push(`    inet6 ${fmtIp6(x.addr)}/${x.len} scope global ${x.deprecated ? 'deprecated ' : ''}dynamic mngtmpaddr noprefixroute `, `       valid_lft ${Math.max(0, Math.floor(x.valid - t))}sec preferred_lft ${Math.max(0, Math.floor(x.pref - t))}sec`);
  }
  L.push(`    inet6 ${fmtIp6(a.ll)}/64 scope link `, '       valid_lft forever preferred_lft forever');
  return L;
}

export const LO_INET6 = ['    inet6 ::1/128 scope host noprefixroute ', '       valid_lft forever preferred_lft forever'];

/** ip -6 route */
export function linuxRoute6(eng, d) {
  const a = hostAddr6(eng, d);
  if (!a.enabled || !a.linkUp) return [];
  const t = eng.s.t;
  const L = [];
  const statics = a.addrs.filter(x => x.kind === 'static');
  for (const p of a.onlink) {
    const st = statics.some(x => prefix6(x.addr, x.len) === p.net && x.len === p.len);
    const ra = d.v6?.onlink?.[`${p.net}/${p.len}`];
    if (st) L.push(`${fmtCidr6(p.net, p.len)} dev ${d.nic} proto kernel metric 256 pref medium`);
    else L.push(`${fmtCidr6(p.net, p.len)} dev ${d.nic} proto ra metric 1024 expires ${Math.max(0, Math.floor((ra?.until ?? t) - t))}sec pref medium`);
  }
  L.push(`fe80::/64 dev ${d.nic} proto kernel metric 256 pref medium`);
  for (const r of a.routers) {
    if (r.kind === 'static') L.push(`default via ${fmtIp6(r.addr)} dev ${d.nic} proto static metric 1024 pref medium`);
    else L.push(`default via ${fmtIp6(r.addr)} dev ${d.nic} proto ra metric 1024 expires ${Math.max(0, Math.floor(r.until - t))}sec pref medium`);
  }
  return L;
}

/** ip -6 neigh */
export function linuxNeigh6(eng, d) {
  const a = hostAddr6(eng, d);
  if (!a.enabled || !a.linkUp) return [];
  const L = [];
  for (const r of a.routers) {
    const rd = r.dev ? eng.s.devices[r.dev] : null;
    const ifc = rd ? l3Ifaces6(eng, rd).find(i => i.name === r.iface) : null;
    if (ifc) L.push(`${fmtIp6(r.addr)} dev ${d.nic} lladdr ${macLinux(rd.ports[ifc.port].mac)} router STALE`);
    else if (r.kind === 'static') L.push(`${fmtIp6(r.addr)} dev ${d.nic} FAILED`);
  }
  return L;
}
