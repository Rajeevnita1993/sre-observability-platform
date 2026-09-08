const client = require('prom-client');

const register = new client.Registry(client.Registry.OPENMETRICS_CONTENT_TYPE);                  // ← enable exemplars
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['route', 'method', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['route', 'method', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
  enableExemplars: true,      // ✅ works because _openMetrics is true
});

const httpInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'In-flight HTTP requests',
  labelNames: ['route'],
  registers: [register],
});

const ordersPublished = new client.Counter({
  name: 'orders_published_total',
  help: 'Total orders published to SQS',
  labelNames: ['status'],   // optional, but useful to separate success/error
  registers: [register],
});

module.exports = { register, httpRequestsTotal, httpRequestDuration, httpInFlight, ordersPublished };