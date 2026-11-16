import test from'node:test';import assert from'node:assert/strict';import{analyseMarketMicrostructure}from'../worker/src/core/market-intelligence.js';
const context={orderBook:{valid:true,timestamp:100000,spreadBps:2,notionalImbalance:.3},funding:{rate:.0007},openInterest:{size:100},timestamp:100000};
test('supports fresh bid-dominant liquidity confirmation',()=>{const r=analyseMarketMicrostructure(context,{direction:'BUY',now:101000});assert.equal(r.approved,true);assert.equal(r.direction,'BUY');assert.ok(r.score>50)});
test('rejects stale order book snapshots',()=>{const r=analyseMarketMicrostructure(context,{direction:'BUY',now:200000});assert.equal(r.approved,false);assert.ok(r.reasons.some(x=>x.includes('stale')))});
test('rejects spreads above liquidity threshold',()=>{const r=analyseMarketMicrostructure({...context,orderBook:{...context.orderBook,spreadBps:20}},{direction:'BUY',now:101000});assert.equal(r.approved,false)});
test('flags crowded long carry without inventing open-interest direction',()=>{const r=analyseMarketMicrostructure(context,{direction:'BUY',now:101000});assert.ok(r.reasons.some(x=>x.includes('Positive funding')));assert.equal(r.openInterest.size,100)});
test('fails closed when order-book evidence is missing',()=>{const r=analyseMarketMicrostructure(null,{direction:'BUY'});assert.equal(r.approved,false)});
