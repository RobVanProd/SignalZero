// IPv4 address math. Addresses are unsigned 32-bit integers internally.
// Pure functions, no DOM. Covered by tests/unit/ipv4.test.js.

export function parseIp(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255 || (m[i].length > 1 && m[i][0] === '0')) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

export function fmtIp(n) {
  n = n >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isValidIp(text) {
  return parseIp(text) !== null;
}

export function prefixToMask(len) {
  if (len <= 0) return 0;
  if (len >= 32) return 0xffffffff;
  return (0xffffffff << (32 - len)) >>> 0;
}

/** Returns the prefix length for a contiguous dotted mask, or null. */
export function maskToPrefix(maskText) {
  const m = typeof maskText === 'number' ? maskText >>> 0 : parseIp(maskText);
  if (m === null) return null;
  const inv = (~m) >>> 0;
  // contiguous iff inv+1 is a power of two
  if ((inv & (inv + 1)) !== 0) return null;
  let len = 0;
  for (let b = 31; b >= 0; b--) if ((m >>> b) & 1) len++;
  return len;
}

export function fmtMask(len) {
  return fmtIp(prefixToMask(len));
}

export function wildcardOf(len) {
  return fmtIp(~prefixToMask(len) >>> 0);
}

export function networkOf(ip, len) {
  return (ip & prefixToMask(len)) >>> 0;
}

export function broadcastOf(ip, len) {
  return (networkOf(ip, len) | (~prefixToMask(len) >>> 0)) >>> 0;
}

export function inSubnet(ip, net, len) {
  return networkOf(ip, len) === networkOf(net, len);
}

/** Usable host range. /31 (RFC 3021) and /32 handled explicitly. */
export function hostRange(ip, len) {
  const net = networkOf(ip, len);
  const bc = broadcastOf(ip, len);
  if (len === 32) return { first: net, last: net, count: 1 };
  if (len === 31) return { first: net, last: bc, count: 2 };
  return { first: (net + 1) >>> 0, last: (bc - 1) >>> 0, count: Math.max(0, bc - net - 1) };
}

export function isHostAddress(ip, len) {
  if (len >= 31) return true;
  return ip !== networkOf(ip, len) && ip !== broadcastOf(ip, len);
}

export function overlaps(aNet, aLen, bNet, bLen) {
  const len = Math.min(aLen, bLen);
  return networkOf(aNet, len) === networkOf(bNet, len);
}

/** Cisco-style wildcard match: bits set in the wildcard are "don't care". */
export function wildcardMatch(ip, base, wildcard) {
  const care = (~wildcard) >>> 0;
  return ((ip & care) >>> 0) === ((base & care) >>> 0);
}

export function parseCidr(text) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(text).trim());
  if (!m) return null;
  const ip = parseIp(m[1]);
  const len = Number(m[2]);
  if (ip === null || len > 32) return null;
  return { ip, len };
}

export function fmtCidr(ip, len) {
  return fmtIp(networkOf(ip, len)) + '/' + len;
}

export function isApipa(ip) {
  return inSubnet(ip, parseIp('169.254.0.0'), 16);
}

export function isPrivate(ip) {
  return inSubnet(ip, parseIp('10.0.0.0'), 8) ||
    inSubnet(ip, parseIp('172.16.0.0'), 12) ||
    inSubnet(ip, parseIp('192.168.0.0'), 16);
}

export function isLoopback(ip) {
  return inSubnet(ip, parseIp('127.0.0.0'), 8);
}

export function isMulticast(ip) {
  return inSubnet(ip, parseIp('224.0.0.0'), 4);
}

export const LIMITED_BROADCAST = 0xffffffff;
export const ZERO = 0;

/** Expand a VLAN/number list like "10,20-22" into a sorted array. */
export function parseRangeList(text, min = 1, max = 4094) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const p = part.trim();
    if (!p) return null;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < min || b > max || b < a) return null;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/** Compress a sorted number list into "1,10,20-22" form (IOS style). */
export function fmtRangeList(list) {
  const xs = [...list].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    parts.push(j > i ? `${xs[i]}-${xs[j]}` : String(xs[i]));
    i = j;
  }
  return parts.join(',');
}
