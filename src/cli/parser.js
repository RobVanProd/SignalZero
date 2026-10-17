// IOS-style command matcher: unique-prefix keyword abbreviation, typed arguments, ambiguity detection,
// caret error markers and context help ("?"). Grammar entries are templates such as
//   'show interfaces <IF>'   'ip route <IP> <MASK> <NH>'   'description <LINE>'
import { parseIp, maskToPrefix, parseRangeList } from '../engine/ipv4.js';
import { canonIf } from '../engine/model.js';
import { parseIp6, parseCidr6 } from '../engine/ipv6.js';

export const ARG_TYPES = {
  IP: { help: 'A.B.C.D', parse: t => parseIp(t) },
  MASK: { help: 'A.B.C.D  Mask', parse: t => (maskToPrefix(t) === null ? null : maskToPrefix(t)) },
  WILD: { help: 'A.B.C.D  Wildcard bits', parse: t => parseIp(t) },
  IF: { help: 'Interface name (e.g. GigabitEthernet0/1, g0/1, Gi0/1.10)', parse: t => canonIf(t) },
  NUM: { help: '<0-4294967295>', parse: t => (/^\d+$/.test(t) ? Number(t) : null) },
  VLAN: { help: '<1-4094>  VLAN ID', parse: t => (/^\d+$/.test(t) && +t >= 1 && +t <= 4094 ? Number(t) : null) },
  VLIST: { help: 'WORD  VLAN IDs, e.g. 10,20-25', parse: t => parseRangeList(t) },
  WORD: { help: 'WORD', parse: t => t },
  LINE: { help: 'LINE  Up to 240 characters', parse: t => t, rest: true },
  NH: { help: 'A.B.C.D  Forwarding router\'s address | Interface', parse: t => parseIp(t) ?? canonIf(t) },
  // ---- ipv6
  IP6: { help: 'X:X:X:X::X  IPv6 address', parse: t => (t.includes(':') ? parseIp6(t) : null) },
  PFX6: { help: 'X:X:X:X::X/<0-128>  IPv6 prefix', parse: t => (t.includes(':') ? parseCidr6(t) : null) },
  NH6: { help: 'X:X:X:X::X  IPv6 address of next-hop | Interface', parse: t => (t.includes(':') ? parseIp6(t) : canonIf(t)) },
  // ---- ospf (Act II): OSPF area ID, decimal or dotted; the text is kept because IOS shows it as entered
  AREA: { help: '<0-4294967295>  OSPF area ID as a decimal value | A.B.C.D  OSPF area ID in IP address format', parse: t => (/^\d+$/.test(t) && Number(t) <= 4294967295 ? { area: Number(t), text: String(Number(t)) } : parseIp(t) !== null ? { area: parseIp(t), text: t } : null) },
};

export function tokenize(line) {
  const toks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) toks.push({ v: m[0], pos: m.index });
  return toks;
}

function compile(template) {
  return template.split(/\s+/).map(w => {
    const m = /^<([A-Z][A-Z0-9]*)(?::([a-z0-9]+))?>$/.exec(w);
    if (m) return { arg: m[1], name: m[2] || m[1].toLowerCase(), type: ARG_TYPES[m[1]] };
    return { kw: w.toLowerCase() };
  });
}

export class Grammar {
  constructor() { this.cmds = {}; this.help = {}; }

  add(mode, template, handler, opts = {}) {
    const modes = Array.isArray(mode) ? mode : [mode];
    for (const m of modes) (this.cmds[m] ||= []).push({ spec: compile(template), template, handler, ...opts });
    return this;
  }

  kwHelp(map) { Object.assign(this.help, map); return this; }

  /**
   * Match a command line. Returns one of:
   *  { ok: true, cmd, args }  { error: 'ambiguous'|'incomplete'|'invalid', pos }
   */
  match(mode, line) {
    const toks = tokenize(line);
    let alive = (this.cmds[mode] || []).map(c => ({ c, args: {}, done: false }));
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      const low = tok.v.toLowerCase();
      const exact = [];
      const prefix = new Map();
      const argm = [];
      for (const cand of alive) {
        if (cand.done) continue;
        const spec = cand.c.spec[i];
        if (!spec) continue;
        if (spec.kw) {
          if (spec.kw === low) exact.push(cand);
          else if (spec.kw.startsWith(low)) {
            if (!prefix.has(spec.kw)) prefix.set(spec.kw, []);
            prefix.get(spec.kw).push(cand);
          }
        } else if (spec.type.rest) {
          argm.push({ ...cand, args: { ...cand.args, [spec.name]: line.slice(tok.pos).trim() }, done: true });
        } else {
          const v = spec.type.parse(tok.v);
          if (v !== null && v !== undefined) argm.push({ ...cand, args: { ...cand.args, [spec.name]: v } });
        }
      }
      if (exact.length) alive = exact;
      else if (prefix.size > 1) return { error: 'ambiguous', pos: tok.pos, token: tok.v };
      else if (prefix.size === 1) alive = [...prefix.values()][0];
      else if (argm.length) alive = argm;
      else return { error: 'invalid', pos: tok.pos, token: tok.v };
      if (alive.some(a => a.done)) {
        const d = alive.find(a => a.done);
        return { ok: true, cmd: d.c, args: d.args };
      }
    }
    const complete = alive.filter(a => a.c.spec.length === toks.length);
    if (complete.length) return { ok: true, cmd: complete[0].c, args: complete[0].args };
    return { error: 'incomplete' };
  }

  /** Context help for a line ending in '?'. */
  helpFor(mode, line) {
    const partial = !/\s$/.test(line) && line.length > 0;
    const toks = tokenize(line);
    const fixed = partial ? toks.slice(0, -1) : toks;
    const frag = partial ? toks[toks.length - 1].v.toLowerCase() : '';
    let alive = this.cmds[mode] || [];
    for (let i = 0; i < fixed.length; i++) {
      const low = fixed[i].v.toLowerCase();
      const ex = alive.filter(c => c.spec[i]?.kw === low);
      const pre = alive.filter(c => c.spec[i]?.kw && c.spec[i].kw.startsWith(low));
      const ar = alive.filter(c => c.spec[i]?.arg && (c.spec[i].type.rest || c.spec[i].type.parse(fixed[i].v) !== null));
      alive = ex.length ? ex : new Set(pre.map(c => c.spec[i].kw)).size === 1 ? pre : ar;
      if (alive.some(c => c.spec[i]?.type?.rest)) return [];
    }
    const i = fixed.length;
    const out = new Map();
    let cr = false;
    for (const c of alive) {
      const spec = c.spec[i];
      if (!spec) { if (!partial) cr = true; continue; }
      if (spec.kw) { if (spec.kw.startsWith(frag)) out.set(spec.kw, this.help[spec.kw] || ''); }
      else if (!partial) out.set(`<${spec.arg}>`, spec.type.help);
    }
    const lines = [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, h]) => (partial ? k : `  ${k.padEnd(18)} ${h}`));
    if (partial) return [lines.join('  ')];
    if (cr) lines.push('  <cr>');
    return lines;
  }

  /** Tab completion: returns completed line or null. */
  complete(mode, line) {
    const toks = tokenize(line);
    if (!toks.length || /\s$/.test(line)) return null;
    const frag = toks[toks.length - 1].v.toLowerCase();
    const before = line.slice(0, toks[toks.length - 1].pos);
    const i = toks.length - 1;
    let alive = this.cmds[mode] || [];
    for (let k = 0; k < i; k++) {
      const low = toks[k].v.toLowerCase();
      const ex = alive.filter(c => c.spec[k]?.kw === low);
      const pre = alive.filter(c => c.spec[k]?.kw && c.spec[k].kw.startsWith(low));
      const ar = alive.filter(c => c.spec[k]?.arg && (c.spec[k].type.rest || c.spec[k].type.parse(toks[k].v) !== null));
      alive = ex.length ? ex : new Set(pre.map(c => c.spec[k].kw)).size === 1 ? pre : ar;
    }
    const kws = [...new Set(alive.map(c => c.spec[i]?.kw).filter(k => k && k.startsWith(frag)))];
    if (kws.length !== 1) return null;
    return before + kws[0] + ' ';
  }
}

export function caretLines(prompt, line, pos) {
  return [' '.repeat(prompt.length + pos) + '^', "% Invalid input detected at '^' marker."];
}
