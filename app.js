const initAudioBtn = document.getElementById("initAudioBtn");
const addChannelBtn = document.getElementById("addChannelBtn");
const addFileChannelBtn = document.getElementById("addFileChannelBtn");
const addUrlChannelBtn = document.getElementById("addUrlChannelBtn");
const deviceSelect = document.getElementById("deviceSelect");
const audioFileInput = document.getElementById("audioFileInput");
const audioUrlInput = document.getElementById("audioUrlInput");
const channelsContainer = document.getElementById("channels");
const statusEl = document.getElementById("status");
const masterVolume = document.getElementById("masterVolume");
const masterVolumeValue = document.getElementById("masterVolumeValue");
const masterMeterFill = document.getElementById("masterMeterFill");
const masterMeterValue = document.getElementById("masterMeterValue");
const channelTemplate = document.getElementById("channelTemplate");

let audioContext;
let masterGain;
let masterAnalyser;
let meterAnimationId;
const channels = new Map();

function setStatus(message) {
  statusEl.textContent = message;
}

function toGain(value) {
  return Number(value) / 100;
}

function updateMasterVolume() {
  if (!masterGain) {
    return;
  }
  const percent = Number(masterVolume.value);
  masterGain.gain.value = toGain(percent);
  masterVolumeValue.textContent = `${percent}%`;
}

function createAnalyser() {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  return analyser;
}

function getLevelPercent(analyser) {
  if (!analyser) {
    return 0;
  }

  const buffer = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buffer);

  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const sample = (buffer[index] - 128) / 128;
    sum += sample * sample;
  }

  const rms = Math.sqrt(sum / buffer.length);
  return Math.min(100, Math.round(rms * 140));
}

function paintMeter(fillEl, valueEl, level) {
  fillEl.style.width = `${level}%`;
  valueEl.textContent = `${level}%`;
}

function updateMeters() {
  if (!audioContext) {
    return;
  }

  paintMeter(masterMeterFill, masterMeterValue, getLevelPercent(masterAnalyser));

  channels.forEach((channel) => {
    const level = getLevelPercent(channel.analyser);
    paintMeter(channel.refs.meterFill, channel.refs.meterValue, level);
  });

  meterAnimationId = requestAnimationFrame(updateMeters);
}

function ensureMeterLoop() {
  if (!meterAnimationId) {
    meterAnimationId = requestAnimationFrame(updateMeters);
  }
}

function updateImportButtons() {
  const isReady = Boolean(audioContext);
  addFileChannelBtn.disabled = !isReady || audioFileInput.files.length === 0;
  addUrlChannelBtn.disabled = !isReady || audioUrlInput.value.trim().length === 0;
}

function createChannelNodes() {
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 20000;
  const panner = audioContext.createStereoPanner();
  panner.pan.value = 0;
  const analyser = createAnalyser();

  gain.connect(filter);
  filter.connect(panner);
  panner.connect(analyser);
  analyser.connect(masterGain);

  return { gain, filter, panner, analyser };
}

function appendChannelElement(title, sourceType) {
  const clone = channelTemplate.content.firstElementChild.cloneNode(true);
  clone.querySelector(".channel-title").textContent = title;
  clone.querySelector(".source-badge").textContent = sourceType;
  channelsContainer.appendChild(clone);

  return {
    element: clone,
    refs: {
      vol: clone.querySelector(".vol"),
      volValue: clone.querySelector(".vol-value"),
      pan: clone.querySelector(".pan"),
      panValue: clone.querySelector(".pan-value"),
      lp: clone.querySelector(".lp"),
      lpValue: clone.querySelector(".lp-value"),
      meterFill: clone.querySelector(".meter-fill"),
      meterValue: clone.querySelector(".meter-value"),
      mediaProgress: clone.querySelector(".media-progress"),
      progressSeek: clone.querySelector(".progress-seek"),
      progressCurrent: clone.querySelector(".progress-current"),
      progressDuration: clone.querySelector(".progress-duration"),
      transportBtn: clone.querySelector(".transport-btn"),
      muteBtn: clone.querySelector(".mute-btn"),
      removeBtn: clone.querySelector(".remove-btn")
    }
  };
}

function registerChannel(channel) {
  const channelId = `ch-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  channels.set(channelId, channel);
  wireChannelUI(channelId, channel.refs);
  ensureMeterLoop();
  return channelId;
}

async function ensureAudioInitialized() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterAnalyser = createAnalyser();
    masterGain.connect(audioContext.destination);
    masterGain.connect(masterAnalyser);
    updateMasterVolume();
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  await navigator.mediaDevices.getUserMedia({ audio: true });
  await refreshDevices();
  updateImportButtons();
  ensureMeterLoop();
}

async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");

  deviceSelect.innerHTML = "";
  inputs.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent =
      device.label || `輸入裝置 ${index + 1}`;
    deviceSelect.appendChild(option);
  });

  const hasInputs = inputs.length > 0;
  deviceSelect.disabled = !hasInputs;
  addChannelBtn.disabled = !hasInputs;
  setStatus(hasInputs ? `已載入 ${inputs.length} 個輸入裝置` : "找不到輸入裝置");
}

function removeChannel(channelId) {
  const channel = channels.get(channelId);
  if (!channel) {
    return;
  }

  channel.stream?.getTracks().forEach((track) => track.stop());
  channel.mediaElement?.pause();
  if (channel.mediaElement) {
    channel.mediaElement.src = "";
    channel.mediaElement.load();
  }
  if (channel.objectUrl) {
    URL.revokeObjectURL(channel.objectUrl);
  }
  channel.source.disconnect();
  channel.gain.disconnect();
  channel.filter.disconnect();
  channel.panner.disconnect();
  channel.analyser.disconnect();
  channel.element.remove();
  channels.delete(channelId);
}

function updateTransportButton(channel) {
  if (!channel.refs.transportBtn) {
    return;
  }

  if (!channel.mediaElement) {
    channel.refs.transportBtn.disabled = true;
    channel.refs.transportBtn.textContent = "播放";
    return;
  }

  channel.refs.transportBtn.disabled = false;
  channel.refs.transportBtn.textContent = channel.mediaElement.paused ? "播放" : "暫停";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function updateProgressUI(channel) {
  if (!channel.refs.mediaProgress) {
    return;
  }

  if (!channel.mediaElement) {
    channel.refs.mediaProgress.classList.add("is-hidden");
    channel.refs.progressSeek.disabled = true;
    return;
  }

  channel.refs.mediaProgress.classList.remove("is-hidden");

  const duration = Number.isFinite(channel.mediaElement.duration)
    ? channel.mediaElement.duration
    : 0;
  const currentTime = Number.isFinite(channel.mediaElement.currentTime)
    ? channel.mediaElement.currentTime
    : 0;
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  channel.refs.progressSeek.disabled = duration <= 0;
  channel.refs.progressSeek.value = String(Math.round((Math.min(100, Math.max(0, progressPercent)) / 100) * 1000));
  channel.refs.progressSeek.style.setProperty("--progress", `${Math.min(100, Math.max(0, progressPercent))}%`);
  channel.refs.progressCurrent.textContent = formatTime(currentTime);
  channel.refs.progressDuration.textContent = formatTime(duration);
}

function wireChannelUI(channelId, refs) {
  const channel = channels.get(channelId);
  if (!channel) {
    return;
  }

  refs.vol.addEventListener("input", () => {
    const value = Number(refs.vol.value);
    channel.gain.gain.value = toGain(value);
    refs.volValue.textContent = `${value}%`;
  });

  refs.pan.addEventListener("input", () => {
    const value = Number(refs.pan.value) / 100;
    channel.panner.pan.value = value;
    refs.panValue.textContent = value.toFixed(2);
  });

  refs.lp.addEventListener("input", () => {
    const value = Number(refs.lp.value);
    channel.filter.frequency.value = value;
    refs.lpValue.textContent = `${value}`;
  });

  refs.muteBtn.addEventListener("click", () => {
    channel.isMuted = !channel.isMuted;
    channel.gain.gain.value = channel.isMuted ? 0 : toGain(Number(refs.vol.value));
    refs.muteBtn.textContent = channel.isMuted ? "取消靜音" : "靜音";
  });

  refs.removeBtn.addEventListener("click", () => {
    removeChannel(channelId);
  });

  refs.transportBtn.addEventListener("click", async () => {
    if (!channel.mediaElement) {
      return;
    }

    try {
      if (channel.mediaElement.paused) {
        await channel.mediaElement.play();
      } else {
        channel.mediaElement.pause();
      }
      updateTransportButton(channel);
    } catch (error) {
      setStatus(`播放控制失敗：${error.message}`);
    }
  });

  refs.progressSeek.addEventListener("input", () => {
    if (!channel.mediaElement || !Number.isFinite(channel.mediaElement.duration) || channel.mediaElement.duration <= 0) {
      return;
    }

    const percent = Number(refs.progressSeek.value) / 1000;
    channel.mediaElement.currentTime = channel.mediaElement.duration * percent;
    updateProgressUI(channel);
  });

  if (channel.mediaElement) {
    channel.mediaElement.addEventListener("play", () => updateTransportButton(channel));
    channel.mediaElement.addEventListener("pause", () => updateTransportButton(channel));
    channel.mediaElement.addEventListener("ended", () => updateTransportButton(channel));
    channel.mediaElement.addEventListener("timeupdate", () => updateProgressUI(channel));
    channel.mediaElement.addEventListener("loadedmetadata", () => updateProgressUI(channel));
    channel.mediaElement.addEventListener("durationchange", () => updateProgressUI(channel));
    channel.mediaElement.addEventListener("seeking", () => updateProgressUI(channel));
    channel.mediaElement.addEventListener("seeked", () => updateProgressUI(channel));
  }

  updateTransportButton(channel);
  updateProgressUI(channel);
}

function createMediaElementFromSource(sourceUrl, { loop = false } = {}) {
  const mediaElement = new Audio();
  mediaElement.crossOrigin = "anonymous";
  mediaElement.loop = loop;
  mediaElement.preload = "auto";
  mediaElement.src = sourceUrl;
  mediaElement.load();
  return mediaElement;
}

async function addMediaElementChannel({ title, sourceType, mediaElement, objectUrl }) {
  const source = audioContext.createMediaElementSource(mediaElement);
  const { gain, filter, panner, analyser } = createChannelNodes();
  source.connect(gain);

  const { element, refs } = appendChannelElement(title, sourceType);

  registerChannel({
    source,
    gain,
    filter,
    panner,
    analyser,
    mediaElement,
    objectUrl,
    element,
    refs,
    isMuted: false
  });
}

async function addChannel() {
  if (!audioContext || audioContext.state !== "running") {
    setStatus("請先啟用音訊");
    return;
  }

  const deviceId = deviceSelect.value;
  if (!deviceId) {
    setStatus("請先選擇輸入裝置");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });

    const source = audioContext.createMediaStreamSource(stream);
    const { gain, filter, panner, analyser } = createChannelNodes();

    source.connect(gain);

    const deviceText =
      deviceSelect.options[deviceSelect.selectedIndex]?.textContent || "輸入裝置";
    const { element, refs } = appendChannelElement(deviceText, "麥克風");

    registerChannel({
      stream,
      source,
      gain,
      filter,
      panner,
      analyser,
      element,
      refs,
      isMuted: false
    });

    setStatus(`已加入軌道：${deviceText}`);
  } catch (error) {
    setStatus(`加入軌道失敗：${error.message}`);
  }
}

async function addFileChannels() {
  if (!audioContext || audioContext.state !== "running") {
    setStatus("請先啟用音訊");
    return;
  }

  const files = Array.from(audioFileInput.files || []);
  if (files.length === 0) {
    setStatus("請先選擇音訊檔案");
    return;
  }

  let addedCount = 0;

  for (const file of files) {
    try {
      const objectUrl = URL.createObjectURL(file);
      const mediaElement = createMediaElementFromSource(objectUrl);
      await addMediaElementChannel({
        title: `檔案：${file.name}`,
        sourceType: "音訊檔案",
        mediaElement,
        objectUrl
      });
      addedCount += 1;
    } catch (error) {
      setStatus(`加入檔案失敗：${file.name}，${error.message}`);
    }
  }

  if (addedCount > 0) {
    audioFileInput.value = "";
    updateImportButtons();
    setStatus(`已加入 ${addedCount} 個音訊檔案軌道（預設暫停）`);
  }
}

async function addUrlChannel() {
  if (!audioContext || audioContext.state !== "running") {
    setStatus("請先啟用音訊");
    return;
  }

  const url = audioUrlInput.value.trim();
  if (!url) {
    setStatus("請先輸入音訊網址");
    return;
  }

  try {
    const mediaElement = createMediaElementFromSource(url, { loop: false });
    await addMediaElementChannel({
      title: `網址：${url}`,
      sourceType: "音訊網址",
      mediaElement
    });
    audioUrlInput.value = "";
    updateImportButtons();
    setStatus("已加入網址音訊軌道（預設暫停）");
  } catch (error) {
    setStatus(`加入網址失敗：${error.message}。請確認該網址允許跨來源存取。`);
  }
}

initAudioBtn.addEventListener("click", async () => {
  initAudioBtn.disabled = true;
  setStatus("初始化中...");

  try {
    await ensureAudioInitialized();
    setStatus("音訊已啟用");
  } catch (error) {
    setStatus(`無法啟用音訊：${error.message}`);
  } finally {
    initAudioBtn.disabled = false;
  }
});

addChannelBtn.addEventListener("click", addChannel);
addFileChannelBtn.addEventListener("click", addFileChannels);
addUrlChannelBtn.addEventListener("click", addUrlChannel);
masterVolume.addEventListener("input", updateMasterVolume);
audioFileInput.addEventListener("change", updateImportButtons);
audioUrlInput.addEventListener("input", updateImportButtons);

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (audioContext) {
    refreshDevices().catch((error) => setStatus(`更新裝置失敗：${error.message}`));
  }
});