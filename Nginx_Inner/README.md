# Haproxy Gate

## Checking the connection to the broker
```bash
openssl s_client -connect [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:18883 \
	-CAfile  /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-root.crt \
	-cert /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-client.crt \
	-key /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-client.key \
	-showcerts 
```bash

```bash
openssl s_client -connect [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:18883 \
	-CAfile  /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-root.crt \
	-cert /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-client.crt \
	-key /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-client.key \
	-state -debug

openssl s_client -connect [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:18883 \
	-CAfile  /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-root.crt \
	-cert /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-client.crt \
	-key /opt/otmc-deploy/otmc.secret/broker/internal_cert/internal-client.key \
	-msg -debug  
```


