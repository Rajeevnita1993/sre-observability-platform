// shared/logger.js
const { trace } = require('@opentelemetry/api');
const pino = require('pino');

// Create the base logger with common configuration
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Redact sensitive data
  redact: ['password', 'token', 'authorization'],
});

// Helper to inject trace context
function getTraceContext() {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc 
    ? { trace_id: sc.traceId, span_id: sc.spanId }
    : {};
}

// Helper to add trace to any log fields
function withTrace(fields = {}) {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc
    ? { ...fields, trace_id: sc.traceId, span_id: sc.spanId }
    : fields;
}

// Create a service-specific logger
function createServiceLogger(serviceName, additionalFields = {}) {
  const traceFields = getTraceContext();
  return baseLogger.child({
    service: serviceName,
    ...traceFields,
    ...additionalFields,
  });
}

module.exports = {
  baseLogger,
  getTraceContext,
  withTrace,
  createServiceLogger,
};