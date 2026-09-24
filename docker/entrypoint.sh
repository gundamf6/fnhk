#!/bin/sh
# 飞海监控 FNHK · Docker 入口脚本
# 作用：准备目录 + 首次启动用默认口令 admin（打印到日志），然后启动服务。
# 说明：默认口令只为「开箱即用」；用户可在网页「设置 → 🔑 访问口令」里自行修改，
#       改完写入配置文件（存在数据卷里），以后重启/重建容器都沿用新口令。
set -e

CONF="${NVR_CONF:-/data/config.json}"
mkdir -p "$(dirname "$CONF")" "${NVR_REC_ROOT:-/rec}" "${NVR_DATA:-/data}"

# 首次启动（还没有配置文件）且用户没自己指定口令 → 使用默认口令 admin
if [ ! -f "$CONF" ] && [ -z "${NVR_HTTP_PASS:-}" ]; then
  NVR_HTTP_USER="${NVR_HTTP_USER:-admin}"
  NVR_HTTP_PASS=admin
  export NVR_HTTP_USER NVR_HTTP_PASS
  echo "=============================================================="
  echo " 飞海监控 首次启动"
  echo "   访问地址: http://<这台设备的IP>:${NVR_PORT:-8091}"
  echo "   用户名  : ${NVR_HTTP_USER}"
  echo "   密  码  : ${NVR_HTTP_PASS}"
  echo " ------------------------------------------------------------"
  echo " 这是默认口令，建议登录后在「设置 → 🔑 访问口令」里改成你自己的。"
  echo " 想直接指定口令：启动容器时加  -e NVR_HTTP_PASS=你的密码"
  echo "=============================================================="
elif [ ! -f "$CONF" ]; then
  echo "=============================================================="
  echo " 飞海监控 首次启动 · 使用你指定的用户名/口令"
  echo "   用户名: ${NVR_HTTP_USER:-admin}   密码: （你设置的那一个）"
  echo "=============================================================="
fi

exec node /app/server.mjs
