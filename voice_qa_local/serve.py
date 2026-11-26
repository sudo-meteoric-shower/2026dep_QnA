# -*- coding: utf-8 -*-
"""本地静态服务（修复 .mjs/.wasm MIME 类型）+ 请求日志。

用本文件替代 `python -m http.server`：
Windows 的 Python MIME 表跟随系统注册表，.mjs 未注册会被当成 text/plain，
浏览器安全策略禁止 import text/plain 模块，导致 ONNX 运行时加载失败
（no available backend found / Failed to fetch dynamically imported module）。
"""
import http.server
import socketserver
import sys

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
        super().end_headers()

if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", 8000), Handler) as httpd:
        print("本地服务已启动: http://127.0.0.1:8000/voice_qa_assistant_local.html", flush=True)
        print("关闭本窗口或按 Ctrl+C 停止服务", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
