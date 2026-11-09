// ASCII dump of a level: node tools/dump.js <index> [c0] [c1] [r0] [r1]
const W = require('../src/world.js');
const [i, c0 = 0, c1 = 9999, r0 = 0, r1 = 9999] = process.argv.slice(2).map(Number);
const L = W.make(i), TS = 64;
const g = L.grid.map(r => r.split(''));
const put = (x, y, ch) => { const c = Math.floor(x / TS), r = Math.floor((y - 1) / TS); if (g[r] && g[r][c] === ' ') g[r][c] = ch; };
L.enemies.forEach(e => put(e.x, e.y, 'E')); L.npcs.forEach(e => put(e.x, e.y, 'N')); L.checkpoints.forEach(e => put(e.x, e.y, 'C'));
L.hooks.forEach(e => put(e.x, e.y + 1, 'J')); L.springs.forEach(e => put(e.x, e.y, 'S')); L.movers.forEach(e => { for (let x = e.x; x < e.x + e.w; x += TS) put(x, e.y + 1, e.kind === 'crumble' ? '~' : 'M'); });
L.pickups.forEach(e => put(e.x, e.y, e.kind === 'tag' ? '.' : '+')); L.crates.forEach(e => put(e.x, e.y, 'x')); put(L.start.x, L.start.y, 'P'); put(L.exit.x, L.exit.y, 'X'); put(L.boss.x, L.boss.y, 'B');
let head = '    '; for (let c = c0; c < Math.min(c1, L.cols); c++) head += c % 10 === 0 ? String(c / 10 % 10 | 0) : c % 5 === 0 ? '+' : ' ';
console.log(head);
g.forEach((row, r) => { if (r >= r0 && r <= r1) console.log(String(r).padStart(3) + ' ' + row.slice(c0, c1).join('').replace(/\s+$/, '')); });
console.log(head, '\ncols', L.cols, 'rows', L.rows, 'enemies', L.enemies.length, 'tags', L.pickups.filter(p => p.kind === 'tag').length);
