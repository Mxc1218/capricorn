"""执行态 —— 把"任务 + 心跳"折叠成前端能直接显示的一个标签。

为什么单独抽出来：
    「正在验证 / 待认领 / 失联 / 已合并」这套判断，前端、CLI、报告三处都要用。
    放在前端里写一遍，等于让三个地方各维护一套判断 —— 迟早对不上。
    所以判断只在 Python 里做一次，输出是纯数据。

两条硬规矩（来自旧前端那套的教训）：
    1. 不编造时刻。没有 started_at 就说"未知"，不拿 created 顶替。
    2. 失联是【观测到的】：心跳超过阈值没动才算，不是猜的。
"""
from __future__ import annotations

import time

STALE_AFTER = 90.0     # 心跳超过这么久没动 → 失联

LABELS = {
    "pending": "待认领",
    "running": "正在验证",
    "stalled": "验证活动失联",
    "done": "已收敛",
    "failed": "已失败",
    "merged": "已合并",
}

TONES = {              # 前端用它上色
    "pending": "grey",
    "running": "amber",
    "stalled": "red",
    "done": "green",
    "failed": "red",
    "merged": "violet",
}


def task_view(task, now: float | None = None, heartbeat: float | None = None,
              stale_after: float = STALE_AFTER) -> dict:
    """返回 {state, label, tone, wait, run, total, open, stale_for}。

    heartbeat: 这条任务最近一次心跳的时间（来自执行者的实时状态文件）。
               没有就传 None —— 那就只能说"不知道"，不能假装健康。
    """
    now = now or time.time()
    created = getattr(task, "created", 0) or 0
    started = getattr(task, "started_at", 0) or 0
    ended = getattr(task, "ended_at", 0) or 0
    status = getattr(task, "status", "pending") or "pending"

    state = status
    stale_for = 0.0
    if status == "running":
        # 心跳来源按可靠性排序：显式心跳 > 任务最后一次更新 > 开跑时刻。
        # 一个都没有就不判「失联」—— 没有观测就说不知道，这是旧前端那条规矩。
        ref = heartbeat or getattr(task, "updated", 0) or started or created
        if ref and (now - ref) > stale_after:
            state = "stalled"
            stale_for = now - ref

    end = ended or now
    wait = max(0.0, (started or end) - created) if created else 0.0
    run = max(0.0, (ended or now) - started) if started else 0.0
    total = max(0.0, end - created) if created else 0.0

    return {
        "state": state,
        "label": LABELS.get(state, state),
        "tone": TONES.get(state, "grey"),
        "wait": round(wait, 1),
        "run": round(run, 1),
        "total": round(total, 1),
        "open": not ended and status in ("pending", "running"),
        "stale_for": round(stale_for, 1),
    }


def fact_tone(evidence_status: str) -> str:
    """事实的可信度 → 颜色。未核验的不能看起来像已确认。"""
    return {
        "accepted": "green",
        "candidate": "amber",
        "rejected": "red",
        "negated": "grey",
        "unverified": "blue",
    }.get(evidence_status or "unverified", "grey")
