local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local config = ReplicatedStorage:WaitForChild("VoiceLinkConfig")
local API_BASE = config:WaitForChild("ApiBase").Value
local API_KEY = config:WaitForChild("ApiKey").Value
local SITE_URL = config:WaitForChild("SiteUrl").Value
local roomId = game.JobId ~= "" and game.JobId or HttpService:GenerateGUID(false)
local sessions = {}
local playerCodes = {}
local muted = {}
local event = ReplicatedStorage:WaitForChild("VoiceSessionEvent")

local function request(path, body)
  local ok, result = pcall(function()
    return HttpService:RequestAsync({
      Url = API_BASE .. path,
      Method = "POST",
      Headers = { ["Content-Type"] = "application/json", ["x-api-key"] = API_KEY },
      Body = HttpService:JSONEncode(body)
    })
  end)
  return ok and result and result.Success
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
  return { userId = tostring(player.UserId), code = playerCodes[player.UserId], displayName = player.DisplayName, position = { x = position.X, y = position.Y, z = position.Z }, muted = muted[player.UserId] == true }
end

local function register(player)
  local code = makeCode()
  sessions[code] = player.UserId
  playerCodes[player.UserId] = code
  muted[player.UserId] = false
  local registered = request("/api/roblox/register", { roomId = roomId, code = code, userId = tostring(player.UserId), displayName = player.DisplayName, position = playerData(player).position, muted = false })
  event:FireClient(player, "session", SITE_URL, code)
  if not registered then event:FireClient(player, "error", "تعذر تسجيل الجلسة في الخادم") end
end

Players.PlayerAdded:Connect(register)
Players.PlayerRemoving:Connect(function(player)
  muted[player.UserId] = nil
  playerCodes[player.UserId] = nil
  request("/api/roblox/remove", { roomId = roomId, userId = tostring(player.UserId) })
end)

event.OnServerEvent:Connect(function(player, action, value)
  if action == "mute" then muted[player.UserId] = value == true end
end)

local elapsed = 0
RunService.Heartbeat:Connect(function(delta)
  elapsed += delta
  if elapsed < 1 then return end
  elapsed = 0
  local players = {}
  for _, player in ipairs(Players:GetPlayers()) do table.insert(players, playerData(player)) end
  request("/api/roblox/heartbeat", { roomId = roomId, players = players })
end)

for _, player in ipairs(Players:GetPlayers()) do task.spawn(register, player) end
