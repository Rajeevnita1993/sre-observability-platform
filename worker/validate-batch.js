// worker/validate-batch.js
'use strict';
const { Worker } = require('worker_threads');
const path = require('path');

function chunkArray(arr, n) {
  const chunks = Array.from({ length: n }, () => []);
  arr.forEach((item, i) => chunks[i % n].push(item));
  return chunks;
}

function validateBatch(orders, nWorkers = 4) {
  // Fresh 8-byte shared buffer per batch: [lockWord, counterWord]
  const sharedBuffer = new SharedArrayBuffer(8);
  const chunks = chunkArray(orders, nWorkers);

  return Promise.all(chunks.map(chunk => runWorker(chunk, sharedBuffer)))
    .then(results => {
      const state = new Int32Array(sharedBuffer);
      return {
        workers: nWorkers,
        items: orders.length,
        sharedCounter: state[1],
        perWorker: results,
      };
    });
}

function runWorker(chunk, sharedBuffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'validate-worker.js'), {
      workerData: { chunk, sharedBuffer },
    });
    worker.on('message', resolve);
    worker.on('error', reject);
  });
}

module.exports = { validateBatch };