// worker/lock.js
// Atomics-based shared mutex.
// Int32 layout of the shared buffer:
//   index 0 = lock word  (0 = free, 1 = held)
//   index 1 = shared counter
'use strict';

const LOCK_INDEX = 0;
const COUNTER_INDEX = 1;

function acquireLock(state) {
  while (Atomics.compareExchange(state, LOCK_INDEX, 0, 1) !== 0) {
    Atomics.wait(state, LOCK_INDEX, 1);   // park until released
  }
}

function releaseLock(state) {
  Atomics.store(state, LOCK_INDEX, 0);
  Atomics.notify(state, LOCK_INDEX, 1);
}

// Non-atomic RMW — the reason the lock "needs" to exist.
function incrementCounter(state) {
  const current = Atomics.load(state, COUNTER_INDEX);
  Atomics.store(state, COUNTER_INDEX, current + 1);
}

function readCounter(state) {
  return Atomics.load(state, COUNTER_INDEX);
}


// atomic, lock-free increment — the fix
function atomicIncrement(state) {
  return Atomics.add(state, COUNTER_INDEX, 1);
}

module.exports = {
  acquireLock, releaseLock, incrementCounter, readCounter, atomicIncrement,
  LOCK_INDEX, COUNTER_INDEX,
};