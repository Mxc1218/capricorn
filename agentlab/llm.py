"""LLM 客户端 —— OpenAI 兼容的 chat/completions，只用标准库。

为什么是一个类而不是直接 requests:
    测试要能换成假模型（见 tests/），所以调用面只暴露 chat() 一个方法。
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def merge(self, other: "Usage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.cached_tokens += other.cached_tokens


@dataclass
class Reply:
    message: dict[str, Any]          # assistant 消息原文（可能带 tool_calls）
    usage: Usage
    raw: dict[str, Any] = field(default_factory=dict)


class LLM:
    """最小可用的 OpenAI 兼容客户端。"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: int = 180,
        retries: int = 3,
    ):
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
        self.base_url = (base_url or os.environ.get("AGENTLAB_BASE_URL", "https://api.deepseek.com")).rstrip("/")
        self.model = model or os.environ.get("AGENTLAB_MODEL", "deepseek-flash")
        self.timeout = timeout
        self.retries = retries

    # -- 对外只有一个方法 ---------------------------------------------------
    def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.2,
    ) -> Reply:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                data = self._post("/chat/completions", body)
                choice = data["choices"][0]
                msg = choice["message"]
                u = data.get("usage") or {}
                usage = Usage(
                    prompt_tokens=int(u.get("prompt_tokens") or 0),
                    completion_tokens=int(u.get("completion_tokens") or 0),
                    cached_tokens=int(u.get("prompt_cache_hit_tokens") or 0),
                )
                return Reply(message=msg, usage=usage, raw=data)
            except Exception as exc:  # 网络/限流/5xx 一律退避重试
                last = exc
                if attempt < self.retries:
                    time.sleep(min(30, 2 ** attempt))
        raise RuntimeError(f"LLM 调用失败（重试 {self.retries} 次）: {last}") from last

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
