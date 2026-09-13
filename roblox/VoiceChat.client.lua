local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GuiService = game:GetService("GuiService")

local player = Players.LocalPlayer
local gui = script.Parent
local panel = gui:WaitForChild("Panel")
local openButton = gui:WaitForChild("OpenButton")
local closeButton = panel:WaitForChild("CloseButton")
local websiteButton = panel:WaitForChild("WebsiteButton")
local copyButton = panel:WaitForChild("CopyButton")
local muteButton = panel:WaitForChild("MuteButton")
local siteLabel = panel:WaitForChild("SiteLabel")
local codeLabel = panel:WaitForChild("CodeLabel")
local statusLabel = panel:WaitForChild("StatusLabel")
local event = ReplicatedStorage:WaitForChild("VoiceSessionEvent")
local siteUrl = ""
local code = ""
local muted = false

local function setOpen(value)
  panel.Visible = value
  openButton.Visible = not value
end

openButton.Activated:Connect(function() setOpen(true) end)
closeButton.Activated:Connect(function() setOpen(false) end)

websiteButton.Activated:Connect(function()
  if siteUrl == "" then return end
  pcall(function() GuiService:OpenBrowserWindow(siteUrl .. "?code=" .. code) end)
  statusLabel.Text = "افتح الرابط وأدخل الرمز الظاهر هنا"
end)

copyButton.Activated:Connect(function()
  statusLabel.Text = "الرمز: " .. code
end)

muteButton.Activated:Connect(function()
  muted = not muted
  muteButton.Text = muted and "فتح المايك" or "إغلاق المايك"
  statusLabel.Text = muted and "تم إغلاق المايك" or "تم فتح المايك"
  event:FireServer("mute", muted)
end)

event.OnClientEvent:Connect(function(action, url, newCode)
  if action == "error" then
    statusLabel.Text = url
    return
  end
  if action ~= "session" then return end
  siteUrl = url
  code = newCode
  siteLabel.Text = url
  codeLabel.Text = code
  statusLabel.Text = "الجلسة جاهزة"
end)

panel.Visible = false
openButton.Visible = true
