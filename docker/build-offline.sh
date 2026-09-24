#!/bin/sh
# 飞海监控 FNHK · 本地/离线构建脚本
# 用途：在任意有 docker 的机器上构建镜像，并导出「离线镜像包」（用户无需联网即可导入）。
# 用法：sh docker/build-offline.sh [镜像标签] [输出文件名]
#   例：sh docker/build-offline.sh fnhk:v0.4.0 fnhk-docker-v0.4.0.tar.gz
set -e
cd "$(dirname "$0")/.."   # 切到仓库根目录（Dockerfile 所在处）

TAG="${1:-fnhk:latest}"
OUT="${2:-fnhk-docker-offline.tar.gz}"

echo "==> 构建镜像 $TAG"
docker build -t "$TAG" .

echo "==> 导出离线包 $OUT"
docker save "$TAG" | gzip -9 > "$OUT"
ls -lh "$OUT"

echo
echo "离线包已生成：$OUT"
echo "用户导入（在目标 NAS 上执行）："
echo "  gunzip -c $OUT | docker load"
echo "然后： docker run -d --name fnhk -p 8091:8091 -v /vol1/docker/fnhk/data:/data -v /vol1/docker/fnhk/rec:/rec --restart unless-stopped $TAG"
