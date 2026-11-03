# AGENTS.md

OTMC MQTT broker deployment: several independently started services plus a Vue dashboard. The root `docker-compose.yml` is the authoritative runtime; `README.md` describes a planned Envoy/QUIC + C++26 design that is **not** what compose starts.

## Active data path

Client mTLS `:8883` -> `HAProxy_Gate` -> `Nginx_Inner` TLS `:18883` -> `Nodejs_Broker` on UDS `/var/run/otmc/mqtt.sock` (host `/dev/shm/otmc/mqtt.sock`). All core compose services use `network_mode: host`, so these are literal host ports, not published container ports.

- `Nodejs_Broker/` is the real MQTT 5 server. It uses `mqtt-packet` directly, not a broker library: `client_session.mjs` handles CONNECT/AUTH/PUBLISH/SUBSCRIBE/PINGREQ/DISCONNECT. No retained messages, persistence, wills, or offline sessions; forwarded publishes go out at QoS 0.
- `HAProxy_Gate/` terminates client certificates; `lua/mqtt_route.lua` picks the `mqtt_backend_<nodeId>` with the smallest XOR distance between the last presented cert's public-key hash (leaf first, then chain order) and the backend ID.
- `HAProxy_Gate/dynamic-backend/` reads broker endpoints from Valkey and writes `HAProxy_Gate/backends/mqtt_backend_<nodeId>.cfg`, then reloads HAProxy.
- `dashboard/` is a separate compose stack. `SpaceService/` is an OpenSSL signing API on `/var/run/otmc/space.api.sock`; `WebPageService/` is the Vue/Vite UI. Its nginx serves `dashboard/www` on `:10443` and proxies `/api/v1/space` to `space.api.sock`. This stack uses `/dev/shm/otmc-dashboard`, not the broker's `/dev/shm/otmc`.
- `CXX_Broker/` and `ProxyWSS/` are prototypes, not in any compose file. `ProxyWSS/index.mjs` uses CommonJS `require` in `.mjs` and has no manifest — do not wire it in without fixing it.

## Commands

From the repo root, start the core services explicitly to skip the stale root `valkey` service:

```bash
docker compose up -d --build mqtt-broker-nodejs nginx-inner haproxy
docker compose config -q          # cheap syntax check
```

Backend sync (`haproxy-syncbackend`) is a separate concern; see the reload caveat below. A clean checkout has only `HAProxy_Gate/backends/empty.cfg`, so HAProxy has no DHT target and MQTT routing fails until `dynamic-backend` writes a `mqtt_backend_*` file.

Dashboard stack (nginx serves `dashboard/www` on `:10443`; it does not start `SpaceService`):

```bash
docker compose -f dashboard/docker-compose.yml up -d
```

Then start `SpaceService` from inside its helper, because `server.mjs` reads absolute cert and socket paths:

```bash
cd dashboard/SpaceService && ./run.x.bash   # interactive shell
npm run dev                                 # inside the shell
```

There is no lint, typecheck, or automated test suite. Every `npm test` script deliberately exits 1; do not treat that as a broken suite. Manual clients: `Nodejs_Broker/test/index.mjs` (UDS) and `test/client_mtls/index.js` (edge mTLS). Other manual checks are in `HAProxy_Gate/README.md` (`openssl s_client`, `socat` admin socket) and `Nginx_Inner/README.md`.

Node is often unavailable on the host. Use the `run.x.bash` helpers or `node:26` images, which supply the required cert/socket mounts. Run each helper from its own directory — they mount `$(pwd)` and relative paths such as `../backends`, and they open an interactive shell. `test/client_mtls/tc-lua_client_certs.bash` uses `node:24` and is the exception.

## Configuration and secrets

- Services read certs from absolute `/usr/local/etc/certs/{client_cert,server_cert,internal_cert,valkey-cluster}`. On the host these come from `/opt/otmc-deploy/otmc.secret/broker/...`; dashboard nginx additionally needs `/watorvapor/ecdsa-cert/certbot/etc` for `wator.xyz`. They cannot start correctly outside the compose/run-script mounts.
- `Nodejs_Broker/config.mjs` and `HAProxy_Gate/dynamic-backend/config.mjs` hardcode the public IPv6 address, Valkey DNS names, and TLS options. There are no env-var overrides; edit those files for another environment.
- `Nodejs_Broker/redis_config.mjs` derives each broker's `nodeId` from the SHA-256 of the SPKI public key of `internal_cert/internal-server.crt`, encoded as Base58. That same ID is the HAProxy backend suffix and the DHT key.
- MQTT auth is MQTT 5 enhanced auth, not just the TLS layer: CONNECT -> AUTH `0x18` with method `certchain` -> client returns its certificate chain plus signed `{challenge, timeStamp}` entries. `test/client_mtls/index.js` is the reference client; it hardcodes `mqtt-broker-local10001.wator.xyz:8883` and expects certs in the gitignored `client_cert/` and `server_cert/` directories.
- ACLs: each certificate's public-key hash yields prefix rules `a/#`, `a/b/#`, `a/b/c/#`. Keys that signed the challenge get `all`; other chain keys get `read`.

## Valkey cluster

Production uses the three host-specific deployments under `ValKey-Cluster/`, not the root compose `valkey` service. Create the cluster once with the `valkey-cli --cluster create` command in `ValKey-Cluster/REDAME.MD`; each node's `cluster-announce-hostname` must match its directory/domain. Nodes serve TLS only on `6379` (`port 0`).

The root `valkey` service is stale: its bind source `./valkey/valkey.conf` is an empty directory, so it cannot start as configured. Prefer `ValKey-Cluster/`.

## Known traps

- `haproxy-syncbackend` in the root compose has no Docker socket or CLI, yet `backend_in_haproxy.mjs` calls `docker kill -s HUP otmc-haproxy`. For dynamic reloads use `HAProxy_Gate/dynamic-backend/run.x.bash` (mounts `/var/run/docker.sock` and `/usr/bin/docker`; opens a shell, then run `node index.mjs`), or reload manually.
- `mqtt_route.lua`'s `REDIS_HOST`/`REDIS_PORT` constants (`127.0.0.1:16379`) are unused/stale; routing only sees backends currently in `core.backends`, i.e. generated cfg files after a reload.
- Generated backend files are ignored by `HAProxy_Gate/backends/.gitignore`; never commit them. Keep only `empty.cfg` (the compose command points HAProxy at the whole `backends/` directory).
- `CXX_Broker` builds with Clang and C++26: `cmake -S CXX_Broker -B build && cmake --build build -j`. It fetches `async_mqtt` 10.3.0 from GitHub, and the binary listens on hardcoded `/dev/shm/mqtt/async_mqtt_broker.sock` (it ignores the `--socket` argument passed by `entrypoint.bash`).
- `dashboard/WebPageService` `npm run build` emits Vite's default `dist/`, but the dashboard nginx serves the checked-in `dashboard/www`; copy/sync the build or set `build.outDir` before deploying. Current vite inputs do not generate the tracked `www/setup/browser/*` pages.
- `SpaceService` only accepts CNs matching its hardcoded regex and signs with files in `/usr/local/etc/certs/client_cert`; changing profiles requires editing `server.mjs`. Its `authenticateBearer` middleware is currently a no-op, so the HTTP API has no real auth.
