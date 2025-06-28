import wasmVDF from '../vdf-wrapper.js';
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
    async registerIdentity(handle, keyPair, vdfProof, vdfInput) {
        console.log(`[Identity] Attempting to register handle: ${handle}`);
        
        // Add a registry lock to prevent race conditions
        const lockKey = `identity:lock:${handle.toLowerCase()}`;
        const lockBytes = new Uint8Array(16);
        crypto.getRandomValues(lockBytes);
        const lockValue = Array.from(lockBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        
        // Try to acquire lock
        const existingLock = await this.dht.get(lockKey);
        if (existingLock) {
            throw new Error(`Handle "${handle}" is being registered by another user`);
        }
        
        // Set lock with 30 second expiry
        await this.dht.store(lockKey, { value: lockValue, expires: Date.now() + 30000 });
        
        try {
            // Double-check handle is still available
            const existingClaim = await this.lookupHandle(handle);
            if (existingClaim) {
                throw new Error(`Handle "${handle}" is already registered`);
            }

            // Create identity claim WITH VDF proof
            const claim = {
                handle: handle,
                publicKey: typeof keyPair.publicKey === 'string' ? 
                    keyPair.publicKey : arrayBufferToBase64(keyPair.publicKey),
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
                nodeId: arrayBufferToBase64(await crypto.subtle.digest('SHA-1', 
                    typeof keyPair.publicKey === 'string' ? 
                        base64ToArrayBuffer(keyPair.publicKey) : keyPair.publicKey))
            };

            // Sign the ENTIRE claim including VDF proof
            const claimData = JSON.stringify({
                handle: claim.handle,
                publicKey: claim.publicKey,
                vdfProof: claim.vdfProof,
                vdfInput: claim.vdfInput,
                claimedAt: claim.claimedAt
            });

            const signature = nacl.sign(new TextEncoder().encode(claimData), keyPair.secretKey);
            claim.signature = arrayBufferToBase64(signature);

            // Store in DHT
            const handleKey = `identity:handle:${handle.toLowerCase()}`;
            const success = await this.dht.store(handleKey, claim);

            if (!success && state.peers.size === 0) {
                console.log(`[Identity] No peers available, storing identity locally in DHT`);
                this.dht.storage.set(handleKey, claim);
            } else if (!success) {
                throw new Error("Failed to register identity in DHT");
            }

            // Store reverse mapping
            const pubkeyKey = `identity:pubkey:${claim.publicKey}`;
            await this.dht.store(pubkeyKey, { handle: handle, claimedAt: claim.claimedAt });
            
            if (state.peers.size === 0) {
                this.dht.storage.set(pubkeyKey, { handle: handle, claimedAt: claim.claimedAt });
            }

            console.log(`[Identity] Successfully registered ${handle} with VDF proof`);
            return claim;
            
        } finally {
            // Always release lock
            await this.dht.store(lockKey, null);
        }
    }
  
  // Look up who owns a handle
    async lookupHandle(handle) {
      const handleKey = `identity:handle:${handle.toLowerCase()}`;
      console.log(`[DM] Looking up handle: ${handle} with key: ${handleKey}`); // ADDED
      const claim = await this.dht.getWithTimeout(handleKey, 3000);
      
      if (!claim) {
          console.warn(`[DM] DHT lookup for ${handleKey} returned null. The recipient's identity claim was not found on the network.`); // ADDED
          return null;
      }

      console.log(`[DM] DHT lookup found a claim for ${handle}. Verifying...`); // ADDED
      if (await this.verifyClaim(claim)) {
        console.log(`[DM] Claim for ${handle} is verified.`); // ADDED
        return claim;
      }
      
      console.warn(`[DM] Claim verification failed for ${handle}.`); // ADDED
      return null;
    }
  
  // Verify an identity claim is valid
    async verifyClaim(claim) {
        try {
            // First verify the signature
            const claimData = JSON.stringify({
                handle: claim.handle,
                publicKey: claim.publicKey,
                vdfProof: claim.vdfProof,
                vdfInput: claim.vdfInput,
                claimedAt: claim.claimedAt
            });
            
            const publicKey = base64ToArrayBuffer(claim.publicKey);
            const signature = base64ToArrayBuffer(claim.signature);
            
            const originalMessage = nacl.sign.open(signature, publicKey);
            if (!originalMessage) return false;
            
            const decodedMessage = new TextDecoder().decode(originalMessage);
            if (decodedMessage !== claimData) return false;
            
            // Now verify the VDF proof
            if (!claim.vdfProof || !claim.vdfInput) {
                console.warn(`[Identity] Claim missing VDF proof`);
                return false;
            }
            
           
            const vdfProofObj = new wasmVDF.VDFProof(
                claim.vdfProof.y,
                claim.vdfProof.pi,
                claim.vdfProof.l,
                claim.vdfProof.r,
                BigInt(claim.vdfProof.iterations)
            );
            
            const vdfValid = await wasmVDF.computer.verify_proof(
                claim.vdfInput,
                vdfProofObj
            );
            
            if (!vdfValid) {
                console.warn(`[Identity] VDF proof invalid for handle: ${claim.handle}`);
                return false;
            }
            
            return true;
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
    async verifyOwnIdentity(identity, maxRetries = 5) {
      // Add retry logic for DHT bootstrap period
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const claim = await this.lookupHandle(identity.handle);
          
          if (claim) {
            const ourPubKey = arrayBufferToBase64(identity.publicKey);
            return claim.publicKey === ourPubKey;
          }
          
          // If no claim found but we have no peers yet, we might be first or still bootstrapping
          if (this.dht.buckets.every(bucket => bucket.length === 0)) {
            console.log(`[Identity] No peers available yet (attempt ${attempt + 1}/${maxRetries}), retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
            continue;
          }
          
          // If we have peers but no claim, the identity truly doesn't exist
          return false;
        } catch (e) {
          console.warn(`[Identity] Verification attempt ${attempt + 1} failed:`, e);
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
      }
      
      // After all retries, check if we're truly alone
      return this.dht.buckets.every(bucket => bucket.length === 0);
    }
}
