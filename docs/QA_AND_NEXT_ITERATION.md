# SIGNAL//ZERO v0.3 — QA status and next decision gate

Date: 15 October 2026. The v0.2 QA document is preserved in [`prototype/v0.2/QA_AND_NEXT_ITERATION.md`](../prototype/v0.2/QA_AND_NEXT_ITERATION.md).

## What changed since v0.2 (and which v0.2 limitations it addresses)

| v0.2 limitation | v0.3 status |
|---|---|
| Boolean "deterministic limited model", not packets | Replaced by a topology engine that walks each packet hop by hop (ARP, VLAN tags, STP state, ACLs, TTL, PAT, replies traced independently). Still not a packet-level emulator: no TCP state, no queueing. |
| Fictional device shell (`switch port 6 vlan 30`) | Cisco IOS-style CLI (modes, unique-prefix abbreviations, `?`, Tab, caret errors, running-config), Windows cmd, Ubuntu shell with systemd/journald, dhcpd/BIND/netplan tooling and a nano editor. |
| `audit guest` synthetic probe | Removed. Isolation is proven by testing from the guest kiosk itself. |
| Three.js from a CDN; WebGL unverified | Three.js 0.186.1 bundled into one offline HTML file. Rendering exercised with a real WebGL 2 implementation (SwiftShader) in headless Chromium; screenshots reviewed. |
| One scripted repair per stage | Behavioural win checks; alternative fixes accepted; constraints catch collateral damage; aftershocks measure trade-offs (M06, M10). |
| Broadcast-storm level recommended | Built (M06) with three interventions whose consequences differ measurably. |
| No unseen-network practice | Night Shift generator: randomised addressing, 15 fault classes, solvability proven per challenge. |
| No learning instrumentation | Local telemetry of the metrics your playtest protocol names; JSON export in Settings. |

## Verified (automated, reproducible)

`npm test` — node:test, 48 tests, all passing at the time of writing:

- IPv4 math (masks, ranges, overlap, wildcards).
- Engine: speed/duplex negotiation incl. parallel detection, ACL first-match/implicit-deny/undefined-ACL, ACE parsing, IOS grammar (abbreviation, ambiguity, incomplete, caret position), dhcpd.conf / zone / netplan parsers with real-style errors, STP roles and 802.1D timers and priority changes, TTL through PAT, asymmetric failure when NAT is removed, DHCP INIT-REBOOT NAK after a VLAN move, BPDU guard err-disable.
- Campaign: all 10 incidents start broken; each refuses to complete before verification; each completes with its reference fix plus a verification; aftershocks resolve. Canonical replay starts are unsolved.
- Negative paths: ping is not proof (M03); zone edit without reload changes nothing; stale client cache defeats the fix until flushed; VLAN-only, ACL-only, ACL-without-DNS and ACL-without-permit-any all fail (M05); relay on the wrong subinterface fails (M07); IOS rejects an overlapping /25 and a scope change without a gateway change fails (M08); snooping without a trusted uplink starves legitimate DHCP (M10).
- M06 trade-off is measured, not asserted: Rapid PVST+ outage ≤ 3 s, PVST+ 28–40 s, shut-a-riser ≥ 90 s until the player re-enables the port.
- Accuracy regressions (`tests/unit/accuracy.test.js`, 14 tests, each shown to fail on the pre-fix engine): ACL `established`; IOS NAT/ACL order of operations; PAT un-translating ICMP errors (traceroute through NAT); Rapid PVST+ fast only via edge ports or proposal/agreement with an RSTP neighbour, and M06's mixed-mode outcome; BIND keeping the last good zone after a failed reload and SERVFAIL for a never-loaded primary zone; err-disable recovery needs shut/no shut; interface-only static routes; DNS refused vs timed out; `root primary`/`secondary` macro; valid IOS show/ping commands no longer answered with a fake syntax error; DHCP snooping option 82 vs the IOS relay; IOS defaults (UDP port unreachable, proxy ARP on new subinterfaces); teaching text in M02/M04/M08 matching the simulator.
- Generator: healthy builds across 12 random addressing plans; every fault class breaks a user-facing flow and its reference repair restores all flows; 40 generated challenges (single and double faults) verified solvable; challenge completion requires a post-fix verification.

`npm run test:browser` — Chromium with SwiftShader WebGL 2 (software rendering, not a GPU):

- 14 steps, all passing on commit 3d963d1: title, briefing, M01 solved through the patch-panel UI and a console command, debrief shown and the win recorded exactly once (regression for a double-debrief bug), M02 start, packet-capture view, map/IPAM window, NOC render, a Night Shift challenge (seed 27, DNS service down) fixed from the consoles and closed exactly once, mobile viewport with touch controls and console; no uncaught page errors in any of the three pages. Screenshots in `tests/browser/out/` (a selection in `docs/screenshots/`).

## Not verified (say so plainly)

- **Real GPUs and phones.** Frame rate, thermal behaviour, Safari/iOS WebGL quirks and Android GPU paths are unmeasured. SwiftShader proves the shaders compile and the scene renders, not that it is fast. The Night Ink ink pass runs on every tier (9 depth taps + 1 colour tap per pixel).
- **The art style's effect on play.** Whether "only signal glows" helps players read faults, and whether the halftone screen causes fatigue over 45 minutes, is untested. Add to the playtest: ask each player what the glowing things meant, and log any complaint about the dots.
- **Learning.** No learner has played v0.3. There is no evidence yet of enjoyment, retention or transfer.
- **Output fidelity.** Device outputs imitate real formats from documentation and experience, not from captured traffic or recorded sessions. An independent review found 7 high and 11 medium accuracy defects; 16 of them (all 7 high) plus 3 low ones are fixed with regression tests, and findings 10, 15, 17, 18 remain (listed in `docs/SIMULATION_MODEL.md`). Wording added by those fixes that is unconfirmed against real devices: BIND's "loading from master file" (9.18 may say "primary file") and rndc's unknown-zone error; dig's three "connection refused" lines and Linux nslookup's refused output; Windows nslookup "No response from server" for a refused query (low confidence); IOS "Routing entry for 0.0.0.0/0, supernet", the `show ip interface` NAT line, "% Invalid source interface", and the trimmed `show interfaces … switchport` / err-disabled layouts. A recorded comparison against real IOS/Windows/Ubuntu sessions has not been done.
- **Network model vs a reference implementation.** The v0.2 plan's differential test against Linux namespaces or an emulator is still open.

## First real play session (owner, n = 1, 15 Oct 2026)

What happened in M01: the player found the fault from evidence (`show interfaces status`, then the TDR "Open" on all pairs at ~2 m) but used all three hints and still could not act. Nothing said that the fix is a patch cord at the panel, or how to reach and use the panel. They tried to click cables; cables were not interactive. They also hit IOS's `% Incomplete command` on `show cable-diagnostics tdr` with no guidance. Verdict in their words: the problem should be broken into steps with feedback "so we understand we are on the right path", plus a tutorial on how everything works.

This falsifies the v0.3 assumption that a briefing plus three hints is enough onboarding for a non-expert. It is one player, so it says nothing about rates, but it was a hard stop, and that is enough to act on. Changes:

- **Step-by-step coach** for incidents 1–4 (`src/content/coach.js`, `src/game/coach.js`). M01 opens with three controls lessons (look, walk, map). Each step says what to do, where, and the exact command. An orange waypoint points at the station. Each step is ticked off by observing what the player actually did, and on completion the coach explains what the result means (e.g. what "Open at 2 m" implies). A rejected command (`% Incomplete`, `% Invalid input`, wrong device) gets a coaching note in the console. Steps never gate the win; a player who fixes things directly skips ahead. On by default; Settings → Step-by-step coach.
- **Inspectable cables:** every patch-panel port's permanent cable is now drawn. Aiming at a cable says what it connects and whether the panel port in front is empty. E on a patch-panel cable opens the panel.
- **M01 hint 3** now says how to do the fix in this game.
- Tests: `tests/unit/coach.test.js` walks M01–M04 through the coach with the real commands. The browser suite asserts the next-step card, the waypoint and a coaching note.

Not yet known: whether the coach over-scaffolds (players follow steps without understanding). Add to the playtest: after M04 with the coach on, give each player M07 (relay, no coach) and record whether they diagnose it unaided. If coach users do worse on unguided M07 than a coach-off group, the coach is teaching button-pressing.

## Pre-registered playtest (proposal — agree the thresholds before running it)

Participants: 5 non-networking players + 5 Tier-1 technicians (your v0.2 design), no tutorial beyond the in-game briefing. 45 minutes in campaign, then free choice. Export each player's log (Settings → Playtest log → Export JSON).

| Metric (telemetry field) | Proposed gate | If it fails |
|---|---|---|
| First useful action (`firstUsefulActionSec`, median) | ≤ 180 s | Onboarding problem: fix briefing/first station before anything else |
| Hypothesis-driven work (`diagnostic` : `changes` ratio; `unknownCommands` / `commands`) | diagnostic ≥ 2× changes; unknown ≤ 25% | Players are guessing or fighting the shell: improve discoverability, not content |
| Progress (`missionsWon` by 45 min, median) | non-networkers ≥ 3, technicians ≥ 5 | Difficulty curve or navigation |
| Stuck periods (`stuckPeriods` per player) | median ≤ 2 | Identify the incident and the missing affordance |
| **Voluntary repeat** (`voluntaryReplays`, or starting the next incident after the 45 min) | ≥ 6 of 10 continue unprompted | **The core loop is not fun enough. Iterate on the loop; do not add content.** |
| Transfer at 48–72 h: unseen DHCP-relay or DNS fault in Packet Tracer/GNS3, no hints, 20 min | ≥ 3 of 5 non-networkers, ≥ 4 of 5 technicians | Too scripted: shift time from campaign to unguided challenges |

Decision rule: the repeat gate and the transfer gate are the two that decide whether to expand content. Passing everything else while failing either means more missions would scale a problem, not a product.

## Smallest falsifiable next step

Run the 10-player session above on v0.3 as built, with the thresholds fixed in advance. Cost: about one day. It can falsify the two claims everything else rests on: that this loop is enjoyable, and that it transfers. Until then, the right engineering work is fixing what the session exposes, not adding objectives.

## Known issues / risks

- Mobile is playable but dense; the console sidebar is hidden behind a "Goals" toggle on narrow screens.
- Typing-heavy play on touch devices is slow; quick-command chips mitigate but do not solve it.
- Time-dependent mechanics (30 s STP convergence, 5-minute APIPA retries, camera T1 renewals) are realistic but can read as "nothing happened". The `T` fast-forward exists for this; watch whether players find it.
- Visual quality was tuned against software-rendered screenshots; the ink thresholds, halftone cell size and bloom should be rechecked on a real GPU and an OLED phone.
- The map's internet cluster (BACKUP/PORTAL/RESOLVER/SIP-GW) draws overlapping nodes.
