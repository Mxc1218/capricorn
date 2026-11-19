/* Presentation metadata only. Legacy text is never promoted to authoritative evidence. */
(function(root){
  'use strict';
  function toolingInfo(fact){
    if(!fact||['origin','goal'].includes(fact.id))return false;
    if(['accepted_receipt','rejected','candidate'].includes(fact.evidence_status)||(fact.flags||[]).length)return false;
    if(['tooling_info','tool_help','preparation'].includes(fact.fact_kind||fact.kind))return true;
    if(fact.evidence_level==='target_response'||fact.target_response)return false;
    const text=String(fact.description||'');
    // Conservative legacy classification. A target response that happens to quote --help is retained.
    if(/HTTP\/\d(?:\.\d)?\s+\d{3}|目标响应|靶机响应|response\s+(?:body|status)/i.test(text))return false;
    return /^\s*(?:Usage:|用法[：:]|【工具(?:帮助|说明)】)/i.test(text)||
      /(?:^|\n)\s*(?:[$>]\s*)?[\w./-]+\s+(?:--help|-h)(?:\s|$)/m.test(text)&&/usage|用法|帮助|参数说明|options:/i.test(text)||
      /(?:执行|运行|查看)\s*[`"']?[\w./-]+\s+--help\b/.test(text)&&/帮助|用法|参数说明/.test(text);
  }
  function decorate(graph){
    const pid=graph.project.id,valid=new Set((graph.intents||[]).filter(i=>i.project_id==null||i.project_id===pid).map(i=>i.id));
    const merges=new Map(),unknown=new Set();
    function add(from,to,meta={}){
      if(!valid.has(from)||!valid.has(to)||from===to)return;
      const key=JSON.stringify([from,to]);
      const prior=merges.get(key);
      if(!prior||prior.legacy_text&&!meta.legacy_text)merges.set(key,{...meta,type:'merge',from,to,project_id:pid});
    }
    for(const edge of graph.edges||[])if(edge.type==='merge'&&(edge.project_id==null||edge.project_id===pid))add(edge.from,edge.to,edge);
    for(const edge of graph.merges||[])if(edge.project_id==null||edge.project_id===pid)add(edge.from||edge.victim_id,edge.to||edge.survivor_id,edge);
    for(const f of graph.facts||[]){
      if(f.project_id!=null&&f.project_id!==pid)continue;
      const text=String(f.description||'');
      const match=text.match(/^\s*【(?:合并通知|已合并)】\s*(i\d+)\s*已被\s*(?:并入|合并(?:到|至)?)\s*(i\d+)\b/);
      if(match)add(match[1],match[2],{legacy_text:true,source_fact:f.id,created_at:f.created_at});
      else{
        const victim=text.match(/^\s*【(?:合并通知|已合并)】\s*(i\d+)\s*已被/);
        if(victim&&valid.has(victim[1]))unknown.add(victim[1]);
      }
    }
    const targets=new Map();
    for(const e of merges.values()){if(!targets.has(e.from))targets.set(e.from,[]);targets.get(e.from).push(e.to);}
    return {...graph,
      facts:(graph.facts||[]).map(f=>({...f,tooling_info:toolingInfo(f)})),
      intents:(graph.intents||[]).map(i=>({...i,merged_into:targets.get(i.id)||[],merge_target_unknown:unknown.has(i.id)})),
      edges:[...(graph.edges||[]).filter(e=>e.type!=='merge'),...merges.values()],
      merge_relations:[...merges.values()]};
  }
  const api={toolingInfo,decorate};root.ViewerSemantics=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
