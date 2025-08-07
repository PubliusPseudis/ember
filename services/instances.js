// services/instances.js
let stateManager, verificationQueue, imageStore, peerManager, memoryManager;
let progressiveVDF, noiseGenerator, trafficMixer, privacyPublisher, mixingNode,relayCoordinator, activityProfile; 


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
    relayCoordinator,
    activityProfile
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
    relayCoordinator,
    activityProfile
  } = services);
}

export const getStateManager = () => stateManager;
export const getImageStore = () => imageStore;
export const getPeerManager = () => peerManager;
