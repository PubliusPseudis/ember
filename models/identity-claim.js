// FILE: models/identity-claim.js
import { arrayBufferToBase64, base64ToArrayBuffer, JSONStringifyWithBigInt, JSONParseWithBigInt } from '../utils.js';

export class IdentityClaim {
  constructor({ handle, publicKey, encryptionPublicKey, vdfProof, vdfInput, claimedAt, nodeId, signature }) {
    // Constructor can perform basic validation
    if (!handle || !publicKey || !vdfProof) {
      throw new Error('Handle, publicKey, and vdfProof are required for an IdentityClaim.');
    }
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
    return {
      handle: this.handle,
      publicKey: arrayBufferToBase64(this.publicKey),
      encryptionPublicKey: arrayBufferToBase64(this.encryptionPublicKey),
      vdfProof: {
        ...this.vdfProof,
        iterations: this.vdfProof.iterations.toString() + 'n' // Use BigInt convention
      },
      vdfInput: this.vdfInput,
      claimedAt: this.claimedAt,
      nodeId: arrayBufferToBase64(this.nodeId),
      signature: arrayBufferToBase64(this.signature)
    };
  }

  /**
   * Reconstructs an IdentityClaim from a raw JSON object.
   * Converts string representations back into their proper types.
   * @param {object} obj - The raw object from a JSON payload.
   * @returns {IdentityClaim} A complete IdentityClaim instance.
   */
  static fromJSON(obj) {
    if (!obj) return null;

    // Use the robust parsing from utils.js to handle BigInt
    const parsedObj = JSONParseWithBigInt(JSON.stringify(obj));

    return new IdentityClaim({
      ...parsedObj,
      publicKey: base64ToArrayBuffer(parsedObj.publicKey),
      encryptionPublicKey: base64ToArrayBuffer(parsedObj.encryptionPublicKey),
      nodeId: base64ToArrayBuffer(parsedObj.nodeId),
      signature: base64ToArrayBuffer(parsedObj.signature)
    });
  }
}
