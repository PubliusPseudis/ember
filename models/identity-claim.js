// FILE: models/identity-claim.js
import { arrayBufferToBase64, base64ToArrayBuffer, JSONStringifyWithBigInt, JSONParseWithBigInt } from '../utils.js';

export class IdentityClaim {
  constructor({ handle, publicKey, encryptionPublicKey, vdfProof, vdfInput, 
               claimedAt, nodeId, signature }) {
    if (!handle || !publicKey || !vdfProof) {
      throw new Error('Handle, publicKey, and vdfProof are required for an IdentityClaim.');
    }
    
    // Only public fields
    this.handle = handle;
    this.publicKey = publicKey;
    this.encryptionPublicKey = encryptionPublicKey;
    this.vdfProof = vdfProof;
    this.vdfInput = vdfInput;
    this.claimedAt = claimedAt || Date.now();
    this.nodeId = nodeId;
    this.signature = signature;
  }


  /**
   * Prepares the claim for network transmission or storage.
   * Converts Uint8Array and BigInt types to strings.
   * @returns {object} A JSON-serializable object.
   */
toJSON() {
  const result = {
    handle: this.handle,
    publicKey: arrayBufferToBase64(this.publicKey),
    encryptionPublicKey: arrayBufferToBase64(this.encryptionPublicKey),
    vdfProof: this.vdfProof ? {
      ...this.vdfProof,
      iterations: this.vdfProof.iterations?.toString() + 'n'
    } : null,
    vdfInput: this.vdfInput,
    claimedAt: this.claimedAt,
    nodeId: arrayBufferToBase64(this.nodeId),
    signature: arrayBufferToBase64(this.signature)
  };
  
  console.log(`[IdentityClaim] DEBUG toJSON:`, {
    hasSignature: !!this.signature,
    signatureLength: this.signature?.length,
    signatureBase64Length: result.signature?.length,
    allKeys: Object.keys(result)
  });
  
  return result;
}

  /**
   * Reconstructs an IdentityClaim from a raw JSON object.
   * Converts string representations back into their proper types.
   * @param {object} obj - The raw object from a JSON payload.
   * @returns {IdentityClaim} A complete IdentityClaim instance.
   */
static fromJSON(obj) {
  if (!obj) return null;
  
  // Handle both string and object inputs
  let parsed;
  if (typeof obj === 'string') {
    parsed = JSONParseWithBigInt(obj);
  } else {
    parsed = JSONParseWithBigInt(JSON.stringify(obj));
  }
  
  // Ensure signature is converted to Uint8Array
  const signature = parsed.signature ? base64ToArrayBuffer(parsed.signature) : null;
  
  if (!signature) {
    console.error('[IdentityClaim] No signature in parsed data:', parsed);
    return null;
  }
  
  return new IdentityClaim({
    handle: parsed.handle,
    publicKey: base64ToArrayBuffer(parsed.publicKey),
    encryptionPublicKey: base64ToArrayBuffer(parsed.encryptionPublicKey),
    nodeId: base64ToArrayBuffer(parsed.nodeId),
    signature: signature,
    vdfProof: parsed.vdfProof ? {
      ...parsed.vdfProof,
      iterations: parsed.vdfProof.iterations ? 
        BigInt(parsed.vdfProof.iterations.toString().replace('n', '')) : null
    } : null,
    vdfInput: parsed.vdfInput,
    claimedAt: parsed.claimedAt
  });
}
}
