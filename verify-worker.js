// Import the WASM module
import init, { VDFComputer, VDFProof } from './wasm/vdf_wasm.js';

let computer = null;
let initialized = false;

// Initialize WASM once
async function initializeWasm() {
    if (!initialized) {
        await init(new URL('./wasm/vdf_wasm_bg.wasm', import.meta.url));

        computer = new VDFComputer();
        initialized = true;
        console.log('[Worker] WASM VDF initialized');
    }
}

// Nacl for signature verification - use CDN or bundle it
import nacl from 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm';

// Helper functions from main code
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function verifySignature(post) {
    console.log(`[SIG_VERIFY] --- Starting verification for post ${post.id} ---`);
    
    // Debug: log what fields this post object actually has
    console.log('[SIG_VERIFY] Post fields:', Object.keys(post));
    console.log('[SIG_VERIFY] Full post object:', post);
    
    if (!post.signature || !post.authorPublicKey) {
        console.error(`[SIG_VERIFY] ❌ FAILED: Post ${post.id} is missing signature or public key.`);
        return false;
    }
    console.log(`[SIG_VERIFY] Post has signature and public key. Proceeding...`);
    console.log(`[SIG_VERIFY]   > Public Key (b64): ${post.authorPublicKey}`);
    
    try {
        const publicKeyBytes = base64ToArrayBuffer(post.authorPublicKey);
        const signatureBytes = base64ToArrayBuffer(post.signature);
        console.log(`[SIG_VERIFY] Decoded keys and signature into byte arrays.`);
        console.log(`[SIG_VERIFY]   > Public Key length: ${publicKeyBytes.length} bytes`);
        console.log(`[SIG_VERIFY]   > Signature length: ${signatureBytes.length} bytes`);

        // Reconstruct the exact data object that was signed.
        const signableData = {
            id: post.id,
            content: post.content,
            timestamp: post.timestamp,
            parentId: post.parentId,
            imageHash: post.imageHash,
            authorPublicKey: post.authorPublicKey // Use the Base64 string from the post object
        };
        console.log('[SIG_VERIFY] Reconstructed signableData object:', signableData);

        // This is the most critical part: This string MUST EXACTLY MATCH the one created before signing.
        const messageToVerifyString = JSON.stringify(signableData);
        console.log('[SIG_VERIFY] Stringified data to verify:', messageToVerifyString);

        const messageBytes = new TextEncoder().encode(messageToVerifyString);
        
        // Attempt to open the signature
        console.log('[SIG_VERIFY] Calling nacl.sign.open...');
        const verifiedMessageBytes = nacl.sign.open(signatureBytes, publicKeyBytes);

        if (verifiedMessageBytes === null) {
            console.error(`[SIG_VERIFY] ❌ FAILED: nacl.sign.open returned null. The signature is cryptographically invalid for the given public key and message.`);
            return false;
        }
        console.log('[SIG_VERIFY] ✅ nacl.sign.open succeeded. Signature is valid for the public key.');

        // Final check: Does the message content match?
        const decodedMessage = new TextDecoder().decode(verifiedMessageBytes);
        console.log('[SIG_VERIFY] Decoded message from signature:', decodedMessage);

        if (decodedMessage !== messageToVerifyString) {
            console.error(`[SIG_VERIFY] ❌ FAILED: Message content mismatch after verification!`);
            console.error(`[SIG_VERIFY]   > Expected: ${messageToVerifyString}`);
            console.error(`[SIG_VERIFY]   > Got:      ${decodedMessage}`);
            return false;
        }

        console.log(`[SIG_VERIFY] ✅ SUCCESS: Message content matches. Signature for post ${post.id} is fully verified.`);
        return true;

    } catch (e) {
        console.error(`[SIG_VERIFY] ❌ FAILED: An unexpected error occurred during verification for post ${post.id}:`, e);
        return false;
    }
}

// Main message handler
self.addEventListener('message', async function(e) {
    const { type, data, id } = e.data;
    
    try {
        await initializeWasm();
        
        switch (type) {
            case 'verify_batch':
                const results = await verifyBatch(data.posts);
                self.postMessage({ type: 'batch_complete', id, results });
                break;
                
            case 'verify_single':
                const result = await verifySinglePost(data.post);
                self.postMessage({ type: 'single_complete', id, result });
                break;
        }
    } catch (error) {
        self.postMessage({ 
            type: 'error', 
            id, 
            error: error.message 
        });
    }
});

async function verifyBatch(posts) {
    const results = [];
    
    for (const post of posts) {
        const result = await verifySinglePost(post);
        results.push(result);
        
        // Send progress updates
        if (results.length % 10 === 0) {
            self.postMessage({ 
                type: 'progress', 
                completed: results.length, 
                total: posts.length 
            });
        }
    }
    
    return results;
}

async function verifySinglePost(post) {
    const verification = {
        id: post.id,
        valid: false,
        errors: []
    };

    console.log(`[Worker] Starting verification for post ${post.id}`);

    try {
        // --- 1. Verify author VDF (with new validation) ---
        if (!post.authorVdfProof || typeof post.authorVdfProof !== 'object' || !post.authorVdfProof.y) {
            console.log(`[Worker] Author VDF proof missing or malformed:`, post.authorVdfProof);
            verification.errors.push('Missing or malformed author VDF proof');
            return verification;
        }

        console.log(`[Worker] Verifying author VDF proof...`);
        const authorProof = new VDFProof(
            post.authorVdfProof.y,
            post.authorVdfProof.pi,
            post.authorVdfProof.l,
            post.authorVdfProof.r,
            BigInt(post.authorVdfProof.iterations) // Convert back to BigInt for WASM
        );

        const authorVdfValid = await computer.verify_proof(
            post.authorVdfInput,
            authorProof
        );

        console.log(`[Worker] Author VDF verification result: ${authorVdfValid}`);
        if (!authorVdfValid) {
            verification.errors.push('Invalid author VDF proof');
        }

        // --- 2. Verify post VDF if present ---
        if (post.vdfProof) {
            if (typeof post.vdfProof !== 'object' || !post.vdfProof.y) {
                console.log(`[Worker] Post VDF proof malformed:`, post.vdfProof);
                verification.errors.push('Malformed post VDF proof');
            } else {
                console.log(`[Worker] Verifying post VDF proof...`);
                const postProof = new VDFProof(
                    post.vdfProof.y,
                    post.vdfProof.pi,
                    post.vdfProof.l,
                    post.vdfProof.r,
                    BigInt(post.vdfProof.iterations) // Convert back to BigInt for WASM
                );

                const postVdfValid = await computer.verify_proof(
                    post.vdfInput,
                    postProof
                );

                console.log(`[Worker] Post VDF verification result: ${postVdfValid}`);
                if (!postVdfValid) {
                    verification.errors.push('Invalid post VDF proof');
                }
            }
        }

        // --- 3. Verify signature ---
        console.log(`[Worker] Verifying signature...`);
        const signatureValid = verifySignature(post);
        console.log(`[Worker] Signature verification result: ${signatureValid}`);
        if (!signatureValid) {
            verification.errors.push('Invalid signature');
        }

        // The post is valid only if there are no errors
        if (verification.errors.length === 0) {
            verification.valid = true;
            console.log(`[Worker] Post ${post.id} verification SUCCESS`);
        } else {
            console.log(`[Worker] Post ${post.id} verification FAILED. Errors:`, verification.errors);
        }

    } catch (error) {
        console.error(`[Worker] Verification error for post ${post.id}:`, error);
        verification.errors.push(error.message);
    }

    return verification;
}
