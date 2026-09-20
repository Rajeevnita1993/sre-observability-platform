// worker/resultsCache.js
// deliberate unbounded cache.
// Looks like a normal idempotency helper. Never evicts. That's the bug.

// const resultsCache = new Map();   // keyed by orderId, never evicted

// function cacheResult(orderId, result) {
//   resultsCache.set(orderId, result);     // +1 entry per processed order, forever
// }

// function getResult(orderId) {
//   return resultsCache.get(orderId);
// }

// module.exports = { cacheResult, getResult, resultsCache };

// worker/resultsCache.js
// fix — bounded LRU. Same interface, safe internals.

const MAX_ENTRIES = 1000;
const resultsCache = new Map();   // insertion-ordered → LRU-friendly

function cacheResult(orderId, result) {
  if (resultsCache.has(orderId)) {
    resultsCache.delete(orderId);   // move to end (most recent)
  }
  resultsCache.set(orderId, result);
  if (resultsCache.size > MAX_ENTRIES) {
    const oldest = resultsCache.keys().next().value;
    resultsCache.delete(oldest);
  }
}

function getResult(orderId) {
  if (!resultsCache.has(orderId)) return undefined;
  const value = resultsCache.get(orderId);
  resultsCache.delete(orderId);
  resultsCache.set(orderId, value);   // refresh recency
  return value;
}

module.exports = { cacheResult, getResult, resultsCache };