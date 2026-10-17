// ---- ospf (Act II): SSH in-band management (N10-009 3.5). Client and server checks for nested console sessions.
// The connection is a real TCP 22 probe through the simulated network (routing, NAT, ACLs all apply); the server side
// enforces the IOS vty transport and access-class. Session nesting itself lives in cli/index.js.
//
// Client wording (see docs/topics/ospf.md for sources): IOS "% Connection timed out; remote host not responding",
// "% Connection refused by remote host", "[Connection to X closed by foreign host]"; OpenSSH
// "ssh: connect to host X port 22: Connection timed out", "(user@host) Password:" for keyboard-interactive
// (OpenSSH >= 8.5, which Windows 11 and Ubuntu 24.04 ship), "user@host's password:" for password authentication.
import { fmtIp, parseIp } from '../engine/ipv4.js';
import { resolveName } from '../engine/services.js';
import { evalAcl } from '../engine/routing.js';

/** Lab credentials for the training network's consoles (shown in the M12 brief and hints). */
export const LAB_LOGIN = { user: 'admin', password: 'nightshift' };

/** Which SSH server a device runs, or null. */
export function sshServerKind(d) {
  if (!d || d.powered === false) return null;
  if (d.os === 'ios') return d.kind === 'router' && (d.vty?.transport ?? ['ssh']).includes('ssh') ? 'ios' : null;
  if (d.kind !== 'host') return null;
  const svc = Object.values(d.services || {}).find(s => s.kind === 'ssh' && s.active && (s.listen || []).some(l => l.proto === 'tcp' && l.port === 22));
  if (!svc) return null;
  return d.os === 'windows' ? 'windows' : 'linux';
}

const OPENSSH_USAGE = [
  'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]',
  '           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]',
  '           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]',
  '           [-J destination] [-L address] [-l login_name] [-m mac_spec]',
  '           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]',
  '           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]',
  '           destination [command [argument ...]]',
];

/** Parse OpenSSH client arguments (Windows 11 and Ubuntu ship OpenSSH 9.x). */
export function parseOpenSsh(args, defaultUser) {
  let user = null;
  let host = null;
  let port = 22;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l') { user = args[++i] ?? null; if (!user) return { usage: true }; continue; }
    if (a === '-p') { port = Number(args[++i]); if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `Bad port '${args[i] ?? ''}'` }; continue; }
    if (a === '-o' || a === '-i' || a === '-F' || a === '-J' || a === '-E') { i++; continue; }
    if (/^-[46AaCfGgKkMNnqsTtVvXxYy]+$/.test(a)) continue;
    if (a.startsWith('-')) return { error: `unknown option -- ${a.replace(/^-+/, '').slice(0, 1)}`, usage: true };
    if (host === null) host = a;
  }
  if (!host) return { usage: true };
  const at = host.lastIndexOf('@');
  if (at > 0) { user = user ?? host.slice(0, at); host = host.slice(at + 1); }
  if (!host) return { usage: true };
  return { user: user ?? defaultUser, host, port };
}

function openSshError(host, why) { return `ssh: connect to host ${host} port 22: ${why}`; }

/**
 * Client: open TCP 22 to `host` from device `dev`. client: 'ios' | 'openssh'.
 * Returns { ok:false, lines, stage } or { ok:true, lines, open:{ target, ip, host, user, client, server } }.
 */
export function sshConnect(eng, dev, { user, host, client, port = 22 }) {
  const ios = client === 'ios';
  let ip = parseIp(host);
  if (ip === null) {
    if (ios) return { ok: false, stage: 'resolve', lines: ['% Unknown command or computer name, or unable to find computer address'] };
    const r = resolveName(eng, dev, host, {});
    if (!r.ok) {
      const why = dev.os === 'windows' ? 'No such host is known.' : r.rcode === 'NXDOMAIN' ? 'Name or service not known' : 'Temporary failure in name resolution';
      return { ok: false, stage: 'resolve', lines: [`ssh: Could not resolve hostname ${host}: ${why}`] };
    }
    ip = r.addr;
  }
  if (port !== 22) return { ok: false, stage: 'connect', lines: [ios ? '% Connection refused by remote host' : openSshError(host, 'Connection refused')] };
  const p = eng.probe({ from: dev.id, dst: ip, proto: 'tcp', dport: 22, sport: 40000 + Math.floor(eng.rand() * 20000), record: true });
  const fail = (stage, iosText, osText, note) => {
    eng.event({ type: 'ssh', host: dev.id, ip, ok: false, stage });
    const lines = [ios ? iosText : openSshError(host, osText)];
    if (note) lines.push({ t: 'note', text: `trainer: ${note}` });
    return { ok: false, stage, lines };
  };
  if (p.status === 'local-error') return fail('connect', '% Destination unreachable; gateway or host down', 'Network is unreachable', `${dev.hostname} has no route to ${fmtIp(ip)}.`);
  if (p.status === 'timeout') {
    const why = p.replyLost ? `the SYN reached ${fmtIp(ip)} but its SYN-ACK never came back (${p.lostReason}): the far end has no working route back to this source.` : `nothing answered (${p.lostReason || 'no reply'}).`;
    return fail('connect', '% Connection timed out; remote host not responding', 'Connection timed out', why);
  }
  if (p.kind === 'net-unreachable') return fail('connect', '% Destination unreachable; gateway or host down', 'Network is unreachable', `${fmtIp(p.responderIp)} reported "network unreachable".`);
  if (p.kind !== 'syn-ack') return fail('refused', '% Connection refused by remote host', 'Connection refused', 'the host answered with a TCP reset: it is up, but no SSH server listens on port 22.');
  const target = eng.s.devices[p.fwd.at];
  const server = sshServerKind(target);
  if (!server) return fail('refused', '% Connection refused by remote host', 'Connection refused');
  // IOS vty access-class: checked against the source address the router sees (after any NAT on the way).
  if (server === 'ios' && target.vty?.acl) {
    const seen = p.fwd.pkt.src;
    const r = evalAcl(target, target.vty.acl, { proto: 'tcp', src: seen, dst: ip, sport: p.fwd.pkt.sport, dport: 22, flags: ['syn'] }, true);
    if (!r.permit) return fail('refused', '% Connection refused by remote host', 'Connection refused', `${target.hostname} refused the session: its vty access-class ${target.vty.acl} does not permit source ${fmtIp(seen)}.`);
  }
  eng.event({ type: 'ssh', host: dev.id, ip, ok: true, stage: 'connect', target: target.id });
  return { ok: true, lines: [], open: { target: target.id, ip, host, user, client, server } };
}

/** Prompt the client shows while waiting for the password. */
export function passwordPrompt(o) {
  if (o.client === 'ios') return 'Password:';
  if (o.server === 'ios') return `(${o.user}@${o.host}) Password:`;
  return `${o.user}@${o.host}'s password:`;
}

/** Check a password attempt. Returns { ok, lines, closed }. */
export function sshAuth(o, password) {
  if (o.user === LAB_LOGIN.user && password === LAB_LOGIN.password) return { ok: true, lines: [] };
  o.tries = (o.tries || 0) + 1;
  if (o.tries < 3) return { ok: false, lines: o.client === 'openssh' && o.server !== 'ios' ? ['Permission denied, please try again.'] : [] };
  if (o.client === 'ios') return { ok: false, closed: true, lines: ['% Authentication failed.', '', `[Connection to ${o.host} closed by foreign host]`] };
  const methods = o.server === 'ios' ? 'keyboard-interactive,password' : o.server === 'windows' ? 'publickey,password,keyboard-interactive' : 'publickey,password';
  return { ok: false, closed: true, lines: [`${o.user}@${o.host}: Permission denied (${methods}).`] };
}

/** What the remote side prints right after login. */
export function loginBanner(eng, o) {
  if (o.server === 'linux') return ['Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)', '', ' * Documentation:  https://help.ubuntu.com', ' * Management:     https://landscape.canonical.com', ' * Support:        https://ubuntu.com/pro', '', 'Last login: Thu Oct 15 01:12:44 2026 from 10.0.0.5'];
  if (o.server === 'windows') return ['Microsoft Windows [Version 10.0.26100.2033]', '(c) Microsoft Corporation. All rights reserved.', ''];
  return [''];
}

/** Client output when the remote side closes the session normally. */
export function closeLines(o, remoteLines = []) {
  if (o.client === 'ios') return ['', `[Connection to ${o.host} closed by foreign host]`];
  if (o.server === 'ios') return [`Connection to ${o.host} closed by remote host.`, `Connection to ${o.host} closed.`];
  return [...remoteLines, `Connection to ${o.host} closed.`];
}

/** Does the TCP path of an open session still work (client -> server port 22 and back)? */
export function sshPathOk(eng, fromDev, o) {
  const p = eng.probe({ from: fromDev, dst: o.ip, proto: 'tcp', dport: 22, sport: 40000 });
  return p.status === 'ok' && p.kind === 'syn-ack' && p.fwd.at === o.target;
}

/** Client output when the session's path broke under it. */
export function lostLines(o) {
  const note = { t: 'note', text: `trainer: ${o.host} stopped answering: the path this SSH session runs over is broken (often the change just made on the far end). A real client freezes until TCP gives up; here the session drops at once. Reconnect from a path that still works, or use the console.` };
  if (o.client === 'ios') return [note, '', `[Connection to ${o.host} closed by foreign host]`];
  return [note, 'client_loop: send disconnect: Broken pipe'];
}

export { OPENSSH_USAGE };
