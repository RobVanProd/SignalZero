// Architecture: NOC floor, window wall, lobby, Sector B corridor and room, ceiling fixtures, cable trays.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Batcher } from './materials.js';
import { ROOM, CORRIDOR, SECTOR_B, LOBBY, DOOR_B, TRAY_SEGMENTS, RACK, RACKS } from './layout.js';
import { labelTexture } from './textures.js';

export function sign(text, opts, w, h) {
  const t = labelTexture(text, opts);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, color: new THREE.Color(0.6, 0.6, 0.6) }));
  return m;
}

export function buildRoom(scene, M, q) {
  const root = new THREE.Group();
  root.name = 'room';
  scene.add(root);
  const B = new Batcher();
  const colliders = [];
  const wall = (x0, z0, x1, z1, h, mat = M.wall, y0 = 0) => {
    const w = Math.abs(x1 - x0) || 0.2;
    const d = Math.abs(z1 - z0) || 0.2;
    B.box(w, h, d, (x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2, mat, 0, [w / 4, h / 4]);
    colliders.push({ x0: Math.min(x0, x1) - 0.1, x1: Math.max(x0, x1) + 0.1, z0: Math.min(z0, z1) - 0.1, z1: Math.max(z0, z1) + 0.1 });
  };

  // ---------------- floors
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.x1 - ROOM.x0, ROOM.z1 - ROOM.z0), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);
  const perf = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 4.8), M.perforated);
  perf.rotation.x = -Math.PI / 2;
  perf.position.set(-7.05, 0.004, -4.0);
  perf.receiveShadow = true;
  root.add(perf);
  for (const [x0, x1, z0, z1, mat] of [[CORRIDOR.x0, CORRIDOR.x1, CORRIDOR.z0, CORRIDOR.z1, M.floorB], [SECTOR_B.x0, SECTOR_B.x1, SECTOR_B.z0, SECTOR_B.z1, M.floorB]]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat);
    f.rotation.x = -Math.PI / 2;
    f.position.set((x0 + x1) / 2, 0.001, (z0 + z1) / 2);
    f.receiveShadow = true;
    root.add(f);
  }

  // ---------------- ceilings
  const ceil = (x0, x1, z0, z1, y) => B.box(x1 - x0, 0.1, z1 - z0, (x0 + x1) / 2, y + 0.05, (z0 + z1) / 2, M.ceiling, 0, [(x1 - x0) / 1.2, (z1 - z0) / 1.2]);
  ceil(ROOM.x0, ROOM.x1, ROOM.z0, ROOM.z1, ROOM.h);
  ceil(CORRIDOR.x0, CORRIDOR.x1, CORRIDOR.z0, CORRIDOR.z1, CORRIDOR.h);
  ceil(SECTOR_B.x0, SECTOR_B.x1, SECTOR_B.z0, SECTOR_B.z1, SECTOR_B.h);

  // ---------------- main room walls
  wall(ROOM.x0, ROOM.z0, ROOM.x0, ROOM.z1, ROOM.h); // west
  wall(ROOM.x0, ROOM.z1, ROOM.x1, ROOM.z1, ROOM.h); // south
  // east wall with Sector B door gap
  wall(ROOM.x1, DOOR_B.z1, ROOM.x1, ROOM.z1, ROOM.h);
  wall(ROOM.x1, ROOM.z0, ROOM.x1, DOOR_B.z0, ROOM.h);
  B.box(0.2, ROOM.h - 2.7, DOOR_B.z1 - DOOR_B.z0, ROOM.x1, 2.7 + (ROOM.h - 2.7) / 2, (DOOR_B.z0 + DOOR_B.z1) / 2, M.wall);
  // north window wall: sill, header, mullions, glass
  B.box(ROOM.x1 - ROOM.x0, 0.45, 0.3, 0, 0.225, ROOM.z0, M.trim);
  B.box(ROOM.x1 - ROOM.x0, 0.35, 0.3, 0, ROOM.h - 0.175, ROOM.z0, M.trim);
  colliders.push({ x0: ROOM.x0, x1: ROOM.x1, z0: ROOM.z0 - 0.3, z1: ROOM.z0 + 0.25 });
  for (let x = ROOM.x0; x <= ROOM.x1 + 0.01; x += 2.4) B.box(0.09, ROOM.h, 0.16, x, ROOM.h / 2, ROOM.z0 + 0.02, M.frame);
  B.box(ROOM.x1 - ROOM.x0, 0.06, 0.12, 0, 2.45, ROOM.z0 + 0.03, M.frame);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.x1 - ROOM.x0, ROOM.h - 0.8), M.glass);
  glass.position.set(0, 0.45 + (ROOM.h - 0.8) / 2, ROOM.z0 + 0.02);
  glass.renderOrder = 5;
  root.add(glass);

  // baseboard light strips
  B.box(ROOM.x1 - ROOM.x0 - 0.2, 0.025, 0.02, 0, 0.08, ROOM.z1 - 0.11, M.stripCyan);
  B.box(0.02, 0.025, ROOM.z1 - ROOM.z0 - 0.2, ROOM.x0 + 0.11, 0.08, 0, M.stripCyan);
  B.box(ROOM.x1 - ROOM.x0 - 0.4, 0.02, 0.02, 0, 0.47, ROOM.z0 + 0.17, M.stripCyan);
  // wall pilasters
  for (const z of [-6.5, -2.0, 2.5, 7.0]) B.box(0.35, ROOM.h, 0.5, ROOM.x0 + 0.17, ROOM.h / 2, z, M.trim);
  for (const x of [-8, -3, 2]) B.box(0.5, ROOM.h, 0.35, x, ROOM.h / 2, ROOM.z1 - 0.17, M.trim);

  // ---------------- lobby partition (glass) with door gap
  const lobbyGlass = (x0, x1) => {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, 3.2), M.glass);
    g.position.set((x0 + x1) / 2, 1.6, LOBBY.z0);
    g.renderOrder = 5;
    root.add(g);
    const frost = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, 0.35), M.glassFrost);
    frost.position.set((x0 + x1) / 2, 1.25, LOBBY.z0 + 0.005);
    root.add(frost);
    B.box(x1 - x0, 0.06, 0.08, (x0 + x1) / 2, 3.2, LOBBY.z0, M.frame);
    B.box(x1 - x0, 0.06, 0.08, (x0 + x1) / 2, 0.03, LOBBY.z0, M.frame);
    colliders.push({ x0, x1, z0: LOBBY.z0 - 0.12, z1: LOBBY.z0 + 0.12 });
  };
  lobbyGlass(LOBBY.x0, LOBBY.doorX0);
  lobbyGlass(LOBBY.doorX1, LOBBY.x1);
  for (const x of [LOBBY.x0, LOBBY.doorX0, LOBBY.doorX1, LOBBY.x1 - 0.04]) B.box(0.07, 3.2, 0.1, x, 1.6, LOBBY.z0, M.frame);
  B.box(LOBBY.x1 - LOBBY.x0, ROOM.h - 3.2, 0.12, (LOBBY.x0 + LOBBY.x1) / 2, 3.2 + (ROOM.h - 3.2) / 2, LOBBY.z0, M.wallDark);
  B.box(0.12, 3.2, ROOM.z1 - LOBBY.z0, LOBBY.x0, 1.6, (LOBBY.z0 + ROOM.z1) / 2, M.wallDark);
  colliders.push({ x0: LOBBY.x0 - 0.12, x1: LOBBY.x0 + 0.12, z0: LOBBY.z0, z1: ROOM.z1 });
  const lobbySign = sign('GUEST LOBBY', { w: 1024, h: 128, font: '800 58px "Big Shoulders Display", sans-serif', fg: '#f0e6cf', bg: null }, 2.4, 0.3);
  lobbySign.position.set(8.4, 3.55, LOBBY.z0 - 0.07);
  lobbySign.rotation.y = Math.PI;
  root.add(lobbySign);
  const lobbySign2 = lobbySign.clone();
  lobbySign2.position.set(8.4, 3.55, LOBBY.z0 + 0.07);
  lobbySign2.rotation.y = 0;
  root.add(lobbySign2);

  // ---------------- corridor and Sector B
  wall(CORRIDOR.x0, CORRIDOR.z0, CORRIDOR.x1, CORRIDOR.z0, CORRIDOR.h, M.wall);
  wall(CORRIDOR.x0, CORRIDOR.z1, CORRIDOR.x1, CORRIDOR.z1, CORRIDOR.h, M.wall);
  for (let x = CORRIDOR.x0 + 0.8; x < CORRIDOR.x1; x += 1.4) {
    B.box(0.9, 0.03, 0.18, x, CORRIDOR.h - 0.02, (CORRIDOR.z0 + CORRIDOR.z1) / 2, M.lightPanel);
    B.box(0.04, 0.02, CORRIDOR.z1 - CORRIDOR.z0 - 0.2, x, 0.01, (CORRIDOR.z0 + CORRIDOR.z1) / 2, M.stripTeal);
  }
  const S = SECTOR_B;
  wall(S.x0, S.z0, S.x1, S.z0, S.h);
  wall(S.x0, S.z1, S.x1, S.z1, S.h);
  wall(S.x1, S.z0, S.x1, S.z1, S.h);
  wall(S.x0, S.z0, S.x0, CORRIDOR.z0, S.h);
  wall(S.x0, CORRIDOR.z1, S.x0, S.z1, S.h);
  B.box(0.2, S.h - CORRIDOR.h, CORRIDOR.z1 - CORRIDOR.z0, S.x0, CORRIDOR.h + (S.h - CORRIDOR.h) / 2, (CORRIDOR.z0 + CORRIDOR.z1) / 2, M.wall);
  for (let x = S.x0 + 1.5; x < S.x1 - 0.5; x += 2.5) for (let z = S.z0 + 1.5; z < S.z1 - 0.5; z += 3) B.box(1.2, 0.03, 0.3, x, S.h - 0.02, z, M.lightPanel);
  B.box(S.x1 - S.x0 - 0.4, 0.025, 0.02, (S.x0 + S.x1) / 2, 0.08, S.z1 - 0.11, M.stripTeal);
  const secSign = sign('SECTOR B · WARD & SECURITY', { w: 1536, h: 160, font: '800 64px "Big Shoulders Display", sans-serif', fg: '#f0e6cf', bg: '#0b0f26', border: '#ffa53b' }, 2.6, 0.27);
  secSign.position.set(ROOM.x1 - 0.12, 3.1, (DOOR_B.z0 + DOOR_B.z1) / 2);
  secSign.rotation.y = -Math.PI / 2;
  root.add(secSign);

  // Sector B sliding door (animated)
  const door = new THREE.Group();
  const leaf = new THREE.Mesh(new RoundedBoxGeometry(0.08, 2.6, DOOR_B.z1 - DOOR_B.z0, 2, 0.02), M.trim);
  leaf.position.y = 1.3;
  door.add(leaf);
  const doorWin = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.9, 0.5), M.glassFrost);
  doorWin.position.set(0, 1.7, 0);
  door.add(doorWin);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 1.2), M.stripRed.clone());
  lamp.position.set(0, 2.62, 0);
  door.add(lamp);
  door.position.set(ROOM.x1 - 0.02, 0, (DOOR_B.z0 + DOOR_B.z1) / 2);
  root.add(door);

  // ---------------- ceiling fixtures (main)
  for (let x = -9; x <= 9; x += 3.6) {
    for (let z = -6.5; z <= 7; z += 3.4) {
      if (x > LOBBY.x0 && z > LOBBY.z0) continue;
      B.box(1.6, 0.04, 0.22, x, ROOM.h - 0.03, z, M.lightPanel);
      B.box(1.7, 0.05, 0.3, x, ROOM.h - 0.01, z, M.trim);
    }
  }
  for (let x = 6; x <= 11; x += 2.5) B.box(0.9, 0.04, 0.9, x, ROOM.h - 0.03, 6.8, M.lightWarm);
  // accent ring over the holo table
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.03, 8, 96), M.stripCyan);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, ROOM.h - 0.08, 1.0);
  B.mesh(ring);

  // ---------------- cable trays
  const trayRung = new THREE.BoxGeometry(0.4, 0.02, 0.03);
  for (const [a, b] of TRAY_SEGMENTS) {
    const A = new THREE.Vector3(...a);
    const Bv = new THREE.Vector3(...b);
    const len = A.distanceTo(Bv);
    const dir = Bv.clone().sub(A).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const mid = A.clone().lerp(Bv, 0.5);
    for (const side of [-0.2, 0.2]) {
      const off = new THREE.Vector3(Math.cos(yaw) * side, 0, -Math.sin(yaw) * side);
      B.box(0.025, 0.07, len, mid.x + off.x, mid.y, mid.z + off.z, M.tray, yaw);
    }
    const n = Math.max(2, Math.floor(len / 0.3));
    for (let i = 0; i <= n; i++) {
      const p = A.clone().lerp(Bv, i / n);
      const m = new THREE.Matrix4().compose(p.setY(p.y - 0.03), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw + Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1));
      B.add(trayRung, M.tray, m);
    }
    // hangers
    for (let i = 0; i <= Math.floor(len / 1.8); i++) {
      const p = A.clone().lerp(Bv, i / Math.max(1, Math.floor(len / 1.8)));
      const top = p.y > 3 ? ROOM.h : p.y > 2.8 ? SECTOR_B.h : CORRIDOR.h;
      if (top - p.y > 0.05) B.box(0.012, top - p.y, 0.012, p.x, (top + p.y) / 2, p.z, M.tray);
    }
  }

  // ---------------- rack row signage plinth
  B.box(0.2, 0.08, RACKS.length * RACK.w + 0.2, RACK.x - RACK.d / 2 - 0.1, 0.04, -4.0, M.trim);

  // ---------------- big wall sign
  const title = sign('NETWORK OPERATIONS', { w: 2048, h: 220, font: '200 120px "Segoe UI", sans-serif', fg: '#f0e6cf', bg: null }, 5.5, 0.6);
  title.position.set(-2.5, 3.2, ROOM.z1 - 0.13);
  title.rotation.y = Math.PI;
  root.add(title);
  const sub = sign('CITY OF HALDEN · DISTRICT 04 · NIGHT SHIFT', { w: 2048, h: 120, font: '800 54px "Big Shoulders Display", sans-serif', fg: '#5ee9ff', bg: null }, 5.5, 0.32);
  sub.position.set(-2.5, 2.72, ROOM.z1 - 0.13);
  sub.rotation.y = Math.PI;
  root.add(sub);

  B.build(root, { shadows: q.shadows });
  return { root, door, doorLamp: lamp, colliders, glass };
}
