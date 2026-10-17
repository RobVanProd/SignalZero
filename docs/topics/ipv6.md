# IPv6 dual stack (Act II, M11)

The engine was IPv4-only. This build adds IPv6 next to it: addresses, SLAAC from Router Advertisements, Neighbor Discovery, ICMPv6, IPv6 routing and ACLs, AAAA records and dual-stack client behaviour. IPv4 is unchanged. IPv6 stays off until incident M11 turns it on.

## Engine

| Module | What it does |
|---|---|
| `src/engine/ipv6.js` | Address math. In state an address is a 32-digit lowercase hex string (JSON-safe, compared with `===`). IPv4 addresses stay numbers, so `typeof a === 'string'` tells the families apart. Parses every RFC 4291 §2.2 text form: `::`, leading zeros, embedded IPv4 in the last 32 bits, `[addr]`, `%zone` through `parseIp6Zone`. Formats to RFC 5952 §4: lowercase, longest zero run compressed (leftmost on a tie), never a single group; IOS prints the same text in uppercase. Also: prefix math on hex strings (no BigInt), modified EUI-64 (RFC 4291 appendix A), link-local, solicited-node, and `fmtAddr()`, which formats either family. |
| `src/engine/net6.js` | Host and router IPv6 state. Covers SLAAC (RFC 4862), Router Advertisements and Solicitations (RFC 4861), the IPv6 routing table, IPv6 ACLs and Neighbor Discovery. |
| `src/engine/trace6.js` | The IPv6 packet walk. `sendPacket()` and `probe()` in `trace.js` hand any packet whose destination is an IPv6 address to it, and return the same result shapes (`fwd.hops`, `kind`, `status`, `rttMs`, `pass`). |
| `services.js` | Adds `resolveName6` (AAAA), `lookupHost` (getaddrinfo with RFC 6724 ordering) and `asksAaaa` (which clients send AAAA queries). `httpRequest` now does Happy Eyeballs and accepts `opts.family` (4 or 6). Public DNS serves AAAA from `state.internet.names6`, and BIND zones serve AAAA records. |
| `parsers/zone.js`, `parsers/netplan.js` | AAAA records with BIND's error text. netplan: IPv6 addresses (inline or block lists), `routes: - to: default via: <IPv6>` (link-local allowed), `gateway6`, `accept-ra`. |

### State (all plain JSON)

- **Router:** `ipv6Routing` (`ipv6 unicast-routing`), `routes6 [{net,len,nh,iface,ad}]`, `acls6 {NAME:{entries}}`. Each port or subinterface can carry `ipv6 = { enable, addrs:[{addr,len,eui}], ll, raSuppress:null|'periodic'|'all', filterIn, filterOut }`.
- **Host:** `ipcfg.static6 = { addrs, gw }` (netplan), `ipcfg.acceptRa` (default true, as in networkd). `v6` holds what was learned from RAs, with absolute simulation times: `{ addrs:{prefix:{addr,temp,valid,pref,...}}, routers:{ll:{dev,iface,until}}, onlink:{...} }`.
- `timers.ra` drives periodic RAs. `v6RaMemo` detects interfaces that just started advertising.

### Behaviour

- **Link-local:** every IPv6-capable host NIC and every IPv6-enabled router interface has one. IOS and Ubuntu (networkd default `eui64`) use modified EUI-64. Windows uses a randomized interface ID that it keeps per adapter, and the same ID for its public SLAAC address. Output shows the zone: `%7` on Windows (the interface index, as in `arp -a`), `%eth0` on Linux.
- **Router Advertisements:** a router advertises on an interface only with `ipv6 unicast-routing`, the interface up with IPv6 enabled, and RAs not suppressed. `ipv6 nd ra suppress` stops periodic RAs but still answers Router Solicitations. `ipv6 nd ra suppress all` stops both (Cisco IOS IPv6 command reference). Periodic RAs go out every 200 s. An RA lists every global prefix of the interface (on-link and autonomous), with valid lifetime 2592000 s, preferred 604800 s and router lifetime 1800 s (the IOS defaults). Hosts send a Router Solicitation on link-up and on reboot. An inbound IPv6 traffic-filter on the router sees the RS: IOS ACLs implicitly permit only ND NS and NA, not RS.
- **SLAAC:** a host forms an address only from a /64 (RFC 4862 §5.5.3 d). From any prefix it learns the on-link prefix and the default router, which is the router's link-local address. Windows also creates a temporary address (RFC 4941; 7-day valid and 1-day preferred defaults) and prefers it as a source (RFC 6724 rule 7). Linux servers with static IPv4 also accept RAs, as networkd does unless `accept-ra: false`.
- **Neighbor Discovery** replaces ARP. A Neighbor Solicitation is flooded in the egress broadcast domain, and the owner answers with a Neighbor Advertisement. IPv6 ACLs apply to ND: an inbound filter on the owner (a router) sees the NS, and the resolving router's inbound filter sees the NA that comes back. A failure at a router is reported with ICMPv6 Destination Unreachable code 3, address unreachable (RFC 4861 §7.2.2). The IPv4 model treats ARP failure as a silent drop.
- **Packet walk** at each router: inbound traffic-filter, own address (link-local only on the ingress link), no forwarding without `ipv6 unicast-routing`, hop limit (ICMPv6 Time Exceeded), longest-prefix match (Destination Unreachable code 0 when there is no route), link-local source leaving its link (code 2), outbound traffic-filter, ND for the next hop. UDP to a router address gets code 4 (port unreachable) and TCP gets RST. Initial hop limit is 64 on IOS and Linux and 128 on Windows. There is no NAT and no fragmentation by routers.
- **Routing:** C and L (/128) routes plus `L FF00::/8 via Null0, receive` for display. S routes can be `P/len NH`, which is recursive through connected or static routes and installed only when it resolves, `P/len IF`, or `P/len IF NH`, which is installed while IF is up. A link-local next hop without an interface is rejected. Lookup is longest prefix, then administrative distance. ISP-PE routes the delegated `2001:db8:<site>::/48` to EDGE-RTR's WAN address `2001:db8:ffff:1::2` and does no proxy ND, so an interface-only default route fails, the same as in IPv4.
- **IPv6 ACLs:** `ipv6 access-list NAME`, entries `[sequence N] permit|deny ipv6|tcp|udp|icmp <src> [port] <dst> [port] [icmp-type] [established] [log]`, addresses written `any`, `host X` or `X/len`. Evaluation is top-down, first match wins. An ACL with at least one entry ends with the implicit `permit icmp any any nd-na`, `permit icmp any any nd-ns` and `deny ipv6 any any`, so an explicit `deny ipv6 any any` blocks ND. An empty or undefined ACL permits everything. Applied with `ipv6 traffic-filter NAME in|out`.
- **DNS:** AAAA records come from BIND zones and from the public resolver, over the clinic's IPv4 DNS transport. AAAA queries depend on the client. Windows sends one only when the host has an IPv6 address that is neither link-local nor Teredo, and not when the A query failed (Microsoft, DNS Client behaviour). On Linux, glibc's getaddrinfo, used by curl, ping and traceroute, always asks, even with only link-local addresses (sourceware bug 12377). nslookup (both OSes) and dig ask directly. The AAAA query uses a fixed source port, so it never shifts the engine's random stream.
- **Address selection and Happy Eyeballs:** a simplified RFC 6724 puts IPv6 first only when the host has a global IPv6 source and a route to the destination. curl tries the first family. If that fails at once, after a timeout or with an ICMP error, it tries the other. When both fail, curl reports the first family's error, as lib/connect.c does ("all eyeballers failed"). `ping` and `tracert` use the first address (`-4` / `-6` to choose), and `curl -4` / `-6` force a family.
- **Services:** listeners are dual-stack unless they name a family. The DHCP services are DHCPv4 only. An nginx server block can be IPv6-only: BACKUP's `backup6.example.net` site has `family: 6`.

## CLI

- **IOS (routers):**
  - Global and interface config: `ipv6 unicast-routing`, `ipv6 address X/len [eui-64]`, `ipv6 address FE80::X link-local`, `ipv6 enable`, `ipv6 nd ra suppress [all]`, `ipv6 traffic-filter`, the `ipv6 route` forms above, `ipv6 access-list` (prompt `(config-ipv6-acl)#`), and `no` forms.
  - Show commands: `show ipv6 interface [brief|IF]`, `show ipv6 route [static|connected|local|ADDR]`, `show ipv6 neighbors [IF]`, `show ipv6 access-list [NAME]`.
  - `ping` and `traceroute` to IPv6 addresses (`ping ipv6 X`, `source IF|ADDR`). A link-local destination prompts `Output Interface:` and takes the interface on the next line, as IOS does.
  - Running-config: `ipv6 unicast-routing` after `no ip domain lookup`, interface IPv6 lines after duplex/speed, `ipv6 route` lines after the `ip route` lines, `ipv6 access-list` blocks after the IPv4 ACLs.
  - Valid but unsimulated commands get the training-image note: `ipv6 nd ra dns server` (IOS XE 3.9S and later), DHCPv6 server commands, `show ipv6 protocols`.
- **Windows:**
  - `ipconfig` and `/all` show IPv6 Address, Temporary IPv6 Address and Link-local IPv6 Address with `%7`, the IPv6 router listed before the IPv4 gateway, and DHCPv6 IAID / Client DUID in `/all`.
  - `ping -4/-6` (IPv6 replies print no TTL), `tracert -4/-6`.
  - `nslookup` prints both records (`Addresses:` with IPv6 first) and takes `-type=AAAA|A`. `ipconfig /displaydns` shows AAAA entries (type 28).
  - `curl -4/-6/-v` (Happy Eyeballs lines), `route print [-4|-6]`, `netsh interface ipv6 show neighbors|addresses|route`. `ipconfig /renew6` explains that SLAAC, not DHCPv6, is in use.
- **Ubuntu:**
  - `ip a` (both families), `ip -6 addr|route|neigh`, `ip -4 a`, `ip n`.
  - `ping -4/-6`, `ping6`, `traceroute -4/-6`, `traceroute6`.
  - `dig AAAA` and `dig @<IPv6>`, `nslookup` (A and AAAA), `curl -4/-6/-v`.
  - `ss -tulpn` shows the `[::]` sockets. `netplan apply` handles the IPv6 settings.

## Mission M11 "THE OTHER STACK" (act 2)

The backup vendor freezes its IPv4 endpoint: `/health` still answers, read-only, so other topics' checks on `backup.example.net` keep passing. Uploads now go only to `backup6.example.net`, which has an AAAA record and no A record. Setup switches the `backup` flow to that name. It also adds an `ipv6` flow (DISPATCH-01 to the portal's IPv6 address, TCP 443, district `data`).

- **Start:** the ISP side is ready. The clinic has no IPv6, and every host has only its link-local address.
- **Goals:** EDGE-RTR routes IPv6 and has `::/0` installed; DISPATCH-01 has a SLAAC address in `2001:db8:42:10::/64` and a default router; CORE-SRV's backup check to `backup6` succeeds; DISPATCH-01 reaches the internet over IPv6.
- **Constraints:** IPv4 still works (clinic records, internet through PAT, guest portal, guest isolation).
- **Evidence:** an inside host gets 200 from `curl https://backup6.example.net/health`.
- **Accepted fixes:** a global or link-local-with-interface next hop, `eui-64` or `::1` on the LAN, and the commands in any order.
- **Pitfalls taught:**
  - Without `ipv6 unicast-routing` there are no RAs.
  - A LAN prefix other than /64 gives no SLAAC address.
  - A link-local next hop needs the exit interface.
  - There is no IPv6 NAT: the delegated /48 is routed, and the ISP routes it to `::2` specifically. An `eui-64` WAN address breaks the return path.
  - An explicit `deny ipv6 any any` blocks ND.

The coach (`COACH.M11`) has 10 steps: `ipconfig`, `nslookup`, `ip -6 route`, `show ipv6 interface brief`, `ipv6 unicast-routing`, the WAN address, the LAN /64 (ticks when DISPATCH-01 has SLAAC), the default route, `ipconfig` again (new `ipconfig6` event), and the verification curl.

**Challenge faults:**

- `ra-suppressed`: `ipv6 nd ra suppress all` on the clinic subinterface, with DISPATCH-01 and CORE-SRV rebooted.
- `ipv6-default-route`: `::/0` points at `2001:db8:ffff:1::9`. The route is installed because ::9 is on the connected /64, but ND then fails and EDGE-RTR returns address unreachable.
- `ipv6-acl-nd`: a WAN IPv6 ACL that ends in an explicit `deny ipv6 any any log`.

`buildHealthy` enables the `ipv6` flow. A challenge `reboot()` now also forgets RA-learned state, then solicits again.

## For integration (files this build may not edit)

- `src/ui/capture.js`: `pktLine()` formats `p.src`/`p.dst` with `fmtIp`. Switch to `fmtAddr` from `src/engine/ipv6.js`, because IPv6 packets carry hex strings. `describeFwd()` should also handle the new outcomes `addr-unreachable` ("ICMPv6 address unreachable") and `scope-unreachable` ("beyond scope of source address"), plus the `local-error` reason `nd-fail` ("Neighbor Solicitation for the next hop got no answer"). Its `no-address` text says "no IPv4 address", which for IPv6 means "IPv6 disabled".
- `src/ui/mapview.js`:
  - Line 142, the L3 interfaces table: add `l3Ifaces6(eng, d)` rows (`fmtIp6(a.addr)/len`).
  - Line 91, the device label: optionally add the host's global IPv6 address from `hostAddr6`.
  - The IPAM sheet: add the IPv6 plan (2001:db8:42::/48, VLAN n → 2001:db8:42:n::/64, WAN 2001:db8:ffff:1::/64).
- `src/ui/terminal.js` line 71: on IPv6-enabled hosts the Ubuntu login banner also prints an "IPv6 address for eth0:" line.
- `src/content/objectives.js`: 1.8 is now covered by M11 (IPv6 dual stack, SLAAC, ND, AAAA, Happy Eyeballs).
- Flows: the new flow id is `ipv6` (district `data`). After M11 the `backup` flow's label and URL change (`Records → offsite backup (IPv6)`).
- Engine API: `fmtAddr`/`fmtIp6`/`parseIp6` (ipv6.js), `hostAddr6`/`l3Ifaces6` (net6.js), `eng.routes6(id)`.

## Known simplifications (do not teach these as fact)

- **DAD:** Duplicate Address Detection always succeeds; duplicates are not detected.
- **Initial RAs:** RFC 4861 §6.2.4 allows up to 16 s between initial advertisements; here an interface that starts advertising reaches its hosts at once.
- **Withdrawn prefixes:** a prefix a router stops advertising is dropped by its hosts at that router's next RA. Real hosts keep the address until its lifetime ends, and IOS does not deprecate removed prefixes unless told to (`ipv6 nd prefix … 0 0`).
- **DNS transport:** no RDNSS and no DHCPv6. Clients keep their DHCPv4 DNS server and fetch AAAA records over IPv4, a common dual-stack design. `ipv6 nd ra dns server` exists on IOS XE 3.9S and later but is not simulated.
- **MTU and ICMPv6 extras:** no Path MTU discovery or Packet Too Big (one MTU everywhere), no ICMPv6 rate limiting, no redirects, no extension headers.
- **ND cache and default router choice:** there is no NUD state machine. Neighbour tables are derived from reachability, like `show ip arp` in this simulator: IOS `show ipv6 neighbors` lists every reachable neighbour, and ages and states are synthetic. Default router selection takes the first learned router, without router preference or NUD failover.
- **Windows addresses:** the randomized interface IDs and temporary addresses are deterministic hashes of the MAC, so replays are identical. Temporary addresses are not regenerated each day.
- **Linux addresses:** Linux uses EUI-64 with no privacy addresses (networkd default without `ipv6-privacy`).
- **Address selection:** RFC 6724 is simplified to the "usable source + route" rule and the temporary-address preference.
- **Happy Eyeballs timing:** the 200 ms head start and concurrent attempts are not timed. The second family is tried after the first fails, and the elapsed times printed are approximate.
- **TCP and ICMP errors:** Windows TCP is modelled as ignoring ICMP errors during connect (it times out), while Linux reports them at once. This is consistent with common behaviour but unverified for every Windows build.
- **ACL denies:** IPv6 ACL denies are silent drops, as in the IPv4 model; IOS may send ICMPv6 administratively prohibited.
- **Router without unicast-routing:** a router without `ipv6 unicast-routing` still originates IPv6 (ping, traceroute) using its own routes. Whether IOS uses its static routes there is unverified.
- **Out of scope:** cameras (the fleet device) are IPv4-only. The guest VLAN has no IPv6; the optional guest-VLAN step of the plan was not built.
- **ipconfig layout:** the simulator's `ipconfig` label formatter puts the colon two columns left of real Windows. This predates this build and was kept so the IPv6 lines line up with the IPv4 ones.

## Output wording sources

Strings were compared with primary sources on 17 Oct 2026. "Matches" means the format or text was confirmed; "Unverified" means it comes from documentation or experience and was not confirmed.

| Output | Verdict | Source |
|---|---|---|
| IOS `show ipv6 interface`: `IPv6 is enabled, link-local address is …`, `Global unicast address(es):`, `…, subnet is …/64 [EUI]`, `Joined group address(es):`, `ND DAD is enabled, number of DAD attempts: 1`, `ND reachable time is 30000 milliseconds (using 30000)`, `ND router advertisements are sent every 200 seconds`, `… live for 1800 seconds`, `ND advertised default router preference is Medium`, `Hosts use stateless autoconfig for addresses.` | Matches | [Cisco IOS IPv6 Command Reference, show ipv6 cef tr to show ipv6 in](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-s2.html) |
| IOS `show ipv6 interface`: `ND RAs are suppressed (periodic)` / `(all)`, `IPv6 is tentative … [TEN]` on a down interface, the inbound/outgoing access list lines | Unverified | — |
| IOS `show ipv6 interface brief`: name then `[up/up]`, link-local first, then global addresses, `unassigned` | Matches the order; exact padding unverified | [OpenClassrooms Packet Tracer lab](https://openclassrooms.com/courses/7688651-simulate-your-network-diagram-with-cisco-packet-tracer/7878639-check-the-status-of-your-router), Cisco command reference above |
| IOS `show ipv6 route`: `IPv6 Routing Table - default - N entries`, the Codes block, `via X, directly connected`, `S ::/0 [1/0]` + `via …` | Matches | [Cisco IOS IPv6 Command Reference, show ipv6 ri to show ipv6 si](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-s5.html) |
| IOS `show ipv6 route`: `via GigabitEthernet0/0, receive`, `L FF00::/8 [0/0] via Null0, receive` | Unverified (IOS 15 lab captures; the reference shows the 12.x `via ::, Null0` form) | — |
| IOS `show ipv6 neighbors`: header `IPv6 Address … Age Link-layer Addr State Interface`, columns, `REACH` | Matches; short interface names unverified (the reference prints `Ethernet2`) | [Cisco IOS IPv6 Command Reference, show ipv6 na to show ipv6 pr](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-s4.html) |
| IOS `show ipv6 access-list`: `IPv6 access list NAME`, `    permit … (N matches) sequence 10` | Matches | [Cisco IOS IPv6 Command Reference, show bgp ipv6 to show ipv6 cef](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-s1.html) |
| IPv6 ACLs end with implicit `permit icmp any any nd-na`, `permit icmp any any nd-ns`, `deny ipv6 any any`; an ACL needs one entry for the implicit deny to apply | Matches | [NetworkLessons: ACL IPv6 implicit statements](https://notes.networklessons.com/acl-ipv6-implicit-statements) |
| `ipv6 nd ra suppress` suppresses periodic RAs only, `… all` also solicited RAs | Matches | [Cisco IOS IPv6 Command Reference, ipv6 mo to ipv6 ospf da](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-i3.html) |
| `ipv6 nd ra dns server` introduced in IOS XE 3.9S | Matches | same page |
| `ipv6 route`: an interface must be given with a link-local next hop | Matches | [Cisco IOS IPv6 Command Reference, ipv6 ospf de to ipv6 sp](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book/ipv6-i4.html) |
| `% Interface has to be specified for a link-local nexthop` | Unverified (text from IOS experience) | — |
| IOS IPv6 ping `% No valid route for destination` / `Success rate is 0 percent (0/1)`, `Output Interface:` prompt for link-local, traceroute without the VRF line, `!H` for address unreachable | Unverified | — |
| Windows `ipconfig /all`: `IPv6 Address`, `Temporary IPv6 Address`, `Link-local IPv6 Address … fe80::…%13(Preferred)`, `Default Gateway` with the IPv6 router (`%zone`) first and the IPv4 gateway on the next line, `DHCPv6 IAID`, `DHCPv6 Client DUID` after `DHCP Server` | Matches | [cisco.goffinet.org, Prise d'information IPv6](https://cisco.goffinet.org/ccna/ipv6/prise-information-ipv6/) |
| `netsh interface ipv6 show neighbor` (layout, `Reachable (Router)`, `Permanent`, 33-33-… multicast MACs) and `netsh interface ipv6 show route` columns | Matches | same page |
| `netsh interface ipv6 show addresses` layout, `route print -6` column spacing and the wrapped long destinations | Unverified | [University of Tartu course (column meanings only)](https://courses.cs.ut.ee/all/MTAT.08.003/mat/1int/course/module6/6.2.1.6/6.2.1.6.html) |
| Windows `ping` IPv6 replies `Reply from X: time=Nms` (no TTL), `Destination net unreachable.` / `Destination host unreachable.` for ICMPv6 codes 0 / 3 | Unverified (consistent with the IP_STATUS aliases in ipexport.h) | — |
| Windows DNS Client: AAAA queried only with an IPv6 address that is not link-local or Teredo; no AAAA query when the A query timed out or failed | Matches for Vista and Server 2008; assumed unchanged in Windows 11 | [Microsoft: DNS Client Behavior in Windows Vista](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-vista/bb727035(v=technet.10)) |
| glibc `getaddrinfo` returns AAAA even when the host has only link-local IPv6 addresses | Matches | [sourceware bug 12377](https://sourceware.org/bugzilla/show_bug.cgi?id=12377) |
| curl `-v`: `* Host h:p was resolved.`, `* IPv6: …`, `* IPv4: …` (`(none)`), `*   Trying [v6]:443...`, `* Immediate connect fail for X: …`, `* connect to X port N from Y port M failed: …`, `Failed to connect to h port N after T ms: Couldn't connect to server`; when every family fails the first family's error is reported | Matches (curl 8.5.0, Ubuntu 24.04) | [lib/hostip.c](https://raw.githubusercontent.com/curl/curl/curl-8_5_0/lib/hostip.c), [lib/cf-socket.c](https://raw.githubusercontent.com/curl/curl/curl-8_5_0/lib/cf-socket.c), [lib/connect.c](https://raw.githubusercontent.com/curl/curl/curl-8_5_0/lib/connect.c) |
| curl on Windows: `Network unreachable` (WSAENETUNREACH) | Matches (curl 8.9.1) | [lib/strerror.c](https://raw.githubusercontent.com/curl/curl/curl-8_9_1/lib/strerror.c) |
| iputils ping over IPv6: `PING h (addr) 56 data bytes`, `From X icmp_seq=N Destination unreachable: No route` / `Address unreachable` / `Port unreachable` / `Beyond scope of source address`, `Time exceeded: Hop limit` | Matches (iputils 20240117) | [ping/ping6_common.c](https://raw.githubusercontent.com/iputils/iputils/20240117/ping/ping6_common.c) |
| `traceroute -6` default `80 byte packets` | Unverified | — |
| `ip -6 neigh`: `fe80::… dev eth0 lladdr … router STALE` | Matches | [cisco.goffinet.org](https://cisco.goffinet.org/ccna/ipv6/prise-information-ipv6/) |
| `ip -6 addr` flags for networkd SLAAC (`scope global dynamic mngtmpaddr noprefixroute`), `lo` `scope host noprefixroute`; `ip -6 route` `proto ra metric 1024 expires Ns pref medium` | Unverified (metrics differ between the kernel, networkd and NetworkManager) | — |
| BIND: a bad AAAA rdata fails with `bad IPv6 address` (DNS_R_BADAAAA) | Matches (BIND 9.18) | [aaaa_28.c](https://raw.githubusercontent.com/isc-projects/bind9/v9.18.28/lib/dns/rdata/in_1/aaaa_28.c), [result.c](https://raw.githubusercontent.com/isc-projects/bind9/v9.18.28/lib/isc/result.c) |
| Windows `nslookup`: `Addresses:  <v6>` + continuation `          <v4>`; `-type=AAAA` → `name\tAAAA IPv6 address = …`; NODATA prints `Name:` only | Unverified | — |
| BIND `nslookup`: one `Name:`/`Address:` pair per record, A then AAAA; `*** Can't find x: No answer` | Unverified | — |
| IOS RA defaults: interval 200 s, router lifetime 1800 s; prefix valid 2592000 s, preferred 604800 s | Matches | Cisco command reference (show ipv6 interface and show ipv6 interface prefix samples, ipv6-s2) |
| netplan: `addresses` with IPv6, `routes: - to: default  via: <IPv6>`, `gateway6` deprecated, `accept-ra`; error text for a malformed address | Syntax per netplan documentation; error strings unverified | — |
