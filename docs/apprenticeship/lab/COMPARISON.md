# Lab vs simulator: command outputs

| Lab file | Host | Command | Result |
|---|---|---|---|
| 01-same-subnet | pca | `ip -4 addr show dev eth0` | match (compared) |
| 01-same-subnet | pca | `ip -4 addr` | match (compared) |
| 01-same-subnet | pca | `ip route` | match (compared) |
| 01-same-subnet | pca | `ip route get 192.168.10.12` | match (compared) |
| 01-same-subnet | pca | `ping -c 3 192.168.10.12` | match (compared) |
| 01-same-subnet | pca | `ip neigh` | match (compared (entry order ignored)) |
| 01-same-subnet | pcb | `ip neigh` | match (compared (entry order ignored)) |
| 01b-cached | pca | `ping -c 1 192.168.10.12` | match (compared) |
| 01d-nobody | pca | `ping -c 2 192.168.10.99` | match (compared) |
| 01d-nobody | pca | `ip neigh` | match (compared (entry order ignored)) |
| 01c-stale | pca | `ip neigh` | match (compared (entry order ignored)) |
| 02-no-gateway | pca | `ip route get 192.168.20.10` | match (compared) |
| 02-no-gateway | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 02-no-gateway | pca | `ip neigh` | match (compared (entry order ignored)) |
| 03-gateway | pca | `ip route add default via 192.168.10.1` | match (compared) |
| 03-gateway | pca | `ip route` | match (compared) |
| 03-gateway | pca | `ip route get 192.168.20.10` | match (compared) |
| 03-gateway | pca | `ping -c 3 192.168.20.10` | match (compared) |
| 03-gateway | pca | `ip neigh` | match (compared (entry order ignored)) |
| 03-gateway | r1 | `ip neigh` | match (compared (entry order ignored)) |
| 03-gateway | srv | `ip neigh` | match (compared (entry order ignored)) |
| 03b-route-errors | pca | `ip route add default via 192.168.10.1` | match (compared) |
| 03b-route-errors | pca | `ip route add default via 192.168.20.1` | match (compared) |
| 03b-route-errors | pca | `ip route add default via 192.168.30.1` | match (compared) |
| 03b-route-errors | pca | `ip route add default via 192.168.10.300` | match (compared) |
| 03b-route-errors | pca | `ip route add default 192.168.10.1` | match (compared) |
| 03b-route-errors | pca | `ip route del default via 192.168.10.99` | match (compared) |
| 03b-route-errors | pca | `ip route` | match (compared) |
| 03b-route-errors | pca | `ip route del default` | match (compared) |
| 03b-route-errors | pca | `ip route del default` | match (compared) |
| 03b-route-errors | pca | `ip route add default via 192.168.10.1` | match (compared) |
| 04-wrong-gateway | pca | `ip route replace default via 192.168.10.254` | match (compared) |
| 04-wrong-gateway | pca | `ip route` | match (compared) |
| 04-wrong-gateway | pca | `ping -c 3 192.168.20.10` | match (compared) |
| 04-wrong-gateway | pca | `ip neigh` | match (compared (entry order ignored)) |
| 04-wrong-gateway | pca | `ping -c 2 192.168.10.12` | match (compared) |
| 04-wrong-gateway | pca | `ip route get 192.168.20.10` | match (compared) |
| 04a-fix-replace | pca | `ip route replace default via 192.168.10.1` | match (compared) |
| 04a-fix-replace | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 04b-fix-del-add | pca | `ip route replace default via 192.168.10.254` | match (compared) |
| 04b-fix-del-add | pca | `ip route del default` | match (compared) |
| 04b-fix-del-add | pca | `ip route add default via 192.168.10.1` | match (compared) |
| 04b-fix-del-add | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 04c-fix-specific | pca | `ip route replace default via 192.168.10.254` | match (compared) |
| 04c-fix-specific | pca | `ip route add 192.168.20.0/24 via 192.168.10.1` | match (compared) |
| 04c-fix-specific | pca | `ip route` | match (compared) |
| 04c-fix-specific | pca | `ip route get 192.168.20.10` | match (compared) |
| 04c-fix-specific | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 04c-fix-specific | pca | `ip route del 192.168.20.0/24 via 192.168.10.1` | match (compared) |
| 04c-fix-specific | pca | `ip route replace default via 192.168.10.1` | match (compared) |
| 05-no-return | srv | `ip route del default` | match (compared) |
| 05-no-return | pca | `ping -c 3 192.168.20.10` | match (compared) |
| 05-no-return | srv | `ip route get 192.168.10.11` | match (compared) |
| 05-no-return | srv | `ping -c 1 192.168.10.11` | match (compared) |
| 05-no-return | srv | `ip route add default via 192.168.20.1` | match (compared) |
| 05-no-return | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 06-wrong-mask | pca | `ip addr del 192.168.10.11/24 dev eth0` | state mirrored (ip addr add/del is not simulated) |
| 06-wrong-mask | pca | `ip route` | match (compared) |
| 06-wrong-mask | pca | `ip addr add 192.168.10.11/16 brd + dev eth0` | state mirrored (ip addr add/del is not simulated) |
| 06-wrong-mask | pca | `ip route add default via 192.168.10.1` | match (compared) |
| 06-wrong-mask | pca | `ip route` | match (compared) |
| 06-wrong-mask | pca | `ip route get 192.168.20.10` | match (compared) |
| 06-wrong-mask | pca | `ping -c 3 192.168.20.10` | match (compared) |
| 06-wrong-mask | pca | `ip neigh` | match (compared (entry order ignored)) |
| 06b-proxy-arp | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 06b-proxy-arp | pca | `ip neigh` | match (compared (entry order ignored)) |
| 07-neigh | pca | `ip neigh flush dev eth0` | match (compared) |
| 07-neigh | pca | `ip neigh` | match (compared (entry order ignored)) |
| 07-neigh | pca | `ip neigh show 192.168.10.1` | match (compared (entry order ignored)) |
| 07-neigh | pca | `ip n` | match (compared (entry order ignored)) |
| 07-neigh | pca | `ip -4 neigh` | match (compared (entry order ignored)) |
| 08-edges | pca | `ip route get 192.168.10.11` | match (compared) |
| 08-edges | pca | `ip route get 192.168.10.999` | match (compared) |
| 08-edges | pca | `ip route get` | match (compared) |
| 08-edges | pca | `ip route show default` | match (compared) |
| 08-edges | pca | `ip r` | match (compared) |
| 08-edges | pca | `ip route add 192.168.20.5/24 via 192.168.10.1` | match (compared) |
| 08-edges | pca | `ip route replace default via 192.168.10.254` | match (compared) |
| 08-edges | pca | `ping -c 1 192.168.20.10` | match (compared) |
| 08-edges | pca | `ping -c 4 192.168.20.10` | match (compared) |
| 08-edges | pca | `ping -c 6 192.168.20.10` | match (compared) |
| 08-edges | pca | `ip route replace default via 192.168.10.1` | match (compared) |
| 08-edges | pca | `ip route add 192.168.20.0/24 dev eth0` | match (compared) |
| 08-edges | pca | `ip route` | match (compared) |
| 08-edges | pca | `ip route get 192.168.20.10` | match (compared) |
| 08-edges | pca | `ping -c 2 192.168.20.10` | match (compared) |
| 08-edges | pca | `ip route del 192.168.20.0/24 dev eth0` | match (compared) |
| 08-edges | pca | `ip neigh flush` | match (compared) |
| 08-edges | pca | `ip neigh show dev eth0` | match (compared (entry order ignored)) |
| 08-edges | pca | `ip neigh flush all` | match (compared) |
| 08-edges | pca | `ip neigh` | match (compared (entry order ignored)) |
| 08-edges | pca | `ping 192.168.10.12   (interrupted after ~3.5 s with SIGINT, as Ctrl+C would)` | match (compared) |
| 08-edges | pca | `ip route add default` | match (compared) |
| 08-edges | pca | `ip route add default via 192.168.10.1 dev eth9` | match (compared) |
| 08-edges | pca | `ip neigh show dev eth9` | match (compared (entry order ignored)) |
| 08-edges | pca | `ip -4 addr show dev eth9` | match (compared) |
| 08-edges | pca | `ip route del` | differs, known: iproute2 prints its full 60-line usage text; the simulator prints the first line and a SIMULATOR note saying what to type (the usage text is not reproduced). |
| 10-practice | pcb | `ip route` | match (compared) |
| 10-practice | pcb | `ip route add default via 10.20.30.1` | match (compared) |
| 10-practice | pcb | `ip route add default via 10.20.31.1` | match (compared) |
| 10-practice | pcb | `ip route add default via 10.20.30.126` | match (compared) |
| 10-practice | pcb | `ping -c 2 10.20.31.25` | match (compared) |
| 10-practice | pcb | `ip neigh` | match (compared (entry order ignored)) |
| 11-gateway-is-host | pca | `ip route add default via 10.20.30.100` | match (compared) |
| 11-gateway-is-host | pca | `ping -c 2 10.20.31.25` | match (compared) |
| 11-gateway-is-host | pca | `ip neigh` | match (compared (entry order ignored)) |
| 11-gateway-is-host | pcb | `ip neigh` | match (compared (entry order ignored)) |
| 11-gateway-is-host | pcb | `sysctl net.ipv4.ip_forward` | lab check only |
| 11-gateway-is-host | pca | `ip route replace default via 10.20.30.126` | match (compared) |
| 11-gateway-is-host | pca | `ping -c 2 10.20.31.25` | match (compared) |
| 12-no-return-b | srv | `ip route del default` | match (compared) |
| 12-no-return-b | pca | `ping -c 2 10.20.31.25` | match (compared) |
| 12-no-return-b | srv | `ip route add default via 10.20.31.1` | match (compared) |
| 12-no-return-b | pca | `ping -c 2 10.20.31.25` | match (compared) |

110 of 111 compared commands match; 1 differ (1 known and listed above).

### 08-edges: pca$ ip route del
```diff
- Usage: ip route { list | flush } SELECTOR
-        ip route save SELECTOR
-        ip route restore
-        ip route showdump
-        ip route get [ ROUTE_GET_FLAGS ] ADDRESS
-                             [ from ADDRESS iif STRING ]
-                             [ oif STRING ] [ tos TOS ]
-                             [ mark NUMBER ] [ vrf NAME ]
-                             [ uid NUMBER ] [ ipproto PROTOCOL ]
-                             [ sport NUMBER ] [ dport NUMBER ]
-        ip route { add | del | change | append | replace } ROUTE
- SELECTOR := [ root PREFIX ] [ match PREFIX ] [ exact PREFIX ]
-             [ table TABLE_ID ] [ vrf NAME ] [ proto RTPROTO ]
-             [ type TYPE ] [ scope SCOPE ]
- ROUTE := NODE_SPEC [ INFO_SPEC ]
- NODE_SPEC := [ TYPE ] PREFIX [ tos TOS ]
-              [ table TABLE_ID ] [ proto RTPROTO ]
-              [ scope SCOPE ] [ metric METRIC ]
-              [ ttl-propagate { enabled | disabled } ]
- INFO_SPEC := { NH | nhid ID } OPTIONS FLAGS [ nexthop NH ]...
- NH := [ encap ENCAPTYPE ENCAPHDR ] [ via [ FAMILY ] ADDRESS ]
-       [ dev STRING ] [ weight NUMBER ] NHFLAGS
- FAMILY := [ inet | inet6 | mpls | bridge | link ]
- OPTIONS := FLAGS [ mtu NUMBER ] [ advmss NUMBER ] [ as [ to ] ADDRESS ]
-            [ rtt TIME ] [ rttvar TIME ] [ reordering NUMBER ]
-            [ window NUMBER ] [ cwnd NUMBER ] [ initcwnd NUMBER ]
-            [ ssthresh NUMBER ] [ realms REALM ] [ src ADDRESS ]
-            [ rto_min TIME ] [ hoplimit NUMBER ] [ initrwnd NUMBER ]
-            [ features FEATURES ] [ quickack BOOL ] [ congctl NAME ]
-            [ pref PREF ] [ expires TIME ] [ fastopen_no_cookie BOOL ]
- TYPE := { unicast | local | broadcast | multicast | throw |
-           unreachable | prohibit | blackhole | nat }
- TABLE_ID := [ local | main | default | all | NUMBER ]
- SCOPE := [ host | link | global | NUMBER ]
- NHFLAGS := [ onlink | pervasive ]
- RTPROTO := [ kernel | boot | static | NUMBER ]
- PREF := [ low | medium | high ]
- TIME := NUMBER[s|ms]
- BOOL := [1|0]
- FEATURES := ecn
- ENCAPTYPE := [ mpls | ip | ip6 | seg6 | seg6local | rpl | ioam6 | xfrm ]
- ENCAPHDR := [ MPLSLABEL | SEG6HDR | SEG6LOCAL | IOAM6HDR | XFRMINFO ]
- SEG6HDR := [ mode SEGMODE ] segs ADDR1,ADDRi,ADDRn [hmac HMACKEYID] [cleanup]
- SEGMODE := [ encap | encap.red | inline | l2encap | l2encap.red ]
- SEG6LOCAL := action ACTION [ OPTIONS ] [ count ]
- ACTION := { End | End.X | End.T | End.DX2 | End.DX6 | End.DX4 |
-             End.DT6 | End.DT4 | End.DT46 | End.B6 | End.B6.Encaps |
-             End.BM | End.S | End.AS | End.AM | End.BPF }
- OPTIONS := OPTION [ OPTIONS ]
- OPTION := { flavors FLAVORS | srh SEG6HDR | nh4 ADDR | nh6 ADDR | iif DEV | oif DEV |
-             table TABLEID | vrftable TABLEID | endpoint PROGNAME }
- FLAVORS := { FLAVOR[,FLAVOR] }
- FLAVOR := { psp | usp | usd | next-csid }
- IOAM6HDR := trace prealloc type IOAM6_TRACE_TYPE ns IOAM6_NAMESPACE size IOAM6_TRACE_SIZE
- XFRMINFO := if_id IF_ID [ link_dev LINK ]
- ROUTE_GET_FLAGS := [ fibmatch ]
+ Usage: ip route { list | flush } SELECTOR
```

# Lab vs simulator: frames

| Capture | Listening on | Result | Timing-dependent frames |
|---|---|---|---|
| 01-same-subnet | pca | match (8 frames) | lab: 0 unicast ARP confirmations; simulator: 2 marked "about 5 s later" |
| 01b-cached | pca | match (2 frames) | lab: 0 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
| 01d-nobody | pca | match (3 frames) | lab: 2 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
| 02-no-gateway | pca | match (0 frames) | lab: 0 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
| 03-gateway-pca | pca | match (8 frames) | lab: 0 unicast ARP confirmations; simulator: 2 marked "about 5 s later" |
| 03-gateway-srv | srv | match (8 frames) | lab: 0 unicast ARP confirmations; simulator: 2 marked "about 5 s later" |
| 04-wrong-gateway | pca | match (3 frames) | lab: 0 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
| 05-no-return-srv | srv | match (5 frames) | lab: 0 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
| 06-wrong-mask | pca | match (3 frames) | lab: 0 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
| 11-gateway-is-host | pca | match (4 frames) | lab: 0 unicast ARP confirmations; simulator: 0 marked "about 5 s later" |
