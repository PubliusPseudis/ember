import { state, imageStore } from './main.js'; 
import { Post } from './models/post.js';
import { peerManager } from './main.js';

export class StateManager {
  constructor() {
    this.dbName = 'EmberNetwork';
    this.version = 1;
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
      store.add(postData);
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
            post.verified = false;
            state.pendingVerification.set(post.id, post);

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
            
            // Only load if post still has carriers
            if (post.carriers.size > 0) {
              state.posts.set(post.id, post);
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
}
