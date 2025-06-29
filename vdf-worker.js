import init, { VDFComputer } from './wasm/vdf_wasm.js';

// This worker initializes its own instance of the WASM module.
let computer = null;

self.addEventListener('message', async (e) => {
    const { input, iterations, jobId } = e.data;

    try {
        // Initialize WASM on the first call
        if (!computer) {
            await init(new URL('./wasm/vdf_wasm_bg.wasm', import.meta.url));
            computer = new VDFComputer();
        }

        // Define the progress callback which sends messages back to the main thread
        const onProgress = (percentage) => {
            self.postMessage({
                type: 'progress',
                jobId: jobId,
                progress: percentage
            });
        };

        // Run the computation
        const wasmProof = await computer.compute_proof(
            input,
            BigInt(iterations),
            onProgress
        );

        // IMPORTANT: Convert the WASM proof object to a plain JS object
        // This is necessary because WASM objects don't serialize properly with postMessage
        const proof = {
            y: wasmProof.y,
            pi: wasmProof.pi,
            l: wasmProof.l,
            r: wasmProof.r,
            iterations: iterations // Use the original iterations value we passed in
        };

        // Send the serialized proof back
        self.postMessage({
            type: 'complete',
            jobId: jobId,
            proof: proof
        });

    } catch (error) {
        // Report any errors
        self.postMessage({
            type: 'error',
            jobId: jobId,
            // This is the corrected line for this file
            error: String(error)
        });
    }
});
