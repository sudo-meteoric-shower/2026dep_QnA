# 本地语音问答助手基础版

本分支在课堂原型基础上按《提示词.txt》调整。打开 `voice_qa_local/启动本地服务.bat`，使用默认的 Whisper-base、Qwen2.5-1.5B 和 bge-small-zh-v1.5。首次取得代码后，使用 Git LFS 获取已收录的权重，再按需运行 `voice_qa_local/download_models.py` 补齐本地模型。

使用步骤在 [运行说明](voice_qa_local/README.md)。原型测试记录保留在 reproduction_check 目录，本轮的预设题目、合成材料与逐题计时在 [静音评测](reproduction_check/静音评测)。
