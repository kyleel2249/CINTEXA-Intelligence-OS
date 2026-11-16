import test from'node:test';
import assert from'node:assert/strict';
import{getBitgetCandles,getBitgetTicker,getBitgetInstruments}from'../worker/src/exchanges/bitget-market.js';import{submitBitgetLiveOrder}from'../worker/src/exchanges/bitget.js';
const response=data=>({ok:true,json:async()=>({code:'00000',data})});
test('normalises Bitget candle rows and sorts oldest first',async()=>{const rows=[['2000','2','3','1','2.5','10','20'],['1000','1','2','0.5','1.5','5','7']];const out=await getBitgetCandles({symbol:'BTCUSDT',productType:'USDT-FUTURES',fetchImpl:async url=>{assert.match(String(url),/granularity=1m/);return response(rows)}});assert.deepEqual(out.map(x=>x.time),[1000,2000]);assert.equal(out[0].close,1.5)});
test('rejects invalid symbols before making a request',async()=>{await assert.rejects(()=>getBitgetTicker({symbol:'BTC/USDT',fetchImpl:async()=>{throw Error('must not call')}}),/valid Bitget symbol/)});
test('rejects unsupported product types',async()=>{await assert.rejects(()=>getBitgetInstruments({productType:'TESTNET'}),/Unsupported Bitget product type/)});
test('returns a normalized ticker record',async()=>{const out=await getBitgetTicker({symbol:'BTCUSDT',productType:'SPOT',fetchImpl:async url=>{assert.match(String(url),/spot\/market\/tickers/);return response([{lastPr:'65000',bidPr:'64999',askPr:'65001',high24h:'66000',low24h:'64000'}])}});assert.equal(out.last,65000);assert.equal(out.exchange,'BITGET')});

test('margin market data uses the public spot symbol catalogue',async()=>{await getBitgetInstruments({productType:'MARGIN',fetchImpl:async url=>{assert.match(String(url),/spot\/public\/symbols/);return response([{symbol:'BTCUSDT'}])}})});
test('live order routing remains hard-disabled regardless of environment flags',async()=>{await assert.rejects(()=>submitBitgetLiveOrder({env:{ETI_LIVE_ENABLED:'true',ETI_RISK_SERVICE_READY:'true',ETI_PROTECTIVE_ORDER_SERVICE_READY:'true'}}),/hard-disabled/)});
