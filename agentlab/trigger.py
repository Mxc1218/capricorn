"""触发器 —— 什么时候该让规划者再看一眼图。

这套判定不是我发明的，是从 Lucy（Cairn scheduler/loop.py）里搬过来的。
原作者踩过的坑都写在注释里，所以语义必须原样保留，不要顺手优化。

三条核心规则：
1. 不是「图一变就响」，是「事实数增长才响」。
   任意变化触发会让规划者每秒看一次图，而每条方向要跑几分钟 ——
   生产速度是消费速度的二十倍，方向必然爆炸。
2. open_intents 从有到零，才响一次（这轮做完了，该想下一步）。
3. 静止重规划：零未结案 + 无执行在跑 + 上次静止重规划后事实增加了，才允许再规划一次。
   哨兵 last_idle_replan_facts 防重复触发。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ReasonCheckpoint:
    """上一次 reason 时，图的样子。用于判断「有没有新信息」。"""
    fact_count: int = 0
    hint_count: int = 0
    open_intent_count: int = 0
    # ★ -1 是哨兵：表示还没静止重规划过，不参与比较。
    #   若让哨兵参与，len(facts) > -1 恒真 ⇒ 零变化也会被当成有新信息放行。
    last_idle_replan_facts: int = -1


def reason_trigger(
    fact_count: int,
    hint_count: int,
    open_intent_count: int,
    running_count: int,
    checkpoint: ReasonCheckpoint | None,
) -> str | None:
    """返回触发原因；None 表示不该触发。

    例：facts:3->7 / open_intents:2->0 / idle_replan / initial
    """
    if checkpoint is None:
        return "initial"

    changes: list[str] = []
    if fact_count > checkpoint.fact_count:
        changes.append("facts:%d->%d" % (checkpoint.fact_count, fact_count))
    if hint_count > checkpoint.hint_count:
        changes.append("hints:%d->%d" % (checkpoint.hint_count, hint_count))
    if checkpoint.open_intent_count > 0 and open_intent_count == 0:
        changes.append("open_intents:%d->0" % checkpoint.open_intent_count)

    if changes:
        return ",".join(changes)

    # ── 零变化时的静止重规划 ────────────────────────────────
    # 只在没有未结案方向、也没有任务在跑、且事实确实比上次多时才允许。
    # 为什么要求 running == 0：有任务在跑时它跑完自然会写事实，那条路已经能触发。
    if open_intent_count == 0 and running_count == 0:
        last = checkpoint.last_idle_replan_facts
        if last >= 0 and fact_count > last:
            checkpoint.last_idle_replan_facts = fact_count
            checkpoint.open_intent_count = 0
            return "idle_replan"
    return None


def reason_checkpoint_decision(outcome: str, attempts_before: int, max_attempts: int) -> tuple[bool, bool]:
    """reason 结束后要不要推进 checkpoint。返回 (advance, give_up)。

    success          → (True,  False)  这轮确实消化了这个图状态
    failed 未到上限   → (False, False) 保住触发源，冷却过后能自动重试
    failed 已达上限   → (True,  True)  放弃（不推进就会永远重试）

    ★ failed 为什么不推进：推进等于把触发源杀掉，而冷却检查嵌在
      「有触发源才检查」的位置 —— 触发源一死就再也走不到冷却，项目永久卡死。
      这是 Lucy 那边实测出来的真 bug。
    """
    if outcome == "success":
        return True, False
    if outcome == "failed":
        if attempts_before + 1 >= max_attempts:
            return True, True
        return False, False
    return False, False


def slot_limit(max_workers: int, active_projects: int, dynamic: bool,
               min_project_workers: int, max_project_workers: int) -> int:
    """这个项目这一轮能用几个执行槽位。

    关闭动态分配 → 固定 max_project_workers；
    开启动态分配 → max(min_project_workers, max_workers // 活跃项目数)。

    为什么要动态：固定上限在池子小于 N×上限时退化成先到先得，
    而排队顺序与项目需要多少无关；只剩一道大题时应该让它吃满池子。
    """
    if not dynamic:
        return max_project_workers
    n = max(1, active_projects)
    return max(min_project_workers, max_workers // n)