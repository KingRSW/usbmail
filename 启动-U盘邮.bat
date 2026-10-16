@echo off
chcp 65001 >nul
title U盘邮
cd /d "%~dp0"

echo.
echo   U盘邮 正在启动...
echo.

set "NODE_BIN="

REM 1) 优先使用 U盘 自带的绿色版 Node (免安装)
if exist "runtime\node-win-x64\node.exe" set "NODE_BIN=runtime\node-win-x64\node.exe"
if exist "runtime\node-win-arm64\node.exe" set "NODE_BIN=runtime\node-win-arm64\node.exe"

REM 2) 退回系统已安装的 Node
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_BIN=node"
)

if not defined NODE_BIN (
  echo   [X] 没有找到可用的 Node 运行时。
  echo.
  echo       U盘里应该带有 runtime\ 目录。如果缺失,
  echo       请到 https://nodejs.org 下载 Windows 版解压进去,
  echo       或在本机安装 Node.js 后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo   使用运行时: %NODE_BIN%
"%NODE_BIN%" --version
echo.

"%NODE_BIN%" app\server.js

echo.
echo   服务已停止。
pause
