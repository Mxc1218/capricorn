# 摩羯的运行镜像 —— 不是为了"有工具"，是为了有一个正常的 bash。
#
# 背景：在 Windows cmd 里跑，42% 的工具调用返回非零，绝大多数是转义问题。
# 摩羯是纯标准库 Python，所以镜像里只需要 python3 + 常用命令行工具。
#
# 基础镜像用 Debian（python:3.12-slim），不用 kali-rolling：
# 实测 kali-rolling 现在的 curl 依赖坏了（libngtcp2-16 不可满足），装不上。
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends --fix-missing -o Acquire::Retries=5 \
        curl wget git jq unzip ca-certificates openssl \
        nmap sqlmap gobuster netcat-openbsd dnsutils \
    && rm -rf /var/lib/apt/lists/*

# PoC / 知识库：这是"指纹 → 搜 exploit"那条路的基础
RUN mkdir -p /opt/pocs && cd /opt/pocs \
    && git clone --depth 1 https://github.com/Threekiii/Awesome-POC.git \
    && git clone --depth 1 https://github.com/zhzyker/exphub.git \
    || true

RUN printf "%s\n" \
    "#!/bin/sh" \
    "PAT=\"\${1:?用法: searchpoc <关键词>}\"" \
    "echo \"== 内容命中 ==\"" \
    "grep -ril \"\$PAT\" /opt/pocs 2>/dev/null | head -20" \
    "echo \"== 文件名命中 ==\"" \
    "find /opt/pocs -iname \"*\${PAT}*\" 2>/dev/null | head -10" \
    > /usr/local/bin/searchpoc && chmod +x /usr/local/bin/searchpoc

WORKDIR /app
CMD ["/bin/bash"]