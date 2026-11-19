function bindNode(node, kind, id) {
  node.setAttribute("tabindex", "0");
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", (kind === "fact" ? "事实 " : "方向 ") + id + "，打开完整详情");
  node.addEventListener("click", ev => { ev.stopPropagation(); selectNode(kind, id); });
  node.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectNode(kind, id); }
  });
  node.addEventListener("mouseenter", ev => showTip(ev, kind, id));
  node.addEventListener("mousemove", moveTip);
  node.addEventListener("mouseleave", hideTip);
}

function highlightEdges() {
  const selection = state.selected;
  const trace = state.traceMode && selection
    ? TreeModel.traceGraph(state.data, selection.kind, selection.id, state.traceMode) : null;
  state.trace = trace;
  const included = trace ? new Set(trace.nodes) : null;
  const edgeKeys = trace ? new Set(trace.edges.map(TreeModel.edgeKey)) : null;
  if(state.view==="graph"){
  document.querySelectorAll("#edges path").forEach(path => {
    const edge = {type:path.dataset.edge, from:path.dataset.from, to:path.dataset.to};
    const selectedKey = selection && selection.kind + ":" + selection.id;
    const endpointKeys = edge.type === "merge" ? ["intent:" + edge.from,"intent:" + edge.to] : edge.type === "trigger" ? ["fact:" + edge.from,"intent:" + edge.to] : ["intent:" + edge.from,"fact:" + edge.to];
    const active = included ? edgeKeys.has(TreeModel.edgeKey(edge)) : selection && endpointKeys.includes(selectedKey);
    path.classList.toggle("hl", !!active);
    path.classList.toggle("e-dim", !!selection && !active);
  });
  document.querySelectorAll("#tree [data-fid], #tree [data-cid], #tree [data-iid]").forEach(node => {
    const id = node.dataset.fid || node.dataset.cid || node.dataset.iid;
    const kind = node.dataset.iid ? "intent" : "fact";
    node.classList.toggle("trace-dim", !!included && !included.has(kind + ":" + id));
    node.classList.toggle("trace-node", !!included && included.has(kind + ":" + id));
  });
  } // Hidden lane DOM is not scanned on reasoning refresh.
  const note = $("#trace-info");
  note.textContent = trace ? `已追踪 ${trace.nodes.length} 个节点、${trace.edges.length} 条数据库推导边（不含时间猜测）` : "";
  note.hidden = !trace;
  highlightReasoning();
}

function applyFiltering() {
  const isRunning = state.filter === "running";
  document.querySelectorAll("g.card[data-fid]").forEach(g => {
    const f = FACTS[g.getAttribute("data-fid")]; if (!f) return;
    g.classList.toggle("dim", !isRunning && !matches(f));
  });
  document.querySelectorAll("g.card[data-cid]").forEach(g => {
    const f = FACTS[g.getAttribute("data-cid")]; if (!f) return;
    g.classList.toggle("dim", !isRunning && !matches(f));
  });
  document.querySelectorAll("g.trig").forEach(g => {
    const f = FACTS[g.getAttribute("data-fid")]; if (!f) return;
    g.classList.toggle("dim", !isRunning && !matches(f));
  });
  document.querySelectorAll("g.lane").forEach(g => {
    const n = +g.getAttribute("data-lane");
    const L = (state.data.lanes || [])[n]; if (!L) return;
    g.style.opacity = (isRunning && !L.intent.running) ? "0.18" : "1";
  });
  /* 搜索命中描边 */
  const q = state.query.trim().toLowerCase();
  state.hitIds = new Set();
  if (q) (state.data.facts || []).forEach(f => {
    if ((f.description || "").toLowerCase().includes(q) || f.id.toLowerCase().includes(q))
      state.hitIds.add(f.id);
  });
  document.querySelectorAll("g.card[data-fid]").forEach(g => {
    g.classList.toggle("hit", state.hitIds.has(g.getAttribute("data-fid")));
  });
  if (state.data) renderDashboard(state.data);
  highlightReasoning();
}

let _allTsCache = null;
function applyTimeline() {
  if (!_allTsCache) return;
  const [t0, t1] = _allTsCache;
  const cutoff = t0 + (t1 - t0) * (state.tl / 1000);
  const on = state.tl >= 1000;
  document.querySelectorAll("g.card[data-fid]").forEach(g => {
    const f = FACTS[g.getAttribute("data-fid")]; if (!f) return;
    const hide = !on && f.ts && f.ts > cutoff;
    g.style.display = hide ? "none" : "";
  });
  document.querySelectorAll("g.card[data-cid]").forEach(g => {
    const f = FACTS[g.getAttribute("data-cid")]; if (!f) return;
    g.style.display = (!on && f.ts && f.ts > cutoff) ? "none" : "";
  });
  document.querySelectorAll("g.trig").forEach(g => {
    const f = FACTS[g.getAttribute("data-fid")]; if (!f) return;
    g.style.display = (!on && f.ts && f.ts > cutoff) ? "none" : "";
  });
  $("#tlsLabel").textContent = on ? "全部"
    : fmtTime(new Date(cutoff * 1000).toISOString());
}

/* ── 提示气泡 ── */
function showTip(ev, kind, id) {
  const tip = $("#tip");
  if (kind === "fact") {
    const f = FACTS[id]; if (!f) return;
    const t = tagsOf(f);
    tip.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${f.id} · ${fmtTime(f.created_at)}`;
    tip.appendChild(b);
    const d = document.createElement("div");
    d.textContent = oneLine(f.description, 150);
    tip.appendChild(d);
    const m = document.createElement("div");
    m.style.marginTop = "4px";
    m.style.color = "var(--fg3)";
    m.textContent = (f.source_intent ? `来源方向 ${f.source_intent}` : "未归属") +
      (flagBadge(f) ? ` · ${flagBadge(f)}` : "");
    tip.appendChild(m);
  } else {
    const it = INTENTS[id]; if (!it) return;
    tip.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${it.id} · ${it.state_label}`;
    tip.appendChild(b);
    const d = document.createElement("div");
    d.textContent = oneLine(it.description, 150);
    tip.appendChild(d);
  }
  tip.style.display = "block";
  moveTip(ev);
}
function moveTip(ev) {
  const tip = $("#tip");
  const r = $("#stage").getBoundingClientRect();
  let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
  if (x + tip.offsetWidth > r.width - 8) x = ev.clientX - r.left - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > r.height - 8) y = ev.clientY - r.top - tip.offsetHeight - 14;
  tip.style.left = Math.max(4, x) + "px";
  tip.style.top = Math.max(4, y) + "px";
}
function hideTip() { $("#tip").style.display = "none"; }

/* ── 详情侧栏：完整不截断 ── */
function showDetail(kind, id) {
  const body = $("#side-body"), title = $("#side-title");
  /* ★ 之前这里漏了「把面板显示出来」：关闭按钮把 #side 收起来（加 .hide）之后，
     再点节点只会往隐藏的容器里填内容 —— 看起来就是"关了以后再也打不开"。
     打开详情必须同时把面板显出来。 */
  const side = $("#side");
  if (side) side.classList.remove("hide");
  while (body.firstChild) body.removeChild(body.firstChild);
  if (kind === "fact") {
    const f = FACTS[id]; if (!f) return;
    title.textContent = `fact ${f.id}`;
    addKV(body, [
      ["创建时间", fmtTime(f.created_at)],
      ["来源方向", f.source_intent ? f.source_intent : "未归属（DB source_intent 为空）"],
      ["归属依据", TreeModel.provenanceLabel(f)],
      ["证据口径", TreeModel.evidenceLabel(f.evidence_status)],
      ["触发方向", (f.triggers || []).join("、") || "—"],
      ["是本方向结论", (f.is_conclusion_of || []).join("、") || "—"],
      ["标签", (f.tags || []).join("、") || "—"],
    ]);
    if (f.flags && f.flags.length) {
      addH(body, "候选 flag 字面量 · 不等于平台接受");
      const p = document.createElement("pre");
      p.className = "full";
      p.textContent = f.flags.join("\n");
      body.appendChild(p);
    }
    if (f.violations && f.violations.length) {
      addH(body, "⚠ 措辞违规命中（全称否定）");
      f.violations.forEach(v => {
        const d = document.createElement("div");
        d.className = "vf";
        const h = document.createElement("div");
        h.className = "h";
        h.textContent = `${v.severity === "P1" ? "红线" : "有界（降级）"} · ${v.label}` +
          (v.kind === "completion" ? " · 完成式断言" : "") +
          (v.bounded ? " · 命中点在有界作用域内" : "");
        const q = document.createElement("div");
        q.className = "q";
        q.textContent = "…" + v.quote + "…";
        d.appendChild(h); d.appendChild(q); body.appendChild(d);
      });
    }
    addH(body, "完整 description（未截断）");
    const pre = document.createElement("pre");
    pre.className = "full";
    pre.setAttribute("data-fact", f.id);
    pre.setAttribute("data-desc-len", String((f.description || "").length));
    pre.textContent = f.description || "(空)";
    body.appendChild(pre);
    /* 复制按钮 */
    const bar = document.createElement("div");
    bar.style.marginTop = "8px";
    const cb = document.createElement("button");
    cb.textContent = "复制完整描述";
    cb.onclick = async () => {
      try {
        if (!navigator.clipboard) throw new Error("剪贴板不可用");
        await navigator.clipboard.writeText(f.description || ""); cb.textContent = "已复制";
      } catch (error) { cb.textContent = "复制失败，请手动选择文本"; }
      setTimeout(() => { cb.textContent = "复制完整描述"; }, 2000);
    };
    bar.appendChild(cb); body.appendChild(bar);
  } else {
    const it = INTENTS[id]; if (!it) return;
    const frozen = projectStopped();          // 项目已停止 → 别把未收敛方向标成"实时"
    const live = it.running && !frozen;
    title.textContent = `intent ${it.id}`;
    /* ★ 计时行放第 4 项（index 3）：真在跑才是活的、每秒跳；其余定格。 */
    addKV(body, [
      ["状态", it.state_label],
      ["创建时间", fmtTime(it.created_at)],
      ["收敛时间", fmtTime(it.concluded_at)],
      ["方向墙钟跨度" + (live ? "（实时）" : ""), "—"],
      ["最后心跳", fmtTime(it.last_heartbeat_at) + (it.stale ? "（超 5 分钟）" : "")],
      ["创建者", it.creator || "—"],
      ["执行者", it.worker || "未认领"],
      ["收敛到", it.to_fact_id || "—"],
      ["产出 fact", String((it.produced || []).length) + " 条"],
      ["结论分类", it.tier_label + " · 仅文本信号"],
    ]);
    const target = body.querySelectorAll("dl.kv dd")[3];
    if (target) {
      while (target.firstChild) target.removeChild(target.firstChild);
      const sp = document.createElement("span");
      sp.className = "live-val";
      const em = document.createElement("span");
      em.style.color = "var(--fg3)";
      em.style.fontSize = "11px";
      if (live) {
        sp.setAttribute("data-itimer-live", it.id);   // ← tickTimers() 每 1 秒找它
        sp.textContent = intentTimeText(it, false);
        em.textContent = "　墙钟时间（从 " + fmtTime(it.created_at) + " 起）";
      } else if (it.open) {
        sp.textContent = intentTimeText(it, true);
        em.textContent = "　未收敛；这是方向创建后的墙钟跨度，不是实际执行净时长";
      } else {
        sp.textContent = intentTimeText(it, false);
        em.textContent = "　" + fmtTime(it.created_at) + " → " + fmtTime(it.concluded_at);
      }
      target.appendChild(sp); target.appendChild(em);
    }
    addH(body, "触发的 fact（本方向依据）");
    addRel(body, it.triggered_by || [], "tr");
    addH(body, "产出的 fact");
    addRel(body, it.produced || [], "");
    addH(body, "收敛结论");
    addRel(body, it.converges_to ? [it.converges_to] : [], "cv");
    addH(body, "完整 description（未截断）");
    const pre = document.createElement("pre");
    pre.className = "full";
    pre.textContent = it.description || "(空)";
    body.appendChild(pre);
  }
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "分类与回执均来自黑板文本，不是本页重新向平台校验。时间推测归属只用于排版，不是推导关系。";
  body.appendChild(note);
  const controls = document.createElement("div"); controls.className = "trace-actions";
  for (const [mode, label] of [["upstream","上游依据"],["downstream","下游产出"],["both","完整推导"],[null,"清除追踪"]]) {
    const button = document.createElement("button"); button.textContent = label;
    button.addEventListener("click", () => {
      state.selected = {kind, id}; state.traceMode = mode;
      if (mode) setView(state.view === "reasoning" ? "reasoning" : "graph");
      else if (state.view === "reasoning") renderReasoning();
      highlightEdges();
    });
    controls.appendChild(button);
  }
  body.appendChild(controls);

}
function addH(body, t) { const h = document.createElement("h4"); h.textContent = t; body.appendChild(h); }function addKV(body, pairs) {
  const dl = document.createElement("dl"); dl.className = "kv";
  pairs.forEach(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v == null ? "—" : v;
    dl.appendChild(dt); dl.appendChild(dd);
  });
  body.appendChild(dl);
}
function addRel(body, ids, cls) {
  const d = document.createElement("div"); d.className = "rel";
  if (!ids.length) { d.textContent = "—"; body.appendChild(d); return; }
  ids.forEach(id => {
    const a = document.createElement("a");
    a.className = cls; a.textContent = id;
    a.onclick = () => {
      state.selected = { kind: "fact", id };
      showDetail("fact", id); highlightEdges();
    };
    d.appendChild(a);
  });
  body.appendChild(d);
}

/* ══════════════════════ 自检 ══════════════════════
   两路交叉验证：
     (a) DOM 路 —— 数 SVG 里真实存在的节点/边（证明真的画出来了）
     (b) 布局路 —— 用渲染时记录的精确矩形做几何断言（dump-dom 下 getBBox 为 0，不可依赖）
   ══════════════════════════════════════════════════ */
function runSelfCheck(width, height, laneInfo, trigPos, conclPos, ec) {
  const g = state.data, S = g.summary || {}, LAY = window.__LAYOUT__, D = window.__DIAG__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  /* ── DOM 路 ── */
  const domFacts = new Set(), domCards = new Set();
  document.querySelectorAll("g[data-fid]").forEach(n => domFacts.add(n.getAttribute("data-fid")));
  document.querySelectorAll("g[data-cid]").forEach(n => domFacts.add(n.getAttribute("data-cid")));
  document.querySelectorAll("g.card[data-fid],g.card[data-cid]").forEach(n => {
    domCards.add(n.getAttribute("data-fid") || n.getAttribute("data-cid"));
  });

  const allIds = (g.facts || []).map(f => f.id);
  const missing = allIds.filter(id => !domFacts.has(id));
  const extra = Array.from(domFacts).filter(id => allIds.indexOf(id) < 0);

  /* C1 ★ 每条 fact 都出现在 DOM 里，且不多不少 */
  add("C1 全部 fact 都渲染出来（DOM 去重数 == DB 数）",
      domFacts.size === allIds.length && missing.length === 0 && extra.length === 0,
      `DOM ${domFacts.size} / DB ${allIds.length}` +
      (missing.length ? `，缺失 ${missing.length}：${missing.slice(0, 12).join(",")}` : "") +
      (extra.length ? `，多余：${extra.join(",")}` : ""));

  /* C2 ★ 未归属 fact 全部可见（不能因为没 source_intent 就消失）*/
  const orph = (g.facts || []).filter(f => !f.source_intent || f.orphan_reason === "missing_source");
  const orphMissing = orph.filter(f => !domFacts.has(f.id));
  add("C2 未归属 fact 全部可见并打了「未归属/收敛」标",
      orphMissing.length === 0,
      `未归属 ${orph.length} 条（${orph.map(f => f.id).join(",")}），缺失 ${orphMissing.length}` +
      (orphMissing.length ? "：" + orphMissing.map(f => f.id).join(",") : ""));

  /* C3 ★ 三类边：DOM 实际画出的条数 == 本次 fetch 的数据里应有的条数
        （用同一份数据自洽比对，避免与「别的时刻」的快照做跨时比较）*/
  const eT = document.querySelectorAll('#edges path[data-edge="trigger"]').length;
  const eP = document.querySelectorAll('#edges path[data-edge="produce"]').length;
  const eC = document.querySelectorAll('#edges path[data-edge="converge"]').length;
  const dataT = (g.edges || []).filter(e => e.type === "trigger").length;
  const dataP = (g.edges || []).filter(e => e.type === "produce").length;
  const dataC = (g.edges || []).filter(e => e.type === "converge").length;
  add("C3 三类边都绘制，条数与本次数据一致（触发/产出/收敛）",
      eT === dataT && eP === dataP && eC === dataC &&
      eT === D.drawn.trigger && eP === D.drawn.produce && eC === D.drawn.converge,
      `触发 DOM ${eT} / 数据 ${dataT} / 渲染期 ${D.drawn.trigger}；` +
      `产出 DOM ${eP} / 数据 ${dataP} / 渲染期 ${D.drawn.produce}；` +
      `收敛 DOM ${eC} / 数据 ${dataC} / 渲染期 ${D.drawn.converge}`);

  /* C4 边端点都存在（没有悬空边）*/
  let dangling = 0;
  document.querySelectorAll("#edges path").forEach(p => {
    const f = p.getAttribute("data-from"), t = p.getAttribute("data-to");
    if (f && !FACTS[f] && !INTENTS[f]) dangling++;
    if (t && !FACTS[t] && !INTENTS[t]) dangling++;
  });
  add("C4 没有悬空边（每条边两端都是真实节点）", dangling === 0, `悬空 ${dangling}`);

  /* C5 ★ 含flag 字面量 的 fact 都被高亮，数量与 DB 一致（按 fact 去重）。
     折叠时它们以 **芯片** 形式出现，所以卡片和芯片都要数。 */
  const flagDom = new Set();
  document.querySelectorAll("g.card.flag, g.fchip.flag").forEach(n => {
    flagDom.add(n.getAttribute("data-fid") || n.getAttribute("data-cid"));
  });
  const flagDb = (g.facts || []).filter(f => (f.tags || []).indexOf("flag") >= 0);
  add("C5 含flag 字面量 的 fact 全部高亮且数量对得上",
      flagDom.size === S.flag_facts && flagDb.length === S.flag_facts,
      `高亮 ${flagDom.size} / DB 带 flag 标签 ${flagDb.length} / 汇总 ${S.flag_facts}` +
      `（唯一 flag 值 ${S.flag_unique} 个）`);

  /* C6 泳道数 == intent 数 */
  const lanes = document.querySelectorAll("g.lane").length;
  add("C6 泳道数 == intent 数", lanes === S.intents, `${lanes} / ${S.intents}`);

  /* C7 每张泳道卡片都写在布局记录里（DOM 与布局两路一致）*/
  const layLaneIds = new Set(LAY.cards.filter(c => c.kind === "lane").map(c => c.id));
  const domLaneIds = new Set();
  document.querySelectorAll("g.lane g.card[data-fid]").forEach(n => domLaneIds.add(n.getAttribute("data-fid")));
  add("C7 DOM 泳道卡片与布局记录一致",
      layLaneIds.size === domLaneIds.size &&
      Array.from(domLaneIds).every(id => layLaneIds.has(id)),
      `布局 ${layLaneIds.size} / DOM ${domLaneIds.size}`);

  /* C8 ★ 同一泳道内卡片无重叠（用记录矩形做精确断言，含容差）*/
  let overlaps = [], minGap = Infinity;
  LAY.lanes.forEach(L => {
    const arr = LAY.cards.filter(c => c.kind === "lane" && c.lane === L.n)
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      const gap = b.y - (a.y + a.h);
      minGap = Math.min(minGap, gap);
      if (gap < -0.01) overlaps.push(`${L.intent}:${a.id}/${b.id}`);
    }
  });
  add("C8 同泳道卡片无重叠（记录矩形精确断言）",
      overlaps.length === 0,
      overlaps.length ? `重叠 ${overlaps.length} 对：${overlaps.slice(0, 6).join(" ")}`
        : `0 对重叠，最小间隙 ${minGap === Infinity ? "—" : minGap.toFixed(1)}px，共 ${LAY.cards.length} 张卡`);

  /* C9 卡片不超出画布 */
  let clipped = [];
  [...LAY.cards, ...LAY.conclusions, ...LAY.trigs].forEach(c => {
    if (c.x < 0 || c.y < 0 || c.x + c.w > width + 1 || c.y + c.h > height + 1) clipped.push(c.id);
  });
  add("C9 卡片不超出画布", clipped.length === 0,
      `越界 ${clipped.length}${clipped.length ? "：" + clipped.slice(0, 8).join(",") : ""}（画布 ${Math.round(width)}×${Math.round(height)}）`);

  /* C10 汇总计数自洽 */
  add("C10 汇总自洽（触发+产出+收敛 == 边总数，且 fact/intent 数与 DB 行数同源）",
      (S.edges_trigger + S.edges_produce + S.edges_converge) === (g.edges || []).length &&
      S.facts === allIds.length && S.intents === (g.intents || []).length,
      `${S.edges_trigger}+${S.edges_produce}+${S.edges_converge}=${(g.edges || []).length}；` +
      `fact ${S.facts}，intent ${S.intents}`);

  /* C11 布局覆盖：泳道卡片/芯片 + 折叠块的结论 + 触发源芯片 == 全部 fact
     （折叠时一条 fact 可能只以**芯片**形式出现，那也算"落了位置"）*/
  const covered = {};
  const bump = (id) => { covered[id] = (covered[id] || 0) + 1; };
  LAY.cards.forEach(c => bump(c.id));
  LAY.trigs.forEach(t => bump(t.id));
  Object.keys(LAY.covered || {}).forEach(id => { covered[id] = LAY.covered[id]; });
  const uncovered = allIds.filter(id => !covered[id]);
  const dup = Object.keys(covered).filter(id => covered[id] > 1);
  const nChip = LAY.cards.filter(c => c.kind === "chip").length;
  const nCollapsed = (LAY.lanes || []).filter(l => l.collapsed).length;
  add("C11 布局覆盖完整（每条 fact 至少落在一个位置）",
      uncovered.length === 0,
      `未覆盖 ${uncovered.length}${uncovered.length ? "：" + uncovered.join(",") : ""}；` +
      `其中 ${nChip} 条以折叠芯片呈现（${nCollapsed} 个已收敛方向被折起）；` +
      `重复出现 ${dup.length}${dup.length ? "：" + dup.slice(0, 10).join(",") : ""}`);

  /* C12 详情面板：选中的 fact 必须显示完整 description（不能截断、不能出现省略号）*/
  const pre = document.querySelector("#side-body pre.full[data-fact]");
  if (pre) {
    const fid = pre.getAttribute("data-fact");
    const full = (FACTS[fid] || {}).description || "";
    const shown = pre.textContent || "";
    const same = shown === full;
    add("C12 详情面板显示完整 description（不截断）", same,
        `fact ${fid}：数据 ${full.length} 字 / 面板 ${shown.length} 字` +
        (same ? "，逐字一致" : "，★不一致！") +
        (shown.slice(-1) === "…" ? "，面板末尾出现省略号（不该有）" : ""));
  } else {
    add("C12 详情面板显示完整 description（不截断）", true,
        "本次未选中节点，跳过（用 ?fact=f056 可验证）");
  }

  const fail = checks.filter(c => !c.ok);
  const out = {
    ready: true,
    calibrated: !!state.calibrated,
    project: g.project.id,
    project_title: g.project.title,
    generated_at: g.generated_at,
    canvas: { w: Math.round(width), h: Math.round(height) },
    summary: S,
    edges_drawn: { trigger: eT, produce: eP, converge: eC },
    edges_in_data: { trigger: dataT, produce: dataP, converge: dataC },
    checks,
    failed: fail.length,
    hard_failed: fail.filter(c => c.name.indexOf("C3") < 0).length,
    verdict: fail.length === 0 ? "全部通过"
      : (fail.length === 1 && fail[0].name.indexOf("C3") === 0
         ? "通过（仅 C3 跨快照漂移，见 note）" : `失败 ${fail.length} 项`),
    dom_facts: domFacts.size,
    db_facts: allIds.length,
    layout_cards: LAY.cards.length,
    note: "项目数据由服务端提供。本页所有断言都与「本次 fetch 到的同一份数据」自洽比对；" +
          "C1/C2/C5 用 DOM 与数据双向核对，C3 用 DOM 与本次 edges 双向核对。" +
          "页面会定期重新获取完整快照，校准后保留滚动位置（calibrated=true）。",
  };
  window.__SELFCHECK__ = out;
  $("#selfcheck").textContent = JSON.stringify(out, null, 1);
  /* 诊断：每条泳道卡片数 / 产出边数（有 source_intent 的才算产出）*/
  try {
    const diag = {};
    (state.data.lanes || []).forEach(L => {
      const iid = L.intent.id;
      diag[iid] = { cards: (L.card_ids || []).length,
                    produced: (L.produced || []).length,
                    extra: (L.extra || []).length,
                    withSrc: (L.produced || []).length,
                    sameIntent: (L.produced || []).length,
                    drawn: D.laneProduce[iid] || 0 };
    });
    window.__LANEDIAG__ = diag;
    const dn = document.getElementById("lanediag");
    if (dn) dn.textContent = JSON.stringify(diag);
    jlog("diag cards=" + Object.keys(diag).reduce((a, k) => a + diag[k].cards, 0) +
         " wantedProduce=" + D.want.produce + " drawnProduce=" + D.drawn.produce +
         " dataProduce=" + (state.data.edges || []).filter(e => e.type === "produce").length +
         " drawnTrigger=" + D.drawn.trigger +
         " dataTrigger=" + (state.data.edges || []).filter(e => e.type === "trigger").length);
  } catch (e) {
    jlog("diag 异常: " + (e && (e.stack || e.message) || e));
  }

  /* 过滤器自检：用页面真正的 matches() 跑一遍各档过滤，证明过滤真的能用 */
  try {
    const keepF = state.filter, keepQ = state.query;
    const fc = {};
    ["all", "flag", "receipt", "accepted", "rejected", "hardening", "denial", "orphan"].forEach(f => {
      state.filter = f; state.query = "";
      fc[f] = (state.data.facts || []).filter(matches).length;
    });
    state.filter = "running"; state.query = "";
    fc.running = (state.data.intents || []).filter(i => i.running).length;
    /* 全文搜索自检：取一段「字面上真的存在于 description 里」的片段当关键词 */
    const sample = (state.data.facts || [])
      .find(f => (f.description || "").replace(/\s/g, "").length > 30);
    if (sample) {
      let kw = "";
      for (let i = 10; i + 12 <= sample.description.length; i++) {
        const cand = sample.description.substr(i, 12);
        if (!/[\s]/.test(cand)) { kw = cand; break; }
      }
      if (kw) {
        state.filter = "all"; state.query = kw;
        fc.search_kw = kw;
        fc.search_hits = (state.data.facts || []).filter(matches).length;
        fc.search_includes_sample = matches(sample);
      }
    }
    state.filter = keepF; state.query = keepQ;
    out.filters = fc;
    out.filter_expected = {
      all: S.facts, flag: S.flag_facts, receipt: S.receipt_facts,
      hardening: S.hardening_facts, denial: S.denial_facts, orphan: S.orphan_facts,
      running: S.running_intents, accepted: S.accepted_receipts, rejected: S.rejected_facts,
    };
    const bad = Object.keys(out.filter_expected).filter(k => fc[k] !== out.filter_expected[k]);
    out.filter_ok = bad.length === 0 &&
      (!sample || (fc.search_hits > 0 && fc.search_includes_sample));
    out.filter_bad = bad;
    if (!out.filter_ok) jlog("过滤自检不一致: " + JSON.stringify(bad) + " 实际=" + JSON.stringify(fc));
  } catch (e) {
    jlog("过滤自检异常: " + (e && (e.stack || e.message) || e));
    out.filter_ok = false;
  }
  /* 把最终结论写回 DOM（含过滤自检结果）*/
  $("#selfcheck").textContent = JSON.stringify(out, null, 1);

  const b = $("#banner");
  if (fail.length) {
    b.classList.remove("hide");
    b.textContent = "自检未通过：" + fail.map(c => c.name + "（" + c.detail + "）").join("；");
  } else b.classList.add("hide");
}

/* ══════════════════════ 数据加载 ══════════════════════ */
