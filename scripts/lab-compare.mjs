// Differential check: replay every command of the real-kernel reference lab (docs/apprenticeship/lab/out/*.txt,
// produced by bench-lab.sh) on the simulator's bench, in the same order and with the same state changes, and
// compare outputs line by line and frame captures frame by frame.
//
// Normalisation removes only what differs because the lab runs on veth pairs in namespaces or because time is
// real there: interface index and @ifN peer suffix, "link-netns", the qdisc name, timings, and ICMP ids.
// Usage: node scripts/lab-compare.mjs            (prints a report)
//        import { compareLab } from it            (used by tests/unit/lab-conformance.test.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBench } from '../src/content/bench.js';
import { createSession, execute } from '../src/cli/index.js';
import { framesFor } from '../src/engine/frames.js';
import { neighbors, flushNeigh } from '../src/engine/neighbor.js';
import { fmtIp, parseIp } from '../src/engine/ipv4.js';
import { macLinux } from '../src/engine/model.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LAB_OUT = path.join(ROOT, 'docs/apprenticeship/lab/out');
const DEV = { pca: 'PC-A', pcb: 'PC-B', srv: 'SRV', r1: 'R1' };

/** Differences that are deliberate, with the reason. Anything else that differs is a defect. */
export const KNOWN_DIFFERENCES = {
  'ip route del': 'iproute2 prints its full 60-line usage text; the simulator prints the first line and a SIMULATOR note saying what to type (the usage text is not reproduced).',
};

/** Parse a transcript into [{ ns, cmd, out: [lines], exit }]. */
export function parseTranscript(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^(pca|pcb|srv|r1)\$ (.*)$/.exec(line);
    if (m) { cur = { ns: m[1], cmd: m[2], out: [], exit: null }; blocks.push(cur); continue; }
    const e = /^\[exit (\d+)\]$/.exec(line);
    if (e && cur) { cur.exit = Number(e[1]); cur = null; continue; }
    if (cur) cur.out.push(line);
  }
  return blocks;
}

export function normalise(lines) {
  return lines
    .map(l => l
      .replace(/^\d+: (\w+)(@if\d+)?:/, 'N: $1:')
      .replace(/ link-netns \w+/, '')
      .replace(/qdisc \w+/, 'qdisc Q')
      .replace(/time=[\d.]+ ms/, 'time=T ms')
      .replace(/, time \d+ms/, ', time Tms')
      .replace(/^rtt min\/avg\/max\/mdev = .*$/, 'rtt min/avg/max/mdev = T')
      .replace(/id \d+, seq/, 'id N, seq')
      .trimEnd())
    // a real terminal shows "^C" where the lab's captured stdout has the blank line ping prints after SIGINT
    .map(l => (l === '^C' ? '' : l));
}

/** iproute2-style neighbour lines for a device (used for the lab's `ip neigh` on R1, which has no shell here). */
function neighLines(eng, id) {
  const d = eng.s.devices[id];
  return neighbors(eng, d).map(n => `${fmtIp(n.ip)} dev ${n.iface}${n.mac ? ` lladdr ${macLinux(n.mac)}` : ''} ${n.state} `);
}

/** Lab steps that change state outside the transcripts (see bench-lab.sh), in lab order. */
function plan() {
  const flushall = s => { for (const d of Object.values(s.eng.s.devices)) flushNeigh(d); };
  return [
    { file: '01-same-subnet' }, { file: '01b-cached' }, { file: '01d-nobody' }, { act: s => s.eng.advance(50) }, { file: '01c-stale' },
    { act: flushall }, { file: '02-no-gateway' }, { file: '03-gateway' }, { file: '03b-route-errors' },
    { act: flushall }, { file: '04-wrong-gateway' }, { file: '04a-fix-replace' }, { file: '04b-fix-del-add' }, { file: '04c-fix-specific' },
    { act: flushall }, { file: '05-no-return' },
    { act: flushall }, { file: '06-wrong-mask' },
    { act: s => { s.eng.s.devices.R1.ports.eth0.proxyArp = true; s.eng.mutated('lab: proxy_arp=1 on r1 eth0', 'lab'); flushall(s); } }, { file: '06b-proxy-arp' },
    { act: s => { s.eng.s.devices.R1.ports.eth0.proxyArp = false; const c = s.eng.s.devices['PC-A'].ipcfg.static; c.len = 24; c.gw = parseIp('192.168.10.1'); c.removed = false; s.eng.mutated('lab: restore PC-A /24', 'lab'); } },
    { file: '07-neigh' }, { act: flushall }, { file: '08-edges' },
    { act: s => { s.eng = buildBench('P', { gw: { 'PC-A': null, 'PC-B': null } }); s.sess = {}; } },
    { file: '10-practice' }, { file: '11-gateway-is-host' }, { file: '12-no-return-b' },
  ];
}

// Lab frame captures: which transcript command they cover and where tcpdump listened.
const CAPTURES = [
  { file: '01-same-subnet', cmd: 'ping -c 3 192.168.10.12', at: 'pca' },
  { file: '01b-cached', cmd: 'ping -c 1 192.168.10.12', at: 'pca' },
  { file: '01d-nobody', cmd: 'ping -c 2 192.168.10.99', at: 'pca' },
  { file: '02-no-gateway', cmd: 'ping -c 2 192.168.20.10', at: 'pca' },
  { file: '03-gateway-pca', transcript: '03-gateway', cmd: 'ping -c 3 192.168.20.10', at: 'pca' },
  { file: '03-gateway-srv', transcript: '03-gateway', cmd: 'ping -c 3 192.168.20.10', at: 'srv' },
  { file: '04-wrong-gateway', cmd: 'ping -c 3 192.168.20.10', at: 'pca' },
  { file: '05-no-return-srv', transcript: '05-no-return', cmd: 'ping -c 3 192.168.20.10', at: 'srv' },
  { file: '06-wrong-mask', cmd: 'ping -c 3 192.168.20.10', at: 'pca' },
  { file: '11-gateway-is-host', cmd: 'ping -c 2 10.20.31.25', at: 'pca' },
];

/** Real time passing in the lab while a command runs (ping sends one echo per second; failed ARP waits ~3 s). */
function labSeconds(cmd, out) {
  const m = /^ping .*-c (\d+)/.exec(cmd);
  if (!m) return 0;
  return Number(m[1]) - 1 + (out.some(l => /Destination Host Unreachable/.test(l)) ? 3 : 0);
}

export function compareLab() {
  const s = { eng: buildBench('A'), sess: {} };
  const results = [];
  const frames = {};
  for (const step of plan()) {
    if (step.act) { step.act(s); continue; }
    const file = path.join(LAB_OUT, `${step.file}.txt`);
    if (!fs.existsSync(file)) { results.push({ file: step.file, cmd: '(transcript missing)', status: 'missing' }); continue; }
    for (const b of parseTranscript(fs.readFileSync(file, 'utf8'))) {
      const dev = DEV[b.ns];
      const lab = normalise(b.out);
      let sim;
      let status;
      if (b.ns === 'r1' && /^ip neigh$/.test(b.cmd)) {
        sim = normalise(neighLines(s.eng, 'R1'));
        status = 'compared (entry order ignored)';
      } else if (/^sysctl /.test(b.cmd)) {
        results.push({ file: step.file, ns: b.ns, cmd: b.cmd, status: 'lab check only', lab, sim: null });
        continue;
      } else if (/^ip addr (add|del) /.test(b.cmd)) {
        // not simulated as a command: mirror the state change so the next commands start from the same state
        const c = s.eng.s.devices[dev].ipcfg.static;
        const m = /^ip addr (add|del) ([\d.]+)\/(\d+)/.exec(b.cmd);
        if (m[1] === 'del') { c.removed = true; c.gw = null; c.routes = []; } else { c.removed = false; c.addr = parseIp(m[2]); c.len = Number(m[3]); }
        s.eng.mutated(`lab mirror: ${b.cmd}`, 'lab');
        results.push({ file: step.file, ns: b.ns, cmd: b.cmd, status: 'state mirrored (ip addr add/del is not simulated)', lab, sim: null });
        continue;
      } else {
        // the lab's interrupted ping is shown as "ping HOST   (interrupted …)"
        const cmd = b.cmd.replace(/\s+\(interrupted.*$/, '').trim();
        s.sess[dev] ||= createSession(s.eng, dev);
        const before = s.eng.trafficSeq;
        const r = execute(s.eng, s.sess[dev], cmd);
        sim = normalise((r.lines || []).filter(l => typeof l === 'string'));
        const probes = s.eng.traffic.filter(x => x.seq > before);
        // the capture covers the first run of a command in its transcript
        if (probes.length) frames[`${step.file}|${cmd}`] ||= framesFor(s.eng, probes);
        // the kernel lists neighbour entries in hash-table order; compare them as a set
        status = /^ip (-4 )?n(e(i(gh?)?)?)?\b/.test(cmd) && !/flush/.test(cmd) ? 'compared (entry order ignored)' : 'compared';
        s.eng.advance(labSeconds(cmd, b.out));
      }
      const same = status.includes('order ignored') ? JSON.stringify([...lab].sort()) === JSON.stringify([...sim].sort()) : JSON.stringify(lab) === JSON.stringify(sim);
      results.push({ file: step.file, ns: b.ns, cmd: b.cmd, status, match: same, known: same ? null : KNOWN_DIFFERENCES[b.cmd] || null, lab, sim });
    }
  }
  // frames: compare what tcpdump saw at the capture point with the simulator's frames on that link
  const frameResults = [];
  const linkOf = { pca: 'pca', srv: 'srv' };
  for (const c of CAPTURES) {
    const f = path.join(LAB_OUT, `${c.file}.frames.txt`);
    if (!fs.existsSync(f)) continue;
    const lab = normalise(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
    const simAll = frames[`${c.transcript || c.file}|${c.cmd}`] || [];
    const seen = simAll.filter(x => x.line && x.links.includes(linkOf[c.at]));
    const sim = normalise(seen.filter(x => !x.delayed).map(x => x.line));
    const simLater = normalise(seen.filter(x => x.delayed).map(x => x.line));
    // Unicast ARP confirmations (and their replies) happen ~5 s after an entry is used: whether one falls inside a
    // capture window depends on real timing, so they are reported separately rather than compared.
    const broadcastFor = new Set(lab.map(l => /> ff:ff:ff:ff:ff:ff, ethertype ARP .*who-has ([\d.]+)/.exec(l)?.[1]).filter(Boolean));
    const isConfirm = l => (/ethertype ARP/.test(l) && /Request who-has/.test(l) && !/> ff:ff:ff:ff:ff:ff/.test(l)) || (/Reply ([\d.]+) is-at/.test(l) && !broadcastFor.has(/Reply ([\d.]+) is-at/.exec(l)[1]));
    const labCore = lab.filter(l => !isConfirm(l));
    const unicastConfirms = lab.filter(isConfirm);
    frameResults.push({ file: c.file, at: c.at, cmd: c.cmd, match: JSON.stringify(labCore) === JSON.stringify(sim), lab: labCore, sim, labTimingOnly: unicastConfirms, simLater });
  }
  return { results, frameResults };
}

function report() {
  const { results, frameResults } = compareLab();
  const L = ['# Lab vs simulator: command outputs', '', '| Lab file | Host | Command | Result |', '|---|---|---|---|'];
  for (const r of results) L.push(`| ${r.file} | ${r.ns ?? ''} | \`${r.cmd}\` | ${r.match === undefined ? r.status : r.match ? `match (${r.status})` : r.known ? `differs, known: ${r.known}` : '**DIFFERENT**'} |`);
  const diffs = results.filter(r => r.match === false);
  L.push('', `${results.filter(r => r.match).length} of ${results.filter(r => r.match !== undefined).length} compared commands match; ${diffs.length} differ (${diffs.filter(d => d.known).length} known and listed above).`);
  for (const d of diffs) L.push('', `### ${d.file}: ${d.ns}$ ${d.cmd}`, '```diff', ...d.lab.map(l => `- ${l}`), ...d.sim.map(l => `+ ${l}`), '```');
  L.push('', '# Lab vs simulator: frames', '', '| Capture | Listening on | Result | Timing-dependent frames |', '|---|---|---|---|');
  for (const f of frameResults) L.push(`| ${f.file} | ${f.at} | ${f.match ? `match (${f.lab.length} frames)` : '**DIFFERENT**'} | lab: ${f.labTimingOnly.length} unicast ARP confirmations; simulator: ${f.simLater.length} marked "about 5 s later" |`);
  for (const f of frameResults.filter(x => !x.match)) L.push('', `### ${f.file}`, '```diff', ...f.lab.map(l => `- ${l}`), ...f.sim.map(l => `+ ${l}`), '```');
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) console.log(report());
