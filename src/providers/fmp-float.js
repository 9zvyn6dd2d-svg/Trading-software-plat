// Share float from Financial Modeling Prep (https://site.financialmodelingprep.com).
// Float changes slowly, so each symbol is fetched at most once per day to stay
// inside the free tier's daily request limit.

import { easternParts } from '../market-session.js';

const BASE = 'https://financialmodelingprep.com/stable/shares-float';
// A symbol whose lookup failed (e.g. not covered by the free plan) is not asked
// for again until this long has passed, so failures can't burn the daily quota.
const RETRY_AFTER_MS = 15 * 60_000;

export class FmpFloatProvider {
  constructor(apiKey, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = { day: null, values: new Map() };
    this.failures = new Map(); // symbol -> { message, retryAt }
    this.pausedUntil = 0; // set after HTTP 429 so no symbol is tried
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  // Returns Map(symbol -> { shares, asOf }) where shares is null if FMP has no figure.
  async getFloats(symbols) {
    const today = easternParts(new Date(this.now())).dateKey;
    if (this.cache.day !== today) this.cache = { day: today, values: new Map() };
    const now = this.now();
    const due = (s) => !this.cache.values.has(s) && (this.failures.get(s)?.retryAt ?? 0) <= now;
    const toFetch = now < this.pausedUntil ? [] : symbols.filter(due);
    await Promise.all(
      toFetch.map(async (symbol) => {
        try {
          const url = new URL(BASE);
          url.searchParams.set('symbol', symbol);
          url.searchParams.set('apikey', this.apiKey);
          const res = await this.fetch(url);
          if (res.status === 429) this.pausedUntil = now + RETRY_AFTER_MS;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const [row] = await res.json();
          this.cache.values.set(symbol, {
            shares: Number.isFinite(row?.floatShares) ? row.floatShares : null,
            asOf: row?.date ?? null,
          });
          this.failures.delete(symbol);
        } catch (err) {
          this.failures.set(symbol, { message: err.message, retryAt: now + RETRY_AFTER_MS });
        }
      }),
    );
    const unresolved = symbols.filter((s) => !this.cache.values.has(s));
    if (unresolved.length) {
      const reasons = unresolved.slice(0, 3).map((s) => `${s}: ${this.failures.get(s)?.message ?? 'lookups paused'}`);
      const e = new Error(
        `Float lookup failed for ${unresolved.length} symbol(s) (${reasons.join('; ')}); retrying every ${RETRY_AFTER_MS / 60_000} minutes`,
      );
      e.partial = new Map(symbols.filter((s) => this.cache.values.has(s)).map((s) => [s, this.cache.values.get(s)]));
      throw e;
    }
    return new Map(symbols.map((s) => [s, this.cache.values.get(s)]));
  }
}
