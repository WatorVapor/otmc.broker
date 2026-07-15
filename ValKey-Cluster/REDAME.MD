## 启动集群
```bash
docker exec -it valkey-dts valkey-cli \
  --tls \
  --cert /etc/valkey/tls/valkey-node.crt \
  --key /etc/valkey/tls/valkey-node.key \
  --cacert /etc/valkey/tls/valkey-root.crt \
  --cluster create \
  valkey-cluster-conoha-ndhealth.wator.xyz:6379 \
  valkey-cluster-conoha-pdf-coltd.wator.xyz:6379 \
  valkey-cluster-conoha-wator.wator.xyz:6379 \
  --cluster-replicas 0
```
## 从集群节点进入，查看集群
```bash
docker exec -it valkey-dts valkey-cli \
  --tls \
  --cert /etc/valkey/tls/valkey-node.crt \
  --key /etc/valkey/tls/valkey-node.key \
  --cacert /etc/valkey/tls/valkey-root.crt 
```
### 查看集群信息
```bash
cluster info
```

## 客户端进入集群
```bash
docker run -it --rm \
  --network host \
  -v /opt/otmc-deploy/otmc.secret/broker/valkey-cluster:/etc/valkey/tls \
  --name valkey-client \
  valkey/valkey:9 /bin/bash
```
```bash
valkey-cli -c --tls \
  --cert /etc/valkey/tls/valkey-client.crt \
  --key /etc/valkey/tls/valkey-client.key \
  --cacert /etc/valkey/tls/valkey-root.crt \
  -p 6379 \
  -h valkey-cluster-conoha-wator.wator.xyz

valkey-cli -c --tls \
  --cert /etc/valkey/tls/valkey-client.crt \
  --key /etc/valkey/tls/valkey-client.key \
  --cacert /etc/valkey/tls/valkey-root.crt \
  -p 6379 \
  -h valkey-cluster-conoha-ndhealth.wator.xyz

valkey-cli -c --tls \
  --cert /etc/valkey/tls/valkey-client.crt \
  --key /etc/valkey/tls/valkey-client.key \
  --cacert /etc/valkey/tls/valkey-root.crt \
  -p 6379 \
  -h valkey-cluster-conoha-pdf-coltd.wator.xyz

```
### 查看集群
```bash
cluster info
```