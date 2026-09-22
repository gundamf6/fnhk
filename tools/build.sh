#!/bin/bash
# 打包 fn-hiknvr.fpk（需要飞牛 fnpack）
set -e
cd "$(dirname "$0")/../fn-hiknvr"
command -v fnpack >/dev/null || { echo "未找到 fnpack（fnOS 自带，通常在 /usr/local/bin/fnpack）"; exit 1; }
fnpack build
ls -la ./*.fpk
