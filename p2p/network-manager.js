// This module handles the core WebTorrent setup, peer wire management,
// and acts as the main dispatcher for all incoming P2P messages.

// --- IMPORTS ---
import WebTorrent from 'webtorrent';
import { epidemicGossip, state, peerManager, imageStore, dandelion, handleNewPost, handleProvisionalClaim, handleConfirmationSlip, handleParentUpdate, handlePostsResponse, handleCarrierUpdate, handleVerificationResults, generateAndBroadcastAttestation,evaluatePostTrust, handleDirectMessage } from '../main.js';
import { updateConnectionStatus, notify, updateStatus, refreshPost, renderPost } from '../ui.js';
import { CONFIG } from '../config.js';
import { generateId, hexToUint8Array, normalizePeerId, arrayBufferToBase64, base64ToArrayBuffer } from '../utils.js';
import { KademliaDHT } from './dht.js';
import { HyParView } from './hyparview.js';
import { Scribe } from './scribe.js';
import { Plumtree } from './plumtree.js';
import nacl from 'tweetnacl'; 


const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;


// --- FUNCTION DEFINITIONS ---

function initNetwork() { // It no longer needs to be async
  updateConnectionStatus("Initializing WebTorrent...");

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  console.log("Initializing network... iOS:", isIOS);

 
  if (!isNode && !window.RTCPeerConnection) {
    console.error("WebRTC not supported!");
    updateConnectionStatus("WebRTC not supported on this device", 'error');
    notify("WebRTC not supported on this device");
    return;
  }

  updateConnectionStatus("Setting up peer connections...");
  const trackers = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce',
  ];
  state.trackers = trackers;

  try {
    // This line will now use the `WebTorrent` variable we just defined above.
    state.client = new WebTorrent({
      dht: !isIOS,
      maxConns: isIOS ? 20 : 100,
      tracker: {
        announce: trackers,
        rtcConfig: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      },
      trickle: true
    });


    updateConnectionStatus("Joining DHT bootstrap network...");

    const bootstrapData = new Blob(['Ember-DHT-Bootstrap-v1'], { type: 'text/plain' });
    state.client.seed(bootstrapData, {
      name: 'ember-bootstrap.txt',
      announce: state.trackers || []
    }, torrent => {
      console.log(`Connected to bootstrap network: ${torrent.infoHash}`);
      updateConnectionStatus("Connected to Ember bootstrap network!");
      
      torrent.on('wire', (wire, addr) => {
        handleBootstrapWire(wire, addr);
      });
      
      torrent.on('error', (err) => {
        console.error('Bootstrap torrent error:', err);
        updateConnectionStatus(`Bootstrap error: ${err.message}`, 'error');
      });
      
      // Check peer count after a delay
      setTimeout(() => {
        if (torrent.numPeers === 0) {
          updateConnectionStatus("No peers found - you might be the first node! 🌟", 'info');
        }
      }, 10000);
    });

    // ADDED: Handle seed errors
    state.client.on('error', (err) => {
      if (err.message.includes('seed')) {
        console.error('Failed to seed bootstrap:', err);
        updateConnectionStatus('Failed to join bootstrap network', 'error');
        
        // Attempt recovery
        setTimeout(() => {
          console.log('Attempting to reconnect...');
          location.reload();
        }, 5000);
      }
    });



  } catch (e) {
    console.error("Failed to create WebTorrent client:", e);
    updateConnectionStatus(`Failed to initialize: ${e.message}`, 'error');
    throw e;
  }

  state.client.on("error", e => {
    console.error("Client error:", e.message);
    updateConnectionStatus(`Network error: ${e.message}`, 'error');
    if (!/Connection error|WebSocket/.test(e.message)) {
      notify("Network error: " + e.message);
    }
  });

  state.client.on('warning', (err) => {
    console.warn('WebTorrent warning:', err);
  });

  updateConnectionStatus("Network ready - using unified bootstrap");

  let lastPeerCount = 0;
    const statusCheckInterval = setInterval(() => {
      const currentPeerCount = state.peers.size;
      
      if (currentPeerCount !== lastPeerCount) {
        console.log(`Peer count changed: ${lastPeerCount} → ${currentPeerCount}`);
        if (currentPeerCount > 0 && lastPeerCount === 0) {
          updateConnectionStatus(`Connected! ${currentPeerCount} peer${currentPeerCount > 1 ? 's' : ''}`, 'success');
          notify("🔥 Another node joined the network!");
        } else if (currentPeerCount > lastPeerCount) {
          updateConnectionStatus(`${currentPeerCount} peers connected`, 'success');
        }
        lastPeerCount = currentPeerCount;
      }
      
      // Special handling for first node
      const timeSinceStart = Date.now() - (window.networkStartTime || Date.now());
      if (state.peers.size === 0 && timeSinceStart > 15000) {
        // After 15 seconds with no peers, assume we're first
        updateConnectionStatus("Running as first node - waiting for others to join... 🌟", 'info');
        clearInterval(statusCheckInterval); // Stop checking so frequently
      }
    }, 1000);

  window.networkStartTime = Date.now();
  console.log("Network initialization complete", {
    client: !!state.client,
    trackers: trackers.length
  });
}

function handleBootstrapWire(wire, addr) {
  const originalId = wire.peerId;
  const idKey = normalizePeerId(originalId);

  if (!idKey) {
    console.error('Invalid bootstrap peer ID');
    return;
  }
  if (state.peers.has(idKey)) return;

  console.log(`Bootstrap peer connected: ${idKey.substring(0, 12)}...`);
  wire.peerId = idKey;

  const peerData = {
    wire,
    addr,
    id: originalId,
    idKey: idKey,
    messageTimestamps: [],
    shardIndex: 'bootstrap',
    connectedAt: Date.now(),
    bytesReceived: 0,
    bytesSent: 0
  };

  state.peers.set(idKey, peerData);

  if (state.dht && originalId) {
    let uint8Id;
    if (originalId instanceof Uint8Array) {
      uint8Id = originalId;
    } else if (ArrayBuffer.isView(originalId)) {
      uint8Id = new Uint8Array(originalId.buffer, originalId.byteOffset, originalId.byteLength);
    } else if (typeof originalId === 'string') {
      const hex = originalId.replace(/^0x/, '');
      if (hex.length % 2 === 0) {
        uint8Id = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      }
    } else if (originalId && (originalId.type === 'Buffer' || originalId.data)) {
      uint8Id = new Uint8Array(originalId.data || originalId);
    }

    if (uint8Id) {
      state.dht.addPeer(uint8Id, peerData);
    }
  }

  if (state.hyparview && state.hyparview.activeView.size < state.hyparview.activeViewSize) {
    state.hyparview.addToActiveView(originalId, { wire, isOutgoing: false });
  }

  attachEphemeralExtension(wire);

    // Set up a delayed identity announcement
    setTimeout(async () => {
      if (wire.destroyed) return;
      
      // If we have an identity, announce our routing info
      if (state.myIdentity && state.identityRegistry) {
        try {
          await state.identityRegistry.updatePeerLocation(
            state.myIdentity.handle,
            state.myIdentity.nodeId,
            idKey // This is the normalized peer ID
          );
          console.log(`[Network] Announced routing info for ${state.myIdentity.handle}`);
          
          // Also send a direct announcement to this peer
          sendPeer(wire, {
            type: 'identity_announce',
            handle: state.myIdentity.handle,
            publicKey: state.myIdentity.publicKey,
            wirePeerId: idKey
          });
        } catch (e) {
          console.error('[Network] Failed to update peer location:', e);
        }
      }
    }, 2000); // Wait 2 seconds for connection to stabilize


  wire.on('close', () => {
    console.log(`Bootstrap peer disconnected: ${idKey.substring(0, 12)}...`);
    state.peers.delete(idKey);
    if (state.dht && originalId) state.dht.removePeer(originalId);
    if (state.hyparview && originalId) state.hyparview.handlePeerFailure(originalId);
    updateStatus();
  });

  wire.on('error', err => console.error(`Bootstrap wire error:`, err.message));
}

function handleWire(wire, addr) {
  // ADDED: Connection rate limiting
  if (!state.connectionTracker) {
    state.connectionTracker = new Map();
  }
  
  // Extract IP from address
    let ip = 'unknown';
    if (addr) {
        const lastColon = addr.lastIndexOf(':');
        if (addr.startsWith('[') && addr.includes(']')) {
            // IPv6 like [::1]:port
            ip = addr.substring(0, addr.indexOf(']') + 1);
        } else if (lastColon > addr.indexOf(':')) {
            // IPv4 like 127.0.0.1:port
            ip = addr.substring(0, lastColon);
        } else {
            // Address without port
            ip = addr;
        }
    }
    
  const now = Date.now();
  
  // Track connections per IP
  let ipData = state.connectionTracker.get(ip);
  if (!ipData) {
    ipData = { connections: [], blocked: false };
    state.connectionTracker.set(ip, ipData);
  }
  
  // Remove old connections (older than 1 minute)
  ipData.connections = ipData.connections.filter(time => now - time < 60000);
  
  // Check if IP is blocked
  if (ipData.blocked && now - ipData.blockedTime < 300000) { // 5 minute block
    console.warn(`Rejecting connection from blocked IP: ${ip}`);
    wire.destroy();
    return;
  }
  
  // Check rate limit (max 10 connections per minute per IP)
  if (ipData.connections.length >= 10) {
    console.warn(`Rate limit exceeded for IP: ${ip}`);
    ipData.blocked = true;
    ipData.blockedTime = now;
    wire.destroy();
    return;
  }
  
  // Track this connection
  ipData.connections.push(now);
  
  // Clean up tracker periodically
  if (state.connectionTracker.size > 1000) {
    const cutoff = now - 600000; // 10 minutes
    const toDelete = [];
    state.connectionTracker.forEach((data, ip) => {
      if (data.connections.length === 0 && (!data.blocked || now - data.blockedTime > 600000)) {
        toDelete.push(ip);
      }
    });
    toDelete.forEach(ip => state.connectionTracker.delete(ip));
  }
  
  const originalId = wire.peerId;
  const idKey = normalizePeerId(originalId);

  if (!idKey) {
    console.error('Invalid peer ID, rejecting connection');
    return;
  }
  if (state.peers.has(idKey)) return;

  wire.peerId = idKey;
  console.log(`New peer connection: ${idKey.substring(0, 12)}...`);

  const peerData = {
    wire,
    addr,
    id: originalId,
    idKey: idKey,
    messageTimestamps: [],
    connectedAt: Date.now(),
    bytesReceived: 0,
    bytesSent: 0
  };

  state.peers.set(idKey, peerData);

  if (state.dht) {
    let uint8Id;
    if (originalId instanceof Uint8Array) {
      uint8Id = originalId;
    } else if (ArrayBuffer.isView(originalId)) {
      uint8Id = new Uint8Array(originalId.buffer, originalId.byteOffset, originalId.byteLength);
    } else if (typeof originalId === 'string') {
      const hex = originalId.replace(/^0x/, '');
      if (hex.length % 2 === 0) {
        uint8Id = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      }
    } else if (originalId && (originalId.type === 'Buffer' || originalId.data)) {
      uint8Id = new Uint8Array(originalId.data || originalId);
    }
    if (uint8Id) {
      state.dht.addPeer(uint8Id, peerData);
    }
  }

  if (state.hyparview && state.hyparview.activeView.size < state.hyparview.activeViewSize) {
    state.hyparview.addToActiveView(originalId, { wire, isOutgoing: false });
  }

  peerManager.updateScore(idKey, 'connection', 1);
  updateStatus();

  wire.on('download', (bytes) => {
    peerData.bytesReceived += bytes;
    peerManager.updateScore(idKey, 'data', bytes / 1000);
  });

  wire.on('upload', (bytes) => {
    peerData.bytesSent += bytes;
  });

  attachEphemeralExtension(wire);


setTimeout(async () => {
  if (wire.destroyed) return;
  
  if (state.myIdentity && state.identityRegistry) {
    try {
      await state.identityRegistry.updatePeerLocation(
        state.myIdentity.handle,
        state.myIdentity.nodeId,
        idKey
      );
      console.log(`[Network] Announced routing info for ${state.myIdentity.handle}`);
      
      sendPeer(wire, {
        type: 'identity_announce',
        handle: state.myIdentity.handle,
        publicKey: state.myIdentity.publicKey,
        wirePeerId: idKey
      });
    } catch (e) {
      console.error('[Network] Failed to update peer location:', e);
    }
  }
}, 2000);


  const delay = Math.random() * 10000;
  setTimeout(() => {
    if (!wire.destroyed) {
      sendPeer(wire, { type: 'request_posts' });
    }
  }, delay);

  wire.on('close', () => {
    console.log(`Disconnected from peer: ${idKey}`);
    peerManager.updateScore(idKey, 'disconnection', 1);
    state.peers.delete(idKey);
    if (state.dht && originalId) state.dht.removePeer(originalId);
    if (state.hyparview && originalId) state.hyparview.handlePeerFailure(originalId);
    updateStatus();
  });

  wire.on('error', err => console.error(`Wire error ${idKey}:`, err.message));
}

const sendPeer = (wire, msg) => {
  if (!wire || wire.destroyed) return;

  try {
    const encoder = new TextEncoder();
    const msgStr = JSON.stringify(msg);
    
    // Add debug logging for chunk responses
    if (msg.type === 'chunk_response') {
      console.log(`[SendPeer] Sending chunk_response with ${msg.chunks.length} chunks for image ${msg.imageHash.substring(0, 8)}...`);
      console.log(`[SendPeer] Message size: ${msgStr.length} bytes (max: ${CONFIG.MAX_MESSAGE_SIZE})`);
    }
    
    if (msgStr.length > CONFIG.MAX_MESSAGE_SIZE) {
      console.warn("Message too large, dropping:", msgStr.length);
      return;
    }
    const data = encoder.encode(msgStr);

    // Add more debug info
    const extensionReady = wire.ephemeral_msg && wire.ephemeral_msg._ready;
    if (msg.type === 'chunk_response') {
      console.log(`[SendPeer] Extension ready: ${extensionReady}, wire destroyed: ${wire.destroyed}`);
    }

    if (wire.ephemeral_msg && wire.ephemeral_msg._ready && wire.ephemeral_msg.peerId !== undefined) {
      wire.extended(wire.ephemeral_msg.peerId, data);
      if (msg.type === 'chunk_response') {
        console.log('[SendPeer] Sent via ephemeral_msg extension');
      }
    } else if (wire.extendedMapping && wire.extendedMapping.ephemeral_msg !== undefined) {
      wire.extended(wire.extendedMapping.ephemeral_msg, data);
      if (msg.type === 'chunk_response') {
        console.log('[SendPeer] Sent via extendedMapping');
      }
    } else {
      if (!wire._pendingMessages) {
        wire._pendingMessages = [];
        // Start a timeout only for the *first* queued message
        wire._pendingTimeout = setTimeout(() => {
            if (wire._pendingMessages && wire._pendingMessages.length > 0) {
                console.warn(`[Extension] Clearing ${wire._pendingMessages.length} queued messages for unresponsive peer: ${wire.peerId}`);
                wire._pendingMessages = []; // Clear the queue
            }
        }, 15000); // 15 second timeout
      }

      wire._pendingMessages.push(msg);
      if (wire._pendingMessages.length > CONFIG.MAX_PENDING_MESSAGES) {
          wire._pendingMessages.shift(); // Remove oldest message
      }
      console.log(`[Extension] Queued message. Queue size: ${wire._pendingMessages.length}`);
    }
  } catch (e) {
    console.warn("sendPeer fail", e.message);
  }
};;

function attachEphemeralExtension(wire) {
  function EphemeralExtension() {
    const self = this;
    self._ready = false;
  }
  EphemeralExtension.prototype.name = 'ephemeral_msg';

EphemeralExtension.prototype.onExtendedHandshake = function (handshake) {
    if (!handshake.m || typeof handshake.m.ephemeral_msg === 'undefined') {
      console.warn('Peer does not support ephemeral_msg');
      // If handshake fails, clear any pending timeout and messages
      if (wire._pendingTimeout) clearTimeout(wire._pendingTimeout);
      wire._pendingMessages = [];
      return;
    }
    this.peerId = handshake.m.ephemeral_msg;
    this._ready = true;
    wire.ephemeral_msg = this;
    console.log('Extension ready! PeerID:', this.peerId);
    
    // Clear the timeout now that the handshake is successful
    if (wire._pendingTimeout) {
        clearTimeout(wire._pendingTimeout);
        wire._pendingTimeout = null;
    }
    
    if (wire._pendingMessages && wire._pendingMessages.length > 0) {
      console.log(`[Extension] Sending ${wire._pendingMessages.length} queued messages`);
      wire._pendingMessages.forEach(msg => sendPeer(wire, msg));
      wire._pendingMessages = [];
    }
    setTimeout(() => {
      if (!wire.destroyed && this._ready) {
        sendPeer(wire, { type: 'request_posts' });
        console.log('Sent initial request_posts');
      }
    }, 1000);
  };

  EphemeralExtension.prototype.onMessage = function (buf) {
    try {
      const msg = JSON.parse(new TextDecoder().decode(buf));
      console.log('Received message:', msg.type);
      handlePeerMessage(msg, wire);
    } catch (e) {
      console.error('Bad peer message:', e);
    }
  };
  wire.use(EphemeralExtension);
}

async function authenticatePeer(wire, peerId) {
  // Generate challenge
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const challengeB64 = arrayBufferToBase64(challenge);
  
  // Store challenge for verification
  if (!state.peerChallenges) state.peerChallenges = new Map();
  state.peerChallenges.set(peerId, { challenge: challengeB64, timestamp: Date.now() });
  
  // Send authentication request
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      state.peerChallenges.delete(peerId);
      resolve(false);
    }, 10000); // 10 second timeout
    
    sendPeer(wire, {
      type: 'auth_challenge',
      challenge: challengeB64
    });
    
    // Store resolver for when we get response
    state.peerChallenges.get(peerId).resolver = (success) => {
      clearTimeout(timeout);
      resolve(success);
    };
  });
}


function broadcast(msg, excludeWire = null) {
  if (!msg.msgId) {
    msg.msgId = generateId();
    msg.hops = 0;
  }

  if (epidemicGossip.messageTTL.has(msg.msgId)) {
    const hops = epidemicGossip.messageTTL.get(msg.msgId);
    if (hops >= epidemicGossip.maxHops) return;
    msg.hops = hops + 1;
  }
  epidemicGossip.messageTTL.set(msg.msgId, msg.hops);

  if (state.plumtree && state.hyparview && state.hyparview.getActivePeers().length > 2) {
    state.plumtree.broadcast(msg, excludeWire?.peerId?.toString('hex'));
  } else {
    const networkSize = state.peers.size;
    let fanout = Math.ceil(Math.log2(networkSize + 1)) + 2;
    fanout = Math.min(fanout, 8);
    const selected = epidemicGossip.selectRandomPeers(fanout, [excludeWire]);
    selected.forEach(peer => {
      epidemicGossip.sendWithExponentialBackoff(peer, msg);
    });
  }
}

async function handlePeerMessage(msg, fromWire) {
  if (msg.msgId && state.seenMessages.has(msg.msgId)) {
    return;
  }
  if (msg.msgId) {
    state.seenMessages.add(msg.msgId);
  }

  const peerId = fromWire.peerId;
  const peerData = state.peers.get(peerId);
  if (peerData) {
    const now = Date.now();
    peerData.messageTimestamps.push(now);
    peerData.messageTimestamps = peerData.messageTimestamps.filter(
      ts => now - ts < CONFIG.RATE_LIMIT_WINDOW
    );
    const rateLimitedMessageTypes = ['new_post', 'parent_update'];
    if (rateLimitedMessageTypes.includes(msg.type)) {
      if (peerData.messageTimestamps.length > CONFIG.RATE_LIMIT_MESSAGES) {
        console.warn(`Rate limit exceeded for peer ${peerId} for message type: ${msg.type}. Dropping message.`);
        return;
      }
    }
  }
  
  if (state.trafficMixer && (msg.type === "new_post" || msg.type === "carrier_update")) {
      state.trafficMixer.addToMixPool(msg, fromWire);
  }

  switch (msg.type) {
    case "dht_rpc":
      if (state.dht) state.dht.handleRPC(msg, fromWire);
      break;
    case "hyparview":
      if (state.hyparview) state.hyparview.handleMessage(msg, fromWire);
      break;
    case "scribe":
      if (state.scribe) state.scribe.handleMessage(msg, fromWire);
      break;
    case "plumtree":
        if (state.plumtree) state.plumtree.handleMessage(msg, fromWire);
        break;
    case "onion_relay":
        dandelion.handleOnionRelay(msg, fromWire);
        break;
    case 'provisional_identity_claim':
        await handleProvisionalClaim(msg.claim);
        break;
    case "request_image_chunks":
      if (msg.imageHash && Array.isArray(msg.chunkHashes) && msg.chunkHashes.length <= 100) {
        handleChunkRequest(msg.imageHash, msg.chunkHashes, fromWire);
      }
      break;
    case 'post_attestation':
      handlePostAttestation(msg, fromWire);
      break;
    case "chunk_response":
      if (msg.imageHash && msg.chunks) {
        handleChunkResponse(msg);
      }
      break;
    case 'identity_confirmation_slip':
        await handleConfirmationSlip(msg.slip);
        break;
    case "peer_exchange":
      if (msg.peers && Array.isArray(msg.peers)) {
        msg.peers.forEach(peerInfo => {
          try {
            let peerId;
            if (typeof peerInfo.id === 'string') {
              peerId = hexToUint8Array(peerInfo.id);
            } else if (peerInfo.id instanceof Uint8Array) {
              peerId = peerInfo.id;
            } else if (peerInfo.id && (peerInfo.id.type === 'Buffer' || peerInfo.id.data)) {
              peerId = new Uint8Array(peerInfo.id.data || peerInfo.id);
            }
            if (peerId && state.dht) {
              // Check if the peer is our own ID. Only perform this check if our identity has been created.
              const isSelf = state.myIdentity && state.dht.uint8ArrayEquals(peerId, state.myIdentity.nodeId);
              
              if (!isSelf) {
                state.dht.addPeer(peerId, { wire: null });
              }
            }
          } catch (e) {
            console.error("Error in peer exchange:", e);
          }
        });
      }
      break;
    case "e2e_dm":
      await handleDirectMessage(msg, fromWire);
      break;
    case "noise":
      return;
    case "new_post":
      if (msg.phase === "stem" || msg.phase === "fluff") {
        dandelion.handleRoutedPost(msg, fromWire);
      } else {
        await handleNewPost(msg.post || msg, fromWire);
      }
      break;
    case "request_image":
      handleImageRequest(msg.imageHash, fromWire);
      break;
    case "image_response":
      handleImageResponse(msg);
      break;
    case "parent_update":
      handleParentUpdate(msg);
      break;
    case "request_posts":
      if (fromWire) {
        const list = [...state.posts.values()].map(p => p.toJSON());
        sendPeer(fromWire, { type: "posts_response", posts: list });
      }
      break;
    case "posts_response":
      await handlePostsResponse(msg.posts, fromWire);
      break;
    case "carrier_update":
      handleCarrierUpdate(msg);
      break;
    case "auth_challenge":
      if (state.myIdentity && state.myIdentity.secretKey) {
        const signature = nacl.sign(
          base64ToArrayBuffer(msg.challenge),
          state.myIdentity.secretKey
        );
        sendPeer(fromWire, {
          type: 'auth_response',
          signature: arrayBufferToBase64(signature),
          handle: state.myIdentity.handle,
          publicKey: state.myIdentity.publicKey
        });
      }
      break;

    case "auth_response":
      const peerId = fromWire.peerId;
      const challenge = state.peerChallenges?.get(peerId);
      if (challenge && msg.signature && msg.publicKey) {
        const verified = nacl.sign.open(
          base64ToArrayBuffer(msg.signature),
          base64ToArrayBuffer(msg.publicKey)
        );
        if (verified && arrayBufferToBase64(verified) === challenge.challenge) {
          // Authentication successful
          const peerData = state.peers.get(peerId);
          if (peerData) {
            peerData.authenticated = true;
            peerData.handle = msg.handle;
            peerData.publicKey = msg.publicKey;
          }
          challenge.resolver(true);
        } else {
          challenge.resolver(false);
        }
        state.peerChallenges.delete(peerId);
      }
      break;
    case "identity_announce":
      if (msg.handle && msg.publicKey && msg.wirePeerId) {
        console.log(`[Network] Received identity announcement from ${msg.handle}`);
        
        // Store the wire-to-handle mapping locally for quick lookups
        if (!state.peerIdentities) state.peerIdentities = new Map();
        state.peerIdentities.set(fromWire.peerId, {
          handle: msg.handle,
          publicKey: msg.publicKey,
          timestamp: Date.now()
        });
        
        // Update the peer data with identity info
        const peerData = state.peers.get(fromWire.peerId);
        if (peerData) {
          peerData.handle = msg.handle;
          peerData.identityVerified = false; // Will verify later
          
          // Verify the identity claim asynchronously
          state.identityRegistry.lookupHandle(msg.handle).then(claim => {
            if (claim && claim.publicKey === msg.publicKey) {
              peerData.identityVerified = true;
              console.log(`[Network] Verified identity for peer ${msg.handle}`);
            }
          });
        }
      }
      break;
      case "dm_delivered":
          if (msg.messageId) {
            console.log(`[DM] Received delivery confirmation for message ${msg.messageId}`);
            stateManager.markMessageDelivered(msg.messageId);
            
            // Update UI to show delivered status
            notify(`Message to ${msg.recipient} delivered ✓`);
          }
          break;
    case "routing_update":
      if (msg.handle && msg.nodeId && msg.peerId && msg.timestamp) {
        console.log(`[Network] Received routing update from ${msg.handle}`);
        
        // Verify the update is recent
        const age = Date.now() - msg.timestamp;
        if (age > 300000) { // 5 minutes
          console.log(`[Network] Ignoring stale routing update (${age}ms old)`);
          break;
        }
        
        // Store in our local routing cache
        if (!state.peerRoutingCache) state.peerRoutingCache = new Map();
        state.peerRoutingCache.set(msg.handle, {
          nodeId: msg.nodeId,
          peerId: msg.peerId,
          timestamp: msg.timestamp,
          publicKey: msg.publicKey,
          fromWire: fromWire.peerId
        });
        
        // Update the DHT if we have it
        if (state.identityRegistry) {
          const routingKey = `routing:${msg.handle.toLowerCase()}`;
          const routingInfo = {
            handle: msg.handle,
            nodeId: msg.nodeId,
            wirePeerId: msg.peerId,
            timestamp: msg.timestamp,
            ttl: 300000
          };
          
          // FIXED: Use proper DHT store method with propagate: false
          state.dht.store(routingKey, routingInfo, { propagate: false })
            .then(() => {
              console.log(`[Network] Stored routing info for ${msg.handle} in local DHT`);
            })
            .catch(e => {
              console.error(`[Network] Failed to store routing info:`, e);
            });
        }
        
        // Update peer identity mapping
        const peerData = state.peers.get(fromWire.peerId);
        if (peerData) {
          peerData.handle = msg.handle;
          peerData.lastRoutingUpdate = Date.now();
        }
      }
      break;

    case "routing_heartbeat":
      if (msg.handle && msg.timestamp) {
        // Update last seen time for this peer's routing
        if (state.peerRoutingCache && state.peerRoutingCache.has(msg.handle)) {
          const cached = state.peerRoutingCache.get(msg.handle);
          cached.lastHeartbeat = Date.now();
        }
        
        // Update peer data
        const peerData = state.peers.get(fromWire.peerId);
        if (peerData) {
          peerData.lastHeartbeat = Date.now();
        }
      }
      break;
  }
}


async function handlePostAttestation(msg, fromWire) {
  const { attestation, attesterHandle, attesterPublicKey, signature } = msg;
  
  if (!attestation || !attesterHandle || !attesterPublicKey || !signature) {
    console.warn('[Attestation] Invalid attestation message format');
    return;
  }
  
  // Verify the signature
  try {
    const dataToVerify = JSON.stringify(attestation);
    const publicKey = base64ToArrayBuffer(attesterPublicKey);
    const sig = base64ToArrayBuffer(signature);
    
    const verified = nacl.sign.open(sig, publicKey);
    if (!verified) {
      console.warn(`[Attestation] Invalid signature from ${attesterHandle}`);
      return;
    }
    
    const decodedData = new TextDecoder().decode(verified);
    if (decodedData !== dataToVerify) {
      console.warn(`[Attestation] Signature mismatch from ${attesterHandle}`);
      return;
    }
  } catch (e) {
    console.error('[Attestation] Signature verification failed:', e);
    return;
  }
  
  // Check attestation age (prevent replay attacks)
  const age = Date.now() - attestation.timestamp;
  if (age > 60000) { // Reject attestations older than 1 minute
    console.warn(`[Attestation] Attestation too old: ${age}ms`);
    return;
  }
  
  // Get attester's reputation
  const peerId = fromWire.peerId;
  const reputation = peerManager.getScore(peerId);
  const canTrust = peerManager.canTrustAttestations(peerId);
  
  console.log(`[Attestation] Received from ${attesterHandle} (rep: ${reputation.toFixed(2)}, trusted: ${canTrust})`);
  
  // Find the post (could be in pendingVerification or already in posts)
  let post = state.pendingVerification.get(attestation.postId);
  if (!post) {
    post = state.posts.get(attestation.postId);
  }
  
  if (!post) {
    console.log(`[Attestation] Post ${attestation.postId} not found`);
    return;
  }
  
  // Add attestation to the post
  const wasNew = post.addAttestation(attesterHandle, reputation);
  
  if (wasNew) {
    console.log(`[Attestation] Added to post ${attestation.postId}, trust score: ${post.trustScore.toFixed(2)}`);
    
    // Track attestation for reputation
    peerManager.updateScore(peerId, 'attestation', 1);
    
    // Nudge the verifier so we don't wait for the next scheduled sweep
    if (state.pendingVerification.has(attestation.postId)) { 
        evaluatePostTrust(attestation.postId); 
    }
    
    // If post is still pending and now has enough trust, promote it
    if (state.pendingVerification.has(attestation.postId) && 
        post.hasSufficientTrust(CONFIG.TRUST_THRESHOLD)) {
      console.log(`[Attestation] Post ${attestation.postId} reached trust threshold, promoting without verification`);
      
      // Move from pending to verified
      state.pendingVerification.delete(attestation.postId);
      post.verified = true;
      state.posts.set(post.id, post);
      renderPost(post);
      notify(`Post verified by peer attestations`);
      
      // The attester gets credit for a correct attestation
      peerManager.updateScore(peerId, 'correct_attestation', 1);
    }
  }
}

async function handleImageRequest(imageHash, fromWire) {
    const metadata = imageStore.images.get(imageHash);
    if (!metadata) {
        console.log(`[ImageRequest] Peer requested image ${imageHash.substring(0, 8)}... but we don't have its metadata.`);
        return;
    }
    console.log(`[ImageRequest] Peer requested image ${imageHash.substring(0, 8)}.... We have metadata and will send available chunks.`);

    const chunks = [];
    for (const chunkMeta of metadata.chunks) {
        const chunkData = imageStore.chunks.get(chunkMeta.hash);
        if (chunkData) {
            chunks.push({ hash: chunkMeta.hash, data: chunkData });
        } else {
            console.warn(`[ImageRequest] Missing chunk ${chunkMeta.hash.substring(0, 8)}... for image ${imageHash.substring(0, 8)}... that we should have.`);
        }
    }

    sendPeer(fromWire, {
        type: "image_response",
        imageHash: imageHash,
        metadata: metadata,
        chunks: chunks
    });
}

async function handleImageResponse(msg) {
    console.log(`[ImageResponse] Received image response for hash: ${msg.imageHash.substring(0, 8)}...`);
    if (!imageStore.images.has(msg.imageHash) && msg.metadata) {
        imageStore.images.set(msg.imageHash, msg.metadata);
    }

    if (msg.chunks && Array.isArray(msg.chunks)) {
        for (const chunk of msg.chunks) {
            if (chunk.hash && chunk.data && !imageStore.chunks.has(chunk.hash)) {
                // For simplicity, we assume the chunk hash is valid here. A robust implementation would verify it.
                imageStore.chunks.set(chunk.hash, chunk.data);
            }
        }
    }

    const imageData = await imageStore.retrieveImage(msg.imageHash);

    if (imageData) {
        // Check if a post was waiting for this image in the verification queue
        const pendingPost = Array.from(state.pendingVerification.values()).find(p => p.imageHash === msg.imageHash);

        if (pendingPost) {
            console.log(`[Image] Found pending post ${pendingPost.id} for received image. Promoting to feed.`);
            pendingPost.imageData = imageData;

            // Perform the final processing steps that were deferred in handleVerificationResults
            if (pendingPost.parentId) {
                const parent = state.posts.get(pendingPost.parentId);
                if (parent) {
                    parent.replies.add(pendingPost.id);
                    pendingPost.depth = Math.min(parent.depth + 1, 5);
                    refreshPost(parent);
                } else {
                    pendingPost.depth = 1;
                }
            }

            state.posts.set(pendingPost.id, pendingPost);
            renderPost(pendingPost); // Render for the first time
            generateAndBroadcastAttestation(pendingPost);

            // Finally, remove it from the pending queue
            state.pendingVerification.delete(pendingPost.id);
            notify(`Added 1 new post (with image)`);
            return; // Exit after handling the pending post
        }

        // Fallback for existing posts that might have been rendered with placeholders
        for (const [id, post] of state.posts) {
            if (post.imageHash === msg.imageHash && !post.imageData) {
                post.imageData = imageData;
                refreshPost(post);
            }
        }
    } else {
        // The image is still not complete, request the remaining chunks
        const metadata = imageStore.images.get(msg.imageHash);
        if (metadata) {
            const missingChunkHashes = metadata.chunks
                .filter(chunkMeta => !imageStore.chunks.has(chunkMeta.hash))
                .map(chunkMeta => chunkMeta.hash);

            if (missingChunkHashes.length > 0) {
                console.log(`[ImageResponse] Still missing ${missingChunkHashes.length} chunks. Requesting again.`);
                const peers = Array.from(state.peers.values()).slice(0, 3);
                for (const peer of peers) {
                    sendPeer(peer.wire, {
                        type: "request_image_chunks",
                        imageHash: msg.imageHash,
                        chunkHashes: missingChunkHashes
                    });
                }
            }
        }
    }
}

function handleChunkRequest(imageHash, requestedHashes, fromWire) {
    console.log(`[ChunkRequest] Peer requested ${requestedHashes.length} chunks for image ${imageHash.substring(0, 8)}...`);
    
    const chunks = [];
    for (const hash of requestedHashes) {
        const chunk = imageStore.chunks.get(hash);
        if (chunk) {
            chunks.push({ hash, data: chunk });
        }
    }
    
    if (chunks.length > 0) {
        console.log(`[ChunkRequest] Sending ${chunks.length} chunks for image ${imageHash.substring(0, 8)}...`);
        sendPeer(fromWire, {
            type: "chunk_response",
            imageHash: imageHash,
            chunks: chunks,
            requestId: requestedHashes.requestId
        });
    } else {
        console.log(`[ChunkRequest] No chunks found for image ${imageHash.substring(0, 8)}...`);
    }
}

async function handleChunkResponse(msg) {
    if (!msg || !msg.imageHash || !Array.isArray(msg.chunks)) {
        console.warn("Received an incomplete chunk response, ignoring.");
        return;
    }
    
    console.log(`[ChunkResponse] Received ${msg.chunks.length} chunks for image ${msg.imageHash.substring(0, 8)}...`);
    
    let newChunksCount = 0;
    for (const { hash, data } of msg.chunks) {
        if (!imageStore.chunks.has(hash)) {
            // Verify chunk hash before storing
            const actualHash = await imageStore.sha256(data);
            if (actualHash === hash) {
                imageStore.chunks.set(hash, data);
                newChunksCount++;
                
                // Notify any pending requests via a custom event
                if (msg.requestId) {
                    window.dispatchEvent(new CustomEvent(`chunk_received_${msg.requestId}`, {
                        detail: {
                            chunkHash: hash,
                            imageHash: msg.imageHash
                        }
                    }));
                }
            } else {
                console.warn(`[ChunkResponse] Chunk hash mismatch! Expected ${hash.substring(0, 8)}..., got ${actualHash.substring(0, 8)}...`);
            }
        }
    }
    
    if (newChunksCount > 0) {
        console.log(`[ChunkResponse] Stored ${newChunksCount} new chunks for image ${msg.imageHash.substring(0, 8)}...`);
        
        // Try to retrieve the image now that we have new chunks
        const imageData = await imageStore.retrieveImage(msg.imageHash);
        if (imageData) {
            // Update all posts that need this image
            for (const [id, post] of state.posts) {
                if (post.imageHash === msg.imageHash && !post.imageData) {
                    post.imageData = imageData;
                    refreshPost(post);
                }
            }
        }
    }
}


// --- EXPORTS ---
// Export the functions that main.js needs to call.
export {
  initNetwork,
  broadcast,
  sendPeer,
  handlePeerMessage
};
