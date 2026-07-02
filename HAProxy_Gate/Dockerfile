FROM haproxy:lts

USER root

# Added "uuid" to the luarocks install command
RUN apt-get update && apt-get install -y \
    lua5.4 \
    liblua5.4-dev \
    luarocks \
    libssl-dev \
    build-essential \
    && luarocks install --lua-version=5.4 luaossl \
    && luarocks install --lua-version=5.4 uuid \
    && apt-get purge -y --auto-remove build-essential luarocks \
    && rm -rf /var/lib/apt/lists/*
