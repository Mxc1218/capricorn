"""编排 —— 一个规划者 + 若干执行者。

一轮的节奏：
    规划（读黑板+任务史，出任务） → 并发派发执行者 → 收结论（写回黑板与任务） → 下一轮

和 Cairn 的区别只有一个，但很关键：
    Cairn 的 reason 每落一条事实就触发一轮；这里是【按轮】触发，
    而且规划者看得到「上一轮派了什么、结果如何」，所以不会四轮重打同一批题。

因果怎么落地（这是能画出树的前提）：
    任务有 from_facts（依据哪些事实）和 produced（产出了哪些事实）；
    事实有 refs 和 produced_by。两边一对，事实↔任务的边就成立了。
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .board import Board
from .llm import LLM
from .loop import Agent
from .planner import PROMPT as PLANNER_PROMPT
from .planner import parse_plan, render_tasks
from .tasks import Task, TaskStore


@dataclass
class Round:
    index: int
    plan_reason: str
    dispatched: list[Task] = field(default_factory=list)
    done: bool = False


@dataclass
class Report:
    rounds: list[Round] = field(default_factory=list)
    finished: bool = False
    reason: str = ""


class Orchestrator:
    def __init__(
        self,
        llm: LLM,
        board: Board,
        workdir: Path,
        registry_factory=None,
        workers: int = 2,
        max_rounds: int = 3,
        max_new_tasks: int = 2,
        steps_per_task: int = 8,
        seconds_per_task: int = 300,
        trace_dir: Path | None = None,
        live_dir: Path | None = None,
        tasks_path: Path | None = None,
        total_seconds: int = 0,
    ):
        self.llm = llm
        self.board = board
        self.workdir = Path(workdir)
        self.workers = workers
        self.max_rounds = max_rounds
        self.max_new_tasks = max_new_tasks
        # 0 = 不限步数：只靠时间预算兜底（墙钟是这个口子唯一的闸）。
        self.steps_per_task = 10**6 if (steps_per_task or 0) <= 0 else steps_per_task
        self.seconds_per_task = seconds_per_task
        self.trace_dir = trace_dir
        self.live_dir = live_dir
        self.total_seconds = total_seconds
        self._started_at = 0.0
        # ★ 默认落在 workdir 里，不落当前目录 —— 否则不同任务会串到同一个 tasks.jsonl
        self.store = TaskStore(tasks_path or (self.workdir / "tasks.jsonl"))
        self._lock = threading.Lock()
        self.goal = ""
        if registry_factory is None:
            from .tools import board_registry

            registry_factory = lambda wd, tid="": board_registry(wd, self.board, task_id=tid)  # noqa: E731
        self.registry_factory = registry_factory

    # -- 规划 ---------------------------------------------------------------
    def plan(self):
        prompt = PLANNER_PROMPT.format(
            goal=self.goal,
            board=self.board.render(),
            tasks=render_tasks(self.store.all()),
            max_new=self.max_new_tasks,
        )
        reply = self.llm.chat([{"role": "user", "content": prompt}])
        return parse_plan(reply.message.get("content") or reply.reasoning or "")

    # -- 执行 ---------------------------------------------------------------
    def _run_task(self, task: Task) -> Task:
        import time as _time

        task.status = "running"
        task.started_at = _time.time()
        task.worker = task.id
        self.store.update(task)

        brief = (
            "你领到一条任务，只能做这一条：\n\n"
            "# 任务\n%s\n\n# 细节\n%s\n\n"
            "# 你的依据（黑板上的事实）\n%s\n\n"
            "# 规矩\n"
            "1. 先把确认到的结论用 note 记进黑板，再继续下一步。\n"
            "2. 只做这一条任务，不要顺手做别的事。\n"
            "3. 做完调用 finish，把结论一句话写进 answer。\n"
            "4. 做不完也要 finish，说明卡在哪 —— 不要空转到步数用完。\n"
            "5. 结束前必须在黑板留一条 note：做了什么、结果如何。**失败也要留**，"
            "因为\"这条路不通\"和\"这条路通了\"一样值钱。"
        ) % (task.title, task.detail, self._fact_brief(task.from_facts))

        live = None
        if self.live_dir is not None:
            from .live import Live

            live = Live(Path(self.live_dir) / ("%s.json" % task.id), worker=task.id, task=task.title)
            live.update(status="running")

        before = {f.id for f in self.board.all()}
        agent = Agent(
            llm=self.llm,
            registry=self.registry_factory(self.workdir, task.id),
            max_steps=self.steps_per_task,
            trace_dir=self.trace_dir,
            deadline_s=self.seconds_per_task,
            board=self.board,
            live=live,
        )
        try:
            res = agent.run(brief)
            task.result = res.answer or "(无结论)"
            task.status = "done" if res.finished else "failed"
        except Exception as exc:
            task.result = "%s: %s" % (type(exc).__name__, exc)
            task.status = "failed"

        # 因果收口：这条任务产出了哪些事实
        with self._lock:
            task.produced = [f.id for f in self.board.all() if f.id not in before]
            task.ended_at = _time.time()
            # ★ 模型不一定照做，所以"这轮干了什么"由编排者兜底写进黑板。
            #   否则失败轮次在黑板上一片空白，规划者下一轮只能瞎猜 ——
            #   实测就是这么连续猜了四个模块（命令注入→文件上传→文件包含→SQL 注入）。
            if not task.produced:
                fact = self.board.add(
                    "note",
                    "[%s] %s → %s" % (task.status, task.title, (task.result or "无结论")[:200]),
                    source="orchestrator",
                    produced_by=task.id,
                    evidence_status="unverified",
                )
                task.produced = [fact.id]
            self.store.update(task)

        if live is not None:
            live.update(status=task.status, result=task.result[:300])
        return task

    def _fact_brief(self, ids) -> str:
        if not ids:
            return "(无)"
        lines = []
        for fid in ids:
            f = self.board.get(fid)
            lines.append("- %s [%s] %s" % (fid, f.kind, f.content[:200]) if f else "- %s（不存在）" % fid)
        return "\n".join(lines)

    def dispatch(self, tasks: list[Task]) -> list[Task]:
        if not tasks:
            return []
        rem = self.remaining()
        if rem <= 15:
            return []
        self.seconds_per_task = int(min(self.seconds_per_task, rem))
        with ThreadPoolExecutor(max_workers=min(self.workers, len(tasks))) as pool:
            return list(pool.map(self._run_task, tasks))

    # -- 主循环 -------------------------------------------------------------
    def remaining(self) -> float:
        if not self.total_seconds or not self._started_at:
            return float("inf")
        return self.total_seconds - (__import__("time").time() - self._started_at)

    def run(self, goal: str) -> Report:
        import time as _t
        self.goal = goal
        self._started_at = _t.time()
        report = Report()
        for i in range(1, self.max_rounds + 1):
            if self.remaining() <= 20:
                report.reason = "总时长预算用尽"
                break
            plan = self.plan()
            round_ = Round(index=i, plan_reason=plan.reason, done=plan.done)
            report.rounds.append(round_)
            if plan.done:
                report.finished = True
                report.reason = plan.reason
                break
            if not plan.tasks:
                report.reason = "规划者没有派出任何新任务（%s）" % plan.reason
                break

            created = []
            for pt in plan.tasks:
                created.append(self.store.add(pt.title, pt.detail, pt.from_facts))
            round_.dispatched = created

            self.dispatch(created)
            report.reason = plan.reason
        return report
