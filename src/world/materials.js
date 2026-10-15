// Shared materials and a static-geometry batcher (merges meshes by material to cut draw calls).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { floorTextures, perforatedTexture, wallTexture, ceilingTexture, brushedMetal } from './textures.js';

export const COLORS = {
  cyan: 0x5cc8ff,
  teal: 0x2de0b5,
  green: 0x3dffb4,
  amber: 0xffa53b,
  red: 0xff3d5a,
  white: 0xe8f6ff,
  violet: 0x8a7dff,
};

let cache = null;

export function materials() {
  if (cache) return cache;
  const floor = floorTextures();
  floor.map.repeat.set(10, 7.5);
  floor.rough.repeat.set(10, 7.5);
  const wallMap = wallTexture();
  wallMap.repeat.set(1, 1);
  const ceil = ceilingTexture();
  ceil.repeat.set(1, 1);
  const brushed = brushedMetal(3);
  const perf = perforatedTexture();
  perf.repeat.set(2, 8);
  const std = (o) => new THREE.MeshStandardMaterial(o);
  cache = {
    floor: std({ map: floor.map, roughnessMap: floor.rough, roughness: 0.72, metalness: 0.18, color: 0xffffff, envMapIntensity: 0.8 }),
    floorB: std({ map: floor.map, roughnessMap: floor.rough, roughness: 0.6, metalness: 0.3, color: 0xd9e4ea }),
    perforated: std({ map: perf, roughness: 0.55, metalness: 0.5 }),
    wall: std({ map: wallMap, roughness: 0.92, metalness: 0.05 }),
    wallDark: std({ color: 0x0b1117, roughness: 0.95, metalness: 0.05 }),
    ceiling: std({ map: ceil, roughness: 0.95, metalness: 0.0 }),
    trim: std({ color: 0x1b232c, roughness: 0.45, metalness: 0.7 }),
    frame: std({ color: 0x151b22, roughness: 0.38, metalness: 0.85, map: brushed }),
    rackSide: std({ color: 0x0e1318, roughness: 0.5, metalness: 0.75 }),
    rackInner: std({ color: 0x07090c, roughness: 0.8, metalness: 0.3 }),
    device: std({ color: 0x1d232a, roughness: 0.42, metalness: 0.75 }),
    blank: std({ color: 0x0c0f13, roughness: 0.6, metalness: 0.5 }),
    desk: std({ color: 0x1a2028, roughness: 0.35, metalness: 0.25 }),
    wood: std({ color: 0x4a2f1f, roughness: 0.55, metalness: 0.05 }),
    deskTop: std({ color: 0x232b34, roughness: 0.28, metalness: 0.15 }),
    plastic: std({ color: 0x14181d, roughness: 0.55, metalness: 0.1 }),
    plasticLight: std({ color: 0xd9dee3, roughness: 0.5, metalness: 0.05 }),
    fabric: std({ color: 0x1a2733, roughness: 0.95, metalness: 0.0 }),
    rubber: std({ color: 0x08090b, roughness: 0.9, metalness: 0.0 }),
    chrome: std({ color: 0x9aa7b3, roughness: 0.18, metalness: 1.0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, roughness: 0.04, metalness: 0.0, transmission: 0, transparent: true, opacity: 0.12, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false }),
    glassFrost: new THREE.MeshStandardMaterial({ color: 0xbfe9ff, roughness: 0.35, metalness: 0.0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    tray: std({ color: 0x3a4652, roughness: 0.4, metalness: 0.85 }),
    cableJacket: std({ color: 0x25313b, roughness: 0.6, metalness: 0.1 }),
    plant: std({ color: 0x1f5a3f, roughness: 0.8, metalness: 0.0 }),
    planter: std({ color: 0x20262d, roughness: 0.4, metalness: 0.6 }),
    lightPanel: new THREE.MeshStandardMaterial({ color: 0x0b0f12, emissive: 0xf0e6cf, emissiveIntensity: 0.6, roughness: 1 }),
    lightWarm: new THREE.MeshStandardMaterial({ color: 0x0b0f12, emissive: 0xffc98a, emissiveIntensity: 0.62, roughness: 1 }),
    stripCyan: new THREE.MeshStandardMaterial({ color: 0x041014, emissive: 0xf0e6cf, emissiveIntensity: 0.45, roughness: 1 }),
    stripTeal: new THREE.MeshStandardMaterial({ color: 0x041014, emissive: 0xf0e6cf, emissiveIntensity: 0.4, roughness: 1 }),
    stripAmber: new THREE.MeshStandardMaterial({ color: 0x140b02, emissive: 0xffa53b, emissiveIntensity: 0.55, roughness: 1 }),
    stripRed: new THREE.MeshStandardMaterial({ color: 0x140205, emissive: COLORS.red, emissiveIntensity: 3.0, roughness: 1 }),
    black: new THREE.MeshBasicMaterial({ color: 0x000000 }),
  };
  return cache;
}

/** Collects static meshes and merges them per material. */
export class Batcher {
  constructor() { this.groups = new Map(); }

  add(geometry, material, matrix) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!this.groups.has(material)) this.groups.set(material, []);
    this.groups.get(material).push(g);
  }

  box(w, h, d, x, y, z, material, rotY = 0, uvScale = null) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (uvScale) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale[0], uv.getY(i) * uvScale[1]);
    }
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(1, 1, 1));
    this.add(g, material, m);
  }

  mesh(object) {
    object.updateMatrixWorld(true);
    this.add(object.geometry, object.material, object.matrixWorld);
  }

  build(parent, { shadows = false } = {}) {
    for (const [mat, list] of this.groups) {
      const merged = mergeGeometries(list, false);
      const m = new THREE.Mesh(merged, mat);
      m.receiveShadow = shadows;
      m.castShadow = false;
      m.matrixAutoUpdate = false;
      parent.add(m);
    }
    this.groups.clear();
  }
}
