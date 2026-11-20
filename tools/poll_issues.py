"""拉 GitHub issue —— GPT 派活、我去干的通道（第一期：只读）。

为什么要它：GPT 那边能直接读仓库、能写 issue，但它推不到我这边——
机器没有公网入站端口，webhook 不可用。所以只能我主动拉。

第一期刻意只读：把待办列成一份清单写到 .issues/pending.md，
人过一眼再决定要不要动手。自动执行要等这套跑顺了再说。

用法：
    python -m tools.poll_issues --once          # 跑一次，写清单
    python -m tools.poll_issues --watch         # 每 5 分钟跑一次
    python -m tools.poll_issues --once --repo Mxc1218/capricorn

凭证：优先读环境变量 GITHUB_TOKEN，否则从 git credential 里取（和 push 用的是同一个）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

API = "https://api.github.com"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".issues"
DONE_LABEL = "dsh:done"


def token() -> str:
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if t:
        return t
    try:
        out = subprocess.run(
            ["git", "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True, text=True, timeout=15,
        ).stdout
        for line in out.splitlines():
            if line.startswith("password="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def api(path: str, tok: str):
    req = urllib.request.Request(
        API + path,
        headers={"Authorization": "token " + tok,
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "mojie-poll"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_open_issues(repo: str, tok: str) -> list[dict]:
    items = api("/repos/%s/issues?state=open&per_page=50" % repo, tok)
    out = []
    for it in items:
        if "pull_request" in it:          # PR 不是任务
            continue
        labels = [lb.get("name", "") for lb in it.get("labels") or []]
        if DONE_LABEL in labels:          # 已经处理过
            continue
        out.append({
            "number": it["number"],
            "title": it.get("title") or "",
            "body": (it.get("body") or "")[:4000],
            "labels": labels,
            "updated_at": it.get("updated_at"),
            "url": it.get("html_url"),
        })
    return out


def render(issues: list[dict]) -> str:
    if not issues:
        return "# 待办 issue\n\n(没有)\n"
    lines = ["# 待办 issue（%d 条）" % len(issues), ""]
    for it in issues:
        lines.append("## #%d %s" % (it["number"], it["title"]))
        lines.append("")
        lines.append("- 标签：" + (", ".join(it["labels"]) or "(无)"))
        lines.append("- 更新：" + str(it["updated_at"]))
        lines.append("- 链接：" + str(it["url"]))
        lines.append("")
        body = (it["body"] or "").strip()
        lines.append(body if body else "(无正文)")
        lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


def one_round(repo: str, tok: str, quiet: bool = False) -> list[dict]:
    if not tok:
        print("[poll] 没有 GitHub 凭证（GITHUB_TOKEN 或 git credential）")
        return []
    try:
        issues = fetch_open_issues(repo, tok)
    except Exception as exc:
        print("[poll] 拉取失败：%s: %s" % (type(exc).__name__, exc))
        return []
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "pending.json").write_text(json.dumps(issues, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "pending.md").write_text(render(issues), encoding="utf-8")

    state_file = OUT_DIR / "state.json"
    try:
        seen = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        seen = {}
    fresh = [i for i in issues if seen.get(str(i["number"])) != i["updated_at"]]
    for i in issues:
        seen[str(i["number"])] = i["updated_at"]
    state_file.write_text(json.dumps(seen, ensure_ascii=False, indent=2), encoding="utf-8")

    stamp = time.strftime("%H:%M:%S")
    if fresh:
        print("[poll %s] %d 条待办，其中 %d 条是新的/有更新：" % (stamp, len(issues), len(fresh)))
        for i in fresh:
            print("   #%d %s" % (i["number"], i["title"][:60]))
    elif not quiet:
        print("[poll %s] %d 条待办，没有变化" % (stamp, len(issues)))
    return fresh


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="Mxc1218/capricorn")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--interval", type=int, default=300)
    args = ap.parse_args(argv)

    tok = token()
    if not tok:
        print("拿不到 GitHub 凭证")
        return 2

    if args.watch:
        print("[poll] 每 %d 秒拉一次 %s" % (args.interval, args.repo), flush=True)
        while True:
            one_round(args.repo, tok)
            time.sleep(args.interval)
    one_round(args.repo, tok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
