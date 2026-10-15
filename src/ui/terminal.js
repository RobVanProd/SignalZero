// Device console window: a real-feeling shell (history, Tab completion, IOS "?" help), a packet-capture tab,
// field notes, and a sidebar with the live mission checklist, quick commands and hints.
import { h, clear, overlay } from './dom.js';
import { createSession, execute, complete, prompt as promptOf } from '../cli/index.js';
import { renderCapture } from './capture.js';
import { fmtIp } from '../engine/ipv4.js';
import { hostAddr } from '../engine/routing.js';

const QUICK = {
  ios: { router: ['enable', 'show ip interface brief', 'show ip route', 'show running-config', 'show access-lists', 'show ip nat translations', 'show interfaces g0/1', 'show logging', 'show cdp neighbors', 'configure terminal'],
    switch: ['enable', 'show interfaces status', 'show vlan brief', 'show interfaces trunk', 'show spanning-tree', 'show mac address-table', 'show logging', 'show ip dhcp snooping', 'show processes cpu sorted', 'configure terminal'] },
  windows: ['ipconfig /all', 'ipconfig /renew', 'ipconfig /flushdns', 'ipconfig /displaydns', 'ping ', 'tracert ', 'pathping ', 'nslookup ', 'curl -v https://', 'arp -a', 'route print'],
  linux: ['systemctl status isc-dhcp-server', 'journalctl -u isc-dhcp-server', 'systemctl status named', 'cat /etc/dhcp/dhcpd.conf', 'nano /etc/dhcp/dhcpd.conf', 'dhcpd -t -cf /etc/dhcp/dhcpd.conf', 'cat /etc/bind/db.ops.example', 'nano /etc/bind/db.ops.example', 'named-checkzone ops.example /etc/bind/db.ops.example', 'rndc reload', 'dhcp-lease-list', 'ip a', 'ss -tulpn', 'systemctl status nginx', 'cat /etc/netplan/01-netcfg.yaml'],
};

const CHEATS = {
  ios: [['enable', 'privileged mode (# prompt)'], ['configure terminal', 'enter config mode'], ['interface g0/6', 'select an interface'], ['do show …', 'run show commands from config mode'], ['?', 'list what can come next'], ['Tab', 'complete a keyword'], ['end / exit', 'leave config modes'], ['… | include TEXT', 'filter show output'], ['write memory', 'save running-config']],
  windows: [['ipconfig /all', 'address, mask, gateway, DHCP server, DNS'], ['ping host', 'ICMP reachability (not the app)'], ['tracert host', 'path, hop by hop'], ['nslookup name', 'ask DNS directly (skips cache)'], ['curl -v https://…', 'test the actual application'], ['ipconfig /displaydns', 'this PC\'s DNS cache']],
  linux: [['systemctl status UNIT', 'is the service running?'], ['journalctl -u UNIT', 'why did it stop?'], ['nano FILE', 'edit (Ctrl+O save, Ctrl+X exit)'], ['dhcpd -t -cf FILE', 'test DHCP config'], ['named-checkzone ZONE FILE', 'test a DNS zone'], ['rndc reload', 'apply zone changes'], ['… | grep TEXT', 'filter output']],
};

export class TerminalWindow {
  constructor(app) { this.app = app; this.ov = null; }

  console(devId) {
    const app = this.app;
    const c = (app.consoles[devId] ||= { lines: [], hist: [] });
    if (!c.sess) c.sess = createSession(app.eng, devId);
    return c;
  }

  open(station) {
    const app = this.app;
    const devId = station.dev;
    const d = app.eng.s.devices[devId];
    if (!d) return;
    this.devId = devId;
    this.station = station;
    const c = this.console(devId);
    if (!c.lines.length) this.banner(d, c);
    this.histIdx = c.hist.length;
    const osBadge = { ios: 'IOS', windows: 'WIN', linux: 'LNX' }[d.os] || d.os;
    this.out = h('div', { class: `term scroll os-${d.os}`, role: 'log', 'aria-live': 'polite' });
    this.pr = h('span', { class: 'pr' });
    this.input = h('input', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'command', placeholder: d.os === 'ios' ? 'type a command — ? for help, Tab to complete' : 'type a command — help lists supported commands' });
    this.input.addEventListener('keydown', e => this.key(e));
    const form = h('form', { class: 'cmdline', onsubmit: e => { e.preventDefault(); this.submit(); } }, this.pr, this.input, h('button', { class: 'btn small', type: 'submit' }, 'RUN ↵'));
    this.capture = h('div', { class: 'capture scroll hidden' });
    this.notes = h('div', { class: 'capture scroll hidden' });
    const tabs = [['console', 'Console'], ['capture', 'Packet capture'], ['notes', 'Field notes']];
    this.tabBtns = {};
    const tabBar = h('div', { class: 'tabs' }, tabs.map(([k, label]) => (this.tabBtns[k] = h('button', { class: `tab ${k === 'console' ? 'on' : ''}`, onclick: () => this.tab(k) }, label))));
    this.side = h('div', { class: 'wside scroll' });
    const body = h('div', { class: 'wbody' }, h('div', { class: 'wmain' }, tabBar, this.out, this.capture, this.notes, form), this.side);
    const win = h('div', { class: 'window glass', role: 'dialog', 'aria-label': `${d.hostname} console` },
      h('div', { class: 'wbar' }, h('div', { class: 'ic' }, osBadge), h('div', { class: 'ti' }, h('b', {}, station.label), h('small', {}, station.sub)),
        h('button', { class: 'btn small ghost mobile-only', onclick: () => this.side.classList.toggle('show') }, 'Goals'),
        h('button', { class: 'wclose', 'aria-label': 'Close', onclick: () => app.closeOverlay() }, '×')),
      body);
    this.ov = overlay(win, { onClose: () => app.closeOverlay() });
    this.render();
    this.renderSide();
    this.renderNotes(d);
    if (!app.touch) setTimeout(() => this.input.focus(), 30);
  }

  banner(d, c) {
    const app = this.app;
    if (d.os === 'ios') c.lines.push({ t: 'out', text: `\n${d.hostname} con0 is now available\n\nPress RETURN to get started.\n` });
    else if (d.os === 'windows') c.lines.push({ t: 'out', text: 'Microsoft Windows [Version 10.0.26100.2033]\n(c) Microsoft Corporation. All rights reserved.\n' });
    else c.lines.push({ t: 'out', text: `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\n\n  System load:  0.04   Users logged in: 1   IPv4 for ${d.nic}: ${(() => { const a = hostAddr(app.eng, d); return a.addr !== null ? fmtIp(a.addr) : '-'; })()}\n\nLast login: Thu Oct 15 01:12:44 2026 from 10.0.0.5\n` });
    if (app.trainerNotes) c.lines.push({ t: 'note', text: d.os === 'ios' ? 'Cisco-style CLI. Start with "enable", then "show …" commands. "?" lists options, Tab completes, abbreviations like "sh ip int br" work.' : d.os === 'windows' ? 'Windows command prompt. Type help for the supported commands.' : 'Ubuntu server shell (you are root). Type help for supported commands.' });
  }

  tab(k) {
    for (const [name, b] of Object.entries(this.tabBtns)) b.classList.toggle('on', name === k);
    this.out.classList.toggle('hidden', k !== 'console');
    this.capture.classList.toggle('hidden', k !== 'capture');
    this.notes.classList.toggle('hidden', k !== 'notes');
    if (k === 'capture') this.renderCapture();
    if (k === 'console' && !this.app.touch) this.input.focus();
  }

  render() {
    const c = this.console(this.devId);
    clear(this.out);
    const frag = document.createDocumentFragment();
    for (const l of c.lines.slice(-400)) {
      if (l.t === 'note') { if (l.coach ? this.app.coach.active : this.app.trainerNotes) frag.append(h('span', { class: `note${l.coach ? ' coach' : ''}` }, l.text)); continue; }
      if (l.t === 'cmd') { frag.append(h('div', { class: 'ln cmd' }, h('span', { class: 'pr' }, l.prompt + ' '), l.text)); continue; }
      frag.append(h('div', { class: 'ln' }, l.text));
    }
    this.out.append(frag);
    this.out.scrollTop = this.out.scrollHeight;
    this.pr.textContent = promptOf(this.app.eng, c.sess);
  }

  push(lines) {
    const c = this.console(this.devId);
    for (const l of lines) {
      if (typeof l === 'string') c.lines.push({ t: 'out', text: l });
      else if (l && l.t === 'note') c.lines.push({ t: 'note', text: l.text, coach: !!l.coach });
    }
    if (c.lines.length > 600) c.lines.splice(0, c.lines.length - 600);
  }

  submit(lineOverride) {
    const app = this.app;
    const c = this.console(this.devId);
    const line = lineOverride ?? this.input.value;
    this.input.value = '';
    const pr = promptOf(app.eng, c.sess);
    c.lines.push({ t: 'cmd', prompt: pr, text: line });
    if (line.trim()) { c.hist.push(line); if (c.hist.length > 80) c.hist.shift(); }
    this.histIdx = c.hist.length;
    const r = app.runCommand(this.devId, c.sess, line);
    if (r.clear) c.lines = [];
    else this.push(r.lines || []);
    if (r.keep) this.input.value = r.keep;
    this.render();
    this.renderSide();
    if (r.trace || r.frames) this.capBadge();
    if (r.editor) app.openEditor(r.editor, () => this.render());
    if (r.logout) this.render();
  }

  capBadge() {
    const b = this.tabBtns.capture;
    if (!b.querySelector('.badge')) b.append(h('span', { class: 'badge' }, 'new'));
  }

  key(e) {
    const app = this.app;
    const c = this.console(this.devId);
    if (e.key === 'Escape') { e.preventDefault(); app.closeOverlay(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.histIdx = Math.max(0, Math.min(c.hist.length, this.histIdx + (e.key === 'ArrowUp' ? -1 : 1)));
      this.input.value = c.hist[this.histIdx] ?? '';
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const done = complete(app.eng, c.sess, this.input.value);
      if (done) this.input.value = done;
      return;
    }
    if (e.key === '?' && c.sess.os === 'ios') {
      e.preventDefault();
      this.submit(this.input.value + '?');
      return;
    }
    if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); c.lines.push({ t: 'cmd', prompt: promptOf(app.eng, c.sess), text: this.input.value + '^C' }); this.input.value = ''; this.render(); return; }
    if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); c.lines = []; this.render(); return; }
    if (e.key === 'z' && e.ctrlKey && c.sess.os === 'ios') { e.preventDefault(); this.submit('end'); }
  }

  renderSide() {
    const app = this.app;
    const side = clear(this.side);
    const d = app.eng.s.devices[this.devId];
    const ev = app.lastEval || {};
    const m = app.missionInfo();
    const step = app.coach.active ? app.coach.current() : null;
    if (step) {
      const how = typeof step.how === 'string' ? step.how : app.touch ? step.how.touch : step.how.desktop;
      const here = step.cmd && step.cmd.dev === this.devId;
      side.append(h('h5', {}, `NEXT STEP ${app.coach.steps.indexOf(step) + 1} OF ${app.coach.steps.length}`), h('div', { class: 'sideblock coachside' },
        h('div', { class: 't' }, step.title), h('div', { class: 'how' }, how),
        here ? h('button', { class: 'chip go', title: 'Fill the prompt with this command, then press Enter', onclick: () => { this.input.value = step.cmd.text; if (!app.touch) this.input.focus(); } }, `▸ ${step.cmd.text}`) : null,
        step.cmd && !here ? h('div', { class: 'elsewhere' }, `This step runs on ${step.cmd.dev}. Close this window (Esc) and follow the orange marker.`) : null,
        step.where && step.where !== this.devId && !step.cmd ? h('div', { class: 'elsewhere' }, `Next: ${step.where === 'PATCH' ? 'the patch panel in RACK C' : step.where}. Close this window (Esc) and follow the orange marker.`) : null));
    }
    const last = app.coach.active ? app.coach.last : null;
    if (last?.learned) side.append(h('h5', {}, `LAST RESULT · ${last.title.toUpperCase()}`), h('div', { class: 'sideblock lastres' }, last.learned));
    if (m) {
      side.append(h('h5', {}, m.code), h('div', { class: 'sideblock' }, h('div', { style: { fontWeight: 800, marginBottom: '6px' } }, m.title),
        h('ul', { class: 'checklist' }, [...(ev.goals || []).map(g => h('li', { class: g.ok ? 'ok' : '' }, h('span', { class: 'ck' }, g.ok ? '✓' : ''), g.label)),
          ...(ev.status === 'verify' || (ev.evidence || []).some(e => e.ok) ? (ev.evidence || []).map(e => h('li', { class: `ev ${e.ok ? 'ok' : ''}` }, h('span', { class: 'ck' }, e.ok ? '✓' : ''), e.label)) : [])])));
      if (ev.status === 'verify') side.append(h('div', { class: 'hintbox', style: { borderColor: 'rgba(255,181,71,.5)' } }, 'The fix looks in place. Now prove it the way a user would experience it.'));
    }
    const q = d.os === 'ios' ? QUICK.ios[d.kind === 'router' ? 'router' : 'switch'] : QUICK[d.os] || [];
    side.append(h('h5', {}, 'QUICK COMMANDS'), h('div', { class: 'chips' }, q.map(cmd => h('button', { class: 'chip', title: cmd.endsWith(' ') || cmd.endsWith('//') ? 'fills the prompt; add a target' : 'click to fill, Enter to run', onclick: () => { this.input.value = cmd; if (!app.touch) this.input.focus(); } }, cmd))));
    if (m && app.hintsAllowed()) {
      const hint = app.currentHint();
      side.append(h('h5', {}, 'STUCK?'), h('button', { class: 'btn small', onclick: () => { app.useHint(); this.renderSide(); } }, hint.next ? `Reveal hint ${hint.next}/${hint.total} (−${hint.cost} rep)` : 'All hints shown'));
      if (hint.text) side.append(h('div', { class: 'hintbox' }, hint.text));
    }
  }

  renderCapture() {
    const b = this.tabBtns.capture.querySelector('.badge');
    if (b) b.remove();
    renderCapture(this.capture, this.app, this.devId);
  }

  renderNotes(d) {
    const app = this.app;
    const n = clear(this.notes);
    const a = d.kind === 'host' ? hostAddr(app.eng, d) : null;
    n.append(h('div', { class: 'panelpad' },
      h('div', { class: 'eyebrow' }, 'DEVICE'), h('h3', { style: { margin: '6px 0 4px' } }, d.hostname), h('div', { class: 'muted' }, d.role || ''),
      a && a.addr !== null ? h('p', { class: 'mono' }, `IPv4 ${fmtIp(a.addr)}/${a.len}${a.gw ? `  gw ${fmtIp(a.gw)}` : ''}`) : null,
      h('h4', { class: 'eyebrow', style: { marginTop: '18px' } }, 'CHEAT SHEET'),
      h('table', { class: 'table' }, h('tbody', {}, (CHEATS[d.os] || []).map(([k, v]) => h('tr', {}, h('td', { class: 'mono' }, k), h('td', {}, v))))),
      h('p', { class: 'muted', style: { marginTop: '14px', fontSize: '12px' } }, 'Outputs imitate real Cisco IOS, Windows and Ubuntu formats closely, but this is a training simulation: a subset of commands, and a bounded network model.')));
  }

  close() { if (this.ov) { this.ov.remove(); this.ov = null; } }
}
