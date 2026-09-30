import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlpacaProvider, parseTime } from '../src/providers/alpaca.js';

function fakeFetch(routes, calls = []) {
  return async (url, opts) => {
    calls.push({ url: new URL(url), opts });
    const handler = routes[new URL(url).pathname];
    if (!handler) return { ok: false, status: 404, text: async () => 'no route' };
    const body = typeof handler === 'function' ? handler(new URL(url)) : handler;
    return { ok: true, status: 200, json: async () => body };
  };
}

const REGULAR = Date.parse('2026-09-30T15:00:00Z');
const provider = (routes, calls, now = REGULAR) =>
  new AlpacaProvider({ keyId: 'k', secret: 's', feed: 'iex' }, { fetchImpl: fakeFetch(routes, calls), now: () => now });

test('parses Alpaca nanosecond timestamps', () => {
  assert.equal(parseTime('2026-09-30T14:59:58.123456789Z'), Date.parse('2026-09-30T14:59:58.123Z'));
  assert.equal(parseTime(null), null);
});

test('sends auth headers and merges movers with most-actives', async () => {
  const calls = [];
  const p = provider(
    {
      '/v1beta1/screener/stocks/movers': { gainers: [{ symbol: 'AAA' }, { symbol: 'BBB' }] },
      '/v1beta1/screener/stocks/most-actives': { most_actives: [{ symbol: 'BBB' }, { symbol: 'CCC' }] },
    },
    calls,
  );
  assert.deepEqual((await p.getCandidateSymbols()).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(calls[0].opts.headers['APCA-API-KEY-ID'], 'k');
  assert.equal(calls[0].opts.headers['APCA-API-SECRET-KEY'], 's');
});

test('quotes: during the session previous close comes from prevDailyBar', async () => {
  const p = provider({
    '/v2/stocks/snapshots': {
      AAA: {
        latestTrade: { p: 6, t: '2026-09-30T14:59:58.5Z' },
        dailyBar: { t: '2026-09-30T04:00:00Z', c: 6, v: 1234 },
        prevDailyBar: { t: '2026-09-29T04:00:00Z', c: 4, v: 999 },
      },
      NOTRADE: { latestTrade: null },
    },
  });
  const q = await p.getQuotes(['AAA', 'NOTRADE']);
  assert.deepEqual(q.get('AAA'), { price: 6, lastTradeAt: Date.parse('2026-09-30T14:59:58.5Z'), prevClose: 4, sessionVolume: 1234 });
  assert.equal(q.has('NOTRADE'), false);
});

test('quotes: before the open the daily bar is yesterday, so it is the previous close', async () => {
  const p = provider(
    {
      '/v2/stocks/snapshots': {
        AAA: {
          latestTrade: { p: 6, t: '2026-09-30T11:59:00Z' },
          dailyBar: { t: '2026-09-29T04:00:00Z', c: 5, v: 1234 },
          prevDailyBar: { t: '2026-09-28T04:00:00Z', c: 4, v: 999 },
        },
      },
    },
    [],
    Date.parse('2026-09-30T12:00:00Z'),
  );
  const q = (await p.getQuotes(['AAA'])).get('AAA');
  assert.equal(q.prevClose, 5);
  assert.equal(q.sessionVolume, 0);
});

test('average volume excludes today, follows pagination and is cached per day', async () => {
  const calls = [];
  const p = provider(
    {
      '/v2/stocks/bars': (url) =>
        url.searchParams.get('page_token')
          ? { bars: { AAA: [{ t: '2026-09-30T04:00:00Z', v: 999_999 }] } }
          : { bars: { AAA: [{ t: '2026-09-28T04:00:00Z', v: 100 }, { t: '2026-09-29T04:00:00Z', v: 300 }] }, next_page_token: 'p2' },
    },
    calls,
  );
  assert.equal((await p.getAverageVolumes(['AAA'])).get('AAA'), 200);
  await p.getAverageVolumes(['AAA']);
  assert.equal(calls.length, 2); // two pages, then cached
});

test('HTTP errors surface with a hint for auth problems', async () => {
  const p = new AlpacaProvider(
    { keyId: 'k', secret: 's' },
    { fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }) },
  );
  await assert.rejects(p.getCandidateSymbols(), /HTTP 403 \(check ALPACA_API_KEY/);
});

test('news is grouped by symbol', async () => {
  const p = provider({
    '/v1beta1/news': {
      news: [{ headline: 'Deal', url: 'u', source: 'benzinga', created_at: '2026-09-30T12:00:00Z', symbols: ['AAA', 'ZZZ'] }],
    },
  });
  const news = await p.getNews(['AAA', 'BBB'], new Date(REGULAR - 86_400_000));
  assert.equal(news.get('AAA')[0].headline, 'Deal');
  assert.deepEqual(news.get('BBB'), []);
});

test('pre-market volume is fetched in full once, then only the last few minutes', async () => {
  const calls = [];
  let now = Date.parse('2026-09-30T12:00:00Z'); // 08:00 ET
  const since = new Date('2026-09-30T08:00:00Z');
  const p = new AlpacaProvider(
    { keyId: 'k', secret: 's' },
    {
      now: () => now,
      fetchImpl: fakeFetch(
        {
          '/v2/stocks/bars': (url) =>
            url.searchParams.get('start') === since.toISOString()
              ? { bars: { AAA: [{ t: 'a', v: 100 }, { t: 'b', v: 50 }] } }
              : { bars: { AAA: [{ t: 'b', v: 80 }, { t: 'c', v: 10 }] } }, // bar b grew, c is new
        },
        calls,
      ),
    },
  );
  assert.equal((await p.getVolumeSince(['AAA'], since)).get('AAA'), 150);
  now += 3_000;
  assert.equal((await p.getVolumeSince(['AAA'], since)).get('AAA'), 190);
  assert.equal(calls[1].url.searchParams.get('start'), new Date(now - 180_000).toISOString());
  assert.equal(p.requestsLastMinute(), 2);
});
