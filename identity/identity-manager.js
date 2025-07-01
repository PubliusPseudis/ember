import nacl from 'tweetnacl'; 
import wasmVDF from '../vdf-wrapper.js';
import { state } from '../main.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../utils.js';

// --- NEW, ROBUST IDENTITY REGISTRY ---
export class IdentityRegistry {
  constructor(dht) {
    this.dht = dht;
    this.verifiedIdentities = new Map(); // handle -> identity info
  }
  
  // --- STEP 1: Main registration function ---
  // Stores the full identity claim using the PUBLIC KEY as the address.
async registerIdentity(handle, keyPair, vdfProof, vdfInput) {
  console.log(`[Identity] Starting registration for handle: ${handle}`);
  
  const publicKeyB64 = arrayBufferToBase64(keyPair.publicKey);

  // First, check if the desired handle is already taken
  const existingPubkey = await this.dht.get(`handle-to-pubkey:${handle.toLowerCase()}`);
  if (existingPubkey) {
    throw new Error(`Handle "${handle}" is already registered.`);
  }

  // Create the primary identity claim
  const claim = {
    handle: handle,
    publicKey: publicKeyB64,
    encryptionPublicKey: state.myIdentity.encryptionPublicKey,
    vdfProof: {
      y: vdfProof.y,
      pi: vdfProof.pi,
      l: vdfProof.l,
      r: vdfProof.r,
      iterations: vdfProof.iterations.toString()
    },
    vdfInput: vdfInput,
    claimedAt: Date.now(),
    nodeId: arrayBufferToBase64(await crypto.subtle.digest('SHA-1', keyPair.publicKey))
  };
  
  // Sign the ENTIRE claim
  const claimData = JSON.stringify(claim);
  const signature = nacl.sign(new TextEncoder().encode(claimData), keyPair.secretKey);
  claim.signature = arrayBufferToBase64(signature);

  // Store with high replication factor for identity data
  const identityOptions = {
    propagate: true,
    refresh: true,
    replicationFactor: 30 // Higher replication for critical identity data
  };

  // Store the FULL claim at the pubkey address
  const pubkeyAddress = `pubkey:${publicKeyB64}`;
  const pubkeyResult = await this.dht.store(pubkeyAddress, claim, identityOptions);
  
  if (pubkeyResult.replicas < 3) {
    console.warn(`[Identity] Low replication for identity claim: ${pubkeyResult.replicas} replicas`);
  }

  // Store the secondary mapping from handle -> pubkey
  const handleAddress = `handle-to-pubkey:${handle.toLowerCase()}`;
  const handleResult = await this.dht.store(handleAddress, { publicKey: publicKeyB64 }, identityOptions);
  
  if (handleResult.replicas < 3) {
    console.warn(`[Identity] Low replication for handle mapping: ${handleResult.replicas} replicas`);
  }

  console.log(`[Identity] Successfully registered ${handle} with ${pubkeyResult.replicas} replicas`);
  return claim;
}
  
  // --- STEP 2: Main lookup function ---
  // Now, to look up a user, we first find their pubkey, then get their full data.
async lookupHandle(handle) {
    const handleAddress = `handle-to-pubkey:${handle.toLowerCase()}`;
    console.log(`[DM] Looking up handle: ${handle} at DHT address: ${handleAddress}`);
    
    const mapping = await this.dht.get(handleAddress);
    if (!mapping || !mapping.publicKey) {
        console.warn(`[DM] No public key found for handle ${handle}.`);
        return null;
    }
    
    const publicKeyB64 = mapping.publicKey;
    const pubkeyAddress = `pubkey:${publicKeyB64}`;
    console.log(`[DM] Found public key. Fetching full claim from: ${pubkeyAddress}`);
    
    const claim = await this.dht.get(pubkeyAddress);
    if (!claim) {
        console.warn(`[DM] Found pubkey for ${handle}, but the full claim is missing from the DHT.`);
        return null;
    }

    // Handle wrapped values from DHT storage
    const actualClaim = claim.value || claim;

    // DEBUG: Log the claim structure
    console.log(`[DM] Retrieved claim structure:`, Object.keys(actualClaim));
    console.log(`[DM] Claim has encryptionPublicKey: ${!!actualClaim.encryptionPublicKey}`);

    // Always verify the integrity of the claim.
    try {
        const isValid = await this.verifyClaim(actualClaim);
        if (isValid) {
            console.log(`[DM] Claim for ${handle} is verified.`);
            return actualClaim;
        } else {
            console.warn(`[DM] Claim verification failed for ${handle}.`);
            return null;
        }
    } catch (error) {
        console.error(`[DM] Error verifying claim for ${handle}:`, error);
        return null;
    }
}
  
  // --- STEP 3: Verification Logic (mostly unchanged, but still important) ---
async verifyClaim(claim) {
    try {
        console.log("[Identity] Starting claim verification for handle:", claim.handle);
        
        const claimData = JSON.stringify(claim);
        const publicKey = base64ToArrayBuffer(claim.publicKey);
        
        // Remove the signature from the data before verifying
        const dataToVerify = {
            handle: claim.handle,
            publicKey: claim.publicKey,
            encryptionPublicKey: claim.encryptionPublicKey,
            vdfProof: claim.vdfProof,
            vdfInput: claim.vdfInput,
            claimedAt: claim.claimedAt,
            nodeId: claim.nodeId
        };
        const signedString = JSON.stringify(dataToVerify);
        
        const signature = base64ToArrayBuffer(claim.signature);
        
        console.log("[Identity] Verifying signature...");
        const verifiedMessage = nacl.sign.open(signature, publicKey);
        if (!verifiedMessage) {
             console.warn("[Identity] nacl.sign.open returned null. Invalid signature.");
             return false;
        }

        const decodedMessage = new TextDecoder().decode(verifiedMessage);
        if (decodedMessage !== signedString) {
            console.warn("[Identity] Signature is valid, but message content does not match.");
            return false;
        }
        
        console.log("[Identity] Signature verified, checking VDF proof...");
        // VDF verification logic remains the same...
        if (!claim.vdfProof || !claim.vdfInput) {
            console.warn("[Identity] Missing VDF proof or input");
            return false;
        }
        
        console.log("[Identity] VDF proof structure:", Object.keys(claim.vdfProof));
        console.log("[Identity] Calling wasmVDF.verifyVDFProof...");
        
        const vdfValid = await wasmVDF.verifyVDFProof(claim.vdfInput, claim.vdfProof);
        console.log("[Identity] VDF verification result:", vdfValid);
        
        return vdfValid;

    } catch (e) {
        console.error("Identity claim verification failed:", e);
        return false;
    }
}

  // --- STEP 4: Other functions remain largely the same ---
  
  async verifyAuthorIdentity(post) {
    const claim = await this.lookupHandle(post.author);
    if (!claim) {
      console.warn(`[Identity] No registration found for handle: ${post.author}`);
      return false;
    }
    
    const registeredPubKey = claim.publicKey;
    const postPubKey = arrayBufferToBase64(post.authorPublicKey);
    
    if (registeredPubKey !== postPubKey) {
      console.warn(`[Identity] Public key mismatch for ${post.author}! Possible impersonation.`);
      return false;
    }
    
    this.verifiedIdentities.set(post.author, claim);
    return true;
  }
  
  
  
  
  async verifyOwnIdentity(identity, maxRetries = 5) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const claim = await this.lookupHandle(identity.handle);
          if (claim) {
            const ourPubKey = arrayBufferToBase64(identity.publicKey);
            return claim.publicKey === ourPubKey;
          }
          if (this.dht.buckets.every(bucket => bucket.length === 0)) {
            console.log(`[Identity] No peers available yet (attempt ${attempt + 1}/${maxRetries}), retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            continue;
          }
          return false;
        } catch (e) {
          console.warn(`[Identity] Verification attempt ${attempt + 1} failed:`, e);
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
      }
      return this.dht.buckets.every(bucket => bucket.length === 0);
  }
  
  async updatePeerLocation(handle, nodeId, wirePeerId) {
  const routingKey = `routing:${handle.toLowerCase()}`;
  console.log(`[Identity] Updating routing info for ${handle} with wire peer ID: ${wirePeerId}`);
  
  const routingInfo = {
    handle: handle,
    nodeId: arrayBufferToBase64(nodeId), // Store as base64 for consistency
    wirePeerId: wirePeerId, // The actual WebRTC peer ID for current connection
    timestamp: Date.now(),
    ttl: 300000 // 5 minutes
  };
  
  // Store locally first
  await this.dht.store(routingKey, routingInfo, { propagate: true });
  
  // Also store reverse mapping for quick lookups
  const reverseKey = `wire-to-handle:${wirePeerId}`;
  await this.dht.store(reverseKey, { handle: handle }, { propagate: true });
  
  console.log(`[Identity] Routing info stored for ${handle} at key ${routingKey}`);
  return true;
}

async lookupPeerLocation(handle) {
  const routingKey = `routing:${handle.toLowerCase()}`;
  console.log(`[Identity] Looking up current peer location for ${handle}`);
  
  const routingInfo = await this.dht.get(routingKey);
  
  if (!routingInfo) {
    console.log(`[Identity] No routing info found for ${handle}`);
    return null;
  }
  
  // Check if routing info is still valid
  const age = Date.now() - routingInfo.timestamp;
  if (age > routingInfo.ttl) {
    console.log(`[Identity] Routing info for ${handle} has expired (age: ${age}ms)`);
    return null;
  }
  
  console.log(`[Identity] Found routing info for ${handle}, wire peer ID: ${routingInfo.wirePeerId}`);
  return routingInfo;
}

async removeExpiredRouting() {
  const routingPrefix = 'routing:';
  const wirePrefix = 'wire-to-handle:';
  
  for (const [key, value] of this.dht.storage) {
    if (key.startsWith(routingPrefix)) {
      // For routing entries, check the routing info's own timestamp
      const routingInfo = value.value || value; // Handle both wrapped and unwrapped values
      if (routingInfo.timestamp && Date.now() - routingInfo.timestamp > (routingInfo.ttl || 300000)) {
        console.log(`[Identity] Removing expired routing entry: ${key} (age: ${Date.now() - routingInfo.timestamp}ms)`);
        this.dht.storage.delete(key);
      }
    } else if (key.startsWith(wirePrefix)) {
      // For wire-to-handle mappings, check if they have a timestamp
      if (value.timestamp && Date.now() - value.timestamp > 300000) {
        console.log(`[Identity] Removing expired wire mapping: ${key}`);
        this.dht.storage.delete(key);
      }
    }
  }
}
  
}
