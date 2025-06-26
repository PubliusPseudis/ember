// main.js
// This is the main entry point and orchestrator for the entire application.
// It initializes all modules, manages the global state, and wires up event handlers.

// --- 1. IMPORTS ---
import { CONFIG } from './config.js';
import { Post } from './models/post.js';
import { VerificationQueue } from './verification-queue.js';

import { applyTheme, setupThemeToggle, showConnectScreen, updateLoadingMessage, renderPost, refreshPost, dropPost, updateStatus, notify, loadTopicSubscriptions, updateTopicFilter, addTopicToUI, updateAges, updateTopicStats, handleImageSelect, removeImage, toggleReplyForm, discoverAndFilterTopic, filterByTopic, setFeedMode, completeTopicSuggestion, scrollToPost , subscribeToTopic,handleReplyImageSelect,removeReplyImage } from './ui.js';
import { StateManager } from './storage.js';
import { MemoryManager } from './services/memory-manager.js';
import { PeerManager } from './services/peer-manager.js';
import { ContentAddressedImageStore } from './services/image-store.js';
import { initIdentity } from './identity/identity-flow.js';
import { IdentityRegistry } from './identity/identity-manager.js';
import { ProgressiveVDF } from './identity/vdf.js';
import { initNetwork, broadcast, sendPeer} from './p2p/network-manager.js';
import { NoiseGenerator } from './p2p/noise-generator.js';
import { TrafficMixer } from './p2p/traffic-mixer.js';
import { DandelionRouter } from './p2p/dandelion.js';
import { HierarchicalBloomFilter, BloomFilter, generateId, isReply, arrayBufferToBase64, base64ToArrayBuffer, JSONStringifyWithBigInt } from './utils.js';
import wasmVDF from './vdf-wrapper.js'; 
import { EpidemicGossip } from './p2p/epidemic-gossip.js';


// --- 2. GLOBAL STATE ---
export const state = {
  posts: new Map(),
  peers: new Map(),
  myIdentity: null,
  client: null,
  provisionalIdentities: new Map(),
  explicitlyCarrying: new Set(),
  viewing: new Set(),
  toxicityClassifier: null,
  imageClassifier: null,
  seenMessages: new HierarchicalBloomFilter(),
  seenPosts: new HierarchicalBloomFilter(),
  dht: null,
  hyparview: null,
  scribe: null,
  plumtree: null,
  identityRegistry: null,
  subscribedTopics: new Set(['#general', '#ember']),
  topicFilter: '',
  feedMode: 'all',
  pendingVerification: new Map(),
};


// --- 3. SERVICE INSTANCES ---
export const stateManager = new StateManager();
export const verificationQueue = new VerificationQueue();
export const imageStore = new ContentAddressedImageStore();
export const peerManager = new PeerManager();
export const memoryManager = new MemoryManager();
export const progressiveVDF = new ProgressiveVDF();
export const noiseGenerator = new NoiseGenerator();
export const trafficMixer = new TrafficMixer();
export const dandelion = new DandelionRouter();
export const epidemicGossip = new EpidemicGossip();


// --- 4. CORE LOGIC & HANDLERS ---
function applyConfigToUI() {
  const postInput = document.getElementById('post-input');
  if (postInput) {
    postInput.maxLength = CONFIG.MAX_POST_SIZE;
  }

  const charCountDisplay = document.querySelector('#compose .char-count');
  if (charCountDisplay) {
    charCountDisplay.innerHTML = `<span id="char-current">0</span>/${CONFIG.MAX_POST_SIZE}`;
  }
}

async function initContentFilter() {
  try {
    state.toxicityClassifier = await toxicity.load(CONFIG.TOXICITY_THRESHOLD);
    console.log("Toxicity model ready");
  } catch (e) {
    console.error("Toxicity model failed:", e);
  }
}

async function initImageFilter() {
    try {
        state.imageClassifier = await nsfwjs.load(CONFIG.NSFWJS_MODEL_PATH);
        console.log("Image filter model ready");
    } catch (e) {
        console.error("Image filter failed to load:", e);
    }
}

export async function isToxic(text) {
  if (!state.toxicityClassifier) return false;
  try {
    const preds = await state.toxicityClassifier.classify([text]);
    for (const p of preds) if (p.results[0].match) return p.label;
    return false;
  } catch (e) {
    console.error("toxicity check failed:", e);
    return false;
  }
}

export async function isImageToxic(imageData) {
    if (!state.imageClassifier) return false;
    try {
        const img = new Image();
        img.src = imageData;
        await new Promise((resolve) => img.onload = resolve);
        const predictions = await state.imageClassifier.classify(img);
        const problematic = predictions.find(p => {
            if (p.className === 'Porn' && p.probability > 0.7) return true;
            if (p.className === 'Hentai' && p.probability > 0.7) return true;
            if (p.className === 'Sexy' && p.probability > 0.8) return true;
            return false;
        });
        return problematic ? problematic.className : false;
    } catch (e) {
        console.error("Image classification failed:", e);
        return false;
    }
}

export async function handleNewPost(data, fromWire) {
  const postData = data.post || data;

  if (!postData?.id || state.posts.has(postData.id) || state.seenPosts.has(postData.id)) {
    return;
  }
  if (postData.content.length > CONFIG.MAX_POST_SIZE) {
    return;
  }
  if (await isToxic(postData.content)) {
    return;
  }

  state.seenPosts.add(postData.id);
  const p = Post.fromJSON(postData);
  state.pendingVerification.set(p.id, p);

  verificationQueue.addBatch([postData], 'high', (results) => {
    handleVerificationResults(results);
  });

  broadcast({ type: "new_post", post: postData }, fromWire);
}

export function findRootPost(postId) {
  let current = postId;
  let post = state.posts.get(current);
  const visited = new Set();
  
  while (post && post.parentId && !visited.has(current)) {
    visited.add(current);
    current = post.parentId;
    post = state.posts.get(current);
  }
  
  return current;
}

export async function handlePostsResponse(list, fromWire) {
  if (!Array.isArray(list)) return;

  console.log(`Received ${list.length} posts, queuing for verification...`);
  const postsToVerify = [];
  for (const postData of list) {
    if (!postData?.id || state.posts.has(postData.id) || state.seenPosts.has(postData.id)) {
      continue;
    }
    if (postData.content.length > CONFIG.MAX_POST_SIZE) {
      continue;
    }
    state.seenPosts.add(postData.id);
    const p = Post.fromJSON(postData);
    state.pendingVerification.set(p.id, p);
    postsToVerify.push(postData);
  }

  if (postsToVerify.length > 0) {
    postsToVerify.sort((a, b) => {
      if (!a.parentId && b.parentId) return -1;
      if (a.parentId && !b.parentId) return 1;
      return a.timestamp - b.timestamp;
    });
    verificationQueue.addBatch(postsToVerify, 'normal', (results) => {
      handleVerificationResults(results);
    });
  }
}

export async function handleVerificationResults(results) {
    let newlyVerifiedCount = 0;
    console.log(`[Debug] Processing ${results.length} verification results`);
    
    for (const result of results) {
        const post = state.pendingVerification.get(result.id);
        if (!post) continue;
        
        console.log(`[Debug] Processing post ${result.id.substring(0,8)}... hasImage: ${!!post.imageHash}, parentId: ${post.parentId || 'none'}, valid: ${result.valid}`);
        
        if (result.valid) {
            post.verified = true;
            
            // Check identity but don't require it for post acceptance
            let identityStatus = 'unknown';
            if (state.identityRegistry) {
                try {
                    const claim = await state.identityRegistry.lookupHandle(post.author);
                    if (claim) {
                        // Identity found - verify it matches
                        const identityValid = await state.identityRegistry.verifyAuthorIdentity(post);
                        identityStatus = identityValid ? 'verified' : 'mismatch';
                    }
                    // If no claim found, identityStatus remains 'unknown'
                } catch (e) {
                    console.warn(`Identity check error for ${post.author}:`, e);
                }
            }
            
            post.identityStatus = identityStatus;
            
            // Reject only if identity exists but doesn't match (impersonation)
            if (identityStatus === 'mismatch') {
                console.warn(`Rejecting post from ${post.author} - identity mismatch!`);
                state.pendingVerification.delete(result.id);
                continue;
            }
            
            // Handle parent/reply relationships
            if (post.parentId) {
                const parent = state.posts.get(post.parentId);
                if (parent) {
                    parent.replies.add(post.id);
                    post.depth = Math.min(parent.depth + 1, 5);
                    refreshPost(parent);
                } else {
                    // Parent not found yet - set default depth
                    post.depth = 1;
                    console.log(`Reply ${post.id} added without parent ${post.parentId}`);
                }
            }
            
            // Handle images
            if (post.imageHash && !post.imageData) {
                const imageData = await imageStore.retrieveImage(post.imageHash);
                if (imageData) {
                    post.imageData = imageData;
                } else {
                    const peers = Array.from(state.peers.values()).slice(0, 3);
                    for (const peer of peers) {
                        sendPeer(peer.wire, { type: "request_image", imageHash: post.imageHash });
                    }
                }
            }
            
            state.posts.set(post.id, post);
            console.log(`[Debug] Added post ${post.id.substring(0,8)}... to state.posts. Total posts: ${state.posts.size}`);
            renderPost(post);
            newlyVerifiedCount++;
        }
        
        state.pendingVerification.delete(result.id);
    }
    
    console.log(`[Debug] Finished processing. Added ${newlyVerifiedCount} posts. state.posts.size: ${state.posts.size}`);

    if (newlyVerifiedCount > 0) {
        notify(`Added ${newlyVerifiedCount} new verified posts`);
    }
}

export async function handleProvisionalClaim(claim) {
    if (!claim || !claim.handle || !claim.vdfProof || !claim.signature) {
        return;
    }
    if (await state.dht.get(`identity:handle:${claim.handle}`)) return;
    if (state.provisionalIdentities.has(claim.handle)) return;

    try {
        const vdfProofForVerification = new wasmVDF.VDFProof(claim.vdfProof.y, claim.vdfProof.pi, claim.vdfProof.l, claim.vdfProof.r, BigInt(claim.vdfProof.iterations));
        const isVdfValid = await wasmVDF.computer.verify_proof(claim.vdfInput, vdfProofForVerification);
        if (!isVdfValid) {
            return;
        }
        const claimDataToVerify = JSON.stringify({
            handle: claim.handle,
            publicKey: claim.publicKey,
            vdfProof: claim.vdfProof
        });
        const publicKeyBytes = base64ToArrayBuffer(claim.publicKey);
        const signatureBytes = new Uint8Array(Object.values(claim.signature));
        if (nacl.sign.open(signatureBytes, publicKeyBytes) === null) {
            return;
        }
    } catch (e) {
        return;
    }

    state.provisionalIdentities.set(claim.handle, {
        claim: claim,
        confirmations: new Set()
    });
    const claimHash = await hashClaim(claim);
    const slipDataToSign = JSON.stringify({ handle: claim.handle, claimHash });
    const slipSignature = nacl.sign(new TextEncoder().encode(slipDataToSign), state.myIdentity.secretKey);
    const slip = {
        handle: claim.handle,
        claimHash: claimHash,
        confirmerHandle: state.myIdentity.handle,
        confirmerPublicKey: arrayBufferToBase64(state.myIdentity.publicKey),
        signature: slipSignature
    };
    broadcast({ type: 'identity_confirmation_slip', slip: slip });
}

export async function handleConfirmationSlip(slip) {
    if (!slip || !slip.handle || !slip.claimHash || !slip.confirmerPublicKey || !slip.signature) return;
    const provisionalEntry = state.provisionalIdentities.get(slip.handle);
    if (!provisionalEntry) return;
    const slipDataToVerify = JSON.stringify({ handle: slip.handle, claimHash: slip.claimHash });
    const isSlipSignatureValid = nacl.sign.open(slip.signature, base64ToArrayBuffer(slip.confirmerPublicKey)) !== null;
    if (!isSlipSignatureValid) {
        return;
    }
    const expectedHash = await hashClaim(provisionalEntry.claim);
    if (slip.claimHash !== expectedHash) {
        return;
    }
    provisionalEntry.confirmations.add(slip.confirmerHandle);
    if (provisionalEntry.confirmations.size >= CONFIG.IDENTITY_CONFIRMATION_THRESHOLD) {
        await state.dht.store(`identity:handle:${slip.handle}`, provisionalEntry.claim);
        state.provisionalIdentities.delete(slip.handle);
        if (slip.handle === state.myIdentity.handle) {
            notify(`Your handle "${slip.handle}" has been confirmed by the network!`);
            state.myIdentity.isRegistered = true;
            state.myIdentity.registrationVerified = true;
        }
    }
}

export async function hashClaim(claim) {
    const claimString = JSON.stringify({
        handle: claim.handle,
        publicKey: claim.publicKey,
        vdfProof: claim.vdfProof
    });
    const encoder = new TextEncoder();
    const data = encoder.encode(claimString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function handleCarrierUpdate(msg) {
    const p = state.posts.get(msg.postId);
    if (!p) return;
    const handle = msg.peer || msg.fromIdentityHandle;
    if (!handle) return;
    if (msg.carrying) {
        p.carriers.add(handle);
    } else {
        p.carriers.delete(handle);
    }
    if (p.carriers.size === 0 && !isReply(p)) {
        if (!debugPostRemoval(p.id, 'carrier update - no carriers')) {
            state.posts.delete(p.id);
            dropPost(p.id);
        }
    } else {
        refreshPost(p);
    }
}

export function handleParentUpdate(msg) {
    const parent = state.posts.get(msg.parentId);
    const reply = state.posts.get(msg.replyId);
    if (parent && reply) {
        parent.replies.add(msg.replyId);
        refreshPost(parent);
    }
}

export async function createPostWithTopics() {
    const input = document.getElementById("post-input");
    const txt = input.value.trim();
    if (!txt) return;

    const topics = state.scribe ? state.scribe.extractTopics(txt) : ['#general'];
    const imagePreview = document.getElementById('image-preview');
    const imageData = imagePreview.dataset.imageData || null;
    const btn = document.getElementById("send-button");
    btn.disabled = true;

    notify("Computing proof of work...", 10000);

    try {
        const vdfInput = txt + state.myIdentity.uniqueId + Date.now();
        btn.textContent = "Computing proof...";
        const proof = await progressiveVDF.computeAdaptiveProof(txt, state.myIdentity.uniqueId, vdfInput);
        if (await isToxic(txt)) {
            notify(`Your post may be seen as toxic. Please rephrase.`);
            btn.disabled = false;
            btn.textContent = "🔥 Light it up";
            return;
        }
        if (imageData && await isImageToxic(imageData)) {
            notify("Image content not allowed");
            btn.disabled = false;
            btn.textContent = "🔥 Light it up";
            return;
        }
        
        const p = new Post(txt, null, imageData);
        p.verified = true;
        if (imageData) {
            await p.processImage();
        }
        
        p.vdfProof = proof;
        p.vdfInput = vdfInput;
        p.sign(state.myIdentity.secretKey);

        state.posts.set(p.id, p);
        input.value = "";
        document.getElementById("char-current").textContent = 0;
        renderPost(p);

        if (state.peers.size >= 3) {
            dandelion.routePostSecure(p);
        } else {
            dandelion.routePost(p);
        }

        if (state.scribe) {
            topics.forEach(topic => {
                state.scribe.multicast(topic, { type: 'new_post', post: p.toJSON() });
            });
        }

        removeImage();

        btn.disabled = false;
        btn.textContent = "🔥 Light it up";
        notify("Posted to the void");
    } catch (error) {
        console.error("VDF computation failed:", error);
        notify("Failed to compute proof of work", 5000);
        btn.disabled = false;
        btn.textContent = "🔥 Light it up";
    }
}

export function toggleCarry(id, isManual = true) {
    const p = state.posts.get(id);
    if (!p) return;
    const isCarrying = p.carriers.has(state.myIdentity.handle);

    if (!isCarrying) {
        p.carriers.add(state.myIdentity.handle);
        state.explicitlyCarrying.add(id);
        broadcast({ type: "carrier_update", postId: id, peer: state.myIdentity.handle, carrying: true });
        refreshPost(p);
    } else {
        p.carriers.delete(state.myIdentity.handle);
        state.explicitlyCarrying.delete(id);
        broadcast({ type: "carrier_update", postId: id, peer: state.myIdentity.handle, carrying: false });
        if (p.carriers.size === 0 && !isReply(p)) {
            if (!debugPostRemoval(p.id, 'toggleCarry - withdrawn')) {
                state.posts.delete(p.id);
                dropPost(id);
            }
        } else {
            refreshPost(p);
        }
    }
}

export async function createReply(parentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    if (!input) return;
    const txt = input.value.trim();
    if (!txt) return;
    
    const btn = input.parentElement.querySelector('button');
    btn.disabled = true;
    
    const parentPost = state.posts.get(parentId);
    if (!parentPost) {
        notify("Parent post no longer exists!");
        return;
    }
    
    // Check for toxic content
    if (await isToxic(txt)) {
        notify(`Your reply may be seen as toxic. Please rephrase.`);
        btn.disabled = false;
        return;
    }
    
    // Get image data if present
    const imagePreview = document.getElementById(`reply-image-preview-${parentId}`);
    const imageData = imagePreview?.dataset?.imageData || null;
    
    // Check image toxicity if present
    if (imageData && await isImageToxic(imageData)) {
        notify("Image content not allowed");
        btn.disabled = false;
        return;
    }
    
    // Create reply with image data
    const reply = new Post(txt, parentId, imageData);
    reply.depth = Math.min(parentPost.depth + 1, 5);
    
    // Process image if present
    if (imageData) {
        await reply.processImage();
    }
    reply.sign(state.myIdentity.secretKey);

    // Add VDF proof
    if (window.progressiveVDF) {
        const vdfInput = txt + state.myIdentity.uniqueId + Date.now();
        try {
            const proof = await progressiveVDF.computeAdaptiveProof(txt, state.myIdentity.uniqueId, vdfInput);
            reply.vdfProof = proof;
            reply.vdfInput = vdfInput;
        } catch (e) {
            console.warn("VDF failed for reply:", e);
        }
    }
    
    // Update parent post
    parentPost.replies.add(reply.id);
    if (!parentPost.carriers.has(state.myIdentity.handle)) {
        parentPost.carriers.add(state.myIdentity.handle);
        state.explicitlyCarrying.add(parentId);
        broadcast({ type: "carrier_update", postId: parentId, peer: state.myIdentity.handle, carrying: true });
    }
    
    // Add reply to state and render
    state.posts.set(reply.id, reply);
    renderPost(reply);
    
    // Broadcast the reply
    const replyData = reply.toJSON();
    broadcast({ type: "new_post", post: replyData });
    broadcast({ type: "parent_update", parentId: parentId, replyId: reply.id });
    
    // Set carriers
    reply.carriers.add(state.myIdentity.handle);
    state.explicitlyCarrying.add(reply.id);
    
    // Clear the form
    input.value = "";
    document.getElementById(`reply-char-${parentId}`).textContent = 0;
    
    // Clear image if present
    removeReplyImage(parentId);
    
    // Hide the reply form
    toggleReplyForm(parentId);
    
    btn.disabled = false;
    notify("Gas'd the thread!");
}

async function initTopics() {
    loadTopicSubscriptions();
    updateTopicFilter();
    const pendingTopics = new Set(state.subscribedTopics);
    const waitForScribe = setInterval(async () => {
        if (state.scribe) {
            clearInterval(waitForScribe);
            for (const topic of pendingTopics) {
                try {
                    await state.scribe.subscribe(topic);
                } catch (e) {
                    console.error(`Failed to subscribe to ${topic}:`, e);
                }
            }
        }
    }, 1000);
    setInterval(updateTopicStats, 5000);
}

// --- 5. MAINTENANCE & GARBAGE COLLECTION ---
let maintenanceInterval;
function startMaintenanceLoop() {
  let tick = 0;
  maintenanceInterval = setInterval(() => {
    tick++;
    if (tick % 5 === 0) trafficMixer.mix();
    if (tick % 10 === 0) {
      updateAges();
      noiseGenerator.generateNoise();
    }
    if (tick % 30 === 0) {
      memoryManager.checkMemory();
      garbageCollect();
      stateManager.savePosts();
      stateManager.saveUserState();
      stateManager.savePeerScores();
      stateManager.saveImageChunks(); // Periodically save image data
    }
    if (tick % 60 === 0 && state.hyparview) {
        const activePeers = state.hyparview.getActivePeers();
        if (activePeers.length > 0) {
            const target = activePeers[Math.floor(Math.random() * activePeers.length)];
            const knownPeers = Array.from(state.peers.keys())
                .filter(id => typeof id === 'string')
                .slice(0, 10)
                .map(peerId => ({ id: peerId }));
            if (knownPeers.length > 0 && target.wire && !target.wire.destroyed) {
                sendPeer(target.wire, {
                    type: 'peer_exchange',
                    peers: knownPeers
                });
            }
        }
    }
    if (tick % 300 === 0) {
        const stats = state.seenMessages.getStats();
    }
    if (tick % 3600 === 0) {
        stateManager.cleanup();
        tick = 0;
    }
  }, 1000);
}

function garbageCollect() {
    const now = Date.now();
    const threadsMap = new Map();
    for (const [id, p] of state.posts) {
        const rootId = findRootPost(id);
        if (!threadsMap.has(rootId)) {
            threadsMap.set(rootId, new Set());
        }
        threadsMap.get(rootId).add(id);
    }
    for (const [rootId, threadPosts] of threadsMap) {
        const threadCarriers = new Set();
        let newestTimestamp = 0;
        let hasExplicitlyCarried = false;
        let hasReplies = false;
        threadPosts.forEach(postId => {
            const post = state.posts.get(postId);
            if (post) {
                post.carriers.forEach(c => threadCarriers.add(c));
                newestTimestamp = Math.max(newestTimestamp, post.timestamp);
                if (state.explicitlyCarrying.has(postId)) hasExplicitlyCarried = true;
                if (isReply(post)) hasReplies = true;
            }
        });
        const threadAge = now - newestTimestamp;
        const shouldKeep = hasExplicitlyCarried || threadCarriers.size > 2 || threadAge < 3600000 || hasReplies;
        if (!shouldKeep && threadCarriers.size === 1 && threadAge > 1800000) {
            threadPosts.forEach(postId => {
                const post = state.posts.get(postId);
                if (post && post.carriers.has(state.myIdentity.handle) && post.carriers.size === 1 && !isReply(post)) {
                    toggleCarry(postId, false);
                }
            });
        }
    }
    updateStatus();
}

// --- 6. APP LIFECYCLE (INIT) ---
async function init() {
  applyTheme(localStorage.getItem('ephemeral-theme') || 'dark');
  setupThemeToggle();
  applyConfigToUI();
  try {
    await wasmVDF.initialize();
    await verificationQueue.init();
    await stateManager.init();
    await initIdentity();    
    await stateManager.loadUserState();
    await stateManager.loadImageChunks(); 
    await initContentFilter();
    await initImageFilter();

    const loadedPostCount = await stateManager.loadPosts();
    
    if (state.pendingVerification.size > 0) {
      const postsToVerify = Array.from(state.pendingVerification.values());
      postsToVerify.sort((a, b) => a.timestamp - b.timestamp);
      verificationQueue.addBatch(postsToVerify, 'high', (results) => {
        handleVerificationResults(results);
        notify(`Restored ${results.filter(r => r.valid).length} posts from your last session.`);
      });
    }     
    
    await stateManager.loadPeerScores();
    showConnectScreen(loadedPostCount);

  } catch (e) {
    console.error("Init failed:", e);
    document.getElementById("loading").innerHTML = `<div class="loading-content"><h2>Init Failed</h2><p>${e.message}</p><button onclick="location.reload()">Try Again</button></div>`;
  }
}

export function sendToPeer(peer, message) {
    if (!peer || !peer.wire || peer.wire.destroyed) return false;
    
    try {
        sendPeer(peer.wire, message);
        return true;
    } catch (error) {
        console.error('Failed to send message to peer:', error);
        return false;
    }
}

async function connectToNetwork() {
  document.getElementById("loading").innerHTML = `<div class="loading-content"><div class="spinner"></div><div>🔥 Igniting the Ember Network...</div><div style="font-size:12px;margin-top:10px;color:#ff8c42">Securing identity...</div></div>`;
  await new Promise(r => setTimeout(r, 500));
  
  try {
    //await wasmVDF.initialize();
    //await verificationQueue.init();
    //await initIdentity();
    initNetwork();

    if (state.dht) {
      state.identityRegistry = new IdentityRegistry(state.dht);
      setTimeout(async () => {
        if (state.myIdentity && state.myIdentity.handle) {
          try {
            const isRegistered = await state.identityRegistry.verifyOwnIdentity(state.myIdentity);
            if (isRegistered) {
              state.myIdentity.registrationVerified = true;
            } else {
              const keyPair = {
                publicKey: state.myIdentity.publicKey,
                secretKey: state.myIdentity.secretKey
              };
              try {
                const identityClaim = await state.identityRegistry.registerIdentity(
                  state.myIdentity.handle,
                  keyPair
                );
                state.myIdentity.identityClaim = identityClaim;
                state.myIdentity.isRegistered = true;
                state.myIdentity.registrationVerified = true;
                const serializableIdentity = {
                  ...state.myIdentity,
                  publicKey: arrayBufferToBase64(state.myIdentity.publicKey),
                  secretKey: Array.from(state.myIdentity.secretKey),
                  vdfProof: state.myIdentity.vdfProof,
                  deviceCalibration: state.myIdentity.deviceCalibration
                };
                localStorage.setItem("ephemeral-id", JSONStringifyWithBigInt(serializableIdentity));
                notify(`Identity "${state.myIdentity.handle}" registered in network! 🎉`);
              } catch (registerError) {
                console.error(`[Identity] Failed to register identity in DHT:`, registerError);
                notify(`Warning: Could not register identity in network`, 5000);
              }
            }
          } catch (e) {
            console.warn("Could not verify/register identity:", e);
          }
        }
      }, 5000);
    }

    startMaintenanceLoop();
    initTopics();

    window.addEventListener("beforeunload", () => {
      if (maintenanceInterval) clearInterval(maintenanceInterval);
      stateManager.savePosts();
      stateManager.saveUserState();
      stateManager.savePeerScores();
      if (state.client) state.client.destroy();
    });

    setTimeout(() => {
      document.getElementById("loading").style.display = "none";
      if (!localStorage.getItem("ephemeral-tips")) {
        setTimeout(() => notify("💡 Tip: Posts live only while carried by peers"), 1000);
        setTimeout(() => notify("💡 Tip: Ctrl+Enter to post quickly"), 6000);
        localStorage.setItem("ephemeral-tips", "yes");
      }
      if (state.posts.size > 0) {
        notify(`Welcome back! ${state.posts.size} embers still burning 🔥`);
      }
    }, 1500);

  } catch (error) {
      console.error("Network initialization failed:", error);
      document.getElementById("loading").innerHTML = `<div class="loading-content"><h2>Connection Failed</h2><p>${error.message}</p><button onclick="connectToNetwork()" class="primary-button">Try Again</button></div>`;
  }
}

export function debugPostRemoval(postId, reason) {
  // This allows for live debugging via the browser console, e.g.:
  // window.ephemeralDebug.preventRemoval = true;
  // window.ephemeralDebug.protectedPosts.add('some_post_id');
  
  if (window.ephemeralDebug?.preventRemoval) {
    console.warn(`[Debug] Removal of post ${postId} PREVENTED by global flag. Reason: ${reason}`);
    return true; // Return true to PREVENT removal
  }
  
  if (window.ephemeralDebug?.protectedPosts?.has(postId)) {
    console.warn(`[Debug] Removal of post ${postId} PREVENTED because it is protected. Reason: ${reason}`);
    return true; // Return true to PREVENT removal
  }
  
  console.log(`[Debug] Post ${postId} is being removed. Reason: ${reason}`);
  return false; // Return false to ALLOW removal
}


// --- 7. GLOBALS & KICKOFF ---
// Expose functions to the global scope so onclick handlers in the HTML can find them.
window.createPostWithTopics = createPostWithTopics;
window.toggleCarry = toggleCarry;
window.createReply = createReply;
window.handleImageSelect = handleImageSelect;
window.removeImage = removeImage;
window.toggleReplyForm = toggleReplyForm;
window.subscribeToTopic = subscribeToTopic;
window.filterByTopic = filterByTopic;
window.setFeedMode = setFeedMode;
window.discoverAndFilterTopic = discoverAndFilterTopic;
window.completeTopicSuggestion = completeTopicSuggestion;
window.scrollToPost = scrollToPost;
window.clearLocalData = () => stateManager.clearLocalData();
window.connectToNetwork = connectToNetwork;
window.handleReplyImageSelect = handleReplyImageSelect;
window.removeReplyImage = removeReplyImage;

// Start the application initialization process once the page is loaded.
window.addEventListener("load", init);

// Debugging
window.ephemeralDebug = {
  posts: () => state.posts,
  peers: () => state.peers,
  id: () => state.myIdentity,
  stats: () => ({ posts: state.posts.size, peers: state.peers.size }),
    wasmVDF: wasmVDF 
};
