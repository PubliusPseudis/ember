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
// Correctly import all necessary functions from ui.js
import {
    currentDMRecipient, addMessageToConversation, applyTheme, setupThemeToggle, 
    showConnectScreen, updateLoadingMessage, renderPost, refreshPost, dropPost, 
    updateStatus, notify, loadTopicSubscriptions, updateTopicFilter, addTopicToUI, 
    updateAges, updateTopicStats, handleImageSelect, removeImage, toggleReplyForm, 
    discoverAndFilterTopic, filterByTopic, setFeedMode, completeTopicSuggestion, 
    scrollToPost, subscribeToTopic, handleReplyImageSelect, removeReplyImage, 
    storeDMLocallyAndUpdateUI, updateDMInbox, updateUnreadBadge, toggleThread,
    openProfileForHandle, renderProfile, closeProfile, updateProfilePicturesInPosts, initializeUserProfileSection
} from './ui.js';
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
import { routingManager } from './services/routing-manager.js';

// --- 2. GLOBAL STATE ---
export const state = {
  posts: new Map(),
  peers: new Map(),
  peerIdentities: new Map(),
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
  viewingProfile: null, // Currently viewed profile handle
  profileCache: new Map(), // Cache for received profiles
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

export async function isToxic(text) {
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
            renderPost(post);
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
      verificationQueue.addBatch([post], 'normal', (results) => {
        handleVerificationResults(results);
      });
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
            btn.textContent = "🔥";
            return;
        }
        if (imageData && await isImageToxic(imageData)) {
            notify("Image content not allowed");
            btn.disabled = false;
            btn.textContent = "🔥";
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
        btn.textContent = "🔥";
        notify("Posted to the void");
    } catch (error) {
        console.error("VDF computation failed:", error);
        notify("Failed to compute proof of work", 5000);
        btn.disabled = false;
        btn.textContent = "🔥";
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

export async function ratePost(postId, vote) {
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
            state.myIdentity.secretKey
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

export async function sendDirectMessage(recipientHandle, messageText) {
  console.log(`[DM] Initializing DM to ${recipientHandle}...`);

  try {
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

export async function handleDirectMessage(msg, fromWire) {
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
export async function broadcastProfileUpdate(profileData = null) {
  if (!state.myIdentity || !state.scribe) return;
  
  const profile = profileData || state.myIdentity.profile;
  if (!profile) return;
  
  const topic = '@' + state.myIdentity.handle;
  console.log(`[Profile] Broadcasting profile update to topic: ${topic}`);
  
  // Sign the profile data
  const profileStr = JSON.stringify(profile);
  const signature = nacl.sign(
    new TextEncoder().encode(profileStr),
    state.myIdentity.secretKey
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

export async function subscribeToProfile(handle) {
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

export async function unsubscribeFromProfile(handle) {
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

export function handleProfileUpdate(msg, fromWire) {
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

export async function handleScribeMessage(msg, fromWire) {
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
export let maintenanceInterval;
export function startMaintenanceLoop() {
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
      stateManager.savePeerScores();
      stateManager.saveImageChunks(); // Periodically save image data
      stateManager.saveDHTState(); 
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
        
        // Initialize default profile if not present
        if (!identity.profile) {
          identity.profile = {
            handle: identity.handle,
            bio: '',
            profilePictureHash: null,
            theme: {
              backgroundColor: '#000000',
              fontColor: '#ffffff',
              accentColor: '#ff1493'
            },
            updatedAt: Date.now()
          };
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
    await stateManager.loadDHTState();
    
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
        
         // Re-publish identity records to the DHT to ensure discoverability ---
        console.log("[Identity] Re-publishing identity records for returning user...");
        const handleAddress = `handle-to-pubkey:${state.myIdentity.handle.toLowerCase()}`;
        const pubkeyAddress = `pubkey:${state.myIdentity.publicKey}`;

        // Use Promise.all to re-publish both records concurrently.
        Promise.all([
          state.dht.store(handleAddress, { publicKey: state.myIdentity.publicKey }),
          state.dht.store(pubkeyAddress, state.myIdentity.identityClaim)
        ]).then(() => {
            console.log("[Identity] Successfully re-published identity to the DHT.");
        }).catch(err => {
            console.error("[Identity] Failed to re-publish identity:", err);
        });       
          // Initialize profile section
        initializeUserProfileSection();
        notify(`Welcome back, ${storedIdentity.handle}!`);
        // Announce our routing info after a short delay
        setTimeout(async () => {
          if (state.client && state.identityRegistry) {
            // Get our current WebRTC peer ID from any active connection
            const activePeer = Array.from(state.peers.values())[0];
            if (activePeer && activePeer.wire) {
              const ourWirePeerId = activePeer.wire._client?.peerId;
              if (ourWirePeerId) {
                await state.identityRegistry.updatePeerLocation(
                  state.myIdentity.handle,
                  state.myIdentity.nodeId,
                  ourWirePeerId
                );
                console.log('[Init] Initial routing info announced');
              }
            }
          }
        }, 5000); // Wait 5 seconds for connections to establish
      } else if (state.peers.size === 0) {
        // If verification fails BUT we have no peers, we are the first node.
        // We should trust the local identity and assume it's valid.
        console.warn("Could not verify identity on DHT (no peers found), trusting local storage.");
        state.myIdentity = storedIdentity;
         initializeUserProfileSection();
        notify(`Welcome back, pioneer ${storedIdentity.handle}!`);
      } else {
        // Stored identity is invalid or taken because verification failed and there ARE peers.
        notify("Stored identity is no longer valid. Please create a new one.");
        await createNewIdentity();
        initializeUserProfileSection();
      }
    } else {
      // No stored identity
      await createNewIdentity();
      initializeUserProfileSection();
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
      stateManager.saveDHTState();
        routingManager.stop();
      if (state.client) state.client.destroy();
      if (state.dht) {
        state.dht.shutdown();
      }
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

export async function handlePostRating(msg, fromWire) {
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

export function initializeP2PProtocols() {
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
      } else if (message.type === 'PROFILE_UPDATE') {
        handleProfileUpdate(message, null);
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
  // Start routing manager
    routingManager.start();
    console.log("Routing manager initialized");
}

// helper function for init
export async function initNetworkWithTempId(tempNodeId) {
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

export async function findPeerByHandle(handle) {
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
if (typeof window !== 'undefined') {
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
  window.state = state;
window.openProfileForHandle = openProfileForHandle;

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
}
