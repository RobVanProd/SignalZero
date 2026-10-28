# Apprenticeship Lesson 1: Next hop

*Local delivery, ARP and the default gateway.* About 25 minutes. Title screen → **Apprenticeship · Lesson 1**.

Why this lesson first: see `AUDIT.md`. It is the knowledge M02, M04 and M05 assume and the game never taught. A DHCP lease is these settings; a default route is this decision; "a VLAN alone does not isolate" depends on knowing that routers forward between subnets.

Code: `src/content/lessons.js` (content), `src/game/lesson.js` (runtime, no DOM), `src/content/bench.js` (the network), `src/ui/bench.js` (screen), `src/engine/neighbor.js` (ARP tables), `src/engine/frames.js` (frame view), `src/cli/iproute.js` (`ip route` / `ip neigh`).

## The sequence

Each concept goes through the same progression: the problem → a working example made visible → guided use with every command explained → a changed example with support → a fault, only once its prerequisites were taught → diagnose, repair, verify → an unguided case.

| # | Step | Stage | What is taught or tested | What makes it visible | Done when (live network state) |
|---|---|---|---|---|---|
| 1 | The problem | Problem | Why a host must choose between delivering a packet itself and handing it to a router. One analogy (internal mail), tied straight back to the bench's network, MAC addresses and router interface. | — | Read |
| 2 | Your address defines your network | Working example, guided | Address + prefix length (/24) define the local network | `ip -4 addr`; diagram shows the network ranges | `ip addr` ran on PC-A |
| 3 | Same network: deliver it yourself | Working example, guided, **prediction** | No gateway is needed on-link (RFC 1122 §3.3.1); ARP request (broadcast, flooded), ARP reply (unicast), frame straight to the destination's MAC; the switch reads MACs, not IPs | Frame view: each frame step by step, with the links it crosses | PC-A got echo replies from PC-B |
| 4 | What PC-A remembered | Guided, **prediction** | Neighbour (ARP) cache; the target learns the sender (RFC 826); unicast ARP confirmations; **what ARP failure looks like** (`From <own address> … Destination Host Unreachable`, FAILED) | `ip neigh` on both PCs; the second ping's frames have no ARP; three unanswered broadcasts for 192.168.10.99 | ARP table read, a cached ping after it, and the failed ARP demo |
| 5 | Another network, no gateway | Guided, **prediction** | No matching route → nothing is sent | `ping: connect: Network is unreachable`; `ip route get` says the same; frame view: no frames | That failure seen and `ip route get` run |
| 6 | Add the default gateway | Guided, **prediction**, explain-back | The default route; the gateway must be on your own network; ARP for the gateway, not the far host; the IP destination stays the same while MACs change per hop; TTL 64 → 63; only routers forward | Frames on both networks; `ip neigh` lists R1, not the server | PC-A reaches the server **and** the learner verified with a ping after the last change |
| 7 | Every reply needs a way back | Guided, **prediction** | The return path: a reply is a packet that needs its own route | Requests reach the server; the server cannot reply; PC-A sees silence, no error | Silence observed while the server had no route, then repaired and verified |
| 8 | Your turn: a different network | **Changed example**, supported, prediction | Same idea with different numbers and a /26 | No command list. Hints start with the idea (concept → evidence → action) | PC-B reaches the server and the learner verified |
| 9 | Ticket: PC-A cannot reach the server | **Fault** (wrong gateway, an address nobody owns), supported | Diagnose from evidence taught in steps 4–6 | Real outputs only; hints on request | PC-A reaches the server **and** PC-B, verified after the last change |
| 10 | On your own | **Transfer**, independent | A *different* fault on Bench B, drawn at random: the gateway is another PC (ARP works, PC-B does not route), or the server has no route back | No hints. "I'm stuck: show me" explains and is recorded | Fixed and verified; then a free-text explanation and a multiple-choice check |

Prerequisites are data, not prose: each step lists `teaches`, each fault step lists `requires`, and `tests/unit/lesson.test.js` fails if a fault requires something not taught earlier, or if support ever goes backwards (guided → supported → independent).

## Teaching mechanics

- **Predict, then test.** Steps 3–8 ask for a prediction before the task. After the task the card shows "you predicted X; what happened". Wrong predictions carry a misconception tag (`arp-remote`, `gateway-needed-locally`, `switch-routes`, `mask`, `error-means-remote`).
- **Teach the missing prerequisite.** When a misconception has been seen twice (wrong predictions or answers, or a rejected command that reveals it), a short refresher on that idea appears before the next step, with a frame replay where it helps. After 6 commands without progress in a supported step, the refresher for that step's key idea is offered once.
- **Remediation on real errors.** A rejected command keeps its real error and gets a LESSON note explaining the idea behind it. For example, `Error: Nexthop has invalid gateway.` → "a gateway must be on PC-B's own network, 10.20.30.64/26 (10.20.30.64 to 10.20.30.127)". Guided steps name the right address; supported practice does not; the independent case gives no notes at all.
- **Skip what you can show.** A four-question placement check on the first card. All four right skips to the troubleshooting steps (9–10), where the learner still has to demonstrate it on the network. Guided steps also have "I know this: hide the explanation".
- **Replay, slow down, inspect.** The frame view steps forward and back, plays at 0.25×, 0.5× or 1×, and replays the last command's frames. Each frame shows a plain-language explanation, the decoded fields (with which device owns each MAC) and the line `tcpdump -n -e` prints. "Reset bench" undoes the learner's changes in the current step.
- **Discoverable controls.** Clicking a command in the card fills that device's console. Clicking a PC on the diagram opens its console. The labels in the top bar open the scope page. On a phone the three panes become tabs.

## How steps are judged

- By the network's actual state, re-checked whenever the card would show success. A step is never completed by typing an expected command sequence. Any valid repair counts: `ip route replace default via …`, `del` then `add`, or a specific route `ip route add 192.168.20.0/24 via 192.168.10.1` all pass step 9. Pointing the gateway at another PC does not.
- Fault and practice steps also require a successful ping **after the last configuration change**, so "fixed but never checked" does not pass. A later change that breaks the network withdraws the success.
- The terminal, the diagram's addresses/routes/ARP tables, the frame view and the step check all read the same bench engine. The frame view is derived from the probes that produced the terminal output (`engine.traffic` → `framesFor`).

## Scope (what this bench is and is not)

| Area | Covered | Not covered / simplified |
|---|---|---|
| Devices | PC-A, PC-B, SRV: Ubuntu 24.04 hosts (root shell). R1: an IPv4 router. SW1, SW2: unmanaged switches. | R1's console is not part of the lesson. Cisco routers enable proxy ARP by default; R1 has it off (a router with it on can hide a wrong subnet mask: lab file `06b-proxy-arp.txt`). |
| Commands | `ip addr` / `ip -4 addr` (show), `ip route` (show, get, add, del, replace), `ip neigh` (show, flush), `ping` (with or without `-c`), `help`. | `ip addr add/del`, `ip link set`, `ip neigh add/del` and other real commands (`tcpdump`, `arping`, …) are labelled SIMULATOR: real but not simulated. net-tools commands (`arp`, `route`, `netstat`, `ifconfig`) give Ubuntu's real "not found, install net-tools" message. |
| Protocols | IPv4, ARP, ICMP echo/reply, Ethernet II framing, routing by longest prefix. | IPv6 is disabled on the bench (IPv6 uses Neighbor Discovery, RFC 4861, instead of ARP; taught in M11). No DHCP, DNS or TCP on the bench. |
| Switching | Broadcast frames are flooded; unicast frames go to one port. | The switch MAC table, its learning and aging, and unknown-unicast flooding are not modelled or shown. The frame sequences shown are the same ones a learning switch would produce after the ARP exchange. |
| Timers | ARP states REACHABLE, STALE, DELAY, FAILED. | Fixed timers: STALE after 30 s (Linux picks 15–45 s), DELAY confirmed after 5 s. Entries are never garbage-collected. A failed ARP covers the echoes of one command, as one round of three requests (the lab showed one round covering up to 4 queued echoes; longer pings start a new round there). |
| Time | The bench clock runs in real time (ARP entries age while you watch). | **Accelerated:** commands complete at once. On a real network each echo is 1 s apart and a failed ARP takes about 3 s. The frame view marks frames that would come about 5 s later. |
| Persistence | Route changes are run-time changes (as `ip route` makes them). | Nothing survives a reboot; netplan is not involved on the bench. |
| Tutorial-only | Diagram, frame view, Reset bench, predictions, hints, refreshers. | Real equivalents: `tcpdump -n -e` (same lines), Wireshark. |

## Network+ N10-009 mapping

Checked against the official *CompTIA Network+ N10-009 Exam Objectives, Version 4.0*. Exam vocabulary is used where it names the real thing; no trivia.

| Objective | Where |
|---|---|
| 1.1 OSI model: Layer 2, Layer 3 | Steps 3 and 6: frames (MAC addresses, switches) versus packets (IP addresses, routers); the IP destination stays the same while MACs change per hop |
| 1.4 Traffic types: broadcast, unicast | ARP request (broadcast, flooded) versus ARP reply and echo frames (unicast); unicast ARP confirmations |
| 1.7 IPv4 addressing: subnetting, CIDR | Steps 2 and 8: /24 and /26, which addresses share a network, where a gateway can be |
| 5.1 Troubleshooting methodology | Steps 9–10: gather information, theory, test, change one thing, verify full functionality (both PCs) |
| 5.3 Incorrect default gateway; route selection: routing table, default routes; incorrect subnet mask | Steps 5–10. A wrong mask appears only as a prediction and in the scope notes, not as a fault: changing an address (`ip addr`) is not simulated |
| 5.5 Tools: ping, ip, arp, tcpdump, protocol analyzer | Every step; the frame view prints `tcpdump -n -e` lines |

## References

- RFC 1122 §3.3.1 (host routing: on-link versus gateway): https://www.rfc-editor.org/rfc/rfc1122.html#section-3.3.1
- RFC 826 (ARP; the target records the sender's addresses)
- RFC 4861 (IPv6 Neighbor Discovery, which replaces ARP in IPv6; not on this bench): https://www.rfc-editor.org/rfc/rfc4861.html
- Linux NUD states and timers: `ip-neighbour(8)`, `/proc/sys/net/ipv4/neigh/*` (values recorded in `lab/out/00-environment.txt`)
- Not used in this lesson, for the next ones: RFC 2131 (DHCP), RFC 1034 §4.3.4 (DNS caching), Microsoft `ping` documentation (Windows hosts are not on this bench).
