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
    ap.add_argument("goal", nargs="?", default="", help="这次要达成的目标，一句话")
    # ★ 中文目标不要走批处理参数：cmd 按 GBK 解析 .bat，UTF-8 的中文会把后面的引号吃掉，
    #   结果所有命令行参数被并进 goal，静默退化成默认值。走文件最稳。
    ap.add_argument("--goal-file", default="", help="从 UTF-8 文件读目标（中文推荐用这个）")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--task-steps", type=int, default=10)
    ap.add_argument("--task-seconds", type=int, default=300)
    ap.add_argument("--workdir", default=".")
    ap.add_argument("--board", default="board.jsonl")
    ap.add_argument("--live-dir", default="live")
    ap.add_argument("--trace-dir", default="runs")
    ap.add_argument("--model", default=None)
    ap.add_argument("--check-url", default="", help="开跑前先探测这个 URL，不通就中止")
    args = ap.parse_args(argv)

    goal = args.goal
    if args.goal_file:
        goal = Path(args.goal_file).read_text(encoding="utf-8").strip()
    if not goal:
        print("缺少目标：给一个参数，或用 --goal-file")
        return 2

    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        print("缺少 DEEPSEEK_API_KEY")
        return 2

    # ★ 开跑前先确认目标活着。这一条是血的教训：
    #   靶场崩了以后，执行者不会说"目标不可达"，而是去翻 docker / wsl / 路由表，
    #   十分钟烧完才失败。机器不该替人数这种事。
    if args.check_url:
        import urllib.request
        try:
            with urllib.request.urlopen(args.check_url, timeout=6) as resp:
                print("目标可达：%s → HTTP %s" % (args.check_url, resp.status))
        except Exception as exc:
            print("目标不可达，已中止：%s（%s）" % (args.check_url, exc))
            return 3

    live_dir = Path(args.live_dir)
    if live_dir.exists():
        for stale in live_dir.glob("*.json"):
            stale.unlink(missing_ok=True)   # 上一轮的残留会冒充"正在跑"

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
    report = orch.run(goal)
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
