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
import { activityProfile } from './services/activity-profile.js';
import { contentSimilarity } from './services/content-similarity.js';
import { LivingPostManager } from './services/living-post-vm.js';

// --- SERVICE INSTANCES ---
export function initializeServices(dependencies = {}) {
  const imageStore = new ContentAddressedImageStore();

  (function attachBlobShims(s) {
    if (!s.put) s.put = async (blob, meta = {}) => {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onerror = rej;
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
      return s.storeImage(dataUrl, {
        ...meta,
        mime: blob.type || meta.mime,
        size: blob.size ?? meta.size
      });
    };
    if (!s.getBlob) s.getBlob = async (hash) => {
      const dataUrl = await s.retrieveImage(hash);
      const [, b64] = dataUrl.split(',', 2);
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
      return new Blob([bytes], { type: mime });
    };
    if (!s.getArrayBuffer) s.getArrayBuffer = async (hash) => (await s.getBlob(hash)).arrayBuffer();
    if (!s.getText) s.getText = async (hash) => (await s.getBlob(hash)).text();
  })(imageStore);

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
    relayCoordinator: new RelayCoordinator(),
    activityProfile: activityProfile,
    contentSimilarity: contentSimilarity,
    livingPostManager: new LivingPostManager()
  };
  
  setServices(services);
  services.relayCoordinator.init(services.peerManager);
  services.privacyPublisher.init(services.peerManager, services.relayCoordinator);
  return services;
}

// Re-export for backward compatibility
export { getServices, getImageStore, getPeerManager, getStateManager } from './services/instances.js';
