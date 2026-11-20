"""编排 —— 一个规划者 + 若干执行者。

有两种调度模式：

**round（旧）**：规划 → 并发派发 → 等全部结束 → 再规划。
    问题：t001 第 31 秒就完成了，规划者要等最慢的 t002（368 秒）才醒。
    实测 e1-01 的 9 分钟里，有 6 分钟是这么被耗掉的。

**tick（新）**：每一秒看一眼 —— 谁完成了就收进来；触发器响了就派 reason；
    有空槽就派 explore。判定用的是从 Lucy 搬来的 reason_trigger（见 trigger.py）。

tick 模式的三个关键点：
    1. reason 不阻塞：它和 explore 一样是线程池里的一个任务；
    2. 触发靠 checkpoint 而不是"图变了"（细节见 trigger.py 顶部）；
    3. 谁先完成谁先回来 —— 用 submit 而不是 map。
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .board import Board
from .llm import LLM
from .loop import Agent
from .planner import PROMPT as PLANNER_PROMPT
from .planner import parse_plan, render_tasks
from .tasks import Task, TaskStore
from .trigger import (ReasonCheckpoint, reason_checkpoint_decision,
                      reason_trigger)

REASON_KEY = "__reason__"


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
    reason_triggered: int = 0        # 规划者被唤醒了几次
    explore_dispatched: int = 0


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
        mode: str = "tick",
        done_when: str = "",
        reason_cooldown: float = 60.0,
        reason_max_attempts: int = 3,
    ):
        self.llm = llm
        self.board = board
        self.workdir = Path(workdir)
        self.workers = workers
        self.max_rounds = max_rounds
        self.max_new_tasks = max_new_tasks
        # 0 = 不限步数：只靠时间预算兜底
        self.steps_per_task = 10**6 if (steps_per_task or 0) <= 0 else steps_per_task
        self.seconds_per_task = seconds_per_task
        self.trace_dir = trace_dir
        self.live_dir = live_dir
        self.total_seconds = total_seconds
        self.mode = mode
        self.done_when = done_when
        self.reason_cooldown = reason_cooldown
        self.reason_max_attempts = reason_max_attempts

        self._started_at = 0.0
        self.store = TaskStore(tasks_path or (self.workdir / "tasks.jsonl"))
        self._lock = threading.Lock()
        self.goal = ""

        # 触发器状态（进程内，重启等于 initial —— 和 Lucy 一致）
        self.checkpoint: ReasonCheckpoint | None = None
        self.reason_fail_until = 0.0
        self.reason_attempts = 0
        self.planner_done = False
        self.done_without_evidence = 0
        self.give_up_reason = ""

        if registry_factory is None:
            from .tools import board_registry

            registry_factory = lambda wd, tid="": board_registry(wd, self.board, task_id=tid)  # noqa: E731
        self.registry_factory = registry_factory

    # -- 账目 ---------------------------------------------------------------
    def remaining(self) -> float:
        if not self.total_seconds or not self._started_at:
            return float("inf")
        return self.total_seconds - (time.time() - self._started_at)

    def open_intent_count(self) -> int:
        return sum(1 for t in self.store.all() if t.status in ("pending", "running"))

    def pending_tasks(self) -> list[Task]:
        return [t for t in self.store.all() if t.status == "pending"]

    def done_file_exists(self) -> bool:
        # ★ 不能只看文件是否存在：跑分脚本会先建一个空的 flag.txt 占位，
        #   只看 exists() 会让 agent 在第 0 秒就收工（实测踩过：耗时 0s、黑板 0 条）。
        #   必须「存在 + 非空」才算达成。
        if not self.done_when:
            return False
        p = Path(self.done_when)
        try:
            return p.exists() and bool(p.read_text(encoding="utf-8", errors="replace").strip())
        except Exception:
            return False

    def board_has_flag(self) -> bool:
        """黑板上是否已经有 flag 类事实。

        ★ 实测（2026-11-20，e1-01 第二次跑）：agent 把 flag 记进了黑板 f004，
          但没写 flag.txt —— 只盯文件的话，达成判定永远不响，它会继续跑满预算。
          "结果落在哪"不该只有一条通道。
        """
        for f in self.board.all():
            if f.kind == "flag" and (f.content or "").strip():
                return True
        return False

    def goal_achieved(self) -> bool:
        """目标达成的两条通道：产物文件有内容，或黑板上已有 flag 事实。"""
        return self.done_file_exists() or self.board_has_flag()

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

    def _run_reason(self) -> bool:
        """规划者的一次唤醒。返回是否成功（决定 checkpoint 要不要推进）。"""
        try:
            plan = self.plan()
        except Exception:
            return False

        if plan.done:
            # ★★ 规划者不能单独宣布"完成"。
            #   实测（2026-11-20 第三次跑 e1-01）：它跑了 5 分 47 秒、只有 2 条事实，
            #   就报 done=True 收工了 —— 一题都没解出来。
            #   所以"完成"必须有【证据】：产物文件有内容，或黑板上已有 flag 事实。
            #   没证据的 done 当"这轮提不出新方向"处理，并计数；反复如此才放弃。
            if self.goal_achieved():
                self.planner_done = True
            else:
                self.done_without_evidence += 1
                if self.done_without_evidence >= 2:
                    self.give_up_reason = "规划者连续声称完成但没有证据（黑板无 flag、产物为空）"
                    self.planner_done = True

        with self._lock:
            for pt in plan.tasks[: self.max_new_tasks]:
                self.store.add(pt.title, pt.detail, pt.from_facts)
        return True

    # -- 执行 ---------------------------------------------------------------
    def _run_task(self, task: Task) -> Task:
        task.status = "running"
        task.started_at = time.time()
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
            "5. 结束前必须在黑板留一条 note：做了什么、结果如何。失败也要留。"
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

        with self._lock:
            task.produced = [f.id for f in self.board.all() if f.id not in before]
            task.ended_at = time.time()
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

    # -- 旧模式：按轮 -------------------------------------------------------
    def _run_rounds(self, report: Report) -> Report:
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
            with ThreadPoolExecutor(max_workers=min(self.workers, len(created))) as pool:
                list(pool.map(self._run_task, created))
            report.reason = plan.reason
        return report

    # -- 新模式：按槽位 -----------------------------------------------------
    def _run_tick(self, report: Report) -> Report:
        running: dict[str, object] = {}
        with ThreadPoolExecutor(max_workers=max(1, self.workers + 1)) as pool:
            while True:
                # 1) 收工判定 —— 两条通道都算：产物文件有内容，或黑板上已有 flag 事实
                if self.goal_achieved():
                    report.finished = True
                    report.reason = ("目标产物已生成：%s" % self.done_when
                                     if self.done_file_exists() else "黑板上已记录 flag 事实")
                    break
                if self.planner_done and not running and not self.pending_tasks():
                    report.finished = self.goal_achieved()
                    report.reason = (self.give_up_reason or
                                     ("规划者判定目标已达成" if report.finished
                                      else "规划者判定完成，但没有任何证据"))
                    break
                if self.remaining() <= 5:
                    report.reason = "总时长预算用尽"
                    break

                # 2) 收已完成的
                reaped = False
                for key in [k for k, f in running.items() if f.done()]:
                    reaped = True
                    fut = running.pop(key)
                    if key == REASON_KEY:
                        ok = False
                        try:
                            ok = bool(fut.result())
                        except Exception:
                            ok = False
                        advance, give_up = reason_checkpoint_decision(
                            "success" if ok else "failed", self.reason_attempts, self.reason_max_attempts)
                        if ok:
                            self.reason_attempts = 0
                            self.checkpoint = ReasonCheckpoint(
                                fact_count=len(self.board.all()),
                                hint_count=0,
                                open_intent_count=self.open_intent_count(),
                                last_idle_replan_facts=(self.checkpoint.last_idle_replan_facts
                                                        if self.checkpoint else -1),
                            )
                        else:
                            self.reason_attempts += 1
                            self.reason_fail_until = time.time() + self.reason_cooldown
                            if give_up:
                                report.reason = "规划者连续失败，放弃"
                    continue

                # ★ 刚收完东西要【回到循环头】重新判定收工条件。
                #   否则会出现：reason 刚说 done=True、任务也收完了，
                #   却因为先走到"全都空了"分支而直接 break，finished 永远是 False。
                if reaped:
                    continue

                # 3) 触发器：该不该唤醒规划者
                explore_running = sum(1 for k in running if k != REASON_KEY)
                if REASON_KEY not in running and time.time() >= self.reason_fail_until:
                    trig = reason_trigger(
                        fact_count=len(self.board.all()),
                        hint_count=0,
                        open_intent_count=self.open_intent_count(),
                        running_count=len(running),
                        checkpoint=self.checkpoint,
                    )
                    if trig is not None:
                        running[REASON_KEY] = pool.submit(self._run_reason)
                        report.reason_triggered += 1

                # 4) 填空槽
                free = self.workers - explore_running
                if free > 0:
                    for task in self.pending_tasks()[:free]:
                        with self._lock:
                            self.store.update(task)
                        running[task.id] = pool.submit(self._run_task, task)
                        report.explore_dispatched += 1

                # 5) 全都空了 + 规划者也没打算再干 → 收工
                if not running and not self.pending_tasks():
                    trig = reason_trigger(
                        fact_count=len(self.board.all()), hint_count=0,
                        open_intent_count=0, running_count=0, checkpoint=self.checkpoint)
                    if trig is None:
                        if self.planner_done:
                            report.finished = True
                            report.reason = "规划者判定目标已达成"
                        else:
                            report.reason = "没有任务在跑，触发条件也不再响"
                        break

                time.sleep(1)
        return report

    # -- 入口 ---------------------------------------------------------------
    def run(self, goal: str) -> Report:
        self.goal = goal
        self._started_at = time.time()
        report = Report()
        if self.mode == "round":
            return self._run_rounds(report)
        return self._run_tick(report)
