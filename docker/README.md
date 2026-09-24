# 飞海监控 FNHK · Docker 部署

在任意支持 Docker 的设备上跑「飞海监控」（群晖 / 威联通 / 极空间 / 绿联 / 树莓派 / Linux 主机 / Windows Docker Desktop 都可以）。
镜像**自带 ffmpeg**，不用自己装依赖。

> 飞牛 fnOS 用户见文末「特别说明」，直接用 `fn-hiknvr-x.y.z.fpk` 安装，不需要看本文档。

---

## 第一种安装方式：在线安装（推荐）

一行命令（把 `/你的路径` 换成你自己的盘路径）：

```bash
docker run -d --name fnhk --restart unless-stopped -p 8091:8091 \
  -e TZ=Asia/Shanghai \
  -v /你的路径/fnhk-data:/data -v /你的路径/fnhk-rec:/rec \
  ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
```

取首次启动的访问密码：

```bash
docker logs fnhk
```

浏览器打开 `http://设备IP:8091`，用户名 `admin`，密码看上一条日志。

**群晖 / 威联通 图形界面**：容器管理里新建容器 → 镜像填 `ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest` → 端口映射 `8091:8091` → 存储映射「你的目录 → `/data`」「你的录像目录 → `/rec`」→ 环境变量 `TZ=Asia/Shanghai` → 启动。

---

## 第二种安装方式：docker compose

新建一个文件夹，放 `docker-compose.yml`：

```yaml
services:
  fnhk:
    image: ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
    container_name: fnhk
    restart: unless-stopped
    ports:
      - "8091:8091"
    environment:
      TZ: Asia/Shanghai
    volumes:
      - ./fnhk-data:/data      # 配置 + 运行数据
      - ./fnhk-rec:/rec        # 录像（建议换成大盘路径）
```

然后：

```bash
docker compose up -d
docker logs fnhk      # ← 首次启动的访问密码在这里
```

> 冒号左边是**你设备上的路径**（随便改，Docker 会自动建目录）；冒号右边 `/data`、`/rec` 是容器内的固定路径，**别改**。

---

## 第三种安装方式：离线安装（完全不用联网拉镜像）

适合拉不动镜像的网络环境。下载 `fnhk-docker-offline-amd64.tar.gz`（若超过 100MB 会分成 `part-00`、`part-01`…），上传到设备后：

```bash
# 如果是分卷，先合并（没有 part 文件就跳过这步）
cat fnhk-docker-offline-amd64.tar.gz.part-* > fnhk-docker-offline-amd64.tar.gz

# 导入镜像（导入后镜像名是 fnhk:offline）
gunzip -c fnhk-docker-offline-amd64.tar.gz | docker load

# 启动（把镜像名换成 fnhk:offline）
docker run -d --name fnhk --restart unless-stopped -p 8091:8091 \
  -e TZ=Asia/Shanghai -v /你的路径/data:/data -v /你的路径/rec:/rec fnhk:offline

docker logs fnhk
```

---

## 特别说明：飞牛 fnOS 用户怎么安装

飞牛用户**不需要**用上面的 Docker 方式：到 Releases 下载 **`fn-hiknvr-x.y.z.fpk`**，在飞牛「**应用中心 → 手动安装**」里选择该文件即可，配置方式与以前版本完全一样。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | 时区（影响录像分目录时间） |
| `NVR_HTTP_USER` | `admin` | 登录用户名 |
| `NVR_HTTP_PASS` | 首次启动自动生成 | 登录密码（**设了就以环境变量为准**） |
| `NVR_PORT` | `8091` | 服务端口 |
| `NVR_HTTP_HOST` | `0.0.0.0` | 监听地址（容器内别改） |
| `NVR_REC_ROOT` | `/rec` | 录像目录（容器内） |
| `NVR_DATA` | `/data` | 数据目录（容器内） |
| `NVR_RETENTION_DAYS` | `3` | 录像保留天数 |
| `NVR_SEGMENT_SECONDS` | `300` | 单个录像片段时长（秒） |

> ⚠️ 安全：服务**必须设置访问口令**才会监听对外地址（没口令时只允许本机访问）。首次启动会自动生成一个并打印在日志里，记得改掉或自己用 `NVR_HTTP_PASS` 指定。

---

## 常见问题

**Q：忘了密码？**
改 `docker-compose.yml`，加一行 `NVR_HTTP_PASS: 你的新密码`，然后 `docker compose up -d` 重建容器即可。

**Q：录像存在哪？**
容器里是 `/rec`，对应你挂载的宿主机目录。建议挂到大容量硬盘，如 `/volume1/NVR`、`/vol2/1000/NVR`。

**Q：ARM 设备（树莓派 / 部分 ARM 群晖）能用吗？**
当前提供的是 **amd64** 镜像（绝大多数 NAS / 主机都是 x86_64）。如果你需要在 **arm64**（如树莓派、ARM 架构 NAS）上跑，可在 GitHub 那边勾选 `push_registry=true` 让 CI 出多架构镜像，或用 `buildx --platform linux/arm64` 自行构建。

**Q：怎么升级？**
```bash
docker compose pull && docker compose up -d
```

**Q：手机看监控卡？**
界面里可切换主/子码流，宫格预览默认走子码流，单画面走主码流。

---

## 开发者：怎么发布新镜像

1. 推送到 GitHub 触发 CI（`.github/workflows/docker.yml`）：CI 只编译，产出 `fnhk-docker-offline-amd64.tar.gz`（超 100MB 自动分卷）供离线安装
2. 在国内机器上用 `docker/push.sh` 推到镜像仓库（GitHub 机房在海外，跨境推送很慢，所以不在 CI 里推）：
   ```bash
   # 本地起构建也可：docker build -t fnhk:offline .
   # 然后用 crane + skopeo 推送（会自动把未压缩的层重新压成 gzip）
   crane auth login ccr.ccs.tencentyun.com -u <账号ID> -p <密码>
   docker/push.sh ./fnhk-docker-offline-amd64.tar.gz ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
   ```
3. 若勾选 CI 里的 `push_registry=true`，CI 会自己构建多架构（amd64+arm64）并推送（需配好 Secrets，且跨境推送较慢）
