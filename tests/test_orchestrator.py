"""编排的骨架测试：规划者出任务、执行者写回黑板、轮次推进。全部用假模型。"""
from __future__ import annotations

import json
from pathlib import Path

from agentlab.board import Board
from agentlab.llm import Reply, Usage
from agentlab.orchestrator import Orchestrator
from agentlab.planner import parse_plan
from agentlab.tools import Registry, Tool, Finish


class FakeLLM:
    def __init__(self, script):
        self.script = list(script)
        self.model = "fake"

    def chat(self, messages, tools=None, temperature=0.2):
        msg = self.script.pop(0) if self.script else {"role": "assistant", "content": "(无话可说)"}
        return Reply(message=msg, usage=Usage(prompt_tokens=10, completion_tokens=5))


def plan_msg(tasks, done=False, reason="r"):
    payload = {"done": done, "reason": reason, "tasks": tasks}
    return {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)}


def toolcall(name, args, cid="c1"):
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": cid, "type": "function",
         "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


def test_parse_plan_tolerates_code_fence():
    text = "好的，这是计划：\\n`@json\\n" + json.dumps(
        {"done": False, "reason": "x", "tasks": [{"title": "a", "detail": "b"}]},
        ensure_ascii=False) + "\\n`@"
    p = parse_plan(text)
    assert p.done is False
    assert p.reason == "x"
    assert p.tasks[0].title == "a"


def test_orchestrator_dispatches_and_writes_board(tmp_path: Path):
    board = Board(tmp_path / "board.jsonl")
    reg = Registry()
    reg.add(Tool(name="finish", description="done",
                 parameters={"type": "object", "properties": {"answer": {"type": "string"}},
                             "required": ["answer"]},
                 fn=lambda answer: (_ for _ in ()).throw(Finish(answer)), risk="none"))

    llm = FakeLLM([
        plan_msg([{"title": "扫端口", "detail": "对 127.0.0.1 做一次端口扫描"}]),   # 第 1 轮规划
        toolcall("finish", {"answer": "扫完了，22 开着"}),                          # 执行者
        plan_msg([], done=True, reason="目标已达成"),                               # 第 2 轮规划
    ])

    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd: reg, workers=1,
                        max_rounds=2, steps_per_task=2, trace_dir=None)
    report = orch.run("拿下目标")

    assert len(report.rounds) == 2
    assert report.rounds[0].dispatched[0].title == "扫端口"
    assert report.finished is True
    assert report.reason == "目标已达成"
    kinds = [f.kind for f in board.all()]
    assert "note" in kinds, "执行者的结论必须回写黑板，否则下一轮规划者看不见"
