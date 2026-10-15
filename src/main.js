// Entry point: loading screen, WebGL capability check, then the game.
import { App } from './game/app.js';

function fail(msg, err) {
  console.error(err || msg);
  const el = document.getElementById('loading');
  if (el) {
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'ld';
    box.style.maxWidth = '560px';
    box.style.padding = '24px';
    box.innerHTML = '<div class="eyebrow" style="color:#ff4d6d">COULD NOT START</div><h2 style="margin:10px 0">SIGNAL//ZERO needs WebGL 2</h2><p style="color:#9fb6c2;line-height:1.6"></p><pre style="white-space:pre-wrap;color:#ff9aa9;font-size:12px"></pre>';
    box.querySelector('p').textContent = msg;
    box.querySelector('pre').textContent = err ? String(err.stack || err.message || err) : '';
    el.append(box);
  }
}

function webgl2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

window.addEventListener('DOMContentLoaded', () => {
  if (!webgl2()) return fail('Your browser or device did not provide a WebGL 2 context. Try a current Chrome, Edge, Firefox or Safari, and check that hardware acceleration is enabled.');
  requestAnimationFrame(() => {
    try {
      window.SZ = new App();
      const el = document.getElementById('loading');
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 700);
    } catch (e) {
      fail('The game failed to initialise.', e);
    }
  });
});
