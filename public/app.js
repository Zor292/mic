const state = { token: null, socket: null, selfId: null, self: null, peers: new Map(), connections: new Map(), localStream: null, muted: false, devices: [], outputId: "", audioContext: null, audioRoutes: new Map() };
const $ = id => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");

function setStatus(message, error = false) { $("loginStatus").textContent = message; $("loginStatus").style.color = error ? "#f48f9f" : "#64dda8"; }
function initials(name) { return (name || "V").slice(0, 1).toUpperCase(); }
function send(message) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message)); }

async function connect() {
  const code = $("roomCode").value.trim().toUpperCase();
  const displayName = $("displayName").value.trim() || "Player";
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return setStatus("أدخل رمزًا صحيحًا من 6 إلى 12 خانة", true);
  setStatus("جارٍ الاتصال...");
  try {
    const response = await fetch("/api/session/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, displayName }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "تعذر العثور على الرمز");
    state.token = data.token;
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    $("identityName").textContent = displayName;
    $("avatarInitial").textContent = initials(displayName);
    $("roomLabel").textContent = data.roomId.slice(0, 8).toUpperCase();
    unlockAudio();
    await loadDevices();
    await startMicrophone();
    openSocket();
  } catch (error) { setStatus(error.message, true); }
}

async function loadDevices() {
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { $("audioState").textContent = "بدون إذن الميكروفون"; }
  state.devices = await navigator.mediaDevices.enumerateDevices();
  const input = $("inputDevice");
  const output = $("outputDevice");
  input.innerHTML = "";
  output.innerHTML = "";
  state.devices.filter(device => device.kind === "audioinput").forEach(device => input.add(new Option(device.label || "Microphone", device.deviceId)));
  state.devices.filter(device => device.kind === "audiooutput").forEach(device => output.add(new Option(device.label || "Speaker", device.deviceId)));
  state.outputId = output.value;
}

async function startMicrophone() {
  try {
    const deviceId = $("inputDevice").value;
    if (state.localStream) state.localStream.getTracks().forEach(track => track.stop());
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    state.localStream.getAudioTracks().forEach(track => track.enabled = !state.muted);
    $("audioState").textContent = state.muted ? "الميكروفون مكتوم" : "الميكروفون جاهز";
    for (const pc of state.connections.values()) { const sender = pc.getSenders().find(item => item.track?.kind === "audio"); if (sender) await sender.replaceTrack(state.localStream.getAudioTracks()[0]); }
  } catch { $("audioState").textContent = "تعذر تشغيل الميكروفون"; }
}

function openSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/socket?token=${encodeURIComponent(state.token)}`);
  state.socket.onopen = () => { $("connectionText").textContent = "متصل"; $("voiceStatus").textContent = "يعمل"; };
  state.socket.onmessage = event => { let message; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "welcome") state.selfId = message.id; if (message.type === "peers") updatePeers(message); if (message.type === "signal") receiveSignal(message); };
  state.socket.onclose = () => { $("connectionText").textContent = "انقطع الاتصال"; $("voiceStatus").textContent = "متوقف"; for (const pc of state.connections.values()) pc.close(); state.connections.clear(); };
}

function updatePeers(message) {
  state.self = message.self;
  $("nearCount").textContent = message.peers.length;
  $("peerCount").textContent = message.peers.length;
  const next = new Map(message.peers.map(peer => [peer.id, peer]));
  for (const peer of message.peers) { state.peers.set(peer.id, peer); if (!state.connections.has(peer.id)) createPeer(peer, state.selfId < peer.id); applyPeerAudio(peer); }
  for (const [id, pc] of state.connections) if (!next.has(id)) { pc.close(); state.connections.delete(id); state.peers.delete(id); document.getElementById(`audio-${id}`)?.remove(); state.audioRoutes.delete(id); }
  state.peers = next;
  renderPeople(message.peers);
  renderMap(message.peers, message.self.position);
}

function createPeer(peer, initiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  state.connections.set(peer.id, pc);
  state.localStream?.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  pc.onicecandidate = event => { if (event.candidate) send({ type: "signal", targetId: peer.id, payload: { candidate: event.candidate } }); };
  pc.ontrack = event => { const audio = document.getElementById(`audio-${peer.id}`) || document.body.appendChild(Object.assign(document.createElement("audio"), { id: `audio-${peer.id}`, autoplay: true, playsInline: true })); audio.srcObject = event.streams[0]; applyOutput(audio); applyPeerAudio(state.peers.get(peer.id) || peer); audio.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) { pc.close(); state.connections.delete(peer.id); } };
  if (initiator) pc.createOffer().then(offer => pc.setLocalDescription(offer).then(() => send({ type: "signal", targetId: peer.id, payload: { description: pc.localDescription } }))).catch(() => {});
}

async function receiveSignal(message) {
  const peer = state.peers.get(message.fromId) || { id: message.fromId, username: "Player", distance: 50, muted: false };
  let pc = state.connections.get(message.fromId);
  if (!pc) { createPeer(peer, false); pc = state.connections.get(message.fromId); }
  try {
    if (message.payload.description) { await pc.setRemoteDescription(message.payload.description); if (message.payload.description.type === "offer") { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); send({ type: "signal", targetId: message.fromId, payload: { description: pc.localDescription } }); } }
    if (message.payload.candidate) await pc.addIceCandidate(message.payload.candidate);
  } catch {}
}

function renderPeople(peers) {
  const list = $("peopleList");
  if (!peers.length) { list.innerHTML = '<div class="empty-state">لا يوجد لاعب ضمن نطاق السماع حاليًا</div>'; return; }
  list.innerHTML = peers.sort((a, b) => a.distance - b.distance).map(peer => `<div class="person-row"><div class="person-avatar">${initials(peer.username)}</div><div><div class="person-name"><i class="status-dot ${peer.muted ? "muted" : ""}"></i>${peer.username}</div><div class="person-meta">${peer.muted ? "الميكروفون مكتوم" : peer.radio ? `موجة ${peer.radioChannel}` : "صوت قريب"}</div></div><div class="distance">${peer.radio ? "RADIO" : `${peer.distance} م`}</div><div class="meter"><i style="width:${peer.radio ? 100 : Math.max(8, 100 - peer.distance * 2)}%"></i></div></div>`).join("");
}

function renderMap(peers, selfPosition) {
  const map = $("mapPoints");
  map.innerHTML = peers.map(peer => { const dx = peer.position.x - selfPosition.x; const dz = peer.position.z - selfPosition.z; const left = 50 + Math.max(-42, Math.min(42, dx / 50 * 42)); const top = 50 + Math.max(-42, Math.min(42, dz / 50 * 42)); return `<div class="map-point ${peer.muted ? "muted" : ""}" style="left:${left}%;top:${top}%"><span class="map-point-label">${peer.username}</span></div>`; }).join("");
}

function unlockAudio() { if (!state.audioContext) state.audioContext = new AudioContext(); if (state.audioContext.state === "suspended") state.audioContext.resume().catch(() => {}); }
function radioCurve() { const curve = new Float32Array(256); for (let i = 0; i < curve.length; i++) { const x = i * 2 / curve.length - 1; curve[i] = Math.tanh(x * 2.4) * 0.75; } return curve; }
function applyPeerAudio(peer) {
  const audio = document.getElementById(`audio-${peer.id}`);
  if (!audio) return;
  unlockAudio();
  let route = state.audioRoutes.get(peer.id);
  if (!route) {
    const source = state.audioContext.createMediaElementSource(audio);
    const filter = state.audioContext.createBiquadFilter();
    const compressor = state.audioContext.createDynamicsCompressor();
    const shaper = state.audioContext.createWaveShaper();
    const gain = state.audioContext.createGain();
    source.connect(filter).connect(compressor).connect(shaper).connect(gain).connect(state.audioContext.destination);
    route = { filter, compressor, shaper, gain };
    state.audioRoutes.set(peer.id, route);
  }
  const radio = Boolean(peer.radio);
  route.filter.type = radio ? "bandpass" : "allpass";
  route.filter.frequency.value = radio ? 1500 : 1000;
  route.filter.Q.value = radio ? 0.8 : 0.1;
  route.compressor.threshold.value = radio ? -25 : 0;
  route.compressor.ratio.value = radio ? 7 : 1;
  route.shaper.curve = radio ? radioCurve() : null;
  route.gain.gain.value = radio ? 0.72 : Math.pow(Math.max(0, 1 - peer.distance / 50), 0.72);
}
function applyOutput(audio) { if (state.outputId && typeof audio.setSinkId === "function") audio.setSinkId(state.outputId).catch(() => {}); }
function toggleMute() { state.muted = !state.muted; state.localStream?.getAudioTracks().forEach(track => track.enabled = !state.muted); $("micButton").classList.toggle("active", !state.muted); $("micState").textContent = state.muted ? "مكتوم" : "مفتوح"; $("audioState").textContent = state.muted ? "الميكروفون مكتوم" : "الميكروفون جاهز"; send({ type: "mute", muted: state.muted }); }
function disconnect() { state.socket?.close(); state.localStream?.getTracks().forEach(track => track.stop()); location.reload(); }

$("connectButton").addEventListener("click", connect);
$("roomCode").addEventListener("keydown", event => { if (event.key === "Enter") connect(); });
$("micButton").addEventListener("click", toggleMute);
$("disconnectButton").addEventListener("click", disconnect);
$("inputDevice").addEventListener("change", startMicrophone);
$("outputDevice").addEventListener("change", event => { state.outputId = event.target.value; document.querySelectorAll("audio").forEach(applyOutput); });
const presetCode = new URLSearchParams(location.search).get("code");
if (presetCode) $("roomCode").value = presetCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
