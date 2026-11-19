/* Read-only timing. Observed intervals are labelled; no claim time is invented from heartbeat age. */
(function(root){
  'use strict';
  const memory=new Map(),PREFIX='cairn-observed-execution-v1:';
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  function stamp(v){
    if(number(v)!==null)return v;
    if(typeof v!=='string'||!v)return null;
    const s=/^\d{4}-\d\d-\d\dT/.test(v)&&!/(Z|[+-]\d\d:?\d\d)$/.test(v)?v+'Z':v;
    const t=Date.parse(s)/1000;return Number.isFinite(t)?t:null;
  }
  const scope=g=>JSON.stringify([g.project.id,g.run?.id||g.project.run_id||g.project.created_at||'unknown']);
  function load(g){
    const key=scope(g);if(memory.has(key))return memory.get(key);
    let saved=null;
    try{saved=JSON.parse(root.sessionStorage?.getItem(PREFIX+key)||'null');}catch(_){}
    const rows=new Map();
    for(const r of Array.isArray(saved?.rows)?saved.rows:[])if(typeof r.id==='string'&&number(r.total)!==null)
      rows.set(r.id,{id:r.id,total:r.total,segment:0,active:false,worker:'',last:null});
    const entry={key,rows,runTotal:number(saved?.runTotal)??0,last:null,projectActive:false};
    memory.set(key,entry);return entry;
  }
  function observe(g,rows,now,connected){
    if(!g)return;
    const entry=load(g),byId=new Map(rows.map(r=>[r.id,r]));
    const delta=entry.last!==null?now-entry.last:0;
    if(connected&&entry.projectActive&&g.project.status==='active'&&delta>0&&delta<=10)entry.runTotal+=delta;
    for(const it of g.intents||[]){
      if(it.project_id!=null&&it.project_id!==g.project.id)continue;
      const r=byId.get(it.id),active=!!connected&&r?.state==='executing';
      const old=entry.rows.get(it.id)||{id:it.id,total:0,segment:0,active:false,worker:'',last:null};
      const step=old.last!==null?now-old.last:0;
      const continuous=old.active&&active&&old.worker===String(it.worker||'')&&step>=0&&step<=10;
      if(continuous){old.total+=step;old.segment+=step;}
      else if(active)old.segment=0;
      old.active=active;old.worker=String(it.worker||'');old.last=now;
      entry.rows.set(it.id,old);
    }
    entry.last=connected?now:null;entry.projectActive=connected&&g.project.status==='active';
    try{root.sessionStorage?.setItem(PREFIX+entry.key,JSON.stringify({runTotal:entry.runTotal,rows:[...entry.rows.values()].map(r=>({id:r.id,total:r.total}))}));}catch(_){}
  }
  function read(g,rows,now,connected){
    if(!g)return {rows:[],totalSeconds:0,source:'observed',runSeconds:null,runSource:'unknown'};
    const entry=load(g),raw=new Map(rows.map(r=>[r.id,r])),result=[];
    for(const it of g.intents||[]){
      if(it.project_id!=null&&it.project_id!==g.project.id)continue;
      const base=raw.get(it.id)||{id:it.id,state:'closed',worker:it.worker||'',animated:false};
      const observed=entry.rows.get(it.id),extra=connected&&base.state==='executing'&&observed?.active&&observed.last!==null
        ?Math.min(10,Math.max(0,now-observed.last)):0;
      const recordedTotal=number(it.validation_total_s),checkpoint=stamp(it.validation_active_since);
      const currentStart=stamp(it.execution_started_at),end=stamp(it.execution_ended_at);
      const currentUntil=base.state==='executing'&&connected?now:end;
      const recordedCurrent=currentStart!==null&&currentUntil!==null?Math.max(0,currentUntil-currentStart):null;
      const source=recordedTotal!==null?'recorded':'observed';
      const cumulativeSeconds=recordedTotal!==null?recordedTotal+(base.state==='executing'&&connected&&checkpoint!==null?Math.max(0,now-checkpoint):0)
        :(observed?.total||0)+extra;
      result.push({...base,currentSeconds:recordedCurrent!==null?recordedCurrent:observed?observed.segment+extra:null,
        cumulativeSeconds,timingSource:source,currentSource:recordedCurrent!==null?'recorded':'observed'});
    }
    const sources=new Set(result.map(r=>r.timingSource));
    const runStart=stamp(g.run?.started_at||g.project.run_started_at),runEnd=stamp(g.run?.ended_at||g.project.run_ended_at);
    const runExtra=connected&&g.project.status==='active'&&entry.last!==null?Math.min(10,Math.max(0,now-entry.last)):0;
    return {rows:result,totalSeconds:result.reduce((sum,r)=>sum+r.cumulativeSeconds,0),
      source:sources.size===1?sources.values().next().value:sources.size?'mixed':'observed',
      runSeconds:runStart!==null?(g.project.status==='active'&&connected?Math.max(0,now-runStart):runEnd!==null?Math.max(0,runEnd-runStart):null):entry.runTotal+runExtra,
      runSource:runStart!==null?'recorded':'observed'};
  }
  const api={observe,read,stamp};root.ExecutionClock=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
