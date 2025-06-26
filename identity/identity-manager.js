import { state } from '../main.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../utils.js';

// Everyone gets a registration
export class IdentityRegistry {
  constructor(dht) {
    this.dht = dht;
    this.verifiedIdentities = new Map(); // handle -> identity info
    this.registrationAttempts = new Map(); // track attempts
  }
  
  // Create and register a new identity
async registerIdentity(handle, keyPair) {
    console.log(`[Identity] Attempting to register handle: ${handle}`);

    // Check if handle is already taken
    const existingClaim = await this.lookupHandle(handle);
    if (existingClaim) {
        throw new Error(`Handle "${handle}" is already registered`);
    }

    // Convert publicKey to ArrayBuffer if it's a base64 string
    let publicKeyBuffer;
    if (typeof keyPair.publicKey === 'string') {
        publicKeyBuffer = base64ToArrayBuffer(keyPair.publicKey);
    } else {
        publicKeyBuffer = keyPair.publicKey;
    }

    // Create identity claim
    const claim = {
        handle: handle,
        publicKey: typeof keyPair.publicKey === 'string' ? keyPair.publicKey : arrayBufferToBase64(keyPair.publicKey),
        claimedAt: Date.now(),
        nodeId: arrayBufferToBase64(await crypto.subtle.digest('SHA-1', publicKeyBuffer)) // Use the buffer here
    };

    // Sign the claim
    const claimData = JSON.stringify({
        handle: claim.handle,
        publicKey: claim.publicKey,
        claimedAt: claim.claimedAt
    });

    const signature = nacl.sign(new TextEncoder().encode(claimData), keyPair.secretKey);
    claim.signature = arrayBufferToBase64(signature);

    // Store in DHT at handle key
    const handleKey = `identity:handle:${handle.toLowerCase()}`;
    const success = await this.dht.store(handleKey, claim);

    if (!success) {
        // If we have no peers, store locally in the DHT anyway
        if (state.peers.size === 0) {
            console.log(`[Identity] No peers available, storing identity locally in DHT`);
            this.dht.storage.set(handleKey, claim);
        } else {
            // If we have peers but still failed, this is a real error
            throw new Error("Failed to register identity in DHT");
        }
    }

    // Store reverse mapping (pubkey -> handle)
    const pubkeyKey = `identity:pubkey:${claim.publicKey}`;
    await this.dht.store(pubkeyKey, { handle: handle, claimedAt: claim.claimedAt });
    
    // If that also fails with no peers, store locally
    if (state.peers.size === 0) {
        this.dht.storage.set(pubkeyKey, { handle: handle, claimedAt: claim.claimedAt });
    }

    console.log(`[Identity] Successfully registered ${handle} ${state.peers.size === 0 ? '(locally)' : '(in DHT)'}`);
    return claim;
}
  
  // Look up who owns a handle
  async lookupHandle(handle) {
    const handleKey = `identity:handle:${handle.toLowerCase()}`;
    const claim = await this.dht.get(handleKey);
    
    if (claim && await this.verifyClaim(claim)) {
      return claim;
    }
    
    return null;
  }
  
  // Verify an identity claim is valid
  async verifyClaim(claim) {
    try {
      const claimData = JSON.stringify({
        handle: claim.handle,
        publicKey: claim.publicKey,
        claimedAt: claim.claimedAt
      });
      
      const publicKey = base64ToArrayBuffer(claim.publicKey);
      const signature = base64ToArrayBuffer(claim.signature);
      
      const originalMessage = nacl.sign.open(signature, publicKey);
      if (!originalMessage) return false;
      
      const decodedMessage = new TextDecoder().decode(originalMessage);
      return decodedMessage === claimData;
    } catch (e) {
      console.error("Identity claim verification failed:", e);
      return false;
    }
  }
  
  // Verify a post author's identity
  async verifyAuthorIdentity(post) {
    const claim = await this.lookupHandle(post.author);
    if (!claim) {
      console.warn(`[Identity] No registration found for handle: ${post.author}`);
      return false;
    }
    
    // Check if post's public key matches registered public key
    const registeredPubKey = claim.publicKey;
    const postPubKey = arrayBufferToBase64(post.authorPublicKey);
    
    if (registeredPubKey !== postPubKey) {
      console.warn(`[Identity] Public key mismatch for ${post.author}! Possible impersonation.`);
      return false;
    }
    
    // Cache verified identity
    this.verifiedIdentities.set(post.author, claim);
    return true;
  }
  
  // Check if we own a handle (for reconnection)
  async verifyOwnIdentity(identity) {
    const claim = await this.lookupHandle(identity.handle);
    if (!claim) return false;
    
    const ourPubKey = arrayBufferToBase64(identity.publicKey);
    return claim.publicKey === ourPubKey;
  }
}
