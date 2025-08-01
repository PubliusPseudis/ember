// services/instances.js
let stateManager, verificationQueue, imageStore, peerManager, memoryManager;
let progressiveVDF, noiseGenerator, trafficMixer, privacyPublisher, mixingNode,relayCoordinator; 

export function getServices() {
  return {
    stateManager,
    verificationQueue,
    imageStore,
    peerManager,
    memoryManager,
    progressiveVDF,
    noiseGenerator,
    trafficMixer,
    privacyPublisher,
    mixingNode,
    relayCoordinator
  };
}

export function setServices(services) {
  ({
    stateManager,
    verificationQueue,
    imageStore,
    peerManager,
    memoryManager,
    progressiveVDF,
    noiseGenerator,
    trafficMixer,
    privacyPublisher,
    mixingNode,
    relayCoordinator
  } = services);
}

export const getStateManager = () => stateManager;
export const getImageStore = () => imageStore;
export const getPeerManager = () => peerManager;
