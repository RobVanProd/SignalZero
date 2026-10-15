# SIGNAL//ZERO — game-first Network+ learning system

**Status:** concept and tested, single-file browser vertical slice, 14 October 2026  
**Target certification:** CompTIA Network+ N10-009 (version 9)  
**Scope:** a full game system that develops working network skill. The attached prototype does **not** cover the entire exam.

## 1. The product test

A learner who has never configured a network should eventually become able to design, inspect, repair, and explain networks *without playing the game*. An enjoyable game is a condition of success; high scores on its own scoring system are not sufficient evidence of learning.

**Anti-pattern:** drill question → pick A/B/C/D → show confetti → give XP. This produces a quiz with graphics, not a game.

**Design principle:** network behavior is the game's underlying system. The player operates the system. Services and people inside the world depend on it. Errors cause plausible network symptoms. The same diagnostic method and configuration knowledge must work outside the game.

**Genre:** city-infrastructure rescue + systems strategy + tactical fault isolation, with a persistent network you build over time. The experience should feel closer to a well-paced repair/strategy game than a test-prep site.

## 2. The main loop (2–5 minute missions)

1. **Urgent outcome:** a clinic's dispatch calls fail, a city service can't reach cloud storage, guest Wi-Fi exposes private systems, or voice calls glitch.
2. **Observe:** the map shows packet traffic, link status, service impact, and users trying to work. Specific tools reveal IP configuration, routes, switchports, event logs, spectrum, and packet captures.
3. **Hypothesize and intervene:** recable, choose media, reallocate address space, alter VLAN/trunk/ACL, fix routing, move a wireless AP, fail over power, or roll back a change. Multiple valid fixes should exist where technically appropriate.
4. **See consequences immediately:** packet paths, dropped traffic, alarms, user demand, throughput, jitter, and uptime respond to the actual simulated network state.
5. **Verify and earn progression:** the original service must work, and the fix must not break other explicit constraints. Bonus credit rewards fast, precise diagnosis and low disruption; it does **not** reward guessing or arbitrary tool use.
6. **Debrief in under 20 seconds:** what failed, evidence that showed it, why this fix worked, and a real-world command or mechanism. Deeper explanation is optional and accessible at any time.

The player learns by making meaningful decisions. Unlockable tools extend options, not fictional knowledge. In a later challenge, the game removes interface help and requires the same task in a changed topology.

## 3. The four interacting play systems

### A. The living city

City districts request services and produce load. Clinics need reliable records, traffic sensors need low latency, offices need DNS/DHCP/VPN, security cameras use PoE, and guest devices must not reach protected hosts. A city-wide status map shows actual results. An optional deadline adds tension, but Training mode removes time pressure.

### B. The network is real enough to predict failures

One consistent network model drives the map, tools, packet traces, device status, scoring, and service checks. Cables have media, speed, distance and loss. Switchports have VLANs, forwarding state and counters. Routers have interfaces, routing tables, next hops, ACLs and NAT. Hosts have IP configuration and applications. Services are not simply green or red because the plot says so; they must derive from the packet path and configuration.

### C. Packet freeze — visual explanation when needed

Pause one failing request and step through its journey: source device → Ethernet/ARP → VLAN → router/next hop → TCP or UDP → DNS/application. Expand a packet to see real header fields. Compare to the same request after repair. Early players see highlights; later players choose instruments and interpret the evidence themselves. This is a *learning aid*, not a claim that OSI layers literally execute as seven isolated operations.

### D. The skill model

Each Network+ sub-objective has evidence gates: **guided success → unguided success in a changed scenario → delayed success → authentic transfer**. The game stores hints used, tool choices, time-to-diagnosis, repeated mistaken hypotheses, collateral damage, and verification results. It adapts next scenarios to weak concepts. It does not use a raw level number as evidence of competence.

## 4. Full N10-009 objective-to-game design map

The objective groups below follow the published N10-009 syllabus. The scenarios are original game designs, not exam questions. Each item needs multiple incidents and more than one network layout.

| ID | Topic | Mechanic proving practical understanding |
|---|---|---|
| **1.1** | OSI model | Use packet freeze and layer-based instruments to localize a real break without memorizing a layer list in isolation. |
| **1.2** | Devices and functions | Build a district using switches, routers, firewalls, load balancers, IDS/IPS, NAS and access points; the wrong choice fails for a physical/logical reason. |
| **1.3** | Cloud connectivity | Build a hybrid service with virtual network, gateways, security groups and remote users; compare deployment options under outage/cost/load constraints. |
| **1.4** | Ports, protocols, services, traffic | Keep real app flows alive; choose TCP/UDP behavior, permit correct ports, and inspect broadcast/multicast/unicast paths. Service traffic requires the real destination port. |
| **1.5** | Media and transceivers | Lay copper/fiber between buildings; choose matching optics/connectors and realistic lengths, loss budgets and speeds; investigate link failures. |
| **1.6** | Topologies and architectures | Design a star, mesh, hierarchical or spine-leaf network; test redundancy, bottlenecks and failure domains after a district goes dark. |
| **1.7** | IPv4 addressing | Allocate multiple subnet sizes to expanding districts without overlap; validate CIDR masks, gateways, public/private ranges and address utilization. |
| **1.8** | Modern networking | Deploy IPv6/dual-stack and a policy-driven WAN; investigate overlay/underlay, SD-WAN routing, VXLAN, zero trust and config drift in advanced contracts. |
| **2.1** | Routing | Repair static routes, route preferences and dynamic convergence in a simulated multi-site network; preserve NAT/PAT, failover and correct next hops. |
| **2.2** | Switching | Segment departments with VLANs, 802.1Q trunks, STP, link aggregation, duplex/speed and MTU; survive loops and excessive load. |
| **2.3** | Wireless | Move APs on a radio map; tune band, channel, width, antenna, coverage and WPA settings; measure roaming, interference and guest isolation. |
| **2.4** | Physical installation | Connect MDF/IDF racks, patch panels, PoE budgets, UPSs and transceivers; keep cables labeled and rooms cooled so later maintenance works. |
| **3.1** | Procedures/documentation | Maintain a usable network diagram and IPAM; perform changes with impact checks, baseline diffs, rollback and decommissioning. |
| **3.2** | Monitoring | Investigate SNMP, syslog, flow counters and packet captures; establish baselines before diagnosing drops, errors or an overloaded interface. |
| **3.3** | Disaster recovery | Prepare hot/warm/cold failover systems and backups; experience different RTO, RPO, MTTR, MTBF and availability outcomes during a disaster. |
| **3.4** | Network services | Configure DHCP scopes/relay/reservations, IPv4/IPv6 address services, DNS zones/records, SLAAC and time sync; observe real client failure modes. |
| **3.5** | Network access/management | Restore equipment through SSH, console or out-of-band links; maintain secure VPN and compare split/full tunnel behavior. |
| **4.1** | Security concepts | Protect critical data flows using least privilege, authentication, certificates, encryption, segmentation and physical safeguards. |
| **4.2** | Network threats | Diagnose rogue DHCP, rogue APs, ARP/DNS poisoning, DDoS, flooding and on-path attacks from evidence rather than arbitrary red traffic. |
| **4.3** | Defense tools | Deploy ACLs, 802.1X/NAC, port security and hardened services; confirm attackers are blocked while legitimate flows continue. |
| **5.1** | Troubleshooting approach | Track symptom → theory → test → repair → verify → documentation. Let skilled players work freely; score evidence and collateral impact. |
| **5.2** | Physical faults | Use cable tester, tone probe, optics readings, interface statistics and PoE counters to isolate swaps, bad termination and attenuation. |
| **5.3** | Service/config faults | Repair wrong VLAN, route, gateway, subnet, ACL, DHCP and switch loop problems in different topologies. |
| **5.4** | Performance faults | Stabilize a live call or stream under congested links, jitter, latency, packet loss and Wi-Fi interference. Choose capacity/QoS/design fixes. |
| **5.5** | Tools and commands | Use truthful `ping`, `tracert`/`traceroute`, `ipconfig`/`ip`, `nslookup`/`dig`, switch `show` commands, analyzer traces and physical testers in context. |

**Domain weight check:** concepts 23%; implementation 20%; operations 19%; security 14%; troubleshooting 24%. This is not a claim that every concept needs equal gameplay time. Some items (port lists, connector names, process terms) still require deliberate recall, but recall should occur during meaningful jobs, then be checked independently.

## 5. Campaign structure — stories rather than subject chapters

| Act | Campaign situation | What increases in complexity |
|---|---|---|
| **Prologue: First Light** | Restore a clinic during opening night | Media links, switch/router roles, DHCP, DNS, basic ping |
| **Act I: Growing Pains** | An expanding district with competing tenants | Subnets/VLSM, duplicate addresses, VLANs, trunks, Wi-Fi |
| **Act II: Traffic Jam** | Traffic surge, performance collapse | TCP/UDP, ports, link speed, latency, Wi-Fi spectrum, QoS, STP |
| **Act III: Access Denied** | An attacker exploits guest and contractor access | ACLs, NAC, VPN, ARP/DNS poisoning, certificates, least privilege |
| **Act IV: The Blackout** | Power, fiber, equipment and region failures cascade | PoE/UPS, route convergence, redundant links, failover, recovery targets |
| **Act V: Three Sites, One Network** | Distributed offices and cloud infrastructure | Dynamic routing, NAT, IPv6, SD-WAN, cloud security, monitoring and change control |
| **Final: No Overlay** | A new network with hidden faults and an uptime contract | No guided highlights; choose tools, explain fault, fix safely, validate and document |

This order spirals through the syllabus. The player meets a concept in context, later relies on it under new conditions, then must name and explain it in a real-world style interface.

## 6. Set-piece mission ideas that could actually be fun

- **Broadcast Storm:** an added switch link creates a Layer 2 loop. Links still show *up* while broadcasts multiply and services fall. Freeze a frame, inspect MAC learning, enable or repair STP. Optional rapid isolation by shutting a port sacrifices capacity to save the district.
- **Ghost DNS:** everyone can ping the service address but not its name. Later an attacker manipulates DNS, producing a similar user symptom but different evidence. Diagnosing the difference matters.
- **The 1% Problem:** dispatch calls mostly succeed but sound awful. A low loss rate or jitter ruins voice quality. A player must read real-time latency, traffic, QoS and port counters while keeping calls active.
- **An Open Door:** fix guest wireless access without exposing the staff VLAN. A wrong ACL can block users *or* leak records. Both outcomes affect the city immediately.
- **The Last Route:** a regional fiber cut forces paths through a low-capacity backup; reroute, choose what service to protect, and restore full service without a routing loop.
- **Fifty Cameras, One Switch:** new PoE cameras overload the switch's power budget. Upgrade injectors/switch or move loads without losing video recording.

## 7. Scaffold the learning, then remove the scaffold

**First encounter:** manipulate one concept with visible effects, short tool tips and a reversible failure.  
**Second encounter:** solve without explicit directions; player can request the tool panel.  
**Third encounter:** mix two or more fault classes that have similar symptoms and demand selective testing.  
**Challenge encounter:** randomize topology, masks, addresses, device placements, loads and fault location within verified solvable constraints.  
**Transfer lab:** solve the equivalent situation with real commands, realistic CLI outputs, an independent network emulator or real isolated lab.

Do not randomize values so aggressively that problems become nonsense. A deterministic fault generator should produce a known-correct reference state, inject a fault, and independently prove that at least one allowed recovery path exists.

## 8. Engineering plan and validation

**Simulation foundation:** a typed topology graph (devices, ports, links, media, interfaces) drives L2 forwarding, ARP, IPv4/IPv6, subnet math, routing, ACL/NAT, basic TCP/UDP and service state. Later modules add STP, DHCP/DNS, 802.11 coverage/interference, capture, logs, monitoring, redundant links, dynamic routing and cloud boundaries. Keep the simulation deterministic so the same incident can be replayed and tested.

**No fake causality:** a VLAN assignment cannot magically stop inter-VLAN routing; a green link LED cannot prove DHCP works; a successful IP ping cannot prove DNS works; a default route does not control on-link traffic. The simulator must distinguish these. Higher levels need real protocol behavior, not scripted status toggles.

**Validation gates:**
- Unit test subnet membership, broadcast calculations, host validity, DHCP allocation, route selection, ACL order and packet state transitions.
- Differentially compare selected small topologies against an external reference implementation (e.g., isolated Linux namespaces/containers or a validated network emulator) and capture expected ping, ARP, DHCP, DNS and route behavior.
- Run reproducible bug cases: wrong mask, DHCP off, wrong DNS A record, guest VLAN with open inter-VLAN ACL, bad default next hop, STP loop and packet loss.
- Review mission text and debriefs against published CompTIA exam objectives and vendor/network documentation. Version the coverage map when the exam changes.

**Content system:** authors express *goal state, topology, constraints, injected faults, tool availability, validated recovery paths, teaching tags and difficulty*, not one hard-coded answer sequence. The simulation decides whether the network is fixed. AI can generate story variants, but should not invent facts or make final network correctness decisions.

**Performance target:** responsive interaction, deterministic sim ticks, packet visualization decoupled from network state; avoid drawing every real traffic unit in a large city. Aggregate high-rate flows but allow inspection of representative packets.

## 9. The playable prototype — exactly what exists

`SIGNAL_ZERO.html` is a self-contained browser file. It contains:

1. **Physical reconnection:** join edge → switch → client; verify access to the server.
2. **DHCP:** inspect an APIPA client, enable DHCP on the edge, renew the lease.
3. **DNS:** run `ping` and `nslookup`; correct an A record; verify hostname resolution.
4. **Segmentation:** assign guest AP switchport to VLAN 20 and add a router deny ACL; test guest internet and staff isolation.
5. **Routing:** correct the default route next hop while retaining local portal service.

The player can inspect devices, use a small supported command set, watch live schematic traffic, request a hint, switch Training mode on/off and replay for score. Browser testing has verified the five intended success paths.

**Known limits:** The prototype is a rule-based model, not a real packet simulator. Commands return synthetic outputs. It lacks actual packet capture, full ARP/DNS/DHCP exchanges, routing decision engine, subnet calculations, Wi-Fi physics and most of the N10-009 curriculum. The first missions still rely heavily on clicking configuration controls. It tests the teaching structure, not whether we have already built a compelling complete game. It should not be used as a sole Network+ prep source.

## 10. The first experiment that decides whether to build the full game

Test with **8–12 first-time network learners**, plus a few technicians to catch technical errors. Give them 15–20 minutes of play, no tutorial video, then compare against a conventional mini lab that teaches the same five skills.

Collect: unprompted continued play/replay; visible confusion and abandonment; completion and hint usage; performance on **new** unseen topologies immediately after play and again days later; ability to use relevant commands; ability to explain why their fix worked. Report engagement, accuracy, retention and transfer separately. Define acceptable gates *before* testing. If learners can finish but cannot solve a new fault, the level is too scripted. If they learn but don't want to replay, the core loop is not game-like enough.

**Suggested build order:** tune the playable core until people voluntarily replay it → build a reference-tested packet engine → add subnetting/VLANs/Wi-Fi as deep systems → expand authored incidents across the 25 objectives → independently assess exam readiness with written scenarios and full performance labs. Avoid building hundreds of missions until one mission is genuinely enjoyable and teaches a transferable skill.

## Source and licensing notes

Official syllabus: **CompTIA Network+ N10-009 exam objectives, Version 6.0**:  
https://lecbyo.files.cmp.optimizely.com/download/35a7403ab73211ef9dcda6f347fbf652

Network+ and CompTIA are trademarks of their respective owners. This is an **unofficial** game concept and original educational content, not an affiliated or endorsed exam product. Do not reproduce actual exam questions or unauthorized exam dumps.
