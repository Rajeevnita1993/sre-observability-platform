require('./pyroscope');
require('./tracing');
const express = require('express');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { context, propagation, trace } = require('@opentelemetry/api');

const { logger, withTrace } = require('./logger');
const addMetrics = require('./server');
const { ordersPublished } = require('./metrics');

const sns = new SNSClient({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,   // http://localstack:4566
});

const app = express();
addMetrics(app);
app.use(express.json());

// Middleware to capture OTel trace context
app.use((req, res, next) => {
  // Get the REAL OTel trace context
  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext();
  
  if (spanContext) {
    // Use the REAL trace ID from OTel
    const traceId = spanContext.traceId;
    const spanId = spanContext.spanId;
    
    // Set headers for client visibility
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-span-id', spanId);
    
    // Create logger with REAL trace context
    req.logger = logger.child({
      trace_id: traceId,
      span_id: spanId,
      route: req.path,
      method: req.method,
    });
    
    // Store for later use
    req.traceId = traceId;
    req.spanId = spanId;
    req.spanContext = spanContext;
  } else {
    // Fallback if no active span (shouldn't happen with tracing enabled)
    const fallbackId = crypto.randomUUID();
    req.logger = logger.child({ 
      trace_id: fallbackId,
      route: req.path,
      method: req.method,
    });
    req.traceId = fallbackId;
  }
  
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/orders', async (req, res) => {
  //const traceId = req.headers['x-trace-id'] ?? crypto.randomUUID();
  //const log = logger.child({ trace_id: traceId, route: 'POST /orders' });
  const log = req.logger;

  const { item, qty } = req.body || {};
  if (!item || !Number.isInteger(qty) || qty < 1) {
  log.error(withTrace({
      status: 400,
      item,
      qty,
      msg: 'Invalid order request',
    }));
    
    return res.status(400).json({
      error: 'item (string) and qty (int>=1) required'
    });
}
  const order = { id: crypto.randomUUID(), item, qty, ts: Date.now() };
  log.info(withTrace({
    msg: 'Order created',
    order_id: order.id,
    item,
    qty,
  }));
  // Extract trace context for SNS message attributes
  const currentContext = context.active();
  const messageAttributes = {};
  propagation.inject(currentContext, messageAttributes, {
    set: (carrier, key, value) => {
      carrier[key] = { DataType: 'String', StringValue: value };
    }
  });
  const command = new PublishCommand({
  TopicArn: process.env.TOPIC_ARN,
  Message: JSON.stringify(order),
  MessageAttributes: messageAttributes
});

  log.info(withTrace({
    msg: 'Publishing order to SNS',
    'messaging.destination.name': process.env.TOPIC_ARN,
    'order.id': order.id,
  }));

  try {
    await sns.send(command);
    ordersPublished.inc({ status: 'success' });

    log.info({ op: 'publish', status: 202, order_id: order.id }, 'order accepted');
     res.status(202).json({ 
      id: order.id, 
      trace_id: req.traceId 
    });
}
  catch (err) {
    ordersPublished.inc({ status: 'error' });
    log.error(withTrace({
      msg: 'order rejected',
      op: 'publish',
      status: 500,
      error: err.message,
    }));
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => {
  logger.info(withTrace({
    msg: 'API listening',
    'server.port': 8080,
  }));
});
