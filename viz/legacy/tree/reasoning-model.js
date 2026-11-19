/* Actual recorded dependencies, not lane order or a generated narrative. */
(function(root) {
  'use strict';
  const Scope=root.AttemptScope||(typeof require==='function'?require('./attempt-scope.js'):null);
  const edgeKey = edge => JSON.stringify([edge.type, edge.from, edge.to]);
  const endpoints = edge => edge.type === 'merge' ? ['intent:' + edge.from, 'intent:' + edge.to] : edge.type === 'trigger'
    ? ['fact:' + edge.from, 'intent:' + edge.to] : ['intent:' + edge.from, 'fact:' + edge.to];

  function indexGraph(graph) {
    const nodes = new Map();
    for (const f of graph.facts || []) if((!graph.project?.id||Scope.isCurrentFact(f,graph.project.id))&&!(graph.ui_hide_tooling!==false&&f.tooling_info))nodes.set('fact:' + f.id, {key:'fact:' + f.id, kind:'fact', data:f});
    for (const i of graph.intents || []) if(!graph.project?.id||Scope.isCurrentFact(i,graph.project.id))nodes.set('intent:' + i.id, {key:'intent:' + i.id, kind:'intent', data:i});
    const unique = new Map();
    for (const e of graph.edges || []) {
      if (!['trigger','produce','converge','merge'].includes(e.type)) continue;
      const [a,b] = endpoints(e);
      if (nodes.has(a) && nodes.has(b)) unique.set(edgeKey(e),e);
    }
    const edges = [...unique.values()], incoming = new Map(), outgoing = new Map();
    for (const key of nodes.keys()) { incoming.set(key,[]); outgoing.set(key,[]); }
    for (const e of edges) {
      const [a,b] = endpoints(e); outgoing.get(a).push(e); incoming.get(b).push(e);
    }
    // Stable BFS choices: actual production preferred to a re-used convergence reference.
    for (const rows of outgoing.values()) rows.sort((a,b) =>
      (a.type === 'converge') - (b.type === 'converge') || endpoints(a)[1].localeCompare(endpoints(b)[1]));
    return {nodes,edges,incoming,outgoing};
  }

  function resultGroups(graph) {
    const groups=new Map();
    for(const fact of graph.facts||[]) {
      if((graph.project?.id&&!Scope.isCurrentFact(fact,graph.project.id))||fact.evidence_status==='test_record'||Scope.isTestReceipt(fact))continue;
      if(['origin','goal'].includes(fact.id)||fact.tooling_info)continue;
      for(const raw of fact.flags||[]) {
        const literal=String(raw).replace(/\s+/g,'');
        if(Scope.isSyntheticFlag(literal))continue;
        // Truncated quotations such as flag{2f9ca153-...} are not new results.
        if(/\.{2,}|…|<|>|placeholder/i.test(literal))continue;
        if(!groups.has(literal))groups.set(literal,{literal,mentions:[],candidates:[],receipts:[],rejections:[]});
        const group=groups.get(literal);group.mentions.push(fact);
        if(fact.evidence_status==='candidate')group.candidates.push(fact);
        if(fact.evidence_status==='accepted_receipt')group.receipts.push(fact);
        if(fact.evidence_status==='rejected')group.rejections.push(fact);
      }
    }
    return [...groups.values()].filter(g=>g.candidates.length||g.receipts.length).map((g,n)=>{
      const receipt=g.receipts[g.receipts.length-1];
      const first=g.candidates[0]||receipt;
      return {...g,number:n+1,target:receipt||first,first,
        status:receipt&&g.rejections.length?'conflicting_receipts':receipt?'accepted_receipt':g.rejections.length?'rejected':'candidate'};
    });
  }

  function project(graph, mode='success', receipt='all') {
    const index=indexGraph(graph),groups=resultGroups(graph);
    const receipts=[...index.nodes.values()].filter(n=>n.kind==='fact'&&n.data.evidence_status==='accepted_receipt'&&!Scope.isTestReceipt(n.data));
    const terminalFacts=new Map();
    for(const group of groups)terminalFacts.set(group.target.id,group.target);
    // Legacy fixtures/records may have a receipt with no extracted flag literal.
    for(const n of receipts)if(!groups.some(g=>g.receipts.some(f=>f.id===n.data.id)))terminalFacts.set(n.data.id,n.data);
    const targets=[...terminalFacts.values()].filter(f=>receipt==='all'||f.id===receipt).map(f=>index.nodes.get('fact:'+f.id));
    const accepted=targets.filter(n=>n.data.evidence_status==='accepted_receipt');
    function ancestors(seeds) {
      const seen=new Set(seeds),queue=[...seen];
      for(let p=0;p<queue.length;p++)for(const edge of index.incoming.get(queue[p])||[]) {
        if(edge.type==='merge')continue;
        const key=endpoints(edge)[0];if(!seen.has(key)){seen.add(key);queue.push(key);}
      }
      return seen;
    }
    const reachable=new Set(),queue=[];
    if(index.nodes.has('fact:origin')){reachable.add('fact:origin');queue.push('fact:origin');}
    for(let p=0;p<queue.length;p++)for(const edge of index.outgoing.get(queue[p])||[]) {
      if(edge.type==='merge')continue;
      const key=endpoints(edge)[1];if(!reachable.has(key)){reachable.add(key);queue.push(key);}
    }
    const connected=accepted.filter(n=>reachable.has(n.key));
    const successNodes=ancestors(connected.map(n=>n.key));
    const successEdges=new Set(index.edges.filter(e=>e.type!=='merge'&&endpoints(e).every(k=>successNodes.has(k)&&reachable.has(k))).map(edgeKey));
    const disconnected=accepted.filter(n=>!reachable.has(n.key)).map(n=>n.data.id);
    // Green is a visual trail, not an upgrade to evidence_status/successNodes.
    // Rejected/conflicting exact values, templates, negations and foreign projects never seed green.
    const flagTargets=new Set(),confirmedTargets=new Set(),blockedFlagStates=new Map(),representedReceipts=new Set();
    for(const group of groups){
      for(const f of group.receipts)representedReceipts.add(f.id);
      if(group.status==='rejected'||group.status==='conflicting_receipts'){
        for(const f of [...group.candidates,...group.receipts,...group.rejections])blockedFlagStates.set('fact:'+f.id,group.status);
        continue;
      }
      if(receipt!=='all'&&group.target.id!==receipt)continue;
      for(const f of [...group.candidates,...group.receipts])if(index.nodes.has('fact:'+f.id))flagTargets.add('fact:'+f.id);
      if(group.status==='accepted_receipt')for(const f of [...group.candidates,...group.receipts])if(index.nodes.has('fact:'+f.id))confirmedTargets.add('fact:'+f.id);
    }
    // Old accepted records without an extracted literal can still display their recorded trail.
    for(const node of receipts)if(!representedReceipts.has(node.data.id)&&(receipt==='all'||node.data.id===receipt)){
      flagTargets.add(node.key);confirmedTargets.add(node.key);
    }
    const flagNodes=ancestors([...flagTargets]),confirmedFlagNodes=ancestors([...confirmedTargets]);
    const flagEdges=new Set(index.edges.filter(e=>e.type!=='merge'&&endpoints(e).every(k=>flagNodes.has(k))).map(edgeKey));
    const confirmedFlagEdges=new Set(index.edges.filter(e=>e.type!=='merge'&&endpoints(e).every(k=>confirmedFlagNodes.has(k))).map(edgeKey));
    const seeds=new Set(targets.map(n=>n.key));
    const targetKeys=new Set(seeds);
    // Keep the result-producing direction's actual outputs together. In b-01,
    // f107 explains the login, whereas f108/f109 are sibling receipt records.
    // We must not pretend there is a recorded f107 -> f109 causal edge.
    for(const n of targets)for(const e of index.incoming.get(n.key)||[]) {
      if(e.type!=='produce')continue;
      const producer=endpoints(e)[0];
      for(const output of index.outgoing.get(producer)||[])if(output.type==='produce') {
        const key=endpoints(output)[1];
        if(index.nodes.get(key).data.evidence_status==='accepted_receipt'&&!targetKeys.has(key))continue;
        seeds.add(key);
      }
    }
    let visible=ancestors([...seeds]);
    const effectiveMode=receipts.length?mode:'all';
    if(effectiveMode==='ancestors') {
      // Expand the remaining sibling outputs of every supporting direction.
      const expanded=new Set(visible);
      for(const key of visible)if(key.startsWith('intent:'))for(const e of index.outgoing.get(key)||[])if(e.type==='produce')expanded.add(endpoints(e)[1]);
      visible=ancestors([...expanded]);
    } else if(effectiveMode==='all')visible=new Set(index.nodes.keys());
    // Result filters must not hide other concurrent leases awaiting validation.
    if(graph.project?.status==='active'){
      const pending=[];
      for(const n of index.nodes.values())if(n.kind==='intent'&&n.data.open){
        pending.push(n.key);
        for(const e of index.outgoing.get(n.key)||[])if(e.type==='produce')pending.push(endpoints(e)[1]);
      }
      for(const key of ancestors(pending))visible.add(key);
    }
    // Show the explicit merge family without treating merge as evidence of success.
    let expanded=true;
    while(expanded){expanded=false;for(const e of index.edges)if(e.type==='merge'){
      const [a,b]=endpoints(e);if(visible.has(a)||visible.has(b))for(const key of [a,b])if(!visible.has(key)){visible.add(key);expanded=true;}
    }}
    const includedEdges=index.edges.filter(e=>endpoints(e).every(k=>visible.has(k)));
    const incident=new Map(),visibleIncident=new Map();
    for(const e of index.edges)for(const k of endpoints(e))incident.set(k,(incident.get(k)||0)+1);
    for(const e of includedEdges)for(const k of endpoints(e))visibleIncident.set(k,(visibleIncident.get(k)||0)+1);
    const nodes=[...visible].map(k=>({...index.nodes.get(k),success:successNodes.has(k)&&reachable.has(k),
      flagState:confirmedFlagNodes.has(k)?'confirmed':flagNodes.has(k)?'found':null,
      flagTarget:flagTargets.has(k),flagBlockedState:blockedFlagStates.get(k)||null,
      omitted:(incident.get(k)||0)-(visibleIncident.get(k)||0)}));
    return {nodes,edges:includedEdges,successNodes,successEdges,flagNodes,flagEdges,confirmedFlagNodes,confirmedFlagEdges,flagTargets,receipts,targets,disconnected,groups,
      mode:effectiveMode,totalNodes:index.nodes.size,totalEdges:index.edges.length};
  }

  function layout(projection, options={}) {
    const keys = projection.nodes.map(n => n.key), keySet = new Set(keys);
    const next = new Map(keys.map(k => [k,[]])), back = new Map(keys.map(k => [k,[]]));
    for (const e of projection.edges) {
      const [a,b] = endpoints(e); if (!keySet.has(a) || !keySet.has(b)) continue;
      next.get(a).push(b); back.get(b).push(a);
    }
    // Iterative Kosaraju: cycles stay visibly cyclic instead of causing an infinite depth.
    const visited = new Set(), order = [];
    for (const start of keys) {
      if (visited.has(start)) continue;
      visited.add(start); const stack = [[start,0]];
      while (stack.length) {
        const frame = stack[stack.length-1], children = next.get(frame[0]);
        if (frame[1] < children.length) {
          const child = children[frame[1]++];
          if (!visited.has(child)) { visited.add(child); stack.push([child,0]); }
        } else { order.push(frame[0]); stack.pop(); }
      }
    }
    const component = new Map(), groups = [];
    for (const start of order.reverse()) {
      if (component.has(start)) continue;
      const id = groups.length, group = [], stack = [start]; component.set(start,id);
      while (stack.length) {
        const key = stack.pop(); group.push(key);
        for (const parent of back.get(key)) if (!component.has(parent)) { component.set(parent,id); stack.push(parent); }
      }
      groups.push(group);
    }
    const children = groups.map(() => new Set()), indegree = groups.map(() => 0), ranks = groups.map(() => 0);
    for (const e of projection.edges) {
      const [a,b] = endpoints(e), ca=component.get(a), cb=component.get(b);
      if (ca !== cb && !children[ca].has(cb)) { children[ca].add(cb); indegree[cb]++; }
    }
    const queue = indegree.map((n,i) => n === 0 ? i : -1).filter(i => i >= 0);
    for (let p=0;p<queue.length;p++) for (const child of children[queue[p]]) {
      ranks[child] = Math.max(ranks[child],ranks[queue[p]]+1);
      if (--indegree[child] === 0) queue.push(child);
    }
    // Split each dependency rank by type, including disconnected nodes and SCCs.
    // Compact empty ranks, but never place facts and intents in the same column.
    const typedRanks=[...new Set(projection.nodes.map(n=>ranks[component.get(n.key)]*2+(n.kind==='intent'?1:0)))].sort((a,b)=>a-b);
    const columns=new Map(typedRanks.map((r,i)=>[r,i])),layers=[];
    for(const node of projection.nodes){
      const dependencyRank=ranks[component.get(node.key)];
      const rank=columns.get(dependencyRank*2+(node.kind==='intent'?1:0));
      (layers[rank]||=[]).push({...node,rank,dependencyRank,cycle:groups[component.get(node.key)].length>1});
    }
    // Within each dependency column, read numeric IDs from top to bottom.
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    const cmpId = (a, b) => {
      const ai = a.data?.id, bi = b.data?.id;
      if (ai != null && bi != null) {
        const as = String(ai), bs = String(bi);
        const c = collator.compare(as, bs);
        if (c) return c;
      } else if (ai != null) return -1;
      else if (bi != null) return 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    };
    const rank = node => node.kind !== 'fact' ? 3 : node.data.id === 'origin' ? 0 : node.data.id === 'goal' ? 2 : 1;
    for (const layer of layers) layer.sort((a, b) => rank(a) - rank(b) || cmpId(a, b));
    // Dependency ranks are columns: the reading direction is always left to right.
    // No wrapping into false extra depths. Wide sibling sets scroll vertically.
    const w=300,h=148,gapX=104,gapY=28,margin=36,gutter=110;
    const width=Math.max(700,layers.length*(w+gapX)-gapX+margin*2);
    const bodyHeight=Math.max(240,...layers.map(layer=>layer.length*(h+gapY)-gapY));
    let height=bodyHeight+gutter+margin*2;
    const nodes=[],byKey=new Map();
    layers.forEach((layer,rank)=>{
      const offset=gutter+margin;
      layer.forEach((node,n)=>{
        const placed={...node,rank,x:margin+rank*(w+gapX),y:offset+n*(h+gapY),w,h};
        nodes.push(placed);byKey.set(node.key,placed);
      });
    });
    const outputGroups=[],producerSets=new Map(),owned=new Map();
    for(const edge of projection.edges){
      if(edge.type==='produce'){
        const fact=byKey.get('fact:'+edge.to),intent=byKey.get('intent:'+edge.from);
        if(!fact||!intent||['origin','goal'].includes(fact.data.id))continue;
        if(!producerSets.has(fact.key))producerSets.set(fact.key,new Set());
        producerSets.get(fact.key).add(intent.key);
      }
    }
    for(const node of nodes)if(node.kind==='fact'){
      const producers=[...(producerSets.get(node.key)||[])].sort((a,b)=>cmpId(byKey.get(a),byKey.get(b)));
      node.producerIds=producers.map(k=>byKey.get(k).data.id);
      // source_intent only disambiguates actual produce edges. A converge edge is not ownership.
      const declared=node.data.source_intent&&'intent:'+node.data.source_intent;
      const owner=producers.length===1?producers[0]:declared&&producers.includes(declared)?declared:null;
      if(owner){node.producerId=byKey.get(owner).data.id;node.ownerKey=owner;if(!owned.has(owner))owned.set(owner,[]);owned.get(owner).push(node);}
    }
    for(const [owner,facts] of owned){
      facts.sort(cmpId);byKey.get(owner).outputCount=facts.length;
      facts.forEach((f,n)=>{f.outputIndex=n+1;f.outputCount=facts.length;});
    }
    if(options.groupOutputs){
      const pitch=h+gapY,groupGap=48,cursors=layers.map(()=>gutter+margin);
      const units=nodes.filter(n=>n.kind==='intent'||!n.ownerKey).slice().sort((a,b)=>a.rank-b.rank||rank(a)-rank(b)||cmpId(a,b));
      for(const unit of units){
        if(unit.kind!=='intent'){unit.y=cursors[unit.rank];cursors[unit.rank]=unit.y+pitch;continue;}
        const facts=owned.get(unit.key)||[],byColumn=new Map();
        for(const fact of facts){if(!byColumn.has(fact.rank))byColumn.set(fact.rank,[]);byColumn.get(fact.rank).push(fact);}
        // Each intent column starts at the same top baseline. Inputs and occupied
        // output columns must never drag a new/single intent down the canvas.
        const top=cursors[unit.rank];let blockHeight=h;
        for(const rows of byColumn.values())blockHeight=Math.max(blockHeight,rows.length*pitch-gapY);
        unit.y=top;
        for(const [column,rows] of byColumn){
          // Preserve ownership and avoid overlap. In a shared output column,
          // only its facts move down; their producer remains top-packed.
          const outputTop=Math.max(top,cursors[column]);
          rows.forEach((fact,n)=>{fact.y=outputTop+n*pitch;fact.groupKey=unit.key;});
          outputGroups.push({key:unit.key+':'+column,producerId:unit.data.id,producerKey:unit.key,factKeys:rows.map(f=>f.key),
            aligned:outputTop===top,producerY:top,
            x:rows[0].x-10,y:outputTop-24,w:w+20,h:rows.length*pitch-gapY+36});
          cursors[column]=outputTop+rows.length*pitch-gapY+groupGap;
        }
        // Reserve the output stack's height below its producer, so the next producer cannot interleave.
        cursors[unit.rank]=Math.max(cursors[unit.rank],top+blockHeight+groupGap);
      }
      height=nodes.reduce((end,n)=>Math.max(end,n.y+n.h),240+gutter+margin)+margin;
    }
    const edges=projection.edges.map((e,n)=>{
      const [a,b]=endpoints(e),source=byKey.get(a),target=byKey.get(b);
      const feedback=component.get(a)===component.get(b)||target.rank<=source.rank;
      const outer=feedback||target.rank>source.rank+1;
      const sx=source.x+source.w,sy=source.y+source.h/2,tx=target.x,ty=target.y+target.h/2;
      const mid=(sx+tx)/2,channel=16+(n%8)*9;
      const points=outer?[[sx,sy],[sx+20,sy],[sx+20,channel],[tx-20,channel],[tx-20,ty],[tx,ty]]
        :[[sx,sy],[mid,sy],[mid,ty],[tx,ty]];
      return {...e,points,feedback,outer,success:projection.successEdges.has(edgeKey(e)),
        flagState:projection.confirmedFlagEdges?.has(edgeKey(e))?'confirmed':projection.flagEdges?.has(edgeKey(e))?'found':null,
        labelX:outer?(sx+tx)/2:mid,labelY:outer?channel-4:(sy+ty)/2-7};
    });
    return {nodes,edges,outputGroups,width,height,direction:'LR',grouped:!!options.groupOutputs,cycles:groups.filter(g=>g.length>1).length};

  }
  const api={indexGraph,project,layout,endpoints,edgeKey,resultGroups};
  root.ReasoningModel=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(globalThis);
