"""命令行入口: python -m agentlab "任务描述" """
from __future__ import annotations

import argparse
import os
from pathlib import Path

from .llm import LLM
from .loop import Agent
from .tools import default_registry


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="agentlab")
    ap.add_argument("task", help="给 agent 的任务")
    ap.add_argument("--max-steps", type=int, default=12)
    ap.add_argument("--workdir", default=".")
    ap.add_argument("--trace-dir", default="runs")
    ap.add_argument("--model", default=None)
    args = ap.parse_args(argv)

    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        print("缺少 DEEPSEEK_API_KEY")
        return 2

    workdir = Path(args.workdir).resolve()
    agent = Agent(
        llm=LLM(api_key=key, model=args.model),
        registry=default_registry(workdir),
        max_steps=args.max_steps,
        trace_dir=Path(args.trace_dir),
    )
    res = agent.run(args.task)

    for s in res.steps:
        print(f"[{s.index}] {s.tool}({', '.join(f'{k}={str(v)[:40]!r}' for k, v in s.args.items())})")
        print(f"     → {s.observation[:200].replace(chr(10), ' ')}")
    print("-" * 60)
    print("答案:", res.answer)
    print(f"步数: {len(res.steps)}  token: prompt={res.usage.prompt_tokens} "
          f"completion={res.usage.completion_tokens} cached={res.usage.cached_tokens}")
    print("trace:", res.trace_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
