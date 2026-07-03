-- base58.lua (基于 kikito/lua-base58)
local alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
local base = #alphabet

local function encode(data)
  local bytes = { data:byte(1, -1) }
  local size = #bytes
  local n, p = 0, 0
  for i = size, 1, -1 do
    n = n + bytes[i] * (256 ^ p)
    p = p + 1
  end
  if n == 0 then return string.rep(alphabet:sub(1,1), size) end
  local res = {}
  while n > 0 do
    table.insert(res, 1, alphabet:sub((n % base) + 1, (n % base) + 1))
    n = math.floor(n / base)
  end
  for i = 1, size do
    if data:byte(i) ~= 0 then break end
    table.insert(res, 1, alphabet:sub(1,1))
  end
  return table.concat(res)
end

return { encode = encode, decode = nil } -- 如需解码可扩充，这里仅演示编码
