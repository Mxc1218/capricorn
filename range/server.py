"""本地靶场 —— 三道关，全部用标准库，起一个进程就够。

关 1  8080 首页：一个假的"Nginx 目录浏览"，提示有 /download?file= 接口
关 2  /download 路径穿越：可以读任意文件 —— 用来读 user.flag
关 3  /exec 命令注入：过滤得「看起来有」，绕过去就能执行 —— 用来读 root.flag

为什么自己搭：
    HTB 的机器会过期、IP 会变、平台会重置，做不了「同一条件重复跑」。
    实验要的是可复现，不是真实。这个靶场 1 秒起停，状态永远一致。

用法:
    python range/server.py --port 8080
    python range/server.py --port 8080 --quiet     # 不打访问日志
"""
from __future__ import annotations

import argparse
import http.server
import os
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
USER_FLAG = "flag{localrange_web_3f9a}"
ROOT_FLAG = "flag{localrange_root_c7b1}"

INDEX = """<!doctype html><html><head><title>Internal File Service</title></head>
<body style="background:#111;color:#ddd;font-family:monospace;padding:40px">
<h1>Internal File Service (v1.2.3)</h1>
<p>可用接口：</p>
<ul>
  <li><code>/download?file=readme.txt</code> —— 下载说明文件</li>
  <li><code>/exec?cmd=id</code> —— 运维用诊断接口（仅限内网）</li>
</ul>
<p>作者备注：exec 接口的过滤已经修过了，别再提这件事。</p>
</body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "nginx/1.18.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        if not QUIET:
            sys.stderr.write("[range] %s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, body: str, code: int = 200, ctype: str = "text/html; charset=utf-8"):
        raw = body.encode("utf-8", "replace")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/":
            return self._send(INDEX)

        if parsed.path == "/download":
            name = (qs.get("file") or ["readme.txt"])[0]
            # 故意不做 basename —— 这就是关 2
            target = (ROOT / "public" / name)
            try:
                data = Path(target).read_bytes()[:65536]
                return self._send(data.decode("utf-8", "replace"), ctype="application/octet-stream")
            except Exception as exc:
                return self._send("file not found: %s" % exc, 404)

        if parsed.path == "/exec":
            cmd = (qs.get("cmd") or [""])[0]
            low = cmd.lower()
            # 「看起来有过滤」：挡了几个关键词，但挡不严（可以用单引号/拼接绕过）
            if any(bad in low for bad in ("cat ", "flag", ";", "&&", "|")):
                return self._send("403: request blocked by WAF", 403)
            try:
                out = subprocess.run(
                    cmd, shell=True, capture_output=True, timeout=5,
                )
                text = (out.stdout or b"") + (out.stderr or b"")
                return self._send("[exit=%s]\n%s" % (out.returncode, text.decode("utf-8", "replace")), ctype="text/plain")
            except Exception as exc:
                return self._send("exec error: %s" % exc, 500)

        return self._send("404 not found", 404)


QUIET = False


def prepare() -> None:
    """摆好靶场里的文件。每次启动都重建，保证状态一致。"""
    pub = ROOT / "public"
    pub.mkdir(parents=True, exist_ok=True)
    (pub / "readme.txt").write_text(
        "Internal File Service\n只有内网能访问。\n", encoding="utf-8")
    # user flag 放在 web 根的上两级，需要路径穿越才读得到
    (ROOT / "user.flag").write_text(USER_FLAG + "\n", encoding="utf-8")
    # root flag 放在一个「只有能执行命令才读得到」的位置
    secret = Path(tempfile.gettempdir()) / "localrange_root.flag"
    secret.write_text(ROOT_FLAG + "\n", encoding="utf-8")
    (ROOT / "ROOT_FLAG_PATH").write_text(str(secret), encoding="utf-8")


def main(argv=None) -> int:
    global QUIET
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    QUIET = args.quiet

    prepare()
    srv = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    print("靶场已启动: http://%s:%d/" % (args.bind, args.port))
    print("  user flag 位置: %s" % (ROOT / "user.flag"))
    print("  root flag 位置: %s" % (ROOT / "ROOT_FLAG_PATH").read_text().strip())
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
