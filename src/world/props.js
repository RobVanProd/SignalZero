// Furniture and equipment: racks with real faceplates, port LEDs, desks, monitors, kiosk, Sector B fit-out.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RACK, RACKS, RACK_DEVICES, rackOf, deviceFront, PLACES, LOBBY_JACKS, ROOM, SECTOR_B } from './layout.js';
import { switchFace, routerFace, serverFace, patchPanelFace, genericFace, labelTexture } from './textures.js';
import { Screen } from './screens.js';
import { PATCH_PANEL } from '../content/district.js';
import { sign } from './room.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Collects per-port LED instances; colours are updated every frame from engine state. */
export class LedBank {
  constructor() { this.items = []; }
  add(pos, key, size = [0.006, 0.004, 0.004]) { this.items.push({ pos, key, size }); return this.items.length - 1; }
  build(parent) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.2, 3.2), toneMapped: false });
    this.mesh = new THREE.InstancedMesh(g, mat, Math.max(1, this.items.length));
    const m = new THREE.Matrix4();
    this.items.forEach((it, i) => {
      m.compose(it.pos, new THREE.Quaternion(), new THREE.Vector3(...it.size));
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, new THREE.Color(0, 0, 0));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    this.byKey = new Map();
    this.items.forEach((it, i) => { if (!this.byKey.has(it.key)) this.byKey.set(it.key, []); this.byKey.get(it.key).push(i); });
  }
  set(key, color) {
    const idx = this.byKey.get(key);
    if (!idx) return;
    for (const i of idx) this.mesh.setColorAt(i, color);
  }
  commit() { if (this.mesh) this.mesh.instanceColor.needsUpdate = true; }
}

function hitbox(group, w, h, d, pos, station) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
  m.position.copy(pos);
  m.userData.station = station;
  group.add(m);
  return m;
}

function facePlane(map, emissive, w, h) {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.5, metalness: 0.4, emissiveMap: emissive || null, emissive: emissive ? 0xffffff : 0x000000, emissiveIntensity: emissive ? 0.55 : 0 });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

/**
 * Racks with devices. Returns anchors for every cabled port: anchors['DEV|PORT'] = { p: Vector3, out: [x,y,z] }.
 */
export function buildRacks(root, M, B, leds, hits) {
  const anchors = {};
  const patchPorts = {};
  for (const r of RACKS) {
    const cx = RACK.x;
    const z = r.z;
    // frame: posts, top/bottom, side panels, rails
    for (const dz of [-RACK.w / 2 + 0.03, RACK.w / 2 - 0.03]) {
      for (const dx of [-RACK.d / 2 + 0.03, RACK.d / 2 - 0.03]) B.box(0.05, RACK.h, 0.05, cx + dx, RACK.h / 2, z + dz, M.frame);
      B.box(RACK.d - 0.06, RACK.h - 0.1, 0.012, cx, RACK.h / 2, z + dz * 1.02, M.rackSide);
    }
    B.box(RACK.d, 0.05, RACK.w, cx, RACK.h - 0.025, z, M.frame);
    B.box(RACK.d, 0.08, RACK.w, cx, 0.04, z, M.frame);
    B.box(0.02, RACK.h - 0.2, RACK.w - 0.1, cx - RACK.d / 2 + 0.05, RACK.h / 2, z, M.rackInner);
    for (const dz of [-0.26, 0.26]) B.box(0.02, RACK.h - 0.2, 0.03, RACK.frontX - 0.03, RACK.h / 2, z + dz, M.chrome);
    // cable manager fingers on the right side
    for (let y = 0.25; y < RACK.h - 0.2; y += 0.09) B.box(0.05, 0.02, 0.05, RACK.frontX + 0.02, y, z - 0.32, M.plastic);
    // top label + glow strip
    const lab = sign(r.title, { w: 512, h: 128, font: '800 60px "Big Shoulders Display", sans-serif', fg: '#f0e6cf', bg: '#0b0f26', sub: r.sub }, 0.5, 0.125);
    lab.position.set(RACK.frontX + 0.03, RACK.h - 0.14, z);
    lab.rotation.y = Math.PI / 2;
    root.add(lab);
    B.box(0.01, 0.012, RACK.w - 0.12, RACK.frontX + 0.025, RACK.h - 0.06, z, M.stripCyan);
    // blanking panels everywhere a device is not
    const used = RACK_DEVICES.filter(d => d.rack === r.id).map(d => [d.y - d.units * 0.0222, d.y + d.units * 0.0222]);
    for (let y = 0.15; y < RACK.h - 0.25; y += 0.0889) {
      if (used.some(([a, b]) => y + 0.0889 > a - 0.002 && y < b + 0.002)) continue;
      B.box(0.01, 0.086, 0.48, RACK.frontX - 0.005, y + 0.0445, z, M.blank);
    }
  }
  for (const rd of RACK_DEVICES) {
    const f = deviceFront(rd);
    const r = rackOf(rd.rack);
    B.box(0.55, f.h - 0.002, 0.44, f.x - 0.29, f.y, f.z, M.device);
    let face;
    if (rd.face === 'switch') face = switchFace('C9200-24P', rd.dev);
    else if (rd.face === 'router') face = routerFace(rd.dev);
    else if (rd.face === 'server') face = serverFace(rd.dev, { model: rd.model, tag: rd.tag, tint: rd.tint });
    else if (rd.face === 'patch') face = patchPanelFace(PATCH_PANEL.map(p => ({ id: p.id, short: p.id })));
    else face = genericFace(rd.label || rd.dev, rd.sub || '', '#1f252d', 6);
    const plane = facePlane(face.map, face.emissive, f.w, f.h);
    plane.position.set(f.x, f.y, f.z);
    plane.rotation.y = Math.PI / 2;
    root.add(plane);
    for (const p of face.ports || []) {
      const pos = V(f.x + 0.003, f.y + (0.5 - p.v) * f.h, f.z + (0.5 - p.u) * f.w);
      if (rd.face === 'patch') {
        patchPorts[p.id] = pos.clone();
        leds.add(pos.clone().add(V(0.002, 0.012, 0.008)), `patch|${p.id}`);
      } else {
        anchors[`${rd.dev}|${p.name}`] = { p: pos.clone().add(V(0, -0.006, 0)), out: [1, 0, 0] };
        if (p.name !== 'Con0') leds.add(pos.clone().add(V(0.002, 0.003, 0.007)), `${rd.dev}|${p.name}`);
      }
    }
    if (!rd.decor) {
      const station = rd.face === 'patch' ? 'PATCH' : rd.dev;
      hits.push(hitbox(root, 0.12, Math.max(0.1, f.h + 0.05), 0.56, V(f.x + 0.04, f.y, f.z), station));
    }
    if (rd.face === 'server') {
      anchors[`${rd.dev}|eth0`] = { p: V(f.x + 0.002, f.y - f.h * 0.2, f.z - f.w * 0.45), out: [1, 0, 0] };
      leds.add(V(f.x + 0.003, f.y + f.h * 0.25, f.z - f.w * 0.46), `${rd.dev}|power`);
    }
    if (rd.decor) {
      for (let i = 0; i < 6; i++) leds.add(V(f.x + 0.003, f.y + f.h * 0.15, f.z + 0.15 - i * 0.016), `decor|${rd.dev}|${i}`);
    }
    void r;
  }
  // KVM drawer (screen) in rack D for server consoles
  const kvm = new Screen(512, 300);
  const kvmMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.25), kvm.material);
  const rd = rackOf('D');
  kvmMesh.position.set(RACK.frontX + 0.2, 1.06, rd.z);
  kvmMesh.rotation.set(0, Math.PI / 2, 0);
  kvmMesh.rotateX(-0.25);
  root.add(kvmMesh);
  B.box(0.36, 0.02, 0.46, RACK.frontX + 0.13, 0.92, rd.z, M.device);
  B.box(0.26, 0.008, 0.42, RACK.frontX + 0.17, 0.935, rd.z, M.plastic);
  return { anchors, patchPorts, kvm };
}

function chair(B, M, x, z, rot) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0));
  const place = (g, mat, lx, ly, lz) => {
    const p = V(lx, ly, lz).applyQuaternion(q).add(V(x, 0, z));
    B.add(g, mat, new THREE.Matrix4().compose(p, q, V(1, 1, 1)));
  };
  place(new RoundedBoxGeometry(0.52, 0.09, 0.5, 2, 0.03), M.fabric, 0, 0.5, 0);
  place(new RoundedBoxGeometry(0.5, 0.62, 0.08, 2, 0.035), M.fabric, 0, 0.88, 0.24);
  place(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 10), M.chrome, 0, 0.27, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = new THREE.BoxGeometry(0.04, 0.03, 0.32);
    const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot + a, 0));
    const p = V(Math.sin(a) * 0.14, 0.06, Math.cos(a) * 0.14).applyQuaternion(q).add(V(x, 0, z));
    B.add(leg, M.chrome, new THREE.Matrix4().compose(p, lq, V(1, 1, 1)));
  }
}

/** Operator desk with monitors. Monitors face +z in local space (toward the operator). */
export function buildDesk(root, M, B, { x, z, rot = 0 }, opts = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rot;
  root.add(group);
  const w = opts.width ?? 2.4;
  const top = new THREE.Mesh(new RoundedBoxGeometry(w, 0.05, 0.85, 2, 0.02), M.deskTop);
  top.position.set(0, 0.74, 0);
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, 0.008, 0.01), M.stripCyan);
  edge.position.set(0, 0.718, 0.42);
  group.add(edge);
  for (const sx of [-w / 2 + 0.06, w / 2 - 0.06]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 0.75), M.desk);
    leg.position.set(sx, 0.36, -0.02);
    group.add(leg);
  }
  if (opts.raceway !== false) {
    const top = opts.ceiling ?? 4.2;
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.07, top - 0.74, 0.07), M.trim);
    pole.position.set(0.6, 0.74 + (top - 0.74) / 2, -0.47);
    group.add(pole);
  }
  const modesty = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.42, 0.03), M.desk);
  modesty.position.set(0, 0.5, -0.38);
  group.add(modesty);
  const screens = [];
  const n = opts.monitors ?? 3;
  for (let i = 0; i < n; i++) {
    const s = new Screen(512, 300);
    const off = (i - (n - 1) / 2) * 0.62;
    const ang = (i - (n - 1) / 2) * -0.28;
    const mon = new THREE.Group();
    mon.position.set(off, 0, -0.18 + Math.abs(i - (n - 1) / 2) * 0.08);
    mon.rotation.y = ang;
    const bez = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.36, 0.025, 2, 0.008), M.plastic);
    bez.position.y = 1.08;
    mon.add(bez);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.575, 0.335), s.material);
    scr.position.set(0, 1.08, 0.0135);
    mon.add(scr);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.03), M.trim);
    stand.position.set(0, 0.9, -0.03);
    mon.add(stand);
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.015, 0.16, 2, 0.006), M.trim);
    base.position.set(0, 0.772, 0);
    mon.add(base);
    group.add(mon);
    screens.push(s);
  }
  const kb = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.02, 0.15, 2, 0.006), M.plastic);
  kb.position.set(0, 0.775, 0.17);
  group.add(kb);
  const keys = new THREE.Mesh(new THREE.PlaneGeometry(0.41, 0.12), new THREE.MeshStandardMaterial({ color: 0x0b0e11, emissive: 0x1a6b80, emissiveIntensity: 0.25, roughness: 0.6 }));
  keys.rotation.x = -Math.PI / 2;
  keys.position.set(0, 0.786, 0.17);
  group.add(keys);
  const mouse = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.025, 0.1, 2, 0.012), M.plastic);
  mouse.position.set(0.33, 0.775, 0.18);
  group.add(mouse);
  if (opts.lamp) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.04, 16), M.lightWarm);
    lamp.position.set(-w / 2 + 0.25, 1.15, -0.15);
    group.add(lamp);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 8), M.chrome);
    arm.position.set(-w / 2 + 0.25, 0.96, -0.15);
    group.add(arm);
  }
  group.updateMatrixWorld(true);
  chair(B, M, ...new THREE.Vector3(0, 0, 0.75).applyAxisAngle(V(0, 1, 0), rot).add(V(x, 0, z)).toArray().filter((_, i) => i !== 1), rot);
  return { group, screens };
}

/** Holo table base. */
export function buildHoloBase(root, M) {
  const g = new THREE.Group();
  g.position.set(0, 0, 1.0);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.6, 0.86, 64), M.desk);
  base.position.y = 0.43;
  base.castShadow = true;
  g.add(base);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(1.48, 0.035, 10, 96), M.trim);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.88;
  g.add(lip);
  const glow = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.012, 8, 96), M.stripCyan);
  glow.rotation.x = Math.PI / 2;
  glow.position.y = 0.885;
  g.add(glow);
  const kick = new THREE.Mesh(new THREE.TorusGeometry(1.58, 0.01, 8, 96), M.stripCyan);
  kick.rotation.x = Math.PI / 2;
  kick.position.y = 0.06;
  g.add(kick);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(1.42, 64), new THREE.MeshStandardMaterial({ color: 0x06202a, emissive: 0x0a4a5a, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.92 }));
  glass.rotation.x = -Math.PI / 2;
  glass.position.y = 0.875;
  g.add(glass);
  root.add(g);
  return g;
}

export function buildVideoWall(root, M, B) {
  const screens = [];
  const x = ROOM.x1 - 0.14;
  const cols = 3;
  const rows = 2;
  const w = 1.9;
  const h = 1.07;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const s = new Screen(1024, 576, { brightness: 1.6 });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.02, h - 0.02), s.material);
      const z = (i - (cols - 1) / 2) * w;
      m.position.set(x - 0.075, 1.35 + j * h + h / 2, z);
      m.rotation.y = -Math.PI / 2;
      root.add(m);
      screens.push(s);
    }
  }
  B.box(0.06, rows * h + 0.12, cols * w + 0.12, x - 0.01, 1.35 + (rows * h) / 2, 0, M.plastic);
  B.box(0.02, 0.02, cols * w + 0.1, x - 0.07, 1.33, 0, M.stripCyan);
  const desk = buildDesk(root, M, B, { x: 9.6, z: 0, rot: -Math.PI / 2 }, { monitors: 2, width: 2.0 });
  return { screens, deskScreens: desk.screens };
}

export function buildLobby(root, M, B, leds, hits, anchors) {
  // kiosk
  const k = PLACES['GUEST-KIOSK'].kiosk;
  const g = new THREE.Group();
  g.position.set(k.x, 0, k.z);
  g.rotation.y = k.rot;
  root.add(g);
  const post = new THREE.Mesh(new RoundedBoxGeometry(0.42, 1.2, 0.2, 2, 0.04), M.plasticLight);
  post.position.y = 0.6;
  g.add(post);
  const head = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.86, 0.08, 3, 0.03), M.plasticLight);
  head.position.set(0, 1.45, 0.02);
  head.rotation.x = -0.12;
  g.add(head);
  const scr = new Screen(512, 720);
  const sm = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.76), scr.material);
  sm.position.set(0, 1.45, 0.065);
  sm.rotation.x = -0.12;
  g.add(sm);
  g.updateMatrixWorld(true);
  hits.push(hitbox(root, 0.7, 1.9, 0.7, V(k.x, 0.95, k.z), 'GUEST-KIOSK'));
  // AP on the ceiling
  const ap = PLACES['GUEST-AP'].ceiling;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.04, 32), M.plasticLight);
  disc.position.set(ap.x, ROOM.h - 0.03, ap.z);
  root.add(disc);
  leds.add(V(ap.x, ROOM.h - 0.055, ap.z), 'GUEST-AP|wlan0', [0.02, 0.004, 0.02]);
  anchors['GUEST-AP|eth0'] = { p: V(ap.x + 0.15, ROOM.h - 0.02, ap.z), out: [0, 1, 0] };
  anchors['GUEST-KIOSK|wlan0'] = { p: V(k.x, 1.5, k.z), out: [0, 1, 0] };
  anchors['GUEST-AP|wlan0'] = { p: V(ap.x, ROOM.h - 0.07, ap.z), out: [0, -1, 0] };
  // warm slatted feature wall + welcome sign
  for (let i = 0; i < 26; i++) B.box(0.12, 3.0, 0.05, 4.4 + i * 0.29, 1.6, ROOM.z1 - 0.16, M.wood);
  B.box(7.6, 0.02, 0.04, 8.2, 0.12, ROOM.z1 - 0.2, M.stripAmber);
  const welcome = sign('WELCOME  ·  GUEST WI-FI: CityClinic-Guest', { w: 2048, h: 160, font: '800 70px "Big Shoulders Display", sans-serif', fg: '#f0e6cf', bg: null }, 4.8, 0.38);
  welcome.position.set(8.2, 2.7, ROOM.z1 - 0.2);
  welcome.rotation.y = Math.PI;
  root.add(welcome);
  // bench + jacks
  B.box(0.45, 0.06, 2.6, 11.4, 0.45, 6.6, M.deskTop);
  for (const z of [5.5, 7.7]) B.box(0.4, 0.42, 0.06, 11.4, 0.21, z, M.trim);
  for (const [port, p] of Object.entries(LOBBY_JACKS)) {
    B.box(0.02, 0.12, 0.08, p[0], p[1], p[2], M.plasticLight);
    const lab = sign(`L-${port.split('/')[1].padStart(2, '0')}`, { w: 256, h: 96, font: 'bold 54px monospace', fg: '#20262d', bg: '#e9edf0' }, 0.08, 0.03);
    lab.position.set(p[0] - 0.012, p[1] + 0.09, p[2]);
    lab.rotation.y = -Math.PI / 2;
    root.add(lab);
    anchors[`ACCESS-SW|${port}`] = { p: V(p[0] - 0.015, p[1], p[2]), out: [-1, 0, 0], jack: true };
  }
  // planters
  for (const [x, z] of [[4.7, 8.3], [11.3, 8.4], [-11.3, 8.3], [-11.3, -8.3], [11.3, -8.3]]) {
    B.box(0.5, 0.55, 0.5, x, 0.275, z, M.planter);
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.9 + (k % 3) * 0.2, 5), M.plant);
      leaf.position.set(x + Math.cos(a) * 0.1, 0.95, z + Math.sin(a) * 0.1);
      leaf.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
      B.mesh(leaf);
    }
  }
  // rogue travel router (hidden until M10)
  const rogue = new THREE.Group();
  const rp = PLACES['ROGUE-AP'].pos;
  rogue.position.set(...rp);
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.03, 0.09, 2, 0.01), M.plasticLight);
  rogue.add(body);
  for (const s of [-0.04, 0.04]) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6), M.plasticLight);
    ant.position.set(-0.04, 0.06, s);
    ant.rotation.z = 0.3;
    rogue.add(ant);
  }
  const rled = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.02), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 3, 4), toneMapped: false }));
  rled.position.set(0.061, 0.004, 0);
  rogue.add(rled);
  rogue.visible = false;
  root.add(rogue);
  const rogueHit = hitbox(root, 0.4, 0.4, 0.4, V(rp[0], rp[1], rp[2]), 'ROGUE-AP');
  anchors['ROGUE-AP|eth0'] = { p: V(rp[0] + 0.06, rp[1], rp[2]), out: [1, 0, 0] };
  return { kioskScreen: scr, rogue, rogueHit };
}

export function buildSectorB(root, M, B, leds, hits, anchors) {
  const out = {};
  // wall cabinet with DIST-SW-B
  const wr = PLACES['DIST-SW-B'].wallRack;
  B.box(0.62, 0.7, 0.45, wr.x, 1.45, wr.z + 0.02, M.rackSide);
  B.box(0.66, 0.74, 0.02, wr.x, 1.45, wr.z - 0.2, M.frame);
  const face = switchFace('C9200-24P', 'DIST-SW-B');
  const fw = 0.48;
  const fh = 0.0445;
  const plane = facePlane(face.map, face.emissive, fw, fh);
  const fy = 1.45;
  const fz = wr.z + 0.25;
  plane.position.set(wr.x, fy, fz);
  root.add(plane);
  for (const p of face.ports) {
    const pos = V(wr.x + (p.u - 0.5) * fw, fy + (0.5 - p.v) * fh, fz + 0.003);
    anchors[`DIST-SW-B|${p.name}`] = { p: pos.clone().add(V(0, -0.006, 0)), out: [0, 0, 1] };
    if (p.name !== 'Con0') leds.add(pos.clone().add(V(-0.007, 0.003, 0.002)), `DIST-SW-B|${p.name}`);
  }
  const lab = sign('SECTOR B · IDF-1', { w: 512, h: 96, font: '800 46px "Big Shoulders Display", sans-serif', fg: '#f0e6cf', bg: '#0b0f26' }, 0.5, 0.09);
  lab.position.set(wr.x, 1.88, wr.z + 0.255);
  root.add(lab);
  hits.push(hitbox(root, 0.7, 0.8, 0.5, V(wr.x, 1.45, wr.z + 0.25), 'DIST-SW-B'));
  // camera PoE bank anchor shares the cabinet
  anchors['CAMERAS|eth0'] = { p: V(wr.x + 0.3, 1.2, wr.z + 0.25), out: [0, 0, 1] };
  // nurse desk + phone
  const nd = buildDesk(root, M, B, PLACES['NURSE-STATION'].desk, { monitors: 2, width: 2.2, lamp: true, ceiling: SECTOR_B.h });
  out.nurseScreens = nd.screens;
  hits.push(hitbox(root, 1.6, 0.8, 0.8, V(PLACES['NURSE-STATION'].desk.x - 0.4, 1.0, PLACES['NURSE-STATION'].desk.z), 'NURSE-STATION'));
  const ph = PLACES['VOIP-PHONE'].phone;
  const phone = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.05, 0.2, 2, 0.015), M.plastic);
  phone.position.set(...ph);
  phone.rotation.x = -0.35;
  root.add(phone);
  const pscr = new Screen(256, 128);
  const psm = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.06), pscr.material);
  psm.position.set(ph[0], ph[1] + 0.03, ph[2] - 0.02);
  psm.rotation.x = -Math.PI / 2 + 0.35;
  root.add(psm);
  out.phoneScreen = pscr;
  hits.push(hitbox(root, 0.4, 0.4, 0.4, V(ph[0], ph[1], ph[2]), 'VOIP-PHONE'));
  // staff table + laptop
  const st = PLACES['STAFF-LAPTOP'].table;
  B.box(1.4, 0.04, 0.8, st.x, 0.74, st.z, M.deskTop);
  for (const [dx, dz] of [[-0.62, -0.32], [0.62, -0.32], [-0.62, 0.32], [0.62, 0.32]]) B.box(0.04, 0.72, 0.04, st.x + dx, 0.36, st.z + dz, M.chrome);
  const lapBase = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.018, 0.25, 2, 0.006), M.trim);
  lapBase.position.set(st.x, 0.77, st.z + 0.05);
  root.add(lapBase);
  const lscr = new Screen(512, 320);
  const lid = new THREE.Group();
  lid.position.set(st.x, 0.78, st.z - 0.075);
  lid.rotation.x = -0.25;
  const lidBack = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.24, 0.01, 2, 0.006), M.trim);
  lidBack.position.y = 0.12;
  lid.add(lidBack);
  const lsm = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.21), lscr.material);
  lsm.position.set(0, 0.12, 0.006);
  lid.add(lsm);
  root.add(lid);
  out.laptopScreen = lscr;
  hits.push(hitbox(root, 0.8, 0.6, 0.6, V(st.x, 0.95, st.z), 'STAFF-LAPTOP'));
  chair(B, M, st.x, st.z + 0.75, 0);
  // CCTV wall
  const cctv = new Screen(1600, 860, { brightness: 1.5 });
  const cm = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 2.15), cctv.material);
  cm.position.set(SECTOR_B.x1 - 0.16, 1.85, -6.5);
  cm.rotation.y = -Math.PI / 2;
  root.add(cm);
  B.box(0.06, 2.3, 4.15, SECTOR_B.x1 - 0.1, 1.85, -6.5, M.plastic);
  out.cctv = cctv;
  hits.push(hitbox(root, 0.6, 2.2, 4.0, V(SECTOR_B.x1 - 0.4, 1.85, -6.5), 'CCTV'));
  // door controller
  const dc = PLACES['DOOR-CTRL'].panel;
  B.box(0.04, 0.32, 0.22, dc[0], dc[1], dc[2], M.plasticLight);
  leds.add(V(dc[0] - 0.025, dc[1] + 0.1, dc[2]), 'DOOR-CTRL|eth0', [0.004, 0.012, 0.012]);
  anchors['DOOR-CTRL|eth0'] = { p: V(dc[0] - 0.03, dc[1] - 0.12, dc[2]), out: [-1, 0, 0] };
  // camera domes on the ceiling
  for (const [x, z] of [[21, -4], [24, -1], [27, -9], [20.5, -9.8], [27.5, 0.2], [23, -5.5]]) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.glassFrost);
    d.rotation.x = Math.PI;
    d.position.set(x, SECTOR_B.h - 0.01, z);
    root.add(d);
    leds.add(V(x, SECTOR_B.h - 0.06, z), 'CAMERAS|dome', [0.01, 0.01, 0.01]);
  }
  // nurse desk NIC anchors
  anchors['NURSE-STATION|eth0'] = { p: V(...PLACES['NURSE-STATION'].nic), out: [0, 0, -1] };
  anchors['VOIP-PHONE|eth0'] = { p: V(...PLACES['VOIP-PHONE'].nic), out: [0, 0, -1] };
  anchors['STAFF-LAPTOP|eth0'] = { p: V(...PLACES['STAFF-LAPTOP'].nic), out: [0, 0, -1] };
  return out;
}

export function buildDemarc(root, M, B, anchors) {
  const p = PLACES.DEMARC.pos;
  B.box(0.08, 0.5, 0.4, p[0], p[1], p[2], M.plasticLight);
  const lab = sign('ISP DEMARC', { w: 512, h: 128, font: '800 60px "Big Shoulders Display", sans-serif', fg: '#20262d', bg: '#ffa53b', sub: 'CIRCUIT DC-44817' }, 0.36, 0.09);
  lab.position.set(p[0] + 0.045, p[1] + 0.12, p[2]);
  lab.rotation.y = Math.PI / 2;
  root.add(lab);
  B.box(0.05, ROOM.h - p[1] - 0.25, 0.05, p[0], (ROOM.h + p[1] + 0.25) / 2, p[2] + 0.1, M.tray);
  anchors['DEMARC'] = { p: V(p[0] + 0.05, p[1] - 0.15, p[2]), out: [1, 0, 0] };
}

export function wallLabel(root, text, pos, rotY, w = 1.4) {
  const s = sign(text, { w: 1024, h: 140, font: '800 60px "Big Shoulders Display", sans-serif', fg: '#f0e6cf', bg: '#0b0f26' }, w, w * 0.137);
  s.position.copy(pos);
  s.rotation.y = rotY;
  root.add(s);
  return s;
}

export { labelTexture };
