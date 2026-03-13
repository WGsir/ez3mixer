// 共用變數
let mode = null; // 'host' or 'client'
let peer = null;
let audioContext = null;

// DOM Elements - 共用
const btnHostMode = document.getElementById("btnHostMode");
const btnClientMode = document.getElementById("btnClientMode");
const hostSection = document.getElementById("hostSection");
const clientSection = document.getElementById("clientSection");

// DOM Elements - Host
const hostIdDisplay = document.getElementById("hostIdDisplay");
const hostInitAudioBtn = document.getElementById("hostInitAudioBtn");
const hostStatus = document.getElementById("hostStatus");
const masterVolume = document.getElementById("masterVolume");
const masterVolumeValue = document.getElementById("masterVolumeValue");
const masterMeterFill = document.getElementById("masterMeterFill");
const masterMeterValue = document.getElementById("masterMeterValue");
const channelsContainer = document.getElementById("channels");
const channelTemplate = document.getElementById("channelTemplate");

// DOM Elements - Client
const remoteIdInput = document.getElementById("remoteIdInput");
const clientConnectBtn = document.getElementById("clientConnectBtn");
const clientDisconnectBtn = document.getElementById("clientDisconnectBtn"); // 新增這行
const clientStatus = document.getElementById("clientStatus");
const clientControls = document.getElementById("clientControls");
const clientInitAudioBtn = document.getElementById("clientInitAudioBtn");
const clientDeviceSelect = document.getElementById("clientDeviceSelect");
const clientAddMicBtn = document.getElementById("clientAddMicBtn");
const clientFileInput = document.getElementById("clientFileInput");
const clientAddFileBtn = document.getElementById("clientAddFileBtn");
const clientTracksList = document.getElementById("clientTracksList");

// 混音器變數 (Host 端)
let masterGain;
let masterAnalyser;
let meterAnimationId;
const channels = new Map();
const keepAliveAudios = new Set(); // 避免 Chrome WebRTC 音訊 GC 問題
const clientTrackMeters = new Map();
let clientMeterAnimationId;

// UI 切換邏輯
btnHostMode.addEventListener('click', () => {
    mode = 'host';
    document.getElementById("modeSelection").style.display = 'none';
    hostSection.style.display = 'block';
    initHost();
});

btnClientMode.addEventListener('click', () => {
    mode = 'client';
    document.getElementById("modeSelection").style.display = 'none';
    clientSection.style.display = 'block';
    initClient();
});

// ====== 音訊核心功能 (Host) ======
function toGain(value) {
    return Number(value) / 100;
}

function updateMasterVolume() {
    if (!masterGain) return;
    const percent = Number(masterVolume.value);
    masterGain.gain.value = toGain(percent);
    masterVolumeValue.textContent = `${percent}%`;
}

masterVolume.addEventListener('input', updateMasterVolume);

function createAnalyser() {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    return analyser;
}

function getLevelPercent(analyser) {
    if (!analyser) return 0;
    const buffer = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
        const sample = (buffer[i] - 128) / 128;
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / buffer.length);
    return Math.min(100, Math.round(rms * 140));
}

function formatClientTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function ensureClientMeterLoop() {
    if (!clientMeterAnimationId) {
        clientMeterAnimationId = requestAnimationFrame(updateClientTrackMeters);
    }
}

function updateClientTrackMeters() {
    if (!audioContext || clientTrackMeters.size === 0) {
        clientMeterAnimationId = null;
        return;
    }

    clientTrackMeters.forEach((meterObj) => {
        const level = getLevelPercent(meterObj.analyser);
        meterObj.meterFill.style.width = `${level}%`;
        meterObj.meterValue.textContent = `${level}%`;
    });

    clientMeterAnimationId = requestAnimationFrame(updateClientTrackMeters);
}

function updateMeters() {
    if (!audioContext) return;
    const masterLevel = getLevelPercent(masterAnalyser);
    masterMeterFill.style.width = `${masterLevel}%`;
    masterMeterValue.textContent = `${masterLevel}%`;

    channels.forEach((channel) => {
        const level = getLevelPercent(channel.analyser);
        channel.refs.meterFill.style.width = `${level}%`;
        channel.refs.meterValue.textContent = `${level}%`;
    });

    meterAnimationId = requestAnimationFrame(updateMeters);
}

// ====== Host 邏輯 ======

async function ensureAudioInitializedHost() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        masterGain = audioContext.createGain();
        masterAnalyser = createAnalyser();
        masterGain.connect(masterAnalyser);
        masterGain.connect(audioContext.destination);
        updateMasterVolume();
    }
    if (audioContext.state !== "running") {
        await audioContext.resume();
    }
    if (!meterAnimationId) {
        meterAnimationId = requestAnimationFrame(updateMeters);
    }
}

hostInitAudioBtn.addEventListener('click', async () => {
    try {
        await ensureAudioInitializedHost();
        hostStatus.innerHTML = "音訊系統已啟用 (Ready)";
        hostStatus.style.color = "#a7f3d0";
        hostInitAudioBtn.disabled = true;
    } catch (e) {
        hostStatus.innerHTML = `無法啟用音訊: ${e.message}`;
        hostStatus.style.color = "#fca5a5";
    }
});

function generateRandomId(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function initHost(attempt = 1) {
    const id = generateRandomId(8);
    hostIdDisplay.textContent = '產生中...';
    peer = new Peer(id);
    
    peer.on('open', (assignedId) => {
        hostIdDisplay.textContent = assignedId;
    });

    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            console.warn(`ID "${id}" 已被占用，重新產生... (第 ${attempt} 次)`);
            peer.destroy();
            peer = null;
            setTimeout(() => initHost(attempt + 1), 500);
            return;
        }
        hostStatus.textContent = `連線錯誤: ${err.message}`;
        hostStatus.style.color = "#fca5a5";
    });

    // 接受客戶端連線確認 (Data Connection)
    peer.on('connection', (conn) => {
        console.log("Client connected via DataConnection:", conn.peer);
    });

    peer.on('call', (call) => {
        if (!audioContext) {
            console.warn("房主尚未啟用音訊！");
            // 要求呼叫者等待，但 PeerJS 只能 answer
        }

        const trackTitle = call.metadata?.title || '未命名軌道';
        
        call.answer(); // 建立連線，不回傳自己的 stream
        
        let currentChannelId = null;

        call.on('stream', (remoteStream) => {
            console.log('Host received stream: ', trackTitle, remoteStream);
            currentChannelId = addHostMixingChannel(call, remoteStream, trackTitle);
        });

        call.on('close', () => {
            if (currentChannelId) removeHostChannel(currentChannelId);
        });

        call.on('error', () => {
            if (currentChannelId) removeHostChannel(currentChannelId);
        });
    });
}

function createChannelNodes() {
    const delay = audioContext.createDelay(5);
    delay.delayTime.value = 0;
    const gain = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 20000;
    const panner = audioContext.createStereoPanner();
    panner.pan.value = 0;
    const analyser = createAnalyser();

    delay.connect(gain);
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(analyser);
    analyser.connect(masterGain);

    return { delay, gain, filter, panner, analyser };
}

function addHostMixingChannel(call, stream, title) {
    ensureAudioInitializedHost(); // 確保已啟動
    
    // WebRTC 避坑: Chrome gc workaround
    const dummyAudio = new Audio();
    dummyAudio.srcObject = stream;
    keepAliveAudios.add(dummyAudio);
    
    // 連接節點
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const { delay, gain, filter, panner, analyser } = createChannelNodes();
    sourceNode.connect(delay);

    const clone = channelTemplate.content.firstElementChild.cloneNode(true);
    clone.querySelector(".channel-title").textContent = title;
    channelsContainer.appendChild(clone);

    const refs = {
        vol: clone.querySelector(".vol"),
        volValue: clone.querySelector(".vol-value"),
        pan: clone.querySelector(".pan"),
        panValue: clone.querySelector(".pan-value"),
        lp: clone.querySelector(".lp"),
        lpValue: clone.querySelector(".lp-value"),
        delay: clone.querySelector(".delay"),
        delayValue: clone.querySelector(".delay-value"),
        meterFill: clone.querySelector(".meter-fill"),
        meterValue: clone.querySelector(".meter-value"),
        muteBtn: clone.querySelector(".mute-btn"),
        removeBtn: clone.querySelector(".remove-btn")
    };

    const channelId = call.peer + "-" + Date.now();
    const channelData = { id: channelId, call, stream, sourceNode, delay, gain, filter, panner, analyser, dummyAudio, element: clone, refs, isMuted: false };
    channels.set(channelId, channelData);

    // UI 事件綁定
    refs.vol.addEventListener("input", () => {
        const val = Number(refs.vol.value);
        gain.gain.value = channelData.isMuted ? 0 : toGain(val);
        refs.volValue.textContent = `${val}%`;
    });

    refs.pan.addEventListener("input", () => {
        const val = Number(refs.pan.value) / 100;
        panner.pan.value = val;
        refs.panValue.textContent = val.toFixed(2);
    });

    refs.lp.addEventListener("input", () => {
        const val = Number(refs.lp.value);
        filter.frequency.value = val;
        refs.lpValue.textContent = `${val}`;
    });

    refs.delay.addEventListener("input", () => {
        const valMs = Number(refs.delay.value);
        delay.delayTime.value = valMs / 1000;
        refs.delayValue.textContent = `${valMs}ms`;
    });

    refs.muteBtn.addEventListener("click", () => {
        channelData.isMuted = !channelData.isMuted;
        gain.gain.value = channelData.isMuted ? 0 : toGain(Number(refs.vol.value));
        refs.muteBtn.textContent = channelData.isMuted ? "取消靜音" : "靜音";
        refs.muteBtn.style.color = channelData.isMuted ? "#fca5a5" : "#e5e7eb";
    });

    refs.removeBtn.addEventListener("click", () => {
        call.close(); // 中斷通話
        removeHostChannel(channelId);
    });

    return channelId;
}

function removeHostChannel(channelId) {
    const channel = channels.get(channelId);
    if (!channel) return;
    
    channel.sourceNode?.disconnect();
    channel.delay?.disconnect();
    channel.gain?.disconnect();
    channel.filter?.disconnect();
    channel.panner?.disconnect();
    channel.analyser?.disconnect();
    
    if (channel.dummyAudio) {
        channel.dummyAudio.srcObject = null;
        keepAliveAudios.delete(channel.dummyAudio);
    }

    channel.element.remove();
    channels.delete(channelId);
}


// ====== Client 邏輯 ======

let hostId = null;
let hostConnection = null;
let activeClientCalls = [];

function initClient() {
    peer = new Peer();
    
    peer.on('error', (err) => {
        console.error(err);
        handleClientFullDisconnect(`連線錯誤: ${err.message}`);
    });
}

clientConnectBtn.addEventListener('click', () => {
    const val = remoteIdInput.value.trim();
    if (!val) return;
    hostId = val;
    
    clientConnectBtn.disabled = true;
    clientStatus.textContent = "連線中...";
    
    // 建立與房主的 DataConnection 作為在線狀態檢測
    hostConnection = peer.connect(hostId);
    
    hostConnection.on('open', () => {
        clientStatus.textContent = "已成功連線至房間！";
        clientStatus.style.color = "#a7f3d0";
        
        clientConnectBtn.style.display = "none";
        clientDisconnectBtn.style.display = "inline-block";
        remoteIdInput.disabled = true;
        clientControls.classList.remove('is-hidden');
    });

    hostConnection.on('close', () => {
        handleClientFullDisconnect("房主已關閉房間或連線中斷");
    });

    hostConnection.on('error', (err) => {
        handleClientFullDisconnect(`連線發生錯誤: ${err.message}`);
    });
});

clientDisconnectBtn.addEventListener('click', () => {
    if (hostConnection) {
        hostConnection.close();
    }
    handleClientFullDisconnect("已主動斷開連線");
});

function handleClientFullDisconnect(msg = "已斷線") {
    clientStatus.textContent = msg;
    clientStatus.style.color = "#fca5a5";
    clientConnectBtn.style.display = "inline-block";
    clientConnectBtn.disabled = false;
    clientDisconnectBtn.style.display = "none";
    clientControls.classList.add('is-hidden');
    remoteIdInput.disabled = false;
    
    // 斷開所有客戶端已傳送的軌道
    activeClientCalls.forEach(obj => {
        if (typeof obj.cleanupAction === 'function') {
            obj.cleanupAction(false); // false 代表不從陣列中 splice 去動到迴圈
        }
    });
    activeClientCalls = [];
    hostConnection = null;
}

// Client 初始化 Local Audio Context (用來擷取或混音，如果需要的話)
async function ensureAudioInitializedClient() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state !== "running") {
        await audioContext.resume();
    }
}

clientInitAudioBtn.addEventListener('click', async () => {
    try {
        await ensureAudioInitializedClient();
        await navigator.mediaDevices.getUserMedia({ audio: true }); // 要求權限
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === "audioinput");
        
        clientDeviceSelect.innerHTML = "";
        inputs.forEach((d, i) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `麥克風 ${i + 1}`;
            clientDeviceSelect.appendChild(opt);
        });

        const hasInputs = inputs.length > 0;
        clientDeviceSelect.disabled = !hasInputs;
        clientAddMicBtn.disabled = !hasInputs;
        clientFileInput.disabled = false;
        clientAddFileBtn.disabled = false;

        clientInitAudioBtn.disabled = true;
        clientInitAudioBtn.classList.add('active');
        clientInitAudioBtn.textContent = "音訊已啟用";

    } catch (e) {
        console.error(e);
        alert(`無法啟用輸入裝置: ${e.message}`);
    }
});

function addClientTrackItem(
    title,
    call,
    localStreamToStop = null,
    mediaElementsToStop = [],
    mediaElement = null,
    meterAnalyser = null,
    nodesToDisconnect = [],
    objectUrlsToRevoke = []
) {
    const div = document.createElement('div');
    div.className = 'client-track channel'; // 添加 channel class
    
    const nameEl = document.createElement('h3');
    nameEl.className = 'channel-title';
    nameEl.style.margin = '0';
    nameEl.textContent = title;
    
    const stopBtn = document.createElement('button');
    stopBtn.className = 'warning';
    stopBtn.textContent = '停止傳送';

    const meterRow = document.createElement('div');
    meterRow.className = 'control-row meter-control-row';
    meterRow.innerHTML = `
        <label>Level</label>
        <div class="meter" aria-label="Client 軌道音量顯示條">
            <div class="meter-fill"></div>
        </div>
        <output class="meter-value">0%</output>
    `;
    const meterFill = meterRow.querySelector('.meter-fill');
    const meterValue = meterRow.querySelector('.meter-value');

    const mediaProgress = document.createElement('div');
    mediaProgress.className = mediaElement ? 'media-progress' : 'media-progress is-hidden';
    mediaProgress.innerHTML = `
        <div class="progress-bar">
            <input class="progress-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放進度條" />
        </div>
        <div class="progress-time">
            <span class="progress-current">0:00</span>
            <span class="progress-duration">0:00</span>
        </div>
    `;

    const progressSeek = mediaProgress.querySelector('.progress-seek');
    const progressCurrent = mediaProgress.querySelector('.progress-current');
    const progressDuration = mediaProgress.querySelector('.progress-duration');

    const transportBtn = document.createElement('button');
    transportBtn.className = 'transport-btn';
    transportBtn.textContent = '播放';
    transportBtn.disabled = !mediaElement;

    const updateTransportButton = () => {
        if (!mediaElement) {
            transportBtn.disabled = true;
            transportBtn.textContent = '播放';
            return;
        }

        transportBtn.disabled = false;
        transportBtn.textContent = mediaElement.paused ? '播放' : '暫停';
    };

    const updateMediaProgress = () => {
        if (!mediaElement) {
            return;
        }

        const duration = Number.isFinite(mediaElement.duration) ? mediaElement.duration : 0;
        const currentTime = Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0;
        const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
        const clampedPercent = Math.min(100, Math.max(0, progressPercent));

        progressSeek.disabled = duration <= 0;
        progressSeek.value = String(Math.round((clampedPercent / 100) * 1000));
        progressSeek.style.setProperty("--progress", `${clampedPercent}%`);
        progressCurrent.textContent = formatClientTime(currentTime);
        progressDuration.textContent = formatClientTime(duration);
    };

    let isCleaned = false;
    const cleanupAction = (removeFromGlobalArray = true) => {
        if (isCleaned) {
            return;
        }
        isCleaned = true;

        if (call.open) {
            call.close();
        }

        if (localStreamToStop) {
            localStreamToStop.getTracks().forEach(t => t.stop());
        }

        mediaElementsToStop.forEach(el => {
            el.pause();
            el.src = "";
        });

        nodesToDisconnect.forEach((node) => {
            node?.disconnect?.();
        });

        objectUrlsToRevoke.forEach((url) => {
            URL.revokeObjectURL(url);
        });

        if (meterAnalyser) {
            clientTrackMeters.delete(call);
        }

        div.remove();
        
        if (removeFromGlobalArray) {
            activeClientCalls = activeClientCalls.filter(c => c.call !== call);
        }
    };

    stopBtn.addEventListener('click', () => cleanupAction(true));

    // 如果房主主動斷開或踢出這個軌道
    call.on('close', () => cleanupAction(true));
    call.on('error', () => cleanupAction(true));

    // 存入全域陣列供統一斷線使用
    activeClientCalls.push({ call, stopBtn, cleanupAction });

    if (meterAnalyser) {
        clientTrackMeters.set(call, {
            analyser: meterAnalyser,
            meterFill,
            meterValue
        });
        ensureClientMeterLoop();
    }

    const headerDiv = document.createElement('div');
    headerDiv.className = 'channel-header';
    headerDiv.appendChild(nameEl);
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions';
    actionsDiv.appendChild(transportBtn);
    actionsDiv.appendChild(stopBtn);

    div.appendChild(headerDiv);
    div.appendChild(meterRow);
    div.appendChild(mediaProgress);
    div.appendChild(actionsDiv);
    clientTracksList.appendChild(div);

    transportBtn.addEventListener('click', async () => {
        if (!mediaElement) {
            return;
        }

        try {
            if (mediaElement.paused) {
                await mediaElement.play();
            } else {
                mediaElement.pause();
            }
            updateTransportButton();
        } catch (error) {
            alert(`播放控制失敗: ${error.message}`);
        }
    });

    progressSeek.addEventListener('input', () => {
        if (!mediaElement || !Number.isFinite(mediaElement.duration) || mediaElement.duration <= 0) {
            return;
        }

        const percent = Number(progressSeek.value) / 1000;
        mediaElement.currentTime = mediaElement.duration * percent;
        updateMediaProgress();
    });

    if (mediaElement) {
        mediaElement.addEventListener('play', updateTransportButton);
        mediaElement.addEventListener('pause', updateTransportButton);
        mediaElement.addEventListener('ended', updateTransportButton);
        mediaElement.addEventListener('timeupdate', updateMediaProgress);
        mediaElement.addEventListener('loadedmetadata', updateMediaProgress);
        mediaElement.addEventListener('durationchange', updateMediaProgress);
        mediaElement.addEventListener('seeking', updateMediaProgress);
        mediaElement.addEventListener('seeked', updateMediaProgress);
    }

    updateTransportButton();
    updateMediaProgress();
}

// 傳送麥克風
clientAddMicBtn.addEventListener('click', async () => {
    if (!hostId) {
        alert("請先輸入房主 ID");
        return;
    }

    const deviceId = clientDeviceSelect.value;
    try {
        await ensureAudioInitializedClient();

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        const title = `麥克風: ${clientDeviceSelect.options[clientDeviceSelect.selectedIndex]?.textContent || '預設'}`;
        const call = peer.call(hostId, stream, { metadata: { title } });
        const analyserInput = audioContext.createMediaStreamSource(stream);
        const analyser = createAnalyser();
        analyserInput.connect(analyser);
        
        addClientTrackItem(title, call, stream, [], null, analyser, [analyserInput, analyser]);

    } catch (e) {
        console.error(e);
        alert(`無法取得麥克風串流: ${e.message}`);
    }
});

// 傳送音訊檔案
clientAddFileBtn.addEventListener('click', async () => {
    if (!hostId) {
        alert("請先輸入房主 ID");
        return;
    }
    const files = Array.from(clientFileInput.files || []);
    if (files.length === 0) return;

    await ensureAudioInitializedClient();

    for (const file of files) {
        const objectUrl = URL.createObjectURL(file);
        const audio = new Audio();
        audio.src = objectUrl;
        audio.controls = false;
        audio.loop = false;
        
        // 為了讓使用者也能聽見，同時擷取串流，我們可以直接呼叫 captureStream()
        // 或使用 Web Audio API: source -> destination -> peer, source -> audioContext.destination
        const sourceNode = audioContext.createMediaElementSource(audio);
        const destNode = audioContext.createMediaStreamDestination();
        const analyser = createAnalyser();
        
        sourceNode.connect(destNode);
        sourceNode.connect(analyser);
        // 如果也想在 Client 端聽到聲音，取消下一行註解
        sourceNode.connect(audioContext.destination);

        const title = `檔案: ${file.name}`;

        const call = peer.call(hostId, destNode.stream, { metadata: { title } });
        addClientTrackItem(
            title,
            call,
            null,
            [audio],
            audio,
            analyser,
            [sourceNode, destNode, analyser],
            [objectUrl]
        );
    }

    clientFileInput.value = '';
});
