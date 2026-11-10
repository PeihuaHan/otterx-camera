// OtterX camera viewer: WHEP (WebRTC) playback from MediaMTX at video.fjordlabs.org.
// The vessel id comes from <body data-vessel="otterx003">.
// Credentials are entered on the page and never stored in this repo.

const GATEWAY = "https://video.fjordlabs.org";
const CAMERAS = ["front", "rear"];
const CRED_KEY = "otterx-video-credentials";
const ASPECT_KEY = "otterx-keep-aspect";

const vessel = document.body.dataset.vessel;
const cameraView = document.querySelector(".camera-view");
const message = document.getElementById("stream-message");
const aspectToggle = document.getElementById("aspect-toggle");
const buttons = document.querySelectorAll("[data-camera]");
const layers = Object.fromEntries(
  [...document.querySelectorAll("[data-stream]")].map((l) => [l.dataset.stream, l])
);
const loginEl = document.getElementById("login");
const loginForm = loginEl.querySelector("form");
const loginError = document.getElementById("login-error");

const streamStatus = {};
const players = {};
let selectedCamera = "front";

// ---------- Credentials ----------
function loadCredentials() {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const c = JSON.parse(store.getItem(CRED_KEY) || "null");
      if (c && c.user) return c;
    } catch {}
  }
  return null;
}
function saveCredentials(c, remember) {
  try {
    sessionStorage.setItem(CRED_KEY, JSON.stringify(c));
    if (remember) localStorage.setItem(CRED_KEY, JSON.stringify(c));
    else localStorage.removeItem(CRED_KEY);
  } catch {}
}
function clearCredentials() {
  try { sessionStorage.removeItem(CRED_KEY); localStorage.removeItem(CRED_KEY); } catch {}
}
function authHeader(c) {
  const bytes = new TextEncoder().encode(`${c.user}:${c.pass}`);
  return "Basic " + btoa(String.fromCharCode(...bytes));
}

// ---------- WHEP player ----------
class AuthError extends Error {}

class WhepPlayer {
  constructor(video, onStatus) {
    this.video = video;
    this.onStatus = onStatus;
    this.pc = null;
    this.retryTimer = null;
    this.generation = 0;
  }
  play(url, credentials) {
    this.stop();
    this.url = url;
    this.credentials = credentials;
    this._connect(++this.generation);
  }
  stop() {
    clearTimeout(this.retryTimer);
    this.generation++;
    if (this.pc) { this.pc.close(); this.pc = null; }
    this.video.srcObject = null;
  }
  async _connect(gen) {
    this.onStatus("Connecting…");
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => {
      if (gen !== this.generation) return;
      if (this.video.srcObject !== e.streams[0]) {
        this.video.srcObject = e.streams[0];
        this.video.play().catch(() => {});
      }
    };
    pc.onconnectionstatechange = () => {
      if (gen !== this.generation) return;
      if (pc.connectionState === "connected") this.onStatus("");
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this._retry(gen);
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGathering(pc, 2000);
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", Authorization: authHeader(this.credentials) },
        body: pc.localDescription.sdp,
      });
      if (res.status === 401 || res.status === 403) throw new AuthError("Wrong username or password");
      if (res.status === 404) throw new Error("Stream offline");
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const answer = await res.text();
      if (gen !== this.generation) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      if (gen !== this.generation) return;
      if (err instanceof AuthError) {
        this.stop();
        onAuthFailed(err.message);
        return;
      }
      console.error(err);
      this._retry(gen, err.message);
    }
  }
  _retry(gen, reason) {
    if (gen !== this.generation) return;
    this.onStatus(`Reconnecting…${reason ? " (" + reason + ")" : ""}`);
    if (this.pc) { this.pc.close(); this.pc = null; }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (gen === this.generation) this._connect(++this.generation);
    }, 2000);
  }
}

function waitIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, timeoutMs);
  });
}

// ---------- UI ----------
function updateMessage() {
  const status = streamStatus[selectedCamera];
  if (!status) { message.hidden = true; return; }
  message.querySelector("strong").textContent = status;
  message.querySelector("span").textContent =
    `${vessel.toUpperCase()} · ${selectedCamera[0].toUpperCase() + selectedCamera.slice(1)} camera`;
  message.hidden = false;
}

function selectCamera(camera) {
  selectedCamera = camera;
  for (const [name, layer] of Object.entries(layers)) {
    const on = name === camera;
    layer.classList.toggle("active", on);
    layer.setAttribute("aria-hidden", String(!on));
  }
  buttons.forEach((b) => {
    const on = b.dataset.camera === camera;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  try { history.replaceState(null, "", "#" + camera); } catch {}
  updateMessage();
}

function setKeepAspect(keep) {
  cameraView.classList.toggle("stretch", !keep);
  aspectToggle.textContent = keep ? "Keep ratio" : "Stretch";
  aspectToggle.setAttribute("aria-pressed", String(keep));
  try { localStorage.setItem(ASPECT_KEY, keep ? "1" : "0"); } catch {}
}

function startStreams(credentials) {
  loginEl.hidden = true;
  for (const cam of CAMERAS) {
    if (!players[cam]) {
      const video = layers[cam].querySelector("video");
      players[cam] = new WhepPlayer(video, (status) => {
        if (status) streamStatus[cam] = status; else delete streamStatus[cam];
        if (cam === selectedCamera) updateMessage();
      });
    }
    players[cam].play(`${GATEWAY}/${vessel}/${cam}/whep`, credentials);
  }
}

function onAuthFailed(reason) {
  Object.values(players).forEach((p) => p.stop());
  clearCredentials();
  showLogin(reason);
}

function showLogin(error) {
  loginError.textContent = error || "";
  loginError.hidden = !error;
  loginEl.hidden = false;
  loginForm.elements.user.focus();
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const c = { user: loginForm.elements.user.value.trim(), pass: loginForm.elements.pass.value };
  if (!c.user) return;
  saveCredentials(c, loginForm.elements.remember.checked);
  startStreams(c);
});

document.getElementById("logout").addEventListener("click", () => {
  Object.values(players).forEach((p) => p.stop());
  clearCredentials();
  showLogin();
});

// Hide controls and cursor after 3 s without input.
(function autoHide(ms = 3000) {
  let t;
  const show = () => {
    document.body.classList.remove("idle");
    clearTimeout(t);
    t = setTimeout(() => { if (loginEl.hidden) document.body.classList.add("idle"); }, ms);
  };
  ["mousemove", "touchstart", "keydown"].forEach((ev) => window.addEventListener(ev, show));
  show();
})();

// Double-click toggles fullscreen.
cameraView.addEventListener("dblclick", (e) => {
  if (e.target.closest("button, a, form")) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

// Keyboard: 1/f = front, 2/r = rear.
window.addEventListener("keydown", (e) => {
  if (!loginEl.hidden || e.target.closest("input")) return;
  if (e.key === "1" || e.key === "f") selectCamera("front");
  if (e.key === "2" || e.key === "r") selectCamera("rear");
});

let keepAspect = true;
try { keepAspect = localStorage.getItem(ASPECT_KEY) !== "0"; } catch {}
aspectToggle.addEventListener("click", () => setKeepAspect((keepAspect = !keepAspect)));
setKeepAspect(keepAspect);
buttons.forEach((b) => b.addEventListener("click", () => selectCamera(b.dataset.camera)));
selectCamera(location.hash === "#rear" ? "rear" : "front");

window.addEventListener("pagehide", () => Object.values(players).forEach((p) => p.stop()));

const saved = loadCredentials();
if (saved) startStreams(saved); else showLogin();
