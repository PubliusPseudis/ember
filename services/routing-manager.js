import { state } from '../main.js';
import { arrayBufferToBase64 } from '../utils.js';
import { sendPeer } from '../p2p/network-manager.js';

export class RoutingManager {
  constructor() {
    this.routingInterval = 120000; // 2 minutes
    this.heartbeatInterval = 30000; // 30 seconds
    this.lastKnownPeerId = null;
    this.routingUpdateTimer = null;
    this.heartbeatTimer = null;
    this.routingFailures = 0;
    this.maxFailures = 3;
  }
  
  async start() {
    console.log('[RoutingManager] Starting routing management');
    
    // Initial routing announcement
    await this.updateRouting();
    
    // Start periodic updates
    this.routingUpdateTimer = setInterval(() => {
      this.updateRouting().catch(e => {
        console.error('[RoutingManager] Routing update failed:', e);
        this.handleRoutingFailure();
      });
    }, this.routingInterval);
    
    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(e => 
        console.error('[RoutingManager] Heartbeat failed:', e)
      );
    }, this.heartbeatInterval);
    
    // Monitor peer ID changes
    this.monitorPeerIdChanges();
  }
  
  stop() {
    if (this.routingUpdateTimer) {
      clearInterval(this.routingUpdateTimer);
      this.routingUpdateTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  async updateRouting(force = false) {
    if (!state.myIdentity || !state.identityRegistry) {
      console.log('[RoutingManager] No identity, skipping routing update');
      return;
    }
    
    const currentPeerId = this.getCurrentPeerId();
    if (!currentPeerId) {
      console.log('[RoutingManager] No active connections, skipping routing update');
      return;
    }
    
    // Check if peer ID changed
    const peerIdChanged = this.lastKnownPeerId && this.lastKnownPeerId !== currentPeerId;
    if (peerIdChanged) {
      console.log(`[RoutingManager] Peer ID changed from ${this.lastKnownPeerId} to ${currentPeerId}`);
      force = true;
    }
    
    // Skip update if peer ID hasn't changed (unless forced)
    if (!force && this.lastKnownPeerId === currentPeerId && this.routingFailures === 0) {
      console.log('[RoutingManager] Peer ID unchanged, skipping update');
      return;
    }
    
    try {
      // Update routing in DHT
      await state.identityRegistry.updatePeerLocation(
        state.myIdentity.handle,
        state.myIdentity.nodeId,
        currentPeerId
      );
      
      // Broadcast routing announcement to all peers
      await this.broadcastRoutingUpdate(currentPeerId);
      
      this.lastKnownPeerId = currentPeerId;
      this.routingFailures = 0;
      
      console.log(`[RoutingManager] Routing updated successfully with peer ID: ${currentPeerId}`);
      
    } catch (error) {
      console.error('[RoutingManager] Failed to update routing:', error);
      throw error;
    }
  }
  
  getCurrentPeerId() {
    // Try to get our peer ID from WebTorrent client
    if (state.client && state.client.peerId) {
      return state.client.peerId;
    }
    
    // Fallback: get from any active wire connection
    for (const [peerId, peerData] of state.peers) {
      if (peerData.wire && !peerData.wire.destroyed && peerData.wire._client) {
        const clientPeerId = peerData.wire._client.peerId;
        if (clientPeerId) {
          return clientPeerId;
        }
      }
    }
    
    return null;
  }
  
  async broadcastRoutingUpdate(peerId) {
    const announcement = {
      type: 'routing_update',
      handle: state.myIdentity.handle,
      nodeId: arrayBufferToBase64(state.myIdentity.nodeId),
      peerId: peerId,
      timestamp: Date.now(),
      publicKey: state.myIdentity.publicKey
    };
    
    // Send to all connected peers
    let sentCount = 0;
    for (const [_, peerData] of state.peers) {
      if (peerData.wire && !peerData.wire.destroyed) {
        try {
          sendPeer(peerData.wire, announcement);
          sentCount++;
        } catch (e) {
          console.error('[RoutingManager] Failed to send routing update to peer:', e);
        }
      }
    }
    
    console.log(`[RoutingManager] Broadcasted routing update to ${sentCount} peers`);
  }
  
  async sendHeartbeat() {
    if (!state.myIdentity || state.peers.size === 0) {
      return;
    }
    
    const heartbeat = {
      type: 'routing_heartbeat',
      handle: state.myIdentity.handle,
      timestamp: Date.now()
    };
    
    // Send to a subset of peers
    const peers = Array.from(state.peers.values());
    const maxHeartbeatPeers = Math.min(3, peers.length);
    
    for (let i = 0; i < maxHeartbeatPeers; i++) {
      const peer = peers[Math.floor(Math.random() * peers.length)];
      if (peer.wire && !peer.wire.destroyed) {
        sendPeer(peer.wire, heartbeat);
      }
    }
  }
  
  monitorPeerIdChanges() {
    // Set up a WebTorrent client event listener if possible
    if (state.client) {
      // Listen for reconnection events
      state.client.on('error', (err) => {
        if (err.message.includes('connection')) {
          console.log('[RoutingManager] Connection error detected, will update routing on reconnect');
          this.routingFailures++;
        }
      });
    }
    
    // Also monitor peer count changes
    let lastPeerCount = state.peers.size;
    setInterval(() => {
      const currentPeerCount = state.peers.size;
      
      // If we lost all peers and regained some, force routing update
      if (lastPeerCount === 0 && currentPeerCount > 0) {
        console.log('[RoutingManager] Regained connectivity, forcing routing update');
        this.updateRouting(true).catch(e => 
          console.error('[RoutingManager] Failed to update after reconnection:', e)
        );
      }
      
      lastPeerCount = currentPeerCount;
    }, 5000);
  }
  
  handleRoutingFailure() {
    this.routingFailures++;
    
    if (this.routingFailures >= this.maxFailures) {
      console.error('[RoutingManager] Max routing failures reached, resetting');
      this.routingFailures = 0;
      
      // Try to rejoin the network
      if (state.dht) {
        state.dht.bootstrap().then(() => {
          console.log('[RoutingManager] DHT re-bootstrapped after routing failures');
          this.updateRouting(true);
        });
      }
    }
  }
  
  // Get stats for debugging
  getStats() {
    return {
      currentPeerId: this.getCurrentPeerId(),
      lastKnownPeerId: this.lastKnownPeerId,
      routingFailures: this.routingFailures,
      isRunning: !!this.routingUpdateTimer
    };
  }
}

// Create singleton instance
export const routingManager = new RoutingManager();
