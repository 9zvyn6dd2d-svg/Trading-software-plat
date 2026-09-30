function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function loadConfig() {
  return {
    port: num('PORT', 3000),
    scanIntervalMs: num('SCAN_INTERVAL_SECONDS', 15) * 1000,
    staleAfterMs: num('STALE_AFTER_SECONDS', 120) * 1000,
    watchlist: str('WATCHLIST')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    alpaca: {
      keyId: str('ALPACA_API_KEY'),
      secret: str('ALPACA_API_SECRET'),
      feed: str('ALPACA_FEED', 'iex').toLowerCase(),
    },
    fmpKey: str('FMP_API_KEY'),
    criteria: {
      minPrice: num('MIN_PRICE', 1),
      maxPrice: num('MAX_PRICE', 20),
      minChangePct: num('MIN_CHANGE_PCT', 10),
      minRvol: num('MIN_RVOL', 5),
      maxFloat: num('MAX_FLOAT', 20_000_000),
      preferredFloat: num('PREFERRED_FLOAT', 10_000_000),
      newsLookbackHours: num('NEWS_LOOKBACK_HOURS', 24),
    },
  };
}
