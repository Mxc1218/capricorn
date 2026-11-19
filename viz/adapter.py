"""把摩羯的黑板/任务，翻译成他那套前端（Lucy tree UI）认识的形状。

为什么是适配而不是复刻：
    对完字段之后两边几乎是同一个模型 —— intent↔task、fact↔fact、
    trigger/produce/merge 同名同义。复刻等于把 200KB 的渲染/布局/动画重写一遍，
    适配只需要把字段名对上。

他期望的两个接口：
    GET /tree/projects            项目列表
    GET /projects/<pid>/tree      单项目图：{project, facts, intents, edges, hints, summary}

他读的字段（从 JS 里抠出来的，不是猜的）：
    fact   : id, description, source_intent, evidence_status, ts/created_at, tags, flags
    intent : id, project_id, description, execution_state, state_label, running, open,
             created_at, concluded_at, last_heartbeat_at, to_fact_id, merged_into, worker
    edge   : type(trigger|produce|merge), from, to
"""
from __future__ import annotations

import json
import time
from pathlib import Path

# 我们的状态 → 他的 execution_state
STATE_MAP = {
    "pending": "waiting",
    "running": "executing",
    "stalled": "stalled",
    "done": "closed",
    "failed": "closed",
    "merged": "merged",
}
LABEL = {
    "waiting": "待认领",
    "executing": "正在验证",
    "stalled": "验证活动失联",
    "closed": "已收敛",
    "merged": "已合并",
}


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts))


def _read_jsonl(path: Path) -> list[dict]:
    out = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return out


def _fold(rows: list[dict]) -> dict[str, dict]:
    folded: dict[str, dict] = {}
    for r in rows:
        if r.get("id"):
            folded[r["id"]] = r
    return folded


def build_project(source: dict) -> dict:
    """source: {project_id, title, board_path, tasks_path, live_dir}"""
    pid = source["project_id"]
    facts_raw = _read_jsonl(Path(source["board_path"])) if source.get("board_path") else []
    tasks_raw = _read_jsonl(Path(source["tasks_path"])) if source.get("tasks_path") else []
    tasks = _fold(tasks_raw)

    hb = {}
    live_dir = source.get("live_dir")
    if live_dir and Path(live_dir).exists():
        for f in Path(live_dir).glob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                if d.get("worker"):
                    hb[d["worker"]] = d.get("updated") or 0
            except Exception:
                pass

    now = time.time()
    facts, intents, edges = [], [], []

    for f in facts_raw:
        facts.append({
            "id": f.get("id"),
            "description": f.get("content") or "",
            "source_intent": f.get("produced_by") or None,
            "evidence_status": f.get("evidence_status") or "unverified",
            "ts": f.get("ts") or 0,
            "created_at": _iso(f.get("ts")),
            "tags": f.get("tags") or [],
            "flags": [],
        })

    for tid, t in tasks.items():
        status = t.get("status") or "pending"
        state = STATE_MAP.get(status, "waiting")
        started = t.get("started_at") or 0
        ended = t.get("ended_at") or 0
        beat = hb.get(t.get("worker") or tid) or t.get("updated") or started or 0
        if state == "executing" and beat and (now - beat) > 90:
            state = "stalled"
        intents.append({
            "id": tid,
            "project_id": pid,
            "title": t.get("title") or "",
            "description": (t.get("title") or "") + "\\n" + (t.get("detail") or ""),
            "execution_state": state,
            "state_label": LABEL.get(state, state),
            "running": state == "executing",
            "open": not ended,
            "stale": state == "stalled",
            "created_at": _iso(t.get("created")),
            "concluded_at": _iso(ended) if ended else None,
            "last_heartbeat_at": _iso(beat) if beat else None,
            "to_fact_id": (t.get("produced") or [None])[0],
            "merged_into": t.get("merged_into") or None,
            "worker": t.get("worker") or tid,
            "result": t.get("result") or "",
        })
        for fid in t.get("from_facts") or []:
            edges.append({"type": "trigger", "from": fid, "to": tid})
        for fid in t.get("produced") or []:
            edges.append({"type": "produce", "from": tid, "to": fid})
        if t.get("merged_into"):
            edges.append({"type": "merge", "from": tid, "to": t["merged_into"]})

    # 事实之间的支撑关系 → 他也认 produce，但这里用一个不冲突的 type，前端会当普通边处理
    for f in facts:
        for ref in (_read_refs(facts_raw, f["id"])):
            edges.append({"type": "trigger", "from": ref, "to": f["id"]})

    return {
        "project": {
            "id": pid,
            "title": source.get("title") or pid,
            "platform": source.get("platform") or "local",
            "status": source.get("status") or "active",
            "created_at": _iso(source.get("created_at")) or _iso(now),
        },
        "facts": facts,
        "intents": intents,
        "edges": edges,
        "hints": [],
        "summary": {
            "fact_count": len(facts),
            "intent_count": len(intents),
            "edge_count": len(edges),
            # 他顶部那几个计数器读的是 summary.*，缺一个就显示 undefined/NaN
            "executing_intents": sum(1 for i in intents if i["execution_state"] == "executing"),
            "waiting_intents": sum(1 for i in intents if i["execution_state"] == "waiting"),
            "stale_intents": sum(1 for i in intents if i["execution_state"] == "stalled"),
            "awaiting_heartbeat_intents": 0,
            "dangling_references": 0,
            "accepted_receipts": sum(1 for f in facts if f["evidence_status"] == "accepted" and f.get("kind") == "flag"),
            "last_activity_ts": max([f.get("ts") or 0 for f in facts] + [0]),
            "project_span_s": (max([i.get("created_at") or "" for i in intents] + [""]) and
                               (time.time() - (min([t.get("created") or 0 for t in tasks.values()] or [time.time()])))) or 0,
        },
        "dangling_references": [],
    }


def _read_refs(facts_raw: list[dict], fid: str) -> list[str]:
    for f in facts_raw:
        if f.get("id") == fid:
            return [r for r in (f.get("refs") or []) if r]
    return []


def list_projects(sources: list[dict]) -> list[dict]:
    out = []
    for s in sources:
        facts = _read_jsonl(Path(s["board_path"])) if s.get("board_path") else []
        tasks = _fold(_read_jsonl(Path(s["tasks_path"]))) if s.get("tasks_path") else {}
        out.append({
            "id": s["project_id"],
            "title": s.get("title") or s["project_id"],
            "platform": s.get("platform") or "local",
            "status": s.get("status") or "active",
            "created_at": _iso(s.get("created_at")) or _iso(time.time()),
            "fact_count": len(facts),
            "intent_count": len(tasks),
        })
    # 他那套按 created_at 倒序排，且默认选第一条。
    # 为了让默认落在"内容最多"的项目上，这里把内容多的时间戳排前面 —— 纯展示口径，
    # 不是真实创建时间（真实时间在项目详情里另有字段）。
    base = time.time()
    out.sort(key=lambda x: (x["fact_count"] + x["intent_count"]), reverse=True)
    for i, item in enumerate(out):
        item["created_at"] = _iso(base - i)
    return out
