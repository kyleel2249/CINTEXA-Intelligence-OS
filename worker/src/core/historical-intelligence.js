const finite = value => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function validateMarketObservation(input = {}) {
  const types = new Set(['ORDER_BOOK','FUNDING','OPEN_INTEREST','TICKER']);
  const observationType = String(input.observationType || '').toUpperCase();
  const symbol = String(input.symbol || '').toUpperCase();
  const productType = String(input.productType || 'USDT-FUTURES').toUpperCase();
  const observedAt = Number(input.observedAt);
  if (!types.has(observationType)) throw new TypeError('Unsupported observation type');
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) throw new TypeError('Invalid market symbol');
  if (!['SPOT','MARGIN','USDT-FUTURES','USDC-FUTURES','COIN-FUTURES','LINEAR','INVERSE','OPTION'].includes(productType)) throw new TypeError('Unsupported product type');
  if (!finite(observedAt) || observedAt <= 0 || observedAt > Date.now() + 60000) throw new TypeError('Observation timestamp is invalid or in the future');
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new TypeError('Observation data must be an object');
  const d = input.data;
  if (observationType === 'ORDER_BOOK') {
    if (![d.mid,d.spreadBps,d.bidNotional,d.askNotional,d.notionalImbalance].every(finite) || Number(d.mid) <= 0 || Number(d.spreadBps) < 0) throw new TypeError('Order-book observation is missing valid normalized metrics');
    if (Math.abs(Number(d.notionalImbalance)) > 1.000001) throw new TypeError('Order-book imbalance must be between -1 and 1');
  }
  if (observationType === 'FUNDING' && !finite(d.rate)) throw new TypeError('Funding observation requires a finite rate');
  if (observationType === 'OPEN_INTEREST' && (!finite(d.size) || Number(d.size) < 0)) throw new TypeError('Open-interest observation requires a non-negative size');
  if (observationType === 'TICKER' && (!finite(d.last) || Number(d.last) <= 0)) throw new TypeError('Ticker observation requires a positive last price');
  const exchange=String(input.exchange||'BITGET').toUpperCase();
  if(!['BITGET','BYBIT'].includes(exchange)) throw new TypeError('Unsupported exchange provenance');
  return { exchange, observationType, symbol, productType, observedAt: Math.floor(observedAt), data: d, source: String(input.source || 'BITGET').slice(0,40) };
}

export function analyseDerivativesHistory(observations = []) {
  const rows = observations.filter(x => x && x.data).slice().sort((a,b) => Number(a.observedAt)-Number(b.observedAt));
  const oi = rows.filter(x => x.observationType === 'OPEN_INTEREST' && finite(x.data.size));
  const funding = rows.filter(x => x.observationType === 'FUNDING' && finite(x.data.rate));
  const change = (list, key) => {
    if (list.length < 2) return { available:false, observations:list.length, change:null, changePercent:null };
    const first=Number(list[0].data[key]), last=Number(list.at(-1).data[key]);
    return { available:true, observations:list.length, first, last, change:last-first, changePercent:first===0?null:(last-first)/Math.abs(first)*100, from:list[0].observedAt, to:list.at(-1).observedAt };
  };
  const oiChange=change(oi,'size'), fundingChange=change(funding,'rate');
  return { openInterest:oiChange, funding:{...fundingChange, current:funding.length?Number(funding.at(-1).data.rate):null, mean:funding.length?funding.reduce((s,x)=>s+Number(x.data.rate),0)/funding.length:null}, sampleCount:rows.length };
}

export function detectLiquidityEvents(observations = [], { depthDropThreshold=.6, priceMoveThreshold=.0015, imbalanceThreshold=.35 } = {}) {
  const rows=observations.filter(x=>x&&x.data).slice().sort((a,b)=>Number(a.observedAt)-Number(b.observedAt));
  const books=rows.filter(x=>x.observationType==='ORDER_BOOK'), tickers=rows.filter(x=>x.observationType==='TICKER');
  const events=[];
  for(let i=1;i<books.length;i++){
    const prev=books[i-1],cur=books[i],p=prev.data,c=cur.data;
    const oldDepth=Number(p.bidNotional)+Number(p.askNotional),newDepth=Number(c.bidNotional)+Number(c.askNotional);
    if(!(oldDepth>0&&newDepth>=0)) continue;
    const depthDrop=(oldDepth-newDepth)/oldDepth;
    const nearest=tickers.reduce((best,t)=>Math.abs(t.observedAt-cur.observedAt)<Math.abs((best?.observedAt??Infinity)-cur.observedAt)?t:best,null);
    const priorTicker=nearest?tickers.filter(t=>t.observedAt<nearest.observedAt).at(-1):null;
    const priceMove=nearest&&priorTicker?(Number(nearest.data.last)-Number(priorTicker.data.last))/Number(priorTicker.data.last):null;
    if(depthDrop>=depthDropThreshold&&priceMove!==null&&Math.abs(priceMove)>=priceMoveThreshold){
      events.push({type:'LIQUIDITY_WITHDRAWAL_WITH_PRICE_DISLOCATION',observedAt:cur.observedAt,depthDropPercent:depthDrop*100,priceMovePercent:priceMove*100,confidence:'OBSERVATIONAL',note:'Rapid depth reduction coincided with price displacement; this is not proof of spoofing or intent.'});
    }
    if(i>=2){
      const a=books[i-2].data,b=books[i-1].data,nowBook=books[i].data;
      const ia=Number(a.notionalImbalance),ib=Number(b.notionalImbalance),ic=Number(nowBook.notionalImbalance);
      const midA=Number(a.mid),midC=Number(nowBook.mid);
      const stableMid=finite(midA)&&midA>0&&finite(midC)&&Math.abs((midC-midA)/midA)<.0005;
      const persistentSide=(ia>=imbalanceThreshold&&ib>=imbalanceThreshold&&ic>=imbalanceThreshold)||(ia<=-imbalanceThreshold&&ib<=-imbalanceThreshold&&ic<=-imbalanceThreshold);
      const depthA=Number(a.bidNotional)+Number(a.askNotional),depthC=Number(nowBook.bidNotional)+Number(nowBook.askNotional);
      if(persistentSide&&stableMid&&depthA>0&&depthC>=depthA*.8){
        events.push({type:'POSSIBLE_LIQUIDITY_ABSORPTION',observedAt:books[i].observedAt,side:ic>0?'BID':'ASK',persistentImbalance:ic,confidence:'LOW',note:'Persistent one-sided book imbalance with limited mid-price displacement. Order-book snapshots alone cannot confirm executed aggressor flow or prove absorption.'});
      }
    }
    const imbalance=Number(c.notionalImbalance);
    if(Math.abs(imbalance)>=imbalanceThreshold){
      events.push({type:'ORDER_BOOK_IMBALANCE',observedAt:cur.observedAt,direction:imbalance>0?'BID':'ASK',imbalance,confidence:'OBSERVATIONAL'});
    }
  }
  return events;
}

export function summarizeSignalPerformance(rows = []) {
  const valid=rows.filter(x=>x&&x.status==='COMPLETE');
  const tradeRows=valid.filter(x=>x.decision==='TRADE');
  const returns=tradeRows.map(x=>Number(x.horizonResults?.['4h']?.directionalReturnPct)).filter(Number.isFinite);
  const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0);
  const grossWin=wins.reduce((s,x)=>s+x,0),grossLoss=Math.abs(losses.reduce((s,x)=>s+x,0));
  const mean=arr=>arr.length?arr.reduce((s,x)=>s+x,0)/arr.length:null;
  const avg=mean(returns);
  return {
    totalSignals:rows.length, completedSignals:valid.length, pendingSignals:rows.filter(x=>x.status==='PENDING'||x.status==='PARTIAL').length,
    tradeSignals:tradeRows.length, noTradeSignals:valid.filter(x=>x.decision==='NO TRADE').length,
    winRate:returns.length?wins.length/returns.length*100:null, averageDirectionalReturnPct:avg,
    expectancyPct:avg, profitFactor:grossLoss===0?(grossWin>0?null:0):grossWin/grossLoss,
    averageWinPct:mean(wins),averageLossPct:mean(losses),sampleSize:returns.length,
    reliability:returns.length<30?'INSUFFICIENT_SAMPLE':'OBSERVED_SAMPLE'
  };
}

export function evaluateOutcomeHorizons(signal, candles, horizonsMs=[3600000,14400000,86400000], {barDurationMs=0}={}) {
  if(!signal||!Array.isArray(candles)) throw new TypeError('Signal and candle history are required');
  const entry=Number(signal.entry_price),start=Number(signal.entry_time_ms);
  if(!finite(entry)||entry<=0||!finite(start)||!['BUY','SELL'].includes(signal.direction)) return {status:'INVALID',results:{}};
  const ordered=candles.filter(c=>finite(c.time)&&finite(c.high)&&finite(c.low)&&finite(c.close)&&Number(c.time)>=start).slice().sort((a,b)=>a.time-b.time);
  const results={};
  for(const horizon of horizonsMs){
    const end=start+horizon, window=ordered.filter(c=>barDurationMs>0?Number(c.time)+barDurationMs<=end:Number(c.time)<=end);
    if(!window.length) continue;
    const lastBarClose=Number(window.at(-1).time)+(barDurationMs||0);
    if(barDurationMs>0&&lastBarClose<end-barDurationMs) continue;
    if(barDurationMs===0&&Number(window.at(-1).time)<end) continue;
    const close=Number(window.at(-1).close),raw=(close-entry)/entry*100,dir=signal.direction==='BUY'?1:-1;
    const highs=window.map(c=>(Number(c.high)-entry)/entry*100*dir),lows=window.map(c=>(Number(c.low)-entry)/entry*100*dir);
    results[horizon===3600000?'1h':horizon===14400000?'4h':horizon===86400000?'24h':String(horizon)]={
      directionalReturnPct:raw*dir,marketReturnPct:raw,maximumFavourableExcursionPct:Math.max(0,...highs),maximumAdverseExcursionPct:Math.min(0,...lows),closePrice:close,closedAt:Number(window.at(-1).time)
    };
  }
  return {status:Object.keys(results).length===horizonsMs.length?'COMPLETE':Object.keys(results).length?'PARTIAL':'PENDING',results};
}
