local openssl = require "openssl"
local x509 = require("openssl.x509")
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


-- Recursively print table keys with type info (depth 2)
local function dump_module(mod, name, depth)
    depth = depth or 0
    if depth > 2 then return end
    for k, v in pairs(mod) do
        local full_key = name .. "." .. tostring(k)
        local vtype = type(v)
        if vtype == "table" then
            core.Info(full_key .. " = <table>")
            dump_module(v, full_key, depth + 1)
        elseif vtype == "function" then
            core.Info(full_key .. " = <function>")
        else
            core.Info(full_key .. " = " .. tostring(v))
        end
    end
end

local function dump_cert_methods(cert)
    if not cert then
        core.Info("cert is nil")
        return
    end
    core.Info("cert type: " .. type(cert))
    local mt = getmetatable(cert)
    if not mt then
        core.Info("no metatable")
        return
    end
    core.Info("metatable keys:")
    for k, v in pairs(mt) do
        core.Info("  meta." .. k .. " = " .. type(v))
        -- If __index is a table, it usually holds the methods
        if k == "__index" and type(v) == "table" then
            core.Info("  __index methods:")
            for mk, mv in pairs(v) do
                core.Info("    " .. mk .. " = " .. type(mv))
            end
        end
    end
end


local function dump_public_key_methods(pubkey)
    if not pubkey then
        core.Info("pubkey is nil")
        return
    end
    core.Info("pubkey type: " .. type(pubkey))
    local mt = getmetatable(pubkey)
    if not mt then
        core.Info("no metatable")
        return
    end
    core.Info("metatable keys:")
    for k, v in pairs(mt) do
        core.Info("  meta." .. k .. " = " .. type(v))
        -- If __index is a table, it usually holds the methods
        if k == "__index" and type(v) == "table" then
            core.Info("  __index methods:")
            for mk, mv in pairs(v) do
                core.Info("    " .. mk .. " = " .. type(mv))
            end
        end
    end
end



local function parse_asn1_length(data, offset)
    local b = string.byte(data, offset)
    if not b then return nil, 0 end
    if b < 0x80 then
        return b, 1
    elseif b == 0x80 then -- indefinite length (not used in DER certificates)
        return nil, 1
    else
        local num_bytes = b - 0x80
        if num_bytes > 4 then return nil, 1 end -- safety
        local len = 0
        for i = 1, num_bytes do
            local byte = string.byte(data, offset + i)
            if not byte then return nil, i end
            len = len * 256 + byte
        end
        return len, num_bytes + 1
    end
end

-- Split a concatenated DER blob into individual certificate DERs
local function split_der_certificates(der_blob)
    local certs = {}
    local pos = 1
    local len = #der_blob
    while pos <= len do
        -- Certificate starts with 0x30 (SEQUENCE tag)
        if string.byte(der_blob, pos) ~= 0x30 then
            return nil, "invalid DER: expected SEQUENCE tag at offset " .. pos
        end
        local content_length, length_bytes = parse_asn1_length(der_blob, pos + 1)
        if not content_length then
            return nil, "failed to parse DER length at offset " .. pos
        end
        local total_cert_len = 1 + length_bytes + content_length
        if pos + total_cert_len - 1 > len then
            return nil, "DER blob truncated"
        end
        local cert_der = der_blob:sub(pos, pos + total_cert_len - 1)
        table.insert(certs, cert_der)
        pos = pos + total_cert_len
    end
    return certs
end

local function bin2hex(s)
    return (s:gsub('.', function(c)
        return string.format('%02x', string.byte(c))
    end))
end

local function bin2b64(s)
    -- Convert binary string to base64
    local b64_chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    local result = {}
    local padding = ''
    
    for i = 1, #s, 3 do
        local b1, b2, b3 = string.byte(s, i, i + 2)
        b2 = b2 or 0
        b3 = b3 or 0
        
        local n = b1 * 65536 + b2 * 256 + b3
        local c1 = math.floor(n / 262144) % 64 + 1
        local c2 = math.floor(n / 4096) % 64 + 1
        local c3 = math.floor(n / 64) % 64 + 1
        local c4 = n % 64 + 1
        
        table.insert(result, b64_chars:sub(c1, c1))
        table.insert(result, b64_chars:sub(c2, c2))
        table.insert(result, b64_chars:sub(c3, c3))
        table.insert(result, b64_chars:sub(c4, c4))
    end
    
    local remainder = #s % 3
    if remainder == 1 then
        result[#result] = padding
        result[#result - 1] = padding
    elseif remainder == 2 then
        result[#result] = padding
    end
    
    return table.concat(result)
end


-- 从证书链提取 tenant_hash 和 device_id
local function extract_identity(txn)        
    -- 获取客户端证书链 DER
    local chain_blob = txn.sf:ssl_c_chain_der()
    if not chain_blob or #chain_blob == 0 then
        txn:Warning("No client certificate chain provided")
        return nil, nil
    end

    -- 拆分 DER 链为单个证书
    local cert_ders, err = split_der_certificates(chain_blob)
    if not cert_ders then
        txn:Warning("Failed to split DER chain: " .. (err or "unknown"))
        return nil, nil
    end    

    -- 解析证书链
    local certs = {}
    local cert_hashes = ""
    for _, cert_der in ipairs(cert_ders) do
        local cert, err = x509.new(cert_der,"der")
        if not cert then
            txn:Warning("Failed to parse cert in chain: " .. (err or "unknown"))
            return nil, nil
        end
        --dump_cert_methods(cert)

        local subject_name = cert:getSubject()
        local subject_str = "unknown"
        if subject_name and type(subject_name.tostring) == "function" then
            subject_str = subject_name:tostring()
        elseif subject_name then
            subject_str = tostring(subject_name)
        end
        txn:Info("certificate subject: " .. subject_str)
        
        -- 解析 public key
        local public_key = cert:getPublicKey()
        txn:Info("certificate public key type: " .. (public_key and public_key:type() or "nil"))
        dump_public_key_methods(public_key)
        txn:Info("certificate public key: " .. (public_key and tostring(public_key) or "nil"))
        local dig = digest.new("sha256")
        dig:update(tostring(public_key))
        local pubkey_hash = dig:final()
        txn:Info("public key SHA256 hash: " .. (pubkey_hash and bin2b64(pubkey_hash) or "nil"))
        
        table.insert(certs, cert)
        cert_hashes = cert_hashes .."@".. bin2b64(pubkey_hash)

    end
    txn:Info("Parsed " .. #certs .. " certificates in chain")    
    txn:Info("Parsed " .. cert_hashes .. " certificate hashes")    
    local dig2 = digest.new("sha256")
    dig2:update(cert_hashes)
    local total_hash = dig2:final()
    txn:Info("Total certificate chain hash: " .. (total_hash and bin2b64(total_hash) or "nil"))

    return certs
end



-- 获取完整客户端证书链的 PEM 格式
local function get_client_chain_pem(txn)
    -- ssl_c_chain_pem() 返回 PEM 编码的整个证书链
    local pem = txn.sf:ssl_c_chain_pem()
    txn:Info("Client chain PEM length: " .. (pem and #pem or 0))
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
    txn:Info("Processing MQTT CONNECT for " .. txn.sf:src())
    dump_module(openssl, "openssl")
    dump_module(x509, "x509")
    dump_module(digest, "digest")
    local tenant_hash, device_id = extract_identity(txn)
    if not tenant_hash or not device_id then
        txn:Warning("Failed to extract identity")
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end

--[[

    -- 查询后端地址 (基于 tenant_hash)
    local backend_addr = redis_get(tenant_hash)  -- 实现略
    if not backend_addr then
        txn:Warning("No backend for tenant_hash " .. tenant_hash)
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end

    -- 生成 client_id
    local client_id = tenant_hash .. "-" .. device_id
]]

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
