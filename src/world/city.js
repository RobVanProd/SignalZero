// The city outside the window. Districts light up (or black out) with the services they depend on.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildingWindows, prng, radialGlow, labelTexture } from './textures.js';

const GROUND = -46;
export const DISTRICTS = {
  data: { x0: -520, x1: -200, color: 0x7fd8ff, label: 'Data' },
  clinic: { x0: -200, x1: -40, color: 0xffd9a8, label: 'Clinic' },
  ward: { x0: -40, x1: 60, color: 0xffe0b8, label: 'Ward' },
  public: { x0: 60, x1: 200, color: 0xb9f1ff, label: 'Public' },
  security: { x0: 200, x1: 340, color: 0xa8ffd8, label: 'Security' },
  voice: { x0: 340, x1: 560, color: 0xffc7a0, label: 'Voice' },
};

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { t: { value: 0 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vDir; uniform float t;
      void main(){
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 zen = vec3(0.004, 0.012, 0.03);
        vec3 mid = vec3(0.02, 0.06, 0.10);
        vec3 hor = vec3(0.10, 0.17, 0.22);
        vec3 glow = vec3(0.28, 0.16, 0.12);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.18, h));
        c = mix(c, zen, smoothstep(0.18, 0.75, h));
        c += glow * exp(-abs(h) * 22.0) * 0.55;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function boxUV(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // faces: +x,-x,+y,-y,+z,-z (4 verts each)
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 2 || f === 3) { uv.setXY(i, 0.001, 0.001); continue; }
      const across = f < 2 ? d : w;
      uv.setXY(i, uv.getX(i) * (across / 18), uv.getY(i) * (h / 26));
    }
  }
  return g;
}

export class City {
  constructor(scene, q) {
    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);
    this.t = 0;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), skyMaterial());
    sky.renderOrder = -10;
    this.group.add(sky);
    this.sky = sky;
    // stars
    const rnd = prng(77);
    const sp = [];
    for (let i = 0; i < 1600; i++) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(0.15 + rnd() * 0.85);
      sp.push(Math.sin(ph) * Math.cos(th) * 1300, Math.cos(ph) * 1300, Math.sin(ph) * Math.sin(th) * 1300);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.group.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xbfe6ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false, depthWrite: false })));
    // moon
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialGlow('210,235,255'), color: 0xffffff, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    moon.position.set(-420, 380, -1000);
    moon.scale.set(220, 220, 1);
    this.group.add(moon);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(22, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.7, 1.8), fog: false, toneMapped: false }));
    disc.position.copy(moon.position).add(new THREE.Vector3(0, 0, 5));
    disc.lookAt(0, 0, 0);
    this.group.add(disc);

    // ground with street grid
    const gc = document.createElement('canvas');
    gc.width = gc.height = 512;
    const gx = gc.getContext('2d');
    gx.fillStyle = '#020407';
    gx.fillRect(0, 0, 512, 512);
    gx.strokeStyle = 'rgba(255,190,120,0.55)';
    gx.lineWidth = 3;
    for (let i = 0; i <= 512; i += 64) { gx.beginPath(); gx.moveTo(i, 0); gx.lineTo(i, 512); gx.stroke(); gx.beginPath(); gx.moveTo(0, i); gx.lineTo(512, i); gx.stroke(); }
    const gt = new THREE.CanvasTexture(gc);
    gt.colorSpace = THREE.SRGBColorSpace;
    gt.wrapS = gt.wrapT = THREE.RepeatWrapping;
    gt.repeat.set(16, 16);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: 0x05080b, emissiveMap: gt, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, GROUND, -600);
    this.group.add(ground);

    // buildings per district
    const density = q.city ?? 1;
    const winTex = buildingWindows(5);
    winTex.wrapS = winTex.wrapT = THREE.RepeatWrapping;
    this.districts = {};
    const lists = {};
    const beacons = [];
    for (const k of Object.keys(DISTRICTS)) lists[k] = [];
    // Rings of blocks: low near the tower (we look down on them), taller and sparser with distance.
    const rings = [
      { z0: 55, z1: 190, hMin: 6, hMax: 30, cell: 26, p: 0.55 },
      { z0: 190, z1: 420, hMin: 20, hMax: 80, cell: 30, p: 0.5 },
      { z0: 420, z1: 900, hMin: 40, hMax: 170, cell: 42, p: 0.42 },
    ];
    for (const ring of rings) {
      for (let zz = ring.z0; zz < ring.z1; zz += ring.cell) {
        const halfWidth = zz * 1.15 + 80;
        for (let xx = -halfWidth; xx <= halfWidth; xx += ring.cell) {
          if (rnd() > ring.p * density) continue;
          const z = -zz - rnd() * ring.cell * 0.4;
          const x = xx + (rnd() - 0.5) * ring.cell * 0.4;
          if (Math.abs(x + 95) < 40 && Math.abs(z + 260) < 40) continue; // landmark plot
          const tall = rnd() < 0.1;
          const h = ring.hMin + Math.pow(rnd(), 1.6) * (ring.hMax - ring.hMin) * (tall ? 1.6 : 1);
          const w = ring.cell * (0.45 + rnd() * 0.4);
          const d = ring.cell * (0.45 + rnd() * 0.4);
          const key = Object.keys(DISTRICTS).find(n => x >= DISTRICTS[n].x0 * (zz / 400 + 0.6) && x < DISTRICTS[n].x1 * (zz / 400 + 0.6)) || (x < 0 ? 'data' : 'voice');
          const g = boxUV(w, h, d);
          g.translate(x, GROUND + h / 2, z);
          lists[key].push(g);
          if (h > 70 && rnd() < 0.6) beacons.push(new THREE.Vector3(x, GROUND + h + 1.5, z));
        }
      }
    }
    for (const [k, list] of Object.entries(lists)) {
      if (!list.length) continue;
      const mat = new THREE.MeshStandardMaterial({ color: 0x080d13, roughness: 0.85, metalness: 0.3, emissiveMap: winTex, emissive: new THREE.Color(DISTRICTS[k].color), emissiveIntensity: 0.15 });
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      this.group.add(mesh);
      this.districts[k] = { mesh, mat, level: 0.15, target: 0.15, state: 'unknown' };
    }
    // aviation beacons
    const bg = new THREE.BufferGeometry().setFromPoints(beacons);
    this.beacons = new THREE.Points(bg, new THREE.PointsMaterial({ color: new THREE.Color(3, 0.3, 0.3), size: 5, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false }));
    this.group.add(this.beacons);

    // landmark: the clinic tower with a cross sign facing the NOC
    const tower = new THREE.Mesh(boxUV(40, 150, 30), new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.7, metalness: 0.4, emissiveMap: winTex, emissive: 0xffe6c8, emissiveIntensity: 0.2 }));
    tower.position.set(-95, GROUND + 75, -260);
    this.group.add(tower);
    this.clinicTower = tower;
    const crossTex = labelTexture('✚  CITY CLINIC', { w: 1024, h: 256, font: 'bold 150px "Segoe UI", sans-serif', fg: '#ffffff', bg: null });
    this.cross = new THREE.Mesh(new THREE.PlaneGeometry(38, 9.5), new THREE.MeshBasicMaterial({ map: crossTex, color: new THREE.Color(0.2, 0.05, 0.05), transparent: true, toneMapped: false, fog: false }));
    this.cross.position.set(-95, GROUND + 142, -244.8);
    this.group.add(this.cross);

    // traffic: light streams on two avenues
    const cars = [];
    this.carData = [];
    for (let i = 0; i < 260; i++) {
      const lane = i % 4;
      const along = rnd();
      this.carData.push({ lane, along, speed: 0.02 + rnd() * 0.03, dir: lane < 2 ? 1 : -1 });
      cars.push(0, 0, 0);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cars, 3));
    const cc = new Float32Array(cars.length);
    for (let i = 0; i < this.carData.length; i++) {
      const red = this.carData[i].dir < 0;
      cc.set(red ? [3, 0.4, 0.3] : [3, 2.6, 1.8], i * 3);
    }
    cg.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    this.cars = new THREE.Points(cg, new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
    this.group.add(this.cars);

    this.fog = new THREE.FogExp2(0x0b1620, 0.0016);
    scene.fog = this.fog;
  }

  /** states: { districtKey: 'ok' | 'degraded' | 'down' | 'unknown' } */
  setDistricts(states) {
    for (const [k, d] of Object.entries(this.districts)) {
      const s = states[k] || 'unknown';
      d.state = s;
      d.target = s === 'ok' ? 1.55 : s === 'degraded' ? 0.75 : s === 'down' ? 0.06 : 0.22;
    }
    this.clinicOk = states.clinic === 'ok';
  }

  frame(dt) {
    this.t += dt;
    for (const d of Object.values(this.districts)) {
      d.level += (d.target - d.level) * Math.min(1, dt * 1.2);
      let v = d.level;
      if (d.state === 'degraded') v *= 0.75 + 0.25 * Math.sin(this.t * 7 + d.level);
      if (d.state === 'down') v *= 0.5 + 0.5 * (Math.sin(this.t * 23) > 0.6 ? 1 : 0.2);
      d.mat.emissiveIntensity = v;
    }
    const cross = this.cross.material.color;
    const target = this.clinicOk ? new THREE.Color(3.2, 0.25, 0.3) : new THREE.Color(0.25, 0.03, 0.04);
    cross.lerp(target, Math.min(1, dt * 2));
    this.clinicTower.material.emissiveIntensity = this.clinicOk ? 1.3 : 0.12;
    this.beacons.material.opacity = Math.sin(this.t * 3) > 0.2 ? 1 : 0.1;
    const pos = this.cars.geometry.attributes.position;
    this.carData.forEach((c, i) => {
      c.along = (c.along + c.speed * dt * c.dir + 1) % 1;
      const avenue = c.lane % 2 === 0;
      if (avenue) pos.setXYZ(i, -800 + c.along * 1600, GROUND + 0.5, -170 - (c.lane > 1 ? 4 : 0));
      else pos.setXYZ(i, 52 + (c.lane > 1 ? 4 : 0), GROUND + 0.5, -60 - c.along * 900);
    });
    pos.needsUpdate = true;
  }
}
