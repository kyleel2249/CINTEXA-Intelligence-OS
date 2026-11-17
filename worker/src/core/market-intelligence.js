export function analyseMarketMicrostructure(context,{direction='NEUTRAL',maxSpreadBps=12,now=Date.now(),maxAgeMs=15000,minTopDepthNotional=0}={}){
 const reasons=[],book=context?.orderBook;if(!book?.valid)return{available:false,approved:false,score:0,direction:'NEUTRAL',reasons:['Valid order-book data is unavailable']};
 const age=now-Number(book.timestamp||context.timestamp||0),fresh=age>=0&&age<=maxAgeMs,spread=Number(book.spreadBps),depth=Number(book.totalDepthNotional??(Number(book.bidNotional||0)+Number(book.askNotional||0))),imbalance=Number(book.notionalImbalance);
 if(!fresh)reasons.push('Order-book snapshot is stale');if(!Number.isFinite(spread)||spread<0||spread>maxSpreadBps)reasons.push('Bid/ask spread exceeds the configured liquidity limit');if(Number.isFinite(minTopDepthNotional)&&minTopDepthNotional>0&&depth<minTopDepthNotional)reasons.push('Top-of-book liquidity is below the configured minimum');
 const pressure=imbalance>.12?'BUY':imbalance<-.12?'SELL':'NEUTRAL';let score=50;
 if(direction===pressure&&direction!=='NEUTRAL')score+=20;else if(pressure!=='NEUTRAL'&&direction!=='NEUTRAL')score-=20;
 if(spread<=maxSpreadBps)score+=10;else score-=15;
 const funding=context.funding?.rate;
 if(Number.isFinite(funding)){if(direction==='BUY'&&funding>=.0005){score-=10;reasons.push('Positive funding is elevated; long-side carry cost may be high')}if(direction==='SELL'&&funding<=-.0005){score-=10;reasons.push('Negative funding is elevated; short-side carry cost may be high')}}
 const oi=Number(context.openInterest?.size),oiAvailable=Number.isFinite(oi)&&oi>=0;
 if(!oiAvailable&&context.productType!=='SPOT'&&context.productType!=='MARGIN')reasons.push('Open-interest snapshot is unavailable; derivatives participation context is incomplete');
 if(context.optionalErrors?.length)reasons.push(...context.optionalErrors);
 const approved=fresh&&Number.isFinite(spread)&&spread<=maxSpreadBps&&(!minTopDepthNotional||depth>=minTopDepthNotional);
 if(!approved)score=Math.min(score,49);
 return{available:true,approved,score:Math.max(0,Math.min(100,score)),direction:pressure,ageMs:age,fresh,spreadBps:spread,spreadAbsolute:book.spread,midPrice:book.mid,microPrice:book.microPrice,totalDepthNotional:depth,depthImbalance:imbalance,orderBookImbalance:imbalance,orderBookPressure:pressure,funding:context.funding||null,openInterest:context.openInterest||null,openInterestAvailable:oiAvailable,derivativesContextAvailable:context.productType==='SPOT'||context.productType==='MARGIN'||Boolean(context.funding&&oiAvailable),reasons}
}
