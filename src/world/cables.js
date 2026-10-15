// Physical cables for every simulated link, plus the packet particle system that animates real traces.
import * as THREE from 'three';
import { toonMaterial } from './style.js';
import { routeBetween, PLACES } from './layout.js';
import { PATCH_PANEL } from '../content/district.js';

const OFFSITE = new Set(['ISP-PE', 'INTERNET', 'BACKUP', 'PORTAL', 'RESOLVER', 'SIP-GW']);
const CORD_COLORS = { 'P01-P04': 0x1f7bff, 'P07-P09': 0xffd23f, 'P08-P10': 0xffd23f };

function anchorFor(anchors, dev, port) {
  return anchors[`${dev}|${port}`] || null;
}

/** Spread a run inside the trays so bundles look like bundles (ends stay on their ports). */
function spread(pts, index) {
  const o = new THREE.Vector3(((index % 7) - 3) * 0.014, ((index % 3) - 1) * 0.008, (((index * 3) % 5) - 2) * 0.012);
  return pts.map((p, i) => (i > 2 && i < pts.length - 3 ? p.clone().add(o) : p.clone()));
}

function dedupe(pts) {
  const out = [pts[0]];
  for (const p of pts.slice(1)) if (p.distanceTo(out[out.length - 1]) > 0.01) out.push(p);
  return out;
}

// Invisible fat tube along a cable so the player can aim at it (the visible cable is a few mm thick).
const PICK_MAT = new THREE.MeshBasicMaterial({ visible: false });
function pickProxy(curve, info) {
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, Math.floor(curve.getLength() * 4)), 0.045, 4, false), PICK_MAT);
  m.userData.pick = info;
  return m;
}

export class Cables {
  constructor(parent, anchors, patchPorts) {
    this.group = new THREE.Group();
    this.group.name = 'cables';
    parent.add(this.group);
    this.anchors = anchors;
    this.patchPorts = patchPorts;
    this.links = new Map(); // id -> { curve, mesh, kind, length }
    this.signature = '';
    const D = PLACES.DEMARC.pos;
    this.skyCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(D[0] + 0.05, D[1] - 0.15, D[2]),
      new THREE.Vector3(-11.5, 3.6, -7.2),
      new THREE.Vector3(-9.5, 4.6, -10.5),
      new THREE.Vector3(-4, 14, -60),
      new THREE.Vector3(10, 40, -260),
    ], false, 'centripetal');
    this.skyLen = this.skyCurve.getLength();
    // Permanent cabling: every patch-panel port is wired, behind the panel, to the device on its label.
    // These runs always exist; a patch cord on the front is what joins two of them.
    this.proxies = [];
    this.runs = {};
    PATCH_PANEL.forEach((p, i) => {
      const A = anchorFor(anchors, p.dev, p.port);
      const PA = patchPorts[p.id];
      if (!A || !PA) return;
      const pts = dedupe(spread(routeBetween(A.p.toArray(), A.out, PA.toArray(), [1, 0, 0]), 20 + i));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      this.runs[p.id] = pts;
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(400, Math.max(24, Math.floor(curve.getLength() * 22))), 0.0035, 5, false), toonMaterial({ color: /CONSOLE/.test(p.label) ? 0x6fa6c8 : 0x5d6b78 }));
      this.group.add(mesh);
      const proxy = pickProxy(curve, { kind: 'run', panel: p.id, dev: p.dev, port: p.port, label: p.label });
      this.group.add(proxy);
      this.proxies.push(proxy);
    });
    this.linkProxies = [];
  }

  /** (Re)build cable meshes when the set of links changes. */
  sync(eng) {
    const st = eng.s;
    const ids = Object.keys(st.links).sort();
    const sig = ids.join(',') + '|' + ids.map(id => (st.links[id].cut ? 1 : 0)).join('');
    if (sig !== this.signature) {
      this.signature = sig;
      for (const [, l] of this.links) if (l.mesh) { this.group.remove(l.mesh); l.mesh.geometry.dispose(); }
      for (const m of this.linkProxies) { this.group.remove(m); m.geometry.dispose(); }
      this.linkProxies = [];
      this.links.clear();
      let idx = 0;
      for (const id of ids) {
        const link = st.links[id];
        const built = this.buildLink(link, idx++);
        if (!built) continue;
        this.links.set(id, built);
        if (built.mesh) {
          const proxy = pickProxy(built.drawn || built.curve, { kind: link.patch ? 'cord' : 'cable', link: id });
          this.group.add(proxy);
          this.linkProxies.push(proxy);
        }
      }
    }
    // appearance
    const storms = eng.storms();
    const stormLinks = new Set();
    for (const [, set] of storms) for (const id of set) stormLinks.add(id);
    for (const [id, l] of this.links) {
      if (!l.mesh) continue;
      const ls = eng.linkStatus(id);
      const m = l.mesh.material;
      l.storm = stormLinks.has(id);
      l.up = ls.up;
      l.mismatch = !!ls.mismatch;
      m.emissive.setHex(l.storm ? 0xff2244 : l.mismatch ? 0xffa020 : ls.up ? 0x000000 : 0x330008);
      m.emissiveIntensity = l.storm ? 1.6 : l.mismatch ? 0.7 : ls.up ? 0 : 0.6;
    }
  }

  buildLink(link, index) {
    const a = link.a;
    const b = link.b;
    const offA = OFFSITE.has(a.dev);
    const offB = OFFSITE.has(b.dev);
    if (offA && offB) return { kind: 'sky', curve: this.skyCurve, length: this.skyLen };
    if (link.media === 'wifi') {
      const pa = anchorFor(this.anchors, a.dev, a.port)?.p;
      const pb = anchorFor(this.anchors, b.dev, b.port)?.p;
      if (!pa || !pb) return null;
      const mid = pa.clone().lerp(pb, 0.5).add(new THREE.Vector3(0, 0.4, 0));
      const curve = new THREE.QuadraticBezierCurve3(pa.clone(), mid, pb.clone());
      return { kind: 'wifi', curve, length: curve.getLength() };
    }
    let pts;
    if (offA || offB) {
      const inside = offA ? b : a;
      const an = anchorFor(this.anchors, inside.dev, inside.port);
      const dm = this.anchors.DEMARC;
      if (!an || !dm) return null;
      pts = routeBetween(an.p.toArray(), an.out, dm.p.toArray(), dm.out);
      if (offA) pts.reverse();
    } else if (link.patch) {
      const [pa, pb] = link.label.split('↔');
      const ea = PATCH_PANEL.find(p => p.id === pa);
      const devA = ea && ea.dev === a.dev ? a : b;
      const devB = devA === a ? b : a;
      const panelA = devA === a ? pa : pb;
      const panelB = devA === a ? pb : pa;
      const A = anchorFor(this.anchors, devA.dev, devA.port);
      const B = anchorFor(this.anchors, devB.dev, devB.port);
      const PA = this.patchPorts[panelA];
      const PB = this.patchPorts[panelB];
      if (!A || !B || !PA || !PB || !this.runs[panelA] || !this.runs[panelB]) return null;
      // the permanent runs are drawn already: draw only the cord on the front, packets follow run + cord + run
      const cord = [PA.clone(), PA.clone().add(new THREE.Vector3(0.05, 0, 0)), PA.clone().lerp(PB, 0.5).add(new THREE.Vector3(0.16, -0.12, 0)), PB.clone().add(new THREE.Vector3(0.05, 0, 0)), PB.clone()];
      const drawn = new THREE.CatmullRomCurve3(cord, false, 'centripetal');
      let full = dedupe([...this.runs[panelA], ...cord.slice(1, -1), ...this.runs[panelB].slice().reverse()]);
      if (devA !== a) full = full.reverse();
      const curve = new THREE.CatmullRomCurve3(full, false, 'centripetal');
      const color = CORD_COLORS[link.label.replace('↔', '-')] ?? 0x2d8cff;
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(drawn, 48, 0.0042, 6, false), toonMaterial({ color, emissive: 0x000000 }));
      this.group.add(mesh);
      return { kind: 'cable', curve, length: curve.getLength(), mesh, drawn };
    } else {
      const A = anchorFor(this.anchors, a.dev, a.port);
      const B = anchorFor(this.anchors, b.dev, b.port);
      if (!A || !B) return null;
      pts = routeBetween(A.p.toArray(), A.out, B.p.toArray(), B.out);
    }
    const curve = new THREE.CatmullRomCurve3(dedupe(spread(pts, index)), false, 'centripetal');
    const length = curve.getLength();
    const color = link.id === 'wan' ? 0xff8a1e : 0x5d6b78;
    const mat = toonMaterial({ color, emissive: 0x000000 });
    const geo = new THREE.TubeGeometry(curve, Math.min(600, Math.max(24, Math.floor(length * 22))), 0.0035, 5, false);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    this.group.add(mesh);
    if (link.cut) {
      // show the cut: hide the middle of the run
      geo.setDrawRange(0, Math.floor(geo.index.count * 0.45));
    }
    return { kind: 'cable', curve, length, mesh };
  }

  /** Convert engine hop list ([{link, from, to}]) into curve segments for the packet system. */
  route(eng, hops) {
    const segs = [];
    let lastSky = false;
    for (const h of hops) {
      const l = this.links.get(h.link);
      const link = eng.s.links[h.link];
      if (!l || !link) continue;
      if (l.kind === 'sky') {
        if (lastSky) continue;
        lastSky = true;
        const outbound = !OFFSITE.has(h.from.dev) || h.to.dev === 'INTERNET' || ['ISP-PE'].includes(h.from.dev);
        segs.push({ curve: l.curve, length: l.length, rev: !outbound, sky: true });
        continue;
      }
      lastSky = false;
      const rev = !(link.a.dev === h.from.dev && link.a.port === h.from.port);
      segs.push({ curve: l.curve, length: l.length, rev, wifi: l.kind === 'wifi' });
    }
    return segs;
  }
}

// ------------------------------------------------------------------ packets

const VERT = `
attribute float size;
attribute vec3 pcolor;
attribute float alpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = pcolor;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.5, 0.0, d);
  float a = pow(core, 1.6) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * (1.0 + core * 2.5), a);
}`;

export class Packets {
  constructor(parent, max = 1200) {
    this.max = max;
    this.items = [];
    this.free = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    parent.add(this.points);
    this.geo = g;
  }

  /** Travel along segments. opts: { color, speed, size, dieAt: segment index or null, trail } */
  spawn(segs, opts = {}) {
    if (!segs.length) return;
    if (this.items.length > this.max / 5) return;
    this.items.push({ kind: 'travel', segs, seg: 0, u: 0, color: new THREE.Color(opts.color ?? 0x5ef1ff), speed: opts.speed ?? 6, size: opts.size ?? 0.05, dieAt: opts.dieAt ?? null, trail: opts.trail ?? 3, then: opts.then || null, burst: opts.burst ?? null });
  }

  burst(p, color = 0xff3d5a, n = 14) {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(0.4 + Math.random() * 0.8);
      this.items.push({ kind: 'spark', p: p.clone(), v, life: 0.7 + Math.random() * 0.4, age: 0, color: new THREE.Color(color), size: 0.035 });
    }
  }

  update(dt) {
    let n = 0;
    const put = (p, c, s, a) => {
      if (n >= this.max) return;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      this.col[n * 3] = c.r; this.col[n * 3 + 1] = c.g; this.col[n * 3 + 2] = c.b;
      this.size[n] = s;
      this.alpha[n] = a;
      n++;
    };
    const keep = [];
    const tmp = new THREE.Vector3();
    for (const it of this.items) {
      if (it.kind === 'spark') {
        it.age += dt;
        if (it.age >= it.life) continue;
        it.v.y -= 1.2 * dt;
        it.p.addScaledVector(it.v, dt);
        put(it.p, it.color, it.size, 1 - it.age / it.life);
        keep.push(it);
        continue;
      }
      const seg = it.segs[it.seg];
      const speed = seg.sky ? it.speed * 18 : it.speed;
      it.u += (speed * dt) / Math.max(0.05, seg.length);
      if (it.dieAt !== null && it.seg === it.dieAt && it.u >= 0.5) {
        seg.curve.getPointAt(seg.rev ? 0.5 : 0.5, tmp);
        this.burst(tmp, 0xff3d5a);
        continue;
      }
      if (it.u >= 1) {
        it.seg++;
        it.u = 0;
        if (it.seg >= it.segs.length) {
          if (it.then) it.then();
          continue;
        }
      }
      const s2 = it.segs[it.seg];
      for (let k = 0; k <= it.trail; k++) {
        const u = Math.max(0, Math.min(1, it.u - k * (0.06 / Math.max(0.3, s2.length))));
        s2.curve.getPointAt(s2.rev ? 1 - u : u, tmp);
        put(tmp, it.color, it.size * (1 - k * 0.18) * (s2.sky ? 3 : 1), 1 - k / (it.trail + 1));
      }
      keep.push(it);
    }
    this.items = keep;
    for (let i = n; i < this.max; i++) this.alpha[i] = 0;
    this.geo.setDrawRange(0, n);
    for (const k of ['position', 'pcolor', 'size', 'alpha']) this.geo.attributes[k].needsUpdate = true;
  }
}
