// Campaign runtime: evaluates the active mission against the engine after every action and tick.
// Pure logic (no DOM) so it can be tested headless.
import { MISSIONS } from '../content/missions.js';

export class Campaign {
  constructor(eng, saved = null) {
    this.eng = eng;
    this.st = saved ?? { index: 0, phase: 'main', okSince: null, startT: 0, startChange: 0, startEvent: 0, hints: {}, results: [], done: false };
    this.evBefore = null;
  }

  get mission() { return MISSIONS[this.st.index]; }
  get done() { return this.st.done; }

  /** Start mission i (runs its scripted setup). */
  begin(i) {
    const eng = this.eng;
    this.st.index = i;
    this.st.phase = 'main';
    this.st.okSince = null;
    this.st.startT = eng.s.t;
    this.st.startChange = eng.s.changeSeq;
    this.st.startEvent = eng.s.eventSeq;
    this.st.armAt = null;
    this.st.cutAt = null;
    this.st.outage = null;
    this.st.trigger = null;
    MISSIONS[i].setup?.(eng);
    eng.evaluateFlows();
    this.st.startChange = eng.s.changeSeq;
    return { radio: MISSIONS[i].radioStart };
  }

  markBefore() { this.evBefore = this.eng.s.eventSeq; }

  goalsFor(phase = this.st.phase) {
    const m = this.mission;
    return phase === 'after' ? m.aftershock.goals : m.goals;
  }

  evidenceStatus() {
    const m = this.mission;
    const since = this.st.okSince;
    return (m.evidence || []).map(req => ({
      label: req.label,
      ok: since !== null && this.eng.s.events.some(ev => ev.seq > since && req.match(ev)),
    }));
  }

  /** Evaluate the mission. source: 'command' | 'tick' | 'action'. */
  evaluate(source = 'action') {
    if (this.st.done) return { status: 'done' };
    const eng = this.eng;
    const m = this.mission;
    const phase = this.st.phase;
    if (phase === 'armed') return { status: 'armed', goals: [], constraints: [], evidence: [] };
    const goals = this.goalsFor().map(g => ({ label: g.label, ok: !!g.check(eng) }));
    const constraints = phase === 'main' ? (m.constraints || []).map(c => ({ label: c.label, ok: !!c.check(eng) })) : [];
    const allOk = goals.every(g => g.ok) && constraints.every(c => c.ok);
    if (!allOk) {
      this.st.okSince = null;
      return { status: 'open', goals, constraints, evidence: this.evidenceStatus() };
    }
    if (this.st.okSince === null) this.st.okSince = source === 'command' && this.evBefore !== null ? this.evBefore : eng.s.eventSeq;
    if (phase === 'after') {
      this.st.outage = Math.max(0, Math.round(eng.s.t - this.st.cutAt));
      return this.complete(goals, constraints);
    }
    const evidence = this.evidenceStatus();
    if (!evidence.every(e => e.ok)) return { status: 'verify', goals, constraints, evidence };
    if (m.aftershock) {
      this.st.phase = 'armed';
      this.st.armAt = eng.s.t + m.aftershock.delay;
      return { status: 'cleared', goals, constraints, evidence, radio: m.radioWin.split('.')[0] + '.' };
    }
    return this.complete(goals, constraints, evidence);
  }

  /** Advance scripted events; returns an evaluation or null. */
  tick() {
    if (this.st.done) return null;
    const eng = this.eng;
    const m = this.mission;
    if (this.st.phase === 'armed' && eng.s.t >= this.st.armAt) {
      const what = m.aftershock.trigger(eng);
      this.st.trigger = what;
      if (!what) return this.complete([], []);
      this.st.phase = 'after';
      this.st.cutAt = eng.s.t;
      this.st.okSince = null;
      const r = this.evaluate('tick');
      return { ...r, radio: m.aftershock.radio, aftershock: true };
    }
    if (this.st.phase === 'after') return this.evaluate('tick');
    return null;
  }

  useHint() {
    const m = this.mission;
    const n = Math.min(m.hints.length, (this.st.hints[m.id] || 0) + 1);
    this.st.hints[m.id] = n;
    return { tier: n, text: m.hints[n - 1] };
  }

  complete(goals, constraints, evidence = []) {
    const eng = this.eng;
    const m = this.mission;
    const changes = eng.s.changeLog.filter(c => c.seq > this.st.startChange && c.actor === 'player');
    const cmds = eng.s.events.filter(e => e.seq > this.st.startEvent && e.type === 'command');
    const hints = this.st.hints[m.id] || 0;
    const outcome = m.outcome ? m.outcome(eng, { outage: this.st.outage }) : null;
    let rep = 500 - hints * 60;
    if (outcome?.outage !== undefined && outcome.outage !== null) rep += outcome.outage <= 5 ? 150 : outcome.outage <= 45 ? 60 : 0;
    const result = {
      id: m.id, title: m.title, simSeconds: Math.round(eng.s.t - this.st.startT), hints, changes: changes.length,
      changeList: changes.map(c => c.desc), commands: cmds.length, unknownCommands: cmds.filter(c => c.unknown).length,
      outcome, reputation: Math.max(100, rep), completedAt: Date.now(),
    };
    this.st.results.push(result);
    this.st.phase = 'complete';
    return { status: 'won', goals, constraints, evidence, result, radio: m.radioWin };
  }

  /** Move to the next mission after a win. */
  next() {
    if (this.st.index + 1 >= MISSIONS.length) { this.st.done = true; return { done: true }; }
    return this.begin(this.st.index + 1);
  }

  get reputation() { return this.st.results.reduce((a, r) => a + r.reputation, 0); }
}
