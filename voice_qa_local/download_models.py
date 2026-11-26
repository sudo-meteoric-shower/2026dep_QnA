# -*- coding: utf-8 -*-
"""Download models from ModelScope API endpoint with retry + resume."""
import os, sys, time, urllib.request, urllib.error

MS_API = "https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={path}"
BASE = os.path.dirname(os.path.abspath(__file__))

FILES = {
    "onnx-community/whisper-base": [
        "config.json", "preprocessor_config.json", "generation_config.json",
        "tokenizer.json", "tokenizer_config.json",
        "onnx/encoder_model_quantized.onnx",
        "onnx/decoder_model_merged_quantized.onnx",
    ],
    "onnx-community/Qwen2.5-1.5B-Instruct": [
        "config.json", "generation_config.json", "tokenizer.json",
        "tokenizer_config.json", "special_tokens_map.json",
        "onnx/model_quantized.onnx",
    ],
    "onnx-community/Qwen3-0.6B-ONNX": [
        "config.json", "generation_config.json", "tokenizer.json",
        "tokenizer_config.json", "special_tokens_map.json",
        "onnx/model_quantized.onnx",
    ],
    "Xenova/bge-small-zh-v1.5": [
        "config.json", "tokenizer.json", "tokenizer_config.json",
        "onnx/model_quantized.onnx",
    ],
}

def fetch(url, dest, tries=8):
    tmp = dest + ".part"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for t in range(1, tries + 1):
        try:
            resume_from = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            req = urllib.request.Request(url)
            if resume_from:
                req.add_header("Range", f"bytes={resume_from}-")
            req.add_header("User-Agent", "Mozilla/5.0")
            with urllib.request.urlopen(req, timeout=300) as r:
                total = r.headers.get("Content-Length")
                total = int(total) + resume_from if total else None
                mode = "ab" if resume_from else "wb"
                got = resume_from
                with open(tmp, mode) as f:
                    while True:
                        chunk = r.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if total and got % (100 * 1024 * 1024) < len(chunk):
                            print(f"  {os.path.basename(dest)}: {got/1e6:.0f}/{(total or 0)/1e6:.0f} MB", flush=True)
            os.replace(tmp, dest)
            return True
        except Exception as e:
            print(f"  try{t} error: {e}", flush=True)
            time.sleep(min(10 * t, 60))
    return False

def main():
    failed = []
    for repo, files in FILES.items():
        for path in files:
            # repo -> models/ 下的本地目录名
            local_map = {
                "onnx-community/whisper-base": "whisper-base",
                "onnx-community/Qwen2.5-1.5B-Instruct": "Qwen2.5-1.5B-Instruct",
                "onnx-community/Qwen3-0.6B-ONNX": "Qwen3-0.6B-ONNX",
                "Xenova/bge-small-zh-v1.5": "bge-small-zh-v1.5",
            }
            dest = os.path.join(BASE, "models", local_map[repo], path)
            if os.path.exists(dest) and os.path.getsize(dest) > 1000:
                print(f"SKIP (exists) {dest}", flush=True)
                continue
            url = MS_API.format(repo=repo, path=urllib.parse.quote(path))
            print(f"DOWNLOAD {repo}/{path}", flush=True)
            ok = fetch(url, dest)
            size = os.path.getsize(dest) if os.path.exists(dest) else 0
            print(f"{'OK' if ok else 'FAIL'} {dest} {size/1e6:.1f} MB", flush=True)
            if not ok:
                failed.append(f"{repo}/{path}")
            time.sleep(1)
    if failed:
        print("FAILED FILES:", failed, flush=True)
        sys.exit(1)
    print("=== ALL DONE ===", flush=True)

import urllib.parse
main()
