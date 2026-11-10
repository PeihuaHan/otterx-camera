// Glass-to-glass latency estimate for the selected camera, shown at the bottom middle.
//
//   Edge→Cloud  vessel to video server, published on MQTT video/<vessel>/<camera>/latency
//   Network     video server to this browser, half the WebRTC round-trip time
//   Jitter buf  time frames wait in the browser's jitter buffer
//   Decode      browser decode time per frame
//   Display     frame handed to compositor until it is on screen (requestVideoFrameCallback)
//   Total       sum of the above (camera capture and encode on the vessel are not included)
//
// Relies on globals from camera.js: vessel, players, layers, selectedCamera.

const MQTT_URL = "wss://telemetry.fjordlabs.org/mqtt";
const MQTT_USER = "operator";
const MQTT_PASS = "1234";
const EDGE_STALE_MS = 15000;

const latencyEl = document.getElementById("latency");
const latField = Object.fromEntries(
  [...latencyEl.querySelectorAll("[data-lat]")].map((el) => [el.dataset.lat, el])
);

// ---------- Edge → cloud over MQTT ----------
const edge = {}; // camera -> { ms, min, max, at }

function connectMqtt() {
  if (!window.mqtt) { console.warn("mqtt.js not loaded"); return; }
  const client = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 3000,
    clientId: "otterx-viewer-" + Math.random().toString(16).slice(2, 10),
  });
  client.on("connect", () => client.subscribe(`video/${vessel}/+/latency`));
  client.on("message", (topic, payload) => {
    const cam = topic.split("/")[2];
    try {
      const d = JSON.parse(payload.toString());
      if (typeof d.latency_ms === "number") {
        edge[cam] = { ms: d.latency_ms, min: d.min_ms, max: d.max_ms, at: Date.now() };
      }
    } catch {}
  });
  client.on("error", (e) => console.warn("MQTT", e.message));
}

// ---------- Display delay via requestVideoFrameCallback ----------
const display = {}; // camera -> smoothed ms
function ema(prev, v, a = 0.2) { return prev == null ? v : prev + a * (v - prev); }

function watchFrames(cam, video) {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return;
  const onFrame = (_now, meta) => {
    if (meta.expectedDisplayTime && meta.presentationTime) {
      const d = meta.expectedDisplayTime - meta.presentationTime;
      if (d >= 0 && d < 500) display[cam] = ema(display[cam], d);
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

// ---------- WebRTC stats ----------
const prevStats = {}; // camera -> previous cumulative counters
const rtc = {};       // camera -> latest computed values

async function sampleStats(cam) {
  const pc = players[cam] && players[cam].pc;
  if (!pc || pc.connectionState !== "connected") { delete rtc[cam]; return; }
  const report = await pc.getStats();
  let video, pair, selectedPairId;
  report.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video") video = s;
    if (s.type === "transport" && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId;
  });
  pair = selectedPairId && report.get(selectedPairId);
  if (!pair) report.forEach((s) => { if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s; });
  if (!video) return;

  const p = prevStats[cam];
  const out = {};
  if (pair && pair.currentRoundTripTime != null) out.network = (pair.currentRoundTripTime * 1000) / 2;
  if (video.jitter != null) out.packetJitter = video.jitter * 1000;

  // Use deltas since the last sample so values track current conditions.
  if (p) {
    const emitted = (video.jitterBufferEmittedCount || 0) - p.emitted;
    if (emitted > 0) out.jitterBuffer = (((video.jitterBufferDelay || 0) - p.jbDelay) / emitted) * 1000;
    const decoded = (video.framesDecoded || 0) - p.decoded;
    if (decoded > 0) out.decode = (((video.totalDecodeTime || 0) - p.decodeTime) / decoded) * 1000;
  }
  prevStats[cam] = {
    emitted: video.jitterBufferEmittedCount || 0,
    jbDelay: video.jitterBufferDelay || 0,
    decoded: video.framesDecoded || 0,
    decodeTime: video.totalDecodeTime || 0,
  };
  out.fps = video.framesPerSecond;

  out.display = display[cam] != null ? display[cam] : null;
  rtc[cam] = { ...(rtc[cam] || {}), ...out };
}

// ---------- Render ----------
function fmt(ms) { return ms == null || isNaN(ms) ? "–" : Math.round(ms) + " ms"; }

function render() {
  const cam = selectedCamera;
  const r = rtc[cam];
  const e = edge[cam] && Date.now() - edge[cam].at < EDGE_STALE_MS ? edge[cam] : null;

  if (!r && !e) { latencyEl.hidden = true; return; }
  latencyEl.hidden = false;

  latField.edge.textContent = fmt(e && e.ms);
  latField.edge.parentElement.title =
    "Edge (vessel) to cloud video server, reported over MQTT" +
    (e ? ` — min ${e.min} / max ${e.max} ms` : " — no recent data");
  latField.network.textContent = fmt(r && r.network);
  latField.jitter.innerHTML = fmt(r && r.jitterBuffer) +
    (r && r.packetJitter != null ? ` <small>±${Math.round(r.packetJitter)}</small>` : "");
  latField.decode.textContent = fmt(r && r.decode);
  latField.display.textContent = fmt(r && r.display);

  const parts = [e && e.ms, r && r.network, r && r.jitterBuffer, r && r.decode, r && r.display];
  const known = parts.filter((v) => v != null && !isNaN(v));
  const total = known.reduce((a, b) => a + b, 0);
  const totalEl = latField.total;
  totalEl.textContent = known.length ? Math.round(total) + " ms" + (known.length < parts.length ? "+" : "") : "–";
  totalEl.classList.toggle("warn", total >= 200 && total < 400);
  totalEl.classList.toggle("bad", total >= 400);
}

async function tick() {
  await Promise.all(CAMERAS.map((c) => sampleStats(c).catch(() => {})));
  render();
}

for (const cam of CAMERAS) watchFrames(cam, layers[cam].querySelector("video"));
buttons.forEach((b) => b.addEventListener("click", render));
connectMqtt();
setInterval(tick, 1000);
