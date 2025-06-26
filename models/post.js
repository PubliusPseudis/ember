import { state, imageStore } from '../main.js'; 
import { generateId, sanitize, arrayBufferToBase64, base64ToArrayBuffer } from '../utils.js';

function serializeVdfProof(proof) {
    if (!proof) return null;
    return {
        y: proof.y,
        pi: proof.pi,
        l: proof.l,
        r: proof.r,
        iterations: proof.iterations ? proof.iterations.toString() : null
    };
}

/* ---------- POST CLASS WITH SIGNATURES ---------- */
export class Post {
    constructor(content, parentId = null, imageData = null) {
        // Core post data
        this.id = generateId();
        this.content = sanitize(content);
        this.timestamp = Date.now();
        this.parentId = parentId;
        this.imageData = imageData; // Temporary storage for base64 before processing
        this.imageHash = null; // Will be populated by processImage()

        // Author's identity information
        this.author = state.myIdentity.handle;
        this.authorPublicKey = state.myIdentity.publicKey;
        this.authorUniqueId = state.myIdentity.uniqueId;
        this.authorVdfInput = state.myIdentity.vdfInput;

        // Deep copy the VDF proof to ensure BigInt is preserved
        if (state.myIdentity.vdfProof) {
            this.authorVdfProof = {
                y: state.myIdentity.vdfProof.y,
                pi: state.myIdentity.vdfProof.pi,
                l: state.myIdentity.vdfProof.l,
                r: state.myIdentity.vdfProof.r,
                iterations: state.myIdentity.vdfProof.iterations
            };
        } else {
            this.authorVdfProof = null;
        }

        this.signature = null;

        // Ephemeral state
        this.carriers = new Set([state.myIdentity.handle]);
        this.replies = new Set();
        this.depth = 0;
    }

    async processImage() {
        if (this.imageData && !this.imageHash) {
            const result = await imageStore.storeImage(this.imageData);
            this.imageHash = result.hash;
            // The Merkle root is part of imageStore.images.get(this.imageHash).merkleRoot
            this.imageData = null; // Clear raw data after processing
            console.log(`[Post] Image processed, hash: ${this.imageHash?.substring(0, 8)}...`);
        }
    }

    /**
     * Creates a consistent, stringified version of the post data for signing.
     * Includes imageHash for content integrity.
     * @returns {Uint8Array} - The byte array to be signed or verified.
     */
toSignable() {
  // Ensure publicKey is always in the same format
  let publicKeyBase64;
  if (typeof this.authorPublicKey === 'string') {
    // Already base64
    publicKeyBase64 = this.authorPublicKey;
  } else if (this.authorPublicKey instanceof ArrayBuffer || this.authorPublicKey instanceof Uint8Array) {
    // Convert to base64
    publicKeyBase64 = arrayBufferToBase64(this.authorPublicKey);
  } else {
    console.error('Unknown publicKey type:', typeof this.authorPublicKey);
    publicKeyBase64 = '';
  }
  
  const signableData = {
    id: this.id,
    content: this.content,
    timestamp: this.timestamp,
    parentId: this.parentId,
    imageHash: this.imageHash,
    authorPublicKey: publicKeyBase64
  };
  
  const signedString = JSON.stringify(signableData);
  return new TextEncoder().encode(signedString);
}

    /**
     * Signs the post using the user's private key.
     * @param {Uint8Array} secretKey - The user's secret signing key.
     */
    sign(secretKey) {
        const messageBytes = this.toSignable();
        this.signature = nacl.sign(messageBytes, secretKey);
        console.log(`[Post] Post signed. Signature: ${arrayBufferToBase64(this.signature).substring(0, 16)}...`);
    }

    /**
     * Verifies the post's signature.
     * @returns {boolean} - True if the signature is valid, false otherwise.
     */
    verify() {
        if (!this.signature || !this.authorPublicKey) {
            console.warn("[Post] Verification failed: Post is missing signature or public key.");
            return false;
        }

        const messageToVerifyBytes = this.toSignable(); // Re-create signable data
        const originalMessage = nacl.sign.open(this.signature, this.authorPublicKey);

        if (originalMessage === null) {
            console.warn("[Post] Verification failed: nacl.sign.open returned null (invalid signature).");
            return false;
        }

        const decodedOriginal = new TextDecoder().decode(originalMessage);
        const decodedSignable = new TextDecoder().decode(messageToVerifyBytes);

        if (decodedOriginal !== decodedSignable) {
            console.error("[Post] Verification failed: Re-decoded message from signature does NOT match re-created signable data!");
            console.error("  Original from signature:", decodedOriginal);
            console.error("  Re-created signable data:", decodedSignable);
            return false;
        }
        
        console.log("[Post] Signature successfully verified.");
        return true;
    }

    /**
     * Prepares the entire Post object for network transmission.
     * Converts Uint8Array fields to Base64 strings for reliable JSON transport.
     * @returns {object} - A JSON-serializable object.
     */
    toJSON() {
        const publicKeyBase64 = arrayBufferToBase64(this.authorPublicKey);
        
        // Get fresh image metadata if available
        let imageMeta = null;
        if (this.imageHash && imageStore.images.has(this.imageHash)) {
            const metadata = imageStore.images.get(this.imageHash);
            imageMeta = {
                merkleRoot: metadata.merkleRoot,
                chunks: metadata.chunks,
                size: metadata.size,
                created: metadata.created
            };
        }
        
        return {
            id: this.id,
            content: this.content,
            timestamp: this.timestamp,
            parentId: this.parentId,
            imageHash: this.imageHash,
            imageMeta: imageMeta,  
            author: this.author,
            authorPublicKey: publicKeyBase64,
            authorUniqueId: this.authorUniqueId,
            authorVdfProof: serializeVdfProof(this.authorVdfProof), // Serialize properly
            authorVdfInput: this.authorVdfInput,
            vdfProof: this.vdfProof ? serializeVdfProof(this.vdfProof) : null, // Also serialize post VDF if present
            vdfInput: this.vdfInput,
            signature: this.signature ? arrayBufferToBase64(this.signature) : null,
            carriers: [...this.carriers],
            replies: [...this.replies],
            depth: this.depth
        };
    }

    /**
     * Reconstructs a Post object from incoming network data.
     * Converts Base64 string fields back into Uint8Arrays.
     * @param {object} j - The raw object from a JSON payload.
     * @returns {Post} - A complete Post instance.
     */
    static fromJSON(j) {
        const p = Object.create(Post.prototype);
        
        // Copy all basic properties
        p.id = j.id;
        p.content = j.content;
        p.timestamp = j.timestamp;
        p.parentId = j.parentId;
        p.imageHash = j.imageHash;
        p.imageData = j.imageData;
        p.author = j.author;
        p.authorUniqueId = j.authorUniqueId;
        p.authorVdfInput = j.authorVdfInput;
        p.vdfInput = j.vdfInput;
        p.depth = j.depth || 0;

        // Deserialize VDF proofs (convert iterations back from string)
        if (j.authorVdfProof) {
            p.authorVdfProof = {
                y: j.authorVdfProof.y,
                pi: j.authorVdfProof.pi,
                l: j.authorVdfProof.l,
                r: j.authorVdfProof.r,
                iterations: j.authorVdfProof.iterations ? BigInt(j.authorVdfProof.iterations) : null
            };
        }
        
        if (j.vdfProof) {
            p.vdfProof = {
                y: j.vdfProof.y,
                pi: j.vdfProof.pi,
                l: j.vdfProof.l,
                r: j.vdfProof.r,
                iterations: j.vdfProof.iterations ? BigInt(j.vdfProof.iterations) : null
            };
        }

        // Store image metadata if available
        if (j.imageMeta && j.imageHash) {
            if (!imageStore.images.has(j.imageHash)) {
                imageStore.images.set(j.imageHash, j.imageMeta);
                console.log(`[Post.fromJSON] Stored image metadata for ${j.imageHash.substring(0, 8)}...`);
            }
        }

        // Handle public key conversion
        if (typeof j.authorPublicKey === 'string') {
            p.authorPublicKey = base64ToArrayBuffer(j.authorPublicKey);
        } else if (j.authorPublicKey && (j.authorPublicKey.type === 'Buffer' || j.authorPublicKey.data)) {
            p.authorPublicKey = new Uint8Array(j.authorPublicKey.data || j.authorPublicKey);
        } else if (j.authorPublicKey instanceof Uint8Array) {
            p.authorPublicKey = j.authorPublicKey;
        }
        
        // Handle signature conversion
        if (typeof j.signature === 'string') {
            p.signature = base64ToArrayBuffer(j.signature);
        } else if (j.signature && (j.signature.type === 'Buffer' || j.signature.data)) {
            p.signature = new Uint8Array(j.signature.data || j.signature);
        } else if (j.signature instanceof Uint8Array) {
            p.signature = j.signature;
        } else {
            p.signature = null;
        }
        
        // Convert arrays back to Sets
        p.carriers = new Set(j.carriers || []);
        p.replies = new Set(j.replies || []);
        
        console.log('[Post.fromJSON] Reconstructed post:', {
            id: p.id,
            author: p.author,
            hasPublicKey: !!p.authorPublicKey,
            hasSignature: !!p.signature,
            hasAuthorVdfProof: !!p.authorVdfProof,
            authorVdfIterations: p.authorVdfProof?.iterations?.toString()
        });
        
        return p;
    }
}
