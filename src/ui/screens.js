// Menus and cards: title, briefing, debrief, skills, mission select, Night Shift setup, guide, settings, about,
// and in-world dialogs (phone, CCTV, rogue device).
import { h, clear, overlay, fmtDuration } from './dom.js';
import { MISSIONS, ACTS } from '../content/missions.js';
import { OBJECTIVES, DOMAINS } from '../content/objectives.js';
import { level, recommend, TRANSFER_LABS } from '../game/progress.js';

const objTitle = id => OBJECTIVES.find(o => o.id === id)?.title || '';

export function titleScreen(app) {
  const hasSave = app.hasSave();
  const el = h('div', { id: 'title' },
    h('div', { class: 'title-card' },
      h('div', { class: 'eyebrow' }, 'NETWORK OPERATIONS SIMULATOR · v0.3'),
      h('div', { class: 'logo' }, 'SIGNAL', h('em', {}, '//'), 'ZERO'),
      h('div', { class: 'tagline' }, 'Night shift · District 04'),
      h('p', { class: 'lede' }, 'Half the district is dark and you are the only engineer on site. Walk the operations centre, open real-style device consoles, find the fault from evidence, fix it, and prove it works. The city outside the window lights up only when the services actually do.'),
      h('div', { class: 'menu' },
        hasSave ? h('button', { class: 'btn primary', onclick: () => app.continueCampaign() }, 'Continue night shift', h('small', {}, app.saveLabel())) : null,
        h('button', { class: `btn ${hasSave ? '' : 'primary'}`, onclick: () => app.newCampaign() }, hasSave ? 'New campaign' : 'Begin night shift', h('small', {}, '10 incidents')),
        h('button', { class: 'btn', onclick: () => app.openMissionSelect() }, 'Incident replay', h('small', {}, 'any solved incident')),
        h('button', { class: 'btn', onclick: () => app.openChallengeSetup() }, 'Night Shift challenge', h('small', {}, 'randomised · unguided')),
        h('button', { class: 'btn', onclick: () => app.openSkills() }, 'Skill evidence', h('small', {}, 'N10-009 map')),
        h('div', { style: { display: 'flex', gap: '10px' } },
          h('button', { class: 'btn ghost', style: { flex: 1 }, onclick: () => app.openSettings() }, 'Settings'),
          h('button', { class: 'btn ghost', style: { flex: 1 }, onclick: () => app.openAbout() }, 'About the simulation')))),
    h('div', { class: 'title-foot' }, 'Unofficial training game. Not affiliated with or endorsed by CompTIA or Cisco. Network+ is a trademark of CompTIA. Device shells imitate real output formats but are a bounded simulation. ', h('a', { href: '#', onclick: e => { e.preventDefault(); app.openAbout(); } }, 'What is and is not simulated →')));
  document.getElementById('ui').append(el);
  return el;
}

export function briefing(app, m, onGo) {
  const card = h('div', { class: 'card glass', role: 'dialog' },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, `${ACTS[m.act].title} · INCIDENT ${m.id.slice(1)} · ${m.code}`), h('h2', {}, m.title)),
    h('div', { class: 'bd' },
      h('p', { class: 'brief' }, m.brief),
      h('h4', {}, 'Your task'), h('p', {}, m.task),
      h('h4', {}, 'How you win'), h('ul', { class: 'clean' }, m.goals.map(g => h('li', {}, g.label)), (m.constraints || []).map(c => h('li', { class: 'muted' }, `Without breaking: ${c.label}`))),
      app.coach.steps && app.settings.coach !== false ? h('div', { class: 'hintbox coachbrief' }, h('b', {}, 'COACH IS ON. '), `This incident is broken into ${app.coach.steps.length} small steps. The NEXT STEP card (top left) says what to do and where; an orange marker points at the place; each step is explained when you finish it. You can turn the coach off in Settings.`) : null,
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'The simulator checks real behaviour (does traffic actually flow?), not a specific command. Any correct fix works. After the fix you must verify it from where users are.'),
      h('div', { class: 'tags' }, m.objectives.map(o => h('span', { class: 'tag', title: objTitle(o) }, h('b', {}, o), ' ', objTitle(o).split(' (')[0])))),
    h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => { ov.remove(); onGo(); } }, 'Start incident →')));
  const ov = overlay(card, { dismissable: false });
  return ov;
}

export function debrief(app, m, res, { onNext, onReplay, last }) {
  const r = res.result;
  const d = m.debrief;
  const outcome = r.outcome;
  const card = h('div', { class: 'card glass', role: 'dialog', style: { width: 'min(860px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'stamp' }, 'RESOLVED', h('small', {}, `INC ${m.id.slice(1)} · ${fmtDuration(r.simSeconds)}`)), h('div', { class: 'eyebrow', style: { color: 'var(--green)' } }, `INCIDENT ${m.id.slice(1)} RESOLVED · ${m.code}`), h('h2', {}, m.title)),
    h('div', { class: 'bd' },
      h('div', { class: 'metrics' },
        h('div', { class: 'metric' }, h('b', {}, fmtDuration(r.simSeconds)), h('small', {}, 'TIME TO RESTORE')),
        h('div', { class: 'metric' }, h('b', {}, r.commands), h('small', {}, 'COMMANDS')),
        h('div', { class: 'metric' }, h('b', {}, r.changes), h('small', {}, 'CONFIG CHANGES')),
        h('div', { class: 'metric' }, h('b', {}, r.hints), h('small', {}, 'HINTS USED'))),
      outcome ? h('div', { class: 'sideblock', style: { margin: '6px 0 4px' } },
        h('div', { class: 'eyebrow' }, 'YOUR INTERVENTION'), h('p', { style: { margin: '6px 0' } }, h('b', {}, outcome.method), outcome.outage !== undefined && outcome.outage !== null ? ` · aftershock outage: ${outcome.outage === 0 ? 'none' : fmtDuration(outcome.outage)}` : ''),
        outcome.compare ? h('table', { class: 'table compare' }, h('thead', {}, h('tr', {}, h('th', {}, 'Option'), h('th', {}, 'Outage when a riser fails'), h('th', {}, 'Redundancy'))), h('tbody', {}, outcome.compare.map(c => h('tr', { class: outcome.method.toLowerCase().includes(c.option.split(' ')[0].toLowerCase()) ? 'you' : '' }, h('td', {}, c.option), h('td', {}, c.outage), h('td', {}, c.redundancy))))) : null) : null,
      h('div', { class: 'cols' },
        h('div', {}, h('h4', {}, 'What failed'), h('p', {}, d.failure), h('h4', {}, 'The evidence'), h('p', {}, d.evidence)),
        h('div', {}, h('h4', {}, 'The fix'), h('p', {}, d.fix), h('h4', {}, 'Why it works'), h('p', {}, d.why))),
      h('h4', {}, 'Use it on real gear'), h('ul', { class: 'clean' }, d.real.map(x => h('li', {}, x))),
      h('h4', {}, 'Common mistakes'), h('ul', { class: 'clean' }, d.pitfalls.map(x => h('li', {}, x))),
      r.changeList?.length ? h('details', {}, h('summary', { class: 'muted', style: { cursor: 'pointer', marginTop: '10px' } }, `Your ${r.changeList.length} change(s)`), h('ul', { class: 'clean mono', style: { fontSize: '12px' } }, r.changeList.map(c => h('li', {}, c)))) : null,
      h('div', { class: 'tags' }, m.objectives.map(o => h('span', { class: 'tag' }, h('b', {}, o), ' guided ✓')))),
    h('div', { class: 'ft' },
      h('button', { class: 'btn ghost', onclick: () => { ov.remove(); onReplay(); } }, 'Replay incident'),
      h('button', { class: 'btn primary', onclick: () => { ov.remove(); onNext(); } }, last ? 'Finish the shift →' : 'Next incident →')));
  const ov = overlay(card, { dismissable: false });
  return ov;
}

export function shiftComplete(app, results) {
  const total = results.reduce((a, r) => a + r.reputation, 0);
  const card = h('div', { class: 'card glass', role: 'dialog' },
    h('div', { class: 'hd' }, h('div', { class: 'stamp' }, 'SHIFT END', h('small', {}, '06:00 · DISTRICT 04')), h('div', { class: 'eyebrow', style: { color: 'var(--green)' } }, 'SHIFT COMPLETE · 06:00'), h('h2', {}, 'District 04 is back online')),
    h('div', { class: 'bd' },
      h('p', {}, `Ten incidents resolved. Reputation ${total}. That is guided practice: the incidents were scripted and hints were available.`),
      h('p', {}, 'The next step is the one that matters for real skill: Night Shift challenges reshuffle the addressing plan, inject faults you have not seen in that combination, and remove the trainer notes. Come back tomorrow for the delayed-recall evidence.'),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Incident', 'Time', 'Hints', 'Changes'].map(x => h('th', {}, x)))), h('tbody', {}, results.map(r => h('tr', {}, h('td', {}, r.title), h('td', {}, fmtDuration(r.simSeconds)), h('td', {}, r.hints), h('td', {}, r.changes)))))),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.openSkills(); } }, 'Skill evidence'), h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.openChallengeSetup(); } }, 'Try a Night Shift challenge →')));
  const ov = overlay(card, { dismissable: false });
}

export function missionSelect(app) {
  const done = app.progress.missions;
  let ov;
  const card = h('div', { class: 'card glass', style: { width: 'min(980px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'INCIDENT REPLAY'), h('h2', {}, 'Replay a solved incident')),
    h('div', { class: 'bd' },
      h('p', { class: 'muted' }, 'Each replay starts from a clean copy of the network at that point in the night. Incidents unlock as you solve them in the campaign.'),
      ACTS.map(a => [h('h4', {}, a.title), h('div', { class: 'mgrid' }, MISSIONS.filter(m => m.act === a.id).map((m, i) => {
        const idx = MISSIONS.indexOf(m);
        const unlocked = idx === 0 || done[MISSIONS[idx - 1].id] || done[m.id] || app.settings.unlockAll;
        const best = done[m.id]?.best;
        return h('button', { class: `mtile ${unlocked ? '' : 'locked'} ${done[m.id] ? 'done' : ''}`, disabled: !unlocked, onclick: () => { ov.remove(); app.replayMission(idx); } },
          h('div', { class: 'c' }, `${m.id} · ${m.code}`), h('div', { class: 't' }, m.title), h('div', { class: 's' }, best ? `best ${fmtDuration(best.simSeconds)} · ${best.hints} hints` : unlocked ? 'not solved yet' : 'locked'));
        void i;
      }))])),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.showTitle(); } }, 'Back')));
  ov = overlay(card, { dismissable: false });
}

export function challengeSetup(app) {
  const rec = recommend(app.progress);
  let faults = 1;
  let ov;
  const focus = rec.filter(r => r.coverage === 'core').slice(0, 3).map(r => r.id);
  const diffBtns = h('div', { class: 'seg' });
  const renderSeg = () => {
    clear(diffBtns);
    for (const [n, label] of [[1, 'One fault'], [2, 'Two faults']]) diffBtns.append(h('button', { class: faults === n ? 'on' : '', onclick: () => { faults = n; renderSeg(); } }, label));
  };
  renderSeg();
  const card = h('div', { class: 'card glass' },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'NIGHT SHIFT CHALLENGE'), h('h2', {}, 'Unseen faults, new addressing')),
    h('div', { class: 'bd' },
      h('p', {}, 'A fully working district with a different addressing plan and VLAN numbers. Something breaks. You get a trouble ticket with user symptoms only. No trainer notes, no step hints, and the packet capture shows where traffic stopped but not why.'),
      h('p', { class: 'muted' }, 'Before handing it to you, the generator proves the challenge is solvable: it breaks a healthy copy and repairs it with a reference fix.'),
      h('div', { class: 'form', style: { marginTop: '14px' } }, h('label', {}, 'Difficulty'), diffBtns,
        h('label', {}, 'Focus (from your evidence gaps)'), h('div', { class: 'tags', style: { marginTop: 0 } }, focus.map(o => h('span', { class: 'tag', title: objTitle(o) }, h('b', {}, o), ' ', objTitle(o).split(' (')[0]))))),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.showTitle(); } }, 'Back'), h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.startChallenge({ faults, focus }); } }, 'Generate shift →')));
  ov = overlay(card, { dismissable: false });
}

export function ticket(app, ch, onGo) {
  const card = h('div', { class: 'card glass' },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow', style: { color: 'var(--amber)' } }, `TROUBLE TICKET · INC-${String(ch.seed).slice(-6)}`), h('h2', {}, 'Night Shift')),
    h('div', { class: 'bd' },
      h('h4', {}, 'Reported by users'), h('ul', { class: 'clean' }, ch.ticket.map(t => h('li', {}, t))),
      h('h4', {}, 'Recent change records'), h('ul', { class: 'clean mono', style: { fontSize: '12.5px' } }, ch.eng.s.changeLog.map(c => h('li', {}, c.desc))),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Addressing differs from the campaign: check the IPAM sheet on the network map. You win when every monitored service is healthy and you have verified it from a user device.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => { ov.remove(); onGo(); } }, 'Take the ticket →')));
  const ov = overlay(card, { dismissable: false });
}

export function challengeDone(app, res) {
  const r = res.result;
  const card = h('div', { class: 'card glass' },
    h('div', { class: 'hd' }, h('div', { class: 'stamp' }, 'CLOSED', h('small', {}, r.unguided ? 'NO HINTS' : `${r.hints} HINT${r.hints === 1 ? '' : 'S'}`)), h('div', { class: 'eyebrow', style: { color: 'var(--green)' } }, 'TICKET CLOSED'), h('h2', {}, r.unguided ? 'Solved unguided' : 'Solved with hints')),
    h('div', { class: 'bd' },
      h('div', { class: 'metrics' }, h('div', { class: 'metric' }, h('b', {}, fmtDuration(r.simSeconds)), h('small', {}, 'TIME')), h('div', { class: 'metric' }, h('b', {}, r.changes), h('small', {}, 'CHANGES')), h('div', { class: 'metric' }, h('b', {}, r.hints), h('small', {}, 'HINTS')), h('div', { class: 'metric' }, h('b', {}, r.collateral), h('small', {}, 'EXTRA BREAKAGE'))),
      h('h4', {}, 'What was broken'), h('ul', { class: 'clean' }, app.challenge.ch.faults.map(f => h('li', {}, f.title, h('span', { class: 'muted' }, ` · ${f.objectives.join(', ')}`)))),
      h('p', { class: 'muted' }, r.unguided ? 'Counts as unguided evidence for these objectives. Another unguided success at least 24 hours from your first one on an objective counts as delayed recall.' : 'Hints were used, so this does not count as unguided evidence.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.showTitle(); } }, 'Menu'), h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.openChallengeSetup(); } }, 'Another shift →')));
  const ov = overlay(card, { dismissable: false });
}

export function skills(app) {
  const p = app.progress;
  let ov;
  const rows = [];
  for (const dom of [1, 2, 3, 4, 5]) {
    rows.push(h('div', { class: 'hd', style: { gridColumn: '1 / -1', paddingTop: '14px', color: 'var(--cyan)' } }, `DOMAIN ${dom} · ${DOMAINS[dom].name.toUpperCase()} · ${DOMAINS[dom].weight}% of exam`));
    for (const o of OBJECTIVES.filter(x => x.domain === dom)) {
      const e = p.objectives[o.id];
      const lv = level(e);
      rows.push(h('div', { class: 'mono' }, o.id), h('div', { title: o.note || '' }, o.title, h('span', { class: `cov ${o.coverage}` }, o.coverage === 'none' ? 'NOT IN GAME' : o.coverage.toUpperCase())));
      for (let k = 1; k <= 4; k++) rows.push(h('div', {}, h('div', { class: `lv ${lv >= k ? 'on' : ''}` })));
    }
  }
  const labs = Object.entries(TRANSFER_LABS);
  const card = h('div', { class: 'card glass', style: { width: 'min(1000px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'SKILL EVIDENCE · CompTIA Network+ N10-009 (unofficial map)'), h('h2', {}, 'What you have shown, not what you have read')),
    h('div', { class: 'bd' },
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'GUIDED: solved a campaign incident. UNGUIDED: solved a randomised challenge with no hints. DELAYED: did it again unguided at least a day later. TRANSFER: you report doing it on real or emulated gear (self-reported; the game cannot verify it). Levels are evidence of practice in this simulator, not a prediction of an exam score.'),
      h('div', { class: 'ladder' }, h('div', { class: 'hd' }, 'ID'), h('div', { class: 'hd' }, 'OBJECTIVE'), h('div', { class: 'hd' }, 'GUIDED'), h('div', { class: 'hd' }, 'UNGUIDED'), h('div', { class: 'hd' }, 'DELAYED'), h('div', { class: 'hd' }, 'TRANSFER'), rows),
      h('h4', {}, 'Transfer labs (outside the game)'),
      h('div', { style: { display: 'grid', gap: '8px' } }, labs.map(([id, text]) => {
        const e = p.objectives[id];
        return h('div', { class: 'sideblock' }, h('b', {}, id), ' ', h('span', { class: 'muted' }, objTitle(id)), h('p', { style: { margin: '6px 0' } }, text),
          e?.transfer ? h('span', { class: 'pill ok' }, '✓ self-reported') : h('button', { class: 'btn small', onclick: () => { const note = prompt('Briefly, what did you do and on what gear?'); if (note) { app.reportTransfer(id, note); ov.remove(); skills(app); } } }, 'I did this outside the game'));
      }))),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.afterMenu(); } }, 'Close')));
  ov = overlay(card, { dismissable: false });
}

export function guide(app) {
  let ov;
  const card = h('div', { class: 'card glass', style: { width: 'min(860px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'FIELD GUIDE'), h('h2', {}, 'How engineers fix networks')),
    h('div', { class: 'bd' },
      h('h4', {}, 'The method'),
      h('ol', { class: 'clean' }, h('li', {}, h('b', {}, 'Reproduce'), ' the symptom from where the user is.'), h('li', {}, h('b', {}, 'Scope'), ': who is affected, who is not? What changed? (change log, logs)'), h('li', {}, h('b', {}, 'Isolate by layer'), ': link → address → path → name → service.'), h('li', {}, h('b', {}, 'Change one thing'), ' that your evidence points to.'), h('li', {}, h('b', {}, 'Verify'), ' the user-facing service, and check you broke nothing else.')),
      h('h4', {}, 'Controls'),
      h('p', {}, h('span', { class: 'kbd' }, 'WASD'), ' move · mouse look · ', h('span', { class: 'kbd' }, 'E'), ' use · ', h('span', { class: 'kbd' }, 'M'), ' map & quick travel · ', h('span', { class: 'kbd' }, 'T'), ' fast-forward time ×8 (waiting on timers) · ', h('span', { class: 'kbd' }, 'Esc'), ' close / menu. Touch: left stick, drag right side to look, USE button.'),
      h('h4', {}, 'Where things are and how to use them'),
      h('table', { class: 'table' }, h('tbody', {},
        [['Racks A–E (left wall)', 'A: EDGE-RTR, the router to the internet · B: ACCESS-SW, the switch every clinic device plugs into · C: the patch panel · D: CORE-SRV (DHCP + DNS) and the app servers on a KVM screen · E: storage. Aim at a device and press E for its console.'],
          ['Consoles', 'Type a command and press Enter. Quick-command chips fill the prompt. On Cisco devices start with enable; "?" lists what can come next; Tab completes. Esc closes the window.'],
          ['Patch panel (RACK C)', 'Each front port is permanently wired, behind the panel, to the device on its label. A patch cord joins two front ports: click one port, then another. Click a port with a cord to unplug it. The LED shows whether the two devices made a link. CONSOLE ports have the same socket but carry serial management, not Ethernet.'],
          ['Cables', 'Aim at any cable to see what it connects and whether it has a link. E on a patch-panel cable opens the panel.'],
          ['Dispatch desk (in front of the window)', 'DISPATCH-01, the user\'s Windows PC. Start most incidents here: see what the user sees.'],
          ['Network table / map (M)', 'Live topology (lines are cables: solid = up, red dashed = down), IPAM & docs (who should have which address), services, change log, and QUICK TRAVEL to any device.'],
          ['Lobby and Sector B', 'The guest kiosk and lobby wall jacks are in the lobby corner, to your right where the shift starts. Sector B (ward, staff laptop, cameras, phone) is through the corridor door, which unlocks once Sector B\'s switch has power.'],
          ['Editor (nano)', 'Opens from a Linux console ("nano FILE"). Ctrl+O saves, Ctrl+X exits; buttons at the bottom do the same.']].map(([q, a]) => h('tr', {}, h('td', {}, h('b', {}, q)), h('td', {}, a))))),
      h('h4', {}, 'Reading the room'),
      h('ul', { class: 'clean' },
        h('li', {}, 'Only live signal glows. Port LEDs: green = link up · flickering green = traffic · steady amber = spanning tree blocking · blinking amber = spanning tree still starting, or err-disabled · green/amber flicker = duplex mismatch or a loop · dark = no link.'),
        h('li', {}, 'Packets you send (ping, curl, tracert) fly along the real path. Red sparks mark where a packet was dropped. The PACKET CAPTURE tab of a console lists every hop and the reason.'),
        h('li', {}, 'City districts outside the window light up only when their services work.')),
      h('h4', {}, 'How an incident is won'),
      h('ul', { class: 'clean' },
        h('li', {}, 'The simulator checks behaviour (does the traffic actually flow?), never a specific command. Any correct fix works; breaking something else fails the "do not break" checks.'),
        h('li', {}, 'After the fix you must prove it from where users are, e.g. curl from the PC. The checklist shows VERIFY when that is the last thing missing.'),
        h('li', {}, 'Incidents 1–4 have a coach: the NEXT STEP card and an orange marker. Later incidents have hints only (each costs reputation). T fast-forwards time when something needs to wait (spanning tree, DHCP retries).')),
      h('h4', {}, 'Which tool answers which question'),
      h('table', { class: 'table' }, h('tbody', {},
        [['Is there a link? At what speed/duplex?', 'show interfaces status · show interfaces g0/x · patch panel LEDs · TDR'],
          ['Did the client get the right address?', 'ipconfig /all (Windows) · ip a (Linux)'],
          ['Can I reach it at all?', 'ping <IP> (ICMP only — not proof the app works)'],
          ['Where does the path stop?', 'tracert / traceroute · show ip route · packet capture tab'],
          ['Does the name point to the right host?', 'nslookup / dig (ask DNS directly) · ipconfig /displaydns (client cache)'],
          ['Does the application work?', 'curl -v https://… (DNS → TCP → TLS → HTTP)'],
          ['Is a service running, and why did it stop?', 'systemctl status · journalctl -u <unit>'],
          ['Which port is a MAC on? Is there a loop?', 'show mac address-table · show spanning-tree · show logging'],
          ['Is something filtering?', 'show access-lists (watch the match counters)']].map(([q, a]) => h('tr', {}, h('td', {}, q), h('td', { class: 'mono' }, a))))),
      h('h4', {}, 'Trainer notes'),
      h('p', {}, 'Purple TRAINER notes explain what an output means. Real devices never print them. They are on in the campaign and off in Night Shift challenges; you can turn them off in Settings.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.afterMenu(); } }, 'Back to work')));
  ov = overlay(card, { onClose: () => { ov.remove(); app.afterMenu(); } });
}

export function settingsCard(app) {
  let ov;
  const s = app.settings;
  const seg = (key, options, reload = false) => {
    const wrap = h('div', { class: 'seg' });
    const draw = () => { clear(wrap); for (const [v, label] of options) wrap.append(h('button', { class: s[key] === v ? 'on' : '', onclick: () => { s[key] = v; app.saveSettings(); draw(); if (reload) note.classList.remove('hidden'); } }, label)); };
    draw();
    return wrap;
  };
  const range = (key, min, max, step) => { const r = h('input', { type: 'range', min, max, step, value: s[key] }); r.addEventListener('input', () => { s[key] = Number(r.value); app.saveSettings(); }); return r; };
  const note = h('p', { class: 'hintbox hidden' }, 'Graphics quality changes apply after reloading the page.');
  const card = h('div', { class: 'card glass' },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'SETTINGS'), h('h2', {}, 'Settings')),
    h('div', { class: 'bd' },
      h('div', { class: 'form' },
        h('label', {}, 'Graphics quality'), seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], true),
        h('label', {}, 'Mouse sensitivity'), range('sensitivity', 0.3, 2.5, 0.05),
        h('label', {}, 'Invert look Y'), seg('invertY', [[false, 'Off'], [true, 'On']]),
        h('label', {}, 'Step-by-step coach (incidents 1–4)'), seg('coach', [[true, 'On'], [false, 'Off']]),
        h('label', {}, 'Trainer notes (campaign)'), seg('trainerNotes', [[true, 'On'], [false, 'Off']]),
        h('label', {}, 'Sound volume'), range('volume', 0, 1, 0.05),
        h('label', {}, 'Unlock all incidents'), seg('unlockAll', [[false, 'No'], [true, 'Yes']]),
        h('label', {}, 'Playtest log'), h('div', {}, h('button', { class: 'btn small', onclick: () => app.exportTelemetry() }, 'Export JSON'), h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '8px' } }, 'Local only. Nothing is uploaded.')),
        h('label', {}, 'Reset'), h('div', {}, h('button', { class: 'btn small danger', onclick: () => { if (confirm('Delete your saved shift, skill evidence and playtest log?')) app.resetAll(); } }, 'Delete all local data'))),
      note),
    h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.applySettings(); app.afterMenu(); } }, 'Done')));
  ov = overlay(card, { dismissable: false });
}

export function about(app) {
  let ov;
  const card = h('div', { class: 'card glass', style: { width: 'min(860px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'ABOUT THE SIMULATION'), h('h2', {}, 'What is real here, and what is not')),
    h('div', { class: 'bd' },
      h('h4', {}, 'Modelled'),
      h('ul', { class: 'clean' },
        h('li', {}, 'One deterministic network engine drives every console, the 3D world and every win condition.'),
        h('li', {}, 'Layer 1: links, speed/duplex auto-negotiation and parallel detection (duplex mismatch), cut cables, console vs Ethernet ports.'),
        h('li', {}, 'Layer 2: 802.1Q access/trunk ports, native VLAN, per-VLAN spanning tree (PVST+ timers, Rapid PVST+), loop/broadcast-storm detection, PortFast, BPDU guard, DHCP snooping, MAC tables derived from forwarding.'),
        h('li', {}, 'Layer 3: connected/static routes with recursive next-hop resolution, longest-prefix match, TTL, ICMP unreachables, Cisco extended/standard ACL semantics (first match, implicit deny), PAT.'),
        h('li', {}, 'Services: ISC DHCP (scopes, relay/giaddr, NAK, pool exhaustion, config parsing), BIND (zone parsing, reload, forwarding), Windows DNS client cache, HTTPS with certificate name checks, nginx up/down.')),
      h('h4', {}, 'Simplified or missing'),
      h('ul', { class: 'clean' },
        h('li', {}, 'Command shells are subsets. Output imitates Cisco IOS 15/IOS-XE, Windows 11 and Ubuntu 24.04 formats closely, but is not byte-identical.'),
        h('li', {}, 'No IPv6, dynamic routing, wireless RF, VPN, NTP, SNMP, cloud or real TCP state machines yet. ACL denies are silent drops. DHCP lease expiry and Windows negative DNS caching are not modelled.'),
        h('li', {}, 'Packet loss, latency and voice MOS are modelled per link and are illustrative, not measured.'),
        h('li', {}, 'This has not been validated with learners yet. Finishing it is not evidence that you are ready for the Network+ exam.')),
      h('p', { class: 'muted' }, 'See docs/SIMULATION_MODEL.md and docs/QA_AND_NEXT_ITERATION.md in the repository for details and the playtest protocol.'),
      h('h4', {}, 'Credits'),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Rendering: three.js (MIT). Type: Big Shoulders Display, IBM Plex Mono and IBM Plex Sans Condensed, all under the SIL Open Font License 1.1. Full notices: docs/THIRD_PARTY.md.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.afterMenu(); } }, 'Close')));
  ov = overlay(card, { onClose: () => { ov.remove(); app.afterMenu(); } });
}

export function pauseMenu(app) {
  let ov;
  const card = h('div', { class: 'card glass', style: { width: 'min(420px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'PAUSED'), h('h2', {}, app.modeLabel())),
    h('div', { class: 'bd' }, h('div', { class: 'menu', style: { maxWidth: 'none' } },
      h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.afterMenu(); } }, 'Resume'),
      app.mission() ? h('button', { class: 'btn', onclick: () => { ov.remove(); app.showBriefingAgain(); } }, 'Incident briefing') : null,
      h('button', { class: 'btn', onclick: () => { ov.remove(); guide(app); } }, 'Field guide'),
      h('button', { class: 'btn', onclick: () => { ov.remove(); skills(app); } }, 'Skill evidence'),
      h('button', { class: 'btn', onclick: () => { ov.remove(); settingsCard(app); } }, 'Settings'),
      h('button', { class: 'btn ghost', onclick: () => { ov.remove(); app.quitToTitle(); } }, 'Save & quit to title'))));
  ov = overlay(card, { onClose: () => { ov.remove(); app.afterMenu(); } });
  return ov;
}

export function phoneDialog(app) {
  let ov;
  const eng = app.eng;
  const v = eng.s.flowState.voice;
  const powered = eng.s.devices['VOIP-PHONE'].powered !== false;
  const out = h('div', { class: 'mono', style: { margin: '10px 0', minHeight: '60px', lineHeight: 1.7 } }, powered ? 'Handset off hook. Press "Test call" to call the regional dispatch centre.' : 'The phone has no power.');
  const card = h('div', { class: 'card glass', style: { width: 'min(520px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'WARD B DISPATCH LINE'), h('h2', {}, 'SIP desk phone')),
    h('div', { class: 'bd' }, out, h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Call quality is estimated with a simplified ITU-T E-model from the simulated path loss, jitter and delay. MOS 4.0+ is good; below 3.6 most people complain.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.afterMenu(); } }, 'Hang up'), h('button', { class: 'btn primary', disabled: !powered, onclick: () => {
      const r = app.testCall();
      clear(out).append(r.ok ? `Connected to sip.example.net\nMOS ${r.mos.toFixed(2)} · loss ${r.loss.toFixed(1)}% · jitter ${r.jitter.toFixed(0)} ms\n${r.mos >= 4 ? 'Clear audio.' : r.mos >= 3.6 ? 'Usable but noticeably degraded.' : 'Robotic, words dropping out.'}` : 'Call failed: no response from the SIP gateway.');
      out.style.whiteSpace = 'pre-line';
    } }, 'Test call')));
  ov = overlay(card, { onClose: () => { ov.remove(); app.afterMenu(); } });
  void v;
}

export function cctvDialog(app) {
  let ov;
  const eng = app.eng;
  const f = eng.s.flowState.cams;
  const cams = eng.s.devices.CAMERAS;
  app.eng.event({ type: 'view', what: 'cctv', live: f?.metric?.reach ?? 0 });
  app.evaluate('action');
  const card = h('div', { class: 'card glass', style: { width: 'min(520px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow' }, 'SECTOR B · CCTV'), h('h2', {}, `${cams.powered === false ? 0 : f?.metric?.reach ?? 0} / ${cams.count} feeds recording`)),
    h('div', { class: 'bd' }, h('p', {}, cams.powered === false ? 'The camera bank is not installed yet.' : `${cams.leases.length} cameras hold an IP address. ${f?.metric?.reach ?? 0} reach the recorder on TCP 554.`), h('p', { class: 'muted', style: { fontSize: '12px' } }, 'The wall shows NO SIGNAL for cameras that cannot stream.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn primary', onclick: () => { ov.remove(); app.afterMenu(); } }, 'OK')));
  ov = overlay(card, { onClose: () => { ov.remove(); app.afterMenu(); } });
}

export function rogueDialog(app) {
  let ov;
  const d = app.eng.s.devices['ROGUE-AP'];
  const mac = d?.ports.eth0.mac.match(/../g).join(':');
  const card = h('div', { class: 'card glass', style: { width: 'min(560px,96vw)' } },
    h('div', { class: 'hd' }, h('div', { class: 'eyebrow', style: { color: 'var(--amber)' } }, 'UNKNOWN DEVICE'), h('h2', {}, 'Pocket travel router')),
    h('div', { class: 'bd' }, h('p', {}, 'A small white travel router is plugged into a lobby wall jack. The sticker on the bottom reads:'), h('p', { class: 'mono' }, `MAC ${mac}\nDefault LAN 192.168.8.1 · DHCP on`), h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Unplugging it removes the immediate problem. It does not stop the next one.')),
    h('div', { class: 'ft' }, h('button', { class: 'btn', onclick: () => { ov.remove(); app.afterMenu(); } }, 'Leave it'), h('button', { class: 'btn danger', onclick: () => { ov.remove(); app.unplugRogue(); app.afterMenu(); } }, 'Unplug it')));
  ov = overlay(card, { onClose: () => { ov.remove(); app.afterMenu(); } });
}
