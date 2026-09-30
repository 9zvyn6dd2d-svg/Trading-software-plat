import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketSession, premarketOpen } from '../src/market-session.js';

test('classifies Eastern-time sessions on a weekday (EDT)', () => {
  assert.equal(marketSession(new Date('2026-09-30T07:59:00Z')), 'closed'); // 3:59 ET
  assert.equal(marketSession(new Date('2026-09-30T08:00:00Z')), 'premarket'); // 4:00 ET
  assert.equal(marketSession(new Date('2026-09-30T13:29:00Z')), 'premarket'); // 9:29 ET
  assert.equal(marketSession(new Date('2026-09-30T13:30:00Z')), 'regular'); // 9:30 ET
  assert.equal(marketSession(new Date('2026-09-30T20:00:00Z')), 'afterhours'); // 16:00 ET
  assert.equal(marketSession(new Date('2026-10-01T00:00:00Z')), 'closed'); // 20:00 ET
});

test('handles standard time (EST) too', () => {
  assert.equal(marketSession(new Date('2026-12-02T14:30:00Z')), 'regular'); // 9:30 EST
  assert.equal(marketSession(new Date('2026-12-02T14:29:00Z')), 'premarket');
});

test('weekends are closed', () => {
  assert.equal(marketSession(new Date('2026-10-03T15:00:00Z')), 'closed');
});

test('premarketOpen is 04:00 Eastern on the same Eastern date', () => {
  assert.equal(premarketOpen(new Date('2026-09-30T14:00:00Z')).toISOString(), '2026-09-30T08:00:00.000Z');
  assert.equal(premarketOpen(new Date('2026-12-02T15:00:00Z')).toISOString(), '2026-12-02T09:00:00.000Z');
});
