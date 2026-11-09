/* CLAX world data — levels, cast, script. Pure data + a small level-building DSL (runs in Node for tests).
   Levels are authored in tile units (64px). See docs/LEVEL_DESIGN.md for the vocabulary. */
(function (root) {
'use strict';
const P = root.CLAX_PHYS || require('./phys.js');
const TS = P.TS;

const biomes = [
  { id: 'yard', name: 'Sunken Rescue Yard', subtitle: 'UNAUTHORIZED DEPARTURE', tag: '01 / SALVAGE DISTRICT', sky: ['#092a38', '#29717a'], deep: '#06202b', haze: '#1d6672', accent: '#64e4d6', floor: '#284a49', edge: '#eaa349', shadow: '#092735', tex: 'metal_teal', wall: '#082029', cap: '#e8923f', capDark: '#22323a', fog: 'rgba(16,74,84,' },
  { id: 'fortress', name: 'The Inflatable Fortress', subtitle: 'SAFETY IS MANDATORY', tag: '02 / BUREAU TERRITORY', sky: ['#1b3657', '#81b2c2'], deep: '#1a2f44', haze: '#789fac', accent: '#ffe4a2', floor: '#a07a55', edge: '#ffad4e', shadow: '#263947', tex: 'metal_orange', wall: '#2c2734', cap: '#f3e2bd', capDark: '#c9662c', fog: 'rgba(120,160,180,' },
  { id: 'carnival', name: 'Pressure Trench Carnival', subtitle: 'NO REFUNDS. NO ESCAPE.', tag: '03 / THE LAST RELIEF VALVE', sky: ['#160e32', '#43204d'], deep: '#110e29', haze: '#4e2d69', accent: '#ef95de', floor: '#3c2852', edge: '#f4bf59', shadow: '#1e1634', tex: 'purple', wall: '#150d26', cap: '#f0b84f', capDark: '#4a2060', fog: 'rgba(70,36,110,' }];

const lines = {
  snap: ['Stand back! I am almost qualified!', 'I read HALF the warning!', 'That was a controlled catastrophe.', 'Your concern has been ignored.', 'Not stolen. Urgently reassigned.', 'I brought my own applause.', 'Put that on my heroic record.'],
  dash: ['A perfectly normal walking speed.', 'No brakes. Strong opinions.', 'Coming through! Eventually!', 'Momentum is a recommendation.'],
  hurt: ['That part was rented!', 'Minor setback. Major complaint.', 'My dignity has a warranty!', 'I felt that in my paperwork.'],
  rescue: ['Safety third. People first.', 'One rescue. Hold the paperwork.', 'You are welcome. Tell everybody.', 'Nobody sinks on my shift!'],
  ada: ['Impact detected. Ego remains intact.', 'Rescue successful. Dignity unrecoverable.', 'I have logged that as a landing.', 'Congratulations. You are now the hazard.'],
  burst: ['EMERGENCY! ME!', 'Warning labels are just spoilers.', 'I am the flotation device!'],
  death: ['Still unsinkable. Temporarily elsewhere.', 'Please disregard the previous landing.', 'The suit survived. My argument did not.'],
  swing: ['I meant to grab that!', 'Rated for wreckage. I qualify.', 'Wheee— I mean. Tactical.'],
  float: ['I am the flotation device!', 'Inflating the ego. And the suit.', 'Technically this is still falling.'],
  fall: ['I have logged that as a shortcut.', 'Depth assessment: more than expected.'],
  idle: ['Heroes do not tap their feet. This is a patrol.', 'ADA, how do I look? Do not answer.', 'Any moment now, someone will need me.'],
};

/* Story: the Incident Log. An emergency only exists on paper once witnesses are logged, so every rescue
   makes the Bureau's "zero incidents" record harder to keep. Clax wants his name on the Rescuer line. */
const intros = [
  [['ADA', 'Suit online. Occupant identification: one shrimp. Barnacle Scraper, Third Class. Unlicensed.'],
   ['CLAX', 'Forty-one applications to the Rescue Corps, ADA. Forty-one. Today I am accepting myself.'],
   ['ADA', 'The Bureau has classified Port Flounder as an unapproved emergency. Officially, nothing is happening.'],
   ['DOT', 'Dot here, harbor courier. Drydock locked the public air pumps "pending review". People are stuck out there, and I know every one of them by name.'],
   ['ADA', 'Procedure: an emergency exists once witnesses are entered in the Incident Log. Three per district.'],
   ['CLAX', 'And the Rescuer line? The one where the name goes?'],
   ['ADA', 'Blank. You are not licensed.'],
   ['CLAX', 'Not stolen. Urgently reassigned. Find the yard coupler, fill the log, become a legend. Possibly in that order.']],
  [['DRYDOCK', 'Welcome to the Inflatable Fortress. For your safety, all exits have been removed.'],
   ['CLAX', 'You built a castle out of armbands.'],
   ['ADA', 'Structural assessment: embarrassingly accurate. The floors are load-bearing bounce.'],
   ['DOT', 'The relief valve is in his office, top of the keep. Otto, Nell and old Inspector Brine went in to complain last week. Nobody came out.'],
   ['DRYDOCK', 'Zero recorded incidents in nine years, shrimp. Do you know how I did it?'],
   ['CLAX', 'You stopped recording them.'],
   ['DRYDOCK', '...Take a number.'],
   ['CLAX', 'I am about to become a very expensive safety violation.']],
  [['REFUND', 'Welcome, valued survivor! Breathing is included in our Premium Not-Dead package.'],
   ['DRYDOCK', 'This is Drydock. Do not hang up. It will not take my calls. I signed the air over to it and it changed the locks.'],
   ['CLAX', 'You are on MY radio now? ADA, is he allowed on my radio?'],
   ['ADA', 'He is the only licensed official in range. Regrettably, that is useful.'],
   ['DOT', 'Clax. My gran is down there. Tilly. She only went for the raffle.'],
   ['CLAX', 'No speeches this time. Everybody gets out.'],
   ['ADA', 'Recording that as personal growth. Against considerable evidence.']]];
const outros = [
  [['ADA', 'Pump coupler recovered. Yard witnesses logged. That is more than the Bureau recorded all year.'],
   ['CLAX', 'Please carve that on something expensive.'],
   ['DOT', 'One district breathing. The valve for the rest is in the fortress. Drydock keeps it in his office, next to his awards.'],
   ['CLAX', 'He has awards? I want awards.']],
  [['DRYDOCK', 'You cannot rescue people without an approved rescue plan!'],
   ['CLAX', 'I had a plan. It was mostly the claw.'],
   ['ADA', 'Director. The relief valve housing is empty.'],
   ['DRYDOCK', '...The Bureau outsourced air. To the carnival. Their Refund Department offered zero incidents, guaranteed. It was a very good rate.'],
   ['DOT', 'You SOLD the air?'],
   ['DRYDOCK', 'Leased. With an option to regret.'],
   ['CLAX', 'Then we ruin a perfectly terrible fairground. You are coming on the radio. Bring the fine print.']],
  [['REFUND', 'Your cancellation request has been—'],
   ['CLAX', 'APPROVED.'],
   ['DRYDOCK', 'Clause nine. A logged rescue voids the lease. It needs a licensed name on the Rescuer line. I could sign. The Bureau would have saved the harbor.'],
   ['ADA', 'Or I can enter the unlicensed occupant, and the log is invalid. Clax. You wanted the line.'],
   ['CLAX', '...Put down Pip. And Mabel. Gus. Tilly. All of them. They did the hard part. They waited.'],
   ['ADA', 'Witnesses entered as rescuers of record. Lease void. Pumps restarting.'],
   ['DOT', 'The whole harbor can breathe! Gran says the shrimp can come for dinner.'],
   ['ADA', 'Updating occupant record. License: denied. Rescuer: confirmed.'],
   ['CLAX', 'Hang on. Did you just compliment me?'],
   ['ADA', 'No. That was a system warning.'],
   ['CLAX', 'Good. I was worried we were having a moment. ...Can I at least get a plaque?'],
   ['ADA', 'I have logged that as a no.']]];

const enemyInfo = {
  crab: { name: 'Clamp Crab', hp: 2, w: 86, h: 73, speed: 65, kind: 'walk', score: 100 },
  buoy: { name: 'Buoy Drone', hp: 2, w: 69, h: 100, speed: 44, kind: 'fly', score: 125 },
  turret: { name: 'Barnacle Battery', hp: 3, w: 88, h: 108, speed: 0, kind: 'turret', score: 150 },
  eel: { name: 'Eel Looter', hp: 2, w: 73, h: 104, speed: 123, kind: 'walk', score: 150 },
  warden: { name: 'Pressure Warden', hp: 5, w: 98, h: 124, speed: 54, kind: 'walk', score: 250 },
  torpedo: { name: 'Torpedo Lifeguard', hp: 2, w: 94, h: 64, speed: 82, kind: 'charge', score: 175 },
  guard: { name: 'Buoy Enforcer', hp: 4, w: 94, h: 119, speed: 42, kind: 'shield', score: 200 },
  puffer: { name: 'Puffer Barker', hp: 3, w: 90, h: 100, speed: 47, kind: 'puffer', score: 175 },
  carnival: { name: 'Ticket Collector', hp: 5, w: 104, h: 121, speed: 64, kind: 'walk', score: 250 } };
const bosses = [
  { sprite: 'crab', name: 'FOREMAN CLAMPRIGHT', title: 'Certified to make things worse.', hp: 24, w: 232, h: 202, kind: 'clamp' },
  { sprite: 'warden', name: 'DIRECTOR DRYDOCK', title: 'There is a form for that explosion.', hp: 34, w: 200, h: 278, kind: 'director' },
  { sprite: 'carnival', name: 'THE REFUND DEPARTMENT', title: 'Your safety is our recurring revenue.', hp: 42, w: 286, h: 302, kind: 'refund' }];

/* ------------------------------------------------------------------ level builder */
function builder(index, cols, rows) {
  const g = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const bk = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const L = { index, biome: biomes[index], cols, rows, width: cols * TS, height: rows * TS, grid: g, back: bk, movers: [], hooks: [], springs: [],
    enemies: [], pickups: [], npcs: [], vents: [], crates: [], checkpoints: [], signs: [], areas: [], radio: [], hints: [], deco: [], boss: null, exit: null, start: null };
  let id = 0;
  const inb = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;
  const set = (c, r, ch) => { if (inb(c, r)) g[r][c] = ch; };
  const B = {
    L, set,
    R(c, r, w, h, ch = '#') { for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) set(x, y, ch); },
    C(c, r, w, h) { B.R(c, r, w, h, ' '); },
    BK(c, r, w, h, ch = 'w') { for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (inb(x, y)) bk[y][x] = ch; },
    deck(c, r, w) { B.R(c, r, w, 1, '='); },
    spikes(c, r, w) { B.R(c, r, w, 1, '^'); },
    /* terrain profile: walks right from column c with the walking surface on top of row r.
       F flat, U/D 45° up/down, u/d gentle up/down, G gap (pit), O bouncy flat, H flat with spikes on top, S±n step. */
    T(c, r, spec, depth = rows) {
      const fill = (x, y0) => { for (let y = y0; y < Math.min(rows, y0 + depth); y++) set(x, y, '#'); };
      for (const tok of spec.trim().split(/\s+/)) {
        const k = tok[0], n = parseInt(tok.slice(1), 10);
        for (let i = 0; i < (k === 'S' ? 1 : n); i++) {
          if (k === 'F') { fill(c, r); c++; }
          else if (k === 'O') { fill(c, r); set(c, r, 'o'); c++; }
          else if (k === 'H') { fill(c, r); set(c, r - 1, '^'); c++; }
          else if (k === 'G') { c++; }
          else if (k === 'U') { set(c, r - 1, '/'); fill(c, r); c++; r--; }
          else if (k === 'D') { set(c, r, '\\'); fill(c, r + 1); c++; r++; }
          else if (k === 'u') { set(c, r - 1, 'a'); set(c + 1, r - 1, 'b'); fill(c, r); fill(c + 1, r); c += 2; r--; }
          else if (k === 'd') { set(c, r, 'c'); set(c + 1, r, 'd'); fill(c, r + 1); fill(c + 1, r + 1); c += 2; r++; }
          else if (k === 'S') { r += n; }
        }
      }
      return { c, r };
    },
    px: c => (c + .5) * TS,
    gy(c, r) { const y = P.groundBelow(L, (c + .5) * TS, r * TS, rows * TS); return y === null ? r * TS : y; },
    E(type, c, r, o = {}) {
      const e = enemyInfo[type], fly = ['fly', 'charge', 'puffer'].includes(e.kind), x = B.px(c), y = fly ? r * TS : B.gy(c, r), i = L.enemies.length;
      L.enemies.push({ type, x, y, originX: x, originY: y, ...e, dir: i % 2 ? -1 : 1, t: i * .74, phase: i * .83, hp: e.hp, maxHp: e.hp, cool: 1.1 + i % 3 * .4, hit: 0, dead: false, vy: 0, range: 150, ...o });
    },
    tag(c, r) { L.pickups.push({ id: id++, x: B.px(c), y: r * TS, kind: 'tag' }); },
    tags(c, r, n, dc = 1, dr = 0) { for (let i = 0; i < n; i++) B.tag(c + i * dc, r + i * dr); },
    arc(c, r, n, w, h) { for (let i = 0; i < n; i++) { const t = n === 1 ? .5 : i / (n - 1); B.tag(c + t * w, r - Math.sin(t * Math.PI) * h); } },
    trail(c0, c1, r, step = 1.5) { for (let c = c0; c <= c1; c += step) { const y = P.groundBelow(L, (c + .5) * TS, r * TS, 900); if (y !== null) L.pickups.push({ id: id++, x: B.px(c), y: y - 52, kind: 'tag' }); } },
    item(kind, c, r) { L.pickups.push({ id: id++, x: B.px(c), y: B.gy(c, r) - 56, kind }); },
    crate(c, r) { L.crates.push({ x: B.px(c), y: B.gy(c, r), w: 47, h: 49, broken: false }); },
    npc(c, r, name, who, line) { L.npcs.push({ id: L.npcs.length, x: B.px(c), y: B.gy(c, r), rescued: false, name, who, line, kind: L.npcs.length % 3 }); },
    cp(c, r) { L.checkpoints.push({ x: B.px(c), y: B.gy(c, r), active: false, index: L.checkpoints.length }); },
    hook(c, r, o = {}) { const x = B.px(c), y = r * TS; L.hooks.push({ x, y, baseX: x, baseY: y, ax: (o.ax || 0) * TS, ay: (o.ay || 0) * TS, speed: o.speed || 1, phase: o.phase || 0, anchorY: (o.anchor === undefined ? r - 6 : o.anchor) * TS }); },
    spring(c, r, vy = -1120, vx = 0, lock = .35) { L.springs.push({ x: B.px(c), y: B.gy(c, r), vy, vx, lock, fired: 0 }); },
    mover(c, r, w, o = {}) { const x = c * TS, y = r * TS; L.movers.push({ kind: 'moving', x, y, baseX: x, baseY: y, w: w * TS, h: 26, ax: (o.ax || 0) * TS, ay: (o.ay || 0) * TS, speed: o.speed || 1, phase: o.phase || 0, dx: 0, dy: 0 }); },
    crumble(c, r, w) { L.movers.push({ kind: 'crumble', x: c * TS, y: r * TS, w: w * TS, h: 26, timer: 0, absent: 0, dx: 0, dy: 0 }); },
    wheel(cc, cr, radius, n, speed, w = 2.4) { for (let i = 0; i < n; i++) L.movers.push({ kind: 'wheel', cx: cc * TS, cy: cr * TS, radius: radius * TS, speed, phase: i / n * Math.PI * 2, w: w * TS, h: 26, x: 0, y: 0, dx: 0, dy: 0, hub: i === 0, count: n }); },
    vent(c, r, phase = 0) { L.vents.push({ x: B.px(c), y: B.gy(c, r), phase, period: 3.4 - index * .2 }); },
    sign(c, r, text) { L.signs.push({ x: B.px(c), y: B.gy(c, r), text }); },
    area(c, name, sub, r0 = 0, r1 = rows) { L.areas.push({ x: c * TS, y0: r0 * TS, y1: r1 * TS, name, sub, seen: false }); },
    radio(c, script, r0 = 0, r1 = rows) { L.radio.push({ x: c * TS, y0: r0 * TS, y1: r1 * TS, script, seen: false }); },
    hint(c, text, sub, r0 = 0, r1 = rows) { L.hints.push({ x: c * TS, y0: r0 * TS, y1: r1 * TS, text, sub, seen: false }); },
    deco(t, c, r, o = {}) { L.deco.push({ t, x: c * TS, y: r * TS, ...o }); },
    start(c, r) { L.start = { x: B.px(c), y: B.gy(c, r) }; },
    arena(c0, c1, r, exitC) {
      const sp = bosses[index], y = r * TS, bx = (c1 - 5) * TS;
      L.boss = { ...sp, x: bx, y, originX: bx, originY: y, minX: (c0 + 2) * TS, maxX: (c1 - 1.5) * TS, gate: (c0 - 1.5) * TS, dir: -1, t: 0, cool: 1.9, attackPhase: 'idle', hp: sp.hp, maxHp: sp.hp, hit: 0, dead: false, active: false, phaseTime: 0 };
      L.exit = { x: B.px(exitC), y };
    },
    done() { L.grid = g.map(r => r.join('')); L.back = bk.map(r => r.join('')); P.stepMovers(L, 0, 0); return L; },
  };
  return B;
}

/* ------------------------------------------------------------------ 01 SUNKEN RESCUE YARD */
function yard() {
  const B = builder(0, 246, 42), { T, R, C, BK, deck, E } = B;
  // -- Slipway Nine: the stolen launch
  T(0, 27, 'F8 d3 F10 u1 F3 d1 F6 G3 F8');
  B.start(3, 20); B.sign(6, 20, 'RESCUE FIRST.\nASK LATER.');
  B.area(0, 'SLIPWAY NINE', 'Where the suit was parked. Was.');
  deck(17, 28, 4); B.tags(17, 27.2, 4); B.trail(9, 15, 20); B.trail(22, 35, 22); B.arc(36.5, 28.6, 5, 4, 1.6);
  B.hint(12, 'SPACE to jump. Press again in the air for a vent-hop.', 'Hold it after the second jump to inflate and float.');
  E('crab', 44, 26); B.crate(42, 26); B.trail(40, 46, 26);
  B.deco('crane', 2, 27, { h: 9 }); B.deco('chain', 11, 16, { len: 7 }); B.deco('lamp', 21, 30); B.deco('chain', 30, 15, { len: 9 }); B.deco('buoy', 26, 29);
  // -- The Heap: scrapped lifeboats
  T(48, 30, 'U2 F3 D1 F2 u1 F4 D2 F4 G6 F5 U1 F9 G10 F6');
  B.area(48, 'THE HEAP', 'Scrapped lifeboats. Boats imply sinking.');
  B.radio(50, [['DOT', 'That heap used to be the Yard lifeboats. The Bureau scrapped them. Boats imply sinking.'], ['CLAX', 'So does water. Nobody scrapped that.']]);
  E('crab', 51, 24); E('buoy', 59, 24.2); E('eel', 65, 26);
  deck(58, 25, 4); deck(64, 23, 4); B.tags(58, 24.2, 4); B.npc(66, 20, 'PIP', 'the lamp-keeper\'s kid', 'My rescuer has a warning label.'); B.tags(64, 22.2, 2);
  B.trail(49, 66, 22, 2);
  B.hook(71, 25); B.arc(68, 27.5, 6, 6, -1.4);
  B.hint(65, 'SNAP (J) in mid-air near a ring to grab it with the claw.', 'Steer the swing with A / D. Jump to let go.');
  B.radio(67, [['ADA', 'Overhead ring detected. The claw is rated for lifting wreckage. You are, technically, wreckage.']]);
  B.item('pressure', 76, 26); E('turret', 77, 26); E('crab', 84, 25); R(82, 27, 4, 2); R(85, 26, 2, 1); B.crate(86, 20); B.trail(80, 81, 25);
  B.hook(92, 23.6); B.hook(96, 23.6); B.crumble(93, 30, 2); B.arc(89.5, 26.5, 8, 9, -1.2);
  B.cp(101, 24);
  B.deco('chain', 54, 14, { len: 10 }); B.deco('crane', 76, 30, { h: 11, flip: true }); B.deco('lamp', 60, 28); B.deco('buoy', 87, 25); B.deco('lamp', 103, 29);
  // -- The S.S. Caution: never sailed, too risky
  T(105, 29, 'F4'); T(109, 36, 'F44'); R(109, 14, 44, 22); BK(109, 14, 44, 22);
  C(109, 26, 2, 3);                       // breach
  C(111, 22, 14, 7); deck(114, 25, 4);    // cargo hold (A)
  C(122, 29, 3, 2);                       // hatch down to the bilge
  C(111, 31, 30, 5); B.spikes(115, 35, 3); B.spikes(128, 35, 4);   // bilge
  C(125, 26, 1, 3); C(126, 22, 12, 7);    // door + boiler room (C)
  C(138, 14, 4, 22);                      // funnel shaft, open to the sky
  deck(140, 32, 2); deck(138, 28, 2); deck(140, 24, 2); deck(138, 20, 2); deck(140, 17, 2);
  T(153, 14, 'D15');                      // the bow, one long slide
  B.area(107, 'THE S.S. CAUTION', 'Never sailed. Too risky.');
  B.radio(108, [['DOT', 'The S.S. Caution. Built to evacuate the whole harbor. Never sailed. Too risky.'], ['ADA', 'Hull breach ahead. I recommend not making a second one.']]);
  E('eel', 116, 24); B.crate(113, 24); B.crate(119, 24); B.tags(114, 24.2, 4); B.tags(112, 28.2, 9);
  B.hint(120, 'Drop through the hatch for the bilge. Someone is knocking.', 'Or jump the gap and keep going. Rescues are optional, and worth it.', 26, 30);
  B.npc(112, 33, 'MABEL', 'cook of a ship that never left', 'I have been making soup for a voyage since March.');
  E('crab', 121, 33); E('crab', 134, 33); B.tags(118, 34.2, 9); B.item('health', 113, 33);
  E('turret', 133, 26); B.item('pressure', 129, 26); B.tags(127, 28.2, 5);
  B.hint(136, 'Climb the funnel. Push into a wall while falling to slide; jump to kick off.', 'The decks work too, if you prefer dignity.', 22, 36);
  B.tags(139.5, 30, 7, 0, -2.2);
  B.cp(144, 10); E('buoy', 148, 11.3); E('torpedo', 132, 11.6); E('crab', 120, 10); B.trail(112, 136, 10, 2); B.trail(153, 167, 13, 1.5);
  B.radio(142, [['CLAX', 'Top deck! ADA, log that I conquered a ship.'], ['ADA', 'Logged: occupant climbed a chimney.']], 0, 15);
  R(145, 11, 5, 3); C(146, 12, 3, 2); BK(146, 12, 3, 2); B.deco('porthole', 147, 12.4);   // wheelhouse shell (cosmetic nook)
  for (const c of [113, 118, 128, 133]) B.deco('porthole', c, 23.5);
  for (const c of [114, 120, 126, 132]) B.deco('porthole', c, 32.6);
  B.deco('lamp', 117, 22, { hang: true }); B.deco('lamp', 131, 22, { hang: true }); B.deco('pipe', 111, 30.6, { w: 30 }); B.deco('flag', 151, 14); B.deco('chain', 124, 4, { len: 9 });
  // -- Gantry Line
  T(168, 29, 'F6 G4 F3 G14 F4 U2 F8 D2 F6');
  B.area(168, 'GANTRY LINE', 'The cranes still run. Nobody asked them to.');
  B.radio(170, [['DRYDOCK', 'Attention, unauthorized hero. Your heroics have not been scheduled. Please stop being brave until further notice.'], ['CLAX', 'He knows my job title!']]);
  B.vent(171, 26, 0); B.arc(174, 27.6, 4, 3, 1.4); E('torpedo', 179, 26.4);
  B.hook(184.5, 23, { ax: 1.6, speed: 1.1 }); B.hook(190.5, 23, { ax: 1.6, speed: 1.1, phase: 2.2 }); B.mover(185.5, 30, 2.5, { ax: 3.4, speed: .8 });
  B.arc(181.5, 26.4, 10, 12, -1.3);
  B.hint(178, 'The crane rings move. So should you.', 'A slow platform runs below if the claw is feeling shy.');
  R(203, 19, 2, 4); deck(205, 23, 3); B.deco('chain', 204, 9, { len: 9 }); B.spring(206.5, 24); B.npc(203.5, 15, 'GUS', 'crane operator', 'I have been up here since Tuesday. Nice view. No stairs.'); B.tags(205.5, 22.2, 3);
  E('eel', 197, 26); E('crab', 207, 24); B.vent(212, 26, 1.2); B.item('pressure', 198, 26); B.crate(214, 26);
  B.cp(215, 26);
  B.deco('crane', 180, 29, { h: 12 }); B.deco('crane', 196, 29, { h: 12, flip: true }); B.deco('chain', 187, 12, { len: 8 }); B.deco('lamp', 201, 27); B.deco('lamp', 169, 29);
  // -- The Pump House
  T(217, 29, 'F29'); deck(223, 26, 4); deck(235, 26, 4); R(217, 0, 1, 23); BK(218, 17, 28, 12, 'v');
  B.area(218, 'THE PUMP HOUSE', 'One coupler. One foreman. One opinion.');
  B.arena(218, 244, 29, 243);
  B.deco('pipe', 218, 19, { w: 27 }); B.deco('lamp', 226, 17, { hang: true }); B.deco('lamp', 238, 17, { hang: true });
  L1.objective = 'Find the pump coupler. Log three witnesses if you can reach them.';
  return B.done();
}
const L1 = {};

/* ------------------------------------------------------------------ 02 THE INFLATABLE FORTRESS */
function fortress() {
  const B = builder(1, 195, 62), { T, R, C, BK, deck, E } = B;
  // -- Visitor Processing
  T(0, 54, 'F9 O3 F5 S-3 F7 O3 S-4 F9');
  B.start(3, 48); B.sign(6, 48, 'YOUR SAFETY\nIS NOT OPTIONAL.');
  B.area(0, 'VISITOR PROCESSING', 'Please take a number. The numbers are not for you.');
  B.hint(7, 'The pale floor is inflated. Land on it to bounce.', 'Hold JUMP as you land to bounce much higher.');
  B.trail(4, 16, 50, 1.5); B.arc(9, 51.5, 5, 3, 2.5); E('guard', 21, 48); B.tags(17.5, 49.5, 5); B.arc(24, 48.5, 5, 3, 3); E('buoy', 26, 43.5);
  E('warden', 32, 44); B.crate(30, 44); B.item('pressure', 34, 44); B.cp(35, 44);
  B.deco('flag', 14, 51); B.deco('banner', 18, 46.4, { text: 'NOW SERVING: NOBODY' }); B.deco('flag', 27, 47); B.deco('lamp', 31, 47);
  // -- The Bouncy Bailey
  T(36, 47, 'F3 G2 O8 F2 U2 F5 O4 G3 F6 S-3 F9');
  B.area(36, 'THE BOUNCY BAILEY', 'A courtyard rated for fun. Fun has since been prohibited.');
  B.radio(38, [['DRYDOCK', 'The bailey is inflated to regulation firmness. Any enjoyment you experience is a malfunction.'], ['CLAX', 'ADA, log one malfunction.']]);
  deck(43, 42, 3); deck(48, 40, 3); B.tags(43, 41.2, 3); B.tags(48, 39.2, 3); B.npc(49, 37, 'OTTO', 'filed a complaint in person', 'I only asked where the exit was. That was the offence.');
  E('turret', 54, 43); E('guard', 56, 42); B.arc(41, 45, 8, 8, 3.5); B.trail(53, 58, 42, 1.5);
  E('buoy', 61, 40); B.arc(59, 44, 4, 4, 3);
  E('torpedo', 67, 43.6); B.item('pressure', 66, 44); B.spring(70.5, 44, -1180); B.tags(70.5, 42, 4, 0, -1.2);
  B.hint(66, 'Wall too tall? Springs, bounce floors and wall kicks all stack.', '');
  E('warden', 75, 39); B.crate(77, 39); B.cp(79, 39);
  B.deco('flag', 44, 47); B.deco('banner', 53, 41.4, { text: 'NO RUNNING. NO WALKING.' }); B.deco('flag', 71, 40); B.deco('lamp', 76, 42);
  // -- The Tower of Forms (interior climb)
  R(80, 12, 26, 49); BK(80, 12, 26, 49);
  C(80, 36, 2, 3); C(82, 13, 22, 47);                 // door + hollow keep; floor at row 60 is the solid base
  R(82, 42, 22, 18);                                  // raise ground floor to row 42 (entry level is row 42)
  C(80, 39, 2, 3); R(80, 36, 2, 3);                   // the door is at the entry level
  // storeys (solid slabs with gaps), bottom to top
  R(82, 36, 16, 1); R(88, 30, 16, 1); R(82, 24, 15, 1); R(89, 18, 15, 1);
  deck(99, 39, 3); deck(84, 33, 3); deck(99, 27, 3); deck(84, 21, 3);
  B.mover(100.5, 36, 2.4, { ay: 2.6, speed: .9 }); B.mover(83.2, 30, 2.4, { ay: 2.6, speed: .9, phase: 1.5 });
  B.area(81, 'THE TOWER OF FORMS', 'Every floor is a department. Every department is closed.', 30, 43);
  B.radio(84, [['ADA', 'Directory. Floor one: Complaints. Floor two: Complaints about Complaints. Floor three: Lost Property, including the first two floors.']], 36, 43);
  E('guard', 90, 40); B.crate(86, 40); B.tags(85, 41.2, 8); B.item('pressure', 96, 40);
  E('warden', 90, 34); E('turret', 84, 34); B.tags(87, 35.2, 8); B.sign(94, 34, 'FORM 12-B:\nPERMISSION TO ASK.');
  E('guard', 96, 28); E('buoy', 91, 26.6); B.tags(91, 29.2, 9); B.npc(102, 28, 'NELL', 'queue number 4,000,112', 'They are serving number six. I have snacks for a decade.');
  E('warden', 88, 22); E('turret', 95, 22); B.tags(84, 23.2, 9); B.item('health', 83, 22);
  B.hint(100, 'Lifts and decks go up. So does a wall kick, if you are in a hurry.', '', 36, 43);
  E('guard', 96, 16); B.tags(91, 17.2, 9); B.cp(92, 16); C(104, 15, 2, 3);          // top-floor door out to the ramparts
  for (const r of [38.4, 32.4, 26.4, 20.4]) { B.deco('window', 86, r); B.deco('window', 93, r); B.deco('window', 100, r); }
  B.deco('banner', 90, 13.6, { text: 'DEPARTMENT OF DEPARTMENTS' });
  // -- The Ramparts
  T(106, 18, 'F5 S-1 F2 S1 F3 G5 F3 S-1 F2 S1 F4 G12 F5 U2 F6 G4 F6 S-2 F7');
  B.area(106, 'THE RAMPARTS', 'Mind the gaps. The gaps are mandatory.', 0, 22);
  B.radio(108, [['DOT', 'You are on the wall! His office is the big dome at the end. Look for the awards.'], ['DRYDOCK', 'They are participation awards. I participated in giving them to myself.']], 0, 22);
  E('torpedo', 112, 15.3); B.trail(107, 115, 14, 1.5); B.hook(118.5, 12.6); B.arc(116, 15.4, 5, 5, -1.2);
  E('guard', 122, 15); E('turret', 126, 15); B.item('pressure', 124, 15);
  B.hook(131, 12, { ax: 1.4, speed: 1 }); B.hook(136.5, 12, { ax: 1.4, speed: 1, phase: 2 }); B.mover(131.5, 19, 2.5, { ax: 3.2, speed: .75 }); B.arc(128.5, 15.2, 9, 11, -1.4);
  deck(142, 14, 4); B.npc(144, 12.5, 'BRINE', 'former safety inspector', 'I found one problem. He promoted me to prisoner.'); B.tags(142, 13.2, 4);
  E('warden', 146, 13); E('buoy', 141, 10.6); B.vent(151, 13, .6); B.spring(154, 14, -1150, 420, .3); B.arc(152, 14, 5, 5, 2);
  B.cp(160, 12); E('torpedo', 163, 14.4); B.item('health', 162, 12); B.crate(164, 12);
  for (const c of [107, 113, 121, 127, 141, 151, 158]) B.deco('flag', c, 18);
  B.deco('banner', 121, 14.4, { text: 'KEEP OFF THE KEEP' });
  // -- The Director's Office
  T(166, 14, 'F29'); R(166, 0, 1, 8); deck(172, 11, 4); deck(184, 11, 4); BK(167, 2, 28, 12, 'v');
  B.area(167, 'THE DIRECTOR\'S OFFICE', 'Nine years. Zero incidents. One shrimp.', 0, 22);
  B.arena(167, 193, 14, 192);
  B.deco('window', 172, 6); B.deco('window', 180, 6); B.deco('window', 188, 6); B.deco('banner', 176, 3.6, { text: 'ZERO RECORDED INCIDENTS' });
  B.L.objective = 'Climb the keep. Break the Bureau lock. Recover the relief valve.';
  return B.done();
}

/* ------------------------------------------------------------------ 03 PRESSURE TRENCH CARNIVAL */
function carnival() {
  const B = builder(2, 213, 60), { T, R, C, BK, deck, E } = B;
  // -- The Midway
  T(0, 16, 'F12 G3 F6 G4 F9 G6 F8');
  B.start(3, 10); B.sign(6, 10, 'EVERY PRIZE\nIS A LIABILITY.');
  B.area(0, 'THE MIDWAY', 'Step right up. Stepping back is extra.');
  R(8, 13, 3, 3); deck(8, 11, 3); B.tags(8, 10.2, 3); B.trail(4, 20, 12, 1.5); E('puffer', 14, 12.4);
  B.crumble(21.5, 15, 2); R(26, 13, 4, 3); deck(26, 10, 4); B.tags(26, 9.2, 4); E('carnival', 31, 12); B.crate(29, 8);
  B.hint(18, 'Cracked platforms fall away. Keep moving.', '');
  B.crumble(35, 15, 2); B.crumble(38, 14, 2); B.arc(34.5, 13.6, 6, 6, 1.4); B.npc(28, 8, 'LULU', 'grand prize winner', 'I won the grand prize. It was a bill.');
  E('eel', 43, 12); E('puffer', 46, 11.6); B.item('pressure', 45, 12); B.cp(47, 12);
  B.deco('tent', 3, 16, { s: 1.2 }); B.deco('bulbs', 1, 9, { w: 11 }); B.deco('tent', 16, 16, {}); B.deco('bulbs', 15, 9.5, { w: 15 }); B.deco('banner', 30, 6.6, { text: 'WIN NOTHING! PAY ANYWAY!' }); B.deco('tent', 42, 16, { s: 1.1 }); B.deco('bulbs', 39, 9, { w: 9 });
  // -- The Coaster of Liabilities: one long drop into the trench
  T(48, 16, 'D4 F3 d3 F3 D5 F2 G5 F4 D4 d2 F5 G6 F3 D6 F8');
  B.area(48, 'THE COASTER OF LIABILITIES', 'You must be this insured to ride.', 0, 50);
  B.radio(50, [['REFUND', 'Thank you for choosing gravity! A convenience fee has been added to your descent.'], ['CLAX', 'Bill me at the bottom.']], 0, 30);
  B.trail(48, 70, 14, 1.2); B.arc(70.5, 27, 6, 5, 1.8); B.trail(76, 91, 26, 1.2); B.arc(92, 33.6, 7, 6, 1.8); B.trail(98, 106, 32, 1.2); B.trail(107, 115, 40, 1.5);
  E('torpedo', 56, 18); E('eel', 62, 21); E('puffer', 74, 23); E('carnival', 78, 26); E('torpedo', 88, 30.6); E('eel', 100, 33); E('buoy', 96, 30);
  B.spring(69.5, 26, -700, 620, .4); B.spring(91.5, 33, -760, 640, .4);
  B.hint(52, 'Downhill is faster. The vent-dash (K) keeps that speed in the air.', '');
  B.deco('bulbs', 48, 12, { w: 20, sag: 5 }); B.deco('bulbs', 72, 22, { w: 18, sag: 6 }); B.deco('banner', 60, 15, { text: 'KEEP ARMS INSIDE THE DEBT' }); B.deco('tent', 110, 43, { s: 1.3 }); B.deco('bulbs', 96, 29, { w: 16, sag: 6 });
  B.cp(109, 40); E('carnival', 112, 40); B.item('health', 114, 40);
  // -- The Hall of Refunds (fun-house interior, down then through)
  T(116, 43, 'F34'); R(116, 26, 34, 17); BK(116, 26, 34, 17);
  C(116, 37, 2, 3);                              // way in (a step down into the lobby)
  C(118, 35, 12, 8); B.spikes(121, 42, 4);      // lobby with a prize pit
  deck(120, 38, 3); deck(125, 37, 3);
  C(130, 37, 2, 3);                              // corridor
  C(132, 28, 8, 15);                             // mirror shaft
  deck(132, 39, 3); deck(137, 36, 3); deck(132, 33, 3); deck(137, 30, 3);
  C(140, 28, 8, 4); C(146, 32, 2, 8);            // upper gallery then the drop
  C(140, 37, 10, 6); B.spikes(141, 42, 3);      // exit room
  C(148, 40, 2, 3);                              // way out
  B.area(117, 'THE HALL OF REFUNDS', 'All complaints are reflected back at you.', 26, 44);
  B.radio(119, [['DRYDOCK', 'I have the lease open. Clause four: the lessee may charge for air, light, and "atmosphere".'], ['CLAX', 'Read faster. Skip to the part where I win.']], 26, 44);
  E('puffer', 127, 36.6); B.tags(120, 37.2, 3); B.tags(125, 36.2, 3); B.crate(119, 40); B.item('pressure', 128, 40);
  B.tags(133.5, 38, 4, 1.2, -2.4); E('buoy', 135, 34); E('carnival', 143, 30); B.tags(141, 31.2, 5);
  B.npc(138.5, 28, 'FITZ', 'ride operator', 'I pulled the stop lever. It filed a counter-claim.'); B.tags(137, 29.2, 3);
  B.hint(133, 'Up the mirror shaft. Decks on both sides, walls for kicking.', '', 30, 44);
  E('eel', 145, 40); B.item('health', 147, 34);
  for (const c of [120, 126, 142]) B.deco('window', c, 36.2);
  B.deco('bulbs', 118, 35.3, { w: 12, sag: 1 }); B.deco('bulbs', 140, 28.3, { w: 8, sag: 1 }); B.deco('banner', 133, 27, { text: 'HALL OF REFUNDS' });
  // -- The Big Wheel
  T(150, 43, 'F5 G22 S-17 F7'); B.cp(150, 40);
  B.area(151, 'THE BIG WHEEL', 'It only goes round. Getting off is premium.', 20, 50);
  B.radio(152, [['DOT', 'Gran is at the top of that wheel. She says the view is lovely and the company is a puffer fish with a megaphone.'], ['CLAX', 'Tell her the flotation device is on its way.']], 20, 50);
  B.wheel(166, 35, 8, 8, .42, 2.6);
  B.hook(158, 30); B.hook(174, 26); E('puffer', 161, 27); E('puffer', 171, 31); E('buoy', 166, 23);
  B.arc(158, 35, 12, 16, 8.5); deck(165, 23, 3); B.npc(166, 20, 'TILLY', 'Dot\'s gran', 'Are you the hero? You are much shorter on the radio.');
  B.hint(153, 'Ride a gondola up and step off at the top right.', 'Tilly is on the little deck above the hub. Jump from a gondola at its peak.', 20, 50);
  B.cp(179, 22); B.item('pressure', 181, 22); B.crate(182, 22);
  B.deco('bulbs', 151, 38, { w: 5 }); B.deco('tent', 180, 26, { s: 1.1 }); B.deco('bulbs', 177, 20, { w: 8 });
  // -- The Refund Department
  T(184, 26, 'F29'); R(184, 0, 1, 20); deck(190, 23, 4); deck(202, 23, 4); BK(185, 14, 28, 12, 'v');
  B.area(185, 'THE REFUND DEPARTMENT', 'Your call is important to our revenue.', 0, 30);
  B.arena(185, 211, 26, 210);
  B.deco('bulbs', 185, 15, { w: 26, sag: 3 }); B.deco('banner', 195, 15.6, { text: 'NO REFUNDS. NO ESCAPE.' });
  B.L.objective = 'Open the final valve. Give the harbor its air back.';
  return B.done();
}

function make(index) {
  const L = [yard, fortress, carnival][index]();
  if (index === 0) L.objective = L1.objective;
  return L;
}
const api = { biomes, lines, intros, outros, enemyInfo, bosses, make, TS };
root.CLAX_WORLD = api;
if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
