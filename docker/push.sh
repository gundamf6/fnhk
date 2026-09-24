#!/usr/bin/env bash
# 把镜像归档推送到镜像仓库（不需要 Docker 守护进程）
#
# 用途：GitHub Actions 只负责编译并产出归档；发布时在**国内机器**上跑这个脚本推镜像，
#       避免从海外 CI 直接推送（跨境很慢）。
#
# 用法：
#   docker/push.sh <oci目录 | .tar | .tar.gz> <registry/命名空间/仓库:标签>
#
# 例：
#   docker/push.sh ./fnhk-docker-offline-amd64.tar.gz ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
#
# 依赖：crane 与 skopeo（都可用环境变量指定路径）
#   CRANE=/path/to/crane SKOPEO=/path/to/skopeo docker/push.sh ...
#
# 说明：会先把镜像层统一重新压缩为 gzip（CI 导出的层可能是未压缩的，原样推上去
#       用户拉取会多传 2~3 倍流量），再用 crane 推送。
set -euo pipefail

# skopeo 会在 XDG_RUNTIME_DIR 下找/建容器配置目录
: "${XDG_RUNTIME_DIR:=/tmp}"; export XDG_RUNTIME_DIR

SRC=${1:?用法: push.sh <oci目录|归档> <registry/ns/repo:tag>}
REF=${2:?用法: push.sh <oci目录|归档> <registry/ns/repo:tag>}
CRANE=${CRANE:-crane}
SKOPEO=${SKOPEO:-skopeo}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 1. 准备一个 OCI 布局目录
if [ -d "$SRC" ]; then
  layout="$SRC"
else
  case "$SRC" in
    *.tar.gz|*.tgz) tar xzf "$SRC" -C "$work" ;;
    *.tar)          tar xf  "$SRC" -C "$work" ;;
    *) echo "不认识的归档类型: $SRC" >&2; exit 1 ;;
  esac
  if [ -f "$work/index.json" ]; then
    layout="$work"
  elif [ -d "$work/app" ] || [ -f "$work/manifest.json" ]; then
    echo "这是 docker-archive 格式，请先用 skopeo 转成 OCI 布局（oci-archive:）" >&2
    exit 1
  else
    echo "归档里找不到 index.json" >&2; exit 1
  fi
fi

# 2. OCI 布局里的引用名（index.json 的 org.opencontainers.image.ref.name）
refname=$("$SKOPEO" --version >/dev/null 2>&1 || true; python3 - "$layout" <<'PY'
import json,sys
idx=json.load(open(sys.argv[1]+'/index.json'))
ms=idx.get('manifests',[])
if len(ms)!=1:
    print('')
else:
    ann=ms[0].get('annotations') or {}
    print(ann.get('org.opencontainers.image.ref.name','offline'))
PY
)
[ -n "$refname" ] || refname=offline

# 3. 重新压缩为 gzip（未压缩的层会被压成 tar+gzip）
if "$SKOPEO" --version >/dev/null 2>&1; then
  # skopeo 需要信任策略文件（仅格式要求，不做签名校验）
  mkdir -p "$work/etc"
  printf '{"default":[{"type":"insecureAcceptAnything"}]}' > "$work/etc/policy.json"
  # 本地不做 signature 校验，也不需要 authfile（重新压缩不访问网络）
  "$SKOPEO" copy --policy "$work/etc/policy.json" \
    "oci:$layout:$refname" "oci:$work/out:$refname" >/dev/null
  layout="$work/out"
fi

# 4. 推送
"$CRANE" push "$layout" "$REF"
echo "✅ 已推送：$REF"
