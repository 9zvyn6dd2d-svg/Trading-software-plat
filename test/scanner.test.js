import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../src/scanner.js';

// Test doubles only. The app itself never falls back to made-up data.
const criteria = { minPrice: 1, maxPrice: 20, minChangePct: 10, minRvol: 5, maxFloat: 20e6, preferredFloat: 10e6, newsLookbackHours: 24 };
const REGULAR = Date.parse('2026-09-30T15:00:00Z'); // 11:00 ET Wednesday
const PREMARKET = Date.parse('2026-09-30T12:00:00Z'); // 08:00 ET

function fakeMarket(quotes, overrides = {}) {
  return {
    name: 'Fake',
    isConfigured: () => true,
    getCandidateSymbols: async () => Object.keys(quotes),
    getQuotes: async (symbols) => new Map(symbols.filter((s) => quotes[s]).map((s) => [s, quotes[s]])),
    getAverageVolumes: async (symbols) => new Map(symbols.map((s) => [s, 1_000_000])),
    getVolumeSince: async (symbols) => new Map(symbols.map((s) => [s, 2_000_000])),
    getNews: async (symbols) => new Map(symbols.map((s) => [s, s === 'NEWS' ? [{ headline: 'Big contract' }] : []])),
    ...overrides,
  };
}
const fakeFloats = { isConfigured: () => true, getFloats: async (symbols) => new Map(symbols.map((s) => [s, { shares: 5e6, asOf: '2026-09-29' }])) };

const scan = (market, now, extra = {}) =>
  runScan({ market, floats: fakeFloats, criteria, staleAfterMs: 120_000, now: () => now, ...extra });

test('no API key: says no real-time data can be found, returns no rows', async () => {
  const r = await scan({ ...fakeMarket({}), isConfigured: () => false }, REGULAR);
  assert.equal(r.status, 'not_configured');
  assert.match(r.message, /no real-time data can be found/i);
  assert.deepEqual(r.rows, []);
});

test('weekend: closed, and the provider is not called', async () => {
  const market = fakeMarket({}, { getCandidateSymbols: async () => assert.fail('should not scan when closed') });
  const r = await scan(market, Date.parse('2026-10-03T15:00:00Z'));
  assert.equal(r.status, 'closed');
  assert.deepEqual(r.rows, []);
});

test('provider failure: error status with the reason, no rows', async () => {
  const market = fakeMarket({}, { getCandidateSymbols: async () => { throw new Error('HTTP 503'); } });
  const r = await scan(market, REGULAR);
  assert.equal(r.status, 'error');
  assert.match(r.message, /could not be found: HTTP 503/);
  assert.deepEqual(r.rows, []);
});

test('every quote old: stale status, no prices shown', async () => {
  const old = REGULAR - 10 * 60_000;
  const r = await scan(fakeMarket({ ABC: { price: 5, prevClose: 4, lastTradeAt: old, sessionVolume: 9e6 } }), REGULAR);
  assert.equal(r.status, 'stale');
  assert.match(r.message, /No fresh data could be found/);
  assert.deepEqual(r.rows, []);
});

test('live scan: gates on price and % change, scores the rest, drops stale quotes', async () => {
  const fresh = REGULAR - 5_000;
  const r = await scan(
    fakeMarket({
      NEWS: { price: 6, prevClose: 4, lastTradeAt: fresh, sessionVolume: 8_000_000 }, // +50%, 8x, news
      QUIET: { price: 3, prevClose: 2.5, lastTradeAt: fresh, sessionVolume: 2_000_000 }, // +20%, 2x, no news
      SLOW: { price: 10, prevClose: 9.8, lastTradeAt: fresh, sessionVolume: 9e6 }, // +2%: gated out
      PRICY: { price: 60, prevClose: 40, lastTradeAt: fresh, sessionVolume: 9e6 }, // price out of range
      OLD: { price: 5, prevClose: 2, lastTradeAt: REGULAR - 600_000, sessionVolume: 9e6 }, // stale
    }),
    REGULAR,
  );
  assert.equal(r.status, 'live');
  assert.deepEqual(r.rows.map((x) => x.symbol), ['NEWS', 'QUIET']);
  assert.equal(r.staleCount, 1);
  const [top, second] = r.rows;
  assert.equal(top.allMet, true);
  assert.equal(top.rvol, 8);
  assert.equal(Math.round(top.changePct), 50);
  assert.equal(second.pillars.news, false);
  assert.equal(second.pillars.rvol, false);
});

test('pre-market uses volume since 04:00 ET instead of the daily bar', async () => {
  let since;
  const market = fakeMarket(
    { NEWS: { price: 6, prevClose: 4, lastTradeAt: PREMARKET - 1_000, sessionVolume: 0 } },
    { getVolumeSince: async (symbols, s) => { since = s; return new Map(symbols.map((x) => [x, 6_000_000])); } },
  );
  const r = await scan(market, PREMARKET);
  assert.equal(r.session, 'premarket');
  assert.equal(since.toISOString(), '2026-09-30T08:00:00.000Z');
  assert.equal(r.rows[0].volume, 6_000_000);
  assert.equal(r.rows[0].rvol, 6);
});

test('news or float failure: rows still live, pillar unknown, warning explains why', async () => {
  const market = fakeMarket(
    { NEWS: { price: 6, prevClose: 4, lastTradeAt: REGULAR - 1_000, sessionVolume: 8e6 } },
    { getNews: async () => { throw new Error('HTTP 429'); } },
  );
  const r = await scan(market, REGULAR, { floats: { isConfigured: () => false } });
  assert.equal(r.status, 'live');
  assert.equal(r.rows[0].pillars.news, null);
  assert.equal(r.rows[0].pillars.float, null);
  assert.equal(r.rows[0].allMet, false);
  assert.ok(r.warnings.some((w) => /News unavailable: HTTP 429/.test(w)));
  assert.ok(r.warnings.some((w) => /FMP_API_KEY is not set/.test(w)));
});

test('watchlist symbols are always checked', async () => {
  let asked;
  const market = fakeMarket({}, {
    getCandidateSymbols: async () => ['AAA'],
    getQuotes: async (symbols) => { asked = symbols; return new Map([['AAA', { price: 5, prevClose: 4, lastTradeAt: REGULAR, sessionVolume: 1 }]]); },
  });
  await scan(market, REGULAR, { watchlist: ['ZZZ', 'AAA'] });
  assert.deepEqual(asked.sort(), ['AAA', 'ZZZ']);
});
