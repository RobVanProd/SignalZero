// The simulator's bench against the same network built from real Linux kernels (docs/apprenticeship/lab).
// The lab transcripts are the reference: they were produced by real iproute2, iputils and tcpdump, not by this code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareLab, LAB_OUT, KNOWN_DIFFERENCES } from '../../scripts/lab-compare.mjs';
import { buildBench } from '../../src/content/bench.js';
import { createSession, execute } from '../../src/cli/index.js';

const { results, frameResults } = compareLab();

test('lab transcripts are present (run docs/apprenticeship/lab/bench-lab.sh as root to regenerate)', () => {
  assert.ok(results.length > 100, `${results.length} lab commands`);
  assert.ok(!results.some(r => r.status === 'missing'));
  assert.ok(frameResults.length >= 9);
});

test('every lab command the simulator supports prints what the real tools printed', () => {
  const compared = results.filter(r => r.match !== undefined);
  const bad = compared.filter(r => !r.match && !KNOWN_DIFFERENCES[r.cmd]);
  assert.deepEqual(bad.map(r => `${r.file}: ${r.ns}$ ${r.cmd}\n  lab: ${JSON.stringify(r.lab)}\n  sim: ${JSON.stringify(r.sim)}`), []);
  assert.ok(compared.filter(r => r.match).length >= 100, `${compared.filter(r => r.match).length} matching commands`);
  // a listed difference that has started to match should be removed from the list
  for (const cmd of Object.keys(KNOWN_DIFFERENCES)) assert.ok(compared.some(r => r.cmd === cmd && !r.match), `known difference "${cmd}" still differs`);
});

test('every lab capture shows the same frames as the simulator (timing-dependent ARP confirmations aside)', () => {
  const bad = frameResults.filter(f => !f.match);
  assert.deepEqual(bad.map(f => `${f.file}\n  lab: ${JSON.stringify(f.lab)}\n  sim: ${JSON.stringify(f.sim)}`), []);
  assert.ok(frameResults.some(f => f.lab.length >= 8), 'non-trivial captures compared');
});

test('Ubuntu command-not-found messages match the real handler (lab file 09)', () => {
  const file = path.join(LAB_OUT, '09-command-not-found.txt');
  if (!fs.existsSync(file)) return; // the lab host had no command-not-found database
  const blocks = fs.readFileSync(file, 'utf8').split(/^\$ /m).filter(Boolean).map(b => { const [cmd, ...out] = b.split('\n'); return { cmd, out: out.filter((l, i, a) => l || i < a.length - 1) }; });
  const eng = buildBench('A');
  const sess = createSession(eng, 'PC-A');
  for (const b of blocks) {
    if (b.cmd === 'ipconfig') continue; // suggestions depend on the archive snapshot; layout checked below
    const sim = execute(eng, sess, b.cmd).lines.filter(l => typeof l === 'string');
    assert.deepEqual(sim, b.out.filter(Boolean), b.cmd);
  }
  const ip = execute(eng, sess, 'ipconfig').lines.filter(l => typeof l === 'string');
  assert.equal(ip[0], "Command 'ipconfig' not found, did you mean:");
  assert.equal(ip.at(-1), 'Try: apt install <deb name>');
});
