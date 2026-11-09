/* CLAX physics — pure (no DOM, no audio). Runs in the browser and in Node for the reachability tests.
   World: 64px tile grid. Tiles:
     '#' solid   'o' bouncy solid (inflatable)   '=' one-way deck   '^' hazard (non-solid)
     '/' 45° floor rising to the right   '\\' 45° floor falling to the right
     'a','b' gentle rise (two tiles per tile of height)   'c','d' gentle fall
   The player is a point-footed box: x = centre, y = feet. */
(function (root) {
'use strict';
const TS = 64;
const SLOPE = { '/': [0, 1], '\\': [1, 0], a: [0, .5], b: [.5, 1], c: [1, .5], d: [.5, 0] };
const K = {
  run: 385, accelGround: 3200, accelAir: 2200, brakeGround: 3400, brakeAir: 750, turnBoost: 1.5,
  gravity: 2250, maxFall: 1150, jump: -880, doubleJump: -790, jumpCut: .5, coyote: .12, buffer: .15,
  dash: 940, dashTime: .18, floatFall: 150, floatDrain: 22, wallSlide: 165, wallJumpX: 460, wallJumpY: -840,
  wallLock: .17, stepUp: 34, airStep: 12, foot: 14, standH: 111, crouchH: 74, swingMin: 130, swingMax: 230,
  latchRange: 285, chest: 70,
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const approach = (a, b, d) => a < b ? Math.min(a + d, b) : Math.max(a - d, b);

function tile(L, c, r) {
  if (c < 0 || c >= L.cols || r < 0) return '#';
  if (r >= L.rows) return ' ';
  return L.grid[r][c];
}
const isSolid = ch => ch === '#' || ch === 'o';
const isSlope = ch => SLOPE[ch] !== undefined;
function slopeY(c, r, ch, x) {
  const s = SLOPE[ch], t = clamp((x - c * TS) / TS, 0, 1);
  return (r + 1) * TS - TS * (s[0] + (s[1] - s[0]) * t);
}
function pointSolid(L, x, y) {
  const c = Math.floor(x / TS), r = Math.floor(y / TS), ch = tile(L, c, r);
  if (isSolid(ch)) return true;
  if (isSlope(ch)) return y > slopeY(c, r, ch, x);
  return false;
}
function boxSolid(L, x0, y0, x1, y1) {
  for (let r = Math.floor(y0 / TS); r <= Math.floor(y1 / TS); r++)
    for (let c = Math.floor(x0 / TS); c <= Math.floor(x1 / TS); c++) if (isSolid(tile(L, c, r))) return true;
  return false;
}
/* First walkable surface at column x between y0 and y1 (y1 >= y0). Returns {y, slope, oneWay, bouncy} or null. */
function probe(L, x, y0, y1, oneWay) {
  const c = Math.floor(x / TS);
  for (let r = Math.floor(y0 / TS); r <= Math.floor(y1 / TS); r++) {
    const ch = tile(L, c, r);
    if (isSlope(ch)) {
      const sy = slopeY(c, r, ch, x);
      if (sy >= y0 && sy <= y1) { const s = SLOPE[ch]; return { y: sy, slope: s[0] - s[1], oneWay: false, bouncy: false }; }
      if (sy < y0) return null;                       // inside the slope body
    } else if (isSolid(ch)) {
      const top = r * TS;
      if (top >= y0 && top <= y1 && !isSolid(tile(L, c, r - 1)) && !isSlope(tile(L, c, r - 1)))
        return { y: top, slope: 0, oneWay: false, bouncy: ch === 'o' };
      if (top < y0) return null;
    } else if (ch === '=' && oneWay) {
      const top = r * TS;
      if (top >= y0 && top <= y1) return { y: top, slope: 0, oneWay: true, bouncy: false };
    }
  }
  return null;
}
/* Ground under a point, used for enemies, pickups and level authoring. */
function groundBelow(L, x, y, max = 2000) {
  const g = probe(L, x, y, y + max, true);
  return g ? g.y : null;
}

function makePlayer(x, y) {
  return {
    x, y, px: x, py: y, vx: 0, vy: 0, w: 52, h: K.standH, facing: 1, grounded: true, coyote: K.coyote,
    jumpBuffer: 0, jumps: 0, cut: false, dashTime: 0, dashDir: 1, airDash: false, drop: 0, support: null,
    slope: 0, wall: 0, wallCoyote: 0, wallDir: 0, wallLock: 0, floating: false, floatSpent: false, crouch: false,
    swing: null, launch: 0, pressure: 100, landV: 0, bounce: 0, touch: 0, oneWay: false, airTime: 0,
  };
}

function stepMovers(L, t, dt) {
  for (const q of L.movers) {
    const ox = q.x, oy = q.y;
    if (q.kind === 'wheel') {
      const a = t * q.speed + q.phase;
      q.x = q.cx + Math.cos(a) * q.radius - q.w / 2; q.y = q.cy + Math.sin(a) * q.radius;
    } else if (q.kind === 'moving') {
      const s = Math.sin(t * q.speed + q.phase);
      q.x = q.baseX + (q.ax || 0) * s; q.y = q.baseY + (q.ay || 0) * s;
    } else if (q.kind === 'crumble') {
      if (q.timer > 0) { q.timer -= dt; if (q.timer <= 0) { q.absent = 2.8; q.timer = 0; } }
      if (q.absent > 0) q.absent = Math.max(0, q.absent - dt);
    }
    q.dx = q.x - ox; q.dy = q.y - oy;
  }
  for (const h of L.hooks) {
    if (h.ax || h.ay) { const s = Math.sin(t * h.speed + h.phase); h.x = h.baseX + (h.ax || 0) * s; h.y = h.baseY + (h.ay || 0) * s; }
  }
}

function nearestHook(L, p) {
  const cx = p.x, cy = p.y - K.chest; let best = null, bd = K.latchRange;
  for (const h of L.hooks) {
    if (h.y > cy - 30) continue;
    const d = Math.hypot(h.x - cx, h.y - cy);
    if (d < bd && Math.abs(h.x - cx) < 250) { bd = d; best = h; }
  }
  return best;
}
function latch(p, h) {
  const cx = p.x - h.x, cy = p.y - K.chest - h.y, d = Math.hypot(cx, cy), th = Math.atan2(cx, cy);
  p.swing = { hook: h, len: d, target: clamp(d, K.swingMin, K.swingMax), th, om: (p.vx * Math.cos(th) - p.vy * Math.sin(th)) / Math.max(d, 80) };
  p.swing.om = clamp(p.swing.om, -4.2, 4.2);
  p.grounded = false; p.support = null; p.dashTime = 0; p.floating = false; p.wall = 0;
}

function stepSwing(p, inp, L, dt, ev) {
  const s = p.swing, h = s.hook;
  s.len = approach(s.len, s.target, 520 * dt);
  s.om += (-(K.gravity / s.len) * Math.sin(s.th) + inp.x * 3.4 * Math.cos(s.th)) * dt;
  s.om *= 1 - .22 * dt;
  let th = clamp(s.th + s.om * dt, -1.45, 1.45);
  if (Math.abs(th) >= 1.45) s.om *= -.3;
  const nx = h.x + Math.sin(th) * s.len, ny = h.y + Math.cos(th) * s.len + K.chest;
  if (boxSolid(L, nx - p.w / 2, ny - p.h, nx + p.w / 2, ny - 6)) { s.om = -s.om * .4; th = s.th; }
  else { p.x = nx; p.y = ny; }
  s.th = th;
  p.vx = Math.cos(th) * s.len * s.om; p.vy = -Math.sin(th) * s.len * s.om;
  if (Math.abs(s.om) > .25) p.facing = s.om > 0 ? 1 : -1;
  if (p.jumpBuffer > 0 || inp.down && inp.jumpPressed) {
    p.jumpBuffer = 0; p.swing = null;
    p.vx *= 1.12; p.vy = Math.min(p.vy * 1.12 - 300, -380);
    p.jumps = 1; p.airDash = false; p.floatSpent = false; p.cut = true; p.coyote = 0;
    ev('release');
  }
}

/* inp: {x:-1|0|1, down:boolean, jumpHeld:boolean}. Buffered jump lives on p.jumpBuffer (set by the caller on press). */
function stepPlayer(p, inp, L, dt, ev = () => {}) {
  p.px = p.x; p.py = p.y;
  p.jumpBuffer = Math.max(0, p.jumpBuffer - dt); p.drop = Math.max(0, p.drop - dt);
  p.wallLock = Math.max(0, p.wallLock - dt); p.launch = Math.max(0, p.launch - dt); p.bounce = Math.max(0, p.bounce - dt);
  p.touch = 0;
  if (p.swing) { stepSwing(p, inp, L, dt, ev); return; }

  const wasGrounded = p.grounded;
  let ix = p.wallLock > 0 || p.launch > 0 ? 0 : inp.x;
  if (ix && p.dashTime <= 0) p.facing = ix;
  if (wasGrounded) { p.coyote = K.coyote; p.airTime = 0; } else { p.coyote = Math.max(0, p.coyote - dt); p.airTime += dt; }
  p.wallCoyote = Math.max(0, p.wallCoyote - dt);

  // crouch (grounded only); stand up only when there is head room
  const wantCrouch = wasGrounded && inp.down && p.dashTime <= 0;
  if (wantCrouch) { p.crouch = true; p.h = K.crouchH; }
  else if (p.crouch && !boxSolid(L, p.x - p.w / 2 + 3, p.y - K.standH, p.x + p.w / 2 - 3, p.y - K.crouchH)) { p.crouch = false; p.h = K.standH; }
  if (p.crouch) ix = 0;

  // ---- jump family ----
  let jumped = false;
  if (p.jumpBuffer > 0 && p.dashTime <= 0) {
    if (inp.down && wasGrounded && (p.oneWay || p.support)) {
      p.drop = .26; p.y += 8; p.grounded = false; p.coyote = 0; p.jumpBuffer = 0; p.support = null; p.crouch = false; p.h = K.standH;
    } else if (p.coyote > 0 && !p.crouch || p.coyote > 0 && p.crouch && !boxSolid(L, p.x - p.w / 2 + 3, p.y - K.standH - 8, p.x + p.w / 2 - 3, p.y - K.crouchH)) {
      p.vy = K.jump; p.jumps = 1; jumped = true; p.crouch = false; p.h = K.standH; ev('jump');
    } else if (!wasGrounded && (p.wall || p.wallCoyote > 0)) {
      const d = p.wall || p.wallDir;
      p.vx = -d * K.wallJumpX; p.vy = K.wallJumpY; p.facing = -d; p.wallLock = K.wallLock; p.jumps = 1; jumped = true;
      p.wall = 0; p.wallCoyote = 0; p.floatSpent = false; ev('walljump', d);
    } else if (!wasGrounded && p.jumps < 2) {
      p.vy = K.doubleJump; p.jumps = 2; jumped = true; ev('double');
    }
    if (jumped) { p.grounded = false; p.support = null; p.coyote = 0; p.jumpBuffer = 0; p.cut = false; p.floating = false; }
  }
  if (!inp.jumpHeld && p.vy < -330 && !p.cut && p.launch <= 0 && p.bounce <= 0) { p.vy *= K.jumpCut; p.cut = true; }

  // ---- horizontal intent, gravity ----
  if (p.dashTime > 0) {
    p.dashTime -= dt; p.vx = p.dashDir * K.dash; p.vy = 0; p.floating = false;
  } else {
    let max = K.run;
    if (wasGrounded && p.slope && ix) max *= Math.sign(ix) === Math.sign(p.slope) ? 1 + .16 * Math.abs(p.slope) : 1 - .12 * Math.abs(p.slope);
    const target = ix * max;
    let rate = ix ? (wasGrounded ? K.accelGround : K.accelAir) : (wasGrounded ? K.brakeGround : K.brakeAir);
    if (ix && Math.sign(p.vx) === -ix && wasGrounded) rate *= K.turnBoost;
    if (p.launch > 0) rate = 0;
    if (Math.abs(p.vx) > max && ix === Math.sign(p.vx)) rate = wasGrounded ? 900 : 260;   // keep earned momentum for a while
    p.vx = approach(p.vx, target, rate * dt);
    p.vy = Math.min(K.maxFall, p.vy + K.gravity * dt);
    // inflate & float: hold jump after the double jump
    p.floating = !wasGrounded && inp.jumpHeld && p.vy > 0 && p.jumps >= 2 && !p.floatSpent && p.pressure > 0 && !p.wall;
    if (p.floating) { p.vy = approach(p.vy, K.floatFall, 4200 * dt); p.pressure = Math.max(0, p.pressure - K.floatDrain * dt); if (p.pressure <= 0) p.floatSpent = true; }
    if (p.wall && p.vy > K.wallSlide) p.vy = approach(p.vy, K.wallSlide, 5200 * dt);
  }

  // ---- carried by a moving platform ----
  if (p.support && wasGrounded && !jumped) { p.x += p.support.dx || 0; p.y += p.support.dy || 0; }

  // ---- move X ----
  const oldY = p.y;
  let nx = p.x + p.vx * dt;
  const dir = Math.sign(nx - p.x);
  if (dir) {
    const skip = wasGrounded && !jumped ? K.stepUp : K.airStep;
    const edge = nx + dir * p.w / 2, c = Math.floor(edge / TS);
    if (c !== Math.floor((p.x + dir * (p.w / 2 - 1)) / TS) || true) {
      const r0 = Math.floor((p.y - p.h + 2) / TS), r1 = Math.floor((p.y - skip - 1) / TS);
      for (let r = r0; r <= r1; r++) {
        const ch = tile(L, c, r); let hit = isSolid(ch);
        if (!hit && isSlope(ch)) {
          const s = SLOPE[ch], side = dir > 0 ? s[0] : s[1];             // height of the face we are running into
          hit = side > 0 && p.y - skip > (r + 1) * TS - side * TS && Math.floor(p.x / TS) !== c;
        }
        if (hit) { nx = dir > 0 ? c * TS - p.w / 2 - .01 : (c + 1) * TS + p.w / 2 + .01; if (p.dashTime <= 0) p.vx = 0; p.touch = dir; break; }
      }
    }
  }
  p.x = nx;

  // ---- move Y ----
  let ny = p.y + p.vy * dt;
  p.grounded = false; let support = null, ground = null;
  if (p.vy < 0) {
    const r = Math.floor((ny - p.h) / TS);
    for (let c = Math.floor((p.x - p.w / 2 + 5) / TS); c <= Math.floor((p.x + p.w / 2 - 5) / TS); c++)
      if (isSolid(tile(L, c, r))) { ny = (r + 1) * TS + p.h + .01; p.vy = 0; ev('bonk'); break; }
  } else {
    const tol = wasGrounded && !jumped ? K.stepUp : K.airStep, y0 = oldY - tol, ow = p.drop <= 0;
    const pick = (x, y1) => {
      const g = probe(L, x, y0, y1, ow);
      if (g && g.oneWay && oldY > g.y + 7) return null;
      return g;
    };
    ground = pick(p.x, ny);
    // stay glued to the ground when running over crests and down slopes (centre first, so descents start smoothly)
    if (!ground && wasGrounded && !jumped && p.drop <= 0) ground = probe(L, p.x, ny, ny + 14 + Math.abs(p.vx) * dt * 1.6, true);
    if (!ground) { const a = pick(p.x - K.foot, ny), b = pick(p.x + K.foot, ny); ground = a && b ? (a.y < b.y ? a : b) : a || b; if (ground && ground.slope) ground = null; }
    if (ow) for (const q of L.movers) {
      if (q.absent > 0) continue;
      if (p.x > q.x - 12 && p.x < q.x + q.w + 12 && oldY <= q.y - (q.dy || 0) + 9 && ny >= q.y && (!ground || q.y < ground.y)) { ground = { y: q.y, slope: 0, oneWay: true, bouncy: false }; support = q; }
    }
  }
  if (ground) {
    p.landV = wasGrounded ? 0 : p.vy;
    if (ground.bouncy && (p.vy > 320 || inp.jumpHeld && p.vy > 60) && !wasGrounded) {
      p.y = ground.y; p.vy = -Math.max(inp.jumpHeld ? 1010 : 640, Math.min(1120, p.vy * (inp.jumpHeld ? 1.02 : .8)));
      p.jumps = 1; p.airDash = false; p.floatSpent = false; p.cut = true; p.bounce = .25; ev('bounce', p.landV);
    } else {
      if (!wasGrounded) ev('land', p.vy);
      p.y = ground.y; p.vy = 0; p.grounded = true; p.jumps = 0; p.airDash = false; p.floatSpent = false; p.floating = false;
      p.support = support; p.slope = ground.slope; p.oneWay = ground.oneWay; p.wall = 0;
      if (support && support.kind === 'crumble' && !support.timer) { support.timer = .7; ev('crumble'); }
    }
  } else {
    p.y = ny; p.support = null; p.slope = 0; p.oneWay = false;
    if (p.jumps === 0 && p.coyote <= 0) p.jumps = 1;
  }

  // ---- wall slide ----
  if (!p.grounded && p.vy > 0 && p.touch && inp.x === p.touch && p.dashTime <= 0 &&
      isSolid(tile(L, Math.floor((p.x + p.touch * (p.w / 2 + 3)) / TS), Math.floor((p.y - p.h * .45) / TS))) &&
      isSolid(tile(L, Math.floor((p.x + p.touch * (p.w / 2 + 3)) / TS), Math.floor((p.y - p.h * .9) / TS)))) {
    if (!p.wall) ev('wall', p.touch);
    p.wall = p.touch; p.wallDir = p.touch; p.wallCoyote = .11; p.floating = false;
  } else p.wall = 0;

  // ---- springs & launchers ----
  for (const s of L.springs) {
    if (p.bounce > 0 || p.vy < 0 || Math.abs(p.x - s.x) > 38 || p.y < s.y - 26 || p.y > s.y + 10) continue;
    p.vy = s.vy; if (s.vx) { p.vx = s.vx; p.facing = Math.sign(s.vx); p.launch = s.lock || .35; }
    p.y = Math.min(p.y, s.y - 1); p.grounded = false; p.support = null; p.jumps = 1; p.airDash = false; p.floatSpent = false; p.coyote = 0; p.cut = true; p.bounce = .3; p.dashTime = 0;
    s.fired = .3; ev('spring', s);
  }
  p.y = Math.max(p.y, p.h - TS);
}

function hazard(L, p) {
  const r = Math.floor((p.y - 6) / TS);
  for (let c = Math.floor((p.x - 16) / TS); c <= Math.floor((p.x + 16) / TS); c++)
    if (tile(L, c, r) === '^' && p.y > (r + 1) * TS - 34) return true;
  return false;
}

const api = { TS, K, SLOPE, tile, isSolid, isSlope, slopeY, pointSolid, boxSolid, probe, groundBelow, makePlayer, stepMovers, stepPlayer, nearestHook, latch, hazard, clamp, approach };
root.CLAX_PHYS = api;
if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
