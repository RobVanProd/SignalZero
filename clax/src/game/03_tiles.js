// World painting: backdrop, cached terrain chunks, set dressing ---------------------------------------------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; };
const rgba = (h, a) => { const A = hex(h); return `rgba(${A[0]},${A[1]},${A[2]},${a})`; };
const motes = Array.from({ length: 46 }, () => ({ x: rand() * W, y: rand() * H, r: rand() * 3 + .6, s: rand() * .7 + .25 }));

function backdrop(cx, cy, t) {
  const L = G.level, b = L.biome, paint = images[b.id + '_background'];
  // the painting, full strength, slow parallax on both axes
  const ph = H * 1.2, pw = ph * paint.width / paint.height, oy = -clamp(cy / Math.max(1, L.height - H), 0, 1) * (ph - H), off = mod(cx * .1, pw * 2);
  for (let i = -2; i < 4; i++) { const x = i * pw - off; if (x > W || x + pw < 0) continue; ctx.save(); if (mod(i, 2) === 1) { ctx.translate(x + pw, oy); ctx.scale(-1, 1); ctx.drawImage(paint, 0, 0, pw + 1, ph); } else ctx.drawImage(paint, x, oy, pw + 1, ph); ctx.restore(); }
  // depth haze: only towards the bottom, so the painting keeps its colour
  let gr = ctx.createLinearGradient(0, H * .35, 0, H); gr.addColorStop(0, b.fog + '0)'); gr.addColorStop(1, b.fog + '.5)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  if (b.id === 'yard') { ctx.save(); ctx.globalAlpha = .07; ctx.fillStyle = b.accent; for (let i = 0; i < 5; i++) { const x = i * 370 - mod(cx * .07, 370); ctx.beginPath(); ctx.moveTo(x, -30); ctx.lineTo(x + 65, -30); ctx.lineTo(x + 350, 720); ctx.lineTo(x + 170, 720); ctx.closePath(); ctx.fill(); } ctx.restore(); }
  skyline(cx, cy, t, .22, mix(b.sky[1], b.shadow, .45), .62, 0, 520);
  skyline(cx, cy, t, .42, mix(b.sky[1], b.shadow, .8), .9, 3, 640);
  for (const s of motes) { ctx.globalAlpha = .14 + s.s * .14; ctx.strokeStyle = b.accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(mod(s.x - cx * (.12 + s.s * .1) + Math.sin(t * .3 + s.y) * 13, W), mod(s.y - cy * .1 - t * (8 + s.s * 13), H), s.r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
/* Mid-distance structures in atmospheric colour. They are anchored to the bottom of the level so climbing leaves them behind. */
function skyline(cx, cy, t, par, color, alpha, salt, pitch) {
  const L = G.level, id = L.biome.id, base = H + 60 + (L.height - H - cy) * par * .55, first = Math.floor(cx * par / pitch) - 1;
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = ctx.strokeStyle = color; ctx.lineCap = 'round';
  for (let i = first; i < first + 5; i++) {
    const x = i * pitch - cx * par, h1 = hash(i, 11 + salt), h2 = hash(i, 23 + salt), hgt = 380 + h1 * 520 + (par > .3 ? 120 : 0), top = base - hgt, wv = 46 + h2 * 30;
    if (id === 'yard') {
      ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + 18, top); ctx.moveTo(x + wv * 2, base); ctx.lineTo(x + wv * 2 - 18, top); ctx.stroke();
      ctx.lineWidth = 4; ctx.beginPath(); for (let y = base, k = 0; y > top + 60; y -= 90, k++) { const a = (base - y) / hgt * 18, b2 = (base - y + 90) / hgt * 18; ctx.moveTo(x + a, y); ctx.lineTo(x + wv * 2 - b2, y - 90); ctx.moveTo(x + wv * 2 - a, y); ctx.lineTo(x + b2, y - 90); } ctx.stroke();
      ctx.fillRect(x - 14, top - 14, wv * 2 + 28, 16); ctx.fillRect(x + 10, top - 60, wv, 48);
      if (h2 > .35) { const dir = h1 > .5 ? 1 : -1, jx = x + wv + dir * (150 + h2 * 90); ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(x + wv, top - 54); ctx.lineTo(jx, top - 96); ctx.stroke(); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x + wv, top - 110); ctx.lineTo(jx, top - 96); const sw = Math.sin(t * .6 + i) * 8; ctx.lineTo(jx + sw, top + 30 + h1 * 120); ctx.stroke(); ctx.beginPath(); ctx.arc(jx + sw, top + 42 + h1 * 120, 11, .4, Math.PI * 1.6); ctx.stroke(); ctx.fillRect(x + wv - 5, top - 112, 10, 60); }
    } else if (id === 'fortress') {
      const w2 = wv * 1.5; ctx.beginPath(); ctx.roundRect(x, top, w2 * 2, hgt + 80, [w2, w2, 0, 0]); ctx.fill();
      ctx.save(); ctx.globalAlpha = alpha * .28; ctx.fillStyle = '#fff3d6'; for (let y = top + w2 + 20; y < base; y += 130) ctx.fillRect(x, y, w2 * 2, 34); ctx.restore();
      ctx.fillRect(x + w2 - 3, top - 90, 6, 96); const fw = Math.sin(t * 2.2 + i) * 6; ctx.beginPath(); ctx.moveTo(x + w2 + 3, top - 88); ctx.quadraticCurveTo(x + w2 + 34, top - 96 + fw, x + w2 + 62, top - 78 + fw); ctx.lineTo(x + w2 + 3, top - 60); ctx.fill();
      if (h2 > .5) { ctx.fillRect(x + w2 * 2 - 4, top + 150, pitch - w2 * 2 + 8, 26); for (let k = 0; k < 5; k++) ctx.fillRect(x + w2 * 2 + k * 52, top + 128, 30, 24); }
    } else {
      const w2 = 120 + h2 * 70; ctx.beginPath(); ctx.moveTo(x + w2, top); ctx.quadraticCurveTo(x + w2 * .7, top + 130, x, top + 200); ctx.lineTo(x + 16, top + 228); ctx.lineTo(x + w2 * 2 - 16, top + 228); ctx.lineTo(x + w2 * 2, top + 200); ctx.quadraticCurveTo(x + w2 * 1.3, top + 130, x + w2, top); ctx.fill();
      ctx.fillRect(x + 22, top + 220, w2 * 2 - 44, hgt); ctx.fillRect(x + w2 - 3, top - 70, 6, 76); ctx.beginPath(); ctx.moveTo(x + w2, top - 70); ctx.lineTo(x + w2 + 44, top - 56); ctx.lineTo(x + w2, top - 42); ctx.fill();
      if (h1 > .55) { const wx = x + w2 * 2 + 150, wy = top + 120, r = 150; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 3; for (let n = 0; n < 10; n++) { const a = n * Math.PI / 5 + t * .08; ctx.beginPath(); ctx.moveTo(wx, wy); ctx.lineTo(wx + Math.cos(a) * r, wy + Math.sin(a) * r); ctx.stroke(); ctx.fillRect(wx + Math.cos(a) * r - 12, wy + Math.sin(a) * r, 24, 20); } ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(wx - 80, base); ctx.lineTo(wx, wy); ctx.lineTo(wx + 80, base); ctx.stroke(); }
      ctx.save(); ctx.globalAlpha = alpha; for (let k = 0; k < 9; k++) { ctx.fillStyle = ['#ffd27a', '#ff8fd0', '#8fe7ff'][k % 3]; ctx.globalAlpha = alpha * (.35 + .3 * Math.sin(t * 3 + k + i)); ctx.beginPath(); ctx.arc(x + 14 + k * (w2 * 2 - 28) / 8, top + 214, 4, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); ctx.fillStyle = color;
    }
  }
  ctx.restore();
}

/* ---- terrain chunks ---- */
const CH = 512, chunkCache = new Map(); let chunkLevel = null, chunkScale = 1;
const T_ = (c, r) => P.tile(G.level, c, r), solidT = ch => ch === '#' || ch === 'o', slopeT = ch => P.SLOPE[ch] !== undefined, massT = ch => solidT(ch) || slopeT(ch);
function slopePoly(g, c, r, ch) { const s = P.SLOPE[ch], x = c * TS, y = (r + 1) * TS; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - s[0] * TS); g.lineTo(x + TS, y - s[1] * TS); g.lineTo(x + TS, y); g.closePath(); }
function paintBack(g, c0, r0, c1, r1) {
  const L = G.level, b = L.biome, pat = g.createPattern(images[b.tex], 'repeat'), bt = (c, r) => (L.back[r] && L.back[r][c] && L.back[r][c] !== ' ') ? L.back[r][c] : null;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const k = bt(c, r); if (!k || solidT(T_(c, r))) continue; const x = c * TS, y = r * TS;
    g.fillStyle = k === 'v' ? mix(b.wall, b.haze, .16) : b.wall; g.fillRect(x, y, TS + .5, TS + .5);
    g.globalAlpha = .2; g.fillStyle = pat; g.fillRect(x, y, TS + .5, TS + .5); g.globalAlpha = 1;
    g.fillStyle = 'rgba(0,0,0,.2)'; if (r % 2 === 0) g.fillRect(x, y, TS, 2); if ((c + (r >> 1)) % 3 === 0) g.fillRect(x, y, 2, TS);
    if (hash(c, r) > .55) { g.fillStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.arc(x + 9, y + 9, 2.4, 0, Math.PI * 2); g.fill(); }
    // contact shadows under ceilings and beside walls sell the depth
    if (massT(T_(c, r - 1))) { const gr = g.createLinearGradient(0, y, 0, y + 46); gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x, y, TS, 46); }
    if (solidT(T_(c - 1, r))) { const gr = g.createLinearGradient(x, 0, x + 30, 0); gr.addColorStop(0, 'rgba(0,0,0,.36)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x, y, 30, TS); }
    if (solidT(T_(c + 1, r))) { const gr = g.createLinearGradient(x + TS, 0, x + TS - 30, 0); gr.addColorStop(0, 'rgba(0,0,0,.36)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x + TS - 30, y, 30, TS); }
    // ragged outer rim where the wall ends in open air
    g.fillStyle = mix(b.wall, '#000000', .45);
    if (!bt(c, r - 1) && !massT(T_(c, r - 1))) g.fillRect(x, y, TS, 7); if (!bt(c - 1, r) && !massT(T_(c - 1, r))) g.fillRect(x, y, 7, TS); if (!bt(c + 1, r) && !massT(T_(c + 1, r))) g.fillRect(x + TS - 7, y, 7, TS);
  }
}
function capStrip(g, x, y, w, b, thin) {
  const hgt = thin ? 14 : 18;
  g.fillStyle = b.cap; g.fillRect(x, y, w, hgt); g.globalAlpha = .45; g.fillStyle = g.__orange; g.fillRect(x, y, w, hgt); g.globalAlpha = 1;
  g.save(); g.beginPath(); g.rect(x, y + 6, w, hgt - 7); g.clip();
  if (b.id === 'fortress') { g.fillStyle = b.capDark; g.fillRect(x, y + 9, w, 5); }
  else { g.fillStyle = b.capDark; for (let xx = Math.floor(x / 44) * 44 - 44; xx < x + w + 44; xx += 44) { g.beginPath(); g.moveTo(xx, y + 6); g.lineTo(xx + 14, y + 6); g.lineTo(xx + 2, y + hgt); g.lineTo(xx - 12, y + hgt); g.fill(); } }
  g.restore();
  g.fillStyle = '#fff0bd'; g.fillRect(x, y, w, 2.4); g.fillStyle = 'rgba(8,20,28,.9)'; g.fillRect(x, y + hgt, w, 2.5);
  if (b.id === 'carnival') for (let xx = Math.ceil(x / 32) * 32; xx < x + w; xx += 32) { g.fillStyle = ['#ffe9a8', '#ff9fd8', '#9fe9ff'][mod(xx / 32, 3) | 0]; g.beginPath(); g.arc(xx, y + 12, 3.2, 0, Math.PI * 2); g.fill(); }
}
function paintFront(g, c0, r0, c1, r1) {
  const L = G.level, b = L.biome, pat = g.createPattern(images[b.tex], 'repeat'); g.__orange = g.createPattern(images.metal_orange, 'repeat');
  const dark = '#0a1c26', open = ch => !massT(ch);
  const depth = (c, r) => { for (let d = 1; d <= 3; d++) if (open(T_(c, r - d)) || open(T_(c - d, r)) || open(T_(c + d, r)) || open(T_(c, r + d))) return d - 1; return 3; };
  // pass 1: the mass. Flat colour first, texture as a quiet overlay, darker the deeper it is buried.
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const ch = T_(c, r), x = c * TS, y = r * TS; if (c < 0 || c >= L.cols || r < 0 || r >= L.rows || !massT(ch)) continue;
    const sl = slopeT(ch); g.save(); if (sl) { slopePoly(g, c, r, ch); g.clip(); }
    g.fillStyle = mix(b.floor, '#000000', .18); g.fillRect(x, y, TS + .6, TS + .6); g.globalAlpha = b.id === 'fortress' ? .5 : .34; g.fillStyle = pat; g.fillRect(x, y, TS + .6, TS + .6); g.globalAlpha = 1;
    const d = depth(c, r); if (d) { g.fillStyle = `rgba(3,10,18,${[0, .3, .5, .64][d]})`; g.fillRect(x, y, TS + .6, TS + .6); }
    g.fillStyle = 'rgba(0,0,0,.2)'; if (r % 2 === 0) g.fillRect(x, y + TS - 2.5, TS + .6, 2.5); if ((c + (r >> 1) * 2) % 4 === 0) g.fillRect(x + TS - 2.5, y, 2.5, TS + .6);
    g.fillStyle = 'rgba(255,255,255,.05)'; if (r % 2 === 0) g.fillRect(x, y, TS + .6, 2); 
    if (hash(c, r) > .55) { g.fillStyle = 'rgba(0,0,0,.4)'; g.beginPath(); g.arc(x + 10, y + 10, 3.4, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(255,255,255,.2)'; g.beginPath(); g.arc(x + 9, y + 9, 1.5, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  // pass 2: lit caps, outlines and details
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const ch = T_(c, r), x = c * TS, y = r * TS; if (c < 0 || c >= L.cols || r < 0 || r >= L.rows) continue;
    if (massT(ch)) {
      const sl = slopeT(ch);
      if (sl) {
        const s = P.SLOPE[ch], ya = y + TS - s[0] * TS, yb = y + TS - s[1] * TS, nx = -(yb - ya), ny = TS, nl = Math.hypot(nx, ny), ux = nx / nl, uy = ny / nl;
        const band = (o0, o1, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(x + ux * o0, ya + uy * o0); g.lineTo(x + TS + .6 + ux * o0, yb + uy * o0); g.lineTo(x + TS + .6 + ux * o1, yb + uy * o1); g.lineTo(x + ux * o1, ya + uy * o1); g.closePath(); g.fill(); };
        g.save(); g.beginPath(); g.moveTo(x, ya - 4); g.lineTo(x + TS + .6, yb - 4); g.lineTo(x + TS + .6, yb + 60); g.lineTo(x, ya + 60); g.closePath(); g.clip();
        band(18, 38, 'rgba(0,0,0,.2)'); band(0, 18, b.cap); g.globalAlpha = .45; band(0, 18, g.__orange); g.globalAlpha = 1;
        if (b.id === 'fortress') band(9, 14, b.capDark); else { g.save(); g.beginPath(); g.moveTo(x + ux * 6, ya + uy * 6); g.lineTo(x + TS + .6 + ux * 6, yb + uy * 6); g.lineTo(x + TS + .6 + ux * 18, yb + uy * 18); g.lineTo(x + ux * 18, ya + uy * 18); g.closePath(); g.clip(); g.fillStyle = b.capDark; for (let xx = Math.floor(x / 44) * 44 - 44; xx < x + TS + 44; xx += 44) { g.beginPath(); g.moveTo(xx, y - 80); g.lineTo(xx + 14, y - 80); g.lineTo(xx - 46, y + TS + 80); g.lineTo(xx - 60, y + TS + 80); g.fill(); } g.restore(); }
        band(0, 2.6, '#fff0bd'); band(18, 20.5, 'rgba(8,20,28,.9)'); g.restore();
        g.fillStyle = dark; if (s[0] > 0 && open(T_(c - 1, r))) g.fillRect(x, ya, 3.5, s[0] * TS); if (s[1] > 0 && open(T_(c + 1, r))) g.fillRect(x + TS - 3.5, yb, 3.5, s[1] * TS);
        continue;
      }
      const up = T_(c, r - 1), lf = T_(c - 1, r), rt = T_(c + 1, r), dn = T_(c, r + 1);
      if (open(up)) {
        if (ch === 'o') {
          const gr = g.createLinearGradient(0, y - 8, 0, y + 30); gr.addColorStop(0, '#fff6dc'); gr.addColorStop(.55, '#f0d9a8'); gr.addColorStop(1, '#c98f52');
          g.fillStyle = gr; g.strokeStyle = dark; g.lineWidth = 3; g.beginPath(); g.roundRect(x + 1.5, y - 7, TS - 3, 36, 15); g.fill(); g.stroke();
          g.fillStyle = '#ef8a3c'; g.fillRect(x + 6, y + 14, TS - 12, 6); g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.ellipse(x + TS / 2, y - 1, 18, 3, 0, 0, Math.PI * 2); g.fill();
        } else {
          capStrip(g, x, y, TS + .6, b, false);
          const gr = g.createLinearGradient(0, y + 20, 0, y + 40); gr.addColorStop(0, 'rgba(0,0,0,.34)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x, y + 20, TS + .6, 20);
          if (b.id === 'yard' && hash(c, r * 3) > .62) { g.fillStyle = 'rgba(96,150,70,.75)'; const dx = 8 + hash(c, r) * 30, len = 12 + hash(r, c) * 22; g.beginPath(); g.roundRect(x + dx, y + 17, 7, len, 3.5); g.fill(); g.beginPath(); g.roundRect(x + dx + 10, y + 17, 5, len * .55, 2.5); g.fill(); }
        }
      }
      g.fillStyle = dark;
      if (open(lf)) { g.fillRect(x, y, 3.5, TS); g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(x + 3.5, y + (open(up) ? 20 : 0), 2, TS); g.fillStyle = dark; }
      if (open(rt)) g.fillRect(x + TS - 3.5, y, 3.5, TS);
      if (open(dn) || dn === '^') { g.fillRect(x, y + TS - 4, TS, 4); }
    } else if (ch === '=') {
      const lf = T_(c - 1, r) !== '=' && !massT(T_(c - 1, r)), rt = T_(c + 1, r) !== '=' && !massT(T_(c + 1, r));
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x, y + 16, TS, 8);
      g.strokeStyle = mix(b.floor, '#000000', .35); g.lineWidth = 6; g.lineCap = 'round';
      if (lf) { g.beginPath(); g.moveTo(x + 8, y + 16); g.lineTo(x + 34, y + 42); g.stroke(); } if (rt) { g.beginPath(); g.moveTo(x + TS - 8, y + 16); g.lineTo(x + TS - 34, y + 42); g.stroke(); }
      g.fillStyle = mix(b.floor, '#000000', .2); g.fillRect(x + (lf ? 3 : 0), y + 12, TS - (lf ? 3 : 0) - (rt ? 3 : 0), 10);
      capStrip(g, x + (lf ? 2 : 0), y, TS + .6 - (lf ? 2 : 0) - (rt ? 2 : 0), b, true);
      g.fillStyle = dark; if (lf) g.fillRect(x, y, 3, 22); if (rt) g.fillRect(x + TS - 3, y, 3, 22);
    } else if (ch === '^') {
      for (let k = 0; k < 4; k++) { const sx = x + 2 + k * 15.5, hgt = 26 + hash(c * 4 + k, r) * 12; g.beginPath(); g.moveTo(sx, y + TS); g.lineTo(sx + 7.5, y + TS - hgt); g.lineTo(sx + 15, y + TS); g.closePath(); g.fillStyle = b.id === 'carnival' ? '#f0c060' : '#e9e2c6'; g.fill(); g.strokeStyle = dark; g.lineWidth = 2.5; g.stroke(); g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.moveTo(sx + 7.5, y + TS - hgt); g.lineTo(sx + 15, y + TS); g.lineTo(sx + 9, y + TS); g.fill(); }
    }
  }
}
function drawChunks(layer, cx, cy) {
  const L = G.level; if (chunkLevel !== L) { chunkCache.clear(); chunkLevel = L; chunkScale = clamp(viewScale * dpr, 1, 1.5) > 1.15 ? 1.5 : 1; }
  for (let j = Math.floor(cy / CH); j <= Math.floor((cy + H) / CH); j++) for (let i = Math.floor(cx / CH); i <= Math.floor((cx + W) / CH); i++) {
    if (i < 0 || j < 0 || i * CH >= L.width || j * CH >= L.height + CH) continue;
    const key = layer + ':' + i + ':' + j; let cv = chunkCache.get(key);
    if (cv === undefined) {
      const c0 = Math.floor(i * CH / TS) - 1, r0 = Math.floor(j * CH / TS) - 1, c1 = Math.floor((i + 1) * CH / TS) + 1, r1 = Math.floor((j + 1) * CH / TS) + 1; let any = false;
      for (let r = Math.max(0, r0); r <= Math.min(L.rows - 1, r1) && !any; r++) for (let c = Math.max(0, c0); c <= Math.min(L.cols - 1, c1); c++) if ((layer === 'b' ? L.back : L.grid)[r][c] !== ' ') { any = true; break; }
      if (!any) cv = null; else { cv = document.createElement('canvas'); cv.width = cv.height = CH * chunkScale; const g = cv.getContext('2d'); g.scale(chunkScale, chunkScale); g.translate(-i * CH, -j * CH); (layer === 'b' ? paintBack : paintFront)(g, c0, r0, c1, r1); }
      if (chunkCache.size > 90) chunkCache.delete(chunkCache.keys().next().value); chunkCache.set(key, cv);
    }
    if (cv) ctx.drawImage(cv, i * CH, j * CH, CH + .5, CH + .5);
  }
}

/* ---- set dressing ---- */
function glow(x, y, r, color, a = .5) { const gr = ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, rgba(color, a)); gr.addColorStop(1, rgba(color, 0)); ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.restore(); }
function chainLine(x, y0, y1, sway = 0) { const n = Math.max(1, Math.round((y1 - y0) / 18)); for (let i = 0; i < n; i++) { const t = i / n, xx = x + sway * t * t, yy = y0 + i * 18; ctx.strokeStyle = '#0b222c'; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(xx, yy + 9, i % 2 ? 3 : 6, 10, 0, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = '#6f7f7a'; ctx.lineWidth = 2; ctx.stroke(); } }
function drawDeco(d, t) {
  const b = G.level.biome, x = d.x, y = d.y; ctx.save();
  switch (d.t) {
    case 'chain': { const sw = Math.sin(t * .8 + x) * 10, y1 = y + d.len * TS; chainLine(x, y, y1, sw); ctx.strokeStyle = '#0b222c'; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(x + sw, y1 + 14, 13, -.3, Math.PI * 1.25); ctx.stroke(); ctx.strokeStyle = '#8a8f80'; ctx.lineWidth = 3; ctx.stroke(); break; }
    case 'lamp': {
      const fl = .8 + Math.sin(t * 9 + x) * .04 + (Math.sin(t * 1.3 + x) > .96 ? -.3 : 0);
      if (d.hang) { ctx.fillStyle = '#0b222c'; ctx.fillRect(x - 2, y, 4, 40); box(x - 16, y + 38, 32, 12, '#3a4a48', '#0b222c', 4); ctx.fillStyle = '#ffe9a6'; ctx.beginPath(); ctx.arc(x, y + 56, 11, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#0b222c'; ctx.lineWidth = 2.5; ctx.stroke(); glow(x, y + 58, 190, '#ffcf7a', .34 * fl); }
      else { ctx.fillStyle = '#0b222c'; ctx.fillRect(x - 5, y - 150, 10, 150); box(x - 13, y - 12, 26, 12, '#35474a', '#0b222c', 3); box(x - 14, y - 182, 28, 34, '#ffe9a6', '#0b222c', 8, 3); box(x - 18, y - 190, 36, 10, '#b58a4a', '#0b222c', 3); glow(x, y - 165, 200, '#ffcf7a', .32 * fl); }
      break; }
    case 'porthole': { box(x - 30, y - 30, 60, 60, '#b9914f', '#0b222c', 30, 4); ctx.fillStyle = '#123a44'; ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(140,235,220,.35)'; ctx.beginPath(); ctx.arc(x - 5, y - 5, 9, 0, Math.PI * 2); ctx.fill(); for (let k = 0; k < 6; k++) { ctx.fillStyle = '#5a4526'; ctx.beginPath(); ctx.arc(x + Math.cos(k * 1.047) * 25, y + Math.sin(k * 1.047) * 25, 2.5, 0, Math.PI * 2); ctx.fill(); } glow(x, y, 70, b.accent, .12); break; }
    case 'window': { ctx.fillStyle = '#0b1a26'; ctx.beginPath(); ctx.roundRect(x - 38, y - 60, 76, 124, [38, 38, 4, 4]); ctx.fill(); const gr = ctx.createLinearGradient(0, y - 56, 0, y + 60); gr.addColorStop(0, b.id === 'carnival' ? '#ff9fd8' : '#ffe0a0'); gr.addColorStop(1, b.id === 'carnival' ? '#7a3fa8' : '#d9843f'); ctx.fillStyle = gr; ctx.globalAlpha = .82; ctx.beginPath(); ctx.roundRect(x - 31, y - 53, 62, 110, [31, 31, 2, 2]); ctx.fill(); ctx.globalAlpha = 1; ctx.fillStyle = '#0b1a26'; ctx.fillRect(x - 2.5, y - 54, 5, 112); ctx.fillRect(x - 32, y - 4, 64, 5); glow(x, y, 150, b.id === 'carnival' ? '#ff9fd8' : '#ffcf7a', .2); break; }
    case 'crane': {
      const hgt = d.h * TS, f = d.flip ? -1 : 1, col = mix(b.shadow, b.haze, .25); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineCap = 'round'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(x - 34, y); ctx.lineTo(x - 14, y - hgt); ctx.moveTo(x + 34, y); ctx.lineTo(x + 14, y - hgt); ctx.stroke();
      ctx.lineWidth = 5; ctx.beginPath(); for (let yy = 0; yy < hgt - 40; yy += 84) { const a = 34 - yy / hgt * 20, a2 = 34 - (yy + 84) / hgt * 20; ctx.moveTo(x - a, y - yy); ctx.lineTo(x + a2, y - yy - 84); ctx.moveTo(x + a, y - yy); ctx.lineTo(x - a2, y - yy - 84); } ctx.stroke();
      ctx.fillRect(x - 40, y - hgt - 44, 80, 48); ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(x, y - hgt - 30); ctx.lineTo(x + f * 300, y - hgt - 96); ctx.moveTo(x, y - hgt - 30); ctx.lineTo(x - f * 110, y - hgt - 10); ctx.stroke(); ctx.fillRect(x - f * 110 - 26, y - hgt - 30, 52, 44);
      ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, y - hgt - 120); ctx.lineTo(x + f * 300, y - hgt - 96); ctx.moveTo(x, y - hgt - 120); ctx.lineTo(x - f * 110, y - hgt - 10); ctx.stroke(); ctx.fillRect(x - 6, y - hgt - 122, 12, 84);
      const sw = Math.sin(t * .7 + x) * 12; ctx.beginPath(); ctx.moveTo(x + f * 300, y - hgt - 96); ctx.lineTo(x + f * 300 + sw, y - hgt + 90); ctx.stroke(); ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(x + f * 300 + sw, y - hgt + 106, 15, -.2, Math.PI * 1.3); ctx.stroke(); break; }
    case 'flag': { ctx.fillStyle = '#0b222c'; ctx.fillRect(x - 3, y - 190, 6, 190); ctx.fillStyle = '#e9c170'; ctx.beginPath(); ctx.arc(x, y - 192, 6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(x + 3, y - 186); for (let k = 0; k <= 8; k++) ctx.lineTo(x + 3 + k * 10, y - 186 + Math.sin(t * 4 + k * .8 + x) * (k * .9)); for (let k = 8; k >= 0; k--) ctx.lineTo(x + 3 + k * 10, y - 142 - k * 2 + Math.sin(t * 4 + k * .8 + x + .6) * (k * .9)); ctx.closePath(); ctx.fillStyle = b.id === 'carnival' ? '#e85fb5' : '#ef7b34'; ctx.fill(); ctx.strokeStyle = '#0b222c'; ctx.lineWidth = 2.5; ctx.stroke(); break; }
    case 'banner': { ctx.font = '900 15px Arial'; const w2 = ctx.measureText(d.text).width + 44; ctx.strokeStyle = '#0b222c'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x - 14, y - 26); ctx.lineTo(x, y); ctx.moveTo(x + w2 + 14, y - 26); ctx.lineTo(x + w2, y); ctx.stroke(); ctx.rotate(0); box(x, y - 4, w2, 36, b.id === 'carnival' ? '#f2c75c' : '#e9dcb4', '#0b222c', 3, 3); ctx.fillStyle = b.id === 'fortress' ? '#d9662c' : b.id === 'carnival' ? '#a2357f' : '#2f5d63'; ctx.fillRect(x + 3, y - 1, 8, 30); ctx.fillRect(x + w2 - 11, y - 1, 8, 30); text(d.text, x + w2 / 2, y + 20, 15, '#1b2c33', 'center', 900); break; }
    case 'bulbs': { const w2 = d.w * TS, sag = (d.sag === undefined ? 2 : d.sag) * 16; ctx.strokeStyle = '#0b1a26'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + w2 / 2, y + sag * 2, x + w2, y); ctx.stroke(); const n = Math.max(2, Math.round(w2 / 46)); for (let k = 0; k <= n; k++) { const u = k / n, bx = x + w2 * u, by = y + sag * 4 * u * (1 - u) + 7, on = Math.sin(t * 3 + k * 1.7) > -.3, col = ['#ffd978', '#ff8fd0', '#8fe7ff', '#b5ff9a'][k % 4]; ctx.fillStyle = on ? col : mix(col, '#000000', .55); ctx.beginPath(); ctx.arc(bx, by, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#0b1a26'; ctx.lineWidth = 1.5; ctx.stroke(); if (on) glow(bx, by, 34, col, .32); } break; }
    case 'tent': { const s = (d.s || 1) * 1.15, cols2 = ['#b23a8a', '#f1d9c0']; ctx.translate(x, y); ctx.scale(s, s); for (let k = 0; k < 8; k++) { ctx.fillStyle = mix(cols2[k % 2], b.shadow, .35); ctx.beginPath(); ctx.moveTo(0, -330); ctx.quadraticCurveTo(-150 + k * 37.5, -250, -170 + k * 42.5, -150); ctx.lineTo(-170 + (k + 1) * 42.5, -150); ctx.quadraticCurveTo(-150 + (k + 1) * 37.5, -250, 0, -330); ctx.fill(); ctx.fillStyle = mix(cols2[(k + 1) % 2], b.shadow, .45); ctx.fillRect(-150 + k * 37.5, -150, 37.6, 150); } ctx.fillStyle = mix('#f2c75c', b.shadow, .3); for (let k = 0; k < 9; k++) { ctx.beginPath(); ctx.arc(-170 + k * 42.5, -150, 21, 0, Math.PI); ctx.fill(); } ctx.fillStyle = '#0b1a26'; ctx.fillRect(-2, -380, 4, 52); ctx.fillStyle = '#f2c75c'; ctx.beginPath(); ctx.moveTo(2, -380); ctx.lineTo(40, -368 + Math.sin(t * 4) * 3); ctx.lineTo(2, -356); ctx.fill(); break; }
    case 'pipe': { const w2 = d.w * TS; box(x, y - 13, w2, 26, mix(b.floor, '#000000', .25), '#0b222c', 0, 3); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(x, y - 9, w2, 5); for (let xx = x + 40; xx < x + w2; xx += 190) box(xx - 9, y - 18, 18, 36, '#8f7444', '#0b222c', 3, 3); break; }
    case 'buoy': { ctx.translate(x, y); ctx.rotate(-.35); ring(0, -30, 62, '#e9682f'); break; }
  }
  ctx.restore();
}
