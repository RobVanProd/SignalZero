import test from 'node:test';
import assert from 'node:assert/strict';
import * as ip from '../../src/engine/ipv4.js';

test('parse and format round-trip', () => {
  for (const s of ['0.0.0.0', '10.42.10.1', '255.255.255.255', '203.0.113.20']) {
    assert.equal(ip.fmtIp(ip.parseIp(s)), s);
  }
  for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '01.2.3.4', '', ' 1.2.3.4x']) {
    assert.equal(ip.parseIp(bad), null, bad);
  }
});

test('mask conversions reject non-contiguous masks', () => {
  assert.equal(ip.maskToPrefix('255.255.255.0'), 24);
  assert.equal(ip.maskToPrefix('255.255.255.192'), 26);
  assert.equal(ip.maskToPrefix('0.0.0.0'), 0);
  assert.equal(ip.maskToPrefix('255.255.255.255'), 32);
  assert.equal(ip.maskToPrefix('255.0.255.0'), null);
  assert.equal(ip.fmtMask(27), '255.255.255.224');
  assert.equal(ip.wildcardOf(24), '0.0.0.255');
});

test('subnet boundaries', () => {
  const a = ip.parseIp('10.42.40.77');
  assert.equal(ip.fmtIp(ip.networkOf(a, 27)), '10.42.40.64');
  assert.equal(ip.fmtIp(ip.broadcastOf(a, 27)), '10.42.40.95');
  const r = ip.hostRange(a, 27);
  assert.equal(r.count, 30);
  assert.equal(ip.fmtIp(r.first), '10.42.40.65');
  assert.equal(ip.fmtIp(r.last), '10.42.40.94');
  assert.equal(ip.hostRange(a, 26).count, 62);
  assert.equal(ip.hostRange(a, 31).count, 2);
  assert.equal(ip.isHostAddress(ip.parseIp('10.42.40.64'), 27), false);
  assert.equal(ip.isHostAddress(ip.parseIp('10.42.40.95'), 27), false);
  assert.equal(ip.isHostAddress(ip.parseIp('10.42.40.94'), 27), true);
});

test('overlap detection', () => {
  const p = ip.parseIp;
  assert.equal(ip.overlaps(p('10.42.40.0'), 25, p('10.42.40.64'), 27), true);
  assert.equal(ip.overlaps(p('10.42.40.128'), 26, p('10.42.40.64'), 27), false);
  assert.equal(ip.overlaps(p('10.42.0.0'), 16, p('10.42.40.64'), 27), true);
});

test('wildcard matching follows Cisco semantics', () => {
  const p = ip.parseIp;
  assert.equal(ip.wildcardMatch(p('10.42.30.7'), p('10.42.30.0'), p('0.0.0.255')), true);
  assert.equal(ip.wildcardMatch(p('10.42.31.7'), p('10.42.30.0'), p('0.0.0.255')), false);
  assert.equal(ip.wildcardMatch(p('10.42.99.7'), p('10.42.0.0'), p('0.0.255.255')), true);
  assert.equal(ip.wildcardMatch(p('1.2.3.4'), p('0.0.0.0'), p('255.255.255.255')), true);
});

test('address classes', () => {
  const p = ip.parseIp;
  assert.equal(ip.isApipa(p('169.254.17.44')), true);
  assert.equal(ip.isPrivate(p('172.31.0.1')), true);
  assert.equal(ip.isPrivate(p('172.32.0.1')), false);
  assert.equal(ip.isPrivate(p('203.0.113.20')), false);
});

test('range lists', () => {
  assert.deepEqual(ip.parseRangeList('10,20-22'), [10, 20, 21, 22]);
  assert.equal(ip.parseRangeList('0'), null);
  assert.equal(ip.parseRangeList('5-3'), null);
  assert.equal(ip.fmtRangeList([1, 10, 20, 21, 22, 30]), '1,10,20-22,30');
});
