import { sendPeer } from './network-manager.js';

export class TrafficMixer {
  constructor() {
    this.mixPool = [];
    this.mixInterval = 5000; // 5 seconds
    this.startMixing();
  }
  
  addToMixPool(msg, wire) {
    this.mixPool.push({ msg, wire, timestamp: Date.now() });
    
    // Limit pool size
    if (this.mixPool.length > 50) {
      this.mixPool.shift();
    }
  }
  
  startMixing() {
    //maintenance loop takes care of this
  }
  
  mix() {
    if (this.mixPool.length < 3) return;
    
    // Shuffle and send random messages
    const shuffled = [...this.mixPool].sort(() => Math.random() - 0.5);
    const toSend = shuffled.slice(0, Math.min(3, shuffled.length));
    
    toSend.forEach(({ msg, wire }) => {
      // Remove from pool
      const index = this.mixPool.indexOf(msg);
      if (index > -1) this.mixPool.splice(index, 1);
      
      // Send with random delay
      setTimeout(() => {
        if (!wire.destroyed) sendPeer(wire, msg);
      }, Math.random() * 1000);
    });
  }
}
