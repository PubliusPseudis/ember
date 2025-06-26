// File: vdf-wrapper.js
import init, { VDFComputer, VDFProof } from './wasm/vdf_wasm.js';

class WasmVDF {
    constructor() {
        // The wrapper now owns the worker
        this.worker = new Worker('vdf-worker.js', { type: 'module' });
        
        // This map holds the promise handlers for active jobs
        this.pendingJobs = new Map();
        this.VDFProof = null; 

        // Central message handler for all messages from the worker
        this.worker.onmessage = (event) => {
            const { type, jobId, progress, proof, error } = event.data;

            // Find the job this message belongs to
            const job = this.pendingJobs.get(jobId);
            if (!job) return;

            switch (type) {
                case 'progress':
                    // If a progress callback was provided, call it
                    if (job.onProgress) {
                        job.onProgress(progress);
                    }
                    break;
                case 'complete':
                    // The job succeeded, resolve the promise with the proof
                    job.resolve(proof);
                    this.pendingJobs.delete(jobId);
                    break;
                case 'error':
                    // The job failed, reject the promise with the error
                    job.reject(new Error(error));
                    this.pendingJobs.delete(jobId);
                    break;
            }
        };
    }
    async initialize() {
        if (this.computer) return; // Only initialize once
        await init(new URL('./wasm/vdf_wasm_bg.wasm', import.meta.url));
        this.computer = new VDFComputer();
        this.VDFProof = VDFProof; // Attach the VDFProof class for external use
        console.log('Main thread WASM VDF initialized for verification tasks.');
    }
    // This is now the primary public method. It returns a promise.
    computeVDFProofWithTimeout(input, iterations, onProgressCallback, timeoutMs = 35000) {
        return new Promise((resolve, reject) => {
            const jobId = Math.random().toString(36).substr(2, 9); // Unique ID for this job

            const timeout = setTimeout(() => {
                // If the job times out, reject the promise and clean up
                this.pendingJobs.delete(jobId);
                reject(new Error('VDF computation timed out'));
            }, timeoutMs);
            
            // Store the promise handlers and the progress callback
            this.pendingJobs.set(jobId, {
                resolve: (proof) => {
                    clearTimeout(timeout);
                    resolve(proof);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                onProgress: onProgressCallback
            });

            // Send the job to the worker
            this.worker.postMessage({
                input,
                iterations: iterations.toString(), // Pass BigInt as string
                jobId
            });
        });
    }


}

// Export a single instance of the wrapper
const wasmVDF = new WasmVDF();
export default wasmVDF;
