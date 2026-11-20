"""触发器的语义测试 —— 从 Lucy 搬过来的那套判定必须原样成立。"""
from __future__ import annotations

from agentlab.trigger import (ReasonCheckpoint, reason_checkpoint_decision,
                              reason_trigger, slot_limit)


def advance(cp: ReasonCheckpoint, facts: int, open_intents: int) -> None:
    """模拟 reason 成功：把 checkpoint 推到当前图状态。"""
    cp.fact_count = facts
    cp.open_intent_count = open_intents


def test_initial_triggers_once():
    assert reason_trigger(0, 0, 0, 0, None) == "initial"


def test_no_change_does_not_trigger():
    cp = ReasonCheckpoint(fact_count=3, open_intent_count=2)
    assert reason_trigger(3, 0, 2, 1, cp) is None


def test_facts_growth_triggers():
    cp = ReasonCheckpoint(fact_count=3, open_intent_count=2)
    assert reason_trigger(7, 0, 2, 1, cp) == "facts:3->7"


def test_open_intents_dropping_to_zero_triggers():
    cp = ReasonCheckpoint(fact_count=3, open_intent_count=2)
    assert reason_trigger(3, 0, 0, 1, cp) == "open_intents:2->0"


def test_idle_replan_only_when_facts_grew_and_nothing_runs():
    cp = ReasonCheckpoint(fact_count=5, open_intent_count=0, last_idle_replan_facts=5)
    # 有任务在跑 → 不该抢跑
    assert reason_trigger(9, 0, 0, 1, cp) == "facts:5->9"
    # 没任务、事实也没涨 → 不该响
    cp2 = ReasonCheckpoint(fact_count=9, open_intent_count=0, last_idle_replan_facts=9)
    assert reason_trigger(9, 0, 0, 0, cp2) is None


def test_idle_replan_sentinel_prevents_repeat():
    # 哨兵未初始化（-1）时 idle 分支不参与判定 —— 防止零变化被当成有新信息
    cp = ReasonCheckpoint(fact_count=9, open_intent_count=0, last_idle_replan_facts=-1)
    assert reason_trigger(9, 0, 0, 0, cp) is None
    # 哨兵就位且事实涨了 → 响一次，并把哨兵推到当前事实数
    cp.last_idle_replan_facts = 9
    assert reason_trigger(9, 0, 0, 0, cp) is None      # 没涨，不响


def test_success_advances_checkpoint():
    assert reason_checkpoint_decision("success", 0, 3) == (True, False)


def test_failure_keeps_trigger_source_alive():
    # ★ 这条是 Lucy 那边「reason 失败后项目永久死锁」的回归测试
    assert reason_checkpoint_decision("failed", 0, 3) == (False, False)
    assert reason_checkpoint_decision("failed", 1, 3) == (False, False)


def test_failure_gives_up_at_max_attempts():
    assert reason_checkpoint_decision("failed", 2, 3) == (True, True)


def test_timeout_does_not_advance():
    assert reason_checkpoint_decision("timed_out", 0, 3) == (False, False)


def test_slot_limit_fixed_and_dynamic():
    assert slot_limit(4, 1, False, 2, 3) == 3          # 固定值直接返回
    assert slot_limit(4, 1, True, 2, 3) == 4           # 单项目吃满池子
    assert slot_limit(4, 2, True, 2, 3) == 2           # 两个项目各 2
    assert slot_limit(4, 9, True, 2, 3) == 2           # 下限保护