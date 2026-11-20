"""生成 writeup —— 每轮跑完自动产出，路径固定：<run_dir>/WRITEUP.md。

为什么要有它：黑板里是一堆事实，trace 里是几百条命令，
但没有任何地方把"这题是怎么打下来的"写成人能读的东西。
复盘、对比、给同事看，都需要一份能从头读到尾的文档。

它不由执行者随手写，而是跑完后从 trace + 黑板【生成】——
因为执行者会写得很碎（recon/AUTH_FLOW.md、dl/REPORT.md 散在各处），也不完整。

用法：
    python -m agentlab.writeup bench/runs/a-05
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from .retro import collect
from .review import RuleBook


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def fold_facts(rows: list[dict]) -> dict:
    """黑板是追加写，同一 id 可能有多条 —— 后面的覆盖前面的。"""
    out = {}
    for r in rows:
        out[r.get("id")] = r
    return out


def chain_for_flag(flag_fact: dict, facts: dict, tasks: dict, depth: int = 0) -> list[str]:
    """从 flag 事实往回追：它由谁产出、依据了哪几条事实，一直追到起点。"""
    lines = []
    pad = "  " * depth
    content = (flag_fact.get("content") or "").replace("\n", " ")[:160]
    lines.append("%s- `%s` [%s] %s" % (pad, flag_fact.get("id"), flag_fact.get("kind"), content))
    if depth >= 3:
        return lines
    for ref in (flag_fact.get("refs") or [])[:3]:
        parent = facts.get(ref)
        if parent:
            lines += chain_for_flag(parent, facts, tasks, depth + 1)
    tid = flag_fact.get("produced_by")
    task = tasks.get(tid) if tid else None
    if task:
        lines.append("%s  ↑ 由 `%s` 产出：%s" % (pad, tid, (task.get("title") or "")[:60]))
    return lines


def generate(run_dir: Path, rules: RuleBook | None = None) -> Path:
    run_dir = Path(run_dir)
    facts = fold_facts(_load_jsonl(run_dir / "board.jsonl"))
    tasks_rows = _load_jsonl(run_dir / "tasks.jsonl")
    tasks = {}
    for r in tasks_rows:
        tasks[r.get("id")] = r
    meta = {}
    try:
        meta = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    ops, _meta, helper_ops = collect(run_dir)
    book = rules or RuleBook()

    flag_facts = [f for f in facts.values() if f.get("kind") == "flag"]
    flag_txt = ""
    try:
        flag_txt = (run_dir / "flag.txt").read_text(encoding="utf-8").strip()
    except Exception:
        pass

    L = []
    L.append("# %s writeup" % run_dir.name)
    L.append("")
    L.append("由 `agentlab.writeup` 生成于 %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    L.append("")

    # -- 结果 --
    L.append("## 结果")
    L.append("")
    if flag_facts or flag_txt:
        for f in flag_facts:
            L.append("- flag：`%s`" % ((f.get("content") or "").split(" ")[0])[:80])
        if flag_txt and not flag_facts:
            L.append("- flag：`%s`（来自 flag.txt）" % flag_txt[:80])
    else:
        L.append("- flag：**未拿到**")
    L.append("- 耗时：%s 秒" % (meta.get("elapsed_s") or "?"))
    L.append("- 结束原因：%s" % (meta.get("reason") or "?"))
    L.append("- 任务：%d 条，事实：%d 条，shell 操作：%d 次（另有 %d 次辅助工具）"
             % (len(tasks), len(facts), len(ops), helper_ops))
    L.append("")

    # -- 关键链路 --
    if flag_facts:
        L.append("## 关键链路")
        L.append("")
        for f in flag_facts[:2]:
            L += chain_for_flag(f, facts, tasks)
        L.append("")

    # -- 时间分布 --
    if ops:
        L.append("## 时间分布（按规则分类）")
        L.append("")
        L.append("| 类别 | 次数 | 总耗时 | 均耗时 | 有产出 |")
        L.append("|---|---|---|---|---|")
        groups = {}
        for op in ops:
            j = book.judge(op["text"])
            key = j["rule"] or "（未命中规则）"
            g = groups.setdefault(key, {"n": 0, "sec": 0.0, "prod": 0})
            g["n"] += 1
            g["sec"] += op["seconds"]
            g["prod"] += 1 if op["produced"] else 0
        for key, g in sorted(groups.items(), key=lambda kv: -kv[1]["sec"]):
            L.append("| %s | %d | %.0fs | %.0fs | %d |"
                     % (key, g["n"], g["sec"], g["sec"] / max(1, g["n"]), g["prod"]))
        L.append("")

        # -- 弯路 --
        slow = sorted([o for o in ops if o["seconds"] >= 20], key=lambda o: -o["seconds"])[:5]
        if slow:
            L.append("## 走过的弯路（单次 ≥20 秒）")
            L.append("")
            for o in slow:
                L.append("- %.0fs 按规则 %s：`%s`"
                         % (o["seconds"], book.judge(o["text"])["rule"] or "未命中",
                            o["text"][:110].replace("`", "'")))
            L.append("")

    # -- 任务台账 --
    if tasks:
        L.append("## 任务台账")
        L.append("")
        L.append("| id | 状态 | P | 耗时 | 标题 | 结果 |")
        L.append("|---|---|---|---|---|---|")
        for tid, t in tasks.items():
            s = t.get("started_at") or 0
            e = t.get("ended_at") or 0
            dur = ("%.0fs" % (e - s)) if (s and e) else "-"
            L.append("| %s | %s | %s | %s | %s | %s |"
                     % (tid, t.get("status"), t.get("priority", 2), dur,
                        (t.get("title") or "")[:30],
                        ((t.get("result") or "").replace("\n", " ")[:40])))
        L.append("")

    L.append("---")
    L.append("")
    L.append("操作原始记录：`traces/*.jsonl`；黑板：`board.jsonl`；任务：`tasks.jsonl`")

    out = run_dir / "WRITEUP.md"
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    return out


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print("用法: python -m agentlab.writeup bench/runs/a-05")
        return 0
    p = generate(Path(argv[0]))
    print("已生成 %s" % p)
    return 0


if __name__ == "__main__":
    sys.exit(main())