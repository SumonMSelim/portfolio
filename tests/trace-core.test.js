import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePop, parseCacheStatus, computePhases, parseDoh, auditHeaders, waterfall, timelineAt, toHex } from '../site/js/trace-core.js';

test('parsePop maps airport code to city', () => {
  assert.deepEqual(parsePop('AMS54-P1'), { raw: 'AMS54-P1', code: 'AMS', city: 'Amsterdam' });
});

test('parsePop keeps unknown codes without a city', () => {
  assert.deepEqual(parsePop('zzz1-C1'), { raw: 'zzz1-C1', code: 'ZZZ', city: null });
});

test('parsePop returns null when header is missing', () => {
  assert.equal(parsePop(null), null);
  assert.equal(parsePop(''), null);
});

test('parseCacheStatus recognises CloudFront x-cache values', () => {
  assert.equal(parseCacheStatus('Hit from cloudfront'), 'hit');
  assert.equal(parseCacheStatus('Miss from cloudfront'), 'miss');
  assert.equal(parseCacheStatus('RefreshHit from cloudfront'), 'refresh');
  assert.equal(parseCacheStatus('Error from cloudfront'), 'unknown');
  assert.equal(parseCacheStatus(null), 'unknown');
});

test('computePhases splits a TLS navigation into phases', () => {
  const p = computePhases({
    nextHopProtocol: 'h2', domainLookupStart: 10, domainLookupEnd: 22.34,
    connectStart: 22.34, secureConnectionStart: 40, connectEnd: 75.5,
    requestStart: 76, responseStart: 120, responseEnd: 130, transferSize: 5120,
  });
  assert.deepEqual(p, { protocol: 'h2', dns: 12.3, tcp: 17.7, tls: 35.5, wait: 44, download: 10, transferSize: 5120 });
});

test('computePhases handles plain HTTP and reused connections', () => {
  const p = computePhases({
    nextHopProtocol: '', domainLookupStart: 5, domainLookupEnd: 5,
    connectStart: 5, secureConnectionStart: 0, connectEnd: 5,
    requestStart: 6, responseStart: 8, responseEnd: 9,
  });
  assert.deepEqual(p, { protocol: 'unknown', dns: 0, tcp: 0, tls: 0, wait: 2, download: 1, transferSize: 0 });
});

test('computePhases never reports negative durations', () => {
  const p = computePhases({ domainLookupStart: 10, domainLookupEnd: 0, connectStart: 0, secureConnectionStart: 0, connectEnd: 0, requestStart: 0, responseStart: 0, responseEnd: 0 });
  assert.equal(p.dns, 0);
});

test('computePhases returns null without a timing entry', () => {
  assert.equal(computePhases(undefined), null);
});

test('parseDoh maps record types and strips trailing dots', () => {
  const records = parseDoh({
    Answer: [
      { name: 'portfolio.mol.la.', type: 5, TTL: 300, data: 'd1234.cloudfront.net.' },
      { name: 'd1234.cloudfront.net.', type: 1, TTL: 60, data: '13.32.1.1' },
      { name: 'x.', type: 99, TTL: 1, data: 'y' },
    ],
  });
  assert.deepEqual(records, [
    { name: 'portfolio.mol.la', type: 'CNAME', data: 'd1234.cloudfront.net', ttl: 300 },
    { name: 'd1234.cloudfront.net', type: 'A', data: '13.32.1.1', ttl: 60 },
    { name: 'x', type: '99', data: 'y', ttl: 1 },
  ]);
});

test('parseDoh handles empty or missing answers', () => {
  assert.deepEqual(parseDoh({ Status: 3 }), []);
  assert.deepEqual(parseDoh(null), []);
});

test('auditHeaders passes a hardened response', () => {
  const headers = {
    'strict-transport-security': 'max-age=31536000',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
  };
  assert.ok(auditHeaders((n) => headers[n] ?? null).every((c) => c.ok));
});

test('auditHeaders flags a bare response', () => {
  assert.ok(auditHeaders(() => null).every((c) => !c.ok));
});

test('auditHeaders accepts X-Frame-Options as framing protection', () => {
  const [, , framing] = auditHeaders((n) => (n === 'x-frame-options' ? 'DENY' : null));
  assert.equal(framing.ok, true);
});

test('waterfall sizes phases proportionally and drops empty ones', () => {
  assert.deepEqual(waterfall({ dns: 10, tcp: 0, tls: 30, wait: 50, download: 10 }), [
    { key: 'dns', label: 'DNS', ms: 10, pct: 10 },
    { key: 'tls', label: 'TLS', ms: 30, pct: 30 },
    { key: 'wait', label: 'Server', ms: 50, pct: 50 },
    { key: 'download', label: 'Download', ms: 10, pct: 10 },
  ]);
});

test('waterfall is empty without timing or with all-zero phases', () => {
  assert.deepEqual(waterfall(null), []);
  assert.deepEqual(waterfall({ dns: 0, tcp: 0, tls: 0, wait: 0, download: 0 }), []);
});

test('timelineAt picks chapter and move progress', () => {
  const counts = [0, 2, 4];
  assert.deepEqual(timelineAt(0, 1000, counts), { chapter: 0, move: -1, t: 0 });
  assert.deepEqual(timelineAt(1000, 1000, counts), { chapter: 1, move: 0, t: 0 });
  assert.deepEqual(timelineAt(1200, 1000, counts), { chapter: 1, move: 0, t: 0.5 });
  const later = timelineAt(1600, 1000, counts);
  assert.deepEqual([later.chapter, later.move], [1, 1]);
  assert.ok(Math.abs(later.t - 0.5) < 1e-9);
});

test('timelineAt holds the last move complete during the arrival pause', () => {
  assert.deepEqual(timelineAt(1900, 1000, [0, 2]), { chapter: 1, move: 1, t: 1 });
});

test('timelineAt clamps before the start and past the end', () => {
  assert.deepEqual(timelineAt(-50, 1000, [1, 1]), { chapter: 0, move: 0, t: 0 });
  assert.deepEqual(timelineAt(5000, 1000, [1, 1]), { chapter: 1, move: 0, t: 1 });
});

test('toHex encodes bytes as lowercase hex', () => {
  assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), '000fff');
});
