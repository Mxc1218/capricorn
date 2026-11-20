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
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        max_rounds=2, steps_per_task=2, trace_dir=None, mode="round")
    report = orch.run("拿下目标")

    assert len(report.rounds) == 2
    assert report.rounds[0].dispatched[0].title == "扫端口"
    assert report.finished is True
    assert report.reason == "目标已达成"
    # 结论落在任务史里（不重复写进黑板 —— 同一件事别存两份）
    tasks = orch.store.all()
    assert len(tasks) == 1
    assert tasks[0].status == "done"
    assert "22 开着" in tasks[0].result


def test_task_carries_causal_links(tmp_path: Path):
    """任务必须带 from_facts；跑完之后 produced 要记下它产出了哪些事实。"""
    from agentlab.orchestrator import Orchestrator

    board = Board(tmp_path / "board.jsonl")
    board.add("host", "10.0.0.5 有 80 端口")          # f001

    reg = Registry()
    captured = {}

    def fake_note(kind, content, refs=""):
        captured["refs"] = refs
        captured["fact"] = board.add(kind, content, refs=[x for x in refs.split(",") if x], produced_by="t001")
        return "ok"

    reg.add(Tool(name="note", description="n",
                 parameters={"type": "object", "properties": {"kind": {"type": "string"}, "content": {"type": "string"}, "refs": {"type": "string"}},
                             "required": ["kind", "content"]}, fn=fake_note, risk="write"))
    reg.add(Tool(name="finish", description="d",
                 parameters={"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]},
                 fn=lambda answer: (_ for _ in ()).throw(Finish(answer)), risk="none"))

    llm = FakeLLM([
        plan_msg([{"title": "打 80", "detail": "试路径穿越", "from": ["f001"]}]),
        toolcall("note", {"kind": "vuln", "content": "路径穿越确认", "refs": "f001"}),
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c2", "type": "function",
            "function": {"name": "finish", "arguments": "{\"answer\":\"拿到了\"}"}}]},
        plan_msg([], done=True, reason="完成"),
    ])
    orch = Orchestrator(llm=llm, board=board, workdir=tmp_path,
                        registry_factory=lambda wd, tid="": reg, workers=1,
                        max_rounds=2, steps_per_task=3, trace_dir=None)
    orch.run("拿下")

    t = orch.store.all()[0]
    assert t.from_facts == ["f001"]                    # 依据哪条事实
    assert t.produced, "产出了哪些事实必须记下来，否则画不出边"
    f2 = board.get(t.produced[0])
    assert f2.produced_by == "t001" and f2.refs == ["f001"]
