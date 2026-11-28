# 本地语音问答助手 · GPU 实验分支

默认使用 Qwen3-1.7B q4f16 在 WebGPU 上生成回答，Whisper-base 和 BGE-small 使用 WASM。浏览器在本机加载模型。需要支持 WebGPU 与 shader-f16 的显卡，在本机已验证 RTX 4060 Laptop。CPU 课堂版保存在 `version1` 和 `1_7_try` 分支。

初次使用先用 Git LFS 取得已收录的文件。默认问答权重为 `voice_qa_local/models/Qwen3-1.7B-ONNX/onnx/model_q4f16.onnx`，可用项目原有的 `voice_qa_local/download_models.py` 获取缺少的模型。双击 `voice_qa_local/启动本地服务.bat`，在页面点击「全部加载」。需要显式运行 CPU 时，在页面地址末尾加上 `?backend=wasm`。

[运行说明](voice_qa_local/README.md) · [GPU 同题测评与复现命令](reproduction_check/静音评测/WebGPU同题对照.md)

## 原版对照评测

此前基础版的问答模型默认值与老师发来的实际程序一致。书面提示词指定的 Qwen2.5-1.5B 仍可在下拉菜单中选择。

在仓库目录运行 `node reproduction_check/verify.cjs --compare=teacher` 可用原题复测老师原版。运行参数可换成 `--compare=current`（提交 76367a2 的默认 1.5B）、`--compare=single`（只给正确来源）或 `--compare=small`（提交 76367a2 手选 Qwen3-0.6B）。在 current 和 small 模式追加 `--holdout` 可切换至留出题。运行会更新相应的本地 JSON 记录。

候选的源码差异保存在评测目录，可将补丁应用到 76367a2 的页面，再运行 `--compare=candidate` 或 `--compare=candidate-small`。如需避免覆盖现有结果，可在独立工作树运行。

[逐题判分与耗时](reproduction_check/静音评测/原版对照.md)
