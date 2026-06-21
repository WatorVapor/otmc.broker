-- === proxy.lua started ===
ngx.log(ngx.INFO, "=== proxy.lua started ===")

-- 1. 获取包含完整证书链数据的原生转义变量
local escaped_cert = ngx.var.ssl_client_escaped_cert

if not escaped_cert or escaped_cert == "" then
    ngx.log(ngx.ERR, "客户端没有提交任何证书")
    return
end

-- 2. 对 URL 编码进行反转义（将其中的 %0A 还原为标准换行符）
local raw_chain = ngx.unescape_uri(escaped_cert)

-- 3. 检查里面是否包含了多个证书
-- 标准 PEM 证书以 -----BEGIN CERTIFICATE----- 开头
local _, count = string.gsub(raw_chain, "-----BEGIN CERTIFICATE-----", "")

if count and count > 1 then
    ngx.log(ngx.INFO, "【超级成功！】原生变量成功抓取到完整证书链，共计：", count, " 张证书")
    ngx.log(ngx.INFO, "完整链内容如下：\n", raw_chain)
else
    ngx.log(ngx.WARN, "抓取成功，但客户端只发送了 1 张叶子证书（没有带中间证书链）")
    ngx.log(ngx.INFO, "证书内容如下：\n", raw_chain)
end

-- 将拿到的 raw_chain 赋给你后续业务所需的变量
local full_chain = raw_chain

-- ==========================================
-- 在这里继续写你原有的代理、转发或业务逻辑
-- ==========================================