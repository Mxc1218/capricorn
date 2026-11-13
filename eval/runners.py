from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class Outcome:
    solved: bool = False
    found_flag: str | None = None
    elapsed_s: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    steps: int = 0
    error: str = ""
    stdout: str = ""
    trace: str = ""


class Runner(Protocol):
    name: str

    def run(self, instruction: str, workdir: Path, budget_s: int, max_steps: int) -> Outcome: ...


class AgentlabRunner:
    """用我们自己那 200 行内核跑。

    ★ 每个 runner 都只拿到 instruction + workdir + 预算，不许碰题目目录以外的任何东西。
    """

    name = "agentlab"

    def __init__(self, model: str = "deepseek-flash", api_key: str | None = None):
        self.model = model
        self.api_key = api_key

    def run(self, instruction: str, workdir: Path, budget_s: int, max_steps: int) -> Outcome:
        import os
        from agentlab.llm import LLM
        from agentlab.loop import Agent
        from agentlab.tools import default_registry

        key = self.api_key or os.environ.get("DEEPSEEK_API_KEY", "")
        if not key:
            return Outcome(error="缺少 DEEPSEEK_API_KEY")

        agent = Agent(
            llm=LLM(api_key=key, model=self.model, timeout=min(180, max(60, budget_s // 2))),
            registry=default_registry(workdir),
            max_steps=max_steps,
            trace_dir=workdir / "traces",
            deadline_s=budget_s,
        )
        t0 = time.time()
        try:
            res = agent.run(instruction)
        except Exception as exc:
            return Outcome(error=f"{type(exc).__name__}: {exc}", elapsed_s=time.time() - t0)
        return Outcome(
            elapsed_s=time.time() - t0,
            prompt_tokens=res.usage.prompt_tokens,
            completion_tokens=res.usage.completion_tokens,
            cached_tokens=res.usage.cached_tokens,
            steps=len(res.steps),
            stdout=res.answer,
            trace=res.trace_path or "",
        )


class StubRunner:
    """不花钱的假 runner：拿到什么 flag 就往 flag.txt 里写什么。

    唯一用途是验证评测台本身（目录隔离、判分、报告），不碰模型。
    """

    name = "stub"

    def __init__(self, flag: str | None = None):
        self.flag = flag

    def run(self, instruction: str, workdir: Path, budget_s: int, max_steps: int) -> Outcome:
        t0 = time.time()
        if self.flag:
            (Path(workdir) / "flag.txt").write_text(self.flag, encoding="utf-8")
            return Outcome(elapsed_s=time.time() - t0, steps=1, stdout=f"flag={self.flag}")
        return Outcome(elapsed_s=time.time() - t0, steps=2, stdout="我没解出来")
