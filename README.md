# SIGNAL//ZERO — Night Shift

A first-person network operations game. You are the only engineer on site at 02:17, half the district is dark, and every fix has to be found from evidence, made on real-style device consoles, and proven from where users are. The city outside the window lights up only when the services actually work.

**Version 0.3** (15 October 2026). Supersedes the v0.2 prototype, which is preserved unchanged in [`prototype/v0.2/`](prototype/v0.2/).

## Play

```bash
npm install
npm run build           # -> dist/signal-zero.html (single file, works offline)
```

Open `dist/signal-zero.html` in a current Chrome, Edge, Firefox or Safari. If your browser blocks local files, serve the folder (`npx serve dist`) and open the printed URL. WebGL 2 is required. Three.js is bundled, so no network access is needed at runtime.

- **Desktop:** click to capture the mouse, `WASD` move, `E` use, `M` map / IPAM / quick travel, `H` field guide, `T` fast-forward time ×8 (for STP timers and DHCP renewals), `Esc` close / menu.
- **Touch:** left stick to move, drag the right side to look, `USE`, `MAP`, `MENU`.
- Graphics quality (Low / Medium / High) is auto-detected; change it in Settings or with `?q=low|medium|high`.

## What the game is

| Mode | What it trains |
|---|---|
| **Night shift campaign** (10 incidents, one persistent network) | Guided: physical patching, DHCP service failure, stale DNS + client cache, uninstalled default route, VLAN + ACL segmentation, broadcast storm with an aftershock, DHCP relay, subnet re-planning for 50 cameras, duplex mismatch vs voice quality, rogue DHCP. |
| **Incident replay** | Any solved incident from a clean copy of the network at that point. |
| **Night Shift challenge** | Unguided: randomised addressing and VLAN IDs, 1–2 injected faults from a library of 15, a symptom-only trouble ticket, no trainer notes. The generator proves each challenge is solvable before handing it out. |
| **Skill evidence** | Per N10-009 objective: guided → unguided → delayed (≥24 h later) → transfer (self-reported). |

Design rules carried over from the v0.2 plan:

- **No quiz gates.** Win conditions are behavioural checks against the simulator ("does Ward B's HTTPS request to the records app actually succeed?"), never "did you type this exact line". Any correct fix passes; a "fix" that breaks another service fails the constraints.
- **Fix, then verify.** An incident completes only after the player produces evidence from a user-facing test *after* the fix (e.g. `curl` from the affected PC).
- **Several valid interventions with measurable trade-offs.** In the broadcast storm, Rapid PVST+, PVST+ and "shut a riser" all stop the storm; a scripted riser cut later measures the outage each choice causes (≈1–2 s, ≈30 s, or until a human reacts). In the rogue DHCP incident, shutting the port contains it; DHCP snooping prevents the repeat.

## How it is built

```
src/engine/     deterministic network engine (no DOM): L1 negotiation, 802.1Q, PVST+/RSTP, routing, ACLs, PAT,
                DHCP/DNS/HTTPS services, packet path tracing, simulated clock
src/cli/        device shells: Cisco IOS-style (modes, abbreviations, ?, Tab), Windows cmd, Ubuntu shell
src/content/    the district topology, 10 missions, challenge generator + fault library, N10-009 map
src/game/       campaign/challenge runtime, skill evidence, local playtest telemetry, app controller, audio
src/world/      Three.js world: rooms, racks, cables routed through trays, packet particles, holo table, city
src/ui/         HUD, consoles, nano editor, patch panel, packet capture, map/IPAM, menus
tests/unit/     node:test suites (engine, parsers, CLI grammar, all missions, generator property tests)
tests/browser/  end-to-end test in Chromium with real WebGL (SwiftShader), writes screenshots
docs/           simulation model, curriculum map, QA status and the next falsifiable step
```

```bash
npm test                # unit + mission + generator tests (node:test)
npm run test:browser    # needs `npm run build` first; real WebGL via SwiftShader; screenshots -> tests/browser/out/
```

## Honest status

- Simulation, missions and generator: covered by automated tests (see [`docs/QA_AND_NEXT_ITERATION.md`](docs/QA_AND_NEXT_ITERATION.md)).
- Rendering: exercised in headless Chromium with a software WebGL 2 implementation, not on real GPUs or phones. Frame rate on real devices is unmeasured.
- Learning: **not yet tested with learners.** Nothing here shows that players enjoy it, learn from it, or transfer skills. The pre-registered playtest in the QA document is the next decision gate.
- Scope: a subset of N10-009 ([`docs/CURRICULUM.md`](docs/CURRICULUM.md)). Not an exam-prep substitute.

Unofficial. Not affiliated with or endorsed by CompTIA or Cisco. Network+ is a trademark of CompTIA. Addresses use RFC 1918 and documentation ranges (198.51.100.0/24, 203.0.113.0/24); domains use `.example`.
