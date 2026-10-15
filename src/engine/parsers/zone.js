// Parser for a practical subset of BIND master zone files.
// Supports $TTL, $ORIGIN, '@', blank owner (repeat previous), optional TTL and class, parentheses,
// ';' comments, and SOA / NS / A / AAAA / CNAME / MX / TXT / PTR records.
// Error text imitates named-checkzone.
import { parseIp } from '../ipv4.js';

const TYPES = new Set(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR']);

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
  const origin0 = zone.toLowerCase().replace(/\.$/, '');
  let origin = origin0;
  let ttl = null;
  let lastOwner = null;
  const records = [];
  const errors = [];
  let soa = null;
  for (const ll of logicalLines(text)) {
    if (ll.unclosed) { errors.push(`${file}:${ll.line}: unbalanced parentheses`); break; }
    const toks = ll.text.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    if (toks[0] === '$TTL') {
      if (!/^\d+$/.test(toks[1] || '')) { errors.push(`${file}:${ll.line}: bad ttl`); break; }
      ttl = Number(toks[1]);
      continue;
    }
    if (toks[0] === '$ORIGIN') { origin = (toks[1] || origin).replace(/\.$/, '').toLowerCase(); continue; }
    let k = 0;
    let owner;
    if (ll.leadingSpace) {
      if (!lastOwner) { errors.push(`${file}:${ll.line}: no current owner name`); break; }
      owner = lastOwner;
    } else {
      owner = absName(toks[k++], origin);
      lastOwner = owner;
    }
    let rttl = ttl;
    let cls = 'IN';
    for (let guard = 0; guard < 2; guard++) {
      if (/^\d+$/.test(toks[k] || '')) rttl = Number(toks[k++]);
      else if (/^(IN|CH|HS)$/i.test(toks[k] || '')) cls = toks[k++].toUpperCase();
    }
    const type = (toks[k++] || '').toUpperCase();
    if (!TYPES.has(type)) { errors.push(`${file}:${ll.line}: unknown RR type '${toks[k - 1] || ''}'`); break; }
    if (rttl === null) { errors.push(`${file}:${ll.line}: no TTL specified; zone rejected`); break; }
    const rdata = toks.slice(k);
    const rec = { name: owner, ttl: rttl, cls, type, line: ll.line };
    if (type === 'A') {
      const ip = parseIp(rdata[0] || '');
      if (ip === null || rdata.length !== 1) {
        errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: near '${rdata[0] || ''}': bad dotted quad`);
        break;
      }
      rec.addr = ip;
    } else if (type === 'CNAME' || type === 'NS' || type === 'PTR') {
      if (!rdata[0]) { errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`); break; }
      rec.target = absName(rdata[0], origin);
    } else if (type === 'MX') {
      if (!/^\d+$/.test(rdata[0] || '') || !rdata[1]) { errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`); break; }
      rec.pref = Number(rdata[0]);
      rec.target = absName(rdata[1], origin);
    } else if (type === 'SOA') {
      if (rdata.length < 7 || !rdata.slice(2, 7).every(x => /^\d+$/.test(x))) {
        errors.push(`dns_rdata_fromtext: ${file}:${ll.line}: unexpected end of input`);
        break;
      }
      rec.mname = absName(rdata[0], origin);
      rec.rname = absName(rdata[1], origin);
      [rec.serial, rec.refresh, rec.retry, rec.expire, rec.minimum] = rdata.slice(2, 7).map(Number);
      soa = rec;
    } else if (type === 'TXT') {
      rec.text = rdata.join(' ').replace(/^"|"$/g, '');
    } else if (type === 'AAAA') {
      rec.addr6 = rdata[0];
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
  return { ok, zone: origin0, file, records: ok ? records : [], serial: soa?.serial ?? null, soa, errors };
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
  if (res.ok) return [`zone ${res.zone}/IN: loaded serial ${res.serial}`, 'OK'];
  return [...res.errors, ...zoneLoadFailure(res)];
}
