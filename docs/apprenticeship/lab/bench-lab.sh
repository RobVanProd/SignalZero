#!/usr/bin/env bash
# Reference lab for Apprenticeship Lesson 1 ("Next hop"): the same bench network as the simulator, built from real
# Linux kernels with network namespaces, veth pairs and Linux bridges as switches. Every scenario the lesson teaches
# is run here with the real tools; outputs go to out/*.txt and frame captures to out/*.pcap (+ decoded .txt).
#
#   PC-A 192.168.10.11/24 ─┐                         ┌─ SRV 192.168.20.10/24 (default via 192.168.20.1)
#   PC-B 192.168.10.12/24 ─┴─ SW1 ── Gi0/0 R1 Gi0/1 ─┴─ SW2
#                                 192.168.10.1   192.168.20.1
# Run as root on a Linux host with iproute2, iputils-ping and tcpdump:  sudo ./bench-lab.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
rm -rf "$OUT"; mkdir -p "$OUT"
NS="pca pcb r1 srv sw1 sw2"
cleanup() { for n in $NS; do ip netns del "$n" 2>/dev/null; done; }
cleanup
trap cleanup EXIT
X() { ip netns exec "$@"; }

# Same MAC addresses as the simulator's bench (src/content/bench.js), so captures compare field by field.
MAC_PCA=02:00:00:00:0a:11; MAC_PCB=02:00:00:00:0a:12; MAC_SRV=02:00:00:00:14:10
MAC_R1_0=02:00:00:00:0a:01; MAC_R1_1=02:00:00:00:14:01

# veth <ns> <ifname> <mac> <switch> <switchport>
veth() {
  ip link add tmp0 type veth peer name tmp1
  ip link set tmp0 netns "$1"; X "$1" ip link set tmp0 name "$2"; X "$1" ip link set "$2" address "$3"
  ip link set tmp1 netns "$4"; X "$4" ip link set tmp1 name "$5"; X "$4" ip link set "$5" master br0
  X "$1" ip link set "$2" up; X "$4" ip link set "$5" up
}
# build <pca/len> <pcb/len> <r1 lan/len> <r1 far/len> <srv/len> <srv gateway>
build() {
  cleanup
  for n in $NS; do ip netns add "$n"; X "$n" ip link set lo up; X "$n" sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 2>/dev/null; done
  for s in sw1 sw2; do X $s ip link add br0 type bridge; X $s ip link set br0 up; done
  veth pca eth0 $MAC_PCA sw1 gi0-1
  veth pcb eth0 $MAC_PCB sw1 gi0-2
  veth r1 eth0 $MAC_R1_0 sw1 gi0-4
  veth r1 eth1 $MAC_R1_1 sw2 gi0-4
  veth srv eth0 $MAC_SRV sw2 gi0-1
  X pca ip addr add "$1" brd + dev eth0
  X pcb ip addr add "$2" brd + dev eth0
  X r1 ip addr add "$3" brd + dev eth0
  X r1 ip addr add "$4" brd + dev eth1
  X r1 sysctl -qw net.ipv4.ip_forward=1
  X srv ip addr add "$5" brd + dev eth0
  X srv ip route add default via "$6"
  sleep 1
}
build 192.168.10.11/24 192.168.10.12/24 192.168.10.1/24 192.168.20.1/24 192.168.20.10/24 192.168.20.1

# run <file> <ns> <command...>: prints the prompt line and the command's stdout+stderr and exit status
run() {
  local f="$OUT/$1.txt" n="$2"; shift 2
  { printf '%s$ %s\n' "$n" "$*"; X "$n" "$@" 2>&1; printf '[exit %s]\n' "$?"; } >> "$f"
}
cap_start() { X "$1" tcpdump -n -e -U -i "$2" -w "$OUT/$3.pcap" 2>/dev/null & CAP=$!; sleep 1; }
cap_stop() { sleep 1; kill "$CAP" 2>/dev/null; wait "$CAP" 2>/dev/null; tcpdump -n -e -r "$OUT/$1.pcap" 2>/dev/null | sed -E 's/^[0-9:.]+ //' > "$OUT/$1.frames.txt"; }
flushall() { for n in pca pcb r1 srv; do X $n ip neigh flush all 2>/dev/null; done; }

{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "kernel: $(uname -r)"
  echo "userland: $(. /etc/os-release; echo "$PRETTY_NAME")"
  echo "iproute2: $(ip -V)"
  echo "iputils: $(ping -V | head -1)"
  echo "tcpdump: $(tcpdump --version 2>&1 | head -1)"
  for k in base_reachable_time_ms retrans_time_ms ucast_solicit mcast_solicit delay_first_probe_time gc_stale_time; do echo "pca net.ipv4.neigh.eth0.$k = $(X pca sysctl -n net.ipv4.neigh.eth0.$k)"; done
  echo "r1 net.ipv4.ip_forward = $(X r1 sysctl -n net.ipv4.ip_forward)"
  echo "r1 net.ipv4.conf.eth0.proxy_arp = $(X r1 sysctl -n net.ipv4.conf.eth0.proxy_arp)"
  echo "IPv6 disabled in every namespace (the lesson is IPv4 only)."
} > "$OUT/00-environment.txt"

# ---- S1: same subnet, no default gateway
flushall
run 01-same-subnet pca ip -4 addr show dev eth0
run 01-same-subnet pca ip -4 addr
run 01-same-subnet pca ip route
run 01-same-subnet pca ip route get 192.168.10.12
cap_start pca eth0 01-same-subnet
run 01-same-subnet pca ping -c 3 192.168.10.12
cap_stop 01-same-subnet
run 01-same-subnet pca ip neigh
run 01-same-subnet pcb ip neigh
# a second ping: the neighbour entry is still REACHABLE, so no ARP is sent
cap_start pca eth0 01b-cached
run 01b-cached pca ping -c 1 192.168.10.12
cap_stop 01b-cached
# an address on the subnet that nobody owns: ARP fails, the sender itself reports it
cap_start pca eth0 01d-nobody
run 01d-nobody pca ping -c 2 192.168.10.99
cap_stop 01d-nobody
run 01d-nobody pca ip neigh
# after the reachable time runs out the entry goes STALE
sleep 50
run 01c-stale pca ip neigh

# ---- S2: off-subnet destination, no default route
flushall
cap_start pca eth0 02-no-gateway
run 02-no-gateway pca ip route get 192.168.20.10
run 02-no-gateway pca ping -c 2 192.168.20.10
cap_stop 02-no-gateway
run 02-no-gateway pca ip neigh

# ---- S3: add the default gateway
run 03-gateway pca ip route add default via 192.168.10.1
run 03-gateway pca ip route
run 03-gateway pca ip route get 192.168.20.10
cap_start pca eth0 03-gateway-pca
X srv tcpdump -n -e -U -i eth0 -w "$OUT/03-gateway-srv.pcap" 2>/dev/null & CAP2=$!; sleep 1
run 03-gateway pca ping -c 3 192.168.20.10
cap_stop 03-gateway-pca
kill $CAP2; wait $CAP2 2>/dev/null; tcpdump -n -e -r "$OUT/03-gateway-srv.pcap" 2>/dev/null | sed -E 's/^[0-9:.]+ //' > "$OUT/03-gateway-srv.frames.txt"
run 03-gateway pca ip neigh
run 03-gateway r1 ip neigh
run 03-gateway srv ip neigh
# command errors the learner can hit
run 03b-route-errors pca ip route add default via 192.168.10.1
run 03b-route-errors pca ip route add default via 192.168.20.1
run 03b-route-errors pca ip route add default via 192.168.30.1
run 03b-route-errors pca ip route add default via 192.168.10.300
run 03b-route-errors pca ip route add default 192.168.10.1
run 03b-route-errors pca ip route del default via 192.168.10.99
run 03b-route-errors pca ip route
run 03b-route-errors pca ip route del default
run 03b-route-errors pca ip route del default
run 03b-route-errors pca ip route add default via 192.168.10.1

# ---- S4: wrong default gateway (an address nobody owns on the subnet)
flushall
run 04-wrong-gateway pca ip route replace default via 192.168.10.254
run 04-wrong-gateway pca ip route
cap_start pca eth0 04-wrong-gateway
run 04-wrong-gateway pca ping -c 3 192.168.20.10
cap_stop 04-wrong-gateway
run 04-wrong-gateway pca ip neigh
run 04-wrong-gateway pca ping -c 2 192.168.10.12
run 04-wrong-gateway pca ip route get 192.168.20.10
# three valid repairs
run 04a-fix-replace pca ip route replace default via 192.168.10.1
run 04a-fix-replace pca ping -c 2 192.168.20.10
run 04b-fix-del-add pca ip route replace default via 192.168.10.254
run 04b-fix-del-add pca ip route del default
run 04b-fix-del-add pca ip route add default via 192.168.10.1
run 04b-fix-del-add pca ping -c 2 192.168.20.10
run 04c-fix-specific pca ip route replace default via 192.168.10.254
run 04c-fix-specific pca ip route add 192.168.20.0/24 via 192.168.10.1
run 04c-fix-specific pca ip route
run 04c-fix-specific pca ip route get 192.168.20.10
run 04c-fix-specific pca ping -c 2 192.168.20.10
run 04c-fix-specific pca ip route del 192.168.20.0/24 via 192.168.10.1
run 04c-fix-specific pca ip route replace default via 192.168.10.1

# ---- S5: the server has no route back (return path)
flushall
run 05-no-return srv ip route del default
cap_start srv eth0 05-no-return-srv
run 05-no-return pca ping -c 3 192.168.20.10
cap_stop 05-no-return-srv
run 05-no-return srv ip route get 192.168.10.11
run 05-no-return srv ping -c 1 192.168.10.11
run 05-no-return srv ip route add default via 192.168.20.1
run 05-no-return pca ping -c 2 192.168.20.10

# ---- S6: wrong prefix length on PC-A (/16): it thinks the server is on its own network
flushall
run 06-wrong-mask pca ip addr del 192.168.10.11/24 dev eth0
run 06-wrong-mask pca ip route
run 06-wrong-mask pca ip addr add 192.168.10.11/16 brd + dev eth0
run 06-wrong-mask pca ip route add default via 192.168.10.1
run 06-wrong-mask pca ip route
run 06-wrong-mask pca ip route get 192.168.20.10
cap_start pca eth0 06-wrong-mask
run 06-wrong-mask pca ping -c 3 192.168.20.10
cap_stop 06-wrong-mask
run 06-wrong-mask pca ip neigh
# the same fault with proxy ARP on the router (Cisco IOS enables it by default): it "works"
X r1 sysctl -qw net.ipv4.conf.eth0.proxy_arp=1
flushall
run 06b-proxy-arp pca ping -c 2 192.168.20.10
run 06b-proxy-arp pca ip neigh
X r1 sysctl -qw net.ipv4.conf.eth0.proxy_arp=0
# restore PC-A's /24 (deleting the address removed its routes, so the default route goes back too)
X pca ip addr del 192.168.10.11/16 dev eth0; X pca ip addr add 192.168.10.11/24 brd + dev eth0; X pca ip route add default via 192.168.10.1

# ---- S7: neighbour-table commands
run 07-neigh pca ip neigh flush dev eth0
run 07-neigh pca ip neigh
run 07-neigh pca ip neigh show 192.168.10.1
run 07-neigh pca ip n
run 07-neigh pca ip -4 neigh

# ---- S8: edge cases of the commands the lesson uses
flushall
run 08-edges pca ip route get 192.168.10.11
run 08-edges pca ip route get 192.168.10.999
run 08-edges pca ip route get
run 08-edges pca ip route show default
run 08-edges pca ip r
run 08-edges pca ip route add 192.168.20.5/24 via 192.168.10.1
run 08-edges pca ip route replace default via 192.168.10.254
run 08-edges pca ping -c 1 192.168.20.10
run 08-edges pca ping -c 4 192.168.20.10
run 08-edges pca ping -c 6 192.168.20.10
run 08-edges pca ip route replace default via 192.168.10.1
run 08-edges pca ip route add 192.168.20.0/24 dev eth0
run 08-edges pca ip route
run 08-edges pca ip route get 192.168.20.10
run 08-edges pca ping -c 2 192.168.20.10
run 08-edges pca ip route del 192.168.20.0/24 dev eth0
run 08-edges pca ip neigh flush
run 08-edges pca ip neigh show dev eth0
run 08-edges pca ip neigh flush all
run 08-edges pca ip neigh
# ping with no count runs until interrupted (SIGINT = Ctrl+C); it prints the summary when stopped
{ printf 'pca$ ping 192.168.10.12   (interrupted after ~3.5 s with SIGINT, as Ctrl+C would)\n'; X pca timeout -s INT 3.5 ping 192.168.10.12 2>&1; printf '[exit %s]\n' "$?"; } >> "$OUT/08-edges.txt"

# more command forms the simulator answers
run 08-edges pca ip route add default
run 08-edges pca ip route add default via 192.168.10.1 dev eth9
run 08-edges pca ip neigh show dev eth9
run 08-edges pca ip -4 addr show dev eth9
run 08-edges pca ip route del

# ---- S10: Bench B (the practice and transfer network): a /26, router at .126
build 10.20.30.70/26 10.20.30.100/26 10.20.30.126/26 10.20.31.1/24 10.20.31.25/24 10.20.31.1
run 10-practice pcb ip route
run 10-practice pcb ip route add default via 10.20.30.1
run 10-practice pcb ip route add default via 10.20.31.1
run 10-practice pcb ip route add default via 10.20.30.126
run 10-practice pcb ping -c 2 10.20.31.25
run 10-practice pcb ip neigh
# the gateway is another PC: ARP succeeds, the PC does not forward (ip_forward=0), the echo is silently dropped
run 11-gateway-is-host pca ip route add default via 10.20.30.100
cap_start pca eth0 11-gateway-is-host
run 11-gateway-is-host pca ping -c 2 10.20.31.25
cap_stop 11-gateway-is-host
run 11-gateway-is-host pca ip neigh
run 11-gateway-is-host pcb ip neigh
run 11-gateway-is-host pcb sysctl net.ipv4.ip_forward
run 11-gateway-is-host pca ip route replace default via 10.20.30.126
run 11-gateway-is-host pca ping -c 2 10.20.31.25
# no return route on Bench B
run 12-no-return-b srv ip route del default
run 12-no-return-b pca ping -c 2 10.20.31.25
run 12-no-return-b srv ip route add default via 10.20.31.1
run 12-no-return-b pca ping -c 2 10.20.31.25

# ---- S9: Ubuntu's command-not-found handler for commands a beginner may try (needs the command-not-found
# package and its database; skipped when absent). Output depends on the archive state when the DB was built.
if [ -x /usr/lib/command-not-found ] && [ -f /var/lib/command-not-found/commands.db ]; then
  PY=$(command -v python3.12 || command -v python3)
  for c in ipconfig ifconfig arp route netstat nmap; do { printf '$ %s\n' "$c"; "$PY" /usr/lib/command-not-found -- "$c" 2>&1; } >> "$OUT/09-command-not-found.txt"; done
fi
echo "done: $OUT"
