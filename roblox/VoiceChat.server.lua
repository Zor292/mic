local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local config = ReplicatedStorage:WaitForChild("VoiceLinkConfig")
local event = ReplicatedStorage:WaitForChild("VoiceSessionEvent")
local API_BASE = string.gsub(config:WaitForChild("ApiBase").Value, "/+$", "")
local API_KEY = config:WaitForChild("ApiKey").Value
local SITE_URL = string.gsub(config:WaitForChild("SiteUrl").Value, "/+$", "")
local roomId = game.JobId ~= "" and game.JobId or HttpService:GenerateGUID(false)
local sessions = {}
local playerCodes = {}
local muted = {}
local radioChannels = {}

local function request(path, body)
  local ok, result = pcall(function()
    return HttpService:RequestAsync({
      Url = API_BASE .. path,
      Method = "POST",
      Headers = { ["Content-Type"] = "application/json", ["x-api-key"] = API_KEY },
      Body = HttpService:JSONEncode(body)
    })
  end)
  if not ok then
    warn("VoiceLink HTTP error: " .. tostring(result))
    return false
  end
  if not result.Success then
    warn("VoiceLink HTTP status: " .. tostring(result.StatusCode) .. " " .. tostring(result.StatusMessage))
    return false
  end
  return true
end

local function makeCode()
  local code
  repeat
    code = string.upper(string.sub(string.gsub(HttpService:GenerateGUID(false), "-", ""), 1, 6))
  until not sessions[code]
  return code
end

local function playerData(player)
  local character = player.Character
  local root = character and character:FindFirstChild("HumanoidRootPart")
  local position = root and root.Position or Vector3.zero
  return { userId = tostring(player.UserId), code = playerCodes[player.UserId], displayName = player.DisplayName, position = { x = position.X, y = position.Y, z = position.Z }, muted = muted[player.UserId] == true, radioChannel = radioChannels[player.UserId] }
end

local function register(player)
  local code = makeCode()
  sessions[code] = player.UserId
  playerCodes[player.UserId] = code
  muted[player.UserId] = false
  event:FireClient(player, "session", SITE_URL, code)
  local registered = request("/api/roblox/register", { roomId = roomId, code = code, userId = tostring(player.UserId), displayName = player.DisplayName, position = playerData(player).position, muted = false, radioChannel = nil })
  if registered then
    print("VoiceLink registered: " .. player.Name)
  else
    event:FireClient(player, "error", "تعذر تسجيل الجلسة في الخادم")
  end
end

Players.PlayerAdded:Connect(function(player)
  task.spawn(register, player)
end)

Players.PlayerRemoving:Connect(function(player)
  muted[player.UserId] = nil
  playerCodes[player.UserId] = nil
  radioChannels[player.UserId] = nil
  request("/api/roblox/remove", { roomId = roomId, userId = tostring(player.UserId) })
end)

event.OnServerEvent:Connect(function(player, action, value)
  if action == "ready" and playerCodes[player.UserId] then
    event:FireClient(player, "session", SITE_URL, playerCodes[player.UserId])
  end
  if action == "mute" then muted[player.UserId] = value == true end
  if action == "radioJoin" then
    local channel = tonumber(value)
    if channel and channel % 1 == 0 and channel >= 1 and channel <= 9999 then
      radioChannels[player.UserId] = tostring(channel)
      event:FireClient(player, "radioState", tostring(channel))
    else
      event:FireClient(player, "radioError", "رقم الموجة يجب أن يكون من 1 إلى 9999")
    end
  end
  if action == "radioLeave" then
    radioChannels[player.UserId] = nil
    event:FireClient(player, "radioState", "")
  end
end)

local elapsed = 0
RunService.Heartbeat:Connect(function(delta)
  elapsed = elapsed + delta
  if elapsed < 1 then return end
  elapsed = 0
  local players = {}
  for _, player in ipairs(Players:GetPlayers()) do table.insert(players, playerData(player)) end
  request("/api/roblox/heartbeat", { roomId = roomId, players = players })
end)

for _, player in ipairs(Players:GetPlayers()) do
  task.spawn(register, player)
end
