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
    NVR_PREFIX= \
    NVR_FFMPEG=/usr/bin/ffmpeg

# 自带 ffmpeg（用户无需自行安装），顺手换上时区
RUN apk add --no-cache ffmpeg tzdata ca-certificates \
 && cp /usr/share/zoneinfo/$TZ /etc/localtime && echo "$TZ" > /etc/timezone

WORKDIR /app
COPY fn-hiknvr/app/server/ /app/

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data /rec

EXPOSE 8091
VOLUME ["/data", "/rec"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NVR_PORT||8091)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
