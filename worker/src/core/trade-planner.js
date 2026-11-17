const finite=(v,name)=>{const n=Number(v);if(!Number.isFinite(n))throw new TypeError(name+' must be finite');return n};
const positive=(v,name)=>{const n=finite(v,name);if(n<=0)throw new RangeError(name+' must be greater than zero');return n};
const roundDown=(value,step)=>step>0?Math.floor((value+Number.EPSILON)/step)*step:value;
const roundToTick=(value,tick)=>tick>0?Math.round(value/tick)*tick:value;
export function buildTradePlan({direction,entry,atr,candles=[],equity,riskFraction=.005,leverage=1,availableBalance=Infinity,maxNotional=Infinity,feeRate=.0006,makerFeeRate, takerFeeRate,slippageRate=.0005,targets=[1.5,2,3],marginMode='ISOLATED',contractMultiplier=1,quantityStep=0,minQuantity=0,minNotional=0,priceTick=0,fundingRate=0,fundingIntervals=0,exchangeMaxLeverage=150}={}){
 const side=String(direction||'').toUpperCase(),price=positive(entry,'entry'),volatility=positive(atr,'atr'),capital=positive(equity,'equity'),risk=positive(riskFraction,'riskFraction'),lev=positive(leverage,'leverage');
 const mode=String(marginMode||'ISOLATED').toUpperCase();if(!['CROSS','ISOLATED'].includes(mode))throw new TypeError('marginMode must be CROSS or ISOLATED');
 const multiplier=positive(contractMultiplier,'contractMultiplier'),step=finite(quantityStep,'quantityStep'),minQty=finite(minQuantity,'minQuantity'),minValue=finite(minNotional,'minNotional'),tick=finite(priceTick,'priceTick'),funding=finite(fundingRate,'fundingRate'),intervals=finite(fundingIntervals,'fundingIntervals'),maxLev=positive(exchangeMaxLeverage,'exchangeMaxLeverage');
 const taker=finite(takerFeeRate??feeRate,'takerFeeRate'),maker=finite(makerFeeRate??taker,'makerFeeRate'),slippage=positive(slippageRate+1,'slippageRate+1')-1;
 if(!['BUY','SELL'].includes(side)||risk>.05||lev>Math.min(150,maxLev)||step<0||minQty<0||minValue<0||tick<0||taker<0||maker<0||slippage<0||intervals<0)throw new RangeError('Trade plan inputs are outside permitted bounds');
 const recent=Array.isArray(candles)?candles.slice(-20):[],valid=recent.filter(c=>[c.high,c.low,c.close].every(v=>Number.isFinite(Number(v))));
 const swingLow=valid.length?Math.min(...valid.map(c=>Number(c.low))):null,swingHigh=valid.length?Math.max(...valid.map(c=>Number(c.high))):null;
 let stop=side==='BUY'?price-volatility*1.5:price+volatility*1.5;
 if(side==='BUY'&&swingLow!==null&&swingLow<price)stop=Math.min(stop,swingLow-volatility*.1);
 if(side==='SELL'&&swingHigh!==null&&swingHigh>price)stop=Math.max(stop,swingHigh+volatility*.1);
 stop=roundToTick(stop,tick);const stopDistance=Math.abs(price-stop);
 if(!Number.isFinite(stopDistance)||stopDistance<=0||stopDistance>=price)throw new RangeError('Calculated stop distance is invalid');
 const riskBudget=capital*risk,unitPriceRisk=stopDistance*multiplier,unitCostRisk=price*multiplier*(taker*2+slippage*2),unitRisk=unitPriceRisk+unitCostRisk;
 let contracts=riskBudget/unitRisk;const balance=Number(availableBalance),notionalLimit=Number(maxNotional);
 const marginCap=Number.isFinite(balance)&&balance>=0?balance*lev:Infinity,cap=Math.min(Number.isFinite(notionalLimit)&&notionalLimit>0?notionalLimit:Infinity,marginCap);
 if(Number.isFinite(cap))contracts=Math.min(contracts,cap/(price*multiplier));
 contracts=roundDown(contracts,step);
 if(contracts<minQty||contracts<=0)throw new RangeError('Calculated position is below the exchange minimum quantity');
 const quantity=contracts*multiplier,notional=quantity*price,marginRequired=notional/lev;
 if(notional<minValue)throw new RangeError('Calculated position is below the exchange minimum notional');
 const estimatedEntryFee=notional*taker,estimatedExitFee=notional*taker,estimatedSlippage=notional*slippage*2;
 const estimatedLoss=quantity*stopDistance+estimatedEntryFee+estimatedExitFee+estimatedSlippage;
 const rrs=targets.map(Number);if(!rrs.length||rrs.some(x=>!Number.isFinite(x)||x<1))throw new RangeError('Targets must be reward-to-risk multiples of at least 1');
 const takeProfits=rrs.map((rr,i)=>{const target=roundToTick(side==='BUY'?price+stopDistance*rr:price-stopDistance*rr,tick),grossPnl=quantity*Math.abs(target-price),exitFee=grossPnl/Math.max(Math.abs(target-price),Number.EPSILON)*target*taker,fees=estimatedEntryFee+exitFee,slippageCost=slippage*(notional+quantity*target),fundingCost=notional*funding*intervals*(side==='BUY'?1:-1);return{index:i+1,rewardRisk:rr,price:target,grossPnl,estimatedFees:fees,estimatedSlippage:slippageCost,estimatedFundingCost:fundingCost,estimatedNetPnl:grossPnl-fees-slippageCost-fundingCost}});
 return{algorithm:'ETIAlgo V3 Alpha',direction:side,entry:price,stopLoss:stop,stopDistance,targets:takeProfits,quantity:contracts,baseQuantity:quantity,contractMultiplier:multiplier,notional,leverage:lev,marginMode:mode,estimatedInitialMargin:marginRequired,riskBudget,estimatedLoss,estimatedEntryFee,estimatedExitFee,estimatedFees:estimatedEntryFee+estimatedExitFee,estimatedSlippage,estimatedFundingCostAtStop:notional*funding*intervals*(side==='BUY'?1:-1),availableBalanceRequired:marginRequired,capApplied:contracts<riskBudget/unitRisk,exchangeConstraints:{quantityStep:step,minQuantity:minQty,minNotional:minValue,priceTick:tick,exchangeMaxLeverage:maxLev},assumptions:{stopMethod:'1.5x ATR with recent swing protection',feeRate:taker,makerFeeRate:maker,slippageRate:slippage,riskFraction:risk,fundingRate:funding,fundingIntervals:intervals,targets:'Estimated price targets; funding is a scenario estimate, not a prediction',marginMode:mode},executionReady:false,warning:'Planning only. Validate live instrument precision, contract multiplier, fee tier, mark price, funding schedule, margin mode and account risk before any order.'}
}
