// main.js
// This is the main entry point and orchestrator for the entire application.
// It initializes all modules, manages the global state, and wires up event handlers.

// --- 1. IMPORTS ---
import { CONFIG } from './config.js';
import { Post } from './models/post.js';
import { VerificationQueue } from './verification-queue.js';
import { KademliaDHT } from './p2p/dht.js';
import {currentDMRecipient,addMessageToConversation, applyTheme, setupThemeToggle, showConnectScreen, updateLoadingMessage, renderPost, refreshPost, dropPost, updateStatus, notify, loadTopicSubscriptions, updateTopicFilter, addTopicToUI, updateAges, updateTopicStats, handleImageSelect, removeImage, toggleReplyForm, discoverAndFilterTopic, filterByTopic, setFeedMode, completeTopicSuggestion, scrollToPost , subscribeToTopic,handleReplyImageSelect,removeReplyImage,storeDMLocallyAndUpdateUI , updateDMInbox, updateUnreadBadge, toggleThread} from './ui.js';
import { StateManager } from './storage.js';
import { MemoryManager } from './services/memory-manager.js';
import { PeerManager } from './services/peer-manager.js';
import { ContentAddressedImageStore } from './services/image-store.js';
import { createNewIdentity } from './identity/identity-flow.js';
import { IdentityRegistry } from './identity/identity-manager.js';
import { ProgressiveVDF } from './identity/vdf.js';
import { initNetwork, broadcast, sendPeer} from './p2p/network-manager.js';
import { NoiseGenerator } from './p2p/noise-generator.js';
import { TrafficMixer } from './p2p/traffic-mixer.js';
import { DandelionRouter } from './p2p/dandelion.js';
import { HierarchicalBloomFilter, BloomFilter, generateId, isReply, arrayBufferToBase64, base64ToArrayBuffer, JSONStringifyWithBigInt, JSONParseWithBigInt } from './utils.js';
import wasmVDF from './vdf-wrapper.js'; 
import { EpidemicGossip } from './p2p/epidemic-gossip.js';
import { HyParView } from './p2p/hyparview.js';
import { Scribe } from './p2p/scribe.js';
import { Plumtree } from './p2p/plumtree.js';

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

// Trust evaluation system for incoming posts
const trustEvaluationTimers = new Map(); // postId -> timer


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

  //  Use trust-based verification flow
  console.log(`[Trust] New post ${p.id} from ${p.author}, scheduling trust evaluation`);
  scheduleTrustEvaluation(p);

  // Continue broadcasting
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

  console.log(`Received ${list.length} posts, queuing for trust evaluation...`);
  const postsToEvaluate = [];
  
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
    postsToEvaluate.push(p);
  }

  if (postsToEvaluate.length > 0) {
    // Sort by timestamp (oldest first)
    postsToEvaluate.sort((a, b) => a.timestamp - b.timestamp);
    
    // Schedule trust evaluation for each post
    postsToEvaluate.forEach(post => {
      console.log(`[Trust] Scheduling evaluation for ${post.id}`);
      scheduleTrustEvaluation(post);
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
            // Generate and broadcast attestation for this verified post
            generateAndBroadcastAttestation(post);
            
            // Update peer reputation if this came from a peer
            // (We'll need to track which peer sent each post - for now just log)
            console.log(`[Attestation] Would update peer reputation for valid post`);
        }
        
        state.pendingVerification.delete(result.id);
    }
    
    console.log(`[Debug] Finished processing. Added ${newlyVerifiedCount} posts. state.posts.size: ${state.posts.size}`);

    if (newlyVerifiedCount > 0) {
        notify(`Added ${newlyVerifiedCount} new verified posts`);
    }
}

export async function generateAndBroadcastAttestation(post) {
  // Only generate attestations if we have an identity and the post is verified
  if (!state.myIdentity || !post.verified) return;
  
  // Create attestation data with timestamp to prevent replay attacks
  const attestationData = {
    postId: post.id,
    postAuthor: post.author,
    timestamp: Date.now(),
    vdfIterations: post.vdfProof?.iterations?.toString() || '0'
  };
  
  // Sign the attestation
  const dataToSign = JSON.stringify(attestationData);
  const signature = nacl.sign(
    new TextEncoder().encode(dataToSign),
    state.myIdentity.secretKey
  );
  
  // Create attestation message
  const attestationMsg = {
    type: 'post_attestation',
    attestation: attestationData,
    attesterHandle: state.myIdentity.handle,
    attesterPublicKey: arrayBufferToBase64(state.myIdentity.publicKey),
    signature: arrayBufferToBase64(signature)
  };
  
  console.log(`[Attestation] Broadcasting attestation for post ${post.id} by ${post.author}`);
  
  // Broadcast to network
  broadcast(attestationMsg);
}




export function evaluatePostTrust(postId) {
  const post = state.pendingVerification.get(postId);
  if (!post) {
    trustEvaluationTimers.delete(postId);
    return;
  }
  
  // ALWAYS verify signature first
  if (!post.signature || !post.verify()) {
    console.log(`[Trust] Post ${postId} has invalid signature, rejecting`);
    state.pendingVerification.delete(postId);
    if (trustEvaluationTimers.has(postId)) {
      clearInterval(trustEvaluationTimers.get(postId));
      trustEvaluationTimers.delete(postId);
    }
    return;
  }
  
  // Check if post has reached trust threshold
  if (post.hasSufficientTrust(CONFIG.TRUST_THRESHOLD)) {
    console.log(`[Trust] Post ${postId} reached trust threshold (${post.trustScore.toFixed(2)}), accepting with verified signature`);
    
    // Clear timer
    if (trustEvaluationTimers.has(postId)) {
      clearInterval(trustEvaluationTimers.get(postId));
      trustEvaluationTimers.delete(postId);
    }
    
    // Accept the post
    handleVerificationResults([{
      id: postId,
      valid: true,
      errors: []
    }]);
    
    // Give attesters credit
    for (const attesterHandle of post.attesters) {
      for (const [peerId, peer] of state.peers) {
        peerManager.updateScore(peerId, 'correct_attestation', 0.1);
      }
    }
    
    return;
  }
  
  // Check timeout
  const waitTime = Date.now() - post.timestamp;
  if (waitTime >= CONFIG.ATTESTATION_TIMEOUT) {
    console.log(`[Trust] Timeout for post ${postId}, proceeding with full verification`);
    
    if (trustEvaluationTimers.has(postId)) {
      clearInterval(trustEvaluationTimers.get(postId));
      trustEvaluationTimers.delete(postId);
    }
    
    verificationQueue.addBatch([post], 'normal', (results) => {
      handleVerificationResults(results);
    });
  }
}

export function scheduleTrustEvaluation(post) {
  const postId = post.id;
  
  // Clear any existing timer
  if (trustEvaluationTimers.has(postId)) {
    clearInterval(trustEvaluationTimers.get(postId));
    trustEvaluationTimers.delete(postId);
  }
  
  // Schedule periodic evaluation with automatic cleanup
  const timer = setInterval(() => {
    // Check if post still exists in pending
    if (!state.pendingVerification.has(postId)) {
      clearInterval(timer);
      trustEvaluationTimers.delete(postId);
      return;
    }
    
    evaluatePostTrust(postId);
  }, 100);
  
  trustEvaluationTimers.set(postId, timer);
  
  // Set a maximum lifetime for the timer (10 seconds)
  setTimeout(() => {
    if (trustEvaluationTimers.has(postId)) {
      clearInterval(trustEvaluationTimers.get(postId));
      trustEvaluationTimers.delete(postId);
      
      // If still pending after timeout, send to verification
      if (state.pendingVerification.has(postId)) {
        const post = state.pendingVerification.get(postId);
        verificationQueue.addBatch([post], 'normal', (results) => {
          handleVerificationResults(results);
        });
      }
    }
  }, 10000);
  
  // Do an immediate check
  evaluatePostTrust(postId);
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

    const btn = input.parentElement.querySelector('button');
    btn.disabled = true;

    try {
        const txt = input.value.trim();
        if (!txt) return; // Exit silently if there is no text

        const parentPost = state.posts.get(parentId);
        if (!parentPost) {
            notify("Parent post no longer exists!");
            return;
        }

        // --- All checks now happen inside the robust try block ---

        if (await isToxic(txt)) {
            notify(`Your reply may be seen as toxic. Please rephrase.`);
            return; // Abort if toxic
        }

        const imagePreview = document.getElementById(`reply-image-preview-${parentId}`);
        const imageData = imagePreview?.dataset?.imageData || null;
        if (imageData && await isImageToxic(imageData)) {
            notify("Image content not allowed");
            return; // Abort if image is toxic
        }
        
        // --- VDF is now mandatory and will throw an error on failure ---
        
        const reply = new Post(txt, parentId, imageData);
        reply.depth = Math.min(parentPost.depth + 1, 5);

        if (imageData) {
            await reply.processImage();
        }

        const vdfInput = txt + state.myIdentity.uniqueId + Date.now();
        const proof = await progressiveVDF.computeAdaptiveProof(txt, state.myIdentity.uniqueId, vdfInput);
        reply.vdfProof = proof;
        reply.vdfInput = vdfInput;

        // --- Signing and Broadcasting, identical to parent posts ---

        reply.sign(state.myIdentity.secretKey);
        
        parentPost.replies.add(reply.id);
        if (!parentPost.carriers.has(state.myIdentity.handle)) {
            parentPost.carriers.add(state.myIdentity.handle);
            state.explicitlyCarrying.add(parentId);
            broadcast({ type: "carrier_update", postId: parentId, peer: state.myIdentity.handle, carrying: true });
        }
        
        state.posts.set(reply.id, reply);
        renderPost(reply);
        
        const replyData = reply.toJSON();
        broadcast({ type: "new_post", post: replyData });
        broadcast({ type: "parent_update", parentId: parentId, replyId: reply.id });

        // Also broadcast to topics, which was missing before
        const topics = state.scribe ? state.scribe.extractTopics(txt) : ['#general'];
        if (state.scribe) {
            topics.forEach(topic => {
                state.scribe.multicast(topic, { type: 'new_post', post: replyData });
            });
        }
        
        reply.carriers.add(state.myIdentity.handle);
        state.explicitlyCarrying.add(reply.id);

        // --- Final UI Cleanup ---

        input.value = "";
        document.getElementById(`reply-char-${parentId}`).textContent = 0;
        removeReplyImage(parentId);
        toggleReplyForm(parentId);
        notify("Gas'd the thread!");

    } catch (error) {
        // If anything fails (especially VDF), notify the user and log it.
        console.error("Failed to create reply:", error);
        notify(`Could not create reply: ${error.message}`);

    } finally {
        // IMPORTANT: Always re-enable the button, whether it succeeded or failed.
        btn.disabled = false;
    }
}


// Direct Message Functions
export async function sendDirectMessage(recipientHandle, messageText) {
  try {
    let recipientClaim = null;
    const maxAttempts = 5; // FIX: Increased attempts for more resilience.
    const initialDelay = 1000;

    // This will now wait and retry even if the network is not in the initial bootstrap phase,
    // accounting for general network latency.
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      notify(`Searching for ${recipientHandle} on the network... (Attempt ${attempt + 1})`);
      recipientClaim = await state.identityRegistry.lookupHandle(recipientHandle);
      if (recipientClaim) {
        break; // Found the user, exit the loop.
      }

      if (attempt < maxAttempts - 1) {
        const delay = initialDelay * Math.pow(2, attempt); // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // FIX: Provide clearer, more specific feedback if the user is not found.
    if (!recipientClaim) {
      notify(`Could not find user "${recipientHandle}". They may be offline or do not exist.`);
      return false;
    }

    if (!recipientClaim.encryptionPublicKey) {
      notify(`User ${recipientHandle} does not support encrypted messages.`);
      return false;
    }

    const nonce = nacl.randomBytes(24);
    const messageBytes = new TextEncoder().encode(messageText);
    const recipientPublicKey = base64ToArrayBuffer(recipientClaim.encryptionPublicKey);
    const ciphertext = nacl.box(
      messageBytes,
      nonce,
      recipientPublicKey,
      state.myIdentity.encryptionSecretKey
    );
    const dmPacket = {
      type: 'e2e_dm',
      recipient: recipientHandle,
      sender: state.myIdentity.handle,
      ciphertext: arrayBufferToBase64(ciphertext),
      nonce: arrayBufferToBase64(nonce),
      timestamp: Date.now()
    };
    const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
    const closestPeers = await state.dht.findNode(recipientNodeId);

    // FIX: Provide clearer feedback if a route to the user cannot be found.
    if (closestPeers.length === 0) {
      notify(`Found "${recipientHandle}", but could not find a route to them on the network. They may be offline.`);
      return false;
    }

    let sent = false;
    for (const peer of closestPeers) {
      // The sendPeer function is already robust.
      sendPeer(peer.wire, dmPacket);
      sent = true;
    }

    if (sent) {
      storeDMLocallyAndUpdateUI(recipientHandle, messageText, 'sent');
      addMessageToConversation(recipientHandle, messageText, 'sent'); // FIX: Immediately add sent message to UI
      notify(`Message sent to ${recipientHandle}. Delivery depends on them being online.`);
      return true;
    } else {
      // This case is less likely with the above check, but kept for safety.
      notify(`Failed to send message to ${recipientHandle}.`);
      return false;
    }
  } catch (error) {
    console.error('DM send error:', error);
    notify(`Error sending message: ${error.message}`);
    return false;
  }
}

export async function handleDirectMessage(msg, fromWire) {
  try {
    // Verify this message is for us
    if (msg.recipient !== state.myIdentity.handle) {
      // Not for us - try to forward it
      const recipientClaim = await state.identityRegistry.lookupHandle(msg.recipient);
      if (recipientClaim && recipientClaim.nodeId) {
        const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
        const closestPeers = state.dht.findClosestPeers(recipientNodeId, 3);
        
        // Forward to peers closer to recipient
        for (const peer of closestPeers) {
          if (peer.wire !== fromWire) {
            // *** FIX: Pass peer.wire to sendPeer, not the whole peer object ***
            sendPeer(peer.wire, msg);
          }
        }
      }
      return;
    }
    
    // Look up sender's identity
    const senderClaim = await state.identityRegistry.lookupHandle(msg.sender);
    if (!senderClaim || !senderClaim.encryptionPublicKey) {
      console.warn(`DM from unknown or invalid sender: ${msg.sender}`);
      return;
    }
    
    // Decrypt the message
    const ciphertext = base64ToArrayBuffer(msg.ciphertext);
    const nonce = base64ToArrayBuffer(msg.nonce);
    const senderPublicKey = base64ToArrayBuffer(senderClaim.encryptionPublicKey);
    
    const decryptedBytes = nacl.box.open(
      ciphertext,
      nonce,
      senderPublicKey,
      state.myIdentity.encryptionSecretKey
    );
    if (!decryptedBytes) {
      console.error('Failed to decrypt DM - invalid ciphertext or keys');
      return;
    }
    
    const messageText = new TextDecoder().decode(decryptedBytes);
    // Store and display the message
    storeDMLocallyAndUpdateUI(msg.sender, messageText, 'received');
    updateUnreadBadge(); 
    // Show notification
     notify(`📬 New message from ${msg.sender}`, 6000,
        () => openDMPanel(msg.sender));
    // Update UI if DM panel is open
    if (currentDMRecipient === msg.sender) {
      addMessageToConversation(msg.sender, messageText, 'received');
      
    }
    
  } catch (error) {
    console.error('DM receive error:', error);
  }
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
    
    // Check for stored identity but DON'T set it yet
    const stored = localStorage.getItem("ephemeral-id");
    let storedIdentity = null;
    
    if (stored) {
      try {
        const identity = JSONParseWithBigInt(stored);
        if (identity.nodeId) {
            if (typeof identity.nodeId === 'string') {
            // stored as base-64
            identity.nodeId = base64ToArrayBuffer(identity.nodeId);
            } else if (Array.isArray(identity.nodeId)) {
            // stored as JSON array
            identity.nodeId = new Uint8Array(identity.nodeId);
           }
        }       
        
        
        if (identity.secretKey) {
          if (Array.isArray(identity.secretKey)) {
            identity.secretKey = new Uint8Array(identity.secretKey);
          }
        }
        if (identity.publicKey && typeof identity.publicKey === 'string') {
          identity.publicKey = base64ToArrayBuffer(identity.publicKey);
        }
        if (identity.encryptionPublicKey && typeof identity.encryptionPublicKey === 'string') {
          identity.encryptionPublicKey = base64ToArrayBuffer(identity.encryptionPublicKey);
        }
        if (identity.encryptionSecretKey && Array.isArray(identity.encryptionSecretKey)) {
          identity.encryptionSecretKey = new Uint8Array(identity.encryptionSecretKey);
        }
        if (identity.vdfProof && identity.vdfProof.iterations) {
          if (typeof identity.vdfProof.iterations === 'string') {
            identity.vdfProof.iterations = BigInt(identity.vdfProof.iterations);
          }
        }
        storedIdentity = identity;
      } catch (e) {
        console.error("Failed to parse stored identity:", e);
      }
    }
    
    // Initialize network FIRST with temporary node ID
    const tempNodeId = (storedIdentity && storedIdentity.nodeId instanceof Uint8Array)
                        ? storedIdentity.nodeId
                        : crypto.getRandomValues(new Uint8Array(20));
    
    await initNetworkWithTempId(tempNodeId);
    
    // Wait for DHT to be ready
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (state.dht && state.identityRegistry) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
    
    await new Promise(resolve => {
      let waitTime = 0;
      const checkInterval = setInterval(() => {
        waitTime += 100;
        
        if (state.dht && state.identityRegistry) {
          clearInterval(checkInterval);
          
          // Check if we're likely the first node
          if (waitTime > 5000 && state.peers.size === 0) {
            notify("🎉 Welcome, pioneer! You appear to be the first node on the network!");
          }
          
          resolve();
        }
      }, 100);
    });
        
    
    // Now handle identity
    if (storedIdentity && storedIdentity.handle) {
      // Verify stored identity
      const isValid = await state.identityRegistry.verifyOwnIdentity(storedIdentity);
      
      if (isValid) {
        // Identity was successfully verified on the network
        state.myIdentity = storedIdentity;
        
        // Update the DHT with the final, correct nodeId ---
        state.dht.nodeId = state.myIdentity.nodeId;
        
        notify(`Welcome back, ${storedIdentity.handle}!`);
      } else if (state.peers.size === 0) {
        // If verification fails BUT we have no peers, we are the first node.
        // We should trust the local identity and assume it's valid.
        console.warn("Could not verify identity on DHT (no peers found), trusting local storage.");
        state.myIdentity = storedIdentity;
        notify(`Welcome back, pioneer ${storedIdentity.handle}!`);
      } else {
        // Stored identity is invalid or taken because verification failed and there ARE peers.
        notify("Stored identity is no longer valid. Please create a new one.");
        await createNewIdentity();
      }
    } else {
      // No stored identity
      await createNewIdentity();
    }
    
    // Continue with rest of initialization
    await stateManager.loadUserState();
    await stateManager.loadImageChunks();
    await initContentFilter();
    await initImageFilter();
    
    const loadedPostCount = await stateManager.loadPosts();
    
    /***if we trust ourselves, pending is none
    if (state.pendingVerification.size > 0) {
      const postsToVerify = Array.from(state.pendingVerification.values());
      postsToVerify.sort((a, b) => a.timestamp - b.timestamp);
      verificationQueue.addBatch(postsToVerify, 'high', (results) => {
        handleVerificationResults(results);
        notify(`Restored ${results.filter(r => r.valid).length} posts from your last session.`);
      });
    }
    ***/
    
    await stateManager.loadPeerScores();
    
    // Hide loading screen and show main app
    document.getElementById("loading").style.display = "none";
    initializeP2PProtocols();
    startMaintenanceLoop();
    initTopics();
    updateDMInbox();
    updateUnreadBadge();
    // Update inbox periodically
    setInterval(()=>{ 
                updateDMInbox(),
                updateUnreadBadge();
                }, 30000); // Every 30 seconds
    
    window.addEventListener("beforeunload", () => {
      if (maintenanceInterval) clearInterval(maintenanceInterval);
      stateManager.savePosts();
      stateManager.saveUserState();
      stateManager.savePeerScores();
      if (state.client) state.client.destroy();
    });
    
    if (!localStorage.getItem("ephemeral-tips")) {
      setTimeout(() => notify("💡 Tip: Posts live only while carried by peers"), 1000);
      setTimeout(() => notify("💡 Tip: Ctrl+Enter to post quickly"), 6000);
      localStorage.setItem("ephemeral-tips", "yes");
    }
    
  } catch (e) {
    console.error("Init failed:", e);
    document.getElementById("loading").innerHTML = `<div class="loading-content"><h2>Init Failed</h2><p>${e.message}</p><button onclick="location.reload()">Try Again</button></div>`;
  }
}


function initializeP2PProtocols() {
  if (!state.myIdentity) {
    console.error("Cannot initialize P2P protocols without an identity.");
    return;
  }
  
  // HyParView is created in identity-flow, but we ensure it's here for returning users
  if (!state.hyparview) {
      state.hyparview = new HyParView(state.myIdentity.nodeId, state.dht);
      state.hyparview.bootstrap().catch(e => console.error("HyParView bootstrap failed:", e));
  }

  // Initialize Scribe
  try {
    state.scribe = new Scribe(state.myIdentity.nodeId, state.dht);
    state.scribe.deliverMessage = (topic, message) => {
      if (message.type === 'new_post' && message.post) {
        if (message.post.author === state.myIdentity.handle) return;
        handleNewPost(message.post, null);
      }
    };
  } catch (e) {
    console.error("Failed to initialize Scribe:", e);
  }

  // Initialize Plumtree
  state.plumtree = new Plumtree(state.myIdentity.nodeId, state.hyparview);
  state.plumtree.deliver = (message) => {
    if (message.type === 'post') {
      handleNewPost(message.data, null);
    }
  };
  
  console.log("Dependent P2P protocols (Scribe, Plumtree) initialized.");
}

// helper function for init
async function initNetworkWithTempId(tempNodeId) {
  initNetwork(); // This will create state.client
  
  // Initialize DHT and identity registry immediately
  state.dht = new KademliaDHT(tempNodeId);
  state.identityRegistry = new IdentityRegistry(state.dht);
  
  // The rest of the protocols will initialize after the bootstrap connection
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



export function debugPostRemoval(postId, reason) {
  // This allows for live debugging via the browser console, e.g.:

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
window.handleReplyImageSelect = handleReplyImageSelect;
window.removeReplyImage = removeReplyImage;
window.openDMPanel = openDMPanel;
window.closeDMPanel = closeDMPanel;
window.sendDM = sendDM;
window.toggleThread = toggleThread; 

// Start the application initialization process once the page is loaded.
window.addEventListener("load", init);

// Debugging
window.ephemeralDebug = {
  posts: () => state.posts,
  peers: () => state.peers,
  id: () => state.myIdentity,
  stats: () => ({ posts: state.posts.size, peers: state.peers.size }),
  wasmVDF: wasmVDF,
  // ADD THIS NEW DEBUG COMMAND:
  reputations: () => {
    console.table(peerManager.debugReputations());
    const stats = peerManager.getReputationStats();
    console.log('Reputation distribution:', stats);
    return stats;
  }
};
