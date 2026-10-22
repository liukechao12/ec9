@echo off
REM ============================================================
REM  EC9 后台服务启动器（Windows）
REM
REM  用法：双击本文件，或在命令行执行  D:\ec9\backend\start-ec9.cmd
REM  访问：http://localhost:7098/     账号 admin / admin123
REM
REM  ⚠️ 为什么要专门写这个脚本（2026-10-14 踩过）：
REM   1) 必须先清掉 HTTP_PROXY / http_proxy 等环境变量。
REM      本机环境里 HTTP_PROXY 与 http_proxy **值相同但键重复**，
REM      .NET 枚举 env 会直接抛「已添加了具有相同键的项」，
REM      导致 PowerShell 的 Start-Process / Get-ChildItem env: 全部失败。
REM      只清大小写各一份还不够，必须 env -u 全清。
REM   2) 用 start "" 新窗口而不是后台任务，
REM      后台任务会随会话/工具进程一起被回收（表现为「服务莫名挂了」）。
REM   3) 停止服务：关掉这个窗口，或 netstat 找 PID 后 taskkill。
REM ============================================================
cd /d D:\ec9\backend

if "%HTTP_PROXY%"=="" goto :run
echo [start] 清理代理环境变量...
endlocal & set "HTTP_PROXY=" & set "http_proxy=" & set "HTTPS_PROXY=" & set "https_proxy="

:run
echo [start] 启动 EC9 (端口 7098)...
node app.js
echo.
echo [stop] 服务已退出。若是报错退出，请看上方日志。
pause