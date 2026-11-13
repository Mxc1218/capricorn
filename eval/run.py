"""跑批入口。

用法:
    python -m eval.run --runner stub            # 自检：验证评测台本身
    python -m eval.run --runner agentlab --limit 2
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from eval.tasks import check, find_flag, load_tasks, prepare_workdir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="eval.run")
    ap.add_argument("--tasks", default="eval/tasks")
    ap.add_argument("--answers", default="eval/answers")
    ap.add_argument("--out", default="eval/results")
    ap.add_argument("--runner", choices=["agentlab", "stub"], default="stub")
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--only", nargs="*", default=None, help="只跑这几道")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--budget", type=int, default=0, help="覆盖每题的秒数预算")
    args = ap.parse_args(argv)

    tasks_dir, answers_dir = Path(args.tasks), Path(args.answers)
    tasks = load_tasks(tasks_dir, answers_dir, only=args.only)
    if args.limit:
        tasks = tasks[: args.limit]
    if not tasks:
        print("没有可跑的任务（检查 eval/tasks/*/instruction.md 与 eval/answers/*.txt）")
        return 2

    run_dir = Path(args.out) / time.strftime("run-%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    if args.runner == "agentlab":
        from eval.runners import AgentlabRunner
        runner = AgentlabRunner(model=args.model)
    else:
        from eval.runners import StubRunner
        runner = StubRunner(flag=None)

    rows = []
    print(f"runner={runner.name}  tasks={len(tasks)}  out={run_dir}")
    for task in tasks:
        workdir = prepare_workdir(task, run_dir / task.id / "work")
        budget = args.budget or task.budget_s

        if runner.name == "stub":
            # stub 自检模式：把答案喂给它，验证判分链路
            from eval.runners import StubRunner
            answer = (answers_dir / f"{task.id}.txt").read_text(encoding="utf-8").strip()
            runner = StubRunner(flag=answer)

        outcome = runner.run(task.instruction, workdir, budget, task.max_steps)
        found = find_flag(outcome.stdout, workdir)
        ok = check(answers_dir / f"{task.id}.txt", found)

        row = {
            "task": task.id,
            "kind": task.kind,
            "solved": ok,
            "found": found,
            "elapsed_s": round(outcome.elapsed_s, 1),
            "steps": outcome.steps,
            "prompt_tokens": outcome.prompt_tokens,
            "completion_tokens": outcome.completion_tokens,
            "cached_tokens": outcome.cached_tokens,
            "error": outcome.error,
            "trace": outcome.trace,
        }
        rows.append(row)
        (run_dir / f"{task.id}.json").write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
        mark = "✓" if ok else "✗"
        print(f"  {mark} {task.id:<28} {row['elapsed_s']:>7.1f}s  {row['steps']:>2}步  "
              f"{row['prompt_tokens']:>6}+{row['completion_tokens']:<5} tok"
              + (f"  [{row['error'][:60]}]" if row["error"] else ""))

    solved = sum(1 for r in rows if r["solved"])
    total_elapsed = sum(r["elapsed_s"] for r in rows)
    total_tok = sum(r["prompt_tokens"] + r["completion_tokens"] for r in rows)
    cached = sum(r["cached_tokens"] for r in rows)

    summary = {
        "runner": runner.name,
        "tasks": len(rows),
        "solved": solved,
        "solve_rate": round(solved / len(rows), 3),
        "total_elapsed_s": round(total_elapsed, 1),
        "avg_elapsed_s": round(total_elapsed / len(rows), 1),
        "total_tokens": total_tok,
        "avg_tokens": int(total_tok / len(rows)),
        "cached_tokens": cached,
        "cache_hit_rate": round(cached / total_tok, 3) if total_tok else 0,
        "rows": rows,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "summary.md").write_text(render_md(summary), encoding="utf-8")

    print("-" * 70)
    print(f"解出 {solved}/{len(rows)}  平均 {summary['avg_elapsed_s']}s  平均 {summary['avg_tokens']} token/题")
    print(f"报告: {run_dir / 'summary.md'}")
    return 0


def render_md(s: dict) -> str:
    lines = [
        f"# 评测报告 · {s['runner']}",
        "",
        f"- 题数: **{s['tasks']}**",
        f"- 解出: **{s['solved']}**（{s['solve_rate']*100:.0f}%）",
        f"- 平均耗时: **{s['avg_elapsed_s']}s**",
        f"- 平均 token: **{s['avg_tokens']}**（缓存命中 {s['cache_hit_rate']*100:.0f}%）",
        "",
        "| 题目 | 类型 | 结果 | 耗时(s) | 步数 | token | 备注 |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in s["rows"]:
        lines.append(
            f"| {r['task']} | {r['kind']} | {'✓' if r['solved'] else '✗'} | {r['elapsed_s']} | "
            f"{r['steps']} | {r['prompt_tokens'] + r['completion_tokens']} | {r['error'][:40]} |"
        )
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
