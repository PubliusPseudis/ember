import { sendPeer } from './network-manager.js';
import { generateId } from '../utils.js';


// --- SCRIBE MULTICAST PROTOCOL ---
export class Scribe {
  constructor(nodeId, dht) {
    this.nodeId = nodeId;
    this.dht = dht;
    
    // Topic management
    this.subscribedTopics = new Map(); // topic -> { rendezvousId, parent, children, lastRefresh }
    this.topicMessages = new Map(); // topic -> recent message IDs (for dedup)
    
    // Protocol parameters
    this.heartbeatInterval = 30000; // 30 seconds
    this.treeRepairTimeout = 60000; // 60 seconds
    this.maxChildren = 16; // Max children per node in multicast tree
    
    // Start maintenance
    this.maintenanceTimer = null;
  }
  
  // Extract topics from post content
    extractTopics(content) {
        const topics = new Set();
        
        // ADDED: Limit content length for regex
        const maxContentLength = 1000;
        const truncatedContent = content.length > maxContentLength 
            ? content.substring(0, maxContentLength) 
            : content;
        
        // Extract hashtags with limits
        const MAX_TOPICS = 10;
        const MAX_TOPIC_LENGTH = 50;
        
        const hashtags = truncatedContent.match(/#\w{1,50}/g) || [];
        
        // ADDED: Limit number of hashtags processed
        hashtags.slice(0, MAX_TOPICS).forEach(tag => {
            const cleaned = tag.toLowerCase();
            if (cleaned.length <= MAX_TOPIC_LENGTH) {
                topics.add(cleaned);
            }
        });
        
        // Extract keywords with same limits
        const keywords = ['tech', 'news', 'art', 'music', 'politics', 
                         'science', 'bitcoin', 'finance', 'war', 'coding', 
                         'computers', 'cryptography', 'cryptocurrency'];
        const contentLower = truncatedContent.toLowerCase();
        
        let keywordsAdded = 0;
        for (const keyword of keywords) {
            if (topics.size >= MAX_TOPICS) break;
            if (contentLower.includes(keyword) && keywordsAdded < 5) {
                topics.add(`#${keyword}`);
                keywordsAdded++;
            }
        }
        
        // Always include a default topic
        if (topics.size < MAX_TOPICS) {
            topics.add('#general');
        }
        
        return Array.from(topics);
    }
  
  // Get rendezvous node for a topic
  async getRendezvousNode(topic) {
    return await this.dht.hashToNodeId(topic);
  }
  
  // Subscribe to a topic
  async subscribe(topic) {
    if (this.subscribedTopics.has(topic)) return;
    
    console.log(`[Scribe] Subscribing to topic: ${topic}`);
    
    const rendezvousId = await this.getRendezvousNode(topic);
    const topicInfo = {
      rendezvousId,
      parent: null,
      children: new Set(),
      lastRefresh: Date.now()
    };
    
    this.subscribedTopics.set(topic, topicInfo);
    
    // Find route to rendezvous node
    const route = await this.dht.findNode(rendezvousId);
    
    if (route.length === 0) {
      // We are the rendezvous node
      console.log(`[Scribe] We are the rendezvous node for ${topic}`);
      return;
    }
    
    // Send JOIN request along the route
    const nextHop = route[0];
    this.sendJoinRequest(topic, nextHop);
  }
  
  // Unsubscribe from a topic
  unsubscribe(topic) {
    const topicInfo = this.subscribedTopics.get(topic);
    if (!topicInfo) return;
    
    console.log(`[Scribe] Unsubscribing from topic: ${topic}`);
    
    // Notify parent
    if (topicInfo.parent) {
      sendPeer(topicInfo.parent.wire, {
        type: 'scribe',
        subtype: 'LEAVE',
        topic,
        childId: this.dht.uint8ArrayToHex(this.nodeId)
      });
    }
    
    // Notify children to find new parent
    topicInfo.children.forEach(child => {
      sendPeer(child.wire, {
        type: 'scribe',
        subtype: 'PARENT_FAILED',
        topic
      });
    });
    
    this.subscribedTopics.delete(topic);
    this.topicMessages.delete(topic);
  }
  
  // Send JOIN request
  sendJoinRequest(topic, peer) {
    sendPeer(peer.wire, {
      type: 'scribe',
      subtype: 'JOIN',
      topic,
      nodeId: this.dht.uint8ArrayToHex(this.nodeId)
    });
  }
  
  // Handle incoming Scribe messages
  handleMessage(msg, fromWire) {
    switch (msg.subtype) {
      case 'JOIN':
        this.handleJoin(msg, fromWire);
        break;
      case 'LEAVE':
        this.handleLeave(msg, fromWire);
        break;
      case 'MULTICAST':
        this.handleMulticast(msg, fromWire);
        break;
      case 'HEARTBEAT':
        this.handleHeartbeat(msg, fromWire);
        break;
      case 'PARENT_FAILED':
        this.handleParentFailed(msg, fromWire);
        break;
    }
  }
  
  // Handle JOIN request
  async handleJoin(msg, fromWire) {
    const { topic, nodeId } = msg;
    const senderId = this.dht.hexToUint8Array(nodeId);
    
    const topicInfo = this.subscribedTopics.get(topic);
    const rendezvousId = await this.getRendezvousNode(topic);
    
    // Check if we're closer to rendezvous than sender
    const ourDistance = this.dht.distance(this.nodeId, rendezvousId);
    const senderDistance = this.dht.distance(senderId, rendezvousId);
    
    if (!topicInfo && this.compareDistances(ourDistance, senderDistance) > 0) {
      // Forward JOIN to next hop
      const route = await this.dht.findNode(rendezvousId);
      if (route.length > 0) {
        sendPeer(route[0].wire, msg);
      }
      return;
    }
    
    // We're on the multicast tree - accept as child
    if (!topicInfo) {
      // Create topic subscription
      this.subscribedTopics.set(topic, {
        rendezvousId,
        parent: null,
        children: new Set(),
        lastRefresh: Date.now()
      });
    }
    
    const info = this.subscribedTopics.get(topic);
    
    if (info.children.size < this.maxChildren) {
      // Accept as child
      info.children.add({
        id: senderId,
        wire: fromWire,
        joinedAt: Date.now()
      });
      
      console.log(`[Scribe] Added child for topic ${topic}. Children: ${info.children.size}`);
      
      // Send acceptance
      sendPeer(fromWire, {
        type: 'scribe',
        subtype: 'JOIN_ACK',
        topic
      });
    } else {
      // Reject - tree node full
      sendPeer(fromWire, {
        type: 'scribe',
        subtype: 'JOIN_REJECT',
        topic
      });
    }
  }
  
  // Compare two distances
  compareDistances(dist1, dist2) {
    for (let i = 0; i < dist1.length; i++) {
      if (dist1[i] !== dist2[i]) {
        return dist1[i] - dist2[i];
      }
    }
    return 0;
  }
  
  // Handle LEAVE message
  handleLeave(msg, fromWire) {
    const { topic, childId } = msg;
    const topicInfo = this.subscribedTopics.get(topic);
    
    if (!topicInfo) return;
    
    // Remove child
    topicInfo.children = new Set(
      Array.from(topicInfo.children).filter(
        child => this.dht.uint8ArrayToHex(child.id) !== childId
      )
    );
    
    console.log(`[Scribe] Child left topic ${topic}. Children: ${topicInfo.children.size}`);
  }
  
  // Multicast a message to a topic
  async multicast(topic, message) {
    const topicInfo = this.subscribedTopics.get(topic);
    if (!topicInfo) {
      // Not subscribed - route to rendezvous
      const rendezvousId = await this.getRendezvousNode(topic);
      const route = await this.dht.findNode(rendezvousId);
      if (route.length > 0) {
        sendPeer(route[0].wire, {
          type: 'scribe',
          subtype: 'MULTICAST',
          topic,
          message,
          messageId: generateId(),
          origin: this.dht.uint8ArrayToHex(this.nodeId)
        });
      }
      return;
    }
    
    // We're on the tree - disseminate
    const messageId = generateId();
    this.disseminateMessage(topic, message, messageId, null);
  }
  
  // Disseminate message down the tree
  disseminateMessage(topic, message, messageId, fromWire) {
    const topicInfo = this.subscribedTopics.get(topic);
    if (!topicInfo) return;
    
    // Check for duplicate
    let recentMessages = this.topicMessages.get(topic);
    if (!recentMessages) {
      recentMessages = new Set();
      this.topicMessages.set(topic, recentMessages);
    }
    
    if (recentMessages.has(messageId)) return;
    recentMessages.add(messageId);
    
    // Clean old messages
    if (recentMessages.size > 1000) {
      const arr = Array.from(recentMessages);
      arr.slice(0, 500).forEach(id => recentMessages.delete(id));
    }
    
    // Forward to parent (if not from parent)
    if (topicInfo.parent && topicInfo.parent.wire !== fromWire) {
      sendPeer(topicInfo.parent.wire, {
        type: 'scribe',
        subtype: 'MULTICAST',
        topic,
        message,
        messageId
      });
    }
    
    // Forward to children (except sender)
    topicInfo.children.forEach(child => {
      if (child.wire !== fromWire && !child.wire.destroyed) {
        sendPeer(child.wire, {
          type: 'scribe',
          subtype: 'MULTICAST',
          topic,
          message,
          messageId
        });
      }
    });
    
    // Deliver locally
    this.deliverMessage(topic, message);
  }
  
  // Handle multicast message
  handleMulticast(msg, fromWire) {
    const { topic, message, messageId } = msg;
    this.disseminateMessage(topic, message, messageId, fromWire);
  }
  
  // Deliver message to local application
  deliverMessage(topic, message) {
    // For now, just log it - integrate with post handling later
    console.log(`[Scribe] Delivered message on topic ${topic}:`, message);
  }
  
  // Start maintenance tasks
  startMaintenance() {
    this.maintenanceTimer = setInterval(() => {
      this.sendHeartbeats();
      this.checkTreeHealth();
    }, this.heartbeatInterval);
  }
  
  // Send heartbeats to children
  sendHeartbeats() {
    this.subscribedTopics.forEach((info, topic) => {
      info.children.forEach(child => {
        if (!child.wire.destroyed) {
          sendPeer(child.wire, {
            type: 'scribe',
            subtype: 'HEARTBEAT',
            topic
          });
        } else {
          // Remove dead child
          info.children.delete(child);
        }
      });
    });
  }
  
  // Check tree health
  checkTreeHealth() {
    const now = Date.now();
    
    this.subscribedTopics.forEach((info, topic) => {
      // Check if parent is still alive
      if (info.parent && now - info.lastRefresh > this.treeRepairTimeout) {
        console.log(`[Scribe] Parent timeout for topic ${topic}, repairing...`);
        this.repairTree(topic);
      }
    });
  }
  
  // Handle heartbeat
  handleHeartbeat(msg, fromWire) {
    const { topic } = msg;
    const topicInfo = this.subscribedTopics.get(topic);
    
    if (topicInfo && topicInfo.parent && topicInfo.parent.wire === fromWire) {
      topicInfo.lastRefresh = Date.now();
    }
  }
  
  // Handle parent failure
  handleParentFailed(msg, fromWire) {
    const { topic } = msg;
    this.repairTree(topic);
  }
  
  // Repair tree after parent failure
  repairTree(topic) {
    const topicInfo = this.subscribedTopics.get(topic);
    if (!topicInfo) return;
    
    topicInfo.parent = null;
    
    // Re-subscribe
    this.subscribe(topic);
  }
  
  // Get statistics
  getStats() {
    const stats = {
      subscribedTopics: this.subscribedTopics.size,
      totalChildren: 0,
      topics: []
    };
    
    this.subscribedTopics.forEach((info, topic) => {
      stats.totalChildren += info.children.size;
      stats.topics.push({
        topic,
        children: info.children.size,
        hasParent: !!info.parent
      });
    });
    
    return stats;
  }
  
  // Cleanup on shutdown
  destroy() {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
    }
    
    // Unsubscribe from all topics
    Array.from(this.subscribedTopics.keys()).forEach(topic => {
      this.unsubscribe(topic);
    });
  }
}
