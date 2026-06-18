#!/bin/bash
docker run -it \
    -v $(pwd):/app \
    -v /etc/group:/etc/group:ro \
    -v /etc/passwd:/etc/passwd:ro \
    -v "/opt/otmc-deploy/otmc.secret/broker/client_cert":/app/client_cert \
    -v "/opt/otmc-deploy/otmc.secret/broker/server_cert":/app/server_cert \
    --network host \
    -w /app \
    node:24 \
    /bin/bash
