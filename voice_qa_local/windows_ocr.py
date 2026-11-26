"""Call the offline OCR engine provided by Windows."""
import base64
from functools import lru_cache
import json
import os
from pathlib import Path
import subprocess


@lru_cache(maxsize=1)
def _encoded_script():
    script = Path(__file__).with_name("windows_ocr.ps1").read_text(encoding="utf-8-sig")
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


def recognize(png_bytes):
    if os.name != "nt":
        raise RuntimeError("当前系统不提供 Windows OCR")
    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run(
        [str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand", _encoded_script()],
        input=base64.b64encode(png_bytes),
        capture_output=True,
        check=True,
        timeout=25,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return json.loads(result.stdout.decode("utf-8-sig"))
