# OTMC Dashboard

OTMC 的独立 dashboard 栈。它通过 HTTPS/HTTP3 提供静态的安装/监控 UI，并通过 Unix socket 暴露一个小型本地签名 API。它不属于根 broker 栈，也不共享其 socket：broker 使用 `/dev/shm/otmc`，而 dashboard 使用 `/dev/shm/otmc-dashboard`。

## 目录结构

```text
dashboard/
├── docker-compose.yml        # 仅 nginx
├── nginx/
│   ├── nginx.conf
│   └── conf.d/default.conf   # :10443 TLS/QUIC + /api/v1/space 代理
├── www/                      # 部署的 UI，直接提供服务，无构建步骤
│   ├── index.html            # MQTT-over-WebSocket 监控 dashboard
│   └── setup/
│       ├── index.html        # 角色选择
│       ├── browser/{leader,follower}/index.html
│       └── edge/{leader,follower}/index.html
└── SpaceService/
    ├── server.mjs            # 运行在 space.api.sock 上的 Express 签名 API
    ├── package.json
    └── run.x.bash            # 带所需挂载的 node:26 辅助脚本
```

`www/` 是部署 UI 的唯一真实来源。页面是手写的独立 HTML，使用 CDN 上的 Vue 和 Ant Design Vue；没有 Vite 构建，也不会生成任何内容到 `www/`。

## 快速开始

### 1. 启动 nginx

```bash
docker compose -f dashboard/docker-compose.yml up -d
docker compose -f dashboard/docker-compose.yml config -q
```

nginx 监听 `:10443`（TLS、HTTP/2、HTTP/3/QUIC）并提供 `www/`。它还将 `/api/v1/space/*` 代理到 SpaceService socket，并剥离 `/api/v1/space` 前缀。容器使用 `network_mode: host`，因此 `10443` 就是字面上的主机端口。

TLS 证书从 `/watorvapor/ecdsa-cert/certbot/etc` 挂载到 `/etc/cert`；compose 文件期望 `/etc/cert/live/wator.xyz/{fullchain,privkey}.pem`。

Compose **仅**启动 nginx。它不会启动 SpaceService。

### 2. 启动 SpaceService

`server.mjs` 对证书和 socket 使用绝对路径，其签名调用需要 `client_cert` 目录可写（它可以创建 CA serial）。使用辅助脚本，它会在 `node:26` 上挂载证书目录和 `/dev/shm/otmc-dashboard`：

```bash
cd dashboard/SpaceService
./run.x.bash            # 交互式 shell
npm install             # 首次运行；使用 npm install，而不是 npm ci
npm run dev             # 删除旧 socket，然后运行 server.mjs
```

服务在辅助容器内监听 `/var/run/otmc/space.api.sock`，即主机上的 `/dev/shm/otmc-dashboard/space.api.sock`。

## HTTP 接口

| 路径 | 用途 |
| --- | --- |
| `/` | MQTT-over-WebSocket 监控 dashboard |
| `/setup/` | 角色选择 |
| `/setup/browser/leader/`、`/setup/browser/follower/` | 浏览器 leader/follower 安装 |
| `/setup/edge/leader/`、`/setup/edge/follower/` | 边缘 leader/follower 安装 |
| `POST /api/v1/space/sign/client/space-1st-level` | 签署 Space 一级 CSR |

nginx 将公共路由映射到服务的真实路由 `/sign/client/space-1st-level`。仅存在 `space-1st-level` 配置文件；CSR CN 必须匹配 `^OTMC-Client_Intermediate_4_Space_1st_level_Cert$`。签名使用 `client_cert/client-broker-inter.{crt,key}` 和 `client-space-top.{ext,srl}`。

`authenticateBearer` 当前是空操作，`SIGN_TOKEN` 未使用，因此 HTTP API 没有真正的认证。不要将其暴露到本地 nginx 之外。

## 静态 UI

- `www/index.html` 默认连接到 `wss://mqtt-browser.wator.xyz:8084/mqtt`。
- 连接前，它从 IndexedDB 读取三个证书和一个不可导出的叶子密钥，然后向 WebSocket 子协议列表添加一个 base64url token：

  ```text
  Sec-WebSocket-Protocol: mqtt, auth.<base64url token>
  ```

  token 包含 DER 链（叶子、二级 CA、一级 CA）、时间戳、客户端 ID 以及 ECDSA P-384/SHA-384 签名。每次连接都会重新签署 `<clientId>|<timestamp>`。从 IndexedDB 读取时优先使用 leader 存储，回退到 follower 存储。

- `www/setup/browser/leader/` 将 CSR POST 到 `POST /api/v1/space/sign/client/space-1st-level`。其他安装页面在本地生成密钥和 CSR；follower 页面可以将叶子证书和链导入 IndexedDB。

IndexedDB 数据库：`omtc-mtls-keystore`（注意拼写）。存储：`browser_leader_cert_and_keys`、`browser_follower_cert_and_keys`。键：`client-space-top`、`client-space-inter`、`client-space-leaf`。

**此仓库中不存在实现 `auth.<token>` 子协议的 WebSocket 网关。** 默认 MQTT 端点是外部/测试基础设施；`ProxyWSS/` 是一个无关的、更简单的原型，不解析此 token。

## 配置与密钥

`SpaceService/server.mjs` 硬编码：

```text
/usr/local/etc/certs/client_cert   # CA key/cert/serial/ext
/var/run/otmc                      # 临时 CSR/工作目录和 space.api.sock
```

在主机上，证书来自 `/opt/otmc-deploy/otmc.secret/broker/client_cert`；辅助脚本会挂载它们。服务在 `/var/run/otmc` 下为每个 CSR 创建一个以 CSR 的 SHA-256 命名的工作目录，并在之后删除临时 CSR/证书。

除了未使用的 `SIGN_TOKEN` 外，没有环境变量覆盖。要为其他环境使用，请编辑 compose 文件和 `server.mjs`。

## 已知陷阱

- Compose 栈不会启动 SpaceService；没有辅助脚本时，API 路由返回 502/bad gateway，因为 `space.api.sock` 不存在。
- `npm run dev` 在启动前删除 socket。如果进程死亡，socket 可能保持陈旧状态直到下次启动。
- 辅助脚本打开交互式 shell 并挂载 `$(pwd)`；请从 `dashboard/SpaceService` 运行它。
- nginx 容器需要主机上存在 `/watorvapor/ecdsa-cert/certbot/etc`，否则 TLS 加载失败。
- `SpaceService` 使用 `-CAcreateserial`；`client_cert` 挂载必须可写，否则签名失败。
- `dashboard/www` 已提交并直接提供服务。不要期望其他地方有构建步骤来拾取更改。