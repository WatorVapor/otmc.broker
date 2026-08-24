#!/bin/bash
docker run -it \
    -v $(pwd):/app \
    -v /etc/group:/etc/group:ro \
    -v /etc/passwd:/etc/passwd:ro \
    -v ${HOME}:${HOME} \
    --network host \
    -w /app \
    node:26 \
    /bin/bash
