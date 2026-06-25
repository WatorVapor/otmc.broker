local openssl = require "openssl"
local x509    = openssl.x509
local digest  = require "openssl.digest"
local uuid    = require "uuid"    -- 或自己实现随机 token 生成

-- Redis 配置 (mTLS)
local REDIS_HOST = "redis.trusted.svc"
local REDIS_PORT = 6380
local REDIS_SSL = {
    verify = "required",
    cafile = "/etc/ssl/redis_ca.crt",
    cert   = "/etc/ssl/redis_haproxy.pem",
}

-- 从证书链提取 tenant_hash 和 device_id
local function extract_identity(txn)
    local leaf_der = txn.sf:ssl_c_der()
    local chain_der = txn.sf:ssl_c_chain_der()
    -- ... (证书链拆分、获取 Tenant Issuing CA 公钥指纹与 leaf CN 的逻辑，如前文) ...
    -- 返回 tenant_hash, device_id
end

-- 获取完整客户端证书链的 PEM 格式
local function get_client_chain_pem(txn)
    -- ssl_c_chain_pem() 返回 PEM 编码的整个证书链
    local pem = txn.sf:ssl_c_chain_pem()
    if not pem or #pem == 0 then
        return nil
    end
    return pem
end

-- Redis 命令：SET token pem EX 30
local function redis_set(key, value, ttl)
    local conn = core.tcp()
    conn:settimeout(1)
    local ok, err = conn:connect(REDIS_HOST, REDIS_PORT, REDIS_SSL)
    if not ok then return false, err end
    local cmd = string.format("*3\r\n$3\r\nSET\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n",
                              #key, key, #value, value)
    conn:send(cmd)
    -- 接收响应 (简单处理)
    local data, err = conn:receive("*l")
    conn:close()
    if data and data:match("^+OK") then
        return true
    else
        return false, data or err
    end
end

-- 主入口
function process_mqtt_connect(txn)
    local tenant_hash, device_id = extract_identity(txn)
    if not tenant_hash or not device_id then
        txn:Warning("Failed to extract identity")
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end

    -- 查询后端地址 (基于 tenant_hash)
    local backend_addr = redis_get(tenant_hash)  -- 实现略
    if not backend_addr then
        txn:Warning("No backend for tenant_hash " .. tenant_hash)
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end

    -- 生成 client_id
    local client_id = tenant_hash .. "-" .. device_id

    -- 获取客户端证书链 PEM
    local chain_pem = get_client_chain_pem(txn)
    if not chain_pem then
        txn:Warning("Failed to get client chain PEM")
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end

    -- 生成随机 token
    local token = uuid()  -- 例如 "550e8400-e29b-41d4-a716-446655440000"
    -- 将证书链存储到 Redis，30 秒过期
    local ok, err = redis_set(token, chain_pem, 30)
    if not ok then
        txn:Warning("Failed to store cert chain in Redis: " .. (err or "unknown"))
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end

    -- 通过 Proxy Protocol v2 自定义 TLV 传递 token 和 client_id (可选)
    -- 假设 HAProxy 配置允许设置 TLV 变量
    txn:set_var(txn.f:var("txn.pp2_tlv_0xE0"), token)          -- TLV type 0xE0
    -- 也可以把 client_id 放入另一个 TLV，方便 broker 快速校验
    txn:set_var(txn.f:var("txn.pp2_tlv_0xE1"), client_id)     -- TLV type 0xE1

    -- 设置目标地址
    local ip, port = backend_addr:match("^(.+):(%d+)$")
    txn:set_dst(ip, tonumber(port))

    -- 日志记录
    txn:Info("Routing " .. client_id .. " to " .. backend_addr)
end

core.register_action("process_mqtt_connect", { "tcp-req" }, process_mqtt_connect)
