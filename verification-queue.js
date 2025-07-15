export class VerificationQueue {
    constructor() {
        this.workers = [];
        this.queue = [];
        this.processing = new Map();
        this.results = new Map();
        this.callbacks = new Map();
        
    }
    
    handleError(id, error) {
    console.error(`Processing failed for item ${id}:`, error);
    const processing = this.processing.get(id);
    if (processing) {
        this.processing.delete(id);
    }
}
    
async init() {
    const workerCount = 4;
    console.log(`Initializing ${workerCount} verification workers...`);

    for (let i = 0; i < workerCount; i++) {
        await new Promise(async (resolve, reject) => {
            let worker;

                worker = new Worker(new URL('./verify-worker.js', import.meta.url), { type: 'module' });
                worker.addEventListener('error', (error) => {
                    console.error(`Worker ${i} failed to initialize:`, error);
                    reject(error);
                }, { once: true });
                worker.addEventListener('message', (event) => {
                    this.handleWorkerMessage(event.data, i);
                });
            

            this.workers.push({
                id: i,
                worker,
                busy: false,
                currentBatch: null
            });
            console.log(`Worker ${i} created.`);
            resolve();
        });
    }
    console.log('All workers have been initialized.');
}


    async initializeWorkers(count) {
        console.log(`Initializing ${count} workers sequentially...`);
        for (let i = 0; i < count; i++) {
            // Use a Promise to wait for the worker to be successfully created or fail
            await new Promise((resolve, reject) => {
                const worker = new Worker('verify-worker.js', { type: 'module' });

                const successListener = () => {
                    // To confirm success, we can listen for the first message
                    // or just resolve on the assumption it worked if no error fired.
                    // For simplicity, we'll resolve immediately after setup.
                    console.log(`Worker ${i} initialized successfully.`);
                    this.workers.push({
                        id: i,
                        worker,
                        busy: false,
                        currentBatch: null
                    });
                    resolve();
                };

                const errorListener = (error) => {
                    console.error(`Worker ${i} failed to initialize:`, error);
                    // We'll reject, but you could add more robust retry logic here
                    reject(error); 
                };
                
                // The 'error' event fires on failure.
                worker.addEventListener('error', errorListener, { once: true });
                
                // We can assume success if the error event doesn't fire right away.
                // Setting up other listeners:
                worker.addEventListener('message', (e) => {
                    this.handleWorkerMessage(e.data, i);
                });

                // A small timeout to allow the error event to fire if there's an immediate issue.
                setTimeout(() => {
                    worker.removeEventListener('error', errorListener);
                    successListener();
                }, 100); // Wait 100ms
            });
        }
        console.log('All workers initialized.');
    }
    
    handleWorkerMessage(message, workerId) {
        const worker = this.workers[workerId];
        
        switch (message.type) {
            case 'batch_complete':
                this.processBatchResults(message.id, message.results);
                worker.busy = false;
                worker.currentBatch = null;
                this.processNext();
                break;
                
            case 'single_complete':
                this.processSingleResult(message.id, message.result);
                worker.busy = false;
                this.processNext();
                break;
                
            case 'progress':
                this.updateProgress(message);
                break;
                
            case 'error':
                console.error('Worker error:', message.error);
                this.handleError(message.id, message.error);
                worker.busy = false;
                this.processNext();
                break;
        }
    }
    
    async addBatch(posts, priority = 'normal', callback = null) {
        const batchId = crypto.randomUUID();
        
        // Split into chunks for workers
        const chunkSize = Math.ceil(posts.length / this.workers.length);
        const chunks = [];
        
        for (let i = 0; i < posts.length; i += chunkSize) {
            chunks.push(posts.slice(i, i + chunkSize));
        }
        
        if (callback) {
            this.callbacks.set(batchId, callback);
        }
        
        // Add chunks to queue with priority
        chunks.forEach((chunk, index) => {
            const item = {
                id: `${batchId}-${index}`,
                batchId,
                type: 'verify_batch',
                data: { posts: chunk },
                priority,
                addedAt: Date.now()
            };
            
            if (priority === 'high') {
                this.queue.unshift(item);
            } else {
                this.queue.push(item);
            }
        });
        
        this.processNext();
        return batchId;
    }
    
    async verifySingle(post, priority = 'high') {
        return new Promise((resolve) => {
            const id = crypto.randomUUID();
            
            const item = {
                id,
                type: 'verify_single',
                data: { post },
                priority,
                addedAt: Date.now(),
                resolve
            };
            
            if (priority === 'high') {
                this.queue.unshift(item);
            } else {
                this.queue.push(item);
            }
            
            this.processNext();
        });
    }
    
    processNext() {
        // Find available workers
        const availableWorkers = this.workers.filter(w => !w.busy);
        
        if (availableWorkers.length === 0 || this.queue.length === 0) {
            return;
        }
        
        // Assign work to available workers
        while (availableWorkers.length > 0 && this.queue.length > 0) {
            const worker = availableWorkers.shift();
            const item = this.queue.shift();
            
            worker.busy = true;
            worker.currentBatch = item.id;
            
            this.processing.set(item.id, {
                workerId: worker.id,
                item,
                startTime: Date.now()
            });
            
            worker.worker.postMessage({
                type: item.type,
                data: item.data,
                id: item.id
            });
        }
    }
    
    processBatchResults(id, results) {
        const processing = this.processing.get(id);
        if (!processing) return;
        
        const { item } = processing;
        this.processing.delete(id);
        
        // Clean old results if too many
        if (this.results.size > 10000) {
            const entries = Array.from(this.results.entries());
            entries.slice(0, 5000).forEach(([id]) => this.results.delete(id));
        }
        
        // Check if entire batch is complete
        const batchId = item.batchId;
        if (batchId) {
            const allComplete = !Array.from(this.processing.values())
                .some(p => p.item.batchId === batchId);
            
            if (allComplete) {
                const callback = this.callbacks.get(batchId);
                if (callback) {
                    const batchResults = results;
                    callback(batchResults);
                    this.callbacks.delete(batchId);
                }
            }
        }
    }
    
    processSingleResult(id, result) {
        const processing = this.processing.get(id);
        if (!processing) return;
        
        const { item } = processing;
        this.processing.delete(id);
        
        this.results.set(result.id, result);
        
        if (item.resolve) {
            item.resolve(result);
        }
    }
    
    reassignWorkerTasks(workerId) {
        const worker = this.workers[workerId];
        
        // Find tasks assigned to failed worker
        const tasksToReassign = Array.from(this.processing.entries())
            .filter(([id, info]) => info.workerId === workerId)
            .map(([id, info]) => info.item);
        
        // Re-add to front of queue
        tasksToReassign.forEach(task => {
            this.processing.delete(task.id);
            this.queue.unshift(task);
        });
        
        // Restart worker
        worker.worker.terminate();
        worker.worker = new Worker('verify-worker.js', { type: 'module' });
        worker.busy = false;
        
        // Re-setup event listeners
        worker.worker.addEventListener('message', (e) => {
            this.handleWorkerMessage(e.data, workerId);
        });
        
        this.processNext();
    }
    
    updateProgress(message) {
        // Emit progress event
        window.dispatchEvent(new CustomEvent('verification-progress', {
            detail: {
                completed: message.completed,
                total: message.total
            }
        }));
    }
    
    getResult(postId) {
        return this.results.get(postId);
    }
    
    clearResults() {
        this.results.clear();
    }
    
    getStats() {
        return {
            queueLength: this.queue.length,
            processing: this.processing.size,
            results: this.results.size,
            workers: this.workers.map(w => ({
                id: w.id,
                busy: w.busy
            }))
        };
    }
}


