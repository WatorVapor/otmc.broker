-- get_client_cert_chain.lua
local ssl = require "ngx.ssl"
local cjson = require "cjson.safe"

ngx.log(ngx.ERR, "=== proxy.lua started ===")

-- 获取证书链 PEM 字符串
local chain = ngx.var.ssl_client_cert_chain
if not chain or chain == "" then
    ngx.log(ngx.ERR, "no client certificate chain provided")
    ngx.status = 403
    ngx.say(cjson.encode({ error = "client certificate required" }))
    return ngx.exit(403)
end

-- （可选）解析每一张证书
local certs = {}
for pem in string.gmatch(chain, "%-%-%-%-%-BEGIN CERTIFICATE%-%-%-%-%-.-\n.-%-%-%-%-%-END CERTIFICATE%-%-%-%-%-") do
    local cert, err = ssl.parse_pem_cert(pem)
    if cert then
        table.insert(certs, {
            subject   = cert:get_subject(),
            issuer    = cert:get_issuer(),
            not_after = cert:get_not_after(),
        })
    else
        ngx.log(ngx.WARN, "failed to parse a cert in chain: ", err)
    end
end

-- 返回结果（根据实际需求调整）
ngx.header["Content-Type"] = "application/json"
ngx.say(cjson.encode({
    full_chain = chain,
    parsed_certs = certs
}))

ngx.log(ngx.ERR, "=== proxy.lua finished ===")
