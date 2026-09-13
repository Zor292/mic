const state = {
  token: null,
  socket: null,
  selfId: null,
  self: null,
  peers: new Map(),
  connections: new Map(),
  localStream: null,
  silentTrack: null,
  muted: false,
  devices: [],
  outputId: "",
  radioVolume: Number(
    localStorage.getItem("hlak_radio_volume") || 0.72
  ),
  audioContext: null,
  audioRoutes: new Map(),
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ]
};

const $ = id => document.getElementById(id);
const loginView = $("loginView");
const appView = $("appView");

function setStatus(message, error = false) {
  $("loginStatus").textContent = message;
  $("loginStatus").style.color = error
    ? "#f48f9f"
    : "#64dda8";
}

function initials(name) {
  return (name || "V").slice(0, 1).toUpperCase();
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

async function connect() {
  const code = $("roomCode").value
    .trim()
    .toUpperCase();

  const displayName = $("displayName").value.trim() || "Player";

  if (!/^[A-Z0-9]{6,12}$/.test(code)) {
    return setStatus(
      "أدخل رمزًا صحيحًا من 6 إلى 12 خانة",
      true
    );
  }

  setStatus("جارٍ الاتصال...");

  try {
    const response = await fetch(
      "/api/session/claim",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code,
          displayName
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "تعذر العثور على الرمز"
      );
    }

    state.token = data.token;

    loginView.classList.add("hidden");
    appView.classList.remove("hidden");

    $("identityName").textContent = displayName;
    $("avatarInitial").textContent = initials(displayName);
    $("roomLabel").textContent = data.roomId
      .slice(0, 8)
      .toUpperCase();

    unlockAudio();
    await loadIceServers();
    await loadDevices();
    await startMicrophone();
    openSocket();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadIceServers() {
  try {
    const response = await fetch(
      "/api/ice-config",
      {
        cache: "no-store"
      }
    );

    if (!response.ok) return;

    const data = await response.json();

    if (
      Array.isArray(data.iceServers) &&
      data.iceServers.length
    ) {
      state.iceServers = data.iceServers;
    }
  } catch {}
}

async function loadDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({
      audio: true
    });
  } catch {
    $("audioState").textContent =
      "بدون إذن الميكروفون";
  }

  state.devices =
    await navigator.mediaDevices.enumerateDevices();

  const input = $("inputDevice");
  const output = $("outputDevice");

  input.innerHTML = "";
  output.innerHTML = "";

  state.devices
    .filter(device => device.kind === "audioinput")
    .forEach(device => {
      input.add(
        new Option(
          device.label || "Microphone",
          device.deviceId
        )
      );
    });

  state.devices
    .filter(device => device.kind === "audiooutput")
    .forEach(device => {
      output.add(
        new Option(
          device.label || "Speaker",
          device.deviceId
        )
      );
    });

  state.outputId = output.value;
}

async function startMicrophone() {
  try {
    const deviceId = $("inputDevice").value;

    if (state.localStream) {
      state.localStream
        .getTracks()
        .forEach(track => track.stop());
    }

    state.localStream =
      await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? {
              deviceId: {
                exact: deviceId
              }
            }
          : true
      });

    state.localStream
      .getAudioTracks()
      .forEach(track => {
        track.enabled = !state.muted;
      });

    $("audioState").textContent = state.muted
      ? "الميكروفون مكتوم"
      : "الميكروفون جاهز";

    updateOutgoingTracks();
  } catch {
    $("audioState").textContent =
      "تعذر تشغيل الميكروفون";
  }
}

function openSocket() {
  const protocol =
    location.protocol === "https:"
      ? "wss"
      : "ws";

  state.socket = new WebSocket(
    `${protocol}://${location.host}/socket?token=${encodeURIComponent(state.token)}`
  );

  state.socket.onopen = () => {
    $("connectionText").textContent = "متصل";
    $("voiceStatus").textContent = "يعمل";
  };

  state.socket.onmessage = event => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "welcome") {
      state.selfId = message.id;
    }

    if (message.type === "peers") {
      updatePeers(message);
    }

    if (message.type === "signal") {
      receiveSignal(message);
    }

    if (message.type === "radioBeep") {
      playRadioBeep();
    }
  };

  state.socket.onclose = () => {
    $("connectionText").textContent =
      "انقطع الاتصال";

    $("voiceStatus").textContent = "متوقف";

    for (const pc of state.connections.values()) {
      pc.close();
    }

    state.connections.clear();
  };
}

function updatePeers(message) {
  state.self = message.self;

  if (
    state.muted !== Boolean(message.self?.muted)
  ) {
    setMuted(
      Boolean(message.self?.muted),
      false
    );
  }

  const visiblePeers = message.peers.filter(
    peer => peer.proximity || peer.radio
  );

  $("nearCount").textContent =
    message.peers.filter(
      peer => peer.proximity
    ).length;

  $("peerCount").textContent =
    visiblePeers.length;

  $("radioChannelLabel").textContent =
    message.self.radioChannel
      ? `موجة ${message.self.radioChannel}`
      : "لا توجد موجة";

  const next = new Map(
    message.peers.map(peer => [
      peer.id,
      peer
    ])
  );

  for (const peer of message.peers) {
    state.peers.set(peer.id, peer);

    if (!state.connections.has(peer.id)) {
      createPeer(
        peer,
        state.selfId < peer.id
      );
    }

    applyPeerAudio(peer);
  }

  for (const [id, pc] of state.connections) {
    if (!next.has(id)) {
      pc.close();
      state.connections.delete(id);
      state.peers.delete(id);
      state.audioRoutes.delete(id);
    }
  }

  state.peers = next;
  updateOutgoingTracks();
  renderPeople(visiblePeers);
  renderRadioMembers(visiblePeers);
  renderMap(
    visiblePeers,
    message.self.position
  );
}

function createPeer(peer, initiator) {
  const pc = new RTCPeerConnection({
    iceServers: state.iceServers
  });

  state.connections.set(peer.id, pc);

  const sendTrack = trackForPeer(peer);

  if (sendTrack) {
    pc.addTrack(
      sendTrack,
      new MediaStream([sendTrack])
    );
  }

  pc.onicecandidate = event => {
    if (event.candidate) {
      send({
        type: "signal",
        targetId: peer.id,
        payload: {
          candidate: event.candidate
        }
      });
    }
  };

  pc.ontrack = event => {
    const stream =
      event.streams[0] ||
      new MediaStream([event.track]);

    createAudioRoute(peer.id, stream);
    applyPeerAudio(
      state.peers.get(peer.id) || peer
    );
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      $("connectionText").textContent =
        "فشل اتصال الصوت";
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      [
        "failed",
        "closed",
        "disconnected"
      ].includes(pc.connectionState)
    ) {
      pc.close();
      state.connections.delete(peer.id);
    }
  };

  if (initiator) {
    pc.createOffer()
      .then(offer => {
        return pc
          .setLocalDescription(offer)
          .then(() => {
            send({
              type: "signal",
              targetId: peer.id,
              payload: {
                description:
                  pc.localDescription
              }
            });
          });
      })
      .catch(() => {});
  }
}

async function receiveSignal(message) {
  const peer =
    state.peers.get(message.fromId) || {
      id: message.fromId,
      username: "Player",
      distance: 50,
      muted: false
    };

  let pc = state.connections.get(
    message.fromId
  );

  if (!pc) {
    createPeer(peer, false);
    pc = state.connections.get(
      message.fromId
    );
  }

  try {
    if (message.payload.description) {
      await pc.setRemoteDescription(
        message.payload.description
      );

      if (
        message.payload.description.type ===
        "offer"
      ) {
        const answer =
          await pc.createAnswer();

        await pc.setLocalDescription(answer);

        send({
          type: "signal",
          targetId: message.fromId,
          payload: {
            description: pc.localDescription
          }
        });
      }
    }

    if (message.payload.candidate) {
      await pc.addIceCandidate(
        message.payload.candidate
      );
    }
  } catch {}
}

function renderPeople(peers) {
  const list = $("peopleList");

  if (!peers.length) {
    list.innerHTML =
      '<div class="empty-state">لا يوجد لاعب ضمن نطاق السماع حاليًا</div>';

    return;
  }

  list.innerHTML = peers
    .sort((a, b) => a.distance - b.distance)
    .map(peer => `
      <div class="person-row">
        <div class="person-avatar">
          ${initials(peer.username)}
        </div>
        <div>
          <div class="person-name">
            <i class="status-dot ${
              peer.muted ? "muted" : ""
            }"></i>
            ${peer.username}
          </div>
          <div class="person-meta">
            ${
              peer.muted
                ? "الميكروفون مكتوم"
                : peer.radio
                  ? `موجة ${peer.radioChannel}`
                  : "صوت قريب"
            }
          </div>
        </div>
        <div class="distance">
          ${
            peer.radioOnly
              ? "RADIO"
              : `${peer.distance} م`
          }
        </div>
        <div class="meter">
          <i style="width:${
            peer.radioOnly
              ? 100
              : Math.max(
                  8,
                  100 - peer.distance * 2
                )
          }%"></i>
        </div>
      </div>
    `)
    .join("");
}

function renderRadioMembers(peers) {
  const list = $("radioMemberList");
  const members = peers.filter(
    peer => peer.radio
  );

  $("radioMembersCount").textContent =
    `${members.length} MEMBERS`;

  if (!members.length) {
    list.innerHTML =
      '<div class="empty-state compact">لا توجد موجة نشطة</div>';

    return;
  }

  list.innerHTML = members
    .sort((a, b) => a.distance - b.distance)
    .map(peer => `
      <div class="radio-member">
        <span class="status-dot ${
          peer.muted ? "muted" : ""
        }"></span>
        <strong>${peer.username}</strong>
        <small>
          ${
            peer.muted
              ? "مكتوم"
              : peer.radioTalking
                ? "يتحدث الآن"
                : peer.radioOnly
                  ? "على الموجة"
                  : "راديو وقرب"
          }
        </small>
      </div>
    `)
    .join("");
}

function renderMap(peers, selfPosition) {
  const map = $("mapPoints");

  map.innerHTML = peers
    .map(peer => {
      const dx =
        peer.position.x - selfPosition.x;

      const dz =
        peer.position.z - selfPosition.z;

      const left =
        50 + Math.max(
          -42,
          Math.min(
            42,
            dx / 50 * 42
          )
        );

      const top =
        50 + Math.max(
          -42,
          Math.min(
            42,
            dz / 50 * 42
          )
        );

      return `
        <div class="map-point ${
          peer.muted ? "muted" : ""
        }" style="left:${left}%;top:${top}%">
          <span class="map-point-label">
            ${peer.username}
          </span>
        </div>
      `;
    })
    .join("");
}

function unlockAudio() {
  if (!state.audioContext) {
    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContextClass) return;

    state.audioContext =
      new AudioContextClass();
  }

  if (
    state.audioContext.state ===
    "suspended"
  ) {
    state.audioContext.resume().catch(() => {});
  }
}

function ensureSilentTrack() {
  unlockAudio();

  if (
    state.silentTrack &&
    state.silentTrack.readyState === "live"
  ) {
    return state.silentTrack;
  }

  const destination =
    state.audioContext
      .createMediaStreamDestination();

  const oscillator =
    state.audioContext.createOscillator();

  const gain =
    state.audioContext.createGain();

  gain.gain.value = 0;

  oscillator
    .connect(gain)
    .connect(destination);

  oscillator.start();

  state.silentTrack =
    destination.stream.getAudioTracks()[0];

  return state.silentTrack;
}

function trackForPeer(peer) {
  const microphone =
    state.localStream?.getAudioTracks()[0];

  if (!microphone || state.muted) {
    return ensureSilentTrack();
  }

  if (
    peer?.radioOnly &&
    !state.self?.radioTalking
  ) {
    return ensureSilentTrack();
  }

  return microphone;
}

function updateOutgoingTracks() {
  for (const [id, pc] of state.connections) {
    const sender = pc
      .getSenders()
      .find(item =>
        item.track?.kind === "audio" ||
        !item.track
      );

    if (!sender) continue;

    const track =
      trackForPeer(
        state.peers.get(id)
      );

    sender.replaceTrack(track).catch(() => {});
  }
}

function radioCurve() {
  const curve = new Float32Array(256);

  for (let i = 0; i < curve.length; i++) {
    const x =
      i * 2 / curve.length - 1;

    const saturated =
      Math.tanh(x * 5.2) * 0.82;

    curve[i] =
      Math.round(saturated * 18) / 18;
  }

  return curve;
}

function createAudioRoute(peerId, stream) {
  unlockAudio();

  if (state.audioRoutes.has(peerId)) {
    return;
  }

  const source =
    state.audioContext.createMediaStreamSource(
      stream
    );

  const proximityGain =
    state.audioContext.createGain();

  const highpass =
    state.audioContext.createBiquadFilter();

  const lowpass =
    state.audioContext.createBiquadFilter();

  const compressor =
    state.audioContext
      .createDynamicsCompressor();

  const shaper =
    state.audioContext.createWaveShaper();

  const radioGain =
    state.audioContext.createGain();

  source
    .connect(proximityGain)
    .connect(
      state.audioContext.destination
    );

  source
    .connect(highpass)
    .connect(lowpass)
    .connect(compressor)
    .connect(shaper)
    .connect(radioGain)
    .connect(
      state.audioContext.destination
    );

  state.audioRoutes.set(peerId, {
    highpass,
    lowpass,
    compressor,
    shaper,
    proximityGain,
    radioGain
  });
}

function applyPeerAudio(peer) {
  const route =
    state.audioRoutes.get(peer.id);

  if (!route) return;

  unlockAudio();

  const radio =
    Boolean(peer.radio);

  route.highpass.type = "highpass";
  route.highpass.frequency.value =
    radio ? 420 : 20;
  route.highpass.Q.value =
    radio ? 0.9 : 0.1;

  route.lowpass.type = "lowpass";
  route.lowpass.frequency.value =
    radio ? 1850 : 20000;
  route.lowpass.Q.value =
    radio ? 1.4 : 0.1;

  route.compressor.threshold.value =
    radio ? -38 : 0;

  route.compressor.knee.value =
    radio ? 4 : 30;

  route.compressor.ratio.value =
    radio ? 12 : 1;

  route.compressor.attack.value =
    0.003;

  route.compressor.release.value =
    radio ? 0.12 : 0.25;

  route.shaper.curve =
    radio ? radioCurve() : null;

  const proximityTarget =
    peer.distance <= 50
      ? Math.pow(
          Math.max(
            0,
            1 - peer.distance / 50
          ),
          1.05
        )
      : 0;

  const radioTarget =
    radio && peer.radioTalking
      ? state.radioVolume
      : 0;

  const now =
    state.audioContext.currentTime;

  route.proximityGain.gain
    .cancelScheduledValues(now);

  route.proximityGain.gain
    .setTargetAtTime(
      proximityTarget,
      now,
      0.1
    );

  route.radioGain.gain
    .cancelScheduledValues(now);

  route.radioGain.gain
    .setTargetAtTime(
      radioTarget,
      now,
      radioTarget > 0
        ? 0.025
        : 0.06
    );
}

function applyOutput() {
  if (
    state.outputId &&
    state.audioContext &&
    typeof state.audioContext.setSinkId ===
      "function"
  ) {
    state.audioContext
      .setSinkId(state.outputId)
      .catch(() => {});
  }
}

function playRadioBeep() {
  unlockAudio();

  const oscillator =
    state.audioContext.createOscillator();

  const gain =
    state.audioContext.createGain();

  const now =
    state.audioContext.currentTime;

  oscillator.type = "square";

  oscillator.frequency.setValueAtTime(
    820,
    now
  );

  oscillator.frequency
    .exponentialRampToValueAtTime(
      560,
      now + 0.09
    );

  gain.gain.setValueAtTime(
    0.0001,
    now
  );

  gain.gain
    .exponentialRampToValueAtTime(
      0.08,
      now + 0.006
    );

  gain.gain
    .exponentialRampToValueAtTime(
      0.0001,
      now + 0.1
    );

  oscillator
    .connect(gain)
    .connect(
      state.audioContext.destination
    );

  oscillator.start(now);
  oscillator.stop(now + 0.11);
}

function setMuted(value, notify = true) {
  state.muted = value === true;

  state.localStream
    ?.getAudioTracks()
    .forEach(track => {
      track.enabled = !state.muted;
    });

  updateOutgoingTracks();

  $("micButton")
    .classList
    .toggle("active", !state.muted);

  $("micState").textContent =
    state.muted ? "مكتوم" : "مفتوح";

  $("audioState").textContent =
    state.muted
      ? "الميكروفون مكتوم"
      : "الميكروفون جاهز";

  if (notify) {
    send({
      type: "mute",
      muted: state.muted
    });
  }
}

function toggleMute() {
  setMuted(!state.muted);
}

function disconnect() {
  state.socket?.close();

  state.localStream
    ?.getTracks()
    .forEach(track => track.stop());

  location.reload();
}

$("connectButton").addEventListener(
  "click",
  connect
);

$("roomCode").addEventListener(
  "keydown",
  event => {
    if (event.key === "Enter") {
      connect();
    }
  }
);

$("micButton").addEventListener(
  "click",
  toggleMute
);

$("disconnectButton").addEventListener(
  "click",
  disconnect
);

$("inputDevice").addEventListener(
  "change",
  startMicrophone
);

$("outputDevice").addEventListener(
  "change",
  event => {
    state.outputId = event.target.value;
    applyOutput();
  }
);

$("radioVolumeRange").value =
  Math.round(state.radioVolume * 100);

$("radioVolumeValue").textContent =
  `${Math.round(state.radioVolume * 100)}%`;

$("radioVolumeRange").addEventListener(
  "input",
  event => {
    state.radioVolume =
      Number(event.target.value) / 100;

    localStorage.setItem(
      "hlak_radio_volume",
      state.radioVolume.toString()
    );

    $("radioVolumeValue").textContent =
      `${event.target.value}%`;

    state.peers.forEach(applyPeerAudio);
  }
);

const presetCode =
  new URLSearchParams(location.search)
    .get("code");

if (presetCode) {
  $("roomCode").value =
    presetCode
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12);
}
