import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePillars, passesGate, rankResults } from '../src/criteria.js';

const criteria = { minPrice: 1, maxPrice: 20, minChangePct: 10, minRvol: 5, maxFloat: 20e6, preferredFloat: 10e6 };

test('a textbook setup meets all five pillars', () => {
  const e = evaluatePillars({ price: 4.5, changePct: 35, rvol: 12, news: [{ headline: 'FDA approval' }], float: 3e6 }, criteria);
  assert.equal(e.met, 5);
  assert.equal(e.allMet, true);
  assert.equal(e.preferredFloat, true);
  assert.equal(passesGate(e), true);
});

test('missing data is unknown, never a pass', () => {
  const e = evaluatePillars({ price: 4.5, changePct: 35, rvol: null, news: null, float: undefined }, criteria);
  assert.deepEqual(e.pillars, { price: true, change: true, rvol: null, news: null, float: null });
  assert.equal(e.met, 2);
  assert.equal(e.allMet, false);
});

test('out-of-range price or small move fails the gate', () => {
  assert.equal(passesGate(evaluatePillars({ price: 25, changePct: 40 }, criteria)), false);
  assert.equal(passesGate(evaluatePillars({ price: 0.8, changePct: 40 }, criteria)), false);
  assert.equal(passesGate(evaluatePillars({ price: 5, changePct: 9.9 }, criteria)), false);
});

test('an empty news list fails the news pillar', () => {
  assert.equal(evaluatePillars({ news: [] }, criteria).pillars.news, false);
});

test('ranks by pillars met, then by % change', () => {
  const ranked = rankResults([
    { symbol: 'A', met: 3, changePct: 50 },
    { symbol: 'B', met: 5, changePct: 12 },
    { symbol: 'C', met: 3, changePct: 80 },
  ]);
  assert.deepEqual(ranked.map((r) => r.symbol), ['B', 'C', 'A']);
});
