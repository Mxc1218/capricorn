"""工具层 —— 工具是一等公民。

每个工具三样东西:
    schema  给模型看（JSON Schema）
    call    真正执行
    risk    风险等级（read / write / exec / none）—— 审批模型就是从这长出来的

★ 为什么现在就要 risk 字段:
    等你有"人在环路"需求时，审批的判断依据必须是动作本身带的属性，
    而不是事后看日志猜。现在多写一个字段，将来少一次重构。
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

MAX_OBS_CHARS = 4000


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    fn: Callable[..., str]
    risk: str = "read"

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def call(self, args: dict[str, Any]) -> str:
        out = self.fn(**args)
        out = "" if out is None else str(out)
        if len(out) > MAX_OBS_CHARS:
            out = out[:MAX_OBS_CHARS] + f"\n…（已截断，原始 {len(out)} 字符）"
        return out


class Registry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise KeyError(f"未知工具: {name}（可用: {', '.join(self._tools)}）")
        return self._tools[name]

    def schemas(self) -> list[dict[str, Any]]:
        return [t.schema() for t in self._tools.values()]

    def describe(self) -> str:
        return "\n".join(f"- {t.name}({', '.join((t.parameters.get('properties') or {}))}) [{t.risk}] {t.description}"
                          for t in self._tools.values())


class Finish(Exception):
    """调用 finish 工具时抛出，用来干净地结束一轮。"""

    def __init__(self, answer: str):
        super().__init__(answer)
        self.answer = answer


# -- 内置工具 ---------------------------------------------------------------

def _decode(raw: bytes) -> str:
    """Windows 控制台默认 GBK —— 先按 utf-8 解，解不动再按 gbk。

    ★ 教训：第一版用 text=True + encoding="utf-8"，cmd.exe 的中文错误信息
      变成一片乱码，模型读不懂，连烧三步在猜"到底哪错了"。
    """
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def _run_shell(command: str, timeout: int = 60) -> str:
    """跑一条 shell 命令，**保证**在 timeout 附近返回。

    ★ 实战教训（2026-11-19，第一次打真 HTB）：subprocess.run(timeout=60) 在 Windows 上
      杀的是 cmd.exe，但 cmd 拉起的子进程（这里是 nmap）还攥着管道，
      communicate() 于是永远等下去 —— 超时形同虚设，整个执行者卡死。
      ⇒ 自己 Popen + 用 taskkill /T 连子孙一起收。
    """
    import os as _os

    proc = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = proc.communicate(timeout=timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        try:
            if _os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               capture_output=True, timeout=10)
            else:
                proc.kill()
        except Exception:
            pass
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = b"", b""
        text = _decode(out or b"") + ("\n[stderr]\n" + _decode(err) if err else "")
        return "[超时 %ds，已强杀]\n%s" % (timeout, text.strip()[:4000] or "(无输出)")

    text = _decode(out or b"") + ("\n[stderr]\n" + _decode(err) if err else "")
    return f"[exit={code}]\n{text.strip() or '(无输出)'}"


def _read_file(path: str, max_bytes: int = 20000) -> str:
    data = Path(path).read_bytes()[:max_bytes]
    return data.decode("utf-8", "replace")


def _write_file(path: str, content: str) -> str:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"已写入 {p}（{len(content)} 字符）"


def _to_wsl_path(p: Path) -> str:
    """Windows 路径 → WSL 里的 /mnt/<盘>/... 路径。"""
    s = str(Path(p).resolve())
    if len(s) >= 2 and s[1] == ":":
        drive = s[0].lower()
        rest = s[2:].replace("\\", "/")
        return "/mnt/%s%s" % (drive, rest)
    return s.replace("\\", "/")


def _run_shell_wsl(workdir: Path, command: str, timeout: int = 60) -> str:
    """把命令放进 WSL(Ubuntu) 里跑 —— 这是不用 Docker 的"容器"。

    ★ 为什么非这样不可：在 Windows cmd 里拼复杂命令（curl payload、for /f 循环、
      百分号展开），实测 42% 的调用返回非零，而且大多不是能力问题，是转义问题。
      命令写成脚本文件再交给 bash 跑，引号一个都不用转义。

    命令先落到工作目录里的 .agent_cmd.sh，再 bash 执行 —— 不做任何字符串拼接。
    """
    script = Path(workdir) / ".agent_cmd.sh"
    try:
        # ★ 必须写字节：Windows 上 write_text 会把 \n 变成 \r\n，
        #   bash 读到的是 "cd /mnt/e/xxx\r"，直接报 No such file or directory。
        body = "cd %s\n%s\n" % (_to_wsl_path(workdir), command)
        script.write_bytes(body.encode("utf-8"))
    except Exception as exc:
        return "[写入脚本失败] %s" % exc
    return _run_shell(
        'wsl -d Ubuntu -e bash "%s"' % _to_wsl_path(script),
        timeout=timeout,
    )


def _inside(workdir: Path, path: str) -> Path:
    """把文件工具的路径钉在任务工作目录里，并且不许越界。

    ★ 实战教训（2026-11-13，评测台第一次真跑）：read_file / write_file 原来直接
      用 `Path(path)`，相对路径按【进程 cwd】解析，不是按任务工作目录 ——
      agent 把 data.py / info.py 写到了仓库根，而 run_shell 却是 `cd <workdir> && ...`。
      两个工具基准不一致，等于隔离形同虚设。
      ⇒ 所有文件类工具统一走这里：相对路径拼 workdir，绝对路径也必须落在 workdir 内。
    """
    p = Path(path)
    root = Path(workdir).resolve()
    target = (p if p.is_absolute() else root / p).resolve()
    if root != target and root not in target.parents:
        raise PermissionError(f"路径越界: {path}（只允许在 {root} 内操作）")
    return target


def board_registry(workdir: Path, board, task_id: str = "") -> Registry:
    """带黑板的工具集 —— 在默认四个工具之外多三个。

    ★ 为什么 note / recall / read_fact 要分开，而不是把黑板全塞进 prompt：
      事实一多，全量渲染就把上下文吃光。所以 prompt 里只放【一行摘要】，
      要看全文必须显式 read_fact —— 这是"知道有这条"与"看清这条"的分离，
      也是省 token 的关键。
    """
    reg = default_registry(workdir)

    def note(kind: str, content: str, refs: str = "", status: str = "unverified") -> str:
        """refs 是"依据哪几条已有事实"；status 是证据等级。

        ★ 为什么要让 agent 自己标等级：它最清楚"这是猜的、这是验过的"。
          但默认是 unverified —— 不给默认值，agent 就会把猜测当结论标成 accepted。
        """
        ref_list = [x.strip() for x in str(refs or "").split(",") if x.strip()]
        fact = board.add(kind, content, source="agent", refs=ref_list, produced_by=task_id,
                         evidence_status=status or "unverified")
        return "已记入黑板 %s [%s] %s" % (fact.id, fact.kind, fact.summary)

    def recall(query: str, limit: int = 8) -> str:
        hits = board.search(query, limit=limit)
        if not hits:
            return "(没有匹配的事实)"
        return "\\n".join("%s [%s] %s" % (f.id, f.kind, f.summary) for f in hits)

    def read_fact(fid: str) -> str:
        f = board.get(fid)
        return f.content if f else "(没有这条事实: %s)" % fid

    reg.add(Tool(
        name="note",
        description="把一条【已确认】的结论记进黑板，供本轮之后和下一次运行使用。"
                    "kind 只能是 host/service/vuln/cred/loot/flag/note。记结论，不记计划。",
        parameters={"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["host", "service", "vuln", "cred", "loot", "flag", "note"]},
            "content": {"type": "string", "description": "一句话说清：发生了什么、在哪、依据是什么"},
            "refs": {"type": "string", "description": "可选：这条结论依据哪几条已有事实（逗号分隔的事实 id，如 f002,f004）"},
            "status": {"type": "string", "enum": ["unverified", "candidate", "accepted", "rejected", "negated"],
                       "description": "证据等级：没验证过的用 unverified；只是怀疑用 candidate；亲自验证通过的用 accepted"},
        }, "required": ["kind", "content"]},
        fn=note,
        risk="write",
    ))
    reg.add(Tool(
        name="recall",
        description="在黑板上按关键词查已有事实（只返回一行摘要）。开工前先查一次，别重复别人做过的事。",
        parameters={"type": "object", "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer"},
        }, "required": ["query"]},
        fn=recall,
        risk="read",
    ))
    reg.add(Tool(
        name="read_fact",
        description="读取某条黑板的完整内容（摘要不够看时用）。",
        parameters={"type": "object", "properties": {"fid": {"type": "string"}}, "required": ["fid"]},
        fn=read_fact,
        risk="read",
    ))
    return reg


def default_registry(workdir: Path) -> Registry:
    reg = Registry()
    workdir = Path(workdir).resolve()

    def shell(command: str) -> str:
        # 扫全端口这类命令 60 秒不够；用环境变量按需放宽（默认仍是 60）
        import os as _os
        limit = int(_os.environ.get("AGENTLAB_SHELL_TIMEOUT", "60"))
        if _os.environ.get("AGENTLAB_SHELL", "cmd").lower() == "wsl":
            return _run_shell_wsl(workdir, command, timeout=limit)
        return _run_shell(f'cd "{workdir}" && {command}', timeout=limit)

    def read_inside(path: str) -> str:
        return _read_file(str(_inside(workdir, path)))

    def write_inside(path: str, content: str) -> str:
        return _write_file(str(_inside(workdir, path)), content)

    reg.add(Tool(
        name="run_shell",
        description="在任务工作目录里执行一条 shell 命令，返回 stdout/stderr 与退出码。",
        parameters={"type": "object", "properties": {"command": {"type": "string", "description": "要执行的命令"}},
                    "required": ["command"]},
        fn=shell,
        risk="exec",
    ))
    reg.add(Tool(
        name="read_file",
        description="读取一个文本文件的全部内容（最多 20000 字节）。",
        parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        fn=read_inside,
        risk="read",
    ))
    reg.add(Tool(
        name="write_file",
        description="写入一个文本文件（覆盖），父目录会自动创建。",
        parameters={"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["path", "content"]},
        fn=write_inside,
        risk="write",
    ))
    reg.add(Tool(
        name="finish",
        description="任务已完成时调用，把最终答案交回去。",
        parameters={"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]},
        fn=lambda answer: (_ for _ in ()).throw(Finish(answer)),
        risk="none",
    ))
    return reg