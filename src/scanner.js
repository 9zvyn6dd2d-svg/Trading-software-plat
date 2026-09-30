import { evaluatePillars, passesGate, rankResults } from './criteria.js';
import { marketSession, premarketOpen } from './market-session.js';

// Runs one scan and returns a result the page can render as-is.
//
// status is one of:
//   live            fresh quotes were found; `rows` holds the matches
//   stale           the feed answered but no quote traded recently enough
//   error           the data provider could not be reached or refused us
//   closed          outside 04:00-20:00 ET on a weekday, nothing trades
//   not_configured  no market data API key has been set
//
// Only `live` results carry rows. Every other status carries a plain-English
// `message` and no prices, so nothing old is ever shown as current.
export async function runScan({ market, floats, criteria, watchlist = [], staleAfterMs, now = () => Date.now() }) {
  const startedAt = now();
  const base = { scannedAt: startedAt, provider: market.name, warnings: [] };
  const session = marketSession(new Date(startedAt));

  if (!market.isConfigured()) {
    return {
      ...base,
      status: 'not_configured',
      session,
      message: 'No market data key is set, so no real-time data can be found. Add ALPACA_API_KEY and ALPACA_API_SECRET to .env and restart.',
      rows: [],
    };
  }
  if (session === 'closed') {
    return {
      ...base,
      status: 'closed',
      session,
      message: 'The market is closed (pre-market opens 4:00 AM ET on weekdays). No live data can be found right now.',
      rows: [],
    };
  }

  let symbols, quotes;
  try {
    symbols = [...new Set([...(await market.getCandidateSymbols()), ...watchlist])];
    quotes = await market.getQuotes(symbols);
  } catch (err) {
    return { ...base, status: 'error', session, message: `Real-time data could not be found: ${err.message}`, rows: [] };
  }

  const fresh = [];
  const stale = [];
  let newestTrade = null;
  for (const [symbol, q] of quotes) {
    if (q.lastTradeAt !== null) newestTrade = Math.max(newestTrade ?? 0, q.lastTradeAt);
    const ageMs = q.lastTradeAt === null ? Infinity : startedAt - q.lastTradeAt;
    (ageMs <= staleAfterMs ? fresh : stale).push({ symbol, ...q, ageMs });
  }

  if (fresh.length === 0) {
    const last = newestTrade ? new Date(newestTrade).toISOString() : 'never';
    return {
      ...base,
      status: 'stale',
      session,
      newestTradeAt: newestTrade,
      message: `No fresh data could be found: none of the ${quotes.size} symbols checked has traded in the last ${Math.round(staleAfterMs / 1000)} seconds (latest trade seen: ${last}).`,
      rows: [],
    };
  }

  // Price and % change gate, on fresh quotes only.
  const gated = [];
  for (const q of fresh) {
    const changePct = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
    const row = { ...q, changePct };
    if (passesGate(evaluatePillars(row, criteria))) gated.push(row);
  }
  const gatedSymbols = gated.map((r) => r.symbol);

  // Enrichment. A failure here marks that pillar unknown and says why; it never
  // blocks the live price data from showing.
  const settle = async (label, fn) => {
    if (!gatedSymbols.length) return new Map();
    try {
      return await fn();
    } catch (err) {
      base.warnings.push(`${label} unavailable: ${err.message}`);
      return err.partial ?? null;
    }
  };
  const sinceNews = new Date(startedAt - criteria.newsLookbackHours * 3_600_000);
  const [avgVolumes, premarketVolumes, news, floatMap] = await Promise.all([
    settle('Average volume', () => market.getAverageVolumes(gatedSymbols)),
    session === 'premarket'
      ? settle('Pre-market volume', () => market.getVolumeSince(gatedSymbols, premarketOpen(new Date(startedAt))))
      : Promise.resolve(null),
    settle('News', () => market.getNews(gatedSymbols, sinceNews)),
    floats?.isConfigured()
      ? settle('Float', () => floats.getFloats(gatedSymbols))
      : Promise.resolve(null),
  ]);
  if (!floats?.isConfigured() && gatedSymbols.length) {
    base.warnings.push('Float unavailable: FMP_API_KEY is not set, so the float pillar is unknown.');
  }

  const rows = gated.map((r) => {
    const volume = session === 'premarket' ? premarketVolumes?.get(r.symbol) ?? null : r.sessionVolume;
    const avgVolume = avgVolumes?.get(r.symbol) ?? null;
    const floatInfo = floatMap?.get(r.symbol);
    const row = {
      symbol: r.symbol,
      price: r.price,
      prevClose: r.prevClose,
      changePct: r.changePct,
      volume,
      avgVolume,
      rvol: volume !== null && avgVolume ? volume / avgVolume : null,
      float: floatInfo?.shares ?? null,
      floatAsOf: floatInfo?.asOf ?? null,
      news: news ? news.get(r.symbol) ?? [] : null,
      lastTradeAt: r.lastTradeAt,
      ageMs: r.ageMs,
    };
    return { ...row, ...evaluatePillars(row, criteria) };
  });

  return {
    ...base,
    status: 'live',
    session,
    newestTradeAt: newestTrade,
    checked: quotes.size,
    staleCount: stale.length,
    message: rows.length
      ? `${rows.length} stock(s) up ${criteria.minChangePct}%+ between $${criteria.minPrice} and $${criteria.maxPrice}.`
      : `Live data found for ${fresh.length} symbols, but none are up ${criteria.minChangePct}%+ between $${criteria.minPrice} and $${criteria.maxPrice} right now.`,
    rows: rankResults(rows),
  };
}
