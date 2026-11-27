# 本地语音问答助手基础版

本分支在课堂原型基础上按《提示词.txt》调整。打开 `voice_qa_local/启动本地服务.bat`，使用默认的 Whisper-base、Qwen2.5-1.5B 和 bge-small-zh-v1.5。首次取得代码后，使用 Git LFS 获取已收录的权重，再按需运行 `voice_qa_local/download_models.py` 补齐本地模型。

使用步骤在 [运行说明](voice_qa_local/README.md)。原型测试记录保留在 reproduction_check 目录，本轮的预设题目、合成材料与逐题计时在 [静音评测](reproduction_check/静音评测)。

## 原版对照评测

在仓库目录运行 `node reproduction_check/verify.cjs --compare=teacher` 可用原题复测老师原版。运行参数可换成 `--compare=current`（发布版默认模型）、`--compare=single`（只给正确来源）或 `--compare=small`（发布版手选 Qwen3-0.6B）。在 current 和 small 模式追加 `--holdout` 可切换至留出题。运行会更新相应的本地 JSON 记录。

候选的源码差异保存在评测目录，可将补丁应用到 76367a2 的页面，再运行 `--compare=candidate` 或 `--compare=candidate-small`。如需避免覆盖现有结果，可在独立工作树运行。

[逐题判分与耗时](reproduction_check/静音评测/原版对照.md)
