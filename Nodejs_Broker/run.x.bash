#!/bin/bash
docker run -it \
    -v $(pwd):/app \
    -v /etc/group:/etc/group:ro \
    -v /etc/passwd:/etc/passwd:ro \
    -v /dev/shm/otmc/:/var/run/otmc/ \
    -v /opt/otmc-deploy/otmc.secret/broker/server_cert:/usr/local/etc/certs/server_cert:ro \
    -v /opt/otmc-deploy/otmc.secret/broker/client_cert:/usr/local/etc/certs/client_cert:ro \
    -v /opt/otmc-deploy/otmc.secret/broker/internal_cert:/usr/local/etc/certs/internal_cert:ro \
    -v /opt/otmc-deploy/otmc.secret/broker/valkey-cluster:/usr/local/etc/certs/valkey-cluster:ro \
    -v ${HOME}:${HOME} \
    --network host \
    -w /app \
    node:26 \
    /bin/bash
