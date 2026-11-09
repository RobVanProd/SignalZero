// Build the single-file game: node tools/build.js  ->  dist/Clax_Play.html
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), rd = f => fs.readFileSync(path.join(root, f), 'utf8');
const SKIP = /^(player_body|player_leg_\d|.*_distant)\.webp$/;      // superseded by the rig parts / unused
const assets = {};
for (const f of fs.readdirSync(path.join(root, 'assets')).sort()) if (f.endsWith('.webp') && !SKIP.test(f)) assets[f.replace('.webp', '')] = 'data:image/webp;base64,' + fs.readFileSync(path.join(root, 'assets', f)).toString('base64');
const game = fs.readdirSync(path.join(root, 'src/game')).sort().map(f => rd('src/game/' + f)).join('\n');
const html = rd('src/shell.html') +
  `<script>window.CLAX_ASSETS=${JSON.stringify(assets)};window.CLAX_RIG=${JSON.stringify(JSON.parse(rd('src/rig.json')))};</script>` +
  `<script>${rd('src/phys.js')}</script><script>${rd('src/world.js')}</script><script>${rd('src/audio.js')}</script><script>${game}</script></body></html>\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/Clax_Play.html'), html);
console.log('dist/Clax_Play.html', (html.length / 1024).toFixed(0) + ' KB');
