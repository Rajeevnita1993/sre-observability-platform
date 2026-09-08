// worker/worker.js
require('./profiling');
require('./tracing'); 

const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand } =
  require('@aws-sdk/client-sqs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} = require('@opentelemetry/api');
const { logger, withTrace } = require('./logger');  // ← Added withTrace import
const {
  jobsProcessed,
  queueDepth,
  s3WriteHist,
  messagesConsumed,
} = require('./metrics');

const { serializeResult } = require('./serialize');

const cfg = {
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,
};

const sqs = new SQSClient(cfg);
const s3 = new S3Client({ ...cfg, forcePathStyle: true });
const tracer = trace.getTracer('order-worker');

// Observe SQS queue depth whenever Prometheus scrapes metrics
queueDepth.addCallback(async (result) => {
  try {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: process.env.QUEUE_URL,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })
    );

    result.observe(
      Number(Attributes?.ApproximateNumberOfMessages || 0),
      { queue: 'orders-queue' }
    );
  } catch (err) {
    // ✅ Use withTrace for error logging
    logger.error(withTrace({
      msg: 'Failed to get SQS queue depth',
      error: err.message,
    }));
  }
});

// SNS delivers message attributes inside its JSON envelope when raw delivery is off.
const snsMessageAttributesGetter = {
  keys: carrier => Object.keys(carrier || {}),
  get: (carrier, key) => carrier?.[key]?.Value,
};

async function loop() {
  try {
    const { Messages } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 5,
      MessageAttributeNames: ['All'],
    }));

    for (const m of Messages || []) {
      const envelope = JSON.parse(m.Body);
      const order = JSON.parse(envelope.Message);

      messagesConsumed.add(1);

      // Extract the trace context from SNS message attributes
      const parentContext = propagation.extract(
        ROOT_CONTEXT,
        envelope.MessageAttributes,
        snsMessageAttributesGetter,
      );

      // ✅ Get the REAL trace ID from the extracted context
      const spanContext = trace.getSpanContext(parentContext);
      const traceId = spanContext?.traceId ?? 'unknown';
      
      // ✅ Create logger with REAL trace context
      const log = logger.child({
        trace_id: traceId,
        span_id: spanContext?.spanId,
        op: 'process_order',
        sqs_message_id: m.MessageId,
      });

      // ✅ Use withTrace for structured logging
      log.info(withTrace({
        msg: 'Processing order',
        order_id: order.id,
        item: order.item,
        qty: order.qty,
      }));

      // Execute the entire processing within the extracted parent context
      await context.with(parentContext, async () => {
        // Start a manual CONSUMER span
        const processSpan = tracer.startSpan('orders process', {
          kind: SpanKind.CONSUMER,
        });

        try {
          await context.with(trace.setSpan(context.active(), processSpan), async () => {
            const result = {
              ...order,
              status: 'processed',
              processedAt: Date.now(),
            };

            // --- Custom child span for the S3 write ---
            await tracer.startActiveSpan('persist order result', async (span) => {
              try {
                // Set custom attributes
                span.setAttributes({
                  'order.id': order.id,
                  'aws.s3.bucket': process.env.RESULT_BUCKET,
                  'order.qty': order.qty,
                });

                const startTime = process.hrtime.bigint();

                const body = serializeResult(order); // uses the hot function

                // Perform the actual S3 upload
                await s3.send(new PutObjectCommand({
                  Bucket: process.env.RESULT_BUCKET,
                  Key: `orders/${order.id}.json`,
                  Body: body,
                  ContentType: 'application/json',
                }));

                const durationSeconds =
                  Number(process.hrtime.bigint() - startTime) / 1e9;

                // Record metrics
                s3WriteHist.record(durationSeconds);
                jobsProcessed.add(1, { status: 'ok' });

                // Add a span event
                span.addEvent('result.persisted', {
                  's3.key': `orders/${order.id}.json`,
                });

                // Set status OK
                span.setStatus({ code: SpanStatusCode.OK });

                // ✅ Use withTrace for success logging
                log.info(withTrace({
                  msg: 'result persisted',
                  status: 200,
                  order_id: order.id,
                  s3_key: `orders/${order.id}.json`,
                  duration_seconds: durationSeconds,
                }));

              } catch (err) {
                span.recordException(err);
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: err.message,
                });
                
                // ✅ Use withTrace for error logging
                log.error(withTrace({
                  msg: 'persist failed',
                  status: 500,
                  order_id: order.id,
                  error: err.message,
                  stack: err.stack,
                }));
                throw err;
              } finally {
                span.end();
              }
            });
            // --- End of custom child span ---

            // Delete the message from the queue after successful processing
            await sqs.send(new DeleteMessageCommand({
              QueueUrl: process.env.QUEUE_URL,
              ReceiptHandle: m.ReceiptHandle,
            }));
          });
        } catch (exception) {
          processSpan.recordException(exception);
          processSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: exception.message,
          });
          jobsProcessed.add(1, { status: 'error' });
          
          // ✅ Use withTrace for error logging
          log.error(withTrace({
            msg: 'Order processing failed',
            order_id: order.id,
            error: exception.message,
            stack: exception.stack,
          }));
          // Do not re-throw to avoid crashing the loop; let the loop continue
        } finally {
          processSpan.end();
        }
      });

      // ✅ Use withTrace for completion logging
      log.info(withTrace({
        msg: 'Processed order',
        order_id: order.id,
        status: 'complete',
      }));
    }
  } catch (exception) {
    // ✅ Use withTrace for error logging
    logger.error(withTrace({
      msg: 'Worker polling or processing failed; retrying in one second',
      error: exception.message,
      stack: exception.stack,
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  setImmediate(loop);
}

// Start the worker loop
loop();