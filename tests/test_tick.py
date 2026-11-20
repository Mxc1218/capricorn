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
    # 执行者只写一条普通事实（不是 flag），所以"完成"没有证据
    board = Board(tmp_path / "board.jsonl")
    reg = make_reg(on_finish=lambda: board.add("host", "10.0.0.9 有 80 端口"))
    llm = FakeLLM([
        plan_msg([{"title": "扫一下", "detail": "nmap"}]),   # reason #1（initial）
        toolcall("finish", {"answer": "扫完了"}),            # 执行者
        plan_msg([], done=True, reason="我认为完成了"),         # reason #2（事实涨了）
    ])
    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        steps_per_task=2, trace_dir=None, mode="tick",
                        total_seconds=30)
    report = orch.run("拿下")

    assert report.reason_triggered >= 2, "initial 之后事实增长应该再触发一次"
    assert report.explore_dispatched == 1
    # ★ 规划者说 done 但没有证据（黑板无 flag、产物为空）⇒ 不能算完成
    assert report.finished is False


def test_board_flag_stops_the_run(tmp_path: Path):
    # 执行者写的是 flag 事实 ⇒ 立即收工，不再等规划者
    board = Board(tmp_path / "board.jsonl")
    reg = make_reg(on_finish=lambda: board.add("flag", "flag{abc}", evidence_status="accepted"))
    llm = FakeLLM([
        plan_msg([{"title": "打", "detail": "x"}]),
        toolcall("finish", {"answer": "拿到了"}),
    ])
    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        steps_per_task=2, trace_dir=None, mode="tick", total_seconds=20)
    report = orch.run("拿 flag")
    assert report.finished is True
    assert "flag" in report.reason


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

def test_empty_done_file_does_not_stop(tmp_path: Path):
    """★ 回归：跑分脚本会先建空的 flag.txt 占位。

    只看"文件存在"会让 agent 在第 0 秒就收工（实测踩过：耗时 0s、黑板 0 条）。
    """
    flag = tmp_path / "flag.txt"
    flag.write_text("", encoding="utf-8")           # 空占位
    orch = Orchestrator(llm=FakeLLM([]), board=Board(tmp_path / "b.jsonl"),
                        workdir=tmp_path, registry_factory=lambda wd, tid="": make_reg(),
                        workers=1, steps_per_task=1, trace_dir=None, mode="tick",
                        total_seconds=5, done_when=str(flag))
    assert orch.done_file_exists() is False
    flag.write_text("flag{x}", encoding="utf-8")     # 有内容才算
    assert orch.done_file_exists() is True

def test_board_flag_counts_as_done(tmp_path: Path):
    """★ 回归（2026-11-20 实测）：agent 把 flag 记进黑板 f004，却没写 flag.txt。

    只盯产物文件的话，达成判定永远不响，继续跑满预算。
    """
    board = Board(tmp_path / "b.jsonl")
    flag = tmp_path / "flag.txt"
    flag.write_text("", encoding="utf-8")
    orch = Orchestrator(llm=FakeLLM([]), board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": make_reg(),
                        workers=1, steps_per_task=1, trace_dir=None, mode="tick",
                        total_seconds=5, done_when=str(flag))
    assert orch.goal_achieved() is False
    board.add("flag", "flag{abc}", evidence_status="accepted")
    assert orch.goal_achieved() is True