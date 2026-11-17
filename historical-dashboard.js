const apiBase=String(window.CINTEXA_API_BASE||'').replace(/\/$/,'');
async function readApi(res){const t=res.headers.get('content-type')||'';if(!t.includes('json'))throw new Error('CINTEXA API is not reachable from this site (received a web page instead of data). Deploy the API (Pages Function or Worker) or set CINTEXA_API_BASE in config.js.');return res.json()}
const style=document.createElement('style');
style.textContent=`
.historical-panel{margin-top:22px;background:#0c1b31;border:1px solid #1b3553;border-radius:16px;padding:20px;color:#e8f1ff}
.historical-panel h3{margin:0 0 6px;font-size:18px}.historical-panel .sub{color:#91a8c8;font-size:12px;margin:0 0 16px}
.historical-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.historical-stat{background:#102541;border:1px solid #203b5c;border-radius:12px;padding:13px;min-width:0}
.historical-stat small{display:block;color:#91a8c8;font-size:11px;margin-bottom:7px}.historical-stat strong{font-size:20px;overflow-wrap:anywhere}
.historical-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:15px}
.historical-box{background:#0a1729;border:1px solid #1b3553;border-radius:12px;padding:14px;min-width:0}
.historical-box h4{font-size:13px;margin:0 0 10px}.historical-line{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #1b3553;font-size:12px}.historical-line:last-child{border:0}
.historical-muted{color:#91a8c8}.historical-warning{color:#f3c46c}.historical-refresh{background:#173d67;border:1px solid #2a5c8d;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}
@media(max-width:760px){.historical-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.historical-columns{grid-template-columns:1fr}}
`;
document.head.append(style);
function initHistoricalPanel(){
 const dashboard=document.querySelector('#dashboard'),anchor=dashboard?.querySelector('.main-grid');
 if(!anchor||document.querySelector('#eti-historical-panel'))return;
 anchor.insertAdjacentHTML('afterend',`
 <section class="historical-panel" id="eti-historical-panel">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><h3>ETI Historical Market Intelligence</h3><p class="sub">Persistent Bitget observations · Derivatives history · Signal outcomes · Liquidity events</p></div><button class="historical-refresh" id="eti-history-refresh">Refresh intelligence</button></div>
  <div class="historical-stats">
   <div class="historical-stat"><small>Market observations</small><strong id="eti-hist-count">—</strong></div>
   <div class="historical-stat"><small>Signal records</small><strong id="eti-hist-signals">—</strong></div>
   <div class="historical-stat"><small>4h directional win rate</small><strong id="eti-hist-winrate">—</strong></div>
   <div class="historical-stat"><small>4h gross expectancy</small><strong id="eti-hist-expectancy">—</strong></div>
  </div>
  <div class="historical-columns">
   <div class="historical-box"><h4>Derivatives and liquidity</h4><div id="eti-hist-derivatives" class="historical-muted">Waiting for persisted market observations.</div></div>
   <div class="historical-box"><h4>Signal validation</h4><div id="eti-hist-validation" class="historical-muted">Waiting for completed forward outcomes.</div></div>
  </div>
  <p class="sub" id="eti-hist-status" style="margin-top:14px;margin-bottom:0">Historical statistics are unavailable until D1 migration is applied and Bitget observations are received. Small samples are not treated as validated accuracy.</p>
 </section>`);
 const el=id=>document.getElementById(id);
 const fmt=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const line=(label,value)=>'<div class="historical-line"><span class="historical-muted">'+esc(label)+'</span><b>'+esc(value)+'</b></div>';
 async function load(){
  const symbol=document.querySelector('#market-symbol')?.value?.trim().toUpperCase()||'BTCUSDT';
  const productType=document.querySelector('#market-product')?.value||'USDT-FUTURES';
  el('eti-hist-status').textContent='Loading persisted historical records…';
  try{
   const [historyRes,performanceRes]=await Promise.all([
    fetch(apiBase+'/api/eti/history?'+new URLSearchParams({symbol,productType,hours:'24',limit:'1500'})),
    fetch(apiBase+'/api/eti/performance?'+new URLSearchParams({symbol,productType,limit:'1500'}))
   ]);
   const [history,performance]=await Promise.all([readApi(historyRes),readApi(performanceRes)]);
   if(!historyRes.ok)throw new Error(history.error||'Historical data service unavailable');
   if(!performanceRes.ok)throw new Error(performance.error||'Signal performance service unavailable');
   const summary=performance.summary||{},four=performance.byHorizon?.['4h']||{};
   el('eti-hist-count').textContent=history.count??0;
   el('eti-hist-signals').textContent=summary.totalSignals??0;
   el('eti-hist-winrate').textContent=Number.isFinite(summary.winRate)?fmt(summary.winRate)+'%':'—';
   el('eti-hist-expectancy').textContent=Number.isFinite(four.expectancyPct)?fmt(four.expectancyPct)+'%':'—';
   const oi=history.derivatives?.openInterest||{},funding=history.derivatives?.funding||{};
   const events=Array.isArray(history.liquidityEvents)?history.liquidityEvents:[];
   el('eti-hist-derivatives').innerHTML=
    line('Open-interest change',oi.available?fmt(oi.changePercent)+'%':'Insufficient samples')+
    line('Latest funding',funding.current!==null&&funding.current!==undefined?fmt(Number(funding.current)*100,4)+'%':'Unavailable')+
    line('Funding observations',funding.observations??0)+
    line('Detected liquidity events',events.length)+
    (events.slice(-3).map(e=>line(String(e.type).replaceAll('_',' '),new Date(e.observedAt).toLocaleTimeString())).join('')||'<p class="historical-muted">No qualifying liquidity events in this sample.</p>');
   el('eti-hist-validation').innerHTML=
    line('Completed outcomes',summary.completedSignals??0)+
    line('Pending outcomes',summary.pendingSignals??0)+
    line('Trade decisions',summary.tradeSignals??0)+
    line('NO TRADE decisions',summary.noTradeSignals??0)+
    line('Profit factor',Number.isFinite(four.profitFactor)?fmt(four.profitFactor):'Insufficient sample')+
    '<p class="historical-muted" style="font-size:11px;margin-top:10px">4h sample: '+esc(four.sampleSize??0)+' outcomes · '+esc(four.reliability||'INSUFFICIENT_SAMPLE')+'. No accuracy claim is made from an unvalidated sample.</p>';
   el('eti-hist-status').textContent='Loaded '+history.count+' persisted observations for '+symbol+'. Outcome validation advances when forward candle history is submitted.';
  }catch(error){
   ['eti-hist-count','eti-hist-signals','eti-hist-winrate','eti-hist-expectancy'].forEach(id=>el(id).textContent='—');
   el('eti-hist-status').textContent=error.message+' · Apply migration 0002 and confirm the Worker D1 binding.';
  }
 }
 el('eti-history-refresh').addEventListener('click',load);
 document.querySelector('#market-refresh')?.addEventListener('click',()=>setTimeout(load,2500));
 document.querySelector('#market-symbol')?.addEventListener('change',load);
 document.querySelector('#market-product')?.addEventListener('change',()=>setTimeout(load,1000));
 load();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initHistoricalPanel,{once:true});else initHistoricalPanel();
