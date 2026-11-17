import { buildTradePlan } from './trade-planner.js';
const finite=v=>Number.isFinite(Number(v));
const directionSide=direction=>direction==='BUY'?'Buy':'Sell';
const positive=(v,name)=>{const n=Number(v);if(!Number.isFinite(n)||n<=0)throw new TypeError(name+' must be a positive number');return n};
function buildInversePlan({input,instrument,ticker}){
 const lot=instrument.lotSizeFilter||{},priceFilter=instrument.priceFilter||{},leverageFilter=instrument.leverageFilter||{};
 const entry=positive(input.entry||ticker?.last,'entry'),atr=positive(input.atr,'atr'),equity=positive(input.equity,'equity'),available=positive(input.availableBalance,'availableBalance');
 const direction=String(input.direction||'').toUpperCase();if(!['BUY','SELL'].includes(direction))throw new TypeError('Direction must be BUY or SELL');
 const contractValue=positive(input.contractValue,'inverse contract value');
 const step=positive(lot.qtyStep,'Bybit inverse quantity step'),minQty=Number(lot.minOrderQty||0),tick=positive(priceFilter.tickSize,'Bybit price tick'),minNotional=Number(lot.minNotionalValue||0);
 const maxLev=positive(leverageFilter.maxLeverage,'Bybit maximum leverage'),leverage=positive(input.leverage||1,'leverage');
 if(leverage>Math.min(150,maxLev))throw new RangeError('Requested leverage exceeds the Bybit inverse instrument maximum');
 const marginMode=String(input.marginMode||'ISOLATED').toUpperCase();if(!['CROSS','ISOLATED'].includes(marginMode))throw new TypeError('Linear margin mode must be CROSS or ISOLATED');
 const recent=Array.isArray(input.candles)?input.candles.slice(-20).filter(x=>finite(x.high)&&finite(x.low)):[],swingLow=recent.length?Math.min(...recent.map(x=>Number(x.low))):null,swingHigh=recent.length?Math.max(...recent.map(x=>Number(x.high))):null;
 let stop=direction==='BUY'?entry-atr*1.5:entry+atr*1.5;
 if(direction==='BUY'&&swingLow!==null&&swingLow<entry)stop=Math.min(stop,swingLow-atr*.1);
 if(direction==='SELL'&&swingHigh!==null&&swingHigh>entry)stop=Math.max(stop,swingHigh+atr*.1);
 stop=Math.round(stop/tick)*tick;if(stop<=0||stop===entry)throw new RangeError('Inverse stop price is invalid');
 const riskFraction=positive(input.riskFraction??.005,'riskFraction');if(riskFraction>.05)throw new RangeError('Risk fraction cannot exceed 5%');
 const fee=Number(input.feeRate??.0006),slippage=Number(input.slippageRate??.0005),funding=Number(input.fundingRate??ticker?.fundingRate??0),fundingIntervals=Number(input.fundingIntervals||0);
 if(![fee,slippage,funding,fundingIntervals].every(Number.isFinite)||fee<0||slippage<0||fundingIntervals<0)throw new RangeError('Inverse cost assumptions are invalid');
 const riskBudget=equity*riskFraction,unitPriceRisk=contractValue*Math.abs(1/entry-1/stop)*entry,unitCosts=contractValue*(fee*2+slippage*2),unitRisk=unitPriceRisk+unitCosts;
 const maxNotional=input.maxNotional===undefined?Infinity:positive(input.maxNotional,'maxNotional');
 const cap=Math.min(maxNotional,available*leverage),raw=Math.min(riskBudget/unitRisk,cap/contractValue),quantity=Math.floor((raw+Number.EPSILON)/step)*step,notional=quantity*contractValue;
 if(quantity<minQty||quantity<=0)throw new RangeError('Inverse contract quantity is below the exchange minimum');
 if(notional<minNotional)throw new RangeError('Inverse order notional is below the exchange minimum');
 const margin=notional/leverage,entryFee=notional*fee,exitFee=notional*fee,slippageCost=notional*slippage*2,stopPnl=quantity*contractValue*Math.abs(1/entry-1/stop)*entry,estimatedLoss=stopPnl+entryFee+exitFee+slippageCost;
 const targets=(input.targets||[1.5,2,3]).map(Number);if(!targets.length||targets.some(x=>!Number.isFinite(x)||x<1))throw new RangeError('Targets must be reward-to-risk multiples of at least 1');
 const targetRows=targets.map((rr,index)=>{const price=Math.round((direction==='BUY'?entry+Math.abs(entry-stop)*rr:entry-Math.abs(entry-stop)*rr)/tick)*tick;const grossPnl=quantity*contractValue*Math.abs(1/entry-1/price)*entry;const fees=entryFee+exitFee,slip=notional*slippage*2,fundingCost=notional*funding*fundingIntervals*(direction==='BUY'?1:-1);return{index:index+1,rewardRisk:rr,price,grossPnl,estimatedFees:fees,estimatedSlippage:slip,estimatedFundingCost:fundingCost,estimatedNetPnl:grossPnl-fees-slip-fundingCost}});
 return{algorithm:'ETIAlgo V3.1 Adaptive',direction,entry,stopLoss:stop,stopDistance:Math.abs(entry-stop),targets:targetRows,quantity,baseQuantity:quantity,contractValue,notional,leverage,marginMode,estimatedInitialMargin:margin,riskBudget,estimatedLoss,estimatedEntryFee:entryFee,estimatedExitFee:exitFee,estimatedFees:entryFee+exitFee,estimatedSlippage:slippageCost,estimatedFundingCostAtStop:notional*funding*fundingIntervals*(direction==='BUY'?1:-1),availableBalanceRequired:margin,capApplied:raw<riskBudget/unitRisk,exchangeConstraints:{quantityStep:step,minQuantity:minQty,minNotional,priceTick:tick,exchangeMaxLeverage:maxLev},assumptions:{contractValue,unit:'USD inverse contract',stopMethod:'1.5x ATR with recent swing protection',riskFraction,feeRate:fee,slippageRate:slippage,fundingRate:funding,fundingIntervals},executionReady:false,warning:'Inverse P&L and margin are estimates using the supplied USD contract value. Confirm contract value, settlement coin, fee currency and risk tiers from the live instrument/account before any order.'};
}
export function buildBybitTradePlan({input,instrument,ticker,spotMarginState,borrowQuota}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Bybit trade-plan input is required');
 const category=String(input.category||'linear').toLowerCase();
 if(!['spot','linear'].includes(category))throw new TypeError('Bybit planning currently supports Spot and Linear contracts. Inverse and Options require dedicated contract-payoff models.');
 const symbol=String(input.symbol||instrument?.symbol||'').toUpperCase();
 if(!symbol||symbol!==String(instrument?.symbol||'').toUpperCase())throw new TypeError('A matching Bybit instrument is required');
 if(String(instrument.status||'').toLowerCase()!=='trading')throw new RangeError('Bybit instrument is not currently trading');
 if(category==='inverse'){const plan=buildInversePlan({input,instrument,ticker});const orderType=String(input.orderType||'Limit').toLowerCase();if(!['limit','market'].includes(orderType))throw new TypeError('Order type must be Limit or Market');const timeInForce=String(input.timeInForce||'GTC');if(!['GTC','IOC','FOK','PostOnly'].includes(timeInForce))throw new TypeError('Unsupported Bybit time-in-force');const positionIdx=Number(input.positionIdx??0);if(![0,1,2].includes(positionIdx))throw new TypeError('positionIdx must be 0, 1 or 2');return{exchange:'BYBIT',category,symbol,plan,orderPreview:{category,symbol,side:directionSide(plan.direction),orderType:orderType==='market'?'Market':'Limit',qty:String(plan.quantity),...(orderType==='limit'?{price:String(plan.entry),timeInForce}:{}),positionIdx,reduceOnly:false,takeProfit:String(plan.targets[0].price),stopLoss:String(plan.stopLoss),tpslMode:'Full'},executionAllowed:false,executionReady:false,notice:'Inverse contract preview only. Contract value must be supplied and confirmed against Bybit instrument specifications.'};}
 const lot=instrument.lotSizeFilter||{},priceFilter=instrument.priceFilter||{},leverageFilter=instrument.leverageFilter||{};
 const quantityStep=positive(lot.qtyStep||lot.basePrecision||0,'Bybit quantity step');
 const minQuantity=Number(lot.minOrderQty||0),minNotional=Number(lot.minNotionalValue||0),priceTick=positive(priceFilter.tickSize||0,'Bybit price tick');
 const direction=String(input.direction||'').toUpperCase();
 if(!['BUY','SELL'].includes(direction))throw new TypeError('Direction must be BUY or SELL');
 const useSpotMargin=category==='spot'&&input.useSpotMargin===true;
 let leverage=1,exchangeMaxLeverage=1,marginMode='CROSS',maxNotional=input.maxNotional===undefined?Infinity:positive(input.maxNotional,'maxNotional');
 if(category==='linear'){
  leverage=positive(input.leverage||1,'leverage');
  exchangeMaxLeverage=positive(leverageFilter.maxLeverage||0,'Bybit maximum leverage');
  marginMode=String(input.marginMode||'ISOLATED').toUpperCase();
  if(!['CROSS','ISOLATED'].includes(marginMode))throw new TypeError('Linear margin mode must be CROSS or ISOLATED');
 }else if(useSpotMargin){
  if(String(spotMarginState?.spotMarginMode)!=='1')throw new RangeError('Bybit Spot Margin is not enabled on this account');
  exchangeMaxLeverage=positive(spotMarginState.spotLeverage,'Bybit Spot Margin leverage');
  leverage=positive(input.leverage||exchangeMaxLeverage,'leverage');
  if(leverage>exchangeMaxLeverage)throw new RangeError('Requested leverage exceeds the account Spot Margin leverage');
  if(String(instrument.marginTrading||'none').toLowerCase()==='none')throw new RangeError('This Bybit spot symbol does not support margin trading');
  if(!borrowQuota)throw new RangeError('Fresh Bybit Spot Margin borrow quota is required');
  const quotaCap=direction==='BUY'?Number(borrowQuota.maxTradeAmount):Number(borrowQuota.maxTradeQty)*positive(input.entry||ticker?.last,'entry');
  if(!Number.isFinite(quotaCap)||quotaCap<=0)throw new RangeError('Bybit Spot Margin borrow quota is unavailable for this side');
  maxNotional=Math.min(maxNotional,quotaCap);
 }
 const entry=positive(input.entry||ticker?.last,'entry');
 const plan=buildTradePlan({
  direction,entry,atr:input.atr,candles:Array.isArray(input.candles)?input.candles:[],
  equity:input.equity,availableBalance:positive(input.availableBalance,'availableBalance'),
  riskFraction:input.riskFraction??.005,leverage,marginMode,
  maxNotional,feeRate:input.feeRate??.001,slippageRate:input.slippageRate??.0005,
  targets:input.targets||[1.5,2,3],quantityStep,minQuantity,minNotional,priceTick,
  exchangeMaxLeverage,contractMultiplier:1,
  fundingRate:Number(input.fundingRate??ticker?.fundingRate??0),
  fundingIntervals:Number(input.fundingIntervals||0)
 });
 const orderType=String(input.orderType||'Limit').toLowerCase();
 if(!['limit','market'].includes(orderType))throw new TypeError('Order type must be Limit or Market');
 const timeInForce=String(input.timeInForce||'GTC');
 if(!['GTC','IOC','FOK','PostOnly'].includes(timeInForce))throw new TypeError('Unsupported Bybit time-in-force');
 const positionIdx=Number(input.positionIdx??0);
 if(![0,1,2].includes(positionIdx))throw new TypeError('positionIdx must be 0, 1 or 2');
 const orderPreview={category,symbol,side:direction==='BUY'?'Buy':'Sell',orderType:orderType==='market'?'Market':'Limit',qty:String(plan.quantity),...(orderType==='limit'?{price:String(plan.entry),timeInForce}:{}),...(category==='spot'?{isLeverage:useSpotMargin?1:0,marketUnit:'baseCoin'}:{positionIdx,reduceOnly:false,takeProfit:String(plan.targets[0].price),stopLoss:String(plan.stopLoss),tpslMode:'Full'})};
 return{exchange:'BYBIT',category,symbol,plan,orderPreview,spotMargin:{requested:useSpotMargin,enabled:String(spotMarginState?.spotMarginMode)==='1',leverage:useSpotMargin?leverage:1,borrowQuota:useSpotMargin?borrowQuota:null},executionAllowed:false,executionReady:false,notice:'This is a precision-aware order preview only. It does not change leverage or margin mode and cannot submit an order.'};
}
