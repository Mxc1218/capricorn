"""复盘器 —— 看一轮里【所有操作】花了多少时间、产出了什么，用来校准规则表。

为什么要做到操作级：
    任务级的统计会骗人。"目录枚举"这条任务跑了 200 秒，看不出是 gobuster 吃掉了
    180 秒还是被 20 次 curl 摊掉了。规则要压的是【动作】，所以统计粒度也必须是动作。

用法：
    python -m agentlab.retro bench/runs/a-05
    python -m agentlab.retro bench/runs/a-05 --rules policy/rules.yaml

它只读文件：traces/*.jsonl、board.jsonl、run.json。不改任何运行逻辑。
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

from .review import RuleBook


def load_trace(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def op_text(ev: dict) -> str:
    args = ev.get("args") or {}
    name = ev.get("name") or ""
    parts = [name]
    for k in ("command", "query", "path", "url", "content", "detail"):
        v = args.get(k)
        if v:
            parts.append(str(v))
    return " ".join(parts)[:600]


def collect(run_dir: Path) -> tuple:
    """把这一轮的所有操作摊平，并标注"这次操作之后有没有产出"。"""
    ops = []
    helper_ops = 0
    for tf in sorted((run_dir / "traces").glob("*.jsonl")):
        events = load_trace(tf)
        # 这条 trace = 一个任务。"有产出"按【任务级】判：
        #   该任务写过一条像样的 note（≥60 字），说明它确实拿到了东西。
        #   不按"操作后 180 秒内有没有 note"判 —— 那个太松，会把纯侦察也算成有产出。
        produced = any(e.get("kind") == "tool" and e.get("name") == "note"
                       and len(str((e.get("args") or {}).get("content") or "")) >= 60
                       for e in events)
        for e in events:
            if e.get("kind") != "tool":
                continue
            if e.get("name") != "run_shell":
                helper_ops += 1
                continue
            ts = float(e.get("ts") or 0)
            ops.append({
                "trace": tf.name,
                "ts": ts,
                "tool": e.get("name") or "",
                "text": op_text(e),
                "seconds": float(e.get("seconds") or 0),
                "obs_len": len(str(e.get("observation") or "")),
                "produced": produced,
            })
    meta = {}
    try:
        meta = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    return ops, meta, helper_ops


def aggregate(ops: list[dict], book: RuleBook) -> dict:
    groups = defaultdict(lambda: {"n": 0, "sec": 0.0, "max": 0.0, "obs": 0,
                                  "produced": 0, "examples": []})
    for op in ops:
        j = book.judge(op["text"])
        key = j["rule"] or "（未命中规则）"
        g = groups[key]
        g["n"] += 1
        g["sec"] += op["seconds"]
        g["max"] = max(g["max"], op["seconds"])
        g["obs"] += op["obs_len"]
        g["produced"] += 1 if op["produced"] else 0
        if len(g["examples"]) < 2:
            g["examples"].append(op["text"][:70])
    return dict(groups)


def report(run_dir: Path, book: RuleBook) -> dict:
    ops, meta, helper_ops = collect(run_dir)
    groups = aggregate(ops, book)

    print("=" * 74)
    print("复盘 %s  |  操作 %d 次  |  总耗时 %.0fs  |  取旗 %s"
          % (run_dir.name, len(ops), sum(o["seconds"] for o in ops),
             "是" if meta.get("finished") else "否"))
    print("（只统计 run_shell；另有 %d 次辅助工具调用不计入）" % helper_ops)
    print("=" * 74)
    print("%-22s %4s %8s %7s %8s %7s" % ("类别(规则)", "次数", "总耗时", "均", "观察量", "有产出"))
    for key, g in sorted(groups.items(), key=lambda kv: -kv[1]["sec"]):
        print("%-22s %4d %8.0fs %6.0fs %8d %6d/%d"
              % (key, g["n"], g["sec"], g["sec"] / max(1, g["n"]), g["obs"], g["produced"], g["n"]))

    suggestions = []
    for key, g in groups.items():
        if key == "（未命中规则）":
            if g["n"] >= 5:
                suggestions.append("新规则候选：%d 次操作没命中任何规则，看例子：%s"
                                   % (g["n"], " / ".join(g["examples"])))
            continue
        rule = next((r for r in book.rules if r.id == key), None)
        if rule is None:
            continue
        prio = int(rule.then.get("priority", 2))
        yield_ = g["produced"] / max(1, g["n"])
        if prio >= 3 and yield_ >= 0.5:
            suggestions.append("规则 %s 可能在误伤：%d 次里 %d 次有产出（%.0f%%），但被压到 P3"
                               % (key, g["n"], g["produced"], yield_ * 100))
        if prio == 2 and g["n"] >= 3 and g["produced"] == 0 and g["sec"] / max(1, g["n"]) >= 120:
            suggestions.append("规则 %s 建议降级：%d 次、均 %.0fs、零产出"
                               % (key, g["n"], g["sec"] / max(1, g["n"])))

    print()
    if suggestions:
        print("—— 规则表调整建议（需人工确认后才改 rules.yaml）——")
        for s in suggestions:
            print("  · " + s)
    else:
        print("—— 这轮没有足够证据调规则（样本太少或表现正常）——")
    return {"ops": len(ops), "groups": groups, "suggestions": suggestions}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="从一轮跑分目录生成操作级复盘")
    ap.add_argument("run_dir")
    ap.add_argument("--rules", default="")
    args = ap.parse_args(argv)
    run_dir = Path(args.run_dir)
    if not (run_dir / "traces").exists():
        print("找不到 %s/traces" % run_dir)
        return 2
    book = RuleBook(Path(args.rules) if args.rules else None)
    report(run_dir, book)
    return 0


if __name__ == "__main__":
    sys.exit(main())