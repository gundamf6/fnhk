#!/bin/sh
# 飞海监控 FNHK · Docker 入口脚本
# 作用：准备目录 + 首次启动自动生成访问口令（打进日志，方便用户取），然后启动服务。
set -e

CONF="${NVR_CONF:-/data/config.json}"
mkdir -p "$(dirname "$CONF")" "${NVR_REC_ROOT:-/rec}" "${NVR_DATA:-/data}"

# 首次启动（还没有配置文件）且用户没指定口令 → 自动生成一个随机口令
if [ ! -f "$CONF" ] && [ -z "${NVR_HTTP_PASS:-}" ]; then
  # 8 位随机口令（去掉易混淆字符）
  NVR_HTTP_PASS="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-10)"
  export NVR_HTTP_PASS
  echo "=============================================================="
  echo " 飞海监控 首次启动 · 已自动生成访问口令"
  echo "   用户名: ${NVR_HTTP_USER:-admin}"
  echo "   密  码: ${NVR_HTTP_PASS}"
  echo " 请记下！以后可用环境变量 NVR_HTTP_USER / NVR_HTTP_PASS 覆盖。"
  echo "=============================================================="
fi

exec node /app/server.mjs
