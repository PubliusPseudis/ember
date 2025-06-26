// ui.js
// This module contains all functions and variables responsible for
// interacting with the DOM, rendering content, and handling UI events.

// --- IMPORTS ---
import { state, imageStore, toggleCarry, createReply, createPostWithTopics, findRootPost, isImageToxic, isToxic } from './main.js';
import { CONFIG } from './config.js';


// --- LOCAL HELPERS ---
// Small helper functions that are only used by the UI.
const isReply = (post) => post && post.parentId;

// --- UI STATE & OBSERVERS ---
// Top-level constants and variables that manage UI state.
let bonfireUpdateTimeout;
let showAllShards = true;

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
function notify(msg, dur = 3000) {
  const n = document.createElement("div");
  n.className = "notification";
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => {
    n.style.animationDirection = "reverse";
    setTimeout(() => n.remove(), 300);
  }, dur);
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

  // This logic adds the topic tags to the post's HTML
  let topicsHtml = '';
  if (state.scribe) {
    const topics = state.scribe.extractTopics(p.content);
    if (topics.length > 0) {
      topicsHtml = `
          <div class="post-topics">
              ${topics.map(topic => `<span class="post-topic-tag" onclick="discoverAndFilterTopic('${topic}')">${topic}</span>`).join('')}
          </div>`;
    }
  }

  // *** FIX: Preserve existing replies container ***
  const existingRepliesContainer = el.querySelector('.replies-container');

el.innerHTML = `
    <div class="author">${p.author} ${verificationBadge}</div>
    <div class="content">${(p.content)}</div>
    ${imageHtml}
    ${topicsHtml}
    <div class="post-footer">
        <div class="carriers">
            <span class="heat-level">${heatLevel}</span>
            <span class="carrier-count">${carrierCount}</span>&nbsp;${carrierCount === 1 ? 'breath' : 'breaths'}
            ${hasReplies ? `<span class="thread-stats"><span class="thread-ember">🔥</span> ${threadSize} in thread</span>` : ''}
        </div>
        <div class="post-actions">
            <button class="carry-button ${mine ? 'withdrawing' : 'blowing'}" onclick="toggleCarry('${p.id}')">
                ${isAuthor ? "🔥 Your Ember" : (mine ? "💨 Withdraw" : "🌬️ Blow")}
            </button>
            <button class="reply-button" onclick="toggleReplyForm('${p.id}')">
                💬 Reply
            </button>
            ${hasReplies ? `<span class="collapse-thread" onclick="toggleThread('${p.id}')">[${el.classList.contains('collapsed') ? '+' : '-'}]</span>` : ''}
        </div>
    </div>
    <div id="reply-form-${p.id}" class="reply-compose" style="display: none;">
        <textarea id="reply-input-${p.id}" class="reply-input" placeholder="Add to the conversation..." maxlength="300"></textarea>
        <div class="reply-image-preview" id="reply-image-preview-${p.id}" style="display:none;">
            <img id="reply-preview-img-${p.id}" />
            <button onclick="removeReplyImage('${p.id}')">✕</button>
        </div>
        <div class="compose-footer">
            <input type="file" id="reply-image-input-${p.id}" accept="image/*" style="display:none;" onchange="handleReplyImageSelect(this, '${p.id}')" />
            <button onclick="document.getElementById('reply-image-input-${p.id}').click()" class="image-button">📷</button>
            <span class="char-count"><span id="reply-char-${p.id}">0</span>/${CONFIG.MAX_POST_SIZE}</span>
            <button onclick="createReply('${p.id}')" class="primary-button">🔥 Add Gas!</button>
        </div>
    </div>`;

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

  // --- FIX: UI and State updates now happen immediately ---
  // 1. Add to the local state.
  state.subscribedTopics.add(topic);
  
  // 2. Update the UI components.
  addTopicToUI(topic);
  updateTopicFilter();
  
  // 3. Persist the change and clear the input.
  saveTopicSubscriptions();
  input.value = '';
  notify(`Subscribed to ${topic}`);

  // --- Network action happens when possible ---
  // 4. Tell the P2P network to join the topic.
  if (state.scribe) {
    await state.scribe.subscribe(topic);
  } else {
    // This warning is for developers; the user experience is already handled.
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

    if (state.subscribedTopics.has(topic)) {
        if (topic === '#general') {
            notify("Cannot unsubscribe from #general");
            return;
        }
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
    removeReplyImage
};
