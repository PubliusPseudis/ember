export const CONFIG = {
  MAX_POSTS: 1000,
  MAX_POST_SIZE: 112000,
  MAX_PEERS: 50,
  MAX_MESSAGE_SIZE: 10 * 1024 * 1024, // 10MB
  RATE_LIMIT_MESSAGES: 250,
  RATE_LIMIT_WINDOW: 60_000,
  GARBAGE_COLLECT_INTERVAL: 60_000,
  CARRIER_UPDATE_INTERVAL: 30_000,
  TOXICITY_THRESHOLD: 0.9,
  LOCAL_MODE: false,
  IDENTITY_CONFIRMATION_THRESHOLD: 1,
  NSFWJS_MODEL_PATH: 'nsfwjs-model/',
  TRUST_THRESHOLD: 30, // Minimum trust score to skip verification
  ATTESTATION_TIMEOUT: 15000, // Max time to wait for attestations (15 second)
  MAX_PENDING_MESSAGES: 100, // Max messages to queue per peer before handshake

 // LP moderation mode: 'balanced' or 'off'
  LP_MODERATION: 'off',


  // --- NEW: Universal Privacy Mixing Layer ---
  PRIVACY_CONFIG: {
    // Relay topic assignment
    MIN_RELAY_TOPICS: 1,                    // Minimum for new nodes
    MAX_RELAY_TOPICS: 20,                   // Maximum for highest reputation
    RELAY_TOPIC_UNIVERSE: 10000,            // Total possible relay topics
    TOPIC_ROTATION_PERIOD: 3600000,         // 1 hour in ms
    
    // Bloom filter parameters
    BLOOM_FILTER_SIZE: 1024,                // bits
    BLOOM_HASH_FUNCTIONS: 3,                // hash function count
    BLOOM_FALSE_POSITIVE_RATE: 0.01,        // target FP rate
    
    // Mixing parameters  
    POOL_FLUSH_THRESHOLD: 5,                // minimum posts before flush
    POOL_TIMEOUT: 30000,                    // force flush after 30s
    BASE_MIXING_DELAY: 5000,                // base delay in ms
    REPUTATION_DELAY_FACTOR: 0.7,           // high rep = shorter delays
    
    // Rate limiting
    RELAY_RATE_WINDOW: 3600000,             // 1 hour
    RELAY_RATE_BASE: 150,                    // base rate for new nodes
    RELAY_RATE_REPUTATION_MULTIPLIER: 10,   // max 10x for trusted nodes
    
    // Reputation thresholds
    REPUTATION_TIERS: {
      UNTRUSTED: 0,
      NEW: 100,
      ESTABLISHED: 1000,
      TRUSTED: 5000,
      HIGHLY_TRUSTED: 10000
    }
  }
};
