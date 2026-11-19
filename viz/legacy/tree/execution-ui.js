/* UI is read-only. It observes activity, never claims/releases or validates target evidence. */
const executionLabels={executing:'正在验证',waiting:'待认领',awaiting_heartbeat:'已认领 · 状态待确认',stalled:'验证活动失联',claimed:'已认领 · 状态待确认',paused:'项目已结束',connection_unknown:'连接未确认',closed:'已结束',merged:'已合并'};
let executionReadCache=null;
function executionSnapshot(){
  const connected=state.live&&!state.executionDisconnected&&state.lastTreeReceived!=null&&Date.now()-state.lastTreeReceived<10000;
  const now=nowTs(),bucket=Math.floor(now);
  if(executionReadCache&&executionReadCache.graph===state.data&&executionReadCache.connected===connected&&executionReadCache.bucket===bucket&&executionReadCache.received===state.lastTreeReceived)return executionReadCache.value;
  const raw=LiveExecution.snapshot(state.data,now,connected);
  const clock=ExecutionClock.read(state.data,raw.rows,now,connected);
  const value={...raw,rows:clock.rows,clock,byId:new Map(clock.rows.map(r=>[r.id,r]))};
  executionReadCache={graph:state.data,connected,bucket,received:state.lastTreeReceived,value};return value;
}
function updateText(node,value){if(node&&node.textContent!==value)node.textContent=value;}
/* 等待时间：这个推断方向「从出现到现在」等了多久（墙钟，不含猜测）。
   来源是 LiveExecution.snapshot 已经算好的 spanSeconds：
     project active  → created_at → 现在
     project 已结束  → created_at → summary.last_activity_ts（最后活动）
   ★ 与「此次验证」的区别：
     此次验证 = 本页面**观测到**的验证活动，页面打开前的部分拿不到（可能是 0.0 秒）；
     等待时间 = 方向存在了多久，不依赖页面是否开着，任何时候都有意义。
   ★ 如果「观测到的验证」是 0 而方向已存在很久，那个 0 会误导 —— 这时用等待时间替代。 */
function waitingText(row){
  if(row.spanSeconds==null||!(row.spanSeconds>0))return null;
  return (row.state==='paused'?'在途等待 ':'已等待 ')+fmtDur(row.spanSeconds);
}
function timingText(row){
  const current=(row.currentSource==='recorded'?'此次验证 ':'此次验证（观测） ')+fmtDur(row.currentSeconds);
  const total=(row.timingSource==='recorded'?'累计验证 ':'累计验证（观测） ')+fmtDur(row.cumulativeSeconds);
  const waiting=waitingText(row);
  const observed=(row.currentSeconds||0)>0;
  if(observed)return {current, total, waiting, observed};
  // 没有观测到任何验证活动时，不要报「0.0 秒」——那是个假读数
  // （事实是"本页打开前就已经跑完/没跑"，不是"跑了 0 秒"）。
  if(waiting)return {current:waiting, total, waiting, observed};
  if(row.state==='closed'||row.state==='merged')
    return {current:'已完成 · 本页未观测到活动', total:(row.cumulativeSeconds>0?total:''), waiting, observed};
  return {current:'暂无验证活动记录', total:(row.cumulativeSeconds>0?total:''), waiting, observed};
}
function renderExecutionPanel(before,graph){
  if(!graph||!before||before.project.id!==graph.project.id)state.executionEvents=[];
  else for(const e of LiveExecution.transitions(before,graph)){
    (state.executionEvents||=[]).unshift({...e,observed:graph.generated_at});
    state.executionEvents=state.executionEvents.slice(0,20);
  }
  const list=$('#execution-list'),current=executionSnapshot(),weights={executing:0,awaiting_heartbeat:1,claimed:2,waiting:3,stalled:4,connection_unknown:4,paused:5,merged:6};
  const states=new Map(current.rows.map(r=>[r.id,r.state]));
  const items=graph?graph.intents.filter(i=>i.open).slice().sort((a,b)=>(weights[states.get(a.id)]??5)-(weights[states.get(b.id)]??5)||a.id.localeCompare(b.id,'en',{numeric:true})):[];
  const signature=JSON.stringify([graph?.project.id,...items.map(i=>[i.id,i.worker,i.execution_state,i.description])]);
  if(list.dataset.signature!==signature){list.textContent='';list.dataset.signature=signature;
    for(const it of items){
      const row=document.createElement('button');row.type='button';row.className='execution-row';row.dataset.intentId=it.id;
      const head=document.createElement('strong');head.textContent=it.id+' · '+(it.worker||'尚未认领');
      const status=document.createElement('span');status.className='execution-state';
      const timing=document.createElement('span');timing.className='execution-timing';
      row.title=it.description||'';row.append(head,status,timing);
      row.addEventListener('click',()=>{
        setView('reasoning');focusReasonNode('intent:'+it.id);$('#reason-canvas').scrollIntoView({block:'nearest'});selectNode('intent',it.id);
      });list.appendChild(row);
    }
  }
  const events=$('#execution-events');events.textContent='';
  for(const e of state.executionEvents||[]){
    const li=document.createElement('li');li.textContent=`${fmtTime(e.observed)} · ${e.id} · ${{claimed:'观测到认领',released:'观测到释放',concluded:'观测到收敛',state_changed:'状态变化'}[e.type]} · ${e.worker||'无认领方'}`;events.appendChild(li);
  }
  $('#execution-event-count').textContent=String((state.executionEvents||[]).length);
  $('#btnFocusExecuting').onclick=()=>{
    const id=executionSnapshot().activeIds[0];if(!id)return;
    setView('reasoning');focusReasonNode('intent:'+id);$('#reason-canvas').scrollIntoView({block:'nearest'});
  };
  const links=$('#execution-projects');links.textContent='';
  for(const p of state.projects.filter(p=>p.status==='active'&&p.id!==graph?.project.id)){
    const button=document.createElement('button');button.textContent='运行中 '+p.id;button.title=p.title;button.onclick=()=>selectProject(p.id);links.appendChild(button);
  }
  syncExecutionVisuals();
}
function syncExecutionVisuals(snapshot){
  const s=snapshot||executionSnapshot(),active=new Set(s.activeIds),rows=s.byId;
  const paused=!state.live||state.executionDisconnected||s.rows.some(r=>r.state==='connection_unknown');
  $('#btnFocusExecuting').disabled=active.size===0;
  $('#execution-summary').textContent=!state.data?'等待项目数据':`${state.data.project.id} · ${s.activeIds.length} 条推断正在验证 · ${s.rows.filter(r=>r.state==='waiting').length} 待认领${paused?' · 同步未确认，活动轨道已停止':''}`;
  const openRows=s.rows.filter(r=>r.state!=='closed');
  $('#execution-empty').hidden=openRows.length>0;
  $('#execution-empty').textContent=!state.data?'等待项目数据':state.data.project.status==='active'?'本项目暂无未收敛方向。':'本项目已结束，累计读数保留，不显示执行动画。';
  const chips=document.querySelectorAll('#pulse .chip');
  if(chips.length&&state.data)chips[0].textContent=s.activeIds.length+' 验证中';
  for(const element of document.querySelectorAll('#execution-list .execution-row')){
    const r=rows.get(element.dataset.intentId);if(!r)continue;
    element.dataset.state=r.state;
    updateText(element.querySelector('.execution-state'),executionLabels[r.state]||r.state);
    const text=timingText(r);
    updateText(element.querySelector('.execution-timing'),[text.current,text.total].filter(Boolean).join(' · '));
    element.querySelector('.execution-timing').title='心跳诊断：'+(r.heartbeatAge==null?'未知':fmtDur(r.heartbeatAge)+'前')+'。观测值不包含页面打开前或断连期间，不能等同于后台完整累计。';
  }
  // ★ 选择器必须是 'reason-node intent'：reasoning.js 建的节点 class 是
  //   "reason-node intent"，只写 '.intent' 匹配不到任何东西 —— 结果是推断卡左下角
  //   永远停在占位文案「此次验证：等待执行记录」，等待/执行时长根本不会出现。
  //   （同文件其它地方用的都是 '#reason-nodes .reason-node'，这里是笔误。）
  if(state.view==='reasoning')for(const node of document.querySelectorAll('#reason-nodes .reason-node.intent')){
    const r=rows.get(node.dataset.id);node.classList.toggle('verifying',active.has(node.dataset.id));
    node.dataset.liveState=r?.state||'closed';
    const badge=node.querySelector('[data-live-badge]');if(badge&&r)updateText(badge,executionLabels[r.state]||r.state);
    const meta=node.querySelector('.reason-live-meta'),current=node.querySelector('.reason-current-time');
    if(r){
      const text=timingText(r);
      // 累计口径放 meta；主行显示「等待时间」或「此次验证」——
      // 有等待数据时优先显示等待（它任何时候都有意义），并把两者都放进 tooltip。
      updateText(meta,text.waiting?text.waiting:(text.total||''));
      updateText(current,text.current);
      if(current){
        current.title=text.observed
          ? ('此次验证（'+ (r.currentSource==='recorded'?'记录值':'页面观测值') +'）：'+fmtDur(r.currentSeconds)
             + (text.waiting?('　｜　'+text.waiting):'')
             + (text.total?('　｜　'+text.total):''))
          : ((text.waiting?text.waiting+'　｜　':'')
             + '本页未观测到验证活动（打开页面前的活动无法回溯）；上方「归组/依据」仍以库中记录为准。');
      }
    }
  }
  // Flow lives on an execution rail within the intent, never on a fact dependency.
  // Edges are created static; do not scan every dependency on each timer tick.
}
