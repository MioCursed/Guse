const socket = io('/');
const videoGrid = document.getElementById('video-grid');
const ROOM_ID = window.location.pathname.split('/').pop();
const USER_ID = Math.random().toString(36).substring(7);

const myVideo = document.createElement('video');
myVideo.muted = true;
const peers = {};

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

let localStream = null;

const shareBtn = document.getElementById('share-btn');
const stopShareBtn = document.getElementById('stop-share-btn');

shareBtn.addEventListener('click', async () => {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always", frameRate: 30 },
            audio: true
        });
        
        addVideoStream(myVideo, localStream);
        shareBtn.style.display = 'none';
        stopShareBtn.style.display = 'inline-block';

        socket.emit('join-room', ROOM_ID, USER_ID);
        
        localStream.getVideoTracks()[0].onended = () => {
            stopSharing();
        };

    } catch (err) {
        console.error("Error accessing display media.", err);
    }
});

stopShareBtn.addEventListener('click', stopSharing);

function stopSharing() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        myVideo.remove();
        shareBtn.style.display = 'inline-block';
        stopShareBtn.style.display = 'none';
        socket.emit('stop-sharing', USER_ID);
        
        // Disconnect all peers when I stop sharing
        for(let peer in peers) {
             peers[peer].close();
             delete peers[peer];
        }
    }
}

socket.on('user-connected', userId => {
    console.log('User connected: ' + userId);
    if(localStream) {
        connectToNewUser(userId, localStream);
    }
});

socket.on('offer', async (data) => {
    const peerConnection = new RTCPeerConnection(iceServers);
    peers[data.from] = peerConnection;

    const video = document.createElement('video');
    
    peerConnection.ontrack = event => {
        addVideoStream(video, event.streams[0]);
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: data.from,
                candidate: event.candidate,
                from: USER_ID
            });
        }
    };
    
    // Cleanup if connection closes
    peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') {
             video.remove();
             if(peers[data.from]) delete peers[data.from];
        }
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', {
        target: data.from,
        answer: answer,
        from: USER_ID
    });
});

socket.on('answer', async (data) => {
    const peerConnection = peers[data.from];
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
});

socket.on('ice-candidate', async (data) => {
    const peerConnection = peers[data.from];
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    }
});

socket.on('user-disconnected', userId => {
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
        // Note: Removing the video element is tricky without managing mapping of userId to element.
        // The oniceconnectionstatechange usually handles it.
    }
});

socket.on('user-stopped-sharing', userId => {
    if(peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }
    // Simplistic approach: remove all videos except my own.
    // In a real app, map elements to user IDs.
    Array.from(videoGrid.children).forEach(child => {
        if(child !== myVideo) {
            child.remove();
        }
    })
});

function connectToNewUser(userId, stream) {
    const peerConnection = new RTCPeerConnection(iceServers);
    peers[userId] = peerConnection;

    stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

    const video = document.createElement('video');
    peerConnection.ontrack = event => {
        addVideoStream(video, event.streams[0]);
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: userId,
                candidate: event.candidate,
                from: USER_ID
            });
        }
    };
    
    peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'closed') {
             video.remove();
             if(peers[userId]) delete peers[userId];
        }
    }

    peerConnection.createOffer().then(offer => {
        return peerConnection.setLocalDescription(offer);
    }).then(() => {
        socket.emit('offer', {
            target: userId,
            offer: peerConnection.localDescription,
            from: USER_ID
        });
    });
}

function addVideoStream(video, stream) {
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
        video.play();
    });
    // Check if video is already in grid
    let exists = false;
    Array.from(videoGrid.children).forEach(child => {
       if (child.srcObject === stream) exists = true;
    });
    
    if(!exists){
        videoGrid.append(video);
    }
}
