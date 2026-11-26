@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo  语音问答助手 - 本地离线版
echo  模型目录: models\   服务端口: 8000
echo  关闭本窗口即停止服务
echo ==========================================
start "" http://127.0.0.1:8000/voice_qa_assistant_local.html
rem 注意：必须用 serve.py（修复 .mjs MIME），直接用 http.server 会导致模型运行时加载失败
python serve.py
if errorlevel 1 py -3 serve.py
pause
