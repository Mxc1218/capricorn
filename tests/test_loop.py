"""用假模型测 ReAct 循环 —— 不花一分钱，行为可复现。"""
from __future__ import annotations

import json
from pathlib import Path

from agentlab.llm import Reply, Usage
from agentlab.loop import Agent
from agentlab.tools import Registry, Tool, default_registry


class FakeLLM:
    """按脚本依次返回 assistant 消息。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0
        self.model = "fake"

    def chat(self, messages, tools=None, temperature=0.2):
        self.calls += 1
        msg = self.script.pop(0)
        return Reply(message=msg, usage=Usage(prompt_tokens=100, completion_tokens=20))


def _toolcall(name, args, cid="c1"):
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


def test_loop_executes_tool_then_finishes(tmp_path: Path):
    reg = default_registry(tmp_path)
    target = tmp_path / "n.txt"
    target.write_text("hello", encoding="utf-8")

    llm = FakeLLM([
        _toolcall("read_file", {"path": str(target)}),
        _toolcall("finish", {"answer": "文件内容是 hello"}),
    ])
    agent = Agent(llm=llm, registry=reg, max_steps=5, trace_dir=tmp_path / "runs")
    res = agent.run("读一下 n.txt")

    assert res.finished is True
    assert res.answer == "文件内容是 hello"
    assert [s.tool for s in res.steps] == ["read_file", "finish"]
    assert "hello" in res.steps[0].observation
    assert res.usage.prompt_tokens == 200 and res.usage.completion_tokens == 40

    # trace 必须是结构化的、可聚合的
    events = [json.loads(l) for l in Path(res.trace_path).read_text(encoding="utf-8").splitlines()]
    kinds = [e["kind"] for e in events]
    assert kinds[0] == "run_start" and kinds[-1] == "run_end"
    assert "tool" in kinds and "model" in kinds


def test_tool_error_is_observation_not_crash(tmp_path: Path):
    reg = default_registry(tmp_path)
    llm = FakeLLM([
        _toolcall("read_file", {"path": str(tmp_path / "nope.txt")}),
        _toolcall("finish", {"answer": "文件不存在"}),
    ])
    res = Agent(llm=llm, registry=reg, max_steps=5, trace_dir=tmp_path / "runs").run("读不存在的文件")
    assert "[工具报错]" in res.steps[0].observation
    assert res.finished is True


def test_step_budget_is_enforced(tmp_path: Path):
    reg = default_registry(tmp_path)
    script = [_toolcall("run_shell", {"command": "echo x"}) for _ in range(3)]
    res = Agent(llm=FakeLLM(script), registry=reg, max_steps=3, trace_dir=None).run("无限循环")
    assert res.finished is False
    assert len(res.steps) == 3
    assert "步数用尽" in res.answer
