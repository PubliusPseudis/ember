// In file: models/local-identity.js

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
    this.claimedAt = data.claimedAt;
    this.encryptedVault = data.encryptedVault || null;
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

  isEncrypted() {
    return this.encryptedVault !== null && !this.secretKey;
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
        signature: this.signature,
        claimedAt: this.claimedAt
      });
    }
    return this._identityClaim;
  }

  // For local storage only
  toJSON() {
    const json = {
      // Public data
      handle: this.handle,
      publicKey: arrayBufferToBase64(this.publicKey),
      encryptionPublicKey: arrayBufferToBase64(this.encryptionPublicKey),
      nodeId: arrayBufferToBase64(this.nodeId),
      vdfProof: this.vdfProof ? {
        ...this.vdfProof,
        iterations: this.vdfProof.iterations ?
          (typeof this.vdfProof.iterations === 'bigint' ?
            this.vdfProof.iterations.toString() + 'n' :
            this.vdfProof.iterations.toString() + 'n') : null
      } : null,
      vdfInput: this.vdfInput,
      uniqueId: this.uniqueId,
      signature: this.signature ? arrayBufferToBase64(this.signature) : null,
      claimedAt: this.claimedAt,

    secretKey: this.encryptedVault ? null : arrayBufferToBase64(this.secretKey),
    encryptionSecretKey: this.encryptedVault ? null : arrayBufferToBase64(this.encryptionSecretKey),
   
      
      encryptedVault: this.encryptedVault,

      // Local state
      isRegistered: this.isRegistered,
      registrationVerified: this.registrationVerified,
      profile: this.profile
    };
    return json;
  }

  static fromJSON(obj) {
    if (!obj) return null;
    
    const parsedObj = JSONParseWithBigInt(JSON.stringify(obj));
    
    // Handle vdfProof iterations carefully
    let vdfProof = null;
    if (parsedObj.vdfProof) {
      vdfProof = { ...parsedObj.vdfProof };
      if (vdfProof.iterations !== undefined && vdfProof.iterations !== null) {
        if (typeof vdfProof.iterations === 'string') {
          vdfProof.iterations = BigInt(vdfProof.iterations.replace('n', ''));
        } else if (typeof vdfProof.iterations === 'number') {
          vdfProof.iterations = BigInt(vdfProof.iterations);
        }
      }
    }
    
    return new LocalIdentity({
      ...parsedObj,
      publicKey: base64ToArrayBuffer(parsedObj.publicKey),
      encryptionPublicKey: base64ToArrayBuffer(parsedObj.encryptionPublicKey),
      nodeId: base64ToArrayBuffer(parsedObj.nodeId),
      
      // Correctly decode keys only if they exist and are not in an encrypted vault.
      secretKey: (parsedObj.secretKey && !parsedObj.encryptedVault)
        ? base64ToArrayBuffer(parsedObj.secretKey)
        : null,
      encryptionSecretKey: (parsedObj.encryptionSecretKey && !parsedObj.encryptedVault)
        ? base64ToArrayBuffer(parsedObj.encryptionSecretKey)
        : null,
        
      signature: parsedObj.signature ? base64ToArrayBuffer(parsedObj.signature) : null,
      claimedAt: parsedObj.claimedAt,
      vdfProof: vdfProof,
      encryptedVault: parsedObj.encryptedVault
    });
  }
}
