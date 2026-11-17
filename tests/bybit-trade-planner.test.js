import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBybitTradePlan } from '../worker/src/core/bybit-trade-planner.js';
const linear={symbol:'BTCUSDT',status:'Trading',lotSizeFilter:{qtyStep:'0.001',minOrderQty:'0.001',minNotionalValue:'5'},priceFilter:{tickSize:'0.1'},leverageFilter:{maxLeverage:'100'}};
const spot={symbol:'BTCUSDT',status:'Trading',marginTrading:'both',lotSizeFilter:{qtyStep:'0.00001',minOrderQty:'0.00001',minNotionalValue:'5'},priceFilter:{tickSize:'0.01'}};
const base={symbol:'BTCUSDT',direction:'BUY',entry:100,atr:2,equity:1000,availableBalance:1000,riskFraction:.01};
test('builds a Bybit Linear order preview using exchange precision and leverage limits',()=>{
 const result=buildBybitTradePlan({input:{...base,category:'linear',leverage:10,marginMode:'ISOLATED'},instrument:linear,ticker:{fundingRate:.0001}});
 assert.equal(result.exchange,'BYBIT');
 assert.equal(result.orderPreview.category,'linear');
 assert.equal(result.orderPreview.side,'Buy');
 assert.equal(result.orderPreview.reduceOnly,false);
 assert.equal(result.orderPreview.tpslMode,'Full');
 assert.equal(result.plan.exchangeConstraints.quantityStep,.001);
 assert.equal(result.executionAllowed,false);
});
test('builds a Bybit Spot cash order preview without leverage',()=>{
 const result=buildBybitTradePlan({input:{...base,category:'spot'},instrument:spot});
 assert.equal(result.orderPreview.category,'spot');
 assert.equal(result.orderPreview.isLeverage,0);
 assert.equal(result.plan.leverage,1);
});
test('builds a Bybit Spot Margin preview only when margin is enabled and fresh borrow quota exists',()=>{
 const result=buildBybitTradePlan({input:{...base,category:'spot',useSpotMargin:true,leverage:5},instrument:spot,spotMarginState:{spotMarginMode:'1',spotLeverage:'5'},borrowQuota:{maxTradeAmount:'250',maxTradeQty:'2'}});
 assert.equal(result.orderPreview.isLeverage,1);
 assert.equal(result.plan.leverage,5);
 assert.equal(result.spotMargin.borrowQuota.maxTradeAmount,'250');
});
test('blocks Spot Margin preview when account margin mode is off',()=>{
 assert.throws(()=>buildBybitTradePlan({input:{...base,category:'spot',useSpotMargin:true},instrument:spot,spotMarginState:{spotMarginMode:'0',spotLeverage:'5'},borrowQuota:{maxTradeAmount:'250',maxTradeQty:'2'}}),/not enabled/);
});
test('rejects Options trade plans until a premium-and-Greeks risk model is added',()=>{
 assert.throws(()=>buildBybitTradePlan({input:{...base,category:'option'},instrument:{...linear,symbol:'BTCUSDT'}}),/premium-and-Greeks/);
});
test('rejects leverage above Bybit instrument maximum',()=>{
 assert.throws(()=>buildBybitTradePlan({input:{...base,category:'linear',leverage:150},instrument:linear}),/outside permitted bounds|exchange maximum/);
});

test('builds inverse futures plans with explicit USD contract value and inverse payoff math',()=>{
 const inverse={symbol:'BTCUSD',status:'Trading',lotSizeFilter:{qtyStep:'1',minOrderQty:'1',minNotionalValue:'1'},priceFilter:{tickSize:'0.5'},leverageFilter:{maxLeverage:'100'}};
 const result=buildBybitTradePlan({input:{...base,symbol:'BTCUSD',category:'inverse',entry:100000,atr:1000,contractValue:1,leverage:10,marginMode:'CROSS'},instrument:inverse});
 assert.equal(result.category,'inverse');
 assert.ok(result.plan.quantity>=1);
 assert.equal(result.plan.notional,result.plan.quantity);
 assert.equal(result.plan.contractValue,1);
 assert.equal(result.orderPreview.category,'inverse');
 assert.equal(result.executionAllowed,false);
});
