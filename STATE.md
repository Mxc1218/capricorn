# 当前状态（交接用）

> 换会话、换人、或者三个月后回来看，先读这一页。
> **规矩：边做边改，不要等到收工才写。**
> 最后更新：2026-11-20

## 目标

一句话：**造一把能回答「这次改动有没有用」的尺子**，顺带把 agent 的 token 花在哪、卡在哪看清楚。

## 现在在哪

```
仓库    https://github.com/Mxc1218/capricorn
分支    main
规模    agentlab + eval + viz + tests，测试 14 项全过
```

## 已完成（按时间）

| 块 | 内容 | 证据 |
|---|---|---|
| 内核 | ReAct 循环 + 4 工具 + trace + 墙钟预算 + 路径隔离 | `runs/*.jsonl` |
| 评测台 | 题目/答案隔离、判分、报告、可读复盘 | `eval/results/*/summary.md` |
| 黑板 | 只追加、类型固定、一行摘要 + read_fact 取全文 | `eval/boards/*.jsonl` |
| 角色分工 | 规划者（JSON 契约）+ N 执行者（线程并发） | `agentlab/orchestrator.py` |
| M1 数据 | 三段计时 / 证据分级 / merge 边 | `agentlab/tasks.py`、`board.py`、`state.py` |
| M2 执行态 | 状态徽标 + 计时器 + 失联判定 + 合并置灰 | `viz/` |
| M3 推理树 | 泳道布局（按链分组、左→右）+ 增量重绘 + 详情可跳转 | `viz/index.html` |
| M4 视图 | 推理树 / 总览 / 当前方向 / 全量推导图 / 泳道 / 黑板 / 画布专注 + 筛选器 + hash 路由 | `viz/index.html` |

## 已验证的事实

| 事实 | 证据 |
|---|---|
| 内核能跑真任务 | 5 步跑完一次文件统计；缓存命中 83% |
| 判分链路可用 | stub runner 2/2 |
| 路径隔离生效 | `../escape.txt` 被拦 |
| 可交互任务比纯推理任务省 8 倍输出 | DVWA 10k completion vs babyprng 87k |
| 打穿 DVWA 但拿不到"位置未知的 flag" | `eval/results/run-20261119-215240` |

## 未验证的假设

- 「pi 适合当内核」—— 没实测
- 「上下文压缩省 30 倍」—— 理论值（全量 39k/轮 vs 增量 3.9k），无对照
- 「编排比单 agent 强」—— 代码有了，**还没在同一道题上对比过**


## 2026-11-20 进展（跑分 + 调度改造）

| 块 | 内容 | 证据 |
|---|---|---|
| 跑分接入 | bench/run_one.py：SDK 起容器 → 摩羯打 → 抠 flag → 提交 → 关容器 | bench/runs/e1-01/ |
| 首题通关 | e1-01（SQLi 登录绕过 → 会话登录）9 分钟拿旗，250 分已提交 | 平台 progress=1/1 |
| 触发器迁移 | agentlab/trigger.py 从 Lucy 原样搬三个纯函数 + 11 项语义测试 | tests/test_trigger.py |
| 调度改造 | mode=tick：按槽位触发、reason 异步、谁先完成谁先回来 | tests/test_tick.py |
| 达成即停 | --done-when flag.txt | test_tick_stops_when_done_file_appears |

## 环境结论（今天实测）

| 路径 | 靶场可达 | 用途 |
|---|---|---|
| 宿主 Windows cmd | 可以 | 但 shell 残，42% 调用因转义失败 |
| WSL bash | 可以 | 跑分用这个（AGENTLAB_SHELL=wsl） |
| Docker 容器 | 502 | TCP 能连，HTTP 被 Clash 拦；--network host 也一样 |

## 待验证

- tick 模式 vs round 模式的 A/B（同一道 e1-01）
- 容器网络 502：给 Clash 加 10.0.0.0/8 直连规则后重测
## 下一步

1. 拿 DVWA 跑一次**编排**，和单 agent 的 32 次调用对比（最难的一步：真数据）
2. 用真数据跑一遍全部视图，把布局/性能问题暴露出来
3. 拿 DVWA 跑一次**编排**，和单 agent 的 32 次调用对比
4. 上下文压缩第一版

## 踩过的坑

- **文件工具路径基准**：相对路径按进程 cwd 解析，和 run_shell 的 cd 不一致 → 已修
- **没有墙钟预算**：agent 跑 factorint 卡死 20 分钟 → 已加 deadline_s
- **reasoning 被丢弃**：DeepSeek 的思考在 `message.reasoning_content`，只取 content 等于盲飞 → 已修
- **题面是容器格式**：`/data/`、`/logs/agent/flag.txt`、`challenge:1337` 本地都不存在，agent 白烧 9 步 → 用题前必须先本地化
- **TaskStore 默认路径**：原来落当前目录，不同任务串同一个文件 → 改落 workdir
- **演示/真实数据路径不一致**：结果 json 要放在 `results/<run>/<task>.json`，放深一层列表就读不到

## 别碰的地方

- `eval/answers/` —— 任何情况下都不许放进题目工作目录
- 任何含 Key 的文件 —— 密钥只进环境变量和本地文件，不进对话、不进仓库