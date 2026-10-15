// Physical layout of the operations centre (metres). Y is up. The NOC floor faces north (−z) to the city.
import * as THREE from 'three';

export const ROOM = { x0: -12, x1: 12, z0: -9, z1: 9, h: 4.2 };
export const CORRIDOR = { x0: 12, x1: 19, z0: -7.4, z1: -5.6, h: 3.0 };
export const SECTOR_B = { x0: 19, x1: 29, z0: -11, z1: 1, h: 3.4 };
export const LOBBY = { z0: 4.6, x0: 4, x1: 12, doorX0: 5.0, doorX1: 6.6 };
export const DOOR_B = { x: 12, z0: -7.3, z1: -5.7 };

export const RACK = { x: -8.2, w: 0.78, d: 1.0, h: 2.12, frontX: -7.7 };
export const RACKS = [
  { id: 'A', z: -6.0, title: 'RACK A', sub: 'WAN · EDGE' },
  { id: 'B', z: -5.2, title: 'RACK B', sub: 'ACCESS' },
  { id: 'C', z: -4.4, title: 'RACK C', sub: 'PATCH' },
  { id: 'D', z: -3.6, title: 'RACK D', sub: 'SERVERS' },
  { id: 'E', z: -2.8, title: 'RACK E', sub: 'STORAGE' },
  { id: 'F', z: -2.0, title: 'RACK F', sub: 'UPS' },
];
const U = 0.04445;
export const RACK_DEVICES = [
  { dev: 'EDGE-RTR', rack: 'A', y: 1.32, units: 2, face: 'router' },
  { dev: 'ISP-NTE', rack: 'A', y: 1.62, units: 1, face: 'generic', label: 'ISP NTE · DC-44817', sub: 'Provider demarcation', decor: true },
  { dev: 'ACCESS-SW', rack: 'B', y: 1.42, units: 1, face: 'switch' },
  { dev: 'SW-SPARE', rack: 'B', y: 1.18, units: 1, face: 'generic', label: 'SPARE-SW (unused)', sub: 'C9200-24T', decor: true },
  { dev: 'PATCH', rack: 'C', y: 1.40, units: 2, face: 'patch' },
  { dev: 'CORE-SRV', rack: 'D', y: 1.52, units: 1, face: 'server', model: 'PowerEdge R650 · Ubuntu 24.04' },
  { dev: 'CLINIC-APP', rack: 'D', y: 1.36, units: 1, face: 'server', model: 'PowerEdge R650 · nginx' },
  { dev: 'CLINIC-OLD', rack: 'D', y: 1.20, units: 1, face: 'server', model: 'PowerEdge R640 · legacy', tag: 'DECOM PENDING', tint: '#2a2224' },
  { dev: 'CCTV-NVR', rack: 'D', y: 0.96, units: 2, face: 'server', model: 'NVR-64 · RTSP ingest' },
  { dev: 'SAN-A', rack: 'E', y: 1.30, units: 2, face: 'generic', label: 'SAN-A', sub: 'storage array', decor: true },
  { dev: 'SAN-B', rack: 'E', y: 1.00, units: 2, face: 'generic', label: 'SAN-B', sub: 'storage array', decor: true },
  { dev: 'UPS-1', rack: 'F', y: 0.42, units: 3, face: 'generic', label: 'UPS-1  5kVA', sub: 'online · 82% load', decor: true },
  { dev: 'UPS-2', rack: 'F', y: 0.82, units: 3, face: 'generic', label: 'UPS-2  5kVA', sub: 'online · 79% load', decor: true },
];

export function rackOf(id) { return RACKS.find(r => r.id === id); }
export function deviceFront(rd) {
  const r = rackOf(rd.rack);
  return { x: RACK.frontX + 0.012, y: rd.y, z: r.z, w: 0.48, h: rd.units * U };
}

/** Desk-based hosts and wall/ceiling devices. pos = where the NIC/cable attaches. */
export const PLACES = {
  'DISPATCH-01': { desk: { x: 0, z: -5.0, rot: 0 }, nic: [0.6, 0.76, -5.42] },
  'GUEST-KIOSK': { kiosk: { x: 9.2, z: 7.6, rot: Math.PI }, nic: [9.2, 0.6, 7.75] },
  'GUEST-AP': { ceiling: { x: 8.0, z: 6.2 }, nic: [8.0, 4.05, 6.2] },
  'NURSE-STATION': { desk: { x: 23.5, z: -9.0, rot: 0 }, nic: [24.1, 0.76, -9.42] },
  'VOIP-PHONE': { phone: [24.6, 0.8, -8.75], nic: [24.75, 0.78, -9.0] },
  'STAFF-LAPTOP': { table: { x: 27.0, z: -3.2 }, nic: [27.0, 0.78, -3.4] },
  'DIST-SW-B': { wallRack: { x: 21.0, z: -10.8 }, front: [21.0, 1.45, -10.55] },
  'CAMERAS': { nic: [21.4, 1.2, -10.55] },
  'DOOR-CTRL': { panel: [28.85, 1.45, -0.6], nic: [28.8, 1.2, -0.6] },
  'ROGUE-AP': { pos: [11.35, 0.5, 6.0], nic: [11.4, 0.52, 6.0] },
  DEMARC: { pos: [-11.85, 1.6, -6.4] },
};

export const LOBBY_JACKS = { 'Gi0/9': [11.92, 0.35, 6.0], 'Gi0/10': [11.92, 0.35, 7.2] };

// Interactable stations. `target` = mesh id for raycasting; `stand` = where quick-travel puts you.
export const STATIONS = [
  { id: 'DISPATCH-01', type: 'console', dev: 'DISPATCH-01', label: 'DISPATCH-01', sub: 'Clinic dispatch workstation · Windows', stand: [0, -3.5, 0], zone: 'noc' },
  { id: 'EDGE-RTR', type: 'console', dev: 'EDGE-RTR', label: 'EDGE-RTR', sub: 'Router · console cable · Cisco IOS', stand: [-6.6, -6.0, Math.PI / 2], zone: 'noc' },
  { id: 'ACCESS-SW', type: 'console', dev: 'ACCESS-SW', label: 'ACCESS-SW', sub: 'Access switch · console · Cisco IOS', stand: [-6.6, -5.2, Math.PI / 2], zone: 'noc' },
  { id: 'PATCH', type: 'patch', label: 'RACK C · PATCH PANEL', sub: 'Physical patching', stand: [-6.6, -4.4, Math.PI / 2], zone: 'noc' },
  { id: 'CORE-SRV', type: 'console', dev: 'CORE-SRV', label: 'CORE-SRV', sub: 'DHCP + DNS server · Ubuntu (KVM)', stand: [-6.6, -3.6, Math.PI / 2], zone: 'noc' },
  { id: 'CLINIC-APP', type: 'console', dev: 'CLINIC-APP', label: 'CLINIC-APP', sub: 'Clinic records web server · Ubuntu (KVM)', stand: [-6.6, -3.6, Math.PI / 2], zone: 'noc' },
  { id: 'CCTV-NVR', type: 'console', dev: 'CCTV-NVR', label: 'CCTV-NVR', sub: 'Video recorder · Linux (KVM)', stand: [-6.6, -3.6, Math.PI / 2], zone: 'noc' },
  { id: 'HOLO', type: 'map', label: 'NETWORK TABLE', sub: 'Live topology · IPAM · change log', stand: [0, 2.6, 0], zone: 'noc' },
  { id: 'WALL', type: 'map', label: 'SERVICE WALL', sub: 'Service health dashboard', stand: [9.4, 0, -Math.PI / 2], zone: 'noc' },
  { id: 'GUEST-KIOSK', type: 'console', dev: 'GUEST-KIOSK', label: 'GUEST-KIOSK', sub: 'Lobby kiosk on guest Wi-Fi · Windows', stand: [9.2, 6.3, Math.PI], zone: 'lobby' },
  { id: 'ROGUE-AP', type: 'rogue', dev: 'ROGUE-AP', label: 'UNKNOWN DEVICE', sub: 'Travel router plugged into a wall jack', stand: [10.4, 6.0, -Math.PI / 2], zone: 'lobby' },
  { id: 'DIST-SW-B', type: 'console', dev: 'DIST-SW-B', label: 'DIST-SW-B', sub: 'Sector B switch · console · Cisco IOS', stand: [21.0, -9.4, 0], zone: 'sectorb' },
  { id: 'NURSE-STATION', type: 'console', dev: 'NURSE-STATION', label: 'NURSE-STATION', sub: 'Ward B workstation · Windows', stand: [23.5, -7.6, 0], zone: 'sectorb' },
  { id: 'VOIP-PHONE', type: 'phone', dev: 'VOIP-PHONE', label: 'WARD B DISPATCH PHONE', sub: 'SIP desk phone · place a test call', stand: [24.6, -7.6, 0], zone: 'sectorb' },
  { id: 'STAFF-LAPTOP', type: 'console', dev: 'STAFF-LAPTOP', label: 'STAFF-LAPTOP', sub: 'Staff laptop on VLAN 20 · Windows', stand: [27.0, -1.9, 0], zone: 'sectorb' },
  { id: 'CCTV', type: 'cctv', label: 'CCTV WALL', sub: '50 camera feeds', stand: [26.6, -6.5, -Math.PI / 2], zone: 'sectorb' },
];

// ------------------------------------------------------------------ cable trays & routing
// Overhead cable-ladder graph. Cables rise from a device to the nearest node, follow trays, then drop.
export const TRAY_NODES = {
  R1: [-8.2, 2.55, -6.6], R2: [-8.2, 2.55, -4.4], R3: [-8.2, 2.55, -1.4],
  M0: [-6.0, 3.35, -4.4], M1: [0, 3.35, -4.4], M2: [6.0, 3.35, -4.4], M3: [11.4, 3.35, -4.4],
  W0: [-11.6, 2.55, -6.6],
  E0: [11.4, 3.35, -6.5], C0: [13.0, 2.6, -6.5], C1: [19.6, 2.6, -6.5],
  B0: [21.0, 2.9, -9.8], B1: [24.0, 2.9, -9.8], B2: [27.0, 2.9, -6.0], B3: [27.0, 2.9, -2.0], B4: [28.4, 2.9, -0.6],
  L0: [6.0, 3.35, 2.0], L1: [8.0, 3.35, 4.2], L2: [11.4, 3.35, 4.8],
};
const TRAY_EDGES = [
  ['R1', 'R2'], ['R2', 'R3'], ['R1', 'W0'], ['R2', 'M0'], ['M0', 'M1'], ['M1', 'M2'], ['M2', 'M3'], ['M3', 'E0'], ['E0', 'C0'], ['C0', 'C1'],
  ['C1', 'B0'], ['B0', 'B1'], ['C1', 'B2'], ['B2', 'B3'], ['B3', 'B4'], ['M2', 'L0'], ['L0', 'L1'], ['L1', 'L2'],
];
export const TRAY_SEGMENTS = TRAY_EDGES.map(([a, b]) => [TRAY_NODES[a], TRAY_NODES[b]]);

function nearestNode(p) {
  let best = null;
  let bd = Infinity;
  for (const [k, v] of Object.entries(TRAY_NODES)) {
    const d = Math.hypot(v[0] - p[0], v[2] - p[2]) + Math.abs(v[1] - p[1]) * 0.2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

function trayPath(a, b) {
  if (a === b) return [a];
  const dist = { [a]: 0 };
  const prev = {};
  const q = new Set(Object.keys(TRAY_NODES));
  while (q.size) {
    let u = null;
    for (const k of q) if (dist[k] !== undefined && (u === null || dist[k] < dist[u])) u = k;
    if (u === null) break;
    q.delete(u);
    if (u === b) break;
    for (const [x, y] of TRAY_EDGES) {
      const v = x === u ? y : y === u ? x : null;
      if (!v || !q.has(v)) continue;
      const d = dist[u] + new THREE.Vector3(...TRAY_NODES[u]).distanceTo(new THREE.Vector3(...TRAY_NODES[v]));
      if (dist[v] === undefined || d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  const path = [b];
  while (path[0] !== a && prev[path[0]]) path.unshift(prev[path[0]]);
  return path[0] === a ? path : [a, b];
}

function isRackPort(p) {
  return Math.abs(p.x - (RACK.frontX + 0.012)) < 0.06 && p.y < RACK.h && p.z > -6.6 && p.z < -1.4;
}

function rackCenterZ(z) {
  let best = RACKS[0].z;
  for (const r of RACKS) if (Math.abs(r.z - z) < Math.abs(best - z)) best = r.z;
  return best;
}

/** Points from a port to the point where the cable joins the overhead trays. */
function riser(p, out) {
  if (isRackPort(p)) {
    const fx = RACK.frontX + 0.075;
    const mz = rackCenterZ(p.z) - 0.335;
    return [p.clone(), p.clone().add(new THREE.Vector3(0.05, 0, 0)), new THREE.Vector3(fx, p.y, mz), new THREE.Vector3(fx, RACK.h + 0.06, mz), new THREE.Vector3(RACK.x + 0.15, RACK.h + 0.3, mz)];
  }
  const o = new THREE.Vector3(...out);
  const p1 = p.clone().add(o.clone().multiplyScalar(0.1));
  return [p.clone(), p1];
}

/**
 * Route between two anchors through the cable trays.
 * Returns an array of THREE.Vector3 forming a polyline suitable for a CatmullRom curve.
 */
export function routeBetween(a, outA, b, outB) {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  if (isRackPort(A) && isRackPort(B)) {
    // rack-to-rack: up the vertical manager, across the rack tops, down the other manager
    const fx = RACK.frontX + 0.07;
    const mzA = rackCenterZ(A.z) - 0.335;
    const mzB = rackCenterZ(B.z) - 0.335;
    const outA = A.clone().add(new THREE.Vector3(0.05, 0, 0));
    const outB = B.clone().add(new THREE.Vector3(0.05, 0, 0));
    if (Math.abs(mzA - mzB) < 0.01) return [A, outA, new THREE.Vector3(fx, A.y, mzA), new THREE.Vector3(fx, B.y, mzB), outB, B];
    const top = RACK.h + 0.06;
    const over = RACK.x + 0.22;
    return [A, outA, new THREE.Vector3(fx, A.y, mzA), new THREE.Vector3(fx, top, mzA), new THREE.Vector3(over, top + 0.08, mzA), new THREE.Vector3(over, top + 0.08, mzB), new THREE.Vector3(fx, top, mzB), new THREE.Vector3(fx, B.y, mzB), outB, B];
  }
  if (A.distanceTo(B) < 1.2) {
    const mid = A.clone().lerp(B, 0.5);
    mid.y -= 0.12;
    return [A, A.clone().add(new THREE.Vector3(...outA).multiplyScalar(0.06)), mid, B.clone().add(new THREE.Vector3(...outB).multiplyScalar(0.06)), B];
  }
  const ra = riser(A, outA);
  const rb = riser(B, outB);
  const ea = ra[ra.length - 1];
  const eb = rb[rb.length - 1];
  const na = nearestNode(ea.toArray());
  const nb = nearestNode(eb.toArray());
  const nodes = trayPath(na, nb).map(k => new THREE.Vector3(...TRAY_NODES[k]));
  const upA = new THREE.Vector3(ea.x, nodes[0].y, ea.z);
  const upB = new THREE.Vector3(eb.x, nodes[nodes.length - 1].y, eb.z);
  return [...ra, upA, ...nodes, upB, ...rb.reverse()];
}
