// "Packet capture" view: the exact path the engine computed for the last command, hop by hop.
// In Night Shift challenges the trainer explanations are withheld: you see where it stopped, not why.
import { h, clear } from './dom.js';
import { fmtAddr } from '../engine/ipv6.js';
import { longIf } from '../engine/model.js';

function hostname(app, id) { return app.eng.s.devices[id]?.hostname || id; }

function pktLine(p) {
  if (!p) return '';
  const v6 = typeof p.dst === 'string';
  const icmp = p.proto === 'icmp' || p.proto === 'icmpv6';
  const what = icmp ? `${v6 ? 'ICMPv6' : 'ICMP'} ${p.icmpType || 'echo'}` : `${p.proto.toUpperCase()} ${p.sport} → ${p.dport}`;
  return `${p.src === null || p.src === undefined ? (v6 ? '::' : '0.0.0.0') : fmtAddr(p.src)} → ${fmtAddr(p.dst)}  ${what}  ${v6 ? 'Hop limit' : 'TTL'} ${p.ttl}`;
}

function hopList(app, hops, label, withNotes, notes, outcome) {
  const list = h('div', { class: 'hops' });
  let n = 0;
  for (const hp of hops) {
    n++;
    if (hp.kind === 'l2') {
      const tag = hp.tag !== null && hp.tag !== undefined ? `802.1Q tag ${hp.tag}` : 'untagged';
      list.append(h('div', { class: 'hop' }, h('div', { class: 'n' }, n),
        h('div', {}, h('div', { class: 'h' }, h('span', { class: 'layer l2' }, 'L2'), h('b', {}, `${hostname(app, hp.from.dev)} ${longIf(hp.from.port)}`), '→', h('b', {}, `${hostname(app, hp.to.dev)} ${longIf(hp.to.port)}`)),
          h('div', { class: 'd' }, `${tag}${hp.vlan ? ` · VLAN ${hp.vlan}` : ''}`))));
    } else {
      list.append(h('div', { class: 'hop' }, h('div', { class: 'n' }, n),
        h('div', {}, h('div', { class: 'h' }, h('span', { class: 'layer l3' }, 'L3'), h('b', {}, hostname(app, hp.dev)), h('span', { class: 'muted' }, longIf(hp.iface || ''))),
          h('div', { class: 'd' }, pktLine(hp.pkt)))));
    }
  }
  if (outcome) list.append(h('div', { class: 'hop' }, h('div', { class: 'n' }, '■'), h('div', {}, h('div', { class: 'h' }, h('span', { class: `layer ${outcome.ok ? 'l4' : 'drop'}` }, outcome.ok ? 'END' : 'STOP'), h('b', {}, outcome.text)), withNotes && outcome.why ? h('div', { class: 'd' }, outcome.why) : null)));
  const box = h('div', {}, h('div', { class: 'eyebrow', style: { margin: '6px 0 8px' } }, label), list);
  if (withNotes && notes?.length) box.append(h('div', { class: 'sideblock', style: { marginTop: '8px' } }, h('div', { class: 'eyebrow', style: { color: 'var(--violet)', marginBottom: '4px' } }, 'TRAINER DECODE'), h('ul', { class: 'clean', style: { margin: 0 } }, notes.map(x => h('li', {}, `${hostname(app, x.dev)}: ${x.text}`)))));
  return box;
}

function describeFwd(app, fwd) {
  if (!fwd) return null;
  const at = hostname(app, fwd.at);
  switch (fwd.outcome) {
    case 'delivered': return { ok: true, text: `Delivered to ${at} (${{ echo: 'ICMP echo answered', 'tcp-open': 'TCP port open', 'tcp-refused': 'TCP reset: nothing listening', 'udp-open': 'UDP service answered', 'udp-closed': 'UDP port closed', 'filtered-host': 'host firewall dropped it' }[fwd.service] || fwd.service})` };
    case 'ttl-exceeded': return { ok: true, text: `${typeof fwd.pkt?.dst === 'string' ? 'Hop limit' : 'TTL'} expired at ${at} (traceroute probe)` };
    case 'net-unreachable': return { ok: false, text: `${at}: no route — ${typeof fwd.pkt?.dst === 'string' ? 'ICMPv6 destination unreachable (no route)' : 'ICMP net unreachable'} sent back`, why: fwd.reason };
    case 'addr-unreachable': return { ok: false, text: `${at}: neighbor discovery for the destination got no answer — ICMPv6 address unreachable sent back`, why: fwd.reason };
    case 'scope-unreachable': return { ok: false, text: `${at}: a link-local address cannot be routed to another link — ICMPv6 beyond scope`, why: fwd.reason };
    case 'local-error': return { ok: false, text: `${at} could not send`, why: { 'no-address': 'no address of this family', 'no-route': 'no route / no default gateway', 'arp-fail': 'ARP for the next hop got no answer', 'nd-fail': 'neighbor discovery for the next hop got no answer', 'media-disconnected': 'cable unplugged / link down', 'gateway-off-link': 'gateway is not in the local subnet', 'not-an-ip-device': 'this device does not send IP packets' }[fwd.reason] || fwd.reason };
    default: return { ok: false, text: `Dropped at ${at}`, why: fwd.reason };
  }
}

export function renderCapture(el, app, devId) {
  clear(el);
  const cap = app.captures[devId];
  if (!cap) {
    el.append(h('div', { class: 'cap-empty' }, 'Run ping, tracert, curl, nslookup or ipconfig /renew on this device.', h('br'), 'The capture shows the exact path the simulator computed: every switch port, VLAN tag, routing decision and where traffic stopped.'));
    return;
  }
  const withNotes = app.trainerNotes;
  el.append(h('div', { class: 'eyebrow' }, 'LAST COMMAND'), h('div', { class: 'mono', style: { margin: '4px 0 12px', fontSize: '14px' } }, cap.cmd));
  if (cap.frames?.length) {
    el.append(h('table', { class: 'frames' }, h('thead', {}, h('tr', {}, ['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Info'].map(x => h('th', {}, x)))),
      h('tbody', {}, cap.frames.map((f, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, (f.t - cap.frames[0].t + i * 0.0021).toFixed(6)), h('td', {}, f.src), h('td', {}, f.dst), h('td', {}, f.proto), h('td', {}, f.info))))));
    if (!cap.frames.some(f => /Offer|ACK|NAK/.test(f.info))) el.append(h('p', { class: 'muted' }, 'Only the client\'s broadcast left the NIC: nothing answered.'));
  }
  const p = cap.probe;
  if (p && p.fwd) {
    const fwdOut = describeFwd(app, p.fwd);
    el.append(hopList(app, p.fwd.hops || [], 'REQUEST PATH', withNotes, p.fwd.notes, fwdOut));
    if (p.rep) {
      const ok = p.rep.outcome === 'delivered';
      el.append(hopList(app, p.rep.hops || [], 'REPLY PATH', withNotes, p.rep.notes, { ok, text: ok ? `Reply received${p.ttl ? ` (TTL ${p.ttl})` : ''}` : `Reply lost at ${hostname(app, p.rep.at)}`, why: p.rep.reason }));
    } else if (p.status === 'timeout' && p.fwd.outcome === 'delivered') {
      el.append(h('p', { class: 'muted' }, 'No reply was generated (filtered).'));
    }
    if (!withNotes) el.append(h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Night Shift: trainer explanations are off. Read the path and work out why it stopped.'));
  }
}
