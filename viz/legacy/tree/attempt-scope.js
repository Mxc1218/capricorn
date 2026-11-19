/* Project ID is the attempt boundary. Same challenge/address never merges evidence.
 * DeepSeek draft reviewed for deterministic ordering, metadata merge and test flags. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AttemptScope=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const natural=new Intl.Collator('en',{numeric:true});
  function challengeKey(p){
    const platform=String(p.platform||'').trim(),title=String(p.title||'').trim();let m;
    if((m=/^tsecbench:([a-z]-\d+)$/i.exec(platform)))return 'tsecbench:'+m[1].toLowerCase();
    if((m=/^cvebench:(CVE-\d{4}-\d{4,})$/i.exec(platform)))return 'cvebench:'+m[1].toUpperCase();
    if(platform)return 'project:'+p.id;
    if((m=/^TSecBench\s+([a-z]-\d+)(?=\s|\(|$)/i.exec(title)))return 'tsecbench:'+m[1].toLowerCase();
    if((m=/^(?:CVE-Bench\s+|CVEBench\s+)?(CVE-\d{4}-\d{4,})(?=\s|\(|$)/i.exec(title)))return 'cvebench:'+m[1].toUpperCase();
    return 'project:'+p.id;
  }
  const addresses=p=>[...new Set((p.instance_addresses||[]).map(String))].sort();
  function describe(project,projects){
    const selected={...(projects||[]).find(p=>p.id===project.id),...project};
    const key=challengeKey(selected),byId=new Map((projects||[]).filter(p=>challengeKey(p)===key).map(p=>[p.id,p]));
    byId.set(selected.id,selected);
    const time=p=>Number.isFinite(Date.parse(p.created_at))?Date.parse(p.created_at):-Infinity;
    const matches=[...byId.values()].sort((a,b)=>{
      const ta=time(a),tb=time(b);return (ta===tb?0:ta>tb?-1:1)||natural.compare(b.id,a.id)||String(b.id).localeCompare(String(a.id));
    });
    const latest=matches[0],a=addresses(selected),b=addresses(latest),isLatest=selected.id===latest.id;
    return {challenge_key:key,project_id:selected.id,latest,is_latest:isLatest,history_count:matches.length-1,
      relation:isLatest?'latest_project':!a.length||!b.length?'unknown_instance_history':JSON.stringify(a)===JSON.stringify(b)?'same_instance_history':'different_instance',
      instance_label:a.join(', ')||'实例未标注',latest_instance_label:b.join(', ')||'实例未标注'};
  }
  function isSyntheticFlag(raw){return /^flag\{(?:(?:partial|selftest|self_test|test|example|dummy|placeholder|fake|todo)(?:[_-]?\d+)*|\.{2,}|…|<[^}]*>)\}$/i.test(String(raw||'').replace(/\s+/g,''));}
  function isTestReceipt(f){
    return ['creator','worker','author'].some(k=>/^self[_-]?test$/i.test(f[k]||''))
      ||((f.flags||[]).length>0&&f.flags.every(isSyntheticFlag))
      ||/^\s*(?:\[?self[_-]?test\]?|【(?:自测|测试)回执】)/i.test(f.description||'');
  }
  const isCurrentFact=(f,pid)=>f.project_id==null||f.project_id===pid;
  return {challengeKey,describe,isSyntheticFlag,isTestReceipt,isCurrentFact};
});
