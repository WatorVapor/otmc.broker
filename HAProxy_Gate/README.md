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


