#!/bin/bash
# Run the SpaceService unit tests inside node:26.
# test/app.test.mjs mocks node:child_process (openssl); test/sign_openssl.test.mjs
# uses the real openssl binary from the image. No certs, CA key or unix socket
# are required.
set -euo pipefail

cd "$(dirname "$0")"

docker run --rm \
    -v "$(pwd)":/app \
    -w /app \
    node:26 \
    /bin/bash -c 'if [ ! -d node_modules/express ]; then npm install --no-audit --no-fund; fi; npm test'
