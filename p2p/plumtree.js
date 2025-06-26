import { sendPeer } from './network-manager.js';
import { generateId } from '../utils.js';

// --- PLUMTREE GOSSIP PROTOCOL ---
export class Plumtree {
  constructor(nodeId, hyparview) {
    this.nodeId = nodeId;
    this.hyparview = hyparview; // Use HyParView's active view as eager push peers
    
    // Protocol state
    this.eagerPushPeers = new Set(); // Peers we eagerly push to
    this.lazyPushPeers = new Set();  // Peers we only send IHAVE to
    this.missing = new Map(); // messageId -> { requestTime, timeout }
    this.receivedMessages = new Map(); // messageId -> { message, receivedFrom }
    
    // Protocol parameters
    this.lazyPushDelay = 100; // ms before sending IHAVE
    this.missingTimeout = 3000; // ms to wait for missing message
    this.pruneDelay = 1000; // ms before pruning eager peers
    this.messageHistorySize = 10000;
    
    // Optimization metrics
    this.metrics = {
      messagesReceived: 0,
      duplicatesReceived: 0,
      messagesRequested: 0,
      messagesPruned: 0
    };
    
    // Initialize eager peers from HyParView
    this.initializeEagerPeers();
  }
  
  // Initialize eager push peers from HyParView active view
  initializeEagerPeers() {
    const activePeers = this.hyparview.getActivePeers();
    activePeers.forEach(peer => {
      const peerIdStr = this.hyparview.dht.uint8ArrayToHex(peer.id);
      this.eagerPushPeers.add(peerIdStr);
    });
    console.log(`[Plumtree] Initialized with ${this.eagerPushPeers.size} eager peers`);
  }
  
  // Broadcast a new message
  broadcast(message, excludePeerId = null) {
    const messageId = message.id || generateId();
    message.id = messageId;
    message.originId = this.hyparview.dht.uint8ArrayToHex(this.nodeId);
    
    // Add to our received messages
    this.receivedMessages.set(messageId, {
      message,
      receivedFrom: null,
      timestamp: Date.now()
    });
    
    // Eager push to all eager peers
    this.eagerPush(message, excludePeerId);
    
    // Lazy push to all lazy peers
    setTimeout(() => {
      this.lazyPush(messageId, excludePeerId);
    }, this.lazyPushDelay);
    
    return messageId;
  }
  
  // Eager push - send full message
  eagerPush(message, excludePeerId = null) {
    const activePeers = this.hyparview.getActivePeers();
    
    activePeers.forEach(peer => {
      const peerIdStr = this.hyparview.dht.uint8ArrayToHex(peer.id);
      
      // Skip excluded peer and non-eager peers
      if (peerIdStr === excludePeerId || !this.eagerPushPeers.has(peerIdStr)) {
        return;
      }
      
      if (!peer.wire.destroyed) {
        sendPeer(peer.wire, {
          type: 'plumtree',
          subtype: 'GOSSIP',
          message
        });
      }
    });
  }
  
  // Lazy push - send only IHAVE
  lazyPush(messageId, excludePeerId = null) {
    const activePeers = this.hyparview.getActivePeers();
    
    activePeers.forEach(peer => {
      const peerIdStr = this.hyparview.dht.uint8ArrayToHex(peer.id);
      
      // Skip excluded peer and eager peers
      if (peerIdStr === excludePeerId || this.eagerPushPeers.has(peerIdStr)) {
        return;
      }
      
      if (!peer.wire.destroyed) {
        sendPeer(peer.wire, {
          type: 'plumtree',
          subtype: 'IHAVE',
          messageIds: [messageId]
        });
      }
    });
  }
  
  // Handle incoming Plumtree messages
  handleMessage(msg, fromWire) {
    const fromPeerId = fromWire.peerId ? 
      this.hyparview.dht.uint8ArrayToHex(fromWire.peerId) : null;
    
    switch (msg.subtype) {
      case 'GOSSIP':
        this.handleGossip(msg.message, fromPeerId, fromWire);
        break;
      case 'IHAVE':
        this.handleIHave(msg.messageIds, fromPeerId, fromWire);
        break;
      case 'GRAFT':
        this.handleGraft(fromPeerId, msg.messageId, fromWire);
        break;
      case 'PRUNE':
        this.handlePrune(fromPeerId);
        break;
    }
  }
  
  // Handle received gossip message
  handleGossip(message, fromPeerId, fromWire) {
    const messageId = message.id;
    
    // Check if we've seen this message
    if (this.receivedMessages.has(messageId)) {
      // Duplicate - consider pruning this eager peer
      this.metrics.duplicatesReceived++;
      
      // Prune after delay if we keep getting duplicates
      setTimeout(() => {
        if (this.eagerPushPeers.has(fromPeerId)) {
          this.prune(fromPeerId, fromWire);
        }
      }, this.pruneDelay);
      
      return;
    }
    
    // New message
    this.metrics.messagesReceived++;
    this.receivedMessages.set(messageId, {
      message,
      receivedFrom: fromPeerId,
      timestamp: Date.now()
    });
    
    // Cancel any pending request for this message
    if (this.missing.has(messageId)) {
      const { timeout } = this.missing.get(messageId);
      clearTimeout(timeout);
      this.missing.delete(messageId);
    }
    
    // Graft the sender as eager peer (they were first)
    if (!this.eagerPushPeers.has(fromPeerId)) {
      this.graft(fromPeerId);
    }
    
    // Deliver to application
    this.deliver(message);
    
    // Forward to other peers
    this.eagerPush(message, fromPeerId);
    setTimeout(() => {
      this.lazyPush(messageId, fromPeerId);
    }, this.lazyPushDelay);
    
    // Clean old messages periodically
    if (this.receivedMessages.size > this.messageHistorySize) {
      this.cleanupOldMessages();
    }
  }
  
  // Handle IHAVE announcements
  handleIHave(messageIds, fromPeerId, fromWire) {
    messageIds.forEach(messageId => {
      // If we don't have this message and haven't requested it
      if (!this.receivedMessages.has(messageId) && !this.missing.has(messageId)) {
        // Request the message
        this.requestMessage(messageId, fromPeerId, fromWire);
      }
    });
  }
  
  // Request a missing message
  requestMessage(messageId, fromPeerId, fromWire) {
    this.metrics.messagesRequested++;
    
    // Send GRAFT to request the message
    sendPeer(fromWire, {
      type: 'plumtree',
      subtype: 'GRAFT',
      messageId
    });
    
    // Set timeout for missing message
    const timeout = setTimeout(() => {
      this.missing.delete(messageId);
      // Could implement retry logic here
    }, this.missingTimeout);
    
    this.missing.set(messageId, {
      requestTime: Date.now(),
      timeout,
      requestedFrom: fromPeerId
    });
  }
  
  // Handle GRAFT request - add peer to eager set
  handleGraft(fromPeerId, messageId, fromWire) {
    this.eagerPushPeers.add(fromPeerId);
    this.lazyPushPeers.delete(fromPeerId);
    
    // If we have the requested message, send it
    if (messageId && this.receivedMessages.has(messageId)) {
      const { message } = this.receivedMessages.get(messageId);
      const peer = this.findPeerById(fromPeerId);
      
      if (peer && !peer.wire.destroyed) {
        sendPeer(peer.wire, {
          type: 'plumtree',
          subtype: 'GOSSIP',
          message
        });
      }
    }
    
    console.log(`[Plumtree] Grafted peer ${fromPeerId.substring(0, 12)}... as eager`);
  }
  
  // Handle PRUNE request - move peer to lazy set
  handlePrune(fromPeerId) {
    this.eagerPushPeers.delete(fromPeerId);
    this.lazyPushPeers.add(fromPeerId);
    this.metrics.messagesPruned++;
    
    console.log(`[Plumtree] Pruned peer ${fromPeerId.substring(0, 12)}... to lazy`);
  }
  
  // Graft a peer (make eager)
  graft(peerId) {
    this.eagerPushPeers.add(peerId);
    this.lazyPushPeers.delete(peerId);
  }
  
  // Prune a peer (make lazy)
  prune(peerId, wire) {
    this.eagerPushPeers.delete(peerId);
    this.lazyPushPeers.add(peerId);
    
    // Send PRUNE message
    if (wire && !wire.destroyed) {
      sendPeer(wire, {
        type: 'plumtree',
        subtype: 'PRUNE'
      });
    }
  }
  
  // Find peer by ID
  findPeerById(peerId) {
    const activePeers = this.hyparview.getActivePeers();
    return activePeers.find(p => this.hyparview.dht.uint8ArrayToHex(p.id) === peerId);
  }
  
  // Deliver message to application
  deliver(message) {
    // Override this method for application-specific delivery
    console.log(`[Plumtree] Delivered message: ${message.id}`);
  }
  
  // Clean up old messages
  cleanupOldMessages() {
    const cutoff = Date.now() - 3600000; // 1 hour
    const toDelete = [];
    
    this.receivedMessages.forEach((data, messageId) => {
      if (data.timestamp < cutoff) {
        toDelete.push(messageId);
      }
    });
    
    toDelete.forEach(messageId => {
      this.receivedMessages.delete(messageId);
    });
  }
  
  // Handle peer failure
  handlePeerFailure(peerId) {
    const peerIdStr = this.hyparview.dht.uint8ArrayToHex(peerId);
    this.eagerPushPeers.delete(peerIdStr);
    this.lazyPushPeers.delete(peerIdStr);
  }
  
  // Get statistics
  getStats() {
    return {
      eagerPeers: this.eagerPushPeers.size,
      lazyPeers: this.lazyPushPeers.size,
      messagesInHistory: this.receivedMessages.size,
      missingRequests: this.missing.size,
      metrics: { ...this.metrics }
    };
  }
}
