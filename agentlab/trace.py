"""结构化 trace —— 从第一天就要有账本。

每次 run 一个 .jsonl 文件，一行一个事件。事件种类:
    run_start / model / tool / run_end / error

为什么不用 print:
    事后要回答"这轮花了多少 token、卡在哪一步"，只能靠结构化数据。
    print 出来的东西没法聚合，也没法回放。
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class Tracer:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("a", encoding="utf-8")
        self.t0 = time.time()

    def event(self, kind: str, **fields: Any) -> None:
        rec = {"ts": round(time.time() - self.t0, 3), "kind": kind, **fields}
        self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        self._fh.close()

    def __enter__(self) -> "Tracer":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
