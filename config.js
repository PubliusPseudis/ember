export const CONFIG = {
  MAX_POSTS: 1000,
  MAX_POST_SIZE: 1120,
  MAX_PEERS: 50,
  MAX_MESSAGE_SIZE: 1 * 1024 * 1024, // 1MB
  RATE_LIMIT_MESSAGES: 50,
  RATE_LIMIT_WINDOW: 60_000,
  GARBAGE_COLLECT_INTERVAL: 60_000,
  CARRIER_UPDATE_INTERVAL: 30_000,
  TOXICITY_THRESHOLD: 0.9,
  LOCAL_MODE: false,
  IDENTITY_CONFIRMATION_THRESHOLD: 1,
  NSFWJS_MODEL_PATH: 'nsfwjs-model/',
  TRUST_THRESHOLD: 30, // Minimum trust score to skip verification
  ATTESTATION_TIMEOUT: 1000, // Max time to wait for attestations (1 second)
  MAX_PENDING_MESSAGES: 100, // Max messages to queue per peer before handshake
};
