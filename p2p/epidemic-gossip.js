import { state } from '../main.js';
import { sendPeer } from './network-manager.js';

export class EpidemicGossip {
  constructor() {
    this.messageTTL = new Map(); // Track message hops
    this.maxHops = 6;
  }
  
  selectRandomPeers(count, excludePeers = []) {
    const available = Array.from(state.peers.values())
      .filter(p => !excludePeers.includes(p.wire) && !p.wire.destroyed);
    
    // Fisher-Yates shuffle
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    
    return available.slice(0, count);
  }
  
  sendWithExponentialBackoff(peer, msg, attempt = 0) {
    if (attempt > 3) return;
    
    const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
    setTimeout(() => {
      if (!peer.wire.destroyed && peer.wire.ephemeral_msg?._ready) {
        sendPeer(peer.wire, msg);
      } else if (attempt < 3) {
        this.sendWithExponentialBackoff(peer, msg, attempt + 1);
      }
    }, delay + Math.random() * 100);
  }
}
