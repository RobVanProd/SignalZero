/* Reachability test. Searches each level with the REAL player physics (src/phys.js) driven by scripted input
   macros (walk, jumps, vent-hop, float, dash, wall kicks, ring swings, riding platforms) and reports:
     - whether the exit, every checkpoint and every survivor can be touched from the start
     - soft-locks: standable places from which the exit can no longer be reached
   It proves traversability under these macros. It says nothing about difficulty or fun.
   Enemies, vents and boss gates are ignored. Usage: node tests/reach.js [level] [--verbose] */
const P = require('../src/phys.js'), W = require('../src/world.js');
const TS = P.TS, K = P.K, DT = 1 / 120, verbose = process.argv.includes('--verbose');
const only = process.argv[2] !== undefined && !process.argv[2].startsWith('-') ? [+process.argv[2]] : [0, 1, 2];

function macros() {
  const M = [];
  const add = (name, fn) => M.push({ name, fn });
  for (const d of [-1, 1]) {
    add('walk.12', (t) => ({ x: t < .12 ? d : 0, end: t > .14 }));
    add('walk.5', (t) => ({ x: t < .5 ? d : 0, end: t > .52 }));
    for (const h of [.06, .2, .5]) for (const m of [.18, .45, 9]) add(`jump h${h} m${m}`, (t) => ({ x: t < m ? d : 0, jump: t < h, end: t > h + .05 }));
    for (const t2 of [.25, .45, .7]) for (const fl of [0, 1]) for (const ds of [0, 1]) for (const m of [.4, 9])
      add(`dbl t${t2} f${fl} d${ds} m${m}`, (t) => ({ x: t < m || t > t2 ? d : 0, jump: t < t2 - .04 || (t >= t2 && (fl || t < t2 + .5)), dash: ds && t >= t2 + .28 && t < t2 + .3, end: t > t2 + .6 }));
    add('up then steer', (t, p) => ({ x: t > .55 ? d : 0, jump: t < .3 || (t >= .34 && t < .9), end: t > 1 }));
    add('up dbl late steer', (t, p) => ({ x: t > .75 ? d : 0, jump: t < .36 || (t >= .4 && t < 1), end: t > 1.1 }));
    add('drop', (t) => ({ x: 0, down: t < .1, jump: t < .05, end: t > .2 }));
    add('drop steer', (t) => ({ x: t > .15 ? d : 0, down: t < .1, jump: t < .05, end: t > .2 }));
    add('bounce hold', (t) => ({ x: d, jump: true, end: t > 2.2 }));
    add('bounce hold still', (t) => ({ x: t > .5 ? d : 0, jump: true, end: t > 2.2 }));
    for (const back of [0, 1]) {            // wall kicks: same wall, or zig-zag between two walls
      add(`wall b${back}`, (t, p, s) => {
        if (s.dir === undefined) { s.dir = d; s.kickAt = -1; }
        let jump = t < .3; if (p.wall && t > s.kickAt + .08) { s.kickAt = t; s.pulse = t; if (back) s.dir = -p.wall; else s.dir = p.wall; }
        if (s.pulse !== undefined && t - s.pulse < .32) jump = t - s.pulse > .02;
        return { x: s.dir, jump, end: t > .5 && s.kickAt < t - 1.2 };
      });
    }
    for (const rel of [.35, .8, 1.15]) for (const dj of [0, 1]) add(`swing r${rel} j${dj}`, (t, p, s) => {
      if (p.swing) { s.sw = true; const go = p.swing.th * d > rel && p.swing.om * d > 0 || t - (s.t0 = s.t0 ?? t) > 4; if (go) { s.rel = t; return { x: d, jump: true, press: true }; } return { x: d, jump: false }; }
      if (s.rel !== undefined) return { x: d, jump: dj ? (t - s.rel > .3) : false, snap: t - s.rel > .2, end: t - s.rel > 1.2 };
      return { x: d, jump: t < .25 || (t > .3 && t < .5), snap: t > .1, end: t > 1.4 && !s.sw };
    });
  }
  return M;
}
const MAC = macros();

function run(L, node, mac, t0, touched) {
  for (const q of L.movers) if (q.kind === 'crumble') { q.timer = 0; q.absent = 0; }
  P.stepMovers(L, t0, 0);
  let p = P.makePlayer(node.x, node.y);
  if (node.mover !== undefined) { const q = L.movers[node.mover]; p.x = q.x + node.rel; p.y = q.y; p.support = q; }
  const s = {}; let prevJump = false, t = 0;
  for (let i = 0; i < 6 * 120; i++, t += DT) {
    const a = mac.fn(t, p, s), inp = { x: a.x || 0, down: !!a.down, jumpHeld: !!a.jump };
    if ((a.jump && !prevJump) || a.press) p.jumpBuffer = K.buffer; prevJump = !!a.jump;
    if (a.dash && p.dashTime <= 0 && !(p.airDash && !p.grounded) && !p.swing && p.pressure >= 24) { p.pressure -= 24; p.dashTime = K.dashTime; p.dashDir = p.facing; if (!p.grounded) p.airDash = true; p.vx = p.dashDir * K.dash; p.vy = 0; }
    if (a.snap && !p.grounded && !p.swing) { const h = P.nearestHook(L, p); if (h) P.latch(p, h); }
    P.stepMovers(L, t0 + t, DT); P.stepPlayer(p, inp, L, DT);
    if (p.y > L.height + 220) return null;
    if (P.hazard(L, p)) return null;
    for (const z of touched.targets) if (!z.hit && Math.abs(p.x - z.x) < z.rx && Math.abs(p.y - z.y) < z.ry) { z.hit = true; z.via = mac.name; }
    if (a.end && p.grounded && !p.swing) {
      if (p.support) return { mover: L.movers.indexOf(p.support), rel: Math.round((p.x - p.support.x) / 24) * 24, time: t0 + t };
      // let it settle so the node is a rest position
      for (let k = 0; k < 40 && Math.abs(p.vx) > 1; k++) { P.stepMovers(L, t0 + t, DT); P.stepPlayer(p, { x: 0, down: false, jumpHeld: false }, L, DT); t += DT; if (!p.grounded) break; }
      if (!p.grounded || P.hazard(L, p) || p.support) return null;
      return { x: p.x, y: p.y };
    }
  }
  return null;
}

function analyse(index) {
  const L = W.make(index), started = Date.now();
  const targets = [{ kind: 'exit', name: 'exit', x: L.exit.x, y: L.exit.y, rx: 60, ry: 80 },
    ...L.checkpoints.map((c, i) => ({ kind: 'checkpoint', name: 'checkpoint ' + (i + 1), x: c.x, y: c.y, rx: 46, ry: 70 })),
    ...L.npcs.map(n => ({ kind: 'survivor', name: n.name, x: n.x, y: n.y, rx: 58, ry: 95 }))];
  const touched = { targets };
  const periods = L.movers.filter(q => q.kind !== 'crumble').map(q => ({ x: q.kind === 'wheel' ? q.cx : q.baseX, T: 2 * Math.PI / q.speed })).concat(L.hooks.filter(h => h.ax || h.ay).map(h => ({ x: h.baseX, T: 2 * Math.PI / h.speed })));
  const key = n => n.mover !== undefined ? `m${n.mover}:${n.rel}:${Math.floor((n.time % (2 * Math.PI / (L.movers[n.mover].speed || 1))) / .6)}` : `${Math.round(n.x / 32)}:${Math.round(n.y / 16)}`;
  const nodes = new Map(), edges = new Map(), queue = [];
  const push = (n, from) => { const k = key(n); if (from) { if (!edges.has(from)) edges.set(from, new Set()); edges.get(from).add(k); } if (!nodes.has(k)) { nodes.set(k, n); queue.push(k); } };
  push({ x: L.start.x, y: L.start.y }, null);
  while (queue.length) {
    const k = queue.shift(), n = nodes.get(k);
    if (n.mover !== undefined) {
      const q = L.movers[n.mover];
      if (q.kind !== 'crumble') push({ mover: n.mover, rel: n.rel, time: n.time + .6 }, k);       // wait on the platform
      for (const m of MAC) { const r = run(L, n, m, n.time, touched); if (r) push(r, k); }
    } else {
      const near = periods.filter(q => Math.abs(q.x - n.x) < 1100), phases = near.length ? [0, .25, .5, .75].map(f => f * near[0].T) : [0];
      for (const t0 of phases) for (const m of MAC) { const r = run(L, n, m, t0, touched); if (r) push(r, k); }
    }
    if (nodes.size > 60000) break;
  }
  // soft-locks: nodes that cannot reach any node near the exit
  const rev = new Map(); for (const [a, bs] of edges) for (const b of bs) { if (!rev.has(b)) rev.set(b, []); rev.get(b).push(a); }
  const good = new Set(), st = [];
  for (const [k, n] of nodes) if (n.mover === undefined && Math.abs(n.x - L.exit.x) < 200 && Math.abs(n.y - L.exit.y) < 100) { good.add(k); st.push(k); }
  while (st.length) { const k = st.pop(); for (const a of rev.get(k) || []) if (!good.has(a)) { good.add(a); st.push(a); } }
  const stuck = [...nodes].filter(([k, n]) => !good.has(k) && n.mover === undefined).map(([, n]) => n);
  const cells = new Set(stuck.map(n => `${Math.floor(n.x / TS)},${Math.floor((n.y - 1) / TS)}`));
  console.log(`\nLevel ${index + 1} — ${L.biome.name}: ${nodes.size} rest positions explored in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (verbose) { const xs = [...nodes.values()].filter(n => n.mover === undefined).sort((a, b) => b.x - a.x).slice(0, 4); console.log('  furthest right:', xs.map(n => `(${(n.x / TS).toFixed(1)},${(n.y / TS).toFixed(1)})`).join(' ')); }
  let ok = true;
  for (const z of targets) { console.log(`  ${z.hit ? 'REACHABLE  ' : 'UNREACHABLE'} ${z.name}${verbose && z.hit ? '  (via ' + z.via + ')' : ''}`); if (!z.hit && z.kind !== 'survivor') ok = false; if (!z.hit) ok = false; }
  console.log(`  soft-lock positions: ${stuck.length}${stuck.length ? '  tiles: ' + [...cells].slice(0, 14).join(' ') : ''}`);
  if (stuck.length) ok = false;
  return ok;
}
let all = true; for (const i of only) all = analyse(i) && all;
console.log(all ? '\nREACH: PASS' : '\nREACH: FAIL'); process.exit(all ? 0 : 1);
