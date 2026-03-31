import { VideoSDK } from "@videosdk.live/js-sdk";

// --- DOM References ---
const videoContainer = document.getElementById("videoContainer");
const micSelect = document.getElementById("micSelect");
const webcamSelect = document.getElementById("webcamSelect");
const textDiv = document.getElementById("textDiv");
const joinScreenVideoContainer = document.getElementById(
  "join-screen-video-container",
);

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

// State
let meeting = null;
let currentRole = null;
let currentCameraMode = "front";

// Best cameras detected on join screen
const bestCameras = { front: null, back: null };

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
    if (stream.kind === "video")
      createVideoElement(meeting.localParticipant, "video");
    else if (stream.kind === "share")
      createVideoElement(meeting.localParticipant, "share");
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
    else if (kind === "video")
      toggleWebCamBtn.innerText = newStatus ? "Stop WebCam" : "Start WebCam";
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
      }

      // Client: subscribe to topics
      if (currentRole === "client") {
        meeting.pubSub.subscribe(
          TOPIC_CAPTURE_IMAGE,
          handleCaptureImageRequest,
        );
        meeting.pubSub.subscribe(TOPIC_SWITCH_CAM, handleSwitchCamRequest);
        meeting.pubSub.subscribe(TOPIC_SWITCH_CAM_V2, handleSwitchCamV2);
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

      data.on("stream-enabled", (stream) => {
        if (stream.kind === "video") createVideoElement(data, "video");
        else if (stream.kind === "share") createVideoElement(data, "share");
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

    const customTrack = await VideoSDK.createCameraVideoTrack({
      cameraId: deviceId,
      optimizationMode: "motion",
      encoderConfig: "h720p_w1280p",
      multiStream: true,
    });

    console.log("video Track ", customTrack);

    await meeting.changeWebcam(customTrack);

    currentCameraMode = targetMode;

    console.log(`[Client] V1 switched to ${targetMode} (${deviceId})`);
  } catch (err) {
    console.error(`[Client] V1 switch failed:`, err);
  }
}

// Client: switch camera on agent request (Approach 2 — uses getCameras first/last)
async function handleSwitchCamV2(message) {
  console.log(`[Client] Switch cam request (V2)`);

  if (!meeting) return;

  try {
    const cameras = await VideoSDK.getCameras();
    if (!cameras || cameras.length === 0) return;

    let deviceId;
    let targetMode;

    if (currentCameraMode === "front") {
      deviceId = cameras[cameras.length - 1].deviceId;
      console.log("Lets select this ", cameras[cameras.length - 1]);
      targetMode = "back";
    } else {
      deviceId = cameras[0].deviceId;
      console.log("Lets select this ", cameras[0]);
      targetMode = "front";
    }

    if (!deviceId) {
      console.warn(`[Client] No ${targetMode} camera available`);
      return;
    }

    const customTrack = await VideoSDK.createCameraVideoTrack({
      cameraId: deviceId,
      optimizationMode: "motion",
      encoderConfig: "h720p_w1280p",
      multiStream: true,
    });

    console.log("video Track ", customTrack);

    await meeting.changeWebcam(customTrack);
    currentCameraMode = targetMode;
    console.log(`[Client] V2 switched to ${targetMode} (${deviceId})`);
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

function createVideoElement(participant, type) {
  if (!participant?.id) return;
  const elementId = `f-${participant.id}-${type}`;
  const existingWrapper = document.getElementById(elementId);
  const videoElement = participant.renderVideo({ type, maxQuality: "auto" });
  videoElement.id = `v-${participant.id}-${type}`;

  if (existingWrapper) {
    const oldVideo = existingWrapper.querySelector("video");
    if (oldVideo) {
      oldVideo.srcObject = videoElement.srcObject;
    } else {
      existingWrapper.prepend(videoElement);
    }
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.id = elementId;
  wrapper.className = `video-tile ${
    participant.displayName === "Client" ? "client-tile" : ""
  }`;
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

async function detectBestCameras() {
  const timingEl = document.getElementById("cameraTimingBox");
  if (!timingEl) return { front: null, back: null };

  const globalStart = performance.now();
  let logText = "Camera Detection Started...\n\n";

  try {
    const cameras = await VideoSDK.getCameras();
    if (!cameras || cameras.length === 0) {
      timingEl.innerText = "No cameras detected.";
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
    bestCameras.front = front?.deviceId || sortedAll[0]?.deviceId || null;
    bestCameras.back = back?.deviceId || sortedAll[1]?.deviceId || null;

    const totalTime = (performance.now() - globalStart).toFixed(2);
    logText += `Best Front ID: ${front?.label || bestCameras.front || "None"}\n`;
    logText += `Best Back ID : ${back?.label || bestCameras.back || "None"}\n\n`;
    logText += `Total Time: ${totalTime} ms\n`;
    timingEl.innerText = logText;

    console.log("[Camera Detection] Deep detect finished:", bestCameras);
    return bestCameras;
  } catch (err) {
    timingEl.innerText = `Error during detection\nTime: ${(performance.now() - globalStart).toFixed(2)} ms`;
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
  detectBestCameras(); // Run in background to speed up initial load
  initDevices();
});
