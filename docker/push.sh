#!/usr/bin/env bash
# 把导出的镜像归档推送到镜像仓库（不需要 Docker 守护进程，使用 crane）
#
# 用法：
#   docker/push.sh <oci目录 | .tar | .tar.gz> <registry/命名空间/仓库:标签>
#
# 例：
#   docker/push.sh ./fnhk-docker-offline-amd64.tar.gz ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
#
# 依赖：crane（https://github.com/google/go-containerregistry）
#   CRANE=/path/to/crane docker/push.sh ...
set -euo pipefail

SRC=${1:?用法: push.sh <oci目录|归档> <registry/ns/repo:tag>}
REF=${2:?用法: push.sh <oci目录|归档> <registry/ns/repo:tag>}
CRANE=${CRANE:-crane}

if [ -d "$SRC" ]; then
  "$CRANE" push "$SRC" "$REF"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  case "$SRC" in
    *.tar.gz|*.tgz) tar xzf "$SRC" -C "$tmp" ;;
    *.tar)          tar xf  "$SRC" -C "$tmp" ;;
    *) echo "不认识的归档类型: $SRC" >&2; exit 1 ;;
  esac
  "$CRANE" push "$tmp" "$REF"
fi

echo "✅ 已推送：$REF"
