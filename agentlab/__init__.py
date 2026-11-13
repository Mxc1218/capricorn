"""agentlab — 一个从零写的 ReAct 内核。

设计原则（也是学习点）:
1. 每一步都可观测 —— 一次 run 落一份 JSONL trace，含每步 token 用量。
2. 工具是一等公民 —— 有名字、有 JSON Schema、有风险等级（为将来的审批留口子）。
3. 模型可换 —— LLM 是协议，测试里用假模型，真实跑用 DeepSeek。
"""

__version__ = "0.1.0"
