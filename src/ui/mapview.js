// Network map window: live topology, IPAM documentation, service status, change log and quick travel.
import { h, clear, overlay } from './dom.js';
import { fmtIp, fmtMask } from '../engine/ipv4.js';
import { hostAddr, l3Ifaces } from '../engine/routing.js';
import { STATIONS } from '../world/layout.js';
import { net } from '../content/district.js';
import { wallClock } from '../engine/engine.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

/** IPAM sheet = documentation of the intended design (not live state: documentation can be wrong). */
export function ipamRows(p, eng) {
  const camIf = eng.s.devices['EDGE-RTR'].subifs[`Gi0/1.${p.vlans.cams}`];
  return [
    { what: `VLAN ${p.vlans.clinic} CLINIC`, subnet: `${net(p, 'clinic', 0)}/24`, gw: net(p, 'clinic', 1), notes: `DHCP ${net(p, 'clinic', 100)}–199` },
    { what: `VLAN ${p.vlans.staff} STAFF`, subnet: `${net(p, 'staff', 0)}/24`, gw: net(p, 'staff', 1), notes: 'DHCP via relay' },
    { what: `VLAN ${p.vlans.guest} GUEST`, subnet: `${net(p, 'guest', 0)}/24`, gw: net(p, 'guest', 1), notes: 'Internet only. No access to 10.0.0.0/8.' },
    { what: `VLAN ${p.vlans.cams} CAMERAS`, subnet: camIf?.ip ? `${fmtIp(camIf.ip.addr & ((0xffffffff << (32 - camIf.ip.len)) >>> 0))}/${camIf.ip.len}` : `${net(p, 'cams', 0)}/27`, gw: camIf?.ip ? fmtIp(camIf.ip.addr) : net(p, 'cams', 1), notes: 'Sector B PoE cameras (50)' },
    { what: `VLAN ${p.vlans.doors} DOORS`, subnet: `${net(p, 'cams', 64)}/27`, gw: net(p, 'cams', 65), notes: 'Door controllers — do not renumber' },
    { what: 'WAN', subnet: '198.51.100.0/30', gw: '198.51.100.1 (ISP)', notes: 'EDGE-RTR Gi0/0 = .2, PAT to the internet' },
    { what: 'CORE-SRV', subnet: net(p, 'clinic', 10), gw: '', notes: 'DHCP (isc-dhcp-server) + DNS (BIND), zone ops.example' },
    { what: 'CLINIC-APP', subnet: net(p, 'clinic', 20), gw: '', notes: 'clinic.ops.example (nginx, HTTPS)' },
    { what: 'CCTV-NVR', subnet: net(p, 'clinic', 30), gw: '', notes: 'RTSP ingest TCP 554' },
    { what: 'CLINIC-OLD', subnet: net(p, 'clinic', 99), gw: '', notes: 'DECOMMISSIONED 2026-10-01. Still powered, pending removal.' },
    { what: 'Public DNS', subnet: '203.0.113.53', gw: '', notes: 'resolver.example.net (forwarder)' },
  ];
}

export class MapWindow {
  constructor(app) { this.app = app; this.sel = null; this.tabName = 'topology'; }

  open(tab = 'topology') {
    const app = this.app;
    this.tabName = tab;
    this.body = h('div', { class: 'mapwrap' });
    this.tabBtns = {};
    const tabs = [['topology', 'Topology'], ['ipam', 'IPAM & docs'], ['services', 'Services'], ['changes', 'Change log'], ['travel', 'Quick travel']];
    const bar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => (this.tabBtns[k] = h('button', { class: `tab ${k === tab ? 'on' : ''}`, onclick: () => this.show(k) }, l))));
    this.side = h('div', { class: 'wside scroll' });
    const win = h('div', { class: 'window glass', role: 'dialog', 'aria-label': 'network map' },
      h('div', { class: 'wbar' }, h('div', { class: 'ic' }, '⌖'), h('div', { class: 'ti' }, h('b', {}, 'DISTRICT 04 · NETWORK'), h('small', {}, 'Live topology from the simulator · documentation · quick travel')), h('button', { class: 'wclose', onclick: () => app.closeOverlay() }, '×')),
      h('div', { class: 'wbody' }, h('div', { class: 'wmain' }, bar, this.body), this.side));
    this.ov = overlay(win, { onClose: () => app.closeOverlay() });
    this.show(tab);
  }

  show(k) {
    this.tabName = k;
    for (const [n, b] of Object.entries(this.tabBtns)) b.classList.toggle('on', n === k);
    clear(this.body);
    if (k === 'topology') this.topology();
    else if (k === 'ipam') this.ipam();
    else if (k === 'services') this.services();
    else if (k === 'changes') this.changes();
    else this.travel();
    this.renderSide();
  }

  topology() {
    const app = this.app;
    const eng = app.eng;
    const st = eng.s;
    const devs = Object.values(st.devices).filter(d => d.powered !== false);
    const svg = s('svg', { viewBox: '0 40 820 620', role: 'img', 'aria-label': 'network topology' });
    const pos = d => [d.map?.x ?? 400, d.map?.y ?? 300];
    const storms = new Set();
    for (const [, set] of eng.storms()) for (const id of set) storms.add(id);
    for (const l of Object.values(st.links)) {
      const a = st.devices[l.a.dev];
      const b = st.devices[l.b.dev];
      if (!a || !b || a.powered === false || b.powered === false) continue;
      const ls = eng.linkStatus(l.id);
      const cls = ['edge', !ls.up ? 'down' : '', storms.has(l.id) ? 'storm' : '', ls.mismatch ? 'mismatch' : '', l.media === 'wifi' ? 'wifi' : ''].join(' ');
      const [x1, y1] = pos(a);
      const [x2, y2] = pos(b);
      svg.append(s('line', { class: cls, x1, y1, x2, y2 }, s('title', {}, `${a.hostname} ${l.a.port} ↔ ${b.hostname} ${l.b.port}${ls.up ? ` · ${ls.speed} ${ls.duplexA}/${ls.duplexB}` : ` · DOWN: ${ls.reason || ''}`}`)));
    }
    const bad = new Set(st.flows.filter(f => !st.flowState[f.id]?.ok).map(f => f.from));
    for (const d of devs) {
      const [x, y] = pos(d);
      const a = d.kind === 'host' || d.kind === 'fleet' ? hostAddr(eng, d) : null;
      const sub = a ? (a.addr !== null ? fmtIp(a.addr) : 'no IP') : d.kind === 'router' ? 'router' : d.kind === 'switch' ? 'switch' : d.kind === 'bridge' ? (d.id === 'INTERNET' ? 'internet' : 'AP') : '';
      const g = s('g', { class: `node ${this.sel === d.id ? 'sel' : ''} ${bad.has(d.id) ? 'bad' : ''}`, transform: `translate(${x},${y})`, style: 'cursor:pointer' },
        s('rect', { x: -58, y: -20, width: 116, height: 40, rx: 8 }), s('text', { y: -3 }, d.hostname), s('text', { class: 'sub', y: 12 }, sub));
      g.addEventListener('click', () => { this.sel = d.id; this.show('topology'); });
      svg.append(g);
    }
    this.body.append(h('div', { class: 'map-svg' }, svg), h('div', { class: 'muted', style: { padding: '0 14px 10px', fontSize: '12px' } }, 'Solid cyan = link up · red dashed = down · amber = duplex mismatch · flashing red = loop. Click a device for details.'));
  }

  ipam() {
    const app = this.app;
    const rows = ipamRows(app.eng.s.params, app.eng);
    this.body.append(h('div', { class: 'capture scroll' }, h('div', { class: 'eyebrow' }, 'IP ADDRESS MANAGEMENT · DOCUMENTED DESIGN'),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'This is documentation, not live state. When documentation and the network disagree, find out which one is wrong.'),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Item', 'Subnet / address', 'Gateway', 'Notes'].map(x => h('th', {}, x)))), h('tbody', {}, rows.map(r => h('tr', {}, h('td', {}, r.what), h('td', { class: 'mono' }, r.subnet), h('td', { class: 'mono' }, r.gw), h('td', {}, r.notes)))))));
  }

  services() {
    const eng = this.app.eng;
    this.body.append(h('div', { class: 'capture scroll' }, h('div', { class: 'eyebrow' }, 'USER-FACING SERVICES (tested every 5 s by the simulator)'),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Service', 'From', 'Status', 'Detail'].map(x => h('th', {}, x)))),
        h('tbody', {}, eng.s.flows.map(f => { const fs = eng.s.flowState[f.id] || {}; return h('tr', {}, h('td', {}, f.label), h('td', { class: 'mono' }, f.from), h('td', {}, h('span', { class: `pill ${!fs.ok ? 'bad' : fs.degraded ? 'warn' : 'ok'}` }, h('span', { class: 'dot' }), !fs.ok ? 'DOWN' : fs.degraded ? 'DEGRADED' : 'OK')), h('td', { class: 'mono' }, fs.detail || '')); })))));
  }

  changes() {
    const eng = this.app.eng;
    const fmt = t => { const w = wallClock(t); return `${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')}`; };
    this.body.append(h('div', { class: 'capture scroll' }, h('div', { class: 'eyebrow' }, 'CHANGE LOG · newest first'),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Most outages start with a change. Check what changed before you change anything.'),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Time', 'Who', 'Change'].map(x => h('th', {}, x)))),
        h('tbody', {}, [...eng.s.changeLog].reverse().slice(0, 80).map(c => h('tr', {}, h('td', { class: 'mono' }, c.t < 0 ? 'earlier' : fmt(c.t)), h('td', {}, c.actor), h('td', { class: 'mono' }, c.desc)))))));
  }

  travel() {
    const app = this.app;
    const zoneOpen = z => z !== 'sectorb' || app.world.doorUnlocked;
    this.body.append(h('div', { class: 'capture scroll' }, h('div', { class: 'eyebrow' }, 'QUICK TRAVEL'), h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Walk, or jump straight to a station.'),
      h('div', { class: 'mgrid' }, STATIONS.filter(st => st.type !== 'rogue' || app.world.rogue.visible).map(st => h('button', { class: `mtile ${zoneOpen(st.zone) ? '' : 'locked'}`, disabled: !zoneOpen(st.zone), onclick: () => { app.closeOverlay(); app.travelTo(st.id); } },
        h('div', { class: 'c' }, st.zone.toUpperCase()), h('div', { class: 't' }, st.label), h('div', { class: 's' }, st.sub))))));
  }

  renderSide() {
    const app = this.app;
    const side = clear(this.side);
    const d = this.sel && app.eng.s.devices[this.sel];
    if (!d) {
      side.append(h('h5', {}, 'SELECT A DEVICE'), h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Click a node on the topology to see its interfaces and addresses.'));
      return;
    }
    side.append(h('h5', {}, d.kind.toUpperCase()), h('div', { style: { fontWeight: 800, fontSize: '16px' } }, d.hostname), h('p', { class: 'muted', style: { fontSize: '12.5px' } }, d.role || ''));
    const ifs = l3Ifaces(app.eng, d);
    if (ifs.length) side.append(h('h5', {}, 'L3 INTERFACES'), h('table', { class: 'table' }, h('tbody', {}, ifs.map(i => h('tr', {}, h('td', { class: 'mono' }, i.name), h('td', { class: 'mono' }, `${fmtIp(i.addr)}/${i.len}`), h('td', {}, i.up ? 'up' : 'down'))))));
    const st = STATIONS.find(x => x.dev === d.id || x.id === d.id);
    if (st) side.append(h('button', { class: 'btn small', style: { marginTop: '10px' }, onclick: () => { app.closeOverlay(); app.travelTo(st.id); } }, 'Go to this device'));
    void fmtMask;
  }

  close() { if (this.ov) { this.ov.remove(); this.ov = null; } }
}
