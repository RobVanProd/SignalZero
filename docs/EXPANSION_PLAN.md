# Expansion plan: IPv6, dynamic routing, wireless, VPN (Act II)

Shared contract for the four topic builds, so they merge cleanly. Each topic is built in its own worktree and merged here.

## Missions (Act II · NEW GROUND, `act: 2`)

| ID | Topic | N10-009 | Owner build |
|---|---|---|---|
| M11 | IPv6 dual stack (addressing, SLAAC/RA, ICMPv6/ND, AAAA, v6 routing) | 1.7, 1.8, 3.4, 5.3, 5.5 | ipv6 |
| M12 | Dynamic routing: OSPF to the branch clinic (adjacency, metrics, failover) | 2.1, 1.6, 5.3, 5.5 | ospf |
| M13 | Wireless: channels, interference, bands, WPA2/WPA3, roaming | 2.3, 5.4, 4.3 | wifi |
| M14 | Site-to-site IPsec VPN (backup path to the branch) | 3.5, 4.1, 4.3, 2.1 | vpn |
| M15 | Remote-access VPN for a home worker (split vs full tunnel) | 3.5, 4.1, 5.3 | vpn |

Missions are appended to `MISSIONS` in this order. Each new mission must be independent of the other new missions' state (its start state is built by replaying every earlier reference fix, so it must not assume or break another topic's configuration).

## Address and naming plan

- **Clinic IPv6:** site prefix `2001:db8:42::/48`; VLAN *n* → `2001:db8:42:n::/64` (VLAN 10 → `2001:db8:42:10::/64`), router `::1` on each. WAN EDGE-RTR Gi0/0 ↔ ISP-PE: `2001:db8:ffff:1::/64` (ISP `::1`, EDGE `::2`). Internet hosts: BACKUP `2001:db8:203::20`, PORTAL `2001:db8:203::80`, RESOLVER `2001:db8:203::53`, SIP-GW `2001:db8:203::50`.
- **Branch clinic (site 43):** BRANCH-RTR (ISR, IOS) LAN Gi0/2 `10.43.10.1/24`, BRANCH-SW (unmanaged or IOS access), BRANCH-PC `10.43.10.50` (Windows). Private WAN: EDGE-RTR Gi0/2 `172.16.42.1/30` ↔ CARRIER (metro-Ethernet provider bridge, offsite) ↔ BRANCH-RTR Gi0/0 `172.16.42.2/30`. Branch internet: BRANCH-RTR Gi0/1 `198.51.100.10/30` ↔ ISP-PE `198.51.100.9`.
- **Remote worker:** REMOTE-LAPTOP (Windows) `192.168.1.50/24` behind HOME-RTR (consumer NAT router, public `203.0.113.200`); VPN client pool `10.42.200.0/24`.
- **Wireless:** WLC-01 (controller, management `10.42.10.5`, console in a rack); APs: GUEST-AP (existing id, lobby), LOBBY-AP2, LOBBY-AP3 (lobby), WARD-AP (Sector B); wireless clients: GUEST-KIOSK (existing), WARD-TABLET (Sector B). Positions use world coordinates from `src/world/layout.js` (`pos: { x, z }` on devices).
- All addresses use documentation/private ranges (RFC 3849 `2001:db8::/32`, RFC 5737, RFC 1918).

## File ownership (to keep merges trivial)

- New engine logic goes in a new module per topic (`src/engine/ipv6.js`, `ospf.js`, `wireless.js`, `vpn.js`, plus helpers); shared files get small, clearly delimited additions only.
- `src/engine/trace.js` (packet walk) generalisation for IPv6 belongs to the ipv6 build; others hook in with a single call.
- `src/content/district.js`: add your devices in a block headed `// ---- <topic> (Act II)`.
- `src/content/missions.js`: append your mission(s) at the end of `MISSIONS`; coach steps in `src/content/coach.js` as a new key.
- CLI: add grammar and handlers in blocks headed `// ---- <topic>`.
- Tests: own files `tests/unit/<topic>.test.js` and `tests/unit/fuzz-<topic>.test.js`; one `VERIFY` entry per new mission in `tests/unit/campaign.test.js`.
- Docs: `docs/topics/<topic>.md` (merged into SIMULATION_MODEL.md at integration).
- Not touched by topic builds: `src/world/**`, `src/ui/**`, `src/game/**`, `src/content/objectives.js`, README, CURRICULUM, QA (integration does these).
