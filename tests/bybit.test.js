import test from 'node:test';
import assert from 'node:assert/strict';
import { bybitPublicRequest, bybitPrivateRequest, getBybitInstruments, getBybitTicker, getBybitCandles, getBybitMarketContext, submitBybitLiveOrder } from '../worker/src/exchanges/bybit.js';
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
