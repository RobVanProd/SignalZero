// CompTIA Network+ N10-009 objective map (titles paraphrased from the published exam objectives).
// `coverage` states honestly what this build exercises. Not affiliated with or endorsed by CompTIA.
export const OBJECTIVES = [
  { id: '1.1', domain: 1, title: 'OSI reference model', coverage: 'partial', note: 'Packet trace viewer labels each hop by layer; no dedicated mission.' },
  { id: '1.2', domain: 1, title: 'Networking appliances, applications and functions', coverage: 'partial', note: 'Router, switch, AP, DHCP/DNS/web servers used in context; no device-selection mission.' },
  { id: '1.3', domain: 1, title: 'Cloud concepts and connectivity', coverage: 'none' },
  { id: '1.4', domain: 1, title: 'Ports, protocols, services and traffic types', coverage: 'core', note: 'UDP 53/67/68, TCP 443/554, SIP 5060 drive real outcomes; broadcast vs unicast in DHCP relay.' },
  { id: '1.5', domain: 1, title: 'Transmission media and transceivers', coverage: 'partial', note: 'Copper patching, console vs Ethernet ports, TDR. No fiber/optics budget yet.' },
  { id: '1.6', domain: 1, title: 'Topologies, architectures and types', coverage: 'partial', note: 'Redundant risers and failure domains (M06).' },
  { id: '1.7', domain: 1, title: 'IPv4 and IPv6 addressing', coverage: 'core', note: 'APIPA, subnet sizing, overlap, gateway placement (M02, M08, challenges); IPv6 prefixes, /64 for SLAAC, link-local, EUI-64, RFC 5952 notation (M11).' },
  { id: '1.8', domain: 1, title: 'Evolving use cases (IPv6, SDN/SD-WAN, VXLAN, zero trust...)', coverage: 'partial', note: 'IPv6 dual stack: SLAAC, router advertisements, neighbor discovery, link-local next hops, AAAA, IPv6 ACLs (M11). No SDN/SD-WAN/VXLAN/zero trust.' },
  { id: '2.1', domain: 2, title: 'Routing technologies (static, dynamic, NAT/PAT, FHRP...)', coverage: 'core', note: 'Static/default routes, recursive next hop, inter-VLAN routing, PAT. No dynamic routing yet.' },
  { id: '2.2', domain: 2, title: 'Switching technologies and features', coverage: 'core', note: 'VLANs, 802.1Q trunks, STP/RSTP, speed/duplex, PortFast, BPDU guard.' },
  { id: '2.3', domain: 2, title: 'Wireless devices and technologies', coverage: 'none', note: 'Wi-Fi is modelled only as a link; no RF, channels or WPA yet.' },
  { id: '2.4', domain: 2, title: 'Physical installation factors', coverage: 'partial', note: 'Racks, patch panels, labelling (M01). No power/PoE budget yet.' },
  { id: '3.1', domain: 3, title: 'Organizational processes and procedures (documentation, change management)', coverage: 'partial', note: 'IPAM sheet, change log, running vs startup config.' },
  { id: '3.2', domain: 3, title: 'Network monitoring technologies', coverage: 'partial', note: 'Syslog, interface counters, CPU, service flows. No SNMP/NetFlow.' },
  { id: '3.3', domain: 3, title: 'Disaster recovery concepts', coverage: 'none' },
  { id: '3.4', domain: 3, title: 'IPv4 and IPv6 network services (DHCP, DNS, NTP...)', coverage: 'core', note: 'DHCP scopes/relay/leases and client states, DNS zones/caching/forwarding, AAAA records and IPv6 SLAAC. No DHCPv6 or NTP yet.' },
  { id: '3.5', domain: 3, title: 'Network access and management methods', coverage: 'partial', note: 'Console access to devices; no VPN/jump host yet.' },
  { id: '4.1', domain: 4, title: 'Basic network security concepts', coverage: 'partial', note: 'Segmentation, least privilege for guests.' },
  { id: '4.2', domain: 4, title: 'Types of attacks', coverage: 'partial', note: 'Rogue DHCP / on-path risk (M10).' },
  { id: '4.3', domain: 4, title: 'Network security features, defense techniques and solutions', coverage: 'core', note: 'ACLs, DHCP snooping, BPDU guard.' },
  { id: '5.1', domain: 5, title: 'Troubleshooting methodology', coverage: 'core', note: 'Every incident requires evidence, a change, and verification; debriefs reconstruct the method.' },
  { id: '5.2', domain: 5, title: 'Cabling and physical interface issues', coverage: 'core', note: 'Unplugged/incorrect patch, duplex mismatch, counters, TDR.' },
  { id: '5.3', domain: 5, title: 'Network service issues', coverage: 'core', note: 'DHCP, DNS, VLAN, routing, ACL, STP loop faults.' },
  { id: '5.4', domain: 5, title: 'Performance issues', coverage: 'partial', note: 'Loss/jitter/MOS under duplex mismatch and broadcast storm.' },
  { id: '5.5', domain: 5, title: 'Tools and protocols for troubleshooting', coverage: 'core', note: 'ping, tracert/traceroute, pathping, nslookup/dig, curl, ipconfig/ip, show commands, journalctl.' },
];

export const DOMAINS = {
  1: { name: 'Networking Concepts', weight: 23 },
  2: { name: 'Network Implementation', weight: 20 },
  3: { name: 'Network Operations', weight: 19 },
  4: { name: 'Network Security', weight: 14 },
  5: { name: 'Network Troubleshooting', weight: 24 },
};
