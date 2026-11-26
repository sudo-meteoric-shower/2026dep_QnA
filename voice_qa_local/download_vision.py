"""安装固定版本的本地 SmolVLM，校验三份 ONNX 权重。"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess

REPO = "HuggingFaceTB/SmolVLM-256M-Instruct"
REVISION = "a1a065473baa55316b2ddf85ae4e29282d89ad12"
ROOT = Path(__file__).resolve().parent / "models" / "SmolVLM-256M-Instruct"
CONFIGS = ("config.json", "generation_config.json", "preprocessor_config.json", "processor_config.json",
           "chat_template.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json")
WEIGHTS = {
    "onnx/decoder_model_merged_q4.onnx": "e8f67dd06edf4edbbfeca36f79aaa1b3ea934a2b166d462b3b152788ec3232cd",
    "onnx/embed_tokens_quantized.onnx": "4b919b829fe2bf225e42431230c56891116f0149e5170e36c99bcc0cfae0d2ef",
    "onnx/vision_encoder_quantized.onnx": "f82adc84246fbfe8651038470166385452682cc889538f5106544e622e5f1595",
}


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def install(name):
    expected = WEIGHTS.get(name)
    target = ROOT / name
    if target.is_file() and (digest(target) == expected if expected else target.stat().st_size > 0):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    download = target.with_suffix(target.suffix + f".{os.getpid()}.part")
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}?download=true"
    subprocess.run(["curl.exe", "--location", "--fail", "--silent", "--show-error",
                    "--connect-timeout", "10", "--retry", "2", "--max-time", "180", "--output", str(download), url], check=True)
    if expected:
        if digest(download) != expected:
            raise ValueError(f"SHA-256 mismatch: {name}")
    else:
        with download.open(encoding="utf-8") as file:
            json.load(file)
    download.replace(target)
    print(f"{name} {target.stat().st_size:,} bytes", flush=True)


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(install, (*CONFIGS, *WEIGHTS)))
