import { validateMarketObservation, analyseDerivativesHistory, detectLiquidityEvents, summarizeSignalPerformance, evaluateOutcomeHorizons } from './historical-intelligence.js';
const id=()=>crypto.randomUUID();
const parse=value=>{try{return JSON.parse(value||'{}')}catch{return {}}};
export async function persistMarketObservation(db,input){
  if(!db) throw new Error('D1 database binding is unavailable');
  const o=validateMarketObservation(input),key=id();
  const result=await db.prepare("INSERT OR IGNORE INTO market_observations (id,exchange,product_type,symbol,observation_type,observed_at_ms,data_json,quality,source) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(key,o.source,o.productType,o.symbol,o.observationType,o.observedAt,JSON.stringify(o.data),'VALID',o.source).run();
  return {stored:Boolean(result.meta?.changes),duplicate:!result.meta?.changes,observation:{...o,id:key}};
}
export async function readMarketHistory(db,{symbol,productType='USDT-FUTURES',hours=24,limit=1000}={}){
  if(!db) throw new Error('D1 database binding is unavailable');
  const s=String(symbol||'').toUpperCase();if(!/^[A-Z0-9]{2,30}$/.test(s))throw new TypeError('A valid symbol is required');
  const since=Date.now()-Math.min(168,Math.max(1,Number(hours)||24))*3600000;
  const rows=await db.prepare('SELECT observation_type,observed_at_ms,data_json,quality,source FROM market_observations WHERE exchange=? AND product_type=? AND symbol=? AND observed_at_ms>=? ORDER BY observed_at_ms DESC LIMIT ?')
    .bind('BITGET',productType,s,since,Math.min(5000,Math.max(1,Number(limit)||1000))).all();
  const observations=(rows.results||[]).map(r=>({observationType:r.observation_type,observedAt:Number(r.observed_at_ms),data:parse(r.data_json),quality:r.quality,source:r.source})).reverse();
  return {symbol:s,productType,observations,derivatives:analyseDerivativesHistory(observations),liquidityEvents:detectLiquidityEvents(observations),count:observations.length};
}
export async function recordSignalAndOutcome(db,{signal,productType,symbol,timeframe,now=Date.now()}){
  if(!db) return {persisted:false,reason:'D1 database binding is unavailable'};
  const signalId=id(),outcomeId=id(),entry=Number(signal.analysis?.entryContext?.lastPrice),direction=signal.rawDirection||signal.direction||'NEUTRAL';
  await db.prepare('INSERT INTO signal_events (id,instrument_id,direction,decision,score,evidence_json,strategy_versions_json,created_at) VALUES (?,NULL,?,?,?,?,?,?)')
    .bind(signalId,signal.rawDirection||signal.direction,signal.decision,Number(signal.score)||0,JSON.stringify(signal.evidence||[]),JSON.stringify({algorithm:signal.algorithm,version:signal.version}),new Date(now).toISOString()).run();
  await db.prepare('INSERT INTO signal_outcomes (id,signal_id,product_type,symbol,timeframe,direction,decision,entry_price,entry_time_ms,signal_score,status,horizon_results_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(outcomeId,signalId,productType,symbol,timeframe,direction,signal.decision,finiteOrNull(entry),now,Number(signal.score)||0,(['BUY','SELL'].includes(direction)&&Number.isFinite(entry)&&entry>0)?'PENDING':'INVALID','{}').run();
  return {persisted:true,signalId,outcomeId};
}
function finiteOrNull(v){return Number.isFinite(v)?v:null}
export async function evaluatePendingOutcomes(db,{symbol,productType='USDT-FUTURES',candles}={}){
  if(!db)throw new Error('D1 database binding is unavailable');
  const s=String(symbol||'').toUpperCase();if(!/^[A-Z0-9]{2,30}$/.test(s)||!Array.isArray(candles))throw new TypeError('Symbol and candle array are required');
  const rows=await db.prepare("SELECT * FROM signal_outcomes WHERE symbol=? AND product_type=? AND status IN ('PENDING','PARTIAL') ORDER BY entry_time_ms ASC LIMIT 500").bind(s,productType).all();
  let updated=0;
  for(const row of rows.results||[]){
    const outcome=evaluateOutcomeHorizons(row,candles);
    if(outcome.status==='INVALID')continue;
    if(outcome.status!==row.status||JSON.stringify(outcome.results)!==row.horizon_results_json){
      await db.prepare('UPDATE signal_outcomes SET status=?,horizon_results_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(outcome.status,JSON.stringify(outcome.results),row.id).run();updated++;
    }
  }
  return {symbol:s,examined:(rows.results||[]).length,updated};
}
export async function readSignalPerformance(db,{symbol,productType='USDT-FUTURES',limit=1000}={}){
  if(!db)throw new Error('D1 database binding is unavailable');
  const params=[productType],where='product_type=?';let sql='SELECT * FROM signal_outcomes WHERE '+where;
  if(symbol){sql+=' AND symbol=?';params.push(String(symbol).toUpperCase())}
  sql+=' ORDER BY entry_time_ms DESC LIMIT ?';params.push(Math.min(5000,Math.max(1,Number(limit)||1000)));
  const rows=await db.prepare(sql).bind(...params).all();
  const items=(rows.results||[]).map(r=>({...r,horizonResults:parse(r.horizon_results_json)}));
  const summary=summarizeSignalPerformance(items);
  const byHorizon={};
  for(const h of ['1h','4h','24h'])byHorizon[h]=summarizeSignalPerformance(items.filter(x=>x.horizonResults[h]).map(x=>({...x,status:'COMPLETE',horizonResults:{'4h':x.horizonResults[h]}})));
  return {summary,byHorizon,items};
}
