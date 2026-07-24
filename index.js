import { VideoSDK } from "@videosdk.live/js-sdk";

// --- DOM References ---
const videoContainer = document.getElementById("videoContainer");
const micSelect = document.getElementById("micSelect");
const webcamSelect = document.getElementById("webcamSelect");
const textDiv = document.getElementById("textDiv");
const joinScreenVideoContainer = document.getElementById(
  "join-screen-video-container",
);
const bestCameraInfo = document.getElementById("bestCameraInfo");
const currentCamLabel = document.getElementById("currentCamLabel");

// Buttons
const leaveBtn = document.getElementById("leaveBtn");
const endBtn = document.getElementById("endBtn");
const toggleMicBtn = document.getElementById("toggleMicBtn");
const toggleWebCamBtn = document.getElementById("toggleWebCamBtn");
const switchCamBtn = document.getElementById("switchCamBtn");
const clientBtn = document.getElementById("Client");
const agentBtn = document.getElementById("Agent");
const captureClientImageBtn = document.getElementById("captureClientImageBtn");
const switchClientCamBtn = document.getElementById("switchClientCamBtn");

// Agent image preview
const imagePreviewPanel = document.getElementById("imagePreviewPanel");
const capturedImageEl = document.getElementById("capturedImageEl");
const imageStatusText = document.getElementById("imageStatusText");

// Use meeting ID from config
const VKYC_MEETING_ID = window.VKYC_MEETING_ID;

// PubSub topics
const TOPIC_CAPTURE_IMAGE = "CAPTURE_IMAGE";
const TOPIC_IMAGE_URL = "IMAGE_URL";
const TOPIC_SWITCH_CAM = "SWITCH_CAM";
const TOPIC_SWITCH_CAM_V2 = "SWITCH_CAM_V2";
const TOPIC_CLIENT_CAM_INFO = "CLIENT_CAM_INFO";

// State
let meeting = null;
let currentRole = null;
let currentCameraMode = "front";

// Best cameras detected on join screen
const bestCameras = { front: null, back: null };

// Label + deviceId + facingMode of the camera currently sending video
let activeCameraLabel = null;
let activeCameraDeviceId = null;
let activeCameraFacingMode = null;

function updateCamLabelDisplay(on) {
  currentCamLabel.textContent = on
    ? `Camera (${currentCameraMode}): ${activeCameraLabel || "Unknown"}`
    : "Camera: off";
}

function setActiveCameraFromStream(stream) {
  const track = stream?.getVideoTracks?.()[0] || stream?.track;
  if (track?.label) activeCameraLabel = track.label;
  const settings = track?.getSettings?.() || {};
  if (settings.deviceId) activeCameraDeviceId = settings.deviceId;
  if (settings.facingMode) activeCameraFacingMode = settings.facingMode;
  updateCamLabelDisplay(true);
}

// Ground truth: the video track the SDK is actually sending right now
function getLiveLocalVideoTrack() {
  if (!meeting) return null;
  let live = null;
  meeting.localParticipant.streams?.forEach((s) => {
    if (s.kind === "video" && s.track) live = s.track;
  });
  return live;
}

// Measure (don't assume) which camera ended up enabled after a switch.
// Reads the live sender track; falls back to the custom track we created
// only if it is still alive. Warns when the result differs from what was
// requested — i.e. the switch silently did not take effect.
function reportEnabledCamera(context, requestedDeviceId, targetMode, fallbackStream) {
  let track = getLiveLocalVideoTrack();
  const custom = fallbackStream?.getVideoTracks?.()[0] || null;
  const liveId = track?.getSettings?.().deviceId;
  if ((!track || liveId !== requestedDeviceId) && custom?.readyState === "live") {
    track = custom;
  }

  const settings = track?.getSettings?.() || {};
  if (track?.label) activeCameraLabel = track.label;
  if (settings.deviceId) activeCameraDeviceId = settings.deviceId;
  if (settings.facingMode) activeCameraFacingMode = settings.facingMode;

  // Trust the measured facingMode over our assumed toggle when available
  if (settings.facingMode === "user") currentCameraMode = "front";
  else if (settings.facingMode === "environment") currentCameraMode = "back";
  else currentCameraMode = targetMode;

  updateCamLabelDisplay(true);

  console.log(
    `[Client] ${context} enabled camera → id: ${activeCameraDeviceId}, label: ${activeCameraLabel}, facingMode: ${settings.facingMode || "unknown"}, mode: ${currentCameraMode}`,
  );

  if (
    requestedDeviceId &&
    settings.deviceId &&
    settings.deviceId !== requestedDeviceId
  ) {
    console.warn(
      `[Client] Requested camera ${requestedDeviceId} but the live track is ${settings.deviceId} — the switch DID NOT take effect (device may not allow opening this camera while another is live).`,
    );
  }
}

// Client → Agent: publish camera list + currently enabled camera
async function publishClientCamInfo(type) {
  if (!meeting || currentRole !== "client") return;
  try {
    const cameras = await VideoSDK.getCameras();
    const liveTrack = getLiveLocalVideoTrack();
    const liveSettings = liveTrack?.getSettings?.() || {};
    const payload = {
      type,
      cameras: cameras.map((c) => ({ deviceId: c.deviceId, label: c.label })),
      best: { ...bestCameras },
      enabled: {
        deviceId: liveSettings.deviceId || activeCameraDeviceId,
        label: liveTrack?.label || activeCameraLabel,
        facingMode: liveSettings.facingMode || activeCameraFacingMode || "unknown",
        mode: currentCameraMode,
      },
    };
    meeting.pubSub.publish(TOPIC_CLIENT_CAM_INFO, JSON.stringify(payload), {
      persist: false,
    });
  } catch (e) {
    console.error("[Client] Failed to publish cam info:", e);
  }
}

// Agent: log client camera list / enabled camera
function handleClientCamInfo(message) {
  try {
    const data = JSON.parse(message.message);
    if (data.type === "list") {
      console.log("[Agent] Client camera list (id + label):");
      console.table(data.cameras);
      console.log("[Agent] Client best cameras:", data.best);
      console.log("[Agent] Client enabled camera:", data.enabled);
    } else if (data.type === "switched" || data.type === "enabled") {
      console.log(
        `[Agent] Client camera ${data.type} → mode: ${data.enabled.mode}, facingMode: ${data.enabled.facingMode}, id: ${data.enabled.deviceId}, label: ${data.enabled.label}`,
      );
    }
  } catch (e) {
    console.error("[Agent] Failed to parse client cam info:", e);
  }
}

async function initializeMeeting(token, meetingId, participantName, role) {
  VideoSDK.setLogLevel("DEBUG");
  currentRole = role;

  VideoSDK.config(token);

  // Use best detected front camera for init track
  let customTrack;
  try {
    const cameraId = bestCameras.front || undefined;
    customTrack = await VideoSDK.createCameraVideoTrack({
      cameraId,
      optimizationMode: "motion",
      encoderConfig: "h720p_w1280p",
      multiStream: true,
      bitrateMode: VideoSDK.Constants.BitrateMode.HIGH_QUALITY,
    });
    console.log("video Track ", customTrack);
  } catch (e) {
    console.error("Failed to create custom camera track during init:", e);
  }

  const customAudioTrack = await VideoSDK.createMicrophoneAudioTrack({
    encoderConfig: "high_quality",
    noiseConfig: {
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
  });

  meeting = VideoSDK.initMeeting({
    meetingId,
    name: participantName,
    micEnabled: true,
    webcamEnabled: true,
    multiStream: true,
    customCameraVideoTrack: customTrack,
    customMicrophoneAudioTrack: customAudioTrack,
  });

  meeting.join();

  // Local participant streams
  meeting.localParticipant.on("stream-enabled", (stream) => {
    if (stream.kind === "video") {
      setActiveCameraFromStream(stream);
      // Now there is a real live track to report — refresh the agent's info
      publishClientCamInfo("enabled");
      createVideoElement(meeting.localParticipant, "video", stream);
    } else if (stream.kind === "share")
      createVideoElement(meeting.localParticipant, "share", stream);
  });

  meeting.localParticipant.on("stream-disabled", (stream) => {
    const el = document.getElementById(
      `f-${meeting.localParticipant.id}-${stream.kind}`,
    );
    if (el) el.remove();
  });

  meeting.localParticipant.on("media-status-changed", ({ kind, newStatus }) => {
    if (kind === "audio")
      toggleMicBtn.innerText = newStatus ? "Stop Mic" : "Start Mic";
    else if (kind === "video") {
      toggleWebCamBtn.innerText = newStatus ? "Stop WebCam" : "Start WebCam";
      updateCamLabelDisplay(newStatus);
    }
  });

  // Meeting events
  [
    "meeting-joined",
    "meeting-left",
    "participant-joined",
    "participant-left",
    "error",
  ].forEach((eventName) =>
    meeting.on(eventName, (data) => handleMeetingEvent(eventName, data)),
  );
}

function handleMeetingEvent(name, data) {
  switch (name) {
    case "meeting-joined": {
      console.log("Joined as:", currentRole);
      textDiv.textContent = null;
      document.getElementById("meetingIdHeading").textContent =
        `PEER Id: ${meeting.localParticipant.id} | Meeting: ${meeting.id} | Role: ${currentRole}`;
      document.getElementById("grid-screen").style.display = "block";

      toggleMicBtn.innerText = meeting.localParticipant.micOn
        ? "Stop Mic"
        : "Start Mic";
      toggleWebCamBtn.innerText = meeting.localParticipant.webcamOn
        ? "Stop WebCam"
        : "Start WebCam";

      // Show agent-only UI
      if (currentRole === "agent") {
        captureClientImageBtn.style.display = "inline-block";
        switchClientCamBtn.style.display = "inline-block";
        switchCamBtn.style.display = "inline-block";
        imagePreviewPanel.style.display = "block";
        imageStatusText.textContent = "Waiting for captured image...";

        // Agent subscribes to IMAGE_URL topic to receive image from client
        meeting.pubSub.subscribe(TOPIC_IMAGE_URL, handleImageUrlReceived);

        // Agent subscribes to client camera info (list + enabled cam id)
        meeting.pubSub.subscribe(TOPIC_CLIENT_CAM_INFO, handleClientCamInfo);
      }

      // Client: subscribe to topics
      if (currentRole === "client") {
        meeting.pubSub.subscribe(
          TOPIC_CAPTURE_IMAGE,
          handleCaptureImageRequest,
        );
        meeting.pubSub.subscribe(TOPIC_SWITCH_CAM, handleSwitchCamRequest);
        meeting.pubSub.subscribe(TOPIC_SWITCH_CAM_V2, handleSwitchCamV2);

        // Send camera list to agent
        publishClientCamInfo("list");
      }

      break;
    }

    case "meeting-left": {
      videoContainer.innerHTML = "";
      document.getElementById("grid-screen").style.display = "none";
      document.getElementById("join-screen").style.display = "block";
      captureClientImageBtn.style.display = "none";
      switchClientCamBtn.style.display = "none";
      switchCamBtn.style.display = "none";
      imagePreviewPanel.style.display = "none";
      currentRole = null;
      meeting = null;
      startCameraPreview();
      break;
    }

    case "participant-joined": {
      console.log("participant joined:", data.displayName);

      // Re-send camera list so an agent joining after the client still gets it
      if (currentRole === "client") publishClientCamInfo("list");

      data.on("stream-enabled", (stream) => {
        if (stream.kind === "video") createVideoElement(data, "video", stream);
        else if (stream.kind === "share") createVideoElement(data, "share", stream);
        else if (stream.kind === "audio") createAudioElement(data);
      });

      data.on("stream-disabled", (stream) => {
        const type =
          stream.kind === "share"
            ? "share"
            : stream.kind === "audio"
              ? "audio"
              : "video";

        if (stream.kind !== "audio") {
          stream.pause = () => {
            /* Suppressed race-condition guard */
          };
        }

        const el =
          document.getElementById(`f-${data.id}-${type}`) ||
          document.getElementById(`a-${data.id}`);
        if (el) {
          if (stream.kind !== "audio") {
            const video = el.querySelector("video");
            if (video) video.srcObject = null;
          } else {
            el.srcObject = null;
          }
          el.remove();
        }
      });
      break;
    }

    case "participant-left": {
      data.streams?.forEach((stream) => {
        stream.pause = () => {
          /* Suppressed */
        };
      });
      ["video", "share"].forEach((type) => {
        const el = document.getElementById(`f-${data.id}-${type}`);
        if (el) {
          const video = el.querySelector("video");
          if (video) video.srcObject = null;
          el.remove();
        }
      });
      break;
    }

    default:
      console.log(`[Meeting Event] ${name}`, data);
  }
}

// ─────────────────────────────────────────────
// PubSub Handlers
// ─────────────────────────────────────────────

// Capture own image, upload, and publish URL to agent
async function captureAndPublishImage() {
  if (!meeting) return;

  try {
    const base64Data = await meeting.localParticipant.captureImage();
    if (!base64Data) {
      console.error("[Client] captureImage() returned no data");
      return;
    }

    console.log("[Client] Image captured, uploading...");

    const fileUrl = await meeting.uploadBase64File({
      base64Data,
      token: window.TOKEN,
      fileName: `client-capture-${Date.now()}.jpeg`,
    });

    console.log("[Client] Image uploaded. URL:", fileUrl);

    meeting.pubSub.publish(TOPIC_IMAGE_URL, fileUrl, { persist: false });
  } catch (err) {
    console.error("[Client] Error during image capture/upload:", err);
  }
}

// Client receives pubsub capture request from agent
async function handleCaptureImageRequest(message) {
  console.log("[Client] Capture image request received from agent.");
  await captureAndPublishImage();
}

// Agent receives image URL, fetches base64, displays image
async function handleImageUrlReceived(message) {
  const fileUrl = message.message;
  console.log("[Agent] Image URL received:", fileUrl);
  if (!fileUrl) return;

  try {
    imageStatusText.textContent = "Fetching image...";
    imagePreviewPanel.style.display = "block";

    const base64 = await meeting.fetchBase64File({
      url: fileUrl,
      token: window.TOKEN,
    });

    if (base64) {
      const src = base64.startsWith("data:")
        ? base64
        : `data:image/jpeg;base64,${base64}`;
      capturedImageEl.src = src;
      imageStatusText.textContent = `Captured at ${new Date().toLocaleTimeString()}`;
      console.log("[Agent] Image rendered.");
    } else {
      imageStatusText.textContent = "Failed to fetch image data";
    }
  } catch (err) {
    console.error("[Agent] Error fetching image:", err);
    imageStatusText.textContent = "Error: " + err.message;
  }
}

// Agent: Capture Client Image button
captureClientImageBtn.addEventListener("click", () => {
  if (!meeting) return;
  imageStatusText.textContent = "Requesting capture from client...";
  meeting.pubSub.publish(TOPIC_CAPTURE_IMAGE, "capture", { persist: false });
  console.log("[Agent] Capture image request sent to client");
});

// Agent: Toggle client camera
switchClientCamBtn.addEventListener("click", () => {
  if (!meeting) return;
  meeting.pubSub.publish(TOPIC_SWITCH_CAM, "toggle", { persist: false });
  console.log("[Agent] Requested client to toggle camera");
});

// Resolve when the local video stream comes (back) up, or on timeout
function waitForLocalVideoStream(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        resolve(val);
      }
    };
    setTimeout(() => finish(null), timeoutMs);
    const handler = (stream) => {
      if (stream.kind === "video") {
        finish(stream);
        meeting?.localParticipant?.off?.("stream-enabled", handler);
      }
    };
    meeting.localParticipant.on("stream-enabled", handler);
  });
}

// Shared switch flow: release the current camera BEFORE opening the target.
// Many Android devices cannot open a second camera while one is live —
// with changeWebcam() the new track silently ended up on the same (front)
// camera. Disabling first guarantees the hardware is free.
async function switchToCamera(context, deviceId, targetMode) {
  meeting.disableWebcam();
  await new Promise((r) => setTimeout(r, 300)); // let the device release

  let customTrack;
  try {
    customTrack = await VideoSDK.createCameraVideoTrack({
      cameraId: deviceId,
      optimizationMode: "motion",
      encoderConfig: "h720p_w1280p",
      multiStream: true,
    });
  } catch (err) {
    console.error(
      `[Client] ${context} could not open camera ${deviceId}, restoring previous webcam:`,
      err,
    );
    meeting.enableWebcam();
    return;
  }

  const streamPromise = waitForLocalVideoStream();
  meeting.enableWebcam(customTrack);
  const newStream = await streamPromise;
  if (newStream) setActiveCameraFromStream(newStream);

  reportEnabledCamera(context, deviceId, targetMode, customTrack);
  publishClientCamInfo("switched");
}

// Client: switch camera on agent request (Approach 1 — uses bestCameras)
async function handleSwitchCamRequest(message) {
  const side = message.message;
  console.log(`[Client] Switch cam request (V1): ${side}`);

  if (!meeting) return;

  try {
    const targetMode =
      side === "toggle"
        ? currentCameraMode === "front"
          ? "back"
          : "front"
        : side;

    const deviceId =
      targetMode === "front" ? bestCameras.front : bestCameras.back;

    if (!deviceId) {
      const msg = `No ${targetMode} camera found on this device.`;
      console.warn(`[Client] ${msg}`);
      alert(msg);
      return;
    }

    await switchToCamera("V1", deviceId, targetMode);
  } catch (err) {
    console.error(`[Client] V1 switch failed:`, err);
  }
}

// Client: switch camera on agent request (Approach 2 — uses detected bestCameras)
async function handleSwitchCamV2(message) {
  console.log(`[Client] Switch cam request (V2)`);

  if (!meeting) return;

  try {
    const targetMode = currentCameraMode === "front" ? "back" : "front";
    const deviceId =
      targetMode === "front" ? bestCameras.front : bestCameras.back;

    if (!deviceId) {
      const msg = `No best ${targetMode} camera detected on this device.`;
      console.warn(`[Client] ${msg}`);
      alert(msg);
      return;
    }

    console.log(
      `[Client] V2 switching to best ${targetMode} camera:`,
      deviceId,
    );

    await switchToCamera("V2", deviceId, targetMode);
  } catch (err) {
    console.error(`[Client] V2 switch failed:`, err);
  }
}

// Expose handlers to window for testing
window.handleSwitchCamRequest = handleSwitchCamRequest;
window.handleSwitchCamV2 = handleSwitchCamV2;

// ─────────────────────────────────────────────
// Video / Audio Element Creators
// ─────────────────────────────────────────────
function createAudioElement(participant) {
  if (!participant?.id) return;
  const elementId = `a-${participant.id}`;
  if (document.getElementById(elementId)) return;

  const audioElement = participant.renderAudio({ type: "audio" });
  audioElement.id = elementId;
  audioElement.style.display = "none";
  document.body.appendChild(audioElement);
}

function createVideoElement(participant, type, stream) {
  if (!participant?.id) return;
  const elementId = `f-${participant.id}-${type}`;

  // Tear down any existing tile cleanly before rebuilding
  const existingWrapper = document.getElementById(elementId);
  if (existingWrapper) {
    const oldVideo = existingWrapper.querySelector("video");
    if (oldVideo) {
      oldVideo.pause();
      oldVideo.srcObject = null;
    }
    existingWrapper.remove();
  }

  // ─── Use stream.track directly (like the working reference example) ───────
  // We do NOT use renderVideo() because the SDK manages that element's play()
  // internally, which races with our own play() calls and causes AbortErrors.
  const mediaStream = new MediaStream();
  if (stream?.track) mediaStream.addTrack(stream.track);

  const videoElement = document.createElement("video");
  videoElement.id = `v-${participant.id}-${type}`;
  videoElement.setAttribute("playsinline", true);
  videoElement.autoplay = true;
  videoElement.srcObject = mediaStream;
  videoElement.play().catch((err) => {
    // Only log real errors, not expected interruptions during track swaps
    if (err.name !== "AbortError") console.error("[Video] play() failed:", err);
  });
  // ─────────────────────────────────────────────────────────────────────────

  const wrapper = document.createElement("div");
  wrapper.id = elementId;
  wrapper.className = `video-tile ${participant.displayName === "Client" ? "client-tile" : ""}`;
  wrapper.appendChild(videoElement);

  const nameLabel = document.createElement("div");
  nameLabel.className = "participant-name";
  nameLabel.innerText = `${participant.displayName || participant.id}${type === "share" ? " (Screen Share)" : ""}`;

  if (type === "video") {
    const micOnSvg = `<svg width="18" height="18"><use xlink:href="#icon-mic-on"></use></svg>`;
    const micOffSvg = `<svg width="18" height="18"><use xlink:href="#icon-mic-off"></use></svg>`;
    const micIcon = document.createElement("span");
    micIcon.className = "mic-icon";
    micIcon.id = `mic-${participant.id}`;
    micIcon.innerHTML = participant.micOn ? micOnSvg : micOffSvg;
    nameLabel.appendChild(micIcon);

    participant.on("media-status-changed", ({ kind, newStatus }) => {
      if (kind === "audio")
        micIcon.innerHTML = newStatus ? micOnSvg : micOffSvg;
    });
  }

  wrapper.appendChild(nameLabel);

  if (meeting && participant.id === meeting.localParticipant.id) {
    videoContainer.prepend(wrapper);
  } else {
    videoContainer.appendChild(wrapper);
  }
}

// ─────────────────────────────────────────────
// Join Buttons
// ─────────────────────────────────────────────
clientBtn.addEventListener("click", async () => {
  const token = window.TOKEN;
  if (!token) {
    alert("TOKEN is missing in config.js");
    return;
  }

  document.getElementById("join-screen").style.display = "none";
  stopPreviewStream();
  textDiv.textContent = "Please wait, joining as Client...";

  try {
    await initializeMeeting(token, VKYC_MEETING_ID, "Client", "client");
  } catch (err) {
    alert("Failed to join meeting: " + err.message);
    console.error(err);
    document.getElementById("join-screen").style.display = "block";
    textDiv.textContent = "";
  }
});

agentBtn.addEventListener("click", async () => {
  const token = window.TOKEN;
  if (!token) {
    alert("TOKEN is missing in config.js");
    return;
  }

  document.getElementById("join-screen").style.display = "none";
  stopPreviewStream();
  textDiv.textContent = "Please wait, joining as Agent...";

  try {
    await initializeMeeting(token, VKYC_MEETING_ID, "Agent", "agent");
  } catch (err) {
    alert("Failed to join meeting: " + err.message);
    console.error(err);
    document.getElementById("join-screen").style.display = "block";
    textDiv.textContent = "";
  }
});

// ─────────────────────────────────────────────
// Main Controls
// ─────────────────────────────────────────────
leaveBtn.addEventListener("click", () => meeting?.leave());
endBtn.addEventListener("click", () => meeting?.end());

toggleMicBtn.addEventListener("click", () => {
  if (meeting?.localParticipant.micOn) meeting?.muteMic();
  else meeting?.unmuteMic();
});

toggleWebCamBtn.addEventListener("click", async () => {
  if (meeting?.localParticipant.webcamOn) meeting?.disableWebcam();
  else await meeting?.enableWebcam();
});

switchCamBtn.addEventListener("click", () => {
  if (!meeting) return;
  meeting.pubSub.publish(TOPIC_SWITCH_CAM_V2, "toggle", { persist: false });
  console.log("[Approach 2] Sent toggle pubsub to client on SWITCH_CAM_V2");
});

function setJoinButtonsEnabled(enabled) {
  clientBtn.disabled = !enabled;
  agentBtn.disabled = !enabled;
}

// Explicitly request camera + mic permission so device labels and
// facingMode are available before we probe each camera.
async function requestMediaPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    console.error("Media permission request failed:", err);
    return false;
  }
}

async function detectBestCameras() {
  const timingEl = document.getElementById("cameraTimingBox");
  if (!timingEl) return { front: null, back: null };

  const globalStart = performance.now();
  let logText = "Camera Detection Started...\n\n";

  setJoinButtonsEnabled(false);
  bestCameraInfo.textContent = "Detecting best cameras…";

  const hasPermission = await requestMediaPermission();
  if (!hasPermission) {
    const msg =
      "Camera/mic permission denied. Allow access and reload the page.";
    bestCameraInfo.textContent = msg;
    timingEl.innerText = msg;
    return { front: null, back: null };
  }

  try {
    const cameras = await VideoSDK.getCameras();
    if (!cameras || cameras.length === 0) {
      timingEl.innerText = "No cameras detected.";
      bestCameraInfo.textContent = "No cameras detected.";
      setJoinButtonsEnabled(true);
      return { front: null, back: null };
    }

    logText += `Total Cameras: ${cameras.length}\n\n`;

    const results = [];

    for (const [index, cam] of cameras.entries()) {
      const camStart = performance.now();
      logText += `Camera #${index + 1}: ${cam.label || "Unknown"}\n`;

      try {
        const stream = await VideoSDK.createCameraVideoTrack({
          cameraId: cam.deviceId,
          optimizationMode: "motion",
          encoderConfig: "h720p_w1280p",
          multiStream: false,
        });

        console.log("video Track ", stream);
        const track = stream?.getVideoTracks?.()[0];
        if (!track) {
          logText += `   No track\n\n`;
          continue;
        }

        const settings = track.getSettings();
        const capabilities = track.getCapabilities?.() || {};
        const maxWidth = capabilities.width?.max || settings.width;
        const maxHeight = capabilities.height?.max || settings.height;
        const facingMode = settings.facingMode;

        const score = (maxWidth || 0) * (maxHeight || 0);
        const camTime = (performance.now() - camStart).toFixed(2);

        console.log(
          `[Camera Detection] #${index + 1} "${cam.label || "Unknown"}" → max ${maxWidth}x${maxHeight}, facingMode=${facingMode || "unknown"}, score=${maxWidth}×${maxHeight}=${score}, probe time=${camTime}ms`,
        );

        logText += `   Time: ${camTime} ms\n`;
        logText += `   ${maxWidth}x${maxHeight}\n`;
        logText += `   facingMode:${facingMode || "unknown"} | score:${score}\n\n`;

        results.push({
          deviceId: cam.deviceId,
          label: cam.label,
          facingMode,
          score,
        });
        track.stop();
      } catch (e) {
        logText += `   Failed (${(performance.now() - camStart).toFixed(2)} ms)\n\n`;
        console.warn(
          `[Camera Detection] #${index + 1} "${cam.label || "Unknown"}" failed to open:`,
          e,
        );
      }
    }

    const front = results
      .filter((c) => c.facingMode === "user")
      .sort((a, b) => b.score - a.score)[0];
    const back = results
      .filter((c) => c.facingMode === "environment")
      .sort((a, b) => b.score - a.score)[0];

    // Fallback logic
    const sortedAll = [...results].sort((a, b) => b.score - a.score);
    const frontPick = front || sortedAll[0] || null;
    const backPick = back || sortedAll[1] || null;
    bestCameras.front = frontPick?.deviceId || null;
    bestCameras.back = backPick?.deviceId || null;

    // Full calculation dump: ranking, picks, and how each was chosen
    console.log(
      "[Camera Detection] Ranking by score (score = maxWidth × maxHeight):",
    );
    console.table(
      sortedAll.map((c, rank) => ({
        rank: rank + 1,
        label: c.label,
        facingMode: c.facingMode || "unknown",
        score: c.score,
        deviceId: c.deviceId,
      })),
    );
    console.log(
      `[Camera Detection] Best front pick: ${frontPick ? `"${frontPick.label}" (${front ? "highest-score facingMode=user" : "fallback: highest score overall"})` : "None"}`,
    );
    console.log(
      `[Camera Detection] Best back pick : ${backPick ? `"${backPick.label}" (${back ? "highest-score facingMode=environment" : "fallback: 2nd highest score overall"})` : "None"}`,
    );

    const totalTime = (performance.now() - globalStart).toFixed(2);
    logText += `Best Front: ${frontPick?.label || bestCameras.front || "None"}\n`;
    logText += `Best Back : ${backPick?.label || bestCameras.back || "None"}\n\n`;
    logText += `Total Detection Time: ${totalTime} ms\n`;
    timingEl.innerText = logText;

    // Print best cameras + remaining cameras on the join screen, unlock join
    const others = results.filter(
      (c) =>
        c.deviceId !== bestCameras.front && c.deviceId !== bestCameras.back,
    );
    let infoText = `Best Front: ${frontPick?.label || "None"} | Best Back: ${backPick?.label || "None"}`;
    if (others.length) {
      infoText += `\nOther cameras:\n${others
        .map((c) => `• ${c.label || c.deviceId} (score ${c.score})`)
        .join("\n")}`;
    }
    bestCameraInfo.textContent = infoText;
    setJoinButtonsEnabled(true);

    // Also log to console so timings are visible without opening the debug panel
    console.log(`[Camera Detection] Finished in ${totalTime} ms\n` + logText);
    return bestCameras;
  } catch (err) {
    timingEl.innerText = `Error during detection\nTime: ${(performance.now() - globalStart).toFixed(2)} ms`;
    bestCameraInfo.textContent = "Camera detection failed — see console.";
    setJoinButtonsEnabled(true);
    console.error("detectBestCameras failed:", err);
    return { front: null, back: null };
  }
}

async function initDevices() {
  if (!VideoSDK) return;
  try {
    const cameras = await VideoSDK.getCameras();
    const mics = await VideoSDK.getMicrophones();

    // Populate Webcam select with ALL cameras
    webcamSelect.innerHTML = "";
    cameras.forEach((cam, i) => {
      webcamSelect.appendChild(
        new Option(cam.label || `Camera ${i + 1}`, cam.deviceId),
      );
    });

    // Populate Mic select with all mics
    if (mics) {
      micSelect.innerHTML = "";
      mics.forEach((mic, i) => {
        micSelect.appendChild(
          new Option(mic.label || `Mic ${i + 1}`, mic.deviceId),
        );
      });
    }

    startCameraPreview();
  } catch (e) {
    console.error("Error initializing devices:", e);
  }
}

let previewStream = null;

function stopPreviewStream() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
}

async function startCameraPreview() {
  stopPreviewStream();

  try {
    previewStream = await VideoSDK.createCameraVideoTrack({
      deviceId: webcamSelect.value ? webcamSelect.value : null,
      optimizationMode: "motion",
      encoderConfig: "h720p_w1280p",
      multiStream: true,
      bitrateMode: VideoSDK.Constants.BitrateMode.HIGH_QUALITY,
    });
    joinScreenVideoContainer.innerHTML = "";
    const video = document.createElement("video");
    video.srcObject = previewStream;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
      "width:100%; height:auto; border-radius:8px; background:black;";
    joinScreenVideoContainer.appendChild(video);
  } catch (e) {
    console.error("Preview error:", e);
  }
}

webcamSelect.addEventListener("change", () => startCameraPreview());

// Initialize on load
window.addEventListener("load", async () => {
  await detectBestCameras();
  await initDevices();
});
