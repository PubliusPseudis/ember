// File: vdf-wrapper.js
import init, { VDFComputer, VDFProof } from './wasm/vdf_wasm.js';

class WasmVDF {
    constructor() {

            // Browser environment - use Web Worker
            this.worker = new Worker(new URL('./vdf-worker.js', import.meta.url), { type: 'module' });


        
        
        // This map holds the promise handlers for active jobs
        this.pendingJobs = new Map();
        this.VDFProof = null;

        // Set up message handler for browser
            this.worker.onmessage = (event) => {
                this.handleWorkerMessage(event.data);
            };
        
    }
    
    handleWorkerMessage(data) {
        const { type, jobId, progress, proof, error } = data;

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
    }
    
    async verifyVDFProof(input, proofData) {
        if (!this.computer || !this.VDFProof) {
            throw new Error("WASM VDF not initialized for verification.");
        }
        // Internally create the proof object from the raw data
        const proofObject = new this.VDFProof(
            proofData.y,
            proofData.pi,
            proofData.l,
            proofData.r,
            BigInt(proofData.iterations)
        );
        // Call the underlying WASM verification function
        return await this.computer.verify_proof(input, proofObject);
    }
    
    async initialize() {
        if (this.computer) return; // Only initialize once
        

            // Browser environment
            await init(new URL('./wasm/vdf_wasm_bg.wasm', import.meta.url));
        
        
        this.computer = new VDFComputer();
        this.VDFProof = VDFProof;
        console.log('Main thread WASM VDF initialized for verification tasks.');
    }
    
    // This is now the primary public method. It returns a promise.
    async computeVDFProofWithTimeout(input, iterations, onProgressCallback, timeoutMs = 35000) {

        
        // Browser environment - use worker
        return new Promise((resolve, reject) => {
            const jobId = Math.random().toString(36).substr(2, 9);

            const timeout = setTimeout(() => {
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
                iterations: iterations.toString(),
                jobId
            });
        });
    }
}

// Export a single instance of the wrapper
const wasmVDF = new WasmVDF();
export default wasmVDF;
