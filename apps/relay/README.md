# atrium-relay

手机端的 relay（[SPEC-0005 · 部署 relay、relay 的线路协议](../../docs/specs/0005-mobile-app-and-remote-access.md)，[ADR-0016](../../docs/adr/0016-remote-access-through-own-relay-with-noise.md)）：跑在你自己的 VPS 上，在 Mac 上的宿主和手机之间原样转发 Noise 加密后的字节，看不到内容。一个文件 `relay.cjs`（Node 24），或者一个 Docker 镜像。

```
手机 ──wss──▶ xray :443（TLS）──回落──▶ nginx 127.0.0.1:8080 ── location /atrium/ ──▶ 127.0.0.1:8787 atrium-relay（Docker）
Mac  ──wss──▶          同上
```

对外的入口（`<前缀>` 是 `/atrium`）：`wss://ktoon.site/atrium/v1/host`、`/v1/host/stream`、`/v1/client?host=<hostId>`，健康检查 `https://ktoon.site/atrium/healthz`。

## 数据目录

一个目录放全部状态（Docker 里挂成 `/data`，宿主机上建议 `/srv/atrium-relay/data`）：

| 文件                          | 谁写              | 内容                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.json`                  | 你，手写          | `publicHost`（对外域名，非 443 时带端口，必填）、`pathPrefix`（如 `/atrium`，默认空）、`trustedProxies`（信任哪些反代地址给的真实 IP 头，默认空）、`newStreamsPerIpPerMinute`（默认 30，0 关闭）。不认识的字段报错。例子：`deploy/relay.example.json` |
| `hosts.json`                  | `add-host` 等命令 | 每个宿主的 `hostId`、名字、令牌的 SHA-256、创建时间（0600）。正在跑的 relay 每 2 秒看一次，变了就生效                                                                                                                                                 |
| `logs/relay-<UTC 日期>.jsonl` | relay             | 只有元数据，一天一个文件，留 14 天                                                                                                                                                                                                                    |

## 部署（用户的 VPS：Debian 12、x86_64、Docker、已有 nginx 和 xray）

`relay.cjs` 在 Mac 上构建，镜像在 VPS 上用同一个 Dockerfile 构建（2026-10-26 实际部署时改：从这边网络 `docker save | ssh … docker load` 传 80 MB 的镜像只有约 17 KB/s，超时；只传 1 MB 的 `relay.cjs` 要一分钟，VPS 自己拉官方 Node 镜像很快，拉到的 digest 和 Dockerfile 里写死的一致）。网络好的时候也可以照下面第 1 步的"另一种"在 Mac 上构建整个镜像再传。

1. **Mac 上构建 `relay.cjs`，传到 VPS 上构建镜像**（仓库根目录，依赖已装好）：

   ```sh
   VERSION=$(date +%Y.%m.%d)
   pnpm --filter @atrium/relay build
   ssh <vps> 'mkdir -p /root/atrium-relay-build/dist'
   scp apps/relay/Dockerfile apps/relay/.dockerignore apps/relay/deploy/compose.yaml <vps>:/root/atrium-relay-build/
   scp apps/relay/dist/relay.cjs <vps>:/root/atrium-relay-build/dist/
   shasum -a 256 apps/relay/dist/relay.cjs; ssh <vps> sha256sum /root/atrium-relay-build/dist/relay.cjs   # 两边一致
   ssh <vps> "cd /root/atrium-relay-build && docker build -q -t atrium-relay:$VERSION ."
   ```

   另一种（网络好时）：在 Mac 上 `docker buildx build --platform linux/amd64 -t atrium-relay:$VERSION --load apps/relay`，再 `docker save atrium-relay:$VERSION | gzip | ssh <vps> 'gunzip | docker load'`。


   镜像约 80 MB（官方 `node:24.22.1-bookworm-slim` 加 1 MB 的 `relay.cjs`）。构建的第一阶段会在镜像的 Node 上跑一次 `add-host` / `list-hosts`，打包坏了构建就失败。

2. **VPS 上准备目录**（镜像里以 uid 1000 的 `node` 用户运行）：

   ```sh
   sudo install -d -m 0755 /srv/atrium-relay
   sudo install -d -o 1000 -g 1000 -m 0700 /srv/atrium-relay/data
   sudo tee /srv/atrium-relay/data/relay.json >/dev/null <<'EOF'
   { "publicHost": "ktoon.site", "pathPrefix": "/atrium" }
   EOF
   sudo chown 1000:1000 /srv/atrium-relay/data/relay.json
   sudo cp deploy/compose.yaml /srv/atrium-relay/   # 从仓库拷过去
   ```

3. **启动**：

   ```sh
   cd /srv/atrium-relay && sudo ATRIUM_RELAY_VERSION=$VERSION docker compose up -d
   curl -s http://127.0.0.1:8787/atrium/healthz      # ok
   ```

   `compose.yaml` 只把端口发布到宿主机的 `127.0.0.1:8787`，根文件系统只读、去掉全部 capability、`no-new-privileges`，内存 512 MB。不用 compose 时等价的命令：

   ```sh
   docker run -d --name atrium-relay --restart unless-stopped -p 127.0.0.1:8787:8787 \
     -v /srv/atrium-relay/data:/data --read-only --cap-drop ALL --security-opt no-new-privileges:true \
     atrium-relay:$VERSION
   ```

4. **nginx**：先备份 `/etc/nginx/conf.d/ktoon.site.ssl.conf`，把 `deploy/nginx-location.conf` 的 `location /atrium/ { … }` 加进 xray 回落到的那个 `server { listen 127.0.0.1:8080; … }`，然后 `sudo nginx -t && sudo systemctl reload nginx`。xray 按 ALPN 把 HTTP/2 回落到 `127.0.0.1:8081`（h2c），那个 server 里也加一个只做普通反代的 `location /atrium/`（`proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; proxy_set_header Host $host; proxy_buffering off;`），否则 HTTP/2 的客户端（浏览器、默认的 curl）访问 `/atrium/healthz` 是 404；WebSocket 都走 HTTP/1.1 升级（实测 Node `ws` 和 iOS 的 `URLSessionWebSocketTask` 都是），到 8080 那个。`proxy_pass` 不带路径，前缀原样交给 relay（relay 自己认前缀）。验证：

   ```sh
   curl -s https://ktoon.site/atrium/healthz        # ok
   ```

5. **加宿主**（见下），把打印的一行粘到桌面"手机"页。

不用 Docker 时：装 Node 24，把 `relay.cjs` 放到 `/opt/atrium-relay/`，用 `deploy/atrium-relay.service`（文件开头写了要建的用户和目录）。前面换成 Caddy 也行：`handle /atrium/* { reverse_proxy 127.0.0.1:8787 }`，同样不去掉前缀。

## 加宿主、换令牌、删宿主

```sh
docker exec atrium-relay node /app/relay.cjs add-host "MacBook"   # 打印一行 atrium-relay://hst_…:<令牌>@ktoon.site/atrium
docker exec atrium-relay node /app/relay.cjs list-hosts           # hostId、名字、创建时间（不含令牌）
docker exec atrium-relay node /app/relay.cjs rotate-host <hostId> # 换令牌，打印新的一行；旧连接 2 秒内以 4401 断开
docker exec atrium-relay node /app/relay.cjs remove-host <hostId> # 删掉；在线的 2 秒内断开
```

- 令牌**只打印这一次**，relay 只存它的哈希；丢了就 `rotate-host`。别把这一行贴进聊天记录或工单。
- 两条命令同时改 `hosts.json` 可能丢掉其中一条的改动（没有加锁，一个人手动跑碰不到）。
- `hosts.json` 被手改坏时 relay 保留之前的表并记一条 `hosts_invalid`，命令拒绝覆盖它。

## 升级与回滚

```sh
# Mac：按"部署"第 1 步构建并传上新版本，例如 2026.11.02
# VPS：
cd /srv/atrium-relay && sudo ATRIUM_RELAY_VERSION=2026.11.02 docker compose up -d
```

`docker compose up -d` 换镜像时先给旧容器 SIGTERM：relay 以 1001 关掉所有连接、写完日志再退出，宿主和手机会自己重连（这几秒手机显示"正在重连"）。旧镜像留在 VPS 上，回滚就是用旧版本号再 `up -d` 一次；数据目录不随版本变。确认新版本用了一阵后再 `docker image rm atrium-relay:<旧版本>`。

## 查日志

```sh
sudo tail -f /srv/atrium-relay/data/logs/relay-$(date -u +%F).jsonl
sudo docker logs atrium-relay       # 只有启动那一行和出错时的提示
```

每行一条 JSON：`time`、`level`、`event`，以及按事件带的 `hostId`、`streamId`、`ipHash`（加盐哈希，盐每次启动随机）、`code`（关闭码）、`up` / `down`（字节）、`durationMs`。事件：`listening`、`hosts_loaded`、`hosts_invalid`、`host_online`、`host_offline`（`reason`：`closed`、`replaced`、`unresponsive`、`revoked`）、`auth_failed`、`connection_rejected`、`phone_rejected`、`stream_opened`、`stream_joined`、`stream_closed`、每分钟一条 `resource_usage`（资源计数和内存）、`stopped`。不记载荷、`hello`、令牌、查询串和原始 IP。

关闭码的意思见 SPEC-0005"relay 的线路协议 · 关闭码"：常见的是 4401（令牌不对或被换掉）、4404（宿主不在线）、4408（超时）、4409（宿主的新连接挤掉了旧的）、4429（超了数量或速率）、4507（积压太多）。

## 已知限制

- **拿不到手机的真实 IP**：经 xray 回落后 nginx 看到的来源都是 `127.0.0.1`，relay 在容器里看到的是 Docker 网关。所有手机算同一个地址，"每个 IP 每分钟 30 条新流"实际上是全局每分钟 30 条（一个人用够了；嫌碍事可设 `newStreamsPerIpPerMinute: 0`），日志里的 `ipHash` 也都一样。`trustedProxies` 留空即可，填了也拿不到更多。要区分来源得让 xray 回落时带 PROXY protocol、nginx 从中取地址，第一版不做。其余上限（未认证连接 64、每宿主 16 条流、缓冲）照常生效。
- **单点**：VPS 或 relay 挂了手机就连不上；`/atrium/healthz` 可以接进你自己的监控。
- **上次在线时间只在内存里**：relay 重启后，宿主重连之前，手机看到的是 `offline:0`。
- **HTTP/1.1**：WebSocket 走 HTTP/1.1 升级。xray 回落按 ALPN 分流时，要保证 `http/1.1` 回落到 nginx 的 8080（手机和宿主的 WebSocket 客户端都用 HTTP/1.1）。

## 开发

```sh
pnpm --filter @atrium/relay build                 # dist/relay.cjs
node apps/relay/dist/relay.cjs serve --dir <目录> --listen 127.0.0.1:8787
pnpm exec vitest run --project unit apps/relay    # 单元和真实 ws 的集成测试
pnpm exec vitest run --project leak apps/relay    # 泄漏测试
pnpm test:mutation relay                          # 变异测试
```

`--dir` 默认 `$ATRIUM_RELAY_DIR` 或当前目录，`--listen` 默认 `$ATRIUM_RELAY_LISTEN` 或 `127.0.0.1:8787`。MP0 的假宿主、假手机可以直接对它跑：`node spikes/mobile-mp0/ts/fake-host.ts --relay '<add-host 打印的一行>' --pair`（行里带端口时用 `ws://`，不带时 `wss://`）。
