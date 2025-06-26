import { state, handleNewPost } from '../main.js';
import { sendPeer, handlePeerMessage } from './network-manager.js';

export class DandelionRouter {
  constructor() {
    this.stemProbability = 0.9;
    this.maxStemLength = 10;
    this.onionLayers = 3; // New: multi-hop routing
  }
  
  // Create onion-wrapped message
  createOnionMessage(msg, hops) {
    let wrapped = msg;
    
    // Wrap message in layers
    for (let i = 0; i < hops.length; i++) {
      wrapped = {
        type: "onion_relay",
        nextHop: i < hops.length - 1 ? hops[i + 1].id : null,
        payload: wrapped,
        padding: this.generatePadding()
      };
    }
    
    return wrapped;
  }
  
  generatePadding() {
    // Random padding to obscure message size
    const size = Math.floor(Math.random() * 512);
    return Array(size).fill('x').join('');
  }
  
  
routePost(post, fromWire = null) {
  const postData = post.toJSON();
  
  // Include VDF proof if present
  if (post.vdfProof) {
    postData.vdfProof = post.vdfProof;
    postData.vdfInput = post.vdfInput;
  }
  
  // Use Plumtree if available and network is large enough
  if (state.plumtree && state.peers.size > 5) {
    state.plumtree.broadcast({
      type: 'post',
      data: postData
    });
    return;
  }
  
  // Fall back to existing Dandelion routing
  const msg = {
    type: "new_post",
    post: postData,
    phase: "stem",
    hopCount: 0
  };
  
  this.propagate(msg, fromWire);
}
  
  // Route through multiple hops
  routePostSecure(post, fromWire = null) {
    const availablePeers = Array.from(state.peers.values())
      .filter(p => p.wire !== fromWire && !p.wire.destroyed);
    
    if (availablePeers.length < this.onionLayers) {
      // Fall back to regular routing if not enough peers
      return this.routePost(post, fromWire);
    }
    
    // Select random path
    const hops = [];
    const shuffled = [...availablePeers].sort(() => Math.random() - 0.5);
    for (let i = 0; i < this.onionLayers; i++) {
      hops.push(shuffled[i]);
    }
    
    const onionMsg = this.createOnionMessage({
      type: "new_post",
      post: post.toJSON(),
      phase: "stem",
      hopCount: 0
    }, hops);
    
    // Send to first hop with delay
    setTimeout(() => {
      sendPeer(hops[0].wire, onionMsg);
    }, Math.random() * 2000);
  }
  
  handleOnionRelay(msg, fromWire) {
    // Peel one layer
    const inner = msg.payload;
    
    if (msg.nextHop) {
      // Forward to next hop
      const nextPeer = Array.from(state.peers.values())
        .find(p => p.id === msg.nextHop);
      
      if (nextPeer) {
        setTimeout(() => {
          sendPeer(nextPeer.wire, inner);
        }, Math.random() * 1000);
      }
    } else {
      // We're the final hop, process the message
      handlePeerMessage(inner, fromWire);
    }
  }
  
      propagate(msg, fromWire = null) {
      // Find all potential peers to forward to (excluding the sender)
      const peers = Array.from(state.peers.values())
        .filter(p => p.wire !== fromWire);
      
      if (peers.length > 0) {
        // Select one random peer to continue the stem
        const randomPeer = peers[Math.floor(Math.random() * peers.length)];
        
        // Send the message to the chosen peer
        sendPeer(randomPeer.wire, msg);
      }
    }

    // Handle incoming posts based on phase
    async handleRoutedPost(msg, fromWire) {
      if (msg.phase === "stem") {
        await this.handleStemPhase(msg, fromWire);
      } else {
        await this.handleFluffPhase(msg, fromWire);
      }
    }

    async handleStemPhase(msg, fromWire) {
      msg.hopCount++;
      
      // Decide whether to continue stem or start fluff
      const continuesStem = Math.random() < this.stemProbability && 
                           msg.hopCount < this.maxStemLength;
      
      if (continuesStem && state.peers.size > 1) {
        // Forward to exactly one random peer (not sender)
        const peers = Array.from(state.peers.values())
          .filter(p => p.wire !== fromWire);
        
        if (peers.length > 0) {
          const randomPeer = peers[Math.floor(Math.random() * peers.length)];
          
          // Add small random delay to prevent timing analysis
          setTimeout(() => {
            sendPeer(randomPeer.wire, msg);
          }, Math.random() * 1000); // 0-1 second delay
        }
      } else {
        // Switch to fluff phase
        msg.phase = "fluff";
        msg.hopCount = 0;
        await this.handleFluffPhase(msg, fromWire);
      }
    }

    async handleFluffPhase(msg, fromWire) {
      // First time seeing this post in fluff phase
      if (!state.posts.has(msg.post.id) && !state.seenPosts.has(msg.post.id)) {
        // Process the post normally
        await handleNewPost(msg.post, fromWire);
        
        // Broadcast to all peers except sender
        for (const { wire } of state.peers.values()) {
          if (wire !== fromWire && !wire.destroyed && wire.ephemeral_msg?._ready) {
            sendPeer(wire, {
              type: "new_post",
              post: msg.post,
              phase: "fluff"
            });
          }
        }
      }
    }
     
  
}
