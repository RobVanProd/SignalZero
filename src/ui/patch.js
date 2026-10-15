// Rack C patch panel. Front ports are permanently wired (behind the panel) to the labelled device ports.
import { h, clear, overlay } from './dom.js';
import { PATCH_PANEL, patchLinkId } from '../content/district.js';

const CORD = ['#1f7bff', '#ffd23f', '#ff7a2f', '#37f59a', '#c86bff'];

export class PatchWindow {
  constructor(app) { this.app = app; this.sel = null; }

  open() {
    const app = this.app;
    this.sel = null;
    this.ports = h('div', { class: 'pp-ports' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.pp = h('div', { class: 'pp' }, this.ports, this.svg);
    this.outEl = h('div', { class: 'pp-out' }, 'Select a port, then a second port to connect them with a patch cord. Select a port that already has a cord to unplug it.');
    const card = h('div', { class: 'patch glass', role: 'dialog', 'aria-label': 'patch panel' },
      h('div', { class: 'wbar', style: { padding: '0 0 10px', background: 'none' } }, h('div', { class: 'ic' }, 'L1'), h('div', { class: 'ti' }, h('b', {}, 'RACK C · PATCH PANEL PP-C1'), h('small', {}, 'Front ports connect with patch cords. Each port is permanently cabled behind the panel to the device named on its label.')), h('button', { class: 'wclose', onclick: () => app.closeOverlay() }, '×')),
      this.pp, this.outEl,
      h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'A green LED means the two devices negotiated a link. It proves Layer 1 only: addressing, VLANs and routing still have to be right. Console ports use the same RJ-45 socket but carry serial management, not Ethernet.'));
    this.ov = overlay(card, { onClose: () => app.closeOverlay() });
    this.render();
  }

  render() {
    const app = this.app;
    const st = app.eng.s;
    clear(this.ports);
    for (const p of PATCH_PANEL) {
      const cord = st.patch.cords.find(c => c.includes(p.id));
      let led = '';
      if (cord) {
        const id = patchLinkId(cord[0], cord[1]);
        led = st.links[id] && app.eng.linkStatus(id).up ? 'up' : 'down';
      }
      const b = h('button', { class: `pport ${cord ? 'used' : ''} ${this.sel === p.id ? 'sel' : ''}`, 'data-port': p.id, onclick: () => this.click(p.id) },
        h('span', { class: 'num' }, p.id), h('span', { class: 'jack' }, h('span', { class: `led ${led}` })), h('span', { class: 'lab' }, p.label));
      this.ports.append(b);
    }
    requestAnimationFrame(() => this.drawCords());
  }

  drawCords() {
    const st = this.app.eng.s;
    const box = this.pp.getBoundingClientRect();
    this.svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    clear(this.svg);
    st.patch.cords.forEach((c, i) => {
      const a = this.ports.querySelector(`[data-port="${c[0]}"] .jack`)?.getBoundingClientRect();
      const b = this.ports.querySelector(`[data-port="${c[1]}"] .jack`)?.getBoundingClientRect();
      if (!a || !b) return;
      const ax = a.left - box.left + a.width / 2;
      const ay = a.top - box.top + a.height / 2;
      const bx = b.left - box.left + b.width / 2;
      const by = b.top - box.top + b.height / 2;
      const sag = 40 + Math.abs(bx - ax) * 0.18;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${ax} ${ay} C ${ax} ${ay + sag}, ${bx} ${by + sag}, ${bx} ${by}`);
      path.setAttribute('stroke', CORD[i % CORD.length]);
      this.svg.append(path);
    });
  }

  click(id) {
    const app = this.app;
    const st = app.eng.s;
    const cord = st.patch.cords.find(c => c.includes(id));
    if (!this.sel && cord) {
      const r = app.unpatch(id);
      this.outEl.textContent = r.ok ? `Unplugged ${r.cord[0]} ↔ ${r.cord[1]}.` : r.msg;
      this.render();
      return;
    }
    if (!this.sel) { this.sel = id; this.outEl.textContent = `${id} selected. Choose the other end.`; this.render(); return; }
    if (this.sel === id) { this.sel = null; this.outEl.textContent = 'Selection cleared.'; this.render(); return; }
    const a = this.sel;
    this.sel = null;
    const r = app.patch(a, id);
    if (!r.ok) this.outEl.textContent = r.msg;
    else {
      const ls = app.eng.linkStatus(r.id);
      this.outEl.textContent = ls.up ? `Patched ${a} ↔ ${id}. Link light: ON (${ls.speed} Mb/s ${ls.duplexA}-duplex).` : `Patched ${a} ↔ ${id}. Link light: OFF (${ls.fault === 'incompatible' ? 'no Ethernet signal on one end' : 'no link'}).`;
    }
    this.render();
  }

  close() { if (this.ov) { this.ov.remove(); this.ov = null; } }
}
