/* SIGNAL//ZERO — deliberately bounded, deterministic Network+ training simulation.
 * One source of truth for the client CLI, equipment CLI, mission triggers and HUD.
 * No packet-level emulation is claimed. */
(function (root) {
  'use strict';
  const EXPECTED_DNS = '10.42.1.20';
  const EXPECTED_ROUTE = '10.42.0.254';
  const LEVELS = [
    { id: 'L1', code: 'PHYSICAL / LAYER 1', title: 'THE BROKEN LINK',
      narrative: 'The district gateway is not reaching the access switch. The clinic reports a hard outage.',
      objective: 'Trace the uplink, then restore the correct physical patch at the rack.',
      skill: 'Cable paths, switch uplinks and link status',
      hint: ['Inspect the rack panel. Look for the gateway LAN port and the switch uplink.', 'A working copper connection needs both ends plugged into the correct ports.'] },
    { id: 'L2', code: 'NETWORK SERVICES / DHCP', title: 'NO ONE HAS AN ADDRESS',
      narrative: 'The link is up, but dispatch still cannot contact the gateway. Clients are self-assigning addresses.',
      objective: 'Diagnose the client, bring DHCP back online, and renew its lease.',
      skill: 'DHCP DORA sequence, APIPA and address leases',
      hint: ['At the dispatch PC, run ipconfig /all. An address in 169.254.0.0/16 is a warning sign.', 'Check the service console with services, use dhcp start, then renew the client address with ipconfig /renew.'] },
    { id: 'L3', code: 'NETWORK SERVICES / DNS', title: 'THE WRONG DESTINATION',
      narrative: 'Dispatch can contact the clinic by IP, but the clinic name leads to a dead machine.',
      objective: 'Compare IP and name tests, repair DNS, then verify the clinic web service.',
      skill: 'DNS A records, resolving names and isolating faults',
      hint: ['Try ping 10.42.1.20 and nslookup clinic.ops.example at dispatch. Compare their results.', 'At CORE-SRV use dns list and dns set clinic.ops.example 10.42.1.20. Then at DISPATCH run curl https://clinic.ops.example/health. Ping alone tests reachability, not HTTPS.'] },
    { id: 'L4', code: 'SWITCHING / SECURITY', title: 'UNINVITED GUEST',
      narrative: 'A guest device can reach clinic equipment. Traffic is leaking across trust boundaries.',
      objective: 'Separate guest devices, apply a routed access rule, then audit their reachability.',
      skill: 'VLANs, same-subnet traffic and inter-VLAN filtering',
      hint: ['At the switch, use show vlan. Guests should use VLAN 30, not the clinic VLAN 10.', 'Move switch port 6 to VLAN 30, then at the router use firewall deny guest clinic. Finish with audit guest. VLANs alone do not guarantee routed isolation.'] },
    { id: 'L5', code: 'ROUTING / END-TO-END', title: 'THE LAST HOP',
      narrative: 'The city services are back, but a remote backup endpoint is unreachable through the upstream router.',
      objective: 'Trace the failing path, fix the default next hop, then test the backup application.',
      skill: 'Default routes, next-hop gateways and path tracing',
      hint: ['At dispatch, run tracert 203.0.113.20. The trace ends at the wrong next-hop address.', 'At EDGE-RTR use show routes, then route set default 10.42.0.254. Verify the route with tracert and the application with curl https://backup.example.net/health.'] }
  ];
  const START = Object.freeze({
    uplink: false, dhcpRunning: false, lease: false,
    dnsRunning: true, dnsA: '10.42.1.99',
    guestVlan: 10, firewallDeny: false,
    defaultRoute: '10.42.0.99', verifiedClinic: false,
    verifiedGuests: false, verifiedRemote: false,
    stage: 0, score: 0, hintsUsed: 0, changes: 0
  });
  const PRETTY = { client: 'DISPATCH-01', server: 'CORE-SRV', switch: 'ACCESS-SW', router: 'EDGE-RTR' };
  function asHost(h) { return ({ pc: 'client', workstation: 'client', dispatch: 'client', srv: 'server', rtr: 'router', sw: 'switch' })[h] || h; }
  class NetworkSim {
    constructor(snapshot) {
      this.s = { ...START };
      this.events = [];
      if (snapshot && typeof snapshot === 'object') {
        for (const k of Object.keys(START)) if (Object.hasOwn(snapshot, k) && typeof snapshot[k] === typeof START[k]) this.s[k] = snapshot[k];
        this.s.stage = Math.max(0, Math.min(5, Math.round(this.s.stage)));
      }
      this.reconcile();
    }
    get stage() { return this.s.stage; }
    get done() { return this.s.stage === 5; }
    get levels() { return LEVELS; }
    get status() {
      const s = this.s;
      const leaseOK = s.uplink && s.lease;
      const linkOK = s.uplink;
      const clinicByIP = leaseOK;
      const dnsResolved = leaseOK && s.dnsRunning && s.dnsA === EXPECTED_DNS;
      const clinicByName = clinicByIP && dnsResolved;
      const guestCanReach = s.guestVlan === 10 || !s.firewallDeny;
      const guestSafe = s.guestVlan === 30 && !guestCanReach;
      const remoteRouteOK = leaseOK && s.defaultRoute === EXPECTED_ROUTE;
      return { linkOK, leaseOK, clientIP: s.lease ? '10.42.1.101' : (s.uplink ? '169.254.17.44' : '[disconnected]'),
        clinicByIP, dnsResolved, clinicByName, guestCanReach, guestSafe, remoteRouteOK,
        gatewayIP: '10.42.1.1', dnsIP: '10.42.1.10', clinicIP: EXPECTED_DNS };
    }
    serialize() { return { ...this.s }; }
    reset() { this.s = { ...START }; this.events = []; }
    reconcile() {
      const s = this.s; const st = this.status;
      // A live DHCP lease survives a server outage or momentary link loss; renewal is separate.
      if (!st.clinicByName) s.verifiedClinic = false;
      if (!st.guestSafe) s.verifiedGuests = false;
      if (!st.remoteRouteOK) s.verifiedRemote = false;
      const wins = [];
      const check = [
        () => this.status.linkOK,
        () => this.status.leaseOK,
        () => this.status.clinicByName && s.verifiedClinic,
        () => this.status.guestSafe && s.verifiedGuests,
        () => this.status.remoteRouteOK && s.verifiedRemote
      ];
      while (s.stage < 5 && check[s.stage]()) {
        const solved = s.stage;
        s.stage++;
        s.score += 500;
        wins.push({ index: solved, nextStage: s.stage, title: LEVELS[solved].title });
      }
      return wins;
    }
    patch(a, b) {
      const left = String(a).toLowerCase().trim(), right = String(b).toLowerCase().trim();
      if (left === right) return this.response(['The two ends must be different sockets.'], false);
      if (new Set([left, right]).size === 2 && [left, right].includes('gw-lan1') && [left, right].includes('sw-uplink')) {
        this.s.uplink = true; this.s.changes++;
        const wins = this.reconcile();
        return this.response(['Physical link established: GW-01 LAN1 ↔ SW-01 UPLINK.', 'PHY link: 1 Gbps full duplex / link state UP.', 'Green interface LEDs indicate physical link, not end-to-end service health.'], true, wins);
      }
      return this.response(['Cable connected to incompatible endpoints. The gateway uplink is still down.', 'Check both device labels and the path on the network diagram.'], false);
    }
    unpatch() { this.s.uplink = false; this.s.changes++; this.reconcile(); return this.response(['Uplink physically disconnected. Traffic is blocked even if a client retains its previous address lease.'], true); }
    response(lines, changed = false, wins = []) { return { lines, changed, wins, stage: this.s.stage, status: this.status }; }
    help(host) {
      if (host === 'client') return ['ipconfig /all', 'ipconfig /renew', 'ping <ip | hostname>', 'nslookup clinic.ops.example', 'tracert 203.0.113.20', 'curl https://<host>/health', 'route print', 'arp -a', 'help'];
      if (host === 'server') return ['services', 'dhcp status', 'dhcp start', 'dhcp stop', 'dns list', 'dns set <host> <ip>', 'dns start', 'dns stop', 'help'];
      if (host === 'switch') return ['show interfaces', 'show vlan', 'show mac', 'switch port <number> vlan <id>', 'help'];
      if (host === 'router') return ['show routes', 'show acl', 'route set default <next-hop>', 'firewall deny guest clinic', 'firewall allow guest clinic', 'audit guest', 'help'];
      return [];
    }
    command(who, raw) {
      const host = asHost(String(who || '').toLowerCase());
      const cmd = String(raw || '').replace(/\s+/g, ' ').trim();
      const lc = cmd.toLowerCase();
      if (!PRETTY[host]) return this.response(['Unknown system.'], false);
      if (!cmd) return this.response([], false);
      if (lc === 'help' || lc === '?') return this.response(['AVAILABLE COMMANDS:', ...this.help(host).map(x => '  '+x)], false);
      if (lc === 'clear' || lc === 'cls') return { ...this.response([], false), clear: true };
      let changed = false; const o = []; const s = this.s; const st = this.status;
      const requireHost = (h) => { if (host !== h) { o.push('Not supported on '+PRETTY[host]+'. Use its help command.'); return false; } return true; };
      if (lc === 'ipconfig /all' && requireHost('client')) {
        o.push('Windows IP Configuration', 'Ethernet adapter LAN:',
          '   Media State . . . . . . . : ' + (s.uplink ? 'Media connected' : 'Media disconnected'),
          '   IPv4 Address . . . . . . : ' + st.clientIP,
          '   Subnet Mask . . . . . . . : '+(st.leaseOK?'255.255.255.0':'255.255.0.0'),
          '   Default Gateway . . . . : '+(st.leaseOK?'10.42.1.1':'[not set]'),
          '   DHCP Enabled . . . . . . : Yes',
          '   DHCP Server  . . . . . . : '+(st.leaseOK?'10.42.1.10':'[unreachable]'),
          '   DNS Servers  . . . . . . : '+(st.leaseOK?'10.42.1.10':'[not set]'));
      } else if (lc === 'ipconfig /renew' && requireHost('client')) {
        if (!s.uplink) o.push('DHCP request failed: media disconnected.');
        else if (!s.dhcpRunning) o.push('DHCP DISCOVER sent; no DHCP OFFER received. Timed out.', s.lease?'Existing lease remains assigned until expiration.':'Client retained automatic private address 169.254.17.44.');
        else { s.lease=true; changed=true; o.push('DHCP DISCOVER → OFFER → REQUEST → ACK','Assigned 10.42.1.101/24   Gateway 10.42.1.1','Lease obtained from CORE-SRV 10.42.1.10.'); }
      } else if (lc.startsWith('ping ') && requireHost('client')) {
        const target = lc.slice(5).trim();
        if (!target) o.push('Usage: ping <destination>');
        else if (!st.leaseOK) o.push('PING '+target, 'Request could not be sent: no usable network configuration.', '0 replies; check the interface, IP address and DHCP.');
        else if (target === 'clinic.ops.example') {
          if (!s.dnsRunning) o.push('Ping request could not find host clinic.ops.example (DNS offline).');
          else if (s.dnsA !== EXPECTED_DNS) o.push('Pinging clinic.ops.example ['+s.dnsA+'] with 32 bytes of data:', 'Request timed out. 0 replies / 4 sent.');
          else { o.push('Pinging clinic.ops.example ['+EXPECTED_DNS+'] with 32 bytes of data:', ...Array(3).fill('Reply from '+EXPECTED_DNS+': bytes=32 time=2ms TTL=63'), '3 replies received. ICMP connectivity verified (HTTPS not yet tested).'); }
        } else if (['10.42.1.20', '10.42.1.1', '10.42.1.10', '10.42.1.101'].includes(target)) o.push('Pinging '+target+' with 32 bytes of data:', ...Array(3).fill('Reply from '+target+': bytes=32 time=1ms TTL=64'), 'Packets: Sent = 3, Received = 3, Lost = 0 (0% loss)');
        else if (target === '203.0.113.20' && st.remoteRouteOK) o.push('Pinging 203.0.113.20:', 'Reply from 203.0.113.20: bytes=32 time=18ms TTL=52');
        else o.push('PING '+target, target==='203.0.113.20' ? 'Reply from 10.42.1.1: Destination host unreachable.' : 'Request timed out.', '0 replies received.');
      } else if (lc.startsWith('nslookup') && requireHost('client')) {
        const target = lc.replace(/^nslookup\s*/, '') || 'clinic.ops.example';
        if (!st.leaseOK) o.push('DNS request timed out. No usable client network address.');
        else if (!s.dnsRunning) o.push('DNS request timed out: name server 10.42.1.10 not responding.');
        else if (target === 'clinic.ops.example') o.push('Server: CORE-SRV   Address: 10.42.1.10', 'Non-authoritative answer:', 'Name: clinic.ops.example', 'Address: '+s.dnsA, s.dnsA===EXPECTED_DNS?'Record currently matches the reachable clinic host.':'Note: A successful lookup does not prove the target is online.');
        else if (target === 'backup.example.net') o.push('Server: CORE-SRV   Address: 10.42.1.10','Name: backup.example.net','Address: 203.0.113.20');
        else o.push('** CORE-SRV cannot find '+target+': NXDOMAIN');
      } else if ((lc.startsWith('tracert ') || lc.startsWith('traceroute ')) && requireHost('client')) {
        const target = lc.replace(/^trace(?:rt|route)\s*/, '').trim();
        if (target !== '203.0.113.20') o.push('In this district scenario, traceroute target is 203.0.113.20.');
        else if (!st.leaseOK) o.push('Unable to trace route: client has no valid network configuration.');
        else if (s.defaultRoute !== EXPECTED_ROUTE) o.push('Tracing route to 203.0.113.20:', ' 1    <1 ms  10.42.1.1   (local router)', ' 2     *     10.42.0.99  (unreachable next hop)', 'Trace incomplete. Inspect the default route on EDGE-RTR.');
        else { o.push('Tracing route to 203.0.113.20:', ' 1    <1 ms  10.42.1.1   (EDGE-RTR)', ' 2     5 ms  10.42.0.254 (upstream)', ' 3    18 ms  203.0.113.20 (remote backup endpoint)', 'Trace complete. Routing path verified; test the application separately.'); }
      } else if (lc.startsWith('curl ') && requireHost('client')) {
        const url=lc.replace(/^curl\s+(-i\s+)?/, '').trim();
        if (!['https://clinic.ops.example/health','https://backup.example.net/health'].includes(url)) o.push('This training build exposes: curl https://clinic.ops.example/health or curl https://backup.example.net/health');
        else if (!st.leaseOK) o.push('curl: (7) Failed to connect: no usable network path.');
        else if (!s.dnsRunning) o.push('curl: (6) Could not resolve host: DNS service offline.');
        else if (url.includes('clinic.ops.example') && s.dnsA !== EXPECTED_DNS) o.push('Resolving clinic.ops.example → '+s.dnsA, 'curl: (28) Connection timed out on 443; stale DNS A record.');
        else if (url.includes('clinic.ops.example')) {o.push('HTTP/2 200 OK','server: clinic-health/1.0','content-type: application/json','{"service":"clinic","state":"healthy"}','HTTPS endpoint verified.');s.verifiedClinic=true;changed=true;}
        else if (!st.remoteRouteOK) o.push('curl: (7) Failed to connect to backup.example.net:443.', 'Local route uses unreachable next hop '+s.defaultRoute+'.');
        else {o.push('HTTP/2 200 OK','server: backup-api/1.0','content-type: application/json','{"backup":"ready","uploads":"accepted"}','Remote HTTPS application verified.');s.verifiedRemote=true;changed=true;}
      } else if (lc === 'route print' && requireHost('client')) o.push('IPv4 Route Table', '0.0.0.0/0 via '+(st.leaseOK?'10.42.1.1':'[no gateway]'), '10.42.1.0/24 On-link '+(st.leaseOK?'10.42.1.101':'[inactive]'));
      else if (lc === 'arp -a' && requireHost('client')) o.push('Interface: '+st.clientIP, ...(st.leaseOK?['10.42.1.1   02-42-1a-00-00-01 dynamic','10.42.1.20  02-42-1a-00-00-14 dynamic']:['No resolved neighbors.']));
      else if (lc === 'services' && requireHost('server')) o.push('CORE-SRV NETWORK SERVICES', 'DHCP : '+(s.dhcpRunning?'RUNNING':'STOPPED')+' / scope 10.42.1.100-10.42.1.199', 'DNS  : '+(s.dnsRunning?'RUNNING':'STOPPED')+' / clinic.ops.example → '+s.dnsA, 'Host : 10.42.1.10/24');
      else if (lc === 'dhcp status' && requireHost('server')) o.push('DHCP service: '+(s.dhcpRunning?'RUNNING':'STOPPED'), 'Scope 10.42.1.0/24 | pool 10.42.1.100 – 10.42.1.199', 'Active leases: '+(st.leaseOK?'1':'0'));
      else if (lc === 'dhcp start' && requireHost('server')) { s.dhcpRunning = true; changed=true; o.push('DHCP service started. Listening for DISCOVER broadcasts.', 'Clients must request/renew their address.'); }
      else if (lc === 'dhcp stop' && requireHost('server')) { s.dhcpRunning = false; changed=true; o.push('DHCP service stopped. Existing leases remain valid until their expiration; new leases and renewals will fail.'); }
      else if (lc === 'dns list' && requireHost('server')) o.push('DNS SERVICE '+(s.dnsRunning?'RUNNING':'STOPPED'),'zone clinic.ops.example', 'A  clinic.ops.example   '+s.dnsA+'   TTL=60s', 'Healthy clinic host (reference): 10.42.1.20');
      else if (lc.startsWith('dns set ') && requireHost('server')) {
        const match = /^dns set (\S+) (\d+\.\d+\.\d+\.\d+)$/i.exec(lc);
        if (!match || match[1] !== 'clinic.ops.example' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(match[2]) || match[2].split('.').some(x => +x > 255)) o.push('Usage: dns set clinic.ops.example <valid IPv4 address>');
        else { s.dnsA = match[2]; s.verifiedClinic=false; changed=true; o.push('A record updated: clinic.ops.example → '+s.dnsA, 'Training DNS cache invalidated. Verify from the client.'); }
      } else if (lc === 'dns start' && requireHost('server')) { s.dnsRunning=true; changed=true; o.push('DNS service started.'); }
      else if (lc === 'dns stop' && requireHost('server')) { s.dnsRunning=false; s.verifiedClinic=false; changed=true; o.push('DNS service stopped. Name resolution unavailable.'); }
      else if (lc === 'show interfaces' && requireHost('switch')) o.push('ACCESS-SW interface status:', 'Gi0/1  UPLINK  '+(s.uplink?'up/up   1000/full':'down/down'), 'Gi0/2  DISPATCH  up/up   1000/full', 'Gi0/6  GUEST-AP  up/up   1000/full  VLAN '+s.guestVlan, 'Errors: 0 | Discards: 0');
      else if (lc === 'show vlan' && requireHost('switch')) o.push('VLAN    NAME          PORTS', '10      CLINIC        Gi0/2'+(s.guestVlan===10?', Gi0/6':''), '30      GUEST         '+(s.guestVlan===30?'Gi0/6':'[none]'), 'Note: port 6 carries the guest access point.');
      else if (lc === 'show mac' && requireHost('switch')) o.push('MAC ADDRESS TABLE', '02:42:1A:00:00:64  Gi0/2 VLAN10', '02:42:1A:00:00:C8  Gi0/6 VLAN'+s.guestVlan);
      else if (lc.startsWith('switch port ') && requireHost('switch')) {
        const match = /^switch port (\d+) vlan (\d+)$/i.exec(lc);
        if (!match || +match[1] !== 6 || ![10,30].includes(+match[2])) o.push('This lab manages access port 6, with provisioned VLANs 10 (clinic) and 30 (guest).', 'Usage: switch port 6 vlan <10|30>');
        else { s.guestVlan=+match[2]; s.verifiedGuests=false; changed=true; o.push('ACCESS-SW Gi0/6 assigned to VLAN '+s.guestVlan+'.', 'Inter-VLAN routing policy is a separate security control.'); }
      } else if (lc === 'show routes' && requireHost('router')) o.push('EDGE-RTR IPv4 routing table', 'C  10.42.1.0/24 directly connected Gi0/1', 'C  10.42.0.0/24 directly connected Gi0/0', 'S* 0.0.0.0/0 via '+s.defaultRoute, s.defaultRoute===EXPECTED_ROUTE?'Next hop reachable.':'Warning: configured next hop is not responding.');
      else if (lc === 'show acl' && requireHost('router')) o.push('EDGE-RTR security policy', 'GUEST vlan 30 → CLINIC vlan 10 : '+(s.firewallDeny?'DENY':'ALLOW'), 'VLAN 10 local switching bypasses this routed policy.', 'Default outbound Internet policy: ALLOW');
      else if (lc.startsWith('route set default ') && requireHost('router')) {
        const ip = lc.replace('route set default ','').trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some(x => +x > 255)) o.push('Usage: route set default <IPv4 next-hop>');
        else { s.defaultRoute=ip; s.verifiedRemote=false; changed=true; o.push('Default route changed: 0.0.0.0/0 via '+ip, 'Check reachability with a fresh traceroute from dispatch.'); }
      } else if (lc === 'firewall deny guest clinic' && requireHost('router')) { s.firewallDeny=true; s.verifiedGuests=false; changed=true; o.push('Policy applied: deny VLAN30 → VLAN10.', 'Same-VLAN clients do not cross the router. Confirm source port VLAN, then run audit guest.'); }
      else if (lc === 'firewall allow guest clinic' && requireHost('router')) { s.firewallDeny=false; s.verifiedGuests=false; changed=true; o.push('Policy applied: allow VLAN30 → VLAN10. Review security impact.'); }
      else if (lc === 'audit guest' && requireHost('router')) {
        o.push('Synthetic access probe from GUEST-AP to CLINIC:', 'Switchport Gi0/6 VLAN: '+s.guestVlan,
          'Guest → clinic: '+(st.guestCanReach?'REACHABLE [EXPOSURE]':'BLOCKED [POLICY MATCH]'));
        if (st.guestSafe) { s.verifiedGuests=true; changed=true; o.push('Two protections verified: guest segment separated and routed access denied.'); }
        else if (s.guestVlan===10) o.push('Guest and clinic traffic share VLAN 10; router ACL cannot isolate same-segment traffic.');
        else o.push('Guest VLAN 30 is distinct, but inter-VLAN routing remains allowed.');
      } else o.push('Unknown command on '+PRETTY[host]+': '+cmd, 'Type help to see supported operations.');
      if (changed) s.changes++;
      const wins = this.reconcile();
      return this.response(o, changed, wins);
    }
  }
  root.SignalZeroSim = NetworkSim;
  root.SignalZeroLevels = LEVELS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { NetworkSim, LEVELS, START };
})(typeof window === 'undefined' ? globalThis : window);
