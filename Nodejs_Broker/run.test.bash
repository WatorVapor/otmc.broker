#!/bin/bash
# Run the Nodejs_Broker unit tests inside node:26.
# The tests mock config.mjs / redis / fs / net / crypto, so no certificates,
# Valkey cluster, MQTT client or Unix socket are required.
set -euo pipefail

cd "$(dirname "$0")"

docker run --rm \
    -v "$(pwd)":/app \
    -w /app \
    node:26 \
    bash -lc 'if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi; npm test'
