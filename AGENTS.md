# AGENTS.md

OTMC MQTT broker deployment: several independently started services plus a separate dashboard stack. Root `docker-compose.yml` is what actually runs; root `README.md` describes a planned Envoy/QUIC + C++26 design that compose does **not** start. Trust compose files and `run.x.bash` helpers over README prose.

Repo layout: `Nodejs_Broker/` is the real broker; `HAProxy_Gate/` + `Nginx_Inner/` are the ingress; `dashboard/` is a separate stack; `CXX_Broker/` and `ProxyWSS/` are prototypes; `ValKey-Cluster/` is the production store.

## Active data path

Client mTLS `:8883` -> `HAProxy_Gate` -> `Nginx_Inner` TLS `:18883` -> `Nodejs_Broker` on UDS `/var/run/otmc/mqtt.sock` (host `/dev/shm/otmc/mqtt.sock`). Core compose services use `network_mode: host`, so these are literal host ports, not published container ports.

- `Nodejs_Broker/` is the real MQTT 5 server. It uses `mqtt-packet` directly, not a broker library: `client_session.mjs` handles CONNECT/AUTH/PUBLISH/SUBSCRIBE/PINGREQ/DISCONNECT. No retained messages, persistence, wills, offline sessions, or UNSUBSCRIBE handling; forwarded publishes go out at QoS 0.
- Auth is MQTT 5 enhanced auth, not just TLS: CONNECT -> AUTH `0x18` with method `certchain` -> client returns `{cert, challenges:[{data:{challenge,timeStamp},signature,algorithm,keyAddress}]}`. Signatures must echo that client's challenge and be timestamped within 1 minute; `keyAddress` is Base58 of SHA-256 over a signer cert's SPKI DER. `test/client_mtls/index.js` is the reference client.
- `HAProxy_Gate/` terminates client certificates; `lua/mqtt_route.lua` picks the `mqtt_backend_<nodeId>` with the smallest XOR distance between the last cert in the presented chain (leaf first, then chain order, so the root-most cert sent) and the backend ID. `base58_prefix_to_int64` compares only the first 8 decoded bytes.
- `Nodejs_Broker/redis_config.mjs` derives `nodeId` as Base58 of SHA-256 over the SPKI PEM of `internal_cert/internal-server.crt`. That same ID is the HAProxy backend suffix and the DHT key.
- `Nodejs_Broker/config.mjs` advertises `config.mqtt` (`host`/`port`) into Valkey; `HAProxy_Gate/dynamic-backend/` reads `otmc:broker:store:endpoints` plus `otmc:broker:store:endpoint:<nodeId>` (pub/sub `otmc:broker:endpoint:update`), writes `HAProxy_Gate/backends/mqtt_backend_<nodeId>.cfg`, then reloads HAProxy.
- `dashboard/` is a separate compose stack. `SpaceService/` is an OpenSSL signing API on `/var/run/otmc/space.api.sock` (host `/dev/shm/otmc-dashboard`, not the broker's `/dev/shm/otmc`); `WebPageService/` is a Vue/Vite app. Its nginx serves `dashboard/www` on `:10443` and proxies `/api/v1/space/*` to `space.api.sock`.
- `CXX_Broker/` and `ProxyWSS/` are prototypes, not in any compose file. `ProxyWSS/index.mjs` uses CommonJS `require` in `.mjs` and has no manifest; do not wire it in without fixing it.

## Commands

There is no lint, typecheck, CI, or automated test suite. Every `npm test` script deliberately exits 1; do not treat that as a broken suite. Each service is its own package with an ignored `package-lock.json`; there is no root manifest or workspace. Use `npm install`, not `npm ci`.

Both compose files parse:

```bash
docker compose config -q
docker compose -f dashboard/docker-compose.yml config -q
```

Core stack:

```bash
docker compose up -d --build haproxy nginx-inner
```

Do not run bare `docker compose up -d`; it also starts the broken `mqtt-broker-nodejs` and `valkey` services.

**Caveat:** `haproxy` `depends_on` `mqtt-broker-nodejs`, whose committed service mounts only `Nodejs_Broker`, `valkey-cluster`, and `/dev/shm/otmc`. `config.mjs` reads `client_cert/*` at import and `redis_config.mjs` reads `internal_cert/internal-server.crt` when `new RedisConfig()` runs, so that container exits immediately. Even via the helper, `index.mjs` awaits the production three-node Valkey cluster before it starts listening, so the broker will not start without reachable Valkey nodes. Ignore the compose service and run the broker from its helper, which mounts all four cert dirs:

```bash
cd Nodejs_Broker && ./run.x.bash   # interactive node:26 shell
npm install                        # first run
node index.mjs
```

A clean checkout has only `HAProxy_Gate/backends/empty.cfg`, so HAProxy has no DHT target and MQTT connects fail until `dynamic-backend` writes a `mqtt_backend_*` file. Start `haproxy-syncbackend` (see the reload caveat below) or run `HAProxy_Gate/dynamic-backend/run.x.bash` and then `node index.mjs` inside it.

Dashboard stack (nginx serves `dashboard/www` on `:10443`; it starts neither `SpaceService` nor `WebPageService`):

```bash
docker compose -f dashboard/docker-compose.yml up -d
```

Then start `SpaceService` from inside its helper, because `server.mjs` reads absolute cert/socket paths and its `openssl x509 -CAcreateserial` call writes the CA serial into the mounted `client_cert` directory (the helper mounts it read-write):

```bash
cd dashboard/SpaceService && ./run.x.bash   # interactive shell
npm install && npm run dev                  # inside the shell
```

Node is often unavailable on the host. Use the `run.x.bash` helpers, which run `node:26` with the required cert/socket mounts. Run each helper from its own directory — they mount `$(pwd)` and relative paths such as `../backends`, and they open an interactive shell. `test/client_mtls/tc-lua_client_certs.bash` uses `node:24` and mounts the host cert dirs over its gitignored `client_cert/` and `server_cert/`.

Manual checks:
- `Nodejs_Broker/test/index.mjs` is only a UDS smoke test: it connects to `mqtt+unix:///var/run/otmc/mqtt.sock` without the `certchain` AUTH exchange, so it never reaches a successful CONNACK.
- `test/client_mtls/index.js` is the end-to-end reference client. It hardcodes `mqtt-broker-local10001.wator.xyz:8883` and reads `./client_cert/{client.space.chain.crt,client-space-leaf.key}` plus `./server_cert/server-root.crt`.
- `HAProxy_Gate/README.md` has `openssl s_client` and `socat` admin-socket commands; `Nginx_Inner/README.md` has internal TLS checks on `:18883`.

## Configuration and secrets

- Services read certs from absolute `/usr/local/etc/certs/{client_cert,server_cert,internal_cert,valkey-cluster}`. On the host these come from `/opt/otmc-deploy/otmc.secret/broker/...`; dashboard nginx additionally needs `/watorvapor/ecdsa-cert/certbot/etc` for `wator.xyz`. They cannot start correctly outside the compose/helper mounts.
- `Nodejs_Broker/config.mjs` hardcodes the public IPv6 address, Valkey DNS names, and TLS options (including `rejectUnauthorized: false`); `HAProxy_Gate/dynamic-backend/config.mjs` hardcodes the same Valkey hosts/TLS plus HAProxy's socket and backends path. There are no env-var overrides; edit those files for another environment. The `config.mqtt` address is also what other nodes dial on `:18883`, so it must be reachable.
- ACLs come from `pubKeyHash.slice(-3)` over the root-first chain, i.e. only the deepest three certs contribute. Topics are cumulative (`<h1>/#`, `<h1>/<h2>/#`, `<h1>/<h2>/<h3>/#`). Chain keys that signed the challenge get `all`; the rest get `read`. `write` is never assigned, so signing is required to publish.
- `SpaceService` has only the `space-1st-level` profile; the CSR CN must match `^OTMC-Client_Intermediate_4_Space_1st_level_Cert$`. It signs with `client_cert/client-broker-inter.{crt,key}` using `client-space-top.{ext,srl}`. Its real route is `/sign/client/space-1st-level`; dashboard nginx strips `/api/v1/space` before proxying. `authenticateBearer` is currently a no-op and `SIGN_TOKEN` is unused, so the HTTP API has no real auth.

## Dashboard UI

- `dashboard/www` is committed and served directly by nginx; it is the deployed UI. The pages are hand-written standalone HTML (Vue + antdv loaded from CDN, no build step): `www/setup/{browser,edge}/{leader,follower}/index.html`, linked from `www/setup/index.html`. `browser/*` uses `antdv-next@1.7.0`, `edge/*` uses `ant-design-vue@4.2.6`; do not assume shared components or versions. In `www`, only `browser/leader` calls SpaceService (`POST /api/v1/space/sign/client/space-1st-level`); the other pages generate keys/CSRs locally, and `browser/follower` can import a leaf/chain into IndexedDB.
- `dashboard/WebPageService` is a separate Vite source tree. `npm run build` emits Vite's default `dist/` from `index.html` plus `setup/**/index.html`, never `www/`. Its inputs are `setup/{edge,leader,follower}/index.html` (there is no `browser` tree) and `setup/follower/index.html` imports `src/setup/fellower/` (misspelled), so it does not mirror the deployed `www` layout; edit `www` for deployed changes. Its `npm run dev` serves over a UDS (`/var/run/otmc/dashboard.sock` in the dashboard shm) with HMR pointed at `otmc-dashboard.wator.xyz:443`, so localhost:5173 does not behave like a normal dev server.

## Valkey cluster

Production uses the three host-specific deployments under `ValKey-Cluster/`, not the root compose `valkey` service. Create the cluster once with the `valkey-cli --cluster create` command in `ValKey-Cluster/REDAME.MD` (note the misspelling); each node's `cluster-announce-hostname` must match its directory/domain. Nodes serve TLS only on `6379` (`port 0`). All three compose files use `container_name: valkey-dts`, so they are meant for three different hosts — do not start more than one on the same machine.

The root `valkey` service is stale: its bind source `./valkey/valkey.conf` is a directory, so it cannot start as configured. Prefer `ValKey-Cluster/`.

## Known traps

- `haproxy-syncbackend` in the root compose has no Docker socket or CLI, yet `backend_in_haproxy.mjs` calls `docker kill -s HUP otmc-haproxy`. For dynamic reloads use `HAProxy_Gate/dynamic-backend/run.x.bash` (mounts `/var/run/docker.sock` and `/usr/bin/docker`; opens a shell, then run `node index.mjs`), or reload manually.
- Backends added through the HAProxy runtime API (`socat ... add backend/server`) are lost on the next reload. The files in `HAProxy_Gate/backends/` are the real source of truth.
- `dynamic-backend` only adds backends; `BackendOfHaproxy.deleteBackend()` exists but is never called. A decommissioned node keeps its `mqtt_backend_*.cfg` and stays a routing candidate until you remove the file and reload.
- `mqtt_route.lua`'s `REDIS_HOST`/`REDIS_PORT` constants (`127.0.0.1:16379`) are unused/stale; routing only sees backends currently in `core.backends`, i.e. generated cfg files after a reload.
- Generated backend files are ignored by `HAProxy_Gate/backends/.gitignore`; never commit them. Keep only `empty.cfg` (the compose command points HAProxy at the whole `backends/` directory).
- Broker process landmines: `ClientSession.delete()` dereferences `internal.acl`, which only exists after a successful AUTH, so a client that disconnects or fails AUTH can throw from the socket close handler and take the process down. QoS 2 is incomplete (PUBREC is sent, PUBREL/PUBCOMP are never handled), and a client with overlapping subscriptions can receive duplicate forwardings.
- `ClientAcl`, `ClientTopic`, and `ClientCollector` store state in module-level Maps, so separate instances share it; don't rely on per-session isolation.
- Root `build/` is an ignored CMake FetchContent tree (async_mqtt sources plus `mqtt_uds_broker`); don't edit or commit it as repo source.
- `CXX_Broker` builds with Clang and C++26 modules: `cmake -S CXX_Broker -B build && cmake --build build -j`. `CMakeLists.txt` requires CMake `4.2.0` (use the `ubuntu:26.04` build image), needs Boost, and fetches `async_mqtt` 10.3.0 from GitHub. The binary listens on hardcoded `/dev/shm/mqtt/async_mqtt_broker.sock`; `main()` takes no arguments, so the `--socket` flag in `entrypoint.bash` is ignored.
