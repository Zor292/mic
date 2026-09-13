const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const socketServer = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.ROBLOX_API_KEY || "CHANGE_ME";
const publicUrl = process.env.PUBLIC_URL || "http://localhost:3000";
const proximityRange = 50;
const connectionRange = 65;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
const rooms = new Map();
const tokens = new Map();

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function position(value) {
  return { x: number(value?.x), y: number(value?.y), z: number(value?.z) };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { players: new Map(), clients: new Set(), updatedAt: Date.now() });
  return rooms.get(roomId);
}

function robloxAuth(req, res, next) {
  if (req.get("x-api-key") !== apiKey || apiKey === "CHANGE_ME") return res.status(401).json({ error: "Invalid Roblox API key" });
  next();
}

function broadcast(room) {
  for (const client of room.clients) {
    if (client.readyState !== 1) continue;
    const me = room.players.get(client.userId);
    if (!me) continue;
    const peers = [];
    for (const other of room.clients) {
      if (other === client || other.readyState !== 1) continue;
      const player = room.players.get(other.userId);
      if (!player) continue;
      const meters = distance(me.position, player.position);
      const sameRadio = Boolean(me.radioChannel && player.radioChannel && me.radioChannel === player.radioChannel);
      if (meters <= connectionRange || sameRadio) peers.push({ id: other.socketId, username: player.displayName, distance: Math.round(meters * 10) / 10, position: player.position, proximity: meters <= proximityRange, muted: Boolean(other.muted || player.muted), radio: sameRadio, radioOnly: sameRadio && meters > proximityRange, radioTalking: Boolean(player.radioTalking), radioChannel: sameRadio ? me.radioChannel : null });
    }
    client.send(JSON.stringify({ type: "peers", peers, self: { position: me.position, username: me.displayName, muted: Boolean(client.muted || me.muted), radioChannel: me.radioChannel || null, radioTalking: Boolean(me.radioTalking) } }));
  }
}

function broadcastRadioBeep(room, channel, speakerId) {
  for (const client of room.clients) {
    if (client.readyState !== 1 || client.userId === speakerId) continue;
    const player = room.players.get(client.userId);
    if (player?.radioChannel === channel) client.send(JSON.stringify({ type: "radioBeep" }));
  }
}

function closePlayerClients(room, userId) {
  for (const client of [...room.clients]) {
    if (client.userId !== userId) continue;
    client.close(1000, "Player left");
  }
}

app.get("/api/health", (req, res) => res.json({ ok: true, rooms: rooms.size, publicUrl }));
app.get("/api/ice-config", (req, res) => res.json({ iceServers }));

app.post("/api/roblox/register", robloxAuth, (req, res) => {
  const roomId = text(req.body.roomId);
  const code = text(req.body.code).toUpperCase();
  const userId = text(req.body.userId);
  if (!roomId || !/^[A-Z0-9]{6,12}$/.test(code) || !userId) return res.status(400).json({ error: "Invalid registration" });
  const room = getRoom(roomId);
  const old = room.players.get(userId);
  if (old?.code && old.code !== code) room.players.delete(old.code);
  room.players.set(userId, { userId, code, displayName: text(req.body.displayName, `Player ${userId}`), position: position(req.body.position), muted: Boolean(req.body.muted), radioChannel: text(req.body.radioChannel) || null, radioTalking: false, lastSeen: Date.now() });
  room.updatedAt = Date.now();
  broadcast(room);
  res.json({ ok: true, siteUrl: publicUrl, code });
});

app.post("/api/roblox/heartbeat", robloxAuth, (req, res) => {
  const roomId = text(req.body.roomId);
  const room = getRoom(roomId);
  const players = Array.isArray(req.body.players) ? req.body.players : [];
  const seen = new Set();
  for (const item of players) {
    const userId = text(item.userId);
    const code = text(item.code).toUpperCase();
    if (!userId || !/^[A-Z0-9]{6,12}$/.test(code)) continue;
    if (!room.players.has(userId)) room.players.set(userId, { userId, code, displayName: text(item.displayName, `Player ${userId}`), position: position(item.position), muted: Boolean(item.muted), radioChannel: text(item.radioChannel) || null, radioTalking: Boolean(item.radioTalking), lastSeen: Date.now() });
    const player = room.players.get(userId);
    const wasTalking = Boolean(player.radioTalking);
    player.code = code;
    player.displayName = text(item.displayName, player.displayName);
    player.position = position(item.position);
    player.muted = Boolean(item.muted);
    player.radioChannel = text(item.radioChannel) || null;
    player.radioTalking = Boolean(item.radioTalking && player.radioChannel);
    if (!wasTalking && player.radioTalking) broadcastRadioBeep(room, player.radioChannel, userId);
    player.lastSeen = Date.now();
    seen.add(userId);
  }
  for (const [userId, player] of room.players) {
    if (seen.has(userId) || Date.now() - player.lastSeen < 8000) continue;
    closePlayerClients(room, userId);
    room.players.delete(userId);
  }
  room.updatedAt = Date.now();
  broadcast(room);
  res.json({ ok: true, players: room.players.size });
});

app.post("/api/roblox/remove", robloxAuth, (req, res) => {
  const room = rooms.get(text(req.body.roomId));
  const userId = text(req.body.userId);
  if (room && userId) {
    closePlayerClients(room, userId);
    room.players.delete(userId);
    broadcast(room);
  }
  res.json({ ok: true });
});

app.post("/api/roblox/radio-talk", robloxAuth, (req, res) => {
  const room = rooms.get(text(req.body.roomId));
  const userId = text(req.body.userId);
  const channel = text(req.body.channel);
  const player = room?.players.get(userId);
  if (!room || !player) return res.status(404).json({ error: "Player not found" });
  if (!channel || player.radioChannel !== channel) return res.status(403).json({ error: "Radio channel is not active" });
  const talking = Boolean(req.body.talking);
  const wasTalking = Boolean(player.radioTalking);
  player.radioTalking = talking;
  if (!wasTalking && talking) broadcastRadioBeep(room, channel, userId);
  room.updatedAt = Date.now();
  broadcast(room);
  res.json({ ok: true, talking });
});

app.post("/api/roblox/radio-state", robloxAuth, (req, res) => {
  const room = rooms.get(text(req.body.roomId));
  const userId = text(req.body.userId);
  const player = room?.players.get(userId);
  if (!room || !player) return res.status(404).json({ error: "Player not found" });
  const channel = text(req.body.channel);
  player.radioChannel = channel || null;
  player.radioTalking = false;
  room.updatedAt = Date.now();
  broadcast(room);
  res.json({ ok: true, channel: player.radioChannel });
});

app.post("/api/roblox/mute", robloxAuth, (req, res) => {
  const room = rooms.get(text(req.body.roomId));
  const userId = text(req.body.userId);
  const player = room?.players.get(userId);
  if (!room || !player) return res.status(404).json({ error: "Player not found" });
  player.muted = Boolean(req.body.muted);
  room.updatedAt = Date.now();
  broadcast(room);
  res.json({ ok: true, muted: player.muted });
});

app.post("/api/session/claim", (req, res) => {
  const code = text(req.body.code).toUpperCase();
  let found;
  let foundRoomId;
  for (const [roomId, room] of rooms) {
    for (const player of room.players.values()) if (player.code === code) { found = player; foundRoomId = roomId; }
    if (found) break;
  }
  if (!found) return res.status(404).json({ error: "Code not found or expired" });
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, { roomId: foundRoomId, userId: found.userId, displayName: text(req.body.displayName, found.displayName), createdAt: Date.now() });
  res.json({ ok: true, token, displayName: found.displayName, roomId: foundRoomId });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, publicUrl);
  if (url.pathname !== "/socket") return socket.destroy();
  const token = url.searchParams.get("token");
  const identity = tokens.get(token);
  if (!identity || Date.now() - identity.createdAt > 86400000) return socket.destroy();
  socketServer.handleUpgrade(request, socket, head, ws => socketServer.emit("connection", ws, identity));
});

socketServer.on("connection", (ws, identity) => {
  const room = rooms.get(identity.roomId);
  const player = room?.players.get(identity.userId);
  if (!room || !player) return ws.close(1008, "Session expired");
  ws.socketId = crypto.randomUUID();
  ws.roomId = identity.roomId;
  ws.userId = identity.userId;
  ws.muted = false;
  room.clients.add(ws);
  ws.send(JSON.stringify({ type: "welcome", id: ws.socketId, username: player.displayName, roomId: ws.roomId }));
  broadcast(room);
  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "signal" && typeof message.targetId === "string") {
      const target = [...room.clients].find(client => client.socketId === message.targetId);
      if (target?.readyState === 1) target.send(JSON.stringify({ type: "signal", fromId: ws.socketId, payload: message.payload }));
    }
    if (message.type === "mute") { ws.muted = Boolean(message.muted); broadcast(room); }
  });
  ws.on("close", () => { room.clients.delete(ws); broadcast(room); });
});

setInterval(() => {
  for (const [roomId, room] of rooms) {
    for (const [userId, player] of room.players) if (Date.now() - player.lastSeen > 15000) { closePlayerClients(room, userId); room.players.delete(userId); }
    if (!room.players.size && !room.clients.size && Date.now() - room.updatedAt > 30000) rooms.delete(roomId);
  }
}, 5000);

server.listen(port, () => console.log(`VoiceLink listening on ${publicUrl}`));
