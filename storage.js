import { generateId } from './utils.js';
import { state, imageStore } from './main.js'; 
import { Post } from './models/post.js';
import { peerManager } from './main.js';
import { renderPost } from './ui.js'; 

export class StateManager {
  constructor() {
    this.dbName = 'EmberNetwork';
    this.version = 2;
    this.db = null;
  }
  
    async clearLocalData() {
        if (confirm('This will clear all saved posts and reset your identity. Continue?')) {
          // Close the DB connection this manager is holding
          if (this.db) {
            this.db.close();
          }
          // Clear IndexedDB and localStorage
          await indexedDB.deleteDatabase(this.dbName);
          localStorage.clear();
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
              renderPost(post); // Render the post immediately

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
        if (!this.db || !imageStore) return;

        const transaction = this.db.transaction(['imageChunks'], 'readwrite');
        const store = transaction.objectStore('imageChunks');

        // Clear old chunks first to manage storage size
        await new Promise((resolve) => {
            const clearReq = store.clear();
            clearReq.onsuccess = resolve;
        });

        // Save all current chunks from the imageStore
        for (const [hash, data] of imageStore.chunks) {
            store.add({ hash: hash, data: data });
        }
        console.log(`Saved ${imageStore.chunks.size} image chunks to storage.`);
    }

    async loadImageChunks() {
        if (!this.db || !imageStore) return;

        const transaction = this.db.transaction(['imageChunks'], 'readonly');
        const store = transaction.objectStore('imageChunks');
        const request = store.getAll();

        return new Promise((resolve) => {
            request.onsuccess = () => {
                const chunks = request.result;
                chunks.forEach(chunk => {
                    imageStore.chunks.set(chunk.hash, chunk.data);
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
    
    const transaction = this.db.transaction(['userState'], 'readwrite');
    const store = transaction.objectStore('userState');
    
    // Save identity
    store.put({ 
      key: 'identity', 
      value: state.myIdentity 
    });
    
    // Save theme preference
    store.put({ 
      key: 'theme', 
      value: localStorage.getItem('ephemeral-theme') || 'dark' 
    });
    
    // Save explicitly carried posts
    store.put({ 
      key: 'explicitlyCarrying', 
      value: Array.from(state.explicitlyCarrying) 
    });
  }
  
    async loadUserState() {
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['userState'], 'readonly');
            const store = transaction.objectStore('userState');

            const identityReq = store.get('identity');
            const carryReq = store.get('explicitlyCarrying');

            let identityLoaded = false;
            let carryLoaded = false;

            const checkCompletion = () => {
                if (identityLoaded && carryLoaded) {
                    resolve(); // Resolve the promise only when both are done
                }
            };

            identityReq.onsuccess = () => {
                if (identityReq.result) {
                    state.myIdentity = identityReq.result.value;
                    console.log('Loaded identity from storage');
                }
                identityLoaded = true;
                checkCompletion();
            };

            carryReq.onsuccess = () => {
                if (carryReq.result) {
                    state.explicitlyCarrying = new Set(carryReq.result.value);
                }
                carryLoaded = true;
                checkCompletion();
            };

            identityReq.onerror = (event) => {
                console.error("Failed to load identity:", event.target.error);
                identityLoaded = true; // Mark as done even on error to not block forever
                checkCompletion();
            };

            carryReq.onerror = (event) => {
                console.error("Failed to load explicitly carried posts:", event.target.error);
                carryLoaded = true; // Mark as done even on error
                checkCompletion();
            };
        });
    }
  
  async savePeerScores() {
    if (!this.db || !peerManager) return;
    
    const transaction = this.db.transaction(['peerScores'], 'readwrite');
    const store = transaction.objectStore('peerScores');
    
    peerManager.scores.forEach((score, peerId) => {
      store.put({ peerId, ...score });
    });
  }
  
  async loadPeerScores() {
    if (!this.db || !peerManager) return;
    
    const transaction = this.db.transaction(['peerScores'], 'readonly');
    const store = transaction.objectStore('peerScores');
    const request = store.getAll();
    
    return new Promise((resolve) => {
      request.onsuccess = () => {
        const scores = request.result;
        scores.forEach(score => {
          const { peerId, ...data } = score;
          peerManager.scores.set(peerId, data);
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
