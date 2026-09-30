import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScannerApp } from '../src/server.js';

const config = {
  port: 0,
  scanIntervalMs: 60_000,
  staleAfterMs: 120_000,
  watchlist: [],
  alpaca: {},
  fmpKey: '',
  criteria: { minPrice: 1, maxPrice: 20, minChangePct: 10, minRvol: 5, maxFloat: 20e6, preferredFloat: 10e6, newsLookbackHours: 24 },
};

test('serves the page and reports that no data can be found without a key', async () => {
  const app = createScannerApp(config, {
    market: { name: 'Fake', isConfigured: () => false },
    floats: { isConfigured: () => false },
  });
  const { port } = await app.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Momentum Scanner/);

    await app.scanOnce();
    const scan = await (await fetch(`${base}/api/scan`)).json();
    assert.equal(scan.status, 'not_configured');
    assert.deepEqual(scan.rows, []);
    assert.equal(scan.lastLiveAt, null);

    const stream = await fetch(`${base}/api/stream`);
    const reader = stream.body.getReader();
    let text = '';
    while (!text.includes('event: scan')) text += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    assert.match(text, /"status":"not_configured"/);

    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  } finally {
    await app.stop();
  }
});
