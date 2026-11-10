# OtterX camera viewer

Static site (GitHub Pages) for the OtterX vessel cameras, played over WebRTC (WHEP) from MediaMTX at `video.fjordlabs.org`.

- `/otterx003/` — OtterX003 front/rear
- `/otterx004/` — OtterX004 front/rear

Credentials are typed on the page and sent as HTTP Basic auth to the WHEP endpoint; they are not stored in this repo.
To add a vessel, copy `otterx004/index.html` to a new folder, change `data-vessel` and the labels, and link it from `index.html`.

Latency bar (bottom): edge→cloud from MQTT `video/<vessel>/<camera>/latency` on `wss://telemetry.fjordlabs.org/mqtt`, plus network (RTT/2), jitter buffer, decode and display from WebRTC stats in the browser. Camera capture/encode on the vessel is not included in the total.

Controls: Front/Rear buttons (or keys `1`/`2`), Keep ratio/Stretch, double-click for fullscreen. `#rear` in the URL opens the rear camera.
