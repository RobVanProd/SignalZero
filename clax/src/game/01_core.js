/* CLAX v0.2 — fixed 120 Hz physics, interpolated canvas rendering. Entirely offline.
   The files in src/game/ are fragments of one async function; tools/build.js concatenates them in name order. */
'use strict';
(async () => {
const W = 1280, H = 720, STEP = 1 / 120, DB = window.CLAX_WORLD, P = window.CLAX_PHYS, TS = P.TS, RIG = window.CLAX_RIG;
const canvas = document.getElementById('game'), ctx = canvas.getContext('2d', { alpha: false }), ui = document.getElementById('interface'), $ = s => document.querySelector(s), images = {};
await Promise.all(Object.entries(CLAX_ASSETS).map(([k, src]) => new Promise(ok => { const im = new Image(); im.onload = () => { images[k] = im; ok(); }; im.onerror = () => { console.warn('Missing art', k); ok(); }; im.src = src; })));
let seed = 7391; const rand = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), lerp = (a, b, t) => a + (b - a) * t, approach = (a, b, d) => a < b ? Math.min(a + d, b) : Math.max(a - d, b),
  ease = (a, b, r, dt) => lerp(a, b, 1 - Math.exp(-r * dt)), mod = (x, m) => (x % m + m) % m, hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function box(x, y, w, h, fill, stroke = null, r = 8, lw = 2, c = ctx) { c.beginPath(); c.roundRect(x, y, Math.max(0, w), h, r); c.fillStyle = fill; c.fill(); if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); } }
function text(s, x, y, size = 16, color = '#fff3d8', align = 'left', weight = 700) { ctx.font = `${weight} ${size}px ${size > 32 ? 'Impact, ' : ''}Arial,sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = color; ctx.fillText(s, x, y); }
function image(n, x, y, w, h, flip = false, alpha = 1) { const im = images[n]; if (!im) return; ctx.save(); ctx.globalAlpha *= alpha; if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(im, 0, 0, w, h); } else ctx.drawImage(im, x, y, w, h); ctx.restore(); }

let save = { unlocked: 0, active: 0, best: [0, 0, 0], complete: false, settings: { mute: false, music: true, shake: true, assist: false, touch: 'auto' } };
try { const s = JSON.parse(localStorage.getItem('clax_unsinkable_v1')); if (s) save = { ...save, ...s, active: clamp(Number(s.active) || 0, 0, 2), unlocked: clamp(Number(s.unlocked) || 0, 0, 2), settings: { ...save.settings, ...s.settings } }; } catch (e) {}
const persist = () => { try { localStorage.setItem('clax_unsinkable_v1', JSON.stringify(save)); } catch (e) {} }, audio = new ClaxAudio();

const G = { mode: 'title', level: DB.make(0), player: null, camera: { x: 0, y: 0, px: 0, py: 0, lead: 0, anchor: 0, look: 0 }, time: 0, clock: 0, elapsed: 0, particles: [], waves: [], bullets: [], floaters: [], effects: [],
  score: 0, tags: 0, rescued: 0, deaths: 0, combo: 0, bestCombo: 0, comboTime: 0, kills: 0, shake: 0, hitstop: 0, slow: 0, deathTimer: 0, toast: null, toastTimer: 0, speech: null, speechTimer: 0, speechCool: 0,
  chapterTimer: 0, area: null, areaTimer: 0, radioQueue: [], checkpoint: { x: 190, y: 612 }, safe: { x: 190, y: 612 }, safeTimer: 0, dialogue: null, afterDialogue: null, fps: 60, renderSamples: [], frames: 0, testMode: false, finishPending: false };
const held = new Set(), keyHeld = new Set(), touchHeld = new Set(); let gamepadHeld = new Set(), viewScale = 1, viewX = 0, viewY = 0, dpr = 1, accum = 0, last = performance.now();
const keyMap = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowDown: 'down', KeyS: 'down', Space: 'jump', ArrowUp: 'jump', KeyW: 'jump', KeyZ: 'jump', KeyJ: 'snap', KeyX: 'snap', ShiftLeft: 'dash', ShiftRight: 'dash', KeyK: 'dash', KeyC: 'dash', KeyQ: 'burst', KeyL: 'burst', KeyE: 'burst' };
const upKeys = new Set(['ArrowUp', 'KeyW']);
function syncHeld() { held.clear(); for (const k of keyHeld) { if (keyMap[k]) held.add(keyMap[k]); if (upKeys.has(k)) held.add('up'); } for (const k of touchHeld) held.add(k); for (const k of gamepadHeld) held.add(k); }
function clearInput() { keyHeld.clear(); touchHeld.clear(); gamepadHeld.clear(); held.clear(); document.querySelectorAll('.touch-button.active').forEach(e => e.classList.remove('active')); }
function press(a) {
  if (G.mode === 'dialogue') { if (a === 'jump' || a === 'snap') nextDialogue(); return; }
  if (G.mode !== 'play' || !G.player) return; audio.init(); const p = G.player; p.idle = 0;
  if (a === 'jump') p.jumpBuffer = P.K.buffer; if (a === 'snap') p.snapBuffer = .14; if (a === 'dash') p.dashBuffer = .14; if (a === 'burst') p.burstBuffer = .14;
}
window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (keyMap[e.code] || ['Escape', 'KeyP', 'Enter', 'KeyM', 'KeyF'].includes(e.code)) e.preventDefault();
  if (!keyHeld.has(e.code) && keyMap[e.code]) press(keyMap[e.code]); keyHeld.add(e.code); syncHeld(); if (e.repeat) return;
  if (['Escape', 'KeyP'].includes(e.code)) { if (G.mode === 'play') pause(); else if (G.mode === 'pause') resume(); else if (['settings', 'guide', 'stages'].includes(G.mode)) showTitle(); }
  if (e.code === 'Enter') { audio.init(); if (G.mode === 'title') start(0); else if (G.mode === 'dialogue') nextDialogue(); else if (G.mode === 'clear') continueCampaign(); else if (G.mode === 'pause') resume(); }
  if (e.code === 'KeyM') { save.settings.mute = !save.settings.mute; audio.setMute(save.settings.mute); persist(); toast(save.settings.mute ? 'AUDIO MUTED' : 'AUDIO ENABLED'); }
  if (e.code === 'KeyF') fullscreen();
});
window.addEventListener('keyup', e => { keyHeld.delete(e.code); syncHeld(); });
window.addEventListener('blur', () => { clearInput(); if (G.mode === 'play' && !G.testMode) pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInput(); if (G.mode === 'play' && !G.testMode) pause(); } last = performance.now(); accum = 0; });
window.addEventListener('contextmenu', e => { if (e.target === canvas || e.target.closest('#touch')) e.preventDefault(); });
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 1.6); const w = window.visualViewport?.width || document.documentElement.clientWidth || innerWidth, h = window.visualViewport?.height || document.documentElement.clientHeight || innerHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; viewScale = Math.min(w / W, h / H); viewX = (w - W * viewScale) / 2; viewY = (h - H * viewScale) / 2;
  ui.style.transform = `translate(${viewX}px,${viewY}px) scale(${viewScale})`;
  const touch = save.settings.touch === 'on' || (save.settings.touch !== 'off' && (navigator.maxTouchPoints > 0 || matchMedia('(pointer:coarse)').matches)); $('#touch').classList.toggle('available', touch);
}
window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); resize();
function pollPad() {
  let pads = []; try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : []; } catch (e) {} const s = new Set();
  if (pads.length) {
    const p = pads[0], b = i => p.buttons[i]?.pressed;
    if ((p.axes[0] || 0) < -.25 || b(14)) s.add('left'); if ((p.axes[0] || 0) > .25 || b(15)) s.add('right'); if (b(13) || (p.axes[1] || 0) > .55) s.add('down'); if (b(12) || (p.axes[1] || 0) < -.55) s.add('up');
    if (b(0)) s.add('jump'); if (b(2) || b(5)) s.add('snap'); if (b(1) || b(4)) s.add('dash'); if (b(3)) s.add('burst');
    if (b(9) && !pollPad.start) { if (G.mode === 'play') pause(); else if (G.mode === 'pause') resume(); else if (G.mode === 'title') start(0); } pollPad.start = b(9);
    for (const a of s) if (!gamepadHeld.has(a)) press(a);
  }
  gamepadHeld = s; syncHeld();
}
for (const btn of document.querySelectorAll('[data-action]')) {
  const a = btn.dataset.action;
  btn.addEventListener('pointerdown', e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); touchHeld.add(a); syncHeld(); press(a); btn.classList.add('active'); });
  const end = e => { e.preventDefault(); touchHeld.delete(a); syncHeld(); btn.classList.remove('active'); };
  btn.addEventListener('pointerup', end); btn.addEventListener('pointercancel', end); btn.addEventListener('lostpointercapture', end);
}
function screen(n) { for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== n; $('#touch').classList.toggle('playing', G.mode === 'play'); $('#game-tools').hidden = G.mode !== 'play'; }
function toast(s, sub = '', seconds = 2.5) { G.toast = { s, sub }; G.toastTimer = seconds; }
function say(s, speaker = 'CLAX', force = false) { if (!force && (G.speechCool > 0 || G.radioQueue.length)) return; G.speech = { s, speaker }; G.speechTimer = Math.max(3, 1.6 + s.length * .045); G.speechCool = 6; }
function quip(k, s = 'CLAX', force = false) { const a = DB.lines[k]; say(a[Math.floor(rand() * a.length)], s, force); }

function makePlayer(x, y) {
  const hp = save.settings.assist ? 10 : 6;
  return Object.assign(P.makePlayer(x, y), { hp, maxHp: hp, over: 40, invincible: 0, attack: 0, attackCool: 0, attackUp: false, dashCool: 0, snapBuffer: 0, dashBuffer: 0, burstBuffer: 0, flash: 0, sinceAttack: 5, idle: 0, stride: 0, hurt: 0, skid: 0, win: 0 });
}
function showTitle() { G.mode = 'title'; audio.running = false; clearInput(); screen('title-screen'); $('#continue').hidden = save.unlocked === 0 && !save.complete; }
function start(i = 0, skip = false) {
  audio.init(); audio.setMute(save.settings.mute); audio.setMusic(save.settings.music); audio.biome = i; audio.boss = false; audio.running = true;
  G.level = DB.make(i); G.time = G.elapsed = G.score = G.tags = G.rescued = G.deaths = G.kills = G.combo = G.bestCombo = G.comboTime = G.hitstop = G.slow = G.deathTimer = G.speechTimer = G.speechCool = G.toastTimer = G.areaTimer = 0;
  G.particles = []; G.effects = []; G.waves = []; G.bullets = []; G.floaters = []; G.radioQueue = []; G.finishPending = false; G.area = null;
  G.checkpoint = { ...G.level.start }; G.safe = { ...G.level.start }; G.player = makePlayer(G.checkpoint.x, G.checkpoint.y); resetRig();
  snapCamera(); G.chapterTimer = 3.6; G.mode = 'play'; save.active = i; save.unlocked = Math.max(save.unlocked, i); persist(); clearInput(); screen(null); accum = 0;
  if (!skip) showDialogue(DB.intros[i], () => { G.mode = 'play'; screen(null); G.chapterTimer = 3.4; toast('EXPEDITION ' + String(i + 1).padStart(2, '0'), G.level.objective, 4); });
}
function pause() { G.mode = 'pause'; audio.running = false; clearInput(); screen('pause-screen'); }
function resume() { G.mode = 'play'; audio.running = true; clearInput(); last = performance.now(); accum = 0; screen(null); }
function showDialogue(lines, f) { G.mode = 'dialogue'; G.dialogue = { lines, index: 0 }; G.afterDialogue = f; clearInput(); screen('dialogue-screen'); refreshDialogue(); }
const portraitFor = who => CLAX_ASSETS[who === 'CLAX' ? 'clax_front' : who === 'DRYDOCK' ? 'warden' : who === 'REFUND' ? 'carnival' : who === 'ADA' ? 'buoy' : 'portrait'];
function refreshDialogue() { const [who, line] = G.dialogue.lines[G.dialogue.index]; $('#speaker').textContent = who; $('#dialogue-text').textContent = line; $('#dialogue-count').textContent = `${G.dialogue.index + 1} / ${G.dialogue.lines.length}`; $('#dialogue-portrait').src = portraitFor(who); }
function nextDialogue() { if (G.mode !== 'dialogue') return; audio.init(); if (++G.dialogue.index >= G.dialogue.lines.length) { const f = G.afterDialogue; G.dialogue = null; G.afterDialogue = null; clearInput(); screen(null); f?.(); } else refreshDialogue(); }
function skipDialogue() { if (G.mode === 'dialogue') { G.dialogue.index = G.dialogue.lines.length - 1; nextDialogue(); } }
const formatTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}`;
function finishLevel() {
  if (G.finishPending) return; G.finishPending = true; audio.boss = false; audio.fx('win'); G.radioQueue = [];
  showDialogue(DB.outros[G.level.index], () => {
    G.mode = 'clear'; audio.running = false; G.score += G.rescued * 1000 + Math.max(0, 24000 - Math.floor(G.elapsed) * 30) + Math.max(0, 2000 - G.deaths * 500);
    save.best[G.level.index] = Math.max(save.best[G.level.index] || 0, G.score); save.unlocked = Math.max(save.unlocked, Math.min(2, G.level.index + 1)); save.active = Math.min(2, G.level.index + 1); if (G.level.index === 2) save.complete = true; persist();
    $('#clear-title').textContent = G.level.index === 2 ? 'HARBOR SAVED. EGO INTACT.' : 'RESCUE COMPLETE.';
    $('#clear-subtitle').textContent = G.level.index === 2 ? 'Port Flounder can breathe again. The Rescuer line is full of other people\'s names.' : `Incident Log: ${G.rescued} of 3 witnesses entered. The Bureau would like a word. Preferably without the claw.`;
    $('#result-score').textContent = G.score.toLocaleString(); $('#result-rescues').textContent = `${G.rescued} / 3`; $('#result-time').textContent = formatTime(G.elapsed); $('#result-combo').textContent = G.bestCombo + '×'; $('#result-deaths').textContent = G.deaths;
    $('#result-rank').textContent = G.rescued === 3 && G.deaths === 0 ? 'S' : G.rescued >= 2 && G.deaths < 3 ? 'A' : G.deaths < 6 ? 'B' : 'C'; $('#next-stage').textContent = G.level.index === 2 ? 'BACK TO HARBOR' : 'NEXT EXPEDITION →'; screen('clear-screen');
  });
}
function continueCampaign() { if (G.level.index < 2) start(G.level.index + 1); else showTitle(); }
function fullscreen() { try { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); else document.exitFullscreen?.(); } catch (e) {} }
$('#hero-render').src = CLAX_ASSETS.clax_front; $('#start').onclick = () => start(0); $('#continue').onclick = () => start(save.active); $('#choose-stage').onclick = () => { G.mode = 'stages'; screen('stage-screen'); };
$('#open-guide').onclick = () => { G.mode = 'guide'; screen('guide-screen'); }; $('#open-settings').onclick = () => { G.mode = 'settings'; screen('settings-screen'); };
document.querySelectorAll('[data-back]').forEach(b => b.onclick = showTitle);
document.querySelectorAll('[data-stage]').forEach(b => { const i = +b.dataset.stage; b.style.backgroundImage = `linear-gradient(0deg,rgba(5,17,25,.96),rgba(5,17,25,.05)),url('${CLAX_ASSETS[DB.biomes[i].id + '_background']}')`; b.onclick = () => start(i); });
$('#resume').onclick = resume; $('#restart').onclick = () => start(G.level.index, true); $('#quit').onclick = showTitle; $('#next-stage').onclick = continueCampaign; $('#replay').onclick = () => start(G.level.index, true);
$('#dialogue-next').onclick = nextDialogue; $('#dialogue-skip').onclick = skipDialogue; $('#pause-button').onclick = pause; $('#fullscreen-button').onclick = fullscreen;
for (const k of ['mute', 'music', 'shake', 'assist']) { const el = $('#setting-' + k); el.checked = save.settings[k]; el.onchange = () => { save.settings[k] = el.checked; audio.setMute(save.settings.mute); audio.setMusic(save.settings.music); persist(); }; }
$('#setting-touch').value = save.settings.touch; $('#setting-touch').onchange = e => { save.settings.touch = e.target.value; persist(); resize(); };
$('#volume').oninput = e => { audio.volume = +e.target.value; audio.setMute(save.settings.mute); };
document.querySelectorAll('.guide-enemy').forEach(e => e.src = CLAX_ASSETS[e.dataset.sprite]);
