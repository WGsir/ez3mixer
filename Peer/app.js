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
const clientUrlInput = document.getElementById("clientUrlInput");
const clientAddUrlBtn = document.getElementById("clientAddUrlBtn");
const clientYoutubeInput = document.getElementById("clientYoutubeInput");
const clientAddYoutubeBtn = document.getElementById("clientAddYoutubeBtn");
const clientTracksList = document.getElementById("clientTracksList");

// 混音器變數 (Host 端)
let masterGain;
let masterAnalyser;
let meterAnimationId;
const channels = new Map();
const keepAliveAudios = new Set(); // 避免 Chrome WebRTC 音訊 GC 問題
const clientTrackMeters = new Map();
let clientMeterAnimationId;
let youtubeApiReadyPromise;
const hostDataConnections = new Map();
const hostYouTubeTrackMap = new Map();
const clientYouTubeTracks = new Map();

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

function extractYouTubeVideoId(url) {
    try {
        const parsedUrl = new URL(url);
        const host = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();

        if (host === "youtu.be") {
            const id = parsedUrl.pathname.split("/").filter(Boolean)[0];
            return id || null;
        }

        if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
            if (parsedUrl.pathname === "/watch") {
                return parsedUrl.searchParams.get("v");
            }

            const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
            if (pathSegments[0] === "embed" || pathSegments[0] === "shorts") {
                return pathSegments[1] || null;
            }
        }
    } catch {
        return null;
    }

    return null;
}

async function ensureYouTubeApiReady() {
    if (window.YT?.Player) {
        return;
    }

    if (!youtubeApiReadyPromise) {
        youtubeApiReadyPromise = new Promise((resolve, reject) => {
            const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
            const script = existingScript || document.createElement("script");

            if (!existingScript) {
                script.src = "https://www.youtube.com/iframe_api";
                script.async = true;
                document.head.appendChild(script);
            }

            script.addEventListener("error", () => {
                reject(new Error("無法載入 YouTube IFrame API"));
            });

            const previousReady = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                previousReady?.();
                resolve();
            };
        });
    }

    await youtubeApiReadyPromise;
}

async function createYouTubePlayer(frameElement, videoId) {
    await ensureYouTubeApiReady();

    return new Promise((resolve) => {
        const player = new window.YT.Player(frameElement, {
            videoId,
            playerVars: {
                autoplay: 0,
                controls: 1,
                rel: 0,
                modestbranding: 1,
                playsinline: 1
            },
            events: {
                onReady: () => resolve(player)
            }
        });
    });
}

function isYouTubePlaying(player) {
    const state = player?.getPlayerState?.();
    return state === window.YT?.PlayerState?.PLAYING || state === window.YT?.PlayerState?.BUFFERING;
}

function buildPeerTrackKey(peerId, trackId) {
    return `${peerId}:${trackId}`;
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
        if (channel.isYouTube) {
            processHostYouTubeQueue(channel);
            if (channel.youtubePlayer && typeof channel.youtubePlayer.getCurrentTime === 'function') {
                const ct = channel.youtubePlayer.getCurrentTime() || 0;
                const dur = channel.youtubePlayer.getDuration() || 0;
                updateHostYouTubeProgress(channel, ct, dur);
            }
        }
        
        const level = getLevelPercent(channel.analyser);
        if (channel.refs && channel.refs.meterFill) {
            channel.refs.meterFill.style.width = `${level}%`;
            channel.refs.meterValue.textContent = `${level}%`;
        }
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
        handleHostDataConnection(conn);
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

function handleHostDataConnection(conn) {
    hostDataConnections.set(conn.peer, conn);
    console.log("Client connected via DataConnection:", conn.peer);

    conn.on('data', (payload) => {
        handleHostControlMessage(conn, payload);
    });

    conn.on('close', () => {
        hostDataConnections.delete(conn.peer);
        removeHostYouTubeChannelsByPeer(conn.peer);
    });

    conn.on('error', () => {
        hostDataConnections.delete(conn.peer);
        removeHostYouTubeChannelsByPeer(conn.peer);
    });
}

function updateHostYouTubeProgress(channel, currentTime, duration) {
    const refs = channel.refs;
    if (!refs?.mediaProgress) {
        return;
    }

    refs.mediaProgress.classList.remove("is-hidden");
    const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const safeCurrentTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    const progressPercent = safeDuration > 0 ? (safeCurrentTime / safeDuration) * 100 : 0;
    const clampedPercent = Math.min(100, Math.max(0, progressPercent));

    refs.progressSeek.disabled = true;
    refs.progressSeek.value = String(Math.round((clampedPercent / 100) * 1000));
    refs.progressSeek.style.setProperty("--progress", `${clampedPercent}%`);
    refs.progressCurrent.textContent = formatClientTime(safeCurrentTime);
    refs.progressDuration.textContent = formatClientTime(safeDuration);
}

function applyHostYouTubeControl(channel, payload) {
    if (!channel?.isYouTube) {
        return;
    }

    if (!channel.controlQueue) {
        channel.controlQueue = [];
    }
    
    channel.controlQueue.push({
        wallTime: performance.now(),
        payload: payload
    });
}

function processHostYouTubeQueue(channel) {
    if (!channel.controlQueue || !channel.youtubePlayer) return;

    const now = performance.now();
    const delayMs = Math.max(0, Number(channel.delaySeconds || 0)) * 1000;
    const processTime = now - delayMs;

    let lastSyncPayload = null;

    while (channel.controlQueue.length > 0 && channel.controlQueue[0].wallTime <= processTime) {
        const item = channel.controlQueue.shift();
        
        if (item.payload.action !== 'sync') {
            executeHostYouTubeCommand(channel, item.payload);
        } else {
            lastSyncPayload = item.payload;
        }
    }

    if (lastSyncPayload) {
        executeHostYouTubeCommand(channel, lastSyncPayload);
    }
}

function executeHostYouTubeCommand(channel, payload) {
    const player = channel.youtubePlayer;
    if (!player) return;

    const action = payload.action;
    const clientTime = Number.isFinite(Number(payload.currentTime)) ? Math.max(0, Number(payload.currentTime)) : 0;
    
    if (action === "seek") {
        player.seekTo(clientTime, true);
    } else if (action === "play") {
        player.seekTo(clientTime, true);
        player.playVideo();
    } else if (action === "pause") {
        player.seekTo(clientTime, true);
        player.pauseVideo();
    } else if (action === "sync") {
        const hostCurrentTime = Number(player.getCurrentTime?.() || 0);
        if (Math.abs(hostCurrentTime - clientTime) > 0.5) {
            player.seekTo(clientTime, true);
        }

        if (payload.isPlaying === true && !isYouTubePlaying(player)) {
            player.playVideo();
        }
        if (payload.isPlaying === false && isYouTubePlaying(player)) {
            player.pauseVideo();
        }
    }
}

async function addHostYouTubeChannel(peerId, trackId, videoId, title) {
    if (!videoId || !trackId) {
        return;
    }

    await ensureAudioInitializedHost();

    const key = buildPeerTrackKey(peerId, trackId);
    const existingChannelId = hostYouTubeTrackMap.get(key);
    if (existingChannelId) {
        removeHostChannel(existingChannelId);
    }

    const clone = channelTemplate.content.firstElementChild.cloneNode(true);
    clone.querySelector(".channel-title").textContent = title || `YouTube: ${videoId}`;
    const sourceBadge = clone.querySelector(".source-badge");
    if (sourceBadge) {
        sourceBadge.textContent = "YouTube（Client 控制）";
    }
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
        mediaProgress: clone.querySelector(".media-progress"),
        progressSeek: clone.querySelector(".progress-seek"),
        progressCurrent: clone.querySelector(".progress-current"),
        progressDuration: clone.querySelector(".progress-duration"),
        youtubePlayer: clone.querySelector(".youtube-player"),
        youtubeFrame: clone.querySelector(".youtube-frame"),
        transportBtn: clone.querySelector(".transport-btn"),
        muteBtn: clone.querySelector(".mute-btn"),
        removeBtn: clone.querySelector(".remove-btn")
    };

    refs.mediaProgress?.classList.remove("is-hidden");
    refs.youtubePlayer?.classList.remove("is-hidden");
    refs.progressSeek.disabled = true;
    refs.transportBtn.disabled = true;
    refs.transportBtn.textContent = "Client 控制";
    refs.pan.disabled = true;
    refs.lp.disabled = true;
    refs.panValue.textContent = "-";
    refs.lpValue.textContent = "-";
    refs.removeBtn.textContent = "移除";
    refs.vol.max = "100";
    refs.vol.value = "100";
    refs.volValue.textContent = "100%";

    const channelId = `yt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const channelData = {
        id: channelId,
        ownerPeerId: peerId,
        remoteTrackId: trackId,
        videoId,
        delaySeconds: 0,
        isYouTube: true,
        isMuted: false,
        refs,
        element: clone,
        analyser: null,
        youtubePlayer: null,
        lastClientTime: 0
    };
    channels.set(channelId, channelData);
    hostYouTubeTrackMap.set(key, channelId);

    refs.vol.addEventListener("input", () => {
        const val = Number(refs.vol.value);
        if (!channelData.isMuted) {
            channelData.youtubePlayer?.setVolume?.(Math.min(100, val));
        }
        refs.volValue.textContent = `${val}%`;
    });

    refs.delay.addEventListener("input", () => {
        const valMs = Number(refs.delay.value);
        channelData.delaySeconds = valMs / 1000;
        refs.delayValue.textContent = `${valMs}ms`;
    });

    refs.muteBtn.addEventListener("click", () => {
        channelData.isMuted = !channelData.isMuted;
        if (channelData.isMuted) {
            channelData.youtubePlayer?.mute?.();
        } else {
            channelData.youtubePlayer?.unMute?.();
            channelData.youtubePlayer?.setVolume?.(Math.min(100, Number(refs.vol.value)));
        }
        refs.muteBtn.textContent = channelData.isMuted ? "取消靜音" : "靜音";
        refs.muteBtn.style.color = channelData.isMuted ? "#fca5a5" : "#e5e7eb";
    });

    refs.removeBtn.addEventListener("click", () => {
        removeHostChannel(channelId);
    });

    try {
        const player = await createYouTubePlayer(refs.youtubeFrame, videoId);
        const channel = channels.get(channelId);
        if (!channel) {
            player.destroy();
            return;
        }

        channel.youtubePlayer = player;
        player.setVolume(Number(refs.vol.value));
        player.pauseVideo();
        updateHostYouTubeProgress(channel, 0, Number(player.getDuration?.() || 0));
    } catch (error) {
        removeHostChannel(channelId);
        hostStatus.textContent = `加入 YouTube 軌道失敗: ${error.message}`;
        hostStatus.style.color = "#fca5a5";
    }
}

function removeHostYouTubeChannelsByPeer(peerId) {
    channels.forEach((channel, channelId) => {
        if (channel.ownerPeerId === peerId && channel.isYouTube) {
            removeHostChannel(channelId);
        }
    });
}

function handleHostControlMessage(conn, payload) {
    if (!payload || typeof payload !== "object") {
        return;
    }

    if (payload.type === "yt-add") {
        addHostYouTubeChannel(conn.peer, payload.trackId, payload.videoId, payload.title);
        return;
    }

    if (payload.type === "yt-remove") {
        const key = buildPeerTrackKey(conn.peer, payload.trackId);
        const channelId = hostYouTubeTrackMap.get(key);
        if (channelId) {
            removeHostChannel(channelId, { notifyClient: false });
        }
        return;
    }

    if (payload.type === "yt-control") {
        const key = buildPeerTrackKey(conn.peer, payload.trackId);
        const channelId = hostYouTubeTrackMap.get(key);
        if (!channelId) {
            return;
        }

        const channel = channels.get(channelId);
        applyHostYouTubeControl(channel, payload);
    }
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

function removeHostChannel(channelId, options = {}) {
    const channel = channels.get(channelId);
    if (!channel) return;

    const notifyClient = options.notifyClient !== false;

    if (notifyClient && channel.isYouTube && channel.ownerPeerId && channel.remoteTrackId) {
        const ownerConn = hostDataConnections.get(channel.ownerPeerId);
        if (ownerConn?.open) {
            ownerConn.send({
                type: "yt-force-remove",
                trackId: channel.remoteTrackId
            });
        }
    }

    if (channel.isYouTube && channel.ownerPeerId && channel.remoteTrackId) {
        const key = buildPeerTrackKey(channel.ownerPeerId, channel.remoteTrackId);
        hostYouTubeTrackMap.delete(key);
    }
    
    channel.sourceNode?.disconnect();
    channel.delay?.disconnect();
    channel.gain?.disconnect();
    channel.filter?.disconnect();
    channel.panner?.disconnect();
    channel.analyser?.disconnect();
    channel.youtubePlayer?.destroy?.();
    
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

    hostConnection.on('data', (payload) => {
        handleClientHostMessage(payload);
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

    clientYouTubeTracks.forEach((track) => {
        track.cleanupAction?.(false);
    });
    clientYouTubeTracks.clear();

    hostConnection = null;
}

function updateClientImportButtons() {
    const hasUrl = clientUrlInput.value.trim().length > 0;
    const hasYouTube = Boolean(extractYouTubeVideoId(clientYoutubeInput.value.trim()));
    clientAddUrlBtn.disabled = clientUrlInput.disabled || !hasUrl;
    clientAddYoutubeBtn.disabled = clientYoutubeInput.disabled || !hasYouTube;
}

clientUrlInput.addEventListener('input', updateClientImportButtons);
clientYoutubeInput.addEventListener('input', updateClientImportButtons);

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
        clientUrlInput.disabled = false;
        clientYoutubeInput.disabled = false;
        updateClientImportButtons();

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

// 傳送網址音訊
clientAddUrlBtn.addEventListener('click', async () => {
    if (!hostId) {
        alert("請先輸入房主 ID");
        return;
    }

    const url = clientUrlInput.value.trim();
    if (!url) {
        return;
    }

    if (extractYouTubeVideoId(url)) {
        alert("偵測到 YouTube 連結，請改用下方的 YouTube 輸入欄。\n此模式會由 Client 控制進度並同步到 Host。");
        return;
    }

    try {
        await ensureAudioInitializedClient();

        const audio = new Audio();
        audio.crossOrigin = "anonymous";
        audio.src = url;
        audio.controls = false;
        audio.loop = false;

        await new Promise((resolve, reject) => {
            const onLoaded = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error("網址音訊載入失敗，可能是連結錯誤或來源未開啟 CORS"));
            };
            const cleanup = () => {
                audio.removeEventListener('loadedmetadata', onLoaded);
                audio.removeEventListener('error', onError);
            };

            audio.addEventListener('loadedmetadata', onLoaded, { once: true });
            audio.addEventListener('error', onError, { once: true });
            audio.load();
        });

        const sourceNode = audioContext.createMediaElementSource(audio);
        const destNode = audioContext.createMediaStreamDestination();
        const analyser = createAnalyser();

        sourceNode.connect(destNode);
        sourceNode.connect(analyser);
        sourceNode.connect(audioContext.destination);

        let title = `網址: ${url}`;
        try {
            const parsedUrl = new URL(url);
            const fileName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || "");
            title = fileName ? `網址: ${fileName}` : `網址: ${parsedUrl.hostname}`;
        } catch {
            // fallback 使用原始 URL
        }

        const call = peer.call(hostId, destNode.stream, { metadata: { title } });
        addClientTrackItem(
            title,
            call,
            null,
            [audio],
            audio,
            analyser,
            [sourceNode, destNode, analyser],
            []
        );

        clientUrlInput.value = '';
        updateClientImportButtons();
    } catch (e) {
        console.error(e);
        alert(`無法傳送網址音訊: ${e.message}`);
    }
});

function sendYouTubeControlToHost(payload) {
    if (!hostConnection?.open) {
        return;
    }
    hostConnection.send(payload);
}

function handleClientHostMessage(payload) {
    if (!payload || typeof payload !== 'object') {
        return;
    }

    if (payload.type === 'yt-force-remove') {
        const track = clientYouTubeTracks.get(payload.trackId);
        if (!track) {
            return;
        }

        track.cleanupAction?.(false);
    }
}

function addClientYouTubeTrack(videoId, rawUrl) {
    const trackId = `yt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const title = `YouTube: ${videoId}`;

    const div = document.createElement('div');
    div.className = 'client-track channel';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'channel-header';
    const nameEl = document.createElement('h3');
    nameEl.className = 'channel-title';
    nameEl.style.margin = '0';
    nameEl.textContent = title;
    headerDiv.appendChild(nameEl);

    const youtubePlayerDiv = document.createElement('div');
    youtubePlayerDiv.className = 'youtube-player';
    const youtubeFrameDiv = document.createElement('div');
    youtubeFrameDiv.className = 'youtube-frame';
    youtubePlayerDiv.appendChild(youtubeFrameDiv);

    const mediaProgress = document.createElement('div');
    mediaProgress.className = 'media-progress';
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
    transportBtn.disabled = true;

    const stopBtn = document.createElement('button');
    stopBtn.className = 'warning';
    stopBtn.textContent = '停止同步';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions';
    actionsDiv.appendChild(transportBtn);
    actionsDiv.appendChild(stopBtn);

    div.appendChild(headerDiv);
    div.appendChild(youtubePlayerDiv);
    div.appendChild(mediaProgress);
    div.appendChild(actionsDiv);
    clientTracksList.appendChild(div);

    let player = null;
    let syncTimerId = null;
    let disposed = false;

    const updateTransportButton = () => {
        if (!player) {
            transportBtn.disabled = true;
            transportBtn.textContent = '播放';
            return;
        }

        transportBtn.disabled = false;
        transportBtn.textContent = isYouTubePlaying(player) ? '暫停' : '播放';
    };

    const updateProgress = () => {
        if (!player) {
            return;
        }

        const duration = Number(player.getDuration?.() || 0);
        const currentTime = Number(player.getCurrentTime?.() || 0);
        const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
        const clampedPercent = Math.min(100, Math.max(0, progressPercent));

        progressSeek.disabled = duration <= 0;
        progressSeek.value = String(Math.round((clampedPercent / 100) * 1000));
        progressSeek.style.setProperty("--progress", `${clampedPercent}%`);
        progressCurrent.textContent = formatClientTime(currentTime);
        progressDuration.textContent = formatClientTime(duration);
    };

    const sendControl = (action) => {
        if (!player) {
            return;
        }

        sendYouTubeControlToHost({
            type: 'yt-control',
            trackId,
            action,
            currentTime: Number(player.getCurrentTime?.() || 0),
            duration: Number(player.getDuration?.() || 0),
            isPlaying: isYouTubePlaying(player)
        });
    };

    const cleanupAction = (notifyHost = true) => {
        if (disposed) {
            return;
        }
        disposed = true;

        if (syncTimerId) {
            clearInterval(syncTimerId);
            syncTimerId = null;
        }

        if (notifyHost) {
            sendYouTubeControlToHost({
                type: 'yt-remove',
                trackId
            });
        }

        player?.destroy?.();
        div.remove();
        clientYouTubeTracks.delete(trackId);
    };

    stopBtn.addEventListener('click', () => cleanupAction(true));

    transportBtn.addEventListener('click', () => {
        if (!player) {
            return;
        }

        if (isYouTubePlaying(player)) {
            player.pauseVideo();
            sendControl('pause');
        } else {
            player.playVideo();
            sendControl('play');
        }

        updateTransportButton();
        updateProgress();
    });

    progressSeek.addEventListener('input', () => {
        if (!player) {
            return;
        }

        const duration = Number(player.getDuration?.() || 0);
        if (duration <= 0) {
            return;
        }

        const percent = Number(progressSeek.value) / 1000;
        player.seekTo(duration * percent, true);
        updateProgress();
        sendControl('seek');
    });

    sendYouTubeControlToHost({
        type: 'yt-add',
        trackId,
        videoId,
        title: `YouTube: ${videoId}`,
        sourceUrl: rawUrl
    });

    createYouTubePlayer(youtubeFrameDiv, videoId)
        .then((createdPlayer) => {
            if (disposed) {
                createdPlayer.destroy();
                return;
            }

            player = createdPlayer;
            player.pauseVideo();

            player.addEventListener('onStateChange', () => {
                updateTransportButton();
                updateProgress();

                const state = player.getPlayerState?.();
                if (state === window.YT?.PlayerState?.PAUSED || state === window.YT?.PlayerState?.ENDED) {
                    sendControl('pause');
                }
                if (state === window.YT?.PlayerState?.PLAYING) {
                    sendControl('play');
                }
            });

            syncTimerId = setInterval(() => {
                if (!player) {
                    return;
                }
                updateProgress();
                sendControl('sync');
            }, 1000);

            updateTransportButton();
            updateProgress();
            sendControl('pause');
        })
        .catch((error) => {
            cleanupAction(true);
            alert(`無法建立 YouTube 軌道: ${error.message}`);
        });

    clientYouTubeTracks.set(trackId, {
        trackId,
        cleanupAction
    });
}

clientAddYoutubeBtn.addEventListener('click', async () => {
    if (!hostId || !hostConnection?.open) {
        alert('請先連線到房主');
        return;
    }

    const inputUrl = clientYoutubeInput.value.trim();
    const videoId = extractYouTubeVideoId(inputUrl);

    if (!videoId) {
        alert('請輸入有效的 YouTube 連結');
        return;
    }

    try {
        await ensureAudioInitializedClient();
        addClientYouTubeTrack(videoId, inputUrl);
        clientYoutubeInput.value = '';
        updateClientImportButtons();
    } catch (error) {
        alert(`無法加入 YouTube 軌道: ${error.message}`);
    }
});
