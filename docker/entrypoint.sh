#!/bin/sh
# 飞海监控 FNHK · Docker 入口脚本
# 作用：准备目录 + 首次启动用默认口令 admin（用户可稍后在网页里自行修改），然后启动服务。
# 说明：默认口令只为「开箱即用」；用户改过的口令存在数据卷的配置文件里，重启/重建容器都沿用。
#       访问地址与当前用户名/密码由服务启动后打印（见 server.mjs 的 announceAccess）。
set -e

CONF="${NVR_CONF:-/data/config.json}"
mkdir -p "$(dirname "$CONF")" "${NVR_REC_ROOT:-/rec}" "${NVR_DATA:-/data}"

# 首次启动（还没有配置文件）且用户没自己指定口令 → 使用默认口令 admin
if [ ! -f "$CONF" ] && [ -z "${NVR_HTTP_PASS:-}" ]; then
  NVR_HTTP_USER="${NVR_HTTP_USER:-admin}"
  NVR_HTTP_PASS=admin
  export NVR_HTTP_USER NVR_HTTP_PASS
  echo "[init] 首次启动：使用默认口令（用户名 admin / 密码 admin），稍后在「设置 → 🔑 访问口令」里可以改。"
elif [ ! -f "$CONF" ]; then
  echo "[init] 首次启动：使用你通过 NVR_HTTP_PASS 指定的口令。"
fi

exec node /app/server.mjs
