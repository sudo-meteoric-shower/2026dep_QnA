# 笔记本语音问答助手 v16

双击 `启动本地服务.bat` 即可在 GPU 专用 Edge 窗口打开问答页。启动器会复用已经运行的项目服务；新启动服务时请保留命令窗口。专用窗口和日常使用的 Edge 可以同时打开。也可在本目录运行 `python serve.py --open-gpu`。服务仅监听本机，提供 JavaScript 和 WASM 的 MIME 类型及浏览器多线程所需的响应头。本机普通 `python -m http.server 8000` 会把 .mjs 标成 text/plain，浏览器无法加载该模块。演示使用上述启动器。

1. 本分支页面自动选中 Whisper-base、Qwen3-1.7B 和 bge-small-zh-v1.5。点击「全部加载」或各卡片的「加载」。顶部自检检查当前配置的本地文件，卡片「已就绪」表示推理管线已加载。
2. 上传有可提取正文的 PDF、Word（DOCX）、Excel（XLSX/XLS）或 TXT，可多选。BGE 将 360 字符、重叠 60 字符的原文窗口编码为单位向量。改变向量模型或精度后请重新上传资料建索引。
3. 输入问题，或点击麦克风开始录音，再次点击停止。录音使用 16 kHz 单声道 PCM，裁剪静音后做音量归一化，最长 20 秒。Whisper 转写结果经过清洗后，与打字问题进入同一检索流程。
4. 启用知识库时，取相似度最高的三个片段作为依据。Qwen 使用自身分词器和对话模板，逐段显示简体中文回答；最终清理重复、思考标记和套话，展示引用。语音按钮调用浏览器本地中文语音。清空对话保留本次建好的索引，关闭页面会释放索引。
5. 语音识别可选 Whisper tiny/base/small，问答可选 Qwen3-0.6B、Qwen2.5-1.5B、Qwen3-1.7B，向量可选 BGE small/base。两个 Qwen3 在 WebGPU 上均使用 q4f16。Qwen2.5 使用 CPU WASM q8。快速档的 Whisper 和 BGE 均用 q8，高精度档的 Whisper 使用 fp32 编码器及 q8 解码器，BGE 使用 q4。档位名称沿用课堂提示词，实际答案质量须用题目验证。

浏览器只从 `models/`、`lib/` 和 `ort/` 加载。仅当准备离线模型时运行 `python download_models.py`，脚本从 ModelScope 下载并核对文件大小和 SHA-256。老师提示词列出的 1.5B 模型在纯 WASM 下完整生成约 77 秒属于参考值。看到首字和整段回答完成是两个不同的时间点，本机逐题结果见项目测试目录。

静音复核可在上一层目录执行 `node reproduction_check/verify.cjs --audit`。测试使用虚拟麦克风和合成输入，拦截系统播放，保留浏览器原始回答、引用、耗时和错误记录。

本分支的 GPU 问答会检查硬件适配器与 shader-f16。选用 Qwen3-1.7B 时，检索后的提示要求首句直接回答并保留数值和条件；0.6B 使用原指令。在地址末尾添加 `?backend=wasm` 可使用 CPU 对照，此时快速档的问答权重为 q8。运行性能比较时使用 [WebGPU 复测步骤](../reproduction_check/静音评测/WebGPU同题对照.md)。
