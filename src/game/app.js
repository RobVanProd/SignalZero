// Game controller: modes (title, campaign, replay, challenge), input, the loop, saving, and glue between the
// network engine, the 3D world and the UI.
import { World } from '../world/world.js';
import { detectQuality } from '../world/renderer.js';
import { STATIONS, PLACES } from '../world/layout.js';
import { Engine, wallClock } from '../engine/engine.js';
import { buildDistrict, patchConnect, patchDisconnect, PATCH_PANEL } from '../content/district.js';
import { MISSIONS, enableFlows, buildMissionStart } from '../content/missions.js';
import { generateChallenge, ChallengeRun, healthReport } from '../content/challenges.js';
import { Campaign } from './campaign.js';
import { Coach } from './coach.js';
import { execute, saveFile as cliSave, createSession } from '../cli/index.js';
import { emptyProgress, recordMission, recordChallenge, recordTransfer, PROGRESS_KEY } from './progress.js';
import { Telemetry, TELEMETRY_KEY } from './telemetry.js';
import { Sound } from './audio.js';
import { Hud } from '../ui/hud.js';
import { TerminalWindow } from '../ui/terminal.js';
import { PatchWindow } from '../ui/patch.js';
import { MapWindow } from '../ui/mapview.js';
import { openEditor } from '../ui/editor.js';
import { BenchScreen } from '../ui/bench.js';
import { LESSONS, lessonById } from '../content/lessons.js';
import * as S from '../ui/screens.js';
import { h } from '../ui/dom.js';

const SAVE_KEY = 'signalzero.save.v3';
const SETTINGS_KEY = 'signalzero.settings.v1';
const LESSON_KEY = 'signalzero.lessons.v1';

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export class App {
  constructor() {
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.settings = { quality: null, sensitivity: 1, invertY: false, trainerNotes: true, coach: true, volume: 0.6, unlockAll: false, ...load(SETTINGS_KEY, {}) };
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || this.settings.quality || detectQuality();
    this.world = new World(document.getElementById('view'), q);
    this.progress = load(PROGRESS_KEY, null) || emptyProgress();
    this.telemetry = new Telemetry(load(TELEMETRY_KEY, null));
    this.sound = new Sound();
    this.sound.setVolume(this.settings.volume);
    this.hud = new Hud(this);
    this.term = new TerminalWindow(this);
    this.patchWin = new PatchWindow(this);
    this.mapWin = new MapWindow(this);
    this.coach = new Coach(this);
    this.mode = 'title';
    this.consoles = {};
    this.captures = {};
    this.warp = false;
    this.overlayKind = null;
    this.lastEval = null;
    this.applySettings();
    // a demo network for the title screen
    this.eng = buildMissionStart(buildDistrict, Engine, 9);
    this.world.sync(this.eng, {});
    this.bindInput();
    this.touchControls();
    this.last = performance.now();
    this.acc = { sync: 0, eval: 0, save: 0 };
    requestAnimationFrame(t => this.loop(t));
    this.showTitle();
    window.__SZ__ = this.testApi();
    // facilitator link for playtests: ?lesson=L01[&start=transfer&fault=no-return|gateway-is-host]
    if (params.get('lesson')) this.openLesson(params.get('lesson'), { restart: true, startAt: params.get('start'), transferFault: params.get('fault') });
  }

  // ---------------------------------------------------------------- settings / persistence
  saveSettings() { store(SETTINGS_KEY, this.settings); this.applySettings(); }

  applySettings() {
    const c = this.world.controls;
    c.sensitivity = this.settings.sensitivity;
    c.invertY = this.settings.invertY;
    this.sound.setVolume(this.settings.volume);
    this.trainerNotes = this.mode === 'challenge' ? false : this.settings.trainerNotes;
  }

  hasSave() { return !!load(SAVE_KEY, null); }

  saveLabel() {
    const s = load(SAVE_KEY, null);
    if (!s) return '';
    const m = MISSIONS[s.camp?.index ?? 0];
    return m ? `${m.id} · ${m.title}` : '';
  }

  save() {
    if (this.mode !== 'campaign' || !this.campaign) return;
    const consoles = {};
    for (const [k, c] of Object.entries(this.consoles)) consoles[k] = { lines: c.lines.slice(-150), hist: c.hist.slice(-40), sess: c.sess };
    const ok = store(SAVE_KEY, { v: 3, s: this.eng.s, camp: this.campaign.st, consoles, savedAt: Date.now() });
    if (!ok && !this.saveWarned) { this.saveWarned = true; this.hud.say('Browser storage is unavailable: progress will not be saved when you close this tab.', 'SYSTEM'); }
  }

  saveProgress() { store(PROGRESS_KEY, this.progress); store(TELEMETRY_KEY, this.telemetry.data); }

  resetAll() {
    for (const k of [SAVE_KEY, PROGRESS_KEY, TELEMETRY_KEY, LESSON_KEY]) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
    location.reload();
  }

  exportTelemetry() {
    const blob = new Blob([this.telemetry.export()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `signalzero-playtest-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  reportTransfer(id, note) { recordTransfer(this.progress, id, note); this.saveProgress(); }

  // ---------------------------------------------------------------- modes
  showTitle() {
    this.mode = 'title';
    this.hud.show(false);
    this.world.controls.enabled = false;
    document.exitPointerLock?.();
    this.titleEl?.remove();
    this.titleEl = S.titleScreen(this);
  }

  hideTitle() { this.titleEl?.remove(); this.titleEl = null; }

  startEngine(eng, mode) {
    this.eng = eng;
    this.mode = mode;
    this.consoles = {};
    this.captures = {};
    this.applySettings();
    this.world.packets.items = [];
    this.world.sync(eng, this.view());
    this.hud.show(true);
    this.world.controls.enabled = true;
    this.world.controls.teleport(0, 6.6, 0, -0.04);
  }

  newCampaign() {
    if (this.hasSave() && !confirm('Start a new campaign? Your saved shift will be replaced.')) return;
    this.hideTitle();
    const eng = new Engine(buildDistrict());
    eng.converge();
    eng.s.flows = [];
    enableFlows(eng, ['clinic', 'backup']);
    this.campaign = new Campaign(eng);
    this.startEngine(eng, 'campaign');
    this.telemetry.log('campaign-start');
    this.beginMission(0);
  }

  continueCampaign() {
    const sv = load(SAVE_KEY, null);
    if (!sv) return this.newCampaign();
    this.hideTitle();
    const eng = new Engine(sv.s);
    eng.ensure();
    this.campaign = new Campaign(eng, sv.camp);
    this.startEngine(eng, 'campaign');
    for (const [k, c] of Object.entries(sv.consoles || {})) this.consoles[k] = { lines: c.lines || [], hist: c.hist || [], sess: c.sess || createSession(eng, k) };
    this.telemetry.log('campaign-continue', { mission: this.campaign.mission?.id });
    if (this.campaign.st.phase === 'complete') this.advanceCampaign();
    else { this.coach.reset(this.campaign.mission, this.campaign.st.coach?.[this.campaign.mission.id]); this.evaluate('action'); this.hud.say(this.campaign.mission.radioStart); }
  }

  replayMission(i) {
    this.hideTitle();
    const eng = buildMissionStart(buildDistrict, Engine, i);
    this.campaign = new Campaign(eng, { index: i, phase: 'main', okSince: null, startT: eng.s.t, startChange: eng.s.changeSeq, startEvent: eng.s.eventSeq, hints: {}, results: [], done: false });
    this.startEngine(eng, 'replay');
    this.coach.reset(MISSIONS[i]);
    this.telemetry.log('replay', { mission: MISSIONS[i].id });
    S.briefing(this, MISSIONS[i], () => { this.hud.say(MISSIONS[i].radioStart); this.evaluate('action'); });
    this.evaluate('action');
  }

  beginMission(i) {
    const r = this.campaign.begin(i);
    this.coach.reset(MISSIONS[i], this.campaign.st.coach?.[MISSIONS[i].id]);
    this.world.sync(this.eng, this.view());
    this.evaluate('action');
    this.telemetry.log('mission-start', { id: MISSIONS[i].id });
    this.world.controls.enabled = false;
    S.briefing(this, MISSIONS[i], () => { this.world.controls.enabled = true; this.hud.say(r.radio); this.sound.radio(); this.save(); });
  }

  startChallenge(opts) {
    this.hideTitle();
    const seed = opts?.seed ?? (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    let ch;
    try { ch = generateChallenge(seed, opts); } catch (e) { alert(`Could not generate a challenge: ${e.message}`); return this.showTitle(); }
    this.challenge = new ChallengeRun(ch);
    this.campaign = null;
    this.coach.reset(null);
    this.startEngine(ch.eng, 'challenge');
    this.telemetry.log('challenge-start', { seed, faults: ch.faults.map(f => f.id) });
    this.world.controls.enabled = false;
    S.ticket(this, ch, () => { this.world.controls.enabled = true; this.hud.say('Ticket accepted. Users are waiting. Start where they are.', 'NIGHT SHIFT'); this.evaluate('action'); });
    this.evaluate('action');
  }

  quitToTitle() {
    this.save();
    this.closeOverlay();
    this.coach.reset(null);
    this.campaign = null;
    this.challenge = null;
    this.showTitle();
  }

  modeLabel() { return { campaign: 'Night shift campaign', replay: 'Incident replay', challenge: 'Night Shift challenge' }[this.mode] || 'SIGNAL//ZERO'; }

  mission() { return this.campaign ? this.campaign.mission : null; }

  missionInfo() {
    if (this.campaign) { const m = this.campaign.mission; return { code: m.code, title: m.title }; }
    if (this.challenge) return { code: 'NIGHT SHIFT', title: `Ticket INC-${String(this.challenge.ch.seed).slice(-6)}` };
    return null;
  }

  showBriefingAgain() { const m = this.mission(); if (m) S.briefing(this, m, () => this.afterMenu()); }

  // ---------------------------------------------------------------- evaluation
  evaluate(source = 'action') {
    // Player actions refresh the monitored flows at once, so the services panel agrees with the checklist
    // instead of lagging up to one 5 s flow tick behind it. (Flow probes are not recorded as player evidence.)
    if (source !== 'tick' && this.eng && this.mode !== 'title') { this.eng.evaluateFlows(); this.hud.setServices(this.eng); }
    if (this.campaign) { const ev = this.evalCampaign(source); this.coach.update(); this.hud.setCoach(this.coach); return ev; }
    if (this.challenge) return this.evalChallenge(source);
    return null;
  }

  evalCampaign(source) {
    const camp = this.campaign;
    if (!camp || camp.done || camp.st.phase === 'complete') return null;
    const ev = camp.evaluate(source);
    if (camp.st.phase === 'after' && ev.status === 'open') ev.status = 'after';
    if (camp.st.phase === 'armed') ev.status = 'armed';
    this.lastEval = { ...this.lastEval, ...ev, goals: ev.goals?.length ? ev.goals : this.lastEval?.goals || [], evidence: ev.evidence || this.lastEval?.evidence || [] };
    if (ev.status === 'armed' || ev.status === 'cleared') { this.lastEval.status = 'armed'; }
    this.hud.setMission(camp.mission, this.lastEval);
    if (ev.status === 'cleared') {
      this.hud.flash('SERVICE RESTORED', camp.mission.title, 'Stay alert: the night is not over.');
      this.hud.say(ev.radio || camp.mission.radioWin);
      this.sound.ok();
    }
    if (ev.status === 'won') this.onMissionWon(ev);
    return ev;
  }

  onMissionWon(ev) {
    const m = this.campaign.mission;
    const r = ev.result;
    recordMission(this.progress, m, r);
    this.saveProgress();
    this.telemetry.log('mission-win', { id: m.id, sec: r.simSeconds, hints: r.hints, changes: r.changes });
    this.sound.win();
    this.hud.flash('INCIDENT RESOLVED', m.title, `${r.simSeconds}s · ${r.commands} commands · ${r.hints} hints`);
    this.world.sync(this.eng, this.view());
    this.save();
    setTimeout(() => {
      this.closeOverlay();
      this.world.controls.enabled = false;
      document.exitPointerLock?.();
      const last = this.campaign.st.index === MISSIONS.length - 1;
      S.debrief(this, m, ev, {
        last: this.mode === 'campaign' && last,
        onNext: () => { if (this.mode === 'campaign') this.advanceCampaign(); else this.showTitle(); },
        onReplay: () => this.replayMission(MISSIONS.indexOf(m)),
      });
    }, 1600);
  }

  advanceCampaign() {
    const camp = this.campaign;
    if (camp.st.index + 1 >= MISSIONS.length) {
      camp.st.done = true;
      this.save();
      S.shiftComplete(this, camp.st.results);
      return;
    }
    this.hud.say(camp.mission.radioWin);
    this.beginMission(camp.st.index + 1);
  }

  evalChallenge(source) {
    const run = this.challenge;
    const ev = run.evaluate(source);
    const h0 = ev.health || healthReport(this.eng);
    const goals = h0.flows.map(f => ({ label: f.label, ok: f.ok }));
    if (h0.storm) goals.unshift({ label: 'No switching loop', ok: false });
    this.lastEval = { status: ev.status, goals, evidence: [{ label: 'Verify from a user device after your fix (curl, ping, renew…)', ok: ev.status === 'won' }], constraints: [] };
    this.hud.setMission({ code: 'NIGHT SHIFT · UNGUIDED', title: `INC-${String(run.ch.seed).slice(-6)}`, task: run.ch.ticket.join(' ') }, this.lastEval);
    if (ev.status === 'won' && !run.reported) {
      run.reported = true;
      recordChallenge(this.progress, ev.result);
      this.saveProgress();
      this.telemetry.log('challenge-win', { seed: run.ch.seed, sec: ev.result.simSeconds, hints: ev.result.hints });
      this.sound.win();
      setTimeout(() => { this.closeOverlay(); this.world.controls.enabled = false; document.exitPointerLock?.(); S.challengeDone(this, ev); }, 1400);
    }
    return ev;
  }

  hintsAllowed() { return !!(this.campaign || this.challenge); }

  currentHint() {
    if (this.challenge) return { next: 1, total: '∞', cost: 0, text: this.challengeHint || '' };
    const m = this.campaign.mission;
    const used = this.campaign.st.hints[m.id] || 0;
    return { next: used < m.hints.length ? used + 1 : null, total: m.hints.length, cost: 60, text: used ? m.hints.slice(0, used).map((x, i) => `${i + 1}. ${x}`).join('\n\n') : '' };
  }

  useHint() {
    if (this.challenge) { this.challengeHint = this.challenge.hint(); this.telemetry.log('hint', { mode: 'challenge' }); return; }
    const r = this.campaign.useHint();
    this.telemetry.log('hint', { mission: this.campaign.mission.id, tier: r.tier });
  }

  // ---------------------------------------------------------------- actions (all mutate the engine)
  runCommand(devId, sess, line) {
    const eng = this.eng;
    this.campaign?.markBefore();
    this.challenge?.markBefore();
    let r;
    try { r = execute(eng, sess, line); } catch (e) { console.error(e); r = { lines: [`% internal simulator error: ${e.message}`] }; }
    const last = eng.s.events[eng.s.events.length - 1];
    this.telemetry.command(devId, line, last?.type === 'command' && last.unknown);
    const tips = this.coach.onCommand(devId, line, r);
    if (tips.length) r = { ...r, lines: [...(r.lines || []), ...tips.map(t => ({ ...t, coach: true }))] };
    if (r.trace || r.frames) {
      this.captures[devId] = { cmd: line.trim(), probe: r.trace || null, frames: r.frames || null };
      if (r.trace) this.world.playProbe(eng, r.trace);
    }
    this.sound.key();
    this.evaluate('command');
    this.world.sync(eng, this.view());
    this.dirty = true;
    return r;
  }

  saveFile(dev, path, text) {
    this.campaign?.markBefore();
    cliSave(this.eng, dev, path, text);
    this.telemetry.log('edit', { dev, path });
    this.evaluate('action');
    this.dirty = true;
  }

  patch(a, b) {
    const r = patchConnect(this.eng, a, b);
    this.telemetry.log('patch', { a, b, ok: r.ok });
    if (r.ok) { this.sound.use(); this.evaluate('action'); this.world.sync(this.eng, this.view()); this.dirty = true; } else this.sound.deny();
    this.coach.onPatch(r);
    return r;
  }

  unpatch(a) {
    const r = patchDisconnect(this.eng, a);
    this.telemetry.log('unpatch', { a, ok: r.ok });
    if (r.ok) { this.evaluate('action'); this.world.sync(this.eng, this.view()); this.dirty = true; }
    return r;
  }

  unplugRogue() {
    const s = this.eng.s;
    delete s.links.rogue;
    delete s.links.rogue2;
    this.eng.reindex();
    this.eng.mutated('unplugged the unknown travel router from the lobby jack');
    this.telemetry.log('unplug-rogue');
    this.evaluate('action');
    this.world.sync(this.eng, this.view());
  }

  testCall() {
    this.eng.evaluateFlows();
    const v = this.eng.s.flowState.voice;
    const m = v?.metric;
    const r = m ? { ok: m.mos > 1, mos: m.mos, loss: m.loss, jitter: m.jitter } : { ok: false };
    this.eng.event({ type: 'voip-test', host: 'VOIP-PHONE', mos: r.mos || 0, ok: r.ok && r.mos >= 4 });
    this.evaluate('action');
    return r;
  }

  openEditor(spec, onDone) {
    openEditor(this, spec, onDone);
  }

  focusTerminal() { if (this.term.ov && !this.touch) this.term.input?.focus(); }

  // ---------------------------------------------------------------- overlays & interaction
  /** What a cable is and where it goes, for the aim prompt (pseudo-station for the HUD). */
  describeCable(info) {
    const s = this.eng.s;
    const lab = id => PATCH_PANEL.find(p => p.id === id)?.label || id;
    if (info.kind === 'run') {
      const cord = s.patch.cords.find(c => c.includes(info.panel));
      const other = cord && cord.find(x => x !== info.panel);
      return { type: 'cable-patch', label: `CABLE · ${info.dev} ${info.port} → PATCH PANEL ${info.panel}`, sub: `Permanent cable, wired behind the panel. Front of ${info.panel}: ${other ? `patch cord to ${other} (${lab(other)})` : 'EMPTY, no patch cord'}.` };
    }
    const l = s.links[info.link];
    if (!l) return null;
    const ls = this.eng.linkStatus(l.id);
    const state = ls.up ? `link up · ${ls.speed}${ls.speed === 'wifi' ? '' : ' Mb/s'}${ls.mismatch ? ' · DUPLEX MISMATCH' : ` ${ls.duplexA}-duplex`}` : `NO LINK (${ls.reason || 'down'})`;
    if (info.kind === 'cord') return { type: 'cable-patch', label: `PATCH CORD · ${l.label.replace('↔', ' ↔ ')}`, sub: `${l.a.dev} ${l.a.port} ↔ ${l.b.dev} ${l.b.port} · ${state}` };
    return { type: 'cable', label: `CABLE · ${l.a.dev} ${l.a.port} ↔ ${l.b.dev} ${l.b.port}`, sub: `${state}. A permanent cable: you work on it from the switch ports at either end.` };
  }

  interact() {
    if (this.mode === 'title' || this.overlayKind) return;
    const p = this.pick;
    if (!p) { this.sound.deny(); return; }
    if (p.cable) {
      const d = this.describeCable(p.cable);
      if (d?.type === 'cable-patch') { this.sound.use(); this.openStation(STATIONS.find(s => s.id === 'PATCH')); }
      else if (d) this.hud.say(`${d.label}: ${d.sub}`, 'CABLE', 7000);
      return;
    }
    const st = STATIONS.find(s => s.id === p.station);
    if (!st) return;
    if (st.dev && this.eng.s.devices[st.dev]?.powered === false) { this.hud.say(`${st.label} has no power yet.`, 'SYSTEM', 4000); this.sound.deny(); return; }
    this.sound.use();
    this.telemetry.log('station', { id: st.id });
    this.openStation(st);
  }

  openStation(st) {
    document.exitPointerLock?.();
    this.world.controls.enabled = false;
    this.coach.noteOpen(st.type === 'map' ? 'map' : st.id);
    if (st.type === 'console') {
      this.overlayKind = 'term';
      if (['CORE-SRV', 'CLINIC-APP', 'CCTV-NVR'].includes(st.dev)) this.kvm = st.dev;
      this.term.open(st);
    } else if (st.type === 'patch') { this.overlayKind = 'patch'; this.patchWin.open(); }
    else if (st.type === 'map') { this.overlayKind = 'map'; this.mapWin.open(st.id === 'WALL' ? 'services' : 'topology'); }
    else if (st.type === 'phone') { this.overlayKind = 'dialog'; S.phoneDialog(this); }
    else if (st.type === 'cctv') { this.overlayKind = 'dialog'; S.cctvDialog(this); }
    else if (st.type === 'rogue') { this.overlayKind = 'dialog'; S.rogueDialog(this); }
  }

  openMap() {
    if (this.mode === 'title' || this.overlayKind) return;
    document.exitPointerLock?.();
    this.world.controls.enabled = false;
    this.overlayKind = 'map';
    this.mapWin.open('topology');
    this.coach.noteOpen('map');
  }

  closeOverlay() {
    if (this.editorOpen) return;
    this.term.close();
    this.patchWin.close();
    this.mapWin.close();
    this.overlayKind = null;
    if (this.mode !== 'title') this.world.controls.enabled = true;
  }

  afterMenu() {
    this.overlayKind = null;
    if (this.mode === 'title') { if (!this.titleEl) this.showTitle(); return; }
    this.world.controls.enabled = true;
  }

  openGuide() { this.prepMenu(); S.guide(this); }
  openMenu() { if (this.mode === 'title') return; this.prepMenu(); S.pauseMenu(this); }
  openSkills() { this.prepMenu(); S.skills(this); }
  openSettings() { this.prepMenu(); S.settingsCard(this); }
  openAbout() { this.prepMenu(); S.about(this); }
  openMissionSelect() { this.hideTitle(); S.missionSelect(this); }

  // ---------------------------------------------------------------- apprenticeship (2D bench, no 3D play)
  lessonSaves() { return load(LESSON_KEY, {}); }

  lessonLabel(id) {
    const sv = this.lessonSaves()[id];
    const L = lessonById(id);
    if (!sv || !L) return null;
    if (sv.i >= L.steps.length) return 'completed · play again';
    return `continue: step ${sv.i + 1} of ${L.steps.length}`;
  }

  openLesson(id = LESSONS[0].id, { restart = false, startAt = null, transferFault = null } = {}) {
    const L = lessonById(id);
    if (!L) return;
    const saved = this.lessonSaves()[id];
    const resume = !restart && saved && saved.i < L.steps.length ? saved : null;
    this.hideTitle();
    this.mode = 'lesson';
    this.hud.show(false);
    this.world.controls.enabled = false;
    document.exitPointerLock?.();
    this.telemetry.log('lesson-open', { lesson: id, resume: !!resume });
    this.bench = new BenchScreen(this, L, { resume, startAt, transferFault });
  }

  saveLesson(id, st) {
    const all = this.lessonSaves();
    const { snapshot, ...rest } = st;
    all[id] = { ...rest, snapshot };
    if (!store(LESSON_KEY, all)) { delete all[id].snapshot; store(LESSON_KEY, all); }
    this.saveProgress();
  }

  recordLesson(id, summary) {
    this.progress.lessons ||= {};
    if (!this.progress.lessons[id]) this.telemetry.log('lesson-complete', { lesson: id, ...summary });
    this.progress.lessons[id] = { completedAt: Date.now(), ...summary };
    this.saveProgress();
  }

  leaveLesson() {
    this.bench = null;
    this.showTitle();
  }
  openChallengeSetup() { this.hideTitle(); S.challengeSetup(this); }

  prepMenu() {
    document.exitPointerLock?.();
    this.closeOverlay();
    this.overlayKind = 'menu';
    this.world.controls.enabled = false;
  }

  travelTo(id) {
    const st = STATIONS.find(s => s.id === id);
    if (!st) return;
    this.world.controls.flyTo(st.stand[0], st.stand[1], st.stand[2], -0.12);
  }

  toggleWarp() { this.warp = !this.warp; this.hud.setWarp(this.warp); }

  view() {
    const consoles = {};
    for (const [k, c] of Object.entries(this.consoles)) consoles[k] = c.lines.slice(-16).flatMap(l => (l.t === 'cmd' ? [`${l.prompt} ${l.text}`] : l.t === 'note' ? [] : String(l.text).split('\n'))).slice(-14);
    const m = this.missionInfo();
    return { consoles, kvm: this.kvm, mission: m ? { title: m.title, code: m.code, goals: this.lastEval?.goals || [], evidence: this.lastEval?.status === 'verify' ? this.lastEval.evidence : [] } : null };
  }

  // ---------------------------------------------------------------- input
  bindInput() {
    const dom = this.world.ctx.renderer.domElement;
    dom.addEventListener('click', () => {
      this.sound.ensure();
      if (this.mode !== 'title' && this.mode !== 'lesson' && !this.overlayKind && !this.touch && document.pointerLockElement !== dom) dom.requestPointerLock?.();
      else if (document.pointerLockElement === dom) this.interact();
    });
    addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (this.mode === 'lesson') return; // the bench screen handles its own keys
      this.sound.ensure();
      // modal cards (briefing, debrief, pause…) are plain .overlay elements without an overlayKind
      const modal = !!document.querySelector('#ui > .overlay');
      if (e.code === 'Escape') {
        if (this.overlayKind && this.overlayKind !== 'menu') { e.preventDefault(); this.closeOverlay(); return; }
        if (!this.overlayKind && !modal && this.mode !== 'title') { e.preventDefault(); this.openMenu(); }
        return;
      }
      if (this.mode === 'title' || this.overlayKind || modal) return;
      if (e.code === 'KeyE' || e.code === 'Enter') { e.preventDefault(); this.interact(); }
      else if (e.code === 'KeyM') { e.preventDefault(); this.openMap(); }
      else if (e.code === 'KeyH') { e.preventDefault(); this.openGuide(); }
      else if (e.code === 'KeyT') { e.preventDefault(); this.toggleWarp(); }
    });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === dom; });
    addEventListener('visibilitychange', () => { if (document.hidden) { this.save(); this.saveProgress(); } });
    addEventListener('pagehide', () => { this.save(); this.saveProgress(); });
  }

  touchControls() {
    const wrap = h('div', { id: 'touch' });
    const knob = h('div', { class: 'knob' });
    const stick = h('div', { class: 'stick' }, knob);
    const use = h('button', { class: 'use', onclick: () => this.interact() }, 'USE');
    const map = h('button', { class: 'mini', onclick: () => this.openMap() }, 'MAP');
    const menu = h('button', { class: 'mini', onclick: () => this.openMenu() }, 'MENU');
    wrap.append(stick, h('div', { class: 'tbtns' }, menu, map, use));
    document.getElementById('ui').append(wrap);
    this.touchEl = wrap;
    let sid = null;
    const move = e => {
      const r = stick.getBoundingClientRect();
      let x = e.clientX - (r.left + r.width / 2);
      let y = e.clientY - (r.top + r.height / 2);
      const m = Math.hypot(x, y);
      if (m > 46) { x = (x / m) * 46; y = (y / m) * 46; }
      this.world.controls.stick = { x: x / 46, y: y / 46 };
      knob.style.transform = `translate(${x}px,${y}px)`;
    };
    stick.addEventListener('pointerdown', e => { sid = e.pointerId; stick.setPointerCapture(e.pointerId); move(e); });
    stick.addEventListener('pointermove', e => { if (e.pointerId === sid) move(e); });
    const end = e => { if (e.pointerId !== sid) return; sid = null; this.world.controls.stick = { x: 0, y: 0 }; knob.style.transform = ''; };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    const dom = this.world.ctx.renderer.domElement;
    let lid = null;
    let lx = 0;
    let ly = 0;
    dom.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch' || this.overlayKind || this.mode === 'title') return; lid = e.pointerId; lx = e.clientX; ly = e.clientY; });
    dom.addEventListener('pointermove', e => { if (e.pointerId !== lid || !this.world.controls.enabled) return; this.world.controls.look((e.clientX - lx) * 1.6, (e.clientY - ly) * 1.6); lx = e.clientX; ly = e.clientY; });
    dom.addEventListener('pointerup', e => { if (e.pointerId === lid) lid = null; });
  }

  // ---------------------------------------------------------------- loop
  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const playing = this.mode !== 'title' && this.mode !== 'lesson';
    if (playing) {
      const simDt = dt * (this.warp ? 8 : 1);
      this.eng.advance(simDt);
      this.acc.sync += dt;
      this.acc.eval += dt;
      this.acc.save += dt;
      if (this.acc.eval >= 1) {
        this.acc.eval = 0;
        const t = this.campaign?.tick();
        if (t) {
          if (t.radio) { this.hud.say(t.radio); this.sound.alarm(); }
          if (t.status === 'won') this.onMissionWon(t);
          else this.evaluate('tick');
        } else this.evaluate('tick');
      }
      if (this.acc.sync >= 0.5) {
        this.acc.sync = 0;
        this.world.sync(this.eng, this.view());
        this.hud.setServices(this.eng);
        const w = wallClock(this.eng.s.t);
        const rep = this.campaign ? this.campaign.reputation : 0;
        this.hud.setClock(`${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}:${String(w.ss).padStart(2, '0')}`, rep);
        this.sound.setStress(this.world.alarmTarget || 0);
        if (this.overlayKind === 'patch') this.patchWin.render();
      }
      if (this.acc.save >= 5 && this.dirty) { this.acc.save = 0; this.dirty = false; this.save(); this.saveProgress(); }
      this.hud.setLookHint(!this.touch && !this.locked && !this.overlayKind && this.world.controls.enabled && !document.querySelector('.overlay'));
      this.coach.track(this.world.controls);
      if (!this.overlayKind && this.world.controls.enabled) {
        this.pick = this.world.pick();
        if (this.pick?.cable) this.hud.setPrompt(this.describeCable(this.pick.cable), null);
        else {
          const st = this.pick && STATIONS.find(s => s.id === this.pick.station);
          const ok = st && (!st.dev || this.eng.s.devices[st.dev]?.powered !== false);
          this.hud.setPrompt(ok ? st : null, ok ? this.world.screenRect(this.pick.object) : null);
        }
      } else this.hud.setPrompt(null);
      const step = this.coach.active && !this.overlayKind && !document.querySelector('#ui > .overlay') ? this.coach.current() : null;
      const target = step?.where && this.pick?.station !== step.where ? this.world.projectStation(step.where) : null;
      this.hud.setWaypoint(target ? { ...target, label: STATIONS.find(s => s.id === step.where)?.label || step.where } : null);
    } else {
      // attract mode: slow orbit through the room
      const t = now / 1000;
      const c = this.world.controls;
      c.pos.set(Math.sin(t * 0.05) * 6.2, 0, 2.2 + Math.cos(t * 0.05) * 4.8);
      c.yaw = Math.atan2(c.pos.x - 0, c.pos.z - (-2.5));
      c.pitch = -0.06;
      if (Math.floor(t * 2) !== this.attractTick) { this.attractTick = Math.floor(t * 2); this.eng.advance(0.5); this.world.sync(this.eng, {}); }
    }
    this.world.frame(dt);
    requestAnimationFrame(t2 => this.loop(t2));
  }

  // ---------------------------------------------------------------- test API (used by browser tests)
  testApi() {
    const app = this;
    return {
      app,
      get eng() { return app.eng; },
      mode: () => app.mode,
      cam: (x, z, yaw, pitch = -0.05) => app.world.controls.teleport(x, z, yaw, pitch),
      travel: id => { const st = STATIONS.find(s => s.id === id); app.world.controls.teleport(st.stand[0], st.stand[1], st.stand[2], -0.12); },
      run: (dev, line) => { const c = (app.consoles[dev] ||= { lines: [], hist: [] }); c.sess ||= createSession(app.eng, dev); return app.runCommand(dev, c.sess, line).lines.map(l => (typeof l === 'string' ? l : `[note] ${l.text}`)); },
      open: id => app.openStation(STATIONS.find(s => s.id === id)),
      status: () => ({ mode: app.mode, mission: app.campaign?.mission?.id, phase: app.campaign?.st.phase, eval: app.lastEval?.status, results: app.campaign?.st.results.length }),
      places: PLACES,
      lesson: () => app.bench?.run || null,
      bench: () => app.bench || null,
    };
  }
}
