# 飞海监控 FNHK · Docker 镜像
# 构建（在仓库根目录执行）：
#   docker build -t fnhk:latest .
#   docker buildx build --platform linux/amd64,linux/arm64 -t <你的仓库>/fnhk:latest --push .
FROM node:24-alpine

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    NODE_ENV=production \
    NVR_DOCKER=1 \
    NVR_CONF=/data/config.json \
    NVR_DATA=/data \
    NVR_REC_ROOT=/rec \
    NVR_PORT=8091 \
    NVR_HTTP_HOST=0.0.0.0 \
    NVR_HTTP_USER=admin \
    NVR_PREFIX= \
    NVR_FFMPEG=/usr/bin/ffmpeg
# 注：默认口令 admin 由 entrypoint.sh 在「首次启动」时写入配置；用户可在网页里自行修改（改完写入 /data/config.json，重启不丢）。
#     故意不在这里写 ENV NVR_HTTP_PASS —— 否则每次重启都会被环境变量覆盖回去，用户改的密码会失效。

# 自带 ffmpeg（用户无需自行安装），顺手换上时区
RUN apk add --no-cache ffmpeg tzdata ca-certificates \
 && cp /usr/share/zoneinfo/$TZ /etc/localtime && echo "$TZ" > /etc/timezone \
 # 精简镜像：本应用是纯 JS + 调用 ffmpeg，不需要 npm/yarn/corepack
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm /tmp/*

WORKDIR /app
COPY fn-hiknvr/app/server/ /app/

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data /rec

EXPOSE 8091
VOLUME ["/data", "/rec"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NVR_PORT||8091)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
