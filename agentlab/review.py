"""优先级规则引擎 —— 判定一条方向/一个操作该排多急。

和"安全策略"是两件事：
    安全策略  决定"能不能做"（授权、风险），默认拒绝
    优先级规则 决定"什么时候做"，默认放行

为什么要独立成层：规划者每轮都在被新的模型输出重写，而"这类动作值不值得现在做"
是个稳定的、会被反复修订的判断 —— 它应该来自规则表，而不是模型每次重新想一遍。

规则表在 policy/rules.yaml。改规则不用改这里。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

RULES_PATH = Path(__file__).resolve().parent.parent / "policy" / "rules.yaml"


def _load_yaml(path: Path) -> dict:
    try:
        import yaml
    except ImportError:  # pragma: no cover - venv 里都有
        return json.loads(path.read_text(encoding="utf-8"))
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


@dataclass
class Rule:
    id: str
    when: dict
    then: dict
    evidence: str = ""
    examples: dict = field(default_factory=dict)

    def matches(self, text: str) -> bool:
        low = text.lower()
        when = self.when or {}
        any_kw = [str(k).lower() for k in (when.get("any") or [])]
        if any_kw and not any(k in low for k in any_kw):
            return False
        none_kw = [str(k).lower() for k in (when.get("none") or [])]
        if none_kw and any(k in low for k in none_kw):
            return False
        scale = [str(k).lower() for k in (when.get("scale_any") or [])]
        if scale and not any(k in low for k in scale):
            return False
        return True


class RuleBook:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else RULES_PATH
        data = _load_yaml(self.path)
        self.version = data.get("version", 0)
        self.updated = data.get("updated", "")
        self.defaults = data.get("defaults") or {"priority": 2, "verdict": "ALLOW"}
        self.rules = [Rule(id=r["id"], when=r.get("when") or {}, then=r.get("then") or {},
                           evidence=r.get("evidence") or "", examples=r.get("examples") or {})
                      for r in (data.get("rules") or [])]

    def judge(self, text: str) -> dict:
        """返回命中的所有规则；优先级取【最严】的那个（数值最大的 priority）。

        为什么取最严而不是先命中优先：规则表会反复改顺序，
        取最严能让"改顺序"不改变行为，避免一次排序调整把整批任务重排。
        """
        hits = [r for r in self.rules if r.matches(text or "")]
        if not hits:
            return {"rule": None, "matched": [], "priority": int(self.defaults.get("priority", 2)),
                    "verdict": self.defaults.get("verdict", "ALLOW"),
                    "reason": self.defaults.get("reason", "未命中规则，按原始优先级放行")}
        worst = max(hits, key=lambda r: int(r.then.get("priority", 2)))
        prio = int(worst.then.get("priority", 2))
        return {
            "rule": worst.id,
            "matched": [r.id for r in hits],
            "priority": prio,
            "verdict": worst.then.get("verdict", "ALLOW"),
            "reason": worst.then.get("reason", ""),
            "evidence": worst.evidence,
        }


def task_text(title: str, detail: str = "") -> str:
    return "%s\n%s" % (title or "", detail or "")


def main(argv=None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="规则表解释器：看一句话会被判成什么")
    ap.add_argument("text", nargs="*", help="要判定的一句话")
    ap.add_argument("--file", default="", help="从文件读多行")
    ap.add_argument("--rules", default="", help="换一份规则表")
    args = ap.parse_args(argv)

    book = RuleBook(Path(args.rules) if args.rules else None)
    lines = list(args.text)
    if args.file:
        lines += [l.strip() for l in Path(args.file).read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        print("用法: python -m agentlab.review \"用 gobuster 大字典枚举目录\"")
        print("规则表版本 %s（%s），共 %d 条" % (book.version, book.updated, len(book.rules)))
        for r in book.rules:
            print("  %-24s → P%d  %s" % (r.id, int(r.then.get("priority", 2)),
                                         (r.then.get("reason") or "")[:40]))
        return 0

    for line in lines:
        j = book.judge(line)
        print("· %s" % line[:70])
        print("   → P%d  %s" % (j["priority"], j.get("reason") or ""))
        if j["matched"]:
            print("   命中规则: %s" % ", ".join(j["matched"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())