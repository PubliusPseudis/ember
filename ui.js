// FILE: ui.js
// ui.js
// This module contains all functions and variables responsible for
// interacting with the DOM, rendering content, and handling UI events.

// --- IMPORTS ---
import { state, imageStore, toggleCarry, createReply, createPostWithTopics, findRootPost, isImageToxic, isToxic, sendDirectMessage, broadcastProfileUpdate, subscribeToProfile, unsubscribeFromProfile, handleProfileUpdate } from './main.js';
import { sanitize, sanitizeDM } from './utils.js';
import { CONFIG } from './config.js';
import { sendPeer } from './p2p/network-manager.js';
import DOMPurify from 'dompurify'; // <-- ADDED: Import DOMPurify for sanitization

// --- LOCAL HELPERS ---
// Small helper functions that are only used by the UI.
const isReply = (post) => post && post.parentId;

// --- UI STATE & OBSERVERS ---
// Top-level constants and variables that manage UI state.
let bonfireUpdateTimeout;
let showAllShards = true;

export let currentDMRecipient = null;

const animationObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('animate');
    } else {
      entry.target.classList.remove('animate');
    }
  });
}, { threshold: 0.1 });


// --- CORE RENDERING & POST INTERACTION ---
// These functions are responsible for displaying and interacting with posts and threads.
export function updateConnectionStatus(message, type = 'info') {
  console.log(`[Status] ${message}`);

  const loadingEl = document.getElementById("loading");
  if (!loadingEl || loadingEl.style.display === "none") return;

  const statusDiv = loadingEl.querySelector('div:last-child') ||
                   loadingEl.querySelector('.loading-content').lastElementChild;

  if (statusDiv) {
    const color = type === 'error' ? '#ff4444' :
                  type === 'success' ? '#44ff44' :
                  '#ff8c42';

    statusDiv.innerHTML = `<div style="font-size:12px;margin-top:10px;color:${color}">${message}</div>`;

    // For success messages, add a nice animation
    if (type === 'success') {
      statusDiv.style.animation = 'pulse 1s ease-in-out';
    }
  }
}
function notify(msg, dur = 3000, onClick = null) {
  const n = document.createElement("div");
  n.className = "notification";
  n.textContent = msg;
   if (onClick) n.addEventListener('click', () => { onClick(); n.remove(); });
  document.body.appendChild(n);
  setTimeout(() => {
    n.style.animationDirection = "reverse";
    setTimeout(() => n.remove(), 300);
  }, dur);
}

export function initializeUserProfileSection() {
  console.log('[Debug] initializeUserProfileSection from ui.js has been called.'); 

  if (!state.myIdentity) {
    console.log('[Debug] Exiting: state.myIdentity is not set.'); 
    return;
  }
  
  const section = document.getElementById('user-profile-section');
  const handleEl = document.getElementById('user-profile-handle');
  const picContainer = document.getElementById('user-profile-pic');
  
  if (section && handleEl) {
    console.log('[Debug] Success: Found elements, setting display to block.'); 
    section.style.display = 'block';
    handleEl.textContent = state.myIdentity.handle;
    
    // Update profile picture if available
    if (state.myIdentity.profile && state.myIdentity.profile.profilePictureHash) {
      imageStore.retrieveImage(state.myIdentity.profile.profilePictureHash).then(imageData => {
        if (imageData) {
          picContainer.innerHTML = `<img src="${imageData}" alt="Your profile" />`;
        }
      });
    }
  } else {
    // ADD THIS ELSE BLOCK TO SEE IF ELEMENTS ARE MISSING
    console.error('[Debug] Failed: Could not find #user-profile-section or #user-profile-handle in the DOM.');
  }
}

async function renderPost(p, container = null) {
  if (document.getElementById("post-" + p.id)) return;

  const el = document.createElement("div");
  el.className = p.parentId ? `post reply depth-${Math.min(p.depth, 5)}` : "post";
  el.id = "post-" + p.id;
  animationObserver.observe(el);

  await updateInner(el, p); // Now async

  // Determine where to insert the post
  if (container) {
    container.appendChild(el);
  } else if (p.parentId) {
    // Find parent element and add to its replies container
    const parentEl = document.getElementById("post-" + p.parentId);
    if (parentEl) {
      let repliesContainer = parentEl.querySelector('.replies-container');
      if (!repliesContainer) {
        repliesContainer = document.createElement('div');
        repliesContainer.className = 'replies-container';
        parentEl.appendChild(repliesContainer);
      }
      repliesContainer.appendChild(el);
    } else {
      // Parent not found, add to main feed
      document.getElementById("posts").prepend(el);
    }
  } else {
    // Top-level post
    document.getElementById("posts").prepend(el);
  }

  state.viewing.add(p.id);
  updateStatus();
}

// Function to update profile pictures when they arrive
export function updateProfilePicturesInPosts() {
  // Check all placeholder profile pics periodically
  const placeholders = document.querySelectorAll('.author-profile-placeholder[data-hash]');
  
  placeholders.forEach(async (placeholder) => {
    const hash = placeholder.dataset.hash;
    const imageData = await imageStore.retrieveImage(hash);
    
    if (imageData) {
      const img = document.createElement('img');
      img.src = imageData;
      img.className = 'author-profile-pic';
      img.alt = "Profile picture";
      placeholder.replaceWith(img);
    }
  });
}

function getHeatLevel(carrierCount) {
  if (carrierCount >= 20) return "🔥 Inferno";
  if (carrierCount >= 15) return "🔥 Blazing";
  if (carrierCount >= 10) return "🔥 Burning";
  if (carrierCount >= 5) return "🌟 Glowing";
  if (carrierCount >= 2) return "✨ Flickering";
  return "💨 Dying ember";
}

async function updateInner(el, p) {
  if (!p) return;

  // Initialize properties if missing
  if (!p.carriers) p.carriers = new Set();
  if (!p.replies) p.replies = new Set();

  const existingHTML = el.innerHTML;
  const mine = p.carriers.has(state.myIdentity?.handle);
  const isAuthor = p.author === state.myIdentity?.handle;
  const carrierCount = p.carriers.size;

  const heatLevel = getHeatLevel(carrierCount);
  const heatOpacity = Math.min(0.1 + (carrierCount / 20), 1);

  const threadSize = getThreadSize(p.id);
  const hasReplies = p.replies.size > 0;
  // verification indicator
  let verificationBadge = '';
  
  //  profile picture logic
  let authorProfilePic = '';
  const cachedProfile = state.profileCache.get(p.author);
  
  if (cachedProfile && cachedProfile.profilePictureHash) {
    const imageData = await imageStore.retrieveImage(cachedProfile.profilePictureHash);
    if (imageData) {
      authorProfilePic = `<img src="${imageData}" class="author-profile-pic" alt="${p.author}'s profile" />`;
    } else {
      // Request the image if not found
      const peers = Array.from(state.peers.values()).slice(0, 3);
      for (const peer of peers) {
        if (peer.wire && !peer.wire.destroyed) {
          sendPeer(peer.wire, { type: "request_image", imageHash: cachedProfile.profilePictureHash });
        }
      }
      authorProfilePic = `<div class="author-profile-pic author-profile-placeholder" data-hash="${cachedProfile.profilePictureHash}">👤</div>`;
    }
  } else {
    // No profile cached, show placeholder
    authorProfilePic = '<div class="author-profile-pic author-profile-placeholder">👤</div>';
  }
  
  
  if (p.verified) {
    const identityVerified = state.identityRegistry?.verifiedIdentities.has(p.author);
    if (identityVerified) {
      verificationBadge = '<span class="verified-badge" title="Cryptographically verified + Identity confirmed">✓🔒</span>';
    } else {
      verificationBadge = '<span class="verified-badge" title="Cryptographically verified">✓</span>';
    }
  } else {
    verificationBadge = '<span class="unverified-badge" title="Verification pending">⏳</span>';
  }

    let imageHtml = '';
    if (p.imageHash) {
        if (p.imageData) {
            // We already have the image data, show it
            imageHtml = `<img src="${p.imageData}" class="post-image" alt="Posted image" />`;
        } else if (!p._imageLoading) {
            // We don't have the image yet, try to retrieve it
            p._imageLoading = true;
            const currentElId = el.id;

            imageStore.retrieveImage(p.imageHash).then(imageData => {
                p._imageLoading = false;
                const stillExists = document.getElementById(currentElId);
                if (stillExists && imageData) {
                    p.imageData = imageData; // Cache the image data
                    const imgPlaceholder = stillExists.querySelector('.image-placeholder');
                    if (imgPlaceholder) {
                        imgPlaceholder.outerHTML = `<img src="${imageData}" class="post-image" alt="Posted image" />`;
                    }
                }
            }).catch(err => {
                p._imageLoading = false;
                console.error('Failed to load image:', err);
            });

            // Show placeholder while loading
            imageHtml = `<div class="image-placeholder" style="width:100%;height:150px;background:#333;display:flex;align-items:center;justify-content:center;color:#fff;">Loading Image...</div>`;
        } else {
            // Loading in progress, show placeholder
            imageHtml = `<div class="image-placeholder" style="width:100%;height:150px;background:#333;display:flex;align-items:center;justify-content:center;color:#fff;">Loading Image...</div>`;
        }
    }

    // Gets the community rating of the post
    const ratingSummary = p.getRatingSummary();
    const userVote = p.ratings.get(state.myIdentity?.handle)?.vote;
    
    // Display score as percentage with emoji indicator
    let scoreDisplay = 'Unrated';
    let scoreEmoji = '';
    if (ratingSummary.total > 0) {
        const percentage = Math.round(ratingSummary.score * 100);
        scoreDisplay = `${percentage}%`;
        
        // Add emoji based on score
        if (percentage >= 80) scoreEmoji = '🔥';
        else if (percentage >= 60) scoreEmoji = '✨';
        else if (percentage >= 40) scoreEmoji = '💨';
        else scoreEmoji = '❄️';
    }
    
    // Confidence visualization 
    const confidenceLevel = Math.round(ratingSummary.confidence * 5);
    const confidenceDisplay = '●'.repeat(confidenceLevel) + '○'.repeat(5 - confidenceLevel);



  // This logic adds the topic tags to the post's HTML
  let topicsHtml = '';
  if (state.scribe) {
    const topics = state.scribe.extractTopics(p.content);
    if (topics.length > 0) {
      topicsHtml = `
          <div class="post-topics">
              ${topics.map(topic => `<span class="post-topic-tag" data-topic="${sanitize(topic)}">${sanitize(topic)}</span>`).join('')}
          </div>`;
    }
  }

  // Preserve existing replies container
  const existingRepliesContainer = el.querySelector('.replies-container');

el.innerHTML = `
    <div class="author-section">
      ${authorProfilePic}
      <div class="author clickable-author" data-handle="${p.author}">${p.author} ${verificationBadge}</div>
    </div>
    <div class="content">${DOMPurify.sanitize(p.content)}</div> <!-- FIXED: Sanitize post content -->
    ${imageHtml}
    ${topicsHtml}
    <div class="post-footer">
        <div class="carriers">
            <span class="heat-level">${heatLevel}</span>
            <span class="carrier-count">${carrierCount}</span>&nbsp;${carrierCount === 1 ? 'breath' : 'breaths'}
            ${hasReplies ? `<span class="thread-stats"><span class="thread-ember">🔥</span> ${threadSize} in thread</span>` : ''}
        </div>
        <div class="rating-display">
            <span class="rating-score" title="Community rating: ${ratingSummary.weightedTotal.toFixed(1)} weighted votes">
                ${scoreEmoji} ${scoreDisplay}
            </span>
            <span class="rating-confidence" title="Confidence: ${(ratingSummary.confidence * 100).toFixed(0)}%">
                ${confidenceDisplay}
            </span>
        </div>
        <div class="rating-buttons">
            <button class="rate-up ${userVote === 'up' ? 'active' : ''}" 
                    onclick="ratePost('${p.id}', 'up')" 
                    title="Good post"
                    ${userVote === 'up' ? 'disabled' : ''}>
                👍 <span class="vote-count">${ratingSummary.upvotes}</span>
            </button>
            <button class="rate-down ${userVote === 'down' ? 'active' : ''}" 
                    onclick="ratePost('${p.id}', 'down')" 
                    title="Poor post"
                    ${userVote === 'down' ? 'disabled' : ''}>
                👎 <span class="vote-count">${ratingSummary.downvotes}</span>
            </button>
        </div>
        <div class="post-actions">
            <button class="carry-button ${mine ? 'withdrawing' : 'blowing'}" onclick="toggleCarry('${p.id}')">
                ${isAuthor ? "🌬️" : (mine ? "💨" : "🔥")}
            </button>
            <button class="reply-button" onclick="toggleReplyForm('${p.id}')">💬</button>
            ${!isAuthor ? `<button class="dm-button" onclick="openDMPanel('${p.author}')">📨</button>` : ''}
            ${hasReplies ? `<span class="collapse-thread" onclick="toggleThread('${p.id}')">[${el.classList.contains('collapsed') ? '+' : '-'}]</span>` : ''}
        </div>
    </div>
    <div id="reply-form-${p.id}" class="reply-compose" style="display: none;">
        <textarea id="reply-input-${p.id}" class="reply-input" placeholder="Add to the conversation..." maxlength="1125"></textarea>
        <div class="reply-image-preview" id="reply-image-preview-${p.id}" style="display:none;">
            <img id="reply-preview-img-${p.id}" />
            <button onclick="removeReplyImage('${p.id}')">✕</button>
        </div>
        <div class="compose-footer">
            <input type="file" id="reply-image-input-${p.id}" accept="image/*" style="display:none;" onchange="handleReplyImageSelect(this, '${p.id}')" />
            <button onclick="document.getElementById('reply-image-input-${p.id}').click()" class="image-button">📷</button>
            <span class="char-count"><span id="reply-char-${p.id}">0</span>/${CONFIG.MAX_POST_SIZE}</span>
            <button onclick="createReply('${p.id}')" class="primary-button">🔥</button>
        </div>
    </div>`;


  // Add safe event listeners to the new topic tags
  const topicTags = el.querySelectorAll('.post-topic-tag');
  topicTags.forEach(tag => {
    tag.addEventListener('click', (event) => {
      event.stopPropagation(); // Prevent post click events
      const topic = event.target.dataset.topic;
      if (topic) {
        discoverAndFilterTopic(topic);
      }
    });
  });
  
  // Add click handler for author
    const authorSection = el.querySelector('.author-section');
    if (authorSection) {
      authorSection.addEventListener('click', (event) => {
        event.stopPropagation();
        const handle = el.querySelector('.clickable-author').dataset.handle;
        if (handle) {
          openProfileForHandle(handle);
        }
      });
    }

  // *** FIX: Re-attach the existing replies container if it existed ***
  if (existingRepliesContainer) {
    el.appendChild(existingRepliesContainer);
  }

  el.style.setProperty('--heat-opacity', heatOpacity);
  el.classList.toggle('inferno', carrierCount >= 20);
  el.classList.toggle('hot', carrierCount >= 10);
  el.classList.toggle('warm', carrierCount >= 5);
  el.classList.toggle('dying', carrierCount === 0);

  if (p.parentId && p.depth > 0) {
    const threadLine = document.createElement('div');
    threadLine.className = 'thread-line';
    el.appendChild(threadLine);
  }
}

async function refreshPost(p) {
    const el = document.getElementById("post-" + p.id);
    if (el) await updateInner(el, p);
}

function dropPost(id) {
    const el = document.getElementById("post-" + id);
    if (el) {
        if (window.animationObserver) {
            animationObserver.unobserve(el);
        }
        const replies = el.querySelectorAll('.post.reply');
        replies.forEach(reply => {
            if (window.animationObserver) {
                animationObserver.unobserve(reply);
            }
        });
        el.classList.add("dying");
        setTimeout(() => el.remove(), 1000);
    }
    state.viewing.delete(id);
    updateStatus();
}

function getThreadSize(postId) {
  let count = 0;
  const post = state.posts.get(postId);
  if (!post) return 0;

  const visited = new Set();
  const queue = [postId];

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const p = state.posts.get(id);
    if (p) {
      count++;
      p.replies.forEach(replyId => queue.push(replyId));
    }
  }

  return count - 1; // Exclude the parent post itself
}

function toggleReplyForm(postId) {
    const form = document.getElementById(`reply-form-${postId}`);
    if (form) {
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
        if (form.style.display === 'block') {
            const input = document.getElementById(`reply-input-${postId}`);
            input.focus();
            input.addEventListener('input', (e) => {
                document.getElementById(`reply-char-${postId}`).textContent = e.target.value.length;
            });
        }
    }
}

function toggleThread(postId) {
    const post = state.posts.get(postId);
    if (!post || post.replies.size === 0) return;

    const postEl = document.getElementById(`post-${postId}`);
    if (!postEl) return;

    const repliesContainer = postEl.querySelector('.replies-container');
    const collapseButton = postEl.querySelector('.collapse-thread');

    if (repliesContainer && collapseButton) {
        const isCollapsed = repliesContainer.style.display === 'none';
        if (isCollapsed) {
            repliesContainer.style.display = 'block';
            postEl.classList.remove('collapsed');
            collapseButton.textContent = '[-]';
        } else {
            repliesContainer.style.display = 'none';
            postEl.classList.add('collapsed');
            collapseButton.textContent = '[+]';
        }
    }
}

function updateBonfire() {
    const bonfireContentEl = document.getElementById('bonfire-content');
    if (!bonfireContentEl) return;

    const threads = new Map();

    for (const [id, post] of state.posts) {
        const rootId = findRootPost(id);
        if (!threads.has(rootId)) {
            threads.set(rootId, {
                root: state.posts.get(rootId),
                heat: 0,
                replyCount: 0,
                totalCarriers: new Set()
            });
        }

        const thread = threads.get(rootId);
        thread.replyCount++;
        post.carriers.forEach(c => thread.totalCarriers.add(c));
        thread.heat = thread.totalCarriers.size + thread.replyCount * 2;
    }

    const hottest = Array.from(threads.values())
        .filter(t => t.heat >= 10)
        .sort((a, b) => b.heat - a.heat)
        .slice(0, 10);

    if (hottest.length > 0) {
        const bonfireHtml = hottest.map(thread => `
      <div class="bonfire-item" onclick="scrollToPost('${thread.root.id}')">
        <span class="bonfire-heat">${thread.heat} 🔥</span>
        <span class="thread-stats">${thread.replyCount} replies</span>
        <span class="bonfire-preview">${(thread.root.content.substring(0, 60))}...</span>
      </div>
    `).join('');
        bonfireContentEl.innerHTML = `<div class="bonfire-posts">${bonfireHtml}</div>`;
    } else {
        bonfireContentEl.innerHTML = '<div class="empty-state">No hot threads right now. Start a conversation!</div>';
    }
}

function scrollToPost(postId) {
    const el = document.getElementById(`post-${postId}`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.animation = 'pulse-border 2s ease-in-out';
        setTimeout(() => {
            el.style.animation = '';
        }, 2000);
    }
}

// --- PROFILE FUNCTIONS ---
async function openProfileForHandle(handle) {
  if (!handle) return;
  
  const modal = document.getElementById('profile-modal-overlay');
  modal.style.display = 'flex';
  
  const profileContent = document.getElementById('profile-content');
  profileContent.innerHTML = '<div class="spinner"></div><div>Loading profile...</div>';
  
  state.viewingProfile = handle;
  
  // If viewing our own profile, render immediately from local state.
  if (handle === state.myIdentity.handle) {
    renderProfile(state.myIdentity.profile);
    // We don't need to subscribe to our own profile updates via the network in this case.
    return;
  }
  
  // Step 1: Try DHT first for fast initial load
  const dhtKey = `profile:${handle}`;
  console.log(`[Profile] Attempting to get profile from DHT with key: ${dhtKey}`);
  
  try {
    // Step 2: DHT Get
    const dhtProfile = await state.dht.get(dhtKey);
    
    // Step 3: Conditional Render
    if (dhtProfile) {
      console.log(`[Profile] Found profile in DHT for ${handle}`);
      // The DHT stores the complete message object with signature
      handleProfileUpdate(dhtProfile, null);
      // Profile will be rendered by handleProfileUpdate if signature is valid
    } else {
      console.log(`[Profile] No profile found in DHT for ${handle}, waiting for Scribe`);
      // Profile not in DHT, continue showing loading state
      // Check local cache as fallback
      const cached = state.profileCache.get(handle);
      if (cached) {
        renderProfile(cached);
      }
    }
  } catch (error) {
    console.error(`[Profile] DHT lookup failed for ${handle}:`, error);
    // Continue with Scribe subscription even if DHT fails
  }
  
  // Step 4: Always subscribe to Scribe for live updates
  await subscribeToProfile(handle);
}

function closeProfile() {
  const modal = document.getElementById('profile-modal-overlay');
  modal.style.display = 'none';
  
  if (state.viewingProfile && state.viewingProfile !== state.myIdentity.handle) {
    unsubscribeFromProfile(state.viewingProfile);
  }
  state.viewingProfile = null;
}

async function renderProfile(profileData) {
  const content = document.getElementById('profile-content');
  const isOwnProfile = profileData.handle === state.myIdentity.handle;
  
  // Apply theme if set
  const modal = document.getElementById('profile-modal');
  if (profileData.theme && modal) {
    modal.style.setProperty('--profile-bg', profileData.theme.backgroundColor);
    modal.style.setProperty('--profile-text', profileData.theme.fontColor);
    modal.style.setProperty('--profile-accent', profileData.theme.accentColor);
  }
  
  let profilePicHtml = '<div class="profile-picture-placeholder">👤</div>';
  if (profileData.profilePictureHash) {
    const imageData = await imageStore.retrieveImage(profileData.profilePictureHash);
    if (imageData) {
      profilePicHtml = `<img src="${imageData}" class="profile-picture" alt="${profileData.handle}'s profile picture" />`;
    } else {
      // ADDED: Request image from peers if not found locally
      console.log(`[Profile] Profile picture not found locally, requesting from peers: ${profileData.profilePictureHash}`);
      const peers = Array.from(state.peers.values()).slice(0, 3);
      for (const peer of peers) {
        if (peer.wire && !peer.wire.destroyed) {
          sendPeer(peer.wire, { type: "request_image", imageHash: profileData.profilePictureHash });
        }
      }
      
      // Set up a placeholder that can be updated when image arrives
      profilePicHtml = `<div id="profile-pic-${profileData.profilePictureHash}" class="profile-picture-placeholder">
        <div class="spinner" style="width: 20px; height: 20px;"></div>
      </div>`;
      
      // Set up a listener for when the image arrives
      const checkInterval = setInterval(async () => {
        const imageData = await imageStore.retrieveImage(profileData.profilePictureHash);
        if (imageData) {
          clearInterval(checkInterval);
          const placeholder = document.getElementById(`profile-pic-${profileData.profilePictureHash}`);
          if (placeholder && state.viewingProfile === profileData.handle) {
            placeholder.outerHTML = `<img src="${imageData}" class="profile-picture" alt="${profileData.handle}'s profile picture" />`;
          }
        }
      }, 1000);
      
      // Clear interval after 30 seconds to prevent memory leak
      setTimeout(() => clearInterval(checkInterval), 30000);
    }
  }
  
  const userPosts = Array.from(state.posts.values())
    .filter(post => post.author === profileData.handle)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20);
  
  const postsHtml = userPosts.length > 0 ? 
    userPosts.map(post => `
      <div class="profile-post-item" onclick="scrollToPost('${post.id}'); closeProfile();">
        <div class="profile-post-content">${sanitize(post.content.substring(0, 100))}${post.content.length > 100 ? '...' : ''}</div>
        <div class="profile-post-meta">
          <span>${new Date(post.timestamp).toLocaleDateString()}</span>
          <span>${post.carriers.size} 🔥</span>
        </div>
      </div>
    `).join('') : 
    '<div class="empty-state">No posts yet</div>';
  
  content.innerHTML = `
    <div class="profile-header">
      <div class="profile-picture-container">
        ${profilePicHtml}
      </div>
      <div class="profile-info">
        <h2 class="profile-handle">${profileData.handle}</h2>
        <div class="profile-bio">${DOMPurify.sanitize(profileData.bio || 'No bio yet')}</div> <!-- FIXED: Sanitize profile bio -->
        ${isOwnProfile ? '<button class="edit-profile-button" onclick="openProfileEditor()">Edit Profile</button>' : ''}
      </div>
    </div>
    <div class="profile-posts">
      <h3>Recent Posts</h3>
      <div class="profile-posts-list">
        ${postsHtml}
      </div>
    </div>
  `;
}

window.openProfileEditor = async function() {
  const profile = state.myIdentity.profile || {
    handle: state.myIdentity.handle,
    bio: '',
    profilePictureHash: null,
    theme: {
      backgroundColor: '#000000',
      fontColor: '#ffffff',
      accentColor: '#ff1493'
    },
    updatedAt: Date.now()
  };
  
  const content = document.getElementById('profile-content');
  
  let currentPicHtml = '<div class="profile-picture-placeholder">👤</div>';
  if (profile.profilePictureHash) {
    const imageData = await imageStore.retrieveImage(profile.profilePictureHash);
    if (imageData) {
      currentPicHtml = `<img src="${imageData}" class="profile-picture" alt="Current profile picture" />`;
    }
  }
  
  content.innerHTML = `
    <div class="profile-editor">
      <h2>Edit Profile</h2>
      
      <div class="profile-editor-section">
        <label>Profile Picture</label>
        <div class="profile-picture-editor">
          <div class="current-picture">
            ${currentPicHtml}
          </div>
          <input type="file" id="profile-picture-input" accept="image/*" style="display:none;" />
          <button onclick="document.getElementById('profile-picture-input').click()">Change Picture</button>
        </div>
        <div id="profile-picture-preview" style="display:none;">
          <img id="profile-preview-img" />
          <button onclick="clearProfilePicture()">Remove</button>
        </div>
      </div>
      
      <div class="profile-editor-section">
        <label for="profile-bio">Bio (2500 chars max)</label>
        <textarea id="profile-bio" maxlength="2500" placeholder="Tell us about yourself...">${profile.bio || ''}</textarea>
        <span class="char-count"><span id="bio-char-count">${(profile.bio || '').length}</span>/2500</span>
      </div>
      
      <div class="profile-editor-section">
        <label>Theme Colors</label>
        <div class="color-inputs">
          <div class="color-input-group">
            <label for="bg-color">Background</label>
            <input type="color" id="bg-color" value="${profile.theme.backgroundColor}" />
          </div>
          <div class="color-input-group">
            <label for="text-color">Text</label>
            <input type="color" id="text-color" value="${profile.theme.fontColor}" />
          </div>
          <div class="color-input-group">
            <label for="accent-color">Accent</label>
            <input type="color" id="accent-color" value="${profile.theme.accentColor}" />
          </div>
        </div>
      </div>
      
      <div class="profile-editor-actions">
        <button onclick="saveProfile()" class="primary-button">Save Profile</button>
        <button onclick="cancelProfileEdit()">Cancel</button>
      </div>
    </div>
  `;
  
  document.getElementById('profile-bio').addEventListener('input', (e) => {
    document.getElementById('bio-char-count').textContent = e.target.value.length;
  });
  
  document.getElementById('profile-picture-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const base64 = await handleImageUpload(file);
      const toxic = await isImageToxic(base64);
      if (toxic) {
        notify(`Image appears to contain ${toxic.toLowerCase()} content`);
        e.target.value = '';
        return;
      }
      
      document.getElementById('profile-preview-img').src = base64;
      document.getElementById('profile-picture-preview').style.display = 'block';
      document.getElementById('profile-picture-preview').dataset.imageData = base64;
    } catch (error) {
      notify(error.message);
    }
  });
};

window.clearProfilePicture = function() {
  document.getElementById('profile-picture-preview').style.display = 'none';
  document.getElementById('profile-picture-preview').dataset.imageData = '';
  document.getElementById('profile-picture-input').value = '';
};

window.saveProfile = async function() {
  const bio = document.getElementById('profile-bio').value.trim();
  const bgColor = document.getElementById('bg-color').value;
  const textColor = document.getElementById('text-color').value;
  const accentColor = document.getElementById('accent-color').value;
  
  if (bio && await isToxic(bio)) {
    notify('Your bio may contain inappropriate content. Please revise.');
    return;
  }
  
  let profilePictureHash = state.myIdentity.profile?.profilePictureHash || null;
  const previewDiv = document.getElementById('profile-picture-preview');
  if (previewDiv.style.display !== 'none' && previewDiv.dataset.imageData) {
    const result = await imageStore.storeImage(previewDiv.dataset.imageData);
    profilePictureHash = result.hash;
  }
  
  const updatedProfile = {
    handle: state.myIdentity.handle,
    bio: bio,
    profilePictureHash: profilePictureHash,
    theme: {
      backgroundColor: bgColor,
      fontColor: textColor,
      accentColor: accentColor
    },
    updatedAt: Date.now()
  };
  
  state.myIdentity.profile = updatedProfile;
  
  // This function is in main.js, but we call it from the window scope
  await broadcastProfileUpdate(updatedProfile);
  
  renderProfile(updatedProfile);

  // Update the profile section in control panel
  const picContainer = document.getElementById('user-profile-pic');
  if (picContainer && profilePictureHash) {
    const imageData = await imageStore.retrieveImage(profilePictureHash);
    if (imageData) {
      picContainer.innerHTML = `<img src="${imageData}" alt="Your profile" />`;
    }
  }

  notify('Profile updated successfully!');
};

window.cancelProfileEdit = function() {
  renderProfile(state.myIdentity.profile);
};

// --- TOPIC AND FEED MANAGEMENT ---

async function subscribeToTopic() {
  const input = document.getElementById('topic-input');
  let topic = input.value.trim().toLowerCase();

  if (!topic) return;

  if (!topic.startsWith('#')) {
    topic = '#' + topic;
  }

  if (!/^#\w+$/.test(topic)) {
    notify('Invalid topic format. Use #alphanumeric');
    return;
  }

  if (state.subscribedTopics.has(topic)) {
    notify('Already subscribed to ' + topic);
    return;
  }

  state.subscribedTopics.add(topic);
  addTopicToUI(topic);
  updateTopicFilter();
  saveTopicSubscriptions();
  input.value = '';
  notify(`Subscribed to ${topic}`);

  if (state.scribe) {
    await state.scribe.subscribe(topic);
  } else {
    console.warn("Scribe not ready, but UI has been updated. Network will join topic upon initialization.");
  }
}

function addTopicToUI(topic) {
    const container = document.getElementById('subscribed-topics');
    const existing = container.querySelector(`[data-topic="${topic}"]`);
    if (existing) return;

    const tag = document.createElement('div');
    tag.className = 'topic-tag active';
    tag.dataset.topic = topic;
    tag.textContent = topic;
    tag.onclick = () => toggleTopic(topic);

    container.appendChild(tag);
}

async function toggleTopic(topic) {
    const tag = document.querySelector(`[data-topic="${topic}"]`);

    // PHASE 2: Allow unsubscribing from #general to enable true feed curation.
    if (state.subscribedTopics.has(topic)) {
        if (state.scribe) {
            state.scribe.unsubscribe(topic);
        }
        state.subscribedTopics.delete(topic);
        tag.classList.remove('active');
        notify(`Unsubscribed from ${topic}`);
    } else {
        if (state.scribe) {
            await state.scribe.subscribe(topic);
        }
        state.subscribedTopics.add(topic);
        tag.classList.add('active');
        notify(`Resubscribed to ${topic}`);
    }

    updateTopicFilter();
    saveTopicSubscriptions();
    applyTopicFilter();
}

function updateTopicFilter() {
    const select = document.getElementById('topic-filter');
    const currentValue = select.value;

    select.innerHTML = '<option value="">All Topics</option>';

    state.subscribedTopics.forEach(topic => {
        const option = document.createElement('option');
        option.value = topic;
        option.textContent = topic;
        select.appendChild(option);
    });

    if (currentValue && state.subscribedTopics.has(currentValue)) {
        select.value = currentValue;
    }
}

function filterByTopic() {
    const select = document.getElementById('topic-filter');
    state.topicFilter = select.value;
    applyTopicFilter();
}

function setFeedMode(mode) {
    state.feedMode = mode;
    document.querySelectorAll('.mode-button').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    applyTopicFilter();
}

function applyTopicFilter() {
    const posts = document.querySelectorAll('.post');
    let visibleCount = 0;

    const currentFeedMode = state.feedMode;
    const topicDropdownFilter = state.topicFilter;

    posts.forEach(postEl => {
        const postId = postEl.id.replace('post-', '');
        const post = state.posts.get(postId);
        if (!post) return;

        const postTopics = state.scribe ? state.scribe.extractTopics(post.content) : [];
        let isVisible = false;

        if (currentFeedMode === 'all') {
            isVisible = true;
        } else {
            isVisible = postTopics.some(topic => state.subscribedTopics.has(topic));
        }

        if (isVisible && topicDropdownFilter) {
            isVisible = postTopics.includes(topicDropdownFilter);
        }

        postEl.style.display = isVisible ? 'block' : 'none';
        if (isVisible) {
            visibleCount++;
        }
    });

    let emptyMessage = document.getElementById('filter-empty-message');
    if (visibleCount === 0 && (currentFeedMode === 'topics' || topicDropdownFilter)) {
        if (!emptyMessage) {
            emptyMessage = document.createElement('div');
            emptyMessage.id = 'filter-empty-message';
            emptyMessage.className = 'empty-state';
            document.getElementById('posts').appendChild(emptyMessage);
        }
        emptyMessage.textContent = topicDropdownFilter ?
            `No posts in ${topicDropdownFilter}` :
            'No posts in your subscribed topics';
    } else if (emptyMessage) {
        emptyMessage.remove();
    }
}

function discoverAndFilterTopic(topic) {
  if (!state.subscribedTopics.has(topic)) {
    state.subscribedTopics.add(topic);
    if (state.scribe) {
      state.scribe.subscribe(topic);
    }
    addTopicToUI(topic);
    updateTopicFilter();
    saveTopicSubscriptions();
    notify(`Subscribed to ${topic}`);
  }
  filterToTopic(topic);
}

function filterToTopic(topic) {
  document.getElementById('topic-filter').value = topic;
  state.topicFilter = topic;
  applyTopicFilter();
}

function saveTopicSubscriptions() {
    localStorage.setItem('ember-topics', JSON.stringify(Array.from(state.subscribedTopics)));
}

function loadTopicSubscriptions() {
    const saved = localStorage.getItem('ember-topics');
    if (saved) {
        try {
            const topics = JSON.parse(saved);
            topics.forEach(topic => {
                state.subscribedTopics.add(topic);
                addTopicToUI(topic);
            });
        } catch (e) {
            console.error('Failed to load saved topics:', e);
        }
    }
}

function updateTopicStats() {
    if (!state.scribe) return;

    const stats = state.scribe.getStats();
    const statsEl = document.getElementById('topic-stats');

    if (stats.topics.length > 0) {
        const topicDetails = stats.topics.map(t =>
            `${t.topic}: ${t.children} children${t.hasParent ? ' (connected)' : ' (root)'}`
        ).join('<br>');

        statsEl.innerHTML = `
      <div>Connected to ${stats.subscribedTopics} topic trees</div>
      <div style="font-size: 11px; margin-top: 4px;">${topicDetails}</div>
    `;
    }
}

function showTopicSuggestions(partial) {
    const suggestions = [
        '#tech', '#news', '#art', '#music', '#politics', '#science',
        '#ember', '#random', '#help', '#dev', '#memes'
    ].filter(topic => topic.startsWith(partial));

    let suggestionsEl = document.getElementById('topic-suggestions');
    if (!suggestionsEl) {
        suggestionsEl = document.createElement('div');
        suggestionsEl.id = 'topic-suggestions';
        suggestionsEl.className = 'topic-suggestions';
        document.getElementById('compose').appendChild(suggestionsEl);
    }

    suggestionsEl.innerHTML = suggestions.map(topic =>
        `<div class="suggestion" onclick="completeTopicSuggestion('${topic}')">${topic}</div>`
    ).join('');

    suggestionsEl.style.display = suggestions.length > 0 ? 'block' : 'none';
}

function completeTopicSuggestion(topic) {
    const input = document.getElementById("post-input");
    const text = input.value;
    const words = text.split(/\s+/);
    words[words.length - 1] = topic + ' ';
    input.value = words.join(' ');
    input.focus();
    hideTopicSuggestions();
}

function hideTopicSuggestions() {
    const el = document.getElementById('topic-suggestions');
    if (el) el.style.display = 'none';
}


// --- IMAGE HANDLING ---

async function handleImageUpload(file) {
    return new Promise((resolve, reject) => {
        if (file.size > 50000 * 1024) { // 50000KB limit
            reject(new Error("Image too large. Max 50MB"));
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                let width = img.width;
                let height = img.height;
                const maxDim = 800;

                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = (height / width) * maxDim;
                        width = maxDim;
                    } else {
                        width = (width / height) * maxDim;
                        height = maxDim;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                const base64 = canvas.toDataURL('image/jpeg', 0.7);
                resolve(base64);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function handleImageSelect(input) {
    const file = input.files[0];
    if (!file) return;

    try {
        const base64 = await handleImageUpload(file);
        const toxic = await isImageToxic(base64); // Assumes isImageToxic is globally available or imported
        if (toxic) {
            notify(`Image appears to contain ${toxic.toLowerCase()} content`);
            input.value = '';
            return;
        }
        document.getElementById('preview-img').src = base64;
        document.getElementById('image-preview').style.display = 'block';
        document.getElementById('image-preview').dataset.imageData = base64;
    } catch (e) {
        notify(e.message);
    }
}

function removeImage() {
    document.getElementById('image-preview').style.display = 'none';
    document.getElementById('image-preview').dataset.imageData = '';
    document.getElementById('image-input').value = '';
}


// --- GLOBAL UI & SYSTEM FUNCTIONS ---

function updateStatus() {
    const pc = state.peers.size;
    document.getElementById("peer-count").textContent = pc;
    document.getElementById("post-count").textContent = state.posts.size;
    document.getElementById("status-dot").classList.toggle("connecting", pc === 0);

    const dhtStats = state.dht ? state.dht.getStats() : null;
    const hvStats = state.hyparview ? state.hyparview.getStats() : null;

    const protocolInfo = dhtStats ? `DHT: ${dhtStats.totalPeers} peers` : '';
    const overlayInfo = hvStats ? `HyParView: ${hvStats.activeView}/${hvStats.passiveView}` : '';

    let protocolEl = document.getElementById("protocol-status");
    if (!protocolEl) {
        protocolEl = document.createElement("span");
        protocolEl.id = "protocol-status";
        document.getElementById("status").appendChild(protocolEl);
    }
    protocolEl.innerHTML = `<br/>${protocolInfo} | ${overlayInfo}`;
    
    const privacyStatus = state.dandelion?.onionLayers > 0 ? "🔒 Onion Routing" : "⚠️ Direct";

    let privacyEl = document.getElementById("privacy-status");
    if (!privacyEl) {
        privacyEl = document.createElement("span");
        privacyEl.id = "privacy-status";
        document.getElementById("status").appendChild(privacyEl);
    }
    privacyEl.innerHTML = `<br/>${privacyStatus} | Unified Bootstrap`;

    if (state.peers.size === 0 && state.posts.size === 0) {
      let firstNodeEl = document.getElementById("first-node-status");
      if (!firstNodeEl) {
        firstNodeEl = document.createElement("div");
        firstNodeEl.id = "first-node-status";
        firstNodeEl.style.cssText = "text-align: center; padding: 10px; color: #ffa500; font-size: 12px;";
        firstNodeEl.innerHTML = "🌟 Running as first node - share the network to invite others!";
        document.getElementById("status").appendChild(firstNodeEl);
      }
    } else {
      const firstNodeEl = document.getElementById("first-node-status");
      if (firstNodeEl) firstNodeEl.remove();
    }

    clearTimeout(bonfireUpdateTimeout);
    bonfireUpdateTimeout = setTimeout(() => {
        updateBonfire();
    }, 1000);
}

function updateAges() {
    document.querySelectorAll(".post .age").forEach(el => {
        const id = el.closest(".post").id.replace("post-", "");
        const p = state.posts.get(id);
        if (p) el.textContent = timeAgo(p.timestamp);
    });
}

function applyTheme(theme) {
    const button = document.getElementById('theme-toggle-button');
    if (theme === 'light') {
        document.body.classList.add('light-mode');
        if (button) button.textContent = '🌙 Dark Mode';
    } else {
        document.body.classList.remove('light-mode');
        if (button) button.textContent = '☀️ Light Mode';
    }
}

function setupThemeToggle() {
    const themeToggleButton = document.getElementById('theme-toggle-button');
    if (!themeToggleButton) return;

    themeToggleButton.addEventListener('click', () => {
        document.body.classList.toggle('light-mode');
        if (document.body.classList.contains('light-mode')) {
            localStorage.setItem('ephemeral-theme', 'light');
            themeToggleButton.textContent = '🌙 Dark Mode';
        } else {
            localStorage.setItem('ephemeral-theme', 'dark');
            themeToggleButton.textContent = '☀️ Light Mode';
        }
    });
}

function updateLoadingMessage(message) {
    const loadingEl = document.getElementById("loading");
    if (!loadingEl || loadingEl.style.display === "none") return;

    const statusDiv = loadingEl.querySelector('.loading-content div:nth-child(2)');
    if (statusDiv) {
        statusDiv.textContent = message;
    }
}

function showConnectScreen(loadedPostCount) {
    const isReturningUser = loadedPostCount > 0;

    document.getElementById("loading").innerHTML = `
    <div class="loading-content" style="max-width: 400px; text-align: center;">
      <h1 style="font-size: 48px; margin-bottom: 20px;">🔥</h1>
      <h2>Welcome to Ember</h2>
      <p style="color: #888; margin-bottom: 20px;">
        ${isReturningUser
        ? `Welcome back! ${loadedPostCount} embers still glow from your last visit.`
        : 'A decentralized network where posts live only as long as someone tends the flame.'
    }
      </p>
      <button onclick="connectToNetwork()" class="primary-button" style="font-size: 18px; padding: 12px 30px;">
        🔥 Ignite Connection
      </button>
      <p style="font-size: 12px; color: #666; margin-top: 20px;">
        By connecting, you agree to participate in a public peer-to-peer network
      </p>
    </div>
  `;
}


async function handleReplyImageSelect(input, postId) {
    const file = input.files[0];
    if (!file) return;

    try {
        const base64 = await handleImageUpload(file);
        const toxic = await isImageToxic(base64);
        if (toxic) {
            notify(`Image appears to contain ${toxic.toLowerCase()} content`);
            input.value = '';
            return;
        }
        
        // Set the image preview for this specific reply
        const previewImg = document.getElementById(`reply-preview-img-${postId}`);
        const previewDiv = document.getElementById(`reply-image-preview-${postId}`);
        
        if (previewImg && previewDiv) {
            previewImg.src = base64;
            previewDiv.style.display = 'block';
            previewDiv.dataset.imageData = base64;
        }
    } catch (e) {
        notify(e.message);
    }
}

function removeReplyImage(postId) {
    const previewDiv = document.getElementById(`reply-image-preview-${postId}`);
    const imageInput = document.getElementById(`reply-image-input-${postId}`);
    
    if (previewDiv) {
        previewDiv.style.display = 'none';
        previewDiv.dataset.imageData = '';
    }
    
    if (imageInput) {
        imageInput.value = '';
    }
}

// DM UI Functions
window.currentDMConversation = null;

export function openDMPanel(handle) {
  currentDMRecipient = handle;
  
  // Mark messages as read
  const key = `ember-dms-${handle}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const messages = JSON.parse(stored);
      messages.forEach(msg => {
        if (msg.direction === 'received') {
          msg.read = true;
        }
      });
      localStorage.setItem(key, JSON.stringify(messages));
    }
  } catch (e) {
    console.error('Failed to mark messages as read:', e);
  }
  
  document.getElementById('dm-panel').style.display = 'flex';
  document.getElementById('dm-recipient').textContent = handle;
  loadDMConversation(handle);
  document.getElementById('dm-input').focus();
  
  // Update inbox to reflect read status
  updateDMInbox();
}

export function closeDMPanel() {
  document.getElementById('dm-panel').style.display = 'none';
  currentDMRecipient = null; // FIX: Was window.currentDMConversation
}

export function loadDMConversation(handle) {
  const messagesEl = document.getElementById('dm-messages');
  messagesEl.innerHTML = '';
  
  // Load from localStorage
  const key = `ember-dms-${handle}`;
  let conversation = [];
  
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      conversation = JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load DM history:', e);
  }
  
  // Render messages
  conversation.forEach(msg => {
    addMessageToConversation(handle, msg.message, msg.direction, msg.timestamp);
  });
  
  // Scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

export function addMessageToConversation(handle, messageText, direction, timestamp = Date.now()) {
  const messagesEl = document.getElementById('dm-messages');
  
  const msgEl = document.createElement('div');
  msgEl.className = `dm-message ${direction}`;
  msgEl.innerHTML = `
    <div class="dm-message-content">${sanitizeDM(messageText)}</div>
    <div class="dm-message-time">${new Date(timestamp).toLocaleTimeString()}</div>
  `;
  
  messagesEl.appendChild(msgEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

export async function sendDM() {
  const input = document.getElementById('dm-input');
  const message = input.value.trim();
  const recipient = currentDMRecipient;
  if (!message || !recipient) return;

  // The sendDirectMessage function now handles UI updates on its own.
  const success = await sendDirectMessage(recipient, message);

  if (success) {
    // Just clear the input field.
    input.value = '';
  }
}

// Add to ui.js
export function updateDMInbox() {
  const conversationsEl = document.getElementById('dm-conversations');
  if (!conversationsEl) return;
  
  // Get all conversations from localStorage
  const conversations = [];
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ember-dms-'));
  
  keys.forEach(key => {
    const handle = key.replace('ember-dms-', '');
    try {
      const messages = JSON.parse(localStorage.getItem(key));
      if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        conversations.push({
          handle,
          lastMessage,
          messages
        });
      }
    } catch (e) {
      console.error('Failed to parse DM conversation:', e);
    }
  });
  
  if (conversations.length === 0) {
    conversationsEl.innerHTML = `
      <div class="dm-empty-state">
        No messages yet. Send a DM to start a conversation!
      </div>
    `;
    return;
  }
  
  // Sort by most recent
  conversations.sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
  
  // Render conversations
  conversationsEl.innerHTML = conversations.map(conv => {
    const timeAgo = getTimeAgo(conv.lastMessage.timestamp);
    const preview = conv.lastMessage.message.substring(0, 50) + 
                   (conv.lastMessage.message.length > 50 ? '...' : '');
    const isUnread = conv.lastMessage.direction === 'received' && 
                     !conv.lastMessage.read;
    
    return `
      <div class="dm-conversation-item ${isUnread ? 'unread' : ''}" 
           onclick="openDMPanel('${conv.handle}')">
        <div class="dm-sender">
          <span class="ember-indicator">🔥</span>
          ${conv.handle}
        </div>
        <div class="dm-preview">${sanitizeDM(preview)}</div>
        <div class="dm-time">${timeAgo}</div>
      </div>
    `;
  }).join('');
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function storeDMLocallyAndUpdateUI(otherHandle, messageText, direction) {
  const key = `ember-dms-${otherHandle}`;
  let conversation = [];
  
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      conversation = JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load DM history:', e);
  }
  
  conversation.push({
    message: messageText,
    direction: direction,
    timestamp: Date.now(),
    read: direction === 'sent' || direction === 'queued',
    status: direction === 'queued' ? 'pending' : 'sent' 
  });
  
  if (conversation.length > 100) {
    conversation = conversation.slice(-100);
  }
  
  localStorage.setItem(key, JSON.stringify(conversation));
  updateDMInbox();
}


// Add drawer state
let currentDrawer = 'bonfire';

// Drawer switching function
window.switchDrawer =  function(drawerId) {
  // Don't switch if already active
  if (currentDrawer === drawerId) return;
  
  // Update tab states
  document.querySelectorAll('.drawer-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelector(`[data-drawer="${drawerId}"]`).classList.add('active');
  
  // Animate drawer transition
  const currentDrawerEl = document.getElementById(`${currentDrawer}-drawer`);
  const newDrawerEl = document.getElementById(`${drawerId}-drawer`);
  
  currentDrawerEl.classList.remove('active');
  currentDrawerEl.classList.add('slide-out-left');
  
  setTimeout(() => {
    currentDrawerEl.classList.remove('slide-out-left');
    newDrawerEl.classList.add('active', 'slide-in-right');
    
    setTimeout(() => {
      newDrawerEl.classList.remove('slide-in-right');
    }, 300);
  }, 150);
  
  // Update title
  const titles = {
    'bonfire': 'The Bonfire',
    'inbox': 'Message Embers',
    'network': 'Network Status'
  };
  document.getElementById('drawer-title').textContent = titles[drawerId];
  
  // Update current drawer
  currentDrawer = drawerId;
  
  // Trigger drawer-specific updates
  if (drawerId === 'network') {
    updateNetworkVisualization();
  } else if (drawerId === 'inbox') {
    updateDMInbox();
    markAllMessagesAsRead();
  }
};



// Update unread badge
export function updateUnreadBadge() {
  let unreadCount = 0;
  
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ember-dms-'));
  keys.forEach(key => {
    try {
      const messages = JSON.parse(localStorage.getItem(key));
      unreadCount += messages.filter(m => m.direction === 'received' && !m.read).length;
    } catch (e) {
      console.error('Failed to count unread messages:', e);
    }
  });
  
  const badge = document.getElementById('inbox-unread-badge');
  if (badge) {
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      badge.style.display = 'block';
      
      // Animate the tab if not active
      if (currentDrawer !== 'inbox') {
        const inboxTab = document.querySelector('[data-drawer="inbox"]');
        inboxTab.classList.add('has-unread');
      }
    } else {
      badge.style.display = 'none';
    }
  }
}

function markAllMessagesAsRead() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ember-dms-'));
  keys.forEach(key => {
    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        const messages = JSON.parse(stored);
        let changed = false;
        messages.forEach(msg => {
          if (msg.direction === 'received' && !msg.read) {
            msg.read = true;
            changed = true;
          }
        });

        // Only write back to localStorage if a message was actually marked as read
        if (changed) {
            localStorage.setItem(key, JSON.stringify(messages));
        }
      }
    } catch (e) {
      console.error('Failed to mark messages as read:', e);
    }
  });

  // After marking all as read, update the badge to show 0
  updateUnreadBadge();
  
  // Also remove the pulsing animation from the inbox tab
  const inboxTab = document.querySelector('[data-drawer="inbox"]');
  if (inboxTab) {
      inboxTab.classList.remove('has-unread');
  }
}
// Network visualization
function updateNetworkVisualization() {
  const canvas = document.getElementById('network-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = 200;
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw network graph (simplified visualization)
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  
  // Draw self node
  ctx.beginPath();
  ctx.arc(centerX, centerY, 10, 0, Math.PI * 2);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-accent');
  ctx.fill();
  
  // Draw peer nodes
  const peers = Array.from(state.peers.values());
  const angleStep = (Math.PI * 2) / Math.max(peers.length, 1);
  
  peers.forEach((peer, index) => {
    const angle = angleStep * index;
    const x = centerX + Math.cos(angle) * 80;
    const y = centerY + Math.sin(angle) * 80;
    
    // Draw connection line
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color-accent');
    ctx.globalAlpha = 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
    
    // Draw peer node
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary');
    ctx.fill();
  });
  
  // Update metrics
  updateNetworkMetrics();
}

function updateNetworkMetrics() {
  const metrics = document.getElementById('network-metrics');
  if (!metrics) return;
  
  const dhtStats = state.dht ? state.dht.getStats() : null;
  const hvStats = state.hyparview ? state.hyparview.getStats() : null;
  
  metrics.innerHTML = `
    <div class="metric-item">
      <span class="metric-label">Total Peers</span>
      <span class="metric-value">${state.peers.size}</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">DHT Nodes</span>
      <span class="metric-value">${dhtStats?.totalPeers || 0}</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Active View</span>
      <span class="metric-value">${hvStats?.activeView || 0}/${hvStats?.activeCapacity?.split('/')[1] || 0}</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Messages Seen</span>
      <span class="metric-value">${state.seenMessages.timestamps?.size || 0}</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Storage Used</span>
      <span class="metric-value">${dhtStats?.storageSize || 0} keys</span>
    </div>
  `;
}

// Add CSS class for unread animation
const style = document.createElement('style');
style.textContent = `
  .drawer-tab.has-unread {
    animation: unread-pulse 2s ease-in-out infinite;
  }
  
  @keyframes unread-pulse {
    0%, 100% { 
      border-color: var(--border-color-light);
    }
    50% { 
      border-color: var(--text-accent-hot);
      box-shadow: 0 0 10px var(--shadow-color-accent);
    }
  }
`;
document.head.appendChild(style);


// Make functions available globally
window.openDMPanel = openDMPanel;
window.closeDMPanel = closeDMPanel;
window.sendDM = sendDM;



// --- EXPORTS ---
export {
    animationObserver,
    bonfireUpdateTimeout,
    showAllShards,
    notify,
    renderPost,
    updateInner,
    refreshPost,
    dropPost,
    getHeatLevel,
    getThreadSize,
    toggleReplyForm,
    toggleThread,
    updateBonfire,
    scrollToPost,
    subscribeToTopic,
    addTopicToUI,
    toggleTopic,
    updateTopicFilter,
    filterByTopic,
    setFeedMode,
    applyTopicFilter,
    discoverAndFilterTopic,
    filterToTopic,
    saveTopicSubscriptions,
    loadTopicSubscriptions,
    updateTopicStats,
    showTopicSuggestions,
    completeTopicSuggestion,
    hideTopicSuggestions,
    handleImageUpload,
    handleImageSelect,
    removeImage,
    updateStatus,
    updateAges,
    applyTheme,
    setupThemeToggle,
    updateLoadingMessage,
    showConnectScreen,
    handleReplyImageSelect, 
    removeReplyImage,
    openProfileForHandle,
    renderProfile,
    closeProfile
};
