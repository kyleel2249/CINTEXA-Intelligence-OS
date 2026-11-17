import { evaluateTrade } from './core/signals.js';
import { buildTradePlan } from './core/trade-planner.js';
import { submitBitgetLiveOrder } from './exchanges/bitget.js';
import { getBitgetInstruments, getBitgetTicker, getBitgetCandles, getBitgetMarketContext, UpstreamError } from './exchanges/bitget-market.js';
import { persistMarketObservation, readMarketHistory, recordSignalAndOutcome, evaluatePendingOutcomes, readSignalPerformance } from './core/historical-store.js';

const PRODUCT_TYPES = new Set(['SPOT', 'MARGIN', 'USDT-FUTURES', 'USDC-FUTURES', 'COIN-FUTURES']);
const MULTI_GRANULARITIES = ['1min', '5min', '15min', '1H', '4H', '1D', '1W'];
const granularityMs = { '1min':60000,'3min':180000,'5min':300000,'15min':900000,'30min':1800000,'1H':3600000,'2H':7200000,'4H':14400000,'6H':21600000,'12H':43200000,'1D':86400000,'3D':259200000,'1W':604800000,'1M':2592000000 };
const OBSERVATION_BUCKET_MS = 60000;

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

const cors = env => ({
  'access-control-allow-origin': env.CORS_ORIGIN || 'https://cintexa.com',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-eti-ingestion-token',
  vary: 'Origin'
});
const json = (data, status = 200, env = {}, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...cors(env),
    ...extraHeaders
  }
});

// Constant-time secret comparison: both values are hashed first so length differences do not leak through timing.
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function readJson(req) {
  let body;
  try { body = await req.json(); }
  catch { throw new SyntaxError('Request body must be valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('A JSON object request body is required');
  return body;
}

function assertProductType(value) {
  const productType = String(value || 'USDT-FUTURES').toUpperCase();
  if (!PRODUCT_TYPES.has(productType)) throw new TypeError('Unsupported Bitget product type');
  return productType;
}

// Best-effort per-isolate limiter for the most expensive public endpoint. Cloudflare rate-limiting rules remain the
// authoritative control because isolates do not share memory; see README "Abuse protection".
const buckets = new Map();
export function rateLimit(req, env = {}, { scope = 'default', limit = Number(env.RATE_LIMIT_PER_MIN) || 30, windowMs = 60000, now = Date.now() } = {}) {
  const key = scope + ':' + (req.headers.get('cf-connecting-ip') || 'unknown');
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now + windowMs }; buckets.set(key, bucket); }
  bucket.count++;
  if (bucket.count > limit) throw new HttpError(429, 'Too many requests. Please retry shortly.', { 'retry-after': String(Math.max(1, Math.ceil((bucket.reset - now) / 1000))) });
}

const saveObservation = async (env, observation) => {
  if (!env.DB) return { persisted: false, reason: 'D1 binding unavailable' };
  try { return await persistMarketObservation(env.DB, observation); }
  catch (error) { return { persisted: false, reason: error.message }; }
};

async function saveSignalMarketContext(env, { context, ticker, productType, symbol }) {
  if (!env.DB || !context) return { stored: 0, errors: ['D1 or market context unavailable'] };
  const now = Date.now();
  // Timestamps are bucketed to the minute so repeated requests inside one minute collapse onto the UNIQUE index
  // instead of inserting a new row per request.
  const bucket = t => Math.floor((Number(t) || now) / OBSERVATION_BUCKET_MS) * OBSERVATION_BUCKET_MS;
  const rows = [];
  if (context.orderBook?.valid) rows.push({ observationType: 'ORDER_BOOK', observedAt: bucket(context.orderBook.timestamp), data: { mid: context.orderBook.mid, spreadBps: context.orderBook.spreadBps, bidNotional: context.orderBook.bidNotional, askNotional: context.orderBook.askNotional, notionalImbalance: context.orderBook.notionalImbalance, microPrice: context.orderBook.microPrice } });
  if (context.funding && Number.isFinite(Number(context.funding.rate))) rows.push({ observationType: 'FUNDING', observedAt: bucket(context.funding.timestamp || context.timestamp), data: { rate: Number(context.funding.rate) } });
  if (context.openInterest && Number.isFinite(Number(context.openInterest.size))) rows.push({ observationType: 'OPEN_INTEREST', observedAt: bucket(context.openInterest.timestamp || context.timestamp), data: { size: Number(context.openInterest.size) } });
  if (ticker && Number.isFinite(Number(ticker.last))) rows.push({ observationType: 'TICKER', observedAt: bucket(ticker.timestamp), data: { last: Number(ticker.last) } });
  const results = await Promise.all(rows.map(row => saveObservation(env, { ...row, productType, symbol, source: 'BITGET' })));
  return { stored: results.filter(x => x.stored).length, duplicates: results.filter(x => x.duplicate).length, errors: results.filter(x => !x.stored && !x.duplicate).map(x => x.reason) };
}

async function requireIngestionToken(req, env, message) {
  if (!env.ETI_INGESTION_TOKEN || !(await safeEqual(req.headers.get('x-eti-ingestion-token') || '', env.ETI_INGESTION_TOKEN))) throw new HttpError(401, message);
  if (!env.DB) throw new HttpError(503, 'D1 database binding is unavailable');
}

async function handleSignals(req, env) {
  rateLimit(req, env, { scope: 'signals' });
  const body = await readJson(req);
  const productType = assertProductType(body.productType), symbol = body.symbol, granularity = body.granularity || '1min';
  const otherGranularities = MULTI_GRANULARITIES.filter(g => g !== granularity);
  const [candles, timeframeSettled, instruments, contextResult, tickerResult] = await Promise.all([
    getBitgetCandles({ productType, symbol, granularity, limit: 200 }),
    // A failed higher-timeframe request must not fail the whole analysis; it only reduces confirmation (fail-closed).
    Promise.allSettled(otherGranularities.map(async g => [g, await getBitgetCandles({ productType, symbol, granularity: g, limit: g === '5min' ? 400 : 200 })])),
    getBitgetInstruments({ productType }).catch(() => null),
    getBitgetMarketContext({ productType, symbol }).then(data => ({ data })).catch(error => ({ error: error.publicMessage || error.message })),
    getBitgetTicker({ productType, symbol }).then(data => ({ data })).catch(error => ({ error: error.publicMessage || error.message }))
  ]);
  const timeframeRows = timeframeSettled.filter(r => r.status === 'fulfilled').map(r => r.value);
  const unavailableTimeframes = otherGranularities.filter(g => !timeframeRows.some(([name]) => name === g));
  const timeframes = Object.fromEntries([[granularity, candles], ...timeframeRows]), marketContext = contextResult.data || null;
  const instrument = Array.isArray(instruments) ? instruments.find(x => String(x.symbol).toUpperCase() === String(symbol).toUpperCase()) : null;
  const latest = candles.at(-1), fresh = Boolean(latest && Date.now() - latest.time <= 2 * (granularityMs[granularity] || 60000));
  const instrumentTradable = Boolean(instrument && ['normal', 'online', 'listed'].includes(String(instrument.symbolStatus || instrument.status || '').toLowerCase()));
  const result = await evaluateTrade({ candles, timeframes, primaryTimeframe: granularity, market: { dataFresh: fresh, instrumentTradable, source: 'BITGET', context: marketContext }, risk: { approved: false } });
  // Only persist for symbols the exchange catalogue confirms; this keeps arbitrary public requests from polluting history.
  let historyWrite = { stored: 0, errors: ['Instrument not confirmed in the Bitget catalogue; nothing persisted'] };
  let signalWrite = { persisted: false, reason: 'D1 binding unavailable or instrument unconfirmed' }, outcomeWrite = { updated: 0 };
  if (instrument) {
    historyWrite = await saveSignalMarketContext(env, { context: marketContext, ticker: tickerResult.data, productType, symbol });
    if (env.DB) try {
      signalWrite = await recordSignalAndOutcome(env.DB, { signal: result, productType, symbol, timeframe: granularity });
      outcomeWrite = await evaluatePendingOutcomes(env.DB, { symbol, productType, candles: timeframes['5min'] || [], barDurationMs: 300000 });
    } catch (error) { signalWrite = { ...signalWrite, reason: error.message }; }
  }
  return json({
    ...result,
    history: { marketObservations: historyWrite, signal: signalWrite, outcomes: outcomeWrite },
    market: { exchange: 'BITGET', productType, symbol, granularity, lastCandleTime: latest?.time ?? null, dataFresh: fresh, instrumentTradable, contextAvailable: Boolean(marketContext), contextError: contextResult.error || null, unavailableTimeframes },
    executionAllowed: false,
    executionBlock: 'ETIAlgo V3 Alpha is active; live execution remains blocked pending verified account risk, protective orders, idempotency and reconciliation.'
  }, 200, env);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (u.pathname === '/api/health') return json({
        status: 'ok', service: 'CINTEXA Intelligence OS', execution: 'BITGET_LIVE_ONLY', marketData: 'BITGET_PUBLIC_REST',
        historicalIntelligence: Boolean(env.DB), liveEnabled: false,
        liveBlock: 'Live order routing remains hard-disabled until verified server-side risk, protective orders, idempotency and reconciliation are implemented.'
      }, 200, env);
      if (u.pathname === '/api/departments') return json({ departments: ['ETI', 'AIM', 'RDM', 'OPS', 'COMMS', 'WEB', 'MKT', 'BIZ', 'FIN', 'CRE', 'SUP', 'RDI'].map(id => ({ id, mode: id === 'ETI' ? 'live_bitget_only' : 'department' })) }, 200, env);

      if (u.pathname === '/api/market/instruments' && req.method === 'GET') {
        const productType = u.searchParams.get('productType') || 'USDT-FUTURES';
        return json({ exchange: 'BITGET', productType, data: await getBitgetInstruments({ productType }) }, 200, env);
      }
      if (u.pathname === '/api/market/ticker' && req.method === 'GET') {
        const productType = u.searchParams.get('productType') || 'USDT-FUTURES', symbol = u.searchParams.get('symbol');
        return json(await getBitgetTicker({ productType, symbol }), 200, env);
      }
      if (u.pathname === '/api/market/context' && req.method === 'GET') {
        const productType = u.searchParams.get('productType') || 'USDT-FUTURES', symbol = u.searchParams.get('symbol');
        return json(await getBitgetMarketContext({ productType, symbol }), 200, env);
      }
      if (u.pathname === '/api/market/candles' && req.method === 'GET') {
        const productType = u.searchParams.get('productType') || 'USDT-FUTURES', symbol = u.searchParams.get('symbol'), granularity = u.searchParams.get('granularity') || '1min', limit = u.searchParams.get('limit') || 200;
        const candles = await getBitgetCandles({ productType, symbol, granularity, limit });
        return json({ exchange: 'BITGET', productType, symbol, granularity, candles }, 200, env);
      }
      if (u.pathname === '/api/eti/trade-plan' && req.method === 'POST') {
        let body;
        try { body = await readJson(req); }
        catch (error) { return json({ error: error.message, executionAllowed: false }, 400, env); }
        const allowed = ['direction', 'entry', 'atr', 'candles', 'equity', 'riskFraction', 'leverage', 'availableBalance', 'maxNotional', 'feeRate', 'makerFeeRate', 'takerFeeRate', 'slippageRate', 'targets', 'marginMode', 'contractMultiplier', 'quantityStep', 'minQuantity', 'minNotional', 'priceTick', 'fundingRate', 'fundingIntervals', 'exchangeMaxLeverage'];
        const input = Object.fromEntries(allowed.filter(k => Object.hasOwn(body, k)).map(k => [k, body[k]]));
        const plan = buildTradePlan(input);
        return json({ plan, executionAllowed: false, executionReady: false, notice: 'Calculator output only. This endpoint cannot submit, authorize or queue an exchange order.' }, 200, env);
      }
      if (u.pathname === '/api/eti/signals' && req.method === 'POST') return await handleSignals(req, env);
      if (u.pathname === '/api/eti/observations' && req.method === 'POST') {
        await requireIngestionToken(req, env, 'Unauthorised observation ingestion');
        return json(await persistMarketObservation(env.DB, await readJson(req)), 200, env);
      }
      if (u.pathname === '/api/eti/history' && req.method === 'GET') {
        if (!env.DB) return json({ error: 'D1 database binding is unavailable' }, 503, env);
        return json(await readMarketHistory(env.DB, { symbol: u.searchParams.get('symbol'), productType: assertProductType(u.searchParams.get('productType')), hours: u.searchParams.get('hours') || 24, limit: u.searchParams.get('limit') || 1000 }), 200, env);
      }
      if (u.pathname === '/api/eti/outcomes/evaluate' && req.method === 'POST') {
        await requireIngestionToken(req, env, 'Unauthorised outcome evaluation');
        return json(await evaluatePendingOutcomes(env.DB, await readJson(req)), 200, env);
      }
      if (u.pathname === '/api/eti/performance' && req.method === 'GET') {
        if (!env.DB) return json({ error: 'D1 database binding is unavailable' }, 503, env);
        return json(await readSignalPerformance(env.DB, { symbol: u.searchParams.get('symbol'), productType: assertProductType(u.searchParams.get('productType')), limit: u.searchParams.get('limit') || 1000 }), 200, env);
      }
      if (u.pathname === '/api/eti/orders' && req.method === 'POST') {
        if (!env.ETI_EXECUTION_TOKEN || !(await safeEqual(req.headers.get('authorization') || '', `Bearer ${env.ETI_EXECUTION_TOKEN}`))) return json({ error: 'Unauthorised' }, 401, env);
        const order = await readJson(req);
        let result;
        try { await submitBitgetLiveOrder({ env, order }); result = { submitted: false }; }
        catch (error) { result = { submitted: false, reason: error.message }; }
        // Order submission is hard-disabled by design: always answer 403, never 5xx, and never report a submission.
        return json({ error: 'Live order routing is disabled', result, executionAllowed: false }, 403, env);
      }
      return json({ error: 'Not found' }, 404, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, env, error.headers);
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return json({ error: error.message || 'Invalid request' }, 400, env);
      // Full diagnostics stay in Worker logs; clients only receive a safe message.
      console.error('[cintexa-api]', u.pathname, error?.message || error);
      if (error instanceof UpstreamError) return json({ error: error.publicMessage }, 502, env);
      return json({ error: 'Service temporarily unavailable' }, 502, env);
    }
  },
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM market_observations WHERE observed_at_ms < ?').bind(Date.now() - 90 * 86400000).run()
        .catch(error => console.error('[cintexa-cron] retention cleanup failed:', error?.message || error))
    );
  }
};
