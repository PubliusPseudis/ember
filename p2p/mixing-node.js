import { state } from '../state.js';
import { CONFIG } from '../config.js';
import nacl from 'tweetnacl';

/**
 * Manages the mixing pools for incoming relay requests, providing temporal
 * privacy by batching and delaying posts before publishing them to Scribe.
 */
export class MixingNode {
  constructor() {
    // Pools are segregated by reputation to prevent low-rep spam from
    // affecting the latency of high-rep user posts.
    this.mixingPools = new Map([
      ['low', []],
      ['medium', []],
      ['high', []]
    ]);
    this.scribe = state.scribe;

    // Start a timer to periodically check for pool timeouts.
    setInterval(() => {
      this.mixingPools.forEach((pool, poolKey) => {
        this.checkPoolFlush(poolKey);
      });
    }, 5000); // Check every 5 seconds
  }

  /**
   * Adds a decrypted and validated envelope to the appropriate mixing pool.
   * @param {object} envelope - The decrypted post envelope.
   * @param {number} senderReputation - The estimated reputation of the original sender.
   */
  add(envelope, senderReputation) {
    const poolKey = this.selectMixingPool(senderReputation);
    const pool = this.mixingPools.get(poolKey);
    
    pool.push({
      envelope: envelope,
      receivedAt: Date.now(),
    });
    console.log(`[MixingNode] Added post to '${poolKey}' pool. Pool size: ${pool.length}`);

    // Check if this addition triggers a flush.
    this.checkPoolFlush(poolKey);
  }

  /**
   * Selects a mixing pool key based on reputation.
   * @param {number} reputation - The sender's reputation score.
   * @returns {'low'|'medium'|'high'}
   */
  selectMixingPool(reputation) {
    const tiers = CONFIG.PRIVACY_CONFIG.REPUTATION_TIERS;
    if (reputation >= tiers.TRUSTED) return 'high';
    if (reputation >= tiers.ESTABLISHED) return 'medium';
    return 'low';
  }

  /**
   * Checks if a pool meets the conditions for flushing (either size or timeout).
   * @param {string} poolKey - The key for the pool to check ('low', 'medium', 'high').
   */
  checkPoolFlush(poolKey) {
    const pool = this.mixingPools.get(poolKey);
    if (!pool || pool.length === 0) return;

    const now = Date.now();
    const config = CONFIG.PRIVACY_CONFIG;

    const sizeTrigger = pool.length >= config.POOL_FLUSH_THRESHOLD;
    const timeTrigger = now - pool[0].receivedAt > config.POOL_TIMEOUT;

    if (sizeTrigger || timeTrigger) {
      this.flushPool(poolKey);
    }
  }

  /**
   * Flushes a pool, sending its contents to the Scribe network after a delay.
   * @param {string} poolKey - The key for the pool to flush.
   */
  async flushPool(poolKey) {
    const pool = this.mixingPools.get(poolKey);
    if (!pool || pool.length === 0) return;
    // Immediately clear the pool for the next batch.
    this.mixingPools.set(poolKey, []);
    console.log(`[MixingNode] Flushing '${poolKey}' pool with ${pool.length} items.`);
    // Shuffle the pool to resist timing analysis.
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    // --- FIX START ---
    // Correctly get our own reputation from the relay manager service.
    const selfReputation = getServices().relayCoordinator.selfRelayManager.reputation || 0;
    const baseDelay = CONFIG.PRIVACY_CONFIG.BASE_MIXING_DELAY;
    const repFactor = Math.min(1, selfReputation / CONFIG.PRIVACY_CONFIG.REPUTATION_TIERS.TRUSTED);
    const adjustedDelay = baseDelay * (1 - repFactor * CONFIG.PRIVACY_CONFIG.REPUTATION_DELAY_FACTOR);
    // --- FIX END ---
    
    for (const item of pool) {
      const jitter = Math.random() * adjustedDelay;
      setTimeout(async () => {
        try {
          // Publish the original post to its final destination topics on the Scribe network.
          console.log(`[MixingNode] Publishing post ${item.envelope.post.id} to topics:`, item.envelope.targetTopics);
          // Corrected: Loop through all target topics to multicast
          for (const topic of item.envelope.targetTopics) {
              this.scribe.multicast(topic, { type: 'new_post', post: item.envelope.post });
          }

        } catch (error) {
          console.error(`[MixingNode] Failed to publish post from flushed pool:`, error);
    
        }
      }, jitter);
    }
  }

}
