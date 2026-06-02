import { showToast } from './app.js';

let localStream = null;
let isMuted = false;
let isInCall = false;

const peerConnections = new Map(); // remoteClientId -> RTCPeerConnection
let providerRef = null;
let localClientId = null;
let currentRoom = null;

let audioCtx = null;
let analyser = null;
let volumeInterval = null;

/**
 * Initializes the P2P Voice Calling Channel.
 * 
 * @param {object} provider - The y-websocket provider instance
 * @param {object} ydoc - The shared Y.Doc document
 * @param {string} docId - The active room/document ID
 */
export function initVoice(provider, ydoc, docId) {
  providerRef = provider;
  localClientId = provider.awareness.clientID;
  currentRoom = docId;

  const joinBtn = document.getElementById('voice-join-btn');
  const muteBtn = document.getElementById('voice-mute-btn');

  if (!joinBtn || !muteBtn) return;

  // 1. Setup UI triggers
  joinBtn.addEventListener('click', () => {
    if (isInCall) {
      leaveCall();
    } else {
      joinCall();
    }
  });

  muteBtn.addEventListener('click', () => {
    toggleMute();
  });

  // 2. Wrap WebSocket message listener upon successful websocket connection
  provider.on('status', ({ status }) => {
    if (status === 'connected' && provider.ws) {
      patchWebSocketListener(provider.ws);
    }
  });

  // If already connected on load
  if (provider.wsconnected && provider.ws) {
    patchWebSocketListener(provider.ws);
  }

  // 3. Listen to awareness updates to draw speaking outlines and connect newly arrived callers
  provider.awareness.on('change', () => {
    updateSpeakerOutlines();
    
    if (isInCall) {
      coordinateMeshConnections();
    }
  });
}

/**
 * Wrap WebSocket message listener to handle WebRTC JSON signaling.
 */
function patchWebSocketListener(ws) {
  if (ws._webrtcPatched) return;
  ws._webrtcPatched = true;

  const originalOnMessage = ws.onmessage;

  ws.onmessage = (event) => {
    try {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.type && msg.type.startsWith('webrtc-')) {
          handleSignalingMessage(msg);
          return; // Skip standard Yjs binary decoding
        }
      }
    } catch (e) {
      // Ignore non-JSON or parsing issues
    }

    if (originalOnMessage) {
      originalOnMessage.call(ws, event);
    }
  };
}

/**
 * Request mic access and trigger peering setup.
 */
async function joinCall() {
  const joinBtn = document.getElementById('voice-join-btn');
  const muteBtn = document.getElementById('voice-mute-btn');

  try {
    showToast('Requesting microphone permissions...', 'info', 1500);
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.error('Microphone access denied:', err);
    showToast('Failed to access microphone. Please check permissions.', 'error', 4000);
    return;
  }

  isInCall = true;
  isMuted = false;

  // Update UI button states
  joinBtn.textContent = 'Leave Call';
  joinBtn.classList.remove('btn-primary');
  joinBtn.classList.add('btn-danger');
  
  muteBtn.style.display = 'inline-flex';
  muteBtn.removeAttribute('disabled');
  muteBtn.textContent = '🎙️ Mute';
  muteBtn.classList.remove('active');

  // Broadcast voice status to room
  providerRef.awareness.setLocalStateField('voiceCall', true);
  
  // Start speaking analyzer
  startVolumeAnalyzer();

  showToast('Joined voice channel!', 'success', 2500);

  // Trigger mesh connection coordinates
  coordinateMeshConnections();
}

/**
 * Cleanly exit from WebRTC call.
 */
function leaveCall() {
  const joinBtn = document.getElementById('voice-join-btn');
  const muteBtn = document.getElementById('voice-mute-btn');

  isInCall = false;
  isMuted = false;

  // 1. Stop local audio tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // 2. Stop audio volume analyzer
  stopVolumeAnalyzer();

  // 3. Destroy all Peer Connections
  peerConnections.forEach((pc, clientId) => {
    pc.close();
    removeAudioNode(clientId);
  });
  peerConnections.clear();

  // 4. Update UI
  joinBtn.textContent = 'Join Call';
  joinBtn.classList.remove('btn-danger');
  joinBtn.classList.add('btn-primary');

  muteBtn.style.display = 'none';
  muteBtn.setAttribute('disabled', '');

  // Update awareness
  providerRef.awareness.setLocalStateField('voiceCall', null);
  providerRef.awareness.setLocalStateField('speaking', null);

  showToast('Left voice channel.', 'info', 2000);
}

/**
 * Toggle local microphone mute tracks.
 */
function toggleMute() {
  const muteBtn = document.getElementById('voice-mute-btn');
  if (!localStream) return;

  isMuted = !isMuted;
  
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });

  if (isMuted) {
    muteBtn.textContent = '🔇 Unmute';
    muteBtn.classList.add('active');
    showToast('Microphone muted', 'info', 1500);
    updateSpeakingState(false);
  } else {
    muteBtn.textContent = '🎙️ Mute';
    muteBtn.classList.remove('active');
    showToast('Microphone active', 'success', 1500);
  }
}

/**
 * Broadcast messages through WebSocket signaling proxy.
 */
function sendSignalingMessage(msg) {
  if (providerRef && providerRef.ws && providerRef.wsconnected) {
    providerRef.ws.send(JSON.stringify(msg));
  }
}

/**
 * Checks room awareness and establishes connections with other active voice users.
 */
function coordinateMeshConnections() {
  const states = providerRef.awareness.getStates();
  localClientId = providerRef.awareness.clientID; // sync current ID

  states.forEach((state, clientId) => {
    if (clientId === localClientId) return; // skip self

    const isRemoteInCall = state.voiceCall === true;

    if (isRemoteInCall) {
      if (!peerConnections.has(clientId)) {
        // Setup WebRTC connection
        setupPeerLink(clientId);
      }
    } else {
      // Remote client is not in call (or left). Clean up if we had connection.
      if (peerConnections.has(clientId)) {
        closePeerLink(clientId);
      }
    }
  });

  // Clean up any peers that are no longer in Yjs awareness at all
  peerConnections.forEach((pc, clientId) => {
    if (!states.has(clientId)) {
      closePeerLink(clientId);
    }
  });
}

/**
 * Setup RTCPeerConnection to a target client.
 */
async function setupPeerLink(remoteId) {
  console.log(`[WebRTC] Setting up peer link to client: ${remoteId}`);

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });

  peerConnections.set(remoteId, pc);

  // Add our local audio track
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE Candidates callback
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage({
        type: 'webrtc-candidate',
        senderId: localClientId,
        targetId: remoteId,
        candidate: event.candidate
      });
    }
  };

  // Connection state logger
  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection status to ${remoteId}: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      closePeerLink(remoteId);
    }
  };

  // Remote audio track arrived
  pc.ontrack = (event) => {
    console.log(`[WebRTC] Audio track received from remote client: ${remoteId}`);
    const remoteStream = event.streams[0];
    createAudioNode(remoteId, remoteStream);
  };

  // If we are the initiator (our ID is smaller), generate SDP Offer
  if (localClientId < remoteId) {
    try {
      console.log(`[WebRTC] Initiating offer to client: ${remoteId}`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      sendSignalingMessage({
        type: 'webrtc-offer',
        senderId: localClientId,
        targetId: remoteId,
        offer: offer
      });
    } catch (err) {
      console.error(`[WebRTC] Failed to create offer to ${remoteId}:`, err);
    }
  }
}

/**
 * Clean up a peer link.
 */
function closePeerLink(remoteId) {
  const pc = peerConnections.get(remoteId);
  if (pc) {
    pc.close();
    peerConnections.delete(remoteId);
    console.log(`[WebRTC] Peer link to client ${remoteId} closed.`);
  }
  removeAudioNode(remoteId);
}

/**
 * Handle incoming WebRTC signaling packets.
 */
async function handleSignalingMessage(msg) {
  if (msg.targetId !== localClientId) return; // Target check

  const { type, senderId } = msg;
  let pc = peerConnections.get(senderId);

  try {
    if (type === 'webrtc-offer') {
      console.log(`[WebRTC] Offer received from client: ${senderId}`);
      if (!pc) {
        pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
        peerConnections.set(senderId, pc);

        if (localStream) {
          localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        }

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendSignalingMessage({
              type: 'webrtc-candidate',
              senderId: localClientId,
              targetId: senderId,
              candidate: event.candidate
            });
          }
        };

        pc.ontrack = (event) => {
          console.log(`[WebRTC] Audio track received from remote: ${senderId}`);
          createAudioNode(senderId, event.streams[0]);
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            closePeerLink(senderId);
          }
        };
      }

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendSignalingMessage({
        type: 'webrtc-answer',
        senderId: localClientId,
        targetId: senderId,
        answer: answer
      });

    } else if (type === 'webrtc-answer') {
      console.log(`[WebRTC] Answer received from client: ${senderId}`);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
      }

    } else if (type === 'webrtc-candidate') {
      if (pc && msg.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(e => {
          console.warn('[WebRTC] Failed to add candidate:', e);
        });
      }
    }
  } catch (err) {
    console.error(`[WebRTC] Error handling signaling message from ${senderId}:`, err);
  }
}

/**
 * Creates audio DOM node for remote participant stream.
 */
function createAudioNode(clientId, stream) {
  const container = document.getElementById('audio-streams-container');
  if (!container) return;

  let audio = document.getElementById(`audio-node-${clientId}`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = `audio-node-${clientId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    container.appendChild(audio);
  }

  audio.srcObject = stream;
}

/**
 * Removes remote audio DOM node.
 */
function removeAudioNode(clientId) {
  const audio = document.getElementById(`audio-node-${clientId}`);
  if (audio) {
    audio.srcObject = null;
    audio.parentNode.removeChild(audio);
  }
}

/**
 * Setup Audio Analyser to detect local speaking.
 */
function startVolumeAnalyzer() {
  if (!localStream) return;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(localStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    volumeInterval = setInterval(() => {
      if (isMuted || !isInCall) {
        updateSpeakingState(false);
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;

      // Threshold: if average is above 12, user is speaking
      updateSpeakingState(average > 12);
    }, 150);

  } catch (err) {
    console.warn('[WebRTC] Volume speaking analysis initialization failed:', err);
  }
}

function stopVolumeAnalyzer() {
  if (volumeInterval) {
    clearInterval(volumeInterval);
    volumeInterval = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
}

function updateSpeakingState(isSpeaking) {
  if (providerRef && providerRef.awareness) {
    const localState = providerRef.awareness.getLocalState();
    if (localState && localState.speaking !== isSpeaking) {
      providerRef.awareness.setLocalStateField('speaking', isSpeaking);
    }
  }
}

/**
 * Loops through awareness client states and toggles speaking rings on UI avatars.
 */
function updateSpeakerOutlines() {
  if (!providerRef || !providerRef.awareness) return;

  providerRef.awareness.getStates().forEach((state, clientId) => {
    const avatar = document.getElementById(`avatar-${clientId}`);
    if (avatar) {
      if (state.speaking === true) {
        avatar.classList.add('speaking');
      } else {
        avatar.classList.remove('speaking');
      }
    }
  });
}
