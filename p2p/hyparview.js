import { sendPeer } from './network-manager.js';

// --- HYPARVIEW PROTOCOL IMPLEMENTATION ---
export class HyParView {
  constructor(nodeId, dht) {
    this.nodeId = nodeId;
    this.dht = dht;
    
    // Protocol parameters
    this.activeViewSize = 5; // Small active view
    this.passiveViewSize = 30; // Larger passive view
    this.shuffleLength = 4; // Number of peers to exchange in shuffle
    this.shuffleInterval = 10000; // 10 seconds
    
    // Views
    this.activeView = new Map(); // peerId -> peer info
    this.passiveView = new Map(); // peerId -> peer info
    
    // Protocol state
    this.shuffleTimer = null;
    this.joinTimer = null;
    this.isBootstrapping = false;
    
    // Start periodic shuffle
    this.startShuffle();
  }
  
  // Add a peer to active view
  addToActiveView(peerId, peerInfo) {
    const peerIdStr = this.dht.uint8ArrayToHex(peerId);
    
    if (this.activeView.has(peerIdStr)) return true;
    
    // Check if active view is full
    if (this.activeView.size >= this.activeViewSize) {
      // Try to drop a peer
      const dropped = this.dropFromActiveView();
      if (!dropped) return false;
    }
    
    this.activeView.set(peerIdStr, {
      id: peerId,
      wire: peerInfo.wire,
      addedAt: Date.now(),
      isOutgoing: peerInfo.isOutgoing || false
    });
    
    console.log(`[HyParView] Added peer to active view. Active: ${this.activeView.size}/${this.activeViewSize}`);
    
    // Remove from passive view if present
    this.passiveView.delete(peerIdStr);
    
    return true;
  }
  
  // Add a peer to passive view
  addToPassiveView(peerId, peerInfo) {
    const peerIdStr = this.dht.uint8ArrayToHex(peerId);
    
    if (this.activeView.has(peerIdStr) || this.passiveView.has(peerIdStr)) {
      return false;
    }
    
    if (this.passiveView.size >= this.passiveViewSize) {
      // Drop random peer from passive view
      const keys = Array.from(this.passiveView.keys());
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      this.passiveView.delete(randomKey);
    }
    
    this.passiveView.set(peerIdStr, {
      id: peerId,
      wire: peerInfo.wire || null,
      addedAt: Date.now(),
      priority: peerInfo.priority || 0
    });
    
    console.log(`[HyParView] Added peer to passive view. Passive: ${this.passiveView.size}/${this.passiveViewSize}`);
    
    return true;
  }
  
  // Drop a peer from active view (prioritize dropping incoming connections)
  dropFromActiveView() {
    let candidates = [];
    
    // Prefer to drop incoming connections
    for (const [peerId, peer] of this.activeView) {
      if (!peer.isOutgoing) {
        candidates.push(peerId);
      }
    }
    
    // If no incoming connections, consider all
    if (candidates.length === 0) {
      candidates = Array.from(this.activeView.keys());
    }
    
    if (candidates.length === 0) return false;
    
    // Drop random candidate
    const toDrop = candidates[Math.floor(Math.random() * candidates.length)];
    const peer = this.activeView.get(toDrop);
    
    this.activeView.delete(toDrop);
    
    // Move to passive view
    this.addToPassiveView(peer.id, peer);
    
    // Send DISCONNECT message
    if (peer.wire && !peer.wire.destroyed) {
      sendPeer(peer.wire, {
        type: 'hyparview',
        subtype: 'DISCONNECT'
      });
    }
    
    return true;
  }
  
  // Handle peer failure
  handlePeerFailure(peerId) {
    const peerIdStr = this.dht.uint8ArrayToHex(peerId);
    
    if (!this.activeView.has(peerIdStr)) return;
    
    console.log(`[HyParView] Peer failed: ${peerIdStr.substring(0, 12)}...`);
    
    // Remove from active view
    this.activeView.delete(peerIdStr);
    
    // Try to replace with peer from passive view
    if (this.passiveView.size > 0) {
      const candidates = Array.from(this.passiveView.values())
        .filter(p => p.wire && !p.wire.destroyed)
        .sort((a, b) => b.priority - a.priority);
      
      if (candidates.length > 0) {
        const replacement = candidates[0];
        this.promoteToActiveView(replacement.id);
      }
    }
    
    // If active view is too small, trigger recovery
    if (this.activeView.size < Math.floor(this.activeViewSize / 2)) {
      this.triggerRecovery();
    }
  }
  
  // Promote a peer from passive to active view
  promoteToActiveView(peerId) {
    const peerIdStr = this.dht.uint8ArrayToHex(peerId);
    const peer = this.passiveView.get(peerIdStr);
    
    if (!peer) return false;
    
    // Send JOIN request
    if (peer.wire && !peer.wire.destroyed) {
      sendPeer(peer.wire, {
        type: 'hyparview',
        subtype: 'JOIN',
        ttl: 3,
        sender: this.dht.uint8ArrayToHex(this.nodeId)
      });
      
      return this.addToActiveView(peerId, { ...peer, isOutgoing: true });
    }
    
    return false;
  }
  
  // Handle incoming HyParView messages
  handleMessage(msg, fromWire) {
    switch (msg.subtype) {
      case 'JOIN':
        this.handleJoin(msg, fromWire);
        break;
      case 'FORWARD_JOIN':
        this.handleForwardJoin(msg, fromWire);
        break;
      case 'NEIGHBOR':
        this.handleNeighbor(msg, fromWire);
        break;
      case 'SHUFFLE':
        this.handleShuffle(msg, fromWire);
        break;
      case 'SHUFFLE_REPLY':
        this.handleShuffleReply(msg, fromWire);
        break;
      case 'DISCONNECT':
        this.handleDisconnect(msg, fromWire);
        break;
    }
  }
  
  // Handle JOIN request
  handleJoin(msg, fromWire) {
    const senderId = this.dht.hexToUint8Array(msg.sender);
    
    // Add to active view if possible
    const added = this.addToActiveView(senderId, { wire: fromWire, isOutgoing: false });
    
    if (added) {
      // Forward JOIN to other peers
      if (msg.ttl > 0) {
        const activeList = Array.from(this.activeView.values())
          .filter(p => this.dht.uint8ArrayToHex(p.id) !== msg.sender);
        
        if (activeList.length > 0) {
          const target = activeList[Math.floor(Math.random() * activeList.length)];
          
          sendPeer(target.wire, {
            type: 'hyparview',
            subtype: 'FORWARD_JOIN',
            ttl: msg.ttl - 1,
            sender: msg.sender,
            forwarder: this.dht.uint8ArrayToHex(this.nodeId)
          });
        }
      }
    } else {
      // Add to passive view
      this.addToPassiveView(senderId, { wire: fromWire });
    }
  }
  
  // Handle FORWARD_JOIN
  handleForwardJoin(msg, fromWire) {
    const senderId = this.dht.hexToUint8Array(msg.sender);
    
    if (msg.ttl === 0 || this.activeView.size >= this.activeViewSize) {
      // Send NEIGHBOR message back to original sender
      const senderPeer = this.findPeerByWire(fromWire);
      if (senderPeer) {
        sendPeer(fromWire, {
          type: 'hyparview',
          subtype: 'NEIGHBOR',
          target: msg.sender,
          priority: this.activeView.size < this.activeViewSize ? 'high' : 'low'
        });
      }
    } else {
      // Continue forwarding
      const activeList = Array.from(this.activeView.values())
        .filter(p => this.dht.uint8ArrayToHex(p.id) !== msg.sender && 
                    this.dht.uint8ArrayToHex(p.id) !== msg.forwarder);
      
      if (activeList.length > 0) {
        const target = activeList[Math.floor(Math.random() * activeList.length)];
        
        sendPeer(target.wire, {
          type: 'hyparview',
          subtype: 'FORWARD_JOIN',
          ttl: msg.ttl - 1,
          sender: msg.sender,
          forwarder: this.dht.uint8ArrayToHex(this.nodeId)
        });
      }
    }
  }
  
  // Handle NEIGHBOR message
  handleNeighbor(msg, fromWire) {
    const peerId = fromWire.peerId;
    
    if (msg.priority === 'high') {
      this.addToActiveView(peerId, { wire: fromWire, isOutgoing: false });
    } else {
      this.addToPassiveView(peerId, { wire: fromWire, priority: 1 });
    }
  }
  
  // Handle SHUFFLE request
  handleShuffle(msg, fromWire) {
    const senderId = fromWire.peerId;
    
    // Select random peers from passive view
    const passiveList = Array.from(this.passiveView.entries());
    const selected = [];
    
    for (let i = 0; i < this.shuffleLength && passiveList.length > 0; i++) {
      const index = Math.floor(Math.random() * passiveList.length);
      const [peerId, peer] = passiveList.splice(index, 1)[0];
      selected.push(peerId);
    }
    
    // Send reply
    sendPeer(fromWire, {
      type: 'hyparview',
      subtype: 'SHUFFLE_REPLY',
      peers: selected
    });
    
    // Add received peers to passive view
    if (msg.peers) {
      for (const peerId of msg.peers) {
        this.addToPassiveView(this.dht.hexToUint8Array(peerId), { priority: 0 });
      }
    }
  }
  
  // Handle SHUFFLE_REPLY
  handleShuffleReply(msg, fromWire) {
    if (msg.peers) {
      for (const peerId of msg.peers) {
        this.addToPassiveView(this.dht.hexToUint8Array(peerId), { priority: 0 });
      }
    }
  }
  
  // Handle DISCONNECT
  handleDisconnect(msg, fromWire) {
    const peer = this.findPeerByWire(fromWire);
    if (peer) {
      const peerIdStr = this.dht.uint8ArrayToHex(peer.id);
      this.activeView.delete(peerIdStr);
      console.log(`[HyParView] Peer disconnected: ${peerIdStr.substring(0, 12)}...`);
    }
  }
  
  // Find peer by wire connection
  findPeerByWire(wire) {
    for (const [peerId, peer] of this.activeView) {
      if (peer.wire === wire) return peer;
    }
    for (const [peerId, peer] of this.passiveView) {
      if (peer.wire === wire) return peer;
    }
    return null;
  }
  
  // Start periodic shuffle
  startShuffle() {
    this.shuffleTimer = setInterval(() => {
      this.performShuffle();
    }, this.shuffleInterval);
  }
  
  // Perform shuffle operation
  performShuffle() {
    if (this.activeView.size === 0) return;
    
    // Select random active peer
    const activePeers = Array.from(this.activeView.values());
    const target = activePeers[Math.floor(Math.random() * activePeers.length)];
    
    // Select random subset from active and passive views
    const toSend = [];
    const combined = [
      ...Array.from(this.activeView.keys()),
      ...Array.from(this.passiveView.keys())
    ];
    
    for (let i = 0; i < this.shuffleLength && combined.length > 0; i++) {
      const index = Math.floor(Math.random() * combined.length);
      toSend.push(combined.splice(index, 1)[0]);
    }
    
    if (toSend.length > 0 && target.wire && !target.wire.destroyed) {
      sendPeer(target.wire, {
        type: 'hyparview',
        subtype: 'SHUFFLE',
        peers: toSend
      });
    }
  }
  
  // Trigger recovery when active view is too small
  triggerRecovery() {
    console.log(`[HyParView] Triggering recovery. Active view size: ${this.activeView.size}`);
    
    // Try to promote peers from passive view
    const candidates = Array.from(this.passiveView.values())
      .filter(p => p.wire && !p.wire.destroyed);
    
    const needed = this.activeViewSize - this.activeView.size;
    for (let i = 0; i < needed && i < candidates.length; i++) {
      this.promoteToActiveView(candidates[i].id);
    }
    
    // If still not enough peers, use DHT to find more
    if (this.activeView.size < this.activeViewSize) {
      this.dht.findNode(this.nodeId).then(peers => {
        for (const peer of peers) {
          if (this.activeView.size >= this.activeViewSize) break;
          
          const peerId = peer.id;
          if (!this.activeView.has(this.dht.uint8ArrayToHex(peerId))) {
            this.addToActiveView(peerId, { wire: peer.wire, isOutgoing: true });
          }
        }
      });
    }
  }
  
  // Bootstrap the overlay
  async bootstrap() {
    console.log("[HyParView] Starting bootstrap...");
    this.isBootstrapping = true;
    
    // Use DHT to find initial peers
    const peers = await this.dht.findNode(this.nodeId);
    
    for (const peer of peers) {
      if (this.activeView.size >= this.activeViewSize) break;
      
      // Send JOIN request
      sendPeer(peer.wire, {
        type: 'hyparview',
        subtype: 'JOIN',
        ttl: 3,
        sender: this.dht.uint8ArrayToHex(this.nodeId)
      });
      
      this.addToActiveView(peer.id, { wire: peer.wire, isOutgoing: true });
    }
    
    this.isBootstrapping = false;
    console.log(`[HyParView] Bootstrap complete. Active: ${this.activeView.size}, Passive: ${this.passiveView.size}`);
  }
  
  // Get current statistics
  getStats() {
    return {
      activeView: this.activeView.size,
      passiveView: this.passiveView.size,
      activeCapacity: `${this.activeView.size}/${this.activeViewSize}`,
      passiveCapacity: `${this.passiveView.size}/${this.passiveViewSize}`
    };
  }
  
  // Get active peers for message propagation
  getActivePeers() {
    return Array.from(this.activeView.values())
      .filter(p => p.wire && !p.wire.destroyed);
  }
  
  // Cleanup on shutdown
  destroy() {
    if (this.shuffleTimer) {
      clearInterval(this.shuffleTimer);
    }
    
    // Send disconnect to all active peers
    for (const peer of this.activeView.values()) {
      if (peer.wire && !peer.wire.destroyed) {
        sendPeer(peer.wire, {
          type: 'hyparview',
          subtype: 'DISCONNECT'
        });
      }
    }
    
    this.activeView.clear();
    this.passiveView.clear();
  }
}
