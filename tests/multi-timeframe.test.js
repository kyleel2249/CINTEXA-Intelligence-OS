import test from'node:test';import assert from'node:assert/strict';import{analyseMultiTimeframe}from'../worker/src/core/multi-timeframe.js';
const rising=Array.from({length:80},(_,i)=>({open:100+i,high:102+i,low:99+i,close:101+i,baseVolume:100+i}));
const falling=Array.from({length:80},(_,i)=>({open:200-i,high:202-i,low:199-i,close:201-i,baseVolume:100+i}));
test('confirms direction when higher timeframes align',()=>{const r=analyseMultiTimeframe({'5min':rising,'15min':rising,'1H':rising,'4H':rising},'BUY');assert.equal(r.confirmed,true);assert.equal(r.aligned.length,4);assert.equal(r.alignmentScore,100)});
test('rejects conflicting higher timeframe direction',()=>{const r=analyseMultiTimeframe({'5min':rising,'15min':falling,'1H':rising},'BUY');assert.equal(r.confirmed,false);assert.ok(r.opposing.includes('15min'))});
test('does not confirm when higher timeframe evidence is absent',()=>{const r=analyseMultiTimeframe({'1min':rising},'BUY');assert.equal(r.available,false);assert.equal(r.confirmed,false)});
