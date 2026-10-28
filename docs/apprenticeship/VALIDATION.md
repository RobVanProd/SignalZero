# Technical validation: Lesson 1 against real Linux

Question: does the bench behave like the same network built from real systems, for every command and outcome the lesson teaches? The simulator's own output is not used as evidence. The reference is a lab built from real kernels and the real tools.

## Reference lab

`docs/apprenticeship/lab/bench-lab.sh` (run as root; about 90 s) builds the bench from Linux network namespaces: one namespace per host and router, Linux bridges (STP off) for SW1 and SW2, veth pairs for cables. It uses the same addresses and MAC addresses as the simulator's bench. IPv6 is off, as on the bench. It then runs every scenario the lesson uses, plus edge cases, and saves:

- `lab/out/*.txt`: each command with its exact stdout+stderr and exit status;
- `lab/out/*.pcap`: frame captures (tcpdump on PC-A's or SRV's interface), decoded to `*.frames.txt` with `tcpdump -n -e`;
- `lab/out/00-environment.txt`: the platform and the kernel's ARP parameters.

| Item | Value (from `00-environment.txt`) |
|---|---|
| Kernel | Linux 6.18.44 |
| Userland | Ubuntu 24.04.5 LTS |
| iproute2 | 6.1.0 (`ip`) |
| iputils | 20240117 (`ping`) |
| tcpdump | 4.99.4 |
| ARP parameters | base_reachable_time 30 s, retrans_time 1 s, ucast_solicit 3, mcast_solicit 3, delay_first_probe_time 5 s |
| Router | `net.ipv4.ip_forward=1`, `proxy_arp=0` |
| Date | see `00-environment.txt` (last run 27 Oct 2026) |

Scenarios: same-subnet ping with no gateway; cached second ping; an address nobody owns; entry aging to STALE; off-subnet with no route; adding the gateway (captures on both networks); `ip route` error messages; wrong gateway and three valid repairs; missing return route; wrong prefix length (/16), with and without proxy ARP; neighbour table commands; command edge cases (`ip route get` on its own address, malformed input, `ping` with no count interrupted by SIGINT, `pipe N`); Bench B (/26) practice; gateway pointing at another PC; return path on Bench B; Ubuntu's command-not-found messages.

## Comparison

`node scripts/lab-compare.mjs` replays every lab command on the simulator's bench, in the lab's order, with the same state changes between scenarios. It compares output line by line and each capture frame by frame. `tests/unit/lab-conformance.test.js` runs the same comparison in `npm test`. The full table is in `lab/COMPARISON.md`.

Normalised before comparing (differences caused by the lab rig or real time, not by behaviour): interface index and veth `@ifN` suffix, `link-netns`, qdisc name, round-trip times and `time Nms`, ICMP ids, trailing spaces. `^C` is compared as the blank line ping prints after SIGINT, because a real terminal shows `^C` on that line. Neighbour tables are compared as sets: the kernel lists them in hash order.

Results on the final code:

| Check | Result |
|---|---|
| Command outputs (`ip addr`, `ip route` show/get/add/del/replace with every error, `ip neigh` show/flush, `ping` success/failure/no route/silence/`pipe N`/interrupted, R1's neighbour table) | **110 of 111 identical.** The one difference is deliberate: with no arguments `ip route del` prints iproute2's 60-line usage text; the simulator prints its first line and a SIMULATOR note. |
| Frame captures (10 captures, 2 listening points) | **10 of 10 identical** after setting aside unicast ARP confirmations. Those are sent about 5 s after a neighbour entry is used, so whether one falls inside a capture window depends on real timing. They are listed separately, and the simulator shows them as "about 5 seconds later". |
| Neighbour states after each scenario (REACHABLE, DELAY, STALE, FAILED; target learns sender; proxy-ARP entry pointing at the router's MAC) | Identical, as part of the command comparison |
| Ubuntu command-not-found (`ifconfig`, `arp`, `route`, `netstat`, `nmap`) | Identical. For `ipconfig`, the suggestions depend on the package archive snapshot; only the first and last lines are compared. |

### Does the comparison catch errors? (mutation check)

Each change below was injected into the simulator by itself, the comparison was run, and the change was reverted. The comparator flagged every one.

| Injected defect | Commands differing (of 111) | Captures differing (of 10) |
|---|---|---|
| Host ARPs for the remote destination instead of its gateway | 23 | 5 |
| The ARP target does not record the sender | 5 | 3 |
| Routers do not lower the TTL | 10 | 0 (tcpdump without `-v` does not print TTL; the `ttl=` field in ping output catches it) |
| `ping` omits `pipe N` | 7 | 0 |

### Also checked against the lab by the comparison

- A gateway that is another PC: ARP succeeds (REACHABLE), echo requests are delivered to PC-B's MAC, and PC-B drops them silently (`ip_forward=0`). The pinging PC shows 100 % loss with no error lines.
- A missing return route: requests reach the server, nothing comes back, and there are no error lines on the client.
- A wrong prefix length (/16): PC-A ARPs for the remote server directly and fails. With proxy ARP on at the router, it "works", and the neighbour entry for the server holds the router's MAC. This is in the lab and the scope notes only; the lesson does not use it as a fault (see LESSON-01 scope).

## Not validated (pending)

- **Windows.** No Windows reference machine was available. The bench has no Windows hosts. The campaign's Windows `ping`/`arp -a` output formats remain unverified against a real Windows 11 host. The change made here (`arp -a` reads the shared neighbour table) changes which entries appear, not the format. Microsoft's `ping` documentation describes flags, not error texts.
- **Cisco IOS.** R1's forwarding was compared with a Linux router (IPv4 forwarding, TTL, ARP, proxy ARP off). Its IOS console is not part of this lesson, and IOS output was not lab-verified.
- **Switch internals.** Linux bridges in the lab learn and age MAC addresses. The simulator's flood/forward decisions match the captured frames for these scenarios. MAC learning itself is not modelled.
- **Exact timings.** Real time is not reproduced (see "Accelerated time" in LESSON-01). The lab checks states and messages, not durations.
- **Rendering and devices.** The lesson UI was exercised in headless Chromium with software WebGL (`tests/browser/lesson.mjs`, desktop 1440×900 and a 390×844 phone), not on real phones or GPUs.
- **Learning.** None of the above shows that anyone learns from the lesson. That is what `PLAYTEST.md` is for.

## Reproduce

```bash
sudo ./docs/apprenticeship/lab/bench-lab.sh        # needs iproute2, iputils-ping, tcpdump (and optionally command-not-found)
node scripts/lab-compare.mjs > docs/apprenticeship/lab/COMPARISON.md
npm test                                           # includes tests/unit/lab-conformance.test.js
npm run build && npm run test:lesson               # the lesson through the real UI
```
