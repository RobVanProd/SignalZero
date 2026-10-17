// Minimal netplan (YAML) reader for a single static Ethernet interface.
// Supports addresses (inline [..] or block "- item" lists, IPv4 and IPv6), routes (to: default / 0.0.0.0/0 / ::/0,
// via), gateway4 / gateway6 (deprecated), nameservers.addresses, accept-ra.
// ---- ipv6: netplan (Ubuntu 24.04) accepts IPv6 addresses in "addresses" and a default route per family
// ("routes: - to: default  via: <IPv6 router>"), the router may be given by its link-local address.
import { parseIp, parseCidr, networkOf } from '../ipv4.js';
import { parseCidr6, parseIp6, fmtIp6, prefix6 } from '../ipv6.js';

export function renderNetplan(nic, cfg, fmtIp, v6 = null) {
  const addrs = [`${fmtIp(cfg.addr)}/${cfg.len}`, ...(v6?.addrs || []).map(a => `"${fmtIp6(a.addr)}/${a.len}"`)];
  const v6route = v6?.gw ? `\n        - to: default\n          via: "${fmtIp6(v6.gw)}"` : '';
  return `# /etc/netplan/01-netcfg.yaml  (apply with: netplan apply)
network:
  version: 2
  ethernets:
    ${nic}:
      addresses: [${addrs.join(', ')}]
      routes:
        - to: default
          via: ${cfg.gw !== null && cfg.gw !== undefined ? fmtIp(cfg.gw) : '0.0.0.0'}${v6route}
      nameservers:
        addresses: [${(cfg.dns || []).map(fmtIp).join(', ')}]
`;
}

const unq = x => x.trim().replace(/^["']|["']$/g, '');

export function parseNetplan(text, path, nic) {
  const lines = text.split('\n');
  const err = (i, col, msg) => ({ ok: false, error: `${path}:${i + 1}:${col}: Error in network definition: ${msg}` });
  if (!/^\s*network:\s*$/m.test(text)) return { ok: false, error: `${path}:1:1: Invalid YAML: expected "network:" at top level` };
  if (!new RegExp(`^\\s+${nic}:\\s*$`, 'm').test(text)) return { ok: false, error: `${path}: interface ${nic} is not defined` };
  let addr = null;
  let gw = null;
  let dns = [];
  let inNs = false;
  const addrs6 = [];
  let gw6 = null;
  let acceptRa;
  let block = null; // 'addr' | 'ns' while reading "- item" lines of a block list
  const takeAddr = (item, i, l) => {
    if (item.includes(':')) {
      const c6 = parseCidr6(item);
      if (!c6) return err(i, l.indexOf(item) + 1, `malformed address '${item}', must be X.X.X.X/NN or X:X:X:X:X:X:X:X/NN`);
      if (c6.len < 127 && c6.addr === prefix6(c6.addr, c6.len)) return err(i, l.indexOf(item) + 1, `address '${item}' is the network address`);
      addrs6.push({ addr: c6.addr, len: c6.len });
      return null;
    }
    const c = parseCidr(item);
    if (!c) return err(i, l.indexOf(item) + 1, `malformed address '${item}', must be X.X.X.X/NN or X:X:X:X:X:X:X:X/NN`);
    if (c.len < 31 && (c.ip === networkOf(c.ip, c.len))) return err(i, l.indexOf(item) + 1, `address '${item}' is the network address`);
    if (!addr) addr = c;
    return null;
  };
  const takeDns = (item, i, l) => {
    const v = parseIp(item);
    if (v !== null) { dns.push(v); return null; }
    if (parseIp6(item) !== null) return null; // an IPv6 resolver: accepted (this image resolves over IPv4)
    return err(i, l.indexOf(item) + 1, `malformed address '${item}'`);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/#.*$/, '');
    const item = /^\s*-\s*(\S+)\s*$/.exec(l);
    if (block && item) {
      const e = block === 'ns' ? takeDns(unq(item[1]), i, l) : takeAddr(unq(item[1]), i, l);
      if (e) return e;
      continue;
    }
    if (block && !item) { if (block === 'ns') inNs = false; block = null; }
    if (/^\s*nameservers:\s*$/.test(l)) { inNs = true; continue; }
    const am = /^\s*addresses:\s*\[(.*)\]\s*$/.exec(l);
    if (am) {
      const items = am[1].split(',').map(unq).filter(Boolean);
      if (inNs) {
        dns = [];
        for (const it of items) { const e = takeDns(it, i, l); if (e) return e; }
        inNs = false;
      } else {
        if (!items.length) return err(i, l.indexOf('[') + 2, "malformed address '', must be X.X.X.X/NN or X:X:X:X:X:X:X:X/NN");
        for (const it of items) { const e = takeAddr(it, i, l); if (e) return e; }
      }
      continue;
    }
    if (/^\s*addresses:\s*$/.test(l)) { block = inNs ? 'ns' : 'addr'; if (inNs) dns = []; continue; }
    const ra = /^\s*accept-ra:\s*(\S+)\s*$/.exec(l);
    if (ra) { acceptRa = /^(true|yes|on)$/i.test(ra[1]); continue; }
    const via = /^\s*via:\s*(\S+)\s*$/.exec(l) || /^\s*gateway4:\s*(\S+)\s*$/.exec(l) || /^\s*gateway6:\s*(\S+)\s*$/.exec(l);
    if (via) {
      const raw = unq(via[1]);
      if (raw.includes(':')) {
        const v6 = parseIp6(raw);
        if (v6 === null) return err(i, l.indexOf(via[1]) + 1, `invalid gateway '${raw}'`);
        gw6 = v6;
      } else {
        const v = parseIp(raw);
        if (v === null) return err(i, l.indexOf(via[1]) + 1, `invalid gateway '${raw}'`);
        gw = v;
      }
    }
  }
  if (!addr) return { ok: false, error: `${path}: ${nic}: no static address defined (dhcp4 not supported for this host)` };
  // cfg keeps exactly the IPv4 fields it always had; the IPv6 settings come back beside it.
  return { ok: true, cfg: { addr: addr.ip, len: addr.len, gw, dns }, v6: { addrs: addrs6, gw: gw6 }, acceptRa };
}
