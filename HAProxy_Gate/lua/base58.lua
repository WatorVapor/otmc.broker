-- base58.lua (基于 kikito/lua-base58)
local alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
local base = #alphabet

local function base58_encode(data)
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

local function base58_decode(data)
  if data == "" then return "" end

  -- 反向查找表：字符 -> 数值
  local map = {}
  for i = 1, base do
    map[alphabet:sub(i, i)] = i - 1
  end

  local zero_char = alphabet:sub(1, 1)
  local size = #data

  -- 统计前导 '1' 的个数，它们代表前导的 0x00 字节
  local zeros = 0
  while zeros < size and data:sub(zeros + 1, zeros + 1) == zero_char do
    zeros = zeros + 1
  end

  -- 用 byte 数组做 base58 -> base256 转换（避免大数精度问题）
  local bytes = { 0 }
  for i = zeros + 1, size do
    local c = data:sub(i, i)
    local val = map[c]
    if not val then
      error("invalid base58 character: " .. c, 2)
    end
    local carry = val
    for j = #bytes, 1, -1 do
      carry = carry + bytes[j] * base
      bytes[j] = carry % 256
      carry = math.floor(carry / 256)
    end
    while carry > 0 do
      table.insert(bytes, 1, carry % 256)
      carry = math.floor(carry / 256)
    end
  end

  -- 去掉结果中的前导 0 字节（它们已由 zeros 统计过）
  local start = 1
  while start <= #bytes and bytes[start] == 0 do
    start = start + 1
  end

  local res = {}
  for _ = 1, zeros do
    res[#res + 1] = 0
  end
  for i = start, #bytes do
    res[#res + 1] = bytes[i]
  end

  return string.char(table.unpack(res))
end

return { encode = base58_encode, decode = base58_decode }
