// Windows 11 command prompt subset. Output formats follow cmd.exe / curl.exe conventions closely.
// Lines that are objects { t: 'note', text } are trainer annotations, rendered differently from device output.
import { fmtIp, fmtMask, parseIp, networkOf, broadcastOf, isApipa } from '../engine/ipv4.js';
import { macWindows } from '../engine/model.js';
import { hostAddr } from '../engine/routing.js';
import { dhcpClient, applyDhcpResult, dhcpRelease, resolveName, httpRequest, parseUrl, leaseTimes } from '../engine/services.js';
import { wallClock } from '../engine/engine.js';
import { sshConnect, parseOpenSsh, OPENSSH_USAGE } from './ssh.js'; // ---- ospf (Act II)

/** opts.user: a session opened over SSH (Windows OpenSSH Server, default shell cmd.exe). */
export function winSession(dev, opts = {}) {
  if (opts.user) return { dev: dev.id, os: 'windows', cwd: `C:\\Users\\${opts.user}`, user: opts.user, history: [] };
  return { dev: dev.id, os: 'windows', cwd: 'C:\\Users\\operator', history: [] };
}
// Over SSH, Windows OpenSSH's cmd.exe prompt carries user@HOST (e.g. "scott@IRONHEART C:\Users\scott>").
export function winPrompt(eng, sess) { return sess.user ? `${sess.user}@${eng.s.devices[sess.dev].hostname} ${sess.cwd}>` : `${sess.cwd}>`; }

const HELP = [
  'Supported commands on this training image:',
  '  ipconfig [/all | /release | /renew | /flushdns | /displaydns]',
  '  ping [-n count] <host>          tracert [-d] <host>        pathping <host>',
  '  nslookup <name> [server]        arp -a                     route print',
  '  curl [-v] [-i] [-I] [-k] <url>   hostname   getmac   cls',
  '  ssh user@host                   (OpenSSH client)',
];

function adapterTitle(d) { return d.nic === 'wlan0' ? 'Wireless LAN adapter Wi-Fi:' : 'Ethernet adapter Ethernet:'; }
function adapterName(d) { return d.nic === 'wlan0' ? 'Wi-Fi' : 'Ethernet'; }
const dots = (label, n = 36) => `   ${(label + ' ').padEnd(n - 3, '. ').slice(0, n - 4)}: `;

function fmtWinTime(t) {
  const w = wallClock(t);
  const h12 = w.hh % 12 === 0 ? 12 : w.hh % 12;
  return `${w.dow}, ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(w.mon)]} ${w.day}, ${w.year} ${h12}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')} ${w.hh < 12 ? 'AM' : 'PM'}`;
}

function ipconfig(eng, d, all) {
  const L = ['', 'Windows IP Configuration', ''];
  const a = hostAddr(eng, d);
  const up = eng.portUp(d.id, d.nic);
  if (all) {
    L.push(`${dots('Host Name')}${d.hostname}`, `${dots('Primary Dns Suffix')}`, `${dots('Node Type')}Hybrid`, `${dots('IP Routing Enabled.')}No`, `${dots('WINS Proxy Enabled.')}No`);
    if (a.domain) L.push(`${dots('DNS Suffix Search List.')}${a.domain}`);
    L.push('');
  }
  L.push(adapterTitle(d), '');
  if (!up) {
    L.push(`${dots('Media State')}Media disconnected`, `${dots('Connection-specific DNS Suffix')}`);
    if (all) L.push(`${dots('Description')}${d.nic === 'wlan0' ? 'Intel(R) Wi-Fi 6E AX211 160MHz' : 'Intel(R) Ethernet Connection (17) I219-LM'}`, `${dots('Physical Address.')}${macWindows(d.ports[d.nic].mac)}`, `${dots('DHCP Enabled.')}${d.ipcfg.dhcp ? 'Yes' : 'No'}`, `${dots('Autoconfiguration Enabled')}Yes`);
    return L;
  }
  L.push(`${dots('Connection-specific DNS Suffix')}${a.domain || ''}`);
  if (all) L.push(`${dots('Description')}${d.nic === 'wlan0' ? 'Intel(R) Wi-Fi 6E AX211 160MHz' : 'Intel(R) Ethernet Connection (17) I219-LM'}`, `${dots('Physical Address.')}${macWindows(d.ports[d.nic].mac)}`, `${dots('DHCP Enabled.')}${d.ipcfg.dhcp ? 'Yes' : 'No'}`, `${dots('Autoconfiguration Enabled')}Yes`);
  if (a.source === 'apipa') {
    L.push(`${dots('Autoconfiguration IPv4 Address.')}${fmtIp(a.addr)}${all ? '(Preferred)' : ''}`, `${dots('Subnet Mask')}255.255.0.0`, `${dots('Default Gateway')}`);
  } else if (a.addr !== null) {
    L.push(`${dots('IPv4 Address.')}${fmtIp(a.addr)}${all ? '(Preferred)' : ''}`, `${dots('Subnet Mask')}${fmtMask(a.len)}`);
    if (all && a.source === 'dhcp') {
      L.push(`${dots('Lease Obtained.')}${fmtWinTime(d.lease.obtained)}`, `${dots('Lease Expires')}${fmtWinTime(d.lease.obtained + (d.lease.leaseTime || 28800))}`);
    }
    L.push(`${dots('Default Gateway')}${a.gw !== null && a.gw !== undefined ? fmtIp(a.gw) : ''}`);
    if (all && a.source === 'dhcp') L.push(`${dots('DHCP Server')}${fmtIp(d.lease.server)}`);
  } else {
    L.push(`${dots('Default Gateway')}`);
  }
  if (all) {
    const dns = a.dns || [];
    L.push(`${dots('DNS Servers')}${dns.length ? fmtIp(dns[0]) : ''}`);
    for (const x of dns.slice(1)) L.push(`${' '.repeat(39)}${fmtIp(x)}`);
    L.push(`${dots('NetBIOS over Tcpip.')}Enabled`);
  }
  return L;
}

function learnArp(eng, d, r) {
  const hop = r?.fwd?.hops?.find(h => h.kind === 'l3');
  if (!hop) return;
  const od = eng.s.devices[hop.dev];
  let mac = null;
  let ip = null;
  if (od.kind === 'router') {
    const sub = od.subifs?.[hop.iface];
    const port = od.ports[sub ? sub.parent : hop.iface];
    mac = port?.mac;
    ip = sub ? sub.ip?.addr : port?.ip?.addr;
  } else if (od.kind === 'host') {
    mac = od.ports[od.nic].mac;
    ip = hostAddr(eng, od).addr;
  }
  if (mac && ip !== null && ip !== undefined) {
    d.arpCache = d.arpCache || {};
    d.arpCache[ip] = mac;
  }
}

function resolveForTool(eng, d, target) {
  const lit = parseIp(target);
  if (lit !== null) return { ok: true, addr: lit, literal: true, name: target };
  const r = resolveName(eng, d, target, { useCache: true });
  return { ...r, name: r.qname || target };
}

function ping(eng, d, args) {
  let count = 4;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (/^[-/]n$/i.test(args[i])) { count = Math.max(1, Math.min(50, Number(args[++i]) || 4)); continue; }
    if (/^[-/]t$/i.test(args[i])) { count = 8; continue; }
    rest.push(args[i]);
  }
  const target = rest[0];
  if (!target) return { lines: ['', 'Usage: ping [-n count] target_name'] };
  const L = [];
  const res = resolveForTool(eng, d, target);
  if (!res.ok) {
    L.push(`Ping request could not find host ${target}. Please check the name and try again.`);
    if (res.error === 'timeout') L.push({ t: 'note', text: `trainer: the DNS server(s) ${(res.tried || []).map(x => fmtIp(x.ip)).join(', ') || '(none configured)'} did not answer.` });
    if (res.error === 'refused') L.push({ t: 'note', text: refusedNote(res) });
    eng.event({ type: 'ping', host: d.id, target, ok: false, resolved: false });
    return { lines: L };
  }
  const ip = res.addr;
  L.push('', `Pinging ${res.literal ? fmtIp(ip) : `${res.name} [${fmtIp(ip)}]`} with 32 bytes of data:`);
  let recv = 0;
  let lost = 0;
  let realReplies = 0;
  const rtts = [];
  let last = null;
  let general = false;
  for (let i = 0; i < count; i++) {
    const r = eng.probe({ from: d.id, dst: ip, proto: 'icmp', record: true });
    last = r;
    if (i === 0) learnArp(eng, d, r);
    if (r.status === 'local-error') {
      if (r.reason === 'arp-fail') { L.push(`Reply from ${fmtIp(hostAddr(eng, d).addr)}: Destination host unreachable.`); recv++; continue; }
      L.push('PING: transmit failed. General failure. ');
      lost++;
      general = true;
      continue;
    }
    if (r.status === 'timeout' || eng.rand() > (r.pass ?? 1)) { L.push('Request timed out.'); lost++; continue; }
    if (r.kind === 'net-unreachable') { L.push(`Reply from ${fmtIp(r.responderIp)}: Destination net unreachable.`); recv++; continue; }
    if (r.kind === 'ttl-exceeded') { L.push(`Reply from ${fmtIp(r.responderIp)}: TTL expired in transit.`); recv++; continue; }
    const ms = Math.max(0, Math.floor(r.rttMs + eng.rand() * (r.jitter || 0.3)));
    rtts.push(ms);
    recv++;
    realReplies++;
    L.push(`Reply from ${fmtIp(r.responderIp)}: bytes=32 time${ms < 1 ? '<1' : '='}${ms < 1 ? '' : ms}ms TTL=${r.ttl}`);
  }
  L.push('', `Ping statistics for ${fmtIp(ip)}:`, `    Packets: Sent = ${count}, Received = ${recv}, Lost = ${lost} (${Math.round((lost / count) * 100)}% loss),`);
  if (rtts.length) L.push('Approximate round trip times in milli-seconds:', `    Minimum = ${Math.min(...rtts)}ms, Maximum = ${Math.max(...rtts)}ms, Average = ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}ms`);
  if (recv > 0 && realReplies === 0) L.push({ t: 'note', text: 'trainer: Windows counts ICMP error replies as "Received". None of these were echo replies from the target.' });
  if (general) L.push({ t: 'note', text: `trainer: "General failure" = the PC could not even send (${last.reason === 'no-route' ? 'no route / no default gateway' : last.reason === 'media-disconnected' ? 'cable unplugged' : last.reason}).` });
  if (res.fromCache) L.push({ t: 'note', text: `trainer: ${res.name} came from this PC's DNS cache (TTL ${res.ttlLeft}s left), not a fresh query.` });
  eng.event({ type: 'ping', host: d.id, target, ip, ok: realReplies > 0, sent: count, received: realReplies });
  return { lines: L, trace: last };
}

function tracert(eng, d, args) {
  const rest = args.filter(a => !/^[-/]d$/i.test(a));
  const target = rest[0];
  if (!target) return { lines: ['', 'Usage: tracert [-d] target_name'] };
  const res = resolveForTool(eng, d, target);
  if (!res.ok) { eng.event({ type: 'trace', host: d.id, target, ok: false }); return { lines: [`Unable to resolve target system name ${target}.`] }; }
  const ip = res.addr;
  const L = ['', `Tracing route to ${res.literal ? fmtIp(ip) : `${res.name} [${fmtIp(ip)}]`}`, 'over a maximum of 30 hops:', ''];
  let timeouts = 0;
  let reached = false;
  let last = null;
  for (let ttl = 1; ttl <= 30; ttl++) {
    const r = eng.probe({ from: d.id, dst: ip, proto: 'icmp', ttl, record: true });
    last = r;
    const col = () => {
      const ms = Math.floor(r.rttMs + eng.rand() * (r.jitter || 0.4));
      return ms < 1 ? '    <1 ms' : `${String(ms).padStart(6)} ms`;
    };
    if (r.status === 'local-error') { L.push(`  ${String(ttl).padStart(2)}     Transmit error: code 1231.`); break; }
    if (r.status !== 'ok') {
      L.push(`  ${String(ttl).padStart(2)}     *        *        *     Request timed out.`);
      timeouts++;
      if (timeouts >= 3) { L.push({ t: 'note', text: `trainer: hops ${ttl + 1}-30 would also time out; trace shortened.` }); break; }
      continue;
    }
    timeouts = 0;
    if (r.kind === 'net-unreachable') { L.push(`  ${String(ttl).padStart(2)}  ${fmtIp(r.responderIp)}  reports: Destination net unreachable.`); break; }
    L.push(`  ${String(ttl).padStart(2)} ${col()} ${col()} ${col()}  ${fmtIp(r.responderIp)}`);
    if (r.kind === 'reply') { reached = true; break; }
  }
  L.push('', 'Trace complete.');
  eng.event({ type: 'trace', host: d.id, target, ip, ok: reached });
  return { lines: L, trace: last };
}

function pathping(eng, d, args) {
  const target = args.find(a => !a.startsWith('-') && !a.startsWith('/'));
  if (!target) return { lines: ['Usage: pathping <target_name>'] };
  const res = resolveForTool(eng, d, target);
  if (!res.ok) return { lines: [`Unable to resolve target system name ${target}.`] };
  const ip = res.addr;
  const me = hostAddr(eng, d);
  const hops = [];
  for (let ttl = 1; ttl <= 30; ttl++) {
    const r = eng.probe({ from: d.id, dst: ip, proto: 'icmp', ttl });
    if (r.status !== 'ok') { hops.push(null); break; }
    hops.push(r);
    if (r.kind !== 'ttl-exceeded') break;
  }
  const L = ['', `Tracing route to ${res.literal ? fmtIp(ip) : `${res.name} [${fmtIp(ip)}]`}`, 'over a maximum of 30 hops:', `  0  ${d.hostname} [${fmtIp(me.addr)}]`];
  hops.forEach((h, i) => L.push(h ? `  ${i + 1}  ${fmtIp(h.responderIp)}` : `  ${i + 1}     *        *        *`));
  L.push('', 'Computing statistics for ' + (hops.length * 25) + ' seconds...', '            Source to Here   This Node/Link', 'Hop  RTT    Lost/Sent = Pct  Lost/Sent = Pct  Address', `  0                                           ${d.hostname} [${fmtIp(me.addr)}]`);
  let prevLoss = 0;
  hops.forEach((h, i) => {
    if (!h) { L.push(`  ${i + 1}  ---     100/ 100 =100%   100/ 100 =100%  *`); return; }
    const loss = Math.round((1 - (h.pass ?? 1)) * 100);
    const link = Math.max(0, loss - prevLoss);
    L.push(`${' '.repeat(32)}${String(link).padStart(3)}/ 100 =${String(link).padStart(3)}%   |`);
    L.push(`  ${String(i + 1).padStart(1)}  ${String(Math.round(h.rttMs + (h.jitter || 0))).padStart(4)}ms  ${String(loss).padStart(3)}/ 100 =${String(loss).padStart(3)}%    0/ 100 =  0%  ${fmtIp(h.responderIp)}`);
    prevLoss = loss;
  });
  L.push('', 'Trace complete.');
  eng.event({ type: 'pathping', host: d.id, target, ip, loss: hops.length && hops[hops.length - 1] ? Math.round((1 - (hops[hops.length - 1].pass ?? 1)) * 100) : 100 });
  return { lines: L };
}

function refusedNote(r) {
  return `trainer: ${(r.tried || []).map(x => fmtIp(x.ip)).join(', ')} answered with ICMP port unreachable: the server is up but nothing listens on UDP 53 (service down, not path down).`;
}

function nslookup(eng, d, args) {
  const name = args[0];
  const serverArg = args[1] ? parseIp(args[1]) : undefined;
  const a = hostAddr(eng, d);
  const srv = serverArg ?? (a.dns || [])[0];
  if (srv === undefined) return { lines: ['*** Default servers are not available', `Server:  UnKnown`, 'Address:  127.0.0.1', '', `*** UnKnown can't find ${name || ''}: No response from server`] };
  if (!name) return { lines: ['Default Server:  UnKnown', `Address:  ${fmtIp(srv)}`, '', '> ', { t: 'note', text: 'trainer: interactive nslookup is not supported here; use "nslookup <name> [server]".' }] };
  const r = resolveName(eng, d, name, { server: srv });
  const L = [];
  if (r.error === 'timeout') {
    L.push('DNS request timed out.', '    timeout was 2 seconds.', 'Server:  UnKnown', `Address:  ${fmtIp(srv)}`, '', 'DNS request timed out.', '    timeout was 2 seconds.', 'DNS request timed out.', '    timeout was 2 seconds.', '*** Request to UnKnown timed-out');
    eng.event({ type: 'dns', host: d.id, name, ok: false, error: 'timeout' });
    return { lines: L };
  }
  L.push('Server:  UnKnown', `Address:  ${fmtIp(srv)}`, '');
  if (r.error === 'refused') {
    L.push(`*** UnKnown can't find ${name}: No response from server`, { t: 'note', text: refusedNote(r) });
    eng.event({ type: 'dns', host: d.id, name, ok: false, error: 'refused' });
    return { lines: L };
  }
  if (r.ok) {
    if (!r.aa) L.push('Non-authoritative answer:');
    const cn = (r.answers || []).filter(x => x.type === 'CNAME');
    L.push(`Name:    ${cn.length ? cn[cn.length - 1].target : r.qname}`, `Address:  ${fmtIp(r.addr)}`);
    if (cn.length) L.push(`Aliases:  ${cn[0].name}`);
    L.push('');
  } else if (r.rcode === 'NXDOMAIN') L.push(`*** UnKnown can't find ${name}: Non-existent domain`);
  else if (r.rcode === 'SERVFAIL') L.push(`*** UnKnown can't find ${name}: Server failed`);
  else if (r.rcode === 'REFUSED') L.push(`*** UnKnown can't find ${name}: Query refused`);
  else L.push(`*** UnKnown can't find ${name}: No response from server`);
  L.push({ t: 'note', text: 'trainer: nslookup asks the DNS server directly and bypasses this PC\'s resolver cache (ping/curl use the cache).' });
  eng.event({ type: 'dns', host: d.id, name, server: srv, ok: !!r.ok, addr: r.addr, rcode: r.rcode, aa: r.aa });
  return { lines: L };
}

function curl(eng, d, args) {
  const flags = new Set(args.filter(a => a.startsWith('-')));
  const url = args.find(a => !a.startsWith('-'));
  if (!url) return { lines: ['curl: try \'curl --help\' or \'curl --manual\' for more information'] };
  const fixed = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const insecure = flags.has('-k') || flags.has('--insecure');
  const verbose = flags.has('-v') || flags.has('--verbose');
  const head = flags.has('-I') || flags.has('--head');
  const incl = flags.has('-i') || head;
  const r = httpRequest(eng, d, fixed, { insecure });
  const u = parseUrl(fixed);
  const L = [];
  if (verbose && r.ip !== undefined) {
    L.push(`* Host ${u.host}:${u.port} was resolved.`, '* IPv6: (none)', `* IPv4: ${fmtIp(r.ip)}`, `*   Trying ${fmtIp(r.ip)}:${u.port}...`);
    if (r.stage !== 'connect') {
      L.push(`* Connected to ${u.host} (${fmtIp(r.ip)}) port ${u.port}`);
      if (u.scheme === 'https') L.push('* schannel: disabled automatic use of client certificate', '* ALPN: curl offers http/1.1', '* ALPN: server accepted http/1.1');
    }
  }
  if (r.stage === 'parse') L.push('curl: (3) URL rejected: Malformed input to a URL function');
  else if (r.stage === 'resolve') L.push(`curl: (6) Could not resolve host: ${u.host}`);
  else if (r.stage === 'connect') {
    if (r.error.code === 28) L.push(`curl: (28) Failed to connect to ${u.host} port ${u.port} after 21${String(Math.floor(eng.rand() * 900)).padStart(3, '0')} ms: Timed out`);
    else L.push(`curl: (7) Failed to connect to ${u.host} port ${u.port} after ${r.error.refused ? Math.max(1, Math.round(r.connect?.rttMs || 1)) : 0} ms: Could not connect to server`);
    if (r.error.refused) L.push({ t: 'note', text: 'trainer: the host answered with a TCP reset: it is reachable, but nothing is listening on that port.' });
    else if (r.error.code === 28) L.push({ t: 'note', text: 'trainer: no answer at all (timeout) usually means a path, routing or filtering problem, not a stopped service.' });
  } else if (r.stage === 'tls') {
    L.push('curl: (60) schannel: SNI or certificate check failed: SEC_E_WRONG_PRINCIPAL (0x80090322) - The target principal name is incorrect.', 'More details here: https://curl.se/docs/sslcerts.html', '', 'curl failed to verify the legitimacy of the server and therefore could not', 'establish a secure connection to it. To learn more about this situation and', 'how to fix it, please visit the webpage mentioned above.');
  } else if (r.stage === 'http' && !r.status) {
    L.push(`curl: (56) Recv failure: Connection was reset`);
  } else {
    const reason = { 200: 'OK', 404: 'Not Found', 503: 'Service Unavailable', 301: 'Moved Permanently' }[r.status] || '';
    if (verbose) L.push(`> ${head ? 'HEAD' : 'GET'} ${u.path} HTTP/1.1`, `> Host: ${u.host}`, '> User-Agent: curl/8.9.1', '> Accept: */*', '>', `< HTTP/1.1 ${r.status} ${reason}`, '< Server: nginx/1.24.0', `< Content-Type: ${r.type}`, '<');
    if (incl) L.push(`HTTP/1.1 ${r.status} ${reason}`, 'Server: nginx/1.24.0', `Date: ${httpDate(eng)}`, `Content-Type: ${r.type}`, `Content-Length: ${r.body.length}`, 'Connection: keep-alive', '');
    if (!head) L.push(r.body);
    if (verbose) L.push(`* Connection #0 to host ${u.host} left intact`);
  }
  eng.event({ type: 'http', host: d.id, url: fixed.toLowerCase(), hostname: u?.host, ip: r.ip, ok: !!r.ok, status: r.status ?? null, stage: r.stage, code: r.error?.code ?? null, cache: !!r.resolve?.fromCache });
  return { lines: L, trace: r.connect };
}

function httpDate(eng) {
  const w = wallClock(eng.s.t);
  return `${w.dow.slice(0, 3)}, ${w.day} ${w.mon} ${w.year} ${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')} GMT`;
}

function arp(eng, d, args) {
  if (!/^[-/]a$/i.test(args[0] || '') && !/^[-/]g$/i.test(args[0] || '')) {
    if (/^[-/]d$/i.test(args[0] || '')) { d.arpCache = {}; return { lines: [] }; }
    return { lines: ['', 'Displays and modifies the IP-to-Physical address translation tables used by', 'address resolution protocol (ARP).', '', 'ARP -a [inet_addr]', 'ARP -d inet_addr'] };
  }
  const a = hostAddr(eng, d);
  if (a.addr === null) return { lines: ['No ARP Entries Found.'] };
  const L = ['', `Interface: ${fmtIp(a.addr)} --- 0x${d.nic === 'wlan0' ? '9' : '7'}`, '  Internet Address      Physical Address      Type'];
  for (const [ip, mac] of Object.entries(d.arpCache || {})) {
    L.push(`  ${fmtIp(Number(ip)).padEnd(22)}${macWindows(mac).toLowerCase().padEnd(22)}dynamic`);
  }
  L.push(`  ${fmtIp(broadcastOf(a.addr, a.len)).padEnd(22)}${'ff-ff-ff-ff-ff-ff'.padEnd(22)}static`, `  ${'224.0.0.22'.padEnd(22)}${'01-00-5e-00-00-16'.padEnd(22)}static`, `  ${'255.255.255.255'.padEnd(22)}${'ff-ff-ff-ff-ff-ff'.padEnd(22)}static`);
  return { lines: L };
}

function routePrint(eng, d) {
  const a = hostAddr(eng, d);
  const L = ['===========================================================================', 'Interface List', `  7...${macWindows(d.ports[d.nic].mac).replace(/-/g, ' ').toLowerCase()} ......${d.nic === 'wlan0' ? 'Intel(R) Wi-Fi 6E AX211 160MHz' : 'Intel(R) Ethernet Connection (17) I219-LM'}`, '  1...........................Software Loopback Interface 1', '===========================================================================', '', 'IPv4 Route Table', '===========================================================================', 'Active Routes:', 'Network Destination        Netmask          Gateway       Interface  Metric'];
  const row = (dst, mask, gw, ifc, m) => L.push(`${dst.padStart(17)}${mask.padStart(17)}${gw.padStart(17)}${ifc.padStart(17)}${String(m).padStart(6)}`);
  if (a.addr !== null && eng.portUp(d.id, d.nic)) {
    if (a.gw !== null && a.gw !== undefined) row('0.0.0.0', '0.0.0.0', fmtIp(a.gw), fmtIp(a.addr), 25);
    row(fmtIp(networkOf(a.addr, a.len)), fmtMask(a.len), 'On-link', fmtIp(a.addr), 281);
    row(fmtIp(a.addr), '255.255.255.255', 'On-link', fmtIp(a.addr), 281);
    row(fmtIp(broadcastOf(a.addr, a.len)), '255.255.255.255', 'On-link', fmtIp(a.addr), 281);
  }
  row('127.0.0.0', '255.0.0.0', 'On-link', '127.0.0.1', 331);
  row('127.0.0.1', '255.255.255.255', 'On-link', '127.0.0.1', 331);
  L.push('===========================================================================', 'Persistent Routes:', '  None');
  if (a.addr !== null && (a.gw === null || a.gw === undefined)) L.push({ t: 'note', text: 'trainer: no 0.0.0.0 route means no default gateway: anything off-subnet is unreachable.' });
  return { lines: L };
}

function displayDns(eng, d) {
  const L = ['', 'Windows IP Configuration', ''];
  const entries = Object.entries(d.dnsCache || {}).filter(([, c]) => c.expires > eng.s.t);
  if (!entries.length) { L.push('Could not display the DNS Resolver Cache.'); return L; }
  for (const [name, c] of entries) {
    L.push(`    ${name}`, '    ----------------------------------------', `    Record Name . . . . . : ${name}`, '    Record Type . . . . . : 1', `    Time To Live  . . . . : ${Math.round(c.expires - eng.s.t)}`, '    Data Length . . . . . : 4', '    Section . . . . . . . : Answer', `    A (Host) Record . . . : ${fmtIp(c.addr)}`, '', '');
  }
  return L;
}

export function winExecute(eng, sess, raw) {
  const d = eng.s.devices[sess.dev];
  const line = raw.trim();
  if (!line) return { lines: [] };
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/\.exe$/, '');
  const args = parts.slice(1);
  const a1 = (args[0] || '').toLowerCase();
  switch (cmd) {
    case 'help': case '?': return { lines: HELP };
    case 'cls': case 'clear': return { lines: [], clear: true };
    case 'hostname': return { lines: [d.hostname] };
    case 'whoami': return { lines: [sess.user ? `${d.hostname.toLowerCase()}\\${sess.user}` : `clinic\\operator`] };
    // ---- ospf (Act II): OpenSSH client (built into Windows 11); `exit` ends a session opened over SSH
    case 'ssh': {
      const a = parseOpenSsh(args, 'operator');
      if (a.usage || a.error) return { lines: [...(a.error ? [a.error] : []), ...OPENSSH_USAGE] };
      const r = sshConnect(eng, d, { user: a.user, host: a.host, port: a.port, client: 'openssh' });
      return { lines: r.lines, ...(r.ok ? { sshOpen: r.open } : {}) };
    }
    case 'exit':
      if (sess.user) return { lines: [], logout: true };
      return { lines: [`'${parts[0]}' is not recognized as an internal or external command,`, 'operable program or batch file.'] };
    case 'getmac': return { lines: ['', 'Physical Address    Transport Name', '=================== ==========================================================', `${macWindows(d.ports[d.nic].mac)}   \\Device\\Tcpip_{4D36E972-E325-11CE-BFC1-08002BE10318}`] };
    case 'ipconfig': {
      if (!a1) return { lines: ipconfig(eng, d, false) };
      if (a1 === '/all') { eng.event({ type: 'ipconfig', host: d.id }); return { lines: ipconfig(eng, d, true) }; }
      if (a1 === '/flushdns') { d.dnsCache = {}; eng.event({ type: 'flushdns', host: d.id }); return { lines: ['', 'Windows IP Configuration', '', 'Successfully flushed the DNS Resolver Cache.'] }; }
      if (a1 === '/displaydns') return { lines: displayDns(eng, d) };
      if (a1 === '/release') {
        if (!eng.portUp(d.id, d.nic)) return { lines: ['', 'Windows IP Configuration', '', `No operation can be performed on ${adapterName(d)} while it has its media disconnected.`] };
        if (!d.ipcfg.dhcp) return { lines: ['', 'Windows IP Configuration', '', `The operation failed as no adapter is in the state permissible for`, 'this operation.'] };
        dhcpRelease(eng, d);
        eng.mutated(`${d.hostname}: ipconfig /release`, 'player');
        return { lines: [...ipconfig(eng, d, false)] };
      }
      if (a1 === '/renew') {
        if (!eng.portUp(d.id, d.nic)) return { lines: ['', 'Windows IP Configuration', '', `No operation can be performed on ${adapterName(d)} while it has its media disconnected.`] };
        if (!d.ipcfg.dhcp) return { lines: ['', 'Windows IP Configuration', '', 'The operation failed as no adapter is in the state permissible for', 'this operation.'] };
        // With a lease, Windows renews it: a REQUEST unicast to the server that issued it, from the leased address
        // (broadcast only once past T2). Without one (APIPA, after /release) it runs DORA.
        const mode = !d.lease ? 'discover' : eng.s.t >= leaseTimes(d.lease).t2 ? 'rebind' : 'renew';
        const res = dhcpClient(eng, d, { mode });
        applyDhcpResult(eng, d, res);
        eng.mutated(`${d.hostname}: ipconfig /renew`, 'player');
        eng.event({ type: 'dhcp', host: d.id, ok: res.ok, rogue: !!res.rogue, addr: res.lease?.addr ?? null, via: res.via, server: res.lease?.server ?? null, mode: res.mode });
        const L = [];
        if (!res.ok) {
          L.push('', 'Windows IP Configuration', '', `An error occurred while renewing interface ${adapterName(d)} : unable to contact your DHCP server. Request has timed out.`);
          for (const n of res.notes || []) L.push({ t: 'note', text: `trainer: ${n}` });
          if (res.keepLease && d.lease) L.push({ t: 'note', text: `trainer: the lease on ${fmtIp(d.lease.addr)} has not expired, so Windows keeps using it. "ipconfig /release" then "ipconfig /renew" starts over with a broadcast DISCOVER.` });
          else if (!res.notes?.length) L.push({ t: 'note', text: 'trainer: the DHCP broadcast reached no working DHCP server or relay on this segment.' });
          return { lines: L, frames: res.frames };
        }
        L.push(...ipconfig(eng, d, false));
        if (res.rogue) L.push({ t: 'note', text: 'trainer: this lease did not come from CORE-SRV. Check "DHCP Server" in ipconfig /all.' });
        return { lines: L, frames: res.frames };
      }
      return { lines: ['', 'Error: unrecognized or incomplete command line.', '', 'USAGE:', '    ipconfig [/allcompartments] [/? | /all | /renew | /release | /flushdns | /displaydns]'] };
    }
    case 'ping': return ping(eng, d, args);
    case 'tracert': return tracert(eng, d, args);
    case 'pathping': return pathping(eng, d, args);
    case 'nslookup': return nslookup(eng, d, args);
    case 'curl': return curl(eng, d, args);
    case 'arp': return arp(eng, d, args);
    case 'route': if (a1 === 'print') return routePrint(eng, d); return { lines: ['Usage: route print'] };
    case 'netstat': if (args.join(' ').toLowerCase().includes('r')) return routePrint(eng, d); return { lines: ['Usage: netstat -rn'] };
    case 'traceroute': return { lines: [`'traceroute' is not recognized as an internal or external command,`, 'operable program or batch file.', { t: 'note', text: 'trainer: on Windows the command is tracert.' }] };
    case 'ifconfig': case 'ip': return { lines: [`'${cmd}' is not recognized as an internal or external command,`, 'operable program or batch file.', { t: 'note', text: 'trainer: on Windows use ipconfig (or ipconfig /all).' }] };
    case 'dig': return { lines: [`'dig' is not recognized as an internal or external command,`, 'operable program or batch file.', { t: 'note', text: 'trainer: Windows ships nslookup; dig is a Linux/BIND tool.' }] };
    default: return { lines: [`'${parts[0]}' is not recognized as an internal or external command,`, 'operable program or batch file.'] };
  }
}

export const WIN_COMMANDS = ['ipconfig', 'ipconfig /all', 'ipconfig /renew', 'ipconfig /release', 'ipconfig /flushdns', 'ipconfig /displaydns', 'ping', 'tracert', 'pathping', 'nslookup', 'curl', 'arp -a', 'route print', 'hostname', 'getmac', 'cls', 'help', 'ssh'];
