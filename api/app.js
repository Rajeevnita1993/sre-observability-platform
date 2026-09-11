require('./pyroscope');
require('./tracing');
const express = require('express');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { trace, SpanKind, SpanStatusCode, context, propagation } = require('@opentelemetry/api');
const tracer = trace.getTracer('api');

const { logger, withTrace } = require('./logger');
const addMetrics = require('./server');
const { ordersPublished } = require('./metrics');

const sns = new SNSClient({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,   // http://localstack:4566
});

const app = express();
addMetrics(app);
app.use(express.json({ limit: '5mb' }));

// Middleware to capture OTel trace context (unchanged)
app.use((req, res, next) => {
  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext();
  
  if (spanContext) {
    const traceId = spanContext.traceId;
    const spanId = spanContext.spanId;
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-span-id', spanId);
    req.logger = logger.child({
      trace_id: traceId,
      span_id: spanId,
      route: req.path,
      method: req.method,
    });
    req.traceId = traceId;
    req.spanId = spanId;
    req.spanContext = spanContext;
  } else {
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

const http = require('http');
const https = require('https');

app.post('/debug/outbound-ping', (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'url required in body' });
  }

  const client = url.startsWith('https') ? https : http;

  const outbound = client.get(url, (resp) => {
    let body = '';
    resp.on('data', (chunk) => (body += chunk));
    resp.on('end', () => {
      res.json({
        status: resp.statusCode,
        upstreamHeaders: resp.headers,
        upstreamBody: body.slice(0, 500),
      });
    });
  });

  outbound.on('error', (err) => {
    res.status(500).json({ error: err.message });
  });
});

app.post('/orders', async (req, res) => {
  // ---- SERVER span ----
  await tracer.startActiveSpan('POST /orders', { kind: SpanKind.SERVER }, async (span) => {
    span.setAttributes({
      'http.method': req.method,
      'http.route': '/orders',
    });

    try {
      const log = req.logger;
      // ---- NEW: deliberate slow path for tail-sampling test ----
      if (req.query.slow === 'true') {
        span.setAttribute('debug.slow', true);
        await new Promise(r => setTimeout(r, 700));   // trace > 500ms → slow-traces-policy
      }

      const { item, qty } = req.body || {};

      // Validation
      if (!item || !Number.isInteger(qty) || qty < 1) {
        log.error(withTrace({
          status: 400,
          item,
          qty,
          msg: 'Invalid order request',
        }));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid order request' });
        span.setAttribute('http.status_code', 400);
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

      // ---- CLIENT span for SNS publish ----
      const pubSpan = tracer.startSpan('sns.publish orders', { kind: SpanKind.CLIENT });
      pubSpan.setAttributes({
        'messaging.system': 'aws_sns',
        'messaging.destination.name': process.env.TOPIC_ARN || 'orders-topic',
        'messaging.destination.kind': 'topic',
      });

      try {
        // ---- set baggage, then inject ----
        const baggage = propagation.createBaggage({
          tenant: { value: 'team-checkout' },
        });
        const messageAttributes = {};
        context.with(trace.setSpan(context.active(), pubSpan), () => {
          // Inside here, pubSpan is the active span.
          const ctxWithBaggage = propagation.setBaggage(context.active(), baggage);
          context.with(ctxWithBaggage, () => {
            propagation.inject(context.active(), messageAttributes, {
              set: (carrier, key, value) => {
                carrier[key] = { DataType: 'String', StringValue: value };
              }
            });
          });
        });

        const command = new PublishCommand({
          TopicArn: process.env.TOPIC_ARN,
          Message: JSON.stringify(order),
          MessageAttributes: messageAttributes,
        });

        log.info(withTrace({
          msg: 'Publishing order to SNS',
          'messaging.destination.name': process.env.TOPIC_ARN,
          'order.id': order.id,
        }));

        const response = await sns.send(command);
        ordersPublished.inc({ status: 'success' });

        pubSpan.setAttribute('messaging.message.id', response.MessageId);
        pubSpan.setStatus({ code: SpanStatusCode.OK });

        log.info({ op: 'publish', status: 202, order_id: order.id }, 'order accepted');

        // Success response
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute('http.status_code', 202);
        res.status(202).json({ 
          id: order.id, 
          trace_id: req.traceId 
        });
      } catch (err) {
        ordersPublished.inc({ status: 'error' });
        log.error(withTrace({
          msg: 'order rejected',
          op: 'publish',
          status: 500,
          error: err.message,
        }));
        // Rethrow so the outer catch handles span status
        throw err;
      } finally {
        pubSpan.end(); // always end the client span
      }
    } catch (err) {
      // Outer error handler – sets span status and http.status_code
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.setAttribute('http.status_code', 500);
      // If response hasn't been sent yet, send error
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    } finally {
      span.end(); // always end the server span
    }
  });
});

app.listen(8080, () => {
  logger.info(withTrace({
    msg: 'API listening',
    'server.port': 8080,
  }));
});