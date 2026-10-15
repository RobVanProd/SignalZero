// Holographic topology above the network table: the live logical network, coloured by state.
import * as THREE from 'three';
import { labelTexture } from './textures.js';

const CENTER = new THREE.Vector3(0, 0.9, 1.0);
const KIND_Y = { router: 0.95, switch: 0.68, bridge: 0.55, host: 0.38, fleet: 0.4 };

function shapeFor(kind) {
  if (kind === 'router') return new THREE.OctahedronGeometry(0.085, 0);
  if (kind === 'switch') return new THREE.BoxGeometry(0.14, 0.045, 0.09);
  if (kind === 'bridge') return new THREE.CylinderGeometry(0.055, 0.055, 0.03, 16);
  if (kind === 'fleet') return new THREE.IcosahedronGeometry(0.07, 0);
  return new THREE.SphereGeometry(0.05, 16, 10);
}

export class Holo {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.position.copy(CENTER);
    parent.add(this.group);
    this.sig = '';
    this.nodes = new Map();
    this.edges = new Map();
    this.t = 0;
    // scan disc
    const scanMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { t: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float t; varying vec2 vUv;
        void main(){ vec2 c = vUv - 0.5; float r = length(c)*2.0; if (r>1.0) discard;
          float a = atan(c.y, c.x); float sweep = mod(a - t*1.2, 6.2831853)/6.2831853;
          float ring = smoothstep(0.02,0.0,abs(fract(r*6.0 - t*0.2)-0.5)-0.47);
          float g = pow(1.0 - sweep, 18.0)*0.55 + ring*0.12 + smoothstep(1.0,0.96,r)*0.25;
          gl_FragColor = vec4(vec3(0.25,0.9,1.0)*g, g*0.8); }`,
    });
    this.scan = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64), scanMat);
    this.scan.rotation.x = -Math.PI / 2;
    this.scan.position.y = 0.002;
    this.group.add(this.scan);
    const vol = new THREE.Mesh(new THREE.CylinderGeometry(1.38, 1.4, 1.3, 64, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { t: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform float t; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 3.0) * 0.16 + smoothstep(0.02,0.0,abs(fract(vUv.y*14.0 - t*0.4)-0.5)-0.48)*0.05*(1.0-vUv.y); gl_FragColor = vec4(vec3(0.25,0.85,1.0)*a, a); }',
    }));
    vol.position.y = 0.65;
    this.group.add(vol);
    this.vol = vol;
    this.light = new THREE.PointLight(0x5cc8ff, 2.2, 6, 2);
    this.light.position.set(0, 1.2, 0);
    this.group.add(this.light);
  }

  place(d) {
    const x = ((d.map?.x ?? 400) - 400) / 400 * 1.15;
    const z = ((d.map?.y ?? 350) - 350) / 300 * 1.0;
    return new THREE.Vector3(x, KIND_Y[d.kind] ?? 0.3, z);
  }

  sync(eng) {
    const st = eng.s;
    const devs = Object.values(st.devices).filter(d => d.powered !== false);
    const sig = devs.map(d => d.id).join(',') + '|' + Object.keys(st.links).sort().join(',');
    if (sig !== this.sig) {
      this.sig = sig;
      for (const n of this.nodes.values()) this.group.remove(n.group);
      for (const e of this.edges.values()) this.group.remove(e.line);
      this.nodes.clear();
      this.edges.clear();
      for (const d of devs) {
        const g = new THREE.Group();
        g.position.copy(this.place(d));
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 2.6), toneMapped: false, transparent: true, opacity: 0.95 });
        const m = new THREE.Mesh(shapeFor(d.kind), mat);
        g.add(m);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, g.position.y, 4), new THREE.MeshBasicMaterial({ color: 0x1f6f80, transparent: true, opacity: 0.5 }));
        stem.position.y = -g.position.y / 2;
        g.add(stem);
        const lab = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(d.hostname, { w: 512, h: 96, font: 'bold 44px monospace', fg: '#bff6ff', bg: 'rgba(0,20,28,0.55)' }), transparent: true, depthWrite: false }));
        lab.scale.set(0.36, 0.068, 1);
        lab.position.y = 0.12;
        g.add(lab);
        this.group.add(g);
        this.nodes.set(d.id, { group: g, mesh: m, mat });
      }
      for (const l of Object.values(st.links)) {
        const a = this.nodes.get(l.a.dev);
        const b = this.nodes.get(l.b.dev);
        if (!a || !b) continue;
        const curve = new THREE.LineCurve3(a.group.position.clone(), b.group.position.clone());
        const geo = new THREE.TubeGeometry(curve, 1, 0.006, 5, false);
        const mat = new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
        const line = new THREE.Mesh(geo, mat);
        this.group.add(line);
        this.edges.set(l.id, { line, mat, a: a.group.position, b: b.group.position });
      }
    }
    const storms = eng.storms();
    const stormLinks = new Set();
    for (const [, s] of storms) for (const id of s) stormLinks.add(id);
    for (const [id, e] of this.edges) {
      const ls = eng.linkStatus(id);
      e.storm = stormLinks.has(id);
      e.mat.color.setHex(e.storm ? 0xff3d5a : ls.up ? (ls.mismatch ? 0xffa53b : 0x5cc8ff) : 0xff3d5a).multiplyScalar(ls.up ? 1.6 : 1.2);
      e.mat.opacity = ls.up ? 0.85 : 0.35;
    }
    // node health: red if any flow from this node fails
    const bad = new Set();
    for (const f of st.flows) if (!st.flowState[f.id]?.ok) bad.add(f.from);
    for (const [id, n] of this.nodes) {
      const isBad = bad.has(id);
      n.mat.color.copy(isBad ? new THREE.Color(3, 0.4, 0.6) : new THREE.Color(0.4, 2.2, 2.6));
    }
  }

  frame(dt) {
    this.t += dt;
    this.scan.material.uniforms.t.value = this.t;
    this.vol.material.uniforms.t.value = this.t;
    let i = 0;
    for (const n of this.nodes.values()) {
      n.mesh.rotation.y += dt * 0.8;
      n.group.position.y += Math.sin(this.t * 1.5 + i++) * 0.0003;
    }
    for (const e of this.edges.values()) if (e.storm) e.mat.opacity = 0.4 + 0.6 * Math.abs(Math.sin(this.t * 14));
  }
}
