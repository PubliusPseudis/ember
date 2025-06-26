import { state } from '../main.js';

export class PeerManager {
  constructor() {
    this.scores = new Map();
  }
  
  updateScore(peerId, action, value = 1) {
    const current = this.scores.get(peerId) || { 
      messages: 0, 
      posts: 0, 
      uptime: Date.now(),
      quality: 1.0 
    };
    
    switch(action) {
      case 'message': current.messages += value; break;
      case 'post': current.posts += value; break;
      case 'error': current.quality *= 0.9; break;
    }
    
    this.scores.set(peerId, current);
  }
  
  getScore(peerId) {
    const data = this.scores.get(peerId);
    if (!data) return 0;
    
    const uptime = (Date.now() - data.uptime) / 1000 / 60; // minutes
    return (data.posts * 10 + data.messages + uptime) * data.quality;
  }
  
  getBestPeers(count = 10) {
    return Array.from(state.peers.entries())
      .map(([id, peer]) => ({ id, peer, score: this.getScore(id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => item.peer);
  }
}
