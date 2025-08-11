// FILE: main.js
// main.js
// This is the main entry point and orchestrator for the entire application.
// It initializes all modules, manages the global state, and wires up event handlers.

// --- 1. IMPORTS ---
import { getContentSafety, setRulePackPath, reloadRulePack  } from './services/content-safety-wrapper.js';
import * as tf from '@tensorflow/tfjs';                 //  for nsfwjs
import '@tensorflow/tfjs-backend-cpu';               //  for nsfwjs
import nacl from 'tweetnacl'; 
import * as nsfwjs from 'nsfwjs';
import DOMPurify from 'dompurify';
import { CONFIG } from './config.js';
import { Post } from './models/post.js';
import { VerificationQueue } from './verification-queue.js';
import { KademliaDHT } from './p2p/dht.js';
import { IdentityClaim } from './models/identity-claim.js';
import { LocalIdentity } from './models/local-identity.js';
import { createNewIdentity, unlockIdentity } from './identity/identity-flow.js';

// --- 2. IMPORT SHARED STATE & SERVICES ---
import { initializeServices, getServices } from './services.js';

import { state } from './state.js';
import { messageBus } from './p2p/message-bus.js';
import { setServiceCallbacks } from './services/callbacks.js';


import {
    currentDMRecipient, addMessageToConversation, applyTheme, setupThemeToggle, 
    showConnectScreen, updateLoadingMessage, renderPost, refreshPost, dropPost, 
    updateStatus, notify, loadTopicSubscriptions, updateTopicFilter, addTopicToUI, 
    updateAges, updateTopicStats, handleImageSelect, removeImage, toggleReplyForm, 
    discoverAndFilterTopic, filterByTopic, setFeedMode, completeTopicSuggestion, 
    scrollToPost, subscribeToTopic, handleReplyImageSelect, removeReplyImage, 
    storeDMLocallyAndUpdateUI, updateDMInbox, updateUnreadBadge, toggleThread,
    openProfileForHandle, renderProfile, closeProfile, updateProfilePicturesInPosts, 
    initializeUserProfileSection, setSendPeer,updateHotTopics,getLivingPostValues, 
    initializeLivingPostComposer, clearLivingPostEditors
} from './ui.js';
import { StateManager } from './storage.js';
import { MemoryManager } from './services/memory-manager.js';
import { PeerManager } from './services/peer-manager.js';
import { ContentAddressedImageStore } from './services/image-store.js';
import { IdentityRegistry } from './identity/identity-manager.js';
import { ProgressiveVDF } from './identity/vdf.js';
import { initNetwork, registerHandler, sendPeer, broadcast, handlePeerMessage } from './p2p/network-manager.js';
import { NoiseGenerator } from './p2p/noise-generator.js';
import { TrafficMixer } from './p2p/traffic-mixer.js';
//import { DandelionRouter } from './p2p/dandelion.js';
import { HierarchicalBloomFilter, BloomFilter, generateId, isReply, arrayBufferToBase64, base64ToArrayBuffer, JSONStringifyWithBigInt, JSONParseWithBigInt } from './utils.js';
import wasmVDF from './vdf-wrapper.js'; 
import { HyParView } from './p2p/hyparview.js';
import { Scribe } from './p2p/scribe.js';
import { routingManager } from './services/routing-manager.js';


// Get service references
let stateManager, verificationQueue, imageStore, peerManager, memoryManager;
let progressiveVDF, noiseGenerator, trafficMixer;

//globals - for startup sequence
let identityReady = false;
const earlyMessageQueue = [];
  //startup/identity sequence gloabs
window.identityReady = identityReady;
window.earlyMessageQueue = earlyMessageQueue;
// --- EXPORTS for other modules to import handler functions ---
export {
  // Core post handlers
  handleNewPost,
  handlePostsResponse,
  handleVerificationResults,

  // Identity and Attestation
  handleProvisionalClaim,
  handleConfirmationSlip,
  generateAndBroadcastAttestation,
  evaluatePostTrust,
  scheduleTrustEvaluation,
  hashClaim,

  // Post interaction handlers
  createPostWithTopics,
  createReply,
  toggleCarry,
  handleCarrierUpdate,
  handleParentUpdate,
  findRootPost,
  
  // Rating system
  ratePost,
  handlePostRating,

  // Content checking
  isToxic,
  isImageToxic,

  // Direct Messaging
  sendDirectMessage,
  handleDirectMessage,

  // Profile system
  broadcastProfileUpdate,
  subscribeToProfile,
  unsubscribeFromProfile,
  handleProfileUpdate,
  
  // P2P Protocol and Network Management
  initializeP2PProtocols,
  initNetworkWithTempId,
  handleScribeMessage,
  sendToPeer,
  findPeerByHandle,

  // Maintenance and Debugging
  startMaintenanceLoop,
  maintenanceInterval,
  debugPostRemoval,

    //DM approvals
      sendDMRequest,
  approveDMRequest,
  revokeDMPermission,
  handleDMRequest,
  handleDMApprove,
  handleDMRevoke
};


// Trust evaluation system for incoming posts
const trustEvaluationTimers = new Map(); // postId -> timer





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

async function initImageFilter() {
    try {
        state.imageClassifier = await nsfwjs.load(CONFIG.NSFWJS_MODEL_PATH);
        console.log("Image filter model ready");
    } catch (e) {
        console.error("Image filter failed to load:", e);
    }
}


async function initContentFilter() {
  try {
    // Use the new content safety filter
    state.toxicityClassifier = await getContentSafety();
    console.log("Content safety filter ready");
  } catch (e) {
    console.error("Content safety filter failed:", e);
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
  const reputation = getServices().peerManager.getScore(peerId);
  const canTrust = getServices().peerManager.canTrustAttestations(peerId);
  
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
    getServices().peerManager.updateScore(peerId, 'attestation', 1);
    
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
      getServices().peerManager.updateScore(peerId, 'correct_attestation', 1);
    }
  }
}

async function isToxic(text) {
  if (!state.toxicityClassifier) return false;
  
  try {
    const result = await state.toxicityClassifier.checkContent(text);
    
    if (result.shouldBlock) {
      // Return the most severe violation type
      const violation = result.violations[0];
      return violation.type.toUpperCase();
    }
    
    return false;
  } catch (e) {
    console.error("Content check failed:", e);
    return false;
  }
}

async function isImageToxic(imageData) {
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

async function handleNewPost(data, fromWire) {
  // Add identity check
  if (!state.myIdentity) {
    console.warn("[handleNewPost] Received post before identity ready, dropping");
    return;
  }

  const postData = data.post || data;

  if (!postData?.id || state.posts.has(postData.id) || state.seenPosts.has(postData.id)) {
    return;
  }
  if (postData.content.length > CONFIG.MAX_POST_SIZE) {
    return;
  }
  // Quick pattern check for received content
  if (await isToxic(postData.content)) {
    notify(`Blocked harmful content from ${postData.author}`);
    console.warn(`Blocked harmful content from ${postData.author}`);
    if (fromWire) {
      peerManager.updateScore(fromWire.peerId, 'harmful_content', -50);
    }
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



function findRootPost(postId) {
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

async function handlePostsResponse(list, fromWire) {
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

async function handleVerificationResults(results) {
    let newlyVerifiedCount = 0;
    console.log(`[Debug] Processing ${results.length} verification results`);
    for (const result of results) {
        const post = state.pendingVerification.get(result.id);
        if (!post) continue;

        if (result.valid) {
            post.verified = true;
            let identityStatus = 'unknown';
            if (state.identityRegistry) {
                try {
                    const claim = await state.identityRegistry.lookupHandle(post.author);
                    if (claim) {
                        const identityValid = await state.identityRegistry.verifyAuthorIdentity(post);
                        identityStatus = identityValid ? 'verified' : 'mismatch';
                    }
                } catch (e) {
                    console.warn(`Identity check error for ${post.author}:`, e);
                }
            }

            post.identityStatus = identityStatus;
            if (identityStatus === 'mismatch') {
                console.warn(`Rejecting post from ${post.author} - identity mismatch!`);
                state.pendingVerification.delete(result.id);
                continue;
            }

            // MODIFIED IMAGE HANDLING LOGIC
            if (post.imageHash && !post.imageData) {
                const imageData = await imageStore.retrieveImage(post.imageHash);
                if (!imageData) {
                    // Image is not ready. Request it and defer rendering.
                    console.log(`[Image] Post ${post.id} is valid but awaiting image data. Requesting from peers.`);
                    const peers = Array.from(state.peers.values()).slice(0, 3);
                    for (const peer of peers) {
                        sendPeer(peer.wire, { type: "request_image", imageHash: post.imageHash });
                    }
                    // Skip the rest of this loop, leaving the post in pendingVerification.
                    continue;
                }
                // If we get here, image data was found locally.
                post.imageData = imageData;
            }

            // This block is now only reached if the post has no image or its image is ready.
            if (post.parentId) {
                const parent = state.posts.get(post.parentId);
                if (parent) {
                    parent.replies.add(post.id);
                    post.depth = Math.min(parent.depth + 1, 5);
                    refreshPost(parent);
                } else {
                    post.depth = 1;
                }
            }

            state.posts.set(post.id, post);
            if (post.postType === 'living') {
              state.scribe?.subscribe(`#lp:${post.id}`);
            }
            renderPost(post);
            getServices().contentSimilarity.addPost(post);
            newlyVerifiedCount++;
            generateAndBroadcastAttestation(post);
            console.log(`[Attestation] Would update peer reputation for valid post`);
        }

        state.pendingVerification.delete(result.id);
    }

    if (newlyVerifiedCount > 0) {
        notify(`Added ${newlyVerifiedCount} new verified posts`);
    }
}

async function generateAndBroadcastAttestation(post) {
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
  new Uint8Array(state.myIdentity.secretKey) // Explicitly cast to Uint8Array
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

function evaluatePostTrust(postId) {
  const post = state.pendingVerification.get(postId);
  if (!post) {
    // Clean up timer if post is gone
    const timer = trustEvaluationTimers.get(postId);
    if (timer) {
      clearInterval(timer);
      trustEvaluationTimers.delete(postId);
    }
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
    // Force immediate verification for own posts
    const isOwnPost = state.myIdentity && post.author === state.myIdentity.handle;
    if (isOwnPost) {
      console.log(`[Trust] Fast-tracking own post ${postId} through verification`);
      
      // Clear any existing timer
      if (trustEvaluationTimers.has(postId)) {
        clearInterval(trustEvaluationTimers.get(postId));
        trustEvaluationTimers.delete(postId);
      }
      
      // Check if verificationQueue is initialized
      if (verificationQueue) {
        verificationQueue.addBatch([post], 'normal', (results) => {
          handleVerificationResults(results);
        });
      } else {
        // If verification queue isn't ready, just accept the post directly
        console.log(`[Trust] Verification queue not ready, accepting own post directly`);
        handleVerificationResults([{
          id: postId,
          valid: true,
          errors: []
        }]);
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
        if (peer.handle === attesterHandle) {
          peerManager.updateScore(peerId, 'correct_attestation', 0.1);
          break;
        }
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
    
    // FIX: Check if the verification queue is initialized before using it.
    if (verificationQueue) {
        verificationQueue.addBatch([post], 'normal', (results) => {
          handleVerificationResults(results);
        });
    } else {
        // CORRECTED FIX: If the queue isn't ready, use setTimeout to retry after a short delay.
        // This avoids a busy-wait loop and allows the main thread to complete initialization.
        console.warn(`[Trust] Verification queue not ready, retrying verification for post: ${postId} in 250ms.`);
        setTimeout(() => evaluatePostTrust(postId), 250);
    }
  }
}

function scheduleTrustEvaluation(post) {
  const postId = post.id;
  
  // Helper function to clean up timer
  const cleanupTimer = () => {
    const timer = trustEvaluationTimers.get(postId);
    if (timer) {
      clearInterval(timer);
      trustEvaluationTimers.delete(postId);
    }
  };
  
  // Clear any existing timer
  cleanupTimer();
  
  // Schedule periodic evaluation
  const timer = setInterval(() => {
    // Check if post still exists in pending
    if (!state.pendingVerification.has(postId)) {
      cleanupTimer();
      return;
    }
    
    evaluatePostTrust(postId);
  }, 100);
  
  trustEvaluationTimers.set(postId, timer);
  
  // Set a maximum lifetime for the timer (10 seconds)
  setTimeout(() => {
    cleanupTimer();
    
    // If still pending after timeout, send to verification
    if (state.pendingVerification.has(postId)) {
        const post = state.pendingVerification.get(postId);
        if (!post) return;
        if (verificationQueue) {
          verificationQueue.addBatch([post], 'normal', handleVerificationResults);
        } else {
          console.warn('[Trust] VQ not ready, retrying in 250ms');
          setTimeout(() => evaluatePostTrust(postId), 250);
        }
    }
  }, 10000);
  
  // Do an immediate check
  evaluatePostTrust(postId);
}

async function handleProvisionalClaim(claim) {
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

async function handleConfirmationSlip(slip) {
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

async function hashClaim(claim) {
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

function handleCarrierUpdate(msg) {
    const p = state.posts.get(msg.postId);
    if (!p) return;
    const handle = msg.peer || msg.fromIdentityHandle;
    if (!handle) return;

    if (msg.carrying) {
        p.carriers.add(handle);
        if (handle === state.myIdentity.handle) state.scribe?.subscribe(`#lp:${p.id}`); // NEW
            } else {
        p.carriers.delete(handle);
        if (handle === state.myIdentity.handle) state.scribe?.unsubscribe(`#lp:${p.id}`); // NEW
    }
    if (p.carriers.size === 0 && !isReply(p)) {
        if (!debugPostRemoval(p.id, 'carrier update - no carriers')) {

                if (p?.postType === 'living') {
                  state.scribe?.unsubscribe(`#lp:${p.id}`);
                }
            state.posts.delete(p.id);
            dropPost(p.id);
        }
    } else {
        refreshPost(p);
    }
}

function handleParentUpdate(msg) {
    const parent = state.posts.get(msg.parentId);
    const reply = state.posts.get(msg.replyId);
    if (parent && reply) {
        parent.replies.add(msg.replyId);
        refreshPost(parent);
    }
}

async function createPostWithTopics() {
    const btn = document.getElementById("send-button");
        const mobileBtn = document.getElementById("mobile-send-button"); // <-- FIX: ADD THIS LINE

    const isLivingPost = document.getElementById('living-compose-content').style.display === 'block';

    const mobileComposeModal = document.getElementById('compose-modal-overlay');
    const isMobile = mobileComposeModal && mobileComposeModal.style.display === 'flex';


    let txt, imageData = null;
    let p; 

    if (isLivingPost) {
        const lpData = getLivingPostValues();
        const title = document.getElementById('lp-title-input').value;

        if (!title || !lpData.code || !lpData.state || !lpData.renderer) {
            notify("All fields are required for a Living Post.");
            return;
        }

        // Moderation (balanced): ONLY scan human-visible text.
        // 1) Literal text from the renderer (drop tags & {{mustache}}), 2) string values from JSON state, 3) title.
        const plainFromRenderer = (() => {
          try {
            const tpl = lpData.renderer || '';
            // remove mustache tags, then scripts/styles, then all HTML tags
            const stripped = tpl
              .replace(/{{[\s\S]*?}}/g, ' ')
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ');
            return stripped.replace(/\s+/g, ' ').trim();
          } catch { return ''; }
        })();

        let stringsFromState = '';
        try {
          const obj = JSON.parse(lpData.state || '{}');
          const collect = (v) => {
            if (typeof v === 'string') stringsFromState += ' ' + v;
            else if (v && typeof v === 'object') Object.values(v).forEach(collect);
          };
          collect(obj);
        } catch {}

        const humanVisible = [title, plainFromRenderer, stringsFromState]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000); // cap to avoid weird classifier behavior on huge inputs

        if (CONFIG.LP_MODERATION !== 'off' && humanVisible && await isToxic(humanVisible)) {
          notify('Your Living Post appears to contain disallowed visible text. Please revise the title/renderer/state strings.');
          return;
        }


        try {
            JSON.parse(lpData.state);
        } catch (e) {
            notify("Initial State is not valid JSON.");
            return;
        }

        p = new Post(title);
        p.postType = 'living';
        p.lpCode = lpData.code;
        p.lpState = lpData.state;
        p.lpRenderer = lpData.renderer;
        p.lpCode = p.lpCode.replace(/\u00A0/g, ' '); //pesky invisible chars
        
        try {
            const vm = getServices().livingPostManager;
            const newState = await vm.run(p.id, p.lpCode, 'onLoad', p.lpState);

            p.lpState = newState;
            p.carriers ||= new Set();
            p.carriers.add(state.myIdentity.handle);   // author carries by default
            state.scribe?.subscribe(`#lp:${p.id}`);    // so we receive proposals
        } catch (e) {
            notify(`Error in your onLoad function: ${e.message}`);
            console.error(e);
            return;
        }

    

    } else {
        // Standard post logic (now context-aware)
        if (isMobile) {
            txt = document.getElementById('mobile-post-input').value;
            imageData = document.getElementById('mobile-image-preview').dataset.imageData;
        } else {
            txt = document.getElementById('post-input').value;
            imageData = document.getElementById('image-preview').dataset.imageData;
        }

        if (!txt) return;

        if (await isToxic(txt)) {
            notify(`Your post may be seen as toxic. Please rephrase.`);
            if(isMobile) mobileBtn.disabled = false; else btn.disabled = false;
            return;
        }
        if (imageData && await isImageToxic(imageData)) {
            notify("Image content not allowed");
            if(isMobile) mobileBtn.disabled = false; else btn.disabled = false;
            return;
        }

        p = new Post(txt, null, imageData);
        if (imageData) {
            await p.processImage();
        }
    }
    
    // Disable the correct button
    if (isMobile) {
      mobileBtn.disabled = true;
      mobileBtn.textContent = "Mixing...";
    } else if (btn) {
      btn.disabled = true;
      btn.textContent = "Mixing...";
    }
    notify("Securing post for relay...", 10000);

    try {
        p.sign(state.myIdentity.secretKey);
        await getServices().privacyPublisher.publishPost(p);

        // UI Cleanup
        if (isLivingPost) {
          if (typeof clearLivingPostEditors === 'function') {
            clearLivingPostEditors();
          } else {
            // Fallback: clear title + preview
            const titleEl = document.getElementById('lp-title-input');
            if (titleEl) titleEl.value = '';
            const frame = document.getElementById('lp-preview-frame');
            if (frame) frame.srcdoc = '';
            const errEl = document.getElementById('lp-preview-error');
            if (errEl) errEl.textContent = '';
          }
        } else {
          const postEl = document.getElementById('post-input');
          if (postEl) postEl.value = '';
          const charEl = document.getElementById('char-current');
          if (charEl) charEl.textContent = '0';
          if (typeof removeImage === 'function') removeImage();
        }

        // Re-enable the correct button
        if (isMobile) {
          if (typeof mobileBtn !== 'undefined' && mobileBtn) {
            mobileBtn.disabled = false;
            mobileBtn.textContent = '🔥';
          }
        } else if (typeof btn !== 'undefined' && btn) {
          btn.disabled = false;
          btn.textContent = '🔥';
        }
        notify("Post sent to the mixing layer!");
    } catch (error) {
        console.error("Failed to publish post:", error);
        notify(`Could not publish post: ${error.message}`, 5000);
        btn.disabled = false;
        btn.textContent = "🔥";
    }
}

// Called from the UI when a user clicks an interactive element
async function interactWithLivingPost(postId, inputDataString) {
  const post = state.posts.get(postId);
  if (!post) return;

  let inputData;
  try {
    inputData = JSON.parse(inputDataString);
  } catch (e) {
    console.error("Invalid input data on element:", e);
    return;
  }

  // Create the interaction object, which will be proposed to the carriers.
  const interaction = {
    user: { handle: state.myIdentity.handle },
    input: inputData
  };

  // The proposal is the interaction plus metadata, which we sign.
  const proposalPayload = {
    postId: postId,
    interaction: interaction,
    timestamp: Date.now()
  };

 // const payloadStr = JSON.stringify(proposalPayload);
 // const signature = nacl.sign.detached(new TextEncoder().encode(payloadStr), state.myIdentity.secretKey);

    const payloadStr = JSON.stringify(proposalPayload);
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const sk = state.myIdentity.secretKey instanceof Uint8Array
      ? state.myIdentity.secretKey
      : new Uint8Array(state.myIdentity.secretKey);
    const signature = nacl.sign.detached(payloadBytes, sk);


  const proposalMsg = {
    type: 'lp_interaction_proposal',
    payload: proposalPayload,
    signature: arrayBufferToBase64(signature),
    publicKey: arrayBufferToBase64(state.myIdentity.publicKey)
  };

  // Broadcast the proposal to the post's dedicated Scribe topic.
  const topic = `#lp:${postId}`;
  try {
    await state.scribe.multicast(topic, proposalMsg);
    notify("Interaction proposed to carriers.");
  } catch (error) {
    console.error("Failed to broadcast interaction proposal:", error);
    notify("Could not send interaction to the network.");
  }
}

// This runs on the host's machine to update the state
async function processLivingPostInput(post, interaction) {
    try {
        const vm = getServices().livingPostManager;
        const newStateJson = await vm.run(post.id, post.lpCode, 'onInteract', post.lpState, interaction);

        if (newStateJson !== post.lpState) {
            post.lpState = newStateJson;

            // Monotonic revision and canonical signing
            const nextRev = (typeof post.lpRev === 'number' ? post.lpRev : 0) + 1;
            const canonical = JSON.stringify({ postId: post.id, rev: nextRev, state: post.lpState });
            const sk2 = state.myIdentity.secretKey instanceof Uint8Array
              ? state.myIdentity.secretKey
              : new Uint8Array(state.myIdentity.secretKey);
            const sig = nacl.sign.detached(new TextEncoder().encode(canonical), sk2);

            const updateMsg = {
                type: 'lp_state_update',
                postId: post.id,
                newState: post.lpState,
                rev: nextRev,
                executorHandle: state.myIdentity.handle,
                executorPublicKey: arrayBufferToBase64(state.myIdentity.publicKey),
                signature: arrayBufferToBase64(sig)
            };
            post.lpRev = nextRev;

            // Broadcast the update on the post's Scribe topic.
            const topic = `#lp:${post.id}`;
            await state.scribe.multicast(topic, updateMsg);
            
            refreshPost(post);
        }
    } catch (e) {
        console.error(`Living Post execution error for ${post.id}:`, e);
        notify(`LP Error: ${e.message}`);
    }
}

// --- NEW MESSAGE HANDLERS ---

async function handle_lp_interaction_proposal(msg, fromWire) {
  const { payload, signature, publicKey } = msg;
  const { postId, interaction } = payload;

  const post = state.posts.get(postId);
  if (!post) return; // We don't have this post, so we can't act as executor.

  // 1. Verify the signature of the user who proposed the interaction.
  const payloadStr = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const signatureBytes = base64ToArrayBuffer(signature);
  const publicKeyBytes = base64ToArrayBuffer(publicKey);

  if (!nacl.sign.detached.verify(payloadBytes, signatureBytes, publicKeyBytes)) {
    console.warn(`Invalid signature on lp_interaction_proposal from ${interaction.user.handle}`);
    return;
  }

  // 2. Deterministically elect the current executor for this post.
  const carriers = getCarriersForPost(postId);
  if (carriers.length === 0) {
    console.warn(`[LP] No carriers for ${postId}; ignoring proposal.`);
    return;
  }
  const executor = electExecutor(carriers, postId);
  console.debug(`[LP] post=${postId} carriers=[${carriers.map(c=>c.handle).join(',')}] elected=${executor?.handle}`);
  if (!executor) {
    console.warn(`No valid executor found for post ${postId}`);
    return;
  }

  // 3. Check if *I* am the elected executor.
  if (executor.handle === state.myIdentity.handle) {
    console.log(`[LP Executor] I am the elected executor for post ${postId}. Processing interaction.`);
    // If so, process the interaction and broadcast the state update.
    await processLivingPostInput(post, interaction);
  }
}




/**
 * Gets a list of carrier objects with their IDs, handles, and peer data.
 * - De-duplicates strictly by handle so every node sees the same carrier set.
 * @param {string} postId - The ID of the post.
 * @returns {Array<object>} A list of carrier peers.
 */
function getCarriersForPost(postId) {
  const post = state.posts.get(postId);
  if (!post) return [];

  const carriers = [];
  const seenHandles = new Set();

  const pushOnce = (peerId, handle, peer) => {
    if (!handle) return;
    if (!post.carriers.has(handle)) return;
    if (seenHandles.has(handle)) return;
    carriers.push({ id: peerId ?? null, handle, peer: peer ?? null });
    seenHandles.add(handle);
  };

  // 1) From identities (prefer identities first so metadata is consistent)
  for (const [peerId, identity] of state.peerIdentities) {
    const handle = identity?.handle;
    const peer   = state.peers.get(peerId) || null;
    pushOnce(peerId, handle, peer);
  }

  // 2) From peers that have a handle but no identity (fills gaps)
  for (const [peerId, peer] of state.peers) {
    const handle = peer?.handle || null;
    pushOnce(peerId, handle, peer);
  }

  // 3) Add self if carrying (won’t duplicate because we dedupe by handle)
  if (state.myIdentity?.handle && post.carriers.has(state.myIdentity.handle)) {
    // If you track a concrete connection id for self, use it; otherwise null is fine.
    const selfPeerId = state.selfPeerId ?? null;
    pushOnce(selfPeerId, state.myIdentity.handle, { isSelf: true });
  }

  return carriers;
}

/**
 * Deterministically elects an executor from a list of carriers based on reputation.
 * @param {Array<object>} carriers - A list of carrier peers from getCarriersForPost.
 * @returns {object|null} The elected executor peer object or null.
 */
function electExecutor(carriers, postId) {
  if (!carriers || carriers.length === 0) return null;

  // tiny deterministic 32-bit djb2
  const stableHash = (s) => {
    let h = 5381 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h;
  };

  const scored = carriers.map(c => ({
    ...c,
    _h: stableHash(`${postId}:${c.handle}`)
  }));

  // Sort by hash, then by handle as a tie-breaker
  scored.sort((a, b) => (a._h - b._h) || a.handle.localeCompare(b.handle));

  return scored[0];
}

/**
 * Handle a living-post state update broadcast.
 * Accepts the update if:
 *  - the signer is (currently) a carrier for the post, and
 *  - the signature verifies (supports both legacy "state-only" payload and canonical payload with rev)
 * Then applies the state and refreshes the UI.
 *
 * @param {Object} msg
 * @param {boolean} fromWire  // true if came from network transport
 *
 * Expected msg shape:
 * {
 *   postId: string,
 *   executorHandle: string,          // claimed signer
 *   executorPublicKey: string,       // base64
 *   newState: string,                // JSON string
 *   signature: string,               // base64
 *   rev?: number,                    // optional monotonic revision
 *   carriersHash?: string            // optional hint to detect membership skew
 * }
 */
async function handle_lp_state_update(msg, fromWire) {
  try {
    // basic validation
    if (!msg || !msg.postId || !msg.executorHandle || !msg.executorPublicKey || !msg.newState || !msg.signature) {
      console.warn('[LP] state_update: missing fields', msg);
      return;
    }

    // fetch post
    const post = state.posts?.get ? state.posts.get(msg.postId) : (state.posts || {})[msg.postId];
    if (!post) {
      // unknown post: we can ignore, or queue for later. For now just log.
      console.warn('[LP] state_update: post not found', msg.postId);
      return;
    }

    // enforce "only carriers can influence state"
    const isSignerCarrier = (() => {
      const carriers = post.carriers;
      if (!carriers) return false;

      // carriers might be: Set<string>, Array<string>, Array<{handle:string}>, Map/Record of handles
      if (carriers instanceof Set) return carriers.has(msg.executorHandle);
      if (Array.isArray(carriers)) {
        return carriers.some(c => (typeof c === 'string' ? c === msg.executorHandle : c?.handle === msg.executorHandle));
      }
      if (carriers instanceof Map) return carriers.has(msg.executorHandle);
      if (typeof carriers === 'object') return Object.prototype.hasOwnProperty.call(carriers, msg.executorHandle);
      return false;
    })();

    if (!isSignerCarrier) {
      console.warn(`[LP] state_update: signer ${msg.executorHandle} is not a current carrier; ignoring.`);
      return;
    }

    // identity binding (executorHandle -> executorPublicKey)
    if (state.identityRegistry && typeof state.identityRegistry.lookupHandle === 'function') {
      try {
        const claim = await state.identityRegistry.lookupHandle(msg.executorHandle);
        if (!claim) {
          console.warn('[LP] state_update: no identity claim for', msg.executorHandle);
          return;
        }
        const claimedKeyB64 = (typeof claim.publicKey === 'string')
          ? claim.publicKey
          : arrayBufferToBase64(claim.publicKey);
        if (claimedKeyB64 !== msg.executorPublicKey) {
          console.warn('[LP] state_update: publicKey mismatch for', msg.executorHandle);
          return;
        }
      } catch (e) {
        console.warn('[LP] state_update: identity lookup failed', e);
        return;
      }
    }


    // signature verification
    const encoder = new TextEncoder();
    const pubKeyBytes = base64ToArrayBuffer(msg.executorPublicKey);
    const sigBytes = base64ToArrayBuffer(msg.signature);

    // 1) legacy payload: sign( newState )
    const stateBytes = encoder.encode(msg.newState);
    let verified = false;
    try {
      verified = nacl.sign.detached.verify(stateBytes, sigBytes, pubKeyBytes);
    } catch (e) {
      console.warn('[LP] state_update: legacy verify threw', e);
    }

    // 2) canonical payload (if rev present): sign( JSON.stringify({postId, rev, state}) )
    if (!verified && typeof msg.rev === 'number') {
      const canonical = JSON.stringify({ postId: msg.postId, rev: msg.rev, state: msg.newState });
      const canonicalBytes = encoder.encode(canonical);
      try {
        verified = nacl.sign.detached.verify(canonicalBytes, sigBytes, pubKeyBytes);
      } catch (e) {
        console.warn('[LP] state_update: canonical verify threw', e);
      }
    }

    if (!verified) {
      console.warn('[LP] state_update: signature verification failed for', msg.postId, 'from', msg.executorHandle);
      return;
    }

    // drop duplicates / out-of-order updates when rev is available
    if (typeof msg.rev === 'number') {
      const currentRev = typeof post.lpRev === 'number' ? post.lpRev : 0;
      if (msg.rev <= currentRev) {
        // stale or duplicate — ignore quietly
        return;
      }
      post.lpRev = msg.rev;
    }

    // apply state (keep the string; parse for convenience if needed)
    post.lpState = msg.newState;
    try {
      post.lpStateObj = JSON.parse(msg.newState);
    } catch {
      // keep as string if not valid JSON
      delete post.lpStateObj;
    }

    // (optional) note executor for UI/debugging
    post.lpLastExecutor = msg.executorHandle;
    post.lpUpdatedAt = Date.now();

    // surface carriers membership skew for diagnostics (do not reject!)
    if (msg.carriersHash && typeof computeCarriersHash === 'function') {
      const localHash = computeCarriersHash(post.carriers);
      if (localHash !== msg.carriersHash) {
        console.debug('[LP] state_update: carriers hash mismatch (accepting update anyway). remote=', msg.carriersHash, 'local=', localHash);
        // you could trigger a resync here:
        // enqueueCarriersResync(msg.postId);
      }
    }

    // refresh UI
    if (typeof refreshPost === 'function') {
      refreshPost(post);
    } else if (typeof renderPost === 'function') {
      renderPost(post);
    }
    
    { const _c=document.querySelector('.lp-max-overlay canvas[data-lp-canvas][data-post-id="'+msg.postId+'"]'); if(_c && post.lpStateObj?.gfx) drawGfxIntoCanvas(_c, post.lpStateObj.gfx, { postId: msg.postId }); } 
    
  } catch (err) {
    console.error('[LP] state_update: unhandled error', err, msg);
  }
}



function toggleCarry(id, isManual = true) {
    const p = state.posts.get(id);
    if (!p) return;
    const isCarrying = p.carriers.has(state.myIdentity.handle);

    if (!isCarrying) {
        p.carriers.add(state.myIdentity.handle);
        state.explicitlyCarrying.add(id);
        broadcast({ type: "carrier_update", postId: id, peer: state.myIdentity.handle, carrying: true });
        refreshPost(p);
        state.scribe?.subscribe(`#lp:${id}`);
    } else {
        p.carriers.delete(state.myIdentity.handle);
        state.explicitlyCarrying.delete(id);
        broadcast({ type: "carrier_update", postId: id, peer: state.myIdentity.handle, carrying: false });
        if (p.carriers.size === 0 && !isReply(p)) {
            if (!debugPostRemoval(p.id, 'toggleCarry - withdrawn')) {
                
                const post = state.posts.get(id);
                if (post?.postType === 'living') {
                  state.scribe?.unsubscribe(`#lp:${id}`);
                }               
                
                state.posts.delete(p.id);
                
                dropPost(id);
            }
        } else {
            refreshPost(p);
        }
        state.scribe?.unsubscribe(`#lp:${id}`);
    }
}

async function ratePost(postId, vote) {
    const post = state.posts.get(postId);
    if (!post) return;
    
    // Can't rate your own posts - return early
    if (post.author === state.myIdentity.handle) {
        notify("You cannot rate your own posts");
        return;
    }
    
    // For the current user voting on others' posts, just use a default reputation
    const myReputation = 50; // Default reputation for self
    
    // Add/update rating
    const changed = post.addRating(state.myIdentity.handle, vote, myReputation);
    
    if (changed) {
        // Animate the score update
        const scoreEl = document.querySelector(`#post-${postId} .rating-score`);
        if (scoreEl) {
            scoreEl.classList.add('updating');
            setTimeout(() => scoreEl.classList.remove('updating'), 300);
        }
        if (vote === 'up') {
          getServices().activityProfile.updateAuthorAffinity(post, 'upvote');
        }
        // Update UI
        refreshPost(post);
        
        // Broadcast rating to network
        const ratingMsg = {
            type: 'post_rating',
            postId: postId,
            voter: state.myIdentity.handle,
            vote: vote,
            reputation: myReputation,
            timestamp: Date.now()
        };
        
        // Sign the rating
        const msgStr = JSON.stringify({
            postId: ratingMsg.postId,
            voter: ratingMsg.voter,
            vote: ratingMsg.vote,
            timestamp: ratingMsg.timestamp
        });
        
const signature = nacl.sign(
  new TextEncoder().encode(msgStr),
  new Uint8Array(state.myIdentity.secretKey) // Explicitly cast to Uint8Array
);
        
        ratingMsg.signature = arrayBufferToBase64(signature);
        ratingMsg.voterPublicKey = arrayBufferToBase64(state.myIdentity.publicKey);
        
        broadcast(ratingMsg);
        
        // Visual feedback
        const emoji = vote === 'up' ? '👍' : '👎';
        notify(`Rated post ${emoji}`);
    } else {
        notify("You've already given this rating");
    }
}

async function createReply(parentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    if (!input) return;

    // --- Note: This next line correctly finds the button within the reply form ---
    const btn = input.parentElement.querySelector('button.primary-button');
    btn.disabled = true;
    btn.textContent = 'Mixing...'; // <-- ADD THIS LINE

    try {
        const txt = input.value.trim();
        if (!txt) {
            btn.disabled = false;
            btn.textContent = '🔥'; // <-- ADD THIS LINE TO RESET ON EMPTY INPUT
            return; 
        }
        
        const parentPost = state.posts.get(parentId);
        if (!parentPost) {
            notify("Parent post no longer exists!");
            btn.disabled = false;
            btn.textContent = '🔥'; // <-- AND THIS ONE
            return;
        }


        // --- Local pre-checks ---
        if (await isToxic(txt)) {
            notify(`Your reply may be seen as toxic. Please rephrase.`);
            btn.disabled = false;
            return;
        }

        const imagePreview = document.getElementById(`reply-image-preview-${parentId}`);
        const imageData = imagePreview?.dataset?.imageData || null;
        if (imageData && await isImageToxic(imageData)) {
            notify("Image content not allowed");
            btn.disabled = false;
            return;
        }
          getServices().activityProfile.updateAuthorAffinity(parentPost, 'reply');

        // --- Reply Creation (Local) ---
        // Create the reply Post object with the parentId, process image, and sign it.
        const reply = new Post(txt, parentId, imageData);
        reply.depth = Math.min(parentPost.depth + 1, 5);

        if (imageData) {
            await reply.processImage();
        }
        reply.sign(state.myIdentity.secretKey);
        
        // --- Hand off to Privacy Layer ---
        // The PrivacyPublisher handles the VDF proof, encryption, and relaying.
        // It works for both top-level posts and replies without any changes.
        await getServices().privacyPublisher.publishPost(reply);

        // --- UI Cleanup ---
        input.value = "";
        document.getElementById(`reply-char-${parentId}`).textContent = 0;
        removeReplyImage(parentId);
        toggleReplyForm(parentId); 
        notify("Reply sent to the mixing layer!");

    } catch (error) {
        console.error("Failed to create reply:", error);
        notify(`Could not create reply: ${error.message}`);
    } finally {
        // IMPORTANT: Always re-enable the button, whether it succeeded or failed.
        btn.disabled = false;
        btn.textContent = '🔥'; // <-- ADD THIS LINE
    }
}

async function checkAndDeliverPendingMessages(recipientHandle = null) {
  try {
    console.log('[DM] Checking for pending messages to deliver');
    
    // Get all our pending outgoing messages
    const pendingMessages = await stateManager.getPendingMessagesFrom(state.myIdentity.handle);
    
    if (pendingMessages.length === 0) {
      return;
    }
    
    console.log(`[DM] Found ${pendingMessages.length} pending messages`);
    
    for (const pending of pendingMessages) {
      // Skip if not for the specified recipient (if specified)
      if (recipientHandle && pending.recipient !== recipientHandle) {
        continue;
      }
      
      // Check if recipient is now online
      const routingInfo = await state.identityRegistry.lookupPeerLocation(pending.recipient);
      if (!routingInfo) {
        console.log(`[DM] ${pending.recipient} still offline, skipping`);
        continue;
      }
      
      // Try to deliver
      console.log(`[DM] Attempting to deliver pending message to ${pending.recipient}`);
      
      // Update attempt count
      await stateManager.updateMessageAttempt(pending.id);
      
      // Reconstruct the DM packet
      const dmPacket = {
        type: 'e2e_dm',
        recipient: pending.recipient,
        sender: state.myIdentity.handle,
        ciphertext: pending.encrypted.ciphertext,
        nonce: pending.encrypted.nonce,
        timestamp: pending.timestamp,
        messageId: pending.id, // Include ID for delivery confirmation
        isRetry: true
      };
      
      // Try direct delivery
      const directPeer = await findPeerByHandle(pending.recipient);
      if (directPeer) {
        sendPeer(directPeer.wire, dmPacket);
        console.log(`[DM] Sent pending message directly to ${pending.recipient}`);
        continue;
      }
      
      // Try DHT routing
      const recipientClaim = await state.identityRegistry.lookupHandle(pending.recipient);
      if (recipientClaim && recipientClaim.nodeId) {
        const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
        const closestPeers = await state.dht.findNode(recipientNodeId);
        
        if (closestPeers.length > 0) {
          const peer = closestPeers[0];
          if (peer.wire && !peer.wire.destroyed) {
            sendPeer(peer.wire, dmPacket);
            console.log(`[DM] Sent pending message to ${pending.recipient} via DHT`);
          }
        }
      }
    }
  } catch (error) {
    console.error('[DM] Error delivering pending messages:', error);
  }
}

async function storePendingMessage(recipientHandle, messageText, status = 'queued') {
  try {
    // First encrypt the message for storage
    const recipientClaim = await state.identityRegistry.lookupHandle(recipientHandle);
    if (!recipientClaim || !recipientClaim.encryptionPublicKey) {
      console.error('[DM] Cannot store message - no encryption key for recipient');
      return null;
    }
    
    // Encrypt the message
    const nonce = nacl.randomBytes(24);
    const messageBytes = new TextEncoder().encode(messageText);
    const recipientPublicKey = base64ToArrayBuffer(recipientClaim.encryptionPublicKey);
    const ciphertext = nacl.box(
      messageBytes,
      nonce,
      recipientPublicKey,
      state.myIdentity.encryptionSecretKey
    );
    
    const encryptedData = {
      ciphertext: arrayBufferToBase64(ciphertext),
      nonce: arrayBufferToBase64(nonce)
    };
    
    // Store in IndexedDB
    const messageId = await stateManager.storePendingMessage(
      recipientHandle,
      messageText,
      state.myIdentity.handle,
      encryptedData
    );
    
    // Also update UI to show pending status
    storeDMLocallyAndUpdateUI(recipientHandle, messageText, status);
    
    console.log(`[DM] Stored pending message ${messageId} for ${recipientHandle}`);
    return messageId;
    
  } catch (error) {
    console.error('[DM] Failed to store pending message:', error);
    return null;
  }
}

async function sendDMRequest(recipientHandle) {
  console.log(`[DM] Sending DM request to ${recipientHandle}`);
  
  // Update local permissions
  state.dmPermissions.set(recipientHandle, {
    status: 'pending_outgoing',
    timestamp: Date.now()
  });
  
  // Create request message
  const requestMsg = {
    type: 'dm_request',
    sender: state.myIdentity.handle,
    recipient: recipientHandle,
    timestamp: Date.now(),
    publicKey: arrayBufferToBase64(state.myIdentity.publicKey)
  };
  
  // Sign the request
  const msgStr = JSON.stringify({
    sender: requestMsg.sender,
    recipient: requestMsg.recipient,
    timestamp: requestMsg.timestamp
  });
  
const signature = nacl.sign(
  new TextEncoder().encode(msgStr),
  new Uint8Array(state.myIdentity.secretKey) // Explicitly cast to Uint8Array
);
  
  requestMsg.signature = arrayBufferToBase64(signature);
  
  // Try to send via existing DM routing mechanisms
  const directPeer = await findPeerByHandle(recipientHandle);
  if (directPeer) {
    sendPeer(directPeer.wire, requestMsg);
    notify(`DM request sent to ${recipientHandle}`);
    return true;
  }
  
  // Fall back to DHT routing
  const recipientClaim = await state.identityRegistry.lookupHandle(recipientHandle);
  if (recipientClaim && recipientClaim.nodeId) {
    const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
    const closestPeers = await state.dht.findNode(recipientNodeId);
    
    if (closestPeers.length > 0) {
      sendPeer(closestPeers[0].wire, requestMsg);
      notify(`DM request sent to ${recipientHandle}`);
      return true;
    }
  }
  
  notify(`Could not reach ${recipientHandle}. They may be offline.`);
  return false;
}

async function handleDMRequest(msg, fromWire) {
  // Check if this message is for us
  if (msg.recipient !== state.myIdentity.handle) {
    // Forward if not for us using same logic as handleDirectMessage
    console.log(`[DM] Request for ${msg.recipient}, attempting to forward`);
    
    // Try to forward using routing hint first
    const routingInfo = await state.identityRegistry.lookupPeerLocation(msg.recipient);
    if (routingInfo) {
      // Check if recipient is directly connected to us
      const directPeer = await findPeerByHandle(msg.recipient);
      if (directPeer) {
        console.log(`[DM] Forwarding request directly to ${msg.recipient}`);
        sendPeer(directPeer.wire, msg);
        return;
      }
    }
    
    // Fall back to DHT routing
    const recipientClaim = await state.identityRegistry.lookupHandle(msg.recipient);
    if (recipientClaim && recipientClaim.nodeId) {
      const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
      const closestPeers = state.dht.findClosestPeers(recipientNodeId, 3);
      
      for (const peer of closestPeers) {
        if (peer.wire !== fromWire && peer.wire && !peer.wire.destroyed) {
          sendPeer(peer.wire, msg);
        }
      }
      console.log(`[DM] Forwarded request to ${closestPeers.length} peers via DHT`);
    }
    return;
  }
  
  // Verify signature
  try {
    const dataToVerify = JSON.stringify({
      sender: msg.sender,
      recipient: msg.recipient,
      timestamp: msg.timestamp
    });
    
    const publicKey = base64ToArrayBuffer(msg.publicKey);
    const sig = base64ToArrayBuffer(msg.signature);
    
    const verified = nacl.sign.open(sig, publicKey);
    if (!verified) {
      console.warn(`[DM] Invalid signature on DM request from ${msg.sender}`);
      return;
    }
    
    const decodedData = new TextDecoder().decode(verified);
    if (decodedData !== dataToVerify) {
      console.warn(`[DM] Signature mismatch on DM request from ${msg.sender}`);
      return;
    }
  } catch (e) {
    console.error('[DM] Failed to verify DM request signature:', e);
    return;
  }
  
  // Check if already have permission status
  const existing = state.dmPermissions.get(msg.sender);
  if (existing?.status === 'approved' || existing?.status === 'blocked') {
    // Already decided, ignore new request
    console.log(`[DM] Ignoring request from ${msg.sender} - already ${existing.status}`);
    return;
  }
  
  // Store as pending incoming
  state.dmPermissions.set(msg.sender, {
    status: 'pending_incoming',
    timestamp: msg.timestamp
  });
  
  // Notify user
  notify(`📨 ${msg.sender} wants to send you messages`, 10000,
    () => window.showDMRequest(msg.sender));
  
  // Update UI to show pending request
  updateDMInbox();
}

async function approveDMRequest(handle) {
  console.log(`[DM] Approving DM request from ${handle}`);
  
  // Update local state
  state.dmPermissions.set(handle, {
    status: 'approved',
    timestamp: Date.now()
  });
  
  // Send approval message
  const approvalMsg = {
    type: 'dm_approve',
    sender: state.myIdentity.handle,
    recipient: handle,
    timestamp: Date.now()
  };
  
  // Sign it
  const msgStr = JSON.stringify({
    sender: approvalMsg.sender,
    recipient: approvalMsg.recipient,
    timestamp: approvalMsg.timestamp
  });
  
const signature = nacl.sign(
  new TextEncoder().encode(msgStr),
  new Uint8Array(state.myIdentity.secretKey) // Explicitly cast to Uint8Array
);
  
  approvalMsg.signature = arrayBufferToBase64(signature);
  approvalMsg.publicKey = arrayBufferToBase64(state.myIdentity.publicKey);
  
  // Send via DM routing
  const directPeer = await findPeerByHandle(handle);
  if (directPeer) {
    sendPeer(directPeer.wire, approvalMsg);
  } else {
    // Use DHT routing as fallback
    const recipientClaim = await state.identityRegistry.lookupHandle(handle);
    if (recipientClaim && recipientClaim.nodeId) {
      const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
      const closestPeers = await state.dht.findNode(recipientNodeId);
      if (closestPeers.length > 0) {
        sendPeer(closestPeers[0].wire, approvalMsg);
      }
    }
  }
  
  notify(`✅ Approved messages from ${handle}`);
  updateDMInbox();
}

async function handleDMApprove(msg, fromWire) {
  // Check if this message is for us
  if (msg.recipient !== state.myIdentity.handle) {
    // Forward if not for us using same logic as handleDirectMessage
    console.log(`[DM] Approval for ${msg.recipient}, attempting to forward`);
    
    const routingInfo = await state.identityRegistry.lookupPeerLocation(msg.recipient);
    if (routingInfo) {
      const directPeer = await findPeerByHandle(msg.recipient);
      if (directPeer) {
        console.log(`[DM] Forwarding approval directly to ${msg.recipient}`);
        sendPeer(directPeer.wire, msg);
        return;
      }
    }
    
    const recipientClaim = await state.identityRegistry.lookupHandle(msg.recipient);
    if (recipientClaim && recipientClaim.nodeId) {
      const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
      const closestPeers = state.dht.findClosestPeers(recipientNodeId, 3);
      
      for (const peer of closestPeers) {
        if (peer.wire !== fromWire && peer.wire && !peer.wire.destroyed) {
          sendPeer(peer.wire, msg);
        }
      }
      console.log(`[DM] Forwarded approval to ${closestPeers.length} peers via DHT`);
    }
    return;
  }
  
  // Verify signature
  try {
    const dataToVerify = JSON.stringify({
      sender: msg.sender,
      recipient: msg.recipient,
      timestamp: msg.timestamp
    });
    
    const publicKey = base64ToArrayBuffer(msg.publicKey);
    const sig = base64ToArrayBuffer(msg.signature);
    
    const verified = nacl.sign.open(sig, publicKey);
    if (!verified) {
      console.warn(`[DM] Invalid signature on DM approval from ${msg.sender}`);
      return;
    }
    
    const decodedData = new TextDecoder().decode(verified);
    if (decodedData !== dataToVerify) {
      console.warn(`[DM] Signature mismatch on DM approval from ${msg.sender}`);
      return;
    }
  } catch (e) {
    console.error('[DM] Failed to verify DM approval signature:', e);
    return;
  }
  
  // Update permission status
  state.dmPermissions.set(msg.sender, {
    status: 'approved',
    timestamp: Date.now()
  });
  
  notify(`✅ ${msg.sender} has approved your DM request!`, 5000);
  updateDMInbox();
}

async function revokeDMPermission(handle) {
  console.log(`[DM] Revoking DM permission for ${handle}`);
  
  // Update local state
  state.dmPermissions.delete(handle);
  
  // Send revoke message
  const revokeMsg = {
    type: 'dm_revoke',
    sender: state.myIdentity.handle,
    recipient: handle,
    timestamp: Date.now()
  };
  
  // Sign it
  const msgStr = JSON.stringify({
    sender: revokeMsg.sender,
    recipient: revokeMsg.recipient,
    timestamp: revokeMsg.timestamp
  });
  
const signature = nacl.sign(
  new TextEncoder().encode(msgStr),
  new Uint8Array(state.myIdentity.secretKey) // Explicitly cast to Uint8Array
);
  
  revokeMsg.signature = arrayBufferToBase64(signature);
  revokeMsg.publicKey = arrayBufferToBase64(state.myIdentity.publicKey);
  
  // Send via DM routing
  const directPeer = await findPeerByHandle(handle);
  if (directPeer) {
    sendPeer(directPeer.wire, revokeMsg);
  } else {
    // Use DHT routing as fallback
    const recipientClaim = await state.identityRegistry.lookupHandle(handle);
    if (recipientClaim && recipientClaim.nodeId) {
      const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
      const closestPeers = await state.dht.findNode(recipientNodeId);
      if (closestPeers.length > 0) {
        sendPeer(closestPeers[0].wire, revokeMsg);
      }
    }
  }
  
  notify(`Revoked DM permission for ${handle}`);
  updateDMInbox();
}

async function handleDMRevoke(msg, fromWire) {
  // Check if this message is for us
  if (msg.recipient !== state.myIdentity.handle && msg.sender !== state.myIdentity.handle) {
    // Forward if not for us
    console.log(`[DM] Revoke message not for us, attempting to forward`);
    
    // Try forwarding to recipient
    const recipientInfo = await state.identityRegistry.lookupPeerLocation(msg.recipient);
    if (recipientInfo) {
      const directPeer = await findPeerByHandle(msg.recipient);
      if (directPeer) {
        sendPeer(directPeer.wire, msg);
        return;
      }
    }
    
    // Also try forwarding to sender
    const senderInfo = await state.identityRegistry.lookupPeerLocation(msg.sender);
    if (senderInfo) {
      const directPeer = await findPeerByHandle(msg.sender);
      if (directPeer) {
        sendPeer(directPeer.wire, msg);
        return;
      }
    }
    
    // Fall back to DHT routing for both
    const targets = [msg.recipient, msg.sender];
    for (const target of targets) {
      const claim = await state.identityRegistry.lookupHandle(target);
      if (claim && claim.nodeId) {
        const nodeId = base64ToArrayBuffer(claim.nodeId);
        const closestPeers = state.dht.findClosestPeers(nodeId, 3);
        
        for (const peer of closestPeers) {
          if (peer.wire !== fromWire && peer.wire && !peer.wire.destroyed) {
            sendPeer(peer.wire, msg);
          }
        }
      }
    }
    return;
  }
  
  // Verify signature
  try {
    const dataToVerify = JSON.stringify({
      sender: msg.sender,
      recipient: msg.recipient,
      timestamp: msg.timestamp
    });
    
    const publicKey = base64ToArrayBuffer(msg.publicKey);
    const sig = base64ToArrayBuffer(msg.signature);
    
    const verified = nacl.sign.open(sig, publicKey);
    if (!verified) {
      console.warn(`[DM] Invalid signature on DM revoke`);
      return;
    }
  } catch (e) {
    console.error('[DM] Failed to verify DM revoke signature:', e);
    return;
  }
  
  // Handle revoke based on who sent it
  if (msg.sender === state.myIdentity.handle) {
    // We revoked permission for someone
    state.dmPermissions.delete(msg.recipient);
    notify(`You revoked DM permission for ${msg.recipient}`);
  } else {
    // Someone revoked our permission
    state.dmPermissions.delete(msg.sender);
    notify(`${msg.sender} revoked your DM permission`);
  }
  
  updateDMInbox();
}

async function sendDirectMessage(recipientHandle, messageText) {
  console.log(`[DM] Initializing DM to ${recipientHandle}...`);

  try {
    // Check DM permissions first
    const permission = state.dmPermissions.get(recipientHandle);
    const status = permission?.status;
    
    if (status === 'blocked') {
      notify(`You have blocked ${recipientHandle}. Unblock them to send messages.`);
      return false;
    }
    
    if (status !== 'approved') {
      // Need to send a request first
      if (status === 'pending_outgoing') {
        notify(`DM request to ${recipientHandle} is still pending.`);
        return false;
      }
      
      // Send DM request
      await sendDMRequest(recipientHandle);
      return false; // Don't send the actual message yet
    }
    
    // --- Step 1: Find and Validate Recipient's Identity ---
    let recipientClaim = null;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      notify(`Searching for ${recipientHandle}... (Attempt ${attempt + 1})`);
      recipientClaim = await state.identityRegistry.lookupHandle(recipientHandle);
      if (recipientClaim) break;
    }

    if (!recipientClaim) {
      notify(`Could not find user "${recipientHandle}". They may be offline or do not exist.`);
      return false;
    }

    if (!recipientClaim.encryptionPublicKey) {
      notify(`User ${recipientHandle} does not support encrypted messages.`);
      return false;
    }

    // --- Step 2: Prepare the Encrypted Packet ---
    const nonce = nacl.randomBytes(24);
    const messageBytes = new TextEncoder().encode(messageText);
    const recipientPublicKey = base64ToArrayBuffer(recipientClaim.encryptionPublicKey);
    const ciphertext = nacl.box(
      messageBytes, nonce, recipientPublicKey, state.myIdentity.encryptionSecretKey
    );
    const dmPacket = {
      type: 'e2e_dm',
      recipient: recipientHandle,
      sender: state.myIdentity.handle,
      ciphertext: arrayBufferToBase64(ciphertext),
      nonce: arrayBufferToBase64(nonce),
      timestamp: Date.now()
    };

    // --- Step 3: Attempt Direct Delivery (Highest Priority) ---
    const directPeer = await findPeerByHandle(recipientHandle);
    if (directPeer) {
      console.log(`[DM] Direct connection found. Sending message to ${recipientHandle}.`);
      sendPeer(directPeer.wire, dmPacket);
      storeDMLocallyAndUpdateUI(recipientHandle, messageText, 'sent');
      addMessageToConversation(recipientHandle, messageText, 'sent');
      notify(`Message sent directly to ${recipientHandle}`);
      return true;
    }

    // --- Step 4: Fallback to DHT-based Routing ---
    const routingInfo = await state.identityRegistry.lookupPeerLocation(recipientHandle);
    if (routingInfo) {
      console.log(`[DM] No direct connection. Forwarding message to ${recipientHandle} via DHT.`);
      dmPacket.routingHint = routingInfo.wirePeerId;
      const recipientNodeId = base64ToArrayBuffer(routingInfo.nodeId);
      const closestPeers = await state.dht.findNode(recipientNodeId);

      if (closestPeers.length > 0) {
        sendPeer(closestPeers[0].wire, dmPacket);
        storeDMLocallyAndUpdateUI(recipientHandle, messageText, 'sent');
        addMessageToConversation(recipientHandle, messageText, 'sent');
        notify(`Message sent to ${recipientHandle} via network routing`);
        return true;
      }
    }

    // --- Step 5: Last Resort - Store for Offline Delivery ---
    console.log(`[DM] User ${recipientHandle} is unreachable. Storing message for later delivery.`);
    await storePendingMessage(recipientHandle, messageText, 'queued');
    notify(`${recipientHandle} appears to be offline. Your message has been saved.`);
    return true;

  } catch (error) {
    console.error('Error sending direct message:', error);
    notify(`Error: Could not send message to ${recipientHandle}.`);
    return false;
  }
}

async function handleDirectMessage(msg, fromWire) {
  try {
    // Check if this message is for us
    if (msg.recipient !== state.myIdentity.handle) {
      console.log(`[DM] Message for ${msg.recipient}, attempting to forward`);
      
      // Try to forward using routing hint first
      if (msg.routingHint) {
        for (const [peerId, peer] of state.peers) {
          if (peerId === msg.routingHint && peer.wire && !peer.wire.destroyed) {
            console.log(`[DM] Forwarding to peer via routing hint`);
            sendPeer(peer.wire, msg);
            return;
          }
        }
      }
      
      // Fall back to looking up current routing
      const routingInfo = await state.identityRegistry.lookupPeerLocation(msg.recipient);
      if (routingInfo) {
        // Check if recipient is directly connected to us
        const directPeer = await findPeerByHandle(msg.recipient);
        if (directPeer) {
          console.log(`[DM] Forwarding directly to ${msg.recipient}`);
          sendPeer(directPeer.wire, msg);
          return;
        }
      }
      
      // Fall back to DHT routing
      const recipientClaim = await state.identityRegistry.lookupHandle(msg.recipient);
      if (recipientClaim && recipientClaim.nodeId) {
        const recipientNodeId = base64ToArrayBuffer(recipientClaim.nodeId);
        const closestPeers = state.dht.findClosestPeers(recipientNodeId, 3);
        
        for (const peer of closestPeers) {
          if (peer.wire !== fromWire && peer.wire && !peer.wire.destroyed) {
            sendPeer(peer.wire, msg);
          }
        }
        console.log(`[DM] Forwarded to ${closestPeers.length} peers via DHT`);
      }
      return;
    }
    
    // Message is for us - verify and decrypt
    console.log(`[DM] Received message from ${msg.sender}`);
    
    const senderClaim = await state.identityRegistry.lookupHandle(msg.sender);
    if (!senderClaim || !senderClaim.encryptionPublicKey) {
      console.warn(`[DM] Unknown or invalid sender: ${msg.sender}`);
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
      console.error('[DM] Failed to decrypt - invalid ciphertext or keys');
      return;
    }
    
    const messageText = new TextDecoder().decode(decryptedBytes);
    
    // Store and display the message
    storeDMLocallyAndUpdateUI(msg.sender, messageText, 'received');
    updateUnreadBadge();
    notify(`📬 New message from ${msg.sender}`, 6000,
      () => openDMPanel(msg.sender));
    
    
    // Send delivery confirmation if this was a retry
    if (msg.messageId && msg.isRetry) {
      const confirmation = {
        type: 'dm_delivered',
        messageId: msg.messageId,
        recipient: msg.recipient,
        deliveredAt: Date.now()
      };
      
      // Send confirmation back
      const senderPeer = await findPeerByHandle(msg.sender);
      if (senderPeer) {
        sendPeer(senderPeer.wire, confirmation);
      } else {
        // Route through DHT
        const senderClaim = await state.identityRegistry.lookupHandle(msg.sender);
        if (senderClaim && senderClaim.nodeId) {
          const senderNodeId = base64ToArrayBuffer(senderClaim.nodeId);
          const closestPeers = await state.dht.findNode(senderNodeId);
          if (closestPeers.length > 0) {
            sendPeer(closestPeers[0].wire, confirmation);
          }
        }
      }
    }   
      
    
    // Update UI if DM panel is open
    if (currentDMRecipient === msg.sender) {
      addMessageToConversation(msg.sender, messageText, 'received');
    }
    
    // Check if we have pending messages to send back
    await checkAndDeliverPendingMessages(msg.sender);
    
  } catch (error) {
    console.error('[DM] Receive error:', error);
  }
}

// Profile Functions
async function broadcastProfileUpdate(profileData = null) {
  if (!state.myIdentity || !state.scribe) return;
  
  const profile = profileData || state.myIdentity.profile;
  if (!profile) return;

  // Add the user's public subscriptions to their profile before broadcasting.
  profile.subscriptions = Array.from(state.subscribedTopics);

  const topic = '@' + state.myIdentity.handle;
  console.log(`[Profile] Broadcasting profile update to topic: ${topic}`);
  
  // Sign the profile data
  const profileStr = JSON.stringify(profile);
const signature = nacl.sign(
  new TextEncoder().encode(profileStr),
  new Uint8Array(state.myIdentity.secretKey) // Explicitly cast to Uint8Array
);
  
  const message = {
    type: 'PROFILE_UPDATE',
    profile: profile,
    signature: arrayBufferToBase64(signature),
    publicKey: arrayBufferToBase64(state.myIdentity.publicKey)
  };
  
  try {
    // ADDED: Store in DHT
    const dhtKey = `profile:${profile.handle}`;
    console.log(`[Profile] Storing profile in DHT with key: ${dhtKey}`);
    
    try {
      await state.dht.store(dhtKey, message);
      console.log('[Profile] Profile successfully stored in DHT');
    } catch (dhtError) {
      console.error('[Profile] Failed to store profile in DHT:', dhtError);
    }
    
    // Original Scribe multicast
    await state.scribe.multicast(topic, message);
    console.log('[Profile] Profile update broadcast successful');
  } catch (error) {
    console.error('[Profile] Failed to broadcast profile update:', error);
  }
}

async function subscribeToProfile(handle) {
  if (!state.scribe) return;
  
  const topic = '@' + handle;
  console.log(`[Profile] Subscribing to profile topic: ${topic}`);
  
  try {
    await state.scribe.subscribe(topic);
    console.log(`[Profile] Successfully subscribed to ${handle}'s profile`);
  } catch (error) {
    console.error(`[Profile] Failed to subscribe to ${handle}'s profile:`, error);
  }
}

async function unsubscribeFromProfile(handle) {
  if (!state.scribe || !handle) return;
  
  const topic = '@' + handle;
  console.log(`[Profile] Unsubscribing from profile topic: ${topic}`);
  
  try {
    state.scribe.unsubscribe(topic);
    console.log(`[Profile] Successfully unsubscribed from ${handle}'s profile`);
  } catch (error) {
    console.error(`[Profile] Failed to unsubscribe from ${handle}'s profile:`, error);
  }
}

function handleProfileUpdate(msg, fromWire) {
  if (!msg.profile || !msg.signature || !msg.publicKey) return;
  
  const { profile, signature, publicKey } = msg;
  
  // Verify signature
  try {
    const profileStr = JSON.stringify(profile);
    const publicKeyBytes = typeof publicKey === 'string' ? 
      base64ToArrayBuffer(publicKey) : publicKey;
    const signatureBytes = base64ToArrayBuffer(signature);
    
    const verified = nacl.sign.open(signatureBytes, publicKeyBytes);
    if (!verified) {
      console.warn('[Profile] Invalid signature on profile update');
      return;
    }
    
    // Additional check: verify the data matches
    const decodedData = new TextDecoder().decode(verified);
    if (decodedData !== profileStr) {
      console.warn('[Profile] Profile data mismatch');
      return;
    }
  } catch (error) {
    console.error('[Profile] Failed to verify profile signature:', error);
    return;
  }
  
  // Cache the profile
  state.profileCache.set(profile.handle, profile);

  // *** Check for and store the image metadata ***
  if (profile.profilePictureHash && profile.profilePictureMeta) {
    const imageStore = getServices().imageStore;
    if (imageStore && !imageStore.images.has(profile.profilePictureHash)) {
      imageStore.images.set(profile.profilePictureHash, profile.profilePictureMeta);
      console.log(`[Profile] Stored new image metadata for ${profile.handle}'s profile picture.`);
    }
  }
  
  // ADDED: Cache verified profile into local DHT
  const dhtKey = `profile:${profile.handle}`;
  console.log(`[Profile] Caching verified profile to DHT with key: ${dhtKey}`);
  
  // Store the complete message object (with signature and publicKey) in DHT
  state.dht.store(dhtKey, msg).then(() => {
    console.log(`[Profile] Successfully cached ${profile.handle}'s profile to DHT`);
  }).catch(error => {
    console.error(`[Profile] Failed to cache profile to DHT:`, error);
  });
  
  // If this is the profile we're currently viewing, update the UI
  if (state.viewingProfile === profile.handle) {
    renderProfile(profile);
  }
  
  console.log(`[Profile] Received and verified profile update for ${profile.handle}`);
}

async function handleScribeMessage(msg, fromWire) {
  if (!state.scribe) return;
  
  // Check if this is a profile update
  if (msg.subtype === 'MULTICAST' && msg.message) {
    const innerMsg = msg.message;
    if (innerMsg.type === 'PROFILE_UPDATE') {
      handleProfileUpdate(innerMsg, fromWire);
      return;
    }
  }
  
  // Pass to regular Scribe handler
  state.scribe.handleMessage(msg, fromWire);
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
    
    if (tick % 10 === 0) {
      updateAges();
      noiseGenerator.generateNoise();
      //Update profile pictures
      updateProfilePicturesInPosts();
    }
    
    if (tick % 30 === 0) {
      memoryManager.checkMemory();
      garbageCollect();
      stateManager.savePosts();
      stateManager.saveUserState();
      stateManager.saveDMPermissions();
      stateManager.savePeerScores();
      stateManager.saveImageChunks(); // Periodically save image data
      stateManager.saveDHTState(); 
      
              // Re-publish identity to DHT to ensure it doesn't expire
        if (state.myIdentity && state.dht && state.myIdentity.isRegistered) {
            console.log("[Maintenance] Re-publishing identity records to DHT...");
            
            const identityOptions = { propagate: true, refresh: true, replicationFactor: 30 };
            const publicClaim = state.myIdentity.getPublicClaim();
            const handleAddress = `handle-to-pubkey:${state.myIdentity.handle.toLowerCase()}`;
            const pubkeyAddress = `pubkey:${arrayBufferToBase64(state.myIdentity.publicKey)}`;

            state.dht.store(handleAddress, arrayBufferToBase64(state.myIdentity.publicKey), identityOptions).catch(err => {
                console.error("[Maintenance] Failed to re-publish handle mapping:", err);
            });

            state.dht.store(pubkeyAddress, publicClaim.toJSON(), identityOptions).catch(err => {
                console.error("[Maintenance] Failed to re-publish identity claim:", err);
            });
        }

      
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
          // Try to deliver pending messages
          checkAndDeliverPendingMessages().catch(e => 
            console.error('[Maintenance] Failed to check pending messages:', e)
          );
    }

    if (tick % 120 === 0) { // Every 2 minutes
      // Update our routing info in DHT
      if (state.identityRegistry && state.myIdentity && state.peers.size > 0) {
        // Find our current wire peer ID from any active connection
        let ourWirePeerId = null;
        for (const [peerId, peerData] of state.peers) {
          if (peerData.wire && !peerData.wire.destroyed) {
            // Get our peer ID as seen by this peer
            ourWirePeerId = peerData.wire._client?.peerId;
            if (ourWirePeerId) break;
          }
        }
        
        if (ourWirePeerId) {
          state.identityRegistry.updatePeerLocation(
            state.myIdentity.handle,
            state.myIdentity.nodeId,
            ourWirePeerId
          ).then(() => {
            console.log('[Maintenance] Routing info refreshed');
          }).catch(e => {
            console.error('[Maintenance] Failed to refresh routing:', e);
          });
        }
      }
      
      // Clean up expired routing entries
      if (state.identityRegistry) {
        state.identityRegistry.removeExpiredRouting();
      }
    }
    
    
if (tick % 180 === 0) { // Every 3 minutes
      // This async block now contributes to a GLOBAL topic index.
      (async () => {
        if (!state.scribe || !state.dht) return;

        const GLOBAL_INDEX_KEY = 'global-topic-index:v1';
        const MAX_TOPICS_IN_INDEX = 200;

        try {
          // Step 1: Fetch the current global index from the DHT.
          const existingIndexData = await state.dht.get(GLOBAL_INDEX_KEY);
          const globalTopics = new Map(existingIndexData || []);

          // Step 2: Get this node's locally observed active topics.
          const localActiveTopics = new Map();
          for (const topic of state.scribe.subscribedTopics.keys()) {
            const activityData = await state.dht.get(`topic-activity:${topic}`);
            if (activityData) {
              const now = Date.now();
              const ageHours = (now - activityData.lastSeen) / 3600000;
              const decayFactor = Math.pow(0.5, ageHours);
              const decayedScore = activityData.score * decayFactor;
              if (decayedScore > 0.1) {
                localActiveTopics.set(topic, { score: decayedScore });
              }
            }
          }

          // Step 3: Merge local knowledge into the global index.
          localActiveTopics.forEach((info, topic) => {
            const existingScore = globalTopics.has(topic) ? globalTopics.get(topic).score : 0;
            // Update with the higher score to keep the index fresh.
            if (info.score > existingScore) {
              globalTopics.set(topic, info);
            }
          });
          
          // Step 4: Sort and prune the merged list.
          const sortedTopics = Array.from(globalTopics.entries())
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, MAX_TOPICS_IN_INDEX);

          // Step 5: Store the updated index back to the DHT for others to see.
          await state.dht.store(GLOBAL_INDEX_KEY, sortedTopics);
          console.log(`[Maintenance] 🌐 Updated and published global index with ${sortedTopics.length} topics.`);

        } catch (e) {
          console.error('[Maintenance] Failed to update global topic index:', e);
        }
      })();
    }
    
    
    
    if (tick % 300 === 0) {
        const stats = state.seenMessages.getStats();
      // Clean up stale routing cache entries
      if (state.peerRoutingCache) {
        const now = Date.now();
        const staleTimeout = 600000; // 10 minutes
        
        for (const [handle, info] of state.peerRoutingCache) {
          const age = now - info.timestamp;
          const heartbeatAge = info.lastHeartbeat ? now - info.lastHeartbeat : Infinity;
          
          if (age > staleTimeout && heartbeatAge > staleTimeout) {
            console.log(`[Maintenance] Removing stale routing for ${handle}`);
            state.peerRoutingCache.delete(handle);
          }
        }
      }
      
      // Clean up expired DHT routing entries
      if (state.identityRegistry) {
        state.identityRegistry.removeExpiredRouting();
      }
      
      // Re-broadcast profile every 5 minutes
      if (state.myIdentity && state.myIdentity.profile) {
        broadcastProfileUpdate();
      }
    }
    
    
    
    
    
    
    if (tick % 600 === 0) { // Every 10 minutes
      // Log DHT health
      if (state.dht) {
        const stats = state.dht.getStats();
        console.log('[DHT Health]', {
          peers: stats.totalPeers,
          keys: stats.localKeys,
          refreshQueue: stats.refreshQueueSize,
          replication: stats.replicationHealth
        });
        
        // Force refresh if too many under-replicated keys
        if (stats.replicationHealth.underReplicated > stats.replicationHealth.wellReplicated) {
          console.warn('[DHT] Many under-replicated keys, forcing refresh');
          state.dht.refreshStoredValues();
        }
      }
    }
    
    
    if (tick % 3600 === 0) {
        stateManager.cleanup();
        tick = 0;
      // Clean up old messages
      stateManager.cleanupOldMessages().catch(e =>
        console.error('[Maintenance] Failed to cleanup old messages:', e)
      );
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
                    getServices().contentSimilarity.removePost(post); // + ADD THIS LINE

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
    // --- Step 1: Set up basic message handlers ---
    setServiceCallbacks({
      debugPostRemoval,
      dropPost,
      notify,
      renderPost,
      broadcastProfileUpdate,
      initializeUserProfileSection
    });
        registerHandler('scribe', handleScribeMessage);

    // Set up handlers but DON'T process network messages yet
    messageBus.registerHandler('scribe:new_post', (data) => {
      if (identityReady) {
        handleNewPost(data.message.post, null);
      }
    });
    messageBus.registerHandler('scribe:PROFILE_UPDATE', (data) => {
      if (identityReady) {
        handleProfileUpdate(data.message, null);
      }
    });
    messageBus.registerHandler('scribe:parent_update', (data) => {
      if (identityReady) {
        handleParentUpdate(data.message);
      }
    });
    messageBus.registerHandler('scribe:lp_interaction_proposal', (data) => {
      if (identityReady) handle_lp_interaction_proposal(data.message, null);
    });
    messageBus.registerHandler('scribe:lp_state_update', (data) => {
      if (identityReady) handle_lp_state_update(data.message, null);
    });

    registerHandler('new_post', handleNewPost);
    registerHandler('provisional_identity_claim', async (msg) => await handleProvisionalClaim(msg.claim));
    registerHandler('identity_confirmation_slip', async (msg) => await handleConfirmationSlip(msg.slip));
    registerHandler('post_attestation', handlePostAttestation);
    registerHandler('carrier_update', handleCarrierUpdate);
    registerHandler('parent_update', handleParentUpdate);
    registerHandler('posts_response', async (msg) => await handlePostsResponse(msg.posts));
    registerHandler('post_rating', handlePostRating);
    registerHandler('e2e_dm', handleDirectMessage);
    registerHandler('generate_attestation', generateAndBroadcastAttestation);
    registerHandler('dm_request', handleDMRequest);
    registerHandler('dm_approve', handleDMApprove);
    registerHandler('dm_revoke', handleDMRevoke);
    registerHandler('lp_interaction_proposal', handle_lp_interaction_proposal);
    registerHandler('lp_state_update', handle_lp_state_update);
    setSendPeer(sendPeer);
    messageBus.setSendPeer(sendPeer);
    
    // --- Step 2: Initialize WASM and Base Network ---
    await wasmVDF.initialize();
    
    // --- Step 3: Load and verify identity BEFORE network init ---
const stored = localStorage.getItem("ephemeral-id");
let storedIdentity = null;
let identityValid = false;

if (stored) {
  try {
    const parsed = JSON.parse(stored);
    storedIdentity = LocalIdentity.fromJSON(parsed);
    console.log("[Identity] Found stored identity, checking if encrypted...");
    
    // Check if identity is encrypted
    if (storedIdentity.isEncrypted()) {
      console.log("[Identity] Identity is encrypted, prompting for password...");
      
      try {
        // Unlock the identity with password
        storedIdentity = await unlockIdentity(storedIdentity);
        console.log("[Identity] Identity successfully unlocked");
      } catch (err) {
        console.error("[Identity] Failed to unlock identity:", err);
        
        // If user forgot password or cancelled, create new identity
        localStorage.removeItem("ephemeral-id");
        storedIdentity = null;
      }
    }
  } catch (e) { 
    console.error("Failed to parse stored identity:", e);
    localStorage.removeItem("ephemeral-id");
  }
}

    
    // Initialize network with temp node ID
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
    
    // --- NOW verify identity with DHT ready ---
    if (storedIdentity && storedIdentity.handle) {
      // Give DHT a moment to populate from peers
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      identityValid = await state.identityRegistry.verifyOwnIdentity(storedIdentity);
      
      if (identityValid) {
        state.myIdentity = storedIdentity;
        state.dht.nodeId = state.myIdentity.nodeId;
        console.log("[Identity] Verified stored identity, republishing...");
        
        // Re-publish identity
        const publicClaim = state.myIdentity.getPublicClaim();
        const handleAddress = `handle-to-pubkey:${state.myIdentity.handle.toLowerCase()}`;
        const pubkeyAddress = `pubkey:${arrayBufferToBase64(state.myIdentity.publicKey)}`;
        
        await Promise.all([
          state.dht.store(handleAddress, arrayBufferToBase64(state.myIdentity.publicKey)),
          state.dht.store(pubkeyAddress, publicClaim.toJSON())
        ]).catch(err => { 
          console.error("[Identity] Failed to re-publish identity:", err); 
        });
      } else {
        console.log("[Identity] Stored identity verification failed");
        notify("Stored identity is no longer valid. Please create a new one.");
        await createNewIdentity();
      }
    } else {
      console.log("[Identity] No stored identity found");
      await createNewIdentity();
    }
    
    // --- CRITICAL: Mark identity as ready and process queued messages ---
identityReady = true;
window.identityReady = true;  // Add this line
console.log("[Identity] Identity ready, processing queued messages...");
    
    // Process any messages that arrived while identity was loading
    while (earlyMessageQueue.length > 0) {
      const { msg, fromWire } = earlyMessageQueue.shift();
      console.log(`[Network] Processing queued ${msg.type} message`);
      await handlePeerMessage(msg, fromWire);
    }
    


    // --- Step 4: Initialize Core P2P Protocols (NOW SAFE TO DO) ---
    initializeP2PProtocols();
    
    // --- Step 5: Initialize High-Level Services (NOW SAFE TO DO) ---
    const services = initializeServices({
      renderPost: renderPost
    });
    ({
      stateManager,
      verificationQueue,
      imageStore,
      peerManager,
      memoryManager,
      progressiveVDF,
      noiseGenerator,
      trafficMixer,
    } = services);
    services.stateManager.renderPost = renderPost;
    await verificationQueue.init();


    // Initialize UI with identity
    initializeUserProfileSection();

    // --- Step 6: Load Saved State Using the New Services ---
    await stateManager.init();
    await stateManager.loadDHTState();
    await stateManager.loadUserState();
    await stateManager.loadDMPermissions();

    await stateManager.loadImageChunks();
    await stateManager.loadPosts();
    await stateManager.loadPeerScores();
    
    // --- Step 7: Finalize UI and start background tasks ---
    await initContentFilter();
    await initImageFilter();
    initializeLivingPostComposer();
    document.getElementById("loading").style.display = "none";
    startMaintenanceLoop();
    initTopics();
    updateDMInbox();
    updateUnreadBadge();
    setInterval(()=>{ 
      updateDMInbox(),
      updateUnreadBadge();
    }, 30000);
    
    window.addEventListener("beforeunload", () => {
      if (maintenanceInterval) clearInterval(maintenanceInterval);
      
      // Save identity to localStorage
      if (state.myIdentity) {
        const localIdentity = state.myIdentity instanceof LocalIdentity ?
          state.myIdentity : new LocalIdentity(state.myIdentity);
        localStorage.setItem("ephemeral-id", JSON.stringify(localIdentity.toJSON()));
      }
      
      stateManager.savePosts();
      stateManager.saveUserState();
      stateManager.savePeerScores();
      stateManager.saveDHTState();
      routingManager.stop();
      if (state.client) state.client.destroy();
      if (state.dht) state.dht.shutdown();
    });

    try {
      getServices().relayCoordinator.start();
    } catch(e) { 
      console.error("[Init] Failed to start Relay Coordinator:", e); 
    }

  // Start the activity profile service to begin finding similar users.
  getServices().activityProfile.start();


    if (!localStorage.getItem("ephemeral-tips")) {
      setTimeout(() => notify("💡 Tip: Posts live only while carried by peers"), 1000);
      setTimeout(() => notify("💡 Tip: Ctrl+Enter to post quickly"), 6000);
      localStorage.setItem("ephemeral-tips", "yes");
    }
    
} catch (e) {
  console.error("Init failed:", e);
  identityReady = true; // Set to true even on error to prevent message queue buildup
  window.identityReady = true;  
  document.getElementById("loading").innerHTML = `<div class="loading-content"><h2>Init Failed</h2><p>${e.message}</p><button onclick="location.reload()">Try Again</button></div>`;
}
}

function processLpTemplate(template) {
    // Convert <# ... #> into valid JS for string building
    let code = 'let html = "";\n';
    code += 'const lines = `' + template.replace(/`/g, '\\`') + '`.split("\\n");\n';
    code += 'for (const line of lines) {\n';
    code += '  let processedLine = line';

    // Replace ${...} with template literal syntax
    code += ".replace(/\\$\\{([^\\}]+)\\}/g, (match, expr) => `${eval(expr)}`);\n";
    
    // Handle <# ... #> for logic
    code += 'processedLine = processedLine.replace(/<#\\s*(.*?)\\s*#>/g, (match, logic) => eval(logic) || "");\n';

    code += '  html += processedLine + "\\n";\n';
    code += '}\n';
    code += 'return html;\n';
    return code;
}


async function handlePostRating(msg, fromWire) {
    const { postId, voter, vote, reputation, timestamp, signature, voterPublicKey } = msg;
    
    // Validate message
    if (!postId || !voter || !vote || !signature || !voterPublicKey) {
        console.warn('[Rating] Invalid rating message');
        return;
    }
    
    // Check if post exists
    const post = state.posts.get(postId);
    if (!post) return;
    
    // Verify signature
    try {
        const dataToVerify = JSON.stringify({
            postId,
            voter,
            vote,
            timestamp
        });
        
        const publicKey = base64ToArrayBuffer(voterPublicKey);
        const sig = base64ToArrayBuffer(signature);
        
        const verified = nacl.sign.open(sig, publicKey);
        if (!verified) {
            console.warn(`[Rating] Invalid signature from ${voter}`);
            return;
        }
        
        const decodedData = new TextDecoder().decode(verified);
        if (decodedData !== dataToVerify) {
            console.warn(`[Rating] Signature mismatch from ${voter}`);
            return;
        }
    } catch (e) {
        console.error('[Rating] Signature verification failed:', e);
        return;
    }
    
    // Check timestamp (prevent replay attacks)
    const age = Date.now() - timestamp;
    if (age > 300000) { // 5 minutes
        console.warn(`[Rating] Rating too old: ${age}ms`);
        return;
    }
    
    // Look up voter's actual reputation if we know them
    let actualReputation = reputation || 10;
    for (const [peerId, peerData] of state.peers) {
        if (peerData.handle === voter) {
            actualReputation = peerManager.getScore(peerId);
            break;
        }
    }
    
    // Apply rating
    const changed = post.addRating(voter, vote, actualReputation);
    if (changed) {
        refreshPost(post);
        console.log(`[Rating] Applied rating from ${voter} to post ${postId}`);
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
    state.scribe.startMaintenance();

  } catch (e) {
    console.error("Failed to initialize Scribe:", e);
  }

  
  console.log("P2P protocol (Scribe) initialized.");
  // Start routing manager
    routingManager.start();
    console.log("Routing manager initialized");
}

// helper function for init
async function initNetworkWithTempId(tempNodeId) {
  initNetwork(); // This will create state.client
  
  // Initialize DHT and identity registry immediately
  state.dht = new KademliaDHT(tempNodeId);
  state.identityRegistry = new IdentityRegistry(state.dht);
  
  // The rest of the protocols will initialize after the bootstrap connection
}

function sendToPeer(peer, message) {
    if (!peer || !peer.wire || peer.wire.destroyed) return false;
    
    try {
        sendPeer(peer.wire, message);
        return true;
    } catch (error) {
        console.error('Failed to send message to peer:', error);
        return false;
    }
}

async function findPeerByHandle(handle) {
  // First check our local peer identity map
  if (state.peerIdentities) {
    for (const [peerId, identity] of state.peerIdentities) {
      if (identity.handle === handle) {
        const peer = state.peers.get(peerId);
        if (peer && peer.wire && !peer.wire.destroyed) {
          console.log(`[FindPeer] Found ${handle} in local peer map`);
          return peer;
        }
      }
    }
  }
  
  // Check routing cache
  if (state.peerRoutingCache && state.peerRoutingCache.has(handle)) {
    const cached = state.peerRoutingCache.get(handle);
    
    // Check if routing info is fresh
    const age = Date.now() - cached.timestamp;
    if (age < 300000) { // 5 minutes
      // Try to find peer by the cached peer ID
      for (const [peerId, peer] of state.peers) {
        if (peerId === cached.peerId || peerId === cached.fromWire) {
          if (peer.wire && !peer.wire.destroyed) {
            console.log(`[FindPeer] Found ${handle} via routing cache`);
            return peer;
          }
        }
      }
    }
  }
  
  // If not found locally, check DHT routing info
  const routingInfo = await state.identityRegistry.lookupPeerLocation(handle);
  if (!routingInfo) {
    console.log(`[FindPeer] No routing info found for ${handle}`);
    return null;
  }
  
  // Find peer by wire peer ID
  for (const [peerId, peer] of state.peers) {
    if (peerId === routingInfo.wirePeerId) {
      if (peer.wire && !peer.wire.destroyed) {
        console.log(`[FindPeer] Found ${handle} via DHT routing`);
        return peer;
      }
    }
  }
  
  console.log(`[FindPeer] Routing info found but peer not connected`);
  return null;
}

function debugPostRemoval(postId, reason) {
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

    // Set stateManager's renderPost dependency
   // stateManager.renderPost = renderPost;
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
  window.switchDrawer = switchDrawer; // If this exists
  window.setRulePackPath = setRulePackPath;   // choose a new JSON file
  window.reloadRulePack  = reloadRulePack;    // refresh the current file
  window.ratePost = ratePost;
    window.sendDirectMessage = sendDirectMessage;
      window.isToxic = isToxic;
    window.isImageToxic = isImageToxic;  
        window.updateHotTopics = updateHotTopics;
    window.handleProfileUpdate = handleProfileUpdate;
    window.unsubscribeFromProfile =unsubscribeFromProfile;
window.interactWithLivingPost = interactWithLivingPost;

window.sendDMRequest = sendDMRequest;
window.approveDMRequest = approveDMRequest;
window.declineDMRequest = (handle) => {
  state.dmPermissions.set(handle, {
    status: 'blocked',
    timestamp: Date.now()
  });
  notify(`Declined DM request from ${handle}`);
  updateDMInbox();
};
window.unblockDMContact = (handle) => {
  state.dmPermissions.delete(handle);
  notify(`Unblocked ${handle}`);
  updateDMInbox();
};
window.revokeDMPermission = revokeDMPermission;




    window.subscribeToProfile = subscribeToProfile;
  window.state = state;
window.openProfileForHandle = openProfileForHandle;
window.broadcastProfileUpdate = broadcastProfileUpdate;
  // FIX: Expose profile functions to the global scope
  window.closeProfile = closeProfile;

  window.toggleDMMinimize = function() {
    const panel = document.getElementById('dm-panel');
    panel.classList.toggle('minimized');
    
    // If minimized, clicking header should restore
    if (panel.classList.contains('minimized')) {
      panel.querySelector('.dm-header').onclick = () => toggleDMMinimize();
    } else {
      panel.querySelector('.dm-header').onclick = null;
    }
  };

  window.autoResizeDMInput = function(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  };


  // Debugging interface
  window.ephemeralDebug = {
    posts: () => state.posts,
    peers: () => state.peers,
    id: () => state.myIdentity,
    stats: () => ({ posts: state.posts.size, peers: state.peers.size }),
    wasmVDF: wasmVDF,
    reputations: () => {
      console.table(peerManager.debugReputations());
      const stats = peerManager.getReputationStats();
      console.log('Reputation distribution:', stats);
      return stats;
    },
    routing: () => {
      console.log('=== Routing Status ===');
      console.log('Routing Manager:', routingManager.getStats());
      
      if (state.peerRoutingCache) {
        console.log('\nRouting Cache:');
        const now = Date.now();
        for (const [handle, info] of state.peerRoutingCache) {
          console.log(`  ${handle}: age=${Math.floor((now - info.timestamp)/1000)}s, peerId=${info.peerId.substring(0,8)}...`);
        }
      }
      
      console.log('\nPeer Identities:');
      if (state.peerIdentities) {
        for (const [peerId, identity] of state.peerIdentities) {
          console.log(`  ${peerId.substring(0,8)}... => ${identity.handle}`);
        }
      }
      
      return 'See console for routing details';
    },
    forceRoutingUpdate: () => {
      routingManager.updateRouting(true).then(() => 
        console.log('Routing update forced')
      );
    },
    dhtHealth: () => {
      if (!state.dht) {
        return 'DHT not initialized';
      }
      
      const stats = state.dht.getStats();
      console.log('=== DHT Health Report ===');
      console.log('Network:', {
        totalPeers: stats.totalPeers,
        activeBuckets: stats.activeBuckets,
        avgBucketSize: stats.avgBucketSize
      });
      console.log('Storage:', {
        localKeys: stats.localKeys,
        refreshQueue: stats.refreshQueueSize
      });
      console.log('Replication:', stats.replicationHealth);
      
      console.log('\nReplication Details (sample):');
      let count = 0;
      for (const [key, status] of state.dht.replicationStatus) {
        if (count++ >= 10) break;
        console.log(`  ${key}: ${status.replicas} replicas, last checked ${Math.floor((Date.now() - status.lastCheck) / 1000)}s ago`);
      }
      
      return 'See console for DHT health details';
    },
    forceRefresh: async (key) => {
      if (!state.dht) return 'DHT not initialized';
      
      if (key) {
        const value = state.dht.storage.get(key);
        if (value) {
          const result = await state.dht.store(key, value.value || value, { propagate: true });
          return `Refreshed ${key}: ${result.replicas} replicas`;
        }
        return `Key ${key} not found locally`;
      } else {
        await state.dht.refreshStoredValues();
        return 'Triggered refresh of all stored values';
      }
    },
    checkReplication: async (key) => {
      if (!state.dht) return 'DHT not initialized';
      const status = await state.dht.getReplicationStatus(key);
      return `Key ${key}: ${status.replicas} replicas found`;
    }
  };

  // Start the application initialization process once the page is loaded.
  window.addEventListener("load", init);
  
