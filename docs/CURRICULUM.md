# Curriculum map (N10-009) — v0.3

Builds on the v0.2 plan in [`prototype/v0.2/NETWORK_PLUS_CURRICULUM_PLAN.md`](../prototype/v0.2/NETWORK_PLUS_CURRICULUM_PLAN.md). Objective titles are paraphrased from CompTIA's published N10-009 objectives. Unofficial.

## Evidence ladder (per objective)

| Level | Evidence | Where it comes from |
|---|---|---|
| 1 Guided | Solved a campaign incident tagged with the objective | Scripted incident, hints available, trainer notes on |
| 2 Unguided | Solved a Night Shift challenge involving it with **zero hints** | Randomised addressing/VLANs, injected faults, no trainer notes |
| 3 Delayed | Another unguided success ≥ 24 h after the first success on the objective | Same, later |
| 4 Transfer | Player reports doing the equivalent task on real or emulated gear | Self-reported only; the game cannot verify it |

A level is evidence of practice inside this simulator. It is not an exam-readiness score.

## Campaign incidents

| # | Incident | Fault | What a correct fix requires | N10-009 |
|---|---|---|---|---|
| M01 | The Broken Link | Router–switch patch cord missing; console-port decoys | Read link state / TDR, patch correctly, confirm on a device | 1.5, 2.4, 5.2, 5.5, 5.1 |
| M02 | No One Has an Address | dhcpd crashed on a config syntax error | APIPA recognition, systemctl/journalctl, fix config, `dhcpd -t`, start, renew | 3.4, 5.3, 5.5, 1.4, 1.7 |
| M03 | The Wrong Destination | Stale A record to a live decommissioned server + client cache | Compare DNS vs documentation, edit zone, `rndc reload`, flush cache, verify with curl (ping alone fails the check) | 3.4, 5.3, 5.5, 1.4, 3.1 |
| M04 | The Last Hop | Default route next hop outside the connected /30 (configured, not installed) | tracert, routing table vs running-config, fix route, verify HTTPS | 2.1, 5.3, 5.5, 1.7 |
| M05 | Uninvited Guest | Guest AP in the clinic VLAN | Move VLAN, renew (NAK), inbound ACL that still permits DNS and internet, test both directions from the guest | 2.2, 4.1, 4.3, 1.4, 5.3 |
| M06 | Broadcast Storm | Two risers with STP disabled | Read MAC-flap logs/CPU, restore loop prevention or remove the path; aftershock measures outage of the chosen method (rapid failover needs Rapid PVST+ on both switches; PortFast trunk toward the router) | 2.2, 5.3, 3.2, 1.6, 5.1 |
| M07 | A Different Floor | Staff VLAN gateway lacks `ip helper-address` | Broadcast domains vs relay, giaddr scope selection | 3.4, 2.1, 5.3, 1.4 |
| M08 | Fifty Cameras | /27 scope exhausted; overlap trap with door-controller /27 | Size a non-overlapping /26+, change gateway and scope together, force renewals | 1.7, 3.4, 3.1, 5.3 |
| M09 | The 1% Problem | One end hard-coded 100/full → partner half duplex | pathping, interface counters on both ends, CDP log, fix both ends, test call MOS ≥ 4.0 | 5.4, 5.2, 2.2, 3.2, 5.5 |
| M10 | Someone Else's Network | Rogue DHCP on a lobby jack | Identify via lease details and MAC table, contain (shut/unplug), prevent (snooping + trusted uplink); aftershock tests prevention | 4.2, 4.3, 3.4, 5.3, 2.2 |

## Night Shift fault library (challenges)

Port shutdown · host port in wrong VLAN · VLAN pruned from trunks · DHCP relay missing · DHCP service stopped · DHCP scope hands out wrong gateway · DNS record wrong · DNS service down · default route wrong · PAT missing on a VLAN · guest ACL blocks DNS · STP disabled with redundant risers · duplex mismatch on the voice path · web service stopped · server with wrong default gateway (netplan).

Each challenge: random site octet, VLAN IDs and subnet octets that deliberately do **not** match the campaign's "VLAN n = 10.x.n.0" convention; healthy build verified; faults injected; reference repair applied to a copy to prove solvability; ticket shows only user symptoms and change-record noise.

## Coverage against N10-009

| Coverage | Objectives |
|---|---|
| Core (mission + challenge practice) | 1.4, 1.7, 2.1, 2.2, 3.4, 4.3, 5.1, 5.2, 5.3, 5.5 |
| Partial | 1.1, 1.2, 1.5, 1.6, 2.4, 3.1, 3.2, 3.5, 4.1, 4.2, 5.4 |
| Not in the game yet | 1.3 cloud, 1.8 IPv6/SDN/SD-WAN/VXLAN/zero trust, 2.3 wireless, 3.3 disaster recovery |

Domain weights (concepts 23%, implementation 20%, operations 19%, security 14%, troubleshooting 24%) are shown in the in-game skill map; the game is currently strongest in troubleshooting and weakest in concepts and security breadth.

## Next content, in priority order (only after the playtest gate)

1. Wireless (2.3) as a deep system: AP placement, channel overlap, band steering, WPA2/3-Enterprise vs PSK, roaming.
2. Dynamic routing + first-hop redundancy (2.1) with a WAN failover incident.
3. IPv6 dual-stack (1.8, 3.4): SLAAC vs DHCPv6, RA guard.
4. Monitoring (3.2): SNMP/syslog/NetFlow baselines before diagnosis.
5. Remote access (3.5): out-of-band console when in-band management is down; split vs full tunnel VPN.
