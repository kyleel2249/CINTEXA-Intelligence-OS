import test from 'node:test';
import assert from 'node:assert/strict';
import { bybitPublicRequest, bybitPrivateRequest, getBybitInstruments, getBybitInstrumentCatalog, getBybitTickers, getBybitTicker, getBybitCandles, getBybitMarketContext, getBybitSpotMarginState, getBybitSpotBorrowQuota, getBybitSpotMaxBorrowable, getBybitPositions, getBybitAccountSnapshot, submitBybitLiveOrder } from '../worker/src/exchanges/bybit.js';
const response=(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
test('Bybit V5 public request sorts query parameters and selects the live base by default',async()=>{
 let called='';
 const result=await bybitPublicRequest({env:{},path:'/v5/market/tickers',params:{symbol:'BTCUSDT',category:'linear'},fetchImpl:async url=>{called=String(url);return response({retCode:0,result:{list:[]}})}});
 assert.equal(result.list.length,0);
 assert.ok(called.startsWith('https://api.bybit.com/'));
 assert.ok(called.indexOf('category=linear')<called.indexOf('symbol=BTCUSDT'));
});
test('Bybit public request uses testnet only when explicitly configured',async()=>{
 let called='';
 await bybitPublicRequest({env:{BYBIT_TESTNET:'true'},path:'/v5/market/tickers',params:{category:'spot'},fetchImpl:async url=>{called=String(url);return response({retCode:0,result:{list:[]}})}});
 assert.ok(called.startsWith('https://api-testnet.bybit.com/'));
});
test('instrument categories are validated',async()=>{
 await assert.rejects(()=>getBybitInstruments({category:'margin',fetchImpl:async()=>response({retCode:0,result:{list:[]}})}),/category must be spot, linear, inverse or option/);
});
test('ticker normalizes V5 market fields',async()=>{
 const ticker=await getBybitTicker({category:'linear',symbol:'BTCUSDT',fetchImpl:async()=>response({retCode:0,result:{ts:123,list:[{symbol:'BTCUSDT',lastPrice:'100',bid1Price:'99',ask1Price:'101',fundingRate:'0.0001',openInterest:'500'}]}})});
 assert.equal(ticker.last,100);assert.equal(ticker.fundingRate,.0001);assert.equal(ticker.openInterest,500);
});
test('kline response is normalized and sorted oldest first',async()=>{
 const rows=[['120000','102','103','101','102','5','510'],['60000','101','102','100','101','4','404']];
 const candles=await getBybitCandles({category:'spot',symbol:'BTCUSDT',interval:'1',fetchImpl:async()=>response({retCode:0,result:{list:rows}})});
 assert.equal(candles[0].time,60000);assert.equal(candles[1].close,102);
});
test('authenticated requests sign and transmit Bybit V5 headers',async()=>{
 let options;
 await bybitPrivateRequest({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'},path:'/v5/account/wallet-balance',params:{accountType:'UNIFIED'},fetchImpl:async(_url,opts)=>{options=opts;return response({retCode:0,result:{list:[]}})}});
 assert.equal(options.headers['X-BAPI-API-KEY'],'key');
 assert.equal(options.headers['X-BAPI-SIGN-TYPE'],'2');
 assert.match(options.headers['X-BAPI-SIGN'],/^[a-f0-9]{64}$/);
});
test('Bybit V5 non-zero return codes fail closed',async()=>{
 await assert.rejects(()=>bybitPublicRequest({path:'/v5/market/tickers',params:{category:'spot'},fetchImpl:async()=>response({retCode:10001,retMsg:'bad request'})}),/10001/);
});
test('Bybit order routing remains hard-disabled',async()=>{
 await assert.rejects(()=>submitBybitLiveOrder({env:{BYBIT_LIVE_ENABLED:'true'},order:{}}),/hard-disabled/);
});

test('Bybit Spot Margin state uses the documented read-only endpoint',async()=>{
 let called='';
 const result=await getBybitSpotMarginState({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'},fetchImpl:async url=>{called=String(url);return response({retCode:0,result:{spotMarginMode:'1',spotLeverage:'5',effectiveLeverage:'1.2'}})}});
 assert.ok(called.endsWith('/v5/spot-margin-trade/state'));
 assert.equal(result.spotMarginMode,'1');
 assert.equal(result.spotLeverage,'5');
});
test('Bybit Spot borrow quota validates Buy and Sell sides',async()=>{
 let called='';
 const result=await getBybitSpotBorrowQuota({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'},symbol:'BTCUSDT',side:'Buy',fetchImpl:async url=>{called=String(url);return response({retCode:0,result:{maxTradeQty:'1'}})}});
 assert.ok(called.includes('/v5/order/spot-borrow-check?'));
 assert.ok(called.includes('side=Buy'));
 assert.equal(result.maxTradeQty,'1');
 await assert.rejects(()=>getBybitSpotBorrowQuota({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'},symbol:'BTCUSDT',side:'Hold',fetchImpl:async()=>response({retCode:0,result:{}})}),/Buy or Sell/);
});
test('Bybit Spot maximum borrowable endpoint requires a currency',async()=>{
 await assert.rejects(()=>getBybitSpotMaxBorrowable({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'}}),/currency is required/);
});
test('Bybit positions allow options but reject spot positions',async()=>{
 let called='';
 await getBybitPositions({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'},category:'option',baseCoin:'BTC',fetchImpl:async url=>{called=String(url);return response({retCode:0,result:{list:[]}})}});
 assert.ok(called.includes('category=option'));
 await assert.rejects(()=>getBybitPositions({env:{BYBIT_API_KEY:'key',BYBIT_API_SECRET:'secret'},category:'spot'}),/Spot balances/);
});
test('Bybit account snapshot includes spot margin and option position reads without failing partial account permissions',async()=>{
 const result=await getBybitAccountSnapshot({env:{}});
 assert.equal(result.readOnly,true);
 assert.ok(Array.isArray(result.errors));
 assert.ok(Array.isArray(result.optionPositions));
});

test('Bybit market context collects book, ticker, funding and open-interest history',async()=>{
 const fetchImpl=async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/orderbook'))return response({retCode:0,result:{ts:123,b:[['99','2']],a:[['101','3']]}});
  if(u.pathname.endsWith('/tickers'))return response({retCode:0,result:{ts:123,list:[{symbol:'BTCUSDT',lastPrice:'100',bid1Price:'99',ask1Price:'101'}]}});
  if(u.pathname.endsWith('/funding/history'))return response({retCode:0,result:{list:[{fundingRate:'0.0002',fundingRateTimestamp:'123'}]}});
  if(u.pathname.endsWith('/open-interest'))return response({retCode:0,result:{list:[{openInterest:'500',timestamp:'123'}]}});
  return response({retCode:0,result:{}});
 };
 const result=await getBybitMarketContext({category:'linear',symbol:'BTCUSDT',fetchImpl});
 assert.equal(result.orderBook.bids[0][0],99);
 assert.equal(result.ticker.last,100);
 assert.equal(result.fundingHistory[0].rate,.0002);
 assert.equal(result.openInterestHistory[0].openInterest,500);
});
test('Bybit options do not request unsupported standard kline data',async()=>{
 await assert.rejects(()=>getBybitCandles({category:'option',symbol:'BTC-30DEC26-100000-C-USDT',interval:'1',fetchImpl:async()=>response({retCode:0,result:{list:[]}})}),/does not provide standard kline candles/);
});

test('Bybit instrument catalogue follows pagination cursors and returns the complete list',async()=>{
 let page=0;
 const result=await getBybitInstrumentCatalog({category:'linear',limit:1000,fetchImpl:async url=>{
  page++;
  const cursor=new URL(url).searchParams.get('cursor');
  return response({retCode:0,result:{list:[{symbol:page===1?'BTCUSDT':'ETHUSDT'}],nextPageCursor:page===1?'next-page':''}});
 }});
 assert.equal(page,2);
 assert.deepEqual(result.list.map(x=>x.symbol),['BTCUSDT','ETHUSDT']);
 assert.equal(result.complete,true);
});

test('Bybit category ticker endpoint returns all available symbols in one snapshot',async()=>{
 let called='';
 const rows=[{symbol:'BTCUSDT',lastPrice:'100',turnover24h:'1000'},{symbol:'ETHUSDT',lastPrice:'50',turnover24h:'500'}];
 const result=await getBybitTickers({category:'linear',fetchImpl:async url=>{called=String(url);return response({retCode:0,result:{ts:100,list:rows}})}});
 assert.ok(called.includes('category=linear'));
 assert.equal(result.length,2);
 assert.equal(result[0].symbol,'BTCUSDT');
 assert.equal(result[1].last,50);
});
