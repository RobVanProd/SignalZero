# SIGNAL//ZERO — THE LAST MILE (3D vertical slice)

Version: **0.2 / 14 October 2026**. Three.js-based first-person proof of concept for a game that teaches applied Network+ skills, not a quiz.

## Play now

1. Open `SIGNAL_ZERO_3D.html` in a modern browser (Chrome or Edge recommended) **with an internet connection**. Three.js 0.186.1 loads from the jsDelivr CDN. All game assets and the network simulation are embedded in the HTML. The browser can open the file directly, but if its local-file security policy blocks modules, serve the directory with `python -m http.server 8000` and open `http://localhost:8000/SIGNAL_ZERO_3D.html`.
2. Select **BEGIN SHIFT**. On desktop: **WASD** to move, **mouse** to look, **E** to use a nearby device, **M** for the network map, **H** for field help, **Esc** to leave a terminal. Click the scene if you need to recapture the mouse. Shift moves faster.
3. On mobile: use the left virtual stick, swipe the **right side of the scene** to look, and tap **USE** near stations. The computer UI is sized for mobile as well.
4. Walk to `RACK C / PATCH BAY` and restore the gateway-to-switch uplink. Diagnose services at the four labeled computers. The environment changes when a service is *actually* fixed and verified: lights, station screens, alarms, city windows, the Sector B access door, the map, and the radio messages.

## Concept / game loop

The city is broken. The NOC is a 3D place. Each machine is a contextual interface to the **same** simulated network state. There are no multiple-choice quiz gates.

**Physical gear → instrument/terminal → interpret result → modify real-ish config → verify a service → world reacts → new incident.**

The player can walk into an unlocked Sector B maintenance corridor after the clinic service recovers. The second area shows a backup array whose status changes when external routing and the application work.

| Stage | Symptom | Practical action | Progress proof |
|---|---|---|---|
| 1. Layer 1 | Link to gateway down | Choose labeled gateway LAN port and switch uplink on physical panel | Correct physical patch |
| 2. DHCP | Client does not have a usable address | `ipconfig /all`, check server, start DHCP, client `ipconfig /renew` | Valid lease |
| 3. DNS | DNS maps clinic hostname to dead address | Compare IP ping and name lookup; fix A record on server | HTTPS health request, not just ICMP ping |
| 4. VLAN and ACL | Guest client reaches protected clinic | Move guest AP access port to VLAN 30; deny inter-VLAN access | Synthetic guest path blocked and `audit guest` confirms |
| 5. Routing | Remote backup path uses bad next hop | Run `tracert`, inspect/change router default route | HTTPS health request to remote backup |

Windows-style client console: `help`, `ipconfig /all`, `ipconfig /renew`, `ping`, `nslookup`, `tracert`, `curl`, `route print`, `arp -a`.

Fictional network-device commands: `services`, `dhcp start`, `dns list`, `dns set`, `show vlan`, `show interfaces`, `switch port`, `show routes`, `route set default`, `firewall deny guest clinic`, `audit guest` and others via `help`.

All IPs/hostnames represent a small invented training network. Domains under `.example` and `example.net` and address `203.0.113.20` are documentation-purpose examples.

## What is implemented and what is not

- **Implemented:** a procedural 3D control room, WASD/pointer-lock camera, virtual joystick, usable physical patch panel, four functional terminal interfaces, live reactive telemetry, five linked incidents, automatic progress triggers, radio text events, stage-based Sector B door, command history, guide/hints, and saved state in localStorage when available.
- **Bounded simulation:** command outputs come from a deterministic model, not live Windows, a Cisco IOS parser, packet capture, operating system network stack, or a full Ethernet/TCP/IP simulator. It covers part of the Network+ skill set; **not** all N10-009 topics. It is not an exam-prep substitute yet.
- **Not yet implemented:** unpredictable traffic demand, packet-level switching, 802.1Q trunks, STP timing, true ARP caches, CIDR allocation, Wi-Fi radio, IPSec/VPN, IPv6, RADIUS, detailed NAT/firewalls, AI opponents, actors, and analytics that prove real-world transfer.
- **External dependency:** Three.js is imported from `https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js`. Without CDN access, a clear loading-error screen appears; an offline vendored build is a future packaging step.

## Files and source

- `SIGNAL_ZERO_3D.html` — portable browser game entry (source and simulation embedded, external Three.js module only).
- `src/index.template.html` — authored page layout and styles.
- `src/simulation.js` — networking model; edit to add authentic incidents. Exposes `SignalZeroSim`.
- `src/game.js` — Three.js world, first-person movement, environmental reactions, UI integration.
- `build.py` — `python build.py` rebuilds the single HTML file.
- `tests/test_simulation.cjs` — tests all missions and failure behavior with Node.
- `tests/test_browser.py` — browser UI test using a mocked THREE to confirm flow when the test host cannot reach the real CDN.
- `tests/mock_three.mjs` — a **test double**, never shipped in the playable HTML.
- `NETWORK_PLUS_CURRICULUM_PLAN.md` — broader coverage mapping to N10-009.
- `QA_AND_NEXT_ITERATION.md` — tested claims and next development decisions.

Not affiliated with or endorsed by CompTIA. Network+ is a trademark of CompTIA. No exam questions or exam dumps are included.
