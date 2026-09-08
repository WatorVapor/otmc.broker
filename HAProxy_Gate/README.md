# Haproxy Gate

## Checking the connection to the broker
openssl s_client -connect [2404:7a82:1be9:3f00:96c6:91ff:fea6:7bd0]:18883 \
	-CAfile  /opt/otmc-deploy/otmc.secret/broker/server_cert/server-root.crt \
	-cert /opt/otmc-deploy/otmc.secret/broker/client_cert/client.fullchain.crt \
	-key /opt/otmc-deploy/otmc.secret/broker/client_cert/client-space-leaf.key \
	-verify_return_error -brief



