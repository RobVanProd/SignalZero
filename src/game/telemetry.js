// Local-only playtest telemetry. Nothing is sent anywhere; the player can export a JSON file.
// The metrics mirror the pre-registered playtest in docs/QA_AND_NEXT_ITERATION.md:
//   first useful action, help/hint use and hypothesis-driven changes, voluntary repeat, frustration points.
export const TELEMETRY_KEY = 'signalzero.telemetry.v1';

const READ_ONLY = /^(sh|sho|show|do\s+sh|ping|tracert|traceroute|pathping|nslookup|dig|curl|ipconfig(\s+\/all)?\s*$|ipconfig\s+\/displaydns|arp|route\s+print|netstat|cat|less|ls|journalctl|systemctl\s+(status|is-active)|ss|ip\s+(a|addr|r|route|link)|dhcpd\s+-t|named-checkzone|dhcp-lease-list|test\s+cable|hostname|getmac|help|\?)/i;

export function classify(line) {
  const l = line.trim();
  if (!l) return 'empty';
  if (/^(help|\?)$/i.test(l) || l.endsWith('?')) return 'help';
  return READ_ONLY.test(l) ? 'diagnostic' : 'change';
}

export class Telemetry {
  constructor(saved) {
    this.data = saved && saved.v === 1 ? saved : { v: 1, sessions: [] };
    this.session = { id: Math.random().toString(36).slice(2, 10), start: Date.now(), ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'node', events: [] };
    this.data.sessions.push(this.session);
    if (this.data.sessions.length > 30) this.data.sessions.splice(0, this.data.sessions.length - 30);
  }

  log(type, data = {}) {
    this.session.events.push({ dt: Date.now() - this.session.start, type, ...data });
    if (this.session.events.length > 4000) this.session.events.splice(0, 500);
  }

  command(host, line, unknown) { this.log('command', { host, kind: classify(line), unknown: !!unknown, len: line.length }); }

  summary(session = this.session) {
    const ev = session.events;
    const firstDiag = ev.find(e => e.type === 'command' && e.kind === 'diagnostic');
    const cmds = ev.filter(e => e.type === 'command');
    const wins = ev.filter(e => e.type === 'mission-win');
    const replays = ev.filter(e => e.type === 'replay' || (e.type === 'challenge-start' && wins.length > 0));
    return {
      session: session.id,
      minutes: Math.round((Date.now() - session.start) / 600) / 100,
      firstUsefulActionSec: firstDiag ? Math.round(firstDiag.dt / 1000) : null,
      commands: cmds.length,
      diagnostic: cmds.filter(c => c.kind === 'diagnostic').length,
      changes: cmds.filter(c => c.kind === 'change').length,
      unknownCommands: cmds.filter(c => c.unknown).length,
      helpUses: cmds.filter(c => c.kind === 'help').length,
      hints: ev.filter(e => e.type === 'hint').length,
      missionsWon: wins.map(w => ({ id: w.id, sec: w.sec, hints: w.hints })),
      voluntaryReplays: replays.length,
      stuckPeriods: stuckPeriods(ev),
    };
  }

  export() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), note: 'SIGNAL//ZERO local playtest log. Contains your browser user-agent and the answers you typed in apprenticeship lessons; nothing else personal.', summaries: this.data.sessions.map(s => this.summary(s)), raw: this.data }, null, 2);
  }
}

/** Periods of 3+ minutes without a successful mission step or a diagnostic command. */
function stuckPeriods(ev) {
  const marks = ev.filter(e => (e.type === 'command' && e.kind === 'diagnostic') || e.type === 'mission-win' || e.type === 'goal').map(e => e.dt);
  let n = 0;
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > 180000) n++;
  return n;
}
