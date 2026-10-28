// Apprenticeship lessons: teach a working system before a broken one.
// Every concept follows the same progression: the problem it solves -> a small working example made visible ->
// guided use (each command explained) -> a changed example with support -> a fault, only once its prerequisites
// were taught -> diagnose, repair, verify -> an unguided transfer case.
//
// Steps are completed by the network's actual state (live probes on the bench), never by typing an exact command,
// so any valid repair counts. Predictions and explanations are recorded for the playtest; they never block.
//
// step = {
//   id, kind: 'explain' | 'task', title, body: [short paragraphs], bench?: 'A' | 'P', fresh?: { variant, fault?, gw? },
//   support: 'guided' | 'supported' | 'independent',
//   predict?: { q, options: [{ text, correct?, why, misconception? }] },     (asked before the task, compared after)
//   goal?, commands?: [{ dev, text, words: [[word, meaning]] }],               (guided: every word explained)
//   done(ctx) -> bool, learned: [paragraphs] shown when done,
//   check?: { q, options: [...] }                                              (explain-back after the task)
//   hints?: [{ kind: 'concept' | 'evidence' | 'action', text }]               (supported only, concept first)
//   objectives: Network+ N10-009 objective ids
//   diagram?: 'docs'   troubleshooting steps: the diagram shows only what documentation would (names, addresses),
//                      not live gateways or ARP tables; those are evidence to gather with commands
// }
import { BENCH } from './bench.js';

const A = { ...BENCH.A, nobody: '192.168.10.99' };
const P = BENCH.P;

/** Misconceptions a wrong prediction reveals, and the short lesson that addresses each (shown after two misses). */
export const MISCONCEPTIONS = {
  'arp-remote': {
    title: 'ARP only works on your own network',
    body: [
      'An ARP request is a broadcast, and broadcasts stop at the router: a router does not forward them. So a host can only learn the MAC addresses of devices on its own network.',
      'To reach anything else, the host ARPs for its gateway (the router\'s address on the host\'s own network) and sends the frame there. The IP destination in the packet stays the far address the whole way.',
    ],
    replay: true,
  },
  'gateway-needed-locally': {
    title: 'Same network: no gateway involved',
    body: [
      'A host compares the destination with its own address and prefix length. If the destination is inside its own network, it delivers the packet itself: ARP for the destination, then one frame straight to it through the switch.',
      'The default gateway is only for destinations outside that range. Removing the gateway does not stop local traffic.',
    ],
    replay: true,
  },
  'switch-routes': {
    title: 'Switches forward frames; routers forward packets between networks',
    body: [
      'A switch reads only the Ethernet header (MAC addresses). It never looks at the IP address and never decides that a packet "should go to the router".',
      'A host that has no route for a destination does not send anything. Nothing reaches the switch, so the switch has nothing to forward.',
    ],
  },
  mask: {
    title: 'The prefix length decides who is local',
    body: [
      'The prefix length says how much of the address is the network part. /24: the first three numbers must match (192.168.10.x). /26: the network is a block of 64 addresses; 10.20.30.70/26 is in the block 10.20.30.64 to 10.20.30.127.',
      'Two addresses are on the same network only if they fall in the same block. A gateway, or any address you want to reach without a router, must be inside your own block.',
    ],
  },
  'error-means-remote': {
    title: 'Who is speaking in an error message?',
    body: [
      '"From 192.168.10.11 … Destination Host Unreachable" comes from the sender\'s own address: the sending PC itself is reporting that ARP for its next hop got no answer. Nothing left the local network.',
      'When a reply is lost on its way back, nobody reports anything: ping just shows no replies. Missing errors are evidence too.',
    ],
  },
};

const word = (w, m) => [w, m];

export const LESSONS = [
  {
    id: 'L01',
    code: 'APPRENTICESHIP · LESSON 1',
    title: 'Next hop',
    subtitle: 'Local delivery, ARP and the default gateway',
    minutes: 25,
    objectives: ['1.1', '1.4', '1.7', '5.1', '5.3', '5.5'],
    objectiveNotes: {
      '1.1': 'Layer 2 (Ethernet frames, MAC addresses, switches) vs Layer 3 (IP packets, routers)',
      '1.4': 'Broadcast (ARP request) vs unicast (ARP reply, echo request/reply)',
      '1.7': 'Subnets and CIDR prefix lengths (/24, /26); which addresses share a network',
      '5.1': 'Gather information, theory, test, fix, verify full functionality',
      '5.3': 'Incorrect default gateway; routing table and default routes; incorrect subnet mask (prediction only)',
      '5.5': 'ping, ip (ip route, ip route get, ip neigh), arp and tcpdump (the frame view prints tcpdump -n -e lines)',
    },
    prepares: ['M02', 'M04', 'M05'],
    placement: [
      { q: `PC-A is ${A['PC-A']}/24 and has no default gateway. Which of these can it reach?`, options: [{ text: `${A['PC-B']} only`, correct: true }, { text: `${A.SRV} only` }, { text: 'Both' }, { text: 'Neither: every host needs a gateway' }] },
      { q: `PC-A (gateway ${A['R1-lan']}) pings ${A.SRV}. Which IP address does PC-A ask about in its ARP request?`, options: [{ text: A.SRV }, { text: A['R1-lan'], correct: true }, { text: 'None: the switch finds the server' }] },
      { q: `PC-B is ${P['PC-B']}/26. Which of these addresses can be its default gateway?`, options: [{ text: '10.20.30.1' }, { text: P['R1-lan'], correct: true }, { text: P['R1-far'] }, { text: '10.20.30.130' }] },
      { q: 'A ping gets no replies and prints no error lines, but a capture shows the requests arriving at the server. What is the most likely cause?', options: [{ text: 'The server has no route back to the client', correct: true }, { text: 'The client has no default gateway' }, { text: 'The switch has the wrong MAC table' }] },
    ],
    steps: [
      {
        id: 'intro', kind: 'explain', title: 'The problem', bench: 'A',
        body: [
          'A computer can only put frames on its own cable. For every packet it sends, it must decide: is the destination on my own network, so I can deliver it myself, or do I hand it to a router?',
          'This lesson shows how a host makes that decision, how it finds the hardware (MAC) address to send to (ARP), and what a default gateway is for. You will watch a working network first, then change it, then fix one that someone else broke.',
          'Everything happens on this bench: two Ubuntu PCs and a server on two networks, joined by one router. The consoles accept real Ubuntu commands.',
        ],
        analogy: {
          text: 'Think of a building\'s internal mail: anything for your own floor goes straight to the desk; everything else goes to the mailroom.',
          tie: `On the bench, "your floor" is the network ${A.lan.net}/${A.lan.len}, a desk is found by its MAC address, and the mailroom is the router's interface ${A['R1-lan']}. The envelope's address (the destination IP) never changes on the way.`,
        },
        objectives: ['1.1'],
      },
      {
        id: 'address', kind: 'task', teaches: ['prefix'], title: 'Your address defines your network', bench: 'A', support: 'guided',
        body: [
          `PC-A has the address ${A['PC-A']}/24. The "/24" (the prefix length, also written as the mask 255.255.255.0) says that the first 24 bits, here the first three numbers, name the network. So PC-A's network is ${A.lan.net}/24: every address from 192.168.10.0 to 192.168.10.255.`,
        ],
        goal: 'Look at PC-A\'s address yourself.',
        commands: [{ dev: 'PC-A', text: 'ip -4 addr', words: [word('ip', 'the Linux networking tool (iproute2)'), word('-4', 'IPv4 only'), word('addr', 'show the interface addresses')] }],
        done: c => c.ran('PC-A', /^ip\s+(-4\s+)?a(d(d(r(e(s(s)?)?)?)?)?)?\b/),
        learned: [`"inet ${A['PC-A']}/24" on eth0: that is the address and prefix length. PC-B (${A['PC-B']}) is inside 192.168.10.0/24; the server (${A.SRV}) is not.`],
        check: { q: 'Which of these addresses is on PC-A\'s network?', options: [{ text: '192.168.10.200', correct: true, why: 'Its first three numbers are 192.168.10, the network part of a /24.' }, { text: '192.168.20.10', why: 'The third number differs, so it is on another /24 network (it is the server).', misconception: 'mask' }, { text: '192.168.1.10', why: '192.168.1 is a different network part.', misconception: 'mask' }] },
        objectives: ['1.7'],
      },
      {
        id: 'local', kind: 'task', teaches: ['on-link', 'arp', 'l2-vs-l3'], title: 'Same network: deliver it yourself', bench: 'A', support: 'guided',
        body: ['PC-A has no default gateway at all: run "ip route" and you will see a single line, the route to its own network.'],
        predict: {
          q: `PC-A has no default gateway. Will "ping ${A['PC-B']}" work?`,
          options: [
            { text: 'Yes: PC-B is on the same network, so PC-A delivers it directly', correct: true, why: 'Same-network delivery needs no gateway (RFC 1122, 3.3.1).' },
            { text: 'No: without a default gateway nothing can be reached', why: 'The gateway is only for destinations outside your network.', misconception: 'gateway-needed-locally' },
            { text: 'Only after the switch learns PC-B\'s IP address', why: 'Switches never learn IP addresses; they learn MAC addresses from frames.', misconception: 'switch-routes' },
          ],
        },
        goal: 'Ping PC-B from PC-A, then open the frame view to watch what happened.',
        commands: [{ dev: 'PC-A', text: `ping -c 3 ${A['PC-B']}`, words: [word('ping', 'send ICMP echo requests and wait for echo replies'), word('-c 3', 'send 3 and stop (without -c, Linux ping runs until Ctrl+C)'), word(A['PC-B'], 'the destination: PC-B')] }],
        done: c => c.pinged('PC-A', A['PC-B'], true),
        learned: [
          'Before the first echo, PC-A broadcast an ARP request: "who has 192.168.10.12? tell 192.168.10.11". The destination MAC ff:ff:ff:ff:ff:ff means everyone on this network, so SW1 flooded it out of every port. Only PC-B answered, with a unicast reply naming its MAC.',
          'Then each echo request went in one frame, straight from PC-A\'s MAC to PC-B\'s MAC. The switch forwarded by MAC address only; it never read the IP addresses. "ttl=64": nothing routed it.',
        ],
        objectives: ['1.1', '1.4', '5.5'],
      },
      {
        id: 'cache', kind: 'task', teaches: ['arp-cache', 'arp-failure'], title: 'What PC-A remembered', bench: 'A', support: 'guided',
        body: ['The answer to an ARP request is kept in the neighbour table (the ARP cache), so the next packets do not need to ask again.'],
        goal: 'Read PC-A\'s neighbour table, ping PC-B once more and compare the frames. Then see what happens when nobody answers ARP.',
        commands: [
          { dev: 'PC-A', text: 'ip neigh', words: [word('ip neigh', 'show the neighbour (ARP) table: IP address → MAC address, and how fresh the entry is')] },
          { dev: 'PC-A', text: `ping -c 1 ${A['PC-B']}`, words: [word('-c 1', 'a single echo')] },
          { dev: 'PC-A', text: `ping -c 2 ${A.nobody}`, words: [word(A.nobody, 'an address on PC-A\'s network that no device owns')] },
          { dev: 'PC-A', text: 'ip neigh', words: [word('ip neigh', 'look at the table again')] },
        ],
        predict: {
          q: 'When you ping PC-B again now, will PC-A broadcast another ARP request?',
          options: [
            { text: 'No: the MAC is still in its neighbour table', correct: true, why: 'The entry is REACHABLE, so PC-A sends the echo at once.' },
            { text: 'Yes: ARP happens before every packet', why: 'That would double the traffic; hosts cache ARP answers.' },
          ],
        },
        done: c => c.ran('PC-A', /^ip\s+(-4\s+)?n/) && c.pinged('PC-A', A['PC-B'], true, { after: 'neigh' }) && c.pinged('PC-A', A.nobody, false),
        learned: [
          `"${A['PC-B']} dev eth0 lladdr 02:00:00:00:0a:12 REACHABLE": the MAC PC-A learned. The second ping sent no ARP at all.`,
          'PC-B learned too: the request carried PC-A\'s addresses, so PC-B stored PC-A without asking (try "ip neigh" on PC-B). A few seconds later PC-B double-checks with a unicast ARP request, sent straight to PC-A\'s MAC: not every ARP request is a broadcast. An entry goes STALE after roughly half a minute without confirmation and is checked again when it is next used.',
          `For ${A.nobody} nobody answered: PC-A sent three broadcast requests (one per second on a real network), gave up, and printed "From ${A['PC-A']} icmp_seq=1 Destination Host Unreachable". That message comes from PC-A's own address: PC-A itself is saying it could not find a MAC for its next hop. "ip neigh" now lists ${A.nobody} as FAILED.`,
        ],
        check: { q: 'Where did PC-A\'s entry for 192.168.10.12 come from?', options: [{ text: 'PC-A broadcast an ARP request and PC-B replied', correct: true }, { text: 'The switch sent PC-A its MAC address table', misconception: 'switch-routes' }, { text: 'It was configured by hand' }] },
        objectives: ['1.4', '5.5'],
      },
      {
        id: 'offnet', kind: 'task', teaches: ['no-route'], title: 'Another network, no gateway', bench: 'A', support: 'guided',
        body: [`The server is ${A.SRV}, on 192.168.20.0/24: outside PC-A's network. PC-A still has no default gateway.`],
        predict: {
          q: `What happens when PC-A pings ${A.SRV}?`,
          options: [
            { text: `PC-A broadcasts an ARP request for ${A.SRV}`, why: 'PC-A only ARPs for addresses its routing table says are on its own link.', misconception: 'arp-remote' },
            { text: 'PC-A refuses at once: no route matches, so nothing is sent', correct: true, why: 'The kernel finds no route and returns "Network is unreachable" before any frame is built.' },
            { text: 'The switch passes it to the router anyway', why: 'Nothing is sent, so the switch never sees it; and switches do not route.', misconception: 'switch-routes' },
          ],
        },
        goal: 'Try it, then ask PC-A which route it would use.',
        commands: [
          { dev: 'PC-A', text: `ping -c 2 ${A.SRV}`, words: [word(A.SRV, 'the server, on another network')] },
          { dev: 'PC-A', text: 'ip route', words: [word('ip route', 'show the routing table: where each destination range is sent')] },
          { dev: 'PC-A', text: `ip route get ${A.SRV}`, words: [word('ip route get', 'ask the kernel which route it would use for one address, without sending anything')] },
        ],
        done: c => c.pingFailed('PC-A', A.SRV, 'no-route') && c.ran('PC-A', /^ip\s+(-4\s+)?r(o(u(t(e)?)?)?)?\s+get\b/),
        learned: [
          '"ping: connect: Network is unreachable" and an empty frame view: PC-A did not send a single frame. Its only route covers 192.168.10.0/24, and "ip route get" says the same: "RTNETLINK answers: Network is unreachable".',
          'To reach other networks a host needs a route, usually one default route ("default via …"): send everything that matches nothing else to this router.',
        ],
        objectives: ['5.3', '5.5'],
      },
      {
        id: 'gateway', kind: 'task', teaches: ['gateway', 'gateway-on-link', 'hosts-do-not-forward'], title: 'Add the default gateway', bench: 'A', support: 'guided',
        body: [
          `R1 is a router with one interface on each network: ${A['R1-lan']} on PC-A's network and ${A['R1-far']} on the server's. A default gateway must be an address PC-A can reach directly, so it is R1's address on PC-A's own network: ${A['R1-lan']}.`,
          'The change below is made at run time, the way an administrator tests a fix; it would not survive a reboot (permanent settings live in netplan or come from DHCP).',
        ],
        predict: {
          q: `After the gateway is added, PC-A pings ${A.SRV}. Whose MAC address does PC-A ask for?`,
          options: [
            { text: `The server's (${A.SRV})`, why: 'The server is on another network; PC-A can never ARP for it.', misconception: 'arp-remote' },
            { text: `R1's (${A['R1-lan']})`, correct: true, why: 'Off-network packets go to the gateway, so PC-A needs the gateway\'s MAC.' },
            { text: 'Nobody\'s: the router finds the server by itself', why: 'PC-A must still address the frame to R1\'s MAC, which it learns with ARP.' },
          ],
        },
        goal: 'Give PC-A a default gateway, then ping the server and follow the frames across both networks.',
        commands: [
          { dev: 'PC-A', text: `ip route add default via ${A['R1-lan']}`, words: [word('ip route add', 'add a route'), word('default', 'the route for every destination no other route matches (0.0.0.0/0)'), word('via', 'send those packets to this next hop'), word(A['R1-lan'], 'R1, on PC-A\'s own network')] },
          { dev: 'PC-A', text: `ping -c 3 ${A.SRV}`, words: [word(A.SRV, 'the server')] },
        ],
        done: c => c.reaches('PC-A', 'SRV') && c.verified('PC-A', A.SRV),
        learned: [
          `PC-A ARPed for ${A['R1-lan']}, not for the server, then sent the echo in a frame addressed to R1's MAC (02:00:00:00:0a:01) while the IP destination stayed ${A.SRV}.`,
          'R1 is a router, so it accepts the packet, looks up 192.168.20.0/24 (its eth1 network), lowers the TTL from 64 to 63 and sends a new frame from its own eth1 MAC, after ARPing for the server on that network. The reply comes back the same way: the server sends it to its own gateway, R1. "ttl=63" in the output is that one router hop.',
          'Only a router does this. A PC that receives a packet for someone else\'s IP address discards it (IP forwarding is off on hosts), so a default gateway has to be a router.',
        ],
        check: { q: `Run "ip neigh" on PC-A. Why is ${A.SRV} not in PC-A's neighbour table?`, options: [{ text: 'PC-A never sends frames to the server directly; it sends them to R1', correct: true }, { text: 'The server did not answer ARP', misconception: 'arp-remote' }, { text: 'The table only keeps one entry' }] },
        objectives: ['5.3', '1.1', '5.5'],
      },
      {
        id: 'return', kind: 'task', teaches: ['return-path'], title: 'Every reply needs a way back', bench: 'A', support: 'guided',
        body: [`Replies are packets too. The server answers ${A['PC-A']}, which is outside its own network, so the server needs its own route: its default gateway is ${A['R1-far']}.`],
        predict: {
          q: 'If the server\'s default route is removed, what will PC-A\'s ping show?',
          options: [
            { text: '"Destination Host Unreachable" lines', why: 'That message means the sender could not resolve its own next hop; PC-A\'s side is fine.', misconception: 'error-means-remote' },
            { text: '"Network is unreachable"', why: 'PC-A still has its route; it sends normally.' },
            { text: 'No replies and no error lines at all', correct: true, why: 'The request arrives, but the server cannot send the reply, and nothing reports that to PC-A.' },
          ],
        },
        goal: 'Remove the server\'s default route, watch PC-A\'s ping fail, then put the route back and verify.',
        commands: [
          { dev: 'SRV', text: 'ip route del default', words: [word('ip route del default', 'delete the server\'s default route')] },
          { dev: 'PC-A', text: `ping -c 2 ${A.SRV}`, words: [] },
          { dev: 'SRV', text: `ip route add default via ${A['R1-far']}`, words: [word(A['R1-far'], 'R1, on the server\'s own network')] },
          { dev: 'PC-A', text: `ping -c 2 ${A.SRV}`, words: [] },
        ],
        done: c => c.flag('sawNoReturn') && c.reaches('PC-A', 'SRV') && c.verified('PC-A', A.SRV),
        learned: [
          '"2 packets transmitted, 0 received, 100% packet loss" and nothing else: the frame view shows the requests reaching the server, which then had no route for the reply. Silence, not an error, is what a missing return path looks like.',
          'So "ping fails" never tells you which direction failed. Check both ends: the sender\'s route out, and the receiver\'s route back.',
        ],
        objectives: ['5.3', '5.1'],
      },
      {
        id: 'practice', kind: 'task', requires: ['prefix', 'gateway', 'gateway-on-link'], title: 'Your turn: a different network', fresh: { variant: 'P' }, bench: 'P', support: 'supported',
        body: [
          `This is Bench B, with different numbers. PC-B is ${P['PC-B']}/26 and has no default gateway; the server is ${P.SRV}. R1's addresses are ${P['R1-lan']} and ${P['R1-far']}.`,
          'A /26 network has 64 addresses. Here PC-B\'s network runs from 10.20.30.64 to 10.20.30.127.',
        ],
        predict: {
          q: 'Which address can be PC-B\'s default gateway?',
          options: [
            { text: '10.20.30.1', why: 'Not in 10.20.30.64–127, so PC-B cannot reach it directly (and nothing owns it).', misconception: 'mask' },
            { text: P['R1-lan'], correct: true, why: 'R1\'s address inside PC-B\'s /26.' },
            { text: P['R1-far'], why: 'That is R1\'s address on the server\'s network, not on PC-B\'s.', misconception: 'arp-remote' },
            { text: '10.20.30.130', why: 'Outside 10.20.30.64–127.', misconception: 'mask' },
          ],
        },
        goal: `Make PC-B reach the server (${P.SRV}) and prove it with a ping. No command list this time: use what you learned.`,
        done: c => c.reaches('PC-B', 'SRV') && c.verified('PC-B', P.SRV),
        hints: [
          { kind: 'concept', text: 'A default gateway must be on the host\'s own network. Which of R1\'s two addresses is between 10.20.30.64 and 10.20.30.127?' },
          { kind: 'evidence', text: '"ip route" on PC-B shows what it has now. The diagram shows R1\'s address on each network.' },
          { kind: 'action', text: `On PC-B: ip route add default via ${P['R1-lan']}, then ping -c 2 ${P.SRV}.` },
        ],
        learned: ['Same idea, different numbers: the gateway is always the router\'s address on your own network, and the prefix length decides what "your own network" is.'],
        objectives: ['1.7', '5.3'],
      },
      {
        id: 'fault', kind: 'task', diagram: 'docs', requires: ['gateway', 'arp-failure', 'on-link'], title: 'Ticket: PC-A cannot reach the server', fresh: { variant: 'A', gw: { 'PC-A': A['R1-lan'], 'PC-B': A['R1-lan'] }, fault: 'wrong-gateway' }, bench: 'A', support: 'supported',
        ticket: 'Back on Bench A. "Since this morning\'s change, PC-A cannot reach the server. PC-B is fine. Nothing was changed on the server." Find the cause, fix it, and prove the fix.',
        body: ['Work like an engineer: gather evidence, form a theory, test it, change one thing, verify. Hints start with the idea, not the command.'],
        goal: 'Restore PC-A → server without breaking PC-A → PC-B, and verify with a ping.',
        done: c => c.reaches('PC-A', 'SRV') && c.reaches('PC-A', 'PC-B') && c.verified('PC-A', A.SRV),
        hints: [
          { kind: 'concept', text: 'In "From 192.168.10.11 icmp_seq=1 Destination Host Unreachable", whose address is 192.168.10.11? The PC that prints that message is the one that could not find a MAC for its next hop.' },
          { kind: 'evidence', text: 'Compare PC-A\'s default route ("ip route") with R1\'s address on the diagram. "ip neigh" shows which next hop PC-A tried and whether it answered (FAILED).' },
          { kind: 'action', text: `Point the default route at R1: ip route replace default via ${A['R1-lan']} (or delete the wrong route and add the right one), then ping the server again.` },
        ],
        learned: [
          'Someone typed 192.168.10.254 as PC-A\'s gateway. That address is on the right network but nobody owns it, so ARP got no answer (FAILED) and PC-A itself reported Destination Host Unreachable. PC-B kept working because local traffic never uses the gateway.',
        ],
        check: { q: 'What did "From 192.168.10.11 … Destination Host Unreachable" tell you?', options: [{ text: 'PC-A itself got no ARP answer for its next hop', correct: true }, { text: 'The server refused the ping', misconception: 'error-means-remote' }, { text: 'R1 had no route to the server', misconception: 'error-means-remote' }] },
        objectives: ['5.1', '5.3', '5.5'],
      },
      {
        id: 'transfer', kind: 'task', diagram: 'docs', requires: ['gateway', 'hosts-do-not-forward', 'return-path', 'arp-cache'], title: 'On your own', fresh: { variant: 'P', gw: { 'PC-A': P['R1-lan'], 'PC-B': P['R1-lan'] }, fault: 'transfer' }, bench: 'P', support: 'independent',
        ticket: `Bench B. "PC-A (${P['PC-A']}) cannot reach the server (${P.SRV})." No coach and no hints. Find the cause, fix it, verify.`,
        body: ['This case is different from the last one. If you are truly stuck, "Show me" explains it, and the playtest records that you used it.'],
        goal: 'Restore PC-A → server and verify with a ping.',
        done: c => c.reaches('PC-A', 'SRV') && c.reaches('PC-A', 'PC-B') && c.verified('PC-A', P.SRV),
        explain: { q: 'In one or two sentences: what was wrong, and which evidence showed it?' },
        check: { q: 'Which statement matches what you found?', options: [{ text: 'PC-A\'s gateway was another PC, which does not forward packets', fault: 'gateway-is-host' }, { text: 'The server had no route back to PC-A', fault: 'no-return' }, { text: 'PC-A\'s gateway address belonged to nobody', fault: 'wrong-gateway' }, { text: 'The switch was dropping the frames' }] },
        reveal: {
          'gateway-is-host': `PC-A's default route pointed at ${P['PC-B']}, which is PC-B. ARP succeeded (ip neigh showed PC-B's MAC as REACHABLE), so there were no error lines, but PC-B is not a router: it discards packets for other addresses. Fix: ip route replace default via ${P['R1-lan']}.`,
          'no-return': `The server had no default route, so its replies to ${P['PC-A']} had nowhere to go: no replies and no errors on PC-A, while PC-A's own routes were correct. Fix on SRV: ip route add default via ${P['R1-far']}.`,
        },
        objectives: ['5.1', '5.3', '5.5'],
      },
    ],
    summary: [
      'A host decides with its address and prefix length: same network → ARP for the destination and deliver directly; other network → use a route, usually the default gateway, and ARP for the gateway.',
      'The IP destination stays the same end to end; the MAC addresses change at every router.',
      'A gateway must be on the host\'s own network. Every reply needs a route back.',
      'Evidence: "Network is unreachable" = no route, nothing sent; "From <own address> … Destination Host Unreachable" = ARP for the next hop failed; silence = lost somewhere further on, including on the way back.',
    ],
  },
];

export function lessonById(id) { return LESSONS.find(l => l.id === id) || null; }
