# -*- coding: utf-8 -*-
"""本地静态服务（修复 .mjs/.wasm MIME 类型）+ 请求日志。

用本文件替代 `python -m http.server`：
Windows 的 Python MIME 表跟随系统注册表，.mjs 未注册会被当成 text/plain，
浏览器安全策略禁止 import text/plain 模块，导致 ONNX 运行时加载失败
（no available backend found / Failed to fetch dynamically imported module）。
"""
import argparse
import http.server
import os
import socketserver
import subprocess
import sys
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
        ".html": "text/html",
    }

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stderr.flush()

    def end_headers(self):
        # 禁用浏览器缓存：本机服务读取极快，缓存只会带来旧 MIME/旧文件问题
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

APP = Path(__file__).resolve().parent
PAGE = "voice_qa_assistant_local.html"
ADDRESS = ("127.0.0.1", 8000)


def open_gpu_window(url):
    for variable in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        root = os.environ.get(variable)
        if root:
            edge = Path(root) / "Microsoft/Edge/Application/msedge.exe"
            if edge.is_file():
                break
    else:
        raise FileNotFoundError("找不到 Microsoft Edge，请检查 Edge 是否已安装。")
    profile = APP.parent / "reproduction_check" / "edge-profile-gpu-manual"
    subprocess.Popen([str(edge), f"--user-data-dir={profile}", "--force_high_performance_gpu",
                      "--no-first-run", "--no-default-browser-check", "--new-window", url])


def serving_this_page(url):
    try:
        opener = build_opener(ProxyHandler({}))
        expected = (APP / PAGE).read_bytes()
        with opener.open(url, timeout=3) as response:
            return (response.getheader("Cross-Origin-Opener-Policy") == "same-origin"
                    and response.getheader("Cross-Origin-Embedder-Policy") == "require-corp"
                    and response.read(len(expected) + 1) == expected)
    except OSError:
        return False


def run(open_gpu, prefer_mic_array=False):
    os.chdir(APP)
    url = f"http://{ADDRESS[0]}:{ADDRESS[1]}/{PAGE}"
    window_url = url + ("?mic=array" if prefer_mic_array else "")
    socketserver.ThreadingTCPServer.allow_reuse_address = os.name != "nt"
    try:
        server = socketserver.ThreadingTCPServer(ADDRESS, Handler)
    except OSError:
        if open_gpu and serving_this_page(url):
            open_gpu_window(window_url)
            print("已复用本地服务，并打开 GPU 专用 Edge 窗口。", flush=True)
            return
        raise
    with server:
        if open_gpu:
            open_gpu_window(window_url)
        print(f"本地服务已启动 {url}", flush=True)
        print("关闭本窗口或按 Ctrl+C 停止服务", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--open-gpu", action="store_true", help="用独立 Edge 配置打开问答页面")
    parser.add_argument("--prefer-mic-array", action="store_true", help="项目窗口优先使用麦克风阵列")
    try:
        args = parser.parse_args()
        run(args.open_gpu, args.prefer_mic_array)
    except OSError as error:
        sys.exit(f"启动失败：{error}")
