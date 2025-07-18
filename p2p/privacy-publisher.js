import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { BloomFilter, generateId, arrayBufferToBase64, base64ToArrayBuffer } from '../utils.js';
import { getServices } from '../services/instances.js';
import wasmVDF from '../vdf-wrapper.js';
import nacl from 'tweetnacl';

/**
 * Handles the process of publishing a post through the privacy mixing layer,
 * ensuring the author's identity is decoupled from the final broadcast.
 */
export class PrivacyPublisher {
  constructor() {
    this.scribe = state.scribe;
    this.dht = state.dht;
    this.nodeId = state.myIdentity?.nodeId;
    
    // --- FIX: Initialize dependencies as null ---
    this.peerManager = null;
    this.relayCoordinator = null;
    this.reputation = 0;

    if (!this.scribe || !this.dht || !this.nodeId) {
      throw new Error("PrivacyPublisher requires scribe, dht, and a node identity to be initialized.");
    }
  }

  // --- FIX: Add init method to inject dependencies ---
  init(peerManager, relayCoordinator) {
    this.peerManager = peerManager;
    this.relayCoordinator = relayCoordinator;
    if (this.peerManager && state.myIdentity) {
      this.reputation = this.peerManager.getScore(state.myIdentity.idKey) || 0;
    }
  }

  /**
   * The main entry point for publishing a post securely.
   * Orchestrates the entire privacy-preserving workflow.
   * @param {Post} post - The post object to be published.
   */
    async publishPost(post) {
      // Step 1: Create the envelope (remains the same)
      const envelope = {
        post: post.toJSON(),
        targetTopics: this.scribe.extractTopics(post.content),
        timestamp: Date.now(),
        routingHint: null
      };

      // Step 2: Select a relay topic (remains the same)
      const relayTopic = await this.selectRelayTopic(envelope);
      // If no relay topic is found (because we are the only node),
      // fall back to publishing directly without the privacy layer.
    if (!relayTopic) {
        console.warn("[PrivacyPublisher] No relay topic found. Publishing directly to Scribe.");
        
        // Ensure we have at least one topic to publish to
        let topics = envelope.targetTopics;
        if (!topics || topics.length === 0) {
            // Default to #general if no topics found
            topics = ['#general'];
            console.log("[PrivacyPublisher] No topics in post, defaulting to #general");
        }
        
        topics.forEach(topic => {
            console.log(`[PrivacyPublisher] Multicasting to topic: ${topic}`);
            this.scribe.multicast(topic, { type: 'new_post', post: envelope.post });
        });
        return;
    }

      // --- START: CORRECTED LOGIC ---

      // Step 3: Generate a temporary key for a one-time VDF proof.
      // This is a conceptual key for this operation; we'll use its output.
      const tempVdfInputKey = JSON.stringify(envelope);
      const workProof = await this.generateVDFProof(tempVdfInputKey);

      // Step 4: Encrypt the envelope using a key derived from the proof.
      const { encrypted, nonce } = this.encryptEnvelope(envelope, workProof);

      // --- END: CORRECTED LOGIC ---

      // Step 5: Create the final RelayRequest object.
      const priorityHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.reputation.toString())));
      
      const request = {
        version: 1,
        type: 'RELAY_REQUEST',
        payload: {
            ciphertext: arrayBufferToBase64(encrypted),
            nonce: arrayBufferToBase64(nonce)
        },
        workProof: workProof,
        priorityHash: priorityHash
      };

      // Step 6: Publish the request (remains the same)
      console.log(`[PrivacyPublisher] Publishing RELAY_REQUEST to topic: ${relayTopic}`);
      await this.scribe.multicast(relayTopic, request);
    }

  /**
   * Encrypts the envelope using a key derived from the VDF proof.
   * This allows any node that verifies the proof to decrypt the message.
   * @param {object} envelope - The decrypted envelope.
   * @param {object} workProof - The VDF proof.
   * @returns {{encrypted: Uint8Array, nonce: Uint8Array}}
   */
  encryptEnvelope(envelope, workProof) {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const messageBytes = new TextEncoder().encode(JSON.stringify(envelope));
    
    // Derive a symmetric key from the VDF proof's output.
    // This is a critical step: the key must be derivable by the relay.
    const keyData = new TextEncoder().encode(workProof.y + workProof.pi);
    const key = new Uint8Array(nacl.hash(keyData)).slice(0, nacl.secretbox.keyLength);

    const ciphertext = nacl.secretbox(messageBytes, nonce, key);
    return { encrypted: ciphertext, nonce: nonce };
  }

  /**
   * Generates a VDF proof of work for the relay request.
   * @param {string} input - The input data for the VDF.
   * @returns {Promise<VDFProof>}
   */
  async generateVDFProof(input) {
    // Using the progressiveVDF service to calculate adaptive iterations
    // is better than a fixed number. We'll use the main service for this.
    const progressiveVDF = getServices().progressiveVDF;
    if (!progressiveVDF) {
        // Fallback for safety
        const iterations = 10000n;
        return await wasmVDF.computeVDFProofWithTimeout(input, iterations, () => {});
    }
    // The adaptive proof function calculates the right number of iterations.
    return await progressiveVDF.computeAdaptiveProof(input, state.myIdentity.uniqueId, input);
  }

  /**
   * Selects a relay topic from the network by finding active relays,
   * weighting them by reputation and capacity, and making a random selection.
   * @param {object} envelope - The decrypted envelope.
   * @returns {Promise<string|null>} A relay topic string.
   */
    async selectRelayTopic(envelope) {
        const announcements = await this.relayCoordinator.getActiveRelayAnnouncements();
        if (announcements.length === 0) return null;

        const compatible = announcements.filter(ann => {
          const bloom = new BloomFilter(
            CONFIG.PRIVACY_CONFIG.BLOOM_FILTER_SIZE,
            CONFIG.PRIVACY_CONFIG.BLOOM_HASH_FUNCTIONS
          );
          // The announcement contains the raw Uint8Array bits
          // Add a check to ensure the bloomFilter property is a valid base64 string before decoding.
          if (ann.bloomFilter && typeof ann.bloomFilter === 'string') {
            bloom.bits = base64ToArrayBuffer(ann.bloomFilter); 
          } else {
            // If the bloomFilter is missing or invalid, this relay is not compatible.
            return false;
          }

          return envelope.targetTopics.some(topic => bloom.has(topic));
        });

        if (compatible.length === 0) return null;

        // --- NEW: Enforce Relay Diversity ---
        let weighted = compatible.map(ann => ({
            ann,
            weight: this.calculateRelayWeight(ann)
        }));
        
        const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
        const maxWeightPerNode = totalWeight * 0.1; // No node can have more than 10% of the selection weight

        weighted = weighted.map(item => ({
            ...item,
            weight: Math.min(item.weight, maxWeightPerNode)
        }));
        // --- End of new logic ---
        
        const newTotalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
        let random = Math.random() * newTotalWeight;

        for (const item of weighted) {
            random -= item.weight;
            if (random <= 0) {
                const selectedAnnouncement = item.ann;
                return selectedAnnouncement.topics[Math.floor(Math.random() * selectedAnnouncement.topics.length)];
            }
        }
        
        // Fallback
        return compatible[0].topics[0];
    }
    /**
   * Calculates a selection weight for a relay announcement.
   * @param {object} announcement - The relay announcement.
   * @returns {number} The calculated weight.
   */
  calculateRelayWeight(announcement) {
    const repWeight = Math.log10(announcement.reputation + 1);
    const capacityWeight = 1 - announcement.capacity.currentLoad;
    const latencyWeight = 1 / (1 + announcement.capacity.averageLatency / 1000);
    
    return repWeight * capacityWeight * latencyWeight;
  }
}
