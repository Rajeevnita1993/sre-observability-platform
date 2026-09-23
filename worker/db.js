// worker/db.js — one pool shared across all message processing
const { Pool } = require('pg');

const pool = new Pool({
  max: 10,                       // < max_connections (20), leaves room for psql + exporter
  idleTimeoutMillis: 30000,      // close idle clients after 30s
  connectionTimeoutMillis: 5000, // fail fast if the pool is starved
});

// pool.on('error') catches errors on idle clients — without this handler,
// a backend disconnect crashes the process with an unhandled error event.
pool.on('error', (err) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: 'postgres pool error',
    error: err.message,
  }));
});

async function recordOrder(order) {
  await pool.query(
  `INSERT INTO orders (order_id, customer_id, status, created_at, completed_at)
   VALUES ($1, $2, 'completed', to_timestamp($3 / 1000.0), now())
   ON CONFLICT (order_id) DO UPDATE SET
     status       = EXCLUDED.status,
     completed_at = EXCLUDED.completed_at`,
  [order.id, order.customerId || 'unknown', order.ts]
);
}

module.exports = { pool, recordOrder };