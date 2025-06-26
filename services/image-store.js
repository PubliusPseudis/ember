import { state } from '../main.js';


export class ContentAddressedImageStore {
    constructor() {
        this.chunks = new Map();
        this.images = new Map();
        this.maxChunkSize = 16 * 1024; // 16KB chunks
        this.maxTotalSize = 10 * 1024 * 1024; // 10MB total
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

        // Check if we already have this image
        const imageHash = await this.sha256(imageData);
        if (this.images.has(imageHash)) {
            console.log(`[ImageStore] Image ${imageHash.substring(0, 8)}... already in store (cached).`);
            return { hash: imageHash, type: 'cached' };
        }

        // Chunk the image
        const chunks = [];
        const chunkHashes = []; // To build Merkle tree
        for (let i = 0; i < imageData.length; i += this.maxChunkSize) {
            const chunk = imageData.slice(i, i + this.maxChunkSize);
            const chunkHash = await this.sha256(chunk);
            chunks.push({ hash: chunkHash, data: chunk, index: i / this.maxChunkSize });
            chunkHashes.push(chunkHash); // Add hash to list for Merkle tree

            // Store chunk if we don't have it
            if (!this.chunks.has(chunkHash)) {
                this.chunks.set(chunkHash, chunk);
                console.log(`[ImageStore] Stored new chunk ${chunkHash.substring(0, 8)}...`);
            } else {
                console.log(`[ImageStore] Chunk ${chunkHash.substring(0, 8)}... already exists.`);
            }
        }

        // Build merkle tree
        const merkleRoot = await this.buildMerkleTree(chunkHashes);
        console.log(`[ImageStore] Built Merkle Root for image ${imageHash.substring(0, 8)}...: ${merkleRoot?.substring(0, 8)}...`);

        // Store image metadata
        this.images.set(imageHash, {
            merkleRoot,
            chunks: chunks.map(c => ({ hash: c.hash, index: c.index })),
            size: imageData.length,
            created: Date.now()
        });
        console.log(`[ImageStore] Stored image metadata for ${imageHash.substring(0, 8)}... (chunks: ${chunks.length}, Merkle Root: ${merkleRoot?.substring(0, 8)}...)`);

        // Clean up old data if needed
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
        
        const metadata = this.images.get(imageHash);
        if (!metadata) {
            console.warn(`[ImageStore] Cannot retrieve image ${imageHash.substring(0, 8)}...: Metadata not found.`);
            return null;
        }

        // Check what chunks we have locally and what we're missing
        const missingChunks = [];
        const assembledChunks = new Array(metadata.chunks.length);
        const receivedChunkHashes = new Array(metadata.chunks.length);
        
        for (const chunkMeta of metadata.chunks) {
            const chunkData = this.chunks.get(chunkMeta.hash);
            if (chunkData) {
                // We have this chunk locally
                assembledChunks[chunkMeta.index] = chunkData;
                receivedChunkHashes[chunkMeta.index] = chunkMeta.hash;
            } else {
                // We're missing this chunk
                missingChunks.push(chunkMeta);
            }
        }

        // If we're missing chunks, request them from peers
        if (missingChunks.length > 0) {
            console.log(`[ImageStore] Missing ${missingChunks.length} chunks for ${imageHash.substring(0, 8)}..., requesting from peers...`);
            
            const success = await this.requestChunksFromPeers(imageHash, missingChunks);
            if (!success) {
                console.error(`[ImageStore] Failed to retrieve chunks for ${imageHash.substring(0, 8)}...`);
                return null;
            }
            
            // Re-assemble with the newly received chunks
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

        // Verify Merkle Root
        const reconstructedMerkleRoot = await this.buildMerkleTree(receivedChunkHashes);
        if (reconstructedMerkleRoot !== metadata.merkleRoot) {
            console.error(`[ImageStore] Merkle Root mismatch for image ${imageHash.substring(0, 8)}...! Expected ${metadata.merkleRoot?.substring(0, 8)}..., got ${reconstructedMerkleRoot?.substring(0, 8)}...`);
            return null;
        }
        console.log(`[ImageStore] Merkle Root verified for image ${imageHash.substring(0, 8)}...: ${reconstructedMerkleRoot?.substring(0, 8)}...`);

        // Reassemble chunks
        const fullImageData = assembledChunks.join('');
        console.log(`[ImageStore] Successfully retrieved and verified image ${imageHash.substring(0, 8)}...`);
        return 'data:image/jpeg;base64,' + fullImageData;
    }

    // method to handle peer requests
    async requestChunksFromPeers(imageHash, missingChunks) {
        return new Promise((resolve) => {
            // Add debug logging here
            console.log(`[ImageStore] requestChunksFromPeers called`);
            console.log(`[ImageStore] state exists:`, !!state);
            console.log(`[ImageStore] state.peers exists:`, !!(state && state.peers));
            console.log(`[ImageStore] Available peers:`, state && state.peers ? state.peers.size : 0);
            
            const timeout = setTimeout(() => {
                console.log(`[ImageStore] Timeout requesting chunks for ${imageHash.substring(0, 8)}...`);
                resolve(false);
            }, 10000); // 10 second timeout


            let chunksReceived = 0;
            const chunksNeeded = missingChunks.length;
            const receivedChunks = new Set(); // Track which chunks we've received

            // Create request message with proper type
            const requestMessage = {
                type: 'request_image_chunks',  // match the handler in network-manager.js
                imageHash: imageHash,
                chunkHashes: missingChunks.map(c => c.hash)
            };

            console.log(`[ImageStore] Requesting ${chunksNeeded} chunks for ${imageHash.substring(0, 8)}...`);

            // Send request to all connected peers
            if (state && state.peers) {
                state.peers.forEach((peerData, peerId) => {
                    try {
                        const wire = peerData.wire;
                        if (wire && wire.ephemeral_msg && wire.ephemeral_msg._ready) {
                            wire.extended(wire.ephemeral_msg.peerId, 
                                new TextEncoder().encode(JSON.stringify(requestMessage)));
                        }
                    } catch (error) {
                        console.error(`[ImageStore] Failed to send chunk request to peer:`, error);
                    }
                });
            } else {
                console.error(`[ImageStore] No peers available to request chunks from`);
                clearTimeout(timeout);
                resolve(false);
                return;
            }

            // Store the original handler
            const originalHandler = this.onChunkReceived;
            
            // Set up response handler
            this.onChunkReceived = (chunkHash, chunkData, receivedImageHash) => {
                // Check if this chunk is for our image
                if (receivedImageHash === imageHash && !receivedChunks.has(chunkHash)) {
                    receivedChunks.add(chunkHash);
                    chunksReceived++;
                    console.log(`[ImageStore] Received chunk ${chunksReceived}/${chunksNeeded} for ${imageHash.substring(0, 8)}...`);
                    
                    if (chunksReceived >= chunksNeeded) {
                        clearTimeout(timeout);
                        this.onChunkReceived = originalHandler; // Restore original handler
                        resolve(true);
                    }
                }
                
                // Call original handler if it exists
                if (originalHandler) {
                    originalHandler.call(this, chunkHash, chunkData, receivedImageHash);
                }
            };
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
