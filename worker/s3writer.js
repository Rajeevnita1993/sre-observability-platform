// worker/s3writer.js
// Fault-injection wrapper for S3 writes .

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const cfg = {
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,
};

const s3 = new S3Client({ ...cfg, forcePathStyle: true });

async function writeOrderResult(order, body) {
  const bytes = Buffer.byteLength(body);

  const span = trace.getActiveSpan();
  span?.setAttribute('payload_bytes', bytes);

  // ---- FAULT INJECTION (Day 27 lab) ----
  // Fails ~5% of writes, only when payload > 100 KB.
  // (SNS's own 256 KB cap would otherwise prevent large payloads from reaching us.)
  if (bytes > 102400 && Math.random() < 0.05) {
    span?.setStatus({
      code: SpanStatusCode.ERROR,
      message: 'S3 PutObject timeout',
    });
    throw new Error('S3 PutObject timeout: payload too large for current throughput budget');
  }
  // ---- /FAULT INJECTION ----

  return s3.send(new PutObjectCommand({
    Bucket: process.env.RESULT_BUCKET,
    Key: `orders/${order.id}.json`,
    Body: body,
    ContentType: 'application/json',
  }));
}

module.exports = { writeOrderResult };