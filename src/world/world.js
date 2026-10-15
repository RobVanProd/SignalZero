// Assembles the 3D operations centre and keeps it in sync with the network engine.
import * as THREE from 'three';
import { createRenderer, setupPost, resize, render, QUALITY } from './renderer.js';
import { toonify, INK } from './style.js';
import { materials, Batcher } from './materials.js';
import { buildRoom } from './room.js';
import { buildRacks, buildDesk, buildHoloBase, buildVideoWall, buildLobby, buildSectorB, buildDemarc, LedBank, wallLabel } from './props.js';
import { Cables, Packets } from './cables.js';
import { Holo } from './holo.js';
import { City, DISTRICTS } from './city.js';
import { Controls } from './controls.js';
import { drawTerminal, drawDashboard, drawCctv, drawKiosk, drawPhone, SCR } from './screens.js';
import { PLACES, STATIONS, RACK, ROOM, DOOR_B, SECTOR_B, CORRIDOR, LOBBY } from './layout.js';
import { PATCH_PANEL } from '../content/district.js';
import { stpRecord, carries } from '../engine/switching.js';
import { fmtIp } from '../engine/ipv4.js';
import { wallClock } from '../engine/engine.js';
import { hostAddr } from '../engine/routing.js';

// LED inks (HDR so they clear the signal threshold): phosphor = healthy, sodium = attention, fault, data = traffic
const ink = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
const C = {
  off: new THREE.Color(0, 0, 0),
  green: ink(INK.phosphor, 1.7),
  amber: ink(INK.sodium, 1.8),
  red: ink(INK.fault, 2.0),
  blue: ink(INK.data, 1.9),
  white: ink(INK.paper, 1.8),
};

export class World {
  constructor(container, qName) {
    this.ctx = createRenderer(container, qName);
    this.q = this.ctx.q;
    const renderer = this.ctx.renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(INK.night);
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 3000);
    this.scene.add(this.camera);
    this.t = 0;
    this.alarm = 0;
    const M = (this.M = materials());
    const root = (this.root = new THREE.Group());
    this.scene.add(root);

    const room = (this.room = buildRoom(this.scene, M, this.q));
    const B = new Batcher();
    const leds = (this.leds = new LedBank());
    const hits = (this.hits = []);
    const racks = buildRacks(root, M, B, leds, hits);
    this.anchors = racks.anchors;
    this.patchPorts = racks.patchPorts;
    this.kvm = racks.kvm;
    const dd = buildDesk(root, M, B, PLACES['DISPATCH-01'].desk, { monitors: 3, lamp: true, width: 2.6 });
    this.dispatchScreens = dd.screens;
    hits.push(this.hitbox(2.4, 0.9, 0.9, new THREE.Vector3(0, 1.0, -5.05), 'DISPATCH-01'));
    this.anchors['DISPATCH-01|eth0'] = { p: new THREE.Vector3(...PLACES['DISPATCH-01'].nic), out: [0, 0, -1] };
    buildHoloBase(root, M);
    hits.push(this.hitbox(2.8, 1.2, 2.8, new THREE.Vector3(0, 0.9, 1.0), 'HOLO'));
    const vw = buildVideoWall(root, M, B);
    this.wallScreens = vw.screens;
    this.supScreens = vw.deskScreens;
    hits.push(this.hitbox(0.6, 2.4, 6, new THREE.Vector3(ROOM.x1 - 0.5, 2.4, 0), 'WALL'));
    const lobby = buildLobby(root, M, B, leds, hits, this.anchors);
    this.kioskScreen = lobby.kioskScreen;
    this.rogue = lobby.rogue;
    const sb = buildSectorB(root, M, B, leds, hits, this.anchors);
    this.sb = sb;
    buildDemarc(root, M, B, this.anchors);
    wallLabel(root, 'LOBBY JACKS L-09 / L-10', new THREE.Vector3(11.88, 0.75, 6.6), -Math.PI / 2, 0.9);
    B.build(root, { shadows: this.q.shadows });
    leds.build(root);

    this.city = new City(this.scene, this.q);
    this.cables = new Cables(this.scene, this.anchors, this.patchPorts);
    this.packets = new Packets(this.scene, this.q.particles);
    this.holo = new Holo(this.scene);
    this.lights();
    this.dust();
    this.rain();

    this.controls = new Controls(this.camera, renderer.domElement);
    this.controls.colliders = [
      ...room.colliders,
      { x0: RACK.x - 0.6, x1: RACK.frontX + 0.1, z0: -6.45, z1: -1.55 },
      { x0: -1.4, x1: 1.4, z0: -5.55, z1: -4.55 },
      { circle: true, x: 0, z: 1.0, r: 1.65 },
      { x0: 8.9, x1: 10.4, z0: -1.1, z1: 1.1 },
      { x0: 8.85, x1: 9.55, z0: 7.3, z1: 7.95 },
      { x0: 11.1, x1: 12, z0: 5.3, z1: 7.9 },
      { x0: 20.4, x1: 21.6, z0: -11, z1: -10.5 },
      { x0: 22.3, x1: 24.7, z0: -9.5, z1: -8.55 },
      { x0: 26.25, x1: 27.75, z0: -3.65, z1: -2.75 },
      { x0: SECTOR_B.x1 - 0.5, x1: SECTOR_B.x1, z0: -8.6, z1: -4.4 },
      // outer bounds of corridor openings
      { x0: ROOM.x1 + 0.05, x1: CORRIDOR.x1, z0: CORRIDOR.z1 + 0.05, z1: CORRIDOR.z1 + 0.4 },
      { x0: ROOM.x1 + 0.05, x1: CORRIDOR.x1, z0: CORRIDOR.z0 - 0.4, z1: CORRIDOR.z0 - 0.05 },
    ];
    this.doorBlock = { active: true, x0: ROOM.x1 - 0.15, x1: ROOM.x1 + 0.2, z0: DOOR_B.z0, z1: DOOR_B.z1 };
    this.controls.dynamic = [this.doorBlock];
    this.doorOpen = 0;
    this.doorUnlocked = false;

    this.toonCache = toonify(this.scene);
    setupPost(this.ctx, this.scene, this.camera);
    addEventListener('resize', () => resize(this.ctx, this.camera));
    this.raycaster = new THREE.Raycaster();
    this.flowTimers = {};
    this.ledState = new Map();
    this.consoles = {};
    this.stormLinks = new Set();
  }

  hitbox(w, h, d, pos, station) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.copy(pos);
    m.userData.station = station;
    this.root.add(m);
    return m;
  }

  lights() {
    const s = this.scene;
    const tier0 = this.q.name;
    s.add(new THREE.HemisphereLight(0x8fa8e0, 0x2a3060, tier0 === 'low' ? 1.6 : 1.3));
    // wall washers: soft gradients so walls read as surfaces, not voids (each light costs per-pixel work,
    // so lower tiers get fewer)
    const tier = tier0;
    const washers = tier === 'high' ? 8 : tier === 'medium' ? 4 : 0;
    for (const [x, y, z, tx, tz, col] of [[-10.5, 0.2, 3, -12, 3, 0x2a9fd0], [-10.5, 0.2, -8, -12, -8, 0x2a9fd0], [-4, 0.2, 8.2, -4, 9, 0x6fc7ff], [8, 0.2, 8.2, 8, 9, 0xffb07a], [11.2, 0.2, 6.5, 12, 6.5, 0xffb07a], [24, 0.2, -10.2, 24, -11, 0x39d0c0], [28.2, 0.2, -2, 29, -2, 0x39d0c0], [15.5, 0.2, -6.5, 15.5, -7.4, 0x39d0c0]].slice(0, washers)) {
      const w = new THREE.SpotLight(col, 14, 6, 0.9, 1, 1.5);
      w.position.set(x, y, z);
      w.target.position.set(tx, 2.6, tz);
      s.add(w, w.target);
    }
    const moon = new THREE.DirectionalLight(0x8fb8ff, 0.9);
    moon.position.set(-14, 22, -40);
    moon.target.position.set(0, 0, 0);
    if (this.q.shadows) {
      moon.castShadow = true;
      moon.shadow.mapSize.set(2048, 2048);
      Object.assign(moon.shadow.camera, { left: -16, right: 16, top: 14, bottom: -14, near: 1, far: 90 });
      moon.shadow.bias = -0.0004;
      moon.shadow.normalBias = 0.02;
    }
    s.add(moon, moon.target);
    const ceilingPts = [[-5.4, -5], [0, -5.6], [5.4, -4.8], [-5.4, 1.8], [5.4, 1.8], [0, 6.2], [-5.4, 6.4]];
    for (const [x, z] of tier === 'low' ? ceilingPts.filter((_, i) => i % 2 === 0) : ceilingPts) {
      const p = new THREE.PointLight(0xd8f0ff, 5, 9.5, 1.7);
      p.position.set(x, ROOM.h - 0.25, z);
      s.add(p);
    }
    const rackSpot = new THREE.SpotLight(0xe6f6ff, 70, 14, 0.62, 0.75, 1.4);
    rackSpot.position.set(-4.6, ROOM.h - 0.1, -4.0);
    rackSpot.target.position.set(-7.8, 1.0, -4.0);
    if (this.q.shadows) { rackSpot.castShadow = true; rackSpot.shadow.mapSize.set(1024, 1024); rackSpot.shadow.bias = -0.0005; }
    s.add(rackSpot, rackSpot.target);
    const deskSpot = new THREE.SpotLight(0xffdcb0, 26, 9, 0.7, 0.8, 1.4);
    deskSpot.position.set(0, ROOM.h - 0.1, -3.2);
    deskSpot.target.position.set(0, 0.7, -5);
    s.add(deskSpot, deskSpot.target);
    const wallGlow = new THREE.PointLight(0x3ab8e6, 6, 8, 1.6);
    wallGlow.position.set(10.6, 2.4, 0);
    s.add(wallGlow);
    for (const [x, z] of [[6.5, 6.8], [10, 6.8]]) { const p = new THREE.PointLight(0xffd7a8, 10, 8, 1.5); p.position.set(x, ROOM.h - 0.3, z); s.add(p); }
    for (const [x, z] of (tier === 'low' ? [[23, -6], [15.5, -6.5]] : [[21, -9], [25, -9], [21, -3], [26, -3], [15.5, -6.5]])) { const p = new THREE.PointLight(0xd8f0ff, tier === 'low' ? 16 : 10, tier === 'low' ? 12 : 9, 1.5); p.position.set(x, SECTOR_B.h - 0.25, z); s.add(p); }
    this.alarms = [];
    for (const [x, z] of [[-11.4, 8.4], [11.4, -8.4]]) {
      const a = new THREE.SpotLight(0xff2a3a, 0, 18, 0.35, 0.5, 1.2);
      a.position.set(x, ROOM.h - 0.2, z);
      const tgt = new THREE.Object3D();
      s.add(tgt);
      a.target = tgt;
      s.add(a);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.02, 0.02), toneMapped: false }));
      bulb.position.copy(a.position);
      s.add(bulb);
      this.alarms.push({ light: a, tgt, bulb, x, z });
    }
  }

  dust() {
    const n = 500;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = -11 + Math.random() * 22; p[i * 3 + 1] = 0.2 + Math.random() * 3.8; p[i * 3 + 2] = -8.5 + Math.random() * 17; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.dustPts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fdcff, size: 0.012, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.dustPts);
  }

  rain() {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { t: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float t; varying vec2 vUv;
        float h(float n){ return fract(sin(n*12.9898)*43758.5453); }
        void main(){
          float a = 0.0;
          for (int k=0;k<2;k++){
            float sc = k==0 ? 140.0 : 70.0;
            vec2 g = vec2(vUv.x*sc, vUv.y*(k==0?6.0:3.0) + t*(k==0?1.6:0.7));
            float col = floor(g.x); float r = h(col + float(k)*17.0);
            float y = fract(g.y + r*7.0);
            float streak = smoothstep(0.0,0.03,y)*(1.0-smoothstep(0.03,0.35,y));
            float w = 1.0 - smoothstep(0.0,0.18,abs(fract(g.x)-0.5));
            a += streak*w*step(0.82, r)*(k==0?0.5:0.8);
          }
          gl_FragColor = vec4(vec3(0.6,0.8,0.95), a*0.22);
        }`,
    });
    this.rainMat = mat;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.x1 - ROOM.x0, ROOM.h - 0.8), mat);
    m.position.set(0, 0.45 + (ROOM.h - 0.8) / 2, ROOM.z0 - 0.06);
    m.renderOrder = 4;
    this.scene.add(m);
  }

  // ------------------------------------------------------------------ engine sync
  /** Called after any change and a few times per second. view = { consoles, mission, flows, kioskState } */
  sync(eng, view = {}) {
    this.eng = eng;
    this.cables.sync(eng);
    this.holo.sync(eng);
    const st = eng.s;
    // door to Sector B
    this.doorUnlocked = st.devices['DIST-SW-B'].powered !== false;
    this.doorBlock.active = !this.doorUnlocked;
    this.room.doorLamp.material.emissive.setHex(this.doorUnlocked ? INK.phosphor : INK.fault);
    this.rogue.visible = !!st.devices['ROGUE-AP'] && (!!st.links.rogue || !!st.links.rogue2);
    if (st.links.rogue2) this.rogue.position.set(11.35, 0.5, 7.2);
    else this.rogue.position.set(11.35, 0.5, 6.0);
    // LEDs
    this.stormLinks = new Set();
    for (const [, set] of eng.storms()) for (const id of set) this.stormLinks.add(id);
    const busy = new Set();
    for (const f of st.flows) for (const h of st.flowState[f.id]?.links || []) busy.add(h.link);
    this.ledState.clear();
    for (const d of Object.values(st.devices)) {
      if (!['switch', 'router', 'bridge'].includes(d.kind) && d.id !== 'DOOR-CTRL') continue;
      for (const p of Object.values(d.ports)) {
        const key = `${d.id}|${p.name}`;
        const l = eng.linkAt(d.id, p.name);
        let s = 'off';
        if (d.powered === false) s = 'off';
        else if (p.errDisabled) s = 'err';
        else if (l && eng.linkStatus(l.id).up) {
          s = this.stormLinks.has(l.id) ? 'storm' : busy.has(l.id) ? 'busy' : 'up';
          if (d.kind === 'switch') {
            const v = p.mode === 'access' ? p.accessVlan : Object.keys(d.vlans).map(Number).find(x => carries(d, p, x) && x !== 1) ?? p.native;
            const rec = stpRecord(eng, d.id, v, p.name);
            if (rec && rec.st === 'blocking') s = 'blocking';
            else if (rec && (rec.st === 'listening' || rec.st === 'learning')) s = 'stp';
          }
          if (eng.linkStatus(l.id).mismatch) s = 'mismatch';
        }
        this.ledState.set(key, s);
      }
    }
    for (const p of PATCH_PANEL) {
      const cord = st.patch.cords.find(c => c.includes(p.id));
      let s = 'off';
      if (cord) {
        const id = `patch:${[...cord].sort().join('-')}`;
        s = st.links[id] && eng.linkStatus(id).up ? 'up' : 'amberSolid';
      }
      this.ledState.set(`patch|${p.id}`, s);
    }
    for (const id of ['CORE-SRV', 'CLINIC-APP', 'CLINIC-OLD', 'CCTV-NVR']) this.ledState.set(`${id}|power`, 'power');
    this.ledState.set('GUEST-AP|wlan0', eng.portUp('GUEST-AP', 'eth0') ? 'apblue' : 'off');
    const cams = st.flowState.cams;
    this.ledState.set('CAMERAS|dome', st.devices.CAMERAS.powered === false ? 'off' : cams?.ok ? 'rec' : 'err');
    this.ledState.set('DOOR-CTRL|eth0', st.devices['DOOR-CTRL'].powered === false ? 'off' : eng.portUp('DOOR-CTRL', 'eth0') ? 'up' : 'off');

    // city districts from flows
    const dist = {};
    for (const f of st.flows) {
      const s = st.flowState[f.id];
      if (!s) continue;
      const cur = dist[f.district];
      const v = !s.ok ? 'down' : s.degraded ? 'degraded' : 'ok';
      const rank = { ok: 0, degraded: 1, down: 2 };
      if (!cur || rank[v] > rank[cur]) dist[f.district] = v;
    }
    this.city.setDistricts(dist);
    const failing = st.flows.filter(f => !st.flowState[f.id]?.ok).length;
    this.alarmTarget = this.stormLinks.size ? 1 : failing ? Math.min(0.6, failing * 0.2) : 0;

    // screens
    this.consoles = view.consoles || this.consoles;
    const flowRows = st.flows.map(f => ({ label: f.label, ok: !!st.flowState[f.id]?.ok, degraded: !!st.flowState[f.id]?.degraded, detail: st.flowState[f.id]?.detail || '' }));
    const w = wallClock(st.t);
    const clock = `${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')}`;
    const term = (scr, dev, title, os) => {
      const lines = this.consoles[dev] || [`${title}`, '', 'idle — walk up and press E to use this console'];
      drawTerminal(scr, title, lines, { os, status: eng.portUp(dev, st.devices[dev]?.nic || 'eth0') ? 'LINK' : 'NO LINK', statusColor: eng.portUp(dev, st.devices[dev]?.nic || 'eth0') ? SCR.phos : SCR.fault });
    };
    term(this.dispatchScreens[0], 'DISPATCH-01', 'DISPATCH-01 · cmd', 'windows');
    drawDashboard(this.dispatchScreens[1], 'SERVICE HEALTH', flowRows, `District 04 · ${clock}`);
    drawDashboard(this.dispatchScreens[2], view.mission?.title || 'NIGHT SHIFT', (view.mission?.goals || []).map(g => ({ label: g.label, ok: g.ok, detail: '' })), view.mission?.code || '');
    drawDashboard(this.wallScreens[0], 'CITY SERVICES', flowRows, `updated ${clock}`);
    drawDashboard(this.wallScreens[1], 'DISTRICTS', Object.entries(DISTRICTS).map(([k, d]) => ({ label: d.label, ok: dist[k] !== 'down', degraded: dist[k] === 'degraded' || !dist[k], detail: dist[k] ? dist[k].toUpperCase() : 'NOT MONITORED' })), '');
    const logs = [];
    for (const d of Object.values(st.devices)) for (const e of (d.logging || []).slice(-4)) logs.push(e);
    logs.sort((a, b) => a.t - b.t);
    drawTerminal(this.wallScreens[2], 'SYSLOG · ALL DEVICES', logs.slice(-14).map(e => e.text.replace(/^\*\w+ \d+ /, '')), { status: logs.length ? 'LIVE' : 'QUIET' });
    drawTerminal(this.wallScreens[3], 'CHANGE LOG', st.changeLog.slice(-14).map(c => `${c.actor.slice(0, 8).padEnd(8)} ${c.desc}`), { status: `${st.changeLog.length} CHANGES` });
    drawDashboard(this.wallScreens[4], view.mission?.title || 'NIGHT SHIFT', [...(view.mission?.goals || []), ...(view.mission?.evidence || [])].map(g => ({ label: g.label.slice(0, 60), ok: g.ok, detail: '' })), view.mission?.code || '');
    drawTerminal(this.wallScreens[5], `CLOCK ${clock}`, [`shift time  ${clock}`, `devices     ${Object.values(st.devices).filter(d => d.powered !== false).length}`, `links up    ${Object.values(st.links).filter(l => eng.linkStatus(l.id).up).length}/${Object.keys(st.links).length}`, `loops       ${eng.storms().size ? 'STORM IN VLAN ' + [...eng.storms().keys()].join(',') : 'none'}`], { status: clock });
    drawDashboard(this.supScreens[0], 'SERVICE HEALTH', flowRows, clock);
    drawTerminal(this.supScreens[1], 'CHANGE LOG', st.changeLog.slice(-12).map(c => `${c.actor.slice(0, 8).padEnd(8)} ${c.desc}`), {});
    const kvmDev = view.kvm || 'CORE-SRV';
    term(this.kvm, kvmDev, `KVM · ${kvmDev}`, 'linux');
    if (this.sb.nurseScreens) {
      term(this.sb.nurseScreens[0], 'NURSE-STATION', 'NURSE-STATION · cmd', 'windows');
      drawDashboard(this.sb.nurseScreens[1], 'WARD B', flowRows.filter(r => /Ward|Staff|voice|Camera/i.test(r.label)), clock);
      term(this.sb.laptopScreen, 'STAFF-LAPTOP', 'STAFF-LAPTOP · cmd', 'windows');
      const v = st.flowState.voice;
      drawPhone(this.sb.phoneScreen, st.devices['VOIP-PHONE'].powered === false ? { ok: false, text: 'NO POWER' } : { ok: !!v?.ok, text: v?.metric ? `MOS ${v.metric.mos.toFixed(1)}` : 'REGISTERING', text2: v?.metric ? `loss ${v.metric.loss.toFixed(1)}%  jit ${v.metric.jitter.toFixed(0)}ms` : '' });
      const camsDev = st.devices.CAMERAS;
      drawCctv(this.sb.cctv, camsDev.powered === false ? 0 : cams?.metric?.reach ?? 0, camsDev.count, this.t);
    }
    const k = st.devices['GUEST-KIOSK'];
    const ka = hostAddr(eng, k);
    const g = st.flowState.guest;
    drawKiosk(this.kioskScreen, { online: !!g?.ok, line: g ? (g.ok ? 'portal.example.net reachable' : g.detail) : 'Guest services not monitored yet', ip: ka.addr !== null ? fmtIp(ka.addr) : null });
  }

  /** Animate a command's packet path. */
  playProbe(eng, probe) {
    if (!probe || !probe.fwd) return;
    const fwdHops = (probe.fwd.hops || []).filter(h => h.kind === 'l2');
    const segs = this.cables.route(eng, fwdHops);
    const repHops = (probe.rep?.hops || []).filter(h => h.kind === 'l2');
    const back = this.cables.route(eng, repHops);
    const ok = probe.status === 'ok';
    const okKind = ok && !['net-unreachable', 'ttl-exceeded', 'rst', 'port-unreachable'].includes(probe.kind);
    const replyColor = okKind ? 0x3dffb4 : 0xffa53b;
    if (!segs.length) {
      const here = this.anchorOfDevice(eng, probe.fwd.at);
      if (here) this.packets.burst(here, 0xff3d5a, 18);
      return;
    }
    this.packets.spawn(segs, {
      color: 0xe9fbff, speed: 7, size: 0.07, trail: 5,
      then: () => {
        if (back.length) this.packets.spawn(back, { color: replyColor, speed: 7, size: 0.065, trail: 5, then: probe.replyLost ? () => this.burstAtEnd(back) : null });
        else if (!ok) this.burstAtEnd(segs);
      },
    });
  }

  burstAtEnd(segs) {
    const s = segs[segs.length - 1];
    const p = s.curve.getPointAt(s.rev ? 0 : 1);
    this.packets.burst(p, 0xff3d5a, 18);
  }

  anchorOfDevice(eng, devId) {
    const d = eng.s.devices[devId];
    if (!d) return null;
    const a = this.anchors[`${devId}|${d.nic || 'eth0'}`] || Object.entries(this.anchors).find(([k]) => k.startsWith(devId + '|'))?.[1];
    return a ? a.p.clone() : null;
  }

  // ------------------------------------------------------------------ per frame
  frame(dt) {
    this.t += dt;
    const t = this.t;
    this.controls.update(dt);
    // door animation
    const target = this.doorUnlocked ? 1 : 0;
    this.doorOpen += (target - this.doorOpen) * Math.min(1, dt * 1.8);
    this.room.door.position.z = (DOOR_B.z0 + DOOR_B.z1) / 2 - this.doorOpen * 1.55;
    // LEDs (blink patterns)
    const phase = Math.floor(t * 8);
    if (phase !== this.lastLedPhase) {
      this.lastLedPhase = phase;
      for (const [key, s] of this.ledState) {
        let c = C.off;
        const r = Math.random();
        switch (s) {
          case 'up': c = C.green; break;
          case 'busy': c = r > 0.35 ? C.green : C.off; break;
          case 'storm': c = r > 0.5 ? C.green : r > 0.25 ? C.amber : C.off; break;
          case 'blocking': c = C.amber; break;
          case 'stp': c = phase % 4 < 2 ? C.amber : C.off; break;
          case 'err': c = phase % 2 ? C.amber : C.off; break;
          case 'mismatch': c = r > 0.3 ? C.green : C.amber; break;
          case 'amberSolid': c = C.amber; break;
          case 'power': c = C.blue; break;
          case 'apblue': c = C.blue; break;
          case 'rec': c = phase % 8 < 6 ? C.red : C.off; break;
          default: c = C.off;
        }
        this.leds.set(key, c);
      }
      this.leds.commit();
    }
    // flow packets
    if (this.eng) {
      const st = this.eng.s;
      for (const f of st.flows) {
        const fs = st.flowState[f.id];
        if (!fs || !fs.links?.length) continue;
        this.flowTimers[f.id] = (this.flowTimers[f.id] ?? Math.random()) - dt;
        if (this.flowTimers[f.id] > 0) continue;
        this.flowTimers[f.id] = fs.ok ? 1.1 + Math.random() * 0.5 : 2.2;
        const segs = this.cables.route(this.eng, fs.links);
        if (!segs.length) continue;
        const color = !fs.ok ? 0xff3d5a : fs.degraded ? 0xffa53b : f.kind === 'voice' ? 0x8a7dff : 0x5cc8ff;
        this.packets.spawn(segs, { color, speed: 5.5, size: 0.045, trail: 3, then: fs.ok ? null : () => this.burstAtEnd(segs) });
      }
      if (this.stormLinks.size && Math.random() < dt * 40) {
        const ids = [...this.stormLinks];
        const id = ids[Math.floor(Math.random() * ids.length)];
        const l = this.cables.links.get(id);
        if (l && l.curve) this.packets.spawn([{ curve: l.curve, length: l.length, rev: Math.random() > 0.5 }], { color: 0xff3d5a, speed: 14, size: 0.05, trail: 2 });
      }
      // storm cables pulse
      for (const [, l] of this.cables.links) if (l.storm && l.mesh) l.mesh.material.emissiveIntensity = 0.8 + Math.abs(Math.sin(t * 13)) * 1.6;
    }
    this.packets.update(dt);
    this.holo.frame(dt);
    this.city.frame(dt);
    if (this.rainMat) this.rainMat.uniforms.t.value = t;
    // dust drift
    const dp = this.dustPts.geometry.attributes.position;
    for (let i = 0; i < dp.count; i++) {
      let y = dp.getY(i) + dt * 0.03;
      if (y > 4) y = 0.2;
      dp.setY(i, y);
      dp.setX(i, dp.getX(i) + Math.sin(t * 0.3 + i) * dt * 0.02);
    }
    dp.needsUpdate = true;
    // alarms
    this.alarm += ((this.alarmTarget || 0) - this.alarm) * Math.min(1, dt * 2);
    for (const a of this.alarms) {
      a.light.intensity = this.alarm * 60;
      a.tgt.position.set(a.x + Math.cos(t * 3) * 4, 0, a.z + Math.sin(t * 3) * 4);
      a.bulb.material.color.setRGB(0.2 + this.alarm * 3 * (Math.sin(t * 6) > 0 ? 1 : 0.3), 0.03, 0.04);
    }
    render(this.ctx, this.scene, this.camera, t, this.alarm * 0.6);
  }

  /** Station under the reticle (raycast) or the nearest one in front of the player. */
  pick() {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = 2.8;
    const visibleHits = this.hits.filter(h => h.userData.station !== 'ROGUE-AP' || this.rogue.visible);
    const hit = this.raycaster.intersectObjects(visibleHits, false)[0];
    if (hit) return { station: hit.object.userData.station, object: hit.object };
    const p = this.controls.pos;
    const fwd = new THREE.Vector2(-Math.sin(this.controls.yaw), -Math.cos(this.controls.yaw));
    let best = null;
    for (const h of visibleHits) {
      const dx = h.position.x - p.x;
      const dz = h.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.2) continue;
      const dot = (dx * fwd.x + dz * fwd.y) / Math.max(d, 0.01);
      if (dot < 0.55) continue;
      if (!best || d < best.d) best = { station: h.userData.station, object: h, d };
    }
    return best;
  }

  /** Screen-space rectangle of a hit object (for selection brackets). */
  screenRect(object) {
    const box = new THREE.Box3().setFromObject(object);
    const pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z).project(this.camera));
    const xs = pts.map(p => (p.x * 0.5 + 0.5) * innerWidth);
    const ys = pts.map(p => (-p.y * 0.5 + 0.5) * innerHeight);
    return { x0: Math.max(8, Math.min(...xs)), x1: Math.min(innerWidth - 8, Math.max(...xs)), y0: Math.max(8, Math.min(...ys)), y1: Math.min(innerHeight - 8, Math.max(...ys)) };
  }

  stationStand(id) {
    const s = STATIONS.find(x => x.id === id);
    return s ? s.stand : null;
  }
}

export { STATIONS, QUALITY, LOBBY };
