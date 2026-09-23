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




local function base58_prefix_to_int64(s)
  if not s or s == "" then return nil end

  local decoded = base58.decode(s)
  if #decoded < 8 then
    core.Warning("base58_prefix_to_int64: bad input [" .. tostring(s) .. "]")
    return nil
  end

  local b1,b2,b3,b4,b5,b6,b7,b8 = decoded:byte(1, 8)
  local v = 0
  v = v | (b1 << 56)
  v = v | (b2 << 48)
  v = v | (b3 << 40)
  v = v | (b4 << 32)
  v = v | (b5 << 24)
  v = v | (b6 << 16)
  v = v | (b7 << 8)
  v = v | b8
  return v
end

local function xor_distance_int(a, b)
    return a ~ b  -- Lua 5.3 原生按位异或
end

local function calculate_distance(a, b)
    local a_int = base58_prefix_to_int64(a)
    local b_int = base58_prefix_to_int64(b)
    if not a_int or not b_int then return nil end
    return xor_distance_int(a_int, b_int)
end

local function find_closest_backend(txn, last_hash, all_backends)
    local closest_backend = nil
    local closest_distance = nil   -- 用 nil 初始化

    for backend_id, backend_name in pairs(all_backends) do
        local distance = calculate_distance(last_hash, backend_id)
        if distance ~= nil then
            txn:Info("Distance from last_hash <" .. last_hash ..
                     "> to backend_id <" .. backend_id ..
                     "> is " .. tostring(distance))

            -- 使用无符号比较：math.ult(m, n) 表示 m < n
            if closest_distance == nil or math.ult(distance, closest_distance) then
                closest_distance = distance
                closest_backend = backend_name
            end
        else
            txn:Warning("Failed to calculate distance for backend_id <" ..
                        tostring(backend_id) .. ">")
        end
    end

    txn:Info("Closest backend for last_hash <" .. last_hash ..
             "> is <" .. tostring(closest_backend) ..
             "> with distance " .. tostring(closest_distance))

    return closest_backend
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
    local closest_backend = find_closest_backend(txn, last_hash, all_mqtt_backends)

    txn:set_var("txn.target_backend", closest_backend)
    return
end



core.register_action("match_backend_by_dht", { "tcp-req" }, match_backend_by_dht)

