// Parser for a practical subset of BIND master zone files.
// Supports $TTL, $ORIGIN, '@', blank owner (repeat previous), optional TTL and class in either order, parentheses,
// ';' comments, BIND TTL syntax with units (300, 1D, 1h30m, 2w), and SOA / NS / A / AAAA / CNAME / MX / TXT / PTR
// records (other standard types such as SRV or CAA are accepted and served as opaque data).
// TTL defaults follow lib/dns/master.c: $TTL sets the default; without it, an SOA with no TTL makes the SOA MINIMUM
// the default (warning "no TTL specified; using SOA MINTTL instead"); a record with no TTL and no default before any
// explicit TTL rejects the zone; after an explicit TTL, later records inherit it ("using RFC1035 TTL semantics").
// Error text imitates named-checkzone.
import { parseIp } from '../ipv4.js';

const TYPES = new Set(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR']);
// Valid RR types this subset stores but does not interpret (BIND would load them).
const OPAQUE_TYPES = new Set(['SRV', 'CAA', 'HINFO', 'SPF', 'NAPTR', 'DS', 'DNSKEY', 'RRSIG', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'CDS', 'CDNSKEY', 'TLSA', 'SSHFP', 'DNAME', 'LOC', 'RP', 'SVCB', 'HTTPS', 'URI', 'OPENPGPKEY', 'SMIMEA']);
const UNIT = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

/**
 * BIND's TTL/counter syntax (dns_ttl_fromtext / bind_ttl): a plain number, or one or more number+unit groups
 * (w, d, h, m, s; case-insensitive), e.g. "1D", "1h30m". A bare number may not follow a unit group ("1h30").
 * Returns seconds, or null if the text is not a TTL.
 */
export function parseTtl(text) {
  if (typeof text !== 'string' || !text || text.length > 63) return null;
  let n;
  if (/^\d+$/.test(text)) n = Number(text);
  else {
    if (!/^(?:\d+[wdhms])+$/i.test(text)) return null;
    n = 0;
    for (const [, num, u] of text.matchAll(/(\d+)([wdhms])/gi)) n += Number(num) * UNIT[u.toLowerCase()];
  }
  return n <= 0xffffffff ? n : null;
}

function absName(name, origin) {
  if (name === '@') return origin;
  if (name.endsWith('.')) return name.slice(0, -1).toLowerCase();
  return `${name}.${origin}`.toLowerCase();
}

/** Join parenthesised continuation lines and strip comments; keep original line numbers. */
function logicalLines(text) {
  const out = [];
  let buf = null;
  let startLine = 0;
  let depth = 0;
  text.split('\n').forEach((raw, idx) => {
    let line = '';
    let inQ = false;
    for (const ch of raw) {
      if (ch === '"') inQ = !inQ;
      if (ch === ';' && !inQ) break;
      line += ch;
    }
    for (const ch of line) { if (ch === '(') depth++; if (ch === ')') depth--; }
    const cleaned = line.replace(/[()]/g, ' ');
    if (buf === null) { buf = cleaned; startLine = idx + 1; } else buf += ' ' + cleaned;
    if (depth <= 0) {
      depth = 0;
      out.push({ text: buf, line: startLine, leadingSpace: /^\s/.test(buf) });
      buf = null;
    }
  });
  if (buf !== null) out.push({ text: buf, line: startLine, leadingSpace: /^\s/.test(buf), unclosed: true });
  return out;
}

export function parseZone(text, zone, file = 'db.zone') {
  const origin0 = String(zone || '').toLowerCase().replace(/\.$/, '');
  let origin = origin0;
  let defaultTtl = null; // $TTL, or the SOA MINIMUM when there is no $TTL
  let lastTtl = null; // the most recent explicit TTL (RFC 1035 semantics)
  let warned1035 = false;
  let lastOwner = null;
  const records = [];
  const errors = [];
  const warnings = [];
  let soa = null;
  for (const ll of logicalLines(String(text ?? ''))) {
    if (ll.unclosed) { errors.push(`${file}:${ll.line}: unbalanced parentheses`); break; }
    const toks = ll.text.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    if (toks[0].toUpperCase() === '$TTL') {
      const v = parseTtl(toks[1] || '');
      if (v === null) { errors.push(`${file}:${ll.line}: bad ttl`); break; }
      defaultTtl = v;
      lastTtl = v;
      continue;
    }
    if (toks[0].toUpperCase() === '$ORIGIN') {
      if (!toks[1]) { errors.push(`${file}:${ll.line}: unexpected end of input`); break; }
      origin = absName(toks[1], origin);
      continue;
    }
    if (/^\$(INCLUDE|GENERATE)$/i.test(toks[0])) continue; // valid BIND directives this subset does not expand
    if (toks[0].startsWith('$')) { errors.push(`dns_master_load: ${file}:${ll.line}: unknown $ directive '${toks[0]}'`); break; }
    let k = 0;
    let owner;
    if (ll.leadingSpace) {
      if (!lastOwner) { errors.push(`${file}:${ll.line}: no current owner name`); break; }
      owner = lastOwner;
    } else {
      owner = absName(toks[k++], origin);
      lastOwner = owner;
    }
    let explicit = null;
    let cls = 'IN';
    for (let guard = 0; guard < 2; guard++) {
      const t = toks[k];
      if (t === undefined) break;
      if (explicit === null && parseTtl(t) !== null) { explicit = parseTtl(t); k++; }
      else if (/^(IN|CH|HS)$/i.test(t)) { cls = t.toUpperCase(); k++; }
    }
    const rawType = toks[k++] || '';
    const type = rawType.toUpperCase();
    if (!TYPES.has(type) && !OPAQUE_TYPES.has(type)) { errors.push(`${file}:${ll.line}: unknown RR type '${rawType}'`); break; }
    const rdata = toks.slice(k);
    const rec = { name: owner, ttl: null, cls, type, line: ll.line };
    if (type === 'A') {
      const ip = parseIp(rdata[0] || '');
      if (ip === null || rdata.length !== 1) {
        errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: near '${rdata[0] || ''}': bad dotted quad`);
        break;
      }
      rec.addr = ip;
    } else if (type === 'CNAME' || type === 'NS' || type === 'PTR' || type === 'DNAME') {
      if (!rdata[0]) { errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`); break; }
      rec.target = absName(rdata[0], origin);
    } else if (type === 'MX') {
      if (!/^\d+$/.test(rdata[0] || '') || !rdata[1]) { errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`); break; }
      rec.pref = Number(rdata[0]);
      rec.target = absName(rdata[1], origin);
    } else if (type === 'SOA') {
      // serial is a plain number; refresh/retry/expire/minimum accept TTL units (dns_counter_fromtext).
      const timers = rdata.slice(3, 7).map(parseTtl);
      if (rdata.length < 7 || !/^\d+$/.test(rdata[2]) || timers.some(x => x === null)) {
        errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`);
        break;
      }
      rec.mname = absName(rdata[0], origin);
      rec.rname = absName(rdata[1], origin);
      rec.serial = Number(rdata[2]);
      [rec.refresh, rec.retry, rec.expire, rec.minimum] = timers;
      soa = rec;
    } else if (type === 'TXT') {
      rec.text = rdata.join(' ').replace(/^"|"$/g, '');
    } else if (type === 'AAAA') {
      rec.addr6 = rdata[0];
    } else {
      if (!rdata.length) { errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`); break; }
      rec.data = rdata.join(' ');
    }
    // TTL selection, in BIND's order.
    if (explicit !== null) {
      rec.ttl = explicit;
      lastTtl = explicit;
    } else if (lastTtl === null && defaultTtl === null) {
      if (type === 'SOA') {
        warnings.push(`${file}:${ll.line}: no TTL specified; using SOA MINTTL instead`);
        defaultTtl = rec.minimum;
        lastTtl = rec.minimum;
        rec.ttl = rec.minimum;
      } else {
        errors.push(`${file}:${ll.line}: no TTL specified; zone rejected`);
        break;
      }
    } else if (defaultTtl !== null) {
      rec.ttl = defaultTtl;
    } else {
      if (!warned1035) { warnings.push(`${file}:${ll.line}: using RFC1035 TTL semantics`); warned1035 = true; }
      rec.ttl = lastTtl;
    }
    records.push(rec);
  }
  if (!errors.length) {
    if (!soa) errors.push(`zone ${origin0}/IN: has no SOA record`);
    else if (soa.name !== origin0) errors.push(`zone ${origin0}/IN: SOA record not at top of zone`);
    else if (!records.some(r => r.type === 'NS' && r.name === origin0)) errors.push(`zone ${origin0}/IN: has no NS records`);
  }
  if (!errors.length) {
    // CNAME and other data at the same name is illegal.
    const byName = new Map();
    for (const r of records) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
    for (const [name, rs] of byName) {
      if (rs.some(r => r.type === 'CNAME') && rs.length > 1) { errors.push(`${file}:${rs[0].line}: ${name}: CNAME and other data`); break; }
    }
  }
  const ok = errors.length === 0;
  return { ok, zone: origin0, file, records: ok ? records : [], serial: soa?.serial ?? null, soa, errors, warnings };
}

// isc_result_totext() wording for the master-file loader failures this parser detects.
const LOAD_RESULT = [[/dotted quad/, 'bad dotted quad'], [/unbalanced/, 'unbalanced parentheses'], [/end of input/, 'unexpected end of input'], [/no TTL/, 'no ttl'], [/bad ttl/, 'bad ttl'], [/unknown RR type/, 'unknown class/type'], [/CNAME and other data/, 'CNAME and other data']];

/** The lines named and named-checkzone log after a failed zone load (zone-level checks have no "loading" line). */
export function zoneLoadFailure(res, file = res.file) {
  const e = res.errors[0] || '';
  const why = (LOAD_RESULT.find(([re]) => re.test(e)) || [null, 'syntax error'])[1];
  return [...(/^zone /.test(e) ? [] : [`zone ${res.zone}/IN: loading from master file ${file} failed: ${why}`]), `zone ${res.zone}/IN: not loaded due to errors.`];
}

/** named-checkzone style output. */
export function checkzoneOutput(res) {
  const warn = res.warnings || [];
  if (res.ok) return [...warn, `zone ${res.zone}/IN: loaded serial ${res.serial}`, 'OK'];
  return [...warn, ...res.errors, ...zoneLoadFailure(res)];
}
