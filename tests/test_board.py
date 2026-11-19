"""黑板的行为约束，用假对象测，不花一分钱。"""
from __future__ import annotations

from pathlib import Path

from agentlab.board import Board


def test_append_and_read_back(tmp_path: Path):
    b = Board(tmp_path / "b.jsonl")
    f1 = b.add("host", "10.0.0.5:80 nginx 1.18", source="run1")
    f2 = b.add("vuln", "路径穿越：/download?file=../", source="run1")
    assert f1.id == "f001" and f2.id == "f002"
    # 重新打开同一个文件，历史还在（跨运行累积）
    again = Board(tmp_path / "b.jsonl")
    assert [f.id for f in again.all()] == ["f001", "f002"]


def test_render_is_one_line_per_fact(tmp_path: Path):
    b = Board(tmp_path / "b.jsonl")
    b.add("loot", "很长的正文" * 100)
    text = b.render()
    assert len(text.splitlines()) == 1
    assert "…" in text          # 被截断了
    assert len(text) < 200      # 不会把上下文吃光


def test_search_and_full_text(tmp_path: Path):
    b = Board(tmp_path / "b.jsonl")
    b.add("vuln", "命令注入在 vulnerabilities/exec")
    b.add("host", "无关的一条")
    hits = b.search("命令注入")
    assert len(hits) == 1 and hits[0].kind == "vuln"
    assert "vulnerabilities/exec" in b.get(hits[0].id).content


def test_unknown_kind_rejected(tmp_path: Path):
    b = Board(tmp_path / "b.jsonl")
    try:
        b.add("猜测", "未验证的结论不该进黑板")
    except ValueError:
        pass
    else:
        raise AssertionError("未知类型必须被拒绝")