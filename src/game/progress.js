// Skill evidence model. Per N10-009 objective, evidence climbs a ladder:
//   1 GUIDED     completed a campaign incident tagged with the objective (hints allowed)
//   2 UNGUIDED   solved a randomised Night Shift challenge involving it, with no hints
//   3 DELAYED    another unguided success at least 24 h after the first success on it
//   4 TRANSFER   self-reported: did the equivalent task outside the game (cannot be verified here)
// A level is evidence of practice in this simulator, not proof of exam readiness.
import { OBJECTIVES } from '../content/objectives.js';

export const PROGRESS_KEY = 'signalzero.progress.v1';
const DAY = 24 * 3600 * 1000;
const REVIEW_AFTER = [0, 1 * DAY, 3 * DAY, 7 * DAY, 21 * DAY];

export function emptyProgress() {
  return { v: 1, created: Date.now(), objectives: {}, missions: {}, challenges: [] };
}

function entry(p, id) {
  return (p.objectives[id] ||= { guided: [], unguided: [], transfer: null });
}

export function recordMission(p, mission, result, now = Date.now()) {
  const m = (p.missions[mission.id] ||= { completions: 0, best: null });
  m.completions++;
  if (!m.best || result.simSeconds < m.best.simSeconds) m.best = { simSeconds: result.simSeconds, hints: result.hints };
  for (const o of mission.objectives) entry(p, o).guided.push({ t: now, src: mission.id, hints: result.hints });
}

export function recordChallenge(p, result, now = Date.now()) {
  p.challenges.push({ ...result, t: now });
  for (const o of result.objectives) entry(p, o).unguided.push({ t: now, seed: result.seed, hints: result.hints, unguided: result.unguided });
}

export function recordTransfer(p, objectiveId, note, now = Date.now()) {
  entry(p, objectiveId).transfer = { t: now, note: String(note || '').slice(0, 400), selfReported: true };
}

export function level(e) {
  if (!e) return 0;
  const all = [...e.guided, ...e.unguided];
  if (!all.length) return 0;
  let lvl = e.guided.length ? 1 : 0;
  const clean = e.unguided.filter(x => x.unguided);
  if (clean.length) lvl = 2;
  const first = Math.min(...all.map(x => x.t));
  if (clean.some(x => x.t - first >= DAY)) lvl = 3;
  if (lvl >= 3 && e.transfer) lvl = 4;
  return lvl;
}

export function lastSuccess(e) {
  if (!e) return null;
  const xs = [...e.guided, ...e.unguided].map(x => x.t);
  return xs.length ? Math.max(...xs) : null;
}

/** Objectives ordered by need: lowest evidence first, then most overdue for review. */
export function recommend(p, now = Date.now()) {
  return OBJECTIVES.filter(o => o.coverage !== 'none').map(o => {
    const e = p.objectives[o.id];
    const lvl = level(e);
    const last = lastSuccess(e);
    const due = last === null ? true : now - last >= REVIEW_AFTER[Math.min(lvl, 4)];
    return { id: o.id, title: o.title, level: lvl, due, last, coverage: o.coverage };
  }).sort((a, b) => (a.level - b.level) || (Number(b.due) - Number(a.due)) || ((a.last ?? 0) - (b.last ?? 0)));
}

export const TRANSFER_LABS = {
  '1.4': 'With Wireshark on a real PC, capture a DNS lookup and an HTTPS connection. Identify UDP 53 and the TCP three-way handshake to 443.',
  '1.5': 'With a cable tester, test a known-good and a deliberately mis-terminated patch cord. On a Catalyst switch, run a TDR test on a port with nothing plugged in.',
  '1.7': 'On paper, split 192.168.50.0/24 into subnets for 100, 50 and 20 hosts without overlap. Configure one on a real or emulated router and verify with show ip interface brief.',
  '2.1': 'In Packet Tracer or GNS3, build two routers with a static default route; break the next hop and observe show ip route; add PAT and check show ip nat translations.',
  '2.2': 'In Packet Tracer or GNS3, connect two switches with two links, disable spanning tree, watch the storm, then re-enable Rapid PVST+ and read show spanning-tree.',
  '3.4': 'In a Linux VM, install isc-dhcp-server and bind9, serve one subnet and one zone, break the config on purpose and diagnose it from journalctl and named-checkzone.',
  '4.3': 'On a lab router, write an extended ACL that blocks a guest subnet from private ranges but permits DNS and internet; prove both outcomes and read the match counters.',
  '5.1': 'Write up a real outage you handled using: symptom, scope, hypothesis, test, change, verification, documentation.',
  '5.2': 'On two lab switches, hard-set speed/duplex on one end only. Generate traffic and watch late collisions and CRC errors grow; then fix both ends.',
  '5.3': 'On a home or lab network, separately prove name resolution, IP reachability, path and the application (nslookup, ping by IP, tracert, curl -v).',
  '5.4': 'Run pathping (Windows) or mtr (Linux) to a remote host; explain where latency and loss first appear.',
  '5.5': 'Use ipconfig /all, nslookup, tracert, arp -a and route print on your own PC and explain every line of output.',
};
