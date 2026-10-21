// worker/idempotency.js
const Redis = require('ioredis');

// Use the Kubernetes service name 'redis' as the default
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  family: 4,
  autoSelectFamily: false,
  maxRetriesPerRequest: 3
});

const TTL_SECONDS = 60 * 60; // 1h

// returns true if this is a NEW message (we just claimed the key),
// false if it's a DUPLICATE (the key already existed)
async function claimIdempotencyKey(orderId) {
  const key = `idempotency:${orderId}`;
  const result = await redis.set(key, '1', 'EX', TTL_SECONDS, 'NX');
  return result === 'OK';
}

module.exports = { claimIdempotencyKey };