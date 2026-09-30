// Share float from Financial Modeling Prep (https://site.financialmodelingprep.com).
// Float changes slowly, so each symbol is fetched at most once per day to stay
// inside the free tier's daily request limit.

import { easternParts } from '../market-session.js';

const BASE = 'https://financialmodelingprep.com/stable/shares-float';

export class FmpFloatProvider {
  constructor(apiKey, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = { day: null, values: new Map() };
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  // Returns Map(symbol -> { shares, asOf }) where shares is null if FMP has no figure.
  async getFloats(symbols) {
    const today = easternParts(new Date(this.now())).dateKey;
    if (this.cache.day !== today) this.cache = { day: today, values: new Map() };
    const missing = symbols.filter((s) => !this.cache.values.has(s));
    const errors = [];
    await Promise.all(
      missing.map(async (symbol) => {
        try {
          const url = new URL(BASE);
          url.searchParams.set('symbol', symbol);
          url.searchParams.set('apikey', this.apiKey);
          const res = await this.fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const [row] = await res.json();
          this.cache.values.set(symbol, {
            shares: Number.isFinite(row?.floatShares) ? row.floatShares : null,
            asOf: row?.date ?? null,
          });
        } catch (err) {
          // Not cached, so the next scan retries.
          errors.push(`${symbol}: ${err.message}`);
        }
      }),
    );
    if (errors.length) {
      const e = new Error(`Float lookup failed for ${errors.length} symbol(s): ${errors.slice(0, 3).join('; ')}`);
      e.partial = new Map(symbols.filter((s) => this.cache.values.has(s)).map((s) => [s, this.cache.values.get(s)]));
      throw e;
    }
    return new Map(symbols.map((s) => [s, this.cache.values.get(s)]));
  }
}
