const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const finite=n=>Number.isFinite(Number(n));
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{const m=avg(a);return Math.sqrt(avg(a.map(x=>(x-m)**2)))};
export function classifyMarketRegime(candles,indicators={},microstructure={}){
 if(!Array.isArray(candles)||candles.length<35)return{regime:'INSUFFICIENT_DATA',confidence:0,reasons:['At least 35 candles are required for regime classification']};
 const recent=candles.slice(-30),ranges=recent.map(c=>(Number(c.high)-Number(c.low))/Math.max(Number(c.close),Number.EPSILON)*100).filter(finite);
 const atrPct=finite(indicators.atr)&&finite(candles.at(-1)?.close)?Number(indicators.atr)/Number(candles.at(-1).close)*100:avg(ranges);
 const adx=Number(indicators.adx),volume=recent.map(c=>Number(c.quoteVolume??c.baseVolume??c.volume??0)).filter(finite);
 const volumeRatio=volume.length>5&&avg(volume.slice(0,-1))>0?volume.at(-1)/avg(volume.slice(0,-1)):1;
 const closes=recent.map(c=>Number(c.close)),mean=avg(closes),dispersion=mean?stdev(closes)/mean*100:0;
 const spread=Number(microstructure.spreadBps),depth=Number(microstructure.totalDepthNotional);
 const reasons=[];
 if(finite(spread)&&spread>12){reasons.push('Spread exceeds the normal liquidity threshold');return{regime:'LOW_LIQUIDITY',confidence:90,atrPct,adx:finite(adx)?adx:null,volumeRatio,reasons}}
 let regime='TRANSITIONAL',confidence=45;
 if(atrPct>=2.5){regime='HIGH_VOLATILITY';confidence=clamp(55+atrPct*8,55,95);reasons.push('Recent true-range volatility is elevated')}
 else if(finite(adx)&&adx>=25&&dispersion>=.15){regime='TRENDING';confidence=clamp(55+(adx-25)*1.4,55,92);reasons.push('Directional trend strength is elevated')}
 else if((!finite(adx)||adx<20)&&dispersion<1.2){regime='RANGING';confidence=70;reasons.push('Directional strength and recent price dispersion are compressed')}
 else if(atrPct<.25){regime='LOW_VOLATILITY';confidence=75;reasons.push('Recent true-range volatility is compressed')}
 else reasons.push('Market conditions do not meet a stronger regime definition');
 if(volumeRatio<.5)reasons.push('Latest volume is below half of its recent baseline');
 if(finite(depth)&&depth<=0)reasons.push('Order-book depth is unavailable');
 return{regime,confidence,atrPct,adx:finite(adx)?adx:null,dispersionPct:dispersion,volumeRatio,spreadBps:finite(spread)?spread:null,reasons};
}
function wilsonLower(wins,total,z=1.96){if(!total)return 0;const p=wins/total,z2=z*z;return (p+z2/(2*total)-z*Math.sqrt((p*(1-p)+z2/(4*total))/total))/(1+z2/total)}
export function calibrateHistoricalSignals(rows=[],{minimumSample=30,horizon='4h'}={}){
 const eligible=(Array.isArray(rows)?rows:[]).filter(r=>r.decision==='TRADE'&&r.status==='COMPLETE'&&finite(r.signal_score)&&finite(r.horizonResults?.[horizon]?.directionalReturnPct));
 const wins=eligible.filter(r=>Number(r.horizonResults[horizon].directionalReturnPct)>0).length,total=eligible.length;
 if(total<minimumSample)return{available:false,reliability:'INSUFFICIENT_SAMPLE',sampleSize:total,winRate:total?wins/total*100:null,conservativeWinRate:null,minimumSample};
 return{available:true,reliability:'CALIBRATED_DESCRIPTIVE',sampleSize:total,winRate:wins/total*100,conservativeWinRate:wilsonLower(wins,total)*100,minimumSample,horizon};
}
export function analyseAdaptiveSignal({candles,indicators={},baseScore=0,direction='NEUTRAL',multiTimeframe={},microstructure={},historicalOutcomes=[],minimumScore=68}={}){
 const regime=classifyMarketRegime(candles,indicators,microstructure),calibration=calibrateHistoricalSignals(historicalOutcomes);
 let adjustment=0,threshold=clamp(Number(minimumScore)||68,65,90),reasons=[...regime.reasons];
 if(regime.regime==='HIGH_VOLATILITY'){adjustment-=5;threshold+=5;reasons.push('High volatility reduces score and raises the trade threshold')}
 if(regime.regime==='RANGING'){adjustment-=3;threshold+=4;reasons.push('Range-bound conditions require stronger confirmation')}
 if(regime.regime==='LOW_VOLATILITY'){threshold+=2;reasons.push('Compressed volatility requires a confirmed expansion trigger')}
 if(regime.regime==='LOW_LIQUIDITY'){adjustment-=15;threshold=100;reasons.push('Low-liquidity regime blocks directional approval')}
 if(multiTimeframe.available&&multiTimeframe.opposing?.length){adjustment-=Math.min(10,multiTimeframe.opposing.length*4);threshold+=Math.min(10,multiTimeframe.opposing.length*3);reasons.push('Conflicting higher-timeframe signals raise the required score')}
 else if(multiTimeframe.confirmed){adjustment+=2;reasons.push('Higher-timeframe alignment adds a small confluence adjustment')}
 if(microstructure.available&&microstructure.approved===false){adjustment-=10;threshold=100;reasons.push('Unapproved microstructure blocks directional approval')}
 if(microstructure.funding&&finite(microstructure.funding.rate)){
  const funding=Number(microstructure.funding.rate);
  if((direction==='BUY'&&funding>.0008)||(direction==='SELL'&&funding<-.0008)){adjustment-=3;threshold+=2;reasons.push('Elevated funding against the planned side reduces signal quality')}
 }
 let calibrationAdjustment=0;
 if(calibration.available){
  calibrationAdjustment=clamp((calibration.conservativeWinRate-50)/10,-3,3);
  adjustment+=calibrationAdjustment;
  if(calibration.conservativeWinRate<45){threshold+=4;reasons.push('Historical conservative win-rate estimate is weak; threshold raised')}
  if(calibration.conservativeWinRate>58){threshold=Math.max(65,threshold-1);reasons.push('Historical conservative win-rate estimate supports a marginally lower threshold')}
 }else reasons.push('Historical calibration is not applied until at least 30 completed TRADE outcomes exist');
 const adjustedScore=clamp(Math.round(Number(baseScore||0)+adjustment),0,100);
 return{regime,calibration,baseScore:Number(baseScore||0),adjustment:Number(adjustment.toFixed(2)),calibrationAdjustment:Number(calibrationAdjustment.toFixed(2)),adjustedScore,minimumScore:clamp(threshold,65,100),approved:regime.regime!=='LOW_LIQUIDITY'&&microstructure.available!==false&&microstructure.approved!==false,reasons};
}
