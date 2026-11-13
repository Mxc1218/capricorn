"""评测台 —— 回答"这次改动有没有用"的仪器。

约定:
    eval/tasks/<task_id>/instruction.md   题面（agent 能看到）
    eval/tasks/<task_id>/files/           附件（会被复制进工作目录）
    eval/tasks/<task_id>/meta.json        {budget_s, max_steps, kind}
    eval/answers/<task_id>.txt            期望的 flag（agent 绝对看不到）

判分只看落地物: 工作目录下的 flag.txt，或 stdout 里第一条匹配 flag 正则的字符串。
"""
