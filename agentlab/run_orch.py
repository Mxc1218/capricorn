"""跑一次编排（规划者 + N 执行者），并把实时状态写到 live/ 给调试台看。

    python -m agentlab.run_orch "拿下 localhost:8080 上的 flag" --workers 2 --minutes 10
"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from .board import Board
from .llm import LLM
from .orchestrator import Orchestrator


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="agentlab.orchestrate")
    ap.add_argument("goal", help="这次要达成的目标，一句话")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--task-steps", type=int, default=10)
    ap.add_argument("--task-seconds", type=int, default=300)
    ap.add_argument("--workdir", default=".")
    ap.add_argument("--board", default="board.jsonl")
    ap.add_argument("--live-dir", default="live")
    ap.add_argument("--trace-dir", default="runs")
    ap.add_argument("--model", default=None)
    args = ap.parse_args(argv)

    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        print("缺少 DEEPSEEK_API_KEY")
        return 2

    board = Board(Path(args.board))
    orch = Orchestrator(
        llm=LLM(api_key=key, model=args.model),
        board=board,
        workdir=Path(args.workdir).resolve(),
        workers=args.workers,
        max_rounds=args.rounds,
        steps_per_task=args.task_steps,
        seconds_per_task=args.task_seconds,
        trace_dir=Path(args.trace_dir),
        live_dir=Path(args.live_dir),
    )
    t0 = time.time()
    report = orch.run(args.goal)
    print("=" * 60)
    for r in report.rounds:
        print("第 %d 轮：%s" % (r.index, r.plan_reason[:80]))
        for t in r.dispatched:
            print("   [%s] %s → %s" % (t.status, t.title, (t.result or "")[:100]))
    print("=" * 60)
    print("结束: %s（%s）耗时 %.0fs" % ("已达成" if report.finished else "未达成",
                                     report.reason[:60], time.time() - t0))
    print("黑板 %d 条：%s" % (len(board.all()), Path(args.board).resolve()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
