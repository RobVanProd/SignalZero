// Terminal dispatcher: one session per device console, routed to the right OS shell.
import { iosSession, iosExecute, iosPrompt, iosComplete } from './ios.js';
import { winSession, winExecute, winPrompt, WIN_COMMANDS } from './windows.js';
import { linuxSession, linuxExecute, linuxPrompt, linuxSaveFile, LINUX_COMMANDS } from './linux.js';

export function createSession(eng, devId) {
  const d = eng.s.devices[devId];
  if (d.os === 'ios') return iosSession(d);
  if (d.os === 'windows') return winSession(d);
  return linuxSession(d);
}

export function prompt(eng, sess) {
  if (sess.os === 'ios') return iosPrompt(eng, sess);
  if (sess.os === 'windows') return winPrompt(eng, sess);
  return linuxPrompt(eng, sess);
}

/** Run one command line. Always returns { lines, prompt, ... }. */
export function execute(eng, sess, line) {
  eng.ensure();
  let r;
  if (sess.os === 'ios') r = iosExecute(eng, sess, line);
  else if (sess.os === 'windows') r = winExecute(eng, sess, line);
  else r = linuxExecute(eng, sess, line);
  sess.history.push(line);
  if (sess.history.length > 60) sess.history.shift();
  eng.event({ type: 'command', host: sess.dev, os: sess.os, line: line.trim(), unknown: isUnknown(r) });
  return { ...r, prompt: prompt(eng, sess) };
}

function isUnknown(r) {
  const first = (r.lines || []).map(l => (typeof l === 'string' ? l : l.text)).join('\n');
  return /not recognized as an internal|command not found|Invalid input detected|Unrecognized command/.test(first);
}

export function complete(eng, sess, line) {
  if (sess.os === 'ios') return iosComplete(eng, sess, line);
  const pool = sess.os === 'windows' ? WIN_COMMANDS : LINUX_COMMANDS;
  const hits = pool.filter(c => c.startsWith(line.trim()) && c !== line.trim());
  return hits.length === 1 ? hits[0] + ' ' : null;
}

export function saveFile(eng, devId, path, text) { return linuxSaveFile(eng, devId, path, text); }
