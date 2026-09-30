// Renders scan results pushed from the server over Server-Sent Events.
// Freshness is re-checked every second in the browser too: if a row's last
// trade ages past the limit, or the server stops sending, the page says so
// instead of leaving old numbers looking live.

const $ = (id) => document.getElementById(id);
const PILLAR_LABELS = { price: 'Price', change: '% Up', rvol: 'RVOL', news: 'News', float: 'Float' };

let latest = null;
let lastMessageAt = 0; // browser time of the last event from the server
let clockOffset = 0; // server time minus browser time
const seenSymbols = new Set();
const newSymbols = new Map(); // symbol -> first seen (browser time)

const serverNow = () => Date.now() + clockOffset;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtNum(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '<span class="unknown">n/a</span>';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

function connectionLost() {
  if (!latest) return false;
  const limit = Math.max(3 * (latest.scanIntervalMs ?? 15000), 20000);
  return Date.now() - lastMessageAt > limit || serverNow() - latest.scannedAt > limit;
}

function setBanner(kind, text) {
  const b = $('banner');
  b.className = `banner banner-${kind}`;
  b.textContent = text;
}

function renderBanner() {
  if (!latest) return setBanner('waiting', 'Connecting to scanner…');
  if (connectionLost()) {
    const last = latest.lastLiveAt ? ` Last live data: ${fmtTime(latest.lastLiveAt)}.` : '';
    return setBanner('down', `Scanner is not updating, so no current data can be shown.${last} Retrying…`);
  }
  const lastLive = latest.lastLiveAt && latest.status !== 'live' ? ` Last live data: ${fmtTime(latest.lastLiveAt)}.` : '';
  switch (latest.status) {
    case 'live':
      return setBanner('live', `LIVE · ${latest.message}`);
    case 'closed':
      return setBanner('closed', latest.message);
    case 'starting':
      return setBanner('waiting', 'Scanner is starting…');
    default:
      return setBanner('down', `DATA UNAVAILABLE · ${latest.message}${lastLive}`);
  }
}

function pillarCell(row) {
  return `<div class="pillars">${Object.entries(PILLAR_LABELS)
    .map(([key, label]) => {
      const v = row.pillars[key];
      const cls = v === true ? 'pass' : v === false ? 'fail' : 'unknown';
      const mark = v === true ? '✓' : v === false ? '✗' : '?';
      const title = v === null ? `${label}: data not available` : label;
      return `<span class="${cls}" title="${esc(title)}">${mark} ${label}</span>`;
    })
    .join('')}</div>`;
}

function newsCell(row) {
  if (row.news === null) return '<span class="unknown">unavailable</span>';
  if (!row.news.length) return '<span class="unknown">none found</span>';
  const top = row.news[0];
  const more = row.news.length > 1 ? ` <span class="muted">+${row.news.length - 1}</span>` : '';
  return `<a href="${esc(top.url)}" target="_blank" rel="noopener">${esc(top.headline)}</a>
    <div class="muted">${esc(top.source)} · ${fmtTime(top.publishedAt)}</div>${more}`;
}

function renderRows() {
  const tbody = $('rows');
  const empty = $('empty');
  if (!latest || latest.status !== 'live' || connectionLost()) {
    tbody.innerHTML = '';
    empty.textContent = latest && latest.status !== 'live' && !connectionLost() ? 'No live results to show.' : 'No current data to show.';
    return;
  }
  const onlyAll = $('onlyAll').checked;
  const rows = latest.rows.filter((r) => !onlyAll || r.allMet);
  empty.textContent = rows.length ? '' : onlyAll && latest.rows.length ? 'No stock meets all five pillars right now.' : latest.message;

  tbody.innerHTML = rows
    .map((r) => {
      const age = serverNow() - r.lastTradeAt;
      const stale = age > latest.staleAfterMs;
      const isNew = newSymbols.has(r.symbol) && Date.now() - newSymbols.get(r.symbol) < 5 * 60_000;
      const floatNote = r.float !== null && r.float <= latest.criteria.preferredFloat ? ' title="Under preferred float"' : '';
      return `<tr class="${r.allMet ? 'all-met' : ''} ${stale ? 'stale' : ''}">
        <td><span class="sym">${esc(r.symbol)}</span>${isNew ? '<span class="new">NEW</span>' : ''}</td>
        <td class="num">${stale ? '<span class="unknown">stale</span>' : '$' + r.price.toFixed(r.price < 1 ? 4 : 2)}</td>
        <td class="num up">${stale ? '—' : '+' + r.changePct.toFixed(1) + '%'}</td>
        <td class="num">${fmtNum(r.volume)}</td>
        <td class="num">${r.rvol === null ? '<span class="unknown">n/a</span>' : r.rvol.toFixed(1) + 'x'}</td>
        <td class="num"${floatNote}>${fmtNum(r.float)}</td>
        <td class="news">${newsCell(r)}</td>
        <td>${pillarCell(r)}</td>
        <td>${fmtTime(r.lastTradeAt)}<div class="${stale ? 'age-stale' : 'muted'}">${stale ? 'STALE · ' : ''}${fmtAge(age)}</div></td>
      </tr>`;
    })
    .join('');
}

function renderMeta() {
  $('clock').textContent = new Date(serverNow()).toLocaleTimeString();
  if (!latest) return;
  $('session').textContent = latest.session ?? '—';
  $('provider').textContent = latest.provider ? `Data: ${latest.provider}` : '';
  $('scanned').textContent = latest.scannedAt ? `Last scan: ${fmtTime(latest.scannedAt)}` : '';
  const c = latest.criteria;
  if (c) {
    $('criteria').textContent =
      `$${c.minPrice}–$${c.maxPrice} · up ${c.minChangePct}%+ · RVOL ${c.minRvol}x+ · news in ${c.newsLookbackHours}h · float < ${fmtNum(c.maxFloat)}`;
  }
  $('warnings').innerHTML = (latest.warnings ?? []).map((w) => `<p>⚠ ${esc(w)}</p>`).join('');
}

function render() {
  renderBanner();
  renderRows();
  renderMeta();
}

function onScan(data) {
  latest = data;
  lastMessageAt = Date.now();
  if (data.serverTime) clockOffset = data.serverTime - Date.now();
  const firstBatch = seenSymbols.size === 0;
  for (const r of data.rows ?? []) {
    if (!seenSymbols.has(r.symbol)) {
      if (!firstBatch) newSymbols.set(r.symbol, Date.now());
      seenSymbols.add(r.symbol);
    }
  }
  render();
}

function connect() {
  const source = new EventSource('/api/stream');
  source.addEventListener('scan', (e) => onScan(JSON.parse(e.data)));
  source.addEventListener('heartbeat', (e) => {
    lastMessageAt = Date.now();
    clockOffset = Number(e.data) - Date.now();
  });
  // EventSource reconnects on its own; the 1s render loop shows the outage meanwhile.
}

$('onlyAll').addEventListener('change', render);
setInterval(render, 1000);
connect();
