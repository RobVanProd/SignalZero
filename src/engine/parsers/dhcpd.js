// Parser for a practical subset of ISC dhcpd.conf.
// Supports: comments, global options/parameters, subnet { range; option routers; option domain-name-servers;
// option domain-name; default-lease-time; max-lease-time; }, host { hardware ethernet; fixed-address; },
// authoritative;. Error text follows dhcpd's own wording where practical.
import { parseIp, maskToPrefix, networkOf, inSubnet, fmtIp } from '../ipv4.js';

function tokenize(text) {
  const toks = [];
  const lines = text.split('\n');
  lines.forEach((line, li) => {
    const noComment = line.replace(/#.*$/, '');
    const re = /"[^"]*"|[{};,]|[^\s{};,]+/g;
    let m;
    while ((m = re.exec(noComment))) toks.push({ v: m[0], line: li + 1 });
  });
  return toks;
}

export function parseDhcpd(text, path = '/etc/dhcp/dhcpd.conf') {
  const toks = tokenize(text);
  let i = 0;
  const errors = [];
  const cfg = { authoritative: false, defaultLeaseTime: 600, maxLeaseTime: 7200, options: {}, subnets: [], hosts: [] };
  const peek = () => toks[i];
  const next = () => toks[i++];
  const err = (line, msg) => { errors.push(`${path} line ${line}: ${msg}`); };
  const lastLine = () => (toks[i - 1] ? toks[i - 1].line : 1);

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

  function parseOption(scope) {
    const nameTok = next();
    if (!nameTok) { err(lastLine(), 'unexpected end of file'); return false; }
    const name = nameTok.v;
    const vals = readValues();
    if (!expectSemi()) return false;
    if (name === 'routers' || name === 'domain-name-servers') {
      const ips = [];
      for (const v of vals) {
        const ip = parseIp(v.v);
        if (ip === null) { err(v.line, `${v.v}: host unknown.`); return false; }
        ips.push(ip);
      }
      scope.options[name] = ips;
    } else if (name === 'domain-name') {
      scope.options[name] = (vals[0]?.v || '').replace(/"/g, '');
    } else if (name === 'subnet-mask' || name === 'broadcast-address' || name === 'ntp-servers' || name === 'domain-search') {
      scope.options[name] = vals.map(v => v.v.replace(/"/g, ''));
    } else {
      err(nameTok.line, `unknown option dhcp.${name}`);
      return false;
    }
    return true;
  }

  function parseParam(scope, t) {
    switch (t.v) {
      case 'option': return parseOption(scope);
      case 'default-lease-time':
      case 'max-lease-time': {
        const n = next();
        if (!n || !/^\d+$/.test(n.v)) { err(t.line, 'expecting numeric value.'); return false; }
        if (!expectSemi()) return false;
        scope[t.v === 'default-lease-time' ? 'defaultLeaseTime' : 'maxLeaseTime'] = Number(n.v);
        return true;
      }
      case 'authoritative': if (!expectSemi()) return false; scope.authoritative = true; return true;
      case 'ddns-update-style':
      case 'log-facility': readValues(); return expectSemi();
      default:
        err(t.line, 'expecting a parameter or declaration');
        return false;
    }
  }

  function parseSubnet(t) {
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
    const sub = { net, len: mask, line: t.line, ranges: [], options: {}, defaultLeaseTime: null, maxLeaseTime: null };
    const open = next();
    if (!open || open.v !== '{') { err(open ? open.line : t.line, 'expecting left brace.'); return false; }
    while (peek() && peek().v !== '}') {
      const s = next();
      if (s.v === 'range') {
        const a = next();
        const b = peek() && peek().v !== ';' ? next() : a;
        if (!expectSemi()) return false;
        const ia = parseIp(a.v);
        const ib = parseIp(b.v);
        if (ia === null || ib === null) { err(s.line, 'expecting IP address.'); return false; }
        if (!inSubnet(ia, net, mask) || !inSubnet(ib, net, mask)) {
          errors.push(`Address range ${a.v} to ${b.v} not on net ${fmtIp(net)}/${fmtIp((0xffffffff << (32 - mask)) >>> 0)}!`);
          return false;
        }
        sub.ranges.push([Math.min(ia, ib), Math.max(ia, ib)]);
      } else if (!parseParam(sub, s)) return false;
    }
    if (!peek()) { err(lastLine(), 'unexpected end of file (missing "}")'); return false; }
    next();
    cfg.subnets.push(sub);
    return true;
  }

  function parseHost(t) {
    const name = next();
    const open = next();
    if (!open || open.v !== '{') { err(t.line, 'expecting left brace.'); return false; }
    const h = { name: name.v, mac: null, fixed: null };
    while (peek() && peek().v !== '}') {
      const s = next();
      if (s.v === 'hardware') {
        next();
        const mac = next();
        if (!expectSemi()) return false;
        h.mac = mac.v.toLowerCase().replace(/[:-]/g, '');
      } else if (s.v === 'fixed-address') {
        const a = next();
        if (!expectSemi()) return false;
        h.fixed = parseIp(a.v);
      } else { err(s.line, 'expecting a parameter or declaration'); return false; }
    }
    next();
    cfg.hosts.push(h);
    return true;
  }

  while (i < toks.length) {
    const t = next();
    let ok;
    if (t.v === 'subnet') ok = parseSubnet(t);
    else if (t.v === 'host') ok = parseHost(t);
    else if (t.v === '}' || t.v === '{') { err(t.line, `unexpected "${t.v}"`); ok = false; }
    else ok = parseParam(cfg, t);
    if (!ok) break;
  }
  return { ok: errors.length === 0, cfg, errors };
}

/** Effective options for a subnet (subnet scope overrides global). */
export function subnetOptions(cfg, sub) {
  return {
    routers: sub.options.routers ?? cfg.options.routers ?? [],
    dns: sub.options['domain-name-servers'] ?? cfg.options['domain-name-servers'] ?? [],
    domain: sub.options['domain-name'] ?? cfg.options['domain-name'] ?? null,
    leaseTime: sub.defaultLeaseTime ?? cfg.defaultLeaseTime ?? 600,
  };
}

export function poolSize(sub) {
  return sub.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
}
