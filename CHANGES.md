# Camera Detection & Switch — Changes from the Base Clone

This document lists every change made to `index.html` and `index.js` on top of the
original cloned code, what each change does, and **why** it was needed.

---

## 1. `index.html` changes

### 1.1 Join buttons start disabled

```html
<button id="Client" disabled>Join Meeting as Client</button>
<button id="Agent" disabled>Join Meeting as Agent</button>
```

**Why:** The app picks the best front/back camera on the join screen and uses that
camera for the initial meeting track. If a user could press *Join* before detection
finished, they would join with an undetected/default camera and camera switching
(which relies on `bestCameras`) would have nothing to work with. The buttons are
re-enabled from JS only after `detectBestCameras()` completes.

### 1.2 Best-camera info element on the join screen

```html
<p id="bestCameraInfo" style="font-size: 13px; margin: 8px 0; white-space: pre-line">
  Detecting best cameras…
</p>
```

**Why:** Detection results were previously only written into the hidden debug box
(`#cameraTimingBox`). This element makes the result visible directly on the join
screen: the best front/back picks **plus the list of all other cameras** with their
scores. `white-space: pre-line` lets the multi-line list render from a plain string.

### 1.3 Current camera label inside the meeting

```html
<div id="currentCamLabel" style="font-size: 13px; margin: 4px 0 8px">Camera: —</div>
```

**Why:** During switch testing there was no way to see *which* camera is actually
live. This label shows e.g. `Camera (back): camera 0, facing back`, updates on every
join / switch / webcam toggle, and shows `Camera: off` when the webcam is stopped.

---

## 2. `index.js` changes

### 2.1 Explicit permission request before detection

New helper `requestMediaPermission()` — calls
`navigator.mediaDevices.getUserMedia({ video: true, audio: true })` and immediately
stops the tracks. Called at the very start of `detectBestCameras()`.

**Why:** Without a granted permission, `enumerateDevices()`/`getCameras()` returns
cameras with **empty labels and unstable deviceIds**, and `facingMode` is not
readable — detection would score blind. Requesting permission first guarantees
labels, ids and capabilities are real. If permission is denied, a message is shown
and the join buttons stay locked (joining would fail anyway).

### 2.2 Join gating: `setJoinButtonsEnabled(enabled)`

Buttons are unlocked only after detection finishes (success, "no cameras", or
error). On permission denial they remain locked.

**Why:** See 1.1 — the meeting init and both switch approaches depend on
`bestCameras` being filled.

### 2.3 Best-camera result printed on the join screen

After scoring, the join screen shows:

```
Best Front: camera 1, facing front | Best Back: camera 0, facing back
Other cameras:
• camera 2, facing back (score 2073600)
```

**Why:** Immediate visual confirmation of what detection picked and what it
rejected, without opening the debug panel.

### 2.4 Full calculation logged to console

- One line per probed camera: label, max resolution, `facingMode`, the score math
  (`score=1920×1080=2073600`) and probe time. Failures log a `console.warn` with
  the error.
- A `console.table` of all cameras **ranked by score** (rank, label, facingMode,
  score, deviceId).
- Two lines stating which camera won front/back and *why* (facingMode match vs
  fallback to highest overall score).

**Why:** Makes the selection auditable — when a wrong camera wins you can see the
exact numbers that led there.

### 2.5 Switch Cam V2 now uses the detected best cameras

Old V2 picked `cameras[0]` (front) / `cameras[last]` (back) from `getCameras()`.

**Why:** Device order is arbitrary; on phones with several back lenses "last" could
be a telephoto or ultra-wide. V2 now toggles between `bestCameras.front` and
`bestCameras.back` — same devices detection validated — so V1 and V2 differ only in
their pubsub topic, not in camera choice.

### 2.6 In-meeting active-camera label

State `activeCameraLabel` / `activeCameraDeviceId` / `activeCameraFacingMode` +
`setActiveCameraFromStream()` + `updateCamLabelDisplay()`.

- Updated from the local `stream-enabled` event (covers join, webcam re-enable and
  track changes) and after each switch.
- `media-status-changed` flips the label to `Camera: off` / back on.

**Why:** The values are read from the **live `MediaStreamTrack`**
(`track.label`, `track.getSettings()`), i.e. what the browser is really capturing —
not what we *asked* for. That distinction became critical (see 2.8).

### 2.7 Client → Agent camera telemetry (`CLIENT_CAM_INFO` pubsub topic)

- `publishClientCamInfo(type)` (client): sends a JSON payload with
  - `cameras`: full list of the client's cameras (`deviceId` + `label`),
  - `best`: detected best front/back ids,
  - `enabled`: currently live camera (`deviceId`, `label`, `facingMode`, mode).
  Published as `"list"` on join and when a participant joins (so an agent joining
  *after* the client still receives it), `"enabled"` when the local video stream
  first comes up, and `"switched"` after every V1/V2 switch.
- `handleClientCamInfo` (agent): logs the list as a `console.table` and one line
  per enabled/switched update.

**Why:** The agent drives the switching but previously had zero visibility into
the client's devices — it couldn't tell which camera the client actually turned on.

### 2.8 Ground-truth reporting after a switch

`getLiveLocalVideoTrack()` (reads the actual sender track from
`meeting.localParticipant.streams`) + `reportEnabledCamera()`.

**Why — this fixed a real observed bug:** switch logs showed
`mode: back, id: <front id>, label: camera 1, facing front`. Two flaws caused it:

1. `mode` was our own toggled variable (an *assumption*), while id/label were
   cached values — two unrelated sources that can disagree.
2. The cache was refreshed from the custom track passed to `changeWebcam()`, but
   the SDK **consumes/stops that track** while applying it; a consumed track
   returns empty `label`/`getSettings()` on Android, and `if (label)` guards then
   silently kept the stale front-camera values forever.

`reportEnabledCamera()` therefore *measures* instead of assuming: it reads the live
sender track (falling back to the custom track only while it is still
`readyState === "live"`), derives front/back from the **measured `facingMode`**
(`user` → front, `environment` → back), and logs a loud `console.warn` when the
enabled deviceId differs from the requested one — i.e. when a switch silently did
not take effect.

### 2.9 Release-first switch flow (`switchToCamera()` + `waitForLocalVideoStream()`)

Both V1 and V2 now share one sequence:

```
meeting.disableWebcam()
→ wait ~300 ms for the hardware to release
→ VideoSDK.createCameraVideoTrack({ cameraId: target })
→ meeting.enableWebcam(customTrack)
→ wait for the local "stream-enabled" event
→ report + publish the camera that is REALLY live
```

If opening the target camera fails, the previous webcam is re-enabled so the client
is never left with video off.

**Why:** With the old `createCameraVideoTrack` + `changeWebcam()` flow the logs
proved the camera **never actually switched** — every measurement kept showing
`camera 1, facing front`. Many Android devices cannot open a second camera while
one is live, so the "new" track silently ended up on the same front camera.
Releasing the current camera *before* opening the target removes that hardware
conflict; waiting for `stream-enabled` guarantees the reported values come from the
new, genuinely live track.

---

## 3. Quick reference: pubsub payload (`CLIENT_CAM_INFO`)

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

`mode` = what the app intends/toggles; `facingMode` = what the live track reports.
If the two disagree, the switch did not take effect on the device.
