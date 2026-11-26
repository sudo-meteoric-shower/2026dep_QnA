# 本地语音问答助手基础版

本分支归档《深度学习基础》课堂原型及复现记录。默认使用本地 Whisper-base、Qwen3-0.6B 和 bge-small-zh-v1.5。

1. 安装 Git LFS 后克隆仓库。已经克隆时，在仓库目录运行 git lfs pull，拉取 ONNX 模型权重。
2. 双击 voice_qa_local/启动本地服务.bat，等页面打开。点击「全部加载」，确认三套模型就绪。
3. 可上传 reproduction_check/课堂复现测试资料.txt，询问“青岚实验箱的校验代号是什么”，对照开关知识库前后的答案。

原型文件在 voice_qa_local/。复现结果在 reproduction_check/，包括文字和语音验证的成功与失败记录。模型和运行库均随分支提供，权重通过 Git LFS 分发。
