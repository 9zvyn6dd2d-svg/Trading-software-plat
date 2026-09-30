// Alpaca Market Data API (https://docs.alpaca.markets/docs/about-market-data-api).
// Supplies the mover list, live quotes, volume history and news headlines.
// Any other provider can replace this one by exposing the same methods.

import { easternParts } from '../market-session.js';

const BASE = 'https://data.alpaca.markets';
const CHUNK = 100;

export function parseTime(value) {
  if (!value) return null;
  // Alpaca sends nanosecond precision; trim to milliseconds for Date.parse.
  const ms = Date.parse(String(value).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : null;
}

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class AlpacaProvider {
  constructor({ keyId, secret, feed = 'iex' }, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.keyId = keyId;
    this.secret = secret;
    this.feed = feed;
    this.fetch = fetchImpl;
    this.now = now;
    this.avgVolumeCache = { day: null, values: new Map() };
  }

  get name() {
    return `Alpaca (${this.feed.toUpperCase()} feed)`;
  }

  isConfigured() {
    return Boolean(this.keyId && this.secret);
  }

  async get(path, params = {}) {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      headers: { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secret },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = res.status === 401 || res.status === 403 ? ' (check ALPACA_API_KEY / ALPACA_API_SECRET and your data plan)' : '';
      throw new Error(`Alpaca ${url.pathname} returned HTTP ${res.status}${hint}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return res.json();
  }

  // Today's top gainers plus the most active names, as a candidate universe.
  async getCandidateSymbols() {
    const [movers, actives] = await Promise.all([
      this.get('/v1beta1/screener/stocks/movers', { top: 50 }),
      this.get('/v1beta1/screener/stocks/most-actives', { by: 'volume', top: 100 }),
    ]);
    const symbols = new Set();
    for (const g of movers.gainers ?? []) symbols.add(g.symbol);
    for (const a of actives.most_actives ?? []) symbols.add(a.symbol);
    return [...symbols];
  }

  // Latest trade, previous close and today's regular-session volume per symbol.
  async getQuotes(symbols) {
    const out = new Map();
    const today = easternParts(new Date(this.now())).dateKey;
    for (const group of chunks(symbols)) {
      const data = await this.get('/v2/stocks/snapshots', { symbols: group.join(','), feed: this.feed });
      for (const [symbol, snap] of Object.entries(data ?? {})) {
        if (!snap?.latestTrade) continue;
        const dailyAt = parseTime(snap.dailyBar?.t);
        const dailyIsToday = dailyAt !== null && easternParts(new Date(dailyAt)).dateKey === today;
        // Before the open the "daily bar" is still yesterday's session.
        const prevClose = dailyIsToday ? snap.prevDailyBar?.c : snap.dailyBar?.c;
        out.set(symbol, {
          price: snap.latestTrade.p,
          lastTradeAt: parseTime(snap.latestTrade.t),
          prevClose: prevClose ?? null,
          sessionVolume: dailyIsToday ? snap.dailyBar.v : 0,
        });
      }
    }
    return out;
  }

  async getBars(symbols, params) {
    const bars = new Map(symbols.map((s) => [s, []]));
    for (const group of chunks(symbols)) {
      let pageToken;
      do {
        const data = await this.get('/v2/stocks/bars', {
          symbols: group.join(','),
          feed: this.feed,
          adjustment: 'raw',
          limit: 10000,
          page_token: pageToken,
          ...params,
        });
        for (const [symbol, list] of Object.entries(data.bars ?? {})) {
          bars.get(symbol)?.push(...list);
        }
        pageToken = data.next_page_token;
      } while (pageToken);
    }
    return bars;
  }

  // Volume traded since `since` (used for pre-market volume, which is not in the daily bar).
  async getVolumeSince(symbols, since) {
    const bars = await this.getBars(symbols, { timeframe: '1Min', start: since.toISOString() });
    return new Map([...bars].map(([s, list]) => [s, list.reduce((sum, b) => sum + (b.v ?? 0), 0)]));
  }

  // Average daily volume over the last ~30 completed sessions. Cached per Eastern day.
  async getAverageVolumes(symbols) {
    const today = easternParts(new Date(this.now())).dateKey;
    if (this.avgVolumeCache.day !== today) this.avgVolumeCache = { day: today, values: new Map() };
    const missing = symbols.filter((s) => !this.avgVolumeCache.values.has(s));
    if (missing.length) {
      const start = new Date(this.now() - 45 * 86_400_000).toISOString();
      const bars = await this.getBars(missing, { timeframe: '1Day', start });
      for (const symbol of missing) {
        const completed = (bars.get(symbol) ?? [])
          .filter((b) => easternParts(new Date(parseTime(b.t))).dateKey !== today)
          .slice(-30);
        const avg = completed.length ? completed.reduce((s, b) => s + b.v, 0) / completed.length : null;
        this.avgVolumeCache.values.set(symbol, avg);
      }
    }
    return new Map(symbols.map((s) => [s, this.avgVolumeCache.values.get(s) ?? null]));
  }

  // Headlines per symbol published since `since`.
  async getNews(symbols, since) {
    const out = new Map(symbols.map((s) => [s, []]));
    for (const group of chunks(symbols, 50)) {
      let pageToken;
      let pages = 0;
      do {
        const data = await this.get('/v1beta1/news', {
          symbols: group.join(','),
          start: since.toISOString(),
          limit: 50,
          sort: 'desc',
          page_token: pageToken,
        });
        for (const item of data.news ?? []) {
          const story = {
            headline: item.headline,
            url: item.url,
            source: item.source,
            publishedAt: parseTime(item.created_at),
          };
          for (const s of item.symbols ?? []) out.get(s)?.push(story);
        }
        pageToken = data.next_page_token;
        pages += 1;
      } while (pageToken && pages < 5);
    }
    return out;
  }
}
