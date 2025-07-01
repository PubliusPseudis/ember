// stateless-manager.js
// A 'stub' that conforms to the StateManager interface but is stateless.

export class StatelessManager {
  constructor() {
    this.dbName = 'EmberNetwork-Headless';
    this.version = 2;
    this.db = null;
  }

  async init() {
    console.log("[StateManager] Initialized in stateless mode.");
    return Promise.resolve();
  }

  async clearLocalData() {
    console.log("[StateManager] Clear data requested (no-op in headless mode)");
    return Promise.resolve();
  }

  // Post management
  async savePosts() { 
    console.log("[StateManager] Skipping post save in stateless mode");
    return Promise.resolve(); 
  }
  
  async loadPosts() { 
    console.log("[StateManager] No posts to load in stateless mode");
    return Promise.resolve(0); 
  }

  // User state management
  async saveUserState() { 
    console.log("[StateManager] Skipping user state save in stateless mode");
    return Promise.resolve(); 
  }
  
  async loadUserState() { 
    console.log("[StateManager] No user state to load in stateless mode");
    return Promise.resolve(); 
  }

  // Peer management
  async savePeerScores() { 
    console.log("[StateManager] Skipping peer scores save in stateless mode");
    return Promise.resolve(); 
  }
  
  async loadPeerScores() { 
    console.log("[StateManager] No peer scores to load in stateless mode");
    return Promise.resolve(); 
  }

  // Image management
  async saveImageChunks() { 
    console.log("[StateManager] Skipping image chunks save in stateless mode");
    return Promise.resolve(); 
  }
  
  async loadImageChunks() { 
    console.log("[StateManager] No image chunks to load in stateless mode");
    return Promise.resolve(); 
  }

  // DHT state management
  async saveDHTState() { 
    console.log("[StateManager] Skipping DHT state save in stateless mode"); 
    return Promise.resolve(); 
  }
  
  async loadDHTState() { 
    console.log("[StateManager] Starting with a fresh DHT state in stateless mode"); 
    return Promise.resolve(); 
  }

  // Message management stubs
  async storePendingMessage(recipientHandle, messageText, senderHandle, encrypted = null) {
    console.log(`[StateManager] Would store pending message for ${recipientHandle} (stateless mode)`);
    return Promise.resolve(null);
  }

  async getPendingMessagesFor(recipientHandle) {
    return Promise.resolve([]);
  }

  async getPendingMessagesFrom(senderHandle) {
    return Promise.resolve([]);
  }

  async markMessageDelivered(messageId) {
    console.log(`[StateManager] Would mark message ${messageId} as delivered (stateless mode)`);
    return Promise.resolve();
  }

  async updateMessageAttempt(messageId) {
    console.log(`[StateManager] Would update attempt for message ${messageId} (stateless mode)`);
    return Promise.resolve();
  }

  async cleanupOldMessages() {
    console.log("[StateManager] No old messages to cleanup in stateless mode");
    return Promise.resolve();
  }

  // Cleanup
  async cleanup() { 
    console.log("[StateManager] Cleanup completed (stateless mode)");
    return Promise.resolve(); 
  }
}
