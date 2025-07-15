import { sendPeer } from '../p2p/network-manager.js'; 
import { generateId } from '../utils.js';
import { state } from '../state.js';


export class ContentAddressedImageStore {
    constructor() {
        this.chunks = new Map();
        this.images = new Map();
        this.maxChunkSize = 16 * 1024; // 16KB chunks
        this.maxTotalSize = 10 * 1024 * 1024; // 10MB total
        this.pendingRequests = new Map(); // Track pending requests
    }

    async sha256(data) {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(data);
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async storeImage(base64Data) {
        // Remove data URL prefix if present
        const imageData = base64Data.replace(/^data:image\/\w+;base64,/, '');
        
        // ADDED: Validate image size before processing
        const estimatedSize = (imageData.length * 3) / 4; // Base64 to bytes estimation
        const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB max per image
        
        if (estimatedSize > MAX_IMAGE_SIZE) {
            throw new Error(`Image too large: ${(estimatedSize / 1024 / 1024).toFixed(2)}MB (max 5MB)`);
        }
        
        // ADDED: Check total storage before adding
        let currentUsage = 0;
        for (const chunk of this.chunks.values()) {
            currentUsage += chunk.length;
        }
        
        if (currentUsage + estimatedSize > this.maxTotalSize) {
            // Force cleanup before rejecting
            this.cleanup();
            
            // Re-check after cleanup
            currentUsage = 0;
            for (const chunk of this.chunks.values()) {
                currentUsage += chunk.length;
            }
            
            if (currentUsage + estimatedSize > this.maxTotalSize) {
                throw new Error('Storage full - cannot store new images');
            }
        }

        // Check if we already have this image
        const imageHash = await this.sha256(imageData);
        if (this.images.has(imageHash)) {
            console.log(`[ImageStore] Image ${imageHash.substring(0, 8)}... already in store (cached).`);
            return { hash: imageHash, type: 'cached' };
        }

        // Rest of the method remains the same...
        // Chunk the image
        const chunks = [];
        const chunkHashes = [];
        for (let i = 0; i < imageData.length; i += this.maxChunkSize) {
            const chunk = imageData.slice(i, i + this.maxChunkSize);
            const chunkHash = await this.sha256(chunk);
            chunks.push({ hash: chunkHash, data: chunk, index: i / this.maxChunkSize });
            chunkHashes.push(chunkHash);

            if (!this.chunks.has(chunkHash)) {
                this.chunks.set(chunkHash, chunk);
                console.log(`[ImageStore] Stored new chunk ${chunkHash.substring(0, 8)}...`);
            } else {
                console.log(`[ImageStore] Chunk ${chunkHash.substring(0, 8)}... already exists.`);
            }
        }

        const merkleRoot = await this.buildMerkleTree(chunkHashes);
        console.log(`[ImageStore] Built Merkle Root for image ${imageHash.substring(0, 8)}...: ${merkleRoot?.substring(0, 8)}...`);

        this.images.set(imageHash, {
            merkleRoot,
            chunks: chunks.map(c => ({ hash: c.hash, index: c.index })),
            size: imageData.length,
            created: Date.now()
        });

        this.cleanup();

        return {
            hash: imageHash,
            merkleRoot,
            chunkCount: chunks.length,
            type: 'stored'
        };
    }

    async buildMerkleTree(hashes) {
        if (hashes.length === 0) return null;
        if (hashes.length === 1) return hashes[0];

        const pairs = [];
        for (let i = 0; i < hashes.length; i += 2) {
            const left = hashes[i];
            const right = hashes[i + 1] || hashes[i]; // Handle odd number of hashes by duplicating last one
            const combined = await this.sha256(left + right);
            pairs.push(combined);
        }
        return this.buildMerkleTree(pairs);
    }
    

    
    async retrieveImage(imageHash) {
        console.log(`[ImageStore] retrieveImage called for ${imageHash.substring(0, 8)}...`);

        if (this.pendingRequests.has(imageHash)) {
            console.log(`[ImageStore] Request already pending for ${imageHash.substring(0, 8)}...`);
            return this.pendingRequests.get(imageHash);
        }

        const requestPromise = this._retrieveImageInternal(imageHash)
            .finally(() => {
                this.pendingRequests.delete(imageHash);
            });

        this.pendingRequests.set(imageHash, requestPromise);
        return requestPromise;
    }

    async _retrieveImageInternal(imageHash) {
        const metadata = this.images.get(imageHash);
        if (!metadata) {
            console.warn(`[ImageStore] Cannot retrieve image ${imageHash.substring(0, 8)}...: Metadata not found.`);
            return null;
        }

        // Rest of the original retrieveImage logic...
        const missingChunks = [];
        const assembledChunks = new Array(metadata.chunks.length);
        const receivedChunkHashes = new Array(metadata.chunks.length);
        
        for (const chunkMeta of metadata.chunks) {
            const chunkData = this.chunks.get(chunkMeta.hash);
            if (chunkData) {
                assembledChunks[chunkMeta.index] = chunkData;
                receivedChunkHashes[chunkMeta.index] = chunkMeta.hash;
            } else {
                missingChunks.push(chunkMeta);
            }
        }

        if (missingChunks.length > 0) {
            console.log(`[ImageStore] Missing ${missingChunks.length} chunks for ${imageHash.substring(0, 8)}..., requesting from peers...`);
            
            const success = await this.requestChunksFromPeers(imageHash, missingChunks);
            if (!success) {
                console.error(`[ImageStore] Failed to retrieve chunks for ${imageHash.substring(0, 8)}...`);
                return null;
            }
            
            for (const chunkMeta of metadata.chunks) {
                const chunkData = this.chunks.get(chunkMeta.hash);
                if (!chunkData) {
                    console.error(`[ImageStore] Still missing chunk ${chunkMeta.hash.substring(0, 8)}... after peer request`);
                    return null;
                }
                assembledChunks[chunkMeta.index] = chunkData;
                receivedChunkHashes[chunkMeta.index] = chunkMeta.hash;
            }
        }

        const reconstructedMerkleRoot = await this.buildMerkleTree(receivedChunkHashes);
        if (reconstructedMerkleRoot !== metadata.merkleRoot) {
            console.error(`[ImageStore] Merkle Root mismatch for image ${imageHash.substring(0, 8)}...!`);
            return null;
        }

        const fullImageData = assembledChunks.join('');
        console.log(`[ImageStore] Successfully retrieved and verified image ${imageHash.substring(0, 8)}...`);
        return 'data:image/jpeg;base64,' + fullImageData;
    }

    // method to handle peer requests
    async requestChunksFromPeers(imageHash, missingChunks) {
        return new Promise((resolve) => {
            const peers = Array.from(state.peers.values());
            if (peers.length === 0) {
                console.error(`[ImageStore] No peers available to request chunks from`);
                return resolve(false);
            }

            const requestId = generateId(); // Unique ID for this request
            let receivedChunks = new Set();
            const neededCount = missingChunks.length;

            const timeout = setTimeout(() => {
                window.removeEventListener(`chunk_received_${requestId}`, listener);
                console.log(`[ImageStore] Timeout requesting chunks for ${imageHash.substring(0, 8)}...`);
                resolve(receivedChunks.size === neededCount);
            }, 10000);

            const listener = (event) => {
                const { detail } = event;
                if (detail.imageHash === imageHash && !receivedChunks.has(detail.chunkHash)) {
                    receivedChunks.add(detail.chunkHash);
                    if (receivedChunks.size >= neededCount) {
                        clearTimeout(timeout);
                        window.removeEventListener(`chunk_received_${requestId}`, listener);
                        resolve(true);
                    }
                }
            };
            window.addEventListener(`chunk_received_${requestId}`, listener);

            const requestMessage = {
                type: 'request_image_chunks',
                imageHash: imageHash,
                chunkHashes: missingChunks.map(c => c.hash),
                requestId: requestId // Include the unique ID in the request
            };

            peers.forEach((peerData) => {
                const { wire } = peerData;
                if (wire && !wire.destroyed && wire.ephemeral_msg?._ready) {
                    sendPeer(wire, requestMessage);
                }
            });
        });
    }
    
    async retryChunkRequests(imageHash, maxRetries = 3) {
        const metadata = this.images.get(imageHash);
        if (!metadata) return false;
        
        let attempt = 0;
        while (attempt < maxRetries) {
            const missingChunks = metadata.chunks.filter(
                chunkMeta => !this.chunks.has(chunkMeta.hash)
            );
            
            if (missingChunks.length === 0) {
                return true; // All chunks available
            }
            
            console.log(`[ImageStore] Retry attempt ${attempt + 1}/${maxRetries} for ${missingChunks.length} chunks`);
            
            const success = await this.requestChunksFromPeers(imageHash, missingChunks);
            if (success) {
                return true;
            }
            
            attempt++;
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
        
        return false;
    }
    // method to handle incoming chunk responses
    handleChunkResponse(chunkHash, chunkData, imageHash) {
        console.log(`[ImageStore] Received chunk ${chunkHash.substring(0, 8)}... for image ${imageHash.substring(0, 8)}...`);
        
        // Store the chunk
        this.chunks.set(chunkHash, chunkData);
        
        // Notify the request handler
        if (this.onChunkReceived) {
            this.onChunkReceived(chunkHash, chunkData, imageHash);
        }
    }

    cleanup() {
        let totalSize = 0;
        for (const chunk of this.chunks.values()) {
            totalSize += chunk.length;
        }

        console.log(`[ImageStore] Current total storage usage: ${(totalSize / 1024).toFixed(2)} KB (Max: ${(this.maxTotalSize / 1024 / 1024).toFixed(2)} MB)`);

        if (totalSize > this.maxTotalSize) {
            console.log(`[ImageStore] Initiating cleanup due to high memory usage.`);
            const sortedImages = Array.from(this.images.entries())
                .sort((a, b) => a[1].created - b[1].created);

            let cleanedUpSize = 0;
            while (totalSize > this.maxTotalSize * 0.7 && sortedImages.length > 0) {
                const [hash, metadata] = sortedImages.shift();
                console.log(`[ImageStore] Cleaning up image ${hash.substring(0, 8)}... (oldest)`);

                this.images.delete(hash);

                const chunksToDelete = new Set(metadata.chunks.map(c => c.hash));

                for (const [otherHash, otherMeta] of this.images) {
                    otherMeta.chunks.forEach(c => chunksToDelete.delete(c.hash));
                }

                for (const chunkHash of chunksToDelete) {
                    const chunkData = this.chunks.get(chunkHash);
                    if (chunkData) {
                        totalSize -= chunkData.length;
                        cleanedUpSize += chunkData.length;
                        this.chunks.delete(chunkHash);
                        console.log(`[ImageStore] Deleted unreferenced chunk ${chunkHash.substring(0, 8)}...`);
                    }
                }
            }
            console.log(`[ImageStore] Cleanup complete. Removed ${(cleanedUpSize / 1024).toFixed(2)} KB.`);
        }
    }
}
