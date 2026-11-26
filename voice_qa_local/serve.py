# -*- coding: utf-8 -*-
"""本地静态服务（修复 .mjs/.wasm MIME 类型）+ 请求日志。

用本文件替代 `python -m http.server`：
Windows 的 Python MIME 表跟随系统注册表，.mjs 未注册会被当成 text/plain，
浏览器安全策略禁止 import text/plain 模块，导致 ONNX 运行时加载失败
（no available backend found / Failed to fetch dynamically imported module）。
"""
import http.server
import json
import socketserver
import subprocess
import sys

from windows_ocr import recognize

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
        ".html": "text/html",
    }

    def do_POST(self):
        if self.path != "/api/ocr":
            self.send_error(404)
            return
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in {"127.0.0.1:8000", "localhost:8000"} or origin != f"http://{host}":
            self.send_error(403)
            return
        if self.headers.get_content_type() != "image/png":
            self.send_error(415)
            return
        length = self.headers.get("Content-Length", "")
        if not length.isascii() or not length.isdigit() or len(length) > 8:
            self.send_error(411)
            return
        length = int(length)
        if not 0 < length <= 12 * 1024 * 1024:
            self.send_error(413)
            return
        self.connection.settimeout(15)
        try:
            image = self.rfile.read(length)
            if len(image) != length or not image.startswith(b"\x89PNG\r\n\x1a\n"):
                self._json(400, {"error": "图像数据无效"})
                return
            self._json(200, recognize(image))
        except TimeoutError:
            self._json(408, {"error": "发送图片超时"})
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
            self.log_error("OCR unavailable: %s", type(error).__name__)
            self._json(503, {"error": "本地 OCR 不可用，请检查 Windows 识别语言或开启视觉说明"})

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
