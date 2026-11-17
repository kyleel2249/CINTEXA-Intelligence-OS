const BASE_LIVE='https://api.bybit.com';
const BASE_TEST='https://api-testnet.bybit.com';
const CATEGORIES=new Set(['spot','linear','inverse','option']);
const TIMEFRAMES=new Set(['1','3','5','15','30','60','120','240','360','720','D','W','M']);
const TIMEOUT_MS=9000;
const enc=s=>new TextEncoder().encode(s);
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function hmacHex(secret,message){
 const key=await crypto.subtle.importKey('raw',enc(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',key,enc(message)));
}
const base=env=>env.BYBIT_TESTNET==='true'?BASE_TEST:BASE_LIVE;
const assertCategory=value=>{const c=String(value||'linear').toLowerCase();if(!CATEGORIES.has(c))throw new TypeError('Bybit category must be spot, linear, inverse or option');return c};
const assertSymbol=value=>{const s=String(value||'').toUpperCase();if(!/^[A-Z0-9-]{2,40}$/.test(s))throw new TypeError('A valid Bybit symbol is required');return s};
const cleanParams=params=>Object.fromEntries(Object.entries(params||{}).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>[k,String(v)]));
function queryString(params){return Object.entries(cleanParams(params)).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&')}
async function parseResponse(res,path){
 const raw=await res.text();let data;try{data=JSON.parse(raw)}catch{throw new Error('Bybit returned an unreadable response for '+path+' (HTTP '+res.status+')')}
 if(!res.ok)throw new Error('Bybit HTTP '+res.status+' for '+path+': '+String(data.retMsg||raw).slice(0,240));
 if(Number(data.retCode)!==0)throw new Error('Bybit API '+data.retCode+' for '+path+': '+String(data.retMsg||'Unknown exchange error').slice(0,240));
 return data.result??{};
}
export async function bybitPublicRequest({env={},path,params={},fetchImpl=fetch}={}){
 const query=queryString(params),url=base(env)+path+(query?'?'+query:'');
 const res=await fetchImpl(url,{method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(TIMEOUT_MS)});
 return parseResponse(res,path);
}
export async function bybitPrivateRequest({env,method='GET',path,params={},body=null,fetchImpl=fetch,now=Date.now()}={}){
 if(!env?.BYBIT_API_KEY||!env?.BYBIT_API_SECRET)throw new Error('Bybit API credentials are not configured in Worker secrets');
 const verb=method.toUpperCase(),recvWindow=String(env.BYBIT_RECV_WINDOW||5000),timestamp=String(now),payload=body?JSON.stringify(body):'';
 const query=queryString(params),signPayload=verb==='GET'?timestamp+env.BYBIT_API_KEY+recvWindow+query:timestamp+env.BYBIT_API_KEY+recvWindow+payload;
 const signature=await hmacHex(env.BYBIT_API_SECRET,signPayload);
 const url=base(env)+path+(verb==='GET'&&query?'?'+query:'');
 const headers={'accept':'application/json','content-type':'application/json','X-BAPI-API-KEY':env.BYBIT_API_KEY,'X-BAPI-SIGN':signature,'X-BAPI-SIGN-TYPE':'2','X-BAPI-TIMESTAMP':timestamp,'X-BAPI-RECV-WINDOW':recvWindow};
 const res=await fetchImpl(url,{method:verb,headers,...(verb==='GET'?{}:{body:payload}),signal:AbortSignal.timeout(TIMEOUT_MS)});
 return parseResponse(res,path);
}
export async function getBybitInstruments({env={},category='linear',symbol,baseCoin,limit=1000,cursor,fetchImpl=fetch}={}){
 const c=assertCategory(category),s=symbol?assertSymbol(symbol):undefined;
 return bybitPublicRequest({env,path:'/v5/market/instruments-info',params:{category:c,symbol:s,baseCoin,limit:c==='spot'?undefined:Math.min(1000,Math.max(1,Number(limit)||1000)),cursor},fetchImpl});
}
export async function getBybitInstrumentCatalog({env={},category='linear',baseCoin,limit=1000,maxPages=10,fetchImpl=fetch}={}){
 const c=assertCategory(category),pageSize=c==='spot'?undefined:Math.min(1000,Math.max(1,Number(limit)||1000));
 if(c==='spot')return getBybitInstruments({env,category:c,fetchImpl});
 const list=[],seen=new Set();let cursor,nextCursor='',hasMore=false,pages=0;
 const pageLimit=Math.min(20,Math.max(1,Math.floor(Number(maxPages)||10)));
 while(pages<pageLimit){
  const page=await getBybitInstruments({env,category:c,baseCoin,limit:pageSize,cursor,fetchImpl});
  if(Array.isArray(page.list))list.push(...page.list);
  pages++;
  const next=String(page.nextPageCursor||'');
  if(!next||seen.has(next)){hasMore=false;break}
  seen.add(next);
  if(pages>=pageLimit){hasMore=true;nextCursor=next;break}
  cursor=next;
 }
 return{category:c,list,nextPageCursor:hasMore?nextCursor:'',pages,complete:!hasMore};
}
export async function getBybitTicker({env={},category='linear',symbol,fetchImpl=fetch}={}){
 const c=assertCategory(category),s=assertSymbol(symbol);
 const result=await bybitPublicRequest({env,path:'/v5/market/tickers',params:{category:c,symbol:s},fetchImpl});
 const row=result.list?.[0];if(!row)throw new Error('Bybit returned no ticker for '+s);
 return{exchange:'BYBIT',category:c,symbol:s,last:Number(row.lastPrice),bid:Number(row.bid1Price),ask:Number(row.ask1Price),high24h:Number(row.highPrice24h),low24h:Number(row.lowPrice24h),volume24h:Number(row.volume24h),turnover24h:Number(row.turnover24h),price24hPcnt:Number(row.price24hPcnt),markPrice:Number(row.markPrice),indexPrice:Number(row.indexPrice),fundingRate:row.fundingRate===undefined?null:Number(row.fundingRate),openInterest:row.openInterest===undefined?null:Number(row.openInterest),nextFundingTime:Number(row.nextFundingTime)||null,timestamp:Number(result.ts)||Date.now(),source:'bybit-v5-public-rest'};
}
export async function getBybitCandles({env={},category='linear',symbol,interval='1',limit=200,start,end,fetchImpl=fetch}={}){
 const c=assertCategory(category),s=assertSymbol(symbol),iv=String(interval);if(c==='option')throw new TypeError('Bybit V5 does not provide standard kline candles for options');if(!TIMEFRAMES.has(iv))throw new TypeError('Unsupported Bybit kline interval');
 const n=Math.min(1000,Math.max(1,Math.floor(Number(limit)||200)));
 const result=await bybitPublicRequest({env,path:'/v5/market/kline',params:{category:c,symbol:s,interval:iv,limit:n,start,end},fetchImpl});
 if(!Array.isArray(result.list))throw new Error('Bybit returned an invalid kline payload');
 return result.list.map(row=>({time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),baseVolume:Number(row[5]),quoteVolume:Number(row[6])})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)&&x.high>=x.low).sort((a,b)=>a.time-b.time);
}
export async function getBybitOrderBook({env={},category='linear',symbol,limit=50,fetchImpl=fetch}={}){
 const c=assertCategory(category),s=assertSymbol(symbol),result=await bybitPublicRequest({env,path:'/v5/market/orderbook',params:{category:c,symbol:s,limit:Math.min(c==='option'?25:200,Math.max(1,Number(limit)||50))},fetchImpl});
 const bids=(result.b||[]).map(x=>[Number(x[0]),Number(x[1])]),asks=(result.a||[]).map(x=>[Number(x[0]),Number(x[1])]);
 return{bids,asks,ts:Number(result.ts)||Date.now(),u:result.u,seq:result.seq,category:c,symbol:s};
}
export async function getBybitMarketContext({env={},category='linear',symbol,fetchImpl=fetch}={}){
 const c=assertCategory(category),s=assertSymbol(symbol);
 const [book,ticker,funding,oi]=await Promise.allSettled([
  getBybitOrderBook({env,category:c,symbol:s,fetchImpl}),
  getBybitTicker({env,category:c,symbol:s,fetchImpl}),
  c==='linear'||c==='inverse'?bybitPublicRequest({env,path:'/v5/market/funding/history',params:{category:c,symbol:s,limit:20},fetchImpl}):Promise.resolve(null),
  c==='linear'||c==='inverse'?bybitPublicRequest({env,path:'/v5/market/open-interest',params:{category:c,symbol:s,intervalTime:'5min',limit:20},fetchImpl}):Promise.resolve(null)
 ]);
 const errors=[],b=book.status==='fulfilled'?book.value:null,t=ticker.status==='fulfilled'?ticker.value:null;
 if(book.status==='rejected')errors.push('Order-book unavailable: '+book.reason.message);
 if(ticker.status==='rejected')errors.push('Ticker unavailable: '+ticker.reason.message);
 const f=funding.status==='fulfilled'?funding.value?.list||[]:[],o=oi.status==='fulfilled'?oi.value?.list||[]:[];
 if(funding.status==='rejected')errors.push('Funding history unavailable');
 if(oi.status==='rejected')errors.push('Open-interest history unavailable');
 return{exchange:'BYBIT',category:c,symbol:s,orderBook:b,ticker:t,fundingHistory:f.map(x=>({rate:Number(x.fundingRate),fundingRateTimestamp:Number(x.fundingRateTimestamp)})),openInterestHistory:o.map(x=>({openInterest:Number(x.openInterest),timestamp:Number(x.timestamp)})),errors,timestamp:Date.now(),source:'bybit-v5-public-rest'};
}
export async function getBybitSpotMarginState({env}={}){
 return bybitPrivateRequest({env,path:'/v5/spot-margin-trade/state'});
}
export async function getBybitSpotBorrowQuota({env,symbol,side='Buy'}={}){
 const s=assertSymbol(symbol),direction=String(side);if(!['Buy','Sell'].includes(direction))throw new TypeError('Spot borrow quota side must be Buy or Sell');
 return bybitPrivateRequest({env,path:'/v5/order/spot-borrow-check',params:{category:'spot',symbol:s,side:direction}});
}
export async function getBybitSpotMaxBorrowable({env,currency}={}){
 if(!currency)throw new TypeError('A currency is required');
 return bybitPrivateRequest({env,path:'/v5/spot-margin-trade/max-borrowable',params:{currency:String(currency).toUpperCase()}});
}
export async function getBybitSpotMarginLiability({env,currency}={}){
 if(!currency)throw new TypeError('A currency is required for spot margin liability');
 return bybitPrivateRequest({env,path:'/v5/spot-margin-trade/liability',params:{currency:String(currency).toUpperCase()}});
}
export async function getBybitAccountInfo({env}={}){
 return bybitPrivateRequest({env,path:'/v5/account/info'});
}
export async function getBybitCollateralInfo({env,currency}={}){
 return bybitPrivateRequest({env,path:'/v5/account/collateral-info',params:{currency}});
}
export async function getBybitWalletBalance({env,accountType='UNIFIED',coin}={}){
 return bybitPrivateRequest({env,path:'/v5/account/wallet-balance',params:{accountType,coin}});
}
export async function getBybitPositions({env,category='linear',symbol,settleCoin,baseCoin,limit=200,cursor}={}){
 const c=assertCategory(category);if(c==='spot')throw new TypeError('Spot balances are reported through the Unified wallet endpoint');
 return bybitPrivateRequest({env,path:'/v5/position/list',params:{category:c,symbol:symbol?assertSymbol(symbol):undefined,settleCoin,baseCoin,limit:Math.min(200,Math.max(1,Number(limit)||200)),cursor}});
}
export async function getBybitOpenOrders({env,category='linear',symbol,openOnly=0,limit=50,cursor}={}){
 const c=assertCategory(category);
 return bybitPrivateRequest({env,path:'/v5/order/realtime',params:{category:c,symbol:symbol?assertSymbol(symbol):undefined,openOnly,limit:Math.min(50,Math.max(1,Number(limit)||50)),cursor}});
}
export async function getBybitOrderHistory({env,category='linear',symbol,limit=50,cursor,startTime,endTime}={}){
 const c=assertCategory(category);
 return bybitPrivateRequest({env,path:'/v5/order/history',params:{category:c,symbol:symbol?assertSymbol(symbol):undefined,limit:Math.min(50,Math.max(1,Number(limit)||50)),cursor,startTime,endTime}});
}
export async function getBybitExecutions({env,category='linear',symbol,limit=50,cursor,startTime,endTime}={}){
 const c=assertCategory(category);
 return bybitPrivateRequest({env,path:'/v5/execution/list',params:{category:c,symbol:symbol?assertSymbol(symbol):undefined,limit:Math.min(100,Math.max(1,Number(limit)||50)),cursor,startTime,endTime}});
}
export async function getBybitAccountSnapshot({env}={}){
 const [wallet,accountInfo,collateral,spotMarginState,linear,inverse,optionPositions,spotOrders,optionOrders]=await Promise.allSettled([
  getBybitWalletBalance({env,accountType:'UNIFIED'}),
  getBybitAccountInfo({env}),
  getBybitCollateralInfo({env}),
  getBybitSpotMarginState({env}),
  getBybitPositions({env,category:'linear'}),
  getBybitPositions({env,category:'inverse'}),
  getBybitPositions({env,category:'option',baseCoin:'BTC'}),
  getBybitOpenOrders({env,category:'spot',limit:50}),
  getBybitOpenOrders({env,category:'option',limit:50})
 ]);
 const value=x=>x.status==='fulfilled'?x.value:null;
 const errors=[wallet,accountInfo,collateral,spotMarginState,linear,inverse,optionPositions,spotOrders,optionOrders]
  .map((x,i)=>x.status==='rejected'?['wallet','accountInfo','collateral','spotMarginState','linearPositions','inversePositions','optionPositions','spotOrders','optionOrders'][i]+': '+x.reason.message:null).filter(Boolean);
 return{exchange:'BYBIT',accountType:'UNIFIED',wallet:value(wallet),accountInfo:value(accountInfo),collateral:value(collateral)?.list||[],spotMarginState:value(spotMarginState),linearPositions:value(linear)?.list||[],inversePositions:value(inverse)?.list||[],optionPositions:value(optionPositions)?.list||[],spotOpenOrders:value(spotOrders)?.list||[],optionOpenOrders:value(optionOrders)?.list||[],errors,timestamp:Date.now(),readOnly:true};
}
// Deliberately locked. The V5 connector is live-market and authenticated-account capable,
// but order placement remains unavailable until server-side risk attestation, protected-order
// atomicity, idempotency, fill reconciliation, kill-switch and operator approval are verified.
export async function submitBybitLiveOrder(){throw new Error('Bybit live order routing is hard-disabled pending complete ETI risk attestation, exchange-side protective orders, idempotency, fill reconciliation, account sync, emergency controls and explicit operator activation.')}
