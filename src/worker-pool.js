
// Use n-2 workers to leave CPU resources for the browser and other tasks
// For 2 cores: use 1, for 3 cores: use 2, for 4+ cores: use n-2
const calculateMaxWorkers = () => {
    const cores = navigator.hardwareConcurrency || 4;
    if (cores <= 2) return 1;
    if (cores === 3) return 2;
    return cores - 2;
};
const MAX_WORKERS = calculateMaxWorkers();
console.log(`[WorkerPool] Detected ${navigator.hardwareConcurrency || 'unknown'} cores, using ${MAX_WORKERS} workers.`);

// Pre-initialize worker pool
const workerPool = [];
const activeWorkers = new Set();
const taskQueue = [];

// Create workers upfront
for (let i = 1; i <= MAX_WORKERS; i++) {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.id = i;
    worker.onerror = (error) => console.error(`[WorkerPool] Worker #${worker.id} error:`, error);
    worker.onmessageerror = (error) => console.error(`[WorkerPool] Worker #${worker.id} message error:`, error);
    workerPool.push(worker);
    console.log(`[WorkerPool] Pre-initialized worker #${worker.id}`);
}

function getWorker() {
    // If a worker is idle, return it
    if (workerPool.length > 0) {
        const worker = workerPool.pop();
        activeWorkers.add(worker);
        return Promise.resolve(worker);
    }
    // Otherwise, queue the task
    return new Promise(resolve => {
        taskQueue.push(resolve);
    });
}

function returnWorker(worker) {
    activeWorkers.delete(worker);
    // If there are tasks waiting, give this worker to the next task
    if (taskQueue.length > 0) {
        const nextTaskResolve = taskQueue.shift();
        activeWorkers.add(worker);
        nextTaskResolve(worker);
    } else {
        // Return to pool
        workerPool.push(worker);
    }
}

function runScheduleInWorker(args) {
    return new Promise(async (resolve, reject) => {
        const worker = await getWorker();
        const id = Date.now() + Math.random();

        const handler = (e) => {
            if (e.data.id === id) {
                worker.removeEventListener('message', handler);
                returnWorker(worker);
                if (e.data.type === 'SUCCESS') {
                    resolve(e.data.payload);
                } else {
                    const err = new Error(e.data.payload.message);
                    if (e.data.payload.stack) err.stack = e.data.payload.stack;
                    reject(err);
                }
            }
        };

        worker.addEventListener('message', handler);
        worker.postMessage({ type: 'GENERATE_SCHEDULE', payload: args, id });
    });
}

export function runScheduleInWorkerWithTimeout(args, timeoutMs = 20000) { // 20 second timeout
    return new Promise((resolve, reject) => {
        let timeoutHandle;
        const workerPromise = runScheduleInWorker(args);

        const timeoutPromise = new Promise((_, internalReject) => {
            timeoutHandle = setTimeout(() => {
                internalReject(new Error(`Worker task timed out after ${timeoutMs}ms for seed ${args.randomSeed}`));
            }, timeoutMs);
        });

        Promise.race([workerPromise, timeoutPromise])
            .then(result => {
                clearTimeout(timeoutHandle);
                resolve(result);
            })
            .catch(error => {
                clearTimeout(timeoutHandle);
                reject(error);
            });
    });
}
