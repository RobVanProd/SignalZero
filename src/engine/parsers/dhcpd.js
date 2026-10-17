// Parser for a practical subset of ISC dhcpd.conf (4.4).
// Declarations: subnet { }, shared-network { }, pool { }, group { }, host { hardware ethernet; fixed-address; }.
// Parameters: range [dynamic-bootp] a [b]; authoritative / not authoritative; default/max/min-lease-time; every
// standard DHCP option (values of address, number and flag options are checked; unknown option names are errors);
// the server parameters ISC defines (ping-check, ping-timeout, one-lease-per-client, ddns-update-style,
// log-facility, ...) are accepted and ignored, as are allow/deny/ignore, include, failover, class, key, zone and
// on/if blocks. Error text follows dhcpd's own wording where practical.
//
// The parsed configuration is plain JSON (it lives in the engine state): enclosing scopes are referenced by id.
import { parseIp, maskToPrefix, networkOf, inSubnet, fmtIp } from '../ipv4.js';

// Server parameters (server/stables.c, server_options[]) that this simulator accepts and ignores.
const SERVER_PARAMS = new Set(('circuit-id remote-id agent-id link-selection relay-port dynamic-bootp-lease-cutoff dynamic-bootp-lease-length '
  + 'boot-unknown-clients dynamic-bootp allow-bootp allow-booting one-lease-per-client get-lease-hostnames use-host-decl-names '
  + 'use-lease-addr-for-default-route min-secs filename server-name next-server vendor-option-space site-option-space always-broadcast '
  + 'ddns-domainname ddns-hostname ddns-rev-domainname lease-file-name pid-file-name duplicates declines ddns-updates omapi-port local-port '
  + 'limited-broadcast-address remote-port local-address omapi-key stash-agent-options ddns-ttl ddns-update-style client-updates '
  + 'update-optimization ping-check update-static-leases log-facility do-forward-updates ping-timeout infinite-is-reserved '
  + 'update-conflict-detection leasequery adaptive-lease-time-threshold do-reverse-updates fqdn-reply preferred-lifetime '
  + 'limit-addrs-per-ia limit-prefs-per-ia delayed-ack max-ack-delay dhcp-cache-threshold dont-use-fsync ignore-client-uids '
  + 'log-threshold-low log-threshold-high echo-client-id server-id-check prefix-length-mode server-identifier ping-cltt-secs '
  + 'ping-timeout-ms abandon-lease-time').split(/\s+/));
const NUMERIC_PARAMS = new Set(['ping-timeout', 'min-secs', 'ddns-ttl', 'omapi-port', 'local-port', 'remote-port', 'dynamic-bootp-lease-length', 'adaptive-lease-time-threshold', 'max-ack-delay', 'delayed-ack', 'log-threshold-low', 'log-threshold-high', 'dhcp-cache-threshold', 'abandon-lease-time', 'ping-cltt-secs', 'ping-timeout-ms']);
const FLAG_PARAMS = new Set(['ping-check', 'one-lease-per-client', 'boot-unknown-clients', 'dynamic-bootp', 'allow-bootp', 'allow-booting', 'get-lease-hostnames', 'use-host-decl-names', 'use-lease-addr-for-default-route', 'always-broadcast', 'ddns-updates', 'stash-agent-options', 'client-updates', 'update-optimization', 'update-static-leases', 'do-forward-updates', 'infinite-is-reserved', 'update-conflict-detection', 'leasequery', 'do-reverse-updates', 'dont-use-fsync', 'ignore-client-uids', 'echo-client-id', 'server-id-check']);
const FLAG_WORDS = new Set(['true', 'false', 'on', 'off', 'yes', 'no', 'ignore']);

// DHCP option names (common/tables.c, dhcp_options[]) by value format:
//  ip: one or more IPv4 addresses   num: integer (signed for time-offset)   flag: boolean   text/any: not checked
const OPTION_KIND = {};
for (const n of ('subnet-mask time-servers ien116-name-servers domain-name-servers log-servers cookie-servers lpr-servers impress-servers '
  + 'resource-location-servers swap-server routers broadcast-address router-solicitation-address nis-servers ntp-servers netbios-name-servers '
  + 'netbios-dd-server font-servers x-display-manager dhcp-requested-address dhcp-server-identifier nisplus-servers mobile-ip-home-agent '
  + 'smtp-server pop-server nntp-server www-server finger-server irc-server streettalk-server streettalk-directory-assistance-server '
  + 'nds-servers subnet-selection tftp-server-address associated-ip policy-filter static-routes').split(/\s+/)) OPTION_KIND[n] = 'ip';
for (const n of ('time-offset boot-size max-dgram-reassembly default-ip-ttl path-mtu-aging-timeout interface-mtu arp-cache-timeout '
  + 'default-tcp-ttl tcp-keepalive-interval netbios-node-type dhcp-lease-time dhcp-option-overload dhcp-message-type dhcp-max-message-size '
  + 'dhcp-renewal-time dhcp-rebinding-time client-last-transaction-time v6-only-preferred auto-config loader-reboottime').split(/\s+/)) OPTION_KIND[n] = 'num';
for (const n of ('ip-forwarding non-local-source-routing all-subnets-local perform-mask-discovery mask-supplier router-discovery '
  + 'trailer-encapsulation ieee802-3-encapsulation tcp-keepalive-garbage').split(/\s+/)) OPTION_KIND[n] = 'flag';
for (const n of ('host-name merit-dump domain-name root-path extensions-path nis-domain netbios-scope dhcp-message nwip-domain nisplus-domain '
  + 'tftp-server-name bootfile-name user-class nds-tree-name nds-context uap-servers pcode tcode netinfo-server-tag default-url '
  + 'v4-captive-portal loader-configfile loader-pathprefix').split(/\s+/)) OPTION_KIND[n] = 'text';
for (const n of ('domain-search sip-ua-cs-domains path-mtu-plateau-table vendor-encapsulated-options dhcp-parameter-request-list '
  + 'vendor-class-identifier dhcp-client-identifier nwip-suboptions slp-directory-agent slp-service-scope fqdn relay-agent-information '
  + 'bcms-controller-names bcms-controller-address pxe-system-type pxe-interface-id pxe-client-id geoconf-civic netinfo-server-address '
  + 'name-service-search vivco vivso ipv4-address-andsf rdnss-selection v4-portparams pxelinux-magic option-6rd classless-static-routes '
  + 'rfc3442-classless-static-routes ms-classless-static-routes').split(/\s+/)) OPTION_KIND[n] = 'any';

// Blocks this subset recognises as valid but does not interpret: skipped up to the matching "}" (or ";").
const SKIP_BLOCKS = new Set(['class', 'subclass', 'key', 'zone', 'on', 'if', 'elsif', 'else', 'failover', 'omapi-key', 'switch', 'subnet6', 'host6']);

function tokenize(text) {
  const toks = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, li) => {
    const re = /"[^"]*"?|#.*$|[{};,]|[^\s{};,"#]+/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[0].startsWith('#')) break;
      toks.push({ v: m[0], line: li + 1 });
    }
  });
  return toks;
}

export function parseDhcpd(text, path = '/etc/dhcp/dhcpd.conf') {
  const toks = tokenize(text);
  let i = 0;
  const errors = [];
  const cfg = { authoritative: null, defaultLeaseTime: 43200, maxLeaseTime: 86400, options: {}, subnets: [], hosts: [], scopes: {}, warnings: [] };
  let scopeSeq = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const err = (line, msg) => { errors.push(`${path} line ${line}: ${msg}`); };
  const lastLine = () => (toks[i - 1] ? toks[i - 1].line : 1);
  const newScope = (kind, chain, name = null) => {
    const id = `${kind}${++scopeSeq}`;
    cfg.scopes[id] = { id, kind, name, options: {}, defaultLeaseTime: null, maxLeaseTime: null, authoritative: null, chain };
    return cfg.scopes[id];
  };

  function expectSemi() {
    const t = peek();
    if (!t || t.v !== ';') { err(t ? t.line : lastLine(), 'semicolon expected.'); return false; }
    i++;
    return true;
  }

  function readValues() {
    const vals = [];
    while (peek() && peek().v !== ';' && peek().v !== '{' && peek().v !== '}') {
      const t = next();
      if (t.v !== ',') vals.push(t);
    }
    return vals;
  }

  /** Skip a balanced { ... } block (or up to the next ";" if no block opens first). */
  function skipStatement() {
    let depth = 0;
    while (peek()) {
      const t = next();
      if (t.v === '{') depth++;
      else if (t.v === '}') { depth--; if (depth <= 0) { if (peek()?.v === ';') i++; return true; } }
      else if (t.v === ';' && depth === 0) return true;
    }
    if (depth > 0) { err(lastLine(), 'unexpected end of file'); return false; }
    return true;
  }

  function parseOption(scope) {
    const nameTok = next();
    if (!nameTok || nameTok.v === ';') { err(nameTok ? nameTok.line : lastLine(), 'expecting identifier after option keyword.'); return false; }
    if (nameTok.v === 'space') { readValues(); return expectSemi(); }
    let name = nameTok.v.toLowerCase();
    if (name.startsWith('dhcp.')) name = name.slice(5);
    if (name.includes('.')) { readValues(); return expectSemi(); } // option in another (user-defined) space
    const vals = readValues();
    if (vals[0]?.v === 'code') return expectSemi(); // option definition: "option foo code 224 = text;"
    if (!expectSemi()) return false;
    const kind = OPTION_KIND[name];
    if (!kind) { err(nameTok.line, `unknown option dhcp.${name}`); return false; }
    if (kind === 'ip') {
      const ips = [];
      for (const v of vals) {
        const ip = parseIp(v.v);
        if (ip === null) { err(v.line, `${v.v}: host unknown.`); return false; }
        ips.push(ip);
      }
      scope.options[name] = ips;
    } else if (kind === 'num') {
      if (!vals.length || !vals.every(v => /^-?\d+$/.test(v.v))) { err((vals[0] || nameTok).line, 'expecting numeric value.'); return false; }
      scope.options[name] = vals.map(v => Number(v.v));
    } else if (kind === 'flag') {
      if (!vals.length || !FLAG_WORDS.has(vals[0].v.toLowerCase())) { err((vals[0] || nameTok).line, 'expecting boolean value.'); return false; }
      scope.options[name] = vals[0].v.toLowerCase();
    } else if (name === 'domain-name') {
      scope.options[name] = (vals[0]?.v || '').replace(/"/g, '');
    } else {
      scope.options[name] = vals.map(v => v.v.replace(/"/g, ''));
    }
    return true;
  }

  /** A statement valid in any scope. Returns true, false (error) or null (not a parameter). */
  function parseParam(scope, t) {
    const w = t.v.toLowerCase();
    switch (w) {
      case 'option': return parseOption(scope);
      case 'default-lease-time':
      case 'max-lease-time':
      case 'min-lease-time': {
        const n = next();
        if (!n || !/^\d+$/.test(n.v)) { err(t.line, 'expecting numeric value.'); return false; }
        if (!expectSemi()) return false;
        if (w === 'default-lease-time') scope.defaultLeaseTime = Number(n.v);
        else if (w === 'max-lease-time') scope.maxLeaseTime = Number(n.v);
        return true;
      }
      case 'authoritative': if (!expectSemi()) return false; scope.authoritative = true; return true;
      case 'not': {
        const a = next();
        if (!a || a.v.toLowerCase() !== 'authoritative') { err(a ? a.line : t.line, 'expecting assertion'); return false; }
        if (!expectSemi()) return false;
        scope.authoritative = false;
        return true;
      }
      case 'allow': case 'deny': case 'ignore': readValues(); return expectSemi();
      case 'include': readValues(); return expectSemi();
      case 'hardware': case 'fixed-address': return null;
      default:
        if (SERVER_PARAMS.has(w)) {
          const vals = readValues();
          if (!expectSemi()) return false;
          if (NUMERIC_PARAMS.has(w) && !(vals.length && /^\d+$/.test(vals[0].v))) { err(t.line, 'expecting numeric value.'); return false; }
          if (FLAG_PARAMS.has(w) && vals.length && !FLAG_WORDS.has(vals[0].v.toLowerCase())) { err(vals[0].line, 'expecting boolean value.'); return false; }
          return true;
        }
        if (SKIP_BLOCKS.has(w)) return skipStatement();
        return null;
    }
  }

  function parseRange(sub, s, pool) {
    let a = next();
    if (a && a.v.toLowerCase() === 'dynamic-bootp') a = next();
    if (!a || a.v === ';') { err(s.line, 'expecting IP address.'); return false; }
    const b = peek() && peek().v !== ';' ? next() : a;
    if (!expectSemi()) return false;
    const ia = parseIp(a.v);
    const ib = parseIp(b.v);
    if (ia === null || ib === null) { err(s.line, 'expecting IP address.'); return false; }
    if (!inSubnet(ia, sub.net, sub.len) || !inSubnet(ib, sub.net, sub.len)) {
      errors.push(`Address range ${a.v} to ${b.v} not on net ${fmtIp(sub.net)}/${fmtIp((0xffffffff << (32 - sub.len)) >>> 0)}!`);
      return false;
    }
    const r = [Math.min(ia, ib), Math.max(ia, ib)];
    sub.ranges.push(pool ? [...r, pool.id] : r);
    return true;
  }

  function parseHost(t, chain) {
    const name = next();
    const open = next();
    if (!name || !open || open.v !== '{') { err(t.line, 'expecting left brace.'); return false; }
    const h = { name: name.v, mac: null, fixed: null, fixedAll: [] };
    const scope = newScope('host', chain, name.v);
    h.scope = scope.id;
    while (peek() && peek().v !== '}') {
      const s = next();
      if (s.v === ';') continue;
      if (s.v === 'hardware') {
        const kind = next();
        const mac = next();
        if (!kind || !mac || mac.v === ';') { err(s.line, 'expecting hardware address.'); return false; }
        if (!expectSemi()) return false;
        const hex = mac.v.toLowerCase().replace(/[:-]/g, '');
        if (!/^[0-9a-f]{12}$/.test(hex)) { err(mac.line, 'expecting hexadecimal constant.'); return false; }
        h.mac = hex;
      } else if (s.v === 'fixed-address') {
        const vals = readValues();
        if (!expectSemi()) return false;
        for (const v of vals) {
          const ip = parseIp(v.v);
          if (ip === null) { err(v.line, `${v.v}: host unknown.`); return false; }
          h.fixedAll.push(ip);
        }
        h.fixed = h.fixedAll[0] ?? null;
      } else {
        const r = parseParam(scope, s);
        if (r === false) return false;
        if (r === null) { err(s.line, 'expecting a parameter or declaration'); return false; }
      }
    }
    if (!peek()) { err(lastLine(), 'unexpected end of file'); return false; }
    next();
    cfg.hosts.push(h);
    return true;
  }

  function parsePool(sub, chain) {
    const open = next();
    if (!open || open.v !== '{') { err(open ? open.line : lastLine(), 'expecting left brace.'); return false; }
    const pool = newScope('pool', [sub.scope, ...chain]);
    while (peek() && peek().v !== '}') {
      const s = next();
      if (s.v === ';') continue;
      if (s.v === 'range') { if (!parseRange(sub, s, pool)) return false; continue; }
      const r = parseParam(pool, s);
      if (r === false) return false;
      if (r === null) { err(s.line, 'expecting a parameter or declaration'); return false; }
    }
    if (!peek()) { err(lastLine(), 'unexpected end of file'); return false; }
    next();
    return true;
  }

  function parseSubnet(t, chain, shared) {
    const netT = next();
    const kw = next();
    const maskT = next();
    if (!netT || parseIp(netT.v) === null) { err(t.line, 'expecting IP address or hostname'); return false; }
    if (!kw || kw.v !== 'netmask') { err(kw ? kw.line : t.line, 'expecting netmask'); return false; }
    const mask = maskT ? maskToPrefix(maskT.v) : null;
    if (mask === null) { err(maskT ? maskT.line : t.line, 'expecting netmask'); return false; }
    const net = parseIp(netT.v);
    if (networkOf(net, mask) !== net) {
      err(t.line, `subnet ${netT.v} netmask ${maskT.v}: bad subnet number/mask combination.`);
      return false;
    }
    const scope = newScope('subnet', chain);
    const sub = { net, len: mask, line: t.line, ranges: [], options: scope.options, scope: scope.id, chain, shared: shared ?? null, defaultLeaseTime: null, maxLeaseTime: null };
    const open = next();
    if (!open || open.v !== '{') { err(open ? open.line : t.line, 'expecting left brace.'); return false; }
    while (peek() && peek().v !== '}') {
      const s = next();
      if (s.v === ';') continue;
      if (s.v === 'range') { if (!parseRange(sub, s, null)) return false; continue; }
      if (s.v === 'pool') { if (!parsePool(sub, chain)) return false; continue; }
      if (s.v === 'host') { if (!parseHost(s, [scope.id, ...chain])) return false; continue; }
      const r = parseParam(scope, s);
      if (r === false) return false;
      if (r === null) { err(s.line, 'expecting a parameter or declaration'); return false; }
    }
    if (!peek()) { err(lastLine(), 'unexpected end of file (missing "}")'); return false; }
    next();
    sub.defaultLeaseTime = scope.defaultLeaseTime;
    sub.maxLeaseTime = scope.maxLeaseTime;
    sub.authoritative = scope.authoritative;
    if (cfg.subnets.some(x => x.net === sub.net && x.len === sub.len)) { err(t.line, `subnet ${netT.v} netmask ${maskT.v}: duplicate subnet declaration.`); return false; }
    cfg.subnets.push(sub);
    return true;
  }

  /** Body of the global scope, a shared-network or a group. */
  function parseBody(scope, chain, shared, closing) {
    while (i < toks.length) {
      const t = next();
      if (t.v === ';') continue;
      if (closing && t.v === '}') return true;
      let ok;
      if (t.v === 'subnet') ok = parseSubnet(t, chain, shared);
      else if (t.v === 'host') ok = parseHost(t, chain);
      else if (t.v === 'shared-network' || t.v === 'group') {
        const isShared = t.v === 'shared-network';
        let name = null;
        if (isShared) { const n = next(); name = n ? n.v.replace(/"/g, '') : null; }
        const open = next();
        if (!open || open.v !== '{') { err(open ? open.line : t.line, 'expecting left brace.'); return false; }
        const inner = newScope(isShared ? 'shared' : 'group', chain, name);
        ok = parseBody(inner, [inner.id, ...chain], isShared ? inner.id : shared, true);
      } else if (t.v === 'pool' && shared) {
        // A pool directly in a shared-network: its ranges belong to whichever subnet contains them.
        ok = skipStatement();
      } else if (t.v === '}' || t.v === '{') { err(t.line, `unexpected "${t.v}"`); ok = false; }
      else {
        const r = parseParam(scope, t);
        if (r === null) { err(t.line, 'expecting a parameter or declaration'); ok = false; } else ok = r;
      }
      if (!ok) return false;
    }
    if (closing) { err(lastLine(), 'unexpected end of file'); return false; }
    return true;
  }

  parseBody(cfg, [], null, false);
  if (cfg.defaultLeaseTime === null) cfg.defaultLeaseTime = 43200;
  return { ok: errors.length === 0, cfg, errors };
}

/** Scopes from the most specific to the global one, for an address (pool) in a subnet. */
function scopeChain(cfg, sub, addr) {
  const out = [];
  if (addr !== undefined && addr !== null && cfg.scopes) {
    const r = (sub.ranges || []).find(([a, b, pool]) => pool && addr >= a && addr <= b);
    if (r) out.push(cfg.scopes[r[2]]);
  }
  out.push(cfg.scopes?.[sub.scope] || { options: sub.options || {}, defaultLeaseTime: sub.defaultLeaseTime, maxLeaseTime: sub.maxLeaseTime, authoritative: sub.authoritative ?? null });
  for (const id of sub.chain || []) if (cfg.scopes[id]) out.push(cfg.scopes[id]);
  out.push(cfg);
  return out.filter(Boolean);
}

function pick(chain, f) {
  for (const s of chain) { const v = f(s); if (v !== undefined && v !== null) return v; }
  return null;
}

/** Effective options for a subnet (pool > subnet > shared-network/group > global), optionally for one address. */
export function subnetOptions(cfg, sub, addr) {
  const chain = scopeChain(cfg, sub, addr);
  const leaseTime = pick(chain, s => s.defaultLeaseTime) ?? 43200;
  const t1 = pick(chain, s => s.options?.['dhcp-renewal-time']?.[0]);
  const t2 = pick(chain, s => s.options?.['dhcp-rebinding-time']?.[0]);
  return {
    routers: pick(chain, s => s.options?.routers) ?? [],
    dns: pick(chain, s => s.options?.['domain-name-servers']) ?? [],
    domain: pick(chain, s => s.options?.['domain-name']) ?? null,
    leaseTime,
    t1: t1 ?? null,
    t2: t2 ?? null,
  };
}

/**
 * The ISC "authoritative" flag that governs a subnet: a subnet in an explicit shared-network uses the
 * shared-network's setting; a lone subnet (implicit shared network) uses its own. Default: not authoritative.
 */
export function isAuthoritative(cfg, sub) {
  if (sub.shared && cfg.scopes?.[sub.shared]) {
    const sh = cfg.scopes[sub.shared];
    return !!(sh.authoritative ?? pick((sh.chain || []).map(id => cfg.scopes[id]).filter(Boolean), s => s.authoritative) ?? cfg.authoritative);
  }
  return !!(pick(scopeChain(cfg, sub), s => s.authoritative));
}

/** The shared network a subnet belongs to (its own id when it is not inside a shared-network block). */
export function networkKey(sub) {
  return sub.shared ?? `${sub.net}/${sub.len}`;
}

export function poolSize(sub) {
  return sub.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
}
