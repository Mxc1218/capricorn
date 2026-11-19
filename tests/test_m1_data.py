"""M1 数据层的三条：计时、证据分级、合并边。"""
from __future__ import annotations

import time
from pathlib import Path

from agentlab.board import Board
from agentlab.tasks import TaskStore


def test_task_elapsed_three_phases(tmp_path: Path):
    s = TaskStore(tmp_path / "t.jsonl")
    t = s.add("扫端口", "nmap")
    t.created = 1000.0
    t.started_at = 1010.0
    t.ended_at = 1090.0
    s.update(t)
    e = s.elapsed(t)
    assert e["wait"] == 10.0      # 派发到开跑：说明调度有没有卡
    assert e["run"] == 80.0       # 真正在跑
    assert e["total"] == 90.0
    assert e["open"] is False


def test_running_task_is_open(tmp_path: Path):
    s = TaskStore(tmp_path / "t.jsonl")
    t = s.add("跑着", "还在跑")
    t.created = time.time() - 30
    t.started_at = time.time() - 20
    e = s.elapsed(t)
    assert e["open"] is True
    assert 19 <= e["run"] <= 25


def test_evidence_status_defaults_and_rejects(tmp_path: Path):
    b = Board(tmp_path / "b.jsonl")
    f = b.add("vuln", "好像有命令注入")
    assert f.evidence_status == "unverified"      # 默认必须是"未核验"
    g = b.add("flag", "flag{x}", evidence_status="accepted")
    assert g.evidence_status == "accepted"
    try:
        b.add("note", "x", evidence_status="确定一定")
    except ValueError:
        pass
    else:
        raise AssertionError("非法证据等级必须被拒")


def test_merge_edge_is_recorded(tmp_path: Path):
    s = TaskStore(tmp_path / "t.jsonl")
    a = s.add("方向 A", "x")
    b = s.add("方向 B", "y")
    b.merged_into = a.id
    b.status = "merged"
    s.update(b)
    again = s.get(b.id)
    assert again.merged_into == a.id and again.status == "merged"