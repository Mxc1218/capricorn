"""调试台服务端 —— 只读，标准库，一条命令起。

    python -m viz.server --port 8770

它读三个地方：
    eval/results/<run>/<task>.json          每题结论
    eval/results/<run>/<task>/work/traces/  步骤事件
    eval/boards/<task>.jsonl                黑板
    live/<task>.json                        执行者当前的实时状态
"""
from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from agentlab.state import fact_tone, task_view

HERE = Path(__file__).resolve().parent
LEGACY = HERE / "legacy"
PROJECT = HERE.parent
RESULTS = PROJECT / "eval" / "results"
BOARDS = PROJECT / "eval" / "boards"
LIVE = PROJECT / "live"


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def read_jsonl(path: Path):
    out = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    except Exception:
        pass
    return out


def project_sources():
    # 一个跑过的项目 = (run 目录, 题目名)。他那边一个 project 就是一次尝试。
    out = []
    # 跑分（bench/runs/<code>）也是"项目"，同一个界面里应该看得到。
    # ★ 注意它和 eval/results 是两套目录：跑分自己带 board/live/traces，
    #   不复用 eval/boards，否则不同题的黑板会串在一起。
    bench = PROJECT / "bench" / "runs"
    if bench.exists():
        for run in sorted(bench.iterdir()):
            if not run.is_dir():
                continue
            bt = run / "tasks.jsonl"
            if not bt.exists():
                continue
            out.append({
                "project_id": "bench-" + run.name,
                "title": "跑分 " + run.name,
                "board_path": str(run / "board.jsonl"),
                "tasks_path": str(bt),
                "live_dir": str(run / "live"),
            })

    if not RESULTS.exists():
        return out
    used = set()
    for d in sorted(RESULTS.iterdir()):
        if not d.is_dir():
            continue
        for sub in sorted(d.iterdir()):
            if not sub.is_dir():
                continue
            tasks = sub / "work" / "tasks.jsonl"
            if not tasks.exists():
                continue
            pid = sub.name if sub.name not in used else d.name + ":" + sub.name
            used.add(pid)
            out.append({
                "project_id": pid,
                "title": sub.name + " · " + d.name,
                "board_path": str(BOARDS / (sub.name + ".jsonl")),
                "tasks_path": str(tasks),
                "live_dir": str(LIVE),
            })
    return out


def list_runs():
    runs = []
    if not RESULTS.exists():
        return runs
    for d in sorted(RESULTS.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        tasks = []
        for f in sorted(d.glob("*.json")):
            if f.name in ("summary.json",):
                continue
            data = read_json(f, {}) or {}
            name = data.get("task", f.stem)
            work = d / name / "work"
            traces = work / "traces"
            has_trace = traces.exists() and any(traces.glob("*.jsonl"))
            has_graph = ((work / "tasks.jsonl").exists() or (d / name / "tasks.jsonl").exists()) and (BOARDS / (name + ".jsonl")).exists()
            tasks.append({
                "has_trace": bool(has_trace),
                "has_graph": bool(has_graph),
                "task": name,
                "solved": data.get("solved"),
                "elapsed_s": data.get("elapsed_s"),
                "steps": data.get("steps"),
                "tokens": (data.get("prompt_tokens") or 0) + (data.get("completion_tokens") or 0),
                "error": data.get("error") or "",
                "work": str((d / name / "work").as_posix()),
            })
        # 也扫子目录：编排跑出来的结果没有 <task>.json，但 work/tasks.jsonl 在
        for sub in sorted(d.iterdir()):
            if not sub.is_dir(): continue
            if any(t["task"] == sub.name for t in tasks): continue
            work = sub / "work"
            if not (work / "tasks.jsonl").exists(): continue
            tasks.append({
                "task": sub.name, "solved": False, "elapsed_s": None, "steps": None,
                "tokens": 0, "error": "", "work": str(work.as_posix()),
                "has_trace": (work / "traces").exists() and any((work / "traces").glob("*.jsonl")),
                "has_graph": (BOARDS / (sub.name + ".jsonl")).exists(),
            })
        runs.append({"run": d.name, "tasks": tasks})
    return runs


def load_live():
    if not LIVE.exists():
        return []
    out = []
    for f in sorted(LIVE.glob("*.json")):
        data = read_json(f)
        if data:
            out.append(data)
    return out


def load_graph(work: str):
    """把事实与任务摊成节点 + 边 —— 前端画树就靠这个。

    边只有两种，和原来那套一一对应：
        trigger  fact  → task   （依据这条事实派了这个任务）
        produce  task  → fact   （这条任务产出了这条事实）
    """
    d = Path(work)
    nodes, edges = [], []
    # 任务文件可能在工作目录里（编排写的），也可能在上一层（评测台写的），两处都看
    task_file = d / "tasks.jsonl"
    if not task_file.exists():
        task_file = d.parent / "tasks.jsonl"
    import time as _time
    now = _time.time()
    hb = {}
    if LIVE.exists():
        for f in LIVE.glob("*.json"):
            d2 = read_json(f, {}) or {}
            if d2.get("worker"):
                hb[d2["worker"]] = d2.get("updated") or 0
    if task_file.exists():
        folded = {}
        for rec in read_jsonl(task_file):
            folded[rec.get("id")] = rec
        for tid, t in folded.items():
            from types import SimpleNamespace

            view = task_view(SimpleNamespace(
                created=t.get("created") or 0, started_at=t.get("started_at") or 0,
                ended_at=t.get("ended_at") or 0, status=t.get("status") or "pending",
                updated=t.get("updated") or 0), now=now, heartbeat=hb.get(t.get("worker") or tid))
            nodes.append({"id": tid, "type": "task", "title": t.get("title", ""),
                          "view": view,
                          "status": t.get("status", ""), "result": (t.get("result") or "")[:200],
                          "detail": (t.get("detail") or "")[:300],
                          "created": t.get("created") or 0, "updated": t.get("updated") or 0,
                          "started_at": t.get("started_at") or 0, "ended_at": t.get("ended_at") or 0,
                          "worker": t.get("worker") or "", "merged_into": t.get("merged_into") or "",
                          "from_facts": t.get("from_facts") or [], "produced": t.get("produced") or []})
            for fid in t.get("from_facts") or []:
                edges.append({"from": fid, "to": tid, "kind": "trigger"})
            for fid in t.get("produced") or []:
                edges.append({"from": tid, "to": fid, "kind": "produce"})
            if t.get("merged_into"):
                edges.append({"from": tid, "to": t["merged_into"], "kind": "merge"})
    # 黑板事实（按题目存）
    task_name = d.parent.name
    board_file = BOARDS / (task_name + ".jsonl")
    if board_file.exists():
        for f in read_jsonl(board_file):
            nodes.append({"id": f.get("id"), "type": "fact", "kind": f.get("kind"),
                          "content": (f.get("content") or "")[:200],
                          "refs": f.get("refs") or [], "produced_by": f.get("produced_by") or "",
                          "evidence_status": f.get("evidence_status") or "unverified",
                          "ts": f.get("ts") or 0})
            for ref in f.get("refs") or []:
                # 事实之间是「支撑」关系，和任务那一侧的 trigger/produce 分开
                edges.append({"from": ref, "to": f.get("id"), "kind": "support"})
    return {"nodes": nodes, "edges": edges}


def load_lanes(work: str):
    """一个 trace 文件 = 一个执行者 = 一条泳道。

    ★ 借鉴他原来那个前端的核心：不按「文件」列，按「人」列。
      每行是一个 agent，横轴是步数，方块是工具调用 —— 一眼看出谁在干什么、卡在哪。
    """
    d = Path(work) / "traces"
    if not d.exists():
        return []
    lanes = []
    for f in sorted(d.glob("*.jsonl")):
        ev = read_jsonl(f)
        if not ev:
            continue
        start = next((e for e in ev if e.get("kind") == "run_start"), {})
        lanes.append({
            "name": f.stem.replace("run-", ""),
            "task": (start.get("task") or "")[:80],
            "events": ev,
        })
    return lanes


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, raw: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _json(self, obj):
        self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            # 根路径给他那套前端；我们自己的调试台挪到 /console
            return self._send((LEGACY / "index.html").read_bytes(), "text/html; charset=utf-8")
        if u.path == "/console":
            return self._send((HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        if u.path.startswith("/static/"):
            rel = u.path[len("/static/"):]
            f = LEGACY / rel
            if f.is_file():
                ctype = "application/javascript; charset=utf-8" if f.suffix == ".js" else (
                    "text/css; charset=utf-8" if f.suffix == ".css" else "application/octet-stream")
                return self._send(f.read_bytes(), ctype)
            self.send_response(404); self.end_headers(); return
        if u.path == "/tree/projects":
            from viz.adapter import list_projects
            return self._json(list_projects(project_sources()))
        if u.path.startswith("/projects/") and u.path.endswith("/tree"):
            from viz.adapter import build_project
            from urllib.parse import unquote
            pid = unquote(u.path[len("/projects/"):-len("/tree")]).strip("/")
            src = next((s for s in project_sources() if s["project_id"] == pid), None)
            if not src:
                self.send_response(404); self.end_headers(); return
            return self._json(build_project(src))
        if u.path == "/api/runs":
            return self._json(list_runs())
        if u.path == "/api/live":
            return self._json(load_live())
        if u.path == "/api/board":
            task = (qs.get("task") or [""])[0]
            return self._json(read_jsonl(BOARDS / (task + ".jsonl")))
        if u.path == "/api/graph":
            return self._json(load_graph((qs.get("work") or [""])[0]))
        if u.path == "/api/trace":
            return self._json(load_lanes((qs.get("work") or [""])[0]))
        self.send_response(404)
        self.end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--bind", default="127.0.0.1")
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.bind, a.port), Handler)
    print("调试台: http://%s:%d/" % (a.bind, a.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
