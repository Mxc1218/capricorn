function render() {
  const svg = $("#tree");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const g = state.data;
  if (!g) return;

  FACTS = {}; (g.facts || []).forEach(f => FACTS[f.id] = f);
  INTENTS = {}; (g.intents || []).forEach(i => INTENTS[i.id] = i);

  /* ★ 折叠：收敛的方向折成窄块，未收敛的保持全宽并**向左靠**。
     这样 15 个方向里那一堆「空的、已经停了的」不再各占 424px。
     state.collapse=false 时全部展开（可一键回退）。 */
  const lanes = g.lanes || [];
  const laneRunning = lanes.map(L => !!L.intent.open);
  const collapsed = lanes.map((L, n) => state.collapse && !laneRunning[n]);
  const laneW = lanes.map((L, n) => collapsed[n] ? COLLAPSED_W : LANE_W);
  /* 累加求每个泳道的左边界（不再用 n * 固定宽）*/
  const laneX = [];
  {
    let cx = 20;
    for (let n = 0; n < lanes.length; n++) { laneX[n] = cx; cx += laneW[n] + LANE_GAP; }
  }
  const lanesRight = laneX.length ? laneX[laneX.length - 1] + laneW[laneW.length - 1] : 20;

  /* 泳道高度：折叠块按「芯片网格」算，展开块按卡片堆叠算 */
  const laneH = lanes.map((L, n) => {
    if (collapsed[n]) {
      const cnt = L.card_ids.filter(id => FACTS[id]).length;
      const rows = Math.ceil(cnt / CHIP_COLS);
      const concl = (L.intent.to_fact_id && FACTS[L.intent.to_fact_id]) ? 1 : 0;
      return 64 + 22 + rows * (CHIP_H + CHIP_GAP) + (concl ? 46 : 0) + 24;
    }
    let content = 0;
    L.card_ids.forEach(id => { if (FACTS[id]) content += cardHeight(FACTS[id]) + 10; });
    return Math.max(content + 64 + LANE_PAD_Y, 150);
  });

  /* 顶部：goal / origin 与普通触发源同排成「起点芯片带」 */
  const otherLoose = (g.loose || []).filter(id => id !== "goal" && id !== "origin" && FACTS[id]);

  const trigBandY = 14;
  /* ★ 触发源芯片个数与"是否要画说明行"必须用**同一个判据**。
     踩过的坑：高度预算是按 `edges > trigCount` 算的，而实际画说明行用的是
     `edges - 已画芯片数 > 0` —— 这是两个不同的量（origin/goal 是保底加进去的、
     有些触发源可能不在 chips 里），于是"画了说明行但没给它留高度"，
     说明文字直接压在第一行芯片上，接着又被泳道矩形切掉。
     现在统一：先算出实际会画几个芯片，再据此决定带高与说明行位置。 */
  const trigCount = Math.min(TRIG_PER_ROW * 3, countTriggers(g));
  const trigList = topTriggersWithSpecial(g, trigCount);
  const trigRows = Math.max(1, Math.ceil(trigList.length / TRIG_PER_ROW));
  const trigMore = Math.max(0, countTriggers(g) - trigList.length);
  /* 带高：标题 20 + 芯片行 + （有未列出的触发源时）说明行 44。
     说明行 44 = 与芯片留 12px 气口 + 文字 18 + 底部 14，实测这样才不会被
     芯片虚线边框或泳道矩形切到。 */
  const trigBandH = 20 + trigRows * (TRIG_H + TRIG_GAP) + (trigMore > 0 ? 44 : 6);

  const laneTop = trigBandY + trigBandH + 34;
  const maxLaneH = Math.max.apply(null, laneH.concat([160]));
  const laneBot = laneTop + maxLaneH;

  /* 结论带：★ 折叠泳道里的结论已经画在自己泳道内了，这里只放**其余的**
     （展开泳道的结论 + 无 source_intent 的零散 fact），避免同一张卡出现两次。 */
  const conclInline = {};
  lanes.forEach((L, n) => {
    if (collapsed[n] && L.intent.to_fact_id) conclInline[L.intent.to_fact_id] = 1;
  });
  const conclIds = [];
  (g.intents || []).forEach(i => {
    if (i.to_fact_id && FACTS[i.to_fact_id] && !conclInline[i.to_fact_id]) conclIds.push(i.to_fact_id);
  });
  otherLoose.forEach(id => { if (conclIds.indexOf(id) < 0) conclIds.push(id); });
  const conclRows = conclIds.length ? Math.ceil(conclIds.length / 6) : 0;
  const conclH = conclRows ? (conclRows * 46 + 30) : 0;

  const width = Math.max(lanesRight + 140, Math.min(TRIG_PER_ROW, trigList.length) * 88 + 40, 940);
  const height = laneBot + 46 + conclH + 60;

  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
  /* ★ 重画完让缩放跟随容器（面板开关/窗口变化都会走到这里）*/
  applyZoom();

  /* defs：箭头 */
  const defs = el("defs", {}, svg);
  const mkArrow = (id, color) => {
    const m = el("marker", {
      id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6.5,
      markerHeight: 6.5, orient: "auto-start-reverse",
    }, defs);
    el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }, m);
  };
  mkArrow("ar-trig", "var(--violet)");
  mkArrow("ar-prod", "var(--green)");
  mkArrow("ar-conv", "var(--gold)");
  mkArrow("ar-chain", "var(--gold)");

  const gEdge = el("g", { id: "edges" }, svg);
  const gNode = el("g", { id: "nodes" }, svg);
  /* 记录精确布局矩形：自检用它做几何断言（不依赖 getBBox，dump-dom 下为 0）*/
  const LAY = { cards: [], lanes: [], goal: null, origin: null, width: 0, height: 0,
                conclusions: [], trigs: [], covered: {}, chain: [] };
  window.__LAYOUT__ = LAY;
  /* 渲染期统计（放全局，避免被 runSelfCheck 的 const 遮蔽而抛 ReferenceError）*/
  window.__DIAG__ = { want: { trigger: 0, produce: 0, converge: 0 },
                      drawn: { trigger: 0, produce: 0, converge: 0 },
                      laneProduce: {}, laneCards: {} };
  const D = window.__DIAG__;

  /* ── 起点带：goal / origin 作为触发源芯片画在下面那条带里，不再单独占一行 ── */

  /* ── 触发带：origin / goal 排最前（它们是攻击链起点），其余按触发次数 ── */
  const trigIds = trigList;
  const trigPos = {};
  if (trigIds.length) {
    const bandY = trigBandY;
    const gt = el("g", { class: "trig-band" }, gNode);
    const lbl = el("text", { x: 20, y: bandY + 11, class: "lane-num" }, gt);
    lbl.textContent = `触发源（按被引用次数排序，共 ${countTriggers(g)} 条触发关系；` +
                      `origin 是题目起点）`;
    trigIds.forEach((id, k) => {
      const row = Math.floor(k / TRIG_PER_ROW), col = k % TRIG_PER_ROW;
      const x = 20 + col * 88, y = bandY + 20 + row * (TRIG_H + TRIG_GAP);
      const f = FACTS[id];
      const t = tagsOf(f);
      const cls = ["trig"];
      if (t.has("denial")) cls.push("denial");
      if (t.has("flag")) cls.push("flag");
      if (!f.source_intent) cls.push("orphan");
      if (id === "origin" || id === "goal") cls.push("special");
      if (!matches(f) && state.filter !== "running") cls.push("dim");
      const gg = el("g", { class: cls.join(" "), "data-fid": id }, gt);
      el("rect", { x, y, width: 80, height: TRIG_H, rx: 6, class: "trig-rect" }, gg);
      const tt = el("text", { x: x + 8, y: y + 17, class: "trig-t" }, gg);
      tt.textContent = `${id}${t.has("denial") ? " ✱" : (t.has("flag") ? " ★" : "")}`;
      bindNode(gg, "fact", id);
      trigPos[id] = { x: x + 40, y: y + TRIG_H / 2 };
      LAY.trigs.push({ id: id, x: x, y: y, w: 80, h: TRIG_H });
    });
    const more = trigMore;                 // 与高度预算用同一个值
    if (more > 0) {
      /* 说明文字落在**实际画出的芯片行**下面 */
      const actualRows = Math.ceil(trigIds.length / TRIG_PER_ROW);
      const my = bandY + 20 + actualRows * (TRIG_H + TRIG_GAP) + 30;   // 与芯片留 12px 气口
      const mt = el("text", { x: 20, y: my, class: "lane-num" }, gt);
      mt.textContent = `… 另有 ${more} 条触发关系未被列出（边仍完整绘制）`;
    }
  }

  /* ── 泳道 ── */
  const laneInfo = {};
  const inlineConclusions = {};
  lanes.forEach((L, n) => {
    const x = laneX[n];
    const w = laneW[n];
    const isCollapsed = collapsed[n];
    const h = laneH[n];
    const it = L.intent;
    const running = it.open;
    const stale = it.stale;

    const gl = el("g", { class: "lane" + (isCollapsed ? " collapsed" : ""), "data-lane": n }, gNode);
    const bgCls = ["lane-bg"];
    if (n % 2) bgCls.push("alt");
    if (running) bgCls.push("running");
    if (stale) bgCls.push("stale");
    if (isCollapsed) bgCls.push("folded");
    el("rect", { x, y: laneTop - 26, width: w, height: h + 30, rx: 10, class: bgCls.join(" ") }, gl);
    LAY.lanes.push({ n: n, x: x, y: laneTop - 26, w: w, h: h + 30,
                     intent: it.id, running: running, collapsed: isCollapsed,
                     cards: L.card_ids.length });

    const num = el("text", { x: x + 10, y: laneTop - 10, class: "lane-num" }, gl);
    /* ★ 泳道标签不能超过泳道宽度：折叠块只有 150px，而
       「方向 03 · i003 · 10-13 14:32:43」实测 **167px** —— 会糊到隔壁泳道上。
       所以统一用短标签（编号 + intent id），完整时间挂 tooltip。 */
    num.textContent = `${String(n + 1).padStart(2, "0")} · ${it.id}`;
    {
      const tip = el("title", {}, num);
      tip.textContent = `方向 ${String(n + 1).padStart(2, "0")} · ${it.id} · ` +
                        `创建 ${fmtTime(it.created_at)}` +
                        (it.concluded_at ? ` · 收敛 ${fmtTime(it.concluded_at)}` : " · 未收敛");
    }

    /* intent 盒子（折叠时窄） */
    const ibW = w - 20, ibX = x + 10, ibY = laneTop - 6;
    const iCls = ["ibox"];
    if (running) iCls.push("running");
    if (isCollapsed) iCls.push("folded");
    const ig = el("g", { class: iCls.join(" "), "data-iid": it.id, style: "cursor:pointer" }, gl);
    const fill = running ? "var(--amber-bg)" : "var(--bg2)";
    const stroke = running ? "var(--amber)" : "var(--line)";
    el("rect", { x: ibX, y: ibY, width: ibW, height: 56, rx: 8, fill, stroke, "stroke-width": 1.6 }, ig);
    const itt = el("text", { x: ibX + 10, y: ibY + 19, class: "ibox-t", fill: "var(--fg)",
                             "font-size": isCollapsed ? 11 : 12 }, ig);
    /* 折叠块只有 130px 内宽：「i004 · 未收敛（项目已停止）」实测 166px 会撞出去，
       所以折叠时状态缩成「未收敛」二字（"项目已停止"由整块灰掉 + 顶部计时器表达） */
    itt.textContent = `${it.id} · ${it.state_label}`;
    /* 描述：折叠时窄，用更小字号**并折行**（不靠截断，避免溢出）；展开时压到 16 字避免撞 worker 名 */
    if (isCollapsed) {
      const dw = wrapText(it.description, ibW - 20, 10, "400", 2);
      dw.lines.forEach((ln, k) => {
        const t2 = el("text", { x: ibX + 10, y: ibY + 36 + k * 12, class: "ibox-d",
                                fill: "var(--fg2)", "font-size": 10 }, ig);
        t2.textContent = ln;
      });
    } else {
      const idd = el("text", { x: ibX + 10, y: ibY + 36, class: "ibox-d", fill: "var(--fg2)",
                               "font-size": 11 }, ig);
      idd.textContent = oneLine(it.description, 16);
    }
    /* 折叠块里画不下 worker 名，改到 tooltip；展开块照旧画在右下角 */
    if (!isCollapsed) {
      const ix = el("text", { x: ibX + ibW - 10, y: ibY + 50, class: "ibox-x", fill: "var(--fg3)",
                              "text-anchor": "end" }, ig);
      ix.textContent = (it.worker ? "worker: " + shortId(it.worker).slice(-20) : "未认领") +
                       (stale ? " · 心跳超时" : "");
    } else {
      ig.setAttribute("data-tip-worker",
        (it.worker ? "worker: " + shortId(it.worker) : "未认领") + (stale ? " · 心跳超时" : ""));
    }
    bindNode(ig, "intent", it.id);

    /* ③ 该方向的耗时（实时跳动；收敛后或项目已停止后定格）
       ★ 折叠块只有 130px 内宽：右上角放不下「05:45（已收敛）」——
         实测它会画到 x+246，把标题糊掉。所以折叠时挪到**下一行**右对齐，
         并且去掉「（已收敛）」（块本身已灰、虚线、标了"已收敛"）。
       ★ 项目 stopped 时不再走秒：那些 intent 的 concluded_at 是空的
         （Cairn 停止时没填），但它们其实已经没人干了，继续涨会误导。 */
    const projStopped = (g.project && g.project.status !== "active");
    const laneTicking = it.running && !projStopped;
    /* 折叠块里省掉「（已收敛）」后缀 —— 块本身已灰掉+虚线，且宽度紧张 */
    const tmrText = intentTimeText(it, projStopped);
    const itm = el("text", {
      x: isCollapsed ? ibX + ibW - 8 : ibX + ibW - 10,
      y: isCollapsed ? ibY + 62 : ibY + 19,
      class: "ibox-t", "font-size": isCollapsed ? 10 : 12,
      fill: laneTicking ? "var(--amber)" : "var(--fg2)",
      "text-anchor": "end",
    }, ig);
    if (laneTicking) itm.setAttribute("data-itimer", it.id);   // 只有真的在跑的才每秒更新
    itm.textContent = tmrText;
    itm.setAttribute("title", laneTicking
      ? "已运行（墙钟时间，从 " + fmtTime(it.created_at) + " 起）"
      : (running
         ? "项目已停止，计时定格在停止前（DB 无「何时停的」字段，给不出精确值）"
         : "耗时 " + fmtDur(intentDuration(it)) + "（" + fmtTime(it.created_at) + " → " +
           fmtTime(it.concluded_at) + "）"));

    /* 内容区：折叠泳道画「fact 芯片网格 + 结论小方块」，展开泳道画卡片堆叠 */
    const ids = L.card_ids.filter(id => FACTS[id]);
    const laneTopY = laneTop - 26;                 // 泳道矩形上沿
    const contentTop = ibY + 64;                   // intent 盒（56 高）下方留 8px
    const busX = ibX + 13;
    laneInfo[n] = { x, w, ibX, ibW, ibY, busX, running, collapsed: isCollapsed,
                    intent: it, cards: {}, top: contentTop, bot: contentTop };

    if (isCollapsed) {
      /* ── 折叠：产出/搭车的 fact 变成小芯片，每行 CHIP_COLS 个 ── */
      const padX = 10;
      const chipW = Math.floor((w - padX * 2 - CHIP_GAP * (CHIP_COLS - 1)) / CHIP_COLS);
      let cy = contentTop + 4;
      ids.forEach((id, k) => {
        const col = k % CHIP_COLS, row = Math.floor(k / CHIP_COLS);
        const cxp = x + padX + col * (chipW + CHIP_GAP);
        const cyp = cy + row * (CHIP_H + CHIP_GAP);
        laneInfo[n].cards[id] = { x: cxp, y: cyp, w: chipW, h: CHIP_H };
        D.laneCards[it.id] = (D.laneCards[it.id] || 0) + 1;
        /* 产出边照画（从总线连到芯片），否则折叠后 C3 会"少 56 条边" */
        const isProd = (FACTS[id].source_intent === it.id);
        if (isProd) {
          D.want.produce++;
          D.laneProduce[it.id] = (D.laneProduce[it.id] || 0) + 1;
          if (state.showEdges) {
            el("path", {
              d: `M ${busX} ${ibY + 56} L ${busX} ${cyp + CHIP_H / 2} ` +
                 `L ${cxp - 3} ${cyp + CHIP_H / 2}`,
              class: "e-produce", "marker-end": "url(#ar-prod)", "data-edge": "produce",
              "data-from": it.id, "data-to": id, "data-elided": "1",
            }, gEdge);
            D.drawn.produce++;
          }
        }
        drawChip(gl, FACTS[id], cxp, cyp, chipW, CHIP_H);
        /* 登记到布局与覆盖表：芯片也是"这条 fact 的一个位置" */
        const box = { id: id, lane: n, x: cxp, y: cyp, w: chipW, h: CHIP_H, kind: "chip" };
        LAY.cards.push(box);
        LAY.covered[id] = (LAY.covered[id] || 0) + 1;
      });
      const rows = Math.ceil(ids.length / CHIP_COLS);
      let afterChips = cy + rows * (CHIP_H + CHIP_GAP) + 6;
      if (!ids.length) {
        const none = el("text", { x: x + padX, y: afterChips + 4, class: "lane-num" }, gl);
        none.textContent = "（本方向没产出 fact）";
        afterChips += 12;
      }
      /* 收敛结论：直接落在本泳道里（不再另设结论带，少一处跳读）*/
      const tf = it.to_fact_id;
      if (tf && FACTS[tf]) {
        drawConclMini(gl, FACTS[tf], x + padX, afterChips, w - padX * 2);
        inlineConclusions[it.id] = {x:x + padX,y:afterChips + 17,routeX:x + 2};
        LAY.covered[tf] = (LAY.covered[tf] || 0) + 1;
        laneInfo[n].bot = afterChips + 44;
      } else {
        laneInfo[n].bot = afterChips;
      }
    } else {
      let total = 0;
      const heights = ids.map(id => cardHeight(FACTS[id]));
      heights.forEach(hh => total += hh + 10);
      const laneBotY = laneTopY + h;               // 泳道矩形下沿
      let y = Math.max(contentTop, laneBotY - LANE_PAD_Y - total);

      ids.forEach((id, k) => {
        const f = FACTS[id], ch = heights[k];
        const cy = y;
        laneInfo[n].cards[id] = { x: laneInfo[n].x + CARD_X, y: cy, w: CARD_W, h: ch };
      /* 产出边：只有「这条 fact 的 source_intent 就是本方向」才算产出边。
         收敛结论 / 未归属的卡片是搭在本泳道里的，不能给它们画产出边。*/
      const isProduced = (f.source_intent === it.id);
      if (state.showEdges && isProduced) {
        el("path", {
          d: `M ${busX} ${ibY + 56} L ${busX} ${cy + ch / 2} L ${laneInfo[n].cards[id].x - 4} ${cy + ch / 2}`,
          class: "e-produce", "marker-end": "url(#ar-prod)", "data-edge": "produce",
          "data-from": it.id, "data-to": id,
        }, gEdge);
        D.drawn.produce++;
      }
        if (isProduced) D.want.produce++;
        D.laneCards[it.id] = (D.laneCards[it.id] || 0) + 1;
        if (isProduced) D.laneProduce[it.id] = (D.laneProduce[it.id] || 0) + 1;
        drawCard(gl, f, laneInfo[n].cards[id].x, cy, ch, n);
        LAY.cards.push({ id: id, lane: n, x: laneInfo[n].cards[id].x, y: cy,
                         w: CARD_W, h: ch, kind: "lane" });
        LAY.covered[id] = (LAY.covered[id] || 0) + 1;
        y = cy + ch + 10;
      });
      laneInfo[n].bot = y;
    }

    /* 收敛边：intent → 结论（折叠/展开都要画）*/
    if (it.to_fact_id && FACTS[it.to_fact_id] && state.showEdges) {
      const target = inlineConclusions[it.id];
      el("path", {
        d: target
          ? `M ${busX + 5} ${ibY + 56} L ${target.routeX} ${ibY + 56} L ${target.routeX} ${target.y} L ${target.x - 3} ${target.y}`
          : `M ${busX + 5} ${ibY + 56} L ${busX + 5} ${laneBot + 10}`,
        class: "e-converge", "data-edge": "converge", "data-from": it.id,
        "data-to": it.to_fact_id, "data-concl": it.to_fact_id,
        "marker-end": target ? "url(#ar-conv)" : null,
      }, gEdge);
      D.want.converge++; D.drawn.converge++;
    }
  });

  /* ── 结论带 ── */
  const conclPos = {};
  if (conclIds.length) {
    const gy = laneBot + 34;
    const gc = el("g", { class: "concl-band" }, gNode);
    const lb = el("text", { x: 20, y: gy - 8, class: "lane-num" }, gc);
    lb.textContent = "收敛结论与散点事实 · 来源缺失不会隐藏";
    conclIds.forEach((id, k) => {
      const row = Math.floor(k / 6), col = k % 6;
      const x = 20 + col * 150, y = gy + row * 46;
      const f = FACTS[id]; if (!f) return;
      const t = tagsOf(f);
      const cls = ["card", "concl"];
      if (t.has("flag")) cls.push("flag");
      if (t.has("denial")) cls.push("denial");
      if (!matches(f) && state.filter !== "running") cls.push("dim");
      const cg = el("g", { class: cls.join(" "), "data-cid": id }, gc);
      const isConclusion = f.is_conclusion_of.length > 0;
      el("rect", { x, y, width: 140, height: 38, rx: 7, class: "card-rect",
                   fill: isConclusion ? "var(--gold-bg)" : "var(--card)",
                   stroke: f.orphan_reason === "missing_source" ? "var(--amber)" : isConclusion ? "var(--gold)" : "var(--card-line)",
                   "stroke-width": 1.8 }, cg);
      const tt = el("text", { x: x + 8, y: y + 16, class: "concl-t" }, cg);
      tt.textContent = (f.orphan_reason === "missing_source" ? "⚠ 来源缺失 " : f.is_conclusion_of.length ? "✓ " : "· ") + id;
      const t2 = el("text", { x: x + 8, y: y + 30, class: "card-t2", fill: "var(--fg2)" }, cg);
      t2.textContent = oneLine(f.description, 16);
      bindNode(cg, "fact", id);
      conclPos[id] = { x: x + 70, y: y + 19 };
      LAY.conclusions.push({ id: id, x: x, y: y, w: 140, h: 38 });
      LAY.covered[id] = (LAY.covered[id] || 0) + 1;
    });
    /* 收敛边的终点连线 */
    if (state.showEdges) {
      (g.intents || []).forEach(it => {
        const p = conclPos[it.to_fact_id];
        if (!p || !it.to_fact_id) return;
        const pe = gEdge.querySelector(`[data-edge="converge"][data-concl="${it.to_fact_id}"]`);
        if (pe) {
          const n = (g.lanes || []).findIndex(L => L.intent.id === it.id);
          const busX = n >= 0 ? laneInfo[n].busX + 5 : 40;
          pe.setAttribute("d", `M ${busX} ${laneInfo[n] ? laneInfo[n].ibY + 56 : laneTop} ` +
                               `L ${busX} ${p.y} L ${p.x - 74} ${p.y}`);
          pe.setAttribute("marker-end", "url(#ar-conv)");
        }
      });
    }
  }


  /* ══════════ 有效链路横条（HTML，固定在视口下方）══════════
     ★ 早先把它画在 SVG 底部，结果在 7640px 宽、1226px 高的画布上落到 81% 深处，
       900px 的视口**根本看不到**，必须一路往下滚 —— 用户直接反馈"没看到"。
       它本来就是"总览"，不该藏在画布底部。改成独立的固定横条后永远可见。 */
  renderChainBar();

  /* ── 触发边：每条都必须画（origin 的触发边从 origin 卡片出发）── */
  if (state.showEdges) {
    (g.edges || []).forEach(e => {
      if (e.type !== "trigger") return;
      const b = laneInfo[laneOf(e.to)];
      if (!b) return;
      const tx = b.ibX + b.ibW / 2, ty = b.ibY;
      let a = trigPos[e.from];
      if (!a) {
        /* 该触发源没进芯片带（超出显示上限）：从顶部左侧拉一条线，边不丢 */
        a = { x: 60, y: trigBandY + 10 };
      }
      el("path", {
        d: `M ${a.x} ${a.y} L ${a.x} ${ty - 14} L ${tx} ${ty - 14} L ${tx} ${ty - 2}`,
        class: "e-trigger", "marker-end": "url(#ar-trig)", "data-edge": "trigger",
        "data-from": e.from, "data-to": e.to,
      }, gEdge);
      D.drawn.trigger++;
    });
  }
  /* ── 特殊节点：origin / goal 已作为起点芯片画在触发带上，这里不再重复 ── */
  LAY.width = width; LAY.height = height;
  LAY.conclIds = conclIds.slice();

  applyFiltering();
  applyTimeline();
  document.querySelectorAll("#tree [data-fid],#tree [data-cid]").forEach(node => {
    const id = node.dataset.fid || node.dataset.cid;
    node.dataset.evidence = FACTS[id].evidence_status;
    node.classList.toggle("is-new", state.recentAdded.has(id) && Date.now() < state.recentUntil);
  });
  runSelfCheck(width, height, laneInfo, trigPos, conclPos);
}
function laneOf(iid) {
  const L = (state.data.lanes || []).findIndex(x => x.intent.id === iid);
  return L;
}
function oneLine(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function cardHeight(f) {
  if (!f) return 50;
  const t = tagsOf(f);
  const lines = wrapText(cardTitle(f), CARD_W - CARD_PAD * 2 - 46, 12, "400", TITLE_MAX_LINES);
  let h = CARD_PAD                                              // 上内边距
        + 15                                                    // 第一行：id（+ 徽标）
        + (flagBadge(f) ? LINE_H : 0)                            // 徽标独占一行
        + lines.lines.length * LINE_H;
  if (t.has("flag") || (!f.source_intent)) {
    const add = wrapText(addendum(f), CARD_W - CARD_PAD * 2 - 46, 11, "400", ADD_MAX_LINES);
    if (add.lines[0]) h += 3 + add.lines.length * (LINE_H - 1);
  }
  return Math.max(h + CARD_PAD, 46);
}
function cardTitle(f) {
  let d = String(f.description || "").replace(/\s+/g, " ").trim();
  return d;
}
function addendum(f) {
  const t = tagsOf(f);
  const bits = [];
  if (t.has("flag") && f.flags && f.flags.length) bits.push("★ flag: " + f.flags[0]);
  if (!f.source_intent) bits.push(f.orphan_reason === "time_gap" ? "≈ 时间推测归属（不是推导边）" : "※ 未归属");
  return bits.join("  ");
}

function drawCard(parent, f, x, y, h, laneN) {
  const t = tagsOf(f);
  const cls = ["card"];
  if (t.has("flag")) cls.push("flag");
  if (t.has("receipt")) cls.push("receipt");
  if (t.has("dirfail")) cls.push("dirfail");
  if (!f.source_intent) cls.push("orphan");
  if (f.orphan_reason === "time_gap") cls.push("orphan-timegap");
  if (t.has("denial")) cls.push("denial");
  if (t.has("denial_P1")) cls.push("denial_P1");
  if (!matches(f) && state.filter !== "running") cls.push("dim");

  const g = el("g", { class: cls.join(" "), "data-fid": f.id }, parent);
  el("rect", { x, y, width: CARD_W, height: h, rx: 8, class: "card-rect" }, g);

  const idt = el("text", { x: x + CARD_PAD, y: y + CARD_PAD + 11, class: "card-id" }, g);
  idt.textContent = f.id;

  /* 第一行只放 id 与徽标（徽标右对齐）；标题从下一行开始，绝不与徽标重叠 */
  let rowY = y + CARD_PAD + 11;                    // 第一行基线
  const badgeText = flagBadge(f);
  if (badgeText) {
    const badge = el("text", { x: x + CARD_W - CARD_PAD, y: rowY,
                               class: "card-badge", "text-anchor": "end" }, g);
    badge.textContent = badgeText;
    rowY += LINE_H;                                // 徽标独占一行
  }

  const innerX = x + CARD_PAD + 40;
  const innerW = CARD_W - CARD_PAD * 2 - 46;
  const rr = wrapText(cardTitle(f), innerW, 12, "400", TITLE_MAX_LINES);
  rr.lines.forEach((ln, k) => {
    const tt = el("text", { x: innerX, y: rowY + k * LINE_H, class: "card-t" }, g);
    tt.textContent = ln;
  });
  let cy = rowY + rr.lines.length * LINE_H;
  const add = addendum(f);
  if (add) {
    const ar = wrapText(add, innerW, 11, "400", ADD_MAX_LINES);
    ar.lines.forEach((ln, k) => {
      const tt = el("text", { x: innerX, y: cy + 3 + k * (LINE_H - 1), class: "card-add" }, g);
      tt.textContent = ln;
    });
  }
  bindNode(g, "fact", f.id);
  return g;
}
function flagBadge(f) {
  const t = tagsOf(f);
  const b = [];
  if (t.has("flag")) b.push(TreeModel.evidenceLabel(f.evidence_status));
  else if (t.has("flag_mention")) b.push("flag 提及");
  if (t.has("receipt")) b.push("回执文本");
  if (f.orphan_reason === "missing_source") b.push("⚠ 来源方向不存在");
  if (t.has("dirfail")) b.push("✕ 方向失败");
  if (t.has("hardening")) b.push("⚠ 全称否定");
  else if (t.has("denial")) b.push("· 否定词");
  if (!f.source_intent && f.orphan_reason === "conclusion") b.push("◆ 收敛结论");
  else if (!f.source_intent && f.id !== "origin" && f.id !== "goal") b.push("※ 未归属");
  if (t.has("poison")) b.push("☠ 提示投毒");
  return b.join(" | ");
}
/* ── 折叠泳道里的 fact 芯片：只显示 id + 状态符号，点它看完整描述 ── */
function drawChip(parent, f, x, y, w, h) {
  const t = tagsOf(f);
  const cls = ["fchip"];
  if (t.has("flag")) cls.push("flag");
  if (t.has("receipt")) cls.push("receipt");
  if (t.has("dirfail")) cls.push("dirfail");
  if (!f.source_intent) cls.push("orphan");
  if (t.has("denial")) cls.push("denial");
  if (t.has("denial_P1")) cls.push("denial_P1");
  if (!matches(f) && state.filter !== "running") cls.push("dim");

  const g = el("g", { class: cls.join(" "), "data-fid": f.id }, parent);
  el("rect", { x: x, y: y, width: w, height: h, rx: 5, class: "fchip-rect" }, g);
  const mark = f.evidence_status === "rejected" || f.evidence_status === "negated" ? "✕" : t.has("flag") ? "★" : (t.has("hardening") ? "⚠" : (t.has("dirfail") ? "✕"
    : (t.has("denial") ? "·" : (!f.source_intent ? "※" : ""))));
  const tt = el("text", { x: x + 6, y: y + h - 6, class: "fchip-t" }, g);
  tt.textContent = f.id + (mark ? " " + mark : "");
  /* 悬停给一行摘要，避免完全靠点击 */
  const tip = el("title", {}, g);
  tip.textContent = f.id + " · " + oneLine(f.description, 90);
  bindNode(g, "fact", f.id);
  return g;
}

/* ── 折叠泳道里的「收敛结论」小方块 ── */
function drawConclMini(parent, f, x, y, w) {
  const t = tagsOf(f);
  const cls = ["card", "concl", "mini"];
  if (t.has("flag")) cls.push("flag");
  if (t.has("denial")) cls.push("denial");
  if (!matches(f) && state.filter !== "running") cls.push("dim");
  const g = el("g", { class: cls.join(" "), "data-cid": f.id }, parent);
  el("rect", { x: x, y: y, width: w, height: 34, rx: 6, class: "card-rect",
               fill: "var(--gold-bg)", stroke: "var(--gold)", "stroke-width": 1.6 }, g);
  const tt = el("text", { x: x + 7, y: y + 14, class: "concl-t" }, g);
  tt.textContent = "✓ " + f.id + " 结论";
  const t2 = el("text", { x: x + 7, y: y + 27, class: "card-t2", fill: "var(--fg2)" }, g);
  t2.textContent = oneLine(f.description, 10);
  const tip = el("title", {}, g);
  tip.textContent = "收敛结论 " + f.id + " · " + oneLine(f.description, 110);
  bindNode(g, "fact", f.id);
  return g;
}

/* ══════════ 有效链路横条（HTML，固定在视口下方）══════════
   ★ 为什么不用 SVG：早先画在画布底部，7640×1226 的画布上它落在 81% 深处，
     900px 视口**完全看不到**，必须一路往下滚 —— 用户直接说"没看到"。
     它本质是"总览"，就该固定在视口里，而不是藏进可滚动画布。 */
function renderChainBar() {
  const bar = document.getElementById("chainbar");
  const hd = document.getElementById("chainbar-hd");
  const body = document.getElementById("chainbar-body");
  if (!bar || !hd || !body) return;
  const g = state.data;
  const chain = (g && Array.isArray(g.chain)) ? g.chain : [];
  if (!state.showChain || !chain.length) { bar.classList.add("hide"); return; }
  bar.classList.remove("hide");
  hd.textContent = "";
  body.textContent = "";
  const S = g.summary || {};

  const t = document.createElement("span");
  t.className = "t";
  t.textContent = `里程碑 · ${chain.length} 个（按时间，不是因果链）`;
  hd.appendChild(t);
  const s = document.createElement("span");
  s.className = "s";
  s.textContent = `推进信号 ${S.breakthrough_intents || 0} 个（文本）` +
    `　未推进/已合并 ${S.deadend_intents || 0} 个` +
    `　候选 flag 不等于得分；点击节点可追踪实际推导`;
  hd.appendChild(s);
  const btn = document.createElement("button");
  btn.textContent = "收起";
  btn.title = "收起链路横条（工具栏「有效链路」可再打开）";
  btn.addEventListener("click", () => {
    state.showChain = false;
    const b = document.getElementById("btnChain");
    if (b) b.classList.remove("on");
    renderChainBar();
  });
  hd.appendChild(btn);

  chain.forEach((c, i) => {
    if (i) {
      const a = document.createElement("div");
      a.className = "clink";
      a.textContent = "·";
      body.appendChild(a);
    }
    const f = FACTS[c.id] || {};
    const d = document.createElement("div");
    d.className = "cnode";
    d.setAttribute("data-cid", c.id);
    d.setAttribute("data-chain-node", "1");
    if (c.is_flag) d.classList.add("flag");
    if (c.is_conclusion) d.classList.add("concl");
    if (state.pins.has(c.id)) d.classList.add("pinned");
    if ((c.tags || []).indexOf("denial") >= 0) d.classList.add("denial");
    if (!matches(f) && state.filter !== "running") d.classList.add("dim");
    d.title = c.id + " · " + oneLine(f.description || "", 200);

    const h = document.createElement("div");
    h.className = "h";
    const idx = document.createElement("span"); idx.className = "idx"; idx.textContent = (i + 1) + ".";
    const id = document.createElement("span"); id.className = "id"; id.textContent = c.id;
    const bdg = document.createElement("span");
    bdg.className = "bdg";
    bdg.textContent = (c.is_flag ? TreeModel.evidenceLabel(c.evidence_status) : "") +
      (c.is_conclusion ? (c.is_flag ? " ✓" : "✓ 结论") : "") + (state.pins.has(c.id) ? " 📌" : "");
    h.appendChild(idx); h.appendChild(id); h.appendChild(bdg);

    const dsc = document.createElement("div");
    dsc.className = "dsc";
    dsc.textContent = oneLine(c.label || f.description || "", 60);

    const mta = document.createElement("div");
    mta.className = "mta";
    mta.textContent = (c.source_intent ? "← " + c.source_intent + " · " : "") +
      fmtTime(c.created_at) + (c.why && c.why.length ? " · " + c.why.join("/") : "");

    const pin = document.createElement("span");
    pin.className = "pin";
    pin.setAttribute("data-pin", c.id);
    pin.textContent = state.pins.has(c.id) ? "取消置顶" : "置顶";
    pin.addEventListener("click", (ev) => { ev.stopPropagation(); togglePin(c.id); });

    d.appendChild(h); d.appendChild(dsc); d.appendChild(mta); d.appendChild(pin);
    d.addEventListener("click", () => selectNode("fact", c.id));
    body.appendChild(d);
  });
}

/* ── 手动置顶链路节点（存 localStorage，按项目记忆）── */
function pinKey() {
  const g = state.data;
  return "cairn-pins:" + ((g && g.project && g.project.id) || "-");
}
function loadPins() {
  state.pins = new Set();
  try {
    const raw = localStorage.getItem(pinKey());
    if (raw) JSON.parse(raw).forEach(x => state.pins.add(x));
  } catch (e) { /* 忽略：localStorage 不可用不影响主功能 */ }
}
function savePins() {
  try { localStorage.setItem(pinKey(), JSON.stringify(Array.from(state.pins))); } catch (e) {}
}
function togglePin(id) {
  if (state.pins.has(id)) state.pins.delete(id); else state.pins.add(id);
  savePins();
  render();                              // 重画（芯片上的 📌 与按钮文案都要变）
}

function countTriggers(g) { return (g.edges || []).filter(e => e.type === "trigger").length; }
function topTriggers(g, cap) {
  const m = new Map();
  (g.edges || []).forEach(e => { if (e.type === "trigger") m.set(e.from, (m.get(e.from) || 0) + 1); });
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap).map(x => x[0]);
}
/* origin / goal 永远排最前（攻击链起点，即使它们没有触发边也要显示），其余按触发次数降序 */
function topTriggersWithSpecial(g, cap) {
  const m = new Map();
  (g.edges || []).forEach(e => { if (e.type === "trigger") m.set(e.from, (m.get(e.from) || 0) + 1); });
  const special = ["origin", "goal"].filter(id => FACTS[id]);
  const rest = Array.from(m.keys()).filter(id => id !== "origin" && id !== "goal")
    .sort((a, b) => (m.get(b) - m.get(a)) || a.localeCompare(b));
  return special.concat(rest).slice(0, Math.max(cap, special.length));
}

/* ── 交互绑定 ── */
