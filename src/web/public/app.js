const socket = io('/');
const videoGrid = document.getElementById('video-grid');
const statusMessage = document.getElementById('status-message');
const welcome = document.getElementById('welcome');
const participantCount = document.getElementById('participant-count');
const viewerTotal = document.getElementById('viewer-total');
const viewerList = document.getElementById('viewer-list');
const connectionIndicator = document.getElementById('connection-indicator');
const networkStatus = document.getElementById('network-status');
const ROOM_ID = window.location.pathname.split('/').pop();

const peers = new Map();
const pendingCandidatesByConnection = new Map();
const retryAttempts = new Map();
const retryTimers = new Map();
const maxPeerRetries = 4;
const iceConfigurationReady = loadIceConfiguration();

let iceConfiguration;
let iceConfigurationError;
let localStream = null;
let sessionEnded = false;
let screenPaused = false;
let roomIsOwner = false;
let captureProtectionEnabled = true;
let audioEnabled = false;
let activePipWindow = null;
let activeSharerIds = new Set();
let participantIds = new Set();
let participantProfiles = new Map();
let viewerProfile = { userId: '', displayName: 'Você' };
let viewerId = '';
let mobilePipPlaceholder = null;
let mobilePipCard = null;
let pingMs;
let packetLossPercent;

const shareBtn = document.getElementById('share-btn');
const stopShareBtn = document.getElementById('stop-share-btn');
const pauseShareBtn = document.getElementById('pause-share-btn');
const audioBtn = document.getElementById('audio-btn');
const inviteBtn = document.getElementById('invite-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const welcomeShareBtn = document.getElementById('welcome-share-btn');
const sourceSelect = document.getElementById('source-select');
const qualitySelect = document.getElementById('quality-select');
const systemAudioInput = document.getElementById('system-audio');
const systemAudioOption = document.getElementById('system-audio-option');
const captureDeviceSelect = document.getElementById('capture-device-select');
const captureDeviceLabel = document.getElementById('capture-device-label');
const detectCaptureButton = document.getElementById('detect-capture-btn');
const protectionToggle = document.getElementById('protection-toggle');
const protectionSetting = document.getElementById('protection-setting');
const captureWatermark = document.getElementById('capture-watermark');
const captureBlurNotice = document.getElementById('capture-blur-notice');
const helpDialog = document.getElementById('help-dialog');
const canShareScreen = window.isSecureContext && Boolean(navigator.mediaDevices?.getDisplayMedia);
const canCaptureVideoDevice = Boolean(navigator.mediaDevices?.getUserMedia && navigator.mediaDevices?.enumerateDevices);

document.getElementById('room-qr-image').src = `/api/rooms/${encodeURIComponent(ROOM_ID)}/qr`;
shareBtn.disabled = !canShareScreen;
welcomeShareBtn.disabled = !canShareScreen;
inviteBtn.hidden = true;

if (new URLSearchParams(window.location.search).has('popup')) {
    document.body.classList.add('popup-mode');
}

if (!canShareScreen) {
    document.getElementById('sharing-guidance').textContent =
        'Você pode assistir por aqui. Para compartilhar a tela do celular, use o app Discord.';
}
if (!canCaptureVideoDevice) {
    sourceSelect.querySelector('option[value="capture"]').disabled = true;
}

loadTheme();
loadRoomSession();
updateCaptureCapabilities();
updateCaptureGuard();
startNetworkStats();

socket.on('connect', () => {
    socket.emit('join-room', ROOM_ID);
    connectionIndicator.dataset.state = 'connected';
    connectionIndicator.querySelector('span:last-child').textContent = 'Conectado';
    shareBtn.disabled = sessionEnded || (!canShareScreen && sourceSelect.value !== 'capture');
    setStatus('Entrando na sala...');
});

socket.on('disconnect', () => {
    connectionIndicator.dataset.state = 'connecting';
    connectionIndicator.querySelector('span:last-child').textContent = 'Reconectando...';
    participantIds.clear();
    participantProfiles.clear();
    activeSharerIds.clear();
    closeAllPeers();
    updateRoomUi();
    setStatus('Conexão perdida. Tentando reconectar à sala...');
});

socket.on('connect_error', error => {
    console.error('Não foi possível conectar à sala:', error);
    if (error.message === 'authentication_required') {
        window.location.assign(`/auth/discord?roomId=${encodeURIComponent(ROOM_ID)}`);
        return;
    }
    setStatus('Não foi possível conectar. Verifique a rede e tente atualizar a página.');
});

socket.on('authorization-required', () => {
    window.location.assign(`/auth/discord?roomId=${encodeURIComponent(ROOM_ID)}`);
});

socket.on('room-not-found', () => {
    sessionEnded = true;
    updateRoomUi();
    setStatus('Esta sala não existe mais ou já foi encerrada.');
});

socket.on('room-users', async ({ users, participants = [], sharingUserIds, isOwner, captureProtectionEnabled: roomProtection }) => {
    activeSharerIds = new Set(sharingUserIds);
    participantIds = new Set(users);
    participantProfiles = new Map(participants.map(profile => [profile.socketId, profile]));
    roomIsOwner = Boolean(isOwner);
    captureProtectionEnabled = Boolean(roomProtection);
    protectionSetting.hidden = !roomIsOwner;
    protectionToggle.checked = captureProtectionEnabled;
    updateCaptureGuard();
    renderViewerList();

    if (localStream) {
        await registerCurrentShare();
        users.forEach(connectToViewer);
    } else {
        sharingUserIds.forEach(userId => socket.emit('request-screen', userId));
    }
    updateRoomUi();
});

socket.on('user-connected', participant => {
    const userId = typeof participant === 'string' ? participant : participant.socketId;
    participantIds.add(userId);
    if (typeof participant === 'object' && participant) {
        participantProfiles.set(userId, participant);
    }
    updateRoomUi();
    if (localStream) {
        connectToViewer(userId);
    }
});

socket.on('screen-started', userId => {
    activeSharerIds.add(userId);
    updateRoomUi();
    if (userId === socket.id) {
        return;
    }
    if (localStream) {
        connectToViewer(userId);
    } else {
        socket.emit('request-screen', userId);
    }
});

socket.on('request-screen', ({ from }) => {
    if (localStream && typeof from === 'string') {
        connectToViewer(from);
    }
});

socket.on('offer', async ({ from, connectionId, offer }) => {
    if (typeof connectionId !== 'string' || typeof from !== 'string' || !offer) {
        return;
    }

    try {
        await iceConfigurationReady;
        if (!iceConfiguration) {
            throw iceConfigurationError || new Error('Configuração ICE indisponível.');
        }
        const earlyCandidates = pendingCandidatesByConnection.get(connectionId);
        closePeer(connectionId);
        if (earlyCandidates?.length) {
            pendingCandidatesByConnection.set(connectionId, earlyCandidates);
        }
        const peer = createPeer(connectionId, from, false);
        await peer.connection.setRemoteDescription(offer);
        await addQueuedCandidates(peer, connectionId);
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        socket.emit('answer', { target: from, connectionId, answer: peer.connection.localDescription });
    } catch (error) {
        console.error('Não foi possível receber a transmissão:', error);
        setStatus('Não foi possível conectar à transmissão. Tente novamente ou avise o criador da sala.');
    }
});

socket.on('answer', async ({ connectionId, answer }) => {
    const peer = peers.get(connectionId);
    if (!peer) {
        return;
    }

    try {
        await peer.connection.setRemoteDescription(answer);
        await addQueuedCandidates(peer, connectionId);
    } catch (error) {
        console.error('Não foi possível completar a conexão da transmissão:', error);
        closePeer(connectionId);
    }
});

socket.on('ice-candidate', async ({ connectionId, candidate }) => {
    if (typeof connectionId !== 'string' || !candidate) {
        return;
    }
    const peer = peers.get(connectionId);
    if (!peer) {
        const pending = pendingCandidatesByConnection.get(connectionId) ?? [];
        if (pending.length < 64) {
            pending.push(candidate);
            pendingCandidatesByConnection.set(connectionId, pending);
        }
        return;
    }

    if (!peer.connection.remoteDescription) {
        if (peer.pendingCandidates.length < 64) {
            peer.pendingCandidates.push(candidate);
        }
        return;
    }

    try {
        await peer.connection.addIceCandidate(candidate);
    } catch (error) {
        console.error('Não foi possível adicionar um candidato ICE:', error);
    }
});

socket.on('screen-paused', userId => {
    const peer = findPeerFor(userId);
    if (!peer) {
        return;
    }
    setPausedLabel(peer.video, true);
});

socket.on('screen-resumed', userId => {
    const peer = findPeerFor(userId);
    if (!peer) {
        return;
    }
    setPausedLabel(peer.video, false);
});

socket.on('screen-stopped', handleScreenStopped);
socket.on('user-disconnected', handleUserDisconnected);
socket.on('screen-session-ended', () => {
    sessionEnded = true;
    activeSharerIds.clear();
    stopSharing(false);
    closeAllPeers();
    updateRoomUi();
    setStatus('Esta sala foi encerrada pelo criador.');
});

socket.on('capture-protection-changed', enabled => {
    captureProtectionEnabled = Boolean(enabled);
    protectionToggle.checked = captureProtectionEnabled;
    updateCaptureGuard();
});

socket.on('capture-protection-error', message => {
    protectionToggle.checked = captureProtectionEnabled;
    setStatus(message);
});

socket.on('latency-result', sentAt => {
    if (typeof sentAt !== 'number') {
        return;
    }
    pingMs = Math.max(0, Math.round(performance.now() - sentAt));
    updateNetworkStatus();
});

shareBtn.addEventListener('click', startSharing);
welcomeShareBtn.addEventListener('click', startSharing);
stopShareBtn.addEventListener('click', () => stopSharing());
pauseShareBtn.addEventListener('click', togglePause);
audioBtn.addEventListener('click', toggleRoomAudio);
copyLinkBtn.addEventListener('click', copyInvite);
sourceSelect.addEventListener('change', updateCaptureCapabilities);
detectCaptureButton.addEventListener('click', discoverVideoDevices);
captureDeviceSelect.addEventListener('change', updateCaptureCapabilities);
protectionToggle.addEventListener('change', () => {
    socket.emit('set-capture-protection', protectionToggle.checked);
});
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
document.getElementById('help-btn').addEventListener('click', () => helpDialog.showModal());
document.getElementById('close-help-btn').addEventListener('click', () => helpDialog.close());
document.getElementById('fullscreen-btn').addEventListener('click', toggleFullscreen);
document.getElementById('pip-btn').addEventListener('click', openPictureInPicture);
document.getElementById('leave-btn').addEventListener('click', leaveRoom);
document.getElementById('close-mobile-pip').addEventListener('click', closeMobileMiniPlayer);
inviteBtn.addEventListener('click', sendDiscordInvite);
document.addEventListener('contextmenu', event => {
    if (captureProtectionEnabled && event.target.closest('.screen-card')) {
        event.preventDefault();
    }
});
document.addEventListener('visibilitychange', updateCaptureGuard);
window.addEventListener('blur', updateCaptureGuard);
window.addEventListener('focus', updateCaptureGuard);
document.addEventListener('keydown', handleKeyboardShortcuts);

async function loadIceConfiguration() {
    try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(ROOM_ID)}/ice`, {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`ICE config request failed with status ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data.iceServers)) {
            throw new Error('ICE config response has no iceServers array.');
        }
        iceConfiguration = { iceServers: data.iceServers };
    } catch (error) {
        iceConfigurationError = error;
        console.error('Não foi possível carregar a configuração ICE:', error);
        setStatus('A conexão da sala não ficou pronta. Atualize a página ou tente novamente.');
    }
}

async function loadRoomSession() {
    try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(ROOM_ID)}/session`, {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Room session request failed with status ${response.status}`);
        }
        const data = await response.json();
        viewerId = data.viewerId;
        viewerProfile = data.profile || { userId: data.viewerId, displayName: `Discord · ${data.viewerId}` };
        renderViewerList();
        captureProtectionEnabled = Boolean(data.captureProtectionEnabled);
        roomIsOwner = Boolean(data.isOwner);
        protectionSetting.hidden = !roomIsOwner;
        inviteBtn.hidden = true;
        protectionToggle.checked = captureProtectionEnabled;
        updateWatermark();
        updateCaptureGuard();
    } catch (error) {
        console.error('Não foi possível carregar as informações da sala:', error);
        setStatus('Não foi possível validar sua sessão. Recarregue o link da sala.');
    }
}

function updateCaptureCapabilities() {
    const usingCaptureDevice = sourceSelect.value === 'capture';
    const hasSelectedDevice = Boolean(captureDeviceSelect.value);
    const canShareCurrentSource = usingCaptureDevice
        ? canCaptureVideoDevice && hasSelectedDevice
        : canShareScreen;
    shareBtn.disabled = sessionEnded || !canShareCurrentSource || !socket.connected;
    welcomeShareBtn.disabled = shareBtn.disabled;
    systemAudioInput.disabled = usingCaptureDevice;
    systemAudioOption.hidden = usingCaptureDevice || !canShareScreen;
    captureDeviceSelect.hidden = !usingCaptureDevice;
    captureDeviceLabel.hidden = !usingCaptureDevice;
    detectCaptureButton.hidden = !usingCaptureDevice;
    if (usingCaptureDevice && !hasSelectedDevice) {
        setStatus('Escolha uma câmera ou placa de captura antes de começar.');
    } else if (!canShareScreen && !usingCaptureDevice) {
        setStatus('Neste celular, você pode assistir. Para compartilhar a tela, use o app Discord.');
    } else {
        updateRoomStatus();
    }
}

async function discoverVideoDevices() {
    if (!canCaptureVideoDevice) {
        setStatus('Este navegador não permite selecionar dispositivos de vídeo.');
        return;
    }

    detectCaptureButton.disabled = true;
    try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        permissionStream.getTracks().forEach(track => track.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        captureDeviceSelect.replaceChildren();
        for (const [index, device] of videoDevices.entries()) {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Dispositivo de vídeo ${index + 1}`;
            captureDeviceSelect.append(option);
        }
        if (videoDevices.length === 0) {
            setStatus('Nenhuma placa de captura ou câmera foi encontrada.');
        } else {
            setStatus(`${videoDevices.length} dispositivo(s) de vídeo encontrado(s).`);
        }
        updateCaptureCapabilities();
    } catch (error) {
        console.error('Não foi possível listar dispositivos de vídeo:', error);
        setStatus('Permita o acesso à câmera para detectar placas de captura e dispositivos de vídeo.');
    } finally {
        detectCaptureButton.disabled = false;
    }
}

function getQualityConstraints() {
    const presets = {
        '720p30': { width: 1280, height: 720, frameRate: 30 },
        '1080p30': { width: 1920, height: 1080, frameRate: 30 },
        '1080p60': { width: 1920, height: 1080, frameRate: 60 }
    };
    return presets[qualitySelect.value] || presets['1080p30'];
}

async function startSharing() {
    if (sessionEnded || localStream || !socket.connected) {
        return;
    }

    shareBtn.disabled = true;
    let stream;
    try {
        const quality = getQualityConstraints();
        if (sourceSelect.value === 'capture') {
            const deviceId = captureDeviceSelect.value;
            if (!deviceId) {
                throw new Error('Escolha primeiro uma placa de captura ou dispositivo de vídeo.');
            }
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: { exact: deviceId },
                    width: { ideal: quality.width },
                    height: { ideal: quality.height },
                    frameRate: { ideal: quality.frameRate }
                },
                audio: false
            });
        } else {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: quality.width },
                    height: { ideal: quality.height },
                    frameRate: { ideal: quality.frameRate }
                },
                audio: systemAudioInput.checked
            });
        }
        const result = await new Promise(resolve => {
            socket.timeout(10000).emit('start-screen', (error, response) => {
                resolve(error
                    ? { ok: false, message: 'O servidor não respondeu. Tente novamente.' }
                    : response);
            });
        });

        if (!result?.ok) {
            stream.getTracks().forEach(track => track.stop());
            setStatus(result?.message || 'Não foi possível iniciar o compartilhamento.');
            return;
        }

        localStream = stream;
        screenPaused = false;
        activeSharerIds.add(socket.id);
        const video = createVideo(true);
        video.srcObject = stream;
        videoGrid.prepend(video.closest('.screen-card'));
        syncPictureInPicture();
        video.play().catch(error => console.error('Não foi possível reproduzir a prévia local:', error));
        shareBtn.hidden = true;
        stopShareBtn.hidden = false;
        pauseShareBtn.disabled = false;
        pauseShareBtn.textContent = 'Pausar';
        pauseShareBtn.setAttribute('aria-pressed', 'false');
        audioBtn.disabled = false;
        stream.getVideoTracks()[0]?.addEventListener('ended', () => stopSharing(), { once: true });
        socket.emit('request-room-users');
        updateRoomUi();
        setStatus('Você está transmitindo. Os espectadores podem controlar o próprio áudio.');
    } catch (error) {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        console.error('Não foi possível iniciar o compartilhamento:', error);
        setStatus(error.name === 'NotAllowedError'
            ? 'Captura cancelada. Autorize a fonte no seletor do navegador para transmitir.'
            : error.message || 'Compartilhamento indisponível neste dispositivo.');
    } finally {
        updateCaptureCapabilities();
    }
}

async function registerCurrentShare() {
    if (!localStream || !socket.connected) {
        return;
    }

    const result = await new Promise(resolve => {
        socket.timeout(10000).emit('start-screen', (error, response) => {
            resolve(error ? { ok: false } : response);
        });
    });
    if (!result?.ok) {
        setStatus('A sessão mudou durante a reconexão. Recarregue a sala para continuar.');
        return;
    }
    activeSharerIds.add(socket.id);
    if (screenPaused) {
        socket.emit('screen-paused', true);
    }
}

function stopSharing(notifyServer = true) {
    if (!localStream) {
        return;
    }

    const stream = localStream;
    localStream = null;
    screenPaused = false;
    stream.getTracks().forEach(track => track.stop());
    document.querySelector('[data-local-screen="true"]')?.closest('.screen-card')?.remove();
    if (mobilePipCard && !mobilePipCard.isConnected) {
        closeMobileMiniPlayer();
    }
    syncPictureInPicture();
    activeSharerIds.delete(socket.id);
    shareBtn.hidden = false;
    stopShareBtn.hidden = true;
    pauseShareBtn.disabled = true;
    pauseShareBtn.textContent = 'Pausar';
    audioBtn.disabled = activeSharerIds.size === 0;
    if (notifyServer && socket.connected) {
        socket.emit('stop-screen');
    }
    closeLocalSharerPeers();
    updateRoomUi();
    setStatus(sessionEnded ? 'Sala encerrada.' : 'Sua transmissão foi encerrada.');
    updateCaptureCapabilities();
}

function togglePause() {
    if (!localStream) {
        return;
    }
    screenPaused = !screenPaused;
    for (const track of localStream.getTracks()) {
        track.enabled = !screenPaused;
    }
    pauseShareBtn.textContent = screenPaused ? 'Retomar' : 'Pausar';
    pauseShareBtn.setAttribute('aria-pressed', String(screenPaused));
    socket.emit('screen-paused', screenPaused);
    syncPictureInPicture();
    setStatus(screenPaused ? 'Transmissão pausada.' : 'Transmissão retomada.');
}

function toggleRoomAudio() {
    audioEnabled = !audioEnabled;
    for (const video of document.querySelectorAll('.screen-card video:not([data-local-screen="true"])')) {
        video.muted = !audioEnabled;
        if (audioEnabled) {
            video.play().catch(error => console.error('Não foi possível ativar o áudio da sala:', error));
        }
    }
    syncPictureInPicture();
    audioBtn.textContent = audioEnabled ? 'Silenciar' : 'Som';
    audioBtn.setAttribute('aria-label', audioEnabled ? 'Silenciar som' : 'Ativar som');
    audioBtn.setAttribute('aria-pressed', String(audioEnabled));
}

function handleUserDisconnected(userId) {
    participantIds.delete(userId);
    participantProfiles.delete(userId);
    handleScreenStopped(userId);
}

function findPeerFor(userId) {
    return Array.from(peers.values()).find(peer => peer.remoteUserId === userId);
}

function setPausedLabel(video, paused) {
    const card = video.closest('.screen-card');
    let label = card?.querySelector('.screen-paused-label');
    if (paused && card && !label) {
        label = document.createElement('span');
        label.className = 'screen-paused-label';
        label.textContent = 'Transmissão pausada';
        card.append(label);
    } else if (!paused) {
        label?.remove();
    }
}

async function connectToViewer(userId) {
    if (!localStream || !socket.connected || hasPeerFor(userId, true)) {
        return;
    }

    try {
        await iceConfigurationReady;
        if (!iceConfiguration) {
            throw iceConfigurationError || new Error('Configuração ICE indisponível.');
        }
        const connectionId = crypto.randomUUID();
        const peer = createPeer(connectionId, userId, true);
        localStream.getTracks().forEach(track => peer.connection.addTrack(track, localStream));

        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        socket.emit('offer', {
            target: userId,
            connectionId,
            offer: peer.connection.localDescription
        });
    } catch (error) {
        console.error('Não foi possível iniciar transmissão para um participante:', error);
        setStatus('Não foi possível conectar a tela. Confira sua internet e tente novamente.');
    }
}

function createPeer(connectionId, remoteUserId, isLocalSharer) {
    const connection = new RTCPeerConnection(iceConfiguration);
    const video = createVideo(false);
    const peer = {
        connection,
        video,
        remoteUserId,
        isLocalSharer,
        pendingCandidates: [],
        disconnectTimer: undefined
    };
    peers.set(connectionId, peer);

    connection.ontrack = event => {
        video.srcObject = event.streams[0];
        video.muted = !audioEnabled;
        videoGrid.append(video.closest('.screen-card'));
        if (!document.getElementById('mobile-pip').hidden && !mobilePipCard) {
            openMobileMiniPlayer();
        }
        syncPictureInPicture();
        video.play().catch(error => {
            console.error('Não foi possível reproduzir a transmissão:', error);
            setStatus('Toque em Som para ouvir ou confira as permissões do navegador.');
        });
        updateRoomUi();
    };

    connection.onicecandidate = event => {
        if (event.candidate && socket.connected) {
            socket.emit('ice-candidate', {
                target: remoteUserId,
                connectionId,
                candidate: event.candidate
            });
        }
    };

    connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'connected') {
            retryAttempts.delete(remoteUserId);
            clearTimeout(retryTimers.get(remoteUserId));
            retryTimers.delete(remoteUserId);
            clearTimeout(peer.disconnectTimer);
            peer.disconnectTimer = undefined;
            updateNetworkStatus();
        } else if (connection.connectionState === 'disconnected' && isLocalSharer) {
            if (!peer.disconnectTimer) {
                peer.disconnectTimer = window.setTimeout(() => {
                    if (connection.connectionState === 'disconnected') {
                        schedulePeerRetry(peer, connectionId);
                    }
                }, 5000);
            }
        } else if (['failed', 'closed'].includes(connection.connectionState)) {
            if (isLocalSharer) {
                schedulePeerRetry(peer, connectionId);
            } else {
                closePeer(connectionId);
            }
        }
    };

    return peer;
}

function schedulePeerRetry(peer, connectionId) {
    if (peers.get(connectionId) !== peer) {
        return;
    }
    const remoteUserId = peer.remoteUserId;
    closePeer(connectionId);
    const attempt = (retryAttempts.get(remoteUserId) ?? 0) + 1;
    retryAttempts.set(remoteUserId, attempt);
    if (attempt > maxPeerRetries || !localStream || sessionEnded) {
        setStatus('A conexão caiu. Reinicie o compartilhamento para tentar novamente.');
        return;
    }
    const delay = Math.min(1000 * (2 ** (attempt - 1)), 8000);
    setStatus(`Reconectando transmissão (${attempt}/${maxPeerRetries})...`);
    const timer = window.setTimeout(() => {
        retryTimers.delete(remoteUserId);
        connectToViewer(remoteUserId);
    }, delay);
    retryTimers.set(remoteUserId, timer);
}

async function addQueuedCandidates(peer, connectionId) {
    const earlyCandidates = pendingCandidatesByConnection.get(connectionId) ?? [];
    peer.pendingCandidates.push(...earlyCandidates);
    pendingCandidatesByConnection.delete(connectionId);

    for (const candidate of peer.pendingCandidates) {
        await peer.connection.addIceCandidate(candidate);
    }
    peer.pendingCandidates = [];
}

function hasPeerFor(userId, isLocalSharer) {
    return Array.from(peers.values()).some(peer =>
        peer.remoteUserId === userId && peer.isLocalSharer === isLocalSharer
    );
}

function closePeersForSharer(userId) {
    for (const [connectionId, peer] of peers) {
        if (peer.remoteUserId === userId) {
            closePeer(connectionId);
        }
    }
    updateRoomUi();
}

function handleScreenStopped(userId) {
    activeSharerIds.delete(userId);
    if (userId === socket.id) {
        closeLocalSharerPeers();
        updateRoomUi();
        return;
    }
    closePeersForSharer(userId);
    updateRoomUi();
}

function closeLocalSharerPeers() {
    for (const [connectionId, peer] of peers) {
        if (peer.isLocalSharer) {
            closePeer(connectionId);
        }
    }
}

function closePeer(connectionId) {
    const peer = peers.get(connectionId);
    if (!peer) {
        return;
    }

    peer.connection.close();
    clearTimeout(peer.disconnectTimer);
    peer.video.closest('.screen-card')?.remove();
    peers.delete(connectionId);
    pendingCandidatesByConnection.delete(connectionId);
    if (mobilePipCard && !mobilePipCard.isConnected) {
        closeMobileMiniPlayer();
    }
    syncPictureInPicture();
}

function closeAllPeers() {
    for (const connectionId of peers.keys()) {
        closePeer(connectionId);
    }
}

function createVideo(isLocal) {
    const card = document.createElement('article');
    card.className = 'screen-card';
    const label = document.createElement('span');
    label.className = 'screen-label';
    label.textContent = isLocal ? 'Sua transmissão' : 'Tela compartilhada';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal || !audioEnabled;
    if (isLocal) {
        video.dataset.localScreen = 'true';
    }
    card.append(video, label);
    return video;
}

function setStatus(message) {
    statusMessage.textContent = message;
}

function updateRoomStatus() {
    if (sessionEnded) {
        setStatus('Esta sala foi encerrada.');
    } else if (!canShareScreen && !canCaptureVideoDevice) {
        setStatus('Neste celular, você pode assistir. Para compartilhar a tela, use o app Discord.');
    } else if (activeSharerIds.size > 0) {
        setStatus(`${activeSharerIds.size} ${activeSharerIds.size === 1 ? 'pessoa transmitindo' : 'pessoas transmitindo'}.`);
    } else if (socket.connected) {
        setStatus('Sala pronta. Transmitir é opcional: você também pode apenas assistir.');
    }
}

function updateRoomUi() {
    const localSharer = activeSharerIds.has(socket.id);
    welcome.hidden = activeSharerIds.size > 0 || sessionEnded;
    const total = participantIds.size + 1;
    participantCount.textContent = total === 1 ? 'Só você' : `${total} pessoas`;
    viewerTotal.textContent = String(total);
    inviteBtn.hidden = !roomIsOwner || !localSharer;
    updateWatermark();
    audioBtn.disabled = activeSharerIds.size === 0;
    if (activeSharerIds.size === 0) {
        audioEnabled = false;
        audioBtn.textContent = 'Som';
        audioBtn.setAttribute('aria-label', 'Som indisponível');
        audioBtn.setAttribute('aria-pressed', 'false');
    } else if (!audioEnabled) {
        audioBtn.textContent = 'Som';
        audioBtn.setAttribute('aria-label', 'Ativar som');
    }
    shareBtn.disabled = sessionEnded || !socket.connected
        || (sourceSelect.value === 'capture' ? !captureDeviceSelect.value : !canShareScreen);
    welcomeShareBtn.disabled = shareBtn.disabled;
    pauseShareBtn.disabled = !localSharer;
    updateRoomStatus();
    shareBtn.setAttribute('aria-label', localSharer ? 'Compartilhando sua tela' : 'Começar a compartilhar');
    renderViewerList();
}

function renderViewerList() {
    viewerList.replaceChildren();
    viewerList.append(createViewerItem(viewerProfile, true));
    for (const id of participantIds) {
        const profile = participantProfiles.get(id) || {
            userId: id,
            displayName: 'Entrando...'
        };
        viewerList.append(createViewerItem(profile));
    }
    viewerTotal.textContent = String(participantIds.size + 1);
}

function createViewerItem(profile, isSelf = false) {
    const item = document.createElement('li');
    item.className = 'viewer-item';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    if (profile.avatarUrl) {
        const image = document.createElement('img');
        image.src = profile.avatarUrl;
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        avatar.append(image);
    } else {
        avatar.textContent = (profile.displayName || 'D').trim().slice(0, 1).toUpperCase();
    }
    const name = document.createElement('span');
    name.className = 'viewer-name';
    name.textContent = profile.displayName || `Discord · ${profile.userId}`;
    item.title = `Conta Discord: ${profile.userId}`;
    item.append(avatar, name);
    if (isSelf) {
        const self = document.createElement('span');
        self.className = 'viewer-self';
        self.textContent = 'Você';
        item.append(self);
    }
    return item;
}

async function sendDiscordInvite() {
    inviteBtn.disabled = true;
    try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(ROOM_ID)}/invite`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'fetch' }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || 'Não foi possível enviar o convite para o Discord.');
        }
        setStatus('Convite enviado no canal do Discord.');
    } catch (error) {
        console.error('Não foi possível enviar o convite para o Discord:', error);
        setStatus(error.message || 'Não foi possível enviar o convite. Tente novamente.');
    } finally {
        inviteBtn.disabled = !roomIsOwner || !activeSharerIds.has(socket.id);
    }
}

async function copyInvite() {
    const inviteUrl = `${window.location.origin}/s/${ROOM_ID}`;
    try {
        await navigator.clipboard.writeText(inviteUrl);
        setStatus('Link do convite copiado.');
    } catch (error) {
        console.error('Não foi possível copiar o convite:', error);
        setStatus('Não foi possível copiar. Selecione e copie o endereço da sala manualmente.');
    }
}

function updateCaptureGuard() {
    const blurred = captureProtectionEnabled && (document.hidden || !document.hasFocus());
    document.body.classList.toggle('capture-blurred', blurred);
    captureBlurNotice.hidden = !blurred;
    updateWatermark();
    if (activePipWindow && !activePipWindow.closed) {
        activePipWindow.document.body.classList.toggle('pip-blurred', blurred);
    }
}

function updateWatermark() {
    const videoCard = videoGrid.querySelector('.screen-card');
    const videoBounds = videoCard?.getBoundingClientRect();
    if (!viewerId || !captureProtectionEnabled || !activeSharerIds.size || !videoBounds?.width || !videoBounds.height) {
        captureWatermark.hidden = true;
        return;
    }
    captureWatermark.hidden = false;
    captureWatermark.textContent = `Conta Discord · ${viewerId}`;
    const width = Math.min(240, videoBounds.width - 16);
    const height = 32;
    const maxLeft = Math.max(videoBounds.left + 8, videoBounds.right - width - 8);
    const maxTop = Math.max(videoBounds.top + 8, videoBounds.bottom - height - 8);
    captureWatermark.style.maxWidth = `${Math.max(1, width)}px`;
    captureWatermark.style.left = `${videoBounds.left + 8 + Math.random() * Math.max(0, maxLeft - videoBounds.left - 8)}px`;
    captureWatermark.style.top = `${videoBounds.top + 8 + Math.random() * Math.max(0, maxTop - videoBounds.top - 8)}px`;
}

function startNetworkStats() {
    window.setInterval(() => {
        if (socket.connected) {
            socket.emit('latency-probe', performance.now());
        }
        updateWebRtcStats();
        updateWatermark();
    }, 5000);
}

async function updateWebRtcStats() {
    let lost = 0;
    let received = 0;
    let worstRtt;
    for (const peer of peers.values()) {
        try {
            const stats = await peer.connection.getStats();
            for (const report of stats.values()) {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    lost += Math.max(0, report.packetsLost || 0);
                    received += Math.max(0, report.packetsReceived || 0);
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
                    const rtt = Math.round(report.currentRoundTripTime * 1000);
                    worstRtt = Math.max(worstRtt ?? 0, rtt);
                }
            }
        } catch (error) {
            console.error('Não foi possível obter estatísticas WebRTC:', error);
        }
    }
    if (received + lost > 0) {
        packetLossPercent = Math.round((lost / (received + lost)) * 100);
    }
    updateNetworkStatus(worstRtt);
}

function updateNetworkStatus(mediaRtt) {
    const latency = typeof mediaRtt === 'number' ? mediaRtt : pingMs;
    networkStatus.textContent = activeSharerIds.size === 0
        ? 'Pronta para assistir'
        : (typeof latency === 'number' && latency > 250)
            || (typeof packetLossPercent === 'number' && packetLossPercent > 5)
            ? 'Conexão instável'
            : 'Conexão boa';
    networkStatus.dataset.quality = typeof packetLossPercent === 'number' && packetLossPercent > 5
        ? 'poor'
        : 'good';
}

function loadTheme() {
    try {
        const theme = localStorage.getItem('guse-theme');
        if (theme === 'light' || theme === 'dark') {
            if (theme === 'light') {
                document.documentElement.dataset.theme = 'light';
            } else {
                document.documentElement.removeAttribute('data-theme');
            }
        } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            document.documentElement.dataset.theme = 'light';
        }
    } catch (error) {
        console.error('Não foi possível carregar o tema salvo:', error);
    }
}

function toggleTheme() {
    const isLight = document.documentElement.dataset.theme === 'light';
    const nextTheme = isLight ? 'dark' : 'light';
    if (nextTheme === 'light') {
        document.documentElement.dataset.theme = 'light';
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    try {
        localStorage.setItem('guse-theme', nextTheme);
    } catch (error) {
        console.error('Não foi possível salvar o tema:', error);
    }
}

async function toggleFullscreen() {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else if (document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen();
        } else {
            setStatus('Tela cheia não está disponível neste navegador.');
        }
    } catch (error) {
        console.error('Não foi possível alternar para tela cheia:', error);
        setStatus('O navegador não permitiu tela cheia. Use os controles do próprio navegador.');
    }
}

async function openPictureInPicture() {
    if (typeof window.documentPictureInPicture?.requestWindow === 'function') {
        try {
            const pipWindow = await window.documentPictureInPicture.requestWindow({
                width: 720,
                height: 460
            });
            for (const stylesheet of document.querySelectorAll('link[rel="stylesheet"]')) {
                pipWindow.document.head.append(stylesheet.cloneNode(true));
            }
            pipWindow.document.body.className = 'pip-content';
            const heading = pipWindow.document.createElement('h1');
            heading.textContent = 'Guse Screen · sala';
            pipWindow.document.body.append(heading);
            const grid = pipWindow.document.createElement('div');
            grid.className = 'pip-grid';
            pipWindow.document.body.append(grid);
            activePipWindow = pipWindow;
            pipWindow.addEventListener('pagehide', () => {
                if (activePipWindow === pipWindow) {
                    activePipWindow = null;
                }
            }, { once: true });
            pipWindow.addEventListener('blur', () => {
                if (captureProtectionEnabled) {
                    pipWindow.document.body.classList.add('pip-blurred');
                }
            });
            pipWindow.addEventListener('focus', () => {
                pipWindow.document.body.classList.remove('pip-blurred');
            });
            pipWindow.document.addEventListener('contextmenu', event => {
                if (captureProtectionEnabled && event.target.closest('.screen-card')) {
                    event.preventDefault();
                }
            });
            pipWindow.document.addEventListener('keydown', event => {
                if (captureProtectionEnabled && isScreenshotShortcut(event)) {
                    event.preventDefault();
                    grid.style.visibility = 'hidden';
                    window.setTimeout(() => { grid.style.visibility = ''; }, 1500);
                }
            });
            syncPictureInPicture();
            setStatus('Janela flutuante aberta.');
            return;
        } catch (error) {
            console.error('Document Picture-in-Picture não foi permitido:', error);
        }
    }

    const video = videoGrid.querySelector('video:not([data-local-screen="true"])');
    if (video && typeof video.requestPictureInPicture === 'function') {
        try {
            await video.requestPictureInPicture();
            setStatus('Vídeo aberto na janela flutuante.');
            return;
        } catch (error) {
            console.error('Picture-in-Picture do vídeo não foi permitido:', error);
        }
    }

    if (window.matchMedia('(max-width: 720px)').matches) {
        openMobileMiniPlayer();
        return;
    }

    const popup = window.open(
        `/room/${encodeURIComponent(ROOM_ID)}?popup=1`,
        'guse-screen-popup',
        'popup=yes,width=960,height=640,resizable=yes,scrollbars=yes'
    );
    if (popup) {
        setStatus('Sala aberta em outra janela. Ela pode não ficar sempre visível.');
    } else {
        setStatus('O navegador não permitiu abrir outra janela. Tente novamente pelo botão.');
    }
}

function openMobileMiniPlayer() {
    const miniPlayer = document.getElementById('mobile-pip');
    const miniContent = document.getElementById('mobile-pip-content');
    const card = videoGrid.querySelector('.screen-card');
    if (card && card !== mobilePipCard) {
        mobilePipPlaceholder = document.createComment('video position');
        card.before(mobilePipPlaceholder);
        mobilePipCard = card;
        miniContent.replaceChildren(card);
    } else if (!card && !mobilePipCard) {
        const emptyState = document.createElement('p');
        emptyState.className = 'mobile-pip-empty';
        emptyState.textContent = 'Aguardando alguém compartilhar a tela.';
        miniContent.replaceChildren(emptyState);
    }
    miniPlayer.hidden = false;
    setStatus('Janela flutuante aberta. Arraste para mover ou toque em Fechar.');
}

function closeMobileMiniPlayer() {
    if (mobilePipCard) {
        if (mobilePipPlaceholder?.parentNode && mobilePipCard.isConnected) {
            mobilePipPlaceholder.replaceWith(mobilePipCard);
        } else {
            mobilePipPlaceholder?.remove();
        }
    }
    mobilePipPlaceholder = null;
    mobilePipCard = null;
    document.getElementById('mobile-pip').hidden = true;
}

const mobilePipHandle = document.getElementById('mobile-pip-handle');
let mobilePipDrag = null;
mobilePipHandle.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) {
        return;
    }
    const miniPlayer = document.getElementById('mobile-pip');
    mobilePipDrag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: miniPlayer.getBoundingClientRect().left,
        top: miniPlayer.getBoundingClientRect().top
    };
    mobilePipHandle.setPointerCapture(event.pointerId);
});
mobilePipHandle.addEventListener('pointermove', event => {
    if (!mobilePipDrag || mobilePipDrag.pointerId !== event.pointerId) {
        return;
    }
    const miniPlayer = document.getElementById('mobile-pip');
    const left = Math.min(window.innerWidth - miniPlayer.offsetWidth - 8,
        Math.max(8, mobilePipDrag.left + event.clientX - mobilePipDrag.x));
    const top = Math.min(window.innerHeight - miniPlayer.offsetHeight - 8,
        Math.max(8, mobilePipDrag.top + event.clientY - mobilePipDrag.y));
    miniPlayer.style.left = `${left}px`;
    miniPlayer.style.top = `${top}px`;
    miniPlayer.style.right = 'auto';
    miniPlayer.style.bottom = 'auto';
});
mobilePipHandle.addEventListener('pointerup', () => { mobilePipDrag = null; });
mobilePipHandle.addEventListener('pointercancel', () => { mobilePipDrag = null; });

function syncPictureInPicture() {
    if (!activePipWindow || activePipWindow.closed) {
        return;
    }
    const grid = activePipWindow.document.querySelector('.pip-grid');
    if (!grid) {
        return;
    }
    grid.replaceChildren();
    const cards = videoGrid.querySelectorAll('.screen-card');
    if (cards.length === 0) {
        const empty = activePipWindow.document.createElement('p');
        empty.textContent = 'Aguardando uma transmissão nesta sala.';
        grid.append(empty);
        return;
    }
    for (const card of cards) {
        grid.append(cloneScreenCard(card, activePipWindow.document));
    }
}

function cloneScreenCard(card, targetDocument) {
    const clone = targetDocument.createElement('article');
    clone.className = 'screen-card';
    const sourceVideo = card.querySelector('video');
    const video = targetDocument.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = sourceVideo.muted;
    video.srcObject = sourceVideo.srcObject;
    const label = targetDocument.createElement('span');
    label.className = 'screen-label';
    label.textContent = card.querySelector('.screen-label')?.textContent || 'Transmissão';
    clone.append(video, label);
    if (captureProtectionEnabled && viewerId) {
        const watermark = targetDocument.createElement('span');
        watermark.className = 'pip-watermark';
        watermark.textContent = `Discord ID ${viewerId} · ${new Date().toLocaleTimeString()}`;
        clone.append(watermark);
    }
    video.play().catch(error => console.error('Não foi possível reproduzir a janela flutuante:', error));
    return clone;
}

function leaveRoom() {
    stopSharing();
    closeAllPeers();
    socket.disconnect();
    window.location.assign('/');
}

function handleKeyboardShortcuts(event) {
    if (captureProtectionEnabled && isScreenshotShortcut(event)) {
        event.preventDefault();
        const videos = Array.from(document.querySelectorAll('.screen-card video'));
        videos.forEach(video => { video.style.visibility = 'hidden'; });
        window.setTimeout(() => videos.forEach(video => { video.style.visibility = ''; }), 1500);
        setStatus('A proteção ajuda, mas não consegue impedir fotos ou gravações da tela.');
        return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.matches('input, select, textarea, button, a, summary')) {
        return;
    }
    const key = event.key.toLowerCase();
    if (key === 'h') {
        helpDialog.showModal();
    } else if (key === 't') {
        toggleTheme();
    } else if (key === 'f') {
        void toggleFullscreen();
    } else if (key === 'p') {
        void openPictureInPicture();
    } else if (key === 'i') {
        void copyInvite();
    } else if (key === 's' && !localStream) {
        void startSharing();
    } else if (key === 'x' && localStream) {
        stopSharing();
    } else if (key === 'm' && activeSharerIds.size > 0) {
        toggleRoomAudio();
    } else if (event.code === 'Space' && localStream) {
        event.preventDefault();
        togglePause();
    }
}

function isScreenshotShortcut(event) {
    return event.key === 'PrintScreen'
        || (event.shiftKey && event.metaKey && ['3', '4', '5'].includes(event.key))
        || (event.shiftKey && event.ctrlKey && event.key.toLowerCase() === 's');
}
