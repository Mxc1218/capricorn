"""tick 模式（按槽位触发）的行为测试 —— 全部用假模型，不花 token。"""
from __future__ import annotations

import json
import time
from pathlib import Path

from agentlab.board import Board
from agentlab.llm import Reply, Usage
from agentlab.orchestrator import Orchestrator
from agentlab.tools import Finish, Registry, Tool


class FakeLLM:
    def __init__(self, script):
        self.script = list(script)
        self.model = "fake"
        self.calls = 0

    def chat(self, messages, tools=None, temperature=0.2):
        self.calls += 1
        msg = self.script.pop(0) if self.script else {"role": "assistant", "content": "{}"}
        return Reply(message=msg, usage=Usage(prompt_tokens=10, completion_tokens=5))


def plan_msg(tasks, done=False, reason="r"):
    return {"role": "assistant", "content": json.dumps({"done": done, "reason": reason, "tasks": tasks}, ensure_ascii=False)}


def toolcall(name, args, cid="c1"):
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": cid, "type": "function",
         "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


def make_reg(on_finish=None):
    # finish 时可以顺手做一件事（比如把 flag 写盘），再抛 Finish 收尾
    def _finish(answer):
        if on_finish is not None:
            on_finish()
        raise Finish(answer)

    reg = Registry()
    reg.add(Tool(name="finish", description="done",
                 parameters={"type": "object", "properties": {"answer": {"type": "string"}},
                             "required": ["answer"]},
                 fn=_finish, risk="none"))
    return reg


def test_tick_triggers_reason_then_dispatches(tmp_path: Path):
    board = Board(tmp_path / "board.jsonl")
    reg = make_reg()
    llm = FakeLLM([
        plan_msg([{"title": "扫一下", "detail": "nmap"}]),      # 第一次 reason（initial）
        toolcall("finish", {"answer": "扫完了"}),               # 执行者
        plan_msg([], done=True, reason="完成"),                 # 第二次 reason（facts 涨了）
    ])
    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        steps_per_task=2, trace_dir=None, mode="tick",
                        total_seconds=30)
    report = orch.run("拿下")

    assert report.reason_triggered >= 2, "initial 之后事实增长应该再触发一次"
    assert report.explore_dispatched == 1
    assert report.finished is True
    tasks = orch.store.all()
    assert tasks and tasks[0].status == "done"


def test_tick_stops_when_done_file_appears(tmp_path: Path):
    board = Board(tmp_path / "board.jsonl")
    flag = tmp_path / "flag.txt"
    reg = make_reg(on_finish=lambda: flag.write_text("flag{x}", encoding="utf-8"))

    llm = FakeLLM([
        plan_msg([{"title": "拿 flag", "detail": "写入 flag.txt"}]),
        toolcall("finish", {"answer": "拿到了"}),
    ])
    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        steps_per_task=2, trace_dir=None, mode="tick",
                        total_seconds=20, done_when=str(flag))
    report = orch.run("拿 flag")
    assert report.finished is True
    assert "目标产物已生成" in report.reason


def test_tick_respects_slot_limit(tmp_path: Path):
    """两个任务、一个槽位：第二个必须等第一个结束（流水线而不是一把梭）。"""
    board = Board(tmp_path / "board.jsonl")
    reg = make_reg()
    llm = FakeLLM([
        plan_msg([{"title": "A", "detail": "a"}, {"title": "B", "detail": "b"}]),
        toolcall("finish", {"answer": "A 完"}),
        toolcall("finish", {"answer": "B 完"}),
        plan_msg([], done=True, reason="完成"),
    ])
    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        steps_per_task=2, trace_dir=None, mode="tick",
                        total_seconds=30)
    report = orch.run("干活")
    assert report.explore_dispatched == 2
    assert all(t.status == "done" for t in orch.store.all())