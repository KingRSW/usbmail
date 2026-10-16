@echo off
chcp 65001 >nul
title 清除 U盘邮 数据
cd /d "%~dp0"

echo.
echo   这会删除 U盘邮 保存的全部数据:
echo     - 已添加的邮箱账户和授权码
echo     - 已缓存的邮件正文
echo     - 所有设置
echo.
echo   删除后需要重新添加邮箱账户。
echo   (不会影响你的邮箱本身, 邮件仍在服务器上)
echo.
set /p ans="  确认删除? 输入 yes 回车: "

if not "%ans%"=="yes" (
  echo   已取消, 什么都没删。
  echo.
  pause
  exit /b 0
)

if exist "data" (
  rmdir /s /q "data"
  echo.
  echo   [OK] 数据已清除。下次启动就是全新的 U盘邮。
) else (
  echo.
  echo   没有找到 data 目录, 已经是干净状态。
)
echo.
pause
