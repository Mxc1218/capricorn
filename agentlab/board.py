"""黑板 —— 跨轮次、跨运行共享的事实清单。

为什么需要它：
    现在每一轮都是从零开始：上一轮发现了什么，只活在那一轮的上下文里，
    换一次运行就没了。于是同一个侦察动作会被反复做（Cairn 那场"四轮重打"
    就是这么来的）。

它的形状刻意做得很窄，三条规矩：
    1. **只追加，不修改** —— 事实只增不改，避免"谁对谁错"的仲裁问题。
    2. **类型固定** —— host / service / vuln / cred / loot / flag / note，
       类型决定渲染方式，也决定别的 agent 怎么用它。
    3. **渲染只放摘要** —— 注入 prompt 的永远是一行一条；要看全文必须显式取。
       这一条是省 token 的关键：把"必须看正文"和"知道有这条"分开。

存储是一个 JSONL 文件，一行一条事实。选它而不是数据库，是因为：
可 append、可 diff、人可直接读、坏了只坏最后一行。
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

KINDS = ("host", "service", "vuln", "cred", "loot", "flag", "note")
SUMMARY_WIDTH = 110


@dataclass
class Fact:
    id: str
    ts: float
    kind: str
    content: str
    source: str = ""          # 哪一轮/哪个 agent 写的
    tags: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        one = " ".join((self.content or "").split())
        return one if len(one) <= SUMMARY_WIDTH else one[:SUMMARY_WIDTH] + "…"


class Board:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._cache: list[Fact] | None = None
        # ★ 多个执行者会同时写黑板（编排里默认并发 2 个），append 必须串行。
        import threading as _threading
        self._lock = _threading.Lock()

    # -- 写 -----------------------------------------------------------------
    def add(self, kind: str, content: str, source: str = "", tags: list[str] | None = None) -> Fact:
        if kind not in KINDS:
            raise ValueError("未知类型 %r（可用: %s）" % (kind, ", ".join(KINDS)))
        with self._lock:
            fact = Fact(
                id="f%03d" % (len(self.all()) + 1),
                ts=time.time(),
                kind=kind,
                content=(content or "").strip(),
                source=source,
                tags=tags or [],
            )
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(asdict(fact), ensure_ascii=False) + "\n")
            if self._cache is not None:
                self._cache.append(fact)
            return fact

    # -- 读 -----------------------------------------------------------------
    def all(self) -> list[Fact]:
        if self._cache is None:
            facts = []
            if self.path.exists():
                for line in self.path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        facts.append(Fact(**json.loads(line)))
                    except Exception:
                        continue   # 坏行跳过，不让整个黑板报废
            self._cache = facts
        return self._cache

    def get(self, fid: str) -> Fact | None:
        for f in self.all():
            if f.id == fid:
                return f
        return None

    def search(self, query: str, limit: int = 10) -> list[Fact]:
        q = (query or "").lower().split()
        if not q:
            return self.all()[-limit:]
        scored = []
        for f in self.all():
            text = (f.content + " " + " ".join(f.tags) + " " + f.kind).lower()
            hit = sum(1 for w in q if w in text)
            if hit:
                scored.append((hit, f.ts, f))
        scored.sort(key=lambda x: (-x[0], -x[1]))
        return [f for _, _, f in scored[:limit]]

    # -- 渲染 ---------------------------------------------------------------
    def render(self, limit: int = 40) -> str:
        """给 prompt 用的紧凑清单。只放 id + 类型 + 一行摘要。"""
        facts = self.all()
        if not facts:
            return "(空)"
        shown = facts[-limit:]
        lines = []
        if len(facts) > len(shown):
            lines.append("…（更早的 %d 条已省略，用 recall 查）" % (len(facts) - len(shown)))
        for f in shown:
            lines.append("%s [%s] %s" % (f.id, f.kind, f.summary))
        return "\n".join(lines)
