async function loadProjects() {
  const projects = await TreeModel.fetchJSON("/tree/projects");
  if (!Array.isArray(projects)) throw new Error("项目列表格式错误");
  if (!state.data) $("#foot-status").textContent = "服务正常";
  state.projects = projects.map(p => ({ ...p, n_facts: p.fact_count, n_intents: p.intent_count }))
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "") || b.id.localeCompare(a.id));
  renderProjList();
  if(state.data)renderAttemptScope(state.data);
  const facts = projects.reduce((n, p) => n + (p.fact_count || 0), 0);
  const intents = projects.reduce((n, p) => n + (p.intent_count || 0), 0);
  if (!state.data) $("#foot-info").textContent = `全库：项目 ${projects.length} · fact ${facts} · intent ${intents} · 只读展示`;
}

/* ══════════ 左侧项目列表 ══════════
   设计要点（都是用户明确提的）：
     · 竖向铺开 —— 一个项目一行
     · 单项**不要太高** —— 一行搞定：状态点 + id + 截断标题 + 计数，约 20px
     · 显示状态 —— 用颜色点 + 分组标题，不靠读文字
     · 可折叠 —— 按状态分组，每组头可点收起；整个列表可往左收起
   项目很多（170+），所以默认只展开「正在跑」，历史默认收起。 */
const STATUS_LABEL = { active: "进行中", completed: "已完成", stopped: "已停止" };
const STATUS_ORDER = ["active", "completed", "stopped"];

function renderAttemptScope(graph){
  const box=$('#attempt-scope'),label=$('#attempt-label'),button=$('#btnLatestAttempt');
  if(!graph){label.textContent='等待项目与实例标识';button.hidden=true;box.classList.remove('historical');return;}
  const p=graph.project,s=AttemptScope.describe(p,state.projects),status=STATUS_LABEL[s.latest.status]||s.latest.status;
  box.dataset.projectId=p.id;box.dataset.latestId=s.latest.id;box.classList.toggle('historical',!s.is_latest);
  label.textContent=`${s.is_latest?'该题最新项目':'历史项目'} ${p.id} · 创建 ${fmtTime(p.created_at)} · 实例 ${s.instance_label}。`
    +(s.is_latest?'证据仅属此项目；未接入 runner 轮次标识，不据此宣称指定评测轮次成功。':`最新项目 ${s.latest.id}（${status}）· 实例 ${s.latest_instance_label}；${s.relation==='different_instance'?'不同实例，历史结果不计入最新项目。':'项目不同即独立尝试，同地址也不能合并结果。'}`);
  button.hidden=s.is_latest;button.onclick=()=>selectProject(s.latest.id);
}

function renderProjList() {
  const body = document.getElementById("projbar-body");
  const cnt = document.getElementById("projbar-cnt");
  if (!body) return;
  const q = (state.projQuery || "").trim().toLowerCase();
  const all = state.projects || [];
  body.textContent = "";

  const shown = q
    ? all.filter(p => (p.id + " " + (p.title || "")).toLowerCase().indexOf(q) >= 0)
    : all;
  const act = shown.filter(p => p.status === "active").length;
  if (cnt) cnt.textContent = q ? `${shown.length}/${all.length}` : String(all.length);

  if (!shown.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.style.padding = "12px";
    e.textContent = "没有匹配的项目";
    body.appendChild(e);
    return;
  }

  /* 搜索时不分组的展开，直接平铺结果（更好扫） */
  const groups = q
    ? [["__search", "搜索结果", shown]]
    : STATUS_ORDER.map(s => [s, STATUS_LABEL[s] + "（" + shown.filter(p => p.status === s).length + "）",
                             shown.filter(p => p.status === s)]).filter(g => g[2].length);

  groups.forEach(([key, label, items]) => {
    /* 默认展开：正在跑 或 搜索结果；历史默认收起（170+ 个项目全铺开没法看）*/
    const open = q ? true : (state.projOpen[key] !== undefined
      ? state.projOpen[key] : (key === "active"));

    const h = document.createElement("div");
    h.className = "pgroup";
    const arw = document.createElement("span");
    arw.className = "arw";
    arw.textContent = open ? "▾" : "▸";
    const lb = document.createElement("span");
    lb.textContent = label;
    h.appendChild(arw); h.appendChild(lb);
    h.addEventListener("click", () => {
      state.projOpen[key] = !open;
      renderProjList();
    });
    body.appendChild(h);

    if (!open) return;
    items.forEach(p => {
      const d = document.createElement("div");
      d.className = "pitem" + (p.id === state.pid ? " sel" : "") +
        (p.status === "active" ? " active" : "");
      d.setAttribute("data-pid", p.id);
      d.title = `${p.id} · ${p.title}\n状态：${STATUS_LABEL[p.status] || p.status}` +
        `\nfact ${p.n_facts} / 方向 ${p.n_intents}` +
        `\n创建 ${p.created_at || "—"}`;

      const dot = document.createElement("span");
      dot.className = "dot " + p.status;
      const id = document.createElement("span");
      id.className = "pid";
      id.textContent = p.id.replace(/^proj_/, "#");
      const tt = document.createElement("span");
      tt.className = "ptt";
      const scope=AttemptScope.describe(p,all);
      tt.textContent = (scope.is_latest?'最新 · ':'历史 · ')+(p.title || "");
      d.dataset.attemptScope=scope.is_latest?'latest':'historical';
      d.title+=`\n项目范围：${scope.is_latest?'该题最新项目':'历史独立尝试'}\n实例：${scope.instance_label}`;
      const nn = document.createElement("span");
      nn.className = "pn";
      nn.textContent = (p.n_facts || 0) + "f";

      d.appendChild(dot); d.appendChild(id); d.appendChild(tt); d.appendChild(nn);
      d.addEventListener("click", () => selectProject(p.id));
      body.appendChild(d);
    });
  });
}

function selectProject(pid) {
  if (pid === state.pid) return;
  state.pid = pid;
  state.reasonReceipt = "all";
  state.selected = null; state.traceMode = null; state.trace = null;
  state.recentAdded = new Set(); state.data = null;
  renderAttemptScope(null);
  renderExecutionPanel(null,null);
  renderReasoning();
  $("#side").classList.add("hide");
  const metadata = state.projects.find(p => p.id === pid);
  $("#project-context").textContent = pid+' · '+(metadata ? metadata.title : pid) + " · 正在加载";
  $("#pulse").textContent = ""; $("#stats").textContent = ""; $("#timers").textContent = "";
  $("#hint-banner").classList.add("hide"); $("#chainbar").classList.add("hide");
  $("#load-error").hidden = true; $("#banner").classList.add("hide");
  $("#foot-info").textContent = "正在加载项目 " + pid;
  $("#foot-status").textContent = "加载中";
  $("#overview").textContent = "正在加载项目…";
  $("#tree").textContent = ""; $("#reason-tree").textContent = ""; $("#reason-status").textContent = "等待项目数据";
  $("#current-view").textContent = "正在加载项目…";
  $("#update-note").textContent = "正在切换项目…";
  $("#trace-info").hidden = true;
  try {
    const url = new URL(location.href); url.searchParams.set("project", pid);
    url.searchParams.delete("fact"); url.searchParams.delete("intent");
    history.replaceState(null, "", url);
  } catch (e) {}
  renderProjList();
  return loadTree(pid, false).catch(error => { if (pid === state.pid) showLoadError(error); });
}

let treeLoadSequence = 0;
function showLoadError(error) {
  state.executionDisconnected=true;
  ExecutionClock.observe(state.data,[],nowTs(),false);
  syncExecutionVisuals();
  jlog("数据加载失败：" + (error.message || error));
  const banner = $("#load-error"); banner.hidden = false;
  banner.textContent = "连接异常，当前展示可能已过期：" + (error.message || error);
  $("#foot-status").textContent = "连接异常 · 将自动重试";
}

async function loadTree(pid, silent) {
  if (!pid || pid !== state.pid) return;
  const sequence = ++treeLoadSequence;
  const stage = $("#stage"), keepScroll = {l:stage.scrollLeft,t:stage.scrollTop};
  let data;
  try { data = await TreeModel.fetchJSON("/projects/" + encodeURIComponent(pid) + "/tree"); }
  catch (error) { if (sequence !== treeLoadSequence || pid !== state.pid) return; throw error; }
  if (sequence !== treeLoadSequence || pid !== state.pid) return;
  if (data.project.id !== pid) throw new Error("服务端返回了不匹配的项目");
  if([...data.facts,...data.intents].some(f=>!AttemptScope.isCurrentFact(f,pid)))throw new Error('发现跨项目记录，已拒绝展示，避免历史结果混入');
  data = ViewerSemantics.decorate(data);
  const previous = state.data;
  state.executionDisconnected=false;state.lastTreeReceived=Date.now();
  const delta = TreeModel.diffGraphs(previous, data);
  if (delta.newFacts.length) { state.recentAdded = new Set(delta.newFacts); state.recentUntil = Date.now() + 15000; }
  if (previous && previous.project.id === pid && delta.changed) {
    $("#update-note").textContent = TreeModel.diffLabel(delta);
    $("#update-note").classList.add("changed");
  } else if (!previous) {
    $("#update-note").textContent = "当前快照已加载 · 后续变更会在这里提示";
    $("#update-note").classList.remove("changed");
  }
  const selected = state.selected;
  const sideWasOpen = !$("#side").classList.contains("hide");
  const detailScroll = $("#side-body").scrollTop;
  state.data = data; state.dataRevision=(state.dataRevision||0)+1; setClock(data.server_now_ts);
  // Node lookups are data, not a side effect of drawing the hidden lane view.
  FACTS=Object.fromEntries(data.facts.map(f=>[f.id,f]));
  INTENTS=Object.fromEntries(data.intents.map(i=>[i.id,i]));
  const rawExecution=LiveExecution.snapshot(data,nowTs(),state.live);
  ExecutionClock.observe(data,rawExecution.rows,nowTs(),state.live);
  $("#load-error").hidden = true;
  $("#foot-status").textContent = "服务正常";
  $("#project-context").textContent = pid+' · '+data.project.title + " · " + (STATUS_LABEL[data.project.status] || data.project.status)+'（项目记录状态）';
  renderAttemptScope(data);
  const timestamps = [...data.facts, ...data.intents].map(n => n.ts).filter(t => t != null);
  _allTsCache = timestamps.length ? [Math.min(...timestamps), Math.max(...timestamps)] : null;
  renderStats(data); renderTimers(data); renderHints(data);
  if(!previous||previous.project.id!==data.project.id)loadPins();
  // Draw only the active view, once. Reasoning handles unchanged-content reuse.
  setView(state.view);
  renderExecutionPanel(previous,data);
  if (selected && (selected.kind === "fact" ? FACTS[selected.id] : INTENTS[selected.id])) {
    state.selected = selected;
    if (sideWasOpen) { showDetail(selected.kind, selected.id); $("#side-body").scrollTop = detailScroll; }
    highlightEdges();
  } else {
    state.selected = null; state.traceMode = null;
    $("#side").classList.add("hide"); highlightEdges();
  }
  if (silent) { stage.scrollLeft = keepScroll.l; stage.scrollTop = keepScroll.t; }
  const wantFact = urlParam("fact"), wantIntent = urlParam("intent");
  if (!previous && wantFact && FACTS[wantFact]) selectNode("fact", wantFact);
  else if (!previous && wantIntent && INTENTS[wantIntent]) selectNode("intent", wantIntent);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("#foot-info").textContent = `项目 ${pid} · 快照 ${fmtTime(data.generated_at)}（${timezone}）· 服务端数据 · 只读展示`;
}

function renderStats(graph) {
  const summary = graph.summary;
  const primary = $("#pulse"), all = $("#stats"); primary.textContent = ""; all.textContent = "";
  function chip(parent, label, count, cls) {
    const item = document.createElement("span"); item.className = "chip " + (cls || "");
    item.textContent = count + " " + label; parent.appendChild(item);
  }
  chip(primary,"执行中",summary.executing_intents,"green");
  chip(primary,"待认领",summary.waiting_intents);
  const anomalies = summary.stale_intents + summary.awaiting_heartbeat_intents + summary.dangling_references;
  chip(primary,"异常/待确认",anomalies,anomalies ? "amber" : "");
  chip(primary,"本项目通过回执（文本）",summary.accepted_receipts,"green");
  for (const [label,key] of [["事实","facts"],["方向","intents"],["未收敛","open_intents"],
    ["已收敛","concluded_intents"],["候选 flag","candidate_flag_facts"],["拒收/否决","rejected_facts"],
    ["心跳超时","stale_intents"],["等待心跳","awaiting_heartbeat_intents"],["来源缺失","missing_source_facts"],
    ["触发边","edges_trigger"],["产出边","edges_produce"],["收敛边","edges_converge"],["措辞红线","hardening_facts"]]) {
    chip(all,label,summary[key] || 0);
  }
}

/* ══════════════════════ 计时器 ══════════════════════ */
/* 结构建一次，之后只改 .vl 的文本（避免每秒重建 DOM 影响选中态/滚动）*/
function renderTimers(graph) {
  const box = $("#timers"); box.textContent = "";
  const summary = graph.summary;
  /* ★ 项目总用时（墙钟跨度）是这一栏最重要的读数 —— 它回答"这个项目一共花了多久"。
     所以放在最前面并做成主读数（.hero，字号更大、金色强调）；
     另外两个是口径更窄的次级指标（本次运行 = 页面观测到的活动；推断运行总时间 = 各方向并发求和），
     放后面、字号降一级，避免和总用时抢注意力。
     数据来源不变：project_span_s（项目已停止时止于最后活动；active 时按 now-created 走秒）。 */
  for (const [key,label] of [["total","项目总用时"],["run","本次运行"],["sum","推断运行总时间"]]) {
    const item = document.createElement("div"); item.className = "tmr stopped"; item.dataset.tmr = key;
    if (key === "total") item.classList.add("hero");
    const text = document.createElement("span"); text.className = "lb"; text.textContent = label;
    const value = document.createElement("span"); value.className = "vl";
    const extra = document.createElement("span"); extra.className = "ex";
    extra.textContent = key === "run" ? "无运行账本时仅计页面在线观测" : key === "sum" ? "验证区间并发求和；不等于墙钟时长" : projectStopped() ? "止于最后活动；停止时间未记录" : "从项目创建算起，含等待";
    if(key==='run'){const dot=document.createElement('span');dot.className='pulse';item.appendChild(dot);}
    item.append(text,value,extra); box.appendChild(item);
    if (key === "run") value.textContent = "等待运行记录";
    if (key === "total") value.textContent = fmtDur(summary.project_span_s);
    if (key === "sum") value.textContent = "等待验证记录";
  }
  tickTimers();
}

/* 项目已停止时，用「最后一次心跳/收敛时间」当作下限，避免显示成"到现在" */
function tk_end_or_now(g, S) {
  let t = 0;
  (g.intents || []).forEach(it => {
    if (it.concluded_ts) t = Math.max(t, it.concluded_ts);
    if (it.hb_ts) t = Math.max(t, it.hb_ts);
  });
  return t > 0 ? t : nowTs();
}

/* 只改数字，不重建 DOM */
function tickTimers() {
  const graph = state.data; if (!graph) return;
  const activity=executionSnapshot();syncExecutionVisuals(activity);
  const summary = graph.summary;
  const clock=activity.clock,runTimer=document.querySelector('#timers [data-tmr="run"]');
  const runLive=graph.project.status==='active'&&state.live&&!state.executionDisconnected&&state.lastTreeReceived!=null&&Date.now()-state.lastTreeReceived<10000;
  if(runTimer){runTimer.classList.toggle('live',runLive);runTimer.classList.toggle('stopped',!runLive);}
  const set = (key,value) => { const node = document.querySelector(`#timers [data-tmr="${key}"] .vl`); if (node) node.textContent = value; };
  if(clock){
    set('run',fmtDur(clock.runSeconds)+(clock.runSource==='recorded'?'':' · 观测'));
    set('sum',fmtDur(clock.totalSeconds)+(clock.source==='recorded'?'':clock.source==='mixed'?' · 混合口径':' · 观测累计'));
  }
  if (!projectStopped()) {
    const created = ExecutionClock.stamp(graph.project.created_at);
    if(created!==null)set('total',fmtDur(Math.max(0,nowTs()-created)));
  }
  const timerSelector=state.view==='graph'?'[data-itimer],[data-itimer-live]':'#side:not(.hide) [data-itimer],#side:not(.hide) [data-itimer-live]';
  document.querySelectorAll(timerSelector).forEach(node => {
    const id = node.dataset.itimer || node.dataset.itimerLive;
    const intent = INTENTS[id],row=activity.byId.get(id);
    if(intent){const value=row?(row.timingSource==='recorded'?'累计验证 ':'观测累计 ')+fmtDur(row.cumulativeSeconds):intentTimeText(intent,projectStopped());updateText(node,value);}
  });
  syncCanvasFocusContext(activity);
  if (state.recentUntil && Date.now() >= state.recentUntil) {
    document.querySelectorAll(".is-new").forEach(node => node.classList.remove("is-new"));
    state.recentUntil = 0;
  }
}

/* 每 1 秒跳一次 */
function startTimerLoop() {
  if (state.timerLoop) return;
  state.timerLoop = setInterval(() => {
    if (document.hidden) return;      // 后台标签页不烧 CPU
    tickTimers();
  }, 1000);
}

function renderHints(graph) {
  const banner = $("#hint-banner"); banner.textContent = "";
  banner.classList.toggle("hide", !graph.hints.length);
  if (!graph.hints.length) return;
  const details = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = `人工提示 ${graph.hints.length} 条 · 点击展开原文`;
  details.appendChild(summary);
  for (const hint of graph.hints) {
    const entry = document.createElement("pre"); entry.className = "full";
    entry.textContent = `${hint.creator} · ${fmtTime(hint.created_at)}\n${hint.content}`;
    details.appendChild(entry);
  }
  banner.appendChild(details);
}

/* ══════════════════════ 事件 ══════════════════════ */
function bindUI() {
  initReasoning();
  initCanvasFocus();
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#btnMetrics").addEventListener("click", () => {
    const panel = $("#metrics"); panel.hidden = !panel.hidden;
    $("#btnMetrics").setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#btnRefresh").addEventListener("click", () => refreshAll());
  $("#btnFit").addEventListener("click", e => {
    setFitMode(!fitMode, e.target);
    jlog("fit: fitMode=" + fitMode);
  });

  /* 项目列表：整列收起 */
  const pb = document.getElementById("projbar");
  const bc = document.getElementById("btnProjCollapse");
  if (bc && pb) {
    bc.addEventListener("click", () => {
      const col = pb.classList.toggle("collapsed");
      bc.textContent = col ? "›" : "‹";
      bc.title = col ? "展开项目列表" : "把整个项目列表往左收起";
      setTimeout(() => { if (state.data&&state.view==="graph") render(); }, 180);   // 宽度变了，重画画布
    });
  }
  /* 项目列表：筛选（输入即筛，不做防抖，170 项够快）*/
  const ps = document.getElementById("projSearch");
  if (ps) {
    ps.addEventListener("input", e => {
      state.projQuery = e.target.value;
      renderProjList();
    });
    ps.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.target.value = ""; state.projQuery = ""; renderProjList(); }
    });
  }
  document.querySelectorAll("#toolbar [data-f]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#toolbar [data-f]").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      state.filter = btn.getAttribute("data-f");
      applyFiltering();
    });
  });
  $("#search").addEventListener("input", e => { state.query = e.target.value; applyFiltering(); });
  $("#btnClearSearch").addEventListener("click", () => {
    $("#search").value = ""; state.query = ""; applyFiltering();
  });
  $("#tls").addEventListener("input", e => { state.tl = +e.target.value; applyTimeline(); });
  $("#btnPlay").addEventListener("click", () => togglePlay());
  $("#btnChain").addEventListener("click", e => {
    state.showChain = !state.showChain;
    e.target.classList.toggle("on", state.showChain);
    render();
  });
  $("#btnFold").addEventListener("click", e => {
    state.collapse = !state.collapse;
    e.target.classList.toggle("on", state.collapse);
    e.target.textContent = state.collapse ? "折叠收敛方向" : "全部展开";
    render();
  });
  $("#btnEdges").addEventListener("click", e => {
    state.showEdges = !state.showEdges;
    e.target.classList.toggle("on", state.showEdges);
    render();
  });
  $("#btnLive").addEventListener("click", e => {
    state.live = !state.live;
    if(!state.live)ExecutionClock.observe(state.data,[],nowTs(),false);
    e.target.classList.toggle("on", state.live);
    e.target.setAttribute('aria-pressed',String(state.live));
    tickTimers();
    if(state.live)refreshAll(true);
  });
  $("#btnClose").addEventListener("click", () => {
    if(state.canvasFocus)state.focusSideTouched=true;
    state.selected = null; state.traceMode = null; state.trace = null;
    /* ★ 「关闭」= 真的把整块侧栏收起来（不是只清空内容）。
       之前只清了内容、面板一直占着 430px，用户反馈"无法收起"。 */
    const side = $("#side");
    if (side) side.classList.add("hide");
    $("#side-title").textContent = "点击任一节点查看完整描述";
    const body = $("#side-body");
    while (body.firstChild) body.removeChild(body.firstChild);
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "已关闭详情。左键点节点重新查看。";
    body.appendChild(d);
    highlightEdges();
    document.querySelectorAll(".card-rect.sel").forEach(n => n.classList.remove("sel"));
  });
  $("#btnTheme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("cairn-theme", next); } catch (e) {}
  });
  document.addEventListener("keydown", e => {
    const editing=document.activeElement?.matches('input,textarea,select')||document.activeElement?.isContentEditable;
    if (e.key === "/" && !editing) {
      e.preventDefault(); (state.canvasFocus?$("#canvas-focus-search"):$("#search")).focus();
    } else if ((e.key === "f" || e.key === "F") && !editing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      /* ★ 「画布专注」的快捷键。之前只有工具栏一个按钮，没有快捷键也没写进文档，
         结果功能在但没人知道。F = focus，Esc 退出（不进系统全屏）。 */
      e.preventDefault(); setCanvasFocus(!state.canvasFocus);
    } else if ((e.key === "s" || e.key === "S") && !editing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      /* 收起设置区，把纵向空间让给树（非专注态也需要 —— 原来只有专注态才收得掉）。 */
      e.preventDefault(); setSettingsCollapsed(!state.settingsCollapsed);
    } else if (e.key === "Escape") {
      if(state.canvasFocus){e.preventDefault();setCanvasFocus(false);return;}
      hideTip(); $("#btnClose").click();
    }
  });
  $("#stage").addEventListener("click", () => { hideTip(); });
}
function togglePlay() {
  const btn = $("#btnPlay");
  if (state.playing) {
    clearInterval(state.playTimer); state.playing = false; btn.textContent = "▶ 回放";
    return;
  }
  state.playing = true; btn.textContent = "⏸ 暂停";
  state.tl = 0; $("#tls").value = 0; applyTimeline();
  state.playTimer = setInterval(() => {
    state.tl = Math.min(1000, state.tl + 12);
    $("#tls").value = state.tl; applyTimeline();
    if (state.tl >= 1000) { clearInterval(state.playTimer); state.playing = false; btn.textContent = "▶ 回放"; }
  }, 40);
}

/* Dashboard/view and refresh coordination; the SVG remains the full-data view. */
function setView(view) {
  if (!["reasoning","overview","current","graph"].includes(view)) view = "reasoning";
  state.view = view;
  $("#reasoning").hidden = view !== "reasoning";
  $("#stage").classList.toggle("reasoning-stage",view === "reasoning");
  $("#tools").hidden = view === "reasoning";
  $("#overview").hidden = view !== "overview";
  $("#current-view").hidden = view !== "current";
  $("#tree").toggleAttribute("hidden", view !== "graph");
  $("#legend-panel").hidden = view !== "graph";
  document.querySelectorAll("[data-view]").forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle("on",selected); button.setAttribute("aria-pressed",String(selected));
  });
  if (view === "graph") {
    if(state.laneRenderedRevision!==state.dataRevision){render();state.laneRenderedRevision=state.dataRevision;}
    applyZoom();
  }
  if ((view === "overview"||view === "current")&&state.dashboardRenderedRevision!==state.dataRevision) {
    renderDashboard(state.data);state.dashboardRenderedRevision=state.dataRevision;
  }
  if (view === "reasoning") renderReasoning();
  syncCanvasFocusContext();
  try { const url = new URL(location.href); url.searchParams.set("view",view); history.replaceState(null,"",url); } catch (e) {}
}

function selectNode(kind, id) {
  if(state.canvasFocus)state.focusSideTouched=true;
  state.selected = {kind,id};
  showDetail(kind,id); highlightEdges();
}

function reportButton(node, kind) {
  const button = document.createElement("button"); button.className = "report";
  button.dataset.reportId = node.id; button.dataset.kind = kind;
  button.setAttribute("aria-label", (kind === "fact" ? "事实 " : "方向 ") + node.id + "，查看完整详情");
  if (kind === "fact" && state.recentAdded.has(node.id) && Date.now() < state.recentUntil) button.classList.add("is-new");
  const heading = document.createElement("div"); heading.className = "report-heading";
  const id = document.createElement("strong"); id.textContent = node.id;
  const badge = document.createElement("span"); badge.className = "badge";
  badge.textContent = kind === "intent" ? node.state_label : TreeModel.evidenceLabel(node.evidence_status);
  badge.dataset.status = kind === "intent" ? node.execution_state : node.evidence_status;
  heading.append(id,badge);
  if (button.classList.contains("is-new")) {
    const fresh = document.createElement("span"); fresh.className = "new-badge"; fresh.textContent = "新增"; heading.appendChild(fresh);
  }
  const description = document.createElement("div"); description.className = "report-description";
  description.textContent = oneLine(node.description,180);
  const meta = document.createElement("div"); meta.className = "muted";
  meta.textContent = fmtTime(node.created_at) + " · " + (kind === "fact" ? TreeModel.provenanceLabel(node) : (node.worker || "尚无执行者"));
  button.append(heading,description,meta);
  button.addEventListener("click", () => selectNode(kind,node.id));
  return button;
}

function reportSection(parent,title,nodes,kind,empty,cls) {
  const section = document.createElement("section"); section.className = "dashboard-section " + (cls || "");
  const heading = document.createElement("h2"); heading.textContent = title; section.appendChild(heading);
  const list = document.createElement("div"); list.className = "report-list";
  for (const node of nodes) list.appendChild(reportButton(node,kind));
  if (!nodes.length) { const note = document.createElement("p"); note.className = "muted"; note.textContent = empty; list.appendChild(note); }
  section.appendChild(list); parent.appendChild(section);
}

function renderDashboard(graph) {
  if (!graph||(state.view!=="overview"&&state.view!=="current")) return;
  const overview = $("#overview"), current = $("#current-view"); overview.textContent = ""; current.textContent = "";
  const directions = [...graph.intents].filter(i => i.open);
  const order = {executing:0,stalled:1,awaiting_heartbeat:2,waiting:3,paused:4};
  directions.sort((a,b) => order[a.execution_state] - order[b.execution_state] || (b.ts || 0) - (a.ts || 0));
  const facts = [...graph.facts].filter(f => !["origin","goal"].includes(f.id) && matches(f)).sort((a,b) => (b.ts || 0) - (a.ts || 0) || b.id.localeCompare(a.id));
  const important = graph.chain.map(n => FACTS[n.id]).filter(Boolean).filter(matches).reverse().slice(0,4);
  const anomalies = graph.facts.filter(f => f.orphan_reason === "missing_source");
  const visibleDirections = state.filter === "running" ? directions.filter(i => i.running) : directions;
  reportSection(overview,"当前方向 · 执行 / 等待 / 异常",visibleDirections.slice(0,6),"intent","暂无匹配的未收敛方向。可在全量推导图查看历史。","directions");
  reportSection(overview,"最近事实 · 点击读原文",facts.slice(0,8),"fact","暂无匹配事实。","recent");
  reportSection(overview,"近期里程碑 · 文本信号，不是成功裁决",important,"fact","暂无里程碑。候选 flag 与平台通过回执分开标记。","milestones");
  if (anomalies.length) reportSection(overview,"来源缺失 · 数据仍完整保留",anomalies.slice(0,6),"fact","","anomalies");
  if (graph.dangling_references.length) {
    const note = document.createElement("p"); note.className = "anomaly-note";
    note.textContent = `${graph.dangling_references.length} 条关系引用了不存在的节点：记录为异常，不伪造推导边。`;
    overview.appendChild(note);
  }
  const active = visibleDirections;
  reportSection(current,"当前方向 · 完整列表",active,"intent","当前没有匹配的未收敛方向。","directions");
  const help = document.createElement("p"); help.className = "muted";
  help.textContent = "执行中依据 worker 与近期心跳判断；未收敛不等于正在执行。点击方向可查看依据、产出和完整推导。";
  current.prepend(help);
}

async function refreshAll(manual = true) {
  if (state.refreshBusy || (!manual && (!state.live || state.playing || document.hidden))) return;
  state.refreshBusy = true;
  $("#btnRefresh").disabled = true;
  try {
    if(manual||!state.lastProjectPoll||Date.now()-state.lastProjectPoll>=8000){
      await loadProjects();state.lastProjectPoll=Date.now();
    }
    if (!state.projects.length) {
      state.data = null; state.pid = null; state.selected = null; state.traceMode = null;
      renderAttemptScope(null);
      renderExecutionPanel(null,null);
      renderReasoning();
      $("#overview").textContent = "暂无项目。项目由 Cairn 原有 API 创建，此页只读。";
      $("#current-view").textContent = "暂无项目"; $("#tree").textContent = ""; $("#reason-tree").textContent = ""; $("#reason-status").textContent = "等待项目数据";
      $("#project-context").textContent = "暂无项目"; $("#pulse").textContent = "";
      $("#stats").textContent = ""; $("#timers").textContent = ""; $("#trace-info").hidden = true;
      $("#update-note").textContent = "暂无项目 · 等待下一次快照";
      $("#update-note").classList.remove("changed"); $("#banner").classList.add("hide");
      $("#foot-info").textContent = "暂无项目 · 服务端数据 · 只读展示";
      $("#hint-banner").classList.add("hide"); $("#chainbar").classList.add("hide"); $("#side").classList.add("hide");
      $("#load-error").hidden = true; $("#foot-status").textContent = "服务正常 · 暂无项目";
      return;
    }
    if (!state.projects.some(p => p.id === state.pid)) {
      const next = state.projects.find(p => p.status === "active") || state.projects[0];
      await selectProject(next.id);
    } else await loadTree(state.pid,true);
  } catch (error) { showLoadError(error); }
  finally { state.refreshBusy = false; $("#btnRefresh").disabled = false; }
}

function startRefreshLoop() {
  if (state.refreshLoop) return;
  state.live = !urlParam("nopoll");
  $("#btnLive").classList.toggle("on",state.live);
  $("#btnLive").setAttribute('aria-pressed',String(state.live));
  state.refreshLoop = setInterval(() => refreshAll(false),2000);
}

/* ── 启动 ── */
function urlParam(k) {
  const m = new RegExp("[?&]" + k + "=([^&]*)").exec(location.search);
  return m ? decodeURIComponent(m[1]) : null;
}
(async function boot() {
  try {
    jlog("boot: 开始");
    bindUI();
    jlog("boot: bindUI 完成");
    /* 主题已在 <head> 的内联脚本里定好（避免闪屏），这里只记日志 */
    jlog("boot: 主题 " + document.documentElement.getAttribute("data-theme"));
    /* ★ 默认 1:1（字要看清楚）；`?fit=1` 可一进来就适配成"看全貌"模式。
       无论哪种，容器尺寸一变都会由下面的 ResizeObserver 重算 ——
       这才是"面板开关会不会带着画布一起重排"的关键。 */
    setFitMode(urlParam("fit") === "1");
    setView(urlParam("view") || "reasoning");
    startRefreshLoop();
    startTimerLoop();

    /* ★ 容器尺寸变化就重算缩放。
       这一步是「面板/侧栏的开合有没有合到主树里」的关键：详情面板打开、
       项目列表收起、窗口 resize 都会改变 #stage 的宽度，画布必须跟着走。 */
    const _stage = document.getElementById("stage");
    if (_stage && typeof ResizeObserver !== "undefined") {
      let _raf = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(_raf);
        _raf = requestAnimationFrame(applyZoom);
      }).observe(_stage);
      jlog("boot: ResizeObserver 已挂在 #stage");
    }
    window.addEventListener("resize", applyZoom);

    await loadProjects();
    jlog("boot: 项目列表 " + state.projects.length + " 个");
    const want = urlParam("project");
    /* ?fold=0 强制全部展开、?fold=1 强制折叠（默认折叠）。便于分享/对比/测试。 */
    const foldParam = urlParam("fold");
    if (foldParam === "0" || foldParam === "1") {
      state.collapse = (foldParam === "1");
      const bf = $("#btnFold");
      bf.classList.toggle("on", state.collapse);
      bf.textContent = state.collapse ? "折叠收敛方向" : "全部展开";
    }
    const prefer = (want && state.projects.find(p => p.id === want)) ||
      state.projects.find(p => p.status === "active") || state.projects[0];
    if (!prefer) {
      $("#foot-info").textContent = "暂无项目 · 只读展示（可通过 Cairn API 创建项目）";
      $("#overview").textContent = "暂无项目。项目由 Cairn 原有 API 创建，此页只读。";
      $("#project-context").textContent = "暂无项目";
      $("#current-view").textContent = "暂无项目";
      $("#update-note").textContent = "暂无项目 · 等待下一次快照";
      $("#foot-status").textContent = "服务正常 · 暂无项目";
      startRefreshLoop();
      return;
    }
    const pid = prefer.id;
    state.pid = pid;
    renderProjList();        // ★ 标出当前项目
    await loadTree(pid);
    jlog("boot: 完成 " + pid);
    startTimerLoop();        // ★ 每秒让计时器自己跳（否则只在 8 秒刷新时才动）
    /* 自动刷新：默认开；?nopoll=1 或点「实时刷新」可停 */
    startRefreshLoop();
    if (!urlParam("nopoll")) {
      state.live = true;

    } else {
      state.live = false;
      $("#btnLive").classList.remove("on");
    }
  } catch (err) {
    jlog("boot 异常: " + (err && (err.stack || err.message) || err));
    showLoadError(err);
  }
})();
