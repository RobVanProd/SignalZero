// The apprenticeship bench: a small, fully working network used to teach one idea at a time before any fault.
// Two Ubuntu PCs and a server on two subnets, two unmanaged switches and one router. The same topology, addresses
// and MAC addresses are built from real Linux kernels in docs/apprenticeship/lab/bench-lab.sh, so every result the
// lesson shows can be compared with a real network.
//
//   PC-A ─┐                       ┌─ SRV
//   PC-B ─┴─ SW1 ── eth0 R1 eth1 ─┴─ SW2
import { Engine } from '../engine/engine.js';
import { device, addPort, link, resetDeviceCounter } from '../engine/model.js';
import { parseIp as ip } from '../engine/ipv4.js';

/**
 * Addressing variants. A is the teaching network; P (practice) changes the numbers and the prefix length so the
 * learner has to apply the idea, not repeat keystrokes.
 */
export const BENCH = {
  A: {
    name: 'Bench A', lan: { net: '192.168.10.0', len: 24 }, far: { net: '192.168.20.0', len: 24 },
    'PC-A': '192.168.10.11', 'PC-B': '192.168.10.12', 'R1-lan': '192.168.10.1', 'R1-far': '192.168.20.1', SRV: '192.168.20.10', unused: '192.168.10.254',
  },
  P: {
    name: 'Bench B', lan: { net: '10.20.30.64', len: 26 }, far: { net: '10.20.31.0', len: 24 },
    'PC-A': '10.20.30.70', 'PC-B': '10.20.30.100', 'R1-lan': '10.20.30.126', 'R1-far': '10.20.31.1', SRV: '10.20.31.25', unused: '10.20.30.125',
  },
};

// Locally administered MACs that name their owner (the lab uses the same ones).
export const BENCH_MAC = { 'PC-A': '02000000' + '0a11', 'PC-B': '02000000' + '0a12', 'R1-lan': '02000000' + '0a01', 'R1-far': '02000000' + '1401', SRV: '02000000' + '1410' };

/**
 * Build a bench network. opts.gw: { 'PC-A': addr|null, 'PC-B': ..., SRV: ... } overrides the default gateways
 * (by default the PCs have none and SRV uses R1).
 */
export function buildBench(variant = 'A', opts = {}) {
  const v = BENCH[variant];
  resetDeviceCounter();
  const D = {};
  const add = d => (D[d.id] = d);
  const gw = { 'PC-A': null, 'PC-B': null, SRV: v['R1-far'], ...(opts.gw || {}) };
  const host = (id, role) => {
    const len = id === 'SRV' ? v.far.len : v.lan.len;
    // proto: null -> routes print the way iproute2 shows routes added at run time (no "proto static")
    const d = add(device(id, 'host', 'linux', { role, hostname: id, ipcfg: { dhcp: false, v6Disabled: true, static: { addr: ip(v[id]), len, gw: gw[id] === null ? null : ip(gw[id]), routes: [], dns: [], proto: null } } }));
    addPort(d, 'eth0', { mac: BENCH_MAC[id] });
    d.firewall = { icmp: true, drop: [] };
    return d;
  };
  host('PC-A', 'Ubuntu 24.04 PC');
  host('PC-B', 'Ubuntu 24.04 PC');
  host('SRV', 'Ubuntu 24.04 server');
  for (const sw of ['SW1', 'SW2']) {
    const d = add(device(sw, 'switch', 'none', { role: 'Unmanaged switch', managed: false }));
    for (let i = 1; i <= 4; i++) addPort(d, `Gi0/${i}`);
    d.stp.disabled = [[1, 4094]]; // unmanaged: no spanning tree, ports forward at once (like the lab's Linux bridges)
  }
  const r = add(device('R1', 'router', 'ios', { role: 'Router (IPv4 forwarding, proxy ARP off)' }));
  addPort(r, 'eth0', { ip: { addr: ip(v['R1-lan']), len: v.lan.len }, mac: BENCH_MAC['R1-lan'], proxyArp: false });
  addPort(r, 'eth1', { ip: { addr: ip(v['R1-far']), len: v.far.len }, mac: BENCH_MAC['R1-far'], proxyArp: false });
  const L = {};
  const lk = (id, a, b) => (L[id] = link(id, a, b, { lengthM: 2 }));
  lk('pca', ['PC-A', 'eth0'], ['SW1', 'Gi0/1']);
  lk('pcb', ['PC-B', 'eth0'], ['SW1', 'Gi0/2']);
  lk('r1-lan', ['R1', 'eth0'], ['SW1', 'Gi0/4']);
  lk('r1-far', ['R1', 'eth1'], ['SW2', 'Gi0/4']);
  lk('srv', ['SRV', 'eth0'], ['SW2', 'Gi0/1']);
  const eng = new Engine({ devices: D, links: L, params: { site: 0, vlans: {} }, bench: variant });
  eng.ensure();
  return eng;
}

/** Faults used once their prerequisites have been taught. Each returns a one-line description for the ticket. */
export const BENCH_FAULTS = {
  // A typo'd gateway: an address on the right subnet that nobody owns. ARP for it fails.
  'wrong-gateway': { host: 'PC-A', apply: (eng, v) => setGw(eng, 'PC-A', BENCH[v].unused) },
  // The gateway is set to another PC's address. ARP succeeds, but a host does not forward packets.
  'gateway-is-host': { host: 'PC-A', apply: (eng, v) => setGw(eng, 'PC-A', BENCH[v]['PC-B']) },
  // The server has no default route, so its replies have no way back.
  'no-return': { host: 'SRV', apply: eng => setGw(eng, 'SRV', null) },
};

export function setGw(eng, id, addr) {
  const d = eng.s.devices[id];
  d.ipcfg.static.gw = addr === null ? null : ip(addr);
  d.ipcfg.static.routes = [];
  eng.mutated(`${id}: default gateway ${addr ?? 'removed'}`, 'lesson');
}

/** Does a ping from `from` to `to` (a device id or address) get an echo reply? Read-only: nothing is learned. */
export function benchReaches(eng, from, to) {
  const dst = typeof to === 'number' ? to : eng.s.devices[to] ? eng.s.devices[to].ipcfg.static.addr : ip(to);
  const r = eng.probe({ from, dst, proto: 'icmp' });
  return r.status === 'ok' && r.kind === 'reply';
}
