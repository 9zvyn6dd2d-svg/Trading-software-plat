# Momentum Scanner

A web-based stock scanner that looks for small-cap stocks that may be about to make a big move, using Ross Cameron's five pillars of stock selection. It runs on real-time market data only, and says so plainly when fresh data cannot be found.

## The five pillars

| Pillar | Default | Setting |
| --- | --- | --- |
| Price | $1 to $20 | `MIN_PRICE`, `MAX_PRICE` |
| Up on the day | 10% or more from the previous close | `MIN_CHANGE_PCT` |
| Relative volume | 5x or more of the 30-day average daily volume | `MIN_RVOL` |
| News catalyst | A headline in the last 24 hours | `NEWS_LOOKBACK_HOURS` |
| Low float | Under 20M shares (under 10M is marked as preferred) | `MAX_FLOAT`, `PREFERRED_FLOAT` |

A stock appears once it passes price and % change. The other three pillars are shown as ✓, ✗ or ? (data unavailable), and rows are ranked by how many pillars they meet. A stock meeting all five gets a green edge; tick "Only show 5 / 5 pillars" to hide the rest. Missing data is never counted as a pass.

## Real-time data and what happens when it isn't available

- Every row shows the time of its last trade and how long ago that was, updated every second.
- A quote whose last trade is older than `STALE_AFTER_SECONDS` (default 120) is not treated as live. It's dropped from the results, and if every quote is that old the page shows **DATA UNAVAILABLE: No fresh data could be found**.
- If the data provider errors or can't be reached, the page shows **DATA UNAVAILABLE** with the reason and the time of the last live scan. No old prices are left on screen.
- If the browser stops hearing from the server, it clears the table and says the scanner is not updating.
- Outside 4:00 AM to 8:00 PM ET on weekdays the page says the market is closed and no live data can be found.
- With no API key set, the page says no real-time data can be found. The app never shows sample or mock data.

## High volume section

Below the five-pillar scan, a second table lists up to 25 stocks in the price range that are trading at `MIN_RVOL` (default 5x) or more of their normal volume, busiest first, whatever their % change. It catches stocks that are getting heavy volume before the price has moved 10%. The same freshness rules apply: stale quotes are left out and the table empties whenever data is unavailable.

## Refresh rate

Everything (prices, % change, volume, relative volume, news, both tables) refreshes every `SCAN_INTERVAL_SECONDS`, default **3 seconds**, and is pushed to the page as it comes in. Float is looked up once a day per stock because it doesn't change intraday, and the 30-day average volume is also computed once a day. If FMP refuses a float lookup (for example, a stock its free plan doesn't cover), that stock is not asked for again for 15 minutes, and a rate-limit answer pauses all float lookups for 15 minutes, so failures can't use up the 250 free lookups a day.

Alpaca's free plan allows 200 requests a minute. A 3-second scan uses about 100 to 140 a minute in normal conditions (up to about 170 in a busy pre-market), and the current rate is shown at the bottom of the page. If Alpaca ever answers "rate limit reached", the page says data is unavailable, the scanner waits 15 seconds before trying again, and you can raise `SCAN_INTERVAL_SECONDS`.

## Setup

Requires Node.js 22 or newer. There are no npm dependencies.

1. **Get an Alpaca market data key (required).** Create a free account at [alpaca.markets](https://alpaca.markets). In the dashboard, switch to Paper Trading, find **API Keys** on the home page and click **Generate New Keys**. Copy both the key and the secret (the secret is shown only once).
2. **Get a Financial Modeling Prep key (optional, for float).** Sign up at [financialmodelingprep.com](https://site.financialmodelingprep.com/developer/docs) and copy your API key from the dashboard. Without it, the float pillar shows "?".
3. Copy `.env.example` to `.env` and paste the keys in:
   ```
   ALPACA_API_KEY=your-key-id
   ALPACA_API_SECRET=your-secret
   FMP_API_KEY=your-fmp-key
   ```
4. Start it and open http://localhost:3000:
   ```
   npm start
   ```

## Data feed limits

Alpaca's free plan gives real-time data from the **IEX** exchange only. Prices are real-time, but IEX carries a small share of all US volume, so volume and relative volume are measured on IEX alone (both today's volume and the average use the same feed, so the ratio stays comparable). For whole-market volume, subscribe to Alpaca's paid **Algo Trader Plus** data plan and set `ALPACA_FEED=sip`.

Candidates come from Alpaca's top gainers (50) and most-active (100) lists, plus any symbols in `WATCHLIST`. A mover outside those lists won't be found unless you add it to the watchlist.

Relative volume uses today's volume against the 30-day average daily volume. In pre-market, today's volume is summed from minute bars since 4:00 AM ET. During regular hours it is the regular-session volume.

## Swapping the data provider

`src/providers/alpaca.js` is the only file that talks to the market data API. Any class with the same methods (`isConfigured`, `getCandidateSymbols`, `getQuotes`, `getAverageVolumes`, `getVolumeSince`, `getNews`) can replace it in `src/server.js`. Float comes from `src/providers/fmp-float.js` the same way.

## Tests

```
npm test
```

The tests use stand-in providers to check the pillar logic, the stale and unavailable states, session times and the Alpaca response parsing. Those stand-ins exist only in `test/`.

Not financial advice.
