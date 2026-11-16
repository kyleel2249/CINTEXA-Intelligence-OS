import test from'node:test';import assert from'node:assert/strict';import{ema,rsi,atr,analyseIndicators,evaluateETIAlgoV3}from'../worker/src/core/eti-algo.js';
const rising=Array.from({length:100},(_,i)=>({time:i,open:100+i,high:102+i,low:99+i,close:101+i,baseVolume:100+i}));
test('EMA returns null until enough samples exist',()=>{assert.equal(ema([1,2],3),null);assert.equal(ema([1,2,3],3),2)});
test('RSI identifies uninterrupted gains',()=>assert.equal(rsi(Array.from({length:20},(_,i)=>i+1)),100));
test('ATR returns a positive range estimate',()=>assert.ok(atr(rising)>0));
test('indicator analysis returns trend, momentum, volatility and volume context',()=>{const a=analyseIndicators(rising);assert.equal(a.direction,'BUY');assert.ok(a.ema.fast>a.ema.slow);assert.ok(a.atr>0);assert.equal(a.regime,'trending')});
test('native ETIAlgo output identifies itself and returns bounded score',()=>{const a=evaluateETIAlgoV3(rising,{market:{dataFresh:true}});assert.equal(a.algorithm,'ETIAlgo V3 Alpha');assert.equal(a.valid,true);assert.ok(a.score>=0&&a.score<=100);assert.ok(a.engines.v3&&a.engines.alpha)});
test('insufficient data cannot produce a valid signal',()=>{const a=evaluateETIAlgoV3(rising.slice(0,20));assert.equal(a.valid,false);assert.equal(a.direction,'NEUTRAL')});
