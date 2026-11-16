import test from'node:test';import assert from'node:assert/strict';import{assessRisk}from'../worker/src/core/risk.js';
const base={equity:10000,availableBalance:5000,entry:100,stop:99,quantity:10,leverage:2,maxLeverage:5,maxRiskFraction:.01,maxNotional:2000,rewardRisk:2,dataFresh:true,instrumentTradable:true,protectionReady:true,direction:'BUY'};
test('approves within configured limits',()=>assert.equal(assessRisk(base).approved,true));
test('rejects leverage above exchange limit',()=>assert.equal(assessRisk({...base,leverage:10}).approved,false));
test('fails closed without protective orders',()=>assert.equal(assessRisk({...base,protectionReady:false}).approved,false));
test('fails closed on stale market data',()=>assert.equal(assessRisk({...base,dataFresh:false}).approved,false));
test('rejects negative fees that could understate risk',()=>assert.equal(assessRisk({...base,fees:-2}).approved,false));
test('rejects a stop on the wrong side of a long entry',()=>assert.equal(assessRisk({...base,stop:101}).approved,false));
test('rejects risk limits outside the permitted range',()=>assert.equal(assessRisk({...base,maxRiskFraction:.2}).approved,false));
