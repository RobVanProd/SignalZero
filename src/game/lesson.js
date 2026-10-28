// Runtime for an apprenticeship lesson (content in src/content/lessons.js). No DOM: the bench UI and the unit tests
// drive it the same way. It owns the bench network, runs commands through the real CLI, derives the frame view
// from what the engine recorded, judges steps by live network state, and records predictions, answers, hints and
// remediation for the playtest.
import { Engine } from '../engine/engine.js';
import { parseIp, fmtIp, networkOf, broadcastOf } from '../engine/ipv4.js';
import { hostAddr } from '../engine/routing.js';
import { framesFor } from '../engine/frames.js';
import { createSession, execute, complete as completeCmd } from '../cli/index.js';
import { buildBench, BENCH, BENCH_FAULTS, benchReaches } from '../content/bench.js';
import { MISCONCEPTIONS } from '../content/lessons.js';

export const TRANSFER_FAULTS = ['gateway-is-host', 'no-return'];
const STRUGGLE_COMMANDS = 6;

const clone = o => JSON.parse(JSON.stringify(o));
const textOf = r => (r.lines || []).map(l => (typeof l === 'string' ? l : l.text || '')).join('\n');

export class LessonRun {
  /** opts: { log(type, data), seed, resume: saved state } */
  constructor(lesson, opts = {}) {
    this.lesson = lesson;
    this.log = opts.log || (() => {});
    const seed = opts.seed ?? 1;
    this.st = opts.resume ? clone(opts.resume) : {
      i: 0, transferFault: TRANSFER_FAULTS[Math.abs(seed) % TRANSFER_FAULTS.length], predictions: {}, checks: {}, explains: {},
      hints: {}, misconceptions: {}, taught: [], completed: [], skipped: [], gaveUp: {}, placement: null, startedAt: Date.now(),
      stepTimes: {}, commands: 0,
    };
    if (!opts.resume && opts.transferFault && TRANSFER_FAULTS.includes(opts.transferFault)) this.st.transferFault = opts.transferFault;
    if (!opts.resume && opts.startAt) { const k = lesson.steps.findIndex(s => s.id === opts.startAt); if (k > 0) { this.st.i = k; this.st.skipped.push(...lesson.steps.slice(0, k).map(s => s.id)); this.st.facilitated = opts.startAt; } }
    this.consoles = {};
    this.enter(this.st.i, { restore: true });
  }

  get step() { return this.lesson.steps[this.st.i]; }
  get variant() { return this.eng.s.bench; }
  get v() { return BENCH[this.variant]; }
  get finished() { return this.st.i >= this.lesson.steps.length; }

  // ------------------------------------------------------------------ bench
  build(step) {
    const variant = step.fresh?.variant ?? step.bench ?? 'A';
    const eng = buildBench(variant, { gw: step.fresh?.gw });
    const f = step.fresh?.fault === 'transfer' ? this.st.transferFault : step.fresh?.fault;
    if (f) BENCH_FAULTS[f].apply(eng, variant);
    eng.s.changeLog = [];
    return eng;
  }

  /** Enter step i. A step with `fresh` (or a different bench) gets a newly built network; others continue. */
  enter(i, { restore = false } = {}) {
    this.st.i = i;
    if (this.finished) { this.phase = 'finished'; return; }
    const step = this.step;
    const needNew = !this.eng || step.fresh || (step.bench && this.eng.s.bench !== step.bench);
    if (restore && this.st.snapshot && this.st.snapshotStep === i) this.eng = new Engine(clone(this.st.snapshot));
    else if (needNew) this.eng = this.build(step);
    if (needNew || restore) this.consoles = {};
    this.st.snapshot = clone(this.eng.s);
    this.st.snapshotStep = i;
    this.mark();
    this.phase = step.kind === 'explain' ? 'read' : step.predict && this.st.predictions[step.id] === undefined ? 'predict' : 'task';
    this.hintIdx = this.st.hints[step.id] || 0;
    this.flags = {};
    this.cmdsInStep = 0;
    this.errorsInStep = 0;
    this.lastFrames = null;
    this.t0 = Date.now();
    this.log('lesson-step', { lesson: this.lesson.id, step: step.id, variant: this.eng.s.bench });
  }

  mark() { this.start = { event: this.eng.s.eventSeq, traffic: this.eng.trafficSeq }; }

  /** Put the bench back the way this step started (the learner's own changes are undone). */
  reset() {
    this.eng = new Engine(clone(this.st.snapshot));
    this.consoles = {};
    this.mark();
    this.flags = {};
    this.lastFrames = null;
    this.log('lesson-reset', { lesson: this.lesson.id, step: this.step.id });
  }

  console(dev) {
    return (this.consoles[dev] ||= { sess: createSession(this.eng, dev), lines: [], hist: [] });
  }

  // ------------------------------------------------------------------ commands
  run(dev, line) {
    const c = this.console(dev);
    const before = this.eng.trafficSeq;
    const r = execute(this.eng, c.sess, line);
    const probes = this.eng.traffic.filter(x => x.seq > before);
    const frames = probes.length ? framesFor(this.eng, probes) : null;
    if (frames || /^\s*ping\b/.test(line)) this.lastFrames = { dev, line, frames: frames || [], at: Date.now() };
    this.st.commands++;
    this.cmdsInStep++;
    const out = textOf(r);
    if (/Error:|RTNETLINK answers|Unreachable|not found|unknown, try/.test(out)) this.errorsInStep++;
    this.observe(dev, line, out);
    const tips = this.step?.support === 'independent' ? [] : this.remediation(dev, line, out);
    this.log('lesson-cmd', { lesson: this.lesson.id, step: this.step?.id, dev, line: line.slice(0, 80), err: /Error:|RTNETLINK|Unreachable/.test(out) });
    return { ...r, frames, tips };
  }

  complete(dev, line) { return completeCmd(this.eng, this.console(dev).sess, line); }

  /** State the step needs to remember between commands. */
  observe(dev, line, out) {
    if (this.step?.id === 'return' && dev === 'PC-A' && /ping/.test(line) && /100% packet loss/.test(out) && !/Unreachable/.test(out)) {
      const srv = this.eng.s.devices.SRV.ipcfg.static;
      if (srv.gw === null && !(srv.routes || []).length) this.flags.sawNoReturn = true;
    }
  }

  /** Short notes that teach the idea behind a rejected or failed command (guided and supported steps only). */
  remediation(dev, line, out) {
    const tips = [];
    const d = this.eng.s.devices[dev];
    const a = d?.kind === 'host' ? hostAddr(this.eng, d) : null;
    const range = a && a.addr !== null ? `${fmtIp(networkOf(a.addr, a.len))} to ${fmtIp(broadcastOf(a.addr, a.len))}` : '';
    const r1 = this.eng.s.devices.R1;
    const local = a && a.addr !== null ? Object.values(r1.ports).find(p => p.ip && networkOf(p.ip.addr, p.ip.len) === networkOf(a.addr, a.len)) : null;
    if (/Nexthop has invalid gateway/.test(out)) {
      tips.push({ concept: 'mask', text: `A gateway must be on ${dev}'s own network, ${fmtIp(networkOf(a.addr, a.len))}/${a.len} (${range}), because ${dev} reaches it with one ARP and one frame. ${local && this.step.support === 'guided' ? `R1's address on that network is ${fmtIp(local.ip.addr)}.` : 'Which of R1\'s two addresses (on the diagram) is inside that range?'}` });
      this.bump('mask');
    }
    if (/RTNETLINK answers: File exists/.test(out) && /\badd\s+default\b/.test(line)) tips.push({ text: `${dev} already has a default route, and a host uses one. "ip route" shows it. Change it with "ip route replace default via …", or delete it first with "ip route del default".` });
    if (/RTNETLINK answers: No such process/.test(out)) tips.push({ text: 'There is no such route to delete. "ip route" lists the routes that exist.' });
    if (/ping: connect: Network is unreachable/.test(out) && this.st.i > this.indexOf('offnet')) tips.push({ text: `"Network is unreachable": no route on ${dev} matched the destination, so nothing was sent. Which route would cover it? (ip route)` });
    if (a && a.addr !== null && new RegExp(`From ${fmtIp(a.addr).replace(/\./g, '\\.')} icmp_seq=\\d+ Destination Host Unreachable`).test(out) && this.step.support === 'supported' && this.step.id !== 'fault') {
      tips.push({ concept: 'error-means-remote', text: `That message comes from ${dev}'s own address: ${dev} got no ARP answer from its next hop. "ip route get <destination>" shows which next hop it chose.` });
    }
    if (this.step.id === 'practice' && dev !== 'PC-B' && /^\s*ip\s+r\w*\s+(add|replace|del)/.test(line)) tips.push({ text: 'This ticket is about PC-B. Open PC-B\'s console tab to change PC-B.' });
    // struggling: offer the idea this step depends on, once
    const m = this.step.struggle || (this.step.id === 'practice' ? 'mask' : this.step.id === 'fault' ? 'error-means-remote' : null);
    if (m && !this.flags.offered && this.cmdsInStep >= STRUGGLE_COMMANDS && !this.isDone()) {
      this.flags.offered = true;
      tips.push({ concept: m, offer: true, text: `Stuck? A one-minute refresher: "${MISCONCEPTIONS[m].title}".` });
    }
    return tips;
  }

  indexOf(id) { return this.lesson.steps.findIndex(s => s.id === id); }

  // ------------------------------------------------------------------ judging
  ctx() {
    const eng = this.eng;
    const evs = eng.s.events.filter(e => e.seq > this.start.event);
    const ipOf = x => (typeof x === 'number' ? x : parseIp(x));
    const lastCmd = (dev, re) => [...evs].reverse().find(e => e.type === 'command' && e.host === dev && !e.unknown && re.test(e.line || ''));
    return {
      eng,
      v: this.v,
      ran: (dev, re) => evs.some(e => e.type === 'command' && e.host === dev && !e.unknown && re.test((e.line || '').trim())),
      pinged: (dev, dst, ok, opt = {}) => {
        const after = opt.after === 'neigh' ? lastCmd(dev, /^ip\s+(-4\s+)?n/)?.seq ?? Infinity : 0;
        return evs.some(e => e.type === 'ping' && e.host === dev && e.ip === ipOf(dst) && (ok === undefined || e.ok === ok) && e.seq > after);
      },
      pingFailed: (dev, dst, error) => evs.some(e => e.type === 'ping' && e.host === dev && e.ip === ipOf(dst) && !e.ok && (!error || e.error === error)),
      // a successful ping after the last configuration change: the learner checked the network as it is now
      verified: (dev, dst) => evs.some(e => e.type === 'ping' && e.host === dev && e.ip === ipOf(dst) && e.ok && e.changeSeq === eng.s.changeSeq),
      reaches: (from, to) => benchReaches(eng, from, to),
      flag: name => !!this.flags[name],
    };
  }

  /** Does the network, right now, satisfy this step? */
  isDone() {
    const s = this.step;
    if (!s || s.kind === 'explain') return true;
    try { return !!s.done(this.ctx()); } catch { return false; }
  }

  // ------------------------------------------------------------------ the learner's answers
  predict(k) {
    const s = this.step;
    const o = s.predict.options[k];
    this.st.predictions[s.id] = k;
    if (!o.correct && o.misconception) this.bump(o.misconception);
    this.phase = 'task';
    this.log('lesson-predict', { lesson: this.lesson.id, step: s.id, choice: k, correct: !!o.correct });
    return o;
  }

  /** The task is complete only if the network really is in the required state now. */
  finishTask() {
    if (!this.isDone()) return false;
    const s = this.step;
    this.st.stepTimes[s.id] = Math.round((Date.now() - this.t0) / 1000);
    this.phase = 'result';
    this.log('lesson-task-done', { lesson: this.lesson.id, step: s.id, sec: this.st.stepTimes[s.id], cmds: this.cmdsInStep, hints: this.hintIdx });
    return true;
  }

  /** After the result: the explain-back question(s), then the next step. */
  afterResult() {
    const s = this.step;
    if (s.check && this.st.checks[s.id] === undefined) this.phase = 'check';
    else if (s.explain && this.st.explains[s.id] === undefined) this.phase = 'explain';
    else this.phase = 'next';
    return this.phase;
  }

  answerCheck(k) {
    const s = this.step;
    const o = s.check.options[k];
    this.st.checks[s.id] = k;
    const correct = s.id === 'transfer' ? o.fault === this.st.transferFault : !!o.correct;
    if (!correct && o.misconception) this.bump(o.misconception);
    this.log('lesson-check', { lesson: this.lesson.id, step: s.id, choice: k, correct });
    this.afterResult();
    return { option: o, correct };
  }

  answerExplain(text) {
    const s = this.step;
    this.st.explains[s.id] = String(text).slice(0, 600);
    this.log('lesson-explain', { lesson: this.lesson.id, step: s.id, text: this.st.explains[s.id] });
    this.afterResult();
  }

  bump(m) { this.st.misconceptions[m] = (this.st.misconceptions[m] || 0) + 1; }

  /** A misconception seen twice and not yet addressed: teach it before moving on. */
  pendingRemedy() {
    for (const [m, n] of Object.entries(this.st.misconceptions)) if (n >= 2 && !this.st.taught.includes(m) && MISCONCEPTIONS[m]) return m;
    return null;
  }

  taught(m) { if (!this.st.taught.includes(m)) this.st.taught.push(m); this.log('lesson-remedy', { lesson: this.lesson.id, concept: m }); }

  hint() {
    const s = this.step;
    if (s.support !== 'supported' || !s.hints) return null;
    const h = s.hints[Math.min(this.hintIdx, s.hints.length - 1)];
    this.hintIdx = Math.min(this.hintIdx + 1, s.hints.length);
    this.st.hints[s.id] = this.hintIdx;
    this.log('lesson-hint', { lesson: this.lesson.id, step: s.id, n: this.hintIdx, kind: h.kind });
    return h;
  }

  /** Transfer only: explain the case (recorded as a give-up). */
  showMe() {
    const s = this.step;
    this.st.gaveUp[s.id] = true;
    this.log('lesson-giveup', { lesson: this.lesson.id, step: s.id, fault: this.st.transferFault });
    return s.reveal?.[this.st.transferFault] || null;
  }

  next() {
    const s = this.step;
    if (s && !this.st.completed.includes(s.id)) this.st.completed.push(s.id);
    this.enter(this.st.i + 1);
    if (this.finished) this.log('lesson-finished', { lesson: this.lesson.id, ...this.summary() });
  }

  /** Placement check: all correct -> skip to the troubleshooting steps (the learner still has to demonstrate). */
  placement(answers) {
    const qs = this.lesson.placement;
    const right = qs.map((q, i) => !!q.options[answers[i]]?.correct);
    const passed = right.every(Boolean);
    this.st.placement = { answers, right, passed };
    this.log('lesson-placement', { lesson: this.lesson.id, right, passed });
    if (passed) {
      const to = this.indexOf('fault');
      for (let k = this.st.i; k < to; k++) this.st.skipped.push(this.lesson.steps[k].id);
      this.enter(to);
    }
    return { passed, right };
  }

  summary() {
    const st = this.st;
    const preds = Object.entries(st.predictions).map(([id, k]) => !!this.lesson.steps.find(s => s.id === id)?.predict.options[k]?.correct);
    return {
      completed: st.completed.length, skipped: st.skipped.length, commands: st.commands,
      predictionsRight: preds.filter(Boolean).length, predictions: preds.length,
      hints: Object.values(st.hints).reduce((a, b) => a + b, 0), gaveUp: Object.keys(st.gaveUp),
      transferFault: st.transferFault, transferExplained: st.explains.transfer ?? null,
      misconceptions: st.misconceptions, stepTimes: st.stepTimes, placement: st.placement,
    };
  }

  /** Plain JSON for saving (the engine snapshot is the current step's start; the live bench is not kept). */
  save() { return clone(this.st); }
}
