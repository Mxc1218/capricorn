# 当前状态（交接用）

> 换会话、换人、或者三个月后回来看，先读这一页。
> **规矩：边做边改，不要等到收工才写。** 收工时人已经累了，写出来的都是糊的。
> 最后更新：2026-11-13

## 目标

一句话：**造一把能回答「这次改动有没有用」的尺子**，顺带把 agent 的 token 花在哪看清楚。

## 现在在哪

```
仓库    https://github.com/Mxc1218/capricorn
分支    main
HEAD    e0567bb
规模    989 行 Python（agentlab + eval + tests）
```

## 已验证的事实（都有证据路径）

| 事实 | 证据 |
|---|---|
| 内核能跑通真实任务 | `runs/run-20261113-181549.jsonl`：5 步、8936 prompt / 1482 completion / 7424 缓存 |
| 缓存命中率 83% | 同上，DeepSeek 的 Anthropic 兼容端点前缀缓存确实生效 |
| 判分链路可用 | `eval/results/run-20261113-202009/summary.md`：stub runner 2/2 |
| 路径隔离生效 | 自测：`../escape.txt` 被 `PermissionError` 拦 |
| 三个假模型测试通过 | `pytest tests` → 3 passed |

## 未验证的假设（别当结论用）

- **「pi 适合当内核」**：没实测过，只是它是 MIT 且语言无关。
- **「上下文压缩能省 30 倍」**：那是从 `proj_003` 的图算出来的理论值（全量 39k token/轮 vs 增量 3.9k），没有真实对照。
- **「同一批题跑三次方差很小」**：完全没测。

## 下一步（按顺序，最多做前两条）

1. **扩到 10 道题**（crypto 5 + misc 5，来自 Alibaba CTF），跑出第一份基线报告
2. **加 pi runner**（子进程 CLI），形成"自己写的 vs 借的核"对照
3. 上下文压缩第一版 + 前后对比
4. 方差测试（同批题 ×3）

## 踩过的坑（带现场，别再踩）

- **文件工具路径基准**：相对路径原来按进程 cwd 解析，和 `run_shell` 的 `cd` 不一致 → agent 把文件写到仓库根。已修，见 DESIGN.md 决策 6。
- **没有墙钟预算**：agent 跑 `factorint` 分解 1024 位数，卡死 20 分钟，步数计数器不动。已加 `deadline_s`。
- **Windows 输出编码**：`text=True, encoding="utf-8"` 会让 cmd.exe 的中文报错变乱码，模型读不懂、连烧三步。改为先 utf-8 再 gbk。
- **环境不自述**：不提"你在 Windows/cmd.exe"，模型会先跑 `ls` 再跑 `dir` 再跑 `cd`。

## 别碰的地方

- `eval/answers/` —— 答案目录，**任何情况下都不要放进题目的工作目录**
- 任何含 API Key 的文件（`.env`、本地 yaml）—— 密钥只进环境变量和本地文件，不进对话、不进仓库

## 相关的另一摊

Lucy（`E:\渗透agent\Lucy`）是另一个项目：Cairn 的衍生，AGPL-3.0，见那边的 `PROVENANCE.md`。
**两个项目不要互相 import**，共享的只有"判断"，不共享代码。
