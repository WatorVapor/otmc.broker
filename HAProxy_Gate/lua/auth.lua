-- 外部 Node.js 鉴权服务地址
local auth_url = "http://auth:9000/auth"

core.register_action("auth_by_nodejs", { "tcp-req" }, function(txn)
    local chain = txn:get_var("txn.client_chain")
    if not chain then
        core.Alert("No client certificate chain")
        txn:set_var("txn.auth_ok", false)
        return
    end

    -- 调用 Node.js 服务
    local http = core.httpclient()
    local response, err = http:post(auth_url,
        { ["Content-Type"] = "text/plain" },
        chain
    )

    if not response then
        core.Alert("Auth service unreachable: " .. tostring(err))
        txn:set_var("txn.auth_ok", false)
        return
    end

    if response.status == 200 and response.body == "OK" then
        txn:set_var("txn.auth_ok", true)
        core.Info("Client authenticated: " .. txn:get_var("txn.client_chain"))
    else
        txn:set_var("txn.auth_ok", false)
        core.Warning("Auth denied: " .. response.body)
    end
end)
