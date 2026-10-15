# Simulation model

One deterministic engine (`src/engine/`) is the single source of truth for every console, the 3D world, the HUD and all win conditions. State is plain JSON (saved to `localStorage`, cloned for challenge proofs). Randomness comes from a seeded PRNG stored in the state, so a run can be replayed.

## Layer 1 — `link.js`

- A link is up when both ports are administratively up, not err-disabled, powered, of compatible kind (an RJ-45 console port never links with Ethernet), on matching media, and the cable is not cut.
- Auto-negotiation follows the IEEE 802.3 clause 28 behaviour that matters for troubleshooting: a 10/100 port with **both** speed and duplex hard-set stops negotiating; its auto-negotiating partner falls back to **parallel detection**, learns the speed and assumes **half duplex**. That produces a duplex mismatch. 1000BASE-T is treated as always negotiating. Hard-set speeds that differ cannot link.
- Mismatch effects: the half-duplex side accumulates collisions/late collisions, the full-duplex side CRC errors and runts; CDP logs `%CDP-4-DUPLEX_MISMATCH`. Loss/jitter on the link are illustrative constants (≈6% loss per traversal under load), not a physical model.

## Layer 2 — `switching.js`

- Access/trunk ports, allowed VLAN lists, native VLAN tagging, VLAN database membership (IOS auto-creates a VLAN on `switchport access vlan`).
- **Spanning tree per VLAN (PVST+ / Rapid PVST+):** root bridge = lowest (priority + VLAN, MAC); root port = lowest (root path cost, designated bridge ID, designated port ID, own port ID); one designated port per segment; others alternate/backup. Path cost uses the 802.1D-1998 short values (1G = 4). Switches with STP disabled for a VLAN, and unmanaged bridges, are transparent (they flood BPDUs), so they behave as shared segments between STP speakers.
- **Timers:** 802.1D blocking → listening (15 s) → learning (15 s) → forwarding. Rapid PVST+ transitions are modelled as ~1 s. PortFast edge ports forward immediately. Enabling STP on a VLAN restarts its ports from blocking.
- **Loops:** after STP, a VLAN whose forwarding graph contains a cycle is in a broadcast storm: its links saturate (≈97% loss for that VLAN, ≈55% for other VLANs sharing the links), switch CPU reads 99%, and `%SW_MATM-4-MACFLAP_NOTIF` is logged.
- **Flooding** computes exactly which endpoints a frame reaches and the port-by-port path, which also drives ARP, the MAC address table and the packet animation.
- **DHCP snooping** drops server-side DHCP messages arriving on untrusted ports in snooped VLANs. **BPDU guard** err-disables an edge port that hears an STP speaker.

## Layer 3 — `routing.js`, `trace.js`

- Host addressing: static, DHCP lease, or APIPA (Windows only, after a failed exchange). Hosts route on-link or via the default gateway; no gateway gives Windows `PING: transmit failed. General failure.`
- Router tables: connected + local routes from up/up interfaces; static routes installed only if the next hop resolves through a connected (or recursively through another static) route — "configured is not installed". Longest prefix, then administrative distance.
- **ACLs:** Cisco semantics — top-down, first match wins, implicit deny at the end, wildcard masks, standard (source only) and extended (protocol, source/destination, `eq/neq/lt/gt/range` ports). An ACL that is applied but not defined permits everything.
- **PAT:** `ip nat inside source list … interface … overload`; the reply is un-translated on the outside interface. Missing NAT produces a real asymmetric failure (request delivered, reply has no route back).
- **Packet walk:** every hop does ARP in the egress broadcast domain, inbound ACL, NAT, TTL decrement (time-exceeded at TTL 1), route lookup (ICMP net-unreachable if none), outbound ACL, next hop. Replies are traced independently, so asymmetric problems surface. Initial TTL: Windows 128, Linux 64, IOS 255.

## Services — `services.js`, `parsers/`

- **ISC DHCP:** `dhcpd.conf` subset (subnet/netmask, range, routers, DNS, domain, lease times, host/fixed-address) with dhcpd's own error wording; refuses to start without a subnet declaration for its interface. Scope selection by `giaddr` for relayed requests. DORA, INIT-REBOOT (`ipconfig /renew` with an existing lease → ACK or NAK → DORA), pool exhaustion (`no free leases`), relay via `ip helper-address`, rogue servers answering first on-segment. Journal lines follow dhcpd's format.
- **BIND:** zone-file subset (`$TTL`, `$ORIGIN`, SOA/NS/A/CNAME/MX/TXT/PTR, parentheses, relative names) with `named-checkzone`-style errors; authoritative answers (AA) for loaded zones, recursion via forwarders when reachable, SERVFAIL otherwise; edits apply only on `rndc reload`.
- **Windows DNS client:** positive answers cached for the record TTL; `ping`/`curl` use the cache, `nslookup` asks the server directly; `ipconfig /displaydns` and `/flushdns`. Single-label names get the connection-specific suffix.
- **HTTPS:** name resolution → TCP connect (SYN-ACK, RST = refused, silence = timeout) → certificate name check (Schannel/OpenSSL style error 60) → nginx virtual host response. Host firewalls can drop ports.
- **Voice quality:** a simplified ITU-T G.107 E-model turns simulated delay, jitter and loss into MOS.

## Time

The engine has a simulated clock (`advance(dt)`): STP timers, Windows APIPA DHCP retries every 300 s, fleet (camera) DHCP retries and T1 renewals, interface counters, syslog for storms and CDP. The game runs it in real time; `T` fast-forwards ×8.

## Known simplifications (do not teach these as fact)

- Command shells are subsets; output imitates real formats closely but is not byte-identical, and some strings vary between real software versions (notably curl error wording).
- ACL denies are silent drops (as if `no ip unreachables`), even though IOS sends ICMP administratively-prohibited by default.
- ARP failure at a router is a silent drop. No ARP cache timing, no gratuitous ARP / duplicate address detection.
- No TCP state machine, windowing or retransmission model; HTTP is request/response only.
- DHCP: no lease expiry or T2/rebinding for regular hosts; option 82 / relay-trust interactions with snooping are not modelled; DHCP unicast renewals at T1 are not modelled.
- Windows negative DNS caching is not modelled.
- STP: no max-age expiry for indirect failures, no TCN/MAC flush timing, no MST, RSTP proposal/agreement simplified to ~1 s.
- Loss, latency, jitter and MOS are illustrative, not derived from real queueing.
- Not modelled at all: IPv6, dynamic routing, wireless RF, VPN, NTP, SNMP/NetFlow, cloud, link aggregation, QoS.
