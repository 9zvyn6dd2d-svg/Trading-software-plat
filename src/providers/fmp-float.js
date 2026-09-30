// Share float from Financial Modeling Prep (https://site.financialmodelingprep.com).
// Float changes slowly, so each symbol is fetched at most once per day to stay
// inside the free tier's daily request limit.
//
// FMP's free plan only serves the float endpoint for a handful of large caps and
// answers HTTP 402 for everything else. For those symbols we fall back to the
// free company profile and derive shares outstanding (market cap / price).
// Float is never more than shares outstanding, so a small outstanding count
// proves a small float; a large one leaves float unknown.

import { easternParts } from '../market-session.js';

const BASE = 'https://financialmodelingprep.com/stable';
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

  async get(path, symbol) {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('apikey', this.apiKey);
    const res = await this.fetch(url);
    if (res.status === 429) this.pausedUntil = this.now() + RETRY_AFTER_MS;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const [row] = await res.json();
    return row;
  }

  async lookup(symbol) {
    try {
      const row = await this.get('shares-float', symbol);
      if (Number.isFinite(row?.floatShares)) {
        return { shares: row.floatShares, outstanding: row.outstandingShares ?? null, asOf: row.date ?? null, source: 'float' };
      }
    } catch (err) {
      if (err.status !== 402) throw err; // 402: float not on this plan for this symbol
    }
    const profile = await this.get('profile', symbol);
    const outstanding =
      Number.isFinite(profile?.marketCap) && profile?.price > 0 ? Math.round(profile.marketCap / profile.price) : null;
    return { shares: null, outstanding, asOf: null, source: outstanding === null ? 'none' : 'outstanding' };
  }

  // Returns Map(symbol -> { shares, outstanding, asOf, source }). shares is the
  // float, or null when only shares outstanding (or nothing) is known.
  async getFloats(symbols) {
    const today = easternParts(new Date(this.now())).dateKey;
    if (this.cache.day !== today) this.cache = { day: today, values: new Map() };
    const now = this.now();
    const due = (s) => !this.cache.values.has(s) && (this.failures.get(s)?.retryAt ?? 0) <= now;
    const toFetch = now < this.pausedUntil ? [] : symbols.filter(due);
    await Promise.all(
      toFetch.map(async (symbol) => {
        try {
          this.cache.values.set(symbol, await this.lookup(symbol));
          this.failures.delete(symbol);
        } catch (err) {
          this.failures.set(symbol, { message: err.message, retryAt: now + RETRY_AFTER_MS });
        }
      }),
    );
    const known = new Map(symbols.filter((s) => this.cache.values.has(s)).map((s) => [s, this.cache.values.get(s)]));
    const unresolved = symbols.filter((s) => !this.cache.values.has(s));
    if (unresolved.length) {
      const reasons = unresolved.slice(0, 3).map((s) => `${s}: ${this.failures.get(s)?.message ?? 'lookups paused'}`);
      const e = new Error(
        `Float lookup failed for ${unresolved.length} symbol(s) (${reasons.join('; ')}); retrying every ${RETRY_AFTER_MS / 60_000} minutes`,
      );
      e.partial = known;
      throw e;
    }
    return known;
  }
}
