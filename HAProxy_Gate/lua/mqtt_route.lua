local openssl = require "openssl"
local x509 = require("openssl.x509")
local digest  = require "openssl.digest"
local uuid    = require "uuid"    -- 或自己实现随机 token 生成
local base58 = require("base58")

-- Redis 配置 (mTLS)
local REDIS_HOST = "127.0.0.1"
local REDIS_PORT = 16379

local ALL_BACKENDS_ADDR_KEY = "otmc:all_backends_addr"  -- Redis key for all backend addresses


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

-- Dump the methods of a certificate object
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

-- Dump the methods of a public key object
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


--- Parse ASN.1 length from DER data
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


local function bin2b58(s)
    return base58.encode(s)
end




local function urandom_bytes(n)
    local f = io.open("/dev/urandom", "rb")
    if not f then
        error("无法打开 /dev/urandom，可能权限不足或被容器限制")
    end
    local s = f:read(n)
    f:close()
    if #s ~= n then
        error("读取 /dev/urandom 时未获得足够数据")
    end
    return s
end

uuid.set_rng(urandom_bytes)



-- 从证书链提取 public key hash 和 publick key
local function extract_certs_chain(txn)        
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
    local cert_pubkeys = {}
    local cert_hash_list = {}
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
        -- dump_public_key_methods(public_key)
        txn:Info("certificate public key: " .. (public_key and tostring(public_key) or "nil"))
        local dig = digest.new("sha256")
        dig:update(tostring(public_key))
        local pubkey_hash = dig:final()
        txn:Info("public key SHA256 hash: " .. (pubkey_hash and bin2b58(pubkey_hash) or "nil"))
        
        table.insert(certs, cert)
        cert_pubkeys[bin2b58(pubkey_hash)] = public_key
        table.insert(cert_hash_list, bin2b58(pubkey_hash))
    end
    txn:Info("Extracted " .. #certs .. " certificates in chain")    
    txn:Info("Extracted " .. #cert_hash_list .. " certificate hashes")
    local total_hashes = table.concat(cert_hash_list, "_")
    txn:Info("Certificate public key hashes: " .. total_hashes)
    for keyHash, certPubKey in pairs(cert_pubkeys) do
        txn:Info("Certificate public key: " .. keyHash.. " -> " .. tostring(certPubKey))
    end
    return cert_pubkeys, total_hashes
end


local cluster_map = { 
    ['valkey-cluster-conoha-pdf-coltd.wator.xyz:6379']   = '127.0.0.1:16379',
    ['valkey-cluster-conoha-wator.wator.xyz:6379']       = '127.0.0.1:16380',
    ['valkey-cluster-conoha-ndhealth.wator.xyz:6379']    = '127.0.0.1:16381',
}

local function send_raw_set(host, port, key, value, ttl)
    local conn = core.tcp()
    conn:settimeout(5000)

    local target_key = host .. ":" .. tostring(port)
    local real_target = cluster_map[target_key]
    
    local real_host = host
    local real_port = port

    -- 2. 正确拆分映射出的 IP 和 端口
    if real_target then
        local mapped_ip, mapped_port = real_target:match("^(.-):(%d+)$")
        if mapped_ip and mapped_port then
            real_host = mapped_ip
            real_port = tonumber(mapped_port)
        end
    end

    -- 假设日志对象为 core.Info 或 txn:Info（注意：如果是独立函数，HAProxy Lua 中通常用 core.Info）
    core.Info(string.format("Connecting to Redis target %s via local mapping %s:%d", target_key, real_host, real_port))

    local ok, err = conn:connect(real_host, real_port)
    if not ok then return nil, err end

    local ttl_str = tostring(ttl)
    -- RESP 格式 (SET key value EX ttl)
    local cmd = string.format("*5\r\n$3\r\nSET\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n$2\r\nEX\r\n$%d\r\n%s\r\n",
                              #key, key, #value, value, #ttl_str, ttl_str)
    
    conn:send(cmd)
    local data, err = conn:receive("*l")
    conn:close()
    return data, err
end


local function redis_set(key, value, ttl)
    core.Info("Redis connection details: " .. REDIS_HOST .. ":" .. tostring(REDIS_PORT))
    
    local data, err = send_raw_set(REDIS_HOST, REDIS_PORT, key, value, ttl)
    core.Info("Received Redis response: " .. tostring(data) .. ", error: " .. tostring(err))

    -- 处理 -MOVED 重定向
    if data and data:sub(1, 7) == "-MOVED " then
        local new_host, new_port = data:match("%-MOVED%s+%d+%s+(.-):(%d+)")
        if new_host and new_port then
            core.Info(string.format("Following Redis MOVED to %s:%s", new_host, new_port))
            data, err = send_raw_set(new_host, tonumber(new_port), key, value, ttl)
            core.Info("Received Redis response after redirect: " .. tostring(data))
        end
    end

    if data and data:match("^+OK") then
        return true
    else
        return false, data or err
    end
end

local function send_raw_get(host, port, key)
    local conn = core.tcp()
    conn:settimeout(5000)

    local target_key = host .. ":" .. tostring(port)
    local real_target = cluster_map[target_key]
    
    local real_host = host
    local real_port = port

    -- 2. 正确拆分映射出的 IP 和 端口
    if real_target then
        local mapped_ip, mapped_port = real_target:match("^(.-):(%d+)$")
        if mapped_ip and mapped_port then
            real_host = mapped_ip
            real_port = tonumber(mapped_port)
        end
    end

    -- 假设日志对象为 core.Info 或 txn:Info（注意：如果是独立函数，HAProxy Lua 中通常用 core.Info）
    core.Info(string.format("Connecting to Redis target %s via local mapping %s:%d", target_key, real_host, real_port))

    local ok, err = conn:connect(real_host, real_port)
    if not ok then return nil, err end

    -- RESP 格式 (GET key)
    local cmd = string.format("*2\r\n$3\r\nGET\r\n$%d\r\n%s\r\n",
                              #key, key)
    
    conn:send(cmd)
    local data, err = conn:receive("*l")
    conn:close()
    return data, err

end

local function redis_get(key)
    local result,err = send_raw_get(REDIS_HOST, REDIS_PORT, ALL_BACKENDS_ADDR_KEY)
    core.Info("Received Redis GET response: " .. tostring(result) .. ", error: " .. tostring(err))
    return result, err
end



-- 主入口
function process_mqtt_connect(txn)
    txn:Info("Processing MQTT CONNECT for " .. txn.sf:src())
    -- dump_module(openssl, "openssl")
    -- dump_module(x509, "x509")
    -- dump_module(digest, "digest")
    local pubkeys_hash, total_hashes = extract_certs_chain(txn)
    if not pubkeys_hash or not total_hashes then
        txn:Warning("Failed to extract identity")
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end



    -- 生成随机 token
    local token = uuid()  -- 例如 "550e8400-e29b-41d4-a716-446655440000"
    -- 将证书链公钥存储到 Redis，300 秒过期
    local storeKey = total_hashes .. "_" .. token
    local storeValue = ""
    for keyHash, certPubKey in pairs(pubkeys_hash) do
        txn:Info("Certificate public key: " .. keyHash.. " -> " .. tostring(certPubKey))
        storeValue = storeValue .. tostring(certPubKey) .. "\n"
    end


    local ok, err = redis_set(storeKey, storeValue, 300)
    txn:Info("Redis SET result: " .. tostring(ok) .. ", error: " .. tostring(err))
    if not ok then
        txn:Warning("Failed to store cert chain public keys in Redis: " .. (err or "unknown"))
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end
    redis_get(storeKey)  -- 测试读取，确保存储成功

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
