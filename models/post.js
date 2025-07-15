import nacl from 'tweetnacl'; 
import { state } from '../state.js';
import { getImageStore } from '../services/instances.js';

import { generateId, sanitize, arrayBufferToBase64, base64ToArrayBuffer } from '../utils.js';
import { CONFIG } from '../config.js';

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
        // ADDED: Validate content before creating post
        if (!content || typeof content !== 'string') {
            throw new Error('Post content must be a non-empty string');
        }
        
        if (content.length > CONFIG.MAX_POST_SIZE) {
            throw new Error(`Post content too long: ${content.length} characters (max ${CONFIG.MAX_POST_SIZE})`);
        }
        
        // Core post data
        this.id = generateId();
        this.content = sanitize(content);
        this.timestamp = Date.now();
        this.parentId = parentId;
        this.imageData = imageData; // Temporary storage for base64 before processing
        this.imageHash = null; // Will be populated by processImage()

        // Author's identity information
        if (!state.myIdentity || !state.myIdentity.handle) {
            throw new Error('Cannot create post without identity');
        }
        
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
        //nb do not sign ratings. they are mutable. 
        //we will use basic bayesian conjugate pair - beta-binomial.
        this.ratings = new Map(); // voter handle -> { vote: 'up'|'down', reputation: number }
        this.ratingStats = {
            alpha: 1, // Beta distribution parameter (successes + 1)
            beta: 1,  // Beta distribution parameter (failures + 1)
            totalWeight: 0,
            score: 0.5 // Prior: neutral
        };
        
        this.signature = null;

        // Ephemeral state
        this.carriers = new Set([state.myIdentity.handle]);
        this.replies = new Set();
        this.depth = 0;
        
        // Trust-related transient properties (not serialized)
        this.trustScore = 0;
        this.attesters = new Set();
        this.attestationTimestamps = new Map();
    }

    async processImage() {
        if (this.imageData && !this.imageHash) {
            const imageStore = getImageStore();
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

      // This cryptographically links the proof-of-work to the post content and author.
      const signableData = {
        id: this.id,
        content: this.content,
        timestamp: this.timestamp,
        parentId: this.parentId,
        imageHash: this.imageHash,
        authorPublicKey: publicKeyBase64,
        vdfInput: this.vdfInput, // Add VDF input to the signature
        vdfProof: this.vdfProof ? serializeVdfProof(this.vdfProof) : null // Add serialized VDF proof
      };
      const signedString = JSON.stringify(signableData);
      return new TextEncoder().encode(signedString);
    }

    /**
     * Signs the post using the user's private key.
     * @param {Uint8Array} secretKey - The user's secret signing key.
     */
    sign(secretKey) {
        // Re-create the signable data at the moment of signing
        // to capture any properties added after the constructor, like the reply's VDF proof.
        const signableData = {
          id: this.id,
          content: this.content,
          timestamp: this.timestamp,
          parentId: this.parentId,
          imageHash: this.imageHash,
          authorPublicKey: arrayBufferToBase64(this.authorPublicKey),
          vdfInput: this.vdfInput,
          vdfProof: this.vdfProof ? serializeVdfProof(this.vdfProof) : null
        };

        const messageBytes = new TextEncoder().encode(JSON.stringify(signableData));
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

        // Use the same logic as the new sign() method to reconstruct the data.
        const signableData = {
          id: this.id,
          content: this.content,
          timestamp: this.timestamp,
          parentId: this.parentId,
          imageHash: this.imageHash,
          authorPublicKey: arrayBufferToBase64(this.authorPublicKey),
          vdfInput: this.vdfInput,
          vdfProof: this.vdfProof ? serializeVdfProof(this.vdfProof) : null
        };
        
        const messageToVerifyBytes = new TextEncoder().encode(JSON.stringify(signableData));
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
     * Add an attestation from a peer
     * @param {string} attesterHandle - The handle of the attesting peer
     * @param {number} reputationScore - The reputation score of the attester
     * @returns {boolean} - True if attestation was new, false if already existed
     */
    addAttestation(attesterHandle, reputationScore) {
        if (this.attesters.has(attesterHandle)) {
            return false; // Already attested
        }
        
        this.attesters.add(attesterHandle);
        this.attestationTimestamps.set(attesterHandle, Date.now());
        
        // Add reputation score to trust score
        // Use logarithmic scaling to prevent single high-rep peer from dominating
        // But ensure even rep=0 peers contribute something (minimum 1 point)
        const scoreContribution = Math.max(1, Math.log(1 + reputationScore) * 10);
        this.trustScore += scoreContribution;
        
        console.log(`[Post] Added attestation from ${attesterHandle}, trust score now: ${this.trustScore.toFixed(2)}`);
        return true;
    }

    /**
     * Check if post has sufficient trust to skip verification
     * @param {number} threshold - The trust threshold required
     * @returns {boolean}
     */
    hasSufficientTrust(threshold) {
        return this.trustScore >= threshold;
    }

    /**
     * Get age of oldest attestation in milliseconds
     * @returns {number}
     */
    getOldestAttestationAge() {
        if (this.attestationTimestamps.size === 0) return 0;
        
        const now = Date.now();
        let oldestAge = 0;
        
        for (const timestamp of this.attestationTimestamps.values()) {
            const age = now - timestamp;
            if (age > oldestAge) oldestAge = age;
        }
        
        return oldestAge;
    }

    /**
     * Add or update a rating using beta-binomial model
     * @param {string} voterHandle - Handle of the voter
     * @param {string} vote - 'up' or 'down'
     * @param {number} voterReputation - Reputation score of the voter
     * @returns {boolean} - True if rating was new or changed
     */
    addRating(voterHandle, vote, voterReputation) {
        const existingRating = this.ratings.get(voterHandle);
        
        // If same vote, no change needed
        if (existingRating && existingRating.vote === vote) {
            return false;
        }
        
        // Weight based on reputation (log scale with minimum)
        const weight = Math.max(0.1, Math.log10(voterReputation + 10));
        
        // Remove old vote effect if changing vote
        if (existingRating) {
            if (existingRating.vote === 'up') {
                this.ratingStats.alpha -= existingRating.weight;
            } else {
                this.ratingStats.beta -= existingRating.weight;
            }
            this.ratingStats.totalWeight -= existingRating.weight;
        }
        
        // Add new vote
        this.ratings.set(voterHandle, { vote, weight, reputation: voterReputation });
        
        if (vote === 'up') {
            this.ratingStats.alpha += weight;
        } else {
            this.ratingStats.beta += weight;
        }
        this.ratingStats.totalWeight += weight;
        
        // Calculate score using beta distribution mean
        // For beta-binomial, the posterior mean is alpha/(alpha+beta)
        this.ratingStats.score = this.calculateBayesianScore();
        
        console.log(`[Rating] ${voterHandle} rated post ${this.id} as ${vote} (weight: ${weight.toFixed(2)}, score: ${this.ratingStats.score.toFixed(3)})`);
        
        return true;
    }

    /**
     * Calculate Bayesian score using beta-binomial posterior
     * This gives us a score that accounts for uncertainty
     */
    calculateBayesianScore() {
        // Beta distribution parameters (with prior of alpha=1, beta=1)
        const a = this.ratingStats.alpha;
        const b = this.ratingStats.beta;
        const n = a + b - 2; // Total weighted votes (minus prior)
        
        if (n <= 0) return 0.5; // No votes, return neutral prior
        
        // Posterior mean
        const mean = a / (a + b);
        
        // For ranking, we want to penalize uncertainty
        // Use lower bound of credible interval (similar to Wilson score idea)
        // This approximation works well for beta distribution
        const z = 1.96; // 95% confidence
        const variance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
        const stderr = Math.sqrt(variance);
        
        // Lower bound of credible interval
        const lowerBound = mean - z * stderr;
        
        // Ensure bounds
        return Math.max(0, Math.min(1, lowerBound));
    }

    /**
     * Get rating summary for display
     */
    getRatingSummary() {
        const upvotes = Array.from(this.ratings.values()).filter(r => r.vote === 'up').length;
        const downvotes = Array.from(this.ratings.values()).filter(r => r.vote === 'down').length;
        
        // Calculate confidence based on total weighted votes
        // More votes = higher confidence
        const confidence = 1 - Math.exp(-this.ratingStats.totalWeight / 10);
        
        return {
            score: this.ratingStats.score,
            confidence: confidence,
            upvotes,
            downvotes,
            total: this.ratings.size,
            weightedTotal: this.ratingStats.totalWeight
        };
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
        const imageStore = getImageStore();
        if (this.imageHash && imageStore && imageStore.images.has(this.imageHash)) {
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
            depth: this.depth,
            ratings: Array.from(this.ratings.entries()).map(([handle, data]) => ({
                handle,
                vote: data.vote,
                weight: data.weight
            })),
            ratingStats: this.ratingStats
        };
    }

    /**
     * Reconstructs a Post object from incoming network data.
     * Converts Base64 string fields back into Uint8Arrays.
     * @param {object} j - The raw object from a JSON payload.
     * @returns {Post} - A complete Post instance.
     */
    static fromJSON(j) {
        // ADDED: Validate input structure
        if (!j || typeof j !== 'object') {
            throw new Error('Invalid post data: must be an object');
        }
        
        // ADDED: Required field validation
        const requiredFields = ['id', 'content', 'timestamp', 'author'];
        for (const field of requiredFields) {
            if (!(field in j)) {
                throw new Error(`Invalid post data: missing required field "${field}"`);
            }
        }
        
        // ADDED: Type validation
        if (typeof j.id !== 'string' || typeof j.content !== 'string' || 
            typeof j.timestamp !== 'number' || typeof j.author !== 'string') {
            throw new Error('Invalid post data: incorrect field types');
        }
        
        const p = Object.create(Post.prototype);
        
        // Copy all basic properties with validation
        p.id = j.id;
        p.content = sanitize(j.content); // Re-sanitize for safety
        p.timestamp = j.timestamp;
        p.parentId = j.parentId || null;
        p.imageHash = j.imageHash || null;
        p.imageData = j.imageData || null;
        p.author = j.author;
        p.authorUniqueId = j.authorUniqueId || null;
        p.authorVdfInput = j.authorVdfInput || null;
        p.vdfInput = j.vdfInput || null;
        p.depth = typeof j.depth === 'number' ? j.depth : 0;

        // Deserialize VDF proofs with validation
        if (j.authorVdfProof && typeof j.authorVdfProof === 'object') {
            p.authorVdfProof = {
                y: j.authorVdfProof.y,
                pi: j.authorVdfProof.pi,
                l: j.authorVdfProof.l,
                r: j.authorVdfProof.r,
                iterations: j.authorVdfProof.iterations ? BigInt(j.authorVdfProof.iterations) : null
            };
        } else {
            p.authorVdfProof = null;
        }
        
        if (j.vdfProof && typeof j.vdfProof === 'object') {
            p.vdfProof = {
                y: j.vdfProof.y,
                pi: j.vdfProof.pi,
                l: j.vdfProof.l,
                r: j.vdfProof.r,
                iterations: j.vdfProof.iterations ? BigInt(j.vdfProof.iterations) : null
            };
        } else {
            p.vdfProof = null;
        }

        // Store image metadata if available
        if (j.imageMeta && j.imageHash) {
            const imageStore = getImageStore();
            if (imageStore && !imageStore.images.has(j.imageHash)) {
                imageStore.images.set(j.imageHash, j.imageMeta);
                console.log(`[Post.fromJSON] Stored image metadata for ${j.imageHash.substring(0, 8)}...`);
            }
        }

        // Handle public key conversion with validation
        if (typeof j.authorPublicKey === 'string') {
            p.authorPublicKey = base64ToArrayBuffer(j.authorPublicKey);
        } else if (j.authorPublicKey && (j.authorPublicKey.type === 'Buffer' || j.authorPublicKey.data)) {
            p.authorPublicKey = new Uint8Array(j.authorPublicKey.data || j.authorPublicKey);
        } else if (j.authorPublicKey instanceof Uint8Array) {
            p.authorPublicKey = j.authorPublicKey;
        } else {
            p.authorPublicKey = null;
        }
        
        // Handle signature conversion with validation
        if (typeof j.signature === 'string') {
            p.signature = base64ToArrayBuffer(j.signature);
        } else if (j.signature && (j.signature.type === 'Buffer' || j.signature.data)) {
            p.signature = new Uint8Array(j.signature.data || j.signature);
        } else if (j.signature instanceof Uint8Array) {
            p.signature = j.signature;
        } else {
            p.signature = null;
        }
        
        // Convert arrays back to Sets with validation
        p.carriers = new Set(Array.isArray(j.carriers) ? j.carriers : []);
        p.replies = new Set(Array.isArray(j.replies) ? j.replies : []);
        
        // Initialize trust properties for loaded/received posts
        p.trustScore = 0;
        p.attesters = new Set();
        p.attestationTimestamps = new Map();
        
        //community ratings:
        p.ratings = new Map();
        if (j.ratings && Array.isArray(j.ratings)) {
            j.ratings.forEach(r => {
                p.ratings.set(r.handle, {
                    vote: r.vote,
                    weight: r.weight || 1,
                    reputation: r.reputation || 0
                });
            });
        }

        p.ratingStats = j.ratingStats || {
            alpha: 1,
            beta: 1,
            totalWeight: 0,
            score: 0.5
        };
        
        
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
