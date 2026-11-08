# OTMC Dashboard

Separate dashboard stack for OTMC. It serves the static setup/monitoring UI over
HTTPS/HTTP3 and exposes a small local signing API over a Unix socket. It is not
part of the root broker stack and does not share its sockets: the broker uses
`/dev/shm/otmc`, while the dashboard uses `/dev/shm/otmc-dashboard`.

## Layout

```text
dashboard/
├── docker-compose.yml        # nginx only
├── nginx/
│   ├── nginx.conf
│   └── conf.d/default.conf   # :10443 TLS/QUIC + /api/v1/space proxy
├── www/                      # deployed UI, served directly, no build step
│   ├── index.html            # MQTT-over-WebSocket monitoring dashboard
│   └── setup/
│       ├── index.html        # role selection
│       ├── browser/{leader,follower}/index.html
│       └── edge/{leader,follower}/index.html
└── SpaceService/
    ├── server.mjs            # Express signing API on space.api.sock
    ├── package.json
    └── run.x.bash            # node:26 helper with required mounts
```

`www/` is the source of truth for the deployed UI. Pages are hand-written
standalone HTML using Vue and Ant Design Vue from a CDN; there is no Vite build
and nothing is generated into `www/`.

## Quick start

### 1. Start nginx

```bash
docker compose -f dashboard/docker-compose.yml up -d
docker compose -f dashboard/docker-compose.yml config -q
```

nginx listens on `:10443` (TLS, HTTP/2, HTTP/3/QUIC) and serves `www/`. It also
proxies `/api/v1/space/*` to the SpaceService socket, stripping the
`/api/v1/space` prefix. The container uses `network_mode: host`, so `10443` is a
literal host port.

The TLS certificate is mounted from `/watorvapor/ecdsa-cert/certbot/etc` at
`/etc/cert`; the compose file expects `/etc/cert/live/wator.xyz/{fullchain,privkey}.pem`.

Compose starts **only** nginx. It does not start SpaceService.

### 2. Start SpaceService

`server.mjs` uses absolute paths for certificates and the socket, and its
signing call needs the `client_cert` directory writable (it can create the CA
serial). Use the helper, which mounts the cert directory and
`/dev/shm/otmc-dashboard` on `node:26`:

```bash
cd dashboard/SpaceService
./run.x.bash            # interactive shell
npm install             # first run; use npm install, not npm ci
npm run dev             # removes the old socket, then runs server.mjs
```

The service listens on `/var/run/otmc/space.api.sock` inside the helper, which
is host `/dev/shm/otmc-dashboard/space.api.sock`.

## HTTP surface

| Path | Purpose |
| --- | --- |
| `/` | MQTT-over-WebSocket monitoring dashboard |
| `/setup/` | Role selection |
| `/setup/browser/leader/`, `/setup/browser/follower/` | Browser leader/follower setup |
| `/setup/edge/leader/`, `/setup/edge/follower/` | Edge leader/follower setup |
| `POST /api/v1/space/sign/client/space-1st-level` | Sign a Space 1st-level CSR |

nginx maps the public route to the service's real route
`/sign/client/space-1st-level`. Only the `space-1st-level` profile exists; the
CSR CN must match `^OTMC-Client_Intermediate_4_Space_1st_level_Cert$`. Signing
uses `client_cert/client-broker-inter.{crt,key}` with
`client-space-top.{ext,srl}`.

`authenticateBearer` is currently a no-op and `SIGN_TOKEN` is unused, so the
HTTP API has no real authentication. Do not expose it beyond the local nginx.

## Static UI

- `www/index.html` connects by default to
  `wss://mqtt-browser.wator.xyz:8084/mqtt`.
- Before connecting it reads three certificates and a non-exportable leaf key
  from IndexedDB, then adds a base64url token to the WebSocket subprotocol list:

  ```text
  Sec-WebSocket-Protocol: mqtt, auth.<base64url token>
  ```

  The token contains the DER chain (leaf, 2nd-level CA, 1st-level CA), a
  timestamp, the client ID, and an ECDSA P-384/SHA-384 signature. Each connect
  re-signs `<clientId>|<timestamp>`. Reading from IndexedDB prefers the leader
  store and falls back to the follower store.

- `www/setup/browser/leader/` posts CSRs to
  `POST /api/v1/space/sign/client/space-1st-level`. The other setup pages
  generate keys and CSRs locally; follower pages can import a leaf and chain
  into IndexedDB.

IndexedDB database: `omtc-mtls-keystore` (note the spelling). Stores:
`browser_leader_cert_and_keys`, `browser_follower_cert_and_keys`. Keys:
`client-space-top`, `client-space-inter`, `client-space-leaf`.

**No WebSocket gateway implementing the `auth.<token>` subprotocol is present in
this repository.** The default MQTT endpoint is external/test infrastructure;
`ProxyWSS/` is an unrelated, simpler prototype that does not parse this token.

## Configuration and secrets

`SpaceService/server.mjs` hardcodes:

```text
/usr/local/etc/certs/client_cert   # CA key/cert/serial/ext
/var/run/otmc                      # temp CSR/work dir and space.api.sock
```

On the host the certs come from
`/opt/otmc-deploy/otmc.secret/broker/client_cert`; the helper mounts them. The
service creates a per-CSR work directory under `/var/run/otmc` named by the
SHA-256 of the CSR and removes the temporary CSR/cert afterward.

There are no environment-variable overrides apart from the unused
`SIGN_TOKEN`. Edit the compose files and `server.mjs` for another environment.

## Known traps

- The compose stack does not start SpaceService; without the helper, the API
  route returns 502/bad gateway because `space.api.sock` does not exist.
- `npm run dev` deletes the socket before starting. If the process dies, the
  socket may remain stale until the next start.
- The helper opens an interactive shell and mounts `$(pwd)`; run it from
  `dashboard/SpaceService`.
- The nginx container needs `/watorvapor/ecdsa-cert/certbot/etc` to exist on the
  host, otherwise TLS fails to load.
- `SpaceService` uses `-CAcreateserial`; the `client_cert` mount must be
  writable or signing fails.
- `dashboard/www` is committed and served directly. Do not expect a build step
  to pick up changes elsewhere.
