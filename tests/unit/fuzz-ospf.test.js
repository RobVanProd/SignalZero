// Reliability fuzz for the dynamic-routing build: seeded random OSPF / vty / SSH commands (valid, abbreviated, mutated,
// garbage, "?" help, Tab completion), including nested SSH sessions, on the routers and clients involved in M12, across
// mission starts and a generated challenge. Nothing may throw, every result has a lines array and a prompt, state stays
// JSON-serialisable, and read-only OSPF commands never change a healthy network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.js';
import { buildDistrict } from '../../src/content/district.js';
import { MISSIONS, buildMissionStart } from '../../src/content/missions.js';
import { rngFrom, randomParams, buildHealthy, healthReport, generateChallenge } from '../../src/content/challenges.js';
import { createSession, execute, complete, prompt } from '../../src/cli/index.js';

const IOS = [
  'enable', 'show ip ospf', 'show ip ospf neighbor', 'show ip ospf neighbor g0/X', 'show ip ospf interface', 'show ip ospf interface brief',
  'show ip ospf interface g0/X', 'show ip ospf database', 'show ip ospf database router', 'show ip route ospf', 'show ip protocols',
  'show ip route 10.43.10.50', 'show ip route 0.0.0.0', 'show debugging', 'show running-config | section router ospf', 'show ip ospf neighbor detail',
  'configure terminal', 'router ospf Y', 'no router ospf Y', 'router-id 10.Y.255.1', 'no router-id', 'network 172.16.42.0 0.0.0.3 area Y',
  'no network 172.16.42.0 0.0.0.3 area Y', 'network 10.43.10.0 0.0.0.255 area 0.0.0.Y', 'network 0.0.0.0 255.255.255.255 area 0',
  'network 10.42.10.1 0.0.0.0 area 1', 'passive-interface g0/X', 'no passive-interface g0/X', 'passive-interface default', 'no passive-interface default',
  'auto-cost reference-bandwidth Y', 'no auto-cost reference-bandwidth', 'default-information originate', 'default-information originate always',
  'no default-information originate', 'log-adjacency-changes detail', 'no log-adjacency-changes', 'area Y authentication', 'redistribute static subnets',
  'interface g0/X', 'interface g0/1.Y', 'ip ospf cost Y', 'no ip ospf cost', 'ip ospf hello-interval Y', 'no ip ospf hello-interval', 'ip ospf dead-interval Y',
  'no ip ospf dead-interval', 'ip ospf network point-to-point', 'ip ospf network broadcast', 'no ip ospf network', 'ip ospf priority Y', 'no ip ospf priority',
  'ip ospf 1 area Y', 'no ip ospf 1 area Y', 'ip ospf mtu-ignore', 'no ip ospf mtu-ignore', 'ip mtu Y', 'no ip mtu', 'bandwidth Y', 'no bandwidth',
  'ip ospf authentication message-digest', 'shutdown', 'no shutdown', 'exit', 'end', 'line vty 0 4', 'line vty 0 Y', 'line con 0', 'access-class VTY-MGMT in',
  'no access-class VTY-MGMT in', 'transport input ssh', 'transport input none', 'transport input all', 'clear ip ospf process', 'yes', 'no',
  'debug ip ospf hello', 'debug ip ospf adj', 'undebug all', 'no debug all', 'ssh -l admin 172.16.42.Y', 'ssh -l admin 10.43.10.1', 'ssh -v 2 -l admin 172.16.42.2',
  'ssh -l admin 10.42.10.20', 'ssh 10.43.10.1', 'nightshift', 'nightshift', 'exit', 'do show ip ospf neighbor', 'ip route 10.43.10.0 255.255.255.0 10.42.10.254 Y',
  'no ip route 10.43.10.0 255.255.255.0 10.42.10.254', 'ip access-list extended OSPF-IN', 'permit ospf any any', 'deny ospf any any log', '?', 'show ip ospf ?', 'router ?', 'ip ospf ?',
];
const WIN = [
  'ssh admin@10.43.10.1', 'ssh admin@10.43.10.50', 'ssh -l admin 172.16.42.2', 'ssh admin@clinic.ops.example', 'ssh', 'ssh -p 2222 admin@10.43.10.1',
  'ssh -x', 'ssh -o StrictHostKeyChecking=no admin@10.42.10.20', 'nightshift', 'nightshift', 'wrong', 'exit', 'whoami', 'hostname', 'ping 10.43.10.50',
  'tracert 10.43.10.50', 'curl https://clinic.ops.example/health', 'ipconfig /all', 'show ip ospf neighbor', 'configure terminal', 'enable',
];
const LNX = [
  'ssh admin@10.43.10.1', 'ssh root@10.43.10.1', 'ssh -l admin 10.43.10.50', 'ssh admin@10.42.10.20', 'ssh admin@nosuch.example', 'ssh', 'nightshift', 'nightshift',
  'exit', 'whoami', 'cd ~', 'cd /etc', 'ls', 'pwd', 'ping -c 2 10.43.10.50', 'traceroute 10.43.10.50', 'show ip route ospf', 'enable', 'logout',
];
const READ_ONLY = ['show ip ospf', 'show ip ospf neighbor', 'show ip ospf interface', 'show ip ospf interface brief', 'show ip ospf interface g0/3', 'show ip ospf database', 'show ip route ospf', 'show ip protocols', 'show debugging', 'show ip route 10.43.10.50'];
const JUNK = ['%', '\u0000', '999.1.1.1', '-l', '@', 'admin@', '@10.43.10.1', 'g0/99', '4294967296', '-1', 'ÿ', '\t', '   ', 'area', '0.0.0.0.0'];

function mutate(cmd, rnd) {
  let c = cmd.replace(/X/g, () => String(Math.floor(rnd() * 5))).replace(/Y/g, () => String([0, 1, 2, 5, 10, 40, 255, 256, 1400, 65535, 65536, 99999][Math.floor(rnd() * 12)]));
  const r = rnd();
  if (r < 0.15) c = c.split(' ').map(w => (w.length > 2 && rnd() < 0.6 ? w.slice(0, 1 + Math.floor(rnd() * (w.length - 1))) : w)).join(' ');
  else if (r < 0.25) c = `${c} ${JUNK[Math.floor(rnd() * JUNK.length)]}`;
  else if (r < 0.3) c = c.toUpperCase();
  else if (r < 0.34) c = JUNK[Math.floor(rnd() * JUNK.length)];
  else if (r < 0.37) c = '';
  else if (r < 0.41) c = `${c.split(' ').slice(0, -1).join(' ')} ?`;
  return c;
}

const DEVS = ['EDGE-RTR', 'BRANCH-RTR', 'DISPATCH-01', 'BRANCH-PC', 'CORE-SRV'];

function fuzz(eng, rnd, perDevice, { readOnly = false } = {}) {
  let n = 0;
  for (const id of DEVS) {
    const d = eng.s.devices[id];
    if (!d || d.powered === false) continue;
    const pool = readOnly ? READ_ONLY : d.os === 'ios' ? IOS : d.os === 'windows' ? WIN : LNX;
    const sess = createSession(eng, id);
    if (readOnly) execute(eng, sess, 'enable');
    for (let i = 0; i < perDevice; i++) {
      const base = pool[Math.floor(rnd() * pool.length)];
      const line = readOnly ? base : mutate(base, rnd);
      let r;
      try { r = execute(eng, sess, line); } catch (e) { assert.fail(`${id} threw on ${JSON.stringify(line)}: ${e.stack}`); }
      assert.ok(Array.isArray(r.lines), `${id}: ${JSON.stringify(line)} returned no lines array`);
      for (const l of r.lines) assert.ok(typeof l === 'string' || (l && typeof l.text === 'string'), `${id}: ${JSON.stringify(line)} returned a malformed line`);
      assert.equal(typeof r.prompt, 'string', `${id}: no prompt after ${JSON.stringify(line)}`);
      assert.equal(typeof prompt(eng, sess), 'string');
      if (!readOnly && rnd() < 0.2) { try { complete(eng, sess, line.slice(0, Math.max(0, line.length - 2))); } catch (e) { assert.fail(`${id} Tab-completion threw on ${JSON.stringify(line)}: ${e.stack}`); } }
      if (!readOnly && rnd() < 0.08) { try { eng.advance(1 + Math.floor(rnd() * 15)); } catch (e) { assert.fail(`advance during ${id} session threw: ${e.stack}`); } }
      n++;
    }
    JSON.parse(JSON.stringify(sess));
    if (!readOnly) { try { eng.advance(5 + Math.floor(rnd() * 50)); } catch (e) { assert.fail(`advance after ${id} commands threw: ${e.stack}`); } }
  }
  JSON.parse(JSON.stringify(eng.s));
  return n;
}

const M12 = MISSIONS.findIndex(m => m.id === 'M12');

test('fuzz: OSPF, vty and SSH commands (nested sessions included) survive random and garbage input across mission starts', () => {
  const rnd = rngFrom(20261043);
  let total = 0;
  for (const i of [0, 9, M12]) total += fuzz(buildMissionStart(buildDistrict, Engine, i), rnd, 90);
  const solved = buildMissionStart(buildDistrict, Engine, M12);
  MISSIONS[M12].reference(solved);
  total += fuzz(solved, rnd, 90);
  solved.advance(400);
  JSON.parse(JSON.stringify(solved.s));
  assert.ok(total > 1500, `ran ${total} commands`);
});

test('fuzz: a generated challenge survives OSPF/SSH fuzzing, and time keeps running afterwards', () => {
  const rnd = rngFrom(4343);
  const ch = generateChallenge(91, { faults: 2 });
  const n = fuzz(ch.eng, rnd, 60);
  ch.eng.advance(600);
  JSON.parse(JSON.stringify(ch.eng.s));
  assert.ok(n > 250, `ran ${n} commands`);
});

test('fuzz: read-only OSPF show commands never change a healthy network', () => {
  const eng = buildHealthy(randomParams(rngFrom(17)));
  assert.ok(healthReport(eng).ok, 'healthy to begin with');
  const changes = eng.s.changeSeq;
  const n = fuzz(eng, rngFrom(5), 60, { readOnly: true });
  assert.ok(n > 100, `ran ${n} read-only commands`);
  eng.advance(30);
  assert.ok(healthReport(eng).ok, `still healthy: ${JSON.stringify(healthReport(eng).flows.filter(f => !f.ok))}`);
  assert.equal(eng.s.changeSeq, changes, 'no configuration change was recorded');
});
