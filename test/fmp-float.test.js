import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FmpFloatProvider } from '../src/providers/fmp-float.js';

function setup(statusFor) {
  let now = Date.parse('2026-09-30T15:00:00Z');
  const calls = [];
  const p = new FmpFloatProvider('key', {
    now: () => now,
    fetchImpl: async (url) => {
      const symbol = new URL(url).searchParams.get('symbol');
      calls.push(symbol);
      const status = statusFor(symbol);
      return { ok: status === 200, status, json: async () => [{ floatShares: 5e6, date: '2026-09-29' }] };
    },
  });
  return { p, calls, advance: (ms) => (now += ms) };
}

test('successful lookups are cached for the day', async () => {
  const { p, calls } = setup(() => 200);
  assert.equal((await p.getFloats(['AAA'])).get('AAA').shares, 5e6);
  await p.getFloats(['AAA']);
  assert.deepEqual(calls, ['AAA']);
});

test('a failed symbol is not retried until 15 minutes pass', async () => {
  const { p, calls, advance } = setup((s) => (s === 'BAD' ? 402 : 200));
  const err = await p.getFloats(['AAA', 'BAD']).catch((e) => e);
  assert.match(err.message, /BAD: HTTP 402/);
  assert.equal(err.partial.get('AAA').shares, 5e6);

  advance(3_000);
  await p.getFloats(['AAA', 'BAD']).catch(() => {});
  assert.deepEqual(calls, ['AAA', 'BAD']); // no new requests

  advance(15 * 60_000);
  await p.getFloats(['AAA', 'BAD']).catch(() => {});
  assert.deepEqual(calls, ['AAA', 'BAD', 'BAD']);
});

test('HTTP 429 pauses every lookup, not just the symbol that hit it', async () => {
  const { p, calls, advance } = setup((s) => (s === 'AAA' ? 429 : 200));
  await p.getFloats(['AAA']).catch(() => {});
  advance(3_000);
  const err = await p.getFloats(['NEW']).catch((e) => e);
  assert.match(err.message, /NEW: lookups paused/);
  assert.deepEqual(calls, ['AAA']);
});
