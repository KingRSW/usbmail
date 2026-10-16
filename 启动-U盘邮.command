#!/bin/bash
# U盘邮 — macOS / Linux 启动器
# 双击本文件即可运行。它会自动寻找 U盘里自带的 Node 运行时, 找不到才用系统的。
cd "$(dirname "$0")" || exit 1

echo ""
echo "  U盘邮 正在启动…"
echo ""

NODE_BIN=""
ARCH="$(uname -m)"
OS="$(uname -s)"

# 1) 优先用 U盘自带的运行时 (免安装, 换电脑也能跑)
if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ] && [ -x "runtime/node-mac-arm64/bin/node" ]; then
    NODE_BIN="runtime/node-mac-arm64/bin/node"
  elif [ -x "runtime/node-mac-x64/bin/node" ]; then
    NODE_BIN="runtime/node-mac-x64/bin/node"
  elif [ -x "runtime/node-mac-arm64/bin/node" ]; then
    NODE_BIN="runtime/node-mac-arm64/bin/node"
  fi
else
  if [ "$ARCH" = "aarch64" ] && [ -x "runtime/node-linux-arm64/bin/node" ]; then
    NODE_BIN="runtime/node-linux-arm64/bin/node"
  elif [ -x "runtime/node-linux-x64/bin/node" ]; then
    NODE_BIN="runtime/node-linux-x64/bin/node"
  fi
fi

# 2) 退回系统已装的 Node
if [ -z "$NODE_BIN" ]; then
  for c in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if command -v "$c" >/dev/null 2>&1; then NODE_BIN="$c"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "  ✗ 没有找到可用的 Node 运行时。"
  echo ""
  echo "    U盘里应该带有 runtime/ 目录。如果它缺失了,"
  echo "    请到 https://nodejs.org 下载对应系统的版本解压进去,"
  echo "    或者在本机安装 Node.js 后重新双击本文件。"
  echo ""
  read -r -p "  按回车键退出…"
  exit 1
fi

echo "  使用运行时: $NODE_BIN"
"$NODE_BIN" --version
echo ""

exec "$NODE_BIN" app/server.js
