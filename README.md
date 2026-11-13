# 摩羯 · Capricorn

一个从零写的 agent 内核，和一个能回答「这次改动有没有用」的评测台。

做这东西的原点很朴素：市面上讲 agent 的文章都在讲架构，很少有人讲**它花了多少钱、卡在哪一步、改了一行到底有没有变好**。这个仓库只解决这件事。

## 目录

```
agentlab/
  llm.py        模型客户端（OpenAI 兼容，标准库，重试 + usage 采集）
  tools.py      工具注册表（schema + 实现 + 风险等级）
  loop.py       ReAct 内核（149 行）
  trace.py      结构化 trace（JSONL，一行一个事件）
  cli.py        命令行入口

eval/
  tasks/        题目（题面 + 附件；答案不在里面）
  answers/      期望的 flag（与题面物理隔离）
  runners.py    runner 适配器（agentlab / stub）
  run.py        跑批 + 判分 + 出报告
```

## 两条命令

跑一道题：

```bash
export DEEPSEEK_API_KEY=...
python -m agentlab "统计当前目录下有多少个 .py 文件"
```

跑一轮评测（先用 stub 验证台子本身，再换成真模型）：

```bash
python -m eval.run --runner stub
python -m eval.run --runner agentlab --limit 2
```

报告落在 `eval/results/run-<时间>/summary.md`：解出率、平均耗时、平均 token、每题失败原因。

## 设计上的三个决定

**trace 从第一天就有。** 每次运行落一份 JSONL，每一步带 token 用量。没有这个，后面所有优化都是猜。

**工具带 `risk` 字段。** 现在只记录，将来审批就从这里读——动作的风险等级必须是动作自己带的属性，不能事后从日志里猜。

**评测只看落地物。** 判分读工作目录里的 `flag.txt`，不解析 stdout——stdout 会被日志污染。

## 已知不足

- 没有上下文压缩（长任务会一直涨）
- 没有流式输出
- 没有权限审批
- Windows 下的 shell 输出编码靠猜（先 utf-8 再 gbk）

这些不是 TODO，是路线图上已经有位置的东西。
