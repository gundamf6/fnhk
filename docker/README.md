# 飞海监控 FNHK · Docker 部署

在任意支持 Docker 的设备上跑「飞海监控」（群晖 / 威联通 / 极空间 / 绿联 / 树莓派 / Linux 主机 / Windows Docker Desktop 都可以）。
镜像**自带 ffmpeg**，不用自己装依赖。

> 飞牛 fnOS 用户见文末「特别说明」，直接用 `fn-hiknvr-x.y.z.fpk` 安装，不需要看本文档。

> 🔴 **群晖用户先看这里**：群晖的防火墙默认会把 Docker 的 `172.17.x` 网段全部丢弃 → 容器会「完全没网」（网页能开，但加摄像机、拉流全部超时）。
> 解决办法：**把 `-p 8091:8091` 换成 `--network host`**（不用改防火墙，启动日志还会直接显示 NAS 的真实 IP）。详见文末「特别说明：群晖 / 开了防火墙的 NAS」。

---

## 第一种安装方式：在线安装（推荐）

一行命令（**复制粘贴、回车即可 —— 不用改任何路径**）：

```bash
docker run -d --name fnhk --restart unless-stopped -p 8091:8091 \
  -e TZ=Asia/Shanghai \
  -v fnhk-data:/data \
  -v fnhk-rec:/rec \
  ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
```

> 这里用的是 Docker 的**命名卷**（`fnhk-data` / `fnhk-rec`），**存放位置由 Docker 管理** → 飞牛 / 群晖 / 威联通 / 绿联 / 树莓派 / Windows **全平台照抄可跑**，不存在「路径填错」。
> 查录像存哪：`docker volume inspect fnhk-rec`（看 `Mountpoint`）；群晖一般在 `/volume1/@docker/volumes/fnhk-rec/_data`。
>
> 💡 **想把录像直接放到自己的硬盘 / 共享文件夹**（方便在文件管理器里看、拷）：把 `-v fnhk-rec:/rec` 一行换成——
>
> | 系统 | 换成 |
> |---|---|
> | 飞牛 fnOS | `-v /vol1/docker/fnhk/rec:/rec` |
> | 群晖 DSM | `-v /volume1/docker/fnhk/rec:/rec` |
> | 威联通 QTS | `-v /share/CACHEDEV1_DATA/docker/fnhk/rec:/rec` |
> | 绿联 / 极空间 / 其它国产 NAS | `-v /volume1/docker/fnhk/rec:/rec` |
> | 树莓派 / Linux | `-v /opt/fnhk/rec:/rec` |
>
> 目录不存在会**自动创建**；左边随便换，右边 `/rec` **不能改**。

**每个参数啥意思**（一个都不用改，照抄即可）：

| 参数 | 作用 | 能省吗 |
|---|---|---|
| `-d` | 后台运行 | ❌ 省了关窗口就停 |
| `--name fnhk` | 容器名（方便看日志/升级） | 可省，但名字变随机 |
| `--restart unless-stopped` | 开机自启、崩了自动拉起 | 建议保留 |
| `-p 8091:8091` | 端口映射（左边=你访问用的端口） | ❌ 省了打不开 |
| `-e TZ=Asia/Shanghai` | 时区（影响录像分目录） | 可省（镜像已内置） |
| `-v fnhk-data:/data` | 配置 / 数据持久化 | 可省（会用随机匿名卷） |
| `-v fnhk-rec:/rec` | **录像存放位置** | 可省（同上） |
| 最后一行 | 镜像地址 | ❌ 必需 |

> 最短写法 `docker run -d -p 8091:8091 <镜像>` 也能跑，但名字随机、易丢数据、开机不自启，**不建议**。

> 📁 **录像到底存哪了？文件管理器里怎么找不到？** 命名卷由 Docker 自己管理，位于系统区（群晖为 `@docker` 目录，文件管理器默认不显示）。
> · 查位置：`docker volume inspect fnhk-rec`（群晖一般 = `/volume1/@docker/volumes/fnhk-rec/_data`）
> · **想让录像直接出现在共享文件夹里**：把 `-v fnhk-rec:/rec` 换成 `-v /volume1/docker/fnhk-rec:/rec`（飞牛 `/vol1/...`、威联通 `/share/CACHEDEV1_DATA/...`），再 `docker rm -f fnhk` + 重新 `docker run`（摄像机配置在 `fnhk-data` 卷里，不会丢）。

取首次启动的访问密码：

```bash
docker logs fnhk
```

浏览器打开 `http://设备IP:8091`，用户名 `admin`、密码 `admin`（**每次启动都会打印在日志里**；登录后可在「设置 → 🔑 访问口令」改成自己的）。

**群晖 / 威联通 图形界面**（推荐，全程不用打路径）：容器管理里新建容器 → 镜像填 `ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest` → 端口映射 `8091:8091` → **存储：加两个「卷」**，名称 `fnhk-data` 挂 `/data`、`fnhk-rec` 挂 `/rec`（也可在界面上直接选自己的文件夹挂到 `/rec`）→ 环境变量 `TZ=Asia/Shanghai` → 启动。

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
      - fnhk-data:/data      # 配置 + 运行数据（命名卷）
      - fnhk-rec:/rec        # 录像（命名卷；想放自己的盘见上方对照表）

volumes:
  fnhk-data:
  fnhk-rec:
```

然后：

```bash
docker compose up -d
docker logs fnhk      # ← 首次启动的访问密码在这里
```

> 命名卷不用改路径，任何系统直接跑。右边 `/data`、`/rec` 是容器内固定路径，**别改**。

---

## 第三种安装方式：离线安装（完全不用联网拉镜像）

适合拉不动镜像的网络环境。下载 `fnhk-docker-offline-amd64.tar.gz`（若超过 100MB 会分成 `part-00`、`part-01`…），上传到设备后：

```bash
# 如果是分卷，先合并（没有 part 文件就跳过这步）
cat fnhk-docker-offline-amd64.tar.gz.part-* > fnhk-docker-offline-amd64.tar.gz

# 导入镜像（导入后镜像名是 fnhk:offline）
gunzip -c fnhk-docker-offline-amd64.tar.gz | docker load

# 启动（把镜像名换成 fnhk:offline；不用改任何路径）
docker run -d --name fnhk --restart unless-stopped -p 8091:8091 \
  -e TZ=Asia/Shanghai \
  -v fnhk-data:/data \
  -v fnhk-rec:/rec \
  fnhk:offline

docker logs fnhk
```

---

## 特别说明：群晖 / 开了防火墙的 NAS ★

**症状**：容器能起来、网页能打开、能加摄像机，但「测试连接」永远失败（日志全是 `Operation timed out`）——而且容器里**连外网也不通**。

**原因**：群晖「控制面板 → 安全性 → 防火墙」默认只放行局域网网段（如 `192.168.20.0/24`），**Docker 用的 `172.17.x.x` 网段不在放行范围 → 被全部丢弃**。

**✅ 推荐解法（不碰防火墙）**：把 `-p 8091:8091` 换成 `--network host`：

```bash
# 先删掉旧容器（配置在 fnhk-data 卷里，不会丢）
docker rm -f fnhk
docker run -d --name fnhk --restart unless-stopped --network host \
  -e TZ=Asia/Shanghai \
  -v fnhk-data:/data \
  -v /volume1/docker/NVR:/rec \
  ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
```

好处：① 不用改群晖防火墙；② 容器里能看到 NAS 的真实 IP，启动日志直接显示 `http://192.168.20.201:8091`（不再是 `0.0.0.0`）。
（Container Manager 图形界面里同理：网络选 **host**。）

**备选**：保留 `-p 8091:8091`，去「控制面板 → 安全性 → 防火墙」加一条**允许来源 `172.17.0.0/16`、全部端口**的规则（不推荐：改了系统防火墙，且 DSM 重建规则后可能失效）。

> 另一个常见坑：**「IP 地址」要填摄像机自己的 IP，不是 NAS 的 IP**。
> 点「测试连接」失败时会附带 **「诊断详情（ffmpeg 原话）」**：`No route to host`=网络不通、`401 Unauthorized`=账号密码不对、`404`=通道号不对。

---

## 特别说明：飞牛 fnOS 用户怎么安装

飞牛用户**不需要**用上面的 Docker 方式：到 Releases 下载 **`fn-hiknvr-x.y.z.fpk`**，在飞牛「**应用中心 → 手动安装**」里选择该文件即可，配置方式与以前版本完全一样。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | 时区（影响录像分目录时间） |
| `NVR_HTTP_USER` | `admin` | 登录用户名 |
| `NVR_HTTP_PASS` | `admin`（首次启动写入配置） | 登录密码；设了就以环境变量为准。**忘了密码就用它重置**（重建容器，配置/录像都不丢） |
| `NVR_PORT` | `8091` | 服务端口 |
| `NVR_HTTP_HOST` | `0.0.0.0` | 监听地址（容器内别改） |
| `NVR_REC_ROOT` | `/rec` | 录像目录（容器内） |
| `NVR_DATA` | `/data` | 数据目录（容器内） |
| `NVR_RETENTION_DAYS` | `3` | 录像保留天数 |
| `NVR_SEGMENT_SECONDS` | `300` | 单个录像片段时长（秒） |

> ⚠️ 安全：开箱是 `admin/admin`（内网用）。**同网段任何设备都能访问**，公网暴露或对安全有要求时，请在「设置 → 🔑 访问口令」改掉，或用 `-e NVR_HTTP_PASS=你的密码` 指定。

---

## 常见问题

**Q：忘了密码？**
加一个环境变量重建容器即可（配置/录像都不丢）：加 `-e NVR_HTTP_PASS=你的新密码`（compose 里加一行 `NVR_HTTP_PASS: 你的新密码`）后重新 `docker run` / `docker compose up -d`。

**Q：加摄像机提示「连不上：检查 IP / 端口 / 网络」？**
① IP 有没有填成 NAS 自己的地址；② 群晖是否开了防火墙（见文末「特别说明：群晖」）；③ 点「测试连接」看「诊断详情（ffmpeg 原话）」。

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

> **首选：在飞牛 NAS 上「本地增量构建」**（不需要 docker 守护进程，也不需要 GitHub，几秒出镜像）：
> ```bash
> docker/local-build.sh ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest v0.4.0
> ```
> 原理：以现有镜像为底座，把 `fn-hiknvr/app/server/**` + `docker/entrypoint.sh` 打成一层 `crane append` 上去（后层覆盖同名文件）→ 只换程序文件。
> 改了 ENV / 系统依赖（Dockerfile）时才需要走下面的完整构建。

1. 推送到 GitHub 触发 CI（`.github/workflows/docker.yml`）：CI 只编译，产出 `fnhk-docker-offline-amd64.tar.gz`（超 100MB 自动分卷）供离线安装
2. 在国内机器上用 `docker/push.sh` 推到镜像仓库（GitHub 机房在海外，跨境推送很慢，所以不在 CI 里推）：
   ```bash
   # 本地起构建也可：docker build -t fnhk:offline .
   # 然后用 crane + skopeo 推送（会自动把未压缩的层重新压成 gzip）
   crane auth login ccr.ccs.tencentyun.com -u <账号ID> -p <密码>
   docker/push.sh ./fnhk-docker-offline-amd64.tar.gz ccr.ccs.tencentyun.com/ypopenclaw/fnhk:latest
   ```
3. 若勾选 CI 里的 `push_registry=true`，CI 会自己构建多架构（amd64+arm64）并推送（需配好 Secrets，且跨境推送较慢）
