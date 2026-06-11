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
## 进入，查看集群
```bash
docker exec -it valkey-dts valkey-cli \
  --tls \
  --cert /etc/valkey/tls/valkey-node.crt \
  --key /etc/valkey/tls/valkey-node.key \
  --cacert /etc/valkey/tls/valkey-root.crt 
```
```bash
cluster info
```
