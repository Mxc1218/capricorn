from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

FLAG_RE = re.compile(r"([A-Za-z0-9_]{2,20}\{[^}\n]{4,}\})")


@dataclass
class Task:
    id: str
    dir: Path
    instruction: str
    budget_s: int = 900
    max_steps: int = 30
    kind: str = "unknown"

    @property
    def files_dir(self) -> Path:
        return self.dir / "files"


def load_tasks(tasks_dir: Path, answers_dir: Path, only: list[str] | None = None) -> list[Task]:
    tasks = []
    for d in sorted(Path(tasks_dir).iterdir()):
        if not d.is_dir() or not (d / "instruction.md").exists():
            continue
        if only and d.name not in only:
            continue
        if not (answers_dir / f"{d.name}.txt").exists():
            raise FileNotFoundError(f"缺少答案: {answers_dir / (d.name + '.txt')}")
        meta = {}
        if (d / "meta.json").exists():
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        tasks.append(Task(
            id=d.name,
            dir=d,
            instruction=(d / "instruction.md").read_text(encoding="utf-8"),
            budget_s=int(meta.get("budget_s", 900)),
            max_steps=int(meta.get("max_steps", 30)),
            kind=str(meta.get("kind", "unknown")),
        ))
    return tasks


def prepare_workdir(task: Task, dest: Path) -> Path:
    """给这道题一个干净的工作目录：只有题面和附件，没有答案、没有上一题的残留。"""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    (dest / "INSTRUCTION.md").write_text(task.instruction, encoding="utf-8")
    if task.files_dir.is_dir():
        shutil.copytree(task.files_dir, dest / "files")
    return dest


def find_flag(stdout: str, workdir: Path) -> str | None:
    """判分只看落地物：先看 flag.txt，再看 stdout。"""
    f = workdir / "flag.txt"
    if f.exists():
        text = f.read_text(encoding="utf-8", errors="replace").strip()
        if text:
            return text.split()[0]
    m = FLAG_RE.search(stdout or "")
    return m.group(1) if m else None


def check(answer_file: Path, found: str | None) -> bool:
    if not found:
        return False
    expected = answer_file.read_text(encoding="utf-8").strip().split()[0]
    return found.strip() == expected
