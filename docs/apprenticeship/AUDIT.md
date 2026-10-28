# Prerequisite-gap audit: incidents M01–M05

Date: 27 October 2026. Scope: the five incidents a new player meets first. Sources read: `src/content/missions.js` (briefs, goals, hints, debriefs), `src/content/coach.js` and `src/game/coach.js` (the step coach), `src/ui/screens.js` (briefing, field guide), the console and capture UI, the engine's host and packet logic (`src/engine/routing.js`, `src/engine/trace.js`), the Linux and Windows shells, `docs/QA_AND_NEXT_ITERATION.md` (including the owner's first play session) and the official CompTIA Network+ N10-009 objectives (Version 4.0 PDF).

## How each early incident teaches

Each incident starts broken. Concepts are named in the briefing, used in hints, and explained by the coach only after the player has done the step ("learned" text), or in the debrief after the win. Nowhere in the game is a working network shown and explained before the player has to diagnose a broken one. The field guide covers method and controls. It defines none of these: IP address, subnet mask/prefix, default gateway, MAC address, ARP, switch vs router, lease, DNS server.

| Incident | What it expects you to already know | Where that is taught | When | Hidden prerequisites unrelated to the lesson |
|---|---|---|---|---|
| **M01** Layer 1 | What a switch and a router do; "gateway" (used in the brief: "nothing can reach the gateway"); what a port and a link are; IOS user vs privileged mode; reading `show interfaces status`; what a TDR result means; how a patch panel is wired (permanent link vs patch cord) | Coach "learned" text after each step; hint 2–3; debrief | After each action (the coach explains the result once you have it) | IOS modes and syntax (`enable`, the exact TDR command with the word `interface`) |
| **M02** DHCP | Why a host needs an address, mask, gateway and DNS server; what DHCP does; broadcast; what APIPA (169.254/16) means; that a server runs services | One coach sentence after `ipconfig /all` (APIPA); "DORA" in one sentence when the lease arrives; debrief | After | **Most of the work is Linux administration, not DHCP:** `systemctl`, `journalctl`, reading a parser error that points at the line after the mistake, `nano` keys, `dhcpd -t`. The fault is a missing semicolon in a config file. |
| **M03** DNS | Names vs addresses; what an A record is; that clients cache answers for a TTL; ping vs application test; HTTP status codes | Coach text after each step; debrief | After | BIND zone-file syntax, SOA serials, `named-checkzone`, `rndc` |
| **M04** Routing | How a host decides between on-link delivery and its default gateway; what a routing table and a default route are; that a next hop must be on a connected network; /30 arithmetic; how traceroute works (TTL) | Coach text after `tracert` and `show ip route`; debrief | After | IOS configuration mode and `no ip route` syntax |
| **M05** VLANs and ACLs | Layer 2 vs Layer 3: a VLAN is a separate broadcast domain, and a router still forwards between subnets; DHCP renew vs rebind; ACL order and the implicit deny | Hint 2 (long); debrief | After | IOS ACL syntax, wildcard masks |

### The DHCP incident (M02) in detail

The coach breaks M02 into 10 steps on two machines and an editor: open the PC, `ipconfig /all`, open the server, `systemctl status isc-dhcp-server`, `journalctl -u isc-dhcp-server`, `nano /etc/dhcp/dhcpd.conf`, add the semicolon on line 13, `dhcpd -t -cf …`, `systemctl start isc-dhcp-server`, `ipconfig /renew`, `ipconfig /all`. Not one step asks the player to observe or reason about DHCP itself: no lease is shown being offered, no address is compared with the server's scope, and nothing asks what the gateway and DNS fields in a lease are for. A player can complete it by copying all ten commands and learn only that "the service was broken". The DHCP mechanism is one debrief sentence ("DHCP is DORA…"). This is the pattern the owner described: the game throws you into the problem before teaching the concept, and the commands carry you through without understanding.

Because the fault is a config syntax error, the incident tests Linux service administration, not DHCP. A DHCP lesson should break DHCP's own mechanism: no server reachable, server on another subnet without a relay, an exhausted pool, a wrong option. It should come only after the learner knows what the fields in a lease do.

### The M01 play session

From the QA notes: the owner found the fault from evidence (`notconnect`, TDR "Open" at about 2 m), so they understood the missing link, but could not find how to act on it. Cables were not interactive and no hint said how to use the panel. That was an interface failure, not a knowledge failure. Since then: the coach steps say where the panel is and how to use it; the panel window says "select a port, then a second port"; cables are inspectable; E on a patch cable opens the panel. Still true: without the coach, the only in-incident pointer to the panel interaction is hint 3. M01 also starts broken; the player never sees a working link, a link light coming up, or what "notconnect" means before meeting it.

## The earliest missing foundation

M01's blocker was the interface, and its concept (a link needs a cord between the right two ports) was understood without teaching. The first incident where missing knowledge, not the interface, is the blocker is M02. The knowledge M02 assumes is the same knowledge M03, M04 and M05 assume, and that the game never teaches:

> A host has an address and a prefix length (mask). From those it decides, for every packet: is the destination on my own network (deliver it directly, finding the destination's MAC with ARP), or not (hand it to my default gateway, finding the *gateway's* MAC with ARP; the IP destination does not change)? Off-subnet traffic also needs a route back.

Without this, a DHCP lease is a list of meaningless fields (M02), "ping works but the site doesn't" has nothing to hang on (M03), a default route is a magic line (M04), and "a VLAN alone does not isolate, because the router routes between subnets" cannot be understood (M05). It maps directly onto N10-009 objectives 5.3 ("Incorrect default gateway", "Incorrect subnet mask", "Route selection – routing table, default routes"), 1.7 (subnetting, CIDR), 1.1 (Layer 2 and Layer 3), 1.4 (unicast and broadcast traffic) and 5.5 (`ping`, `ip`, `arp`, `tcpdump`, protocol analyzer).

So the first teaching sequence is **Lesson 1: Next hop — local delivery, ARP and the default gateway**, built in `docs/apprenticeship/LESSON-01.md`.

## Realism defects found in this scope

Each Linux item was checked against the reference lab (`docs/apprenticeship/lab/`, real Linux kernel 6.18, iproute2 6.1.0, iputils 20240117, tcpdump 4.99.4). Windows items were not lab-checked (no Windows machine available). All are fixed unless marked otherwise.

| # | Defect | Real behaviour (lab file) | Status |
|---|---|---|---|
| 1 | Linux `ip neigh` listed only IPv6 neighbours, so a learner looking for ARP entries saw an empty table | IPv4 entries with lladdr and NUD state: REACHABLE, STALE, DELAY, FAILED (`01-same-subnet.txt`, `04-wrong-gateway.txt`) | Fixed: the engine keeps a neighbour table per device, learned by real traffic |
| 2 | `ip route get <addr>` printed the whole routing table | One line naming the chosen next hop, or `RTNETLINK answers: Network is unreachable` (`02`, `03`, `04c`) | Fixed |
| 3 | `ip route add …`, `ip route del …` and `ip addr add …` printed the address/route listing and changed nothing: a real command silently did nothing | `ip route add/del/replace` change the route table; specific errors for duplicates, off-link gateways and malformed input (`03b-route-errors.txt`) | `ip route add/del/replace` fixed. `ip addr add/del` and `ip link set` now say they are real commands that the simulator does not support. |
| 4 | Real commands the simulator does not model were answered as invalid (`tcpdump: command not found`; Windows `'netstat' is not recognized…`) | They exist on those platforms | Fixed for a listed set of Ubuntu and Windows commands: a SIMULATOR note says the command is real but not simulated |
| 5 | Linux `ping` summary lacked `pipe N` when ARP failed for several echoes in flight | `3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2037ms` then `pipe 3` (`04-wrong-gateway.txt`) | Fixed |
| 6 | Hosts kept no ARP state, so "the second ping sends no ARP" and "the target learns the sender" could not be shown | Target creates a STALE entry from the request, then DELAY when it replies, then confirms with a **unicast** ARP request about 5 s later (`01b-cached.frames.txt`) | Fixed (simplified timers; see LESSON-01 limitations) |
| 7 | Windows `arp -a` learned entries only from `ping` | ARP entries come from any traffic | Fixed: `arp -a` now reads the same neighbour table (Windows output format itself not lab-verified) |
| 8 | Cisco `show mac address-table` lists every reachable host whether or not it has sent a frame, and entries never age | Switches learn source MACs from received frames and age them (300 s default on IOS) | **Not fixed** (outside Lesson 1; the lesson uses an unmanaged switch and explains flooding per frame) |
| 9 | Windows `exit` was answered with "'exit' is not recognized…", but `exit` is a cmd.exe built-in | It closes the Command Prompt window | Fixed: a SIMULATOR note says what it would do and how to close the console |
| 10 | Linux `ping` with no `-c` printed 4 replies and a summary as if it had stopped by itself | It runs until Ctrl+C; the terminal shows `^C`, then ping prints the summary (`08-edges.txt`) | Fixed: `^C` line plus a SIMULATOR note that the simulator stopped it after 4 |
| 11 | Objective 1.7 was titled "IPv4 and IPv6 addressing" | N10-009 1.7 is "Given a scenario, use appropriate IPv4 network addressing"; IPv6 is under 1.8 | Fixed in `src/content/objectives.js` |

Also checked and already correct: on-link vs gateway decision; ARP for the gateway, not the remote host; TTL 64 → 63 through one router; `ping: connect: Network is unreachable` with no default route and no frames sent; `From <own address> … Destination Host Unreachable` when ARP for the next hop fails; a missing return route gives silent 100 % loss with no error lines.

## Recommended order of foundations (only Lesson 1 is built)

1. **Next hop** (built): address/prefix → on-link or gateway → ARP for the next hop → router → return path. Prepares M02, M04, M05.
2. **What DHCP hands out and how**: the lease fields (they are Lesson 1's settings), INIT (broadcast Discover/Request) vs renewal (unicast to the server at T1) vs rebinding (broadcast at T2), relays; faults in DHCP itself. Then M02 should be reworked so its fault is a DHCP fault, not a semicolon.
3. **Names vs reachability vs application**: resolution, caching for the TTL, ping vs TCP vs HTTP. Prepares M03.
4. **Routers' tables**: static routes, next hop on a connected network, return routes. Prepares M04.
5. **Layer 2 segmentation**: VLANs as broadcast domains, trunks, inter-VLAN routing. Prepares M05.
6. **Links** (Layer 1): link state, speed/duplex, patching, TDR, shown working before M01 is played broken.

Do not build 2–6 until Lesson 1's playtest (`PLAYTEST.md`) shows it closes the gap.
