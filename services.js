// FILE: services.js

// --- IMPORTS FOR ALL SERVICES ---
import { VerificationQueue } from './verification-queue.js';
import { MemoryManager } from './services/memory-manager.js';
import { PeerManager } from './services/peer-manager.js';
import { ContentAddressedImageStore } from './services/image-store.js';
import { ProgressiveVDF } from './identity/vdf.js';
import { NoiseGenerator } from './p2p/noise-generator.js';
import { TrafficMixer } from './p2p/traffic-mixer.js';
import { EpidemicGossip } from './p2p/epidemic-gossip.js';

import { StateManager } from './storage.js';
import { setServices } from './services/instances.js';

// --- SERVICE INSTANCES ---
// Create instances with dependency injection
export function initializeServices(dependencies = {}) {
  const imageStore = new ContentAddressedImageStore();
  const peerManager = new PeerManager();
  
  const stateManager = new StateManager({
    imageStore,
    peerManager,
    renderPost: dependencies.renderPost
  });
  
  const services = {
    stateManager,
    verificationQueue: new VerificationQueue(),
    imageStore,
    peerManager,
    memoryManager: new MemoryManager(),
    progressiveVDF: new ProgressiveVDF(),
    noiseGenerator: new NoiseGenerator(),
    trafficMixer: new TrafficMixer(),
    epidemicGossip: new EpidemicGossip()
  };
  
  setServices(services);
  return services;
}

// Re-export for backward compatibility
export { getServices, getImageStore, getPeerManager, getStateManager } from './services/instances.js';


