import { state } from '../main.js';
import { sendPeer } from './network-manager.js';

export class NoiseGenerator {
  constructor() {
    this.noiseInterval = 10000; // 10 seconds
    this.startNoise();
  }
  
  startNoise() {
   //maintenance loop takes care of this
  }
  
  generateNoise() {
    if (state.peers.size < 2) return;
    
    // Random chance to send noise
    if (Math.random() > 0.3) return;
    
    const peers = Array.from(state.peers.values());
    const randomPeer = peers[Math.floor(Math.random() * peers.length)];
    
    const noiseMsg = {
      type: "noise",
      data: Array(Math.floor(Math.random() * 1024))
        .fill(0)
        .map(() => Math.random().toString(36))
        .join(''),
      timestamp: Date.now()
    };
    
    sendPeer(randomPeer.wire, noiseMsg);
  }
}
