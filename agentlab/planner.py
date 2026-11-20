"""规划者 —— 只做一件事：读黑板，产出【可以独立执行】的任务清单。

它不碰工具、不做侦察。理由和 Cairn 那套一致：
把"判断往哪打"和"动手去打"拆开，前者要全局视角，后者要专注单点；
合在一起时，模型会一边看全局一边抠细节，两头都做不好。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

PROMPT = """你是这次行动的**规划者**。你不执行任何侦察或利用，只决定"接下来派谁去做什么"。

# 目标
{goal}

# 黑板上已确认的事实
{board}

# 你手上已有的任务及状态
{tasks}

# 你要回答的问题
不是"还剩多少时间"，而是 **“现在最值得推的是哪条方向”**。
时间由调度器硬性管理，你不用考虑；你要看的是每条方向：依据是否成立、有没有在产出、失败了什么。

# 规矩
1. 只在【确有未被覆盖的新方向】时才派任务。已经在跑的、已经完成的方向不要重复派。
2. 一条任务必须【能由一个执行者独立完成】，不要写"继续深入"这种空话。
3. 一条任务只做一件事。要同时做两件事就拆成两条。
4. 最多派 {max_new} 条。任务之间尽量不依赖同一个前提。
5. 每条任务必须写 from：依据黑板上的哪几条事实（写事实 id，如 f002）。没有依据说明你在瞎猜。
6. 每条任务必须写 priority：1=立刻做（会插到队首）、2=正常、3=可以等。**最多 2 条能给 1**。
7. 如果某条排队中的方向已经被新事实取代/明显重复，用 cancel 列出它并写原因。
8. 如果某条排队中的方向现在更重要了，用 raise 列出它（升到 P1）。
9. 如果目标已达成、或所有方向都已跑过且无进展，返回 done=true 并说明卡在哪。

# 输出
只输出一个 JSON 对象，不要任何解释文字：
{{"done": false,
  "reason": "一句话说明你为什么这么排",
  "tasks": [{{"title": "短标题", "detail": "执行者要做什么、怎么算完成", "from": ["f002"], "priority": 2}}],
  "cancel": [{{"id": "t013", "why": "与 t011 覆盖同一入口，且 t011 已在跑"}}],
  "raise": [{{"id": "t009", "why": "新事实显示这是唯一未验证的入口"}}]}}
"""


@dataclass
class PlannedTask:
    title: str
    detail: str
    from_facts: list = field(default_factory=list)
    id: str = ""
    status: str = "pending"      # pending / running / done / failed
    result: str = ""
    priority: int = 2            # 1=立刻 2=正常 3=可以等


@dataclass
class Plan:
    done: bool
    reason: str
    tasks: list[PlannedTask]
    cancel: list = field(default_factory=list)   # [{"id": "t013", "why": "..."}]
    raise_: list = field(default_factory=list)   # [{"id": "t009", "why": "..."}]


def parse_plan(text: str) -> Plan:
    """从模型输出里抠出 JSON。模型偶尔会包代码块或加前言，这里容忍一下。"""
    raw = (text or "").strip()
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return Plan(done=False, reason="规划者没有返回合法 JSON", tasks=[])
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return Plan(done=False, reason="规划者返回的 JSON 解析失败", tasks=[])

    tasks = []
    for item in (data.get("tasks") or [])[:5]:
        title = str(item.get("title") or "").strip()
        detail = str(item.get("detail") or "").strip()
        refs = [str(x) for x in (item.get("from") or []) if str(x).strip()]
        try:
            prio = int(item.get("priority") or 2)
        except Exception:
            prio = 2
        prio = min(3, max(1, prio))
        if title and detail:
            tasks.append(PlannedTask(title=title, detail=detail, from_facts=refs, priority=prio))
    cancel = [c for c in (data.get("cancel") or []) if isinstance(c, dict) and c.get("id")]
    raise_ = [r for r in (data.get("raise") or []) if isinstance(r, dict) and r.get("id")]
    return Plan(done=bool(data.get("done")), reason=str(data.get("reason") or ""),
                tasks=tasks, cancel=cancel, raise_=raise_)


def render_tasks(tasks, board=None, now: float | None = None) -> str:
    """把已有任务摊给规划者看。

    ★ 这里刻意【不给时间预算】。规划者要判断的是"这条方向值不值得再推"，
      不是"还剩几分钟"。时间由代码硬约束（单任务 600 秒、总预算到点收工）。
      给它的有价值信号是：有没有在产出、依据的是什么、产出/失败了几条。
    """
    if not tasks:
        return "(还没有任何任务)"
    import time as _t

    now = now or _t.time()
    fact_ts = {}
    fact_text = {}
    if board is not None:
        for f in board.all():
            fact_ts[f.id] = f.ts
            fact_text[f.id] = (f.content or "").replace("\n", " ")[:60]

    lines = []
    for t in tasks:
        head = "- [%s] %s" % (t.status, t.title)
        if getattr(t, "priority", 2) != 2:
            head += " (P%d)" % t.priority
        lines.append(head)

        refs = getattr(t, "from_facts", []) or []
        if refs:
            lines.append("    依据：" + "；".join(
                "%s(%s)" % (r, fact_text.get(r, "?")) for r in refs))
        produced = getattr(t, "produced", []) or []
        if produced:
            # 最近一次产出的时间 —— 用来判断"还在产出"还是"卡住了"
            last = max((fact_ts.get(p, 0) for p in produced), default=0)
            age = int(now - last) if last else None
            lines.append("    产出 %d 条%s" % (
                len(produced), ("，最近一次 %d 秒前" % age) if age is not None else ""))
        elif t.status in ("done", "failed"):
            lines.append("    产出 0 条")
        if t.status == "running" and getattr(t, "started_at", 0):
            lines.append("    正在跑，已跑 %d 秒" % int(now - t.started_at))
        if t.result:
            # 不再截断到 100 字 —— 失败的细节是它判断"要不要重试"的唯一依据
            lines.append("    结果：" + (t.result or "").replace("\n", " ")[:300])
    return "\n".join(lines)