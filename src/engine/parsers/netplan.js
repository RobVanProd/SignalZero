// Minimal netplan (YAML) reader for a single static Ethernet interface.
// Supports addresses, routes (to: default / 0.0.0.0/0, via), gateway4 (deprecated), nameservers.addresses.
import { parseIp, parseCidr, networkOf } from '../ipv4.js';

export function renderNetplan(nic, cfg, fmtIp) {
  return `# /etc/netplan/01-netcfg.yaml  (apply with: netplan apply)
network:
  version: 2
  ethernets:
    ${nic}:
      addresses: [${fmtIp(cfg.addr)}/${cfg.len}]
      routes:
        - to: default
          via: ${cfg.gw !== null && cfg.gw !== undefined ? fmtIp(cfg.gw) : '0.0.0.0'}
      nameservers:
        addresses: [${(cfg.dns || []).map(fmtIp).join(', ')}]
`;
}

export function parseNetplan(text, path, nic) {
  const lines = text.split('\n');
  const err = (i, col, msg) => ({ ok: false, error: `${path}:${i + 1}:${col}: Error in network definition: ${msg}` });
  if (!/^\s*network:\s*$/m.test(text)) return { ok: false, error: `${path}:1:1: Invalid YAML: expected "network:" at top level` };
  if (!new RegExp(`^\\s+${nic}:\\s*$`, 'm').test(text)) return { ok: false, error: `${path}: interface ${nic} is not defined` };
  let addr = null;
  let gw = null;
  let dns = [];
  let inNs = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/#.*$/, '');
    if (/^\s*nameservers:\s*$/.test(l)) { inNs = true; continue; }
    const am = /^\s*addresses:\s*\[(.*)\]\s*$/.exec(l);
    if (am) {
      const items = am[1].split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (inNs) {
        dns = [];
        for (const it of items) { const v = parseIp(it); if (v === null) return err(i, l.indexOf(it) + 1, `malformed address '${it}'`); dns.push(v); }
        inNs = false;
      } else {
        const c = parseCidr(items[0] || '');
        if (!c) return err(i, l.indexOf('[') + 2, `malformed address '${items[0] || ''}', must be X.X.X.X/NN or X:X:X:X:X:X:X:X/NN`);
        if (c.len < 31 && (c.ip === networkOf(c.ip, c.len))) return err(i, l.indexOf('[') + 2, `address '${items[0]}' is the network address`);
        addr = c;
      }
      continue;
    }
    const via = /^\s*via:\s*(\S+)\s*$/.exec(l) || /^\s*gateway4:\s*(\S+)\s*$/.exec(l);
    if (via) { const v = parseIp(via[1]); if (v === null) return err(i, l.indexOf(via[1]) + 1, `invalid gateway '${via[1]}'`); gw = v; }
  }
  if (!addr) return { ok: false, error: `${path}: ${nic}: no static address defined (dhcp4 not supported for this host)` };
  return { ok: true, cfg: { addr: addr.ip, len: addr.len, gw, dns } };
}
