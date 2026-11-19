
"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   Cairn 攻击树只读前端 —— 零外部依赖，纯原生 DOM + 内联 SVG
   ══════════════════════════════════════════════════════════════════════════ */

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (s) => document.querySelector(s);

/* ── 布局常量 ── */
const LANE_W = 424, CARD_W = 366, CARD_X = 56;      // 展开泳道的宽度/卡片宽/卡片左内边距
const COLLAPSED_W = 150;                            // ★ 收敛泳道折叠后的宽度
const CHIP_H = 20, CHIP_GAP = 5, CHIP_COLS = 2;     // ★ 折叠块里的 fact 芯片
const CARD_PAD = 9, LINE_H = 16, TITLE_MAX_LINES = 3, ADD_MAX_LINES = 3;
const LANE_PAD_Y = 58, LANE_GAP = 20;
const TRIG_H = 26, TRIG_GAP = 7, TRIG_PER_ROW = 14;

const state = {
  projects: [], data: null, filter: "all", query: "",
  selected: null, showEdges: true, live: true, paused: false,
  collapse: true,                       // ★ 默认折叠已收敛方向
  showChain: false,                      // ★ 默认在底部显示有效链路
  pins: new Set(),                      // ★ 手动置顶的链路节点（存 localStorage）
  view: "reasoning", reasonMode: "success", reasonReceipt: "all", reasonZoom: "auto", traceMode: null, trace: null, recentAdded: new Set(), recentUntil: 0, refreshBusy: false,
  pid: null,                            // ★ 当前项目
  projQuery: "",                        // ★ 项目列表筛选词
  projOpen: {},                         // ★ 各分组展开状态
  tl: 1000, playing: false, playTimer: null, hitIds: new Set(),
  /* ★ 默认收起推理树的辅助区块（图例/说明/缩略导航）。
     理由：实测它们合计 288px，而 #main 只有 391px —— 不收的话树只剩 103px，
     基本看不见。工具栏「设置区」或快捷键 S 可随时展开。 */
  settingsCollapsed: true,
};

/* ── 小工具 ── */
const esc = (s) => String(s == null ? "" : s);
function el(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
function fmtTime(iso) {
  if (!iso) return "—";
  const raw = String(iso);
  const normalized = /^\d{4}-\d{2}-\d{2}T/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw + "Z" : raw;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
  }).formatToParts(date).map(part => [part.type,part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function shortId(s) { return String(s || "").replace(/_/g, "_"); }

/* ── 计时器 ──────────────────────────────────────────────────────────
   ★ 基准是**服务端**时间（server_now_ts + 单调时钟推进），
     不用浏览器本机时钟 —— 否则本机与被测机器不同步时，计时器会直接是错的。
   口径：墙钟时间（created → 现在）。DB 没有心跳历史表，算不出净工作时长。 */
let _clock = { serverAt: null, perfAt: null };

function setClock(serverNowTs) {
  if (typeof serverNowTs === "number" && isFinite(serverNowTs)) {
    _clock.serverAt = serverNowTs;
    _clock.perfAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
  }
}
function nowTs() {
  if (_clock.serverAt === null) return Date.now() / 1000;   // 兜底：还没有数据时用本机时钟
  const dev = (typeof performance !== "undefined" ? performance.now() : Date.now());
  return _clock.serverAt + (dev - _clock.perfAt) / 1000;
}
/* 把秒数转成「1天02:03:04」/「02:03:04」/「03:04」/「45.2秒」 */
function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "—";
  const s = Math.floor(sec);
  if (s < 60) return sec.toFixed(1) + "秒";
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60), ss = s % 60;
  const p2 = (x) => String(x).padStart(2, "0");
  if (d > 0) return `${d}天${p2(h)}:${p2(m)}:${p2(ss)}`;
  if (h > 0) return `${p2(h)}:${p2(m)}:${p2(ss)}`;
  return `${p2(m)}:${p2(ss)}`;
}
/* 项目是否已被 Cairn 停止。
   ★ stopped 项目里仍可能有 intent 的 concluded_at 为空（Cairn 停止时不会去填），
     所以「有方向 running」≠「真的在跑」。计时器必须看项目状态，否则会无限涨。 */
function projectStopped() {
  const g = state.data;
  return !!(g && g.project && g.project.status !== "active");
}
/* 未收敛方向：created → 现在（项目已停止时改为定格语义） */
function intentElapsed(it) { return it && it.ts != null ? nowTs() - it.ts : null; }
/* 已收敛方向：created → concluded。后端没给 duration_s 时自己从 ts/concluded_ts 算 */
function intentDuration(it) {
  if (!it) return null;
  if (it.duration_s != null) return it.duration_s;
  if (it.ts != null && it.concluded_ts != null && it.concluded_ts >= it.ts)
    return it.concluded_ts - it.ts;
  return null;
}
/* 一个方向的时长文本。
   frozen=true（项目已停止）时，未收敛方向不再走秒，改标「已停止」——
   因为那个数字已经没有意义了。 */
function intentTimeText(it, frozen) {
  if (!it) return "—";
  const row=typeof executionSnapshot==='function'?executionSnapshot().byId.get(it.id):null;
  if(row)return (row.timingSource==='recorded'?'累计验证 ':'观测累计 ')+fmtDur(row.cumulativeSeconds);
  if (!it.open) return '创建至收敛跨度 '+fmtDur(intentDuration(it));
  if (frozen) {
    const end = state.data.summary.last_activity_ts;
    return end && it.ts != null ? "跨度 " + fmtDur(Math.max(0, end - it.ts)) : "时间未知";
  }
  return "跨度 " + fmtDur(intentElapsed(it));
}

/* ── 文本测量 + 折行（CJK 逐字换行，ASCII 按词/URL 边界）── */
// Canvas measurement avoids write→SVG getComputedTextLength→layout for every glyph.
const textWidthCache=new Map(),wrappedTextCache=new Map();
let textMeasureContext=null,textMeasureFamily=null;
function rememberText(cache,key,value,limit){
  if(cache.size>=limit)cache.delete(cache.keys().next().value);
  cache.set(key,value);return value;
}
function measure(txt,size=12,weight=400,family){
  txt=String(txt);const actualSize=size||12,actualWeight=weight||400;
  if(!textMeasureFamily)textMeasureFamily=getComputedStyle(document.body).fontFamily||'sans-serif';
  const actualFamily=!family||family==='inherit'?textMeasureFamily:family;
  const key=JSON.stringify([actualSize,actualWeight,actualFamily,txt]);
  if(textWidthCache.has(key))return textWidthCache.get(key);
  if(!textMeasureContext)textMeasureContext=document.createElement('canvas').getContext('2d');
  let width=0;
  if(textMeasureContext){textMeasureContext.font=`${actualWeight} ${actualSize}px ${actualFamily}`;width=textMeasureContext.measureText(txt).width;}
  else for(const ch of txt)width+=ch.charCodeAt(0)>0x2e80?actualSize:actualSize*.55;
  return txt.length<=2048?rememberText(textWidthCache,key,width,4096):width;
}
if(document.fonts?.addEventListener)document.fonts.addEventListener('loadingdone',()=>{
  textWidthCache.clear();wrappedTextCache.clear();textMeasureFamily=null;state.reasonRenderSignature=null;
  if(state.data){if(state.view==='reasoning')renderReasoning();else if(state.view==='graph')render();}
});
const CJK = (ch) => ch.charCodeAt(0) > 0x2e80;
const URLISH = /[A-Za-z0-9_\-\.\/:%?=&~#]/;

function wrapText(text,maxW,size,weight,maxLines){
  const source=String(text==null?'':text),key=JSON.stringify([source,maxW,size,weight,maxLines]);
  let result=wrappedTextCache.get(key);
  if(!result){result=computeWrappedText(source,maxW,size,weight,maxLines);if(source.length<=2048)rememberText(wrappedTextCache,key,result,1500);}
  return {lines:result.lines.slice(),hasMore:result.hasMore};
}
function computeWrappedText(text, maxW, size, weight, maxLines) {
  const t = String(text == null ? "" : text);
  if (!t) return { lines: [""], hasMore: false };
  if (measure(t, size, weight) <= maxW) return { lines: [t], hasMore: false };
  const lines = [];
  let cur = "", over = false;
  const pushCur = () => { if (cur !== "") { lines.push(cur); cur = ""; } };
  let i = 0;
  while (i < t.length) {
    if (lines.length > maxLines) { over = true; break; }
    let run;
    if (CJK(t[i]) || t[i] === " ") run = t[i];
    else {
      let j = i;
      while (j < t.length && URLISH.test(t[j])) j++;
      run = (j > i) ? t.slice(i, j) : t[i];
    }
    const cand = cur + run;
    if (measure(cand, size, weight) <= maxW) cur = cand;
    else {
      if (cur === "") {                       // 整段 run 都放不进 → 逐字符硬切
        let k = 0, acc = "";
        while (k < run.length && measure(acc + run[k], size, weight) <= maxW) { acc += run[k]; k++; }
        if (k === 0) k = 1;
        pushCur(); cur = run.slice(0, k);
        i += k; continue;
      }
      pushCur();
      if (run === " ") { i++; continue; }
      cur = run; i += run.length; continue;
    }
    i += run.length;
  }
  pushCur();
  if (lines.length > maxLines) { lines.length = maxLines; over = true; }
  return { lines, hasMore: over };
}

/* ── 应用数据 ── */
let FACTS = {}, INTENTS = {};

function tagsOf(f) { return new Set(f.tags || []); }

/* 过滤判定：返回 true=命中（高亮），false=变暗 */
function matches(f) {
  const t = tagsOf(f);
  const q = state.query.trim().toLowerCase();
  if (q && !(f.description || "").toLowerCase().includes(q) && !f.id.toLowerCase().includes(q))
    return false;
  switch (state.filter) {
    case "all": return true;
    case "flag": return t.has("flag");
    case "receipt": return t.has("receipt");
    case "accepted": return f.evidence_status === "accepted_receipt";
    case "rejected": return f.evidence_status === "rejected";
    case "hardening": return t.has("hardening");
    case "denial": return t.has("denial");
    case "orphan": return !f.source_intent || f.orphan_reason === "missing_source";
    case "running": return false;   // 由 intent 级过滤处理
    default: return true;
  }
}

/* ══════════════════════ 渲染 ══════════════════════ */
/* ══════════ 缩放：跟随容器宽度 ══════════
   ★ 问题一（真正的原因）：`#btnFit` 只在**点的那一瞬间**量一次 stage.clientWidth，
   之后无论详情面板打开/收起、窗口 resize，画布都不再跟随 —— 画布停在旧宽度，
   看起来像浮在外面、没合进主树。现在由 ResizeObserver 驱动，容器一变就重算。
   ★ 问题二：默认**不缩放**时画布 4882px 塞进 1174px 容器，会被截掉 3/4。
   但把 4882px 缩进 1174px 只有 0.24 倍，字全糊了 —— 所以**默认不缩放**，
   「适配宽度」留给"要看全貌"的场景（截图/概览），1:1 才是读细节的常态。
   ?fit=1 可以强制一进来就适配。 */
let fitMode = false;

function setFitMode(on, btn) {
  fitMode = on;
  const b = btn || document.getElementById("btnFit");
  if (b) {
    b.classList.toggle("on", fitMode);
    b.textContent = fitMode ? "还原尺寸" : "适配宽度";
    b.title = fitMode ? "当前：整张图缩进可视宽度（再点回到 1:1 精读）"
                      : "把整张图缩放进当前可视宽度（看全貌用；字会变小）";
  }
  applyZoom();
}

function applyZoom() {
  const svg = document.getElementById("tree");
  const stage = document.getElementById("stage");
  if (!svg || !stage) return;
  const w = svg.getAttribute("width") * 1, h = svg.getAttribute("height") * 1;
  if (!w || !h) return;
  if (!fitMode) {
    /* 原始尺寸：画布比容器宽就横向滚动 */
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    svg.style.width = "";
    svg.style.height = "";
    return;
  }
  const avail = Math.max(160, stage.clientWidth - 4);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = avail + "px";
  svg.style.height = (avail * h / w) + "px";
}
