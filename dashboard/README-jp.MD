# OTMC Dashboard

OTMC 用の独立したダッシュボードスタック。HTTPS/HTTP3 経由で静的なセットアップ/監視 UI を提供し、Unix ソケット経由で小さなローカル署名 API を公開する。ルートブローカースタックの一部ではなく、そのソケットも共有しない。ブローカーは `/dev/shm/otmc` を使用し、ダッシュボードは `/dev/shm/otmc-dashboard` を使用する。

## レイアウト

```text
dashboard/
├── docker-compose.yml        # nginx のみ
├── nginx/
│   ├── nginx.conf
│   └── conf.d/default.conf   # :10443 TLS/QUIC + /api/v1/space プロキシ
├── www/                      # デプロイ済み UI。直接配信され、ビルドステップなし
│   ├── index.html            # MQTT-over-WebSocket 監視ダッシュボード
│   └── setup/
│       ├── index.html        # ロール選択
│       ├── browser/{leader,follower}/index.html
│       └── edge/{leader,follower}/index.html
└── SpaceService/
    ├── server.mjs            # space.api.sock 上の Express 署名 API
    ├── package.json
    └── run.x.bash            # 必要なマウントを行う node:26 ヘルパー
```

`www/` はデプロイ済み UI の信頼できる唯一の情報源である。ページは CDN の Vue と Ant Design Vue を使用した手書きのスタンドアロン HTML であり、Vite ビルドはなく、`www/` に生成されるものもない。

## クイックスタート

### 1. nginx を起動

```bash
docker compose -f dashboard/docker-compose.yml up -d
docker compose -f dashboard/docker-compose.yml config -q
```

nginx は `:10443`（TLS、HTTP/2、HTTP/3/QUIC）でリッスンし、`www/` を配信する。また `/api/v1/space/*` を SpaceService ソケットへプロキシし、`/api/v1/space` プレフィックスを除去する。コンテナは `network_mode: host` を使用するため、`10443` は文字通りのホストポートである。

TLS 証明書は `/watorvapor/ecdsa-cert/certbot/etc` から `/etc/cert` にマウントされる。compose ファイルは `/etc/cert/live/wator.xyz/{fullchain,privkey}.pem` を想定している。

Compose は **nginx のみ** を起動する。SpaceService は起動しない。

### 2. SpaceService を起動

`server.mjs` は証明書とソケットに絶対パスを使用し、その署名呼び出しには `client_cert` ディレクトリが書き込み可能である必要がある（CA serial を作成できる）。`node:26` 上で証明書ディレクトリと `/dev/shm/otmc-dashboard` をマウントするヘルパーを使用する：

```bash
cd dashboard/SpaceService
./run.x.bash            # 対話型シェル
npm install             # 初回実行。npm ci ではなく npm install を使用
npm run dev             # 古いソケットを削除してから server.mjs を実行
```

サービスはヘルパー内で `/var/run/otmc/space.api.sock` をリッスンする。これはホスト上の `/dev/shm/otmc-dashboard/space.api.sock` に相当する。

## HTTP サーフェス

| パス | 用途 |
| --- | --- |
| `/` | MQTT-over-WebSocket 監視ダッシュボード |
| `/setup/` | ロール選択 |
| `/setup/browser/leader/`、`/setup/browser/follower/` | ブラウザ leader/follower セットアップ |
| `/setup/edge/leader/`、`/setup/edge/follower/` | エッジ leader/follower セットアップ |
| `POST /api/v1/space/sign/client/space-1st-level` | Space 1次レベル CSR に署名 |

nginx は公開ルートをサービスの実際のルート `/sign/client/space-1st-level` にマッピングする。存在するプロファイルは `space-1st-level` のみであり、CSR の CN は `^OTMC-Client_Intermediate_4_Space_1st_level_Cert$` に一致する必要がある。署名には `client_cert/client-broker-inter.{crt,key}` と `client-space-top.{ext,srl}` を使用する。

`authenticateBearer` は現在 no-op であり、`SIGN_TOKEN` は未使用のため、HTTP API には実認証がない。ローカル nginx 以外に公開しないこと。

## 静的 UI

- `www/index.html` はデフォルトで `wss://mqtt-browser.wator.xyz:8084/mqtt` に接続する。
- 接続前に IndexedDB から 3 つの証明書とエクスポート不可のリーフ鍵を読み取り、WebSocket サブプロトコルリストに base64url トークンを追加する：

  ```text
  Sec-WebSocket-Protocol: mqtt, auth.<base64url token>
  ```

  トークンには DER チェーン（リーフ、2次レベル CA、1次レベル CA）、タイムスタンプ、クライアント ID、ECDSA P-384/SHA-384 署名が含まれる。接続ごとに `<clientId>|<timestamp>` を再署名する。IndexedDB からの読み取りは leader ストアを優先し、follower ストアにフォールバックする。

- `www/setup/browser/leader/` は CSR を `POST /api/v1/space/sign/client/space-1st-level` に POST する。他のセットアップページはローカルで鍵と CSR を生成する。follower ページはリーフとチェーンを IndexedDB にインポートできる。

IndexedDB データベース：`omtc-mtls-keystore`（綴りに注意）。ストア：`browser_leader_cert_and_keys`、`browser_follower_cert_and_keys`。キー：`client-space-top`、`client-space-inter`、`client-space-leaf`。

**このリポジトリには、`auth.<token>` サブプロトコルを実装する WebSocket ゲートウェイは存在しない。** デフォルトの MQTT エンドポイントは外部/テスト用インフラストラクチャである。`ProxyWSS/` は無関係なより単純なプロトタイプであり、このトークンを解析しない。

## 設定とシークレット

`SpaceService/server.mjs` は次をハードコードしている：

```text
/usr/local/etc/certs/client_cert   # CA key/cert/serial/ext
/var/run/otmc                      # 一時 CSR/作業ディレクトリと space.api.sock
```

ホスト上では証明書は `/opt/otmc-deploy/otmc.secret/broker/client_cert` から取得され、ヘルパーがそれらをマウントする。サービスは `/var/run/otmc` 配下に CSR の SHA-256 で命名された CSR ごとの作業ディレクトリを作成し、その後一時 CSR/証明書を削除する。

未使用の `SIGN_TOKEN` 以外に環境変数による上書きはない。別環境向けには compose ファイルと `server.mjs` を編集すること。

## 既知の落とし穴

- compose スタックは SpaceService を起動しない。ヘルパーなしでは `space.api.sock` が存在しないため、API ルートは 502/bad gateway を返す。
- `npm run dev` は起動前にソケットを削除する。プロセスが死亡すると、次回起動までソケットが古いまま残る可能性がある。
- ヘルパーは対話型シェルを開き、`$(pwd)` をマウントする。`dashboard/SpaceService` から実行すること。
- nginx コンテナはホスト上に `/watorvapor/ecdsa-cert/certbot/etc` が存在する必要があり、そうでなければ TLS の読み込みに失敗する。
- `SpaceService` は `-CAcreateserial` を使用する。`client_cert` マウントは書き込み可能でなければならず、そうでなければ署名に失敗する。
- `dashboard/www` はコミット済みで直接配信される。他の場所の変更をビルドステップが拾うことを期待しないこと。