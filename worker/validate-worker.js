// worker/validate-worker.js
'use strict';

const { parentPort, workerData, threadId } = require('worker_threads');

// Per-thread Pyroscope init so this thread's samples carry a thread tag.
try {
  const Pyroscope = require('@pyroscope/nodejs');
  Pyroscope.init({
    serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS || 'http://pyroscope.observability.svc.cluster.local:4040',
    appName: process.env.OTEL_SERVICE_NAME || 'worker',
    tags: {
      service_name: process.env.OTEL_SERVICE_NAME || 'worker',
      version: process.env.APP_VERSION || '0.9.0',
      thread: String(threadId),
    },
    wall: { collectCpuTime: true },
  });
  Pyroscope.start();
} catch (err) {
  console.error('[validate-worker] pyroscope init failed:', err.message);
}

//const { acquireLock, releaseLock, incrementCounter } = require('./lock');
const { atomicIncrement } = require('./lock');

// ~1 ms of pure CPU — parallelisable, no shared state needed here.
function validateItem(item) {
  let acc = 0;
  for (let i = 0; i < 1_000_000; i++) acc += i % 7;
  return typeof item?.item === 'string' && item.item.length > 0;
}

function run() {
  const state = new Int32Array(workerData.sharedBuffer);
  const { chunk } = workerData;
  let localOk = 0;

  for (const item of chunk) {

    const valid = validateItem(item);
    if (valid) {
      atomicIncrement(state);   // single hardware instruction, no lock
      localOk++;
    }
    // CPU-bound — fully parallel across threads.
    // const valid = validateItem(item);

    // Shared-state update — tiny critical section, huge contention cost.
    // acquireLock(state);
    // if (valid) {
    //   incrementCounter(state);
    //   localOk++;
    // }
    // releaseLock(state);
  }

  parentPort.postMessage({ localOk, total: chunk.length, threadId });
}

run();