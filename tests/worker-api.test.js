import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { safeEqual, rateLimit } from '../worker/src/index.js';
import { recordSignalAndOutcome } from '../worker/src/core/historical-store.js';

let ipCounter = 0;
const uniqueIp = () => '198.51.100.' + (++ipCounter);
const call = (path, { method = 'GET', body, rawBody, headers = {}, env = {} } = {}) => worker.fetch(
  new Request('https://api.test' + path, {
    method,
    headers: { 'cf-connecting-ip': uniqueIp(), ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {})
  }),
  env
);

const quietConsole = async fn => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};
const withFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
};

test('safeEqual compares secrets correctly, including different lengths and non-strings', async () => {
  assert.equal(await safeEqual('token-123', 'token-123'), true);
  assert.equal(await safeEqual('token-123', 'token-124'), false);
  assert.equal(await safeEqual('short', 'a-much-longer-value'), false);
  assert.equal(await safeEqual(undefined, 'x'), false);
  assert.equal(await safeEqual('x', null), false);
});

test('rate limiter blocks after the limit with a Retry-After hint and recovers after the window', () => {
  const req = new Request('https://api.test/', { headers: { 'cf-connecting-ip': uniqueIp() } });
  const opts = { scope: 'unit', limit: 3, windowMs: 60000, now: 1_000_000 };
  for (let i = 0; i < 3; i++) rateLimit(req, {}, opts);
  assert.throws(() => rateLimit(req, {}, opts), error => error.status === 429 && Number(error.headers['retry-after']) >= 1);
  assert.doesNotThrow(() => rateLimit(req, {}, { ...opts, now: 1_000_000 + 60001 }));
});

test('order endpoint: unauthorised without a matching token, 403 (not 5xx) when authorised, 400 on bad JSON', async () => {
  const env = { ETI_EXECUTION_TOKEN: 'exec-secret' };
  assert.equal((await call('/api/eti/orders', { method: 'POST', body: {}, env: {} })).status, 401);
  assert.equal((await call('/api/eti/orders', { method: 'POST', body: {}, env, headers: { authorization: 'Bearer wrong' } })).status, 401);
  const blocked = await call('/api/eti/orders', { method: 'POST', body: { symbol: 'BTCUSDT' }, env, headers: { authorization: 'Bearer exec-secret' } });
  assert.equal(blocked.status, 403);
  const data = await blocked.json();
  assert.equal(data.executionAllowed, false);
  assert.equal(data.result.submitted, false);
  assert.match(data.result.reason, /hard-disabled/);
  const bad = await call('/api/eti/orders', { method: 'POST', rawBody: '{not json', env, headers: { authorization: 'Bearer exec-secret' } });
  assert.equal(bad.status, 400);
});

test('malformed JSON is a 400 client error, not a 502', async () => {
  const signals = await call('/api/eti/signals', { method: 'POST', rawBody: '{oops' });
  assert.equal(signals.status, 400);
  assert.match((await signals.json()).error, /valid JSON/);
  const plan = await call('/api/eti/trade-plan', { method: 'POST', rawBody: '[1,2]' });
  assert.equal(plan.status, 400);
  assert.equal((await plan.json()).executionAllowed, false);
});

test('ingestion and evaluation endpoints require the token and a D1 binding', async () => {
  const post = (path, env, headers = {}) => call(path, { method: 'POST', body: {}, env, headers });
  assert.equal((await post('/api/eti/observations', {})).status, 401);
  assert.equal((await post('/api/eti/observations', { ETI_INGESTION_TOKEN: 'ingest' }, { 'x-eti-ingestion-token': 'nope' })).status, 401);
  assert.equal((await post('/api/eti/observations', { ETI_INGESTION_TOKEN: 'ingest' }, { 'x-eti-ingestion-token': 'ingest' })).status, 503);
  assert.equal((await post('/api/eti/outcomes/evaluate', { ETI_INGESTION_TOKEN: 'ingest' }, { 'x-eti-ingestion-token': 'bad' })).status, 401);
});

test('history and performance reject unsupported product types before touching the database', async () => {
  const env = { DB: {} };
  assert.equal((await call('/api/eti/history?symbol=BTCUSDT&productType=TESTNET', { env })).status, 400);
  assert.equal((await call('/api/eti/performance?symbol=BTCUSDT&productType=TESTNET', { env })).status, 400);
});

test('upstream failures return a sanitised 502 and keep raw diagnostics out of the response', async () => {
  const response = await quietConsole(() => withFetch(
    async () => ({ ok: false, status: 403, headers: { get: key => key === 'server' ? 'cloudflare' : key === 'cf-ray' ? 'ray-secret-1' : 'text/html' }, text: async () => '<html>blocked by upstream</html>' }),
    () => call('/api/market/ticker?productType=USDT-FUTURES&symbol=BTCUSDT')
  ));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /HTTP 403/);
  assert.doesNotMatch(text, /ray-secret-1|cloudflare|blocked by upstream/);
});

// ---- Mocked Bitget + D1 for the signal route ----
const mixCandles = (granularity, count = 120) => {
  const step = { '1m': 60000, '5m': 300000, '15m': 900000, '1H': 3600000, '4H': 14400000, '1D': 86400000, '1W': 604800000 }[granularity] || 60000;
  const end = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 0.1;
    return [String(end - (count - 1 - i) * step), String(base), String(base + 0.5), String(base - 0.5), String(base + 0.2), '10', '1000'];
  });
};
const ok = data => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ code: '00000', data }) });
const bitgetMock = ({ failGranularity = null, symbols = ['BTCUSDT'] } = {}) => async input => {
  const url = new URL(String(input));
  const path = url.pathname;
  if (path.endsWith('/mix/market/candles')) {
    const g = url.searchParams.get('granularity');
    if (g === failGranularity) return { ok: false, status: 500, headers: { get: () => 'text/plain' }, text: async () => 'upstream exploded' };
    return ok(mixCandles(g));
  }
  if (path.endsWith('/mix/market/contracts')) return ok(symbols.map(symbol => ({ symbol, symbolStatus: 'normal' })));
  if (path.endsWith('/mix/market/merge-depth')) return ok({ ts: String(Date.now()), bids: [['100', '3']], asks: [['100.01', '2']] });
  if (path.endsWith('/mix/market/current-fund-rate')) return ok([{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateInterval: '8' }]);
  if (path.endsWith('/mix/market/open-interest')) return ok({ ts: String(Date.now()), openInterestList: [{ symbol: 'BTCUSDT', size: '1234' }] });
  if (path.endsWith('/mix/market/ticker')) return ok([{ lastPr: '112', bidPr: '111.9', askPr: '112.1', high24h: '113', low24h: '99', baseVolume: '10', quoteVolume: '1000' }]);
  throw new Error('unexpected Bitget endpoint ' + path);
};
const fakeDb = ({ failBatch = false, existingAfterFailure = null } = {}) => {
  const state = { inserts: [], batches: 0, batchSizes: [], runs: 0 };
  let firstCalls = 0;
  return {
    state,
    prepare: sql => ({
      bind: (...args) => ({
        sql, args,
        first: async () => { firstCalls++; return firstCalls > 1 ? existingAfterFailure : null; },
        all: async () => ({ results: [] }),
        run: async () => { state.runs++; if (/INSERT OR IGNORE INTO market_observations/.test(sql)) state.inserts.push(args); return { meta: { changes: 1 } }; }
      })
    }),
    batch: async statements => { state.batches++; state.batchSizes.push(statements.length); if (failBatch) throw new Error('UNIQUE constraint failed: signal_outcomes.dedupe_key'); return statements.map(() => ({ meta: { changes: 1 } })); }
  };
};

test('signal analysis survives a failed higher-timeframe fetch, stays fail-closed, and reports what was unavailable', async () => {
  const response = await quietConsole(() => withFetch(bitgetMock({ failGranularity: '4H' }), () => call('/api/eti/signals', { method: 'POST', body: { productType: 'USDT-FUTURES', symbol: 'BTCUSDT', granularity: '1min' } })));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.market.unavailableTimeframes, ['4H']);
  assert.equal(data.executionAllowed, false);
  assert.equal(data.decision, 'NO TRADE');
  assert.equal(data.executable, false);
});

test('signal route persists once per minute bucket, atomically, and only for catalogue-confirmed instruments', async () => {
  const db = fakeDb();
  const response = await withFetch(bitgetMock(), () => call('/api/eti/signals', { method: 'POST', body: { productType: 'USDT-FUTURES', symbol: 'BTCUSDT' }, env: { DB: db } }));
  assert.equal(response.status, 200);
  assert.ok(db.state.inserts.length >= 3, 'market observations were written');
  for (const args of db.state.inserts) assert.equal(args[5] % 60000, 0, 'observation timestamps are minute-bucketed so repeats dedupe');
  assert.equal(db.state.batches, 1);
  assert.equal(db.state.batchSizes[0], 2, 'signal event and outcome are written in one batch');

  const unknownDb = fakeDb();
  const unknown = await withFetch(bitgetMock({ symbols: ['ETHUSDT'] }), () => call('/api/eti/signals', { method: 'POST', body: { productType: 'USDT-FUTURES', symbol: 'BTCUSDT' }, env: { DB: unknownDb } }));
  assert.equal(unknown.status, 200);
  assert.equal(unknownDb.state.inserts.length, 0);
  assert.equal(unknownDb.state.batches, 0);
  assert.equal((await unknown.json()).history.signal.persisted, false);
});

test('recordSignalAndOutcome writes both rows in one batch and treats a unique-key race as a duplicate', async () => {
  const signal = { decision: 'NO TRADE', direction: 'NEUTRAL', rawDirection: 'BUY', score: 40, evidence: [], algorithm: 'ETIAlgo V3 Alpha', version: '3.0.0-alpha', analysis: { entryContext: { lastPrice: 100 } } };
  const good = fakeDb();
  const saved = await recordSignalAndOutcome(good, { signal, productType: 'USDT-FUTURES', symbol: 'BTCUSDT', timeframe: '1min', now: 1_700_000_000_000 });
  assert.equal(saved.persisted, true);
  assert.equal(good.state.batches, 1);
  assert.equal(good.state.runs, 0, 'no standalone inserts that could orphan a row');

  const raced = fakeDb({ failBatch: true, existingAfterFailure: { signal_id: 's-existing', id: 'o-existing' } });
  const duplicate = await recordSignalAndOutcome(raced, { signal, productType: 'USDT-FUTURES', symbol: 'BTCUSDT', timeframe: '1min', now: 1_700_000_000_000 });
  assert.deepEqual({ persisted: duplicate.persisted, duplicate: duplicate.duplicate, signalId: duplicate.signalId }, { persisted: true, duplicate: true, signalId: 's-existing' });

  const broken = fakeDb({ failBatch: true });
  await assert.rejects(() => recordSignalAndOutcome(broken, { signal, productType: 'USDT-FUTURES', symbol: 'BTCUSDT', timeframe: '1min', now: 1_700_000_000_000 }), /UNIQUE constraint/);
});

test('responses carry hardening headers', async () => {
  const response = await call('/api/health');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.liveEnabled, false);
});
