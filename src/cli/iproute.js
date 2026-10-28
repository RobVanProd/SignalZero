// iproute2 6.1 "ip route" and "ip neigh" for IPv4 on Ubuntu hosts: show, get, add/del/replace, flush.
// Every message and layout here was captured from real iproute2 6.1.0 on Linux 6.18 (docs/apprenticeship/lab/out).
// Lines end with a space, as iproute2 prints them.
import { fmtIp, parseIp, networkOf, inSubnet } from '../engine/ipv4.js';
import { macLinux } from '../engine/model.js';
import { hostAddr, hostNextHop } from '../engine/routing.js';
import { neighbors, flushNeigh } from '../engine/neighbor.js';

const SIM = text => ({ t: 'note', sim: true, text: `simulator: ${text}` });

/** Parse "A.B.C.D/len" or "A.B.C.D" (a /32) or "default". */
function parseDest(tok) {
  if (tok === 'default' || tok === '0/0' || tok === '0.0.0.0/0') return { net: 0, len: 0, text: 'default' };
  const m = /^([\d.]+)(?:\/(\d{1,2}))?$/.exec(tok || '');
  if (!m) return null;
  const a = parseIp(m[1]);
  const len = m[2] === undefined ? 32 : Number(m[2]);
  if (a === null || len > 32) return null;
  return { net: a, len, text: tok };
}

/** All IPv4 routes of a host, kernel FIB order (ascending prefix, then length). */
export function hostRoutes(eng, d) {
  const a = hostAddr(eng, d);
  if (a.addr === null || !eng.portUp(d.id, d.nic)) return [];
  const proto = d.ipcfg.static?.proto === undefined ? 'static' : d.ipcfg.static.proto; // netplan-managed hosts show "proto static"
  const rows = [];
  if (a.gw !== null && a.gw !== undefined) rows.push({ net: 0, len: 0, nh: a.gw, proto, dflt: true });
  rows.push({ net: networkOf(a.addr, a.len), len: a.len, connected: true, src: a.addr });
  for (const r of a.routes || []) rows.push({ net: r.net, len: r.len, nh: r.nh, proto: null });
  rows.sort((x, y) => (x.net >>> 0) - (y.net >>> 0) || x.len - y.len);
  return rows;
}

export function routeLine(d, r) {
  const dst = r.dflt ? 'default' : `${fmtIp(r.net)}/${r.len}`;
  if (r.connected) return `${dst} dev ${d.nic} proto kernel scope link src ${fmtIp(r.src)} `;
  if (r.nh === null || r.nh === undefined) return `${dst} dev ${d.nic} scope link `;
  return `${dst} via ${fmtIp(r.nh)} dev ${d.nic}${r.proto ? ` proto ${r.proto}` : ''} `;
}

function runtimeCfg(d) {
  // only statically addressed hosts keep runtime routes here; DHCP-configured hosts are out of scope
  if (d.ipcfg.dhcp || !d.ipcfg.static) return null;
  d.ipcfg.static.routes ||= [];
  return d.ipcfg.static;
}

/** ip route [show [default]] | get ADDR | add|replace|del DEST [via NH] [dev IF] */
export function ipRoute(eng, d, args) {
  const verb = (args[0] || 'show').toLowerCase();
  const a = hostAddr(eng, d);
  if (['show', 'list', 'ls', 'lst'].includes(verb) || verb === undefined) {
    const rows = hostRoutes(eng, d);
    const sel = args[1] === 'default' ? rows.filter(r => r.dflt) : rows;
    return sel.map(r => routeLine(d, r));
  }
  if (verb === 'get') {
    if (!args[1]) return ['need at least a destination address'];
    const dst = parseIp(args[1]);
    if (dst === null) return [`Error: any valid prefix is expected rather than "${args[1]}".`];
    if (a.addr !== null && dst === a.addr) return [`local ${fmtIp(dst)} dev lo src ${fmtIp(dst)} uid 0 `, '    cache <local> '];
    if (a.addr === null || !eng.portUp(d.id, d.nic)) return ['RTNETLINK answers: Network is unreachable'];
    const r = hostNextHop(a, dst);
    if (r.error) return ['RTNETLINK answers: Network is unreachable'];
    eng.event({ type: 'route-get', host: d.id, dst, nh: r.nh, onLink: r.onLink });
    return [`${fmtIp(dst)} ${r.onLink ? '' : `via ${fmtIp(r.nh)} `}dev ${d.nic} src ${fmtIp(a.addr)} uid 0 `, '    cache '];
  }
  if (['add', 'replace', 'change', 'del', 'delete', 'append', 'prepend'].includes(verb)) {
    const cfg = runtimeCfg(d);
    if (!cfg) return [SIM(`"ip route ${verb}" is real, but this simulator supports it only on hosts with a static address. ${d.hostname} is configured by DHCP.`)];
    if (['change', 'append', 'prepend'].includes(verb)) return [SIM(`"ip route ${verb}" is a real iproute2 command that this simulator does not support. Use ip route add, del or replace.`)];
    // DEST [via NH] [dev IF]
    const rest = args.slice(1);
    let destTok = null;
    let nhTok = null;
    let devTok = null;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (w === 'via') { nhTok = rest[++i] ?? ''; continue; }
      if (w === 'dev') { devTok = rest[++i] ?? ''; continue; }
      if (w === 'to') { destTok = rest[++i] ?? ''; continue; }
      if (['proto', 'metric', 'scope', 'src', 'table', 'onlink'].includes(w)) return [SIM(`the "${w}" option of ip route is real but not simulated here.`)];
      if (destTok === null) { destTok = w; continue; }
      return [`Error: either "to" is duplicate, or "${w}" is a garbage.`];
    }
    const del = verb === 'del' || verb === 'delete';
    if (destTok === null) return ['Usage: ip route { list | flush } SELECTOR', SIM(`iproute2 prints its whole usage text here. Give a destination: default, or a network such as 192.168.20.0/24 (for example: ip route ${del ? 'del default' : 'add default via 192.168.10.1'}).`)];
    const dest = parseDest(destTok);
    if (!dest) return [`Error: any valid prefix is expected rather than "${destTok}".`];
    if (dest.len < 32 && dest.len > 0 && networkOf(dest.net, dest.len) !== dest.net) return ['Error: Invalid prefix for given prefix length.'];
    if (dest.len === 0 && dest.net !== 0) return ['Error: Invalid prefix for given prefix length.'];
    let nh = null;
    if (nhTok !== null) {
      nh = parseIp(nhTok);
      if (nh === null) return [`Error: any valid address is expected rather than "${nhTok}".`];
    }
    if (devTok !== null && devTok !== d.nic) return [`Cannot find device "${devTok}"`];
    const isDefault = dest.len === 0;
    const find = () => (isDefault ? (cfg.gw !== null && cfg.gw !== undefined ? { gw: cfg.gw } : null) : cfg.routes.find(r => r.net === dest.net && r.len === dest.len) || null);
    const cur = find();
    if (del) {
      if (!cur || (nh !== null && (isDefault ? cur.gw : cur.nh) !== nh)) return ['RTNETLINK answers: No such process'];
      if (isDefault) cfg.gw = null;
      else cfg.routes = cfg.routes.filter(r => r !== cur);
      eng.mutated(`${d.hostname}: ip route del ${dest.text}`);
      eng.event({ type: 'iproute', host: d.id, verb: 'del', dest: dest.net, len: dest.len });
      return [];
    }
    if (nh === null && devTok === null) return ['RTNETLINK answers: No such device'];
    if (nh !== null && (a.addr === null || !inSubnet(nh, a.addr, a.len))) return ['Error: Nexthop has invalid gateway.'];
    if (verb === 'add' && cur) return ['RTNETLINK answers: File exists'];
    if (isDefault) {
      if (nh === null) return [SIM('a default route without a gateway ("ip route add default dev eth0") is real but not simulated here.')];
      cfg.gw = nh;
    } else {
      cfg.routes = cfg.routes.filter(r => r !== cur);
      cfg.routes.push({ net: dest.net, len: dest.len, nh });
    }
    eng.mutated(`${d.hostname}: ip route ${verb} ${dest.text}${nh !== null ? ` via ${fmtIp(nh)}` : ''}`);
    eng.event({ type: 'iproute', host: d.id, verb, dest: dest.net, len: dest.len, nh });
    return [];
  }
  return [`Command "${args[0]}" is unknown, try "ip route help".`];
}

/** ip neigh [show [ADDR] [dev IF]] | flush dev IF | flush all */
export function ipNeigh(eng, d, args, v6Lines) {
  const verb = (args[0] || 'show').toLowerCase();
  const nic = d.nic;
  const rows = () => neighbors(eng, d).map(n => ({ ...n, line: `${fmtIp(n.ip)} dev ${n.iface}${n.mac ? ` lladdr ${macLinux(n.mac)}` : ''} ${n.state} ` }));
  if (['show', 'list', 'ls', 'lst'].includes(verb)) {
    const rest = args.slice(1);
    let dev = null;
    let addr = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === 'dev') { dev = rest[++i]; continue; }
      const ip = parseIp(rest[i]);
      if (ip === null) return [`Error: any valid prefix is expected rather than "${rest[i]}".`];
      addr = ip;
    }
    if (dev !== null && dev !== nic) return [`Cannot find device "${dev}"`];
    let L = rows().filter(n => addr === null || n.ip === addr);
    // with "dev" given iproute2 leaves the device out of each line
    L = L.map(n => (dev ? n.line.replace(` dev ${n.iface}`, '') : n.line));
    return addr === null && !dev ? [...L, ...(v6Lines || [])] : L;
  }
  if (verb === 'flush') {
    const rest = args.slice(1);
    if (!rest.length) return ['Flush requires arguments.'];
    if (rest[0] === 'all') { flushNeigh(d); eng.event({ type: 'neigh-flush', host: d.id }); return []; }
    if (rest[0] === 'dev') {
      if (rest[1] !== nic) return [`Cannot find device "${rest[1] ?? ''}"`];
      flushNeigh(d, nic);
      eng.event({ type: 'neigh-flush', host: d.id });
      return [];
    }
    return [SIM(`"ip neigh flush ${rest.join(' ')}" is real but only "flush dev ${nic}" and "flush all" are simulated.`)];
  }
  if (['add', 'del', 'delete', 'change', 'replace', 'get'].includes(verb)) return [SIM(`"ip neigh ${verb}" is a real iproute2 command that this simulator does not support.`)];
  return [`Command "${args[0]}" is unknown, try "ip neigh help".`];
}
