#!/bin/bash
# Run the dynamic-backend unit tests inside node:26.
# The tests mock config.mjs / redis / fs / net / child_process, so no certs,
# Valkey cluster or HAProxy socket are required.
set -euo pipefail

cd "$(dirname "$0")"

docker run --rm \
    -v "$(pwd)":/app \
    -w /app \
    node:26 \
    npm test
