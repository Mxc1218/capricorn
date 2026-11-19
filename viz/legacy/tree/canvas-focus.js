/* Window-sized focus mode. Never requests browser/system fullscreen. */
let canvasFocusFrame=0;
function canvasFocusText(node,text){if(node&&node.textContent!==text)node.textContent=text;}
function canvasFocusAnchor(){
  const canvas=$('#reason-canvas'),scale=Number($('#reason-tree')?.dataset.scale)||1;
  return {x:(canvas.scrollLeft+reasonViewportWidth()/2)/scale,y:canvas.scrollTop/scale};
}
function resizeCanvasFocus(anchor){
  cancelAnimationFrame(canvasFocusFrame);
  canvasFocusFrame=requestAnimationFrame(()=>{
    canvasFocusFrame=0;if(state.view==='reasoning')zoomReasoning();else if(state.view==='graph')applyZoom();
    if(anchor&&state.view==='reasoning'){
      const canvas=$('#reason-canvas'),scale=Number($('#reason-tree').dataset.scale)||1;
      canvas.scrollLeft=anchor.x*scale-reasonViewportWidth()/2;canvas.scrollTop=anchor.y*scale;updateReasonMap();
    }
  });
}
function setCanvasSettings(open){
  const anchor=canvasFocusAnchor();
  state.canvasSettings=!!open&&!!state.canvasFocus;
  document.body.classList.toggle('canvas-settings-open',state.canvasSettings);
  $('#btnCanvasOptions').setAttribute('aria-expanded',String(state.canvasSettings));
  resizeCanvasFocus(anchor);
}
function syncCanvasFocusContext(snapshot){
  if(!state.canvasFocus)return;
  const p=state.data?.project,historical=$('#attempt-scope').classList.contains('historical');
  canvasFocusText($('#canvas-focus-context'),p?(historical?'历史项目 · ':'')+p.id+' · '+p.title:'等待项目数据');
  $('#canvas-focus-context').title=$('#attempt-label').textContent||'';
  const fresh=state.live&&!state.executionDisconnected&&state.lastTreeReceived!=null&&Date.now()-state.lastTreeReceived<10000;
  const status=$('#canvas-focus-status'),s=snapshot||(p?executionSnapshot():null);
  status.dataset.state=!p||!fresh?'unknown':'fresh';
  canvasFocusText(status,!p?'等待数据':!state.live?'实时已暂停':!fresh?'同步未确认':s.activeIds.length+' 条验证中');
  const zoom=$('#canvas-focus-zoom'),search=$('#canvas-focus-search');
  if(zoom.value!==(state.reasonZoom||'auto'))zoom.value=state.reasonZoom||'auto';
  if(search.value!==(state.query||''))search.value=state.query||'';
}
function setCanvasFocus(on){
  on=!!on;if(on===!!state.canvasFocus)return;
  const anchor=state.view==='reasoning'?canvasFocusAnchor():null,side=$('#side');
  if(on){
    state.canvasFocusReturn={view:state.view,sideWasOpen:!side.classList.contains('hide')};
    state.focusSideTouched=false;state.canvasFocus=true;
    document.body.classList.add('canvas-focus');side.classList.add('hide');hideTip();
    $('#btnCanvasFocus').setAttribute('aria-pressed','true');
    setView('reasoning');syncCanvasFocusContext();resizeCanvasFocus(anchor);
    $('#btnCanvasFocusExit').focus({preventScroll:true});
  }else{
    const previous=state.canvasFocusReturn;
    state.canvasFocus=false;state.canvasSettings=false;
    document.body.classList.remove('canvas-focus','canvas-settings-open');
    $('#btnCanvasOptions').setAttribute('aria-expanded','false');$('#btnCanvasFocus').setAttribute('aria-pressed','false');
    setView(previous?.view||'reasoning');
    if(previous?.sideWasOpen&&!state.focusSideTouched&&state.selected){
      const {kind,id}=state.selected;if(kind==='fact'?FACTS[id]:INTENTS[id])showDetail(kind,id);
    }
    resizeCanvasFocus(anchor);state.canvasFocusReturn=null;
    $('#btnCanvasFocus').focus({preventScroll:true});
  }
}
/* ══════════ 设置区收起（非专注态） ══════════
   为什么需要：实测设置区 8 个子块合计 288px，而 #main 只有 391px ——
   推理树被压到 103px，基本看不见。原来只有 canvas-focus 才收得掉设置区，
   于是"想看树就必须进专注模式"。这里给非专注态一个等价开关。
   ★ 隐藏的是 #reason-settings 的**子块**，不是它自己：它是 display:contents，
     对 itself 设 display:none 既藏不住子块，又会破坏后面 canvas 的 flex 上下文。 */
function setSettingsCollapsed(on){
  on=!!on;
  if(on===!!state.settingsCollapsed)return;
  const anchor=state.view==='reasoning'?canvasFocusAnchor():null;
  state.settingsCollapsed=on;
  document.body.classList.toggle('settings-collapsed',on);
  const btn=$('#btnSettingsToggle');
  if(btn){
    btn.setAttribute('aria-pressed',String(on));
    btn.classList.toggle('on',on);
    btn.title=on?'展开推理树的辅助区块（图例 / 说明 / 缩略导航）—— 快捷键 S'
                :'收起推理树的辅助区块（图例 / 说明 / 缩略导航），把纵向空间让给树（快捷键 S）';
  }
  resizeCanvasFocus(anchor);
}
function initCanvasFocus(){
  const mainZoom=$('#reason-zoom'),zoom=$('#canvas-focus-zoom');
  zoom.replaceChildren(...[...mainZoom.options].map(option=>option.cloneNode(true)));
  $('#btnCanvasFocus').addEventListener('click',()=>setCanvasFocus(true));
  $('#btnCanvasFocusExit').addEventListener('click',()=>setCanvasFocus(false));
  $('#btnCanvasOptions').addEventListener('click',()=>setCanvasSettings(!state.canvasSettings));
  const st=$('#btnSettingsToggle');
  if(st)st.addEventListener('click',()=>setSettingsCollapsed(!state.settingsCollapsed));
  /* ★ 把「默认收起」真正落到页面上。
     不能指望 setSettingsCollapsed 自己生效：它有 `if(on===state.x)return` 的早退，
     而默认值已经是 true —— 首次调用会被直接挡掉，body 上永远不会有那个类，
     结果"默认收起"只在 state 里成立、界面根本没变（这类 bug 很难看出来）。
     所以初始化时显式同步一次 DOM。 */
  document.body.classList.toggle('settings-collapsed',!!state.settingsCollapsed);
  if(st){
    st.classList.toggle('on',!!state.settingsCollapsed);
    st.setAttribute('aria-pressed',String(!!state.settingsCollapsed));
  }
  $('#btnFocusLatest').addEventListener('click',()=>$('#reason-latest').click());
  $('#canvas-focus-search').addEventListener('input',event=>{
    state.query=event.target.value;state.dashboardRenderedRevision=null;$('#search').value=state.query;if(state.data)applyFiltering();
  });
  zoom.addEventListener('change',()=>{mainZoom.value=zoom.value;mainZoom.dispatchEvent(new Event('change',{bubbles:true}));});
  $('#btnFocusRefresh').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{await refreshAll(true);}finally{button.disabled=false;syncCanvasFocusContext();}
  });
}
