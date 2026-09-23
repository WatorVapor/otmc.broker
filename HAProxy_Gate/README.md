# Haproxy Gate

## Checking the connection to the broker
```bash
openssl s_client -connect [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:8883 \
	-CAfile  /opt/otmc-deploy/otmc.secret/broker/server_cert/server-root.crt \
	-cert /opt/otmc-deploy/otmc.secret/broker/client_cert/client-space-leaf.crt \
	-cert_chain /opt/otmc-deploy/otmc.secret/broker/client_cert/client-space-ca-chain.crt \
	-key /opt/otmc-deploy/otmc.secret/broker/client_cert/client-space-leaf.key \
	-msg -debug  
```


## check haproxy backend
```bash
echo 'add backend mqtt_backend_test from dynamic_mqtt_defaults' | socat - UNIX-CONNECT:/var/run/haproxy/admin.sock
echo 'show backend' | socat - UNIX-CONNECT:/var/run/haproxy/admin.sock

echo 'experimental-mode on;add server mqtt_backend_CktwZ6VQaUewqPWebq6NtMDHy4iPTypTu9w98uuxMHhd/mqtt_server_CktwZ6VQaU [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:18883 ssl ca-file "@internal/internal-root.crt" crt "@internal/internal-client.crt.key.pem"  verify required' | socat - UNIX-CONNECT:/var/run/haproxy/admin.sock


echo 'show servers state' | socat - UNIX-CONNECT:/var/run/haproxy/admin.sock


echo "experimental-mode on; add server mqtt_backend_CktwZ6VQaUewqPWebq6NtMDHy4iPTypTu9w98uuxMHhd/t2 \
  [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:18883 ssl verify none" \
| socat - UNIX-CONNECT:/var/run/haproxy/admin.sock

echo 'show servers state' | socat - UNIX-CONNECT:/var/run/haproxy/admin.sock | grep t2

```
