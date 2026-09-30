// Ross Cameron's five pillars of stock selection. Each pillar resolves to
// true (met), false (not met) or null (the data needed to judge it is missing).
// Missing data never counts as a pass.

export const PILLARS = ['price', 'change', 'rvol', 'news', 'float'];

export function evaluatePillars(stock, criteria) {
  const known = (v) => v !== null && v !== undefined && Number.isFinite(v);

  const price = known(stock.price)
    ? stock.price >= criteria.minPrice && stock.price <= criteria.maxPrice
    : null;
  const change = known(stock.changePct) ? stock.changePct >= criteria.minChangePct : null;
  const rvol = known(stock.rvol) ? stock.rvol >= criteria.minRvol : null;
  const news = Array.isArray(stock.news) ? stock.news.length > 0 : null;
  const float = known(stock.float) ? stock.float <= criteria.maxFloat : null;

  const pillars = { price, change, rvol, news, float };
  const met = PILLARS.filter((p) => pillars[p] === true).length;
  return {
    pillars,
    met,
    allMet: met === PILLARS.length,
    preferredFloat: known(stock.float) && stock.float <= criteria.preferredFloat,
  };
}

// The first two pillars are the hard gate for showing a stock at all; the
// rest are scored so traders can see what a mover is still missing.
export function passesGate(evaluation) {
  return evaluation.pillars.price === true && evaluation.pillars.change === true;
}

export function rankResults(rows) {
  return [...rows].sort((a, b) => b.met - a.met || b.changePct - a.changePct);
}
