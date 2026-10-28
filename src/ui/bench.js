// The apprenticeship bench screen: lesson card, live network diagram, frame-by-frame view and Ubuntu consoles.
// Everything shown is read from the one bench engine the lesson runtime owns (src/game/lesson.js): the diagram's
// addresses, routes and ARP tables, the frames (derived from the probes the last command really sent) and the
// step's completion (a live check of the network, re-checked before any "done" is shown).
import { h, clear, overlay } from './dom.js';
import { fmtIp, networkOf } from '../engine/ipv4.js';
import { hostAddr } from '../engine/routing.js';
import { neighbors } from '../engine/neighbor.js';
import { macLinux } from '../engine/model.js';
import { prompt as promptOf } from '../cli/index.js';
import { MISCONCEPTIONS } from '../content/lessons.js';
import { OBJECTIVES } from '../content/objectives.js';
import { LessonRun } from '../game/lesson.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const POS = { 'PC-A': [92, 92], 'PC-B': [92, 252], SW1: [262, 172], R1: [392, 172], SW2: [522, 172], SRV: [662, 172] };
const HOSTS = ['PC-A', 'PC-B', 'SRV'];
const SPEEDS = [0.25, 0.5, 1];

function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export class BenchScreen {
  constructor(app, lesson, opts = {}) {
    this.app = app;
    this.lesson = lesson;
    this.run = new LessonRun(lesson, { log: (t, d) => app.telemetry.log(t, d), seed: opts.seed ?? Math.floor(Math.random() * 1000), resume: opts.resume, startAt: opts.startAt, transferFault: opts.transferFault });
    this.dev = 'PC-A';
    this.frameIdx = 0;
    this.playing = false;
    this.speed = 0.5;
    this.tab = 'lesson';
    this.build();
    this.renderAll();
    // the bench runs in real time, so ARP entries age (REACHABLE -> STALE) while you watch
    this.clock = setInterval(() => { this.run.eng.advance(1); this.renderDiagram(); }, 1000);
  }

  // ------------------------------------------------------------------ layout
  build() {
    const L = this.lesson;
    this.card = h('div', { class: 'bn-card scroll' });
    this.svg = s('svg', { class: 'bn-svg', viewBox: '0 0 760 340', role: 'img', 'aria-label': 'bench network diagram' });
    this.frameBox = h('div', { class: 'bn-frames' });
    this.term = h('div', { class: 'bn-term' });
    this.progress = h('div', { class: 'bn-progress' });
    const labels = h('div', { class: 'bn-labels' },
      h('button', { class: 'bn-label real', onclick: () => this.scope() }, 'REAL COMMANDS · LAB-CHECKED'),
      h('button', { class: 'bn-label accel', onclick: () => this.scope('time') }, 'ACCELERATED TIME'),
      h('button', { class: 'bn-label tut', onclick: () => this.scope('tutorial') }, 'TUTORIAL VIEW'));
    this.tabs = h('div', { class: 'bn-tabs' }, ['lesson', 'network', 'console'].map(t => h('button', { class: 'bn-tab', 'data-tab': t, onclick: () => this.setTab(t) }, t.toUpperCase())));
    this.root = h('div', { class: 'bench', role: 'dialog', 'aria-label': `${L.code} ${L.title}` },
      h('div', { class: 'bn-top' },
        h('div', {}, h('div', { class: 'eyebrow' }, L.code), h('div', { class: 'bn-title' }, L.title, h('span', {}, L.subtitle))),
        this.progress, labels,
        h('button', { class: 'btn small ghost', onclick: () => this.exit() }, 'Exit lesson')),
      this.tabs,
      h('div', { class: 'bn-body' },
        h('section', { class: 'bn-col bn-lesson', 'data-pane': 'lesson' }, this.card),
        h('section', { class: 'bn-col bn-net', 'data-pane': 'network' }, h('div', { class: 'bn-svgwrap' }, this.svg), this.frameBox),
        h('section', { class: 'bn-col bn-con', 'data-pane': 'console' }, this.term)));
    this.ov = overlay(this.root, { dismissable: false, cls: 'bench-ov' });
    this.setTab('lesson');
  }

  setTab(t) {
    this.tab = t;
    for (const b of this.tabs.children) b.classList.toggle('on', b.dataset.tab === t);
    for (const p of this.root.querySelectorAll('[data-pane]')) p.classList.toggle('show', p.dataset.pane === t);
  }

  renderAll() {
    this.renderProgress();
    this.renderCard();
    this.renderDiagram();
    this.renderFrames();
    this.renderTerm();
  }

  renderProgress() {
    const p = clear(this.progress);
    this.lesson.steps.forEach((st, i) => {
      const cls = this.run.st.completed.includes(st.id) ? 'done' : this.run.st.skipped.includes(st.id) ? 'skip' : i === this.run.st.i ? 'cur' : '';
      p.append(h('span', { class: `bn-dot ${cls}`, title: st.title }));
    });
  }

  // ------------------------------------------------------------------ lesson card
  renderCard() {
    const run = this.run;
    const c = clear(this.card);
    if (run.finished) return this.renderSummary(c);
    const st = run.step;
    const remedy = run.phase === 'next' ? run.pendingRemedy() : null;
    if (remedy) return this.renderRemedy(c, remedy);
    c.append(h('div', { class: 'eyebrow' }, `STEP ${run.st.i + 1} OF ${this.lesson.steps.length} · ${{ guided: 'GUIDED', supported: 'SUPPORTED PRACTICE', independent: 'ON YOUR OWN' }[st.support] || 'CONCEPT'}`), h('h2', {}, st.title));
    if (st.ticket) c.append(h('div', { class: 'bn-ticket' }, h('b', {}, 'TICKET '), st.ticket));
    const body = h('div', { class: `bn-body-text ${this.collapsed?.[st.id] ? 'hidden' : ''}` }, (st.body || []).map(t => h('p', {}, t)));
    c.append(body);
    if (st.kind === 'task' && st.support === 'guided' && st.body?.length && run.phase !== 'read') {
      c.append(h('button', { class: 'linkish', onclick: () => { (this.collapsed ||= {})[st.id] = !this.collapsed?.[st.id]; this.renderCard(); } }, this.collapsed?.[st.id] ? 'Show the explanation' : 'I know this: hide the explanation'));
    }
    if (st.analogy) c.append(h('div', { class: 'bn-analogy' }, h('div', { class: 'eyebrow' }, 'ANALOGY'), h('p', {}, st.analogy.text), h('p', {}, h('b', {}, 'On the real network: '), st.analogy.tie)));

    if (run.phase === 'read') {
      c.append(h('div', { class: 'bn-actions' }, h('button', { class: 'btn primary', onclick: () => this.advance() }, 'Start →'),
        st.id === 'intro' && this.lesson.placement ? h('button', { class: 'btn', onclick: () => this.placement() }, 'I know this: test me (4 questions)') : null));
      return;
    }
    if (run.phase === 'predict') {
      c.append(h('div', { class: 'bn-q' }, h('div', { class: 'eyebrow' }, 'PREDICT FIRST'), h('p', {}, st.predict.q),
        h('div', { class: 'bn-opts' }, st.predict.options.map((o, k) => h('button', { class: 'bn-opt', onclick: () => { run.predict(k); this.renderCard(); } }, o.text))),
        h('p', { class: 'muted small' }, 'There is no penalty for a wrong guess. You will test it on the network next.')));
      return;
    }
    if (run.phase === 'task') {
      if (st.predict) c.append(this.predictionNote(st, false));
      c.append(h('div', { class: 'bn-goal' }, h('div', { class: 'eyebrow' }, 'DO'), h('p', {}, st.goal)));
      if (st.commands) c.append(this.commandList(st));
      const tools = h('div', { class: 'bn-actions' });
      if (st.support === 'supported') tools.append(h('button', { class: 'btn small', onclick: () => { const hint = run.hint(); if (hint) { (this.hints ||= []).push(hint); this.renderCard(); } } }, run.hintIdx >= (st.hints?.length || 0) ? 'All hints shown' : `Hint ${run.hintIdx + 1} of ${st.hints?.length || 0}`));
      if (st.support === 'independent') tools.append(h('button', { class: 'btn small ghost', onclick: () => { const t = run.showMe(); this.revealed = t; this.renderCard(); } }, 'I\'m stuck: show me'));
      tools.append(h('button', { class: 'btn small ghost', title: 'Undo your changes in this step', onclick: () => { run.reset(); this.renderAll(); } }, 'Reset bench'));
      c.append(tools);
      for (const hint of (this.hints || []).filter(x => st.hints?.includes(x))) c.append(h('div', { class: `bn-hint ${hint.kind}` }, h('b', {}, { concept: 'IDEA', evidence: 'EVIDENCE', action: 'ACTION' }[hint.kind]), ' ', hint.text));
      if (this.revealed && st.support === 'independent') c.append(h('div', { class: 'bn-hint action' }, h('b', {}, 'EXPLAINED '), this.revealed));
      if (this.notDone) c.append(h('div', { class: 'bn-warn' }, this.notDone));
      return;
    }
    if (run.phase === 'result') {
      // a success stamp only while the network really is in the required state
      if (!run.isDone()) { run.phase = 'task'; this.notDone = 'The network no longer meets this step\'s goal (something changed). Check it and try again.'; return this.renderCard(); }
      this.notDone = null;
      c.append(h('div', { class: 'bn-stamp' }, '✓ VERIFIED ON THE LIVE NETWORK'));
      if (st.predict) c.append(this.predictionNote(st, true));
      c.append(h('div', { class: 'bn-learned' }, (st.learned || []).map(t => h('p', {}, t))));
      if (run.lastFrames?.frames.length) c.append(h('button', { class: 'btn small', onclick: () => { this.setTab('network'); this.play(0); } }, 'Replay the frames'));
      c.append(h('div', { class: 'bn-actions' }, h('button', { class: 'btn primary', onclick: () => { run.afterResult(); this.advance(); } }, 'Continue →')));
      return;
    }
    if (run.phase === 'check') {
      const ans = this.checkAnswer;
      c.append(h('div', { class: 'bn-q' }, h('div', { class: 'eyebrow' }, 'EXPLAIN IT'), h('p', {}, st.check.q),
        h('div', { class: 'bn-opts' }, st.check.options.map((o, k) => h('button', { class: `bn-opt ${ans && ans.k === k ? (ans.correct ? 'right' : 'wrong') : ''}`, disabled: !!ans, onclick: () => { const r = run.answerCheck(k); this.checkAnswer = { k, ...r }; run.phase = 'check'; this.renderCard(); } }, o.text))),
        ans ? h('p', { class: ans.correct ? 'ok' : 'bad' }, ans.correct ? 'Right. ' : 'Not quite. ', ans.option.why || (ans.correct ? '' : `The answer: ${(st.check.options.find(o => o.correct || o.fault === run.st.transferFault) || {}).text || ''}.`)) : null,
        ans ? h('div', { class: 'bn-actions' }, h('button', { class: 'btn primary', onclick: () => { this.checkAnswer = null; run.afterResult(); this.advance(); } }, 'Continue →')) : null));
      return;
    }
    if (run.phase === 'explain') {
      const ta = h('textarea', { class: 'note', rows: 4, placeholder: 'For example: "The ping printed …, and ip route showed …, so …"' });
      c.append(h('div', { class: 'bn-q' }, h('div', { class: 'eyebrow' }, 'IN YOUR OWN WORDS'), h('p', {}, st.explain.q), ta,
        h('div', { class: 'bn-actions' }, h('button', { class: 'btn primary', onclick: () => { run.answerExplain(ta.value); this.advance(); } }, 'Submit →'))));
      return;
    }
    if (run.phase === 'next') this.advance();
  }

  predictionNote(st, outcome) {
    const k = this.run.st.predictions[st.id];
    const o = st.predict.options[k];
    if (!o) return null;
    if (!outcome) return h('div', { class: 'bn-pred' }, h('b', {}, 'Your prediction: '), o.text);
    const right = !!o.correct;
    return h('div', { class: `bn-pred ${right ? 'right' : 'wrong'}` }, h('b', {}, right ? 'Your prediction was right: ' : 'You predicted: '), o.text, h('br'), right ? null : h('span', {}, h('b', {}, 'What happened: '), st.predict.options.find(x => x.correct).text, '. '), h('span', { class: 'muted' }, o.why || ''));
  }

  commandList(st) {
    return h('div', { class: 'bn-cmds' }, st.commands.map(cmd => h('div', { class: 'bn-cmd' },
      h('button', { class: 'chip go', title: `Put this in ${cmd.dev}'s console`, onclick: () => this.fill(cmd.dev, cmd.text) }, h('span', { class: 'muted' }, `${cmd.dev}  `), cmd.text),
      cmd.words?.length ? h('table', { class: 'bn-words' }, h('tbody', {}, cmd.words.map(([w, m]) => h('tr', {}, h('td', { class: 'mono' }, w), h('td', {}, m))))) : null)));
  }

  renderRemedy(c, m) {
    const r = MISCONCEPTIONS[m];
    c.append(h('div', { class: 'eyebrow' }, 'A QUICK REFRESHER'), h('h2', {}, r.title), r.body.map(t => h('p', {}, t)),
      r.replay && this.run.lastFrames?.frames.length ? h('button', { class: 'btn small', onclick: () => { this.setTab('network'); this.play(0); } }, 'Replay the last frames with this in mind') : null,
      h('div', { class: 'bn-actions' }, h('button', { class: 'btn primary', onclick: () => { this.run.taught(m); if (this.run.phase === 'next') this.advance(); else this.renderCard(); } }, 'Got it →')));
  }

  renderSummary(c) {
    const L = this.lesson;
    const sum = this.run.summary();
    c.append(h('div', { class: 'eyebrow' }, 'LESSON COMPLETE'), h('h2', {}, L.title),
      h('h4', {}, 'What you can now do'), h('ul', { class: 'clean' }, L.summary.map(t => h('li', {}, t))),
      h('h4', {}, 'Your run'), h('p', {}, `Predictions right: ${sum.predictionsRight} of ${sum.predictions} · hints used: ${sum.hints} · commands: ${sum.commands}${sum.gaveUp.length ? ' · used "show me" on the last case' : ''}`),
      h('p', { class: 'muted' }, `Your last case was: ${{ 'gateway-is-host': 'the default gateway pointed at another PC', 'no-return': 'the server had no route back' }[sum.transferFault] || sum.transferFault}.`),
      h('h4', {}, 'Network+ N10-009 objectives practised'), h('table', { class: 'table' }, h('tbody', {}, L.objectives.map(id => h('tr', {}, h('td', { class: 'mono' }, id), h('td', {}, OBJECTIVES.find(o => o.id === id)?.title || ''), h('td', { class: 'muted' }, L.objectiveNotes[id] || ''))))),
      h('p', { class: 'muted' }, `This is what incidents ${L.prepares.join(', ')} assume you know. A DHCP lease, for example, hands a host exactly the settings you worked with here: address, prefix length and default gateway.`),
      h('p', { class: 'muted small' }, 'Playtest: your predictions, answers and hints are in the local playtest log (Settings → Playtest log → Export JSON).'),
      h('div', { class: 'bn-actions' }, h('button', { class: 'btn primary', onclick: () => this.exit() }, 'Back to the title screen')));
    this.app.recordLesson?.(L.id, sum);
  }

  placement() {
    const L = this.lesson;
    const answers = L.placement.map(() => null);
    let ov;
    const body = h('div', { class: 'bd' }, h('p', {}, 'Answer all four correctly and you skip straight to the troubleshooting cases. You still have to show it on the network.'),
      L.placement.map((q, i) => h('div', { class: 'bn-q' }, h('p', {}, `${i + 1}. ${q.q}`), h('div', { class: 'bn-opts' }, q.options.map((o, k) => {
        const b = h('button', { class: 'bn-opt', onclick: () => { answers[i] = k; for (const x of b.parentNode.children) x.classList.remove('sel'); b.classList.add('sel'); } }, o.text);
        return b;
      })))));
    const card = h('div', { class: 'card glass', style: { width: 'min(720px,96vw)' } }, h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'PLACEMENT CHECK'), h('h2', {}, 'Do you already know this?')), body,
      h('div', { class: 'ft' }, h('button', { class: 'btn ghost', onclick: () => ov.remove() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => {
        if (answers.some(a => a === null)) { alert('Answer all four first.'); return; }
        const r = this.run.placement(answers);
        ov.remove();
        if (!r.passed) { this.run.next(); this.placementMsg = `You got ${r.right.filter(Boolean).length} of 4. The lesson starts from the beginning; the parts you know will go quickly.`; }
        this.after();
      } }, 'Check my answers')));
    ov = overlay(card, { dismissable: false });
  }

  scope(which) {
    let ov;
    const card = h('div', { class: 'card glass', style: { width: 'min(760px,96vw)' } }, h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'WHAT IS REAL HERE'), h('h2', {}, 'Scope of this bench')),
      h('div', { class: 'bd scroll', style: { maxHeight: '70vh' } },
        h('h4', { class: which === undefined ? 'hl' : '' }, 'Real, and checked against a real Linux lab'),
        h('ul', { class: 'clean' },
          h('li', {}, 'PC-A, PC-B and SRV behave as Ubuntu 24.04 hosts. Commands and outputs follow iproute2 6.1 (ip route, ip route get, ip neigh) and iputils 20240117 (ping), compared line by line with the same network built from real Linux kernels (docs/apprenticeship/VALIDATION.md).'),
          h('li', {}, 'The forwarding decision (on-link or gateway), ARP for the next hop, TTL, the router\'s forwarding, the missing return path and every error message on this bench.'),
          h('li', {}, 'A real command this simulator does not model is labelled SIMULATOR, never reported as invalid.')),
        h('h4', {}, 'Simplified or left out'),
        h('ul', { class: 'clean' },
          h('li', {}, 'IPv4 only (IPv6 is switched off on the bench). No DHCP or DNS here: addresses are static.'),
          h('li', {}, 'R1 is a plain IPv4 router with proxy ARP off. Its console is not part of this lesson. (Cisco routers enable proxy ARP by default, which can hide a wrong subnet mask.)'),
          h('li', {}, 'SW1 and SW2 are unmanaged switches with spanning tree off. Each frame is shown as flooded (broadcast) or forwarded to one port (unicast); the switch\'s MAC table and its aging are not shown.'),
          h('li', {}, 'ARP timers are fixed: an entry turns STALE after 30 s (Linux picks 15–45 s at random), a DELAY entry is confirmed 5 s later. Entries are never deleted automatically.'),
          h('li', {}, 'No loss, queuing or link speeds on the bench. Route changes are run-time changes; nothing here survives a reboot.')),
        h('h4', { class: which === 'time' ? 'hl' : '' }, 'Accelerated time'),
        h('p', {}, 'Commands finish at once. On a real network ping sends one echo per second, a failed ARP takes about 3 s (three requests 1 s apart), and confirmations happen seconds later. The frame view marks the frames that would come later.'),
        h('h4', { class: which === 'tutorial' ? 'hl' : '' }, 'Tutorial-only controls'),
        h('p', {}, 'The diagram, the frame view, Reset bench, predictions, hints and refreshers exist only for learning. On a real network the closest tools are tcpdump -n -e (the frame view prints the same lines) and Wireshark.')),
      h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => ov.remove() }, 'Close')));
    ov = overlay(card, { onClose: () => ov.remove() });
  }

  /** Leave the current step: teach a pending refresher first (a misconception seen twice), then move on. */
  advance() {
    const run = this.run;
    if (run.phase === 'next' && run.pendingRemedy()) { this.renderAll(); return; }
    if (run.phase === 'next' || run.phase === 'read') run.next();
    this.after();
  }

  after() {
    this.hints = [];
    this.revealed = null;
    this.notDone = null;
    if (!this.run.finished && this.run.st.i >= 0) this.dev = this.defaultDev();
    this.renderAll();
    this.app.saveLesson?.(this.lesson.id, this.run.save());
    if (this.placementMsg) { const m = this.placementMsg; this.placementMsg = null; this.card.prepend(h('div', { class: 'bn-hint concept' }, m)); }
  }

  defaultDev() {
    const st = this.run.step;
    if (st.commands?.length) return st.commands[0].dev;
    if (st.id === 'practice') return 'PC-B';
    return HOSTS.includes(this.dev) ? this.dev : 'PC-A';
  }

  // ------------------------------------------------------------------ diagram
  /** Networks and links are drawn once per bench; devices (addresses, gateways, ARP tables) are redrawn on every
   * change and every second, without touching the links or the packet layer, so an animation keeps running. */
  renderDiagram() {
    const eng = this.run.eng;
    const key = `${eng.s.bench}|${this.run.st.i}|${Object.keys(eng.s.links).join(',')}`;
    if (this.diagKey !== key || !this.devLayer) this.drawStatic(key);
    const layer = clear(this.devLayer);
    for (const l of Object.values(eng.s.links)) this.linkEls[l.id]?.classList.toggle('down', !eng.linkStatus(l.id).up);
    this.drawDevices(layer);
  }

  drawStatic(key) {
    this.diagKey = key;
    const eng = this.run.eng;
    const svg = clear(this.svg);
    const v = this.run.v;
    svg.append(
      s('rect', { x: 14, y: 16, width: 320, height: 312, class: 'bn-netbox' }), s('text', { x: 24, y: 36, class: 'bn-netlabel' }, `${v.lan.net}/${v.lan.len}`),
      s('rect', { x: 452, y: 16, width: 294, height: 312, class: 'bn-netbox far' }), s('text', { x: 462, y: 36, class: 'bn-netlabel' }, `${v.far.net}/${v.far.len}`));
    this.linkEls = {};
    for (const l of Object.values(eng.s.links)) {
      const a = POS[l.a.dev];
      const b = POS[l.b.dev];
      const up = eng.linkStatus(l.id).up;
      const el = s('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `bn-link ${up ? '' : 'down'}`, 'data-link': l.id });
      this.linkEls[l.id] = el;
      svg.append(el);
    }
    this.devLayer = s('g', { class: 'bn-devs' });
    this.pktLayer = s('g', { class: 'bn-pkts' });
    svg.append(this.devLayer, this.pktLayer);
  }

  drawDevices(layer) {
    const eng = this.run.eng;
    for (const [id, [x, y]] of Object.entries(POS)) {
      const d = eng.s.devices[id];
      const g = s('g', { class: `bn-dev ${d.kind}`, transform: `translate(${x},${y})`, 'data-dev': id });
      if (d.kind === 'host') {
        const a = hostAddr(eng, d);
        // troubleshooting steps show documentation only: gateways and ARP tables are evidence for the console
        const docs = this.run.step?.diagram === 'docs';
        const gw = docs ? 'gateway: check on the host' : a.gw !== null && a.gw !== undefined ? `gw ${fmtIp(a.gw)}` : 'no default gateway';
        g.append(s('rect', { x: -66, y: -30, width: 132, height: 60, rx: 2 }), s('text', { x: 0, y: -12, class: 'nm' }, id), s('text', { x: 0, y: 5, class: 'ad' }, `${fmtIp(a.addr)}/${a.len}`), s('text', { x: 0, y: 20, class: `gw ${a.gw === null || a.gw === undefined ? 'none' : ''}` }, gw));
        const n = docs ? [] : neighbors(eng, d).slice(-3);
        n.forEach((e, k) => g.append(s('text', { x: -64, y: 44 + k * 13, class: `nb ${e.state}` }, `${fmtIp(e.ip)} → ${e.mac ? macLinux(e.mac).slice(-5) : '—'} ${e.state}`)));
        if (!n.length) g.append(s('text', { x: -64, y: 44, class: 'nb empty' }, docs ? 'ARP table: use ip neigh' : 'ARP table empty'));
        g.addEventListener('click', () => { this.dev = id; this.setTab('console'); this.renderTerm(); });
      } else if (d.kind === 'router') {
        g.append(s('rect', { x: -40, y: -26, width: 80, height: 52, rx: 26 }), s('text', { x: 0, y: -2, class: 'nm' }, 'R1'), s('text', { x: 0, y: 13, class: 'ad' }, 'router'));
        const p0 = d.ports.eth0.ip;
        const p1 = d.ports.eth1.ip;
        g.append(s('text', { x: 0, y: 44, class: 'ad pt' }, `◀ eth0 ${fmtIp(p0.addr)}`), s('text', { x: 0, y: 59, class: 'ad pt' }, `eth1 ${fmtIp(p1.addr)} ▶`));
      } else {
        g.append(s('rect', { x: -32, y: -16, width: 64, height: 32, rx: 2 }), s('text', { x: 0, y: 5, class: 'nm sm' }, id));
      }
      layer.append(g);
    }
  }

  // ------------------------------------------------------------------ frames
  renderFrames() {
    const box = clear(this.frameBox);
    const lf = this.run.lastFrames;
    const ctl = h('div', { class: 'bn-fctl' },
      h('div', { class: 'eyebrow' }, 'FRAMES', h('span', { class: 'muted' }, lf ? `  ·  ${lf.dev}$ ${lf.line}` : '')),
      h('div', { class: 'bn-fbtns' },
        h('button', { class: 'btn small', title: 'Previous frame', onclick: () => this.stepFrame(-1), disabled: !lf?.frames.length }, '◀'),
        h('button', { class: 'btn small', onclick: () => (this.playing ? this.pause() : this.play(this.frameIdx >= (lf?.frames.length || 1) - 1 ? 0 : this.frameIdx)), disabled: !lf?.frames.length }, this.playing ? 'Pause' : 'Play'),
        h('button', { class: 'btn small', title: 'Next frame', onclick: () => this.stepFrame(1), disabled: !lf?.frames.length }, '▶'),
        h('button', { class: 'btn small', onclick: () => this.play(0), disabled: !lf?.frames.length }, 'Replay'),
        h('select', { 'aria-label': 'speed', onchange: e => { this.speed = Number(e.target.value); } }, SPEEDS.map(x => h('option', { value: x, selected: x === this.speed }, `${x}×`)))));
    box.append(ctl);
    if (!lf) { box.append(h('p', { class: 'muted small' }, 'Run a command that sends packets (ping) and every frame it caused appears here, step by step.')); return; }
    if (!lf.frames.length) { box.append(h('p', { class: 'bn-fnote' }, 'No frames. Nothing was sent.')); return; }
    const list = h('ol', { class: 'bn-flist scroll' });
    let laterShown = false;
    lf.frames.forEach((f, i) => {
      if (f.delayed && !laterShown) { laterShown = true; list.append(h('li', { class: 'bn-later' }, 'About 5 seconds later')); }
      list.append(h('li', { class: `bn-frow ${f.note ? 'note' : f.kind} ${i === this.frameIdx ? 'cur' : ''}`, onclick: () => { this.pause(); this.show(i); } },
        h('div', { class: 'bn-fhead' }, h('span', { class: 'bn-fn' }, f.note ? '•' : String(i + 1)), h('b', {}, this.frameTitle(f))),
        i === this.frameIdx ? h('div', { class: 'bn-fdetail' }, h('p', {}, this.explain(f)), f.line ? h('div', { class: 'mono bn-fline' }, f.line) : null, this.fields(f)) : null));
    });
    box.append(list);
    requestAnimationFrame(() => list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }));
  }

  name(dev) { return dev; }

  owner(mac) {
    if (mac === 'ffffffffffff') return 'broadcast';
    for (const d of Object.values(this.run.eng.s.devices)) for (const p of Object.values(d.ports)) if (p.mac === mac) return d.kind === 'router' ? `R1 ${p.name}` : d.id;
    return '?';
  }

  frameTitle(f) {
    switch (f.kind) {
      case 'arp-request': return f.bcast ? `ARP request (broadcast) · ${f.from} asks for ${fmtIp(f.nh)}${f.tries > 1 ? ` · try ${f.try}/${f.tries}` : ''}` : `ARP request (unicast check) · ${f.from} → ${f.to[0]}`;
      case 'arp-reply': return `ARP reply · ${f.from} → ${f.to[0]}`;
      case 'ip': return `${f.pkt.icmpType === 'echo' ? 'Echo request' : f.pkt.icmpType === 'echo-reply' ? 'Echo reply' : 'IP packet'} · ${f.from} → ${f.to[0]}${f.router ? ' (forwarded)' : ''}`;
      case 'arp-failed': return `${f.from}: no ARP answer for ${fmtIp(f.nh)}`;
      case 'arp-queued': return `Echo ${f.seq} waited for the same ARP attempt`;
      case 'not-sent': return `${f.from}: nothing sent`;
      case 'dropped': return `${f.at}: packet discarded`;
      case 'delivered': return `Request reached ${f.at}`;
      case 'reply-not-sent': return `${f.from}: reply not sent`;
      case 'reply-home': return `Reply reached ${f.at}`;
      default: return f.kind;
    }
  }

  explain(f) {
    const eng = this.run.eng;
    const net = dev => { const a = hostAddr(eng, eng.s.devices[dev] || {}); return a?.addr !== null && a?.addr !== undefined ? `${fmtIp(networkOf(a.addr, a.len))}/${a.len}` : 'its network'; };
    switch (f.kind) {
      case 'arp-request':
        if (!f.bcast) return `${f.from} still has ${fmtIp(f.nh)} in its table but has not had it confirmed lately, so it checks with a request sent straight to the cached MAC (unicast). ${f.to[0]} answers. Not every ARP request is a broadcast.`;
        return `${f.from} needs the MAC address of ${fmtIp(f.nh)}, its next hop. It asks everyone on its network: the destination MAC ff:ff:ff:ff:ff:ff is broadcast, so ${f.seg || 'the switch'} floods the frame out of every other port. Every device reads it; only the owner of ${fmtIp(f.nh)} answers.${f.tries > 1 ? ` Try ${f.try} of ${f.tries}, one second apart on a real network.` : ''}`;
      case 'arp-reply': return `${f.from} answers "${fmtIp(f.nh)} is at ${macLinux(f.replyMac)}" in a unicast frame to ${f.to[0]} only.${f.learned ? ` ${f.from} also stored ${f.to[0]}'s IP and MAC, taken from the request.` : ''}${f.proxy ? ' (Proxy ARP: the router answered for an address behind it.)' : ''}`;
      case 'ip': {
        const p = f.pkt;
        const via = f.to[0] && eng.s.devices[f.to[0]]?.kind === 'router' && p.dst !== this.ipOf(f.to[0]) ? ` The IP destination is ${fmtIp(p.dst)}, but the frame is addressed to ${f.to[0]}'s MAC: ${f.to[0]} is the next hop.` : '';
        const routed = f.router ? ` ${f.from} is a router: it received this packet on its other interface, found the route for ${fmtIp(p.dst)}, lowered the TTL to ${p.ttl} and built a new frame from its own MAC.` : '';
        return `IP ${fmtIp(p.src)} → ${fmtIp(p.dst)}, TTL ${p.ttl}. The switch forwards it by MAC address to one port.${via}${routed}${f.cached ? ` No ARP first: ${f.from} already had the MAC in its table.` : ''}`;
      }
      case 'arp-failed': return `Nobody owns ${fmtIp(f.nh)}, so ${f.from}'s three requests went unanswered (about 3 s on a real network). ${f.from} marks the entry FAILED and reports "From ${fmtIp(f.srcIp)} … Destination Host Unreachable": the message comes from ${f.from} itself.`;
      case 'arp-queued': return `This echo was queued behind the same ARP attempt, so it failed with it.`;
      case 'not-sent': return f.reason === 'no-route' ? `${f.from} has no route that matches the destination (its only network is ${net(f.from)}), so the kernel refused before building any frame: "Network is unreachable".` : `${f.from} could not send (${f.reason}).`;
      case 'dropped': return /not a router/.test(f.reason) ? `${f.at} received a frame addressed to its MAC, but the IP destination is not its own address. ${f.at} is not a router (IP forwarding is off), so it discards the packet. Nobody is told.` : `${f.at}: ${f.reason}.`;
      case 'delivered': return `The echo request reached ${f.at} with TTL ${f.ttl}.`;
      case 'reply-not-sent': return `${f.from} has to answer an address outside its network but has no route for it: the reply is never sent, and nothing reports the failure to the sender.`;
      case 'reply-home': return `The echo reply reached ${f.at} (TTL ${f.ttl}), so ping prints a reply line.`;
      default: return '';
    }
  }

  ipOf(dev) {
    const d = this.run.eng.s.devices[dev];
    return d.kind === 'host' ? hostAddr(this.run.eng, d).addr : null;
  }

  fields(f) {
    if (!f.line) return null;
    const src = f.kind === 'arp-reply' ? f.replyMac : f.srcMac;
    const rows = [['Ethernet destination', `${macLinux(f.dst)} (${this.owner(f.dst)})`], ['Ethernet source', `${macLinux(src)} (${this.owner(src)})`]];
    if (f.kind === 'ip') rows.push(['IP source → destination', `${fmtIp(f.pkt.src)} → ${fmtIp(f.pkt.dst)}`], ['TTL', String(f.pkt.ttl)]);
    else rows.push(['ARP', f.kind === 'arp-request' ? `who has ${fmtIp(f.nh)}? tell ${fmtIp(f.srcIp)}` : `${fmtIp(f.nh)} is at ${macLinux(f.replyMac)}`]);
    return h('table', { class: 'bn-fields' }, h('tbody', {}, rows.map(([k, v2]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v2)))));
  }

  show(i) {
    const lf = this.run.lastFrames;
    if (!lf?.frames.length) return;
    this.frameIdx = Math.max(0, Math.min(lf.frames.length - 1, i));
    this.renderFrames();
    this.animate(lf.frames[this.frameIdx]);
  }

  stepFrame(d) { this.pause(); this.show(this.frameIdx + d); }

  play(from = 0) {
    this.pause();
    this.playing = true;
    this.show(from);
    const tick = () => {
      if (!this.playing) return;
      const lf = this.run.lastFrames;
      if (!lf || this.frameIdx >= lf.frames.length - 1) { this.pause(); return; }
      this.show(this.frameIdx + 1);
      this.timer = setTimeout(tick, 1600 / this.speed);
    };
    this.timer = setTimeout(tick, 1600 / this.speed);
    this.renderFrames();
  }

  pause() { this.playing = false; clearTimeout(this.timer); }

  /** Draw the frame moving: sender -> switch -> receiver(s), lighting the links it crosses. */
  animate(f) {
    cancelAnimationFrame(this.raf);
    for (const el of Object.values(this.linkEls || {})) el.classList.remove('lit', 'bc');
    if (!this.pktLayer) return;
    clear(this.pktLayer);
    if (!f || f.note || !f.links) {
      if (f && (f.at || f.from) && POS[f.at || f.from]) {
        const [x, y] = POS[f.at || f.from];
        this.pktLayer.append(s('rect', { x: x - 74, y: y - 36, width: 148, height: 72, class: `bn-mark ${/home|delivered/.test(f.kind) ? 'ok' : 'bad'}` }));
      }
      return;
    }
    for (const id of f.links) this.linkEls[id]?.classList.add('lit', f.bcast ? 'bc' : 'uc');
    const sw = f.seg && POS[f.seg] ? POS[f.seg] : null;
    const from = POS[f.from];
    const tos = (f.to || []).map(t => POS[t]).filter(Boolean);
    if (!from || !sw) return;
    const cls = f.kind === 'ip' ? 'ip' : 'arp';
    const dots = tos.map(() => s('circle', { r: 7, class: `bn-pkt ${cls}` }));
    const lead = s('circle', { r: 7, class: `bn-pkt ${cls}` });
    this.pktLayer.append(lead, ...dots);
    const dur = 1300 / this.speed;
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / dur);
      if (t < 0.5) {
        const k = t / 0.5;
        lead.setAttribute('cx', from[0] + (sw[0] - from[0]) * k); lead.setAttribute('cy', from[1] + (sw[1] - from[1]) * k);
        for (const d of dots) d.setAttribute('cx', -50);
      } else {
        lead.setAttribute('cx', -50);
        const k = (t - 0.5) / 0.5;
        tos.forEach((p, j) => { dots[j].setAttribute('cx', sw[0] + (p[0] - sw[0]) * k); dots[j].setAttribute('cy', sw[1] + (p[1] - sw[1]) * k); });
      }
      if (t < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ consoles
  renderTerm() {
    const box = clear(this.term);
    const devs = HOSTS;
    box.append(h('div', { class: 'bn-devtabs' }, devs.map(id => h('button', { class: `bn-devtab ${id === this.dev ? 'on' : ''}`, onclick: () => { this.dev = id; this.renderTerm(); } }, id, h('small', {}, ' Ubuntu')))));
    const c = this.run.console(this.dev);
    if (!c.lines.length) c.lines.push({ t: 'note', sim: true, text: `${this.dev}: Ubuntu 24.04, logged in as root. Type a command and press Enter; help lists the supported ones.` });
    this.out = h('div', { class: 'term scroll os-linux bn-out', role: 'log', 'aria-live': 'polite' });
    for (const l of c.lines.slice(-300)) {
      if (l.t === 'cmd') this.out.append(h('div', { class: 'ln cmd' }, h('span', { class: 'pr' }, `${l.prompt} `), l.text));
      else if (l.t === 'note') this.out.append(h('span', { class: `note ${l.sim ? 'sim' : ''} ${l.lesson ? 'lesson' : ''}` }, l.text));
      else this.out.append(h('div', { class: 'ln' }, l.text));
    }
    this.input = h('input', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': `command on ${this.dev}`, placeholder: 'type a command' });
    this.input.addEventListener('keydown', e => this.key(e));
    const form = h('form', { class: 'cmdline', onsubmit: e => { e.preventDefault(); this.submit(); } }, h('span', { class: 'pr' }, promptOf(this.run.eng, c.sess)), this.input, h('button', { class: 'btn small', type: 'submit' }, 'RUN ↵'));
    box.append(this.out, form);
    this.out.scrollTop = this.out.scrollHeight;
    this.histIdx = c.hist.length;
  }

  fill(dev, text) {
    this.dev = dev;
    this.setTab('console');
    this.renderTerm();
    this.input.value = text;
    if (!this.app.touch) this.input.focus();
  }

  key(e) {
    const c = this.run.console(this.dev);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.histIdx = Math.max(0, Math.min(c.hist.length, this.histIdx + (e.key === 'ArrowUp' ? -1 : 1)));
      this.input.value = c.hist[this.histIdx] ?? '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const done = this.run.complete(this.dev, this.input.value);
      if (done) this.input.value = done;
    } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); c.lines = []; this.renderTerm(); }
  }

  submit() {
    const run = this.run;
    const line = this.input.value;
    const c = run.console(this.dev);
    c.lines.push({ t: 'cmd', prompt: promptOf(run.eng, c.sess), text: line });
    if (line.trim()) c.hist.push(line);
    if (!line.trim()) { this.renderTerm(); this.input.focus(); return; }
    const r = run.run(this.dev, line);
    if (r.clear) c.lines = [];
    for (const l of r.lines || []) {
      if (typeof l === 'string') c.lines.push({ t: 'out', text: l });
      else if (l?.t === 'note' && (l.sim || this.app.settings.trainerNotes !== false)) c.lines.push({ t: 'note', text: l.text, sim: !!l.sim });
    }
    for (const t of r.tips || []) c.lines.push({ t: 'note', lesson: true, text: t.text });
    if (r.tips?.some(t => t.offer && t.concept)) this.offer = r.tips.find(t => t.offer).concept;
    if (r.frames) { this.frameIdx = 0; this.renderFrames(); if (r.frames.length) this.play(0); } else if (run.lastFrames && /^\s*ping\b/.test(line)) this.renderFrames();
    this.renderTerm();
    this.renderDiagram();
    if (run.phase === 'task' && run.finishTask()) this.after();
    else if (this.offer) { const m = this.offer; this.offer = null; if (!run.st.taught.includes(m)) { this.card.prepend(h('div', { class: 'bn-hint concept' }, h('b', {}, 'REFRESHER AVAILABLE '), MISCONCEPTIONS[m].title, ' ', h('button', { class: 'btn small', onclick: () => { clear(this.card); this.renderRemedy(this.card, m); } }, 'Show me (1 min)'))); } }
    if (!this.app.touch) this.input.focus();
  }

  exit() {
    clearInterval(this.clock);
    this.pause();
    cancelAnimationFrame(this.raf);
    this.ov.remove();
    this.app.leaveLesson?.();
  }
}
