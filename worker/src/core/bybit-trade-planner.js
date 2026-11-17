import { buildTradePlan } from './trade-planner.js';
const finite=v=>Number.isFinite(Number(v));
const positive=(v,name)=>{const n=Number(v);if(!Number.isFinite(n)||n<=0)throw new TypeError(name+' must be a positive number');return n};
export function buildBybitTradePlan({input,instrument,ticker,spotMarginState,borrowQuota}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Bybit trade-plan input is required');
 const category=String(input.category||'linear').toLowerCase();
 if(!['spot','linear'].includes(category))throw new TypeError('Bybit planning currently supports Spot and Linear contracts. Inverse and Options require dedicated contract-payoff models.');
 const symbol=String(input.symbol||instrument?.symbol||'').toUpperCase();
 if(!symbol||symbol!==String(instrument?.symbol||'').toUpperCase())throw new TypeError('A matching Bybit instrument is required');
 if(String(instrument.status||'').toLowerCase()!=='trading')throw new RangeError('Bybit instrument is not currently trading');
 const lot=instrument.lotSizeFilter||{},priceFilter=instrument.priceFilter||{},leverageFilter=instrument.leverageFilter||{};
 const quantityStep=positive(lot.qtyStep||lot.basePrecision||0,'Bybit quantity step');
 const minQuantity=Number(lot.minOrderQty||0),minNotional=Number(lot.minNotionalValue||0),priceTick=positive(priceFilter.tickSize||0,'Bybit price tick');
 const direction=String(input.direction||'').toUpperCase();
 if(!['BUY','SELL'].includes(direction))throw new TypeError('Direction must be BUY or SELL');
 const useSpotMargin=category==='spot'&&input.useSpotMargin===true;
 let leverage=1,exchangeMaxLeverage=1,marginMode='CROSS',maxNotional=Number(input.maxNotional)||Infinity;
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
