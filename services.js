// FILE: services.js

// --- IMPORTS FOR ALL SERVICES ---
import { VerificationQueue } from './verification-queue.js';
import { MemoryManager } from './services/memory-manager.js';
import { PeerManager } from './services/peer-manager.js';
import { ContentAddressedImageStore } from './services/image-store.js';
import { ProgressiveVDF } from './identity/vdf.js';
import { NoiseGenerator } from './p2p/noise-generator.js';
import { TrafficMixer } from './p2p/traffic-mixer.js';
import { PrivacyPublisher } from './p2p/privacy-publisher.js'; 
import { MixingNode } from './p2p/mixing-node.js';
import { RelayCoordinator } from './p2p/relay-coordinator.js';
import { StateManager } from './storage.js';
import { setServices } from './services/instances.js';

// --- SERVICE INSTANCES ---
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
    privacyPublisher: new PrivacyPublisher(),
    mixingNode: new MixingNode(),
    relayCoordinator: new RelayCoordinator() 
  };
  
  // First, make all services globally available.
  setServices(services);

  // Second, initialize dependencies in the correct order.
  services.relayCoordinator.init(services.peerManager);
  services.privacyPublisher.init(services.peerManager, services.relayCoordinator);
  
  return services;
}

// Re-export for backward compatibility
export { getServices, getImageStore, getPeerManager, getStateManager } from './services/instances.js';
