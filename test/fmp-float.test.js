import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FmpFloatProvider } from '../src/providers/fmp-float.js';

// statusFor(symbol, endpoint) -> HTTP status. calls records "endpoint:symbol".
function setup(statusFor, body = () => [{ floatShares: 5e6, date: '2026-09-29' }]) {
  let now = Date.parse('2026-09-30T15:00:00Z');
  const calls = [];
  const p = new FmpFloatProvider('key', {
    now: () => now,
    fetchImpl: async (url) => {
      const u = new URL(url);
      const symbol = u.searchParams.get('symbol');
      const endpoint = u.pathname.split('/').pop();
      calls.push(`${endpoint}:${symbol}`);
      const status = statusFor(symbol, endpoint);
      return { ok: status === 200, status, json: async () => body(symbol, endpoint) };
    },
  });
  return { p, calls, advance: (ms) => (now += ms) };
}

test('successful lookups are cached for the day', async () => {
  const { p, calls } = setup(() => 200);
  const r = (await p.getFloats(['AAA'])).get('AAA');
  assert.equal(r.shares, 5e6);
  assert.equal(r.source, 'float');
  await p.getFloats(['AAA']);
  assert.deepEqual(calls, ['shares-float:AAA']);
});

test('402 on float falls back to shares outstanding from the profile, cached for the day', async () => {
  const { p, calls } = setup(
    (s, endpoint) => (endpoint === 'shares-float' ? 402 : 200),
    (s, endpoint) => (endpoint === 'profile' ? [{ marketCap: 77_760_354, price: 1.235 }] : []),
  );
  const r = (await p.getFloats(['CNTB'])).get('CNTB');
  assert.equal(r.shares, null);
  assert.equal(r.source, 'outstanding');
  assert.equal(r.outstanding, Math.round(77_760_354 / 1.235));
  await p.getFloats(['CNTB']);
  assert.deepEqual(calls, ['shares-float:CNTB', 'profile:CNTB']);
});

test('a failed symbol is not retried until 15 minutes pass', async () => {
  const { p, calls, advance } = setup((s) => (s === 'BAD' ? 402 : 200));
  const err = await p.getFloats(['AAA', 'BAD']).catch((e) => e);
  assert.match(err.message, /BAD: HTTP 402/);
  assert.equal(err.partial.get('AAA').shares, 5e6);
  const first = ['shares-float:AAA', 'shares-float:BAD', 'profile:BAD'];
  assert.deepEqual([...calls].sort(), [...first].sort());

  advance(3_000);
  await p.getFloats(['AAA', 'BAD']).catch(() => {});
  assert.equal(calls.length, 3); // no new requests

  advance(15 * 60_000);
  await p.getFloats(['AAA', 'BAD']).catch(() => {});
  assert.deepEqual(calls.slice(3), ['shares-float:BAD', 'profile:BAD']);
});

test('HTTP 429 pauses every lookup, not just the symbol that hit it', async () => {
  const { p, calls, advance } = setup((s) => (s === 'AAA' ? 429 : 200));
  await p.getFloats(['AAA']).catch(() => {});
  advance(3_000);
  const err = await p.getFloats(['NEW']).catch((e) => e);
  assert.match(err.message, /NEW: lookups paused/);
  assert.deepEqual(calls, ['shares-float:AAA']);
});

test('HTTP 429 on the profile fallback also pauses lookups', async () => {
  const { p, calls, advance } = setup((s, endpoint) => (endpoint === 'shares-float' ? 402 : 429));
  await p.getFloats(['AAA']).catch(() => {});
  advance(3_000);
  await p.getFloats(['NEW']).catch(() => {});
  assert.deepEqual(calls, ['shares-float:AAA', 'profile:AAA']);
});
