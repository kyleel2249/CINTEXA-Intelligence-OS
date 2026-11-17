import{analyseSMC}from'./smc.js';
import{evaluateETIAlgoV3}from'./eti-algo.js';
import{analyseMultiTimeframe}from'./multi-timeframe.js';
import{analyseMarketMicrostructure}from'./market-intelligence.js';
import{buildTradePlan}from'./trade-planner.js';
const age=(e,last)=>e?last-(e.confirmedAt??e.index):Infinity;
export async function evaluateTrade({candles,timeframes={},primaryTimeframe='1min',market={},risk={},now=Date.now(),maxEvidenceAgeBars=20,minimumScore=68}={}){
 if(!Array.isArray(candles)||candles.length<60)return{algorithm:'ETIAlgo V3 Alpha',decision:'NO TRADE',direction:'NEUTRAL',score:0,reasons:['At least 60 validated candles are required'],executable:false};
 let smc,algo;
 try{smc=analyseSMC(candles);algo=evaluateETIAlgoV3(candles,{market})}catch(e){return{algorithm:'ETIAlgo V3 Alpha',decision:'NO TRADE',direction:'NEUTRAL',score:0,reasons:[e.message],executable:false}}
 const multiTimeframe=analyseMultiTimeframe(timeframes,algo.direction,primaryTimeframe);
 const microstructure=analyseMarketMicrostructure(market.context,{direction:algo.direction,now});
 const last=candles.length-1;
 const fresh=e=>Boolean(e&&age(e,last)>=0&&age(e,last)<=maxEvidenceAgeBars);
 const evidence=[smc.latest.bos,smc.latest.choch,smc.latest.sweep,smc.latest.fvg,smc.latest.ifvg,smc.latest.orderBlock,smc.latest.inducement].filter(fresh);
 const aligned=evidence.filter(e=>(e.direction==='bullish'&&algo.direction==='BUY')||(e.direction==='bearish'&&algo.direction==='SELL'));
 const opposing=evidence.filter(e=>(e.direction==='bullish'&&algo.direction==='SELL')||(e.direction==='bearish'&&algo.direction==='BUY'));
 const direction=algo.direction;
 const structureScore=evidence.length?Math.round(aligned.length/evidence.length*100):0;
 const score=Math.min(100,Math.round(algo.score*.55+structureScore*.15+(multiTimeframe.available?multiTimeframe.alignmentScore*.15:0)+microstructure.score*.15));
 const candidate=direction!=='NEUTRAL'&&score>=minimumScore&&evidence.length>0&&aligned.length>0&&opposing.length===0&&multiTimeframe.confirmed&&microstructure.approved&&market.dataFresh===true&&market.instrumentTradable===true;
 const reasons=[...algo.reasons];
 if(direction==='NEUTRAL')reasons.push('ETIAlgo engines have no qualified directional consensus');
 if(!evidence.length)reasons.push('No recent Smart Money Concepts confirmation');
 if(!multiTimeframe.available)reasons.push('Higher-timeframe market context is unavailable');else if(!multiTimeframe.confirmed)reasons.push('Higher-timeframe direction is conflicting or unconfirmed');
 if(opposing.length)reasons.push('Opposing market-structure evidence detected');
 if(!microstructure.approved)reasons.push(...microstructure.reasons);
 if(score<minimumScore)reasons.push('Signal quality is below the configured threshold');
 if(market.dataFresh!==true)reasons.push('Market data is stale or unverified');
 if(market.instrumentTradable!==true)reasons.push('Instrument trading status is unverified');
 if(risk.approved!==true)reasons.push('Independent server-side risk assessment has not approved');
 if(candidate&&!(Number.isFinite(Number(market.accountEquity))&&Number(market.accountEquity)>0))reasons.push('Verified account equity is unavailable; position sizing is withheld');
 const executable=candidate&&risk.approved===true&&Number(risk.rewardRisk)>=1.5;
 const decision=executable?'TRADE':'NO TRADE';
 if(candidate&&!executable)reasons.push('A directional setup exists, but execution approval is unavailable');
 const tradePlan=candidate&&Number.isFinite(Number(market.accountEquity))&&Number(market.accountEquity)>0?buildTradePlan({direction,entry:algo.entryContext.lastPrice,atr:algo.entryContext.atr,candles,equity:market.accountEquity,riskFraction:market.riskFraction??.005,leverage:market.planningLeverage??1,availableBalance:market.availableBalance??market.accountEquity,maxNotional:market.planningMaxNotional??Infinity,marginMode:market.marginMode??'ISOLATED',contractMultiplier:market.contractMultiplier??1,feeRate:market.takerFeeRate??.0006,slippageRate:market.planningSlippageRate??.0005,fundingRate:market.context?.funding?.rate??0,fundingIntervals:market.planningFundingIntervals??0}):null;
 return{algorithm:'ETIAlgo V3 Alpha',version:'3.0.0-alpha',decision,direction:candidate?direction:'NEUTRAL',candidateDirection:candidate?direction:'NEUTRAL',rawDirection:direction,score,confidenceLabel:score>=80?'HIGH':score>=minimumScore?'MODERATE':'LOW',smc,analysis:algo,multiTimeframe,microstructure,evidence,tradePlan,confluence:{structureScore,aligned:aligned.length,opposing:opposing.length,total:evidence.length},risk:{approved:risk.approved===true,rewardRisk:Number(risk.rewardRisk)||null},reasons:[...new Set(reasons)],executable,expiresAt:now+60000}
}
