#!/bin/bash
docker run -it \
    -v $(pwd):/app \
    -v /etc/group:/etc/group:ro \
    -v /etc/passwd:/etc/passwd:ro \
    -v /dev/shm/otmc-websocket-gate:/var/run/otmc \
    -v ../../HAProxy_Gate/backends:/usr/local/etc/haproxy/backends \
    -v /opt/otmc-deploy/otmc.secret/broker/client_cert:/usr/local/etc/certs/client_cert \
    -v /opt/otmc-deploy/otmc.secret/broker/internal_cert:/usr/local/etc/certs/internal_cert \
    -v ${HOME}:${HOME} \
    --network host \
    -w /app \
    node:26 \
    /bin/bash -c 'umask 000; exec /bin/bash'
