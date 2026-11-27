"""课前准备：从魔搭下载浏览器所需的离线文件，逐个核对大小和 SHA-256。"""
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent / "models"
MODELS = [
    "onnx-community/Qwen2.5-1.5B-Instruct", "onnx-community/whisper-base",
    "Xenova/bge-small-zh-v1.5", "onnx-community/whisper-tiny",
    "onnx-community/whisper-small", "Xenova/bge-base-zh-v1.5",
    "onnx-community/Qwen3-0.6B-ONNX", "onnx-community/Qwen3-1.7B-ONNX",
]

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def download(repo, entry):
    name, size, sha = entry["Path"], entry["Size"], entry["Sha256"]
    dest = ROOT / repo.split("/")[-1] / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == size and digest(dest) == sha:
        return
    temp = dest.with_suffix(dest.suffix + ".part")
    endpoint = f"https://modelscope.cn/api/v1/models/{repo}/repo?"
    for attempt in range(4):
        try:
            offset = temp.stat().st_size if temp.exists() else 0
            while offset < size:
                end = min(size, offset + 32 * 2**20) - 1
                partial = size > 32 * 2**20 or offset > 0
                url = endpoint + urlencode({"Revision":entry["Revision"], "FilePath":name, "offset":offset})
                req = Request(url, headers={"Range":f"bytes={offset}-{end}"} if partial else {})
                with urlopen(req, timeout=60) as response:
                    if partial and (response.status != 206 or not response.headers.get("Content-Range","").startswith(f"bytes {offset}-{end}/")):
                        raise IOError("服务器未正确响应分段请求")
                    with temp.open("ab" if offset else "wb") as stream:
                        while block := response.read(2**20):
                            stream.write(block)
                new_offset = temp.stat().st_size
                if new_offset <= offset:
                    raise IOError("下载未取得新数据")
                offset = new_offset
            if temp.stat().st_size != size:
                raise IOError("下载长度不符")
            if digest(temp) != sha:
                temp.unlink()
                raise IOError("SHA-256 不符")
            temp.replace(dest)
            print("已核验", repo, name, size, flush=True)
            return
        except Exception as error:
            print(repo, name, error, flush=True)
            if attempt == 3:
                raise
            time.sleep(2 + attempt)

def prepare(repo):
    base = f"https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Recursive=true"
    with urlopen(base, timeout=40) as response:
        entries = {f["Path"]: f for f in json.load(response)["Data"]["Files"]}
    names = ["config.json", "tokenizer_config.json", "tokenizer.json"]
    if "whisper" in repo:
        names += ["preprocessor_config.json", "generation_config.json", "onnx/encoder_model_quantized.onnx",
                  "onnx/decoder_model_merged_quantized.onnx", "onnx/encoder_model.onnx"]
    else:
        names += ["onnx/model_quantized.onnx"]
        if "Qwen" in repo:
            names += ["generation_config.json"]
            if "Qwen3" in repo:
                names.append("onnx/model_q4f16.onnx")
        else:
            names += ["onnx/model_q4.onnx"]
    if "special_tokens_map.json" in entries:
        names.append("special_tokens_map.json")
    for name in names:
        download(repo, entries[name])
    return repo

if __name__ == "__main__":
    failures = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {repo: pool.submit(prepare, repo) for repo in MODELS}
        for repo, task in futures.items():
            try:
                task.result()
            except Exception as error:
                failures.append((repo, str(error)))
    if failures:
        raise SystemExit(str(failures))
