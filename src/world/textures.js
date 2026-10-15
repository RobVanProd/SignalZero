// Procedural canvas textures: no image assets, everything is drawn at load time.
import * as THREE from 'three';

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function tex(c, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.needsUpdate = true;
  return t;
}

// Small deterministic PRNG so textures look the same every load.
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(x, w, h, n, alpha, rnd, color = '255,255,255') {
  for (let i = 0; i < n; i++) {
    x.fillStyle = `rgba(${color},${alpha * rnd()})`;
    x.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

/** Raised-floor tiles (600 mm). Returns { map, rough } covering 4x4 tiles. */
export function floorTextures() {
  const S = 1024;
  const T = S / 4;
  const rnd = prng(11);
  const c = canvas(S, S);
  const x = c.getContext('2d');
  const r = canvas(S, S);
  const rx = r.getContext('2d');
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const v = 18 + Math.floor(rnd() * 7);
      x.fillStyle = `rgb(${v},${v + 4},${v + 9})`;
      x.fillRect(i * T, j * T, T, T);
      const g = x.createLinearGradient(i * T, j * T, i * T + T, j * T + T);
      g.addColorStop(0, 'rgba(255,255,255,0.025)');
      g.addColorStop(1, 'rgba(0,0,0,0.05)');
      x.fillStyle = g;
      x.fillRect(i * T, j * T, T, T);
      speckle(x, S, S, 0, 0, rnd);
      const rv = 70 + Math.floor(rnd() * 40);
      rx.fillStyle = `rgb(${rv},${rv},${rv})`;
      rx.fillRect(i * T, j * T, T, T);
    }
  }
  speckle(x, S, S, 9000, 0.05, rnd);
  speckle(rx, S, S, 12000, 0.25, rnd);
  // seams
  x.strokeStyle = 'rgba(0,0,0,0.85)';
  x.lineWidth = 6;
  rx.strokeStyle = 'rgb(230,230,230)';
  rx.lineWidth = 8;
  for (let i = 0; i <= 4; i++) {
    for (const ctx of [x, rx]) {
      ctx.beginPath(); ctx.moveTo(i * T, 0); ctx.lineTo(i * T, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * T); ctx.lineTo(S, i * T); ctx.stroke();
    }
  }
  x.strokeStyle = 'rgba(120,170,190,0.06)';
  x.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    x.beginPath(); x.moveTo(i * T + 4, 0); x.lineTo(i * T + 4, S); x.stroke();
    x.beginPath(); x.moveTo(0, i * T + 4); x.lineTo(S, i * T + 4); x.stroke();
  }
  return { map: tex(c, { repeat: [1, 1] }), rough: tex(r, { srgb: false, repeat: [1, 1] }) };
}

/** Perforated cold-aisle tile. */
export function perforatedTexture() {
  const S = 512;
  const c = canvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#1c242c';
  x.fillRect(0, 0, S, S);
  x.fillStyle = '#05080b';
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
    x.beginPath();
    x.arc(16 + i * 20.5, 16 + j * 20.5, 5.2, 0, Math.PI * 2);
    x.fill();
  }
  x.strokeStyle = '#000';
  x.lineWidth = 10;
  x.strokeRect(0, 0, S, S);
  return tex(c, { repeat: [1, 1] });
}

/** Acoustic wall panels with seams. */
export function wallTexture() {
  const W = 1024;
  const H = 512;
  const rnd = prng(23);
  const c = canvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#18232d';
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < 4; i++) {
    const v = 30 + Math.floor(rnd() * 8);
    x.fillStyle = `rgb(${v},${v + 9},${v + 16})`;
    x.fillRect(i * (W / 4) + 3, 0, W / 4 - 6, H);
  }
  speckle(x, W, H, 14000, 0.035, rnd);
  x.fillStyle = 'rgba(0,0,0,0.6)';
  for (let i = 0; i <= 4; i++) x.fillRect(i * (W / 4) - 3, 0, 6, H);
  return tex(c, { repeat: [1, 1] });
}

export function ceilingTexture() {
  const S = 512;
  const rnd = prng(31);
  const c = canvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#0b1016';
  x.fillRect(0, 0, S, S);
  speckle(x, S, S, 5000, 0.04, rnd);
  x.strokeStyle = '#030507';
  x.lineWidth = 10;
  for (let i = 0; i <= 2; i++) {
    x.beginPath(); x.moveTo(i * S / 2, 0); x.lineTo(i * S / 2, S); x.stroke();
    x.beginPath(); x.moveTo(0, i * S / 2); x.lineTo(S, i * S / 2); x.stroke();
  }
  return tex(c, { repeat: [1, 1] });
}

export function brushedMetal(seed = 5, base = [40, 46, 54]) {
  const W = 512;
  const H = 512;
  const rnd = prng(seed);
  const c = canvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = `rgb(${base.join(',')})`;
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < 1600; i++) {
    const y = rnd() * H;
    const a = rnd() * 0.06;
    x.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    x.fillRect(0, y, W, 1);
  }
  return tex(c, { repeat: [1, 1] });
}

// ------------------------------------------------------------------ device faceplates
// Each returns { map, emissive, ports: [{name, u, v}] } where u,v are 0..1 across the faceplate.

function plate(w, h, bg = '#1b2027') {
  const c = canvas(w, h);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, bg);
  g.addColorStop(1, '#0f1318');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(255,255,255,0.08)';
  x.lineWidth = 2;
  x.strokeRect(1, 1, w - 2, h - 2);
  return { c, x };
}

function rj45(x, px, py, w, h) {
  x.fillStyle = '#05070a';
  x.fillRect(px, py, w, h);
  x.fillStyle = '#2a3038';
  x.fillRect(px + w * 0.3, py + h * 0.72, w * 0.4, h * 0.28);
  x.strokeStyle = '#3a424c';
  x.lineWidth = 1.5;
  x.strokeRect(px, py, w, h);
}

function ears(x, w, h) {
  x.fillStyle = '#272d35';
  x.fillRect(0, 0, 30, h);
  x.fillRect(w - 30, 0, 30, h);
  x.fillStyle = '#0a0d10';
  for (const yy of [h * 0.3, h * 0.7]) {
    x.beginPath(); x.arc(15, yy, 5, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(w - 15, yy, 5, 0, Math.PI * 2); x.fill();
  }
}

export function switchFace(model = 'C9200-24P', label = 'ACCESS-SW') {
  const W = 1024;
  const H = 104;
  const { c, x } = plate(W, H, '#1d232b');
  ears(x, W, H);
  const e = canvas(W, H);
  const ex = e.getContext('2d');
  ex.fillStyle = '#000';
  ex.fillRect(0, 0, W, H);
  x.fillStyle = '#9fb3c2';
  x.font = 'bold 15px sans-serif';
  x.fillText('cisco', 48, 30);
  x.font = '12px sans-serif';
  x.fillStyle = '#6d8191';
  x.fillText(model, 48, 50);
  x.fillStyle = '#c9e7f2';
  x.font = 'bold 13px monospace';
  x.fillText(label, 48, 84);
  const ports = [];
  const x0 = 200;
  const pw = 26;
  const ph = 22;
  for (let i = 0; i < 24; i++) {
    const col = Math.floor(i / 2);
    const row = i % 2;
    const px = x0 + col * 52 + (col >= 6 ? 14 : 0);
    const py = row === 0 ? 20 : 58;
    rj45(x, px, py, pw, ph);
    ports.push({ name: `Gi0/${i + 1}`, u: (px + pw / 2) / W, v: (py - 7) / H });
  }
  // uplink SFP cages
  for (let i = 0; i < 4; i++) {
    x.fillStyle = '#0a0c0f';
    x.fillRect(880 + (i % 2) * 52, 24 + Math.floor(i / 2) * 38, 40, 22);
    x.strokeStyle = '#4b5561';
    x.strokeRect(880 + (i % 2) * 52, 24 + Math.floor(i / 2) * 38, 40, 22);
  }
  // console port
  x.fillStyle = '#16405e';
  x.fillRect(150, 58, 26, 22);
  x.fillStyle = '#7fb2d4';
  x.font = '9px sans-serif';
  x.fillText('CON', 150, 92);
  ports.push({ name: 'Con0', u: (163) / W, v: 51 / H });
  // system LEDs (baked)
  ex.fillStyle = '#3cff9c';
  ex.fillRect(130, 22, 7, 5);
  ex.fillRect(130, 36, 7, 5);
  return { map: tex(c), emissive: tex(e), ports };
}

export function routerFace(label = 'EDGE-RTR') {
  const W = 1024;
  const H = 208;
  const { c, x } = plate(W, H, '#20262e');
  ears(x, W, H);
  const e = canvas(W, H);
  const ex = e.getContext('2d');
  ex.fillStyle = '#000';
  ex.fillRect(0, 0, W, H);
  // module slots
  for (let i = 0; i < 4; i++) {
    x.fillStyle = '#12161b';
    x.fillRect(420 + (i % 2) * 260, 30 + Math.floor(i / 2) * 76, 240, 62);
    x.strokeStyle = '#353d47';
    x.strokeRect(420 + (i % 2) * 260, 30 + Math.floor(i / 2) * 76, 240, 62);
    x.fillStyle = '#3b444f';
    x.font = '11px sans-serif';
    x.fillText(`EHWIC ${i}`, 430 + (i % 2) * 260, 48 + Math.floor(i / 2) * 76);
  }
  x.fillStyle = '#9fb3c2';
  x.font = 'bold 20px sans-serif';
  x.fillText('cisco', 52, 44);
  x.fillStyle = '#6d8191';
  x.font = '13px sans-serif';
  x.fillText('CISCO2911/K9', 52, 66);
  x.fillStyle = '#c9e7f2';
  x.font = 'bold 15px monospace';
  x.fillText(label, 52, 182);
  const ports = [];
  const names = ['Gi0/0', 'Gi0/1', 'Gi0/2'];
  names.forEach((n, i) => {
    const px = 60 + i * 64;
    rj45(x, px, 100, 34, 28);
    x.fillStyle = '#7f93a3';
    x.font = '10px sans-serif';
    x.fillText(n.replace('Gi', 'GE '), px - 2, 146);
    ports.push({ name: n, u: (px + 17) / W, v: 92 / H });
  });
  x.fillStyle = '#16405e';
  x.fillRect(270, 100, 34, 28);
  x.fillStyle = '#7fb2d4';
  x.font = '10px sans-serif';
  x.fillText('CONSOLE', 262, 146);
  ports.push({ name: 'Con0', u: 287 / W, v: 92 / H });
  ex.fillStyle = '#3cff9c';
  ex.fillRect(360, 104, 8, 6);
  ex.fillStyle = '#3cff9c';
  ex.fillRect(360, 118, 8, 6);
  return { map: tex(c), emissive: tex(e), ports };
}

export function serverFace(label = 'CORE-SRV', opts = {}) {
  const W = 1024;
  const H = 104;
  const { c, x } = plate(W, H, opts.tint || '#232931');
  ears(x, W, H);
  const e = canvas(W, H);
  const ex = e.getContext('2d');
  ex.fillStyle = '#000';
  ex.fillRect(0, 0, W, H);
  for (let i = 0; i < 8; i++) {
    const px = 60 + i * 62;
    x.fillStyle = '#14181d';
    x.fillRect(px, 16, 56, 72);
    x.fillStyle = '#2d343d';
    x.fillRect(px + 4, 20, 48, 10);
    x.fillStyle = '#0b0e11';
    for (let k = 0; k < 6; k++) x.fillRect(px + 8, 38 + k * 8, 40, 3);
    ex.fillStyle = i < 6 ? '#3cff9c' : '#1b4d36';
    ex.fillRect(px + 44, 22, 5, 5);
  }
  x.fillStyle = '#0d1014';
  for (let k = 0; k < 9; k++) x.fillRect(600 + k * 26, 18, 14, 68);
  x.fillStyle = '#c9e7f2';
  x.font = 'bold 15px monospace';
  x.fillText(label, 850, 44);
  x.fillStyle = '#6d8191';
  x.font = '11px sans-serif';
  x.fillText(opts.model || 'PowerEdge R650', 850, 66);
  if (opts.tag) {
    x.fillStyle = '#ff5a6e';
    x.fillRect(850, 74, 120, 18);
    x.fillStyle = '#1a0006';
    x.font = 'bold 12px sans-serif';
    x.fillText(opts.tag, 856, 88);
  }
  ex.fillStyle = '#59d9ff';
  ex.beginPath(); ex.arc(980, 30, 7, 0, Math.PI * 2); ex.fill();
  return { map: tex(c), emissive: tex(e), ports: [{ name: 'eth0', u: 0.96, v: 0.7 }] };
}

export function patchPanelFace(panel) {
  const W = 1024;
  const H = 208;
  const { c, x } = plate(W, H, '#1a1f26');
  ears(x, W, H);
  const ports = [];
  x.fillStyle = '#e9edf0';
  x.fillRect(46, 10, W - 92, 26);
  x.fillStyle = '#20262d';
  x.font = 'bold 15px monospace';
  x.fillText('RACK C  /  PATCH PANEL PP-C1  /  CAT6A', 60, 29);
  for (let i = 0; i < 24; i++) {
    const col = i % 12;
    const row = Math.floor(i / 12);
    const px = 70 + col * 74;
    const py = 66 + row * 74;
    rj45(x, px, py, 36, 30);
    x.fillStyle = '#93a7b6';
    x.font = 'bold 12px monospace';
    x.fillText(String(i + 1).padStart(2, '0'), px + 6, py - 6);
    const p = panel[i];
    if (p) {
      x.fillStyle = '#ffe9a8';
      x.fillRect(px - 8, py + 34, 52, 13);
      x.fillStyle = '#2b2200';
      x.font = 'bold 9px monospace';
      x.fillText(p.short, px - 6, py + 44);
      ports.push({ id: p.id, u: (px + 18) / W, v: (py + 15) / H });
    }
  }
  return { map: tex(c), ports };
}

export function genericFace(label, sub = '', color = '#1f252d', leds = 8) {
  const W = 1024;
  const H = 104;
  const { c, x } = plate(W, H, color);
  ears(x, W, H);
  const e = canvas(W, H);
  const ex = e.getContext('2d');
  ex.fillStyle = '#000';
  ex.fillRect(0, 0, W, H);
  x.fillStyle = '#c9e7f2';
  x.font = 'bold 14px monospace';
  x.fillText(label, 60, 42);
  x.fillStyle = '#6d8191';
  x.font = '11px sans-serif';
  x.fillText(sub, 60, 64);
  x.fillStyle = '#0c0f13';
  for (let k = 0; k < 18; k++) x.fillRect(420 + k * 30, 22, 18, 60);
  const rnd = prng(label.length * 13);
  for (let i = 0; i < leds; i++) {
    ex.fillStyle = rnd() > 0.2 ? '#3cff9c' : '#ffb547';
    ex.fillRect(260 + i * 16, 40, 7, 6);
  }
  return { map: tex(c), emissive: tex(e) };
}

/** Text label texture (signage). */
export function labelTexture(text, { w = 1024, h = 160, fg = '#d8f6ff', bg = 'rgba(6,14,20,0.92)', font = 'bold 64px "Segoe UI", sans-serif', align = 'center', border = null, sub = null } = {}) {
  const c = canvas(w, h);
  const x = c.getContext('2d');
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
  if (border) { x.strokeStyle = border; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6); }
  x.fillStyle = fg;
  x.font = font;
  x.textBaseline = 'middle';
  x.textAlign = align;
  const ax = align === 'center' ? w / 2 : align === 'left' ? 40 : w - 40;
  x.fillText(text, ax, sub ? h * 0.4 : h / 2);
  if (sub) {
    x.font = `${Math.round(h * 0.2)}px "Segoe UI", sans-serif`;
    x.fillStyle = 'rgba(160,200,215,0.85)';
    x.fillText(sub, ax, h * 0.75);
  }
  return tex(c);
}

/** Window-light texture for city buildings. */
export function buildingWindows(seed, cols = 8, rows = 24) {
  const W = 256;
  const H = 768;
  const rnd = prng(seed);
  const c = canvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#000';
  x.fillRect(0, 0, W, H);
  const cw = W / cols;
  const rh = H / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const r = rnd();
      if (r < 0.42) continue;
      const warm = rnd() > 0.35;
      const a = 0.35 + rnd() * 0.65;
      x.fillStyle = warm ? `rgba(255,${190 + Math.floor(rnd() * 40)},${120 + Math.floor(rnd() * 60)},${a})` : `rgba(${140 + Math.floor(rnd() * 60)},${210 + Math.floor(rnd() * 40)},255,${a})`;
      x.fillRect(i * cw + cw * 0.2, j * rh + rh * 0.25, cw * 0.6, rh * 0.5);
    }
  }
  return tex(c);
}

export function radialGlow(color = '255,255,255', size = 256) {
  const c = canvas(size, size);
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${color},1)`);
  g.addColorStop(0.25, `rgba(${color},0.45)`);
  g.addColorStop(1, `rgba(${color},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return tex(c);
}

export function verticalFade(top = 'rgba(80,220,255,0.0)', bottom = 'rgba(80,220,255,0.35)') {
  const c = canvas(8, 256);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  x.fillStyle = g;
  x.fillRect(0, 0, 8, 256);
  return tex(c);
}
