# 本地语音问答助手 · 模态扩展

该分支支持用本机 Windows OCR 读取图片里的文字和位置，并可按需附加 SmolVLM 的画面说明。图文知识库保留原图，问答时可以检索简短说明、OCR 原文和已复核的课件资料。

## 使用

1. 克隆 expansion 后运行 git lfs pull，获取本地模型权重。若需要单独补装视觉模型，可在 voice_qa_local 目录运行 python download_vision.py。
2. 双击 voice_qa_local/启动本地服务.bat。在网页点击「全部加载」，然后上传 PNG、JPEG 或 WebP。每张图至多 8 MB、最长边至多 4096 像素。
3. 默认运行 OCR。需要描述图形布局时，在上传前开启「附加视觉说明」。该选项会增加入库时间，并在证据卡中单独显示待核对的说明。
4. 保持「启用 RAG」和「检索图像证据」开启。问图片上的明确字段，例如「PRESSURE 是多少」。如果 OCR 识别到了唯一同名字段，系统直接引用原读数。多张图的同名字段冲突时，可在问题里加上图片文件名。
5. 如有本地课本样例，把 aerodynamics.json 与对应图片放入 voice_qa_local/course_sample，再点「加载空气动力学示例」。

## 运行配置

- Whisper-base 负责转写，bge-small-zh-v1.5 负责检索，Qwen3-0.6B 负责文本生成。可选 SmolVLM-256M-Instruct 用 WASM 运行，固定权重约 210 MB，由 Git LFS 分发。
- OCR 使用当前 Windows 已安装的识别语言，服务仅监听 127.0.0.1。能识别的文字、连字符和公式会随系统语言和图像质量变化。OCR 的坐标表示文字所在区域，无法说明箭头指向。
- 图片默认 OCR 和可选的视觉推理都在本机完成。课本原图、未发布的索引与本机运行记录保存在 Git 忽略目录中。
- 在项目根目录运行 node voice_qa_local/tests/ocr_fields.cjs，可验证字段取值、文件名消歧和无关问题回退。
