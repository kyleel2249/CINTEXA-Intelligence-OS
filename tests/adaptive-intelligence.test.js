import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketRegime, calibrateHistoricalSignals, analyseAdaptiveSignal } from '../worker/src/core/adaptive-intelligence.js';
const candles=(count=80,step=.8)=>Array.from({length:count},(_,i)=>{const close=100+i*step;return{time:i*60000,open:close-step*.2,high:close+step*.3,low:close-step*.3,close,baseVolume:100+i}});
test('classifies a directional market and reports its measurements',()=>{
 const result=classifyMarketRegime(candles(),{adx:32,atr:1.2});
 assert.equal(result.regime,'TRENDING');
 assert.ok(result.confidence>=55);
});
test('classifies a wide spread as low liquidity',()=>{
 const result=classifyMarketRegime(candles(),{adx:30},{spreadBps:30});
 assert.equal(result.regime,'LOW_LIQUIDITY');
});
test('does not apply historical calibration below minimum sample size',()=>{
 const result=calibrateHistoricalSignals([{decision:'TRADE',status:'COMPLETE',signal_score:80,horizonResults:{'4h':{directionalReturnPct:1}}}]);
 assert.equal(result.available,false);
 assert.equal(result.reliability,'INSUFFICIENT_SAMPLE');
});
test('calibrates only completed TRADE outcomes at or above minimum sample',()=>{
 const rows=Array.from({length:40},(_,i)=>({decision:'TRADE',status:'COMPLETE',signal_score:70,horizonResults:{'4h':{directionalReturnPct:i<28?1:-1}}}));
 const result=calibrateHistoricalSignals(rows);
 assert.equal(result.available,true);
 assert.equal(result.sampleSize,40);
 assert.ok(result.conservativeWinRate<result.winRate);
});
test('adaptive signal raises the threshold in high-volatility conditions and keeps calibration inactive for small samples',()=>{
 const bars=Array.from({length:80},(_,i)=>{const close=100+i*.05;return{time:i*60000,open:close-1,high:close+2,low:close-2,close,baseVolume:100}});
 const result=analyseAdaptiveSignal({candles:bars,indicators:{adx:12,atr:3},baseScore:78,direction:'BUY',multiTimeframe:{available:true,confirmed:true,opposing:[]},microstructure:{available:true,approved:true,spreadBps:2,totalDepthNotional:100000},historicalOutcomes:[]});
 assert.equal(result.regime.regime,'HIGH_VOLATILITY');
 assert.ok(result.minimumScore>68);
 assert.equal(result.calibration.available,false);
});
