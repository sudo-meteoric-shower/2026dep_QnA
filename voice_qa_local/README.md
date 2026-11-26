# 语音问答助手 · 本地离线版（v16 彻底重构版）

模型已全部下载到本目录，页面**直接从本地读取**，不依赖 HuggingFace / 魔搭 / 任何 CDN。
针对「识别/回答不准 + 响应慢」，已完成彻底重构；旧模型与多模型选项全部保留、不删除任何文件。

## v16 更新（彻底重构：识别/输出质量 + 响应速度）

针对反馈的"语音识别和大模型输出乱糟糟、响应慢"，做了五项根本性改动：

1. **默认改质量档**：开箱即用即 `Whisper-base`（识别更准）+ `Qwen2.5-1.5B`（非思考、输出干净）+ `bge-small`；
   此前默认是 tiny/0.6B 最弱档，正是"乱糟糟"的主因。下拉仍可切到其它 8 个模型。
2. **录音链路重构**：关闭浏览器 `autoGainControl`（原固定 2 倍增益与 AGC 叠加导致削波失真）；
   新增 **VAD 首尾静音裁剪**（20ms 帧、峰值 12% 阈值，消除静音段喂给 Whisper 产生的幻觉文本）；
   改用 **RMS 归一化**（比峰值归一化更稳）、录音上限 20s。
3. **转录清洗 `cleanTranscript()`**：去除 Whisper 时间戳标记、"谢谢观看/字幕由…提供"等幻觉短语、连续重复句、循环字符。
4. **流式输出（关键提速）**：用 `HF.TextStreamer` + pipeline 自带 tokenizer + `apply_chat_template` 生成 prompt，
   答案**逐字呈现**——首字亚秒级出现，消除原先"等 77~117 秒才看到完整答案"的空白卡顿；
   实测单次生成 96 个流式片段。流式不可用时自动回退整体生成。
5. **答案清洗强化**：去 AI 套话开头（"你是一个语言模型…"/"我是一名人工智能…"）、句子级去重、截断长列表、最多 3 句/160 字。

实测结果：默认配置加载正常、流式 96 片段逐字输出、答案为干净中文（无套话/重复/思考串入）、console 0 错误。
修正了一个自检 404（whisper-base/small 未下载 fp32 encoder，已取消其高精度档标记）。

## v14 更新（多模型选项 · 提升识别与回答准确率）

每类模型卡片新增下拉框，选择后点该卡片「加载」或「全部加载」生效。切换模型会释放旧实例；切换向量模型会提示重建索引。

| 类别 | 可选项 | 定位 | 本地体积 |
|---|---|---|---|
| 语音识别 | Whisper-tiny | 速度最快 | ~40MB |
| 语音识别 | **Whisper-base** | 均衡（推荐替换 tiny） | ~77MB |
| 语音识别 | Whisper-small | 中文最准、较慢 | ~241MB |
| 问答生成 | Qwen3-0.6B | 速度最快 | ~617MB |
| 问答生成 | **Qwen2.5-1.5B-Instruct** | 推荐：非思考模型、输出干净、中文明显更强 | ~1.5GB |
| 问答生成 | Qwen3-1.7B | 能力最强（自动关思考） | ~1.7GB |
| 知识库向量 | bge-small-zh | 快 | ~24MB |
| 知识库向量 | **bge-base-zh** | 向量更准 | ~98MB |

- **准确率提升路径**：识别选 `Whisper-base/small` + 问答选 `Qwen2.5-1.5B` + 向量选 `bge-base-zh`。
- Qwen2.5 为非思考模型，不加 `/no_think`；Qwen3 系列（0.6B/1.7B）自动关闭思考并清洗输出。
- 精度档位对新模型自动降级为 q8（新模型无高精度原始权重）；旧模型仍可用高精度档。
- 所有新模型均来自 ModelScope（魔搭）国内源 `onnx-community/*`、`Xenova/*`，已下载到本地。

### 输出质量修复（针对 Qwen2.5-1.5B 实测暴露的问题）
- **重复输出**：实测初版答案将同一段话重复三遍。已将 `repetition_penalty` 1.05→1.15、`max_new_tokens` 200→160，
  并在 `cleanAnswer()` 增加**句子级去重**（切句后按内容判重，去除循环重复句）。
- **语言跑偏**：Qwen2.5 为非思考模型，初次输出英文。现对 Qwen2.5 在 user 提示显式追加"请用中文简明回答"；
  Qwen3 系列仍用 `/no_think` 关闭思考。
- **边界清洗**：去除开头孤立标点、尾部未完句/免责声明/自我提示（"请提供…""请记住…"）。
- 三轮实测对比：①英文重复三遍 → ②中文但有免责声明 → ③**干净中文、无重复、无思考串入**；console 始终 0 错误。
- 典型输出："在医学成像领域，深度学习主要用于图像识别和分割任务，如肺部CT扫描中的结节检测、心脏MRI的结构分析等。通过训练专门的神经网络模型，可以提高诊断准确性并减少人为错误。"

## v13 更新（同目录高精度权重接入）

之前根目录下闲置的三个 ONNX 文件已确认身份并**真正接入加载**：

| 根目录文件 | 身份 | 接入为 | dtype |
|---|---|---|---|
| `encoder_model.onnx` 31MB | Whisper encoder 全精度 | Whisper 高精度档 encoder | `fp32` |
| `model_q4.onnx` 49MB | bge 向量 q4 | bge 高精度档 | `q4` |
| `model_q4f16.onnx` 543MB | Qwen3 q4f16 | Qwen3 高精度档 | `q4f16` |

- 三个文件已复制到各模型的 `onnx/` 目录（根目录原件保留不动），文件名符合 Transformers.js 的 dtype 后缀约定。
- 模型卡片新增 **精度档位** 下拉：`快速·量化`（q8，默认）与 `高精度`。切到高精度后重新加载即使用上述原始权重。
- Whisper 高精度档采用 encoder(fp32) + decoder(q8) 混合（本地仅有 q8 decoder）。
- 「自检」会探测高精度文件并在信息栏提示可用档位数。
- 实测：三个高精度档均从本地加载成功（徽章「已就绪」）、生成正常中文答案、console 0 错误。

## v12 更新（对话区 / 语音录入 / 千问输出）

- **对话区放大**：上排卡片与顶部栏压低、知识库列表降高，把高度让给对话区（最小 280px）；
  消息气泡字号 11px→13px、行高放大、内边距加宽，多轮问答过程一屏可看清。
- **语音录入修复**：弃用 `MediaRecorder`(webm/opus)→`decodeAudioData` 方案（编码兼容性与音量问题多），
  改用 **Web Audio `ScriptProcessorNode` 直接采集 16kHz 单声道 PCM**：自动增益、实时音量波形、
  静音检测提示、峰值归一化；音频不再经过编码解码，识别更稳。合成音频流实测采集→PCM→Whisper 转写链路正常。
- **千问输出校正**：`enable_thinking:false` 在 Transformers.js 并非有效生成参数，Qwen3 会把 `<think>`
  思考内容混进答案。现改为「提示词 `/no_think` + 输出清洗 `cleanAnswer()`」双保险：
  彻底剥离 `<think>…</think>`、`<|...|>` 控制 token、Markdown 残留并规范空白；
  同时改用稳健的 `generated_text` 提取与确定性生成参数。实测两组问答输出均为干净中文，无思考串入。

## v11 更新

- **修复加载失效**：原页面「测试源」按钮的 HTML 标签残缺，会吞掉后面的自定义地址输入框，
  导致 `configure()` 抛错、三个「加载」按钮点了没反应。现已补全并静态校验全部 25 个 DOM 引用。
- **界面重排**：顶部状态栏 + 模型/知识库双卡片 + 处理流水线 + 占满剩余高度的对话区；
  模型文件路径改为可折叠区，麦克风/输入/播报/清空并入对话卡底部，页面不再拥挤留白。
- **图标修复**：`lib/fa/all.min.css` 的字体路径由 `../webfonts/` 更正为 `./webfonts/`，
  Font Awesome 图标正常显示（此前全部为小方块）。

## 快速开始

双击 **`启动本地服务.bat`**，浏览器会自动打开：

```
http://localhost:8000/voice_qa_assistant_local.html
```

关闭黑色命令行窗口即停止服务。

> 为什么必须用 HTTP 服务：浏览器对 `file://` 页面禁止读取本地文件（CORS），
> 直接双击 html 会导致模型加载失败，页面顶部会给出提示。

## 目录结构

```
voice_qa_local/
├─ voice_qa_assistant_local.html   主页面
├─ 启动本地服务.bat                一键启动（python -m http.server 8000）
├─ models/                         三个模型（共 678MB）
│  ├─ whisper-tiny/                语音识别
│  │   ├─ config.json / preprocessor_config.json / tokenizer*.json
│  │   ├─ onnx/encoder_model_quantized.onnx        快速档 encoder (q8)
│  │   ├─ onnx/decoder_model_merged_quantized.onnx 快速档 decoder (q8)
│  │   └─ onnx/encoder_model.onnx                  高精度档 encoder (fp32)
│  ├─ Qwen3-0.6B-ONNX/             问答生成
│  │   ├─ config.json / tokenizer.json / generation_config.json
│  │   ├─ onnx/model_quantized.onnx                快速档 (q8/int8, 590MB)
│  │   └─ onnx/model_q4f16.onnx                    高精度档 (q4f16, 543MB)
│  └─ bge-small-zh-v1.5/           中文向量
│      ├─ config.json / tokenizer.json
│      ├─ onnx/model_quantized.onnx                快速档 (q8, 24MB)
│      └─ onnx/model_q4.onnx                       高精度档 (q4, 49MB)
├─ lib/                            前端库（共 8MB，全部本地）
│  ├─ transformers.min.js          Transformers.js 3.8.1
│  ├─ tailwind.js / fa/            Tailwind 与 Font Awesome
│  └─ pdf.min.js / mammoth / xlsx  知识库文档解析
└─ ort/                            ONNX Runtime WASM 运行时（22MB）
```

## 界面说明

- **下载源**：默认「本地模型（离线）」。如需联网兜底可切换「魔搭 ModelScope / hf-mirror / HuggingFace 官方」。
- **精度档位**：默认「快速·量化」（q8，加载快）；切到「高精度」后**重新加载**即使用同目录原始权重（fp32/q4f16/q4，精度更高、体积更大）。切换档位需重新加载模型才生效。
- **自检**：点击「自检」按钮，逐个校验 models/ 下三个模型及高精度权重是否齐全，缺失的徽章会标红提示。
- **加载**：分别点三个「加载」按钮，或点「全部加载」。加载完成后即为纯离线运行。
- **知识库**：上传 PDF/DOCX/XLSX/TXT 等文件，本地解析 → bge 向量化 → 检索增强问答。
- **语音**：麦克风录音 → Whisper 转写 → Qwen3 生成 → 浏览器语音播报。

## 实测结论

在本机 Edge 无头浏览器中逐项验证通过：

| 模型 | 结果 | 耗时 |
|---|---|---|
| bge-small-zh（向量） | 已就绪 | < 10s |
| whisper-tiny（识别） | 已就绪 | 约 10s |
| Qwen3-0.6B（问答） | 已就绪 | 约 60s（含 617MB 权重载入） |
| 生成测试 | 正确输出中文回答 | 首次约 48s（WASM 冷启动，后续更快） |

v11 已重新实测通过：自检 → 三个模型从 `models/` 全部加载为「已就绪」→ 本地 Qwen3 生成中文回答
（"我是能用语音和文字帮助你的智能助手，支持多语言和高效响应。"）。控制台无 JS 报错。

## 说明与限制

- 量化档位统一为 q8 / int8：同一套权重在 WASM 与 WebGPU 下都能用，无需按设备分别下载。
- 若浏览器支持 WebGPU，加载时会优先尝试；不支持则自动回退 WASM（CPU），速度较慢但结果一致。
- 主线程推理（不使用 Worker），WASM 生成期间界面会短暂卡顿，属已知代价。
- 删除 models/ 目录后，页面会自动回退到联网下载源。
