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

# 规矩
1. 只在【确有未被覆盖的新方向】时才派任务。已经在跑的、已经完成的方向不要重复派。
2. 一条任务必须【能由一个执行者独立完成】，不要写"继续深入"这种空话。
3. 一条任务只做一件事。要同时做两件事就拆成两条。
4. 最多派 {max_new} 条。任务之间尽量不依赖同一个前提。
5. 如果目标已达成、或所有方向都已跑过且无进展，返回 done=true 并说明卡在哪。

# 输出
只输出一个 JSON 对象，不要任何解释文字：
{{"done": false,
  "reason": "一句话说明你为什么派这些",
  "tasks": [{{"title": "短标题", "detail": "执行者要做什么、依据哪条事实、怎么算完成"}}]}}
"""


@dataclass
class Task:
    title: str
    detail: str
    id: str = ""
    status: str = "pending"      # pending / running / done / failed
    result: str = ""
    facts: list = field(default_factory=list)


@dataclass
class Plan:
    done: bool
    reason: str
    tasks: list[Task]


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
        if title and detail:
            tasks.append(Task(title=title, detail=detail))
    return Plan(done=bool(data.get("done")), reason=str(data.get("reason") or ""), tasks=tasks)


def render_tasks(tasks: list[Task]) -> str:
    if not tasks:
        return "(还没有任何任务)"
    return "\n".join("- [%s] %s：%s" % (t.status, t.title, (t.result or "")[:120]) for t in tasks)
