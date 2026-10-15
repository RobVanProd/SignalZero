# SIGNAL//ZERO v0.2 — QA and next research gates

Date: 14 October 2026

## Validation performed

**Network-model checks (Node): PASS.** Tests covered invalid physical cabling, cable recovery, DHCP request without server, correct DORA exchange, use of APIPA when link is up but DHCP absent, DNS mismatch, IP-vs-name reachability, HTTPS service validation distinct from ICMP ping, same-VLAN guest exposure, failure of firewall-only segregation, successful VLAN+ACL isolation, invalid next hop, traceroute as a routing instrument, HTTPS verification as proof of application health, save/restore, and DHCP lease survival after service shutdown. All five progression gates passed.

**Browser DOM/UI checks (headless Chromium): PASS WITH A MOCK 3D LIBRARY.** Tested first-run button, interaction via patch UI, terminal command entry, stage changes, status HUD, live map, modal close, mobile workstation panel and command results, no uncaught page errors under the mock.

**Native Three.js WebGL rendering: UNVERIFIED in this environment.** The container's browser policy blocks local file/HTTP navigation, and the runtime cannot download the Three.js dependency from the public CDN. A mocked Three.js API was injected solely to exercise UI wiring and game-state logic. That does **not** establish that the visual WebGL room, camera, lighting, performance, or Android GPU path renders correctly. Validate those in a normal browser before considering this production-ready.

The game has **not** undergone player playtests. No claim about actual enjoyment, retention or readiness for the Network+ exam is made.

## Current realism boundaries / known simplifications

- Stage scenarios use a deterministic limited network model rather than discrete packet simulation.
- Synthetic probes (e.g. `audit guest`) test stateful rules, not packets captured from a real switch.
- The fictional device shell is not Cisco, Juniper, or Linux syntax; the client shell implements a small Windows-style command subset.
- TCP, TLS and HTTP status are simulated results. A successful `ping` deliberately does **not** satisfy the HTTPS verification gates.
- Lease expiration and renewal clocks are not simulated; a current address remains valid while DHCP service is offline, as it can on real networks.
- Network failures may be explored again after completing the story without deleting earned milestones; the live HUD still goes red as services fail.

## Best next playtest

Give five non-networking players and five Tier 1 IT technicians the same build. Do not teach the commands up front. Track:

1. **First useful action:** time from entering the world to opening a diagnostic tool and learning something from its output.
2. **Meaningful choice:** how often players use `help`, read evidence, form a real hypothesis, and change the *right* part of the network rather than guessing.
3. **Voluntary repeat:** when finished, whether players restart voluntarily, and their reason.
4. **Unprompted transfer:** 48–72 hours later, ask them to fix a similar but *unseen* fault in a conventional network lab without game hints.
5. **Frustration points:** poor navigation, unclear roles for physical versus logical tasks, too much typing, and whether environmental feedback is understood.

The central product risk is still **fun**. We have made a 3D delivery vehicle for a coherent network model. We have not proved a network-operations game is enjoyable through this version. The next development priority should be a **broadcast-storm level** with emergent consequences, where cable topology, loop prevention, service load, tools and recoveries interact continuously. It should admit several correct interventions with measurable tradeoffs, not a single scripted repair.

## Learning scope

Maintain the N10-009 coverage map. Each objective needs guided success, successful unaided work on a different network, delayed recall and authentic outside-game transfer. A full Network+ course cannot be inferred from completing five introductory missions.
