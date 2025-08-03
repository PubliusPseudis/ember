import { state } from './state.js';
import { generateId, JSONStringifyWithBigInt, JSONParseWithBigInt, base64ToArrayBuffer } from './utils.js';
import { Post } from './models/post.js';
import { LocalIdentity } from './models/local-identity.js';

export class StateManager {
  constructor(dependencies = {}) {
    this.imageStore = dependencies.imageStore;
    this.peerManager = dependencies.peerManager;
    this.renderPost = dependencies.renderPost;
    this.dbName = 'EmberNetwork';
    this.version =3; //v3 has DM permissions and encrypted storage for local identity
    this.db = null;
  }
  async saveDMPermissions() {
      if (!this.db) return;
      
      try {
        const transaction = this.db.transaction(['dmPermissions'], 'readwrite');
        const store = transaction.objectStore('dmPermissions');
        
        // Clear existing
        await new Promise((resolve, reject) => {
          const clearReq = store.clear();
          clearReq.onsuccess = resolve;
          clearReq.onerror = reject;
        });
        
        // Save current permissions
        for (const [handle, permission] of state.dmPermissions) {
          await new Promise((resolve, reject) => {
            const req = store.put({ 
              handle, 
              ...permission 
            });
            req.onsuccess = resolve;
            req.onerror = reject;
          });
        }
        
        console.log(`[Storage] Saved ${state.dmPermissions.size} DM permissions`);
      } catch (error) {
        console.error('[Storage] Failed to save DM permissions:', error);
      }
    }

    async loadDMPermissions() {
      if (!this.db) return;
      
      try {
        const transaction = this.db.transaction(['dmPermissions'], 'readonly');
        const store = transaction.objectStore('dmPermissions');
        const request = store.getAll();
        
        return new Promise((resolve) => {
          request.onsuccess = () => {
            const permissions = request.result;
            permissions.forEach(perm => {
              const { handle, ...data } = perm;
              state.dmPermissions.set(handle, data);
            });
            console.log(`[Storage] Loaded ${permissions.length} DM permissions`);
            resolve();
          };
          request.onerror = (event) => {
            console.error("[Storage] Failed to load DM permissions:", event.target.error);
            resolve();
          };
        });
      } catch (error) {
        console.error('[Storage] Failed to load DM permissions:', error);
      }
    }
  async clearLocalData() {
      if (confirm('This will clear all saved posts and reset your identity. Continue?')) {
        if (this.db) {
          this.db.close();
        }
        
        // Clear the in-memory state FIRST ---
        state.myIdentity = null;

        // Now clear persistent storage
        await indexedDB.deleteDatabase(this.dbName);
        localStorage.clear();
        
        // Finally, reload the page
        location.reload();
      }
    }
  
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        

        //DM permissions
        if (!db.objectStoreNames.contains('dmPermissions')) {
          const permStore = db.createObjectStore('dmPermissions', { keyPath: 'handle' });
          permStore.createIndex('status', 'status', { unique: false });
        }
        
        // Posts store
        if (!db.objectStoreNames.contains('posts')) {
          const postsStore = db.createObjectStore('posts', { keyPath: 'id' });
          postsStore.createIndex('timestamp', 'timestamp', { unique: false });
          postsStore.createIndex('parentId', 'parentId', { unique: false });
        }
        
        // Image Chunks store
        if (!db.objectStoreNames.contains('imageChunks')) {
            // The keyPath will be the chunk's hash
            db.createObjectStore('imageChunks', { keyPath: 'hash' });
        }
        
        // User state store (identity, preferences)
        if (!db.objectStoreNames.contains('userState')) {
          db.createObjectStore('userState', { keyPath: 'key' });
        }
        
        // Peer reputation store
        if (!db.objectStoreNames.contains('peerScores')) {
          db.createObjectStore('peerScores', { keyPath: 'peerId' });
        }
        
        if (!db.objectStoreNames.contains('dhtRoutingTable')) {
            db.createObjectStore('dhtRoutingTable', { keyPath: 'bucketIndex' });
        }
        if (!db.objectStoreNames.contains('dhtStorage')) {
            db.createObjectStore('dhtStorage', { keyPath: 'key' });
        }
        
      // pending messages store
      if (!db.objectStoreNames.contains('pendingMessages')) {
        const pendingStore = db.createObjectStore('pendingMessages', { keyPath: 'id' });
        pendingStore.createIndex('recipient', 'recipient', { unique: false });
        pendingStore.createIndex('sender', 'sender', { unique: false });
        pendingStore.createIndex('timestamp', 'timestamp', { unique: false });
        pendingStore.createIndex('status', 'status', { unique: false });
      }
      
      //  delivery receipts store
      if (!db.objectStoreNames.contains('messageReceipts')) {
        const receiptsStore = db.createObjectStore('messageReceipts', { keyPath: 'messageId' });
        receiptsStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      
    };
    });
  }
    
  async savePosts() {
    if (!this.db) return;
    
    const transaction = this.db.transaction(['posts'], 'readwrite');
    const store = transaction.objectStore('posts');
    
    // Clear existing posts first
    await new Promise((resolve) => {
      const clearReq = store.clear();
      clearReq.onsuccess = resolve;
    });
    
    // Save all current posts
    for (const [id, post] of state.posts) {
      const postData = post.toJSON();
      // Include metadata about our explicit carries
      postData.wasExplicitlyCarried = state.explicitlyCarrying.has(id);
      postData.lastSeen = Date.now();
      try {
            store.add(postData);
      } catch(e) {
            if (e.name === 'QuotaExceededError') {
                console.error("Storage quota exceeded while saving posts. Aborting.");
                notify("Storage is full. Cannot save session.", 5000);
                transaction.abort();
                return; // Exit the loop
            }
        }
    }
  }
  
  async loadPosts() {
      if (!this.db) return;
      
      const transaction = this.db.transaction(['posts'], 'readonly');
      const store = transaction.objectStore('posts');
      const request = store.getAll();
      
      return new Promise((resolve) => {
        request.onsuccess = () => {
          const posts = request.result;
          const now = Date.now();
          let loadedCount = 0;
          
          posts.forEach(postData => {
            // Check if post is too old (24 hours)
            const age = now - postData.timestamp;
            if (age > 24 * 60 * 60 * 1000) return;
            
            // Check if post should still exist based on carriers
            if (postData.carriers.length === 0) return;
            
            // Recreate the post
            const post = Post.fromJSON(postData);            

            // Ensure trust properties are initialized
            if (!post.trustScore) post.trustScore = 0;
            if (!post.attesters) post.attesters = new Set();
            if (!post.attestationTimestamps) post.attestationTimestamps = new Map();

            // Queue for verification instead of marking as verified
            post.verified = true; //do we trust ourselves?
            //state.pendingVerification.set(post.id, post);

            // Decay carriers based on time away
            const hoursAway = Math.floor((now - postData.lastSeen) / (60 * 60 * 1000));
            const decayFactor = Math.max(0.5, 1 - (hoursAway * 0.1)); // Lose 10% per hour away
            
            // Randomly remove some carriers based on decay
            const carriersArray = [...post.carriers];
            const keepCount = Math.max(1, Math.floor(carriersArray.length * decayFactor));
            
            // Keep our own carry if we explicitly carried it
            const mustKeep = postData.wasExplicitlyCarried ? [state.myIdentity.handle] : [];
            const others = carriersArray.filter(c => c !== state.myIdentity.handle);
            
            // Randomly select carriers to keep
            const shuffled = others.sort(() => Math.random() - 0.5);
            const kept = mustKeep.concat(shuffled.slice(0, keepCount - mustKeep.length));
            
            post.carriers = new Set(kept);
            
            // Only load if post still has carriers OR we explicitly carried it
            if (post.carriers.size > 0 || postData.wasExplicitlyCarried) {
              // *** Check if the post was already in pendingVerification from a previous load. ***
              // If so, we use the already-verified version we just created.
              if (state.pendingVerification.has(post.id)) {
                  state.pendingVerification.delete(post.id);
              }

              state.posts.set(post.id, post);
              if (this.renderPost) {
                this.renderPost(post); // Render the post immediately
              }

              if (postData.wasExplicitlyCarried) {
                state.explicitlyCarrying.add(post.id);
              }
              loadedCount++;
            }
          });
          
          console.log(`Loaded ${loadedCount} posts from storage (all marked as verified)`);
          resolve(loadedCount);
        };
      });
    }
  
  
  async saveImageChunks() {
        if (!this.db || !this.imageStore) return;

        const transaction = this.db.transaction(['imageChunks'], 'readwrite');
        const store = transaction.objectStore('imageChunks');

        // Clear old chunks first to manage storage size
        await new Promise((resolve) => {
            const clearReq = store.clear();
            clearReq.onsuccess = resolve;
        });

        // Save all current chunks from the imageStore
        for (const [hash, data] of this.imageStore.chunks) {
            store.add({ hash: hash, data: data });
        }
        console.log(`Saved ${this.imageStore.chunks.size} image chunks to storage.`);
    }

    async loadImageChunks() {
        if (!this.db || !this.imageStore) return;

        const transaction = this.db.transaction(['imageChunks'], 'readonly');
        const store = transaction.objectStore('imageChunks');
        const request = store.getAll();

        return new Promise((resolve) => {
            request.onsuccess = () => {
                const chunks = request.result;
                chunks.forEach(chunk => {
                    this.imageStore.chunks.set(chunk.hash, chunk.data);
                });
                console.log(`Loaded ${chunks.length} image chunks from storage.`);
                resolve(chunks.length);
            };
            request.onerror = (event) => {
                console.error("Failed to load image chunks:", event.target.error);
                resolve(0);
            };
        });
    }

  
  
  
async saveUserState() {
  if (!this.db) return;
  
  try {
    const transaction = this.db.transaction(['userState'], 'readwrite');
    const store = transaction.objectStore('userState');
    
    if (state.myIdentity) {
      // Ensure we have a LocalIdentity instance
      const localIdentity = state.myIdentity instanceof LocalIdentity ?
        state.myIdentity : new LocalIdentity(state.myIdentity);
      
      // The toJSON method now handles encrypted vs unencrypted properly
      await new Promise((resolve, reject) => {
        const req = store.put({ 
          key: 'identity', 
          value: JSON.stringify(localIdentity.toJSON())
        });
        req.onsuccess = resolve;
        req.onerror = reject;
      });
      
      console.log('Saved identity to storage (encrypted:', localIdentity.isEncrypted(), ')');
    }

    // Save theme preference
    const currentTheme = localStorage.getItem('ephemeral-theme') || 'dark';
    await new Promise((resolve, reject) => {
      const req = store.put({ 
        key: 'theme', 
        value: currentTheme
      });
      req.onsuccess = resolve;
      req.onerror = reject;
    });
    
    // Save explicitly carried posts
    if (state.explicitlyCarrying) {
      await new Promise((resolve, reject) => {
        const req = store.put({ 
          key: 'explicitlyCarrying', 
          value: Array.from(state.explicitlyCarrying)
        });
        req.onsuccess = resolve;
        req.onerror = reject;
      });
      
      console.log(`Saved ${state.explicitlyCarrying.size} explicitly carried posts`);
    }
    
  } catch (error) {
    console.error('Error saving user state:', error);
    
    // If we hit quota exceeded, try to clear some data
    if (error.name === 'QuotaExceededError') {
      console.warn('Storage quota exceeded, attempting cleanup...');
      await this.cleanup();
      // Could retry save here if desired
    }
  }
}
  
    async loadUserState() {
      if (!this.db) return;
      try {
          const transaction = this.db.transaction(['userState'], 'readonly');
          const store = transaction.objectStore('userState');
  
          const themePromise = new Promise((resolve, reject) => {
              const req = store.get('theme');
              req.onsuccess = () => resolve(req.result);
              req.onerror = (event) => reject(event.target.error);
          });
  
          const carryPromise = new Promise((resolve, reject) => {
              const req = store.get('explicitlyCarrying');
              req.onsuccess = () => resolve(req.result);
              req.onerror = (event) => reject(event.target.error);
          });
  
          const [themeResult, carryResult] = await Promise.all([themePromise, carryPromise]);
  
          // Process theme result
          if (themeResult && themeResult.value) {
              const theme = themeResult.value;
              localStorage.setItem('ephemeral-theme', theme);
              if (typeof applyTheme === 'function') {
                  applyTheme(theme);
              }
              console.log('Loaded theme:', theme);
          }
  
          // Process explicitly carried posts result
          if (carryResult && carryResult.value) {
              state.explicitlyCarrying = new Set(carryResult.value);
              console.log(`Loaded ${state.explicitlyCarrying.size} explicitly carried posts`);
          } else {
              state.explicitlyCarrying = new Set();
          }
      } catch (error) {
          console.error("Error loading user state:", error);
          state.explicitlyCarrying = new Set();
      }
    }
  
async savePeerScores() {
  if (!this.db || !this.peerManager) return;
  
  try {
    const transaction = this.db.transaction(['peerScores'], 'readwrite');
    const store = transaction.objectStore('peerScores');
    
    // Clear existing scores first
    await new Promise((resolve, reject) => {
      const clearReq = store.clear();
      clearReq.onsuccess = resolve;
      clearReq.onerror = reject;
    });
    
    // Save each score with a valid string key
    for (const [peerId, score] of this.peerManager.scores) {
      // Ensure peerId is a string
      const keyString = this.peerManager.normalizePeerId(peerId);
      if (!keyString) continue; // Skip invalid peer IDs
      
      try {
        await new Promise((resolve, reject) => {
          const req = store.put({ 
            peerId: keyString, 
            ...score 
          });
          req.onsuccess = resolve;
          req.onerror = reject;
        });
      } catch (e) {
        console.error(`Failed to save score for peer ${keyString}:`, e);
      }
    }
  } catch (error) {
    console.error('Error saving peer scores:', error);
  }
}
  
  async loadPeerScores() {
    if (!this.db || !this.peerManager) return;
    
    const transaction = this.db.transaction(['peerScores'], 'readonly');
    const store = transaction.objectStore('peerScores');
    const request = store.getAll();
    
    return new Promise((resolve) => {
      request.onsuccess = () => {
        const scores = request.result;
        scores.forEach(score => {
          const { peerId, ...data } = score;
          this.peerManager.scores.set(peerId, data);
        });
        console.log(`Loaded ${scores.length} peer scores`);
        resolve();
      };
    });
  }
  
  // Clean up old data
  async cleanup() {
    if (!this.db) return;
    
    const transaction = this.db.transaction(['posts'], 'readwrite');
    const store = transaction.objectStore('posts');
    const index = store.index('timestamp');
    
    // Delete posts older than 7 days
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const range = IDBKeyRange.upperBound(cutoff);
    
    index.openCursor(range).onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  }
  
  async storePendingMessage(recipientHandle, messageText, senderHandle, encrypted = null) {
      if (!this.db) return null;
      try {
        const messageId = generateId();
        const pendingMessage = {
          id: messageId,
          recipient: recipientHandle,
          sender: senderHandle,
          message: messageText,
          encrypted: encrypted,
          timestamp: Date.now(),
          attempts: 0,
          lastAttempt: null,
          status: 'pending',
          expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
        };
        const transaction = this.db.transaction(['pendingMessages'], 'readwrite');
        const store = transaction.objectStore('pendingMessages');
        
        // FIX: Wrap the IDBRequest in a Promise
        await new Promise((resolve, reject) => {
            const request = store.add(pendingMessage);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        
        console.log(`[Storage] Stored pending message ${messageId} for ${recipientHandle}`);
        return messageId;
      } catch (error) {
        console.error('[Storage] Failed to store pending message:', error);
        return null;
      }
    }

    async getPendingMessagesFor(recipientHandle) {
      if (!this.db) return [];
      try {
        const transaction = this.db.transaction(['pendingMessages'], 'readonly');
        const store = transaction.objectStore('pendingMessages');
        const index = store.index('recipient');
        
        // FIX: Wrap the IDBRequest in a Promise
        const messages = await new Promise((resolve, reject) => {
            const request = index.getAll(recipientHandle);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        
        const now = Date.now();
        return messages.filter(msg => 
          msg.status === 'pending' && 
          msg.expiresAt > now
        );
      } catch (error) {
        console.error('[Storage] Failed to get pending messages:', error);
        return [];
      }
    }

    async getPendingMessagesFrom(senderHandle) {
      if (!this.db) return [];
      try {
        const transaction = this.db.transaction(['pendingMessages'], 'readonly');
        const store = transaction.objectStore('pendingMessages');
        const index = store.index('sender');
        
        // FIX: Wrap the IDBRequest in a Promise
        const messages = await new Promise((resolve, reject) => {
            const request = index.getAll(senderHandle);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        return messages.filter(msg => msg.status === 'pending');
      } catch (error) {
        console.error('[Storage] Failed to get pending messages from sender:', error);
        return [];
      }
    }

    async markMessageDelivered(messageId) {
      if (!this.db) return;
      try {
        const transaction = this.db.transaction(['pendingMessages', 'messageReceipts'], 'readwrite');
        const messagesStore = transaction.objectStore('pendingMessages');
        const receiptsStore = transaction.objectStore('messageReceipts');
        
        // FIX: Wrap the IDBRequest in a Promise
        const message = await new Promise((resolve, reject) => {
            const request = messagesStore.get(messageId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (message) {
          message.status = 'delivered';
          message.deliveredAt = Date.now();
          
          // FIX: Wrap subsequent requests in Promises
          await new Promise((resolve, reject) => {
              const request = messagesStore.put(message);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
          });
          
          await new Promise((resolve, reject) => {
              const request = receiptsStore.add({
                  messageId: messageId,
                  timestamp: Date.now(),
                  recipient: message.recipient
              });
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
          });

          console.log(`[Storage] Marked message ${messageId} as delivered`);
        }
      } catch (error) {
        console.error('[Storage] Failed to mark message as delivered:', error);
      }
    }

    async updateMessageAttempt(messageId) {
      if (!this.db) return;
      try {
        const transaction = this.db.transaction(['pendingMessages'], 'readwrite');
        const store = transaction.objectStore('pendingMessages');
        
        // FIX: Wrap the IDBRequest in a Promise
        const message = await new Promise((resolve, reject) => {
            const request = store.get(messageId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (message) {
          message.attempts++;
          message.lastAttempt = Date.now();
          
          if (message.attempts >= 10) {
            message.status = 'failed';
          }
          
          // FIX: Wrap the put request in a Promise
          await new Promise((resolve, reject) => {
              const request = store.put(message);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
          });
        }
      } catch (error) {
        console.error('[Storage] Failed to update message attempt:', error);
      }
    }

    async cleanupOldMessages() {
      if (!this.db) return;
      
      try {
        const transaction = this.db.transaction(['pendingMessages'], 'readwrite');
        const store = transaction.objectStore('pendingMessages');
        const messages = await store.getAll();
        
        const now = Date.now();
        let deletedCount = 0;
        
        for (const message of messages) {
          // Delete if: expired, delivered over 24h ago, or failed
          if (message.expiresAt < now ||
              (message.status === 'delivered' && now - message.deliveredAt > 86400000) ||
              message.status === 'failed') {
            await store.delete(message.id);
            deletedCount++;
          }
        }
        
        if (deletedCount > 0) {
          console.log(`[Storage] Cleaned up ${deletedCount} old messages`);
        }
      } catch (error) {
        console.error('[Storage] Failed to cleanup old messages:', error);
      }
    }
  async saveDHTState() {
  if (!this.db || !state.dht) return;
  
  try {
    const dhtState = state.dht.serialize();
    const transaction = this.db.transaction(['dhtRoutingTable', 'dhtStorage'], 'readwrite');
    const routingStore = transaction.objectStore('dhtRoutingTable');
    const storageStore = transaction.objectStore('dhtStorage');
    
    // Clear existing data
    await new Promise((resolve) => {
      const clearReq1 = routingStore.clear();
      clearReq1.onsuccess = resolve;
    });
    
    await new Promise((resolve) => {
      const clearReq2 = storageStore.clear();
      clearReq2.onsuccess = resolve;
    });
    
    // Save routing table (buckets)
    if (dhtState.buckets) {
      dhtState.buckets.forEach((bucket, index) => {
        if (bucket.length > 0) {
          routingStore.add({ bucketIndex: index, peers: bucket });
        }
      });
    }
    
    // Save DHT storage
    if (dhtState.storage) {
      dhtState.storage.forEach(([key, value]) => {
        storageStore.add({ key, value });
      });
    }
    
    console.log('[StateManager] Saved DHT state');
  } catch (error) {
    console.error('[StateManager] Failed to save DHT state:', error);
  }
}

async loadDHTState() {
  if (!this.db) return;
  
  try {
    const transaction = this.db.transaction(['dhtRoutingTable', 'dhtStorage'], 'readonly');
    const routingStore = transaction.objectStore('dhtRoutingTable');
    const storageStore = transaction.objectStore('dhtStorage');
    
    // Load routing table
    const bucketsData = await new Promise((resolve) => {
      const request = routingStore.getAll();
      request.onsuccess = () => resolve(request.result);
    });
    
    // Load storage
    const storageData = await new Promise((resolve) => {
      const request = storageStore.getAll();
      request.onsuccess = () => resolve(request.result);
    });
    
    // Wait for DHT to be initialized
    if (state.dht && bucketsData.length > 0) {
        // First, create a new, full, and valid array of 160 empty buckets.
        const buckets = new Array(160).fill(null).map(() => []);

        // Then, populate it with the data that was loaded from storage.
        bucketsData.forEach(item => {
          // Ensure the saved index is valid before assigning.
          if (item.bucketIndex >= 0 && item.bucketIndex < 160) {
            buckets[item.bucketIndex] = item.peers;
          }
        });
        const storage = storageData.map(item => [item.key, item.value]);

        // Deserialize the now-complete and valid state into the DHT instance.
        state.dht.deserialize({ buckets, storage });
        console.log('[StateManager] Loaded DHT state with', bucketsData.length, 'buckets and', storageData.length, 'keys');
    }
  } catch (error) {
    console.error('[StateManager] Failed to load DHT state:', error);
  }
}
  
}
