import { sendPeer } from './network-manager.js';

// --- KADEMLIA DHT IMPLEMENTATION ---
export class KademliaDHT {
  constructor(nodeId) {
    this.nodeId = nodeId; // 20-byte ID as Uint8Array
    this.k = 20; // Bucket size
    this.alpha = 3; // Concurrency parameter
    this.buckets = new Array(160).fill(null).map(() => []); // 160 k-buckets
    this.storage = new Map(); // Local storage for key-value pairs
    this.rpcHandlers = new Map();
    this.pendingRPCs = new Map();
    this.rpcTimeout = 5000;
    this.refreshQueue = new Map(); // key -> { value, lastRefresh, options }
    this.refreshInterval = 3600000; // 1 hour
    this.replicationFactor = 20; // k parameter
    this.republishInterval = 86400000; // 24 hours
    this.refreshTimer = null;
    this.replicationStatus = new Map(); // key -> { replicas, lastCheck }

    // Initialize RPC handlers
    this.setupRPCHandlers();
  }
  
  async getWithTimeout(key, timeoutMs = 5000) {
      // If no peers, check local storage only
      if (this.buckets.every(bucket => bucket.length === 0)) {
        console.log(`[DHT] No peers - checking local storage for ${key}`);
        return this.storage.get(key) || null;
      }
      
      // Otherwise do normal lookup with timeout
      const getPromise = this.get(key);
      const timeoutPromise = new Promise((resolve) => 
        setTimeout(() => resolve(null), timeoutMs)
      );
      
      return Promise.race([getPromise, timeoutPromise]);
    }
  
   // Compares two Uint8Arrays, returns -1, 0, or 1
  compareUint8Arrays(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    return 0;
  }
  // XOR distance between two node IDs
  distance(id1, id2) {
    const dist = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      dist[i] = id1[i] ^ id2[i];
    }
    return dist;
  }
  
  // Find the bucket index for a given node ID
  getBucketIndex(nodeId) {
    const dist = this.distance(this.nodeId, nodeId);
    
    // Find the highest bit position
    for (let i = 0; i < 160; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      
      if ((dist[byteIndex] >> bitIndex) & 1) {
        return 159 - i;
      }
    }
    return 0; // Same node
  }
  
  // Add a peer to the appropriate k-bucket
  addPeer(peerId, peerInfo) {
    if (this.uint8ArrayEquals(peerId, this.nodeId)) return; // Don't add self
    
    const bucketIndex = this.getBucketIndex(peerId);
    const bucket = this.buckets[bucketIndex];
    
    // Check if peer already exists in bucket
    const existingIndex = bucket.findIndex(p => this.uint8ArrayEquals(p.id, peerId));
    
    if (existingIndex !== -1) {
      // Move to end (most recently seen)
      const peer = bucket.splice(existingIndex, 1)[0];
      bucket.push(peer);
      return;
    }
    
    // Add new peer
    if (bucket.length < this.k) {
      bucket.push({
        id: peerId,
        wire: peerInfo.wire,
        lastSeen: Date.now(),
        rtt: 0,
        failures: 0
      });
      console.log(`Added peer to k-bucket ${bucketIndex}, bucket size: ${bucket.length}`);
    } else {
      // Bucket full - ping oldest peer
      const oldest = bucket[0];
      this.ping(oldest).then(isAlive => {
        if (!isAlive) {
          // Replace with new peer
          bucket.shift();
          bucket.push({
            id: peerId,
            wire: peerInfo.wire,
            lastSeen: Date.now(),
            rtt: 0,
            failures: 0
          });
          console.log(`Replaced stale peer in k-bucket ${bucketIndex}`);
        }
      });
    }
  }
  
  // Remove a peer from k-buckets
  removePeer(peerId) {
    const bucketIndex = this.getBucketIndex(peerId);
    const bucket = this.buckets[bucketIndex];
    
    const index = bucket.findIndex(p => this.uint8ArrayEquals(p.id, peerId));
    if (index !== -1) {
      bucket.splice(index, 1);
      console.log(`[DHT] Removed peer from k-bucket ${bucketIndex}, bucket size: ${bucket.length}`);
    }
  }
  
  // Helper to compare Uint8Arrays
  uint8ArrayEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  
  // Convert string/hex to Uint8Array
  hexToUint8Array(hex) {
    if (hex.startsWith('0x')) {
      hex = hex.slice(2);
    }
    
    if (hex.length % 2) {
      hex = '0' + hex;
    }
    
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }
  
  // Convert Uint8Array to hex string
  uint8ArrayToHex(bytes) {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  
  // Hash to node ID using Web Crypto API
  async hashToNodeId(data) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-1', dataBuffer);
    return new Uint8Array(hashBuffer);
  }
  
  // Find the k closest peers to a target ID
  findClosestPeers(targetId, count = this.k, excludePeerId = null) {
    const allPeers = [];
    
    for (const bucket of this.buckets) {
      for (const peer of bucket) {
        if (excludePeerId && this.uint8ArrayEquals(peer.id, excludePeerId)) continue;
        if (!peer.wire || peer.wire.destroyed) continue;
        
        const distance = this.distance(targetId, peer.id);
        allPeers.push({ peer, distance });
      }
    }
    
    // Sort by distance
    allPeers.sort((a, b) => {
      for (let i = 0; i < 20; i++) {
        if (a.distance[i] !== b.distance[i]) {
          return a.distance[i] - b.distance[i];
        }
      }
      return 0;
    });
    
    return allPeers.slice(0, count).map(item => item.peer);
  }
  
    handleCheckValue(params, senderId) {
      const { key } = params;
      return {
        hasValue: this.storage.has(key),
        timestamp: this.storage.has(key) ? this.storage.get(key).timestamp : null
      };
    }
  
  // Setup RPC handlers
  setupRPCHandlers() {
    this.rpcHandlers.set('PING', this.handlePing.bind(this));
    this.rpcHandlers.set('FIND_NODE', this.handleFindNode.bind(this));
    this.rpcHandlers.set('FIND_VALUE', this.handleFindValue.bind(this));
    this.rpcHandlers.set('STORE', this.handleStore.bind(this));
    this.rpcHandlers.set('CHECK_VALUE', this.handleCheckValue.bind(this));
  }

  // Generate RPC ID
  generateRPCId() {
    return Math.random().toString(36).substr(2, 20);
  }
  
  // Send RPC to a peer
  async sendRPC(peer, method, params) {
    const rpcId = this.generateRPCId();
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRPCs.delete(rpcId);
        peer.failures++;
        reject(new Error('RPC timeout'));
      }, this.rpcTimeout);
      
      this.pendingRPCs.set(rpcId, { resolve, reject, timeout });
      
      sendPeer(peer.wire, {
        type: 'dht_rpc',
        method,
        params,
        rpcId,
        senderId: this.uint8ArrayToHex(this.nodeId)
      });
    });
  }
  
  // Handle incoming RPC
  handleRPC(msg, fromWire) {
    const { method, params, rpcId, senderId } = msg;
    
    if (msg.isResponse) {
      // Handle RPC response
      const pending = this.pendingRPCs.get(rpcId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(msg.result);
        this.pendingRPCs.delete(rpcId);
      }
      return;
    }
    
    // Handle RPC request
    const handler = this.rpcHandlers.get(method);
    if (handler) {
      const result = handler(params, senderId);
      sendPeer(fromWire, {
        type: 'dht_rpc',
        isResponse: true,
        rpcId,
        result
      });
    }
  }
  
  // RPC Handlers
  handlePing(params, senderId) {
    return { alive: true, nodeId: this.uint8ArrayToHex(this.nodeId) };
  }
  
  handleFindNode(params, senderId) {
    const targetId = this.hexToUint8Array(params.targetId);
    const closest = this.findClosestPeers(targetId, this.k);
    
    return {
      peers: closest.map(p => ({
        id: this.uint8ArrayToHex(p.id)
      }))
    };
  }
  
  handleFindValue(params, senderId) {
    const key = params.key;
    
    // Check if we have the value
    if (this.storage.has(key)) {
      return {
        found: true,
        value: this.storage.get(key)
      };
    }
    
    // Return closest peers
    const keyId = this.hashToNodeId(key);
    const closest = this.findClosestPeers(keyId, this.k);
    
    return {
      found: false,
      peers: closest.map(p => ({
        id: this.uint8ArrayToHex(p.id)
      }))
    };
  }
  
    handleStore(params, senderId) {
      const { key, value } = params;
      
      // ADDED: Validate key and value
      if (!key || typeof key !== 'string' || key.length > 256) {
        console.warn('[DHT] Invalid key in STORE request');
        return { stored: false, error: 'Invalid key' };
      }
      
      // ADDED: Size limit for values
      const valueStr = JSON.stringify(value);
      if (valueStr.length > 64 * 1024) { // 64KB max per value
        console.warn('[DHT] Value too large in STORE request');
        return { stored: false, error: 'Value too large' };
      }
      
      // Check total storage BEFORE adding
      const currentSize = Array.from(this.storage.values())
        .reduce((sum, v) => sum + JSON.stringify(v).length, 0);
      
      const MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50MB total
      
      if (currentSize + valueStr.length > MAX_STORAGE_BYTES) {
        // Implement LRU eviction
        const entries = Array.from(this.storage.entries())
          .map(([k, v]) => ({
            key: k,
            value: v,
            size: JSON.stringify(v).length,
            timestamp: v.timestamp || 0
          }))
          .sort((a, b) => a.timestamp - b.timestamp); // Oldest first
        
        let freedSpace = 0;
        while (currentSize + valueStr.length - freedSpace > MAX_STORAGE_BYTES && entries.length > 0) {
          const oldest = entries.shift();
          this.storage.delete(oldest.key);
          freedSpace += oldest.size;
        }
        
        if (currentSize + valueStr.length - freedSpace > MAX_STORAGE_BYTES) {
          return { stored: false, error: 'Storage full' };
        }
      }
      
      // Store with metadata
      const storageEntry = {
        ...value,
        timestamp: Date.now(),
        size: valueStr.length
      };
      
      this.storage.set(key, storageEntry);
      
      return { stored: true };
    }
  
  // High-level operations
  async ping(peer) {
    try {
      const result = await this.sendRPC(peer, 'PING', {});
      peer.lastSeen = Date.now();
      peer.failures = 0;
      return true;
    } catch (e) {
      return false;
    }
  }
  
  // Iterative find node
  async findNode(targetId) {
    const seen = new Set();
    const shortlist = this.findClosestPeers(targetId, this.alpha);
    
    if (shortlist.length === 0) return [];
    
    let closestNode = shortlist[0];
    let closestDistance = this.distance(targetId, closestNode.id);
    
    let iterations = 0;
    const maxIterations = 20;
    while (iterations++ < maxIterations) {
      // Query alpha peers in parallel
      const queries = [];
      let queried = 0;
      
      for (const peer of shortlist) {
        const peerId = this.uint8ArrayToHex(peer.id);
        if (seen.has(peerId) || queried >= this.alpha) continue;
        
        seen.add(peerId);
        queried++;
        
        queries.push(
          this.sendRPC(peer, 'FIND_NODE', { 
            targetId: this.uint8ArrayToHex(targetId) 
          }).catch(() => null)
        );
      }
      
      if (queries.length === 0) break;
      
      const results = await Promise.all(queries);
      let improved = false;
      
      for (const result of results) {
        if (!result || !result.peers) continue;
        
        for (const peerInfo of result.peers) {
          const peerId = this.hexToUint8Array(peerInfo.id);
          
          // Check if we have this peer in our buckets
          let found = false;
          for (const bucket of this.buckets) {
            const peer = bucket.find(p => this.uint8ArrayEquals(p.id, peerId));
            if (peer && !seen.has(peerInfo.id)) {
              shortlist.push(peer);
              
              const distance = this.distance(targetId, peerId);
              if (this.compareUint8Arrays(distance, closestDistance) < 0) {

                closestDistance = distance;
                closestNode = peer;
                improved = true;
              }
              
              found = true;
              break;
            }
          }
        }
      }
      
      if (!improved) break;
      
      // Sort shortlist by distance
      shortlist.sort((a, b) => {
        const distA = this.distance(targetId, a.id);
        const distB = this.distance(targetId, b.id);
        for (let i = 0; i < 20; i++) {
          if (distA[i] !== distB[i]) {
            return distA[i] - distB[i];
          }
        }
        return 0;
      });
    }
    
    return shortlist.slice(0, this.k);
  }
  
  // Store a value in the DHT
    async store(key, value, options = {}) {
      const { 
        propagate = true, 
        refresh = true,
        isRefresh = false,
        replicationFactor = this.replicationFactor 
      } = options;
      
      const keyId = await this.hashToNodeId(key);
      
      // Store locally first with metadata
      const storageEntry = {
        value,
        timestamp: Date.now(),
        refresh,
        storedBy: this.uint8ArrayToHex(this.nodeId)
      };
      
      this.storage.set(key, storageEntry);
      console.log(`[DHT] Stored ${key} locally${isRefresh ? ' (refresh)' : ''}`);
      
      // Add to refresh queue if requested
      if (refresh && !isRefresh) {
        this.refreshQueue.set(key, {
          value,
          lastRefresh: Date.now(),
          options: { propagate, replicationFactor }
        });
      }
      
      if (!propagate) {
        return { stored: true, replicas: 1 };
      }
      
      // Find k closest peers for replication
      const totalPeers = this.buckets.reduce((sum, bucket) => sum + bucket.length, 0);
      if (totalPeers === 0) {
        console.log(`[DHT] No peers available - stored ${key} locally only`);
        return { stored: true, replicas: 1 };
      }
      
      const closest = await this.findNode(keyId);
      if (closest.length === 0) {
        console.log(`[DHT] No reachable peers for replication of ${key}`);
        return { stored: true, replicas: 1 };
      }
      
      // Attempt to store on k closest peers
      const targetReplicas = Math.min(replicationFactor, closest.length);
      const storePromises = [];
      const replicationResults = [];
      
      for (let i = 0; i < targetReplicas; i++) {
        const peer = closest[i];
        const promise = this.sendRPC(peer, 'STORE', { key, value })
          .then(result => {
            if (result && result.stored) {
              replicationResults.push({ peer: peer.id, success: true });
              return true;
            }
            replicationResults.push({ peer: peer.id, success: false, reason: 'rejected' });
            return false;
          })
          .catch(error => {
            replicationResults.push({ peer: peer.id, success: false, reason: error.message });
            return false;
          });
        
        storePromises.push(promise);
      }
      
      const results = await Promise.all(storePromises);
      const successCount = results.filter(r => r === true).length;
      
      console.log(`[DHT] Stored key ${key} at ${successCount}/${targetReplicas} remote nodes (plus local)`);
      
      // Log detailed results for debugging
      if (successCount < targetReplicas / 2) {
        console.warn(`[DHT] Poor replication for ${key}:`, replicationResults);
      }
      
      // Update replication status
      this.replicationStatus.set(key, {
        replicas: successCount + 1, // +1 for local
        lastCheck: Date.now()
      });
      
      return { 
        stored: true, 
        replicas: successCount + 1,
        details: replicationResults 
      };
    }
  
  // Retrieve a value from the DHT
async get(key) {
  // Check local storage first
  const localValue = this.storage.get(key);
  if (localValue) {
    console.log(`[DHT] Found ${key} in local storage`);
    return localValue.value || localValue; // Handle both old and new format
  }
  
  const keyId = await this.hashToNodeId(key);
  const seen = new Set();
  const shortlist = this.findClosestPeers(keyId, this.alpha);
  
  // Try multiple peers in parallel for faster lookups
  const parallelQueries = 3;
  let foundValue = null;
  
  while (shortlist.length > 0 && !foundValue) {
    const batch = shortlist.splice(0, parallelQueries);
    const queries = batch.map(async (peer) => {
      const peerId = this.uint8ArrayToHex(peer.id);
      if (seen.has(peerId)) return null;
      seen.add(peerId);
      
      try {
        const result = await this.sendRPC(peer, 'FIND_VALUE', { key });
        
        if (result.found) {
          // Store locally for caching
          this.storage.set(key, {
            value: result.value,
            timestamp: Date.now(),
            cached: true,
            cachedFrom: peerId
          });
          
          return result.value;
        }
        
        // Add returned peers to shortlist
        if (result.peers) {
          for (const peerInfo of result.peers) {
            if (!seen.has(peerInfo.id)) {
              // Find peer in our buckets
              for (const bucket of this.buckets) {
                const p = bucket.find(peer => 
                  this.uint8ArrayToHex(peer.id) === peerInfo.id
                );
                if (p) {
                  shortlist.push(p);
                  break;
                }
              }
            }
          }
        }
        
        return null;
      } catch (e) {
        // Continue with next peer
        return null;
      }
    });
    
    const results = await Promise.all(queries);
    foundValue = results.find(v => v !== null);
    
    if (foundValue) {
      console.log(`[DHT] Found value for ${key} from network`);
      return foundValue;
    }
    
    // Sort shortlist by distance for next iteration
    shortlist.sort((a, b) => {
      const distA = this.distance(keyId, a.id);
      const distB = this.distance(keyId, b.id);
      return this.compareUint8Arrays(distA, distB);
    });
  }
  
  console.log(`[DHT] Value not found for key: ${key}`);
  return null;
}
  
  // Bootstrap the DHT by finding our own node ID
  async bootstrap() {
    console.log("Bootstrapping DHT...");
    const closest = await this.findNode(this.nodeId);
    console.log(`DHT bootstrap complete, found ${closest.length} peers`);
      // Start refresh timer after bootstrap
    this.startRefreshTimer();
  }
  
  // Get routing table statistics
getStats() {
  let totalPeers = 0;
  let activeBuckets = 0;
  
  for (let i = 0; i < this.buckets.length; i++) {
    const bucketSize = this.buckets[i].length;
    totalPeers += bucketSize;
    if (bucketSize > 0) activeBuckets++;
  }
  
  // Calculate replication health
  let wellReplicated = 0;
  let underReplicated = 0;
  
  for (const [key, status] of this.replicationStatus) {
    if (status.replicas >= this.k / 2) {
      wellReplicated++;
    } else {
      underReplicated++;
    }
  }
  
  return {
    totalPeers,
    activeBuckets,
    avgBucketSize: activeBuckets > 0 ? (totalPeers / activeBuckets).toFixed(2) : 0,
    storageSize: this.storage.size,
    localKeys: this.storage.size,
    refreshQueueSize: this.refreshQueue.size,
    replicationHealth: {
      wellReplicated,
      underReplicated,
      total: this.replicationStatus.size
    }
  };
}
  
    /**
   * Serializes the entire DHT state for saving.
   * @returns {object} - An object containing the routing table and storage.
   */
serialize() {
  const serializedBuckets = this.buckets.map(bucket =>
    bucket.map(peer => ({
      id: this.uint8ArrayToHex(peer.id),
      lastSeen: peer.lastSeen,
      failures: peer.failures,
    }))
  );
  
  // Serialize refresh queue
  const serializedRefreshQueue = Array.from(this.refreshQueue.entries()).map(([key, data]) => ({
    key,
    value: data.value,
    lastRefresh: data.lastRefresh,
    options: data.options
  }));
  
  return {
    buckets: serializedBuckets,
    storage: Array.from(this.storage.entries()),
    refreshQueue: serializedRefreshQueue,
    replicationStatus: Array.from(this.replicationStatus.entries())
  };
}


  /**
   * Deserializes and loads the DHT state from a saved object.
   * @param {object} state - The saved state from serialize().
   */
deserialize(state) {
  if (state.buckets) {
    this.buckets = state.buckets.map(bucket =>
      bucket.map(peer => ({
        id: this.hexToUint8Array(peer.id),
        wire: null,
        lastSeen: peer.lastSeen,
        failures: peer.failures,
      }))
    );
    console.log(`[DHT] Loaded ${state.buckets.flat().length} peers into routing table.`);
  }
  
  if (state.storage) {
    this.storage = new Map(state.storage);
    console.log(`[DHT] Loaded ${this.storage.size} key-value pairs into DHT storage.`);
  }
  
  if (state.refreshQueue) {
    this.refreshQueue = new Map(state.refreshQueue.map(item => [
      item.key,
      {
        value: item.value,
        lastRefresh: item.lastRefresh,
        options: item.options
      }
    ]));
    console.log(`[DHT] Loaded ${this.refreshQueue.size} keys into refresh queue.`);
  }
  
  if (state.replicationStatus) {
    this.replicationStatus = new Map(state.replicationStatus);
  }
  
  // Restart refresh timer if we have data to refresh
  if (this.refreshQueue.size > 0) {
    this.startRefreshTimer();
  }
}
  startRefreshTimer() {
  if (this.refreshTimer) return;
  
  // Run refresh every 10 minutes
  this.refreshTimer = setInterval(() => {
    this.refreshStoredValues().catch(e => 
      console.error('[DHT] Refresh error:', e)
    );
  }, 600000); // 10 minutes
  
  console.log('[DHT] Started refresh timer');
}

stopRefreshTimer() {
  if (this.refreshTimer) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
}

async refreshStoredValues() {
  const now = Date.now();
  let refreshedCount = 0;
  
  for (const [key, refreshData] of this.refreshQueue) {
    const timeSinceRefresh = now - (refreshData.lastRefresh || 0);
    
    // Skip if recently refreshed
    if (timeSinceRefresh < this.refreshInterval) {
      continue;
    }
    
    try {
      // Re-store to ensure replication
      await this.store(key, refreshData.value, {
        ...refreshData.options,
        isRefresh: true
      });
      
      refreshData.lastRefresh = now;
      refreshedCount++;
      
      console.log(`[DHT] Refreshed key: ${key}`);
    } catch (e) {
      console.error(`[DHT] Failed to refresh key ${key}:`, e);
    }
  }
  
  if (refreshedCount > 0) {
    console.log(`[DHT] Refreshed ${refreshedCount} keys`);
  }
  
  // Also check replication status
  await this.checkReplicationStatus();
}

async checkReplicationStatus() {
  const keysToCheck = Array.from(this.refreshQueue.keys()).slice(0, 10); // Check 10 at a time
  
  for (const key of keysToCheck) {
    const status = await this.getReplicationStatus(key);
    this.replicationStatus.set(key, {
      replicas: status.replicas,
      lastCheck: Date.now()
    });
    
    // If under-replicated, force refresh
    if (status.replicas < Math.floor(this.replicationFactor / 2)) {
      console.log(`[DHT] Key ${key} under-replicated (${status.replicas} replicas), forcing refresh`);
      const refreshData = this.refreshQueue.get(key);
      if (refreshData) {
        refreshData.lastRefresh = 0; // Force refresh on next cycle
      }
    }
  }
}

async getReplicationStatus(key) {
  const keyId = await this.hashToNodeId(key);
  const closestPeers = await this.findNode(keyId);
  
  let replicaCount = 0;
  const checkPromises = closestPeers.slice(0, this.k).map(async (peer) => {
    try {
      const result = await this.sendRPC(peer, 'CHECK_VALUE', { key });
      if (result.hasValue) {
        replicaCount++;
      }
    } catch (e) {
      // Peer didn't respond or doesn't have value
    }
  });
  
  await Promise.all(checkPromises);
  
  // Include ourselves if we have it
  if (this.storage.has(key)) {
    replicaCount++;
  }
  
  return { replicas: replicaCount, checked: checkPromises.length };
}
  
  shutdown() {
  this.stopRefreshTimer();
  console.log('[DHT] Shutdown complete');
}
  
}
