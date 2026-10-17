// Terminal dispatcher: one session per device console, routed to the right OS shell.
// ---- ospf (Act II): sessions nest. `ssh` from any console opens the remote device's shell inside the current
// console (sess.ssh = { ...connection, sess: <remote session> }), possibly several hops deep; `exit` on the remote
// side returns to the local one. All of it is plain JSON so a saved game keeps open sessions.
import { iosSession, iosExecute, iosPrompt, iosComplete } from './ios.js';
import { winSession, winExecute, winPrompt, WIN_COMMANDS } from './windows.js';
import { linuxSession, linuxExecute, linuxPrompt, linuxSaveFile, LINUX_COMMANDS } from './linux.js';
import { passwordPrompt, sshAuth, loginBanner, closeLines, sshPathOk, lostLines } from './ssh.js';

export function createSession(eng, devId) {
  const d = eng.s.devices[devId];
  if (d.os === 'ios') return iosSession(d);
  if (d.os === 'windows') return winSession(d);
  return linuxSession(d);
}

/** A session opened by SSH login: IOS vty at the user's privilege (admin is 15), or a user shell on a host. */
function remoteSession(eng, o) {
  const d = eng.s.devices[o.target];
  if (d.os === 'ios') return { ...iosSession(d), mode: 'exec', vty: true };
  if (d.os === 'windows') return winSession(d, { user: o.user });
  return linuxSession(d, { user: o.user });
}

function chainOf(sess) {
  const c = [sess];
  while (c[c.length - 1].ssh?.sess) c.push(c[c.length - 1].ssh.sess);
  return c;
}

/** The session commands currently go to (the innermost SSH hop, or the console itself). */
export function activeSession(sess) {
  const c = chainOf(sess);
  return c[c.length - 1];
}

/** The device commands currently run on (for UI labels and the coach). */
export function activeDevice(sess) { return activeSession(sess).dev; }

function promptOne(eng, s) {
  if (s.ssh?.pending) return passwordPrompt(s.ssh);
  if (s.os === 'ios') return iosPrompt(eng, s);
  if (s.os === 'windows') return winPrompt(eng, s);
  return linuxPrompt(eng, s);
}

export function prompt(eng, sess) { return promptOne(eng, activeSession(sess)); }

function runOs(eng, s, line) {
  if (s.os === 'ios') return iosExecute(eng, s, line);
  if (s.os === 'windows') return winExecute(eng, s, line);
  return linuxExecute(eng, s, line);
}

/** Run one command line. Always returns { lines, prompt, ... }. */
export function execute(eng, sess, line) {
  eng.ensure();
  const chain = chainOf(sess);
  // A nested session rides on TCP: if any hop's path broke (often the change just typed), the session is lost.
  for (let i = 0; i < chain.length - 1; i++) {
    const o = chain[i].ssh;
    if (sshPathOk(eng, chain[i].dev, o)) continue;
    chain[i].ssh = null;
    eng.event({ type: 'ssh-lost', host: chain[i].dev, target: o.target });
    return { lines: lostLines(o), prompt: prompt(eng, sess) };
  }
  const top = chain[chain.length - 1];
  let r;
  let secret = false;
  if (top.ssh?.pending) {
    secret = true;
    const o = top.ssh;
    const a = sshAuth(o, line.trim());
    if (a.ok) {
      top.ssh = { ...o, pending: false, sess: remoteSession(eng, o) };
      delete top.ssh.tries;
      eng.event({ type: 'ssh', host: top.dev, target: o.target, ip: o.ip, ok: true, stage: 'login', user: o.user });
      r = { lines: loginBanner(eng, o) };
    } else {
      if (a.closed) { top.ssh = null; eng.event({ type: 'ssh', host: top.dev, target: o.target, ip: o.ip, ok: false, stage: 'auth' }); }
      r = { lines: a.lines };
    }
  } else {
    r = runOs(eng, top, line);
    if (r.sshOpen) {
      top.ssh = { ...r.sshOpen, pending: true, tries: 0 };
      const { sshOpen, ...rest } = r;
      r = { ...rest, secretNext: true };
    }
    if (r.logout && chain.length > 1) {
      const parent = chain[chain.length - 2];
      const o = parent.ssh;
      parent.ssh = null;
      eng.event({ type: 'ssh-close', host: parent.dev, target: o.target });
      const remote = (r.lines || []).filter(l => l === 'logout');
      r = { ...r, logout: false, lines: closeLines(o, remote) };
    }
  }
  sess.history.push(secret ? '' : line);
  if (sess.history.length > 60) sess.history.shift();
  eng.event({ type: 'command', host: top.dev, os: top.os, line: secret ? '********' : line.trim(), unknown: !secret && isUnknown(r), ...(chain.length > 1 || secret ? { via: chain[0].dev, secret } : {}) });
  return { ...r, prompt: prompt(eng, sess), secret: !!activeSession(sess).ssh?.pending };
}

function isUnknown(r) {
  const first = (r.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n');
  return /not recognized as an internal|command not found|Invalid input detected|Unrecognized command/.test(first);
}

export function complete(eng, sess, line) {
  const s = activeSession(sess);
  if (s.ssh?.pending) return null;
  if (s.os === 'ios') return iosComplete(eng, s, line);
  const pool = s.os === 'windows' ? WIN_COMMANDS : LINUX_COMMANDS;
  const hits = pool.filter(c => c.startsWith(line.trim()) && c !== line.trim());
  return hits.length === 1 ? hits[0] + ' ' : null;
}

export function saveFile(eng, devId, path, text) { return linuxSaveFile(eng, devId, path, text); }
