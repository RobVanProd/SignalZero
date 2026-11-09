// Clax: a jointed cut-out rig posed procedurally -----------------------------------------------------------
/* Parts are cut from the one approved illustration by tools/cut_rig.py. The art faces LEFT, so "forward" is -x in art
   space and the whole rig is mirrored when Clax faces right. Pose values are in screen pixels / radians and are
   blended every frame, so every state change is an in-between rather than a pop.
   Pose key references: docs/reference/animation_water_sheet.png (idle, anticipation, contact/passing, apex, squash,
   claw strike, air dash, hurt, victory). */
const RK = 162 / RIG.height, RU = 1 / RK, PEL = [402 - RIG.origin[0], 452 - RIG.origin[1]];
const POSE0 = { lean: 0, by: 0, sx: 1, sy: 1, head: 0, headY: 0, arm: 0, armX: 0, claw: 0, jaw: 0, hand: 0, f0x: 0, f0y: 0, f0r: 0, f1x: 0, f1y: 0, f1r: 0, spread: 1, infl: 0, tilt: 0 };
const rig = { pose: { ...POSE0 }, face: -1, bs: 0, bv: 0, hs: 0, hv: 0, wa: 0, wv: 0, wh: 0, whv: 0, foam: 0, clack: 0, quipped: false, bubbles: Array.from({ length: 7 }, (_, i) => ({ x: (i * 37 % 100) / 100, y: i / 7, s: .5 + (i * 53 % 10) / 14 })) };
function resetRig() { Object.assign(rig.pose, POSE0); rig.bs = rig.bv = rig.hs = rig.hv = rig.wa = rig.wv = rig.wh = rig.whv = rig.foam = 0; rig.face = G.player && G.player.facing > 0 ? -1 : 1; rig.quipped = false; }
function rigKick(x, y) { rig.bv += y * 14; rig.hv += y * .016; }
/* helmet water: dir = which way the water is thrown (world x), amt 0..1.5 */
function slosh(dir, amt) { rig.wv += dir * amt * 5.5 * (rig.face < 0 ? -1 : 1) * -1; rig.whv -= amt * 70; rig.foam = Math.max(rig.foam, Math.min(1, amt)); }

function poseTarget(p, t) {
  const T = { ...POSE0 }, sp = Math.min(1.25, Math.abs(p.vx) / P.K.run), ph = p.stride;
  const walk = (amt, A = 31) => { for (let i = 0; i < 2; i++) { const u = mod(ph + i * Math.PI, Math.PI * 2), sw = u > Math.PI ? Math.sin(u - Math.PI) : 0; T['f' + i + 'x'] = Math.cos(u) * A * amt; T['f' + i + 'y'] = -sw * 17 * amt; T['f' + i + 'r'] = (u > Math.PI ? Math.sin((u - Math.PI) * 2) * .38 : 0) * amt; } };
  if (p.swing) {
    const om = p.swing.om, f = p.facing; T.tilt = -p.swing.th * (rig.face < 0 ? -1 : 1) * .75; T.f0x = -om * f * 7 - 4; T.f1x = -om * f * 10 + 4; T.f0y = 6; T.f1y = 3; T.f0r = T.f1r = .3; T.hand = -.5 - Math.abs(om) * .3; T.head = -.06; T.spread = .7;
  } else if (p.dashTime > 0) {
    Object.assign(T, { lean: .55, sx: 1.13, sy: .9, f0x: -26, f0y: -18, f1x: -36, f1y: -9, f0r: .9, f1r: .9, arm: .5, claw: 1.2, jaw: .5, hand: -1.25, head: -.12, by: -6, spread: .6 });
  } else if (p.hurt > 0) {
    Object.assign(T, { lean: -.34, arm: -.5, claw: .6, jaw: 1, hand: -1.7, f0x: 14, f1x: -10, f0y: -10, f1y: -3, head: .16, by: -3 });
  } else if (p.wall) {
    Object.assign(T, { lean: -.1, arm: 1.05, claw: 1.5, jaw: .25, f0x: 18, f0y: -14, f1x: 13, f1y: 3, f0r: -.3, hand: -.5, head: .08, spread: .7 });
  } else if (!p.grounded) {
    if (p.floating) { Object.assign(T, { infl: 1, by: -3, arm: .85, claw: .15, hand: -1.75, head: .09, tilt: Math.sin(t * 2.4) * .05, spread: .85 }); for (let i = 0; i < 2; i++) { T['f' + i + 'x'] = Math.sin(t * 5.5 + i * Math.PI) * 9; T['f' + i + 'y'] = -5 + Math.cos(t * 5.5 + i * Math.PI) * 3; T['f' + i + 'r'] = .2; } }
    else if (p.vy < -160) Object.assign(T, { lean: .05, by: -2, sy: 1.06, sx: .96, f0y: 8, f1y: 5, f0x: -5, f1x: -9, f0r: .32, f1r: .25, arm: .2, claw: .15, hand: -1.35, head: -.05, spread: .8 });
    else if (p.vy < 160) Object.assign(T, { by: -1, f0y: -16, f1y: -11, f0x: 8, f1x: -7, f0r: -.2, f1r: .1, arm: .5, claw: .45, jaw: .3, hand: -.95, spread: .8 });
    else Object.assign(T, { lean: -.05, sy: 1.04, f0y: 5, f1y: -7, f0x: 10, f1x: -11, f0r: -.15, f1r: .3, arm: .75, claw: .3, jaw: .35, hand: -1.55, head: .06, spread: .95 });
    T.lean += clamp(p.vx / P.K.run, -1, 1) * p.facing * .07;
  } else if (p.crouch) {
    Object.assign(T, { by: 21, spread: 1.22, claw: .55, arm: .12, headY: 4, lean: .06, hand: -.25, sx: 1.04 });
  } else if (p.skid > 0) {
    Object.assign(T, { lean: -.24, arm: -.3, claw: .1, hand: .55, f0x: 14, f1x: 18, by: 4, head: .1, f0r: -.25, f1r: -.2 });
  } else if (sp > .1) {
    walk(Math.min(1, sp * 1.15)); const a = Math.min(1, sp);
    T.by = (Math.abs(Math.cos(ph)) * 5 - 2.5) * a; T.lean = .13 * sp + (sp > 1.05 ? .07 : 0); T.arm = Math.sin(ph) * .26 * a; T.claw = .22 + Math.cos(ph) * .13; T.hand = -Math.sin(ph) * .55 * a - .1; T.head = -.03 + Math.sin(ph * 2) * .025; T.spread = lerp(1, .42, a);
  } else {
    T.by = Math.sin(t * 2.6) * 1.5; T.arm = Math.sin(t * 2.6 + .5) * .03; T.claw = .04; T.hand = Math.sin(t * 2.6) * .05; T.head = Math.sin(t * 1.3) * .02;
    const cl = mod(t, 4.6); if (cl < .5) T.jaw = Math.abs(Math.sin(cl * Math.PI * 4)) * .9;
    if (p.idle > 6) { T.f1r = -Math.max(0, Math.sin(t * 9)) * .3; T.head = Math.sin(t * .9) * .09; T.hand = -.9; T.arm = .1; }
  }
  if (p.grounded && p.slope) { T.f0y += -p.slope * 9 * (rig.face < 0 ? -1 : 1) * -1; T.f1y += p.slope * 9 * (rig.face < 0 ? -1 : 1) * -1; T.by += 3; }
  if (p.win > 0) Object.assign(T, { by: -4, arm: 1.3, claw: 1.25, jaw: Math.abs(Math.sin(t * 14)), hand: -2.2, head: .05 });
  return T;
}
function updateRig(p, dt) {
  const R = rig.pose, T = poseTarget(p, G.clock), fast = p.dashTime > 0 || p.hurt > 0 ? 30 : 17;
  for (const k in R) R[k] = ease(R[k], T[k], k[0] === 'f' ? 26 : fast, dt);
  // the claw strike runs on its own clock so it is never softened by blending
  if (p.attack > 0) {
    const a = 1 - p.attack / .24, up = p.attackUp; let arm, claw, jaw, ax, lean;
    if (a < .2) { arm = -.32; claw = .5; jaw = 1; ax = -9; lean = -.07; }
    else if (a < .55) { arm = up ? 1.35 : .5; claw = up ? 1.75 : 1.38; jaw = a < .36 ? 1 : 0; ax = up ? 6 : 32; lean = up ? -.04 : .13; }
    else { const b = (a - .55) / .45; arm = lerp(up ? 1.35 : .5, T.arm, b); claw = lerp(up ? 1.75 : 1.38, T.claw, b); jaw = 0; ax = lerp(up ? 6 : 32, 0, b); lean = lerp(.13, T.lean, b); }
    R.arm = ease(R.arm, arm, 75, dt); R.claw = ease(R.claw, claw, 75, dt); R.jaw = ease(R.jaw, jaw, 90, dt); R.armX = ease(R.armX, ax, 75, dt); R.lean = ease(R.lean, lean, 40, dt);
  }
  rig.face = ease(rig.face, p.facing > 0 ? -1 : 1, 24, dt);
  rig.bv += (-430 * rig.bs - 23 * rig.bv) * dt; rig.bs = clamp(rig.bs + rig.bv * dt, -14, 22);
  rig.hv += (-300 * rig.hs - 15 * rig.hv) * dt; rig.hs += rig.hv * dt;
  rig.wv += (-55 * rig.wa - 3.6 * rig.wv) * dt; rig.wa = clamp(rig.wa + rig.wv * dt, -.6, .6);
  rig.whv += (-200 * rig.wh - 9 * rig.whv) * dt; rig.wh = clamp(rig.wh + rig.whv * dt, -16, 16); rig.foam = Math.max(0, rig.foam - dt * 1.6);
  if (p.idle > 8 && !rig.quipped) { rig.quipped = true; quip('idle'); } if (p.idle === 0) rig.quipped = false;
}
function rigPart(name, x, y, rot = 0, sx = 1, sy = 1) { const q = RIG.parts[name]; ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(rot); if (sx !== 1 || sy !== 1) ctx.scale(sx, sy); ctx.drawImage(images['rig_' + name], q.x - q.px, q.y - q.py); ctx.restore(); }
function helmetWater(t) {
  // drawn in head space (origin = neck pivot); the dome interior is an ellipse cut off by the collar
  ctx.save(); ctx.beginPath(); ctx.ellipse(-2, -84, 106, 99, 0, 0, Math.PI * 2); ctx.clip(); ctx.beginPath(); ctx.rect(-130, -200, 260, 172); ctx.clip();
  const y0 = -78 + rig.wh, sl = Math.tan(rig.wa), amp = 2 + Math.abs(rig.wv) * 2.2 + rig.foam * 5, surf = x => y0 + sl * x + Math.sin(x * .055 + t * 7) * amp + Math.sin(x * .11 - t * 5) * amp * .4;
  ctx.beginPath(); ctx.moveTo(-120, 0); for (let x = -120; x <= 120; x += 12) ctx.lineTo(x, surf(x)); ctx.lineTo(120, 0); ctx.closePath(); ctx.fillStyle = 'rgba(40,170,196,.34)'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(-120, -200); for (let x = -120; x <= 120; x += 12) ctx.lineTo(x, surf(x)); ctx.lineTo(120, -200); ctx.closePath(); ctx.fillStyle = 'rgba(214,244,246,.2)'; ctx.fill();
  ctx.beginPath(); for (let x = -120; x <= 120; x += 12) x === -120 ? ctx.moveTo(x, surf(x)) : ctx.lineTo(x, surf(x)); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 5; ctx.stroke();
  if (rig.foam > .05) { ctx.fillStyle = `rgba(255,255,255,${rig.foam * .8})`; for (let k = 0; k < 7; k++) { const x = -90 + k * 30 + Math.sin(t * 9 + k) * 8; ctx.beginPath(); ctx.arc(x, surf(x) - 5 - rig.foam * 12 * Math.abs(Math.sin(t * 12 + k * 2)), 5 + rig.foam * 5, 0, Math.PI * 2); ctx.fill(); } }
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2.5; for (const b of rig.bubbles) { const yy = -30 - mod(b.y * 110 + t * 26 * b.s, 110), xx = -80 + b.x * 160 + Math.sin(t * 2 + b.y * 9) * 6 + rig.wa * 40; if (yy > surf(xx) + 6) { ctx.beginPath(); ctx.arc(xx, yy, 3 + b.s * 4, 0, Math.PI * 2); ctx.stroke(); } }
  ctx.restore();
}
function drawPlayer(x, y, p, opacity = 1) {
  const R = rig.pose, t = G.clock, fs = rig.face, sgn = fs < 0 ? -1 : 1;
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha *= opacity; if (p.invincible > 0 && p.hurt <= 0 && Math.floor(t * 18) % 2 === 0 && opacity === 1) ctx.globalAlpha *= .55;
  ctx.scale(sgn * Math.max(.14, Math.abs(fs)) * RK, RK);
  // --- body frame (art space, units = source pixels, origin = ground under the pelvis) ---
  const by = (R.by + rig.bs) * RU, sq = 1 - rig.bs * .0045, sx = R.sx * (1 + rig.bs * .003), sy = R.sy * sq, rot = -(R.lean + R.tilt), cs = Math.cos(rot), sn = Math.sin(rot);
  const bx = PEL[0] - R.lean * 60, byy = PEL[1] + by, toRoot = (lx, ly) => [bx + lx * sx * cs - ly * sy * sn, byy + lx * sx * sn + ly * sy * cs];
  // --- legs: boots are planted, the spring shafts stretch between hip and ankle ---
  const legs = RIG.legs.map((g, i) => {
    const hip = toRoot(g.hip[0] - 402, g.hip[1] - 452), nx = (g.ankle[0] - RIG.origin[0]) * R.spread + (i ? 10 : -6) * (1 - R.spread) * RU * .3, ny = g.ankle[1] - RIG.origin[1];
    return { g, i, hip, ankle: [nx - R['f' + i + 'x'] * RU, ny + R['f' + i + 'y'] * RU], rot: -R['f' + i + 'r'] };
  });
  for (const l of [legs[1], legs[0]]) {
    const q = RIG.parts['shaft' + l.i], v0x = l.g.ankle[0] - l.g.hip[0], v0y = l.g.ankle[1] - l.g.hip[1], vx = l.ankle[0] - l.hip[0], vy = l.ankle[1] - l.hip[1], len0 = Math.hypot(v0x, v0y), len = Math.max(26, Math.hypot(vx, vy));
    ctx.save(); ctx.translate(l.hip[0], l.hip[1]); ctx.rotate(Math.atan2(vy, vx) - Math.PI / 2); ctx.scale(1 + clamp((len0 - len) / len0, -.2, .5) * .35, len / len0); ctx.rotate(Math.PI / 2 - Math.atan2(v0y, v0x)); ctx.drawImage(images['rig_shaft' + l.i], q.x - l.g.hip[0], q.y - l.g.hip[1]); ctx.restore();
    rigPart('boot' + l.i, l.ankle[0], l.ankle[1], l.rot);
  }
  // --- torso, head, arms ---
  ctx.save(); ctx.translate(bx, byy); ctx.rotate(rot); ctx.scale(sx, sy);
  const inf = 1 + R.infl * (.1 + Math.sin(t * 7) * .012);
  rigPart('torso', 0, 0, 0, inf, 1 + R.infl * .05);
  rigPart('hand', (590 - 402) * inf, 304 - 452, R.hand + Math.sin(t * 2.2) * .03);
  { const hq = RIG.parts.head; ctx.save(); ctx.translate(hq.px - 402, hq.py - 452 + (R.headY - R.infl * 5) * RU + rig.bs * .9); ctx.rotate(R.head + rig.hs); ctx.drawImage(images.rig_head, hq.x - hq.px, hq.y - hq.py); helmetWater(t); ctx.restore(); }
  const shx = 236 - 402 - (R.armX + R.infl * 4) * RU, shy = 316 - 452;
  let armRot = R.arm, clawRot = R.claw, hookArt = null;
  if (p.swing && opacity === 1) {
    // aim the amplifier at the ring; the pincer itself is out on the cable, clamped to the ring
    const h = p.swing.hook, wx = (h.x - x) / (sgn * Math.max(.14, Math.abs(fs)) * RK), wy = (h.y - y) / RK, sr = toRoot(shx, shy);
    hookArt = [wx, wy, sr[0], sr[1]]; armRot = Math.atan2(wy - sr[1], wx - sr[0]) - Math.atan2(78, -80) - rot;
  }
  ctx.save(); ctx.translate(shx, shy); ctx.rotate(armRot);
  if (!hookArt) { ctx.save(); ctx.translate(156 - 236, 394 - 316); ctx.rotate(clawRot + R.jaw * .12); rigPart('jaw', 163 - 156, 408 - 394, -R.jaw * .62); rigPart('pincer', 0, 0, 0); ctx.restore(); }
  rigPart('upper', 0, 0, 0);
  ctx.restore(); ctx.restore();
  if (hookArt) {
    const [wx, wy, ox, oy] = hookArt, a = Math.atan2(wy - oy, wx - ox), d = Math.hypot(wx - ox, wy - oy), reach = 215;
    ctx.lineCap = 'round'; ctx.strokeStyle = '#1a2328'; ctx.lineWidth = 34; ctx.beginPath(); ctx.moveTo(ox + Math.cos(a) * 90, oy + Math.sin(a) * 90); ctx.lineTo(wx - Math.cos(a) * reach, wy - Math.sin(a) * reach); ctx.stroke();
    ctx.strokeStyle = '#59636a'; ctx.lineWidth = 20; ctx.setLineDash([10, 16]); ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.translate(wx - Math.cos(a) * reach, wy - Math.sin(a) * reach); ctx.rotate(a - Math.atan2(231, -26)); rigPart('jaw', 163 - 156, 408 - 394, .08); rigPart('pincer', 0, 0, 0); ctx.restore();
    void d;
  }
  ctx.restore();
}
