// worker/metrics.js
const { metrics } = require('@opentelemetry/api');

const meter = metrics.getMeter('order-worker');

// COUNTER
const jobsProcessed = meter.createCounter(
  'worker_jobs_processed',
  {
    description: 'Jobs consumed from SQS and written to S3',
  }
);

// GAUGE
const queueDepth = meter.createObservableGauge(
  'sqs_queue_depth',
  {
    description: 'Approximate number of visible messages in the SQS queue',
  }
);

// HISTOGRAM
const s3WriteHist = meter.createHistogram(
  's3_write_duration',
  {
    unit: 's',
    description: 'Latency of PutObject to order-results bucket',
  }
);

const messagesConsumed = meter.createCounter(
  'sqs_messages_consumed_total',
  {
    description: 'Total SQS messages consumed and processed',
  }
);

module.exports = {
  jobsProcessed,
  queueDepth,
  s3WriteHist,
  messagesConsumed,
};