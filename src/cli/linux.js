// Ubuntu 24.04 server shell subset: systemd, journald, ISC DHCP, BIND, nginx, iproute2, iputils, dig, curl.
import { fmtIp, fmtMask, parseIp, networkOf, broadcastOf } from '../engine/ipv4.js';
import { macLinux } from '../engine/model.js';
import { hostAddr } from '../engine/routing.js';
import { dhcpdStart, dhcpdStop, namedLoad, resolveName, httpRequest, parseUrl } from '../engine/services.js';
import { parseDhcpd } from '../engine/parsers/dhcpd.js';
import { parseZone, checkzoneOutput } from '../engine/parsers/zone.js';
import { wallClock } from '../engine/engine.js';
import { parseNetplan, renderNetplan } from '../engine/parsers/netplan.js';

const UNITS = {
  'isc-dhcp-server': { svc: 'isc-dhcp-server', desc: 'ISC DHCP IPv4 server', docs: 'man:dhcpd(8)', proc: 'dhcpd' },
  named: { svc: 'named', desc: 'BIND Domain Name Server', docs: 'man:named(8)', proc: 'named' },
  bind9: { svc: 'named', desc: 'BIND Domain Name Server', docs: 'man:named(8)', proc: 'named', alias: 'named' },
  nginx: { svc: 'nginx', desc: 'A high performance web server and a reverse proxy server', docs: 'man:nginx(8)', proc: 'nginx' },
  ssh: { svc: 'sshd', desc: 'OpenBSD Secure Shell server', docs: 'man:sshd(8)', proc: 'sshd' },
  sshd: { svc: 'sshd', desc: 'OpenBSD Secure Shell server', docs: 'man:sshd(8)', proc: 'sshd', alias: 'ssh' },
  'nvr-ingest': { svc: 'rtsp', desc: 'NVR RTSP ingest service', docs: 'man:nvr(8)', proc: 'nvr' },
};

export function linuxSession(dev) { return { dev: dev.id, os: 'linux', cwd: '/root', history: [] }; }
export function linuxPrompt(eng, sess) {
  const d = eng.s.devices[sess.dev];
  return `root@${d.hostname.toLowerCase()}:${sess.cwd === '/root' ? '~' : sess.cwd}#`;
}

const p2 = n => String(n).padStart(2, '0');
function jstamp(t) { const w = wallClock(t); return `${w.mon} ${p2(w.day)} ${p2(w.hh)}:${p2(w.mm)}:${p2(w.ss)}`; }
const MON_NUM = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function dateLong(t) { const w = wallClock(t); return `${w.dow.slice(0, 3)} ${w.year}-${p2(MON_NUM[w.mon])}-${p2(w.day)} ${p2(w.hh)}:${p2(w.mm)}:${p2(w.ss)} UTC`; }
function ago(sec) { sec = Math.max(0, Math.round(sec)); if (sec < 60) return `${sec}s ago`; if (sec < 3600) return `${Math.floor(sec / 60)}min ${sec % 60}s ago`; return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}min ago`; }

function seedJournal(eng, d) {
  if (d.journalSeeded) return;
  d.journalSeeded = true;
  const seed = (d.journalSeed || []).map(([unit, msg]) => ({ t: -1490, unit, msg }));
  d.journal = [...seed, ...d.journal];
}

function journalLines(eng, d, unitFilter) {
  seedJournal(eng, d);
  const host = d.hostname.toLowerCase();
  const map = { dhcpd: 'isc-dhcp-server', named: 'named', nginx: 'nginx', systemd: null };
  return d.journal
    .filter(e => {
      if (!unitFilter) return true;
      const want = UNITS[unitFilter]?.svc === 'named' ? 'named' : unitFilter;
      if (e.unit === 'systemd') return e.msg.includes(`${unitFilter}.service`) || (want === 'named' && e.msg.includes('named.service'));
      return map[e.unit] === want || e.unit === want;
    })
    .map(e => `${jstamp(e.t)} ${host} ${e.unit === 'systemd' ? 'systemd[1]' : `${e.unit}[${pidFor(d, e.unit)}]`}: ${e.msg}`);
}

function pidFor(d, unit) {
  const base = { dhcpd: 812, named: 702, nginx: 911, sshd: 655 }[unit] || 1000;
  return base + (d.restarts?.[unit] || 0) * 1119;
}

function svcOf(d, unitName) {
  const u = UNITS[unitName.replace(/\.service$/, '')];
  if (!u) return null;
  const svc = d.services?.[u.svc];
  return svc ? { u, svc, name: unitName.replace(/\.service$/, '') } : null;
}

function statusLines(eng, d, unitName) {
  const r = svcOf(d, unitName);
  if (!r) return [`Unit ${unitName}.service could not be found.`];
  const { u, svc } = r;
  const name = u.alias && unitName === 'bind9' ? 'named' : unitName.replace(/\.service$/, '');
  const since = svc.since ?? -1490;
  const L = [`${svc.active ? '●' : '×'} ${name}.service - ${u.desc}`, `     Loaded: loaded (/usr/lib/systemd/system/${name}.service; enabled; preset: enabled)`];
  if (svc.active) {
    L.push(`     Active: active (running) since ${dateLong(since)}; ${ago(eng.s.t - since)}`, `       Docs: ${u.docs}`, `   Main PID: ${pidFor(d, u.proc)} (${u.proc})`, '      Tasks: 1 (limit: 4557)', '     Memory: 4.6M (peak: 5.1M)', '        CPU: 31ms');
  } else if (svc.failed) {
    L.push(`     Active: failed (Result: exit-code) since ${dateLong(since)}; ${ago(eng.s.t - since)}`, `       Docs: ${u.docs}`, `   Main PID: ${pidFor(d, u.proc)} (code=exited, status=1/FAILURE)`, '        CPU: 21ms');
  } else {
    L.push(`     Active: inactive (dead) since ${dateLong(since)}; ${ago(eng.s.t - since)}`, `       Docs: ${u.docs}`);
  }
  L.push('', ...journalLines(eng, d, name === 'named' ? 'named' : name).slice(-8));
  return L;
}

function dhcpLeasesFile(eng, d) {
  const svc = d.services['isc-dhcp-server'];
  const L = ['# The format of this file is documented in the dhcpd.leases(5) manual page.', '# This lease file was written by isc-dhcp-4.4.3-P1', '', 'authoring-byte-order little-endian;', ''];
  for (const [mac, l] of Object.entries(svc?.leases || {})) {
    L.push(`lease ${fmtIp(l.addr)} {`, `  starts 4 ${jstamp(l.t)};`, `  ends 4 ${jstamp(l.ends)};`, '  binding state active;', `  hardware ethernet ${macLinux(mac)};`, `  client-hostname "${l.client}";`, '}');
  }
  return L.join('\n');
}

function fileText(eng, d, path) {
  if (path === '/var/lib/dhcp/dhcpd.leases' && d.services?.['isc-dhcp-server']) return dhcpLeasesFile(eng, d);
  if (path === '/etc/resolv.conf') {
    const a = hostAddr(eng, d);
    return `# Generated by netplan\nnameserver ${(a.dns || []).map(fmtIp).join('\nnameserver ') || '127.0.0.53'}\nsearch ops.example\n`;
  }
  if (path === '/etc/netplan/01-netcfg.yaml' && !d.ipcfg.dhcp && d.files?.[path] === undefined) {
    d.files = d.files || {};
    d.files[path] = renderNetplan(d.nic, d.ipcfg.static, fmtIp);
  }
  if (path.startsWith('/etc/nginx/sites-enabled/')) {
    const web = Object.values(d.services || {}).find(s => s.kind === 'web');
    const site = web?.sites.find(s => path.endsWith(s.names[0].split('.')[0])) || web?.sites[0];
    if (site) return `server {\n    listen 443 ssl;\n    server_name ${site.names.join(' ')};\n    ssl_certificate     /etc/ssl/certs/${site.names[0]}.crt;   # CN/SAN: ${site.cert.names.join(', ')}\n    ssl_certificate_key /etc/ssl/private/${site.names[0]}.key;\n    location / { proxy_pass http://127.0.0.1:8080; }\n}\n`;
  }
  return d.files?.[path];
}

function listFiles(eng, d) {
  const all = new Set(Object.keys(d.files || {}));
  if (d.services?.['isc-dhcp-server']) all.add('/var/lib/dhcp/dhcpd.leases');
  all.add('/etc/resolv.conf');
  if (!d.ipcfg.dhcp) { fileText(eng, d, '/etc/netplan/01-netcfg.yaml'); all.add('/etc/netplan/01-netcfg.yaml'); }
  const web = Object.values(d.services || {}).find(s => s.kind === 'web');
  if (web) for (const s of web.sites) all.add(`/etc/nginx/sites-enabled/${s.names[0].split('.')[0]}`);
  return [...all];
}

function resolvePath(sess, p) {
  if (!p) return sess.cwd;
  if (p.startsWith('/')) return p.replace(/\/+$/, '') || '/';
  if (p === '~') return '/root';
  const parts = (sess.cwd === '/' ? '' : sess.cwd).split('/').filter(Boolean);
  for (const x of p.split('/')) { if (x === '..') parts.pop(); else if (x && x !== '.') parts.push(x); }
  return '/' + parts.join('/');
}

function pingLinux(eng, d, args) {
  let count = 4;
  const rest = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '-c') { count = Math.max(1, Math.min(20, Number(args[++i]) || 4)); continue; } rest.push(args[i]); }
  const target = rest[0];
  if (!target) return ['ping: usage error: Destination address required'];
  const lit = parseIp(target);
  const res = lit !== null ? { ok: true, addr: lit } : resolveName(eng, d, target, {});
  if (!res.ok) return [`ping: ${target}: ${res.rcode === 'NXDOMAIN' ? 'Name or service not known' : 'Temporary failure in name resolution'}`];
  const ip = res.addr;
  const L = [`PING ${target} (${fmtIp(ip)}) 56(84) bytes of data.`];
  let ok = 0;
  const rtts = [];
  let errs = 0;
  for (let i = 1; i <= count; i++) {
    const r = eng.probe({ from: d.id, dst: ip, proto: 'icmp', record: true });
    if (r.status === 'local-error') {
      if (r.reason === 'no-route') return [`ping: connect: Network is unreachable`];
      if (r.reason === 'arp-fail') { L.push(`From ${fmtIp(hostAddr(eng, d).addr)} icmp_seq=${i} Destination Host Unreachable`); errs++; continue; }
      return ['ping: connect: Network is unreachable'];
    }
    if (r.status !== 'ok' || eng.rand() > (r.pass ?? 1)) continue;
    if (r.kind === 'net-unreachable') { L.push(`From ${fmtIp(r.responderIp)} icmp_seq=${i} Destination Net Unreachable`); errs++; continue; }
    if (r.kind === 'ttl-exceeded') { L.push(`From ${fmtIp(r.responderIp)} icmp_seq=${i} Time to live exceeded`); errs++; continue; }
    const ms = Math.max(0.05, r.rttMs + eng.rand() * (r.jitter || 0.1));
    rtts.push(ms);
    ok++;
    L.push(`64 bytes from ${fmtIp(r.responderIp)}: icmp_seq=${i} ttl=${r.ttl} time=${ms.toFixed(ms < 10 ? 3 : 1)} ms`);
  }
  L.push('', `--- ${target} ping statistics ---`, `${count} packets transmitted, ${ok} received,${errs ? ` +${errs} errors,` : ''} ${Math.round(((count - ok) / count) * 100)}% packet loss, time ${(count - 1) * 1001}ms`);
  if (rtts.length) {
    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    L.push(`rtt min/avg/max/mdev = ${Math.min(...rtts).toFixed(3)}/${avg.toFixed(3)}/${Math.max(...rtts).toFixed(3)}/${(Math.max(...rtts) - Math.min(...rtts)).toFixed(3)} ms`);
  }
  eng.event({ type: 'ping', host: d.id, target, ip, ok: ok > 0 });
  return L;
}

function traceLinux(eng, d, args) {
  const target = args.find(a => !a.startsWith('-'));
  if (!target) return ['Usage: traceroute host'];
  const lit = parseIp(target);
  const res = lit !== null ? { ok: true, addr: lit } : resolveName(eng, d, target, {});
  if (!res.ok) return [`${target}: Name or service not known`, 'Cannot handle "host" cmdline arg `' + target + "' on position 1 (argc 1)"];
  const L = [`traceroute to ${target} (${fmtIp(res.addr)}), 30 hops max, 60 byte packets`];
  let miss = 0;
  for (let ttl = 1; ttl <= 30; ttl++) {
    const r = eng.probe({ from: d.id, dst: res.addr, proto: 'udp', dport: 33434 + ttl, ttl, record: true });
    if (r.status !== 'ok') { L.push(`${String(ttl).padStart(2)}  * * *`); if (++miss >= 3) { L.push({ t: 'note', text: 'trainer: later hops also time out; output shortened.' }); break; } continue; }
    miss = 0;
    const ms = () => (r.rttMs + eng.rand() * 0.3).toFixed(3);
    const tag = r.kind === 'net-unreachable' ? ' !N' : '';
    L.push(`${String(ttl).padStart(2)}  ${fmtIp(r.responderIp)} (${fmtIp(r.responderIp)})  ${ms()} ms${tag}  ${ms()} ms${tag}  ${ms()} ms${tag}`);
    if (r.kind !== 'ttl-exceeded') break;
  }
  eng.event({ type: 'trace', host: d.id, target, ip: res.addr });
  return L;
}

function digCmd(eng, d, args) {
  let server;
  let short = false;
  let type = 'A';
  let name;
  for (const a of args) {
    if (a.startsWith('@')) server = parseIp(a.slice(1));
    else if (a === '+short') short = true;
    else if (/^(A|NS|SOA|CNAME|MX|TXT|PTR|AAAA)$/i.test(a)) type = a.toUpperCase();
    else if (!a.startsWith('+') && !a.startsWith('-')) name = a;
  }
  if (!name) name = '.';
  const a = hostAddr(eng, d);
  const srv = server ?? (a.dns || [])[0];
  const r = resolveName(eng, d, name, { server: srv, type });
  const w = wallClock(eng.s.t);
  if (r.error === 'timeout' || r.error === 'refused') {
    eng.event({ type: 'dns', host: d.id, name, ok: false, error: r.error });
    const why = `;; communications error to ${fmtIp(srv)}#53: ${r.error === 'refused' ? 'connection refused' : 'timed out'}`;
    return [why, why, why, '', `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${args.join(' ')}`, ';; global options: +cmd', ';; no servers could be reached'];
  }
  eng.event({ type: 'dns', host: d.id, name, server: srv, ok: !!r.ok, addr: r.addr, rcode: r.rcode, aa: r.aa });
  const answers = r.answers || [];
  if (short) return answers.map(x => (x.type === 'A' ? fmtIp(x.addr) : x.target ? x.target + '.' : x.text || ''));
  const q = (r.qname || name).replace(/\.?$/, '.');
  const L = ['', `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${args.join(' ')}`, ';; global options: +cmd', ';; Got answer:', `;; ->>HEADER<<- opcode: QUERY, status: ${r.rcode || 'NOERROR'}, id: ${10000 + Math.floor(eng.rand() * 50000)}`, `;; flags: qr${r.aa ? ' aa' : ''} rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`, '', ';; OPT PSEUDOSECTION:', '; EDNS: version: 0, flags:; udp: 1232', ';; QUESTION SECTION:', `;${q}\t\tIN\t${type}`, ''];
  if (answers.length) {
    L.push(';; ANSWER SECTION:');
    for (const x of answers) L.push(`${x.name}.\t${x.ttl}\tIN\t${x.type}\t${x.type === 'A' ? fmtIp(x.addr) : x.target ? x.target + '.' : x.text}`);
    L.push('');
  }
  L.push(`;; Query time: ${Math.max(0, Math.round(r.probe?.rttMs || 0))} msec`, `;; SERVER: ${fmtIp(srv)}#53(${fmtIp(srv)}) (UDP)`, `;; WHEN: ${w.dow.slice(0, 3)} ${w.mon} ${w.day} ${p2(w.hh)}:${p2(w.mm)}:${p2(w.ss)} UTC ${w.year}`, `;; MSG SIZE  rcvd: ${40 + answers.length * 16}`);
  return L;
}

function curlLinux(eng, d, args) {
  const flags = new Set(args.filter(a => a.startsWith('-')));
  const url = args.find(a => !a.startsWith('-'));
  if (!url) return ["curl: try 'curl --help' or 'curl --manual' for more information"];
  const fixed = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const r = httpRequest(eng, d, fixed, { insecure: flags.has('-k') });
  const u = parseUrl(fixed);
  const L = [];
  if (r.stage === 'resolve') L.push(`curl: (6) Could not resolve host: ${u.host}`);
  else if (r.stage === 'connect') L.push(r.error.code === 28 ? `curl: (28) Failed to connect to ${u.host} port ${u.port} after 13${String(Math.floor(eng.rand() * 9000)).padStart(4, '0')} ms: Couldn't connect to server` : `curl: (7) Failed to connect to ${u.host} port ${u.port} after 0 ms: Couldn't connect to server`);
  else if (r.stage === 'tls') L.push(`curl: (60) SSL: no alternative certificate subject name matches target host name '${u.host}'`, 'More details here: https://curl.se/docs/sslcerts.html', '', 'curl failed to verify the legitimacy of the server and therefore could not', 'establish a secure connection to it. To learn more about this situation and', 'how to fix it, please visit the web page mentioned above.');
  else if (!r.status) L.push('curl: (56) Recv failure: Connection reset by peer');
  else {
    if (flags.has('-i') || flags.has('-I')) L.push(`HTTP/1.1 ${r.status}`, 'Server: nginx/1.24.0 (Ubuntu)', `Content-Type: ${r.type}`, '');
    if (!flags.has('-I')) L.push(r.body);
  }
  eng.event({ type: 'http', host: d.id, url: fixed.toLowerCase(), hostname: u?.host, ip: r.ip, ok: !!r.ok, status: r.status ?? null, stage: r.stage, code: r.error?.code ?? null });
  return L;
}

function ssCmd(eng, d) {
  const L = ['Netid State  Recv-Q Send-Q   Local Address:Port    Peer Address:Port Process'];
  const a = hostAddr(eng, d);
  for (const [key, svc] of Object.entries(d.services || {})) {
    if (!svc.active) continue;
    const proc = { 'isc-dhcp-server': 'dhcpd', named: 'named', nginx: 'nginx', sshd: 'sshd', rtsp: 'nvr' }[key] || key;
    for (const l of svc.listen || []) {
      const local = key === 'named' && a.addr !== null ? fmtIp(a.addr) : '0.0.0.0';
      L.push(`${l.proto.padEnd(6)}${(l.proto === 'udp' ? 'UNCONN' : 'LISTEN').padEnd(7)}0      ${l.proto === 'udp' ? '0     ' : '4096  '}${`${local}:${l.port}`.padStart(19)}${'0.0.0.0:*'.padStart(21)} users:(("${proc}",pid=${pidFor(d, proc)},fd=${3 + l.port % 7}))`);
    }
  }
  return L;
}

function ipCmd(eng, d, args) {
  const sub = (args[0] || 'a').toLowerCase();
  const a = hostAddr(eng, d);
  const up = eng.portUp(d.id, d.nic);
  const mac = macLinux(d.ports[d.nic].mac);
  if ('address'.startsWith(sub) || sub === 'a') {
    const L = ['1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000', '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00', '    inet 127.0.0.1/8 scope host lo', '       valid_lft forever preferred_lft forever', `2: ${d.nic}: <BROADCAST,MULTICAST,UP${up ? ',LOWER_UP' : ''}> mtu 1500 qdisc mq state ${up ? 'UP' : 'DOWN'} group default qlen 1000`, `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`];
    if (a.addr !== null) L.push(`    inet ${fmtIp(a.addr)}/${a.len} brd ${fmtIp(broadcastOf(a.addr, a.len))} scope global ${a.source === 'dhcp' ? 'dynamic ' : ''}${d.nic}`, '       valid_lft forever preferred_lft forever');
    return L;
  }
  if ('route'.startsWith(sub)) {
    if (a.addr === null || !up) return [];
    const L = [];
    if (a.gw !== null && a.gw !== undefined) L.push(`default via ${fmtIp(a.gw)} dev ${d.nic} proto static`);
    L.push(`${fmtIp(networkOf(a.addr, a.len))}/${a.len} dev ${d.nic} proto kernel scope link src ${fmtIp(a.addr)}`);
    return L;
  }
  if ('link'.startsWith(sub)) return [`2: ${d.nic}: <BROADCAST,MULTICAST,UP${up ? ',LOWER_UP' : ''}> mtu 1500 qdisc mq state ${up ? 'UP' : 'DOWN'} mode DEFAULT group default qlen 1000`, `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`];
  return [`Object "${args[0]}" is unknown, try "ip help".`];
}

function systemctl(eng, sess, d, args) {
  const verb = (args[0] || '').toLowerCase();
  const unit = (args[1] || '').replace(/\.service$/, '');
  if (!verb) return { lines: ['  UNIT                       LOAD   ACTIVE SUB     DESCRIPTION', ...Object.entries(d.services || {}).filter(([k]) => UNITS[k] || Object.values(UNITS).some(u => u.svc === k)).map(([k, s]) => `  ${(k === 'sshd' ? 'ssh' : k).padEnd(27)}loaded ${s.active ? 'active running' : s.failed ? 'failed failed ' : 'inactive dead '} ${(Object.values(UNITS).find(u => u.svc === k) || {}).desc || ''}`)] };
  if (!unit) return { lines: ['Too few arguments.'] };
  const r = svcOf(d, unit);
  if (!r) return { lines: [`Failed to ${verb} ${unit}.service: Unit ${unit}.service not found.`] };
  const { svc, u } = r;
  const L = [];
  const startIt = () => {
    d.restarts = d.restarts || {};
    d.restarts[u.proc] = (d.restarts[u.proc] || 0) + 1;
    svc.since = eng.s.t;
    if (u.svc === 'isc-dhcp-server') {
      eng.journal(d, 'systemd', `Started isc-dhcp-server.service - ${u.desc}.`);
      const res = dhcpdStart(eng, d);
      if (!res.ok) {
        L.push(`Job for isc-dhcp-server.service failed because the control process exited with error code.`, `See "systemctl status isc-dhcp-server.service" and "journalctl -xeu isc-dhcp-server.service" for details.`);
      }
      return;
    }
    if (u.svc === 'named') {
      svc.active = true;
      svc.failed = false;
      eng.journal(d, 'systemd', 'Started named.service - BIND Domain Name Server.');
      eng.journal(d, 'named', 'starting BIND 9.18.28-0ubuntu0.24.04.1-Ubuntu (Extended Support Version) <id:>');
      namedLoad(eng, d);
      eng.journal(d, 'named', 'all zones loaded');
      eng.journal(d, 'named', 'running');
      return;
    }
    svc.active = true;
    svc.failed = false;
    eng.journal(d, 'systemd', `Started ${unit}.service - ${u.desc}.`);
  };
  switch (verb) {
    case 'status': return { lines: statusLines(eng, d, unit) };
    case 'is-active': return { lines: [svc.active ? 'active' : svc.failed ? 'failed' : 'inactive'] };
    case 'start': if (!svc.active) { startIt(); eng.mutated(`${d.hostname}: systemctl start ${unit}`); } break;
    case 'restart': {
      if (u.svc === 'isc-dhcp-server') dhcpdStop(eng, d);
      else svc.active = false;
      eng.journal(d, 'systemd', `Stopping ${unit}.service - ${u.desc}...`);
      startIt();
      eng.mutated(`${d.hostname}: systemctl restart ${unit}`);
      break;
    }
    case 'stop': {
      if (u.svc === 'isc-dhcp-server') dhcpdStop(eng, d);
      else svc.active = false;
      svc.since = eng.s.t;
      eng.journal(d, 'systemd', `Stopped ${unit}.service - ${u.desc}.`);
      eng.mutated(`${d.hostname}: systemctl stop ${unit}`);
      break;
    }
    case 'reload': {
      if (!svc.active) { L.push(`${unit}.service is not active, cannot reload.`); break; }
      if (u.svc === 'named') { eng.journal(d, 'named', 'reloading configuration succeeded'); namedLoad(eng, d, { reload: true }); eng.journal(d, 'named', 'reloading zones succeeded'); eng.mutated(`${d.hostname}: systemctl reload named`); }
      else if (u.svc === 'isc-dhcp-server') L.push('Failed to reload isc-dhcp-server.service: Job type reload is not applicable for unit isc-dhcp-server.service.');
      break;
    }
    case 'enable': case 'disable': L.push(`Synchronizing state of ${unit}.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.`); break;
    default: L.push(`Unknown command verb '${verb}'.`);
  }
  eng.event({ type: 'systemctl', host: d.id, verb, unit, active: svc.active });
  return { lines: L };
}

/** Split a command line on "|" the way a shell does: not inside quotes, not when escaped. */
function splitPipes(line) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && q !== "'" && i + 1 < line.length) { cur += ch + line[++i]; continue; }
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '|') { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

/** Shell words with quoting removed (single quotes literal; in double quotes a backslash only escapes $ ` " \\). */
function shellWords(str) {
  const words = [];
  let w = null;
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q === "'") { if (ch === "'") q = null; else w += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && '$`"\\'.includes(str[i + 1] ?? '')) w += str[++i];
      else w += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (w !== null) { words.push(w); w = null; } continue; }
    if (w === null) w = '';
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '\\' && i + 1 < str.length) w += str[++i];
    else w += ch;
  }
  if (w !== null) words.push(w);
  return words;
}

/** GNU grep basic regular expression -> JavaScript RegExp source (\| \( \) \{ \} \+ \? are the operators). */
function breToJs(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '\\' && i + 1 < pat.length) {
      const n = pat[++i];
      out += '|(){}+?'.includes(n) ? n : `\\${n}`;
    } else out += '|(){}+?'.includes(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function applyPipes(lines, pipes) {
  let out = lines.map(l => (typeof l === 'string' ? l : l.text));
  for (const p of pipes) {
    const [cmd, ...rest] = shellWords(p.trim());
    if (cmd === 'grep' || cmd === 'egrep') {
      const flags = rest.filter(x => /^-[a-zA-Z]+$/.test(x)).join('');
      const words = rest.filter(x => !/^-[a-zA-Z]+$/.test(x));
      if (!words.length) return ['Usage: grep [OPTION]... PATTERNS [FILE]...', "Try 'grep --help' for more information."];
      const ci = flags.includes('i');
      const v = flags.includes('v');
      const ext = cmd === 'egrep' || flags.includes('E');
      const src = flags.includes('F') ? words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ext ? words[0] : breToJs(words[0]);
      let re;
      try { re = new RegExp(src, ci ? 'i' : ''); } catch { return [`grep: Unmatched ( or \\(`]; }
      out = out.filter(l => re.test(l) !== v);
      if (flags.includes('c')) out = [String(out.length)];
    } else if (cmd === 'tail' || cmd === 'head') {
      const n = Number(rest[rest.indexOf('-n') + 1]) || Number((rest[0] || '').replace('-', '')) || 10;
      out = cmd === 'tail' ? out.slice(-n) : out.slice(0, n);
    } else if (cmd === 'less' || cmd === 'more' || cmd === 'cat') {
      // pager: no-op
    } else if (cmd === 'wc' && rest[0] === '-l') out = [String(out.length)];
    else if (cmd === undefined) return ['-bash: syntax error near unexpected token `|\''];
    else return [`${cmd}: command not found`];
  }
  return out;
}

export function linuxExecute(eng, sess, raw) {
  const d = eng.s.devices[sess.dev];
  let line = raw.trim().replace(/^sudo\s+/, '');
  if (!line) return { lines: [] };
  const segs = splitPipes(line);
  const pipes = segs.slice(1);
  line = segs[0].trim();
  const parts = line.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  const out = (lines, extra = {}) => ({ lines: pipes.length ? applyPipes(lines, pipes) : lines, ...extra });
  switch (cmd) {
    case 'help': return out(['Supported commands on this training image:', '  ip a | ip r | ip link        ping [-c n] host        traceroute host', '  dig [@server] name [type] [+short]                   nslookup name [server]', '  curl [-i] [-k] url           ss -tulpn                hostname   date   uptime', '  systemctl status|start|stop|restart|reload <unit>    journalctl [-u unit] [-n N]', '  cat <file>   ls [dir]   nano <file>   cd <dir>   pwd', '  dhcpd -t -cf /etc/dhcp/dhcpd.conf     dhcp-lease-list     netplan apply', '  named-checkzone <zone> <file>         named-checkconf      rndc reload', '  Pipes: | grep [-i] pattern  | tail -n N  | head -n N']);
    case 'clear': return { lines: [], clear: true };
    case 'hostname': return out([d.hostname.toLowerCase()]);
    case 'whoami': return out(['root']);
    case 'pwd': return out([sess.cwd]);
    case 'date': { const w = wallClock(eng.s.t); return out([`${w.dow.slice(0, 3)} ${w.mon} ${p2(w.day)} ${p2(w.hh)}:${p2(w.mm)}:${p2(w.ss)} AM UTC ${w.year}`]); }
    case 'uptime': return out([` ${p2(wallClock(eng.s.t).hh)}:${p2(wallClock(eng.s.t).mm)}:${p2(wallClock(eng.s.t).ss)} up 211 days,  3:12,  1 user,  load average: 0.04, 0.03, 0.00`]);
    case 'cd': { const p = resolvePath(sess, args[0] || '/root'); sess.cwd = p; return out([]); }
    case 'ls': {
      const dir = resolvePath(sess, args.find(a => !a.startsWith('-')));
      const names = new Set();
      for (const f of listFiles(eng, d)) if (f.startsWith(dir === '/' ? '/' : dir + '/')) names.add(f.slice(dir === '/' ? 1 : dir.length + 1).split('/')[0]);
      if (dir === '/root') return out([]);
      return out(names.size ? [[...names].sort().join('  ')] : [`ls: cannot access '${args[0] || dir}': No such file or directory`]);
    }
    case 'cat': case 'less': case 'more': {
      const path = resolvePath(sess, args[0]);
      const t = fileText(eng, d, path);
      if (t === undefined) return out([`${cmd}: ${args[0]}: No such file or directory`]);
      eng.event({ type: 'read', host: d.id, path });
      return out(t.replace(/\n$/, '').split('\n'));
    }
    case 'nano': case 'vi': case 'vim': {
      if (!args[0]) return out([`${cmd}: missing file operand`]);
      const path = resolvePath(sess, args[0]);
      const t = fileText(eng, d, path);
      const editable = d.files && (path in d.files);
      if (t !== undefined && !editable) return out([`[ ${path} is generated by the system and is read-only in this training image ]`]);
      return { lines: [], editor: { dev: d.id, path, text: t ?? '', isNew: t === undefined } };
    }
    case 'ip': return out(ipCmd(eng, d, args));
    case 'ifconfig': return out(['Command \'ifconfig\' not found, but can be installed with:', 'apt install net-tools', { t: 'note', text: 'trainer: modern Linux uses "ip a" (iproute2).' }]);
    case 'ping': return out(pingLinux(eng, d, args));
    case 'traceroute': case 'tracepath': return out(traceLinux(eng, d, args));
    case 'dig': return out(digCmd(eng, d, args));
    case 'nslookup': {
      const name = args[0];
      if (!name) return out(['> ', { t: 'note', text: 'trainer: interactive mode not supported; use nslookup <name> [server].' }]);
      const srv = args[1] ? parseIp(args[1]) : (hostAddr(eng, d).dns || [])[0];
      const r = resolveName(eng, d, name, { server: srv });
      if (r.error === 'timeout' || r.error === 'refused') {
        eng.event({ type: 'dns', host: d.id, name, ok: false, error: r.error });
        const why = `;; communications error to ${fmtIp(srv)}#53: ${r.error === 'refused' ? 'connection refused' : 'timed out'}`;
        return out([why, why, ';; no servers could be reached', '']);
      }
      const L = [`Server:\t\t${fmtIp(srv)}`, `Address:\t${fmtIp(srv)}#53`, ''];
      if (r.ok) { if (!r.aa) L.push('Non-authoritative answer:'); L.push(`Name:\t${r.qname}`, `Address: ${fmtIp(r.addr)}`, ''); }
      else L.push(`** server can't find ${r.qname || name}: ${r.rcode || 'SERVFAIL'}`, '');
      eng.event({ type: 'dns', host: d.id, name, ok: !!r.ok, addr: r.addr });
      return out(L);
    }
    case 'curl': return out(curlLinux(eng, d, args));
    case 'ss': case 'netstat': return out(ssCmd(eng, d));
    case 'systemctl': { const r = systemctl(eng, sess, d, args); return out(r.lines); }
    case 'service': { const r = systemctl(eng, sess, d, [args[1], args[0]]); return out(r.lines); }
    case 'journalctl': {
      let unit = null;
      let n = 30;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-u') unit = (args[++i] || '').replace(/\.service$/, '');
        else if (args[i].startsWith('-u')) unit = args[i].slice(2).replace(/\.service$/, '');
        else if (args[i] === '-n') n = Number(args[++i]) || 30;
        else if (args[i] === '-xeu' || args[i] === '-eu') unit = (args[++i] || '').replace(/\.service$/, '');
      }
      if (unit === 'bind9') unit = 'named';
      const lines = journalLines(eng, d, unit);
      eng.event({ type: 'journal', host: d.id, unit });
      if (!lines.length) return out(['-- No entries --']);
      return out(lines.slice(-n));
    }
    case 'dhcpd': {
      if (!args.includes('-t')) return out(['Usage: dhcpd -t [-cf config-file]', { t: 'note', text: 'trainer: run the daemon through systemctl; use dhcpd -t to test the configuration.' }]);
      const path = args.includes('-cf') ? resolvePath(sess, args[args.indexOf('-cf') + 1]) : '/etc/dhcp/dhcpd.conf';
      const t = fileText(eng, d, path);
      if (t === undefined) return out([`Can't open ${path}: No such file or directory`]);
      const r = parseDhcpd(t, path);
      eng.event({ type: 'configtest', host: d.id, what: 'dhcpd', ok: r.ok });
      const head = ['Internet Systems Consortium DHCP Server 4.4.3-P1', 'Copyright 2004-2022 Internet Systems Consortium.', 'All rights reserved.', 'For info, please visit https://www.isc.org/software/dhcp/'];
      if (r.ok) return out([...head, `Config file: ${path}`, 'Database file: /var/lib/dhcp/dhcpd.leases', 'PID file: /var/run/dhcpd.pid']);
      return out([...head, ...r.errors, 'Configuration file errors encountered -- exiting', '', 'If you think you have received this message due to a bug rather', 'than a configuration issue please read the section on submitting', 'bugs on either our web page at www.isc.org or in the README file', 'before submitting a bug.']);
    }
    case 'named-checkzone': {
      const [zone, file] = args;
      if (!zone || !file) return out(['usage: named-checkzone [-djqvD] [-c class] zone filename']);
      const path = resolvePath(sess, file);
      const t = fileText(eng, d, path);
      if (t === undefined) return out([`zone ${zone}/IN: loading from master file ${file} failed: file not found`, `zone ${zone}/IN: not loaded due to errors.`]);
      const r = parseZone(t, zone, file);
      eng.event({ type: 'configtest', host: d.id, what: 'zone', ok: r.ok });
      return out(checkzoneOutput(r));
    }
    case 'named-checkconf': return out([]);
    case 'rndc': {
      if (args[0] !== 'reload' && args[0] !== 'status') return out(['Usage: rndc reload [zone] | rndc status']);
      const svc = d.services?.named;
      if (!svc?.active) return out(['rndc: connect failed: 127.0.0.1#953: connection refused']);
      if (args[0] === 'status') return out(['version: BIND 9.18.28-0ubuntu0.24.04.1-Ubuntu (Extended Support Version) <id:>', `number of zones: ${Object.keys(svc.loaded || {}).length + 100} (99 automatic)`, 'server is up and running']);
      // rndc only reports that named accepted the reload; zone load errors go to named's log, and a zone that
      // fails keeps serving its previous copy.
      const zone = args[1]?.replace(/\.$/, '').toLowerCase();
      if (zone && !svc.zones.some(z => z.zone === zone)) return out(["rndc: 'reload' failed: not found", `no matching zone '${args[1]}' in any view`]);
      eng.journal(d, 'named', "received control channel command 'reload" + (zone ? ` ${zone}` : '') + "'");
      if (!zone) eng.journal(d, 'named', 'reloading configuration succeeded');
      const res = namedLoad(eng, d, { reload: true });
      if (!zone) eng.journal(d, 'named', 'reloading zones succeeded');
      eng.mutated(`${d.hostname}: rndc reload`);
      eng.event({ type: 'rndc', host: d.id, ok: res.ok });
      const L = [zone ? 'zone reload queued' : 'server reload successful'];
      if (!res.ok) L.push({ t: 'note', text: 'trainer: rndc only confirms that named accepted the command. A zone that fails to load is only logged ("journalctl -u named"): named keeps serving the copy it loaded before, or answers SERVFAIL if it never loaded one.' });
      return out(L);
    }
    case 'dhcp-lease-list': {
      const svc = d.services?.['isc-dhcp-server'];
      if (!svc) return out(['dhcp-lease-list: command not found']);
      const L = ['To get manufacturer names please download http://standards.ieee.org/regauth/oui/oui.txt to /usr/local/etc/oui.txt', 'Reading leases from /var/lib/dhcp/dhcpd.leases', 'MAC                IP              hostname       valid until         manufacturer', '==============================================================================================='];
      for (const [mac, l] of Object.entries(svc.leases || {})) L.push(`${macLinux(mac).padEnd(19)}${fmtIp(l.addr).padEnd(16)}${String(l.client).slice(0, 14).padEnd(15)}${jstamp(l.ends).padEnd(20)}-NA-`);
      return out(L);
    }
    case 'exit': case 'logout': return { lines: ['logout'], logout: true };
    case 'ufw': return out(['Status: inactive']);
    case 'netplan': {
      if (args[0] !== 'apply' && args[0] !== 'try') return out(['usage: netplan [-h] [--debug] apply | try | get']);
      const path = '/etc/netplan/01-netcfg.yaml';
      const t = fileText(eng, d, path);
      if (t === undefined || d.ipcfg.dhcp) return out(['netplan: this host is configured by DHCP']);
      const r = parseNetplan(t, path, d.nic);
      if (!r.ok) { eng.event({ type: 'configtest', host: d.id, what: 'netplan', ok: false }); return out([r.error]); }
      d.ipcfg.static = { ...d.ipcfg.static, ...r.cfg };
      eng.mutated(`${d.hostname}: netplan apply`);
      eng.event({ type: 'netplan', host: d.id, ok: true });
      return out(args[0] === 'try' ? ['Do you want to keep these settings?', '', 'Press ENTER before the timeout to accept the new configuration', '', 'Configuration accepted.'] : []);
    }
    default: return out([`${cmd}: command not found`]);
  }
}

/** Save from the editor. */
export function linuxSaveFile(eng, devId, path, text) {
  const d = eng.s.devices[devId];
  d.files[path] = text.endsWith('\n') ? text : text + '\n';
  eng.mutated(`${d.hostname}: edit ${path}`);
  eng.event({ type: 'edit', host: devId, path });
}

export const LINUX_COMMANDS = ['systemctl status', 'systemctl start', 'systemctl restart', 'journalctl -u', 'cat', 'nano', 'dhcpd -t', 'named-checkzone', 'rndc reload', 'dig', 'ip a', 'ip r', 'ss -tulpn', 'ping', 'curl', 'traceroute'];
