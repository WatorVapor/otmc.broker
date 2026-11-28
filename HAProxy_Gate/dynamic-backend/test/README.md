# dynamic-backend unit tests

Run from `HAProxy_Gate/dynamic-backend`:

```bash
./run.test.bash          # node:26 container
# or, if Node 26 is installed locally:
npm test
```

The suite uses the built-in `node:test` runner plus `--experimental-test-module-mocks`.
Every test file registers its mocks **before** dynamically importing the module under
test, so the production modules stay untouched:

| module | mocked dependencies |
| --- | --- |
| `backend_in_haproxy.mjs` | `./config.mjs`, `node:fs`, `node:net`, `node:child_process` |
| `backend_redis.mjs` | `./config.mjs`, `redis` |
| `pubsub_redis.mjs` | `./config.mjs`, `redis` |
| `index.mjs` | `./backend_redis.mjs`, `./backend_in_haproxy.mjs`, `./pubsub_redis.mjs` |

Because `config.mjs` is mocked, the tests do not need the certificate mounts,
a reachable Valkey cluster, or the HAProxy admin socket.
