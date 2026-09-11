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
  TraceFlags,
} = require('@opentelemetry/api');
const { logger, withTrace } = require('./logger');
const {
  jobsProcessed,
  queueDepth,
  s3WriteHist,
  messagesConsumed,
} = require('./metrics');

const { serializeResult } = require('./serialize');
const { writeOrderResult } = require('./s3writer');

const cfg = {
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,
};

const sqs = new SQSClient(cfg);
const s3 = new S3Client({ ...cfg, forcePathStyle: true });
const tracer = trace.getTracer('order-worker');

// Observe SQS queue depth
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
    logger.error(withTrace({
      msg: 'Failed to get SQS queue depth',
      error: err.message,
    }));
  }
});

// Helper to extract SNS message attributes
const snsMessageAttributesGetter = {
  keys: carrier => Object.keys(carrier || {}),
  get: (carrier, key) => carrier?.[key]?.Value,
};

// Helper to parse traceparent from SNS message attributes
function parseTraceparent(tp) {
  if (!tp) return null;
  const [, traceId, spanId] = tp.split('-');
  return { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true };
}

function validateOrder(order) {
  if (!order || typeof order !== 'object') {
    throw new TypeError('Order must be an object');
  }
  if (typeof order.item !== 'string' || order.item.length === 0) {
    throw new TypeError('Order.item must be a non-empty string');
  }
  if (!Number.isInteger(order.qty) || order.qty < 1) {
    throw new TypeError('Order.qty must be an integer >= 1');
  }
}

// -------------------------------------------------------------------
// Process a single message (Steps 1 & 2)
// -------------------------------------------------------------------
async function processOneMessage(m) {
  const envelope = JSON.parse(m.Body);
  const order = JSON.parse(envelope.Message);

  messagesConsumed.add(1);

  // Extract parent context from SNS attributes
  const parentContext = propagation.extract(
    ROOT_CONTEXT,
    envelope.MessageAttributes,
    snsMessageAttributesGetter,
  );

  // ---- NEW: read baggage and promote tenant ----
  const baggage = propagation.getBaggage(parentContext);
  const tenant = baggage?.getEntry('tenant')?.value || 'unknown';

  const spanContext = trace.getSpanContext(parentContext);
  const traceId = spanContext?.traceId ?? 'unknown';
  const log = logger.child({
    trace_id: traceId,
    span_id: spanContext?.spanId,
    op: 'process_order',
    sqs_message_id: m.MessageId,
    tenant,
  });

  log.info(withTrace({
    msg: 'Processing order',
    order_id: order.id,
    item: order.item,
    qty: order.qty,
  }));

  // ---- CONSUMER span ----
  const processSpan = tracer.startSpan('sqs.process orders-queue', {
    kind: SpanKind.CONSUMER,
  }, parentContext);

  processSpan.setAttributes({
    'messaging.system': 'aws_sqs',
    'messaging.destination.name': 'orders-queue',
    'tenant': tenant,
  });

  try {
    await context.with(trace.setSpan(parentContext, processSpan), async () => {
      // ---- processing span with events (Step 1 & 2) ----
      await tracer.startActiveSpan('process order message', async (processingSpan) => {
        processingSpan.setAttribute('tenant', tenant);
        // Event: processing_started
        processingSpan.addEvent('processing_started', {
          'message.id': m.MessageId,
          'sqs.receive_count': Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
        });

        try {
          // Validation
          validateOrder(order);

          // Only if validation passed:
          processingSpan.addEvent('validation_complete', {
            'order.sku': order.item,
            'order.qty': order.qty,
          });

          // ---- S3 upload ----
          const s3Span = tracer.startSpan('s3.PutObject order-results', {
            kind: SpanKind.CLIENT,
          });
          s3Span.setAttributes({
            'rpc.system': 'aws-api',
            'aws.s3.bucket': process.env.RESULT_BUCKET || 'order-results',
          });

          try {
            const startTime = process.hrtime.bigint();
            const body = serializeResult(order);
            const response = await writeOrderResult(order, body);

            // const response = await s3.send(new PutObjectCommand({
            //   Bucket: process.env.RESULT_BUCKET,
            //   Key: `orders/${order.id}.json`,
            //   Body: body,
            //   ContentType: 'application/json',
            // }));

            // Event: s3_write_complete (Step 2)
            processingSpan.addEvent('s3_write_complete', {
              'aws.s3.key': `orders/${order.id}.json`,
              'aws.s3.etag': response.ETag,
            });

            const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
            s3WriteHist.record(durationSeconds);
            jobsProcessed.add(1, { status: 'ok' });

            s3Span.setStatus({ code: SpanStatusCode.OK });

            log.info(withTrace({
              msg: 'result persisted',
              status: 200,
              order_id: order.id,
              s3_key: `orders/${order.id}.json`,
              duration_seconds: durationSeconds,
            }));
          } catch (err) {
            s3Span.recordException(err);
            s3Span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            log.error(withTrace({
              msg: 'persist failed',
              status: 500,
              order_id: order.id,
              error: err.message,
              stack: err.stack,
            }));
            throw err;
          } finally {
            s3Span.end();
          }

          // Delete the message after successful processing
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: process.env.QUEUE_URL,
            ReceiptHandle: m.ReceiptHandle,
          }));

          processingSpan.setStatus({ code: SpanStatusCode.OK });
          log.info(withTrace({
            msg: 'Processed order',
            order_id: order.id,
            status: 'complete',
          }));
        } catch (error) {
          processingSpan.recordException(error);
          processingSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          jobsProcessed.add(1, { status: 'error' });
          log.error(withTrace({
            msg: 'Order processing failed',
            order_id: order.id,
            error: error.message,
            stack: error.stack,
          }));
          throw error;
        } finally {
          processingSpan.end();
        }
      });
    });
  } catch (exception) {
    processSpan.recordException(exception);
    processSpan.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
    jobsProcessed.add(1, { status: 'error' });
    log.error(withTrace({
      msg: 'Order processing failed (outer)',
      order_id: order.id,
      error: exception.message,
      stack: exception.stack,
    }));
  } finally {
    processSpan.end();
  }
}

// -------------------------------------------------------------------
// Process a batch of messages with a summary span and links (Step 4)
// -------------------------------------------------------------------
async function processBatchAsFanIn(messages) {
  // 1. Build links from each message's traceparent (the API-side context)
  const links = messages
    .map(m => {
      const envelope = JSON.parse(m.Body);
      const tp = envelope.MessageAttributes?.traceparent?.Value;
      if (!tp) return null;
      const parsed = parseTraceparent(tp);
      if (!parsed) return null;
      return { context: parsed };
    })
    .filter(Boolean);

  // 2. Create the summary span with links
  const summarySpan = tracer.startSpan('batch-fan-in-summary', { links });
  summarySpan.setAttributes({ 'batch.size': messages.length });

  try {
    // 3. Process each message sequentially (or in parallel, but lab uses sequential)
    for (const msg of messages) {
      await processOneMessage(msg);
    }

    // 4. Add an event and end the summary span
    summarySpan.addEvent('batch_persisted', { 'batch.size': messages.length });
    summarySpan.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    summarySpan.recordException(error);
    summarySpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error; // or handle as needed
  } finally {
    summarySpan.end();
  }
}

// -------------------------------------------------------------------
// Main polling loop (Step 3)
// -------------------------------------------------------------------
async function loop() {
  try {
    const { Messages } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 5,
      MessageAttributeNames: ['All'],
    }));

    if (!Messages || Messages.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return setImmediate(loop);
    }

    // If we have 3 or more messages, process as a batch (Step 3)
    if (Messages.length >= 3) {
      await processBatchAsFanIn(Messages);
    } else {
      for (const msg of Messages) {
        await processOneMessage(msg);
      }
    }
  } catch (exception) {
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