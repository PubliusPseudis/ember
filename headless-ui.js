// headless-ui.js
// A 'stub' version of the UI module for the headless node. Logs critical info.

export function notify(msg, dur, onClick) { 
  console.log(`[UI NOTIFY] ${msg}`); 
}

export function updateConnectionStatus(message, type = 'info') { 
  console.log(`[CONNECTION] ${type.toUpperCase()}: ${message}`); 
}

export function updateLoadingMessage(message) { 
  console.log(`[LOADING] ${message}`); 
}

// Visual functions - empty stubs since headless has no UI
export function renderPost(p) { }
export function refreshPost(p) { }
export function dropPost(id) { }
export function setupThemeToggle() { }
export function applyTheme(theme) { }
export function showConnectScreen() { }
export function updateAges() { }
export function scrollToPost(postId) { }
export function updateStatus() { console.log(`[STATUS] Posts: ${globalThis.state?.posts?.size || 0}, Peers: ${globalThis.state?.peers?.size || 0}`); }

// Topic management stubs
export function loadTopicSubscriptions() { }
export function updateTopicFilter() { }
export function addTopicToUI(topic) { console.log(`[TOPIC] Added ${topic} to subscriptions`); }
export function updateTopicStats() { }
export function subscribeToTopic() { }
export function filterByTopic() { }
export function setFeedMode() { }
export function discoverAndFilterTopic() { }
export function completeTopicSuggestion() { }

// Image handling stubs
export function handleImageSelect() { }
export function removeImage() { }
export function handleReplyImageSelect() { }
export function removeReplyImage() { }

// Reply/thread stubs
export function toggleReplyForm() { }
export function toggleThread() { }

// DM stubs - log for awareness
export function addMessageToConversation(handle, messageText, direction, timestamp) {
  console.log(`[DM] ${direction === 'sent' ? 'Sent to' : 'Received from'} ${handle}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
}

export function storeDMLocallyAndUpdateUI(otherHandle, messageText, direction) {
  console.log(`[DM] Message ${direction} with ${otherHandle}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
}

export function updateDMInbox() { }
export function updateUnreadBadge() { }

// Current DM recipient (needed by main.js)
export let currentDMRecipient = null;

// DM panel functions
export function openDMPanel(handle) {
  console.log(`[UI] Would open DM panel for ${handle} (no-op in headless mode)`);
}

export function closeDMPanel() {
  console.log(`[UI] Would close DM panel (no-op in headless mode)`);
}

export function sendDM() {
  console.log(`[UI] Would send DM (no-op in headless mode)`);
}

export function switchDrawer(drawerId) {
  console.log(`[UI] Would switch to drawer ${drawerId} (no-op in headless mode)`);
}
