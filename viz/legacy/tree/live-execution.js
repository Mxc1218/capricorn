/* Read-only lease observations. DeepSeek draft reviewed; no inferred claim times. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LiveExecution=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const stamp=(value,iso)=>typeof value==='number'&&Number.isFinite(value)?value:iso&&Number.isFinite(Date.parse(iso))?Date.parse(iso)/1000:null;
  function snapshot(graph,now,connected=true){
    if(!graph)return {rows:[],activeIds:[],animatedEdgeKeys:[]};
    const rows=[],activeIds=[],pid=graph.project.id;
    for(const it of graph.intents||[]){
      if((it.project_id!=null&&it.project_id!==pid)||!it.open||it.concluded_at)continue;
      const hb=stamp(it.hb_ts,it.last_heartbeat_at),ts=stamp(it.ts,it.created_at);
      const heartbeatAge=hb!==null&&now>=hb?now-hb:null,worker=String(it.worker||'').trim();
      const until=graph.project.status==='active'?now:stamp(graph.summary?.last_activity_ts,null);
      const spanSeconds=ts!==null&&until!==null&&until>=ts?until-ts:null;
      let state;
      if(graph.project.status!=='active')state='paused';
      else if((it.merged_into||[]).length||it.merge_target_unknown)state='merged';
      else if(!worker)state='waiting';
      else if(!connected)state='connection_unknown';
      else if(heartbeatAge===null)state='awaiting_heartbeat';
      else if(heartbeatAge>300)state='stalled';
      else state=it.execution_state==='executing'?'executing':it.execution_state==='awaiting_heartbeat'?'awaiting_heartbeat':it.execution_state==='stalled'?'stalled':'claimed';
      const animated=state==='executing';
      rows.push({id:it.id,worker,state,heartbeatAge,spanSeconds,animated});if(animated)activeIds.push(it.id);
    }
    const active=new Set(activeIds),keys=new Set();
    // Dependency edges are static. Verification activity is drawn inside the intent node.
    return {rows,activeIds,animatedEdgeKeys:[...keys]};
  }
  function transitions(before,after){
    if(!before||!after||!before.project?.id||before.project.id!==after.project?.id)return [];
    const old=new Map((before.intents||[]).filter(i=>i.project_id==null||i.project_id===before.project.id).map(i=>[i.id,i])),events=[];
    for(const it of after.intents||[]){
      if(it.project_id!=null&&it.project_id!==after.project.id)continue;
      const prev=old.get(it.id);
      if(!prev){if(it.open&&it.worker)events.push({type:'claimed',id:it.id,worker:it.worker});continue;}
      if(prev.open&&!it.open){events.push({type:'concluded',id:it.id,worker:prev.worker||it.worker});continue;}
      if(!it.open)continue;
      if(it.worker&&it.worker!==prev.worker)events.push({type:'claimed',id:it.id,worker:it.worker,previousWorker:prev.worker});
      else if(prev.worker&&!it.worker)events.push({type:'released',id:it.id,worker:prev.worker});
      else if(it.execution_state!==prev.execution_state)events.push({type:'state_changed',id:it.id,worker:it.worker,state:it.execution_state});
    }
    return events;
  }
  return {snapshot,transitions};
});
