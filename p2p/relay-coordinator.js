import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { getServices } from '../services/instances.js';
import { ReputationAwareRelay } from './reputation-aware-relay.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../utils.js';
import nacl from 'tweetnacl';

/**
 * Manages the announcement of this node's relay capabilities to the DHT
 * and the discovery of other active relays from the DHT using a robust index.
 */
export class RelayCoordinator {
  constructor() {
    this.dht = state.dht;
    this.identity = state.myIdentity;
    this.peerManager = null; // Will be injected
    this.selfRelayManager = new ReputationAwareRelay();
    this.announcementTimer = null;
    this.MAX_INDEX_SIZE = 200;

    if (!this.dht || !this.identity) {
      throw new Error("RelayCoordinator requires DHT and identity during construction.");
    }
  }

  // New method for dependency injection
  init(peerManager) {
    this.peerManager = peerManager;
    // Pass the dependency down to the next level
    this.selfRelayManager.init(peerManager);
  }


  /**
   * Starts the periodic process of announcing this node's relay capability.
   */
  start() {
    if (this.announcementTimer) {
      clearInterval(this.announcementTimer);
    }
    
    const announce = async () => {
      // Only announce if we can actually relay.
      if (this.selfRelayManager.calculateRelayTopicCount() > 0) {
        await this.announceRelayCapability();
      }
    };

    // Announce immediately and then periodically.
    announce();
    this.announcementTimer = setInterval(announce, CONFIG.PRIVACY_CONFIG.TOPIC_ROTATION_PERIOD);
    console.log(`[RelayCoordinator] Started. Will announce relay capability every ${CONFIG.PRIVACY_CONFIG.TOPIC_ROTATION_PERIOD / 60000} minutes.`);
  }

  stop() {
    if (this.announcementTimer) {
      clearInterval(this.announcementTimer);
      this.announcementTimer = null;
    }
  }

  /**
   * Fetches, updates, and stores the shared list of active relay node IDs for a given tier.
   * This is a "read-modify-write" operation with conflict potential, but acceptable for this use case.
   * @param {string} indexKey - The DHT key for the index (e.g., 'relay-index:TRUSTED').
   * @param {string} ownNodeIdB64 - This node's own Base64-encoded ID.
   */
async updateRelayIndex(indexKey, ownNodeIdB64) {
    try {
      const existingIndex = (await this.dht.get(indexKey)) || [];
      
      // FIX: Ensure existingIndex is an array
      let nodeIds;
      if (Array.isArray(existingIndex)) {
        nodeIds = existingIndex;
      } else if (existingIndex && typeof existingIndex === 'object' && existingIndex.value) {
        // Handle wrapped values from DHT storage
        nodeIds = Array.isArray(existingIndex.value) ? existingIndex.value : [];
      } else {
        nodeIds = [];
      }
      
      // Add our ID and remove any duplicates
      let updatedNodeIds = new Set([ownNodeIdB64, ...nodeIds]);
      let finalNodeIds = Array.from(updatedNodeIds);
      
      // Prune the list to a maximum size to keep it manageable
      if (finalNodeIds.length > this.MAX_INDEX_SIZE) {
        finalNodeIds = finalNodeIds.slice(0, this.MAX_INDEX_SIZE);
      }
      
      console.log(`[RelayCoordinator] Updating index '${indexKey}' with ${finalNodeIds.length} entries.`);
      await this.dht.store(indexKey, finalNodeIds);
    } catch(e) {
      console.error(`[RelayCoordinator] Failed to update relay index '${indexKey}':`, e);
    }
  }


  /**
   * Builds, signs, and publishes this node's relay announcement and updates the global relay index.
   */
  async announceRelayCapability() {
    await this.selfRelayManager.updateRelayConfiguration();
    const topics = this.selfRelayManager.relayTopics;
    if (topics.length === 0) return;

    const nodeIdB64 = arrayBufferToBase64(this.identity.nodeId); 
    
    // Create the bloom filter string first
    const bloomFilterB64 = arrayBufferToBase64(this.selfRelayManager.createTopicBloomFilter().bits); 



    // Validate that the generated string is a valid Base64 string.
    const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    if (!base64Regex.test(bloomFilterB64)) {
        console.error(`[RelayCoordinator] Generated an invalid Base64 string for the bloom filter. Aborting announcement.`);
        return; // Do not proceed if our own data is invalid.
    }

      const announcement = {
        nodeId: nodeIdB64,
        publicKey: arrayBufferToBase64(this.identity.publicKey),
        epoch: Math.floor(Date.now() / CONFIG.PRIVACY_CONFIG.TOPIC_ROTATION_PERIOD),
        topics: topics,
        bloomFilter: bloomFilterB64,
        reputation: this.peerManager ? 
          this.peerManager.getScore(this.identity.handle) : 0, // Use handle, not idKey
        capacity: {
          currentLoad: Math.random() * 0.5,
          maxThroughput: 100,
          averageLatency: 50 + Math.random() * 50
        }
      };

    // Sign the announcement
    const signature = await this.sign(announcement); 
    const signedAnnouncement = { ...announcement, signature: arrayBufferToBase64(signature) }; 
    // Step 1: Store the full announcement at this node's unique key.
    const tier = this.selfRelayManager.getReputationTier(); 
    const uniqueKey = `relay:announce:${tier}:${nodeIdB64}`; 
    await this.dht.store(uniqueKey, signedAnnouncement, { ttl: CONFIG.PRIVACY_CONFIG.TOPIC_ROTATION_PERIOD * 2 }); 

    // Step 2: Update the shared index for this reputation tier.
    const indexKey = `relay-index:${tier}`; 
    await this.updateRelayIndex(indexKey, nodeIdB64); 
  }

  /**
   * Signs an announcement object.
   * @param {object} announcement - The announcement data.
   * @returns {Promise<Uint8Array>} The signature.
   */
  async sign(announcement) {
    // Create a stable JSON string for signing
    const stringToSign = JSON.stringify(announcement);
    const messageBytes = new TextEncoder().encode(stringToSign);
    return nacl.sign.detached(messageBytes, this.identity.secretKey);
  }

  /**
   * Verifies the signature of a received announcement.
   * @param {object} announcement - The full signed announcement object.
   * @returns {Promise<boolean>}
   */
    async verifySignature(announcement) {
      const { signature, ...dataToVerify } = announcement;
      if (!signature) return false;

      try {
        const messageBytes = new TextEncoder().encode(JSON.stringify(dataToVerify));
        const signatureBytes = base64ToArrayBuffer(signature);
        
        // FIX: The public key is on dataToVerify, not nested deeper.
        // It also needs to be converted from its Base64 string format in the announcement.
        const publicKeyBytes = base64ToArrayBuffer(dataToVerify.publicKey);

        return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
      } catch (e) {
        console.error("[RelayCoordinator] Signature verification failed:", e);
        return false;
      }
    }

  /**
   * Fetches lists of relay node IDs from the DHT, then retrieves the full,
   * signed announcement for each of those nodes.
   * @returns {Promise<object[]>} A list of valid, verified announcements.
   */
  async getActiveRelayAnnouncements() {
    const validAnnouncements = new Set();
    const tiers = ['HIGHLY_TRUSTED', 'TRUSTED', 'ESTABLISHED', 'NEW'];

    // Step 1: Fetch the lists of node IDs for each tier.
    for (const tier of tiers) {
      const indexKey = `relay-index:${tier}`;
      try {
        const nodeIds = await this.dht.get(indexKey);
        if (nodeIds && Array.isArray(nodeIds)) {
          // Step 2: For each node ID, fetch its full announcement.
          const fetchPromises = nodeIds.map(nodeIdB64 => {
            const uniqueKey = `relay:announce:${tier}:${nodeIdB64}`;
            return this.dht.get(uniqueKey);
          });
          
          const announcements = await Promise.all(fetchPromises);
          
          for (const ann of announcements) {
            if (ann) {
              validAnnouncements.add(ann);
            }
          }
        }
      } catch (e) {
        console.warn(`[RelayCoordinator] Could not fetch index for tier ${tier}:`, e);
      }
    }

    // Step 3: Verify and filter all collected announcements.
    const currentEpoch = Math.floor(Date.now() / CONFIG.PRIVACY_CONFIG.TOPIC_ROTATION_PERIOD);
    const verifiedAnnouncements = [];
    for (const ann of validAnnouncements) {
      if (ann.epoch >= currentEpoch - 1 && await this.verifySignature(ann)) {
        verifiedAnnouncements.push(ann);
      }
    }
    
    console.log(`[RelayCoordinator] Discovered and verified ${verifiedAnnouncements.length} active relays.`);
    return verifiedAnnouncements;
  }
}
