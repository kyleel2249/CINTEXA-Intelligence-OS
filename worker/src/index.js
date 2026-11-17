import { evaluateTrade } from './core/signals.js';
import { buildTradePlan } from './core/trade-planner.js';
import { submitBitgetLiveOrder } from './exchanges/bitget.js';
import { getBitgetInstruments, getBitgetTicker, getBitgetCandles, getBitgetMarketContext, analyseOrderBook, UpstreamError } from './exchanges/bitget-market.js';
import { getBybitInstruments, getBybitInstrumentCatalog, getBybitTicker, getBybitCandles, getBybitMarketContext, getBybitWalletBalance, getBybitAccountSnapshot, getBybitSpotBorrowQuota, getBybitSpotMaxBorrowable, getBybitSpotMarginLiability, getBybitPositions, getBybitOpenOrders, getBybitOrderHistory, getBybitExecutions, submitBybitLiveOrder } from './exchanges/bybit.js';
import { persistMarketObservation, readMarketHistory, recordSignalAndOutcome, evaluatePendingOutcomes, readSignalPerformance } from './core/historical-store.js';

const PRODUCT_TYPES = new Set(['SPOT', 'MARGIN', 'USDT-FUTURES', 'USDC-FUTURES', 'COIN-FUTURES', 'LINEAR', 'INVERSE', 'OPTION', 'BYBIT-SPOT', 'BYBIT-LINEAR', 'BYBIT-INVERSE']);
const MULTI_GRANULARITIES = ['1min', '5min', '15min', '1H', '4H', '1D', '1W'];
const granularityMs = { '1min':60000,'3min':180000,'5min':300000,'15min':900000,'30min':1800000,'1H':3600000,'2H':7200000,'4H':14400000,'6H':21600000,'12H':43200000,'1D':86400000,'3D':259200000,'1W':604800000,'1M':2592000000 };
const OBSERVATION_BUCKET_MS = 60000;

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

const cors = env => ({
  'access-control-allow-origin': env.CORS_ORIGIN || 'https://cintexa.com',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-eti-ingestion-token,x-eti-exchange-token',
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
  if (!PRODUCT_TYPES.has(productType)) throw new TypeError('Unsupported exchange product type');
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

async function saveSignalMarketContext(env, { context, ticker, productType, symbol, exchange='BITGET' }) {
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

async function requireExchangeReadToken(req,env){\n  if(!env.ETI_EXCHANGE_READ_TOKEN||!(await safeEqual(req.headers.get('x-eti-exchange-token')||'',env.ETI_EXCHANGE_READ_TOKEN)))throw new HttpError(401,'Unauthorised exchange account access');\n}\n\nasync function requireIngestionToken(req, env, message) {
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
  let historicalOutcomes=[];\n  if(env.DB)try{historicalOutcomes=(await readSignalPerformance(env.DB,{symbol,productType,limit:1500})).items||[]}catch(error){console.error('[eti-calibration]',error?.message||error)}\n  const result = await evaluateTrade({ candles, timeframes, primaryTimeframe: granularity, market: { dataFresh: fresh, instrumentTradable, source: 'BITGET', context: marketContext, historicalOutcomes }, risk: { approved: false } });
  // Only persist for symbols the exchange catalogue confirms; this keeps arbitrary public requests from polluting history.
  let historyWrite = { stored: 0, errors: ['Instrument not confirmed in the Bitget catalogue; nothing persisted'] };
  let signalWrite = { persisted: false, reason: 'D1 binding unavailable or instrument unconfirmed' }, outcomeWrite = { updated: 0 };
  if (instrument) {
    historyWrite = await saveSignalMarketContext(env, { context: marketContext, ticker: tickerResult.data, productType, symbol, exchange: 'BITGET' });
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

const BYBIT_INTERVALS=[['1','1min',60000],['5','5min',300000],['15','15min',900000],['60','1H',3600000],['240','4H',14400000],['D','1D',86400000],['W','1W',604800000]];
async function handleBybitSignals(req,env){
 rateLimit(req,env,{scope:'bybit-signals'});
 const body=await readJson(req),category=String(body.category||'linear').toLowerCase(),symbol=String(body.symbol||'').toUpperCase(),interval=String(body.interval||'1');
 if(!['spot','linear','inverse'].includes(category))throw new TypeError('ETI signal analysis supports Bybit spot, linear and inverse markets; options remain market-data only');
 const primary=BYBIT_INTERVALS.find(x=>x[0]===interval);if(!primary)throw new TypeError('Unsupported Bybit signal interval');
 const other=BYBIT_INTERVALS.filter(x=>x[0]!==interval);
 const [candles,settled,instruments,contextResult]=await Promise.all([
  getBybitCandles({env,category,symbol,interval,limit:200}),
  Promise.allSettled(other.map(async x=>[x[1],await getBybitCandles({env,category,symbol,interval:x[0],limit:x[0]==='5'?400:200})])),
  getBybitInstruments({env,category,symbol,limit:1000}).catch(()=>null),
  getBybitMarketContext({env,category,symbol}).then(data=>({data})).catch(error=>({error:error.message}))
 ]);
 const timeframeRows=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
 const timeframes=Object.fromEntries([[primary[1],candles],...timeframeRows]);
 const unavailableTimeframes=other.filter(x=>!timeframeRows.some(y=>y[0]===x[1])).map(x=>x[1]);
 const instrument=instruments?.list?.find(x=>String(x.symbol).toUpperCase()===symbol);
 const fresh=Boolean(candles.at(-1)&&Date.now()-candles.at(-1).time<=2*primary[2]);
 const rawContext=contextResult.data;let marketContext=null,contextError=contextResult.error||null;
 if(rawContext?.orderBook){
  try{
   const book=analyseOrderBook(rawContext.orderBook,{lastPrice:rawContext.ticker?.last});
   const fr=rawContext.fundingHistory?.[0],oi=rawContext.openInterestHistory?.[0];
   marketContext={exchange:'BYBIT',productType:category==='spot'?'SPOT':category.toUpperCase(),orderBook:book,
    funding:fr&&Number.isFinite(fr.rate)?{rate:fr.rate,timestamp:fr.fundingRateTimestamp}:null,
    openInterest:oi&&Number.isFinite(oi.openInterest)?{size:oi.openInterest,timestamp:oi.timestamp}:null,
    optionalErrors:rawContext.errors||[],timestamp:Date.now()};
  }catch(error){contextError=error.message}
 }
 const instrumentTradable=String(instrument?.status||'').toLowerCase()==='trading';
 const outcomeProduct='BYBIT-'+category.toUpperCase();
 let historicalOutcomes=[];
 if(env.DB)try{historicalOutcomes=(await readSignalPerformance(env.DB,{symbol,productType:outcomeProduct,limit:1500})).items||[]}catch(error){console.error('[bybit-calibration]',error?.message||error)}
 const result=await evaluateTrade({candles,timeframes,primaryTimeframe:primary[1],market:{dataFresh:fresh,instrumentTradable,source:'BYBIT',context:marketContext,historicalOutcomes},risk:{approved:false}});
 let historyWrite={stored:0,errors:['Instrument not confirmed in Bybit catalogue; nothing persisted']};
 let signalWrite={persisted:false,reason:'D1 binding unavailable or instrument unconfirmed'},outcomeWrite={updated:0};
 if(instrument){
  const observationProduct=category==='spot'?'SPOT':category.toUpperCase();
  historyWrite=await saveSignalMarketContext(env,{context:marketContext,ticker:rawContext?.ticker,productType:observationProduct,symbol,exchange:'BYBIT'});
  if(env.DB)try{
   signalWrite=await recordSignalAndOutcome(env.DB,{signal:result,productType:outcomeProduct,symbol,timeframe:primary[1]});
   if(timeframes['5min'])outcomeWrite=await evaluatePendingOutcomes(env.DB,{symbol,productType:outcomeProduct,candles:timeframes['5min'],barDurationMs:300000});
  }catch(error){signalWrite={...signalWrite,reason:error.message}}
 }
 return json({...result,history:{marketObservations:historyWrite,signal:signalWrite,outcomes:outcomeWrite},
  market:{exchange:'BYBIT',category,symbol,interval,granularity:primary[1],lastCandleTime:candles.at(-1)?.time??null,dataFresh:fresh,instrumentTradable,contextAvailable:Boolean(marketContext),contextError,unavailableTimeframes},
  executionAllowed:false,executionBlock:'Bybit account and market integration is active; live order routing remains hard-disabled pending full ETI execution safety verification.'},200,env);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (u.pathname === '/api/health') return json({
        status: 'ok', service: 'CINTEXA Intelligence OS', execution: 'LIVE_ORDER_ROUTING_LOCKED', marketData: ['BITGET_PUBLIC_REST','BYBIT_V5_REST'], bybitConfigured: Boolean(env.BYBIT_API_KEY&&env.BYBIT_API_SECRET),
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
      if (u.pathname === '/api/bybit/signals' && req.method === 'POST') return await handleBybitSignals(req,env);\n      if (u.pathname === '/api/bybit/market/instruments' && req.method === 'GET') {
        const category=u.searchParams.get('category')||'linear',symbol=u.searchParams.get('symbol')||undefined,baseCoin=u.searchParams.get('baseCoin')||undefined;
        const data=u.searchParams.get('all')==='true'?await getBybitInstrumentCatalog({env,category,baseCoin,limit:u.searchParams.get('limit')||1000,maxPages:u.searchParams.get('maxPages')||10}):await getBybitInstruments({env,category,symbol,baseCoin,limit:u.searchParams.get('limit')||1000,cursor:u.searchParams.get('cursor')||undefined});\n        return json({exchange:'BYBIT',category,...data},200,env);
      }
      if (u.pathname === '/api/bybit/market/ticker' && req.method === 'GET') {
        return json(await getBybitTicker({env,category:u.searchParams.get('category')||'linear',symbol:u.searchParams.get('symbol')}),200,env);
      }
      if (u.pathname === '/api/bybit/market/candles' && req.method === 'GET') {
        const category=u.searchParams.get('category')||'linear',symbol=u.searchParams.get('symbol'),interval=u.searchParams.get('interval')||'1',limit=u.searchParams.get('limit')||200;
        return json({exchange:'BYBIT',category,symbol,interval,candles:await getBybitCandles({env,category,symbol,interval,limit})},200,env);
      }
      if (u.pathname === '/api/bybit/market/context' && req.method === 'GET') {
        return json(await getBybitMarketContext({env,category:u.searchParams.get('category')||'linear',symbol:u.searchParams.get('symbol')}),200,env);
      }
      if (u.pathname === '/api/bybit/account' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        if(!env.BYBIT_API_KEY||!env.BYBIT_API_SECRET)throw new HttpError(503,'Bybit API credentials are not configured in Worker secrets');
        return json({exchange:'BYBIT',accountType:u.searchParams.get('accountType')||'UNIFIED',data:await getBybitAccountSnapshot({env}),readOnly:true},200,env);
      }
      if (u.pathname === '/api/bybit/margin/borrow-quota' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitSpotBorrowQuota({env,symbol:u.searchParams.get('symbol'),side:u.searchParams.get('side')||'Buy'}),200,env);
      }
      if (u.pathname === '/api/bybit/margin/max-borrowable' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitSpotMaxBorrowable({env,currency:u.searchParams.get('currency')}),200,env);
      }
      if (u.pathname === '/api/bybit/margin/liability' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitSpotMarginLiability({env,currency:u.searchParams.get('currency')}),200,env);
      }
      if (u.pathname === '/api/bybit/positions' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitPositions({env,category:u.searchParams.get('category')||'linear',symbol:u.searchParams.get('symbol')||undefined,settleCoin:u.searchParams.get('settleCoin')||undefined}),200,env);
      }
      if (u.pathname === '/api/bybit/orders' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitOpenOrders({env,category:u.searchParams.get('category')||'linear',symbol:u.searchParams.get('symbol')||undefined,limit:u.searchParams.get('limit')||50}),200,env);
      }
      if (u.pathname === '/api/bybit/orders/history' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitOrderHistory({env,category:u.searchParams.get('category')||'linear',symbol:u.searchParams.get('symbol')||undefined,limit:u.searchParams.get('limit')||50}),200,env);
      }
      if (u.pathname === '/api/bybit/executions' && req.method === 'GET') {
        await requireExchangeReadToken(req,env);
        return json(await getBybitExecutions({env,category:u.searchParams.get('category')||'linear',symbol:u.searchParams.get('symbol')||undefined,limit:u.searchParams.get('limit')||50}),200,env);
      }
      if (u.pathname === '/api/bybit/orders' && req.method === 'POST') {
        if(!env.ETI_EXECUTION_TOKEN||!(await safeEqual(req.headers.get('authorization')||'',`Bearer ${env.ETI_EXECUTION_TOKEN}`)))return json({error:'Unauthorised',executionAllowed:false},401,env);
        const order=await readJson(req);
        let reason='Bybit live order routing is disabled';
        try{await submitBybitLiveOrder({env,order})}catch(error){reason=error.message}
        return json({error:reason,executionAllowed:false,submitted:false},403,env);
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
        return json(await readMarketHistory(env.DB, { exchange:u.searchParams.get('exchange')||'BITGET', symbol: u.searchParams.get('symbol'), productType: assertProductType(u.searchParams.get('productType')), hours: u.searchParams.get('hours') || 24, limit: u.searchParams.get('limit') || 1000 }), 200, env);
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
