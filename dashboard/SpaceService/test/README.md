# SpaceService tests

Run inside `node:26` (the host usually has no Node):

```bash
npm install   # first run
npm test      # or ./run.test.bash
```

| File | What it covers |
| --- | --- |
| `app.test.mjs` | Route/validation/error behaviour of `app.mjs` over a real HTTP server and real temp dirs. `node:child_process` is mocked, so `openssl` is never executed and no certs/CA key/serial file are needed. |
| `sign_openssl.test.mjs` | End-to-end signing with the real `openssl` binary against a throwaway CA generated in a temp dir. Skipped automatically when `openssl` is unavailable. |

The suite needs the `--experimental-test-module-mocks` flag (already set in
`package.json`) because `app.test.mjs` mocks `node:child_process`.
