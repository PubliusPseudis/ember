import { CONFIG } from '../config.js';
import { BloomFilter } from '../utils.js';
import { state } from '../state.js';
import { getServices } from '../services/instances.js';

/**
 * Manages the node's role as a relay, determining which privacy-mixing
 * topics to monitor based on its reputation.
 */
export class ReputationAwareRelay {
  constructor() {
    this.nodeId = state.myIdentity?.nodeId;
    this.peerManager = null; // Will be injected
    this.reputation = 0;
    this.relayTopics = [];
    this.bloomFilter = null;

    if (!this.nodeId) {
      throw new Error("ReputationAwareRelay cannot be initialized without a nodeId.");
    }
  }

  // New method for dependency injection
  init(peerManager) {
    this.peerManager = peerManager;
    // The user's own reputation is self-determined, not tracked like a peer's.
    // We can just use a default or a more direct value if needed later.
    this.reputation = 500; // Default to an "Established" score.
  }
  /**
   * Determines the node's reputation tier based on its score.
   * @returns {string} The reputation tier (e.g., 'NEW', 'TRUSTED').
   */
  getReputationTier() {
    const tiers = CONFIG.PRIVACY_CONFIG.REPUTATION_TIERS;
    if (this.reputation >= tiers.HIGHLY_TRUSTED) return 'HIGHLY_TRUSTED';
    if (this.reputation >= tiers.TRUSTED) return 'TRUSTED';
    if (this.reputation >= tiers.ESTABLISHED) return 'ESTABLISHED';
    if (this.reputation >= tiers.NEW) return 'NEW';
    return 'UNTRUSTED';
  }

  /**
   * Calculates how many relay topics this node should monitor.
   * Higher reputation nodes monitor more topics.
   * @returns {number} The number of relay topics.
   */
  calculateRelayTopicCount() {
    const tier = this.getReputationTier();
    const config = CONFIG.PRIVACY_CONFIG;
    
    switch(tier) {
      case 'UNTRUSTED': return 0; // Cannot relay
      case 'NEW': return config.MIN_RELAY_TOPICS;
      case 'ESTABLISHED': return 5;
      case 'TRUSTED': return 10;
      case 'HIGHLY_TRUSTED': return config.MAX_RELAY_TOPICS;
      default: return 0;
    }
  }

  /**
   * Deterministically generates a list of relay topics for the current epoch
   * based on the node's ID and reputation.
   * @returns {Promise<string[]>} A promise that resolves to an array of topic strings.
   */
  async generateRelayTopics() {
    const topicCount = this.calculateRelayTopicCount();
    if (topicCount === 0) {
      this.relayTopics = [];
      return [];
    }
    
    const epoch = Math.floor(Date.now() / CONFIG.PRIVACY_CONFIG.TOPIC_ROTATION_PERIOD);
    const topics = new Set();
    
    // Create a seed from the node's ID and the current time epoch
    const encoder = new TextEncoder();
    const data = encoder.encode(this.nodeId.toString() + epoch.toString());
    let seedBuffer = await crypto.subtle.digest('SHA-256', data);

    while (topics.size < topicCount) {
      // Use reputation to bias toward lower-numbered (more popular) topics
      const repFactor = this.reputation / CONFIG.PRIVACY_CONFIG.REPUTATION_TIERS.HIGHLY_TRUSTED;
      const bias = 1 - Math.min(repFactor, 1); // Inverse of reputation
      const range = Math.floor(CONFIG.PRIVACY_CONFIG.RELAY_TOPIC_UNIVERSE * (0.3 + 0.7 * bias));
      
      // Generate a number from the seed
      const seedInt = new DataView(seedBuffer).getUint32(0, false);
      const topicIndex = seedInt % range;
      
      topics.add(`ember:relay:${topicIndex}`);
      
      // Hash the seed to get the next one
      seedBuffer = await crypto.subtle.digest('SHA-256', seedBuffer);
    }
    
    this.relayTopics = Array.from(topics);
    return this.relayTopics;
  }

  /**
   * Creates a bloom filter populated with the node's current relay topics.
   * @returns {BloomFilter} The generated bloom filter.
   */
  createTopicBloomFilter() {
    if (this.relayTopics.length === 0) {
      return null;
    }

    const bloom = new BloomFilter(
      CONFIG.PRIVACY_CONFIG.BLOOM_FILTER_SIZE,
      CONFIG.PRIVACY_CONFIG.BLOOM_HASH_FUNCTIONS
    );
    
    this.relayTopics.forEach(topic => bloom.add(topic));
    
    this.bloomFilter = bloom;
    return bloom;
  }

  /**
   * Updates the node's relay topics and bloom filter. This should be
   * called when reputation changes or a new epoch begins.
   */
  async updateRelayConfiguration() {
    await this.generateRelayTopics();
    this.createTopicBloomFilter();
    console.log(`[Relay] Updated relay configuration. Now monitoring ${this.relayTopics.length} topics.`);
  }
}
