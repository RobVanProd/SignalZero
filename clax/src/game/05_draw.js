// Entities, HUD, frame loop ---------------------------------------------------------------------------------
function ring(x, y, r, fill = '#f3893b') { ctx.save(); ctx.translate(x, y); ctx.strokeStyle = '#102a32'; ctx.lineWidth = r * .55; ctx.beginPath(); ctx.arc(0, 0, r * .69, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = fill; ctx.lineWidth = r * .39; ctx.stroke(); ctx.strokeStyle = '#ffe5af'; ctx.lineWidth = r * .38; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(0, 0, r * .69, i * Math.PI * .5 - .16, i * Math.PI * .5 + .16); ctx.stroke(); } ctx.restore(); }
function checkpoint(c) { ctx.save(); ctx.translate(c.x, c.y); ctx.fillStyle = '#112b34'; ctx.fillRect(-11, -118, 22, 114); box(-27, -135, 54, 18, '#ddaa5c', '#142b34', 5); ctx.strokeStyle = c.active ? '#8af6c9' : '#7ba29b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -131); ctx.lineTo(0, -178); ctx.stroke(); ctx.fillStyle = c.active ? '#a7ffcf' : '#c48a50'; ctx.beginPath(); ctx.arc(0, -180, 7, 0, Math.PI * 2); ctx.fill(); ring(0, -78 + Math.sin(G.clock * 2 + c.x) * 2, 32, c.active ? '#62d5b0' : '#ed9949'); if (c.active) { ctx.strokeStyle = 'rgba(145,255,211,.3)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -78, 40 + Math.sin(G.time * 3) * 3, 0, Math.PI * 2); ctx.stroke(); glow(0, -78, 120, '#7ff2d7', .22); } text('AIR', 0, -19, 12, c.active ? '#a4f5ca' : '#eadba8', 'center', 900); ctx.restore(); }
function npc(n) { if (n.rescued) return; ctx.save(); ctx.translate(n.x, n.y + Math.sin(G.clock * 3 + n.id) * 3); glow(0, -40, 110, '#b7f7c1', .18); ctx.fillStyle = 'rgba(1,20,28,.35)'; ctx.beginPath(); ctx.ellipse(0, -2, 29, 7, 0, 0, Math.PI * 2); ctx.fill(); box(-28, -66, 56, 64, '#e1c780', '#192e36', 18, 3); box(-23, -61, 46, 38, '#416f76', '#172f39', 16, 2); ctx.fillStyle = ['#b2e4a1', '#f2a8bc', '#f0cb6a'][n.kind]; ctx.beginPath(); ctx.ellipse(0, -43, 16, 12, 0, 0, Math.PI * 2); ctx.fill(); const look = clamp((G.player.x - n.x) / 200, -1, 1) * 2; ctx.fillStyle = '#fcf2d5'; ctx.beginPath(); ctx.arc(-6, -47, 6, 0, Math.PI * 2); ctx.arc(6, -47, 6, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#143439'; ctx.beginPath(); ctx.arc(-6 + look, -46, 2.2, 0, Math.PI * 2); ctx.arc(6 + look, -46, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fdedbc'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-9, -13); ctx.lineTo(9, -13); ctx.moveTo(0, -22); ctx.lineTo(0, -5); ctx.stroke(); const bob = Math.sin(G.clock * 5) * 4; box(-14, -100 + bob, 28, 23, '#b9edbd', '#1c423f', 5); text('!', 0, -83 + bob, 19, '#173b38', 'center', 900); text(n.name, 0, -108, 11, '#d0f4c8', 'center', 900); ctx.restore(); }
function pickups(cx, cy) {
  for (const i of G.level.pickups) {
    if (i.taken || i.x < cx - 40 || i.x > cx + W + 40 || i.y < cy - 60 || i.y > cy + H + 60) continue; const y = i.y + Math.sin(G.clock * 3.5 + i.x * .02) * 5;
    if (i.kind === 'tag') { ctx.save(); ctx.translate(i.x, y); ctx.rotate(Math.sin(G.clock * 2 + i.x) * .12); ctx.scale(.78 + Math.abs(Math.sin(G.clock * 1.8 + i.x * .01)) * .22, 1); box(-10, -14, 20, 28, '#edbc63', '#5e442b', 3, 2); ctx.fillStyle = '#624e34'; ctx.beginPath(); ctx.arc(0, -7, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff1b5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-5, 2); ctx.lineTo(5, 2); ctx.moveTo(-5, 7); ctx.lineTo(3, 7); ctx.stroke(); ctx.restore(); }
    else if (i.kind === 'pressure') { box(i.x - 11, y - 17, 22, 34, '#65b4ad', '#183d48', 5, 2); box(i.x - 7, y - 22, 14, 7, '#ebc37e', '#17343d', 2); ctx.fillStyle = '#edecd0'; ctx.fillRect(i.x - 8, y - 5, 16, 5); ctx.fillStyle = '#b5f3db'; ctx.fillRect(i.x - 3, y + 3, 6, 8); }
    else { box(i.x - 14, y - 15, 28, 28, '#e7d7a6', '#314548', 7); ctx.fillStyle = '#54b484'; ctx.fillRect(i.x - 3, y - 9, 6, 18); ctx.fillRect(i.x - 9, y - 3, 18, 6); }
  }
}
function vent(v) { ctx.save(); ctx.translate(v.x, v.y); box(-27, -12, 54, 17, '#735a47', '#152f37', 5); for (let i = -16; i < 22; i += 10) { ctx.fillStyle = '#182e34'; ctx.fillRect(i, -8, 5, 9); } if (v.warning) { ctx.fillStyle = `rgba(255,185,83,${.3 + Math.sin(G.clock * 30) * .2})`; ctx.beginPath(); ctx.moveTo(-32, -15); ctx.lineTo(0, -50); ctx.lineTo(32, -15); ctx.fill(); text('!', 0, -23, 18, '#fff1be', 'center'); } if (v.active) { for (let k = 0; k < 4; k++) { ctx.strokeStyle = `rgba(175,245,232,${.36 - k * .06})`; ctx.lineWidth = 11 - k * 1.4; ctx.beginPath(); ctx.moveTo(-19 + k * 12, -12); for (let y = -20; y > -130; y -= 12) ctx.lineTo(-19 + k * 12 + Math.sin(y * .1 + G.clock * 34 + k) * 8, y); ctx.stroke(); } ctx.fillStyle = 'rgba(184,254,239,.06)'; ctx.fillRect(-30, -130, 60, 120); } ctx.restore(); }
function spring(s) {
  ctx.save(); ctx.translate(s.x, s.y); const c = s.fired > 0 ? -14 * Math.sin(s.fired / .3 * Math.PI) : Math.abs(G.player.x - s.x) < 45 && Math.abs(G.player.y - s.y) < 30 ? 6 : 0;
  if (s.vx) { ctx.rotate(Math.atan2(s.vx, -s.vy) * .55); }
  box(-31, -9, 62, 13, '#94723f', '#152c35', 4); ctx.strokeStyle = '#9ba69a'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-13, -11); for (let i = 0; i < 5; i++) ctx.lineTo(i % 2 ? 14 : -14, -16 - i * (4 - c * .4)); ctx.stroke(); box(-30, -39 + c, 60, 14, s.vx ? '#e8623c' : '#eaab4c', '#18313a', 7); ctx.strokeStyle = '#ffe6a3'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-20, -36 + c); ctx.lineTo(20, -36 + c); ctx.stroke();
  if (s.vx) text('»', 0, -44 + c, 22, '#ffe6a3', 'center', 900); ctx.restore();
}
function crate(c) { if (c.broken) return; ctx.save(); ctx.translate(c.x, c.y); box(-24, -48, 48, 48, patterns.metal_orange, '#1a3037', 4, 3); ctx.strokeStyle = '#dfc28e'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-17, -40); ctx.lineTo(17, -8); ctx.moveTo(17, -40); ctx.lineTo(-17, -8); ctx.stroke(); box(-11, -32, 22, 18, '#e4d29f', '#38453e', 3); text('!', 0, -18, 17, '#553d2e', 'center', 900); ctx.restore(); }
function sign(s) { ctx.save(); ctx.translate(s.x, s.y); ctx.fillStyle = '#2c4546'; ctx.fillRect(-4, -142, 8, 143); ctx.rotate(-.055); box(-70, -159, 140, 66, '#c8ba90', '#213b40', 6, 3); ctx.strokeStyle = '#817653'; ctx.lineWidth = 1; ctx.strokeRect(-64, -153, 128, 54); s.text.split('\n').forEach((l, i) => text(l, 0, -133 + i * 18, 12, '#3b4541', 'center', 900)); ctx.restore(); }
function exitDoor() { const e = G.level.exit, open = G.level.boss.dead; ctx.save(); ctx.translate(e.x, e.y); box(-48, -179, 96, 180, '#334b4d', '#102b34', 21, 5); box(-37, -165, 74, 160, open ? '#4fba9e' : '#2c4a50', '#ddba75', 14, 5); ctx.fillStyle = open ? '#a6f5c9' : '#7d9594'; ctx.globalAlpha = open ? .22 : .08; ctx.fillRect(-27, -155, 54, 145); ctx.globalAlpha = 1; ring(0, -95, 28, open ? '#a4d798' : '#c08747'); text(open ? 'EXIT' : 'LOCKED', 0, -190, 15, open ? '#cbf5c1' : '#c9c9ae', 'center', 900); if (open) { text('→', 0, -37, 40, '#edffd4', 'center', 900); ctx.strokeStyle = '#b1edc2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -95, 38 + Math.sin(G.clock * 5) * 3, 0, Math.PI * 2); ctx.stroke(); glow(0, -95, 170, '#a6f5c9', .25); } ctx.restore(); }
function hookRing(h) {
  const p = G.player, near = !p.swing && !p.grounded && P.nearestHook(G.level, p) === h, held2 = p.swing && p.swing.hook === h;
  chainLine(h.x, Math.min(h.anchorY, h.y - 60), h.y - 22, 0);
  if (h.ax) { ctx.fillStyle = '#0b222c'; ctx.fillRect(h.baseX - h.ax - 30, h.anchorY - 10, h.ax * 2 + 60, 12); box(h.x - 20, h.anchorY - 16, 40, 22, '#8f7444', '#0b222c', 4, 3); }
  ctx.save(); ctx.translate(h.x, h.y); if (near) glow(0, 0, 70, '#ffe19d', .5 + Math.sin(G.clock * 10) * .15);
  ctx.strokeStyle = '#0b222c'; ctx.lineWidth = 13; ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = near || held2 ? '#ffe19d' : '#d59a45'; ctx.lineWidth = 7; ctx.stroke(); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, 19, 3.6, 4.9); ctx.stroke();
  if (near) { box(-17, 34, 34, 22, 'rgba(8,28,37,.85)', '#ffe19d', 5, 1.5); text('J', 0, 51, 14, '#ffe19d', 'center', 900); }
  ctx.restore();
}
function mover(q) {
  if (q.absent > 0) return; const b = G.level.biome; ctx.save(); if (q.timer > 0) ctx.translate(Math.sin(G.time * 83) * 2, Math.cos(G.time * 61) * 1.5);
  const x = q.x, y = q.y, w = q.w;
  if (q.kind === 'wheel') { ctx.strokeStyle = '#0b1a26'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x + 14, y); ctx.lineTo(x + w / 2, y - 62); ctx.lineTo(x + w - 14, y); ctx.stroke(); box(x + w / 2 - 9, y - 70, 18, 18, '#f2c75c', '#0b1a26', 9, 3); box(x, y, w, 40, mix(b.floor, '#b23a8a', .5), '#0b1a26', [4, 4, 16, 16], 3); ctx.fillStyle = '#f1d9c0'; for (let k = 0; k < 3; k++) ctx.fillRect(x + 12 + k * (w - 34) / 2, y + 16, 10, 22); }
  else { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 6, y + 22, w - 12, 8); box(x, y, w, 26, q.kind === 'crumble' ? '#765366' : '#537373', '#10232c', 5, 3); }
  ctx.fillStyle = b.cap; ctx.fillRect(x + 3, y + 2, w - 6, 9); ctx.fillStyle = '#fff0bd'; ctx.fillRect(x + 3, y + 1, w - 6, 2.4);
  if (q.kind === 'moving') { ctx.fillStyle = b.accent; ctx.fillRect(x + w / 2 - 15, y + 16, 30, 4); ctx.fillStyle = '#10232c'; ctx.beginPath(); ctx.arc(x + 14, y + 17, 3.5, 0, Math.PI * 2); ctx.arc(x + w - 14, y + 17, 3.5, 0, Math.PI * 2); ctx.fill(); }
  if (q.kind === 'crumble') { ctx.strokeStyle = '#e1accc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + w * .3, y + 4); ctx.lineTo(x + w * .4, y + 13); ctx.lineTo(x + w * .35, y + 19); ctx.lineTo(x + w * .5, y + 25); ctx.moveTo(x + w * .7, y + 3); ctx.lineTo(x + w * .64, y + 14); ctx.stroke(); }
  ctx.restore();
}
function wheelFrame(q) {
  const b = G.level.biome, a0 = G.time * q.speed; ctx.save(); ctx.translate(q.cx, q.cy); ctx.lineCap = 'round';
  ctx.strokeStyle = mix(b.shadow, '#000000', .2); ctx.lineWidth = 22; ctx.beginPath(); ctx.moveTo(-190, q.radius + 380); ctx.lineTo(0, 0); ctx.lineTo(190, q.radius + 380); ctx.stroke();
  ctx.strokeStyle = '#6b3a86'; ctx.lineWidth = 12; ctx.beginPath(); ctx.arc(0, 0, q.radius - 62, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = '#3c2356'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(0, 0, q.radius * .55, 0, Math.PI * 2); ctx.stroke();
  for (let k = 0; k < q.count; k++) { const a = a0 + k / q.count * Math.PI * 2; ctx.strokeStyle = '#4a2a66'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * (q.radius - 62), Math.sin(a) * (q.radius - 62)); ctx.stroke(); }
  for (let k = 0; k < q.count * 3; k++) { const a = a0 + k / (q.count * 3) * Math.PI * 2, on = Math.sin(G.clock * 4 + k) > -.2, col = ['#ffd978', '#ff8fd0', '#8fe7ff'][k % 3]; ctx.fillStyle = on ? col : mix(col, '#000000', .6); ctx.beginPath(); ctx.arc(Math.cos(a) * (q.radius - 62), Math.sin(a) * (q.radius - 62), 6, 0, Math.PI * 2); ctx.fill(); }
  box(-34, -34, 68, 68, '#f2c75c', '#0b1a26', 34, 5); ctx.fillStyle = '#b23a8a'; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill(); glow(0, 0, 260, '#ff8fd0', .12); ctx.restore();
}
function enemy(e, a = 1) {
  const boss = e === G.level.boss;
  if (e.dead) { if ((e.death || 0) > .6 || boss) return; const d = e.death || 0; ctx.save(); ctx.globalAlpha = Math.max(0, 1 - d / .6); ctx.translate(e.x + (e.deathDir || 1) * d * 260, e.y - e.h * .5 - d * 330 + d * d * 900); ctx.rotate(d * 9 * (e.deathDir || 1)); ctx.scale(1 + d * .3, 1 - d * .3); image(e.type, -e.w * .5, -e.h * .5, e.w, e.h, e.dir < 0); ctx.restore(); return; }
  if (boss && !e.active && Math.abs(e.x - G.camera.x - W / 2) > W) return;
  const x = lerp(e.px ?? e.x, e.x, a), y = lerp(e.py ?? e.y, e.y, a), w = e.w, h = e.h; ctx.save();
  const gy = ['fly', 'charge', 'puffer'].includes(e.kind) ? P.groundBelow(G.level, x, y, 400) : y; if (gy !== null) { ctx.fillStyle = 'rgba(1,15,24,.26)'; ctx.beginPath(); ctx.ellipse(x, gy + 2, w * .38 * (gy === y ? 1 : .7), 7, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.translate(x, y); let bob = 0, sx = 1, sy = 1, rot = 0; const sq = e.squash || 0;
  if (!boss && ['walk', 'shield'].includes(e.kind)) { const st = Math.sin(e.t * (e.speed > 100 ? 16 : 10)); bob = -Math.abs(st) * 4; sy = 1 + st * .035; sx = 1 - st * .035; rot = Math.sin(e.t * (e.speed > 100 ? 8 : 5)) * .05; }
  else if (boss) { bob = Math.sin(e.t * 2) * 3; sy = 1 + Math.sin(e.t * 2) * .012; }
  if (e.kind === 'puffer') { sx = 1 + Math.sin(e.t * 3) * .07; sy = 1 - Math.sin(e.t * 3) * .04; } if (e.kind === 'fly') rot = Math.sin(e.t * 1.7 + e.phase) * .08; if (e.kind === 'turret') { sy = 1 + Math.sin(e.t * 2.4) * .015; }
  if (e.kind === 'charge') { if (e.windup > 0) { rot = Math.sin(G.time * 45) * .05; sx = .9; sy = 1.1; } else if (e.charging > 0) { sx = 1.18; sy = .86; } }
  if (boss && e.attackPhase === 'windup') { sx = 1.06; sy = .93; rot = Math.sin(G.time * 60) * .014; } if (boss && e.attackPhase === 'attack' && e.moveAttack) { sx = 1.08; sy = .95; rot = e.chargeDir * .06; } if (boss && e.attackPhase === 'recover') rot = Math.sin(G.time * 8) * .03;
  sx *= 1 + sq * .16; sy *= 1 - sq * .14;
  ctx.rotate(rot); ctx.scale(sx, sy); if (e.hit > 0) ctx.filter = 'brightness(1.7) saturate(.6)'; image(boss ? e.sprite : e.type, -w / 2, -h + bob, w, h, e.dir < 0); ctx.filter = 'none';
  if (e.windup > 0 || boss && e.attackPhase === 'windup' || !boss && e.cool < .45 && ['fly', 'turret', 'puffer'].includes(e.kind) && Math.abs(G.player.x - e.x) < 680 && Math.abs(G.player.y - e.y) < 400) { ctx.fillStyle = '#f6a158'; ctx.beginPath(); ctx.arc(0, -h - 18, 13, 0, Math.PI * 2); ctx.fill(); text('!', 0, -h - 11, 20, '#301f22', 'center', 900); }
  if (e.shield || e.kind === 'director' && e.attackPhase === 'idle') { ctx.strokeStyle = 'rgba(148,235,228,.65)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, -h * .48, h * .5, e.dir === 1 ? -1.18 : 1.96, e.dir === 1 ? 1.18 : 4.32); ctx.stroke(); }
  if (!boss && e.hp < e.maxHp) { box(-w * .37, -h - 10, w * .74, 5, '#142b35', null, 2); box(-w * .37, -h - 10, w * .74 * Math.max(0, e.hp / e.maxHp), 5, '#ffcb77', null, 2); }
  ctx.restore();
}
function effects(a) {
  for (const e of G.effects) {
    if (e.kind === 'ghost') { const f = rig.face; rig.face = e.face > 0 ? -1 : 1; drawPlayer(e.x, e.y, { ...G.player, facing: e.face, invincible: 0, swing: null }, e.life / e.max * .22); rig.face = f; continue; }
    const t = 1 - e.life / e.max;
    if (e.kind === 'pad') { ctx.strokeStyle = `rgba(255,246,220,${1 - t})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(e.x, e.y, 30 + t * 70, 6 + t * 10, 0, 0, Math.PI * 2); ctx.stroke(); continue; }
    ctx.strokeStyle = `rgba(255,229,167,${(1 - t) * .8})`; ctx.lineWidth = (1 - t) * 16 + 2; ctx.beginPath(); ctx.arc(e.x, e.y, t * 350, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = `rgba(160,255,225,${(1 - t) * .8})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(e.x, e.y, t * 285, 0, Math.PI * 2); ctx.stroke();
  }
  for (const w of G.waves) { if (w.delay > 0) continue; const t = w.life / w.max; ctx.save(); ctx.translate(w.x, w.y); if (w.vy) ctx.rotate(-Math.PI / 2); else ctx.scale(w.vx > 0 ? 1 : -1, 1); ctx.strokeStyle = `rgba(230,255,233,${t})`; ctx.lineWidth = 5 + t * 4; ctx.beginPath(); ctx.arc(-20, 0, 42 + (1 - t) * 23, -1.18, 1.18); ctx.stroke(); ctx.strokeStyle = `rgba(122,233,222,${t * .6})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(-29, 0, 56 + (1 - t) * 20, -1.2, 1.2); ctx.stroke(); for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(-45, k * 18); ctx.lineTo(-8, k * 23); ctx.stroke(); } ctx.restore(); }
  for (const b of G.bullets) { ctx.save(); ctx.translate(lerp(b.px ?? b.x, b.x, a), lerp(b.py ?? b.y, b.y, a)); ctx.rotate(G.time * 5); if (b.kind === 'star') { ctx.fillStyle = '#ffca72'; ctx.strokeStyle = '#62334d'; ctx.lineWidth = 2; ctx.beginPath(); for (let i = 0; i < 10; i++) { const an = i * Math.PI / 5, r = i % 2 ? 5 : 12; if (!i) ctx.moveTo(Math.cos(an) * r, Math.sin(an) * r); else ctx.lineTo(Math.cos(an) * r, Math.sin(an) * r); } ctx.closePath(); ctx.fill(); ctx.stroke(); } else if (b.kind === 'floor') { ctx.rotate(-G.time * 5); ctx.strokeStyle = '#ffd3a1'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, 18, Math.PI, Math.PI * 2); ctx.stroke(); } else { ctx.fillStyle = '#ff9b66'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#ffefd0'; ctx.beginPath(); ctx.arc(-2, -2, 4, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); }
  for (const p of G.particles) { ctx.globalAlpha = clamp(p.life / .35, 0, 1); ctx.fillStyle = ctx.strokeStyle = p.color; const x = lerp(p.px, p.x, a), y = lerp(p.py, p.y, a); if (p.kind === 'bubble') { ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.stroke(); } else { ctx.save(); ctx.translate(x, y); ctx.rotate(G.time * 6 + p.x); ctx.fillRect(-p.size * .5, -p.size * .5, p.size, p.size * .55); ctx.restore(); } }
  ctx.globalAlpha = 1; for (const f of G.floaters) { ctx.globalAlpha = clamp(f.life / .3, 0, 1); ctx.strokeStyle = '#172e35'; ctx.lineWidth = 4; ctx.font = `900 ${f.size}px Arial`; ctx.textAlign = 'center'; ctx.strokeText(f.s, f.x, f.y); text(f.s, f.x, f.y, f.size, f.color, 'center', 900); } ctx.globalAlpha = 1;
}
function hud() {
  const p = G.player, b = G.level.biome; box(18, 17, 317, 74, '#122d36', '#c39960', 14); box(25, 23, 61, 61, '#194552', '#e6ba72', 14, 3); ctx.save(); ctx.beginPath(); ctx.roundRect(28, 26, 55, 55, 11); ctx.clip(); image('portrait', 26, 24, 60, 61); ctx.restore(); text('HULL INTEGRITY', 99, 36, 10, '#c6c9b2', 'left', 900);
  const ratio = p.hp / p.maxHp; for (let i = 0; i < 6; i++) { box(99 + i * 31, 45, 26, 17, '#294642', null, 3); if (ratio > i / 6) box(101 + i * 31, 47, 22 * clamp((ratio - i / 6) * 6, 0, 1), 13, ratio > .34 ? '#8ae1ab' : '#f69a72', null, 2); }
  text(Math.ceil(p.hp) + ' / ' + p.maxHp, 315, 77, 10, '#e9dcc0', 'right'); text('UNSINKABLE / OCCUPANT: CLAX', 100, 78, 8, '#829e9c');
  box(346, 18, 232, 72, '#142f38', p.floating ? '#b5f3db' : '#607f7b', 13); text(p.floating ? 'PRESSURE · INFLATING' : 'PRESSURE', 362, 38, 10, '#b4d0c5', 'left', 900); text(Math.round(p.pressure) + ' PSI', 560, 38, 13, '#c4f8e0', 'right', 900); box(362, 48, 199, 17, '#0b222c', null, 4); box(364, 50, 195 * p.pressure / 100, 13, p.pressure < 24 ? '#e59a6a' : '#62cdbf', null, 3); text('SNAP J   DASH K   FLOAT: HOLD JUMP', 362, 79, 8, '#92afa7');
  box(589, 18, 174, 72, p.over >= 50 ? '#48372c' : '#192e35', p.over >= 50 ? '#e8b55d' : '#556d69', 13); text('OVERPRESSURE', 603, 38, 10, '#e6d2a9', 'left', 900); box(603, 49, 142, 12, '#0e252d', null, 3); box(605, 51, 138 * p.over / 100, 8, p.over >= 50 ? '#efb95d' : '#9c8b69', null, 2); text(p.over >= 50 ? 'Q / Y  ·  RELIEF BURST' : 'CHARGES WITH HITS + RESCUES', 603, 79, 8, p.over >= 50 ? '#ffe0a0' : '#8e9f95');
  text(String(G.score).padStart(7, '0'), 1257, 43, 27, '#fff0c6', 'right', 900); text('TAGS  ' + String(G.tags).padStart(3, '0') + '     WITNESSES  ' + G.rescued + '/3', 1257, 66, 11, '#c4ded1', 'right', 800); text(b.tag, 1257, 86, 10, '#86b7b6', 'right', 800);
  if (G.combo > 1) { text(G.combo + '×', 34, 131, 33, '#f9cd77', 'left', 900); text(G.combo >= 5 ? 'PUBLIC NUISANCE!' : 'RESCUE STREAK', 94, 123, 11, '#f8ddb0', 'left', 900); box(94, 131, 100 * clamp(G.comboTime / 4, 0, 1), 3, '#efbe68', null, 1); }
  const boss = G.level.boss; if (boss.active && !boss.dead) { const x = 410, y = 116, w = 460; box(x - 12, y - 23, w + 24, 46, 'rgba(10,24,33,.89)', '#8d775c', 8, 1); text(boss.name, x, y - 6, 11, '#edcf97', 'left', 900); text(boss.attackPhase === 'recover' ? 'EXPOSED' : boss.attackPhase === 'windup' ? 'MOVE!' : boss.kind === 'director' && boss.attackPhase === 'idle' ? 'SHIELDED' : '', x + w, y - 6, 10, '#a9eddb', 'right', 900); box(x, y, w, 10, '#24343b', null, 3); box(x + 1, y + 1, (w - 2) * Math.max(0, boss.hp / boss.maxHp), 8, '#ee9563', null, 2); }
  if (G.toastTimer > 0 && G.toast) { ctx.save(); ctx.globalAlpha = Math.min(1, G.toastTimer / .3); const y = boss.active && !boss.dead ? 163 : 122; ctx.font = '900 15px Arial'; const w = clamp(Math.max(ctx.measureText(G.toast.s).width, G.toast.sub.length * 6.4) + 60, 420, 900); box(640 - w / 2, y, w, G.toast.sub ? 63 : 42, 'rgba(11,35,43,.92)', '#768f7c', 11, 1.5); text(G.toast.s, 640, y + 26, 15, '#ffe0a0', 'center', 900); if (G.toast.sub) text(G.toast.sub, 640, y + 47, 12, '#c7ded2', 'center', 500); ctx.restore(); }
  if (G.chapterTimer > 0) { const a = Math.min(1, G.chapterTimer / .6, (3.6 - G.chapterTimer) * 2); if (a > 0) { ctx.save(); ctx.globalAlpha = a; box(306, 228, 668, 116, 'rgba(10,29,38,.87)', '#b38d57', 10, 1.5); text('EXPEDITION ' + String(G.level.index + 1).padStart(2, '0') + ' / ' + b.subtitle, 640, 257, 11, '#a5d4c7', 'center', 900); text(b.name.toUpperCase(), 640, 301, 35, '#ffe8ad', 'center', 900); text(G.level.objective, 640, 328, 12, '#c7dacf', 'center', 500); ctx.restore(); } }
  else if (G.areaTimer > 0 && G.area) { const a = Math.min(1, G.areaTimer / .5, (4.2 - G.areaTimer) * 2.5); ctx.save(); ctx.globalAlpha = a; const sl = (1 - Math.min(1, (4.2 - G.areaTimer) * 3)) * -40; ctx.fillStyle = 'rgba(8,24,32,.82)'; ctx.fillRect(0 + sl, 566, 520, 62); ctx.fillStyle = b.edge; ctx.fillRect(0 + sl, 566, 8, 62); text(G.area.name, 30 + sl, 596, 25, '#ffe8ad', 'left', 900); text(G.area.sub, 30 + sl, 616, 12, '#bcd6cc', 'left', 500); ctx.restore(); }
  const touch = $('#touch').classList.contains('available');
  if (G.speechTimer > 0 && G.speech) {
    const sp = G.speech.speaker, col = { ADA: '#67bdb5', DOT: '#9fd38a', DRYDOCK: '#e58a52', REFUND: '#e38fd0' }[sp] || '#b38c58'; ctx.font = '400 15px Arial'; const w = clamp(ctx.measureText(G.speech.s).width + 150, 420, 1120), y = touch ? 486 : 640, x = (W - w) / 2; ctx.save(); ctx.globalAlpha = Math.min(1, G.speechTimer / .25);
    box(x, y, w, 56, 'rgba(8,28,37,.93)', col, 9, 1.5); ctx.save(); ctx.beginPath(); ctx.roundRect(x + 6, y + 6, 44, 44, 7); ctx.clip(); ctx.fillStyle = '#17353f'; ctx.fillRect(x + 6, y + 6, 44, 44); const im = images[sp === 'CLAX' ? 'portrait' : sp === 'DRYDOCK' ? 'warden' : sp === 'REFUND' ? 'carnival' : sp === 'ADA' ? 'buoy' : 'portrait']; if (sp === 'DOT') { ctx.fillStyle = '#9fd38a'; ctx.beginPath(); ctx.arc(x + 28, y + 30, 13, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#17353f'; ctx.fillRect(x + 21, y + 26, 4, 5); ctx.fillRect(x + 31, y + 26, 4, 5); } else if (im) ctx.drawImage(im, x + 6, y + 6, 44, 44 * im.height / im.width); ctx.restore();
    text(sp, x + 62, y + 21, 9, col, 'left', 900); text('“' + G.speech.s + '”', x + 62, y + 41, 15, '#f0ead1', 'left', 400); ctx.restore();
  }
}
const patterns = {}; for (const n of ['metal_orange', 'metal_teal', 'purple']) patterns[n] = ctx.createPattern(images[n], 'repeat');
let lastDraw = performance.now();
function draw(a = 1) {
  const start = performance.now(), fdt = clamp((start - lastDraw) / 1000, 0, .05); lastDraw = start;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#07141e'; ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr); ctx.translate(viewX, viewY); ctx.scale(viewScale, viewScale); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  const menu = ['title', 'stages', 'settings', 'guide'].includes(G.mode), cx = menu ? G.clock * 12 : lerp(G.camera.px, G.camera.x, a), cy = menu ? Math.max(0, G.level.height - H - 200) : lerp(G.camera.py, G.camera.y, a);
  backdrop(cx, cy, G.clock);
  if (menu) { ctx.fillStyle = 'rgba(5,20,29,.28)'; ctx.fillRect(0, 0, W, H); }
  else {
    const L = G.level, p = G.player; ctx.save(); if (G.shake > 0) ctx.translate(Math.sin(G.clock * 93) * G.shake * .65, Math.cos(G.clock * 119) * G.shake * .5); ctx.translate(-Math.round(cx * 2) / 2, -Math.round(cy * 2) / 2);
    const vis = (x, y, m = 140) => x > cx - m && x < cx + W + m && y > cy - m - 200 && y < cy + H + m + 200;
    for (const d of L.deco) if (['crane', 'tent'].includes(d.t) && vis(d.x, d.y, 700)) drawDeco(d, G.clock);
    drawChunks('b', cx, cy);
    for (const d of L.deco) if (!['crane', 'tent'].includes(d.t) && vis(d.x + (d.w || 0) * TS / 2, d.y, 200 + (d.w || d.len || 0) * TS)) drawDeco(d, G.clock);
    for (const q of L.movers) if (q.kind === 'wheel' && q.hub && vis(q.cx, q.cy, 900)) wheelFrame(q);
    for (const s of L.signs) if (vis(s.x, s.y)) sign(s); for (const c of L.checkpoints) if (vis(c.x, c.y)) checkpoint(c);
    exitDoor(); drawChunks('f', cx, cy);
    for (const q of L.movers) if (vis(q.x, q.y, 260)) mover(q); for (const h of L.hooks) if (vis(h.x, h.y, 500)) hookRing(h);
    for (const v of L.vents) if (vis(v.x, v.y)) vent(v); for (const s of L.springs) if (vis(s.x, s.y)) spring(s); for (const c of L.crates) if (vis(c.x, c.y)) crate(c);
    pickups(cx, cy); for (const n of L.npcs) if (vis(n.x, n.y)) npc(n);
    for (const e of L.enemies) if (vis(e.x, e.y, 200)) enemy(e, a); enemy(L.boss, a);
    if (p && G.deathTimer <= 0) {
      const x = lerp(p.px, p.x, a), y = lerp(p.py, p.y, a); if (G.mode === 'play' && G.hitstop <= 0) updateRig(p, fdt);
      if (p.grounded) { ctx.fillStyle = 'rgba(0,18,25,.3)'; ctx.beginPath(); ctx.ellipse(x, y + 2, 49, 7, 0, 0, Math.PI * 2); ctx.fill(); }
      drawPlayer(x, y, p);
    }
    effects(a); ctx.restore();
    // foreground: soft vignette keeps the eye on the play plane
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * .45, W / 2, H / 2, H * .95); vg.addColorStop(0, 'rgba(3,10,18,0)'); vg.addColorStop(1, 'rgba(3,10,18,.42)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    if (p) hud();
    if (['pause', 'clear', 'dialogue'].includes(G.mode)) { ctx.fillStyle = G.mode === 'dialogue' ? 'rgba(4,15,23,.34)' : 'rgba(4,15,23,.68)'; ctx.fillRect(0, 0, W, H); }
    if (G.deathTimer > 0) { ctx.fillStyle = `rgba(12,23,31,${.25 + Math.sin(G.deathTimer / .85 * Math.PI) * .25})`; ctx.fillRect(0, 0, W, H); text('EMERGENCY RELOCATION', 640, 335, 34, '#ffe0a4', 'center', 900); text('Please disregard the previous landing.', 640, 368, 16, '#b6d7cc', 'center', 500); }
  }
  ctx.restore(); G.renderSamples.push(performance.now() - start); if (G.renderSamples.length > 1800) G.renderSamples.shift();
}
function frame(now) {
  const raw = (now - last) / 1000; last = now; const elapsed = Math.min(.08, Math.max(0, raw)); if (raw > 0 && raw < .5) G.fps = ease(G.fps, 1 / raw, 2, elapsed); pollPad();
  if (!G.testMode) { accum += elapsed; let ticks = 0; while (accum >= STEP && ticks++ < 12) { update(STEP); accum -= STEP; } if (ticks >= 12) accum = 0; }
  draw(G.testMode ? 1 : clamp(accum / STEP, 0, 1)); G.frames++; requestAnimationFrame(frame);
}
showTitle(); requestAnimationFrame(frame);
if (new URLSearchParams(location.search).has('test') || window.CLAX_TEST) {
  window.CLAX_DEBUG = { G, DB, P, STEP, images, rig, tick: update, setHeld: (keys = []) => { held.clear(); keys.forEach(k => held.add(k)); }, silence: () => { audio.enabled = false; audio.running = false; },
    start: (i = 0) => start(i, true), pauseSimulation: (v = true) => { G.testMode = v; clearInput(); },
    snapshot: () => ({ mode: G.mode, level: G.level.index, x: G.player?.x, y: G.player?.y, vx: G.player?.vx, vy: G.player?.vy, grounded: G.player?.grounded, hp: G.player?.hp, pressure: G.player?.pressure, over: G.player?.over, tags: G.tags, rescued: G.rescued, score: G.score, deaths: G.deaths, elapsed: G.elapsed, checkpoint: G.checkpoint, alive: G.level.enemies.filter(e => !e.dead).length, boss: { hp: G.level.boss.hp, dead: G.level.boss.dead, active: G.level.boss.active }, frames: G.frames, fps: G.fps }),
    advance: (seconds, keys = [], pose = true) => { held.clear(); keys.forEach(k => held.add(k)); for (let i = 0; i < Math.ceil(seconds / STEP); i++) { update(STEP); if (pose && i % 2 === 0 && G.player && G.mode === 'play') updateRig(G.player, STEP * 2); } lastDraw = performance.now(); draw(1); return CLAX_DEBUG.snapshot(); },
    press, teleport: (x, y) => { const p = G.player; p.x = p.px = x; p.y = p.py = y; p.vx = p.vy = 0; p.grounded = false; p.support = null; p.swing = null; snapCamera(); },
    damageEnemy, damagePlayer, burst, snap, die, respawn, draw: () => { lastDraw = performance.now(); draw(1); }, skipDialogue, finishLevel, screen,
    renderStats: () => { const a = G.renderSamples.slice().sort((a, b) => a - b); return { samples: a.length, mean: a.reduce((s, x) => s + x, 0) / a.length, p50: a[Math.floor(a.length * .5)], p95: a[Math.floor(a.length * .95)], max: a[a.length - 1] }; }, clearMetrics: () => G.renderSamples = [], getHeld: () => Array.from(held) };
}
window.CLAX_READY = true; $('#loading').remove();
})();
