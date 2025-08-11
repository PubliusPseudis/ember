// services/instances.js
let stateManager, verificationQueue, imageStore, peerManager, memoryManager;
let progressiveVDF, noiseGenerator, trafficMixer, privacyPublisher, mixingNode, relayCoordinator, activityProfile, contentSimilarity, livingPostManager;


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
    activityProfile,
    contentSimilarity,
    livingPostManager
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
    activityProfile,
    contentSimilarity,
    livingPostManager
  } = services);
}

export const getStateManager = () => stateManager;
export const getImageStore = () => imageStore;
export const getPeerManager = () => peerManager;
export { imageStore as xpAssets };
export const getXpAssets = () => imageStore;
