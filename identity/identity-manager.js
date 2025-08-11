import nacl from 'tweetnacl'; 
import wasmVDF from '../vdf-wrapper.js';
import { state } from '../state.js';
import { base64ToArrayBuffer, arrayBufferToBase64,JSONStringifyWithBigInt } from '../utils.js';
import { IdentityClaim } from '../models/identity-claim.js'; 

// --- NEW, ROBUST IDENTITY REGISTRY ---
export class IdentityRegistry {
  constructor(dht) {
    this.dht = dht;
    this.verifiedIdentities = new Map(); // handle -> identity info
  }
  
  // --- STEP 1: Main registration function ---
  // Stores the full identity claim using the PUBLIC KEY as the address.
async registerIdentity(handle, keyPair, encryptionPublicKey, vdfProof, vdfInput) {
  console.log(`[Identity] Starting registration for handle: ${handle}`);
  
  const publicKeyB64 = arrayBufferToBase64(keyPair.publicKey);

  // First, check if the desired handle is already taken
  const existingPubkey = await this.dht.get(`handle-to-pubkey:${handle.toLowerCase()}`);
  if (existingPubkey) {
    throw new Error(`Handle "${handle}" is already registered.`);
  }

  // Create the primary identity claim
  const claim = new IdentityClaim({
    handle: handle,
    publicKey: keyPair.publicKey,
    encryptionPublicKey: encryptionPublicKey,
    vdfProof: vdfProof,
    vdfInput: vdfInput,
    claimedAt: Date.now(),
    nodeId: await crypto.subtle.digest('SHA-1', keyPair.publicKey)
  });
  
  console.log(`[Identity] DEBUG: Claim created, signature field:`, claim.signature);
  
  // Sign the claim
  const claimData = {
    handle: claim.handle,
    publicKey: arrayBufferToBase64(claim.publicKey),
    encryptionPublicKey: arrayBufferToBase64(claim.encryptionPublicKey),
    vdfProof: claim.vdfProof,
    vdfInput: claim.vdfInput,
    claimedAt: claim.claimedAt,
    nodeId: arrayBufferToBase64(claim.nodeId)
  };
  
  const claimString = JSONStringifyWithBigInt(claimData);
  const signature = nacl.sign(new TextEncoder().encode(claimString), keyPair.secretKey);
  claim.signature = signature;
  
  console.log(`[Identity] DEBUG: Signature assigned to claim:`, {
    signatureLength: claim.signature?.length,
    signatureType: typeof claim.signature,
    signatureIsUint8Array: claim.signature instanceof Uint8Array,
    first10Bytes: claim.signature ? Array.from(claim.signature.slice(0, 10)) : null
  });

  // Store with high replication factor for identity data
  const identityOptions = {
    propagate: true,
    refresh: true,
    replicationFactor: 30
  };

  // ALWAYS store as JSON
  const pubkeyAddress = `pubkey:${publicKeyB64}`;
  const claimJSON = claim.toJSON();
  
  console.log(`[Identity] DEBUG: claimJSON before storage:`, {
    hasSignature: !!claimJSON.signature,
    signatureValue: claimJSON.signature?.substring(0, 20) + '...',
    allKeys: Object.keys(claimJSON)
  });
  
  // Let's also log the full JSON to see what's being stored
  console.log(`[Identity] DEBUG: Full claimJSON:`, JSON.stringify(claimJSON, null, 2));
  
  const pubkeyResult = await this.dht.store(pubkeyAddress, claimJSON, identityOptions);
  
  // Immediately read it back to verify
  const verifyStore = await this.dht.get(pubkeyAddress);
  console.log(`[Identity] DEBUG: Immediately after store, retrieved:`, {
    hasValue: !!verifyStore,
    valueType: typeof verifyStore,
    hasSignature: !!(verifyStore?.signature || verifyStore?.value?.signature),
    keys: verifyStore ? Object.keys(verifyStore) : null
  });
  
  if (pubkeyResult.replicas < 3) {
    console.warn(`[Identity] Low replication for identity claim: ${pubkeyResult.replicas} replicas`);
  }

  // Store the secondary mapping from handle -> pubkey
  const handleAddress = `handle-to-pubkey:${handle.toLowerCase()}`;
  const handleResult = await this.dht.store(handleAddress, publicKeyB64, identityOptions);

  if (handleResult.replicas < 3) {
    console.warn(`[Identity] Low replication for handle mapping: ${handleResult.replicas} replicas`);
  }

  console.log(`[Identity] Successfully registered ${handle} with ${pubkeyResult.replicas} replicas`);
  return claim;
}
  
  // --- STEP 2: Main lookup function ---
  // Now, to look up a user, we first find their pubkey, then get their full data.
  async lookupHandle(handle) {
    console.log(`[Identity] DEBUG: Looking up handle: ${handle}`);
    
    const handleAddress = `handle-to-pubkey:${handle.toLowerCase()}`;
    const rawValue = await this.dht.get(handleAddress);
    console.log(`[Identity] DEBUG: Got raw value from handle mapping:`, rawValue);

    // Defensively unwrap the value if it's a metadata object
    const publicKeyB64 = (rawValue && typeof rawValue === 'object' && rawValue.value) 
      ? rawValue.value 
      : rawValue;

    if (!publicKeyB64 || typeof publicKeyB64 !== 'string') {
      return null;
    }

  const pubkeyAddress = `pubkey:${publicKeyB64}`;
  const rawData = await this.dht.get(pubkeyAddress);
  
  console.log(`[Identity] DEBUG: Raw data from DHT:`, {
    type: typeof rawData,
    isNull: rawData === null,
    hasValue: !!(rawData?.value),
    directKeys: rawData ? Object.keys(rawData) : null,
    valueKeys: rawData?.value ? Object.keys(rawData.value) : null
  });
  
  if (!rawData) {
    return null;
  }

  // The DHT wraps values, so we need to unwrap
  let rawClaim = rawData;
  
  // Check if it's wrapped
  if (rawData && typeof rawData === 'object') {
    // Check for .value wrapper from DHT storage
    if ('value' in rawData && rawData.value !== undefined) {
      console.log(`[Identity] DEBUG: Unwrapping from .value`);
      rawClaim = rawData.value;
    }
    // Check for other possible wrappers
    else if ('data' in rawData) {
      console.log(`[Identity] DEBUG: Unwrapping from .data`);
      rawClaim = rawData.data;
    }
  }
  
  console.log('[Identity] Raw claim data:', rawClaim);
  console.log(`[Identity] DEBUG: Raw claim details:`, {
    type: typeof rawClaim,
    hasSignature: !!rawClaim?.signature,
    keys: rawClaim ? Object.keys(rawClaim) : null
  });

  // ALWAYS deserialize from JSON
  const claim = IdentityClaim.fromJSON(rawClaim);

  if (!claim) {
    console.log(`[Identity] DEBUG: IdentityClaim.fromJSON returned null`);
    return null;
  }

  console.log(`[Identity] DEBUG: After fromJSON:`, {
    hasSignature: !!claim.signature,
    signatureType: typeof claim.signature,
    signatureLength: claim.signature?.length
  });

  if (await this.verifyClaim(claim)) {
    return claim;
  }
  
  return null;
}



  
  // --- STEP 3: Verification Logic (mostly unchanged, but still important) ---
async verifyClaim(claim) {
    try {
        console.log("[Identity] Starting claim verification for handle:", claim.handle);
        
        // FIX: The claim object from `IdentityClaim.fromJSON` already contains Uint8Arrays.
        // The redundant checks and conversions have been removed.
        const publicKey = claim.publicKey;
        const signature = claim.signature;
        const nodeId = claim.nodeId;
        
        // Reconstruct the exact data that was signed
        const dataToVerify = {
            handle: claim.handle,
            publicKey: arrayBufferToBase64(publicKey),
            encryptionPublicKey: typeof claim.encryptionPublicKey === 'string' ?
                claim.encryptionPublicKey : arrayBufferToBase64(claim.encryptionPublicKey),
            vdfProof: claim.vdfProof,
            vdfInput: claim.vdfInput,
            claimedAt: claim.claimedAt,
            nodeId: arrayBufferToBase64(nodeId)
        };
        
        // Ensure consistent serialization of vdfProof
        if (dataToVerify.vdfProof && dataToVerify.vdfProof.iterations) {
            // Convert iterations to string format if it's not already
            if (typeof dataToVerify.vdfProof.iterations !== 'string') {
                dataToVerify.vdfProof = {
                    ...dataToVerify.vdfProof,
                    iterations: dataToVerify.vdfProof.iterations.toString()
                };
            }
        }
        
        const signedString = JSONStringifyWithBigInt(dataToVerify);
        
        console.log("[Identity] Verifying signature...");
        console.log("[Identity] Data to verify:", signedString.substring(0, 200) + "...");
        
        const verifiedMessage = nacl.sign.open(signature, publicKey);
        
        if (!verifiedMessage) {
            console.warn("[Identity] nacl.sign.open returned null. Invalid signature.");
            return false;
        }

        const decodedMessage = new TextDecoder().decode(verifiedMessage);
        
        console.log("[Identity] Decoded message:", decodedMessage.substring(0, 200) + "...");
        
        if (decodedMessage !== signedString) {
            console.warn("[Identity] Signature is valid, but message content does not match.");
            console.log("[Identity] Expected:", signedString);
            console.log("[Identity] Got:", decodedMessage);
            return false;
        }
        
        console.log("[Identity] Signature verified, checking VDF proof...");
        
        // VDF verification
        if (!claim.vdfProof || !claim.vdfInput) {
            console.warn("[Identity] Missing VDF proof or input");
            return false;
        }
        
        const vdfValid = await wasmVDF.verifyVDFProof(claim.vdfInput, claim.vdfProof);
        console.log("[Identity] VDF verification result:", vdfValid);
        
        return vdfValid;

    } catch (e) {
        console.error("[Identity] Claim verification failed:", e);
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
    
    // Convert both to base64 strings for comparison
    const registeredPubKey = arrayBufferToBase64(claim.publicKey);
    const postPubKey = arrayBufferToBase64(post.authorPublicKey);
    
    if (registeredPubKey !== postPubKey) {
      console.warn(`[Identity] Public key mismatch for ${post.author}! Possible impersonation.`);
      return false;
    }
    
    this.verifiedIdentities.set(post.author, claim);
    return true;
}
  
  
  
  
async verifyOwnIdentity(identity, maxRetries = 5) {
  console.log(`identity ${identity}`);

  const ourPubKeyB64 = arrayBufferToBase64(identity.publicKey);
  const handleLower = identity.handle.toLowerCase();
  const handleAddress = `handle-to-pubkey:${handleLower}`;
  const pubkeyAddress = `pubkey:${ourPubKeyB64}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Try DHT lookup first
      const claim = await this.lookupHandle(identity.handle);
      if (claim) {
        const claimPubKeyB64 = arrayBufferToBase64(claim.publicKey);
        return claimPubKeyB64 === ourPubKeyB64;
      }

      // No claim found: if we can build/obtain our local public claim, verify it and republish
      if (typeof identity.getPublicClaim === 'function') {
        const localClaim = identity.getPublicClaim(); // LocalIdentity already exposes this
        if (await this.verifyClaim(localClaim)) {
          await Promise.all([
            this.dht.store(handleAddress, ourPubKeyB64, { propagate: true }),
            this.dht.store(pubkeyAddress, localClaim.toJSON(), { propagate: true }),
          ]);
          // brief backoff then retry lookup
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
      }

      // Backoff and retry regardless of peer count (avoid early false negative when 1 peer is up)
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    } catch (e) {
      console.warn(`[Identity] Verification attempt ${attempt + 1} failed:`, e);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  // If still nothing, only treat as "ok" when there are truly no peers
  return this.dht.buckets.every((bucket) => bucket.length === 0);
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
