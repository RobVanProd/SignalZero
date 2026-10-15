import { World } from './world/world.js';
import { Engine } from './engine/engine.js';
import { buildDistrict } from './content/district.js';
import { buildMissionStart } from './content/missions.js';

const params = new URLSearchParams(location.search);
const world = new World(document.getElementById('view'), params.get('q') || 'high');
const eng = buildMissionStart(buildDistrict, Engine, Number(params.get('m') || 0));
world.sync(eng, {});
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  world.frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setInterval(() => { eng.advance(0.5); world.sync(eng, {}); }, 500);
window.__SZ__ = { world, eng, cam: (x, z, yaw, pitch = -0.05) => world.controls.teleport(x, z, yaw, pitch) };
