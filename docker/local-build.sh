#!/usr/bin/env bash
# 飞海监控 FNHK · 在飞牛 NAS 上「本地增量构建」镜像（不需要 docker 守护进程）
#
# 原理：以已有的镜像为底座（里面已有 node + ffmpeg + ENV + ENTRYPOINT + HEALTHCHECK），
#       把 app/ 与 entrypoint.sh 打包成**一层**叠上去，直接推到镜像仓库。
#       后加的层会覆盖底座里的同名文件 → 等于"只换程序文件"的快速重建（十几秒）。
#
# 用法：
#   docker/local-build.sh <registry/命名空间/仓库:标签> [额外标签...] [--base <底座镜像>]
# 例：
#   docker/local-build.sh ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest v0.4.0
#
# 依赖：crane（已登录仓库）。默认底座 = 仓库里的 :latest。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"        # repo 根目录
CARGO_DIR="$SRC_DIR/fn-hiknvr/app/server"       # 与 Dockerfile 的 `COPY fn-hiknvr/app/server/ /app/` 对齐
REG="ccr.ccs.tencentyun.com/ypopenclaw/fnhk"
REF=""
EXTRA=()
CRANE=${CRANE:-crane}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --registry) REG="$2"; shift 2 ;;
    -*) echo "未知参数：$1" >&2; exit 1 ;;
    *) if [ -z "$REF" ]; then REF="$1"; else EXTRA+=("$1"); fi; shift ;;
  esac
done
REF="${REF:-$REG:latest}"
case "$REF" in */*:*) ;; *) REF="$REG:$REF" ;; esac
BASE="${BASE:-$REG:latest}"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
echo "==> 底座镜像：$BASE"
echo "==> 目标镜像：$REF"

# ---- 组装一层：容器内路径 /app/** 与 /entrypoint.sh ----
mkdir -p "$WORK/layer/app"
cp -a "$CARGO_DIR/." "$WORK/layer/app/"
cp -a "$SRC_DIR/docker/entrypoint.sh" "$WORK/layer/entrypoint.sh"
chmod 755 "$WORK/layer/entrypoint.sh"
# 属主统一 root:root（容器内以 root 运行）
tar --owner=0 --group=0 --numeric-owner -C "$WORK/layer" -cf "$WORK/layer.tar" .
echo "==> 层大小：$(du -h "$WORK/layer.tar" | cut -f1)  （文件：$(tar tf "$WORK/layer.tar" | wc -l) 个）"

# ---- 叠加 + 推送 ----
"$CRANE" append --base "$BASE" --new_layer "$WORK/layer.tar" --new_tag "$REF"

# ---- 额外标签（同一 digest）----
for t in "${EXTRA[@]:-}"; do
  [ -n "$t" ] || continue
  case "$t" in
    */*:*) full="$t"; tagname="${t##*:}" ;;
    */*)   full="$t"; tagname="${t##*/}" ;;
    *:*)   base="${REF%:*}"; tagname="${t##*:}"; full="$base:$tagname" ;;
    *)     full="${REF%:*}:$t"; tagname="$t" ;;
  esac
  "$CRANE" tag "$REF" "$tagname"
  echo "==> 已加标签：$full"
done

echo "✅ 完成：$REF"
"$CRANE" digest "$REF" || true
