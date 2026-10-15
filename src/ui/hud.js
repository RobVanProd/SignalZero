// Heads-up display: mission card, live service list, radio, interaction prompt, selection brackets, toasts.
import { h, clear } from './dom.js';

export class Hud {
  constructor(app) {
    this.app = app;
    const ui = document.getElementById('ui');
    this.root = h('div', { id: 'hud', class: 'hidden' });
    this.brandEl = h('div', { class: 'brand' }, h('b', {}, 'SIGNAL', h('em', {}, '//'), 'ZERO'), h('span', {}, 'NIGHT SHIFT'));
    this.code = h('div', { class: 'code' });
    this.title = h('div', { class: 'title' });
    this.task = h('div', { class: 'task' });
    this.list = h('ul', { class: 'checklist' });
    this.state = h('div', { class: 'state hidden' });
    this.coachEl = h('div', { class: 'coach hidden' });
    this.mission = h('div', { class: 'mission glass area' }, this.code, this.title, this.task, this.list, this.state, this.coachEl);
    this.clock = h('b', {}, '02:17');
    this.rep = h('b', {}, '0');
    this.warp = h('button', { class: 'ibtn', id: 'warp', title: 'Fast-forward time ×8 (T)', onclick: () => app.toggleWarp() }, '⏩');
    this.svcList = h('div');
    this.services = h('div', { class: 'services glass area' }, h('h4', {}, 'CITY SERVICES · LIVE'), this.svcList);
    const tool = h('div', { class: 'toolbar area' },
      h('div', { class: 'stat glass' }, this.clock, h('small', {}, 'SHIFT CLOCK')),
      h('div', { class: 'stat glass' }, this.rep, h('small', {}, 'REPUTATION')),
      this.warp,
      h('button', { class: 'ibtn', title: 'Network map, IPAM and quick travel (M)', onclick: () => app.openMap() }, '⌖'),
      h('button', { class: 'ibtn', title: 'Field guide (H)', onclick: () => app.openGuide() }, '?'),
      h('button', { class: 'ibtn', title: 'Menu (Esc)', onclick: () => app.openMenu() }, '≡'),
    );
    this.root.append(
      h('div', { class: 'hud-top' }, h('div', {}, this.brandEl, this.mission), h('div', { class: 'hud-right' }, tool, this.services)),
    );
    this.radio = h('div', { id: 'radio', class: 'glass' }, h('div', { class: 'who' }, 'SHIFT LEAD · RADIO'), h('div', { class: 'msg' }));
    this.prompt = h('div', { id: 'prompt', class: 'glass' }, h('b'), h('small'), h('div', { class: 'act' }));
    this.hintBar = h('div', { class: 'hint-bar glass area' }, h('span', {}, h('span', { class: 'kbd' }, 'WASD'), ' move'), h('span', {}, h('span', { class: 'kbd' }, 'E'), ' use'), h('span', {}, h('span', { class: 'kbd' }, 'M'), ' map'), h('span', {}, h('span', { class: 'kbd' }, 'H'), ' guide'), h('span', {}, h('span', { class: 'kbd' }, 'T'), ' fast-forward'), h('span', {}, h('span', { class: 'kbd' }, 'Esc'), ' menu'));
    this.root.append(this.radio, this.prompt, this.hintBar);
    this.lookHint = h('div', { class: 'glass', style: { position: 'fixed', left: '50%', top: '58%', transform: 'translateX(-50%)', padding: '10px 16px', font: '600 13px var(--sans)', pointerEvents: 'none', zIndex: 3 } }, 'Click to look around · ', h('span', { class: 'kbd' }, 'Esc'), ' releases the mouse');
    this.lookHint.classList.add('hidden');
    this.reticle = h('div', { id: 'reticle', class: 'hidden' });
    this.waypoint = h('div', { id: 'waypoint', class: 'hidden' }, h('i', { class: 'pin' }), h('b'), h('small'));
    this.brackets = h('div', { id: 'brackets' }, h('i'), h('i'), h('i'), h('i'));
    this.toast = h('div', { id: 'toast' }, h('div', { class: 'k' }), h('div', { class: 't' }), h('div', { class: 's' }));
    ui.append(this.root, this.reticle, this.brackets, this.toast, this.lookHint, this.waypoint);
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
    this.reticle.classList.toggle('hidden', !on);
    if (!on) this.brackets.classList.remove('on');
  }

  setMission(m, ev) {
    if (!m) return;
    this.code.textContent = m.code;
    this.title.textContent = m.title;
    this.task.textContent = m.task;
    clear(this.list);
    for (const g of ev.goals || []) this.list.append(h('li', { class: g.ok ? 'ok' : '' }, h('span', { class: 'ck' }, g.ok ? '✓' : ''), g.label));
    if (ev.constraints?.length) {
      this.list.append(h('li', { class: 'sep' }, 'DO NOT BREAK'));
      for (const c of ev.constraints) this.list.append(h('li', { class: `con ${c.ok ? 'ok' : ''}` }, h('span', { class: 'ck' }, c.ok ? '✓' : '!'), c.label));
    }
    if (ev.evidence?.length && (ev.status === 'verify' || ev.evidence.some(e => e.ok))) {
      this.list.append(h('li', { class: 'sep' }, 'VERIFY'));
      for (const e of ev.evidence) this.list.append(h('li', { class: `ev ${e.ok ? 'ok' : ''}` }, h('span', { class: 'ck' }, e.ok ? '✓' : ''), e.label));
    }
    const st = this.state;
    st.className = 'state hidden';
    if (ev.status === 'verify') { st.className = 'state verify'; st.textContent = '● Fixed? Now prove it from where users are.'; }
    else if (ev.status === 'armed') { st.className = 'state armed'; st.textContent = '● Stand by: something is about to happen…'; }
    else if (ev.status === 'after') { st.className = 'state armed'; st.textContent = '● Aftershock: restore service.'; }
  }

  setServices(eng) {
    clear(this.svcList);
    for (const f of eng.s.flows) {
      const s = eng.s.flowState[f.id] || {};
      const cls = !s.ok ? 'bad' : s.degraded ? 'warn' : 'ok';
      this.svcList.append(h('div', { class: `svc ${cls}` }, h('span', { class: 'dot' }), h('span', {}, f.label), h('em', { title: s.detail || '' }, !s.ok ? 'DOWN' : s.degraded ? 'DEGRADED' : 'OK')));
    }
    if (!eng.s.flows.length) this.svcList.append(h('div', { class: 'muted', style: { fontSize: '12px' } }, 'No monitored services yet.'));
  }

  setClock(text, rep) {
    this.clock.textContent = text;
    this.rep.textContent = String(rep);
  }

  say(text, who = 'SHIFT LEAD · RADIO', ms = 9000) {
    this.radio.querySelector('.who').textContent = who;
    this.radio.querySelector('.msg').textContent = text;
    this.radio.classList.add('on');
    clearTimeout(this.radioT);
    this.radioT = setTimeout(() => this.radio.classList.remove('on'), ms);
  }

  setPrompt(station, rect) {
    const on = !!station;
    this.prompt.classList.toggle('on', on);
    this.reticle.classList.toggle('hot', on);
    this.brackets.classList.toggle('on', on && !!rect);
    if (!on) return;
    this.prompt.querySelector('b').textContent = station.label;
    this.prompt.querySelector('small').textContent = station.sub;
    const verb = { console: 'OPEN CONSOLE', patch: 'WORK THE PATCH PANEL', map: 'VIEW NETWORK', phone: 'PICK UP PHONE', cctv: 'CHECK FEEDS', rogue: 'INSPECT DEVICE', 'cable-patch': 'OPEN THE PATCH PANEL', cable: 'INSPECT CABLE' }[station.type] || 'USE';
    this.prompt.querySelector('.act').textContent = `${this.app.touch ? 'TAP USE' : 'PRESS E'} · ${verb}`;
    if (rect) {
      const pad = 10;
      Object.assign(this.brackets.style, { left: `${rect.x0 - pad}px`, top: `${rect.y0 - pad}px`, width: `${Math.max(30, rect.x1 - rect.x0 + pad * 2)}px`, height: `${Math.max(30, rect.y1 - rect.y0 + pad * 2)}px` });
    }
  }

  flash(kicker, title, sub, ms = 4200) {
    this.toast.querySelector('.k').textContent = kicker;
    this.toast.querySelector('.t').textContent = title;
    this.toast.querySelector('.s').textContent = sub;
    this.toast.classList.add('on');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => this.toast.classList.remove('on'), ms);
  }

  setWarp(on) { this.warp.classList.toggle('on', on); }

  /** NEXT STEP card under the mission checklist. */
  setCoach(coach) {
    const el = this.coachEl;
    const s = coach.active ? coach.current() : null;
    el.classList.toggle('hidden', !s);
    if (!s) return;
    clear(el);
    const n = coach.steps.indexOf(s);
    const how = typeof s.how === 'string' ? s.how : this.app.touch ? s.how.touch : s.how.desktop;
    el.append(...[
      h('div', { class: 'pips' }, coach.steps.map((x, i) => h('i', { class: coach.done.has(x.id) ? 'ok' : i === n ? 'now' : '' }))),
      h('div', { class: 'k' }, `NEXT STEP ${n + 1} OF ${coach.steps.length}`),
      h('div', { class: 't' }, s.title),
      h('div', { class: 'how' }, how),
      s.cmd ? h('div', { class: 'cmd' }, h('small', {}, `on ${s.cmd.dev}`), h('code', {}, s.cmd.text)) : null].filter(Boolean));
  }

  coachPulse() {
    this.coachEl.classList.remove('pulse');
    void this.coachEl.offsetWidth;
    this.coachEl.classList.add('pulse');
  }

  /** Orange marker over the station the current step needs; clamped to the screen edge with an arrow. */
  setWaypoint(w) {
    const el = this.waypoint;
    el.classList.toggle('hidden', !w);
    if (!w) return;
    el.classList.toggle('edge', !!w.edge);
    el.style.left = `${w.x}px`;
    el.style.top = `${w.y}px`;
    el.style.setProperty('--ang', `${w.angle || 0}rad`);
    el.querySelector('b').textContent = w.label;
    el.querySelector('small').textContent = w.dist < 2 ? (this.app.touch ? 'here · tap USE' : 'here · aim + E') : `${w.dist.toFixed(0)} m`;
  }

  setLookHint(on) { this.lookHint.classList.toggle('hidden', !on); }
}
