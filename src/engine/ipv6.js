// IPv6 address math. Addresses live in state as canonical 32-digit lowercase hex strings (JSON-safe, comparable
// with ===); IPv4 addresses stay unsigned 32-bit numbers, so `typeof a === 'string'` tells the families apart.
// Pure functions, no DOM, no BigInt in state. Covered by tests/unit/ipv6.test.js.
//
//  - Text forms: RFC 4291 section 2.2 (full, leading zeros dropped, one "::", trailing embedded IPv4 x:x:x:x:x:x:d.d.d.d).
//  - Output: RFC 5952 section 4 (lowercase, no leading zeros, the longest run of two or more zero groups compressed,
//    leftmost on a tie, a single zero group never compressed). IOS prints the same form in uppercase.
//  - Modified EUI-64 interface identifiers from a MAC: RFC 4291 appendix A (insert FFFE, invert the U/L bit).
//  - Link-local addresses: fe80::/64 + interface identifier (RFC 4291 2.5.6, RFC 4862 5.3).
import { fmtIp } from './ipv4.js';

const HEX4 = /^[0-9a-f]{1,4}$/i;

function parseV4Tail(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x, i) => x > 255 || (m[i + 1].length > 1 && m[i + 1][0] === '0'))) return null;
  return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
}

/** Parse an IPv6 address (no prefix length, no zone). Returns 32 lowercase hex digits or null. */
export function parseIp6(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  if (t.startsWith('[') && t.endsWith(']')) t = t.slice(1, -1);
  if (!t || /[^0-9a-fA-F:.]/.test(t)) return null;
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const groups = side => {
    if (side === '') return [];
    const parts = side.split(':');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1 && p.includes('.')) {
        const v4 = parseV4Tail(p);
        if (!v4) return null;
        out.push(...v4);
      } else if (HEX4.test(p)) out.push(p);
      else return null;
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  // an embedded IPv4 tail is only valid as the last 32 bits
  if (halves.length === 2 && halves[0].includes('.')) return null;
  let all;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // "::" stands for at least one group (RFC 4291 2.2)
    all = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    all = head;
    if (all.length !== 8) return null;
  }
  return all.map(g => g.toLowerCase().padStart(4, '0')).join('');
}

/** Split "addr%zone" (RFC 4007 section 11). Returns { addr, zone } or null. */
export function parseIp6Zone(text) {
  if (typeof text !== 'string') return null;
  const i = text.indexOf('%');
  if (i < 0) { const a = parseIp6(text); return a ? { addr: a, zone: null } : null; }
  const zone = text.slice(i + 1);
  if (!zone || /\s/.test(zone)) return null;
  const a = parseIp6(text.slice(0, i));
  return a ? { addr: a, zone } : null;
}

/** "2001:db8::/32" -> { addr, len }. The address part need not be the network address. */
export function parseCidr6(text) {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(String(text).trim());
  if (!m) return null;
  const addr = parseIp6(m[1]);
  const len = Number(m[2]);
  if (addr === null || len > 128 || m[2].length > 1 && m[2][0] === '0') return null;
  return { addr, len };
}

export const groupsOf = hex => hex.match(/.{4}/g).map(g => parseInt(g, 16));

/** RFC 5952 text (lowercase). */
export function fmtIp6(hex) {
  if (typeof hex !== 'string' || hex.length !== 32) return String(hex);
  const g = groupsOf(hex);
  // RFC 5952 5: an IPv4-mapped address is written with a dotted quad
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `::ffff:${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const h = x => x.toString(16);
  if (bestLen < 2) return g.map(h).join(':');
  return `${g.slice(0, best).map(h).join(':')}::${g.slice(best + bestLen).map(h).join(':')}`;
}

/** Cisco IOS prints IPv6 addresses compressed the same way, in uppercase. */
export const fmtIp6Ios = hex => fmtIp6(hex).toUpperCase();

/** Family-aware formatter: IPv4 numbers -> dotted quad, IPv6 hex strings -> RFC 5952. */
export function fmtAddr(a) {
  if (typeof a === 'string') return fmtIp6(a);
  return fmtIp(a); // anything else formats exactly as the IPv4 formatter always did
}

export const isV6 = a => typeof a === 'string' && a.length === 32;

// ---------------------------------------------------------------- prefix math (on hex strings, no BigInt)

const NIB_MASK = [0x0, 0x8, 0xc, 0xe];

/** Network address of hex/len. */
export function prefix6(hex, len) {
  const full = Math.floor(len / 4);
  let out = hex.slice(0, full);
  if (full < 32) {
    const rem = len % 4;
    if (rem) out += (parseInt(hex[full], 16) & NIB_MASK[rem]).toString(16);
    out = out.padEnd(32, '0');
  }
  return out;
}

export function inPrefix6(addr, net, len) {
  return prefix6(addr, len) === prefix6(net, len);
}

export function overlaps6(aNet, aLen, bNet, bLen) {
  const len = Math.min(aLen, bLen);
  return prefix6(aNet, len) === prefix6(bNet, len);
}

export const fmtCidr6 = (addr, len) => `${fmtIp6(prefix6(addr, len))}/${len}`;
export const fmtCidr6Ios = (addr, len) => `${fmtIp6Ios(prefix6(addr, len))}/${len}`;

/** Combine a /64 prefix with a 16-hex-digit interface identifier. */
export function withIid(prefixHex, iid) {
  return prefixHex.slice(0, 16) + iid;
}

export const ZERO6 = '0'.repeat(32);
export const LOOPBACK6 = '0'.repeat(31) + '1';
export const LINK_LOCAL_NET = 'fe80' + '0'.repeat(28);

/** fe80::/10 (RFC 4291 2.5.6). */
export function isLinkLocal6(hex) {
  return isV6(hex) && hex.slice(0, 2) === 'fe' && (parseInt(hex[2], 16) & 0xc) === 0x8;
}
export const isMulticast6 = hex => isV6(hex) && hex.startsWith('ff');
export const isUnspecified6 = hex => hex === ZERO6;
export const isLoopback6 = hex => hex === LOOPBACK6;
/** Global unicast in the sense hosts care about: not link-local, multicast, loopback or unspecified. */
export const isGlobal6 = hex => isV6(hex) && !isLinkLocal6(hex) && !isMulticast6(hex) && !isLoopback6(hex) && !isUnspecified6(hex);

/** Modified EUI-64 interface identifier from a 12-hex-digit MAC (RFC 4291 appendix A): 16 hex digits. */
export function eui64(mac) {
  const m = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (m.length !== 12) return null;
  const first = (parseInt(m.slice(0, 2), 16) ^ 0x02).toString(16).padStart(2, '0');
  return `${first}${m.slice(2, 6)}fffe${m.slice(6, 12)}`;
}

export function linkLocalFromIid(iid) {
  return 'fe80000000000000' + iid;
}

// ---------------------------------------------------------------- deterministic "random" interface identifiers

/** 32-bit FNV-1a over a string, as 8 hex digits. */
function fnv32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A 64-bit interface identifier that looks random but is a pure function of its inputs (so replays are identical
 * and no PRNG draw is spent). Used for Windows' randomized identifiers and temporary addresses.
 */
export function hashIid(...parts) {
  const s = parts.join('|');
  let iid = fnv32(s) + fnv32(s, 0x01234567);
  if (/^0+$/.test(iid)) iid = '0000000000000001';
  return iid;
}

/** Solicited-node multicast address (RFC 4291 2.7.1): ff02::1:ffXX:XXXX. */
export function solicitedNode(hex) {
  return 'ff020000000000000000' + '0001ff' + hex.slice(26);
}
