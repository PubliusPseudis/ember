// FILE: ui.js
// ui.js
// This module contains all functions and variables responsible for
// interacting with the DOM, rendering content, and handling UI events.

// --- IMPORTS ---
import { getImageStore, getServices } from './services/instances.js'; 
import { state } from './state.js';
import { sanitize, sanitizeDM } from './utils.js';
import { CONFIG } from './config.js';
import DOMPurify from 'dompurify';
import Mustache from 'mustache';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/material-darker.css';
import 'codemirror/mode/javascript/javascript.js';
import 'codemirror/mode/xml/xml.js';
import 'codemirror/mode/htmlmixed/htmlmixed.js';

//canvas engine for lp games
import { drawGfxIntoCanvas } from './engine-canvas.js';

// Dynamic sendPeer injection
let sendPeerFunction = null;
export function setSendPeer(fn) {
  sendPeerFunction = fn;
}

// --- LOCAL HELPERS ---
// Small helper functions that are only used by the UI.
const isReply = (post) => post && post.parentId;

// --- UI STATE & OBSERVERS ---
// Top-level constants and variables that manage UI state.
let bonfireUpdateTimeout;
let showAllShards = true;

export let currentDMRecipient = null;
let lpCodeEditor, lpStateEditor, lpRendererEditor;

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

  if (section && handleEl && picContainer) { // Added picContainer to the check
    console.log('[Debug] Success: Found elements, setting display to block.'); 
    section.style.display = 'block';
    handleEl.textContent = state.myIdentity.handle;
    
    // Update profile picture if available
    const profile = state.myIdentity.profile;
    if (profile && profile.profilePictureHash) {
      const hash = profile.profilePictureHash;
      getImageStore().retrieveImage(hash).then(imageData => {
        if (imageData) {
          picContainer.innerHTML = `<img src="${imageData}" alt="Your profile" />`;
        } else {
          // ***  If image isn't ready, create a placeholder ***
          // This allows the periodic update function to find and fill it later.
          picContainer.innerHTML = `<div class="profile-picture-placeholder-small" data-hash="${hash}">👤</div>`;
        }
      });
    }
  } else {
    console.error('[Debug] Failed: Could not find #user-profile-section, #user-profile-handle, or #user-profile-pic in the DOM.');
  }
}

async function renderPost(p, container = null) {
    console.log("render post called");
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
    const imageData = await getImageStore().retrieveImage(hash);
    
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

  if (p.postType === 'living' && state.scribe) {
    const topic = `#lp:${p.id}`;
    if (!state.scribe.subscribedTopics.has(topic)) {
      state.scribe.subscribe(topic).catch(e => console.error(`Failed to subscribe to LP topic ${topic}:`, e));
    }
  }

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
    const imageData = await getImageStore().retrieveImage(cachedProfile.profilePictureHash);
    if (imageData) {
      authorProfilePic = `<img src="${imageData}" class="author-profile-pic" alt="${p.author}'s profile" />`;
    } else {
      // Request the image if not found
      const peers = Array.from(state.peers.values()).slice(0, 3);
      for (const peer of peers) {
        if (peer.wire && !peer.wire.destroyed) {
          sendPeerFunction(peer.wire, { type: "request_image", imageHash: cachedProfile.profilePictureHash });
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

            getImageStore().retrieveImage(p.imageHash).then(imageData => {
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

    if (p.postType === 'living') {
        try {
            const lpState = JSON.parse(p.lpState || '{}');
            
            // Use Mustache.js to render the template, then sanitize the output
            const renderedHtml = Mustache.render(p.lpRenderer, lpState);
            const sanitizedHtml = DOMPurify.sanitize(renderedHtml, {
              ALLOWED_TAGS: [
                'div','span','p','ul','ol','li','strong','em','b','i','small','br','hr',
                'a','button','code','pre','canvas'
              ],
              ALLOWED_ATTR: ['href','title','class','data-input','aria-label','role','id','width','height','data-lp-canvas'],
              FORBID_TAGS: [
                'img','picture','source','video','audio','track','iframe','svg',
                'object','embed','link','style'
              ],
              FORBID_ATTR: [
                'style','src','srcset','poster','xlink:href','background','data'
              ],
              ALLOWED_URI_REGEXP: /^(https?:|#)/i
            });
            
            el.innerHTML = `
                <div class="author-section">
                    ${authorProfilePic}
                    <div class="author clickable-author" data-handle="${p.author}">${p.author} ${verificationBadge}</div>
                </div>
                <div class="content">${DOMPurify.sanitize(p.content)}</div>
                <div class="living-post-container" id="lp-container-${p.id}">${sanitizedHtml}</div>

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
                    ${!isAuthor ? `<button class="dm-button" onclick="requestOrOpenDM('${p.author}')">📨</button>` : ''}
                </div>
            </div>
            `;
        
        
            // Add event listeners
            const container = el.querySelector(`#lp-container-${p.id}`);
            container.querySelectorAll('[data-input]').forEach(interactiveEl => {
                interactiveEl.addEventListener('click', () => {
                    const inputData = interactiveEl.getAttribute('data-input');
                    window.interactWithLivingPost(p.id, inputData);
                });
            });

            // If LP provided gfx, draw it into the canvas (if present)
            try {
              const cvs = container.querySelector('canvas[data-lp-canvas]');
              if (cvs) {
                const st = JSON.parse(p.lpState || '{}');
                if (st && st.sim && st.sim.type === 'platformer') {
                  const mod = await import('./engine-sim-platformer.js');
                  if (mod && typeof mod.mountPlatformer === 'function') {
                    await mod.mountPlatformer(cvs, st.sim, { /* no postId: local sim */ });
                  }
                } else if (st && st.gfx) {
                  drawGfxIntoCanvas(cvs, st.gfx, { postId: p.id });
                }
              }
            } catch (e) {
              console.warn('[LP feed] canvas draw failed:', e);
            }


        } catch (e) {
            console.error("Failed to render Living Post:", e);
            el.innerHTML += `<div class="error-message">Error rendering this Living Post.</div>`;
        }
        return; // Exit to skip standard rendering
    }


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
            ${!isAuthor ? `<button class="dm-button" onclick="requestOrOpenDM('${p.author}')">📨</button>` : ''}
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

 async function updateHotTopics() {
    const bonfireContentEl = document.getElementById('bonfire-content');
    if (!bonfireContentEl) return;
    bonfireContentEl.innerHTML = '<div class="empty-state">Looking for hot topics on the network...</div>';
    if (!state.dht) {
        bonfireContentEl.innerHTML = '<div class="empty-state">Connect to the network to find topics.</div>';
        return;
    }

    try {
        const data = await state.dht.get('global-topic-index:v1'); 

        // Filter out internal LP topics (e.g., #lp:abcdef)
        const filtered = (Array.isArray(data) ? data : []).filter(([topic]) => {
          return !/^#lp:/i.test(topic);
        });

        if (filtered.length === 0) {
            bonfireContentEl.innerHTML = '<div class="empty-state">No hot topics found yet. Check back soon!</div>';
            return;
        }

        // The data is an array of [topic, info] pairs.
        const topicsHtml = filtered.map(([topic, info]) => `
            <div class="bonfire-item" onclick="renderHotPostsForTopic('${topic}')">
                <span class="bonfire-heat">${Math.round(info.score)} 📈</span>
                <span class="bonfire-preview">${topic}</span>
            </div>
        `).join('');
        bonfireContentEl.innerHTML = `<div class="bonfire-posts">${topicsHtml}</div>`;


    } catch (e) {
        console.error("Failed to fetch hot topics:", e);
        bonfireContentEl.innerHTML = '<div class="empty-state">Error fetching topics from the network.</div>';
    }
}

async function generateTopicSuggestions() {
  if (!state.myIdentity || !state.dht) return;

  const myTopics = state.subscribedTopics;
  if (myTopics.size === 0) return;

  const suggestions = new Map(); // topic -> { score, from: Set<handle> }
  const peers = Array.from(state.peers.values());
  const profilesToFetch = peers.slice(0, 20); // Check up to 20 random peers

  const fetchPromises = profilesToFetch.map(peer => {
    if (peer.handle) {
      return state.dht.get(`profile:${peer.handle}`);
    }
    return null;
  }).filter(p => p);

  const profiles = await Promise.all(fetchPromises);

  profiles.forEach(profileData => {
    const profile = profileData ? (profileData.value || profileData) : null;
    if (profile && profile.handle && profile.subscriptions) {
      const userTopics = new Set(profile.subscriptions);
      
      // Find intersection (shared topics)
      const intersection = new Set([...myTopics].filter(t => userTopics.has(t)));
      
      // If we share at least one topic, they are a similar user
      if (intersection.size > 0) {
        // Find topics they have that we don't
        userTopics.forEach(topic => {
          if (!myTopics.has(topic)) {
            const suggestion = suggestions.get(topic) || { score: 0, from: new Set() };
            suggestion.score += 1; // Simple score: +1 for each user who has it
            suggestion.from.add(profile.handle);
            suggestions.set(topic, suggestion);
          }
        });
      }
    }
  });

  const sortedSuggestions = Array.from(suggestions.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5); // Get top 5 suggestions

  displayTopicSuggestions(sortedSuggestions);
}

function displayTopicSuggestions(suggestions) {
  const container = document.getElementById('topic-suggestions-list');
  if (!container) return;

  if (suggestions.length === 0) {
    container.innerHTML = '<div class="empty-state">No new suggestions right now.</div>';
    return;
  }

  container.innerHTML = suggestions.map(([topic, info]) => `
    <div class="topic-suggestion-item">
      <span class="topic-tag">${topic}</span>
      <span class="suggestion-reason">Popular with ${info.score} similar users</span>
      <button class="subscribe-button" onclick="discoverAndFilterTopic('${topic}')">+</button>
    </div>
  `).join('');
}

function renderHotPostsForTopic(topic) {
    const bonfireContentEl = document.getElementById('bonfire-content');
    if (!bonfireContentEl) return;


    const now = Date.now();
    const topicPosts = Array.from(state.posts.values()).filter(p => {
        const postTopics = state.scribe ? state.scribe.extractTopics(p.content) : [];
        return postTopics.includes(topic);
    });

    if (topicPosts.length === 0) {
        bonfireContentEl.innerHTML = `
            <div class="empty-state">
                No posts found for ${topic} yet.
                <button class="secondary-button" onclick="updateHotTopics()">Back to Topics</button>
            </div>`;
        return;
    }

    const scoredPosts = topicPosts.map(post => {
        const ageHours = (now - post.timestamp) / 3600000;
        const rating = post.getRatingSummary();
        // Hotness score: carrier count + reply count + weighted rating score, decayed by age.
        const score = (post.carriers.size + post.replies.size * 2 + rating.weightedTotal * 5) / Math.pow(ageHours + 1, 1.2);
        return { post, score };
    });

    const hottest = scoredPosts.sort((a, b) => b.score - a.score).slice(0, 20);

    const postsHtml = hottest.map(({ post, score }) => `
        <div class="bonfire-item" onclick="scrollToPost('${post.id}')">
            <span class="bonfire-heat">${Math.round(score)} 🔥</span>
            <span class="bonfire-preview">${(post.content.substring(0, 60))}...</span>
        </div>
    `).join('');

    bonfireContentEl.innerHTML = `
        <div class="bonfire-header">
            <button class="secondary-button" onclick="updateHotTopics()">← Back to Topics</button>
        </div>
        <div class="bonfire-posts">${postsHtml}</div>
    `;
}
function scrollToPost(postId) {
    // Ensure the correct mobile view is active 
    const feedView = document.getElementById('column-feed');
    // Check if the feed view is NOT active
    if (!feedView.classList.contains('active')) {
        // Find the navigation button that corresponds to the feed view
        const feedNavButton = document.querySelector('.nav-button[data-view="column-feed"]');
        if (feedNavButton) {
            // Programmatically click the button to switch to "The Void"
            feedNavButton.click();
        }
    }

    const el = document.getElementById(`post-${postId}`);
    if (el) {
        // Use a small timeout to allow the view to become visible before scrolling
        setTimeout(() => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.animation = 'pulse-border 2s ease-in-out';
            setTimeout(() => {
                el.style.animation = '';
            }, 2000);
        }, 100); // 100ms delay is usually sufficient for the view transition
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
      window.handleProfileUpdate(dhtProfile, null);
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
  await window.subscribeToProfile(handle);
}

function closeProfile() {
  const modal = document.getElementById('profile-modal-overlay');
  modal.style.display = 'none';
  
  if (state.viewingProfile && state.viewingProfile !== state.myIdentity.handle) {
    window.unsubscribeFromProfile(state.viewingProfile);
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
    const imageData = await getImageStore().retrieveImage(profileData.profilePictureHash);
    if (imageData) {
      profilePicHtml = `<img src="${imageData}" class="profile-picture" alt="${profileData.handle}'s profile picture" />`;
    } else {
      // ADDED: Request image from peers if not found locally
      console.log(`[Profile] Profile picture not found locally, requesting from peers: ${profileData.profilePictureHash}`);
      const peers = Array.from(state.peers.values()).slice(0, 3);
      for (const peer of peers) {
        if (peer.wire && !peer.wire.destroyed) {
          sendPeerFunction(peer.wire, { type: "request_image", imageHash: profileData.profilePictureHash });
        }
      }
      
      // Set up a placeholder that can be updated when image arrives
      profilePicHtml = `<div id="profile-pic-${profileData.profilePictureHash}" class="profile-picture-placeholder">
        <div class="spinner" style="width: 20px; height: 20px;"></div>
      </div>`;
      
      // Set up a listener for when the image arrives
      const checkInterval = setInterval(async () => {
        const imageData = await getImageStore().retrieveImage(profileData.profilePictureHash);
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
    const imageData = await getImageStore().retrieveImage(profile.profilePictureHash);
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
      const toxic = await window.isImageToxic(base64);
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
  
  if (bio && await window.isToxic(bio)) {
    notify('Your bio may contain inappropriate content. Please revise.');
    return;
  }
  
  let profilePictureHash = state.myIdentity.profile?.profilePictureHash || null;
  let profilePictureMeta = state.myIdentity.profile?.profilePictureMeta || null; // <-- Get existing meta

  const previewDiv = document.getElementById('profile-picture-preview');
  if (previewDiv.style.display !== 'none' && previewDiv.dataset.imageData) {
    const result = await getImageStore().storeImage(previewDiv.dataset.imageData);
    profilePictureHash = result.hash;
    // Get the new metadata from the image store ***
    profilePictureMeta = getImageStore().images.get(result.hash);
  }
  
  const updatedProfile = {
    handle: state.myIdentity.handle,
    bio: bio,
    profilePictureHash: profilePictureHash,
    profilePictureMeta: profilePictureMeta, // <-- ADD THIS
    theme: {
      backgroundColor: bgColor,
      fontColor: textColor,
      accentColor: accentColor
    },
    updatedAt: Date.now()
  };
  state.myIdentity.profile = updatedProfile;
  
  // This broadcast will now include the metadata
  await window.broadcastProfileUpdate(updatedProfile);
  
  state.myIdentity.profile = updatedProfile;
  
  // This function is in main.js, but we call it from the window scope
  await window.broadcastProfileUpdate(updatedProfile);
  
  renderProfile(updatedProfile);

  // Update the profile section in control panel
  const picContainer = document.getElementById('user-profile-pic');
  if (picContainer && profilePictureHash) {
    const imageData = await getImageStore().retrieveImage(profilePictureHash);
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

    if (mode === 'forYou') {
        renderForYouFeed();
    } else {
        applyTopicFilter(); // Fall back to the original filter for 'all' and 'topics'
    }
}



function applyTopicFilter() {
    const posts = document.querySelectorAll('.post');
    let visibleCount = 0;


    // If in 'All Posts' mode, explicitly sort by timestamp first
    if (state.feedMode === 'all') {
        const container = document.getElementById('posts');
        // Get only top-level posts for sorting
        const postsToSort = Array.from(container.querySelectorAll('.post:not(.reply)'));

        postsToSort.sort((a, b) => {
            const postA = state.posts.get(a.id.replace('post-', ''));
            const postB = state.posts.get(b.id.replace('post-', ''));
            if (!postA || !postB) return 0;
            // Sort descending for newest first
            return postB.timestamp - a.timestamp;
        });

        // Re-append all sorted posts to the container in the correct order
        postsToSort.forEach(el => container.appendChild(el));
    }

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

    // *** If no topics were loaded from storage, add #general by default ***
    if (state.subscribedTopics.size === 0) {
        const defaultTopic = '#general';
        state.subscribedTopics.add(defaultTopic);
        addTopicToUI(defaultTopic);
        saveTopicSubscriptions(); // Save the default so it persists
        console.log('No saved topics found. Subscribed to #general by default.');
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
        const toxic = await window.isImageToxic(base64); // Assumes isImageToxic is globally available or imported
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
        if (typeof currentDrawer !== 'undefined' && currentDrawer === 'bonfire') {
            updateHotTopics();
        }
    }, 1000);
}

function updateAges() {
    document.querySelectorAll(".post .age").forEach(el => {
        const id = el.closest(".post").id.replace("post-", "");
        const p = state.posts.get(id);
        if (p) el.textContent = getTimeAgo(p.timestamp);
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
        const toxic = await window.isImageToxic(base64);
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
  const success = await window.sendDirectMessage(recipient, message);

  if (success) {
    // Just clear the input field.
    input.value = '';
  }
}

export function updateDMInbox() {
  const conversationsEl = document.getElementById('dm-conversations');
  if (!conversationsEl) return;
  
  // Get pending requests
  const pendingIncoming = [];
  const pendingOutgoing = [];
  const approved = [];
  const blocked = [];
  
  state.dmPermissions.forEach((permission, handle) => {
    if (permission.status === 'pending_incoming') {
      pendingIncoming.push({ handle, ...permission });
    } else if (permission.status === 'pending_outgoing') {
      pendingOutgoing.push({ handle, ...permission });
    } else if (permission.status === 'approved') {
      approved.push({ handle, ...permission });
    } else if (permission.status === 'blocked') {
      blocked.push({ handle, ...permission });
    }
  });
  
  let html = '';
  
  // Show pending incoming requests first
  if (pendingIncoming.length > 0) {
    html += `
      <div class="dm-section">
        <h3 class="dm-section-title">📨 DM Requests</h3>
        ${pendingIncoming.map(req => `
          <div class="dm-request-item">
            <div class="dm-request-info">
              <span class="ember-indicator">🔥</span>
              <span class="dm-sender">${req.handle}</span>
              <span class="dm-time">${getTimeAgo(req.timestamp)}</span>
            </div>
            <div class="dm-request-actions">
              <button class="approve-btn" onclick="approveDMRequest('${req.handle}')">✅ Accept</button>
              <button class="decline-btn" onclick="declineDMRequest('${req.handle}')">❌ Decline</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  // Show existing conversations for approved contacts
  const conversations = [];
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ember-dms-'));
  
  keys.forEach(key => {
    const handle = key.replace('ember-dms-', '');
    // Only show if approved
    if (state.dmPermissions.get(handle)?.status === 'approved') {
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
    }
  });
  
  if (conversations.length > 0) {
    conversations.sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
    
    html += `
      <div class="dm-section">
        <h3 class="dm-section-title">💬 Messages</h3>
        ${conversations.map(conv => {
          const timeAgo = getTimeAgo(conv.lastMessage.timestamp);
          const preview = conv.lastMessage.message.substring(0, 50) + 
                         (conv.lastMessage.message.length > 50 ? '...' : '');
          const isUnread = conv.lastMessage.direction === 'received' && 
                           !conv.lastMessage.read;
          
          return `
            <div class="dm-conversation-item ${isUnread ? 'unread' : ''}" 
                 onclick="openDMPanel('${conv.handle}')">
              <div class="dm-conversation-header">
                <div class="dm-sender">
                  <span class="ember-indicator">🔥</span>
                  ${conv.handle}
                </div>
                <div class="dm-actions">
                  <button class="revoke-btn-small" onclick="event.stopPropagation(); revokeDMPermission('${conv.handle}')">×</button>
                </div>
              </div>
              <div class="dm-preview">${sanitizeDM(preview)}</div>
              <div class="dm-time">${timeAgo}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
  
  // Show approved contacts without conversations
  const approvedWithoutConversations = approved.filter(
    a => !conversations.find(c => c.handle === a.handle)
  );
  
  if (approvedWithoutConversations.length > 0) {
    html += `
      <div class="dm-section">
        <h3 class="dm-section-title">✅ Approved Contacts</h3>
        ${approvedWithoutConversations.map(contact => `
          <div class="dm-contact-item">
            <span class="ember-indicator">🔥</span>
            <span class="dm-sender">${contact.handle}</span>
            <div class="dm-contact-actions">
              <button class="revoke-btn" onclick="revokeDMPermission('${contact.handle}')">Revoke</button>
              <button class="message-btn" onclick="openDMPanel('${contact.handle}')">Message</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  // Show pending outgoing
  if (pendingOutgoing.length > 0) {
    html += `
      <div class="dm-section">
        <h3 class="dm-section-title">⏳ Pending Requests</h3>
        ${pendingOutgoing.map(req => `
          <div class="dm-pending-item">
            <span class="ember-indicator">🔥</span>
            <span class="dm-sender">${req.handle}</span>
            <span class="dm-time">Sent ${getTimeAgo(req.timestamp)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  // Show blocked contacts
  if (blocked.length > 0) {
    html += `
      <div class="dm-section">
        <h3 class="dm-section-title">🚫 Blocked</h3>
        ${blocked.map(contact => `
          <div class="dm-blocked-item">
            <span class="dm-sender">${contact.handle}</span>
            <button class="unblock-btn" onclick="unblockDMContact('${contact.handle}')">Unblock</button>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  if (html === '') {
    conversationsEl.innerHTML = `
      <div class="dm-empty-state">
        No messages yet. Click the 📨 button on a post to request DM access!
      </div>
    `;
  } else {
    conversationsEl.innerHTML = html;
  }
}
/**
 * Calculates a relevance score for a post based on the user's activity profile.
 * @param {Post} post The post to score.
 * @returns {number} The calculated relevance score.
 */
function calculateRelevanceScore(post) {
    if (!state.myIdentity) return 0;
    
     const { activityProfile, peerManager, contentSimilarity } = getServices();
    if (!activityProfile || !peerManager) return 0;

    let score = 0;
    //nuanced weights incorporating reputation and negative feedback
    const WEIGHTS = {
        SUBSCRIBED_TOPIC: 10,
        AUTHOR_AFFINITY: 8,
        AUTHOR_REPUTATION: 12, // Author's general reputation
        COLLABORATIVE_FILTERING: 5, // Multiplier for voter reputation
        NEGATIVE_FEEDBACK: -15, // Negative weight for downvotes
        POST_HEAT: 0.5,
           CONTENT_SIMILARITY: 15,
    };

    // 1. Topic Subscription (Unchanged)
    const postTopics = state.scribe ? state.scribe.extractTopics(post.content) : [];
    if (postTopics.some(t => state.subscribedTopics.has(t))) {
        score += WEIGHTS.SUBSCRIBED_TOPIC;
    }

    // 2. Author Affinity (Unchanged)
    const affinity = activityProfile.authorAffinities.get(post.author) || 0;
    if (affinity > 0) {
        score += WEIGHTS.AUTHOR_AFFINITY * Math.log1p(affinity);
    }

    // 3. NEW: Author Reputation
    const authorReputation = getReputationByHandle(post.author);
    // Use a logarithmic scale to prevent extreme scores from single high-rep users
    score += WEIGHTS.AUTHOR_REPUTATION * Math.log1p(authorReputation / 100);

    // 4. MODIFIED: Collaborative Filtering & Negative Feedback
    let collaborativeScore = 0;
    for (const [voterHandle, rating] of post.ratings.entries()) {
        if (activityProfile.similarUsers.has(voterHandle)) {
            // The 'weight' in the rating is a log-scaled reputation score of the voter
            const voterWeight = rating.weight || 1; 

            if (rating.vote === 'up') {
                collaborativeScore += WEIGHTS.COLLABORATIVE_FILTERING * voterWeight;
            } else if (rating.vote === 'down') {
                // Incorporate negative feedback from downvotes
                collaborativeScore += WEIGHTS.NEGATIVE_FEEDBACK * voterWeight;
            }
        }
    }
    score += collaborativeScore;


    // 5. NEW: Content-Based Similarity
    let maxSimilarity = 0;
    const positivePosts = activityProfile.getPositiveInteractionPostIds();
    if (positivePosts.size > 0 && contentSimilarity) {
        for (const likedPostId of positivePosts) {
            const similarity = contentSimilarity.getCosineSimilarity(post.id, likedPostId);
            if (similarity > maxSimilarity) {
                maxSimilarity = similarity;
            }
        }
        // The score is boosted by its similarity to the user's most-liked content type
        score += WEIGHTS.CONTENT_SIMILARITY * maxSimilarity;
    }

    // 6. Post Heat (Unchanged)
    const heat = post.carriers.size + post.replies.size;
    score += WEIGHTS.POST_HEAT * heat;

    // 7. Time Decay (Unchanged)
    const ageHours = (Date.now() - post.timestamp) / 3600000;
    const decayFactor = Math.exp(-0.05 * ageHours);
    score *= decayFactor;

    return score;
}

/**
 * Renders the "For You" feed by scoring and sorting all known posts.
 */
function renderForYouFeed() {
    const postsContainer = document.getElementById('posts');
    postsContainer.innerHTML = '<div class="empty-state">✨ Curating your feed...</div>';

    if (state.posts.size === 0) {
        postsContainer.innerHTML = '<div class="empty-state">Not enough posts on the network to curate a feed.</div>';
        return;
    }

    // STAGE 1: Scoring all posts
    const scoredPosts = Array.from(state.posts.values())
        .map(post => ({
            post: post,
            score: calculateRelevanceScore(post)
        }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scoredPosts.length === 0) {
        postsContainer.innerHTML = '<div class="empty-state">Not enough activity to curate your feed yet. Interact with some posts!</div>';
        return;
    }

    // STAGE 2: Diversification & Exploration
    let finalFeed = [];
    const authorCounts = new Map();
    const heldForDiversity = [];
    const MAX_POSTS_PER_AUTHOR_IN_TOP_20 = 2;

    // Get and inject exploration posts to introduce novelty
    const explorationPosts = getExplorationPosts(new Set(scoredPosts.map(p => p.post.id)));
    if (explorationPosts.length > 0) scoredPosts.splice(5, 0, explorationPosts[0]);
    if (explorationPosts.length > 1) scoredPosts.splice(12, 0, explorationPosts[1]);

    // Apply source diversity to prevent single-author dominance
    for (const item of scoredPosts) {
        const author = item.post.author;
        const count = authorCounts.get(author) || 0;

        if (finalFeed.length < 20 && count >= MAX_POSTS_PER_AUTHOR_IN_TOP_20) {
            heldForDiversity.push(item);
        } else {
            finalFeed.push(item);
            authorCounts.set(author, count + 1);
        }
    }

    // Add the posts that were held back to the end of the feed
    finalFeed = finalFeed.concat(heldForDiversity);

    // STAGE 3: Rendering the final, curated feed
    postsContainer.innerHTML = '';
    finalFeed.forEach(item => {
        renderPost(item.post, postsContainer);
    });
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
window.switchDrawer = function(drawerId) {
  // Don't switch if already active
  if (currentDrawer === drawerId) return;
  
  // Update tab states
  document.querySelectorAll('.drawer-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelector(`[data-drawer="${drawerId}"]`).classList.add('active');
  
  // For mobile, use simpler show/hide logic
  if (window.innerWidth <= 767) {
    document.querySelectorAll('.drawer-content').forEach(drawer => {
      drawer.classList.remove('active');
    });
    document.getElementById(`${drawerId}-drawer`).classList.add('active');
  } else {
    // Desktop animation logic
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
  }
  

  const titles = {
    'bonfire': 'The Bonfire',
    'inbox': 'Message Embers',
    'network': 'Network Status'
  };

  
  // Update current drawer
  currentDrawer = drawerId;
  
  // Trigger drawer-specific updates
  if (drawerId === 'network') {
    updateNetworkVisualization();
  } else if (drawerId === 'inbox') {
    updateDMInbox();
    markAllMessagesAsRead();
  } else if (drawerId === 'bonfire') {
    updateHotTopics();
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

window.openPrivacyNotice = function() {
  const modal = document.getElementById('privacy-modal-overlay');
  if (modal) {
    modal.style.display = 'flex';
  }
};

window.closePrivacyNotice = function() {
  const modal = document.getElementById('privacy-modal-overlay');
  if (modal) {
    modal.style.display = 'none';
  }
};

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
window.updateHotTopics = updateHotTopics;
window.openDMPanel = openDMPanel;
window.closeDMPanel = closeDMPanel;
window.sendDM = sendDM;
window.renderHotPostsForTopic = renderHotPostsForTopic;
window.requestOrOpenDM = async function(handle) {
  const permission = state.dmPermissions.get(handle);
  const status = permission?.status;
  
  if (status === 'approved') {
    openDMPanel(handle);
  } else if (status === 'pending_outgoing') {
    notify(`DM request to ${handle} is still pending`);
  } else if (status === 'blocked') {
    notify(`You have blocked ${handle}. Go to Messages to unblock.`);
  } else {
    // Send DM request
    const sent = await window.sendDMRequest(handle);
    if (sent) {
      notify(`DM request sent to ${handle}`);
    }
  }
};

window.showDMRequest = function(handle) {
  window.switchDrawer('inbox');
  setTimeout(() => {
    // Find the element using standard JavaScript
    const allRequests = document.querySelectorAll('.dm-request-item');
    const requestEl = Array.from(allRequests).find(el => {
      const senderEl = el.querySelector('.dm-sender');
      return senderEl && senderEl.textContent.trim() === handle;
    });

    if (requestEl) {
      requestEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      requestEl.style.animation = 'pulse-border 2s ease-in-out';
      // Clean up the animation after it finishes
      setTimeout(() => { requestEl.style.animation = ''; }, 2000);
    }
  }, 300);
};
function syncDesktopTopicFilter(val) {
  const mobileSel = document.getElementById('topic-filter');
  if (mobileSel) {
    mobileSel.value = val;
    mobileSel.dispatchEvent(new Event('change'));
  } else {
    // fallback: if your filterByTopic() reads from DOM, call it anyway
    if (typeof filterByTopic === 'function') filterByTopic();
  }
}

window.switchComposeTab = function(tab) {
    const standardContent = document.getElementById('standard-compose-content');
    const livingContent = document.getElementById('living-compose-content');
    const imageButton = document.getElementById('image-upload-button');

    document.querySelectorAll('.compose-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.compose-tab[onclick="switchComposeTab('${tab}')"]`).classList.add('active');

    if (tab === 'living') {
        standardContent.style.display = 'none';
        livingContent.style.display = 'block';
        imageButton.style.display = 'none'; // No images on LPs for now
    } else {
        standardContent.style.display = 'block';
        livingContent.style.display = 'none';
        imageButton.style.display = 'block';
    }
}
window.toggleMobileFilters = function() {
  const filters = document.getElementById('collapsible-feed-header');
  if (filters) {
    filters.classList.toggle('visible');
  }
};

// ===============================================
// == Mobile Navigation Functions
// ===============================================

// Initialize mobile navigation when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupMobileNavigation);
} else {
  setupMobileNavigation();
}

function setupMobileNavigation() {
  const navButtons = document.querySelectorAll('.nav-button');
  const appViews = document.querySelectorAll('.app-view');
  const composeButton = document.getElementById('open-compose-button');
  const composeModal = document.getElementById('compose-modal-overlay');
  const closeComposeButton = document.querySelector('.close-compose-button');

  // Sync topics between desktop and mobile
  function syncTopics() {
    const mobileContainer = document.getElementById('mobile-subscribed-topics');
    if (mobileContainer && state.subscribedTopics) {
      mobileContainer.innerHTML = '';
      state.subscribedTopics.forEach(topic => {
        addTopicToMobileUI(topic);
      });
    }
  }

  // Function to switch views
function switchView(viewId) {
  console.log(`Switching to view: ${viewId}`);  // Add this for debugging
  appViews.forEach(view => {
    view.classList.remove('active');
  });
  const targetView = document.getElementById(viewId);
  if (targetView) {
    targetView.classList.add('active');
    
    // Sync topics when switching to More tab
    if (viewId === 'column-controls') {
      syncTopics();
    }
  } else {
    console.error(`View not found: ${viewId}`);
  }
}

  // Handle navigation button clicks
navButtons.forEach(button => {
    button.addEventListener('click', () => {
        // Deactivate all other buttons
        navButtons.forEach(btn => btn.classList.remove('active'));
        // Activate the clicked button
        button.classList.add('active');

        // --- This is the critical part ---
        // Get the view ID *directly* from the clicked button's attribute.
        const viewId = button.getAttribute('data-view');

        // Call the function to switch to the correct view.
        switchView(viewId);

        // Run view-specific updates AFTER switching.
        if (viewId === 'column-bonfire') {
            if (window.updateHotTopics) {
                window.updateHotTopics();
            }
        } else if (viewId === 'column-controls') {
            syncTopics();
            generateTopicSuggestions(); // Kick off the suggestion process
        }
    });
});

    if (composeButton) {
      composeButton.addEventListener('click', () => {
        composeModal.style.display = 'flex';
        const desktopInput = document.getElementById('post-input');
        const mobileInput = document.getElementById('mobile-post-input');
        if (desktopInput && mobileInput) {
          mobileInput.value = desktopInput.value;
          updateMobileCharCount();
        }

        // Sync image preview fully (dataset, src, and visibility)
        const desktopPreview = document.getElementById('image-preview');
        const mobilePreview = document.getElementById('mobile-image-preview');
        const desktopImg = document.getElementById('preview-img');
        const mobileImg = document.getElementById('mobile-preview-img');
        if (desktopPreview && mobilePreview && desktopImg && mobileImg) {
          if (desktopPreview.dataset.imageData) {
            mobilePreview.dataset.imageData = desktopPreview.dataset.imageData;
            mobileImg.src = desktopImg.src;  // Sync src
            mobilePreview.style.display = desktopPreview.style.display;  // Sync visibility
          }
        }

        setTimeout(() => mobileInput.focus(), 100);
      });
    }

  if (closeComposeButton) {
    closeComposeButton.addEventListener('click', closeMobileCompose);
  }

  if (composeModal) {
    composeModal.addEventListener('click', (e) => {
      if (e.target === composeModal) {
        closeMobileCompose();
      }
    });
  }

  const mobileInput = document.getElementById('mobile-post-input');
  if (mobileInput) {
    mobileInput.addEventListener('input', updateMobileCharCount);
  }

  setupSwipeGestures();
  setupPullToRefresh();
  switchView('column-feed');
}

function closeMobileCompose() {
  const composeModal = document.getElementById('compose-modal-overlay');
  composeModal.style.display = 'none';
  // Clear the input
  const mobileInput = document.getElementById('mobile-post-input');
  if (mobileInput) {
    mobileInput.value = '';
    updateMobileCharCount();
  }
  // Clear image preview
  removeMobileImage();
}

function updateMobileCharCount() {
  const input = document.getElementById('mobile-post-input');
  const counter = document.getElementById('mobile-char-current');
  if (input && counter) {
    counter.textContent = input.value.length;
  }
}

// Mobile image handling
async function handleMobileImageSelect(input) {
  const file = input.files[0];
  if (!file) return;

  try {
    const base64 = await handleImageUpload(file);
    const toxic = await window.isImageToxic(base64);
    if (toxic) {
      notify(`Image appears to contain ${toxic.toLowerCase()} content`);
      input.value = '';
      return;
    }
    document.getElementById('mobile-preview-img').src = base64;
    document.getElementById('mobile-image-preview').style.display = 'block';
    document.getElementById('mobile-image-preview').dataset.imageData = base64;
  } catch (e) {
    notify(e.message);
  }
}

function removeMobileImage() {
  const preview = document.getElementById('mobile-image-preview');
  const input = document.getElementById('mobile-image-input');
  if (preview) {
    preview.style.display = 'none';
    preview.dataset.imageData = '';
  }
  if (input) {
    input.value = '';
  }
}



// Swipe gesture support
function setupSwipeGestures() {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchEndX = 0;
  let touchEndY = 0;

  const minSwipeDistance = 50;
  const swipeRatio = 0.5; // Horizontal movement must be at least 50% more than vertical

  document.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;
    handleSwipe();
  }, { passive: true });

  function handleSwipe() {
    const deltaX = touchStartX - touchEndX;
    const deltaY = Math.abs(touchStartY - touchEndY);
    const absDeltaX = Math.abs(deltaX);

    // Check if it's a horizontal swipe
    if (absDeltaX > minSwipeDistance && absDeltaX > deltaY * swipeRatio) {
      const navButtons = document.querySelectorAll('.nav-button');
      const currentIndex = Array.from(navButtons).findIndex(btn => btn.classList.contains('active'));
      
      if (deltaX > 0 && currentIndex < navButtons.length - 1) {
        // Swipe left - next view
        navButtons[currentIndex + 1].click();
        showSwipeIndicator('next');
      } else if (deltaX < 0 && currentIndex > 0) {
        // Swipe right - previous view
        navButtons[currentIndex - 1].click();
        showSwipeIndicator('previous');
      }
    }
  }
}

function showSwipeIndicator(direction) {
  // Create indicator if it doesn't exist
  let indicator = document.querySelector('.swipe-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'swipe-indicator';
    document.body.appendChild(indicator);
  }

  indicator.textContent = direction === 'next' ? '→' : '←';
  indicator.classList.add('show');
  
  setTimeout(() => {
    indicator.classList.remove('show');
  }, 500);
}


// Helper function to get a user's reputation score by their handle.
function getReputationByHandle(handle) {
    const { peerManager } = getServices();
    if (!peerManager || !state.peerIdentities) return 0;

    // Find the peerId associated with the handle
    for (const [peerId, identity] of state.peerIdentities) {
        if (identity.handle === handle) {
            return peerManager.getScore(peerId);
        }
    }
    // Check if the handle belongs to the current user
    if (state.myIdentity && state.myIdentity.handle === handle) {
        // PeerManager doesn't score the local user, so we can assign a default medium score.
        return 500; // Default reputation for self
    }

    return 0; // Return 0 if handle not found among connected peers
}

// Helper to find popular posts from outside a user's typical topics for feed diversification.
function getExplorationPosts(existingFeedIds) {
    const myTopics = state.subscribedTopics;
    const candidates = Array.from(state.posts.values())
        .filter(post => {
            if (existingFeedIds.has(post.id)) return false;
            const postTopics = state.scribe ? state.scribe.extractTopics(post.content) : [];
            return !postTopics.some(t => myTopics.has(t));
        })
        .map(post => ({
            post: post,
            score: (post.carriers.size + post.replies.size * 2) // Score by "heat"
        }))
        .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) return [];
    if (candidates.length === 1) return [candidates[0]];

    const topTwo = [candidates[0]];
    const secondCandidate = candidates.slice(1).find(c => c.post.author !== topTwo[0].post.author);
    if (secondCandidate) {
        topTwo.push(secondCandidate);
    }

    return topTwo;
}

// Pull to refresh
function setupPullToRefresh() {
  const feedView = document.getElementById('column-feed');
  if (!feedView) return;

  let pullStartY = 0;
  let isPulling = false;

  feedView.addEventListener('touchstart', (e) => {
    if (feedView.scrollTop === 0) {
      pullStartY = e.touches[0].clientY;
      isPulling = true;
    }
  }, { passive: true });

  feedView.addEventListener('touchmove', (e) => {
    if (!isPulling) return;

    const pullDistance = e.touches[0].clientY - pullStartY;
    if (pullDistance > 0 && feedView.scrollTop === 0) {
      e.preventDefault();
      
      // Show pull to refresh indicator
      if (pullDistance > 400) {
        showPullToRefreshIndicator();
      }
    }
  }, { passive: false });

  feedView.addEventListener('touchend', (e) => {
    if (!isPulling) return;

    const pullDistance = e.changedTouches[0].clientY - pullStartY;
    if (pullDistance > 400) {
      // Trigger refresh
      location.reload();
    }
    
    isPulling = false;
    hidePullToRefreshIndicator();
  }, { passive: true });
}

// Mobile topic management
function subscribeToTopicMobile() {
  const input = document.getElementById('mobile-topic-input');
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
  
  // Update both desktop and mobile UI
  addTopicToUI(topic);
  addTopicToMobileUI(topic);
  updateTopicFilter();
  saveTopicSubscriptions();
  input.value = '';
  notify(`Subscribed to ${topic}`);

  if (state.scribe) {
    state.scribe.subscribe(topic).catch(e => console.error('Subscribe failed:', e));
  }
}

function addTopicToMobileUI(topic) {
  const container = document.getElementById('mobile-subscribed-topics');
  if (!container) return;
  
  const existing = container.querySelector(`[data-topic="${topic}"]`);
  if (existing) return;

  const tag = document.createElement('div');
  tag.className = 'topic-tag active';
  tag.dataset.topic = topic;
  tag.textContent = topic;
  tag.onclick = () => toggleTopicMobile(topic);

  container.appendChild(tag);
}

function toggleTopicMobile(topic) {
  const tag = document.querySelector(`#mobile-subscribed-topics [data-topic="${topic}"]`);
  if (!tag) return;

  if (state.subscribedTopics.has(topic)) {
    if (state.scribe) {
      state.scribe.unsubscribe(topic);
    }
    state.subscribedTopics.delete(topic);
    tag.classList.remove('active');
    notify(`Unsubscribed from ${topic}`);
    
    // Also update desktop UI
    const desktopTag = document.querySelector(`#subscribed-topics [data-topic="${topic}"]`);
    if (desktopTag) desktopTag.classList.remove('active');
  } else {
    if (state.scribe) {
      state.scribe.subscribe(topic).catch(e => console.error('Subscribe failed:', e));
    }
    state.subscribedTopics.add(topic);
    tag.classList.add('active');
    notify(`Resubscribed to ${topic}`);
    
    // Also update desktop UI
    const desktopTag = document.querySelector(`#subscribed-topics [data-topic="${topic}"]`);
    if (desktopTag) desktopTag.classList.add('active');
  }

  updateTopicFilter();
  saveTopicSubscriptions();
  applyTopicFilter();
}


function showPullToRefreshIndicator() {
  let indicator = document.querySelector('.pull-to-refresh');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'pull-to-refresh';
    indicator.innerHTML = '<div class="spinner"></div>';
    document.getElementById('column-feed').appendChild(indicator);
  }
  indicator.classList.add('active');
}

function hidePullToRefreshIndicator() {
  const indicator = document.querySelector('.pull-to-refresh');
  if (indicator) {
    indicator.classList.remove('active');
  }
}

function getLivingPostValues() {
    if (!lpCodeEditor) return null;
    return {
        code: lpCodeEditor.getValue(),
        state: lpStateEditor.getValue(),
        renderer: lpRendererEditor.getValue()
    };
}

function updateLpPreview() {
  if (!lpCodeEditor || !lpStateEditor || !lpRendererEditor) return;

  const renderer = lpRendererEditor.getValue();
  const stateStr = lpStateEditor.getValue();
  const frame = document.getElementById('lp-preview-frame');
  const errorEl = document.getElementById('lp-preview-error');
  if (!frame || !errorEl) return;

  errorEl.textContent = '';

  try {
    const lpState = JSON.parse(stateStr || '{}');

    const renderedHtml = Mustache.render(renderer, lpState);
    const sanitizedHtml = DOMPurify.sanitize(renderedHtml, {
      ALLOWED_TAGS: [
        'div','span','p','ul','ol','li','strong','em','b','i','small','br','hr',
        'a','button','code','pre','canvas'
      ],
      ALLOWED_ATTR: ['href','title','class','data-input','aria-label','role','id','width','height','data-lp-canvas'],
      FORBID_TAGS: [
        'img','picture','source','video','audio','track','iframe','svg',
        'object','embed','link','style'
      ],
      FORBID_ATTR: [
        'style','src','srcset','poster','xlink:href','background','data'
      ],
      ALLOWED_URI_REGEXP: /^(https?:|#)/i
    });

    frame.srcdoc = `<style>body{font-family:sans-serif;color:#333}</style>${sanitizedHtml}`;

    // draw to canvas if LP provided gfx
    setTimeout(() => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const cvs = doc.querySelector('canvas[data-lp-canvas]');
                   if (!cvs) return;
            
            if (lpState && lpState.sim && lpState.sim.type === 'platformer') {
              import('./engine-sim-platformer.js').then(mod => {
                if (mod && typeof mod.mountPlatformer === 'function') {
                  mod.mountPlatformer(cvs, lpState.sim, {});
                }
              });
            } else if (lpState && lpState.gfx) {
              drawGfxIntoCanvas(cvs, lpState.gfx, { onInput: (ev) => console.debug('[LP preview input]', ev) });
            }
        } catch (e) { console.warn('[LP preview] canvas draw failed:', e); }
      }
    }, 0);
  } catch (e) {
    errorEl.textContent = 'Error: ' + e.message;
    frame.srcdoc = '';
  }
}

// Clears LP title, editors, and preview safely
function clearLivingPostEditors() {
  try {
    const titleEl = document.getElementById('lp-title-input');
    if (titleEl) titleEl.value = '';
    if (typeof lpCodeEditor !== 'undefined' && lpCodeEditor) lpCodeEditor.setValue('');
    if (typeof lpStateEditor !== 'undefined' && lpStateEditor) lpStateEditor.setValue('');
    if (typeof lpRendererEditor !== 'undefined' && lpRendererEditor) lpRendererEditor.setValue('');
    const frame = document.getElementById('lp-preview-frame');
    if (frame) frame.srcdoc = '';
    const errEl = document.getElementById('lp-preview-error');
    if (errEl) errEl.textContent = '';
  } catch (e) {
    console.warn('[LP] Failed to clear editors:', e);
  }
}


function initializeLivingPostComposer() {
    const commonConfig = {
        lineNumbers: true,
        theme: "material-darker",
        lineWrapping: true,
    };

    lpCodeEditor = CodeMirror.fromTextArea(document.getElementById('lp-code-editor-textarea'), {
        ...commonConfig,
        mode: "javascript",
    });

    lpStateEditor = CodeMirror.fromTextArea(document.getElementById('lp-state-editor-textarea'), {
        ...commonConfig,
        mode: { name: "javascript", json: true },
    });

    lpRendererEditor = CodeMirror.fromTextArea(document.getElementById('lp-renderer-editor-textarea'), {
        ...commonConfig,
        mode: "htmlmixed",
    });

    // Add default content to guide the user
    if (!lpCodeEditor.getValue()) {
      lpCodeEditor.setValue(`
// Crowd Dungeon — ES5, VM-safe (no DOM, no network).
// Exposed helpers: getState(), setState(), getInteraction(), log()
// 2025(c) CopyLeft - Publius Pseudis - GNU GPL v3
function ensureInit(st) {
  if (!st || typeof st !== 'object') st = {};
  if (!st.map) {
    st.map = [
      "###########",
      "#....#....#",
      "#.##.#.##.#",
      "#.#..@..#.#",
      "#.##.#.##.#",
      "#....#..E.#",
      "###########"
    ];
    st.width  = st.map[0].length;
    st.height = st.map.length;
    st.pos = { x: 5, y: 3 };  // matches '@' in the map
    st.exit = { x: 9, y: 5 }; // 'E' in the map
    st.votes = { U:0, D:0, L:0, R:0 };
    st.threshold = 3; // votes needed to move
    st.steps = 0;
    st.done = false;
    st.history = [{ x: st.pos.x, y: st.pos.y }];
    st.msg = "Vote on a direction. First to reach " + st.threshold + " moves!";
  }
  // derived render string
  st.display = renderMap(st);
  return st;
}

function renderMap(st) {
  var rows = [];
  for (var y = 0; y < st.height; y++) {
    var row = st.map[y].split('');
    // draw exit then player so player shows if overlapping when finished
    row[st.exit.x] = 'E';
    row[st.pos.x === st.exit.x && st.pos.y === y ? st.pos.x : st.pos.x] = row[st.pos.x];
    row[st.pos.x] = (y === st.pos.y) ? '@' : row[st.pos.x];
    rows.push(row.join(''));
  }
  return rows.join('\n');
}

function tryMove(st, dir) {
  var dx = 0, dy = 0;
  if (dir === 'U') dy = -1;
  else if (dir === 'D') dy = 1;
  else if (dir === 'L') dx = -1;
  else if (dir === 'R') dx = 1;

  var nx = st.pos.x + dx;
  var ny = st.pos.y + dy;

  if (ny < 0 || ny >= st.height || nx < 0 || nx >= st.width) {
    st.msg = "Ouch! That's a wall.";
    return;
  }
  if (st.map[ny].charAt(nx) === '#') {
    st.msg = "Bumped a wall. Try another path.";
    return;
  }
  st.pos = { x: nx, y: ny };
  st.steps += 1;
  st.history.push({ x: nx, y: ny });
  if (st.history.length > 50) st.history.shift();

  if (st.pos.x === st.exit.x && st.pos.y === st.exit.y) {
    st.done = true;
    st.msg = "🎉 Escaped in " + st.steps + " steps! Press Reset to run it again.";
  } else {
    st.msg = "Moved " + dir + ". Keep going!";
  }
}

function tallyAndMaybeMove(st) {
  // Move once any direction reaches threshold; then reset vote bucket
  var dirs = ['U','D','L','R'];
  for (var i=0; i<dirs.length; i++) {
    var k = dirs[i];
    if (st.votes[k] >= st.threshold) {
      tryMove(st, k);
      st.votes = { U:0, D:0, L:0, R:0 };
      break;
    }
  }
}

function onInteract() {
  var st = ensureInit(getState());
  var inter = getInteraction() || {};
  var input = inter.input || {};

  if (!st.votes) st.votes = { U:0, D:0, L:0, R:0 };

  if (input.action === 'vote' && !st.done) {
    var d = input.dir;
    if (d === 'U' || d === 'D' || d === 'L' || d === 'R') {
      st.votes[d] = (st.votes[d] || 0) + 1;
      st.msg = "Voted " + d + " (" + st.votes[d] + "/" + st.threshold + ")";
      tallyAndMaybeMove(st);
    }
  } else if (input.action === 'undo') {
    if (st.history && st.history.length > 1 && !st.done) {
      st.history.pop();
      var last = st.history[st.history.length-1];
      st.pos = { x: last.x, y: last.y };
      st.steps = Math.max(0, st.steps - 1);
      st.votes = { U:0, D:0, L:0, R:0 };
      st.msg = "Undid last move.";
    }
  } else if (input.action === 'reset') {
    // Reinitialize but keep the same map & exit
    var fresh = {};
    fresh.map = st.map.slice(0);
    fresh.width = st.width; fresh.height = st.height;
    fresh.exit = { x: st.exit.x, y: st.exit.y };
    fresh.pos = { x: 5, y: 3 };
    fresh.votes = { U:0, D:0, L:0, R:0 };
    fresh.threshold = st.threshold;
    fresh.steps = 0; fresh.done = false;
    fresh.history = [{ x: fresh.pos.x, y: fresh.pos.y }];
    fresh.msg = "Fresh run. Vote to move!";
    st = fresh;
  } else if (input.action === 'threshold') {
    // Adjust vote threshold (2..6)
    var t = +input.value;
    if (t >= 2 && t <= 6) {
      st.threshold = t;
      st.votes = { U:0, D:0, L:0, R:0 };
      st.msg = "Threshold set to " + t + ".";
    }
  }

  st.display = renderMap(st);
  setState(st);
}

function onLoad() {
  // No-op: render happens from state.
}
`);
    }

    if (!lpStateEditor.getValue()) {
      lpStateEditor.setValue(`
{
  "map": [
    "###########",
    "#....#....#",
    "#.##.#.##.#",
    "#.#..@..#.#",
    "#.##.#.##.#",
    "#....#..E.#",
    "###########"
  ],
  "width": 11,
  "height": 7,
  "pos": { "x": 5, "y": 3 },
  "exit": { "x": 9, "y": 5 },
  "votes": { "U": 0, "D": 0, "L": 0, "R": 0 },
  "threshold": 3,
  "steps": 0,
  "done": false,
  "history": [{ "x": 5, "y": 3 }],
  "msg": "Vote on a direction. First to reach 3 moves!",
  "display": "###########\n#....#....#\n#.##.#.##.#\n#.#..@..#.#\n#.##.#.##.#\n#....#..E.#\n###########"
}
      `);
    }
    
    if (!lpRendererEditor.getValue()) {
      lpRendererEditor.setValue(`
<div class="lp crowd-dungeon">
  <div class="header">
    <strong>🗝️ Crowd Dungeon</strong>
    <span> — escape together</span>
  </div>

  <div class="status">
    <p>{{ msg }}</p>
    <p>Steps: <strong>{{ steps }}</strong> • Threshold: <strong>{{ threshold }}</strong></p>
    <p>Votes — U: <strong>{{ votes.U }}</strong> D: <strong>{{ votes.D }}</strong> L: <strong>{{ votes.L }}</strong> R: <strong>{{ votes.R }}</strong></p>
  </div>

  <pre class="map">{{ display }}</pre>

  <div class="controls" role="group" aria-label="movement">
    <button data-input='{"action":"vote","dir":"U"}'>↑ Vote Up</button>
    <button data-input='{"action":"vote","dir":"L"}'>← Vote Left</button>
    <button data-input='{"action":"vote","dir":"R"}'>Vote Right →</button>
    <button data-input='{"action":"vote","dir":"D"}'>Vote Down ↓</button>
  </div>

  <div class="tools" role="group" aria-label="tools">
    <button data-input='{"action":"undo"}'>Undo</button>
    <button data-input='{"action":"reset"}'>Reset</button>
    <span> | Set threshold:</span>
    <button data-input='{"action":"threshold","value":2}'>2</button>
    <button data-input='{"action":"threshold","value":3}'>3</button>
    <button data-input='{"action":"threshold","value":4}'>4</button>
    <button data-input='{"action":"threshold","value":5}'>5</button>
    <button data-input='{"action":"threshold","value":6}'>6</button>
  </div>
</div>
`);
    }

    lpCodeEditor.on('change', updateLpPreview);
    lpStateEditor.on('change', updateLpPreview);
    lpRendererEditor.on('change', updateLpPreview);
    
    // Initial render
    updateLpPreview();
}

//event listeners for maximizing panes
    document.querySelectorAll('.lp-maximize-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const paneType = btn.dataset.pane;
            const grid = document.querySelector('.lp-editor-grid');
            const targetPane = document.querySelector(`.lp-editor-pane[data-pane="${paneType}"]`);

            const isAlreadyMaximized = targetPane.classList.contains('maximized');

            grid.classList.toggle('is-maximized', !isAlreadyMaximized);
            document.querySelectorAll('.lp-editor-pane').forEach(p => p.classList.remove('maximized'));
            if (!isAlreadyMaximized) targetPane.classList.add('maximized');
        });
    });


// Expose mobile functions to global scope
window.closeMobileCompose = closeMobileCompose;
window.handleMobileImageSelect = handleMobileImageSelect;
window.removeMobileImage = removeMobileImage;
window.subscribeToTopicMobile = subscribeToTopicMobile;



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
    closeProfile,
    updateHotTopics,
    initializeLivingPostComposer,
    getLivingPostValues,
    clearLivingPostEditors
};
