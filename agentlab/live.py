"""运行时的"当前状态"广播 —— 给调试台看。

为什么写文件而不是开接口：
    执行者跑在别的线程里，调试台跑在别的进程里。
    要让两边不打架，最土也最稳的办法就是「一个 worker 一个 JSON 文件」，
    写满了就整体替换（小文件，原子性够用）。调试台轮询读，读到半个 JSON 就跳过重试。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path


class Live:
    def __init__(self, path: Path, worker: str, task: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data = {
            "worker": worker,
            "task": task,
            "status": "starting",
            "step": 0,
            "phase": "",
            "tool": "",
            "args": "",
            "observation": "",
            "tokens": {"prompt": 0, "completion": 0, "reasoning": 0},
            "started": time.time(),
            "updated": time.time(),
        }
        self._write()

    def _write(self):
        tmp = self.path.with_suffix(".tmp")
        self.data["updated"] = time.time()
        try:
            tmp.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.path)
        except Exception:
            pass

    def update(self, **fields):
        self.data.update(fields)
        self._write()

    def step(self, n: int, phase: str, **kw):
        self.data["step"] = n
        self.data["phase"] = phase
        self.data.update(kw)
        self._write()
