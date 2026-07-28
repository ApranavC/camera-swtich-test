# Camera Switch Test

A VideoSDK.live example app for testing remote camera switching between a **Client** (the device with the cameras) and an **Agent** (the remote controller). Two switch approaches are wired up so their behaviour can be compared side-by-side on the same device.

## Setup

```bash
npm install
# Put your VideoSDK token in a .env file:
#   VITE_VIDEOSDK_TOKEN=your_token_here
npm run dev
```

Open the app in two tabs / devices and join once as **Client** and once as **Agent** (meeting id is fixed in `config.js`).

## The two switch approaches

Both approaches share the same underlying `switchToCamera()` flow — the only difference is **how the target camera is chosen**.

### Approach 1 — `getCameras()` first / last

Agent presses **Switch Cam (V1)** → pubsub topic `SWITCH_CAM` → client runs `handleSwitchCamRequest`.

```js
const cameras = await VideoSDK.getCameras();
const deviceId =
  targetMode === "front"
    ? cameras[0].deviceId                     // first entry = front
    : cameras[cameras.length - 1].deviceId;   // last entry  = back
```

- **Pros:** trivial, no detection step needed.
- **Cons:** relies on the browser's device order. On phones with multiple back lenses the "last" camera could be a telephoto or ultra-wide instead of the main sensor, and on some devices the order isn't stable across sessions.

### Approach 2 — detected `bestCameras`

Agent presses **Switch Cam (V2)** → pubsub topic `SWITCH_CAM_V2` → client runs `handleSwitchCamV2`.

```js
const deviceId =
  targetMode === "front" ? bestCameras.front : bestCameras.back;
```

`bestCameras` is populated on the join screen by `detectBestCameras()`:

1. Request camera + mic permission so device labels and `facingMode` are readable.
2. Open every camera briefly, read its max resolution, score it as `width × height`, then stop the track.
3. Pick the highest-scoring camera with `facingMode === "user"` as `bestCameras.front` (fallback: overall highest score).
4. Pick the highest-scoring camera with `facingMode === "environment"` as `bestCameras.back` (fallback: 2nd highest overall).

Join buttons stay disabled until this finishes.

- **Pros:** picks the camera the OS labels as user/environment and prefers the highest-resolution sensor. Avoids picking a telephoto/ultra-wide by accident.
- **Cons:** slower start (probes every camera), needs camera permission before the meeting begins.

## Shared switch flow

Both approaches call `switchToCamera(context, deviceId, targetMode)`:

```
disableWebcam()
  → wait ~300 ms for the hardware to release
  → VideoSDK.createCameraVideoTrack({ cameraId: target })
  → enableWebcam(customTrack)
  → wait for the local "stream-enabled" event
  → reportEnabledCamera() reads the LIVE sender track
  → publishClientCamInfo("switched")
```

Releasing the current camera before opening the target avoids a hardware conflict on Android, where opening a second camera while one is already live can silently fall back to the original camera. `reportEnabledCamera()` reads the actual live `MediaStreamTrack` (`track.label`, `track.getSettings().deviceId`, `track.getSettings().facingMode`) and logs a `console.warn` when the enabled deviceId doesn't match the requested one — i.e. when the switch didn't take effect.

## Agent-side visibility

The client publishes camera state to the agent on topic `CLIENT_CAM_INFO`:

```json
{
  "type": "list | enabled | switched",
  "cameras": [{ "deviceId": "…", "label": "…" }],
  "best": { "front": "…", "back": "…" },
  "enabled": {
    "deviceId": "…",
    "label": "…",
    "facingMode": "user | environment | unknown",
    "mode": "front | back"
  }
}
```

- `list` — sent on join and when a new participant joins.
- `enabled` — sent when the local video stream first comes up.
- `switched` — sent after every V1/V2 switch.

`mode` is the client's intended toggle; `facingMode` is what the live track actually reports. If they disagree, the switch didn't take effect.

## UI reference

- **Join screen** — `#bestCameraInfo` shows best front / best back / other cameras with scores.
- **In-meeting** — `#currentCamLabel` shows the live camera (e.g. `Camera (back): camera 0, facing back`) or `Camera: off`.
- **Debug panel** — `#cameraTimingBox` (hidden by default) has per-camera probe timings.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Join screen, in-meeting controls, video grid |
| `index.js` | Meeting init, detection, switch flows, pubsub handlers |
| `index.css` | Styling |
| `config.js` | Token + meeting id |
| `vite.config.js` | Dev server config |