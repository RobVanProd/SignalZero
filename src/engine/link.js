// Layer 1: physical link state and speed/duplex negotiation.
//
// Model (IEEE 802.3 clause 28 behaviour, simplified):
//  - A port with BOTH speed and duplex hard-set at 10/100 Mb/s disables auto-negotiation.
//  - A side that auto-negotiates against a side that does not falls back to parallel detection:
//    it detects the speed but cannot learn duplex, so it assumes HALF duplex at 10/100.
//  - 1000BASE-T always negotiates (master/slave), so fixed 1000 keeps negotiation on.
//  - Hard-set speeds that differ cannot form a link.

function autonegEnabled(p) {
  if (p.kind === 'wifi') return true;
  if (p.speed === 1000) return true;
  return !(p.speed !== 'auto' && p.duplex !== 'auto');
}

function speedChoices(p) {
  return p.speed === 'auto' ? p.caps : p.caps.filter(s => s === p.speed);
}

export function negotiate(pa, pb) {
  if (pa.kind === 'wifi' || pb.kind === 'wifi') {
    return { up: true, speed: 'wifi', duplexA: 'full', duplexB: 'full', mismatch: false, autonegA: true, autonegB: true };
  }
  const aA = autonegEnabled(pa);
  const aB = autonegEnabled(pb);
  const common = speedChoices(pa).filter(s => speedChoices(pb).includes(s));
  if (!common.length) return { up: false, reason: 'speed mismatch: no common speed' };
  const speed = Math.max(...common);
  let duplexA;
  let duplexB;
  if (aA && aB) {
    const half = pa.duplex === 'half' || pb.duplex === 'half';
    duplexA = duplexB = half ? 'half' : 'full';
  } else if (aA && !aB) {
    duplexB = pb.duplex;
    duplexA = speed >= 1000 ? 'full' : 'half'; // parallel detection fallback
  } else if (!aA && aB) {
    duplexA = pa.duplex;
    duplexB = speed >= 1000 ? 'full' : 'half';
  } else {
    if (pa.speed !== pb.speed) return { up: false, reason: 'speed mismatch' };
    duplexA = pa.duplex;
    duplexB = pb.duplex;
  }
  return { up: true, speed, duplexA, duplexB, mismatch: duplexA !== duplexB, autonegA: aA, autonegB: aB };
}

/**
 * Full physical status of a link. Reasons are written for the trainer's explanation layer,
 * not shown as device output.
 */
export function linkStatus(state, link) {
  const da = state.devices[link.a.dev];
  const db = state.devices[link.b.dev];
  const pa = da?.ports[link.a.port];
  const pb = db?.ports[link.b.port];
  if (!pa || !pb) return { up: false, reason: 'unknown endpoint' };
  if (link.cut) return { up: false, reason: 'cable fault (open circuit)', fault: 'cut' };
  if (pa.kind !== pb.kind) {
    return { up: false, reason: `incompatible ports (${pa.kind} ↔ ${pb.kind}); a console port does not carry Ethernet`, fault: 'incompatible' };
  }
  if (pa.media !== pb.media || (link.media !== pa.media && link.media !== 'wifi')) {
    return { up: false, reason: 'media mismatch', fault: 'media' };
  }
  if (da.powered === false || db.powered === false) return { up: false, reason: 'device powered off', fault: 'power' };
  if (pa.errDisabled) return { up: false, reason: `${da.hostname} ${pa.name} err-disabled (${pa.errDisabled})`, fault: 'errdisable', side: 'a' };
  if (pb.errDisabled) return { up: false, reason: `${db.hostname} ${pb.name} err-disabled (${pb.errDisabled})`, fault: 'errdisable', side: 'b' };
  if (!pa.adminUp) return { up: false, reason: `${da.hostname} ${pa.name} administratively down`, fault: 'admin', side: 'a' };
  if (!pb.adminUp) return { up: false, reason: `${db.hostname} ${pb.name} administratively down`, fault: 'admin', side: 'b' };
  if (link.media === 'copper' && link.lengthM > 150) return { up: false, reason: 'copper run far beyond 100 m channel limit', fault: 'length' };
  const n = negotiate(pa, pb);
  if (!n.up) return { ...n, fault: 'negotiation' };
  return { ...n, overLength: link.media === 'copper' && link.lengthM > 100 };
}
