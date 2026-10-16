#!/bin/bash
# 清除 U盘邮 的全部数据 (账户配置 + 邮件缓存)
# 用于: 把 U 盘借人前、在公用电脑上用完、或想重新开始
cd "$(dirname "$0")" || exit 1

echo ""
echo "  这会删除 U盘邮 保存的全部数据:"
echo "    - 已添加的邮箱账户和授权码"
echo "    - 已缓存的邮件正文"
echo "    - 所有设置"
echo ""
echo "  删除后需要重新添加邮箱账户。"
echo "  (不会影响你的邮箱本身, 邮件仍在服务器上)"
echo ""
read -r -p "  确认删除? 输入 yes 回车: " ans

if [ "$ans" != "yes" ]; then
  echo "  已取消, 什么都没删。"
  echo ""
  exit 0
fi

if [ -d data ]; then
  rm -rf data
  echo ""
  echo "  ✓ 数据已清除。下次启动就是全新的 U盘邮。"
else
  echo ""
  echo "  没有找到 data 目录, 已经是干净状态。"
fi
echo ""
