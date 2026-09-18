local openssl = require "openssl"
local x509 = require("openssl.x509")
local digest  = require "openssl.digest"
local uuid    = require "uuid"    -- 或自己实现随机 token 生成
local base58 = require("base58")
local json    = require("cjson.safe")

-- Redis 配置 (mTLS)
local REDIS_HOST = "127.0.0.1"
local REDIS_PORT = 16379

local ALL_BACKENDS_ADDR_KEY = "otmc:all_backends_addr"  -- Redis key for all backend addresses
local ALL_BACKENDS_ENDPOINTS_KEY = 'otmc:broker:store:endpoints'


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



-- 从证书链提取 public key hash 和 public key
local function extract_certs_chain(txn)
    -- 获取客户端 leaf 证书 DER
    local leaf_der = txn.sf:ssl_c_der()

    -- 获取客户端证书链 DER
    local chain_blob = txn.sf:ssl_c_chain_der()

    local all_ders = {}
    local seen = {}

    -- 1. 先加入 leaf 证书
    if leaf_der and #leaf_der > 0 then
        table.insert(all_ders, leaf_der)
        seen[leaf_der] = true
    end

    -- 2. 再拆分并加入证书链
    if chain_blob and #chain_blob > 0 then
        local cert_ders, err = split_der_certificates(chain_blob)
        if not cert_ders then
            txn:Warning("Failed to split DER chain: " .. (err or "unknown"))
        else
            for _, cert_der in ipairs(cert_ders) do
                -- 去重，避免 leaf 已经在 chain 中
                if not seen[cert_der] then
                    table.insert(all_ders, cert_der)
                    seen[cert_der] = true
                end
            end
        end
    end

    -- 3. 如果 leaf 和 chain 都没有，才报错返回
    if #all_ders == 0 then
        txn:Warning("No client certificate or certificate chain provided")
        return nil, nil
    end

    -- 解析证书
    local certs = {}
    local cert_pubkeys = {}
    local cert_hash_list = {}
    local cert_subjects = {}

    for _, cert_der in ipairs(all_ders) do
        local cert, err = x509.new(cert_der, "der")
        if not cert then
            txn:Warning("Failed to parse cert in chain: " .. (err or "unknown"))
            return nil, nil
        end

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
        txn:Info("certificate public key: " .. (public_key and tostring(public_key) or "nil"))

        local dig = digest.new("sha256")
        dig:update(tostring(public_key))
        local pubkey_hash = dig:final()
        local hash_b58 = bin2b58(pubkey_hash)

        txn:Info("public key SHA256 hash: " .. (pubkey_hash and hash_b58 or "nil"))

        table.insert(certs, cert)
        cert_pubkeys[hash_b58] = public_key
        cert_subjects[hash_b58] = subject_name
        table.insert(cert_hash_list, hash_b58)
    end

    txn:Info("Extracted " .. #certs .. " certificates in chain")
    txn:Info("Extracted " .. #cert_hash_list .. " certificate hashes")


    return cert_pubkeys, cert_hash_list,cert_subjects
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

    if real_target then
        local mapped_ip, mapped_port = real_target:match("^(.-):(%d+)$")
        if mapped_ip and mapped_port then
            real_host = mapped_ip
            real_port = tonumber(mapped_port)
        end
    end

    core.Info(string.format("Connecting to Redis target %s via local mapping %s:%d", target_key, real_host, real_port))

    local ok, err = conn:connect(real_host, real_port)
    if not ok then
        conn:close()
        return nil, err
    end

    local cmd = string.format("*2\r\n$3\r\nGET\r\n$%d\r\n%s\r\n", #key, key)
    conn:send(cmd)

    -- 读取 RESP 第一行
    local line = conn:receive("*l")
    if not line then
        conn:close()
        return nil, "empty response"
    end

    -- 处理 MOVED 重定向
    if line:sub(1, 7) == "-MOVED " then
        conn:close()
        local new_host, new_port = line:match("%-MOVED%s+%d+%s+(.-):(%d+)")
        if new_host and new_port then
            core.Info(string.format("Following Redis MOVED to %s:%s", new_host, new_port))
            return send_raw_get(new_host, tonumber(new_port), key)
        else
            return nil, line
        end
    end

    -- 处理其他错误响应（以 '-' 开头）
    if line:sub(1,1) == "-" then
        conn:close()
        return nil, line
    end

    -- 处理简单字符串（+OK 等）
    if line:sub(1,1) == "+" then
        conn:close()
        return line:sub(2), nil
    end

    -- 处理整数（:123）
    if line:sub(1,1) == ":" then
        conn:close()
        return line:sub(2), nil
    end

    -- 处理 bulk string（$len）
    if line:sub(1,1) == "$" then
        local len = tonumber(line:sub(2))
        if not len or len < 0 then
            conn:close()
            return nil, "key not found"
        end
        local data = conn:receive(len)
        conn:receive(2)  -- 读取结尾的 \r\n
        conn:close()
        return data, nil
    end

    conn:close()
    return nil, "unknown response: " .. tostring(line)
end

local function redis_get(key)
    local result,err = send_raw_get(REDIS_HOST, REDIS_PORT, key)
    core.Info("Received Redis GET response: " .. tostring(result) .. ", error: " .. tostring(err))
    return result, err
end

local function match_endpoints(txn,backend_endpoints,clientId)
    local minClientCounter = 1000*1000
    local indexMin = 0;
    for index, endpoint in ipairs(backend_endpoints) do
        if type(endpoint) ~= "table" or not endpoint.host or not endpoint.port then
            txn:Warning("Invalid backend endpoint at index " .. tostring(index))
            txn:set_var(txn.f:var("txn.reject"), true)
            return
        end
        txn:Info(string.format("match_endpoints Backend endpoint[%d]: host=%s, port=%s, clientCounter=%s",
            index, tostring(endpoint.host), tostring(endpoint.port),
            tostring(endpoint.clientCounter)))
        if(minClientCounter > endpoint.clientCounter) then
            minClientCounter = endpoint.clientCounter
            indexMin = index;
        end
    end
    txn:Info("match_endpoints minClientCounter=<" .. tostring(minClientCounter) .. ">")
    txn:Info("match_endpoints indexMin=<" .. tostring(indexMin) .. ">")
    return backend_endpoints[indexMin]
end

local function calc_backend_endpoint(txn,clientId)
    txn:Info("calc_backend_endpoint clientId=<".. tostring(clientId) .. ">")
    local all_backends_endpoints = redis_get(ALL_BACKENDS_ENDPOINTS_KEY)
    if not all_backends_endpoints then
        txn:Warning("Failed to get all backends endpoints from Redis")
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end
    txn:Info("All backends endpoints: " .. tostring(all_backends_endpoints))

    -- 示例：[{"host":"mqtt-broker-local10001.wator.xyz","port":18883,"clientCounter":0}]
    local backend_endpoints, json_err = json.decode(all_backends_endpoints)
    if not backend_endpoints or type(backend_endpoints) ~= "table" then
        txn:Warning("Failed to parse all backends endpoints JSON: " .. tostring(json_err))
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end
    local matched_endpoints = match_endpoints(txn,backend_endpoints,clientId)
    txn:Info("calc_backend_endpoint matched_endpoints: " .. tostring(matched_endpoints))
    return matched_endpoints
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
        --txn:set_var(txn.f:var("txn.reject"), true)
        txn:done()
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
    local result, err = redis_get(storeKey)  -- 测试读取，确保存储成功
    txn:Info("Redis GET storeKey<" .. tostring(storeKey) .. ">, result: <" .. tostring(result) .. ">, error: " .. tostring(err))

    local matched_endpoint = calc_backend_endpoint(txn,total_hashes)
    if not matched_endpoint then
        txn:Warning("Failed to calculate backend endpoint")
        txn:set_var(txn.f:var("txn.reject"), true)
        return
    end
    txn:Info("matched_endpoint<" .. tostring(matched_endpoint) .. ">, matched_endpoint.host: <" .. tostring(matched_endpoint.host) .. ">, matched_endpoint.port: " .. tostring(matched_endpoint.port))

    txn:set_var("txn.ssl_c_used", true)

    local dst_ip = matched_endpoint.host

    local dst_port = math.floor(matched_endpoint.port)
    txn:Info("Resolved backend port: " .. tostring(dst_port))
    -- tcp-req Lua transactions do not expose set_dst().  Publish the
    -- destination for HAProxy's set-dst rules instead.
    txn:set_var("txn.route_dst_ip", dst_ip)
    txn:set_var("txn.route_dst_port", dst_port)
    server_ipv6 = "["..dst_ip.."]"..":"..tostring(dst_port)
    txn:Info("Routing to server_ipv6=<" .. server_ipv6 .. ">")
    txn:set_var("txn.mqtt_backend", "mqtt_backend_internal_01")

end

core.register_action("process_mqtt_connect", { "tcp-req" }, process_mqtt_connect)



local function base58_prefix_to_int(s)
  if not s or s == "" then return nil end

  local decoded = base58.decode(s)
  if #decoded < 4 then
    core.Warning("base58_prefix_to_int: bad input [" .. tostring(s) .. "]")
    return nil
  end

  local b1, b2, b3, b4 = decoded:byte(1, 4)
  return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4
end

local function xor_distance_int(a, b)
    return a ~ b  -- Lua 5.3 原生按位异或
end

local function calculate_distance(a, b)
    local a_int = base58_prefix_to_int(a)
    local b_int = base58_prefix_to_int(b)
    return xor_distance_int(a_int, b_int)
end

local function find_fastest_backend(txn, last_hash, all_backends)
    local fastest_backend = nil
    local fastest_distance = 0

    for backend_id, backend_name in pairs(all_backends) do
        local distance = math.abs(calculate_distance(last_hash, backend_id))
        txn:Info("Distance from last_hash <" .. last_hash .. "> to backend_id <" .. backend_id .. "> is " .. tostring(distance))
        if not fastest_distance or distance > fastest_distance then
            fastest_distance = distance
            fastest_backend = backend_name
        end
    end
    txn:Info("Fastest backend for last_hash <" .. last_hash .. "> is <" .. tostring(fastest_backend) .. "> with distance " .. tostring(fastest_distance))

    return fastest_backend
end

local function match_backend_by_dht(txn)
    local pubkeys_hash, cert_hash_list, cert_subjects = extract_certs_chain(txn)
    if not pubkeys_hash or not cert_hash_list then
        txn:Warning("Failed to extract identity")
        --txn:set_var(txn.f:var("txn.reject"), true)
        txn:done()
        return
    end
    txn:Info("match_backend_by_dht cert_hash_list:=<" .. table.concat(cert_hash_list, "_").. " > ")
    -- 选择最后一个证书的 public key hash 作为空间标识符
    local last_hash = cert_hash_list[#cert_hash_list]
    txn:Info("match_backend_by_dht last Certificate public key hash:=<" .. last_hash .. ">")
    local last_subject_name = cert_subjects[last_hash]
    txn:Info("match_backend_by_dht last Certificate subject name:=<" .. tostring(last_subject_name) .. ">")

    local all_mqtt_backends = {};
    for backend_name, backend in pairs(core.backends) do
        txn:Info("Available backend: " .. backend_name)
        if backend_name:match("^mqtt_backend_") then
            local backend_id = backend_name:gsub("^mqtt_backend_", "")
            all_mqtt_backends[backend_id] = backend_name
        end
    end
    local fastest_backend = find_fastest_backend(txn, last_hash, all_mqtt_backends)

    txn:set_var("txn.target_backend", fastest_backend)
    return
end



core.register_action("match_backend_by_dht", { "tcp-req" }, match_backend_by_dht)

