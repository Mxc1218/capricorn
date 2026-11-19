# legacy/ —— 攻击树前端（来自 Lucy / Cairn）

这个目录是从 `Mxc1218/Lucy` 的 `cairn-fixes` 分支复制过来的只读前端：

    cairn/src/cairn/server/static/index.html
    cairn/src/cairn/server/static/tree/*.js, tree.css

## 许可证

上游 Cairn 是 **AGPL-3.0**，因此这份前端也是 AGPL-3.0。
放进这个仓库不影响摩羯自己的代码（那是独立写的），但**如果分发整个仓库，
这部分必须按 AGPL 处理**。真要商业化，要么把这块换掉，要么走单独许可。

## 为什么不重写

两边的数据模型对得上（intent↔task、fact↔fact、trigger/produce/merge 同名同义），
所以写了 `viz/adapter.py` 做字段翻译，而不是把 200KB 的布局/动画重写一遍。

## 它读的两个接口

    GET /tree/projects          项目列表
    GET /projects/<pid>/tree    单项目图 {project, facts, intents, edges, hints, summary}

字段来源：从 tree/*.js 里抠出来的实际取值，不是猜的。

## 已知差异

- `created_at` 被用来排序，为了让「内容最多的项目」默认选中，适配层写成了展示口径的时间戳。
- `hints`、`dangling_references` 目前恒为空（我们的模型还没有这两类数据）。
- `awaiting_heartbeat_intents` 恒为 0。