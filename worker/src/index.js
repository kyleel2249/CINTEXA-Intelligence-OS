import { evaluateTrade } from './core/signals.js';
import { buildTradePlan } from './core/trade-planner.js';
import { submitBitgetLiveOrder } from './exchanges/bitget.js';
import { getBitgetInstruments, getBitgetTicker, getBitgetCandles, getBitgetMarketContext } from './exchanges/bitget-market.js';
import { persistMarketObservation, readMarketHistory, recordSignalAndOutcome, evaluatePendingOutcomes, readSignalPerformance } from './core/historical-store.js';

const cors = env => ({
  'access-control-allow-origin': env.CORS_ORIGIN || 'https://cintexa.com',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-eti-ingestion-token',
  vary: 'Origin'
});
const json = (data, status = 200, env = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(env) }
});
const granularityMs = { '1min':60000,'3min':180000,'5min':300000,'15min':900000,'30min':1800000,'1H':3600000,'2H':7200000,'4H':14400000,'6H':21600000,'12H':43200000,'1D':86400000,'3D':259200000,'1W':604800000,'1M':2592000000 };
const saveObservation = async (env, observation) => {
  if (!env.DB) return { persisted:false, reason:'D1 binding unavailable' };
  try { return await persistMarketObservation(env.DB, observation); }
  catch (error) { return { persisted:false, reason:error.message }; }
};
async function saveSignalMarketContext(env, { context, ticker, productType, symbol }) {
  if (!env.DB || !context) return { stored:0, errors:['D1 or market context unavailable'] };
  const rows=[], now=Date.now();
  if (context.orderBook?.valid) rows.push({ observationType:'ORDER_BOOK', observedAt:context.orderBook.timestamp || now, data:{ mid:context.orderBook.mid, spreadBps:context.orderBook.spreadBps, bidNotional:context.orderBook.bidNotional, askNotional:context.orderBook.askNotional, notionalImbalance:context.orderBook.notionalImbalance, microPrice:context.orderBook.microPrice } });
  if (context.funding && Number.isFinite(Number(context.funding.rate))) rows.push({ observationType:'FUNDING', observedAt:context.funding.timestamp || context.timestamp || now, data:{ rate:Number(context.funding.rate) } });
  if (context.openInterest && Number.isFinite(Number(context.openInterest.size))) rows.push({ observationType:'OPEN_INTEREST', observedAt:context.openInterest.timestamp || context.timestamp || now, data:{ size:Number(context.openInterest.size) } });
  if (ticker && Number.isFinite(Number(ticker.last))) rows.push({ observationType:'TICKER', observedAt:ticker.timestamp || now, data:{ last:Number(ticker.last) } });
  const results=await Promise.all(rows.map(row=>saveObservation(env,{...row,productType,symbol,source:'BITGET'})));
  return { stored:results.filter(x=>x.stored).length, duplicates:results.filter(x=>x.duplicate).length, errors:results.filter(x=>!x.stored&&!x.duplicate).map(x=>x.reason) };
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status:204, headers:cors(env) });
    try {
      if (u.pathname === '/api/health') return json({
        status:'ok', service:'CINTEXA Intelligence OS', execution:'BITGET_LIVE_ONLY', marketData:'BITGET_PUBLIC_REST',
        historicalIntelligence:Boolean(env.DB), liveEnabled:false,
        liveBlock:'Live order routing remains hard-disabled until verified server-side risk, protective orders, idempotency and reconciliation are implemented.'
      },200,env);
      if (u.pathname === '/api/departments') return json({ departments:['ETI','AIM','RDM','OPS','COMMS','WEB','MKT','BIZ','FIN','CRE','SUP','RDI'].map(id=>({id,mode:id==='ETI'?'live_bitget_only':'department'})) },200,env);

      if (u.pathname === '/api/market/instruments' && req.method === 'GET') {
        const productType=u.searchParams.get('productType')||'USDT-FUTURES';
        return json({exchange:'BITGET',productType,data:await getBitgetInstruments({productType})},200,env);
      }
      if (u.pathname === '/api/market/ticker' && req.method === 'GET') {
        const productType=u.searchParams.get('productType')||'USDT-FUTURES',symbol=u.searchParams.get('symbol');
        return json(await getBitgetTicker({productType,symbol}),200,env);
      }
      if (u.pathname === '/api/market/context' && req.method === 'GET') {
        const productType=u.searchParams.get('productType')||'USDT-FUTURES',symbol=u.searchParams.get('symbol');
        return json(await getBitgetMarketContext({productType,symbol}),200,env);
      }
      if (u.pathname === '/api/market/candles' && req.method === 'GET') {
        const productType=u.searchParams.get('productType')||'USDT-FUTURES',symbol=u.searchParams.get('symbol'),granularity=u.searchParams.get('granularity')||'1min',limit=u.searchParams.get('limit')||200;
        const candles=await getBitgetCandles({productType,symbol,granularity,limit});
        return json({exchange:'BITGET',productType,symbol,granularity,candles},200,env);
      }
      if (u.pathname === '/api/eti/trade-plan' && req.method === 'POST') {
        const body=await req.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error:'A trade-plan input object is required',executionAllowed:false},400,env);
        const allowed=['direction','entry','atr','candles','equity','riskFraction','leverage','availableBalance','maxNotional','feeRate','makerFeeRate','takerFeeRate','slippageRate','targets','marginMode','contractMultiplier','quantityStep','minQuantity','minNotional','priceTick','fundingRate','fundingIntervals','exchangeMaxLeverage'];
        const input=Object.fromEntries(allowed.filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
        const plan=buildTradePlan(input);
        return json({plan,executionAllowed:false,executionReady:false,notice:'Calculator output only. This endpoint cannot submit, authorize or queue an exchange order.'},200,env);
      }
      if (u.pathname === '/api/eti/signals' && req.method === 'POST') {
        const body=await req.json(),productType=body.productType||'USDT-FUTURES',symbol=body.symbol,granularity=body.granularity||'1min';
        const multiGranularities=['1min','5min','15min','1H','4H','1D','1W'];
        const [candles,timeframeRows,instruments,contextResult,tickerResult]=await Promise.all([
          getBitgetCandles({productType,symbol,granularity,limit:200}),
          Promise.all(multiGranularities.filter(g=>g!==granularity).map(async g=>[g,await getBitgetCandles({productType,symbol,granularity:g,limit:200})])),
          getBitgetInstruments({productType}),
          getBitgetMarketContext({productType,symbol}).then(data=>({data})).catch(error=>({error:error.message})),
          getBitgetTicker({productType,symbol}).then(data=>({data})).catch(error=>({error:error.message}))
        ]);
        const timeframes=Object.fromEntries([[granularity,candles],...timeframeRows]),marketContext=contextResult.data||null;
        const instrument=Array.isArray(instruments)?instruments.find(x=>String(x.symbol).toUpperCase()===String(symbol).toUpperCase()):null;
        const latest=candles.at(-1),fresh=Boolean(latest&&Date.now()-latest.time<=2*(granularityMs[granularity]||60000));
        const instrumentTradable=Boolean(instrument&&['normal','online','listed'].includes(String(instrument.symbolStatus||instrument.status||'').toLowerCase()));
        const result=await evaluateTrade({candles,timeframes,primaryTimeframe:granularity,market:{dataFresh:fresh,instrumentTradable,source:'BITGET',context:marketContext},risk:{approved:false}});
        const historyWrite=await saveSignalMarketContext(env,{context:marketContext,ticker:tickerResult.data,productType,symbol});
        let signalWrite={persisted:false,reason:'D1 binding unavailable'};
        if(env.DB)try{signalWrite=await recordSignalAndOutcome(env.DB,{signal:result,productType,symbol,timeframe:granularity});}catch(error){signalWrite={persisted:false,reason:error.message};}
        return json({...result,history:{marketObservations:historyWrite,signal:signalWrite},market:{exchange:'BITGET',productType,symbol,granularity,lastCandleTime:latest?.time??null,dataFresh:fresh,instrumentTradable,contextAvailable:Boolean(marketContext),contextError:contextResult.error||null},executionAllowed:false,executionBlock:'ETIAlgo V3 Alpha is active; live execution remains blocked pending verified account risk, protective orders, idempotency and reconciliation.'},200,env);
      }
      if (u.pathname === '/api/eti/observations' && req.method === 'POST') {
        if (!env.ETI_INGESTION_TOKEN || req.headers.get('x-eti-ingestion-token') !== env.ETI_INGESTION_TOKEN) return json({error:'Unauthorised observation ingestion'},401,env);
        if (!env.DB) return json({error:'D1 database binding is unavailable'},503,env);
        const result=await persistMarketObservation(env.DB,await req.json());
        return json(result,200,env);
      }
      if (u.pathname === '/api/eti/history' && req.method === 'GET') {
        if (!env.DB) return json({error:'D1 database binding is unavailable'},503,env);
        return json(await readMarketHistory(env.DB,{symbol:u.searchParams.get('symbol'),productType:u.searchParams.get('productType')||'USDT-FUTURES',hours:u.searchParams.get('hours')||24,limit:u.searchParams.get('limit')||1000}),200,env);
      }
      if (u.pathname === '/api/eti/outcomes/evaluate' && req.method === 'POST') {
        if (!env.ETI_INGESTION_TOKEN || req.headers.get('x-eti-ingestion-token') !== env.ETI_INGESTION_TOKEN) return json({error:'Unauthorised outcome evaluation'},401,env);
        if (!env.DB) return json({error:'D1 database binding is unavailable'},503,env);
        const body=await req.json();
        return json(await evaluatePendingOutcomes(env.DB,body),200,env);
      }
      if (u.pathname === '/api/eti/performance' && req.method === 'GET') {
        if (!env.DB) return json({error:'D1 database binding is unavailable'},503,env);
        return json(await readSignalPerformance(env.DB,{symbol:u.searchParams.get('symbol'),productType:u.searchParams.get('productType')||'USDT-FUTURES',limit:u.searchParams.get('limit')||1000}),200,env);
      }
      if (u.pathname === '/api/eti/orders' && req.method === 'POST') {
        if (!env.ETI_EXECUTION_TOKEN || req.headers.get('authorization') !== `Bearer ${env.ETI_EXECUTION_TOKEN}`) return json({error:'Unauthorised'},401,env);
        const result=await submitBitgetLiveOrder({env,order:await req.json()});
        return json({error:'Live order routing is disabled',result},403,env);
      }
      return json({error:'Not found'},404,env);
    } catch (error) {
      const status=error instanceof TypeError||error instanceof RangeError?400:502;
      return json({error:error.message||'Internal error'},status,env);
    }
  },
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(env.DB.prepare("DELETE FROM market_observations WHERE observed_at_ms < ?").bind(Date.now()-90*86400000).run());
  }
};
