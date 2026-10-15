// Runtime for the step-by-step coach (content in src/content/coach.js). Observes the engine's event log, the
// stations the player opens and how far they have looked/walked; ticks steps off, explains each result, and
// coaches when a command is rejected or typed on the wrong device. Never blocks progress.
import { coachSteps, iosIs } from '../content/coach.js';

export class Coach {
  constructor(app) {
    this.app = app;
    this.reset(null);
  }

  /** Start coaching a mission (or stop, with null). Restores ticked steps from the campaign save. */
  reset(mission, saved = null) {
    this.mission = mission;
    this.steps = mission ? coachSteps(mission.id) : null;
    this.done = new Set(saved || []);
    this.opened = new Set();
    this.lookTravel = 0;
    this.walkTravel = 0;
    this.lastYaw = null;
    this.lastPos = null;
    this.tipAt = 0;
    this.last = null;
    if (this.steps && this.app.progress?.coachBasics) for (const s of this.steps) if (s.basic) this.done.add(s.id);
  }

  get active() { return !!(this.steps && this.app.settings.coach !== false && (this.app.mode === 'campaign' || this.app.mode === 'replay')); }

  /** Index of the next step: the first one after the furthest step completed (earlier skipped steps stay skipped). */
  nextIndex() {
    if (!this.steps) return -1;
    let far = -1;
    this.steps.forEach((s, i) => { if (this.done.has(s.id)) far = i; });
    return far + 1 < this.steps.length ? far + 1 : -1;
  }

  current() { const i = this.nextIndex(); return i >= 0 ? this.steps[i] : null; }

  ctx() {
    const app = this.app;
    const eng = app.eng;
    const since = app.campaign?.st.startEvent ?? 0;
    const evs = eng.s.events.filter(e => e.seq > since);
    return {
      eng,
      app: this,
      ev: pred => evs.some(pred),
      ran: (dev, test) => evs.some(e => e.type === 'command' && e.host === dev && !e.unknown && test(e.line || '')),
      goal: i => { const g = app.campaign?.mission.goals[i]; return !!(g && g.check(eng)); },
      file: (dev, path) => eng.s.devices[dev]?.files?.[path] ?? null,
    };
  }

  /** Track look/walk distance for the controls lessons (called every frame). */
  track(controls) {
    if (!this.active) return;
    if (this.lastYaw !== null) this.lookTravel += Math.abs(controls.yaw - this.lastYaw) + Math.abs(controls.pitch - (this.lastPitch ?? controls.pitch));
    if (this.lastPos) this.walkTravel += Math.hypot(controls.pos.x - this.lastPos.x, controls.pos.z - this.lastPos.z);
    this.lastYaw = controls.yaw;
    this.lastPitch = controls.pitch;
    this.lastPos = { x: controls.pos.x, z: controls.pos.z };
  }

  /** Called on every evaluation: ticks off any steps whose condition now holds, in order, and celebrates the latest. */
  update() {
    if (!this.active) return;
    const c = this.ctx();
    let newest = null;
    // a step can only be ticked once the steps before it are done or skipped, so feedback arrives in order
    for (let i = this.nextIndex(); i >= 0 && i < this.steps.length; i = this.nextIndex()) {
      const s = this.steps[i];
      let ok = false;
      try { ok = s.done(c); } catch { ok = false; }
      if (!ok) break;
      this.done.add(s.id);
      newest = s;
      this.app.telemetry.log('coach-step', { mission: this.mission.id, step: s.id });
    }
    if (this.steps.filter(s => s.basic).every(s => this.done.has(s.id)) && this.steps.some(s => s.basic) && !this.app.progress.coachBasics) {
      this.app.progress.coachBasics = true;
      this.app.saveProgress();
    }
    // later steps can also be reached directly (e.g. the player fixed it without the diagnostics)
    if (!newest) {
      const i = this.nextIndex();
      for (let k = i + 1; i >= 0 && k < this.steps.length; k++) {
        const s = this.steps[k];
        let ok = false;
        try { ok = s.done(c); } catch { ok = false; }
        if (ok && !s.basic) { for (let j = i; j <= k; j++) this.done.add(this.steps[j].id); newest = s; break; }
      }
    }
    if (newest) this.celebrate(newest);
    if (this.app.campaign) this.app.campaign.st.coach = { ...(this.app.campaign.st.coach || {}), [this.mission.id]: [...this.done] };
  }

  celebrate(step) {
    const app = this.app;
    this.last = step;
    const n = this.steps.indexOf(step) + 1;
    app.sound.ok();
    if (step.learned) app.hud.say(step.learned, `COACH · STEP ${n} OF ${this.steps.length} DONE`, Math.max(9000, step.learned.length * 75));
    app.hud.coachPulse();
  }

  /** Station opened (or a map tab shown). Gently redirects when the player opened a different console. */
  noteOpen(id) {
    this.opened.add(id);
    if (!this.active) return;
    const s = this.current();
    if (s && s.where && id !== s.where && !id.startsWith('map') && s.where !== 'HOLO') {
      const label = { PATCH: 'the patch panel in RACK C' }[s.where] || s.where;
      this.app.hud.say(`This is ${id}. The current step ("${s.title}") is at ${label}: follow the orange marker.`, 'COACH', 7000);
    }
    this.update();
  }

  /**
   * After a command: if it was rejected or typed on the wrong device while a step expects a specific command,
   * return trainer-note lines explaining what to type instead.
   */
  onCommand(dev, line, result) {
    if (!this.active) return [];
    const s = this.current();
    if (!s || !s.cmd) return [];
    const out = (result.lines || []).map(l => (typeof l === 'string' ? l : l.text || '')).join('\n');
    const rejected = /% Incomplete command|% Invalid input|% Ambiguous command|% Unknown command|not recognized as an internal|command not found/.test(out);
    const os = this.app.eng.s.devices[dev]?.os;
    const same = os === 'ios' ? iosIs(line, s.cmd.text) : line.trim().toLowerCase().startsWith(s.cmd.text.toLowerCase().split(' ')[0]);
    if (dev !== s.cmd.dev && same) return [{ t: 'note', text: `Right command, wrong device: this step runs on ${s.cmd.dev}. Close this console and follow the orange marker.` }];
    if (dev === s.cmd.dev && rejected && s.cmd.text === 'enable') {
      return [{ t: 'note', text: 'The prompt ends in ">": user EXEC mode, where most show and test commands are not available. Type enable first; the prompt changes to "#".' }];
    }
    if (dev === s.cmd.dev && rejected) {
      const why = /Incomplete/.test(out) ? 'IOS needs more words to know what you mean.' : /Ambiguous/.test(out) ? 'That abbreviation matches more than one command.' : /Invalid input/.test(out) ? 'The ^ marks the first word IOS did not accept.' : 'That command is not available here.';
      return [{ t: 'note', text: `${why} For this step type exactly: ${s.cmd.text}  (or click the command in NEXT STEP on the right). Typing "?" after a word lists what can come next.` }];
    }
    return [];
  }

  /** After a patch attempt that did not bring the needed link up. */
  onPatch(result) {
    if (!this.active || !result.ok) return;
    const s = this.current();
    if (s?.id === 'patch' && !this.ctx().goal(0)) this.app.hud.say('That cord is plugged in, but it is not the link this incident needs (check the link light). Click a port with a cord to unplug it, then join "EDGE-RTR Gi0/1 · LAN" (P01) to "ACCESS-SW Gi0/1 · uplink" (P04).', 'COACH', 9000);
  }
}
