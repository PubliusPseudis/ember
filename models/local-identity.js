// models/local-identity.js
import { IdentityClaim } from './identity-claim.js';
import { arrayBufferToBase64, base64ToArrayBuffer, JSONParseWithBigInt } from '../utils.js';

export class LocalIdentity {
  constructor(data) {
    // Public fields
    this.handle = data.handle;
    this.publicKey = data.publicKey;
    this.encryptionPublicKey = data.encryptionPublicKey;
    this.nodeId = data.nodeId;
    this.vdfProof = data.vdfProof;
    this.vdfInput = data.vdfInput;
    this.uniqueId = data.uniqueId;
    this.signature = data.signature;
    // Private fields - NEVER shared
    this.secretKey = data.secretKey;
    this.encryptionSecretKey = data.encryptionSecretKey;
    this.claimedAt = data.claimedAt;  // <-- Add this!
  
    // Local state
    this.isRegistered = data.isRegistered || false;
    this.registrationVerified = data.registrationVerified || false;
    this.profile = data.profile || {
      handle: this.handle,
      bio: '',
      profilePictureHash: null,
      theme: {
        backgroundColor: '#000000',
        fontColor: '#ffffff',
        accentColor: '#ff1493'
      },
      updatedAt: Date.now()
    };
    
    // Cached public claim
    this._identityClaim = null;
  }

  // Get the public claim for sharing
getPublicClaim() {
  if (!this._identityClaim) {
    this._identityClaim = new IdentityClaim({
      handle: this.handle,
      publicKey: this.publicKey,
      encryptionPublicKey: this.encryptionPublicKey,
      vdfProof: this.vdfProof,
      vdfInput: this.vdfInput,
      nodeId: this.nodeId,
      signature: this.signature,  // <-- Add this!
      claimedAt: this.claimedAt   // <-- And this if it exists!
    });
  }
  return this._identityClaim;
}

  // For local storage only
toJSON() {
  return {
    // Public data
    handle: this.handle,
    publicKey: arrayBufferToBase64(this.publicKey),
    encryptionPublicKey: arrayBufferToBase64(this.encryptionPublicKey),
    nodeId: arrayBufferToBase64(this.nodeId),
    vdfProof: this.vdfProof ? {
      ...this.vdfProof,
      // Ensure iterations is always stored as a string with 'n' suffix
      iterations: this.vdfProof.iterations ? 
        (typeof this.vdfProof.iterations === 'bigint' ? 
          this.vdfProof.iterations.toString() + 'n' : 
          this.vdfProof.iterations.toString() + 'n') : null
    } : null,
    vdfInput: this.vdfInput,
    uniqueId: this.uniqueId,
    signature: this.signature ? arrayBufferToBase64(this.signature) : null,
    claimedAt: this.claimedAt,
    
    // Private data - included for local storage
    secretKey: arrayBufferToBase64(this.secretKey),
    encryptionSecretKey: arrayBufferToBase64(this.encryptionSecretKey),
    
    // Local state
    isRegistered: this.isRegistered,
    registrationVerified: this.registrationVerified,
    profile: this.profile
  };
}

static fromJSON(obj) {
  if (!obj) return null;
  const parsedObj = JSONParseWithBigInt(JSON.stringify(obj));
  
  // Handle vdfProof iterations carefully
  let vdfProof = null;
  if (parsedObj.vdfProof) {
    vdfProof = { ...parsedObj.vdfProof };
    
    // Handle iterations - could be string, BigInt, or number
    if (vdfProof.iterations !== undefined) {
      if (typeof vdfProof.iterations === 'string') {
        // Remove 'n' suffix if present and convert to BigInt
        vdfProof.iterations = BigInt(vdfProof.iterations.replace('n', ''));
      } else if (typeof vdfProof.iterations === 'number') {
        // Convert number to BigInt
        vdfProof.iterations = BigInt(vdfProof.iterations);
      } else if (typeof vdfProof.iterations === 'bigint') {
        // Already a BigInt, keep as is
        vdfProof.iterations = vdfProof.iterations;
      }
    }
  }
  
  return new LocalIdentity({
    ...parsedObj,
    publicKey: base64ToArrayBuffer(parsedObj.publicKey),
    encryptionPublicKey: base64ToArrayBuffer(parsedObj.encryptionPublicKey),
    nodeId: base64ToArrayBuffer(parsedObj.nodeId),
    secretKey: base64ToArrayBuffer(parsedObj.secretKey),
    encryptionSecretKey: base64ToArrayBuffer(parsedObj.encryptionSecretKey),
    signature: parsedObj.signature ? base64ToArrayBuffer(parsedObj.signature) : null,
    claimedAt: parsedObj.claimedAt,
    vdfProof: vdfProof
  });
}
}
