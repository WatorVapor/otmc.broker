#!/bin/bash
docker run -it \
    -v ../backends:/usr/local/etc/haproxy/backends \
    -v $(pwd):/app \
    -v /etc/group:/etc/group:ro \
    -v /etc/passwd:/etc/passwd:ro \
    -v /dev/shm/mqtt/:/var/run/otmc/ \
    -v /dev/shm/haproxy/:/var/run/haproxy/ \
    -v /opt/otmc-deploy/otmc.secret/broker/server_cert:/usr/local/etc/certs/server_cert:ro \
    -v /opt/otmc-deploy/otmc.secret/broker/client_cert:/usr/local/etc/certs/client_cert:ro \
    -v /opt/otmc-deploy/otmc.secret/broker/internal_cert:/usr/local/etc/certs/internal_cert:ro \
    -v /opt/otmc-deploy/otmc.secret/broker/valkey-cluster:/usr/local/etc/certs/valkey-cluster:ro \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /usr/bin/docker:/usr/bin/docker \
    -v ${HOME}:${HOME} \
    --network host \
    -w /app \
    node:26 \
    /bin/bash
