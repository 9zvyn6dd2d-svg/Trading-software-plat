import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runScan } from './scanner.js';
import { AlpacaProvider } from './providers/alpaca.js';
import { FmpFloatProvider } from './providers/fmp-float.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const REQUEST_TIMEOUT_MS = 10_000;

const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

export function createScannerApp(config, { market, floats, now = () => Date.now() } = {}) {
  market ??= new AlpacaProvider(config.alpaca, { fetchImpl: timedFetch });
  floats ??= new FmpFloatProvider(config.fmpKey, { fetchImpl: timedFetch });

  const clients = new Set();
  let latest = null;
  let lastLiveAt = null;
  let timer = null;
  let stopped = false;

  const payload = () => ({
    ...latest,
    serverTime: now(),
    lastLiveAt,
    scanIntervalMs: config.scanIntervalMs,
    staleAfterMs: config.staleAfterMs,
    criteria: config.criteria,
  });

  function broadcast() {
    const frame = `event: scan\ndata: ${JSON.stringify(payload())}\n\n`;
    for (const res of clients) res.write(frame);
  }

  async function scanOnce() {
    try {
      latest = await runScan({
        market,
        floats,
        criteria: config.criteria,
        watchlist: config.watchlist,
        staleAfterMs: config.staleAfterMs,
        now,
      });
    } catch (err) {
      latest = { status: 'error', scannedAt: now(), message: `Scanner failed: ${err.message}`, rows: [], warnings: [] };
    }
    if (latest.status === 'live') lastLiveAt = latest.scannedAt;
    broadcast();
    return latest;
  }

  async function loop() {
    await scanOnce();
    if (!stopped) timer = setTimeout(loop, config.scanIntervalMs);
  }

  async function serveStatic(req, res) {
    const path = new URL(req.url, 'http://x').pathname;
    const file = normalize(join(PUBLIC_DIR, path === '/' ? 'index.html' : path));
    if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      notFound(res);
    }
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/scan') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(latest ? payload() : { status: 'starting', rows: [] }));
    }
    if (path === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      if (latest) res.write(`event: scan\ndata: ${JSON.stringify(payload())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    return serveStatic(req, res);
  });

  // Heartbeat so the page can tell a quiet feed from a dead connection.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(`event: heartbeat\ndata: ${now()}\n\n`);
  }, 5_000);

  return {
    server,
    scanOnce,
    start() {
      loop();
      return new Promise((resolve) => server.listen(config.port, () => resolve(server.address())));
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const app = createScannerApp(config);
  const { port } = await app.start();
  console.log(`Scanner running at http://localhost:${port}`);
  if (!config.alpaca.keyId) console.log('No ALPACA_API_KEY set: the page will say no real-time data can be found.');
}
