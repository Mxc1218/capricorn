from __future__ import annotations

import json
import sys
from pathlib import Path


def load(path: Path) -> list:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def clip(s: str, n: int = 600) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n] + "\n…（截断，原 %d 字符）" % len(s)


def render(events) -> str:
    start = next((e for e in events if e["kind"] == "run_start"), {})
    end = next((e for e in reversed(events) if e["kind"] == "run_end"), {})
    tools = [e for e in events if e["kind"] == "tool"]
    fence = chr(96) * 3  # 三个反引号

    out = [
        "# 运行复盘",
        "",
        "- 任务: " + str(start.get("task") or "")[:200],
        "- 模型: " + str(start.get("model")),
        "- 步数: " + str(end.get("steps", len(tools))),
        "- 收尾: " + ("是" if end.get("finished") else "否（步数/预算用尽）"),
        "- token: " + str(end.get("usage", {})),
        "",
        "## 工具调用一览",
        "",
        "| 步 | 工具 | 参数（截断） |",
        "|---|---|---|",
    ]
    for t in tools:
        args = json.dumps(t.get("args") or {}, ensure_ascii=False)
        out.append("| %s | `%s` [%s] | `%s` |" % (t.get("step"), t.get("name"), t.get("risk"), args[:120].replace("|", "/")))

    out += ["", "## 逐步过程", ""]
    for e in events:
        if e["kind"] == "model":
            u2 = e.get("usage") or {}
            out.append("### 第 %s 步" % e.get("step"))
            out.append("")
            if e.get("thought"):
                out.append("**模型说**：" + clip(e["thought"], 400))
                out.append("")
            out.append("*token: prompt=%s completion=%s cached=%s*" % (u2.get("prompt"), u2.get("completion"), u2.get("cached")))
            out.append("")
        elif e["kind"] == "tool":
            out.append("**调用** `%s`（risk=%s）" % (e.get("name"), e.get("risk")))
            out.append("")
            out.append(fence)
            out.append(json.dumps(e.get("args") or {}, ensure_ascii=False, indent=2)[:800])
            out.append(fence)
            out.append("")
            out.append("**结果**：")
            out.append("")
            out.append(fence)
            out.append(clip(e.get("observation") or "", 700))
            out.append(fence)
            out.append("")
    return "\n".join(out)


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print("用法: python -m eval.replay <trace.jsonl>")
        return 2
    src = Path(argv[0])
    md = render(load(src))
    dst = src.with_suffix(".md")
    dst.write_text(md, encoding="utf-8")
    print("已生成: %s (%d 字符)" % (dst, len(md)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
