"""任务 —— 从"内存里的一个 list"升成和事实平级的一等公民。

为什么必须持久化：
    没有独立的 id 和生命周期，就画不出因果 —— 谁派了谁、谁产出了谁全靠日志猜。
    一旦每条任务都有 id / from_facts / produced，事实与任务之间的边就成立了。

存储和黑板同一套哲学：JSONL，只追加。更新 = 再写一条同 id 的记录，读时后写的覆盖先写的。
这样任何时刻进程被杀，已发生的都还在，最多丢最后一条。
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Task:
    id: str
    title: str
    detail: str
    from_facts: list[str] = field(default_factory=list)   # 派这条任务的依据
    status: str = "pending"                               # pending/running/done/failed/merged
    result: str = ""
    produced: list[str] = field(default_factory=list)     # 产出的事实 id
    # ── 计时（M1）：没有这三个时间，前端画不出「已等待 / 在跑多久」 ──
    created: float = 0.0
    started_at: float = 0.0      # 执行者真正开始跑的时刻
    ended_at: float = 0.0        # 结束时刻（完成/失败/被合并）
    updated: float = 0.0
    # ── 协作（M1）：谁在跑、被谁合并 ──
    worker: str = ""             # 执行者标识（并发时区分）
    merged_into: str = ""        # 被合并到哪条任务（画 merge 边用）
    merged_from: list[str] = field(default_factory=list)


class TaskStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _append(self, task: Task):
        task.updated = time.time()
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(task), ensure_ascii=False) + "\n")

    def add(self, title: str, detail: str, from_facts: list[str] | None = None) -> Task:
        existing = self.all()
        nums = [int(t.id[1:]) for t in existing if t.id[1:].isdigit()]
        task = Task(
            id="t%03d" % (max(nums) + 1 if nums else 1),
            title=title,
            detail=detail,
            from_facts=[f for f in (from_facts or []) if f],
            created=time.time(),
        )
        self._append(task)
        return task

    def update(self, task: Task) -> None:
        self._append(task)

    def all(self) -> list[Task]:
        """折叠：同一个 id 后写的覆盖先写的。"""
        if not self.path.exists():
            return []
        folded: dict[str, Task] = {}
        order: list[str] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                t = Task(**data)
            except Exception:
                continue
            if t.id not in folded:
                order.append(t.id)
            folded[t.id] = t
        return [folded[i] for i in order]

    def get(self, tid: str) -> Task | None:
        for t in self.all():
            if t.id == tid:
                return t
        return None

    def elapsed(self, t: Task, now: float | None = None) -> dict:
        """返回三种时长，前端直接拿去显示，不做二次计算。

        wait  = 从派发到开始等待的时间（说明调度有没有卡）
        run   = 真正在跑的时间
        total = 从派发到现在/结束
        """
        now = now or time.time()
        end = t.ended_at or now
        return {
            "wait": max(0.0, (t.started_at or end) - t.created) if t.created else 0.0,
            "run": max(0.0, (t.ended_at or now) - t.started_at) if t.started_at else 0.0,
            "total": max(0.0, end - t.created) if t.created else 0.0,
            "open": not t.ended_at,
        }

    def render(self) -> str:
        tasks = self.all()
        if not tasks:
            return "(还没有任务)"
        lines = []
        for t in tasks:
            src = (" ←" + ",".join(t.from_facts)) if t.from_facts else ""
            out = (" →" + ",".join(t.produced)) if t.produced else ""
            lines.append("- [%s] %s%s%s：%s" % (t.status, t.title, src, out, (t.result or "")[:100]))
        return "\n".join(lines)
