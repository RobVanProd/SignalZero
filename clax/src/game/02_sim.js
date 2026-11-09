// Simulation: player actions, combat, enemies, triggers, camera ------------------------------------------
function particles(x, y, n, color = '#ffd98b', force = 150, kind = 'spark', bias = null) {
  for (let i = 0; i < n; i++) { if (G.particles.length > 460) G.particles.shift(); const a = rand() * Math.PI * 2, v = (.3 + rand() * .7) * force; G.particles.push({ x, y, px: x, py: y, vx: Math.cos(a) * v + (bias ? bias[0] : 0), vy: Math.sin(a) * v - 40 + (bias ? bias[1] : 0), life: .35 + rand() * .5, size: 2 + rand() * 5, color, kind }); }
}
function floater(s, x, y, color = '#ffe19d', size = 21) { G.floaters.push({ s, x, y, life: 1.1, color, size }); }
function shake(n) { if (save.settings.shake) G.shake = Math.max(G.shake, n); }
function shoot(x, y, vx, vy, kind = 'bolt', damage = 1) { G.bullets.push({ x, y, px: x, py: y, vx, vy, r: kind === 'floor' ? 15 : 9, kind, damage, life: kind === 'floor' ? 3.5 : 4 }); }
function damagePlayer(d, x) {
  const p = G.player; if (p.invincible > 0 || p.dashTime > 0 || G.deathTimer > 0) return;
  p.hp -= save.settings.assist ? d * .5 : d; p.invincible = 1.25; p.flash = .25; p.hurt = .45; p.swing = null; p.vx = x < p.x ? 260 : -260; p.vy = -330; p.grounded = false; p.support = null; p.floating = false;
  G.combo = 0; G.comboTime = 0; shake(8); audio.fx('hurt'); particles(p.x, p.y - 60, 16, '#ffb37a', 200); rigKick(0, -8); slosh(x < p.x ? 1 : -1, 1); quip('hurt'); if (p.hp <= 0) die();
}
function die() { if (G.deathTimer > 0) return; G.deathTimer = .85; G.deaths++; shake(12); audio.fx('burst'); particles(G.player.x, G.player.y - 60, 36, '#f4bf64', 310); quip('death', 'CLAX', true); G.bullets = []; }
function respawn() {
  const old = G.player; G.player = makePlayer(G.checkpoint.x, G.checkpoint.y); G.player.over = Math.max(40, old.over); G.player.invincible = 2; G.safe = { ...G.checkpoint }; resetRig(); snapCamera();
  G.bullets = []; G.waves = []; G.combo = 0; G.hitstop = 0; Object.assign(G.level.boss, { attackPhase: 'idle', phaseTime: 0, cool: 1.8 }); if (!G.level.boss.dead) { G.level.boss.active = false; audio.boss = false; }
  toast('EMERGENCY RELOCATION', 'The suit refuses to discuss the landing.', 2);
}
/* Falling out of the world costs one hull point and puts you back on the last solid ground. */
function fellOut() {
  const p = G.player; p.hp -= save.settings.assist ? .5 : 1; G.combo = 0; audio.fx('hurt'); shake(6);
  if (p.hp <= 0) { die(); return; }
  Object.assign(p, { x: G.safe.x, y: G.safe.y, px: G.safe.x, py: G.safe.y, vx: 0, vy: 0, grounded: true, swing: null, dashTime: 0, jumps: 0, invincible: 1.6, floating: false, wall: 0, launch: 0 });
  resetRig(); snapCamera(); particles(p.x, p.y - 60, 18, '#a4f1e8', 160, 'bubble'); if (rand() < .6) quip('fall', 'ADA', true);
}
function snap() {
  const p = G.player; if (p.attackCool > 0 || p.dashTime > 0 || p.swing) return;
  if (!p.grounded) { const h = P.nearestHook(G.level, p); if (h) { P.latch(p, h); p.attackCool = .25; audio.fx('latch'); particles(h.x, h.y, 10, '#ffe19d', 130); if (rand() < .3) quip('swing'); return; } }
  if (p.pressure < 10) return;
  const up = held.has('up') && !held.has('left') && !held.has('right');
  p.attackCool = .28; p.attack = .24; p.attackUp = up; p.pressure -= 10; p.sinceAttack = 0; if (!up) p.vx -= p.facing * (p.grounded ? 40 : 28); p.over = clamp(p.over + .65, 0, 100);
  G.waves.push(up ? { x: p.x + p.facing * 22, y: p.y - 150, vx: p.facing * 60, vy: -820, r: 44, life: .26, max: .26, hit: new Set(), damage: 2, delay: .05 }
                  : { x: p.x + p.facing * 62, y: p.y - 70, vx: p.facing * 890, vy: 0, r: 42, life: .245, max: .245, hit: new Set(), damage: 2, delay: .05 });
  particles(p.x + p.facing * 76, p.y - 70, 8, '#c8fff3', 150, 'bubble'); audio.fx('snap'); shake(2.5); slosh(-p.facing, .5); if (rand() < .12) quip('snap');
}
function dash() {
  const p = G.player; if (p.dashCool > 0 || p.pressure < 24 || (!p.grounded && p.airDash) || p.swing || p.crouch) return;
  p.pressure -= 24; p.sinceAttack = 0; p.dashTime = P.K.dashTime; p.dashDir = p.wall ? -p.wall : p.facing; p.facing = p.dashDir; p.dashCool = .56; p.invincible = Math.max(p.invincible, .23); if (!p.grounded) p.airDash = true;
  p.vx = p.dashDir * P.K.dash; p.vy = 0; p.wall = 0; audio.fx('dash'); particles(p.x - p.dashDir * 38, p.y - 55, 20, '#b1f4df', 180, 'bubble', [-p.dashDir * 160, 0]); slosh(-p.dashDir, 1); if (rand() < .22) quip('dash');
}
function burst() {
  const p = G.player; if (p.over < 50) return; p.over -= 50; p.pressure = 100; p.invincible = Math.max(p.invincible, .7); p.vy = Math.min(p.vy, -260); if (p.swing) p.swing = null;
  G.effects.push({ kind: 'burst', x: p.x, y: p.y - 70, life: .65, max: .65 }); particles(p.x, p.y - 70, 65, '#ffdfa0', 430); shake(12); audio.fx('burst'); rigKick(0, 10); slosh(0, 1.4);
  for (const e of [...G.level.enemies, G.level.boss]) if (!e.dead && Math.hypot(e.x - p.x, e.y - e.h * .45 - (p.y - 70)) < 345) damageEnemy(e, 8, p.x, true);
  G.bullets = G.bullets.filter(b => Math.hypot(b.x - p.x, b.y - (p.y - 70)) > 360); for (const c of G.level.crates) if (!c.broken && Math.hypot(c.x - p.x, c.y - p.y) < 300) breakCrate(c); quip('burst', 'CLAX', true);
}
function damageEnemy(e, d, x, ignore = false) {
  if (e.dead) return; const boss = e === G.level.boss;
  const shield = !ignore && ((e.kind === 'shield' && e.shield && Math.sign(x - e.x) === e.dir) || (e.kind === 'director' && e.attackPhase === 'idle'));
  if (shield) { d *= .3; floater('CLANG', e.x, e.y - e.h, '#b7e9e2', 15); }
  e.hp -= d; e.hit = .16; e.squash = 1; if (!boss) e.kb = Math.sign(e.x - x) * (shield ? 40 : 150); G.player.over = clamp(G.player.over + 2.7, 0, 100); audio.fx('hit'); G.hitstop = .03; shake(boss ? 4 : 3); particles(e.x, e.y - e.h * .5, 7, '#ffe0a3', 170);
  if (e.hp <= 0) {
    e.dead = true; e.death = 0; e.deathDir = Math.sign(e.x - x) || 1; G.kills++; G.combo++; G.comboTime = 4; G.bestCombo = Math.max(G.bestCombo, G.combo); const score = (e.score || 1500) * Math.min(8, G.combo); G.score += score; floater('+' + score, e.x, e.y - e.h, '#ffe0a3', 25);
    particles(e.x, e.y - e.h * .45, boss ? 65 : 23, '#ffb45e', 240); G.player.over = clamp(G.player.over + 7, 0, 100);
    if (boss) { G.slow = .55; audio.boss = false; audio.fx('win'); G.bullets = []; G.player.hp = Math.min(G.player.maxHp, G.player.hp + 2); G.player.win = 1.6; toast('BUREAU OVERRULED', 'The way is open. Head for the exit hatch.', 4); say('Rescue successful. Dignity unrecoverable.', 'ADA', true); }
    else if (rand() < .24) G.level.pickups.push({ x: e.x, y: e.y - 50, kind: 'pressure' });
  }
}
function breakCrate(c) { if (c.broken) return; c.broken = true; particles(c.x, c.y - 25, 14, '#dfa565', 180); G.score += 75; G.level.pickups.push({ x: c.x, y: c.y - 55, kind: rand() < .35 ? 'health' : 'pressure' }); audio.fx('hit'); }

function physEvent(name, a) {
  const p = G.player;
  if (name === 'jump') { audio.fx('jump'); particles(p.x, p.y, 7, '#e3e0be', 120, 'bubble'); rigKick(0, -9); slosh(0, .6); }
  else if (name === 'double') { audio.fx('double'); particles(p.x, p.y - 10, 16, '#a4f1e8', 150, 'bubble', [0, 160]); rigKick(0, -12); slosh(0, .8); }
  else if (name === 'walljump') { audio.fx('walljump'); particles(p.x + a * 26, p.y - 50, 12, '#e3e0be', 150, 'spark', [-a * 120, 0]); rigKick(0, -9); slosh(a, 1); }
  else if (name === 'land') { const v = Math.min(1, a / 1000); if (a > 250) { audio.fx(a > 800 ? 'thud' : 'land'); particles(p.x, p.y, 4 + v * 10, '#e1c99c', 60 + v * 90, 'spark', [0, -30]); } rigKick(0, 6 + v * 26); slosh(0, v * 1.3); if (a > 950) { shake(4); if (rand() < .3) say(DB.lines.ada[2], 'ADA'); } }
  else if (name === 'bounce') { audio.fx('bounce'); particles(p.x, p.y, 10, '#fff0c6', 150, 'bubble'); rigKick(0, 20); slosh(0, 1.2); G.effects.push({ kind: 'pad', x: p.x, y: p.y, life: .3, max: .3 }); }
  else if (name === 'spring') { audio.fx('spring'); particles(a.x, a.y, 17, '#ffd97e', 200); rigKick(0, 16); slosh(0, 1.2); }
  else if (name === 'release') { audio.fx('release'); rigKick(0, -8); }
  else if (name === 'wall') { audio.fx('land'); }
  else if (name === 'crumble') audio.fx('crumble');
  else if (name === 'bonk') { rigKick(0, 8); slosh(0, .7); }
}

function update(dt) {
  G.clock += dt; for (const k of ['toastTimer', 'speechTimer', 'speechCool', 'areaTimer']) G[k] = Math.max(0, G[k] - dt); G.shake = Math.max(0, G.shake - dt * 22);
  if (G.mode !== 'play') return; if (G.hitstop > 0) { G.hitstop -= dt; return; } if (G.slow > 0) { G.slow -= dt; dt *= .45; }
  G.time += dt; G.elapsed += dt; G.chapterTimer = Math.max(0, G.chapterTimer - dt); G.comboTime -= dt; if (G.comboTime <= 0) G.combo = 0;
  const p = G.player, L = G.level, boss = L.boss; G.camera.px = G.camera.x; G.camera.py = G.camera.y;
  P.stepMovers(L, G.time, dt);
  if (G.deathTimer > 0) { G.deathTimer -= dt; updateEffects(dt); if (G.deathTimer <= 0) respawn(); return; }
  for (const k of ['snapBuffer', 'dashBuffer', 'burstBuffer', 'invincible', 'attack', 'attackCool', 'dashCool', 'flash', 'hurt', 'win']) p[k] = Math.max(0, p[k] - dt);
  p.sinceAttack += dt; if (p.floating) p.sinceAttack = 0; if (p.sinceAttack > .35) p.pressure = clamp(p.pressure + dt * 28, 0, 100);
  const inp = { x: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0), down: held.has('down'), jumpHeld: held.has('jump') };
  if (p.hurt > .2) inp.x = 0;
  if (held.has('snap') && p.attackCool <= 0 && !p.swing || p.snapBuffer > 0) { snap(); p.snapBuffer = 0; } if (p.dashBuffer > 0) { dash(); p.dashBuffer = 0; } if (p.burstBuffer > 0) { burst(); p.burstBuffer = 0; }
  const wasFloating = p.floating, wasGrounded = p.grounded, vx0 = p.vx;
  P.stepPlayer(p, inp, L, dt, physEvent);
  if (p.floating && !wasFloating) { audio.fx('inflate'); if (rand() < .15) quip('float'); }
  // presentation-only state
  p.idle = inp.x || !p.grounded || p.attack > 0 || inp.down ? 0 : p.idle + dt;
  if (p.grounded) { const before = Math.floor(p.stride / Math.PI); p.stride += Math.abs(p.vx) * dt * Math.PI / 62; if (Math.floor(p.stride / Math.PI) !== before && Math.abs(p.vx) > 120) { audio.fx('step'); if (Math.abs(p.vx) > 300) particles(p.x - p.facing * 14, p.y, 1, '#cdbf9c', 40, 'spark', [-p.facing * 40, -30]); } }
  p.skid = p.grounded && inp.x && Math.sign(p.vx) === -inp.x && Math.abs(p.vx) > 140 ? p.skid + dt : 0;
  if (p.skid > 0 && p.skid < dt * 1.5) { audio.fx('skid'); slosh(Math.sign(p.vx), .9); }
  if (p.skid > 0 && rand() < .5) particles(p.x + Math.sign(p.vx) * 20, p.y, 1, '#d9cba6', 60, 'spark', [Math.sign(p.vx) * 90, -50]);
  if (p.wall && rand() < .4) particles(p.x + p.wall * 30, p.y - 95, 1, '#ffd98b', 60, 'spark', [-p.wall * 40, 60]);
  if (p.floating && rand() < .3) particles(p.x + (rand() - .5) * 60, p.y - 20, 1, '#b9f5e6', 30, 'bubble');
  if (p.dashTime > 0 && rand() < .5) G.effects.push({ kind: 'ghost', x: p.x, y: p.y, face: p.facing, life: .2, max: .2 });
  if (Math.abs(p.vx - vx0) > 30 * dt * 60) slosh(Math.sign(vx0 - p.vx), Math.min(1, Math.abs(p.vx - vx0) / 300));
  if (wasGrounded && !p.grounded && p.vy >= 0 && !p.swing) rigKick(0, -4);

  // world limits, hazards, safe ground
  p.x = clamp(p.x, boss.active && !boss.dead ? boss.gate + 30 : 30, L.width - 30);
  if (boss.active && !boss.dead && p.x <= boss.gate + 31) p.vx = Math.max(0, p.vx);
  if (p.y > L.height + 220) { fellOut(); return; }
  if (P.hazard(L, p)) { const was = p.invincible <= 0; damagePlayer(1, p.x - p.facing * 10); if (was && G.deathTimer <= 0) { p.vy = -620; p.vx = -p.facing * 200; } }
  G.safeTimer -= dt;
  if (p.grounded && !p.support && !p.oneWay && G.safeTimer <= 0 && p.invincible <= 0) {
    G.safeTimer = .2; const a = P.probe(L, p.x - 44, p.y - 20, p.y + 30, false), b = P.probe(L, p.x + 44, p.y - 20, p.y + 30, false);
    if (a && b && !P.hazard(L, { x: p.x - 50, y: p.y }) && !P.hazard(L, { x: p.x + 50, y: p.y })) G.safe = { x: p.x, y: p.y };
  }
  for (const cp of L.checkpoints) if (Math.abs(p.x - cp.x) < 46 && Math.abs(p.y - cp.y) < 70 && !cp.active) { L.checkpoints.forEach(c => c.active = false); cp.active = true; G.checkpoint = { x: cp.x, y: cp.y }; p.hp = p.maxHp; p.pressure = 100; p.over = Math.max(p.over, 50); audio.fx('checkpoint'); particles(cp.x, cp.y - 60, 20, '#7ff2d7', 140, 'bubble'); toast('CHECKPOINT / AIR REFILLED', 'Your emergency has been saved.', 2.7); }
  for (const it of L.pickups) {
    if (it.taken) continue;
    if (Math.hypot(it.x - p.x, it.y - (p.y - 60)) < 72) {
      it.taken = true;
      if (it.kind === 'tag') { G.tags++; G.score += 25; p.over = clamp(p.over + .65, 0, 100); audio.fx('tag'); }
      else if (it.kind === 'health') { p.hp = Math.min(p.maxHp, p.hp + 2); audio.fx('rescue'); floater('+ HULL', p.x, p.y - 130, '#90efb5', 18); }
      else { p.pressure = Math.min(100, p.pressure + 28); p.over = clamp(p.over + 6, 0, 100); audio.fx('pressure'); }
      particles(it.x, it.y, 6, it.kind === 'tag' ? '#ffd98b' : '#8fe7da', 80);
    }
  }
  for (const n of L.npcs) if (!n.rescued && Math.abs(p.x - n.x) < 58 && Math.abs(p.y - n.y) < 95) {
    n.rescued = true; G.rescued++; G.score += 800; p.over = clamp(p.over + 18, 0, 100); p.hp = Math.min(p.maxHp, p.hp + 1); audio.fx('rescue'); particles(n.x, n.y - 45, 28, '#b7f7c1', 190);
    toast(`WITNESS LOGGED: ${n.name}`, `${n.who} — “${n.line}”`, 4.2); quip('rescue', 'CLAX', true);
  }
  for (const v of L.vents) { const ph = mod(G.time + v.phase, v.period); v.warning = ph > v.period - 1.2 && ph < v.period - .75; v.active = ph >= v.period - .75; if (v.active && Math.abs(p.x - v.x) < 31 && p.y > v.y - 125 && p.y - p.h < v.y) damagePlayer(1, v.x); }
  for (const s of L.springs) s.fired = Math.max(0, s.fired - dt);
  const inZone = z => !z.seen && p.x >= z.x && p.x < z.x + 900 && p.y >= z.y0 && p.y <= z.y1;
  for (const z of L.areas) if (inZone(z)) { z.seen = true; G.area = z; G.areaTimer = 4.2; }
  for (const z of L.hints) if (inZone(z)) { z.seen = true; toast(z.text, z.sub, 6); }
  for (const z of L.radio) if (inZone(z)) { z.seen = true; G.radioQueue.push(...z.script); }
  if (G.radioQueue.length && G.speechTimer <= 0) { const [who, line] = G.radioQueue.shift(); G.speech = { s: line, speaker: who }; G.speechTimer = Math.max(3.2, 1.8 + line.length * .05); G.speechCool = 5; audio.fx('radio'); }

  for (const e of L.enemies) updateEnemy(e, dt);
  if (p.x > boss.gate + 60 && Math.abs(p.y - boss.y) < 420 && !boss.active && !boss.dead) { boss.active = true; audio.boss = true; audio.fx('boss'); toast(boss.name, boss.title, 3.4); G.checkpoint = { x: boss.gate + 110, y: boss.y }; p.pressure = 100; p.over = Math.max(p.over, 50); G.radioQueue = []; }
  if (boss.active && !boss.dead) updateBoss(boss, dt);
  for (const w of G.waves) {
    if (w.delay > 0) { w.delay -= dt; continue; }
    w.x += w.vx * dt; w.y += w.vy * dt; w.life -= dt; if (P.pointSolid(L, w.x, w.y)) { w.life = 0; particles(w.x, w.y, 4, '#c8fff3', 90, 'bubble'); }
    for (const e of [...L.enemies, boss]) if (!e.dead && !w.hit.has(e) && !(e === boss && !e.active) && Math.abs(w.x - e.x) < e.w * .48 + w.r && w.y + w.r > e.y - e.h && w.y - w.r < e.y) { w.hit.add(e); damageEnemy(e, w.damage, w.vy ? e.x - e.dir : w.x - Math.sign(w.vx) * 90); }
    for (const c of L.crates) if (!c.broken && Math.abs(w.x - c.x) < 55 && w.y + w.r > c.y - c.h && w.y - w.r < c.y) breakCrate(c);
  }
  G.waves = G.waves.filter(w => w.life > 0);
  for (const b of G.bullets) {
    b.px = b.x; b.py = b.y; b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; if (b.kind !== 'floor' && P.pointSolid(L, b.x, b.y)) { b.life = 0; particles(b.x, b.y, 3, '#ffb37a', 70); }
    if (Math.abs(b.x - p.x) < p.w * .45 + b.r && b.y + b.r > p.y - p.h && b.y - b.r < p.y) { damagePlayer(b.damage, b.x); b.life = 0; }
  }
  G.bullets = G.bullets.filter(b => b.life > 0 && b.x > -150 && b.x < L.width + 150); updateEffects(dt); updateCamera(dt);
  if (boss.dead && Math.abs(p.x - L.exit.x) < 60 && Math.abs(p.y - L.exit.y) < 80 && p.grounded) finishLevel();
}

function cameraTarget() {
  const p = G.player, L = G.level, c = G.camera;
  if (p.grounded || p.swing || p.wall) c.anchor = p.y; else if (p.y > c.anchor + 40) c.anchor = p.y - 40; else if (p.y < c.anchor - 230) c.anchor = p.y + 230;
  return [clamp(p.x - W / 2 + c.lead, 0, L.width - W), clamp(c.anchor - 505 + c.look, 0, L.height - H)];
}
function updateCamera(dt) {
  const p = G.player, c = G.camera;
  c.lead = ease(c.lead, p.facing * 105 + clamp(p.vx * .16, -70, 70), 2.6, dt);
  c.look = ease(c.look, p.crouch && p.idle === 0 && Math.abs(p.vx) < 5 ? 150 : p.vy > 900 ? 120 : 0, p.crouch ? 1.4 : 3, dt);
  const [tx, ty] = cameraTarget(); c.x = ease(c.x, tx, 7, dt); c.y = ease(c.y, ty, p.grounded ? 5.5 : 7, dt);
}
function snapCamera() { const c = G.camera; c.lead = G.player.facing * 105; c.look = 0; c.anchor = G.player.y; const [tx, ty] = cameraTarget(); c.x = c.px = tx; c.y = c.py = ty; }

function updateEnemy(e, dt) {
  if (e.dead) { e.death = (e.death || 0) + dt; return; }
  const p = G.player, L = G.level, dx = p.x - e.x, dy = p.y - e.y; if (Math.abs(dx) > 1150 || Math.abs(dy) > 760) return;
  e.px = e.x; e.py = e.y; e.t += dt; e.hit = Math.max(0, e.hit - dt); e.cool -= dt; e.squash = Math.max(0, (e.squash || 0) - dt * 5);
  const near = Math.abs(dx) < 680 && Math.abs(dy) < 400; e.shield = e.kind === 'shield' && e.t % 3.1 < 1.9;
  const tryMove = (nx) => {            // ground walkers: stay on floors, turn at walls and ledges
    const g = P.probe(L, nx, e.y - 40, e.y + 44, true); if (!g || P.boxSolid(L, nx - e.w * .3, e.y - e.h * .8, nx + e.w * .3, e.y - 40) || L.grid[Math.floor((g.y - 8) / TS)]?.[Math.floor(nx / TS)] === '^') return false;
    e.x = nx; e.y = g.y; return true;
  };
  if (e.kb) { tryMove(e.x + e.kb * dt); e.kb = approach(e.kb, 0, 900 * dt); }
  if (['walk', 'shield'].includes(e.kind)) {
    if (e.type === 'eel' && Math.abs(dx) < 240 && Math.abs(dy) < 110) e.dir = Math.sign(dx) || 1; else { if (e.x <= e.originX - e.range) e.dir = 1; if (e.x >= e.originX + e.range) e.dir = -1; }
    if (!tryMove(e.x + e.dir * e.speed * dt)) e.dir *= -1;
  } else if (e.kind === 'fly') { e.x = e.originX + Math.sin(e.t * .75) * 70; e.y = e.originY + Math.sin(e.t * 1.7 + e.phase) * 35; e.dir = dx > 0 ? 1 : -1; }
  else if (e.kind === 'charge') {
    e.dir = dx > 0 ? 1 : -1; e.y = e.originY + Math.sin(e.t * 2) * 12;
    if (e.charging > 0) { e.charging -= dt; const nx = e.x + e.chargeDir * 400 * dt; if (P.pointSolid(L, nx + e.chargeDir * 40, e.y - 30)) e.charging = 0; else e.x = nx; }
    else if (near && Math.abs(dy) < 200 && e.cool < 0) { e.windup = .55; e.cool = 3.2; }
    if (e.windup > 0) { e.windup -= dt; if (e.windup <= 0) { e.charging = .6; e.chargeDir = e.dir; } }
    if (!(e.charging > 0) && !(e.windup > 0)) e.x = ease(e.x, e.originX, 1.8, dt);
  } else if (e.kind === 'puffer') { e.x = e.originX + Math.sin(e.t * .9) * 80; e.y = e.originY + Math.sin(e.t * 2.8) * 42; e.dir = dx > 0 ? 1 : -1; }
  else e.dir = dx > 0 ? 1 : -1;
  if (near && e.cool <= 0 && ['fly', 'turret', 'puffer'].includes(e.kind)) {
    e.cool = e.kind === 'turret' ? 2.1 : e.kind === 'puffer' ? 2.7 : 2.8; e.squash = 1; const sy = e.y - e.h * .55, a = Math.atan2(p.y - 60 - sy, p.x - e.x), v = e.kind === 'turret' ? 290 : 235;
    for (const spread of e.kind === 'puffer' ? [-.35, 0, .35] : [0]) shoot(e.x + e.dir * 25, sy, Math.cos(a + spread) * v, Math.sin(a + spread) * v, e.kind === 'puffer' ? 'star' : 'bolt');
  }
  contact(e);
}
function contact(e) {
  const p = G.player;
  if (Math.abs(e.x - p.x) < e.w * .36 + p.w * .42 && p.y > e.y - e.h * .85 && p.y - p.h < e.y - 8) {
    if (p.py <= e.y - e.h * .6 && p.vy > 100 && e.kind !== 'turret') { damageEnemy(e, 3, p.x, true); p.vy = held.has('jump') ? -760 : -560; p.grounded = false; p.jumps = 1; p.airDash = false; p.floatSpent = false; p.cut = true; p.bounce = .2; audio.fx('double'); rigKick(0, 14); }
    else if (p.dashTime > 0) { if (!e.dashHit || G.time - e.dashHit > .4) { e.dashHit = G.time; damageEnemy(e, 2, p.x, true); } }
    else damagePlayer(1, e.x);
  }
}
function updateBoss(e, dt) {
  const p = G.player; e.px = e.x; e.py = e.y; e.t += dt; e.hit = Math.max(0, e.hit - dt); e.squash = Math.max(0, (e.squash || 0) - dt * 5); e.dir = p.x < e.x ? -1 : 1; e.phaseTime += dt; const rage = e.hp < e.maxHp * .45 ? 1.22 : 1;
  if (e.attackPhase === 'idle') { e.cool -= dt * rage; e.x = ease(e.x, clamp(p.x - e.dir * 240, e.minX + 70, e.maxX - 50), .35, dt); if (e.cool <= 0) { e.attackPhase = 'windup'; e.phaseTime = 0; e.chargeDir = e.dir; audio.fx('warning'); } }
  else if (e.attackPhase === 'windup') {
    if (e.phaseTime > .72 / rage) {
      e.phaseTime = 0; e.attackPhase = 'attack'; e.attackCycle = (e.attackCycle || 0) + 1;
      if (e.kind === 'clamp' || e.kind === 'refund' && e.attackCycle % 3 === 0) e.moveAttack = true;
      else { e.moveAttack = false; const n = e.kind === 'refund' ? 5 : 3, sy = e.y - e.h * .53, a = Math.atan2(p.y - 65 - sy, p.x - e.x); for (let i = 0; i < n; i++) { const an = a + (i - (n - 1) / 2) * .22; shoot(e.x, sy, Math.cos(an) * 300 * rage, Math.sin(an) * 300 * rage, e.kind === 'refund' ? 'star' : 'bolt'); } shoot(e.x, e.y - 18, -370 * rage, 0, 'floor'); shoot(e.x, e.y - 18, 370 * rage, 0, 'floor'); shake(7); particles(e.x, e.y, 22, '#ffc58e', 220); }
    }
  } else if (e.attackPhase === 'attack') { if (e.moveAttack) { e.x = clamp(e.x + e.chargeDir * (e.kind === 'clamp' ? 490 : 420) * rage * dt, e.minX, e.maxX); if (rand() < .18) particles(e.x - e.chargeDir * 70, e.y, 2, '#d4b780', 80); } if (e.phaseTime > .75) { e.attackPhase = 'recover'; e.phaseTime = 0; } }
  else if (e.phaseTime > 1.2 / rage) { e.attackPhase = 'idle'; e.cool = .7; e.phaseTime = 0; }
  contact(e);
}
function updateEffects(dt) {
  for (const p of G.particles) { p.px = p.x; p.py = p.y; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.7; p.vy += (p.kind === 'bubble' ? -90 : 400) * dt; p.life -= dt; } G.particles = G.particles.filter(p => p.life > 0);
  for (const f of G.floaters) { f.y -= 42 * dt; f.life -= dt; } G.floaters = G.floaters.filter(f => f.life > 0); for (const e of G.effects) e.life -= dt; G.effects = G.effects.filter(e => e.life > 0);
}
