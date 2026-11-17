import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMarketObservation, analyseDerivativesHistory, detectLiquidityEvents, summarizeSignalPerformance, evaluateOutcomeHorizons } from '../worker/src/core/historical-intelligence.js';

test('validates normalized order-book observations and rejects invalid imbalance',()=>{
  const row=validateMarketObservation({observationType:'ORDER_BOOK',symbol:'BTCUSDT',observedAt:Date.now(),data:{mid:100,spreadBps:2,bidNotional:1000,askNotional:800,notionalImbalance:.111}});
  assert.equal(row.symbol,'BTCUSDT');
  assert.throws(()=>validateMarketObservation({observationType:'ORDER_BOOK',symbol:'BTCUSDT',observedAt:Date.now(),data:{mid:100,spreadBps:2,bidNotional:1000,askNotional:800,notionalImbalance:2}}),/between -1 and 1/);
});

test('calculates open-interest and funding changes only with multiple observations',()=>{
  const rows=[
    {observationType:'OPEN_INTEREST',observedAt:1,data:{size:100}},
    {observationType:'OPEN_INTEREST',observedAt:2,data:{size:125}},
    {observationType:'FUNDING',observedAt:1,data:{rate:.0001}},
    {observationType:'FUNDING',observedAt:2,data:{rate:.0003}}
  ];
  const result=analyseDerivativesHistory(rows);
  assert.equal(result.openInterest.changePercent,25);
  assert.equal(result.funding.change,.0002);
  assert.equal(analyseDerivativesHistory(rows.slice(0,1)).openInterest.available,false);
});

test('flags depth withdrawal with simultaneous price displacement as observational only',()=>{
  const rows=[
    {observationType:'ORDER_BOOK',observedAt:1000,data:{bidNotional:1000,askNotional:1000,notionalImbalance:0}},
    {observationType:'TICKER',observedAt:1000,data:{last:100}},
    {observationType:'ORDER_BOOK',observedAt:2000,data:{bidNotional:100,askNotional:200,notionalImbalance:-.333}},
    {observationType:'TICKER',observedAt:2000,data:{last:101}}
  ];
  const events=detectLiquidityEvents(rows);
  assert.ok(events.some(x=>x.type==='LIQUIDITY_WITHDRAWAL_WITH_PRICE_DISLOCATION'));
  assert.equal(events.find(x=>x.type==='LIQUIDITY_WITHDRAWAL_WITH_PRICE_DISLOCATION').confidence,'OBSERVATIONAL');
});

test('performance summary keeps small samples explicitly unvalidated',()=>{
  const rows=Array.from({length:4},(_,i)=>({status:'COMPLETE',decision:'TRADE',horizonResults:{'4h':{directionalReturnPct:i%2?-.5:1}}}));
  const summary=summarizeSignalPerformance(rows);
  assert.equal(summary.sampleSize,4);
  assert.equal(summary.reliability,'INSUFFICIENT_SAMPLE');
  assert.equal(summary.winRate,50);
});

test('evaluates directional forward return and favourable/adverse excursion without lookahead',()=>{
  const signal={entry_price:100,entry_time_ms:0,direction:'BUY'};
  const candles=[
    {time:0,high:101,low:99,close:100},
    {time:3600000,high:104,low:98,close:103},
    {time:14400000,high:106,low:97,close:105},
    {time:86400000,high:108,low:96,close:107}
  ];
  const result=evaluateOutcomeHorizons(signal,candles);
  assert.equal(result.status,'COMPLETE');
  assert.equal(result.results['4h'].directionalReturnPct,5);
  assert.equal(result.results['4h'].maximumFavourableExcursionPct,6);
  assert.equal(result.results['4h'].maximumAdverseExcursionPct,-3);
});

test('does not create a completed outcome when the requested forward horizon is not present',()=>{
  const result=evaluateOutcomeHorizons({entry_price:100,entry_time_ms:0,direction:'SELL'},[{time:0,high:101,low:99,close:100}]);
  assert.equal(result.status,'PENDING');
});

test('flags persistent book pressure with stable mid-price as a low-confidence absorption candidate',()=>{
  const rows=[0,1,2].map((n)=>({observationType:'ORDER_BOOK',observedAt:1000+n*1000,data:{mid:100+n*.01,bidNotional:1200,askNotional:300,notionalImbalance:.6}}));
  const events=detectLiquidityEvents(rows);
  const absorption=events.find(x=>x.type==='POSSIBLE_LIQUIDITY_ABSORPTION');
  assert.ok(absorption);
  assert.equal(absorption.confidence,'LOW');
});
test('uses only fully closed five-minute bars for forward outcome windows',()=>{
  const candles=Array.from({length:13},(_,i)=>({time:i*300000,high:101+i,low:99,close:100+i}));
  const result=evaluateOutcomeHorizons({entry_price:100,entry_time_ms:0,direction:'BUY'},candles,[3600000],{barDurationMs:300000});
  assert.equal(result.status,'COMPLETE');
  assert.equal(result.results['1h'].closePrice,111);
});
