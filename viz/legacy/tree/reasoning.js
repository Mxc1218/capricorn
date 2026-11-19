// Stable content changes rebuild geometry; heartbeats/timer totals update in place.
let reasonContentGraph=null,reasonContentKey='';
function reasoningContentKey(graph){
  if(reasonContentGraph===graph)return reasonContentKey;
  const intents=(graph.intents||[]).map(it=>{
    const {last_heartbeat_at,hb_ts,worker,execution_state,state_label,running,stale,unclaimed,
      validation_total_s,validation_active_since,execution_started_at,execution_ended_at,...stable}=it;
    return stable;
  });
  reasonContentGraph=graph;
  reasonContentKey=JSON.stringify([graph.project.id,graph.project.title,graph.project.status,graph.facts,intents,graph.edges]);
  return reasonContentKey;
}
/* A dependency tree is the primary view; dashboards and lanes remain secondary. */
function initReasoning() {
  $('#reason-layout').addEventListener('change',event=>{
    state.groupOutputs=event.target.value!=='id';renderReasoning();
  });
  $('#btnTooling').addEventListener('click',()=>{
    state.showToolInfo=!state.showToolInfo;renderReasoning();
  });
  $('#reason-latest').addEventListener('click',()=>{
    const intents=(state.data?.intents||[]).slice().sort((a,b)=>(a.ts??0)-(b.ts??0)||a.id.localeCompare(b.id,'en',{numeric:true}));
    const latest=intents.at(-1);if(!latest)return;
    state.reasonMode='all';state.traceMode=null;renderReasoning();
    requestAnimationFrame(()=>focusReasonNode('intent:'+latest.id));
  });
  document.querySelectorAll('[data-reason-mode]').forEach(button => button.addEventListener('click', () => {
    state.reasonMode=button.dataset.reasonMode; state.traceMode=null;state.selected=null;$('#side').classList.add('hide');renderReasoning();
    requestAnimationFrame(()=>focusReasonNode('fact:origin'));
  }));
  $('#reason-target').addEventListener('change', event => {
    state.reasonReceipt=event.target.value; state.traceMode=null;state.selected=null;$('#side').classList.add('hide');renderReasoning();
    requestAnimationFrame(()=>focusReasonNode(event.target.value==='all'?'fact:origin':'fact:'+event.target.value));
  });
  $('#reason-zoom').addEventListener('change', event => {
    state.reasonZoom=event.target.value; zoomReasoning();
    syncCanvasFocusContext();
  });
  $('#reason-expand').addEventListener('click', () => {
    state.reasonMode=state.reasonMode==='success'?'ancestors':'all'; state.traceMode=null; renderReasoning();
  });
  $('#reason-start').addEventListener('click',()=>focusReasonNode('fact:origin'));
  $('#reason-end').addEventListener('click',()=>{
    const receipts=(state.data?.facts||[]).filter(f=>f.evidence_status==='accepted_receipt');
    const id=state.reasonReceipt!=='all'?state.reasonReceipt:receipts.at(-1)?.id;
    if(id)focusReasonNode('fact:'+id);
  });
  $('#reason-map').addEventListener('click',event=>{
    const map=$('#reason-map'),point=map.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    const world=point.matrixTransform(map.getScreenCTM().inverse()),canvas=$('#reason-canvas');
    const scale=Number($('#reason-tree').dataset.scale)||1;
    canvas.scrollLeft=world.x*scale-reasonViewportWidth()/2;canvas.scrollTop=world.y*scale-canvas.clientHeight/2;
  });
  const canvas=$('#reason-canvas');
  let mapFrame=0;
  canvas.addEventListener('scroll',()=>{if(!mapFrame)mapFrame=requestAnimationFrame(()=>{mapFrame=0;updateReasonMap();});},{passive:true});
  let drag=null;
  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest('.reason-node'))return;
    drag={x:event.clientX,y:event.clientY,left:canvas.scrollLeft,top:canvas.scrollTop};
    canvas.setPointerCapture(event.pointerId);canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove',event=>{
    if(drag){canvas.scrollLeft=drag.left+drag.x-event.clientX;canvas.scrollTop=drag.top+drag.y-event.clientY;}
  });
  const stopDrag=()=>{drag=null;canvas.classList.remove('dragging');};
  canvas.addEventListener('pointerup',stopDrag);canvas.addEventListener('pointercancel',stopDrag);
  if (typeof ResizeObserver!=='undefined') {
    let frame=0;
    new ResizeObserver(()=>{
      cancelAnimationFrame(frame);frame=requestAnimationFrame(zoomReasoning);
    }).observe($('#reason-canvas'));
  }
  if(typeof MutationObserver!=='undefined')new MutationObserver(()=>requestAnimationFrame(zoomReasoning)).observe($('#side'),{attributes:true,attributeFilter:['class']});
}

function renderReasoning() {
  const graph=state.data, svg=$('#reason-tree');
  if(!graph) {
    state.reasonRenderSignature=null;reasonContentGraph=null;
    svg.textContent='';$('#reason-map').textContent='';$('#reason-results').textContent='';
    $('#reason-status').textContent='等待项目数据';$('#reason-counts').textContent='';$('#reason-evidence-status').textContent='';
    $('#reason-note').textContent='等待当前项目的记录，不沿用上一项目的结果。';return;
  }
  // Do not relayout or recreate SVG nodes for lease-only updates or repeated callers.
  const renderSignature=JSON.stringify([reasoningContentKey(graph),state.reasonMode,state.reasonReceipt,!!state.showToolInfo,state.groupOutputs!==false,state.traceMode,state.traceMode?state.selected:null]);
  if(state.reasonRenderSignature===renderSignature&&svg.childElementCount){
    svg.dataset.reusedSnapshots=String((Number(svg.dataset.reusedSnapshots)||0)+1);
    highlightReasoning();syncExecutionVisuals();return;
  }
  const receipts=graph.facts.filter(f=>f.evidence_status==='accepted_receipt'&&!AttemptScope.isTestReceipt(f));
  const groups=ReasoningModel.resultGroups(graph);
  const terminalMap=new Map(groups.map(g=>[g.target.id,g.target]));
  for(const f of receipts)if(!groups.some(g=>g.receipts.some(r=>r.id===f.id)))terminalMap.set(f.id,f);
  const terminals=[...terminalMap.values()];
  if(state.reasonReceipt!=='all'&&!terminals.some(f=>f.id===state.reasonReceipt)) state.reasonReceipt='all';
  const selector=$('#reason-target'); selector.textContent='';
  const option=(value,text) => { const opt=document.createElement('option');opt.value=value;opt.textContent=text;selector.appendChild(opt); };
  option('all',`全部结果（${terminals.length}）`);
  terminals.forEach(f=>{
    const progress=(f.description||'').match(/进度\s*(\d+\s*\/\s*\d+)/);
    option(f.id,`${f.id} · ${progress?'回执 '+progress[1]:'候选 · 缺通过回执'}`);
  });
  selector.value=state.reasonReceipt;
  const projectedGraph={...graph,ui_hide_tooling:!state.showToolInfo};
  $('#btnTooling').classList.toggle('on',!!state.showToolInfo);
  $('#btnTooling').setAttribute('aria-pressed',String(!!state.showToolInfo));
  $('#btnTooling').textContent=(state.showToolInfo?'收起':'展开')+'工具说明（'+graph.facts.filter(f=>f.tooling_info).length+'）';
  let projection=ReasoningModel.project(projectedGraph,state.reasonMode,state.reasonReceipt);
  if(state.traceMode&&state.selected&&state.view==='reasoning') {
    const trace=TreeModel.traceGraph(graph,state.selected.kind,state.selected.id,state.traceMode);
    const included=new Set(trace.nodes), edgeKeys=new Set(trace.edges.map(TreeModel.edgeKey));
    const full=ReasoningModel.project(projectedGraph,'all',state.reasonReceipt);
    projection={...full,nodes:full.nodes.filter(n=>included.has(n.key)),edges:full.edges.filter(e=>edgeKeys.has(TreeModel.edgeKey(e))),mode:'trace'};
  }
  const grouped=state.groupOutputs!==false;
  $('#reason-layout').value=grouped?'grouped':'id';
  const layout=ReasoningModel.layout(projection,{groupOutputs:grouped});
  svg.dataset.traceKey=state.traceMode&&state.selected&&state.view==='reasoning'
    ? state.selected.kind+':'+state.selected.id+':'+state.traceMode : '';
  document.querySelectorAll('[data-reason-mode]').forEach(button=>{
    button.classList.toggle('on',button.dataset.reasonMode===projection.mode);
    button.setAttribute('aria-pressed',String(button.dataset.reasonMode===projection.mode));
    button.disabled=button.dataset.reasonMode!=='all'&&!receipts.length;
  });
  const modeText={success:'结果依赖 · 保留全部明确前提',ancestors:'完整上下文 · 展开支持方向的其他产出',all:'全部推理 · 保留失败与旁支',trace:'所选节点的关系追踪'}[projection.mode];
  $('#reason-status').textContent=`${modeText} · 显示 ${projection.nodes.length}/${projection.totalNodes} 个节点、${projection.edges.length}/${projection.totalEdges} 条关系`;
  const warning=!receipts.length?'浅绿虚线表示发现完整 flag 候选及其已记录上游，仍待校验；并不等于成功。'
    : projection.disconnected.length?`${projection.disconnected.join('、')} 无法沿已记录关系追溯到 origin；保留断点，不补造成功线。`
    : '从左向右读：事实依据 → 推断/行动 → 新事实。深绿实线保留通过回执的全部已记录上游，不再只选最短路径；同一方向的产出并列，不补造它们之间的因果线。';
  $('#reason-note').textContent=(grouped?'排版按明确产出归组：推断列从顶部起排，产出尽量同高；共享事实列拥挤时仅事实下排避让，组内按编号排列。':'排版按列编号阅读，仍显示明确产出来源。')+warning+` 结果仅属 ${graph.project.id}；已收敛不等于成功；回执仅为本项目记录文本，本页没有重新校验。`;
  $('#reason-expand').hidden=projection.nodes.length===projection.totalNodes;
  $('#reason-expand').textContent=projection.mode==='success'?'展开其余方向产出':'显示全部旁支';
  $('#reason-counts').textContent=`${graph.facts.length} 事实 / ${graph.intents.length} 推断方向 / ${receipts.length} 通过回执`;
  svg.textContent=''; svg.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
  svg.dataset.mode=projection.mode;
  svg.dataset.width=layout.width;svg.dataset.height=layout.height;
  svg.dataset.lastNodeTop=layout.nodes.reduce((top,n)=>Math.max(top,n.y),0);
  svg.dataset.tailCenter=Math.max(0,...layout.nodes.map(n=>n.x+n.w/2));
  renderReasonResults(groups,graph);
  const defs=el('defs',{},svg);
  for(const [id,color] of [['fact','var(--blue)'],['intent','var(--violet)'],['success','var(--green)'],['flag-found','var(--green)'],['flag-confirmed','var(--green)'],['cycle','var(--fg3)'],['merge','var(--amber)']]) {
    const marker=el('marker',{id:'reason-arrow-'+id,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto'},defs);
    el('path',{d:'M0 0L10 5L0 10Z',fill:color},marker);
  }
  const groupLayer=el('g',{id:'reason-output-groups'},svg);
  for(const output of layout.outputGroups){
    const band=el('g',{'data-producer':output.producerId,class:'reason-output-group'},groupLayer);
    el('rect',{x:output.x,y:output.y,width:output.w,height:output.h,rx:10,class:'reason-output-box'},band);
    const label=el('text',{x:output.x+12,y:output.y+15,class:'reason-output-label'},band);
    label.textContent=output.producerId+' 的产出'+(output.aligned===false?' · 下排避让':'')+' · 当前 '+output.factKeys.length+' 条事实';
  }
  const edgeGroup=el('g',{id:'reason-edges'},svg),nodeGroup=el('g',{id:'reason-nodes'},svg);
  layout.edges.forEach(edge=>{
    const group=el('g',{'data-relation':TreeModel.edgeKey(edge),class:'reason-relation'+(edge.success?' success':'')+(edge.flagState?' flag-'+edge.flagState:'')},edgeGroup);
    const d=edge.points.map((p,n)=>(n?'L':'M')+p.join(' ')).join(' ');
    const type=edge.type==='merge'?'merge':edge.flagState?'flag-'+edge.flagState:edge.feedback?'cycle':edge.type==='trigger'?'intent':'fact';
    const path=el('path',{d,class:'reason-edge'+(edge.success?' success':'')+(edge.flagState?' flag-'+edge.flagState:'')+(edge.feedback?' feedback':''),
      'data-edge':edge.type,'data-from':edge.from,'data-to':edge.to,'data-flag-state':edge.flagState,'marker-end':`url(#reason-arrow-${type})`},group);
    const tip=el('title',{},path);tip.textContent=`${edge.from} → ${edge.to} · ${{trigger:'依据（触发）',produce:'产出事实',converge:'收敛引用（不等于成功）',merge:edge.legacy_text?'合并（历史文本关系，非验证结果）':'合并关系（非验证结果）'}[edge.type]}${edge.feedback?' · 环内/回引':''}${edge.flagState==='confirmed'?' · 通向通过回执的已记录关系':edge.flagState==='found'?' · flag候选上游，待校验':''}`;
    if(!edge.outer || edge.success || edge.type==='merge') {
      const text=el('text',{x:edge.labelX,y:edge.labelY,class:'reason-edge-label'+(edge.outer?' outer-label':''),'text-anchor':'middle'},group);
      text.textContent={trigger:'依据',produce:'产出',converge:'收敛',merge:edge.legacy_text?'合并 · 历史文本':'合并'}[edge.type];
    }
  });
  layout.nodes.forEach((node,nodeIndex)=>{
    const data=node.data,accepted=node.kind==='fact'&&data.evidence_status==='accepted_receipt';
    // A long record can contain a local negative result AND a useful positive fact.
    // Do not paint the whole record as a failed branch merely for containing negation.
    const failed=node.kind==='fact'&&data.evidence_status==='rejected';
    const candidate=node.kind==='fact'&&data.evidence_status==='candidate';
    const tooling=node.kind==='fact'&&data.tooling_info;
    const group=el('g',{class:'reason-node '+node.kind+(node.success?' success':'')+(accepted?' accepted':'')+(failed?' failed':'')+(candidate?' candidate':'')+(tooling?' tooling-info':'')+(node.flagState?' flag-'+node.flagState:'')+(node.flagTarget?' flag-target':'')+(node.flagBlockedState?' flag-blocked':''),
      'data-key':node.key,'data-kind':node.kind,'data-flag-state':node.flagState,'data-flag-blocked':node.flagBlockedState,'data-id':data.id,'data-producer':node.producerId,'data-output-count':node.outputCount,transform:`translate(${node.x},${node.y})`},nodeGroup);
    if(node.kind==='intent') {
      el('path',{d:`M14 0H${node.w-14}L${node.w} 20V${node.h-20}L${node.w-14} ${node.h}H14L0 ${node.h-20}V20Z`,class:'reason-box'},group);
    } else el('rect',{x:0,y:0,width:node.w,height:node.h,rx:8,class:'reason-box'},group);
    const title=el('text',{x:14,y:19,class:'reason-node-id'},group);
    title.textContent=(node.kind==='intent'?'推断 / 行动 · ':'事实 · ')+data.id;
    const badge=el('text',{x:node.w-13,y:19,'text-anchor':'end',class:'reason-node-badge'},group);
    if(node.kind==='intent'){
      badge.dataset.liveBadge=data.id;
      el('circle',{cx:node.w-5,cy:-3,r:5,class:'reason-live-dot'},group);
      el('path',{d:`M14 ${node.h-47}H${node.w-14}`,class:'verification-rail'},group);
      const current=el('text',{x:14,y:node.h-11,class:'reason-current-time'},group);current.textContent='此次验证：等待执行记录';
      if((data.merged_into||[]).length||data.merge_target_unknown){
        const merge=el('text',{x:14,y:node.h-58,class:'reason-merge-meta'},group);
        merge.textContent=(data.merged_into||[]).length?'已并入 → '+data.merged_into.join('、'):'已合并 · 去向未记录';
      }
    }
    const progress=accepted&&(data.description||'').match(/进度\s*(\d+\s*\/\s*\d+)/);
    badge.textContent=node.flagBlockedState==='conflicting_receipts'?'回执冲突 · 未确认':node.flagBlockedState==='rejected'?'已拒收':tooling?'工具说明 · 非目标证据':accepted?'通过'+(progress?' · '+progress[1]:'（文本）'):data.evidence_status==='test_record'?'自测/占位 · 不计成功':node.kind==='intent'?(data.open?'未收敛':'已收敛')
      :data.id==='origin'?'题目起点':data.id==='goal'?'目标（非结果）':data.evidence_status==='candidate'?(node.flagTarget?(node.flagState==='confirmed'?'flag值已确认':'发现flag · 待校验'):'候选 · 未核验'):failed?'拒收回执':data.evidence_status==='negated'?'含否定语句':'';
    const text=(data.description||'(空描述)').replace(/\s+/g,' ').replace(/^bootstrap$/,'启动探索（bootstrap）');
    const score=accepted&&(data.description||'').match(/得分\s*(\d+)/);
    const excerpt=accepted&&!node.flagBlockedState?`平台回执：flag 校验通过。${progress?' 本题进度 '+progress[1]+'。':''}${score?' 得分 '+score[1]+'。':''} 点击查看回执原文。`:text;
    const preview=excerpt.slice(0,900),wrapped=wrapText(preview,node.w-28,12.5,400,3);
    if(excerpt.length>preview.length)wrapped.hasMore=true;
    const clip=el('clipPath',{id:'reason-text-'+nodeIndex},defs);
    el('rect',{x:13,y:24,width:node.w-26,height:54},clip);
    const description=el('g',{'clip-path':`url(#reason-text-${nodeIndex})`},group);
    wrapped.lines.forEach((line,n)=>{ const t=el('text',{x:14,y:39+n*16,class:'reason-node-description'},description);t.textContent=line+(wrapped.hasMore&&n===wrapped.lines.length-1?'…':''); });
    const metadata=el('text',{x:14,y:node.kind==='intent'?node.h-27:node.h-9,class:'reason-node-meta'},group);
    metadata.textContent=node.cycle?'存在环内引用 · 不是严格单向树':node.omitted?`另 ${node.omitted} 条关系 · 可展开完整依据`
      :node.kind==='fact'?TreeModel.provenanceLabel(data):'推断与执行方向 · 点击看依据和原文';
    if(node.kind==='intent')metadata.classList.add('reason-live-meta');
    if(node.kind==='fact'&&!['origin','goal'].includes(data.id)){
      const origin=el('text',{x:14,y:node.h-28,class:'reason-producer-label'},group);
      origin.textContent=node.producerId?'产出自 '+node.producerId+' · '+node.outputIndex+'/'+node.outputCount
        :node.producerIds?.length?'多个产出来源 · 未指定唯一归属':'无明确产出来源 · 独立保留';
      const originTip=el('title',{},origin);originTip.textContent=node.producerIds?.length?'明确产出边：'+node.producerIds.join('、'):'不根据位置、时间或收敛引用猜测产生关系';
    }else if(node.kind==='intent'&&node.outputCount){
      const count=el('text',{x:14,y:node.h-58,class:'reason-output-count'},group);
      count.textContent=(data.merged_into||[]).length||data.merge_target_unknown?'':'当前显示 '+node.outputCount+' 条产出事实';
    }
    const tip=el('title',{},group);tip.textContent=text;
    bindNode(group,node.kind,data.id);
  });
  $('#reason-diagnostic').textContent=JSON.stringify({ready:true,nodes:layout.nodes.length,edges:layout.edges.length,
    totalNodes:projection.totalNodes,totalEdges:projection.totalEdges,cycles:layout.cycles,
    duplicates:layout.nodes.length-new Set(layout.nodes.map(n=>n.key)).size,
    disconnected:projection.disconnected,mode:projection.mode,direction:layout.direction,
    groups:groups.length,outputGroups:layout.outputGroups.length,grouped:layout.grouped,confirmedGroups:groups.filter(g=>g.status==='accepted_receipt').length});
  state.reasonRenderSignature=JSON.stringify([reasoningContentKey(graph),state.reasonMode,state.reasonReceipt,!!state.showToolInfo,state.groupOutputs!==false,state.traceMode,state.traceMode?state.selected:null]);
  svg.dataset.fullBuilds=String((Number(svg.dataset.fullBuilds)||0)+1);
  renderReasonMap(layout);highlightReasoning();zoomReasoning();
  syncExecutionVisuals();
  const scope=[graph.project.id,projection.mode,state.reasonReceipt,svg.dataset.traceKey].join('|');
  if(svg.dataset.scope!==scope){svg.dataset.scope=scope;requestAnimationFrame(()=>focusReasonNode(state.reasonReceipt==='all'?'fact:origin':'fact:'+state.reasonReceipt));}
}

function reasonViewportWidth(){
  const canvas=$('#reason-canvas'),side=$('#side');
  if(!canvas)return 0;
  const c=canvas.getBoundingClientRect();
  if(!side||side.classList.contains('hide'))return canvas.clientWidth;
  const s=side.getBoundingClientRect();
  const overlaps=s.bottom>c.top&&s.top<c.bottom&&s.right>c.left&&s.left<c.right;
  return overlaps?Math.max(1,Math.min(canvas.clientWidth,s.left-c.left)):canvas.clientWidth;
}

function zoomReasoning() {
  const svg=$('#reason-tree'),canvas=$('#reason-canvas'); if(!svg||!canvas||!svg.dataset.width)return;
  const fitWidth=Math.min(1,(reasonViewportWidth()-24)/Number(svg.dataset.width));
  const fitHeight=(canvas.clientHeight-24)/Number(svg.dataset.height);
  // Default is readable horizontal exploration, never shrink a 50-node graph to dust.
  const scale=state.reasonZoom==='auto'?Math.max(.8,fitWidth)
    :state.reasonZoom==='fit'?Math.max(.03,Math.min(fitWidth,fitHeight)):Number(state.reasonZoom||1);
  const width=Number(svg.dataset.width)*scale,height=Number(svg.dataset.height)*scale;
  const tail=Number(svg.dataset.tailCenter)||Number(svg.dataset.width);
  const rightPadding=Math.max(0,canvas.clientWidth-reasonViewportWidth()/2-(Number(svg.dataset.width)-tail)*scale);
  const surface=$('#reason-surface');
  svg.style.width=width+'px';svg.style.height=height+'px';
  const bottomPadding=Math.max(0,canvas.clientHeight-16-(Number(svg.dataset.height)-(Number(svg.dataset.lastNodeTop)||0))*scale);
  surface.style.width=Math.max(canvas.clientWidth,width+rightPadding)+'px';surface.style.minHeight=Math.max(canvas.clientHeight,height+bottomPadding)+'px';
  svg.dataset.bottomPadding=bottomPadding;
  svg.dataset.rightPadding=rightPadding;svg.dataset.scale=scale;
  const map=$('#reason-map');map.setAttribute('viewBox',`0 0 ${Number(svg.dataset.width)+rightPadding/scale} ${Number(svg.dataset.height)+bottomPadding/scale}`);
  $('#reason-zoom-status').textContent=Math.round(scale*100)+'% · 末端留白，可居中精读';
  requestAnimationFrame(updateReasonMap);
}

function renderReasonResults(groups,graph) {
  const box=$('#reason-results');box.textContent='';
  const accepted=groups.filter(g=>g.status==='accepted_receipt').length;
  $('#reason-evidence-status').textContent=groups.length
    ?`${groups.length} 个完整候选值 · ${accepted} 个有独立通过回执 · ${groups.length-accepted} 个未获通过确认${graph.facts.some(f=>f.evidence_status==='rejected')?' · 另有拒收记录（不连坐同方向其他候选）':''}`
    :'本项目暂无可核对的完整候选值';
  const tests=graph.facts.filter(f=>f.evidence_status==='test_record').length;
  if(tests)$('#reason-evidence-status').textContent+=` · ${tests} 条自测/占位记录已排除，不计成功`;
  for(const group of groups){
    const labelText={accepted_receipt:'有通过回执',rejected:'有拒收回执',conflicting_receipts:'回执有冲突',candidate:'缺通过回执'}[group.status];
    const button=document.createElement('button');button.className='reason-result '+(group.status==='accepted_receipt'?'accepted':group.status==='candidate'?'found':'pending');
    button.dataset.resultId=group.target.id;
    button.setAttribute('aria-label',`结果 ${group.number}，${labelText}，查看路径`);
    const label=document.createElement('strong');label.textContent=`结果 ${group.number} · ${labelText} · ${graph.project.id}`;
    const detail=document.createElement('span');detail.textContent=`候选 ${group.candidates.map(f=>f.id).join(' / ')||'无单独记录'}${group.receipts.length?'；同值回执 '+group.receipts.map(f=>f.id).join(' / '):' · 不自动判成功'}`;
    const value=document.createElement('code');value.className='reason-flag-value';value.textContent=group.literal;
    button.append(label,value,detail);button.title=group.literal;
    button.addEventListener('click',()=>{
      state.reasonReceipt=group.target.id;state.reasonMode='success';state.traceMode=null;state.selected=null;
      $('#side').classList.add('hide');renderReasoning();requestAnimationFrame(()=>focusReasonNode('fact:'+group.target.id));
    });
    box.appendChild(button);
  }
}

function renderReasonMap(layout){
  const map=$('#reason-map');map.textContent='';map.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);map.setAttribute('preserveAspectRatio','none');
  for(const edge of layout.edges)el('path',{d:edge.points.map((p,n)=>(n?'L':'M')+p.join(' ')).join(' '),class:'reason-map-edge'+(edge.flagState?' flag-'+edge.flagState:'')+(edge.type==='merge'?' merge':'')},map);
  for(const node of layout.nodes)el('rect',{x:node.x,y:node.y,width:node.w,height:node.h,rx:9,
    class:'reason-map-node '+node.kind+(node.flagState?' flag-'+node.flagState:'')+(node.flagBlockedState?' flag-blocked':'')},map);
  el('rect',{id:'reason-map-window',x:0,y:0,width:1,height:1,fill:'none'},map);
}

function updateReasonMap(){
  const canvas=$('#reason-canvas'),svg=$('#reason-tree'),rect=$('#reason-map-window');if(!rect||!svg.dataset.scale)return;
  const c=canvas.getBoundingClientRect(),s=svg.getBoundingClientRect(),scale=Number(svg.dataset.scale);
  const x=Math.max(0,(c.left-s.left)/scale),y=Math.max(0,(c.top-s.top)/scale);
  rect.setAttribute('x',x);rect.setAttribute('y',y);
  rect.setAttribute('width',Math.max(0,Math.min(Number(svg.dataset.width)+(Number(svg.dataset.rightPadding)||0)/scale-x,reasonViewportWidth()/scale)));
  rect.setAttribute('height',Math.max(0,Math.min(Number(svg.dataset.height)+(Number(svg.dataset.bottomPadding)||0)/scale-y,canvas.clientHeight/scale)));
}

function focusReasonNode(key){
  const node=[...document.querySelectorAll('#reason-nodes .reason-node')].find(n=>n.dataset.key===key);
  if(!node)return;
  const canvas=$('#reason-canvas'),r=(node.querySelector?.('.reason-box')||node).getBoundingClientRect(),c=canvas.getBoundingClientRect();
  canvas.scrollLeft+=r.left-c.left-(reasonViewportWidth()-r.width)/2;
  // Horizontal centring remains; vertically pin the focused card near the top.
  canvas.scrollTop+=r.top-c.top-16;
  updateReasonMap();
}

function highlightReasoning() {
  if(!state.data)return;
  const expected=state.traceMode&&state.selected&&state.view==='reasoning'
    ? state.selected.kind+':'+state.selected.id+':'+state.traceMode : '';
  if(($('#reason-tree').dataset.traceKey||'')!==expected) { renderReasoning();return; }
  const highlightKey=JSON.stringify([state.data.project.id,state.selected,state.traceMode,state.query,$('#reason-tree').dataset.fullBuilds]);
  if(state.reasonHighlightSignature===highlightKey)return;
  state.reasonHighlightSignature=highlightKey;
  const selection=state.selected,key=selection&&selection.kind+':'+selection.id;
  let related=null,edgeKeys=null;
  if(selection) {
    if(state.traceMode) {
      const trace=TreeModel.traceGraph(state.data,selection.kind,selection.id,state.traceMode);
      related=new Set(trace.nodes);edgeKeys=new Set(trace.edges.map(TreeModel.edgeKey));
    } else {
      related=new Set([key]);edgeKeys=new Set();
      for(const edge of state.data.edges) if(ReasoningModel.endpoints(edge).includes(key)) {
        ReasoningModel.endpoints(edge).forEach(k=>related.add(k));edgeKeys.add(TreeModel.edgeKey(edge));
      }
    }
  }
  document.querySelectorAll('#reason-nodes .reason-node').forEach(node=>{
    node.classList.toggle('selected',node.dataset.key===key);
    node.classList.toggle('unrelated',!!related&&!related.has(node.dataset.key));
    node.classList.toggle('search-miss',!!state.query&&!((node.dataset.kind==='fact'?FACTS[node.dataset.id]:INTENTS[node.dataset.id])?.description||'').toLowerCase().includes(state.query.toLowerCase())&&!node.dataset.id.includes(state.query));
  });
  document.querySelectorAll('#reason-edges .reason-relation').forEach(node=>{
    node.classList.toggle('unrelated',!!edgeKeys&&!edgeKeys.has(node.dataset.relation));
    node.classList.toggle('selected',!!edgeKeys&&edgeKeys.has(node.dataset.relation));
  });
}
