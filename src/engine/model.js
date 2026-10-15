// Topology model helpers: interface naming, MAC formatting, device and port factories.
// The whole network state is plain JSON so it can be saved, cloned and replayed.

const IF_TYPES = [
  { long: 'GigabitEthernet', short: 'Gi' },
  { long: 'FastEthernet', short: 'Fa' },
  { long: 'TenGigabitEthernet', short: 'Te' },
  { long: 'Vlan', short: 'Vl' },
  { long: 'Loopback', short: 'Lo' },
];

/**
 * Canonicalise an IOS interface name: "g0/1", "gi 0/1", "GigabitEthernet0/1.10" -> "Gi0/1", "Gi0/1.10".
 * Returns null when the type word is unknown or ambiguous.
 */
export function canonIf(text) {
  const m = /^([a-z]+)\s*(\d+(?:\/\d+)*(?:\.\d+)?)$/i.exec(String(text).trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  const hits = IF_TYPES.filter(t => t.long.toLowerCase().startsWith(word) || t.short.toLowerCase() === word);
  // "g" and "gi" both resolve to GigabitEthernet; "t"/"te" to TenGigabitEthernet.
  if (hits.length !== 1) return null;
  return hits[0].short + m[2];
}

export function longIf(name) {
  const m = /^([A-Za-z]+)(.*)$/.exec(name);
  if (!m) return name;
  const t = IF_TYPES.find(x => x.short === m[1]);
  return t ? t.long + m[2] : name;
}

export function parentIf(name) {
  const i = name.indexOf('.');
  return i < 0 ? name : name.slice(0, i);
}

// MACs are stored as 12 lowercase hex chars.
export function macFromIndex(deviceIndex, portIndex = 0) {
  const v = (0x02421a000000 + deviceIndex * 0x100 + portIndex);
  return v.toString(16).padStart(12, '0');
}

export function macCisco(mac) {
  return `${mac.slice(0, 4)}.${mac.slice(4, 8)}.${mac.slice(8, 12)}`;
}

export function macWindows(mac) {
  return mac.toUpperCase().match(/../g).join('-');
}

export function macLinux(mac) {
  return mac.match(/../g).join(':');
}

export function portDefaults(name, extra = {}) {
  return {
    name,
    kind: 'eth', // eth | console | wifi
    media: 'copper', // copper | fiber | wifi
    adminUp: true,
    speed: 'auto',
    duplex: 'auto',
    caps: [10, 100, 1000],
    description: '',
    // switching
    mode: 'access',
    accessVlan: 1,
    allowed: 'all',
    native: 1,
    portfast: false,
    bpduguard: false,
    snoopTrust: false,
    errDisabled: null,
    // routed
    ip: null, // { addr, len }
    helpers: [],
    aclIn: null,
    aclOut: null,
    nat: null,
    proxyArp: false,
    unreachables: true,
    ...extra,
  };
}

let deviceCounter = 0;
export function resetDeviceCounter() { deviceCounter = 0; }

export function device(id, kind, os, opts = {}) {
  deviceCounter += 1;
  const idx = opts.index ?? deviceCounter;
  const d = {
    id,
    kind, // router | switch | host | bridge | fleet
    os, // ios | windows | linux | isp | none | appliance
    hostname: opts.hostname ?? id,
    model: opts.model ?? '',
    index: idx,
    mac: macFromIndex(idx, 0),
    managed: opts.managed ?? true,
    ports: {},
    map: opts.map ?? { x: 0, y: 0 },
    role: opts.role ?? '',
    zone: opts.zone ?? 'noc',
  };
  if (kind === 'switch') {
    d.vlans = { 1: 'default' };
    d.stp = { mode: 'pvst', disabled: [], priority: {} };
    d.snoop = { enabled: false, vlans: [] };
    d.logging = [];
  }
  if (kind === 'router') {
    d.subifs = {};
    d.routes = [];
    d.acls = {};
    d.nat = [];
    d.logging = [];
  }
  if (kind === 'host' || kind === 'fleet') {
    d.nic = opts.nic ?? 'eth0';
    d.ipcfg = opts.ipcfg ?? { dhcp: true, static: null };
    d.lease = null;
    d.released = false;
    d.apipa = opts.apipa ?? null;
    d.dnsCache = {};
    d.services = opts.services ?? {};
    d.files = opts.files ?? {};
    d.firewall = opts.firewall ?? { icmp: true, drop: [] };
    d.ttl = os === 'windows' ? 128 : 64;
    d.journal = [];
  }
  if (kind === 'fleet') {
    d.count = opts.count ?? 10;
    d.leases = []; // [{ mac, addr, len, gw, server }]
    d.nextRetry = 0;
  }
  return d;
}

export function addPort(dev, name, extra = {}) {
  const idx = Object.keys(dev.ports).length + 1;
  dev.ports[name] = portDefaults(name, { mac: macFromIndex(dev.index, idx), ...extra });
  return dev.ports[name];
}

export function link(id, a, b, opts = {}) {
  return {
    id,
    a: { dev: a[0], port: a[1] },
    b: { dev: b[0], port: b[1] },
    media: opts.media ?? 'copper',
    lengthM: opts.lengthM ?? 3,
    cut: false,
    latencyMs: opts.latencyMs ?? 0.12,
    route: opts.route ?? null, // visual cable route hint
    patch: opts.patch ?? null, // patch panel id if this link runs through a patch cord
    label: opts.label ?? '',
  };
}

export function isL2Device(d) {
  return d.kind === 'switch' || d.kind === 'bridge';
}

export function isEndpoint(d) {
  return d.kind === 'host' || d.kind === 'fleet';
}
